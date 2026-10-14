import {
  DomainError,
  type PreviewDTO,
  type Principal,
} from "../../shared/contracts";
import {
  instantToLocalDate,
  instantToLocalDateTime,
  instantToLocalTime,
} from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import {
  expandRecurrence,
  type RecurringEvent,
} from "../integrations/calendar";
import {
  audit,
  entity,
  guard,
  id,
  instant,
  json,
  now,
  object,
  requireScope,
  text,
  timezone,
  type Input,
} from "./core";
import type { Change } from "./tasks";

const COMMAND = "calendar_occurrence_reschedule_commit" as const;
function requireOccurrenceWrite(principal: Principal) {
  requireScope(principal, "calendar", true);
  if (principal.channel !== "UI" && principal.channel !== "MCP")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Occurrence moves require explicit owner interaction or an authorized calendar client.",
      {},
      403,
    );
}
async function occurrenceChange(
  tx: SqlClient,
  input: Input,
  principal: Principal,
) {
  const master = await entity(
    tx,
    "calendar_events",
    "event_id",
    text(input, "event_id"),
    principal.ownerId,
  );
  if (master.provider !== "local")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "External calendar occurrences are read-only.",
      {},
      403,
    );
  if (master.archived_at || !master.recurrence_rule || master.series_event_id)
    throw new DomainError(
      "INVALID_INPUT",
      "Choose an active local recurring series occurrence.",
    );
  const originalStart = instant(input, "occurrence_starts_at"),
    original = expandRecurrence(
      master as unknown as RecurringEvent,
      originalStart,
      new Date(Date.parse(originalStart) + 1000).toISOString(),
    ).find((event) => event.starts_at === originalStart);
  if (!original)
    throw new DomainError(
      "INVALID_INPUT",
      "The selected occurrence is absent, excluded or no longer belongs to this series.",
    );
  const start = instant(input, "starts_at"),
    end = instant(input, "ends_at"),
    zone =
      input.timezone === undefined ? String(master.timezone) : timezone(input),
    allDay =
      input.all_day === undefined ? master.all_day === true : input.all_day;
  if (
    typeof allDay !== "boolean" ||
    end <= start ||
    Date.parse(end) - Date.parse(start) > 366 * 86400000
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A valid ordered occurrence interval of at most one year is required.",
    );
  if (
    allDay &&
    (instantToLocalTime(start, zone) !== "00:00" ||
      instantToLocalTime(end, zone) !== "00:00" ||
      new Date(start).getUTCSeconds() !== 0 ||
      new Date(end).getUTCSeconds() !== 0 ||
      new Date(start).getUTCMilliseconds() !== 0 ||
      new Date(end).getUTCMilliseconds() !== 0 ||
      instantToLocalDate(end, zone) <= instantToLocalDate(start, zone))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "All-day overrides require local midnight boundaries with an exclusive later end date.",
    );
  const recurrenceId =
    master.all_day === true
      ? instantToLocalDate(originalStart, String(master.timezone))
      : instantToLocalDateTime(originalStart, String(master.timezone));
  return {
    master,
    original,
    originalStart,
    start,
    end,
    zone,
    allDay,
    recurrenceId,
  };
}
export async function previewCalendarOccurrence(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<PreviewDTO> {
  requireOccurrenceWrite(principal);
  const change = await occurrenceChange(tx, input, principal),
    overrideId = id("CE"),
    previewId = id("PREVIEW"),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString(),
    payload: Input = {
      event_id: change.master.event_id,
      occurrence_starts_at: change.originalStart,
      starts_at: change.start,
      ends_at: change.end,
      timezone: change.zone,
      all_day: change.allDay,
      recurrence_id: change.recurrenceId,
      override_event_id: overrideId,
      master_revision: Number(change.master.revision),
      preview_actor_id: principal.actorId,
    },
    revisions = {
      [String(change.master.event_id)]: Number(change.master.revision),
    };
  const changes = {
    original: {
      event_id: change.master.event_id,
      occurrence_key: change.original.occurrence_key,
      starts_at: change.original.starts_at,
      ends_at: change.original.ends_at,
      timezone: change.master.timezone,
      all_day: change.master.all_day,
    },
    override: {
      event_id: overrideId,
      series_event_id: change.master.event_id,
      original_occurrence_starts_at: change.originalStart,
      recurrence_id: change.recurrenceId,
      starts_at: change.start,
      ends_at: change.end,
      timezone: change.zone,
      all_day: change.allDay,
    },
    series: {
      event_id: change.master.event_id,
      starts_at: change.master.starts_at,
      ends_at: change.master.ends_at,
      recurrence_rule: change.master.recurrence_rule,
      added_exception: change.recurrenceId,
      revision: change.master.revision,
    },
  };
  await tx.query(
    "INSERT INTO command_previews(preview_id,owner_id,command,input,revisions,expires_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)",
    [
      previewId,
      principal.ownerId,
      COMMAND,
      json(payload),
      json(revisions),
      expiresAt,
    ],
  );
  return {
    preview_id: previewId,
    command: COMMAND,
    input: payload,
    expires_at: expiresAt,
    revisions,
    affected_task_ids: change.master.task_id
      ? [String(change.master.task_id)]
      : [],
    changes: JSON.parse(json(changes)),
    warnings: ["ONLY_SELECTED_OCCURRENCE_CHANGES"],
  };
}
export async function commitCalendarOccurrence(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  operationId: string,
): Promise<Change> {
  requireOccurrenceWrite(principal);
  const previewId = text(input, "preview_id"),
    preview = (
      await tx.query<{
        command: string;
        input: Input;
        consumed_at: string | null;
        expires_at: string;
      }>(
        "SELECT command,input,consumed_at,expires_at FROM command_previews WHERE preview_id=$1 AND owner_id=$2 FOR UPDATE",
        [previewId, principal.ownerId],
      )
    ).rows[0];
  if (!preview || preview.command !== COMMAND)
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "A matching owner-bound occurrence preview is required.",
      {},
      409,
    );
  if (
    preview.consumed_at ||
    new Date(preview.expires_at).getTime() <= Date.now()
  )
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Occurrence preview expired or was already committed.",
      {},
      409,
    );
  const payload = object(preview.input);
  if (payload.preview_actor_id !== principal.actorId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "The occurrence preview belongs to another authorized actor.",
      {},
      403,
    );
  const master = await entity(
    tx,
    "calendar_events",
    "event_id",
    text(payload, "event_id"),
    principal.ownerId,
  );
  guard(master, Number(payload.master_revision));
  const change = await occurrenceChange(tx, payload, principal);
  if (change.recurrenceId !== payload.recurrence_id)
    throw new DomainError(
      "INVALID_INPUT",
      "Occurrence identity changed; obtain a new preview.",
    );
  const existing = Array.isArray(master.recurrence_exceptions)
    ? master.recurrence_exceptions
    : [];
  if (existing.length >= 1000)
    throw new DomainError(
      "INVALID_INPUT",
      "Series exception bound reached; review the series before moving another occurrence.",
    );
  const overrideId = text(payload, "override_event_id");
  await tx.query(
    "UPDATE calendar_events SET recurrence_exceptions=$3::jsonb,revision=revision+1 WHERE event_id=$1 AND owner_id=$2",
    [
      master.event_id,
      principal.ownerId,
      json([...new Set([...existing, change.recurrenceId])].sort()),
    ],
  );
  await tx.query(
    `INSERT INTO calendar_events(event_id,owner_id,title,starts_at,ends_at,timezone,all_day,task_id,notes,series_event_id,original_occurrence_starts_at,recurrence_id,category)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      overrideId,
      principal.ownerId,
      master.title,
      change.start,
      change.end,
      change.zone,
      change.allDay,
      master.task_id,
      master.notes,
      master.event_id,
      change.originalStart,
      change.recurrenceId,
      master.category ?? "Other",
    ],
  );
  await tx.query(
    "UPDATE command_previews SET consumed_at=$3 WHERE preview_id=$1 AND owner_id=$2",
    [previewId, principal.ownerId, now()],
  );
  const afterMaster = await entity(
      tx,
      "calendar_events",
      "event_id",
      String(master.event_id),
      principal.ownerId,
    ),
    override = await entity(
      tx,
      "calendar_events",
      "event_id",
      overrideId,
      principal.ownerId,
    );
  await audit(
    tx,
    principal,
    operationId,
    "calendar.occurrence_excluded",
    String(master.event_id),
    master,
    afterMaster,
    `Occurrence ${change.recurrenceId} moved to ${overrideId}`,
  );
  return {
    entityId: overrideId,
    before: null,
    after: { ...override, series_revision: afterMaster.revision },
    affected: master.task_id ? [String(master.task_id)] : [],
    reason: `Rescheduled occurrence ${change.recurrenceId} from ${master.event_id}`,
  };
}
