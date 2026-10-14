import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { getDatabase, type Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  DomainService,
  Principal,
  PreviewDTO,
  TaskDTO,
} from "../../shared/contracts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SYNTHETIC_READ_CONCURRENCY_BARRIER_TIMEOUT")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe.skipIf(process.env.TEST_POSTGRES !== "1")(
  "Native PostgreSQL parallel consistent reads",
  () => {
    let db: Database, service: DomainService;
    const principal: Principal = {
      ownerId: "staging-synthetic-parallel-read-" + randomUUID(),
      actorId: "synthetic-parallel-read-actor",
      channel: "UI",
      scopes: ["admin:manage"],
    };
    beforeAll(() => {
      const ci =
        process.env.CI === "true" &&
        process.env.OWNER_ID === "synthetic-ci-owner";
      if (!ci && process.env.POSTGRES_READ_CONCURRENCY_STAGING !== "1")
        throw new Error("EXPLICIT_SYNTHETIC_POSTGRES_READ_TEST_REQUIRED");
      if (
        process.env.OWNER_EMAIL !== "owner@example.test" ||
        process.env.BETTER_AUTH_URL !== "http://localhost:3000"
      )
        throw new Error("SYNTHETIC_STAGING_POSTGRES_READ_ENV_REQUIRED");
      db = getDatabase();
      if (!db.readTransaction)
        throw new Error("NATIVE_READ_TRANSACTION_REQUIRED");
      service = createDomainService(db);
      // The coordinator/CI already initialized this schema. This test issues no DDL.
    });
    afterAll(async () => {
      await db?.close?.();
    });

    it("five_same_owner_readers_reach_a_barrier_concurrently_in_SQL_read_only_repeatable_read", async () => {
      const allEntered = deferred(),
        release = deferred();
      let entered = 0;
      const readers = Array.from({ length: 5 }, () =>
        db.readTransaction!(principal.ownerId, async (tx) => {
          const row = (
            await tx.query<{ mode: string; isolation: string }>(
              "SELECT current_setting('transaction_read_only') mode,current_setting('transaction_isolation') isolation",
            )
          ).rows[0];
          expect(row).toEqual({ mode: "on", isolation: "repeatable read" });
          if (++entered === 5) allEntered.resolve();
          await release.promise;
        }),
      );
      try {
        await within(allEntered.promise, 5000);
        expect(entered).toBe(5);
      } finally {
        release.resolve();
        const results = await Promise.allSettled(readers);
        expect(results.every((result) => result.status === "fulfilled")).toBe(
          true,
        );
      }
    }, 30000);

    it("exclusive_canonical_writers_wait_for_active_readers_then_serialize_and_acknowledged_reads_see_committed_rows", async () => {
      const created = await service.execute(
        "task_create",
        { title: "Synthetic parallel read original", due_date: "2055-12-20" },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const entered = deferred(),
        release = deferred();
      const reader = db.readTransaction!(principal.ownerId, async (tx) => {
        const first = (
          await tx.query(
            "SELECT title,revision,due_date FROM tasks WHERE owner_id=$1 AND task_id=$2",
            [principal.ownerId, created.entity_id],
          )
        ).rows;
        entered.resolve();
        await release.promise;
        const second = (
          await tx.query(
            "SELECT title,revision,due_date FROM tasks WHERE owner_id=$1 AND task_id=$2",
            [principal.ownerId, created.entity_id],
          )
        ).rows;
        expect(second).toEqual(first);
      });
      await within(entered.promise, 5000);
      let active = 0,
        maximum = 0;
      const committed: string[] = [];
      const writers = ["A", "B"].map((suffix) =>
        db.transaction(principal.ownerId, async (tx) => {
          maximum = Math.max(maximum, ++active);
          try {
            const row = (
              await tx.query<{ revision: number }>(
                "SELECT revision FROM tasks WHERE owner_id=$1 AND task_id=$2",
                [principal.ownerId, created.entity_id],
              )
            ).rows[0];
            const pinned: Database = {
              query: tx.query,
              transaction: async (owner, action) => {
                expect(owner).toBe(principal.ownerId);
                return action(tx);
              },
            };
            const title = "Synthetic parallel read writer " + suffix;
            await createDomainService(pinned).execute(
              "task_update",
              { task_id: created.entity_id, title },
              principal,
              { idempotencyKey: randomUUID(), expectedRevision: row.revision },
            );
            committed.push(title);
          } finally {
            active--;
          }
        }),
      );
      try {
        const started = Date.now();
        let waiting = 0;
        do {
          waiting = Number(
            (
              await db.query<{ count: string }>(
                `SELECT count(*) count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND objsubid=1
           AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
           AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
           AND objid::bigint=(hashtextextended($1,0)&4294967295)`,
                [principal.ownerId],
              )
            ).rows[0].count,
          );
        } while (waiting < 2 && Date.now() - started < 5000);
        expect(waiting).toBe(2);
        expect(active).toBe(0);
        expect(committed).toHaveLength(0);
      } finally {
        release.resolve();
        await reader;
        const results = await Promise.allSettled(writers);
        expect(results.every((result) => result.status === "fulfilled")).toBe(
          true,
        );
      }
      expect(maximum).toBe(1);
      const current = (await service.query(
        "task_get",
        { task_id: created.entity_id },
        principal,
      )) as TaskDTO;
      expect(current).toMatchObject({
        title: committed.at(-1),
        revision: 3,
        due_date: "2055-12-20",
      });
      expect(
        (
          await db.query(
            "SELECT event_id FROM activity_events WHERE owner_id=$1 AND entity_id=$2 AND event_type='task_update'",
            [principal.ownerId, created.entity_id],
          )
        ).rows,
      ).toHaveLength(2);
    }, 30000);

    it("SQL_read_only_rejects_writes_and_rollback_leaves_the_connection_usable", async () => {
      const forbidden = "staging-synthetic-read-forbidden-" + randomUUID();
      await expect(
        db.readTransaction!(principal.ownerId, (tx) =>
          tx.query("INSERT INTO owners(owner_id) VALUES($1)", [forbidden]),
        ),
      ).rejects.toMatchObject({ code: "25006" });
      expect(
        (
          await db.query("SELECT owner_id FROM owners WHERE owner_id=$1", [
            forbidden,
          ])
        ).rows,
      ).toHaveLength(0);
      expect(await service.query("preferences_get", {}, principal)).toEqual({
        settings: {},
        revision: 0,
      });
    });

    it("stored_preview_remains_writable_exclusive_and_real_commit_is_visible_after_ack", async () => {
      const a = await service.execute(
        "task_create",
        { title: "Synthetic native read dependent" },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const b = await service.execute(
        "task_create",
        { title: "Synthetic native read prerequisite" },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const preview = (await service.query(
        "task_dependency_add_preview",
        { task_id: a.entity_id, prerequisites: [{ task_id: b.entity_id }] },
        principal,
      )) as PreviewDTO;
      expect(
        (
          await db.query(
            "SELECT preview_id FROM command_previews WHERE owner_id=$1 AND preview_id=$2",
            [principal.ownerId, preview.preview_id],
          )
        ).rows,
      ).toHaveLength(1);
      await service.execute(
        "task_dependency_add_commit",
        { preview_id: preview.preview_id },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const read = (await service.query(
        "task_get",
        { task_id: a.entity_id },
        principal,
      )) as TaskDTO;
      expect(read.prerequisites).toHaveLength(1);
      expect(read.prerequisites[0].prerequisite_task_id).toBe(b.entity_id);
      expect(read.readiness).toBe("blocked");
    }, 30000);
  },
);
