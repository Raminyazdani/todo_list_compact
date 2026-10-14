import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  CalendarReminderDTO,
  CommandName,
  DomainService,
  PageDTO,
  Principal,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
  key = randomUUID(),
  actor = principal,
) =>
  service.execute(command, input, actor, {
    expectedRevision: revision,
    idempotencyKey: key,
  });
const event = () =>
  exec("calendar_create_local_event", {
    title: "Synthetic unlinked work series",
    starts_at: "2027-03-21T09:00:00Z",
    ends_at: "2027-03-21T10:00:00Z",
    timezone: "Europe/Berlin",
    recurrence_rule: "FREQ=WEEKLY;COUNT=3",
    category: "Work",
  });
const reminder = (event_id: string, occurrence_starts_at?: string) =>
  exec("calendar_reminder_create", {
    event_id,
    remind_at: "2020-01-01T00:00:00Z",
    ...(occurrence_starts_at ? { occurrence_starts_at } : {}),
  });
const get = (reminder_id: string) =>
  service.query(
    "calendar_reminder_get",
    { reminder_id },
    principal,
  ) as Promise<CalendarReminderDTO>;
const daily = (key = randomUUID(), implementation = service) =>
  implementation.execute(
    "system_daily_run",
    {},
    { ...principal, channel: "system" },
    { idempotencyKey: key },
  );
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-event-reminder-" + randomUUID(),
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});

