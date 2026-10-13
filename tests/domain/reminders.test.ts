import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  CommandName,
  DomainService,
  PageDTO,
  Principal,
  ReminderDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  expectedRevision?: number,
  key = randomUUID(),
) =>
  service.execute(command, input, principal, {
    idempotencyKey: key,
    expectedRevision,
  });
const create = async (remind_at = "2020-01-01T00:00:00Z") => {
  const task = await exec("task_create", {
      title: "Synthetic independently controlled reminder task",
    }),
    reminder = await exec("reminder_create", {
      task_id: task.entity_id,
      remind_at,
    });
  return { task, reminder };
};
const daily = () =>
  service.execute(
    "system_daily_run",
    {},
    { ...principal, channel: "system" },
    { idempotencyKey: randomUUID() },
  );
const list = () =>
  service.query("reminder_list", {}, principal) as Promise<
    PageDTO<ReminderDTO>
  >;
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});
describe("Audited owner reminder pause, resume and cancellation", () => {
  it("paused_due_reminder_is_excluded_then_explicit_past_due_resume_delivers_exactly_once", async () => {
    const { task, reminder } = await create(),
      key = randomUUID(),
      paused = await exec(
        "reminder_pause",
        { reminder_id: reminder.entity_id },
        1,
        key,
      );
    expect(
      await exec("reminder_pause", { reminder_id: reminder.entity_id }, 1, key),
    ).toMatchObject({ replayed: true, version: paused.version });
    expect((await list()).items[0]).toMatchObject({
      state: "Paused",
      remind_at: "2020-01-01T00:00:00.000Z",
      revision: 2,
    });
    expect((await daily()).data).toMatchObject({ delivered: 0, cancelled: 0 });
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ total: 0 });
    const resumed = await exec(
      "reminder_resume",
      { reminder_id: reminder.entity_id },
      paused.version,
    );
    expect(resumed.data).toMatchObject({
      state: "Pending",
      past_due: true,
      remind_at: "2020-01-01T00:00:00.000Z",
      warnings: ["REMINDER_PAST_DUE_RESUMED"],
      revision: 3,
    });
    expect((await daily()).data).toMatchObject({ delivered: 1, cancelled: 0 });
    expect((await daily()).data).toMatchObject({ delivered: 0 });
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ total: 1 });
    expect((await list()).items[0]).toMatchObject({
      state: "Succeeded",
      revision: 4,
    });
    for (const command of [
      "reminder_pause",
      "reminder_resume",
      "reminder_cancel",
    ] as const)
      await expect(
        exec(command, { reminder_id: reminder.entity_id }, 4),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", status: 409 });
    const audit = (
      await db.query<{
        event_type: string;
        before: { state: string };
        after: { state: string; warnings?: string[] };
      }>(
        "SELECT event_type,before,after FROM activity_events WHERE owner_id=$1 AND entity_id=$2 ORDER BY occurred_at",
        [principal.ownerId, reminder.entity_id],
      )
    ).rows;
    expect(
      audit.filter((event) => event.event_type === "reminder_pause"),
    ).toHaveLength(1);
    expect(
      audit.find((event) => event.event_type === "reminder_resume"),
    ).toMatchObject({
      before: { state: "Paused" },
      after: { state: "Pending", warnings: ["REMINDER_PAST_DUE_RESUMED"] },
    });
    expect(
      audit.filter((event) => event.event_type === "reminder.delivered"),
    ).toHaveLength(1);
    expect(
      await service.query("task_get", { task_id: task.entity_id }, principal),
    ).toMatchObject({ revision: 1, status: "Inbox" });
  });
  it("future_resume_preserves_timestamp_and_does_not_claim_past_due_or_delivery", async () => {
    const { reminder } = await create("2035-01-01T00:00:00Z");
    const paused = await exec(
        "reminder_pause",
        { reminder_id: reminder.entity_id },
        1,
      ),
      resumed = await exec(
        "reminder_resume",
        { reminder_id: reminder.entity_id },
        paused.version,
      );
    expect(resumed.data).toMatchObject({
      past_due: false,
      warnings: [],
      remind_at: "2035-01-01T00:00:00.000Z",
    });
    expect((await daily()).data).toMatchObject({ delivered: 0 });
  });
  it("cancellation_preserves_pending_and_paused_records_and_terminal_state_never_resends", async () => {
    for (const pausedFirst of [false, true]) {
      const { reminder } = await create();
      const revision = pausedFirst
        ? (await exec("reminder_pause", { reminder_id: reminder.entity_id }, 1))
            .version
        : 1;
      const key = randomUUID(),
        cancelled = await exec(
          "reminder_cancel",
          { reminder_id: reminder.entity_id },
          revision,
          key,
        );
      expect(cancelled.data).toMatchObject({
        state: "Cancelled",
        remind_at: "2020-01-01T00:00:00.000Z",
      });
      expect(
        await exec(
          "reminder_cancel",
          { reminder_id: reminder.entity_id },
          revision,
          key,
        ),
      ).toMatchObject({ replayed: true });
      await expect(
        exec(
          "reminder_resume",
          { reminder_id: reminder.entity_id },
          cancelled.version,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    }
    expect((await list()).total).toBe(2);
    expect((await daily()).data).toMatchObject({ delivered: 0, cancelled: 0 });
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ total: 0 });
  });
  it("owner_scope_revision_and_input_guards_prevent_unauthorized_or_stale_controls", async () => {
    const { reminder } = await create();
    for (const actor of [
      { ...principal, ownerId: `synthetic-${randomUUID()}` },
      { ...principal, channel: "MCP" as const, scopes: ["tasks:read"] },
    ])
      await expect(
        service.execute(
          "reminder_pause",
          { reminder_id: reminder.entity_id },
          actor,
          { idempotencyKey: randomUUID(), expectedRevision: 1 },
        ),
      ).rejects.toMatchObject({
        code: actor.scopes.includes("admin:manage")
          ? "ENTITY_NOT_FOUND"
          : "INSUFFICIENT_PERMISSIONS",
      });
    await expect(
      exec("reminder_pause", { reminder_id: reminder.entity_id }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec(
        "reminder_pause",
        { reminder_id: reminder.entity_id, remind_at: "2035-01-01T00:00:00Z" },
        1,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec("reminder_resume", { reminder_id: reminder.entity_id }, 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await exec("reminder_pause", { reminder_id: reminder.entity_id }, 1);
    await expect(
      exec("reminder_resume", { reminder_id: reminder.entity_id }, 1),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const client = {
      ...principal,
      channel: "MCP" as const,
      scopes: ["tasks:write"],
    };
    const cancelled = await service.execute(
      "reminder_cancel",
      { reminder_id: reminder.entity_id },
      client,
      { idempotencyKey: randomUUID(), expectedRevision: 2 },
    );
    expect(cancelled.data).toMatchObject({ state: "Cancelled" });
  });
  it("competing_pause_and_cancel_share_expected_revision_and_cannot_silently_overwrite", async () => {
    const { reminder } = await create();
    const results = await Promise.allSettled([
      exec("reminder_pause", { reminder_id: reminder.entity_id }, 1),
      exec("reminder_cancel", { reminder_id: reminder.entity_id }, 1),
    ]);
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
    expect((await list()).items[0].revision).toBe(2);
  });
  it("resumed_closed_task_reminder_is_cancelled_audited_and_never_delivered", async () => {
    const { task, reminder } = await create();
    await exec("reminder_pause", { reminder_id: reminder.entity_id }, 1);
    await exec("task_complete", { task_id: task.entity_id }, 1);
    await exec("reminder_resume", { reminder_id: reminder.entity_id }, 2);
    expect((await daily()).data).toMatchObject({ delivered: 0, cancelled: 1 });
    expect((await list()).items[0].state).toBe("Cancelled");
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ total: 0 });
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND entity_id=$2 AND event_type='reminder.cancelled_for_closed_task'",
          [principal.ownerId, reminder.entity_id],
        )
      ).rows,
    ).toHaveLength(1);
  });
});
