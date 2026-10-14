import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database, SqlClient } from "../../server/db/database";
import type { Principal, PreviewDTO, TaskDTO } from "../../shared/contracts";
import { createTestDatabase } from "./database";

describe("Preferences keep canonical receipts without unrelated graph scans", () => {
  let db: Database;
  const statements: string[] = [];
  const principal: Principal = {
    ownerId: "synthetic-preferences-transaction-" + randomUUID(),
    actorId: "synthetic-preferences-actor",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close?.();
  });
  const service = () =>
    createDomainService({
      query: db.query,
      transaction: (owner, action) =>
        db.transaction(owner, (tx) => {
          const traced: SqlClient = {
            query: async (sql, values) => {
              statements.push(sql);
              return tx.query(sql, values);
            },
          };
          return action(traced);
        }),
    });
  const graphQuery = (sql: string) =>
    /\b(tasks|task_dependency_groups|task_dependency_edges|task_checklists|task_checklist_items)\b/.test(
      sql,
    );

  it("preference_write_revision_replay_audit_and_stale_denial_preserve_graph_rows_without_graph_reads", async () => {
    const canonical = service();
    const task = await canonical.execute(
      "task_create",
      { title: "Synthetic untouched settings task", due_date: "2055-12-20" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const before = (
      await db.query("SELECT * FROM tasks WHERE owner_id=$1", [
        principal.ownerId,
      ])
    ).rows;
    statements.length = 0;
    const key = randomUUID(),
      input = { settings: { display_density: "compact", retention_days: 365 } };
    const accepted = await canonical.execute(
      "preferences_update",
      input,
      principal,
      { idempotencyKey: key, expectedRevision: 0 },
    );
    expect(accepted).toMatchObject({
      entity_id: principal.ownerId,
      version: 1,
      affected_task_ids: [],
      readiness_changes: [],
      data: { settings: input.settings, revision: 1 },
    });
    expect(statements.some(graphQuery)).toBe(false);
    expect(
      (
        await db.query("SELECT * FROM tasks WHERE owner_id=$1", [
          principal.ownerId,
        ])
      ).rows,
    ).toEqual(before);
    const audit = (
      await db.query(
        "SELECT event_type,entity_id,actor_id,channel,operation_id,before,after FROM activity_events WHERE owner_id=$1 AND event_id=$2",
        [principal.ownerId, accepted.audit_event_id],
      )
    ).rows;
    expect(audit).toEqual([
      expect.objectContaining({
        event_type: "preferences_update",
        entity_id: principal.ownerId,
        actor_id: principal.actorId,
        channel: "UI",
        operation_id: accepted.operation_id,
        before: { revision: 0, settings: {} },
        after: expect.objectContaining({
          settings: input.settings,
          revision: 1,
        }),
      }),
    ]);
    const replay = await canonical.execute(
      "preferences_update",
      input,
      principal,
      { idempotencyKey: key, expectedRevision: 0 },
    );
    expect(replay).toEqual({ ...accepted, replayed: true });
    expect(statements.some(graphQuery)).toBe(false);
    await expect(
      canonical.execute(
        "preferences_update",
        { settings: { retention_days: 0 } },
        principal,
        { idempotencyKey: randomUUID(), expectedRevision: 0 },
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(statements.some(graphQuery)).toBe(false);
    expect(
      await canonical.query("preferences_get", {}, principal),
    ).toMatchObject({ revision: 1, settings: input.settings });
    const current = (await canonical.query(
      "task_get",
      { task_id: task.entity_id },
      principal,
    )) as TaskDTO;
    expect(current).toMatchObject({
      status: "Inbox",
      revision: 1,
      due_date: "2055-12-20",
    });
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND event_type='preferences_update'",
          [principal.ownerId],
        )
      ).rows,
    ).toHaveLength(1);
  });

  it("task_completion_still_derives_and_returns_real_downstream_readiness_changes", async () => {
    const canonical = service();
    const a = await canonical.execute(
      "task_create",
      { title: "Synthetic preference exemption gate" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const b = await canonical.execute(
      "task_create",
      { title: "Synthetic preference exemption leaf" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const preview = (await canonical.query(
      "task_dependency_add_preview",
      { task_id: a.entity_id, prerequisites: [{ task_id: b.entity_id }] },
      principal,
    )) as PreviewDTO;
    await canonical.execute(
      "task_dependency_add_commit",
      { preview_id: preview.preview_id },
      principal,
      { idempotencyKey: randomUUID() },
    );
    statements.length = 0;
    const result = await canonical.execute(
      "task_complete",
      { task_id: b.entity_id },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    expect(result.readiness_changes).toContainEqual({
      task_id: a.entity_id,
      before: "blocked",
      after: "ready",
    });
    expect(result.affected_task_ids).toContain(a.entity_id);
    expect(statements.some(graphQuery)).toBe(true);
    expect(
      await canonical.query("task_get", { task_id: a.entity_id }, principal),
    ).toMatchObject({ readiness: "ready", ready_now: true });
  });
});