describe("Local event reminders remain separate from task scopes and workflow", () => {
  it("unlinked_event_pause_retry_past_due_resume_delivers_once_and_never_resends_terminal_reminder", async () => {
    const created = await event(),
      r = await reminder(created.entity_id, "2027-03-28T08:00:00Z"),
      key = randomUUID();
    const paused = await exec(
      "calendar_reminder_pause",
      { reminder_id: r.entity_id },
      1,
      key,
    );
    expect(
      await exec(
        "calendar_reminder_pause",
        { reminder_id: r.entity_id },
        1,
        key,
      ),
    ).toMatchObject({ replayed: true, audit_event_id: paused.audit_event_id });
    expect((await daily()).data).toMatchObject({
      delivered: 0,
      event_reminders: { delivered: 0 },
    });
    await expect(
      exec("calendar_reminder_resume", { reminder_id: r.entity_id }, 1),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const resumed = await exec(
      "calendar_reminder_resume",
      { reminder_id: r.entity_id },
      2,
    );
    expect(resumed.data).toMatchObject({
      remind_at: "2020-01-01T00:00:00.000Z",
      warnings: ["REMINDER_PAST_DUE_RESUMED"],
    });
    const first = await daily();
    expect(first.data).toMatchObject({
      delivered: 1,
      task_reminders: { delivered: 0 },
      event_reminders: { delivered: 1 },
    });
    expect((await daily()).data).toMatchObject({ delivered: 0 });
    expect(await get(r.entity_id)).toMatchObject({
      state: "Succeeded",
      event_id: created.entity_id,
      revision: 4,
    });
    for (const command of [
      "calendar_reminder_pause",
      "calendar_reminder_resume",
      "calendar_reminder_cancel",
    ] as const)
      await expect(
        exec(command, { reminder_id: r.entity_id }, 4),
      ).rejects.toMatchObject({ code: "INVALID_INPUT", status: 409 });
    expect(
      (
        await db.query("SELECT task_id FROM tasks WHERE owner_id=$1", [
          principal.ownerId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT title,task_id,category FROM calendar_events WHERE event_id=$1",
          [created.entity_id],
        )
      ).rows[0],
    ).toMatchObject({
      title: "Synthetic unlinked work series",
      task_id: null,
      category: "Work",
    });
  });
  it("calendar_notifications_are_invisible_and_immutable_to_task_only_clients", async () => {
    const created = await event();
    await reminder(created.entity_id);
    await daily();
    const taskReader = { ...principal, scopes: ["tasks:read"] },
      calendarReader = { ...principal, scopes: ["calendar:read"] };
    expect(
      await service.query("notifications_list", {}, taskReader),
    ).toMatchObject({ total: 0, items: [] });
    const notifications = (await service.query(
      "notifications_list",
      {},
      calendarReader,
    )) as PageDTO<{
      notification_id: string;
      revision: number;
      target_type: string;
      target_id: string;
    }>;
    expect(notifications.total).toBe(1);
    expect(notifications.items[0]).toMatchObject({
      target_type: "calendar",
      target_id: created.entity_id,
    });
    const n = notifications.items[0];
    await expect(
      exec(
        "notification_mark_read",
        { notification_id: n.notification_id },
        n.revision,
        randomUUID(),
        { ...principal, scopes: ["tasks:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await exec(
      "notification_mark_read",
      { notification_id: n.notification_id },
      n.revision,
      randomUUID(),
      { ...principal, scopes: ["calendar:write"] },
    );
    await expect(
      service.query("calendar_reminder_list", {}, taskReader),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.query("notifications_list", {}, { ...principal, scopes: [] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });
  it("foreign_event_scope_nonmember_excluded_and_external_references_fail_before_creation", async () => {
    const created = await event();
    await expect(
      exec(
        "calendar_reminder_create",
        { event_id: created.entity_id, remind_at: "2020-01-01T00:00:00Z" },
        undefined,
        randomUUID(),
        { ...principal, ownerId: "synthetic-foreign" },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await expect(
      exec(
        "calendar_reminder_create",
        { event_id: created.entity_id, remind_at: "2020-01-01T00:00:00Z" },
        undefined,
        randomUUID(),
        { ...principal, scopes: ["tasks:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      reminder(created.entity_id, "2027-03-28T09:00:00Z"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await exec(
      "calendar_update_local_event",
      {
        event_id: created.entity_id,
        recurrence_exceptions: ["2027-03-28"],
        apply_to_series: true,
      },
      1,
    );
    await expect(
      reminder(created.entity_id, "2027-03-28T08:00:00Z"),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await db.query(
      "UPDATE calendar_events SET provider='google' WHERE event_id=$1",
      [created.entity_id],
    );
    await expect(reminder(created.entity_id)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(
      (
        await db.query("SELECT * FROM event_reminders WHERE owner_id=$1", [
          principal.ownerId,
        ])
      ).rows,
    ).toEqual([]);
  });
  it("archiving_local_event_cancels_pending_and_paused_reminders_with_immutable_audit", async () => {
    const created = await event(),
      pending = await reminder(created.entity_id),
      paused = await reminder(created.entity_id);
    await exec("calendar_reminder_pause", { reminder_id: paused.entity_id }, 1);
    await exec(
      "calendar_delete_local_event",
      { event_id: created.entity_id },
      1,
    );
    expect(await get(pending.entity_id)).toMatchObject({ state: "Cancelled" });
    expect(await get(paused.entity_id)).toMatchObject({ state: "Cancelled" });
    expect((await daily()).data).toMatchObject({ delivered: 0 });
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND event_type='calendar.reminder_cancelled_for_archived_event'",
          [principal.ownerId],
        )
      ).rows.length,
    ).toBe(2);
    await expect(
      exec("calendar_reminder_resume", { reminder_id: paused.entity_id }, 3),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("new_EXDATE_cancels_original_occurrence_due_reminder_without_moving_its_timestamp", async () => {
    const created = await event(),
      r = await reminder(created.entity_id, "2027-03-28T08:00:00Z");
    await exec(
      "calendar_update_local_event",
      {
        event_id: created.entity_id,
        recurrence_exceptions: ["2027-03-28T10:00"],
        apply_to_series: true,
      },
      1,
    );
    expect((await daily()).data).toMatchObject({
      delivered: 0,
      cancelled: 1,
      event_reminders: { cancelled: 1 },
    });
    expect(await get(r.entity_id)).toMatchObject({
      state: "Cancelled",
      remind_at: "2020-01-01T00:00:00.000Z",
      occurrence_starts_at: "2027-03-28T08:00:00.000Z",
    });
  });
  it("notification_insert_failure_rolls_back_delivery_state_then_stable_retry_delivers_once", async () => {
    const created = await event(),
      r = await reminder(created.entity_id),
      key = randomUUID();
    const failing: Database = {
      query: db.query.bind(db),
      transaction: (owner, action) =>
        db.transaction(owner, (tx) =>
          action({
            query: async (sql, params) => {
              if (sql.startsWith("INSERT INTO notifications"))
                throw new Error("synthetic_provider_free_fault");
              return tx.query(sql, params);
            },
          }),
        ),
    };
    await expect(daily(key, createDomainService(failing))).rejects.toThrow(
      "synthetic_provider_free_fault",
    );
    expect(await get(r.entity_id)).toMatchObject({
      state: "Pending",
      revision: 1,
    });
    expect((await daily(key)).data).toMatchObject({ delivered: 1 });
    expect(await daily(key)).toMatchObject({ replayed: true });
    expect(
      (
        (await service.query(
          "notifications_list",
          {},
          principal,
        )) as PageDTO<unknown>
      ).total,
    ).toBe(1);
  });
  it("backup_restores_event_reminder_category_scoped_notification_and_accepted_job_retry", async () => {
    const created = await event(),
      r = await reminder(created.entity_id),
      key = randomUUID();
    await daily(key);
    const backup = await service.query("backup_export", {}, principal),
      fresh = await createTestDatabase();
    try {
      const restored = createDomainService(fresh);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restored.query(
          "calendar_reminder_get",
          { reminder_id: r.entity_id },
          principal,
        ),
      ).toMatchObject({
        reminder_id: r.entity_id,
        state: "Succeeded",
        event_id: created.entity_id,
      });
      expect(await daily(key, restored)).toMatchObject({ replayed: true });
      expect(
        (
          (await restored.query(
            "notifications_list",
            {},
            { ...principal, scopes: ["tasks:read"] },
          )) as PageDTO<unknown>
        ).total,
      ).toBe(0);
      expect(
        (
          await fresh.query(
            "SELECT category FROM calendar_events WHERE event_id=$1",
            [created.entity_id],
          )
        ).rows[0],
      ).toEqual({ category: "Work" });
    } finally {
      await fresh.close?.();
    }
  });
});
