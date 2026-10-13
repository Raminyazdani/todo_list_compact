import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDatabase,
  migrateDatabase,
  type Database,
} from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  DomainService,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";

describe.skipIf(process.env.TEST_POSTGRES !== "1")(
  "Real staging PostgreSQL multi-connection concurrency",
  () => {
    let db: Database, service: DomainService;
    const principal: Principal = {
      ownerId: `staging-synthetic-race-${randomUUID()}`,
      actorId: "synthetic-test-runner",
      channel: "UI",
      scopes: ["admin:manage"],
    };
    beforeAll(async () => {
      db = getDatabase();
      await migrateDatabase(db);
      service = createDomainService(db);
    }, 30000);
    afterAll(async () => {
      await db.close?.();
    });
    it("postgres_concurrent_single_occurrence_moves_persist_one_override_and_one_exclusion", async () => {
      const master = await service.execute(
        "calendar_create_local_event",
        {
          title: "Synthetic staging recurring calendar race",
          starts_at: "2027-03-21T09:00:00Z",
          ends_at: "2027-03-21T10:00:00Z",
          timezone: "Europe/Berlin",
          recurrence_rule: "FREQ=WEEKLY;COUNT=3",
        },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const makePreview = (starts_at: string, ends_at: string) =>
        service.query(
          "calendar_occurrence_reschedule_preview",
          {
            event_id: master.entity_id,
            occurrence_starts_at: "2027-03-28T08:00:00Z",
            starts_at,
            ends_at,
          },
          principal,
        ) as Promise<PreviewDTO>;
      const [a, b] = await Promise.all([
        makePreview("2027-03-28T10:00:00Z", "2027-03-28T11:00:00Z"),
        makePreview("2027-03-29T10:00:00Z", "2027-03-29T11:00:00Z"),
      ]);
      const results = await Promise.allSettled(
        [a, b].map((preview) =>
          service.execute(
            "calendar_occurrence_reschedule_commit",
            { preview_id: preview.preview_id },
            principal,
            { idempotencyKey: randomUUID() },
          ),
        ),
      );
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        (
          results.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult
        ).reason,
      ).toMatchObject({ code: "REVISION_CONFLICT" });
      const originals = (
        await db.query<{ revision: number; recurrence_exceptions: string[] }>(
          "SELECT revision,recurrence_exceptions FROM calendar_events WHERE event_id=$1 AND owner_id=$2",
          [master.entity_id, principal.ownerId],
        )
      ).rows;
      expect(originals).toEqual([
        { revision: 2, recurrence_exceptions: ["2027-03-28T10:00:00"] },
      ]);
      expect(
        (
          await db.query(
            "SELECT event_id FROM calendar_events WHERE series_event_id=$1 AND owner_id=$2",
            [master.entity_id, principal.ownerId],
          )
        ).rows,
      ).toHaveLength(1);
    }, 30000);
    it("postgres_simultaneous_edge_writes_cannot_create_cycle", async () => {
      const a = await service.execute(
          "task_create",
          { title: "Synthetic staging race A" },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        b = await service.execute(
          "task_create",
          { title: "Synthetic staging race B" },
          principal,
          { idempotencyKey: randomUUID() },
        );
      const [pa, pb] = (await Promise.all([
        service.query(
          "task_dependency_add_preview",
          { task_id: a.entity_id, prerequisites: [{ task_id: b.entity_id }] },
          principal,
        ),
        service.query(
          "task_dependency_add_preview",
          { task_id: b.entity_id, prerequisites: [{ task_id: a.entity_id }] },
          principal,
        ),
      ])) as [PreviewDTO, PreviewDTO];
      const results = await Promise.allSettled([
        service.execute(
          "task_dependency_add_commit",
          { preview_id: pa.preview_id },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        service.execute(
          "task_dependency_add_commit",
          { preview_id: pb.preview_id },
          principal,
          { idempotencyKey: randomUUID() },
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(["REVISION_CONFLICT", "DEPENDENCY_CYCLE"]).toContain(
        rejected.reason.code,
      );
      const [ta, tb] = (await Promise.all([
        service.query("task_get", { task_id: a.entity_id }, principal),
        service.query("task_get", { task_id: b.entity_id }, principal),
      ])) as [TaskDTO, TaskDTO];
      expect(ta.prerequisites.length + tb.prerequisites.length).toBe(1);
    }, 30000);
    it("postgres_direct_concurrent_writers_are_guarded_by_database_trigger", async () => {
      const a = await service.execute(
          "task_create",
          { title: "Synthetic direct guard A" },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        b = await service.execute(
          "task_create",
          { title: "Synthetic direct guard B" },
          principal,
          { idempotencyKey: randomUUID() },
        );
      const write = (dependent: string, prerequisite: string) =>
        db.transaction(principal.ownerId, async (tx) => {
          const group = randomUUID();
          await tx.query(
            "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id) VALUES($1,$2,$3)",
            [group, principal.ownerId, dependent],
          );
          await tx.query(
            "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id) VALUES($1,$2,$3,$4)",
            [randomUUID(), principal.ownerId, group, prerequisite],
          );
        });
      const results = await Promise.allSettled([
        write(a.entity_id, b.entity_id),
        write(b.entity_id, a.entity_id),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        String(
          (
            results.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
      ).toContain("DEPENDENCY_CYCLE");
    }, 30000);
  },
);
