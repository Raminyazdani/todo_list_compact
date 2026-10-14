import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  expandRecurrence,
  type RecurringEvent,
} from "../integrations/calendar";
import {
  audit,
  cleanRows,
  entity,
  guard,
  hash,
  id,
  instant,
  requireScope,
  text,
  type Input,
} from "./core";
import type { Change } from "./tasks";

function liveOccurrence(event: Input, start: string | null) {
  if (event.archived_at || event.provider !== "local") return false;
  if (!start) return true;
  return expandRecurrence(
    event as unknown as RecurringEvent,
    start,
    new Date(Date.parse(start) + 1).toISOString(),
  ).some((occurrence) => occurrence.starts_at === start);
}
export async function eventReminderCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision?: number,
): Promise<Change> {
  requireScope(principal, "calendar", true);
  const create = command === "calendar_reminder_create";
  if (
    Object.keys(input).some(
      (key) =>
        !(
          create
            ? ["event_id", "remind_at", "occurrence_starts_at"]
            : ["reminder_id"]
        ).includes(key),
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Event reminder input contains unsupported fields.",
    );
  if (create) {
    const eventId = text(input, "event_id", undefined, 512),
      event = await entity(
        tx,
        "calendar_events",
        "event_id",
        eventId,
        principal.ownerId,
      );
    const occurrence =
      input.occurrence_starts_at === undefined
        ? null
        : instant(input, "occurrence_starts_at");
    if (!liveOccurrence(event, occurrence))
      throw new DomainError(
        "INVALID_INPUT",
        "Reminders require an active owner-local event and an exact live occurrence.",
      );
    const reminderId = id("ER");
    await tx.query(
      "INSERT INTO event_reminders(reminder_id,owner_id,event_id,occurrence_starts_at,remind_at) VALUES($1,$2,$3,$4,$5)",
      [
        reminderId,
        principal.ownerId,
        eventId,
        occurrence,
        instant(input, "remind_at"),
      ],
    );
    return {
      entityId: reminderId,
      before: null,
      after: await entity(
        tx,
        "event_reminders",
        "reminder_id",
        reminderId,
        principal.ownerId,
      ),
      affected: [],
    };
  }
  const reminderId = text(input, "reminder_id", undefined, 512),
    before = await entity(
      tx,
      "event_reminders",
      "reminder_id",
      reminderId,
      principal.ownerId,
    );
  guard(before, revision);
  const allowed =
    command === "calendar_reminder_pause"
      ? ["Pending"]
      : command === "calendar_reminder_resume"
        ? ["Paused"]
        : ["Pending", "Paused"];
  if (!allowed.includes(String(before.state)))
    throw new DomainError(
      "INVALID_INPUT",
      "Delivered and cancelled event reminders are terminal.",
      { state: before.state },
      409,
    );
  if (command === "calendar_reminder_resume") {
    const event = await entity(
      tx,
      "calendar_events",
      "event_id",
      String(before.event_id),
      principal.ownerId,
    );
    if (
      !liveOccurrence(
        event,
        before.occurrence_starts_at
          ? new Date(String(before.occurrence_starts_at)).toISOString()
          : null,
      )
    )
      throw new DomainError(
        "INVALID_INPUT",
        "The original event occurrence is no longer active.",
      );
  }
  const state =
    command === "calendar_reminder_pause"
      ? "Paused"
      : command === "calendar_reminder_resume"
        ? "Pending"
        : "Cancelled";
  const after = cleanRows(
    (
      await tx.query<Input>(
        "UPDATE event_reminders SET state=$3,revision=revision+1 WHERE reminder_id=$1 AND owner_id=$2 RETURNING *,remind_at<=now() past_due",
        [reminderId, principal.ownerId, state],
      )
    ).rows,
  )[0];
  const pastDue =
    command === "calendar_reminder_resume" && after.past_due === true;
  return {
    entityId: reminderId,
    before,
    after: { ...after, warnings: pastDue ? ["REMINDER_PAST_DUE_RESUMED"] : [] },
    affected: [],
    reason: pastDue
      ? "Owner resumed the event reminder at its original past-due timestamp."
      : undefined,
  };
}
export async function cancelEventReminders(
  tx: SqlClient,
  eventIds: string[],
  principal: Principal,
  operationId: string,
) {
  const before = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM event_reminders WHERE owner_id=$1 AND event_id=ANY($2::text[]) AND state IN ('Pending','Paused')",
        [principal.ownerId, eventIds],
      )
    ).rows,
  );
  if (!before.length) return;
  const after = cleanRows(
    (
      await tx.query<Input>(
        "UPDATE event_reminders SET state='Cancelled',revision=revision+1 WHERE owner_id=$1 AND event_id=ANY($2::text[]) AND state IN ('Pending','Paused') RETURNING *",
        [principal.ownerId, eventIds],
      )
    ).rows,
  );
  for (const reminder of before)
    await audit(
      tx,
      principal,
      operationId,
      "calendar.reminder_cancelled_for_archived_event",
      String(reminder.reminder_id),
      reminder,
      after.find((row) => row.reminder_id === reminder.reminder_id),
      "The local event was archived; no notification will be sent.",
    );
}
export async function deliverEventReminders(
  tx: SqlClient,
  principal: Principal,
  operationId: string,
) {
  const due = cleanRows(
    (
      await tx.query<Input>(
        "SELECT r.* FROM event_reminders r WHERE r.owner_id=$1 AND r.state='Pending' AND r.remind_at<=now() ORDER BY r.remind_at,r.reminder_id LIMIT 1000",
        [principal.ownerId],
      )
    ).rows,
  );
  let delivered = 0,
    cancelled = 0;
  const notificationIds: string[] = [];
  for (const reminder of due) {
    const event = await entity(
      tx,
      "calendar_events",
      "event_id",
      String(reminder.event_id),
      principal.ownerId,
    );
    const valid = liveOccurrence(
      event,
      reminder.occurrence_starts_at
        ? String(reminder.occurrence_starts_at)
        : null,
    );
    const state = valid ? "Succeeded" : "Cancelled";
    const after = cleanRows(
      (
        await tx.query<Input>(
          "UPDATE event_reminders SET state=$3,revision=revision+1 WHERE reminder_id=$1 AND owner_id=$2 RETURNING *",
          [reminder.reminder_id, principal.ownerId, state],
        )
      ).rows,
    )[0];
    if (valid) {
      const notificationId =
        "N-" +
        hash({
          owner: principal.ownerId,
          eventReminder: reminder.reminder_id,
        }).slice(0, 32);
      await tx.query(
        "INSERT INTO notifications(notification_id,owner_id,title,body,target_type,target_id) VALUES($1,$2,$3,$4,'calendar',$5) ON CONFLICT DO NOTHING",
        [
          notificationId,
          principal.ownerId,
          String(event.title),
          "یادآوری رویداد محلی",
          event.event_id,
        ],
      );
      notificationIds.push(notificationId);
      delivered++;
    } else cancelled++;
    await audit(
      tx,
      principal,
      operationId,
      valid
        ? "calendar.reminder_delivered"
        : "calendar.reminder_cancelled_for_inactive_occurrence",
      String(reminder.reminder_id),
      reminder,
      after,
    );
  }
  return { delivered, cancelled, notification_ids: notificationIds };
}
