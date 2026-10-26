import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDomainService } from "../../server/domain/service";
import {
  exportBackup,
  verifyBackupManifest,
} from "../../server/domain/migration";
import { DEFAULT_TIMEZONE, instantToLocalDate } from "../../shared/datetime";
import type { DailyFocusDTO, Principal } from "../../shared/contracts";
import type { Database } from "../../server/db/database";
import { createTestDatabase } from "./database";

describe("owner-bound daily focus", () => {
  let db: Database;
  const owner: Principal = {
    ownerId: `synthetic-focus-owner-${randomUUID()}`,
    actorId: "synthetic-focus-ui",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  const other: Principal = {
    ownerId: `synthetic-focus-other-${randomUUID()}`,
    actorId: "synthetic-focus-other-ui",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close?.();
  });
  const service = () => createDomainService(db);
  const create = async (title: string, principal = owner) =>
    service().execute("task_create", { title }, principal, {
      idempotencyKey: randomUUID(),
    });
  const read = async (date: string, principal = owner) =>
    (await service().query(
      "daily_focus_get",
      { date },
      principal,
    )) as DailyFocusDTO;

  it("selects ordered tasks without changing status, dates or hierarchy; Done remains selected", async () => {
    const first = await create("Synthetic focus A"),
      second = await create("Synthetic focus B"),
      date = "2026-10-25";
    expect(await read(date)).toMatchObject({
      date,
      timezone: DEFAULT_TIMEZONE,
      revision: 0,
      task_ids: [],
      items: [],
    });
    const accepted = await service().execute(
      "daily_focus_set",
      { date, task_ids: [second.entity_id, first.entity_id] },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 0 },
    );
    expect(accepted).toMatchObject({
      entity_id: `daily-focus:${date}`,
      version: 1,
      readiness_changes: [],
      data: {
        date,
        revision: 1,
        task_ids: [second.entity_id, first.entity_id],
      },
    });
    expect(await read(date)).toMatchObject({
      revision: 1,
      task_ids: [second.entity_id, first.entity_id],
      items: [
        { task_id: second.entity_id, status: "Inbox", due_date: null },
        { task_id: first.entity_id, status: "Inbox", due_date: null },
      ],
    });
    await service().execute(
      "task_complete",
      { task_id: second.entity_id },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    expect(await read(date)).toMatchObject({
      task_ids: [second.entity_id, first.entity_id],
      items: [
        { task_id: second.entity_id, status: "Done" },
        { task_id: first.entity_id, status: "Inbox" },
      ],
    });
    const audit = await db.query<{
      event_type: string;
      before: unknown;
      after: unknown;
    }>(
      "SELECT event_type,before,after FROM activity_events WHERE event_id=$1 AND owner_id=$2",
      [accepted.audit_event_id, owner.ownerId],
    );
    expect(audit.rows).toMatchObject([
      {
        event_type: "daily_focus_set",
        before: { revision: 0, task_ids: [] },
        after: { revision: 1, task_ids: [second.entity_id, first.entity_id] },
      },
    ]);
  });

  it("replays the same key and rejects stale or invalid updates atomically", async () => {
    const task = await create("Synthetic focus revision task"),
      date = "2026-03-29",
      input = { date, task_ids: [task.entity_id] },
      key = randomUUID();
    const accepted = await service().execute("daily_focus_set", input, owner, {
      idempotencyKey: key,
      expectedRevision: 0,
    });
    expect(
      await service().execute("daily_focus_set", input, owner, {
        idempotencyKey: key,
        expectedRevision: 0,
      }),
    ).toEqual({ ...accepted, replayed: true });
    await expect(
      service().execute("daily_focus_set", { date, task_ids: [] }, owner, {
        idempotencyKey: randomUUID(),
        expectedRevision: 0,
      }),
    ).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
      details: { current: { revision: 1, task_ids: [task.entity_id] } },
    });
    for (const invalid of [
      [task.entity_id, task.entity_id],
      [task.entity_id, "synthetic-missing-task"],
      Array.from({ length: 6 }, (_, index) => `synthetic-task-${index}`),
    ])
      await expect(
        service().execute(
          "daily_focus_set",
          { date, task_ids: invalid },
          owner,
          {
            idempotencyKey: randomUUID(),
            expectedRevision: 1,
          },
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await read(date)).toMatchObject({
      revision: 1,
      task_ids: [task.entity_id],
    });
    const cleared = await service().execute(
      "daily_focus_set",
      { date, task_ids: [] },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    expect(cleared.version).toBe(2);
    expect(await read(date)).toMatchObject({ revision: 2, task_ids: [] });
  });

  it("rejects foreign and archived tasks without leaking them across owners", async () => {
    const foreign = await create("Synthetic other-owner task", other),
      archived = await create("Synthetic archived focus task");
    await service().execute(
      "task_archive",
      { task_id: archived.entity_id },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    for (const taskId of [foreign.entity_id, archived.entity_id])
      await expect(
        service().execute(
          "daily_focus_set",
          { date: "2026-10-26", task_ids: [taskId] },
          owner,
          { idempotencyKey: randomUUID(), expectedRevision: 0 },
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await read("2026-10-26")).toMatchObject({
      revision: 0,
      task_ids: [],
    });
    expect(await read("2026-03-29", other)).toMatchObject({
      revision: 0,
      task_ids: [],
    });
  });

  it("serializes two writers of the same new day without silently overwriting", async () => {
    const first = await create("Synthetic focus race A"),
      second = await create("Synthetic focus race B"),
      day = "2026-10-27";
    const attempts = await Promise.allSettled(
      [first.entity_id, second.entity_id].map((taskId) =>
        service().execute(
          "daily_focus_set",
          { date: day, task_ids: [taskId] },
          owner,
          { idempotencyKey: randomUUID(), expectedRevision: 0 },
        ),
      ),
    );
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { code: "REVISION_CONFLICT" } });
    const selected = await read(day);
    expect(selected.revision).toBe(1);
    expect(selected.task_ids).toHaveLength(1);
    expect([first.entity_id, second.entity_id]).toContain(selected.task_ids[0]);
  });

  it("uses Berlin's current local date and includes focus rows in portable backups", async () => {
    const today = instantToLocalDate(Date.now(), DEFAULT_TIMEZONE);
    expect(await service().query("daily_focus_get", {}, owner)).toMatchObject({
      date: today,
      timezone: DEFAULT_TIMEZONE,
    });
    const backup = await db.transaction(owner.ownerId, (tx) =>
      exportBackup(tx, owner.ownerId),
    );
    const verified = verifyBackupManifest(backup, owner.ownerId);
    expect(verified.daily_focus_days.length).toBeGreaterThanOrEqual(2);
    expect(verified.daily_focus_items.length).toBeGreaterThanOrEqual(2);
    const selectionBefore = await read("2026-10-25");
    const restoreDb = await createTestDatabase();
    try {
      const restored = createDomainService(restoreDb);
      await restored.execute(
        "backup_restore",
        { explicit_user_intent: true, backup },
        owner,
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restored.query("daily_focus_get", { date: "2026-10-25" }, owner),
      ).toMatchObject({
        revision: 1,
        task_ids: selectionBefore.task_ids,
      });
    } finally {
      await restoreDb.close?.();
    }
  });
});
