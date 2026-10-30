import {
  DomainError,
  type Principal,
  type RoutineCheckinDTO,
  type RoutineDTO,
  type RoutineDayItemDTO,
  type PageDTO,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  cleanRows,
  date,
  entity,
  guard,
  id,
  number,
  requireScope,
  text,
  type Input,
} from "./core";
import type { Change } from "./tasks";

type RoutineCommand =
  | "routine_create"
  | "routine_update"
  | "routine_pause"
  | "routine_resume"
  | "routine_archive"
  | "routine_restore"
  | "routine_checkin_set";
type RoutineQuery = "routine_list" | "routine_day" | "routine_history";
type RoutineRow = RoutineDTO & { owner_id: string } & Input;
type CheckinRow = {
  owner_id: string;
  routine_id: string;
  local_date: string;
  done: boolean;
  checked_at: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};
type ScheduleRow = {
  start_date: string;
  weekdays: number[];
  time_of_day: string | null;
};

/** Calendar labels are deliberately independent of server and browser timezones. */
export function berlinToday(at = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const part = (type: string) =>
    parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
function weekday(label: string): number {
  return new Date(`${label}T12:00:00Z`).getUTCDay() || 7;
}
function dateBefore(label: string, days: number): string {
  return new Date(Date.parse(`${label}T12:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function selectedDays(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length > 7)
    throw new DomainError(
      "INVALID_INPUT",
      "weekdays must be an array of ISO weekdays 1–7.",
    );
  if (raw.some((item) => !Number.isInteger(item) || item < 1 || item > 7))
    throw new DomainError(
      "INVALID_INPUT",
      "weekdays must contain ISO weekdays 1–7.",
    );
  const unique = [...new Set(raw as number[])].sort((a, b) => a - b);
  if (unique.length !== raw.length)
    throw new DomainError(
      "INVALID_INPUT",
      "weekdays must not contain duplicates.",
    );
  return unique;
}
function suggestedTime(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(raw))
    throw new DomainError("INVALID_INPUT", "time_of_day must be HH:mm.");
  return raw;
}
function routineDTO(row: RoutineRow): RoutineDTO {
  return {
    routine_id: row.routine_id,
    title: row.title,
    notes: row.notes,
    start_date: row.start_date.slice(0, 10),
    weekdays: [...row.weekdays],
    time_of_day: row.time_of_day,
    timezone: row.timezone,
    enabled: row.enabled,
    archived_at: row.archived_at,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
function checkinDTO(row: CheckinRow): RoutineCheckinDTO {
  return {
    routine_id: row.routine_id,
    date: row.local_date.slice(0, 10),
    done: row.done,
    checked_at: row.checked_at,
    revision: row.revision,
  };
}
function scheduled(routine: ScheduleRow, label: string): boolean {
  return (
    label >= routine.start_date.slice(0, 10) &&
    (routine.weekdays.length === 0 || routine.weekdays.includes(weekday(label)))
  );
}
/** Today and the previous 30 Berlin calendar dates may be checked. */
function withinCheckinWindow(
  routine: ScheduleRow,
  target: string,
  today: string,
): boolean {
  return (
    target <= today &&
    target >= dateBefore(today, 30) &&
    scheduled(routine, target)
  );
}
function routineFields(input: Input, existing?: RoutineRow) {
  const title =
    input.title === undefined && existing
      ? existing.title
      : text(input, "title", undefined, 200).trim();
  const notes =
    input.notes === undefined && existing
      ? existing.notes
      : input.notes === undefined || input.notes === null
        ? ""
        : text(input, "notes", "", 10000);
  const start =
    input.start_date === undefined && existing
      ? existing.start_date.slice(0, 10)
      : date(input, "start_date");
  if (!start) throw new DomainError("INVALID_INPUT", "start_date is required.");
  const weekdays =
    input.weekdays === undefined && existing
      ? existing.weekdays
      : selectedDays(input.weekdays ?? []);
  const time =
    input.time_of_day === undefined && existing
      ? existing.time_of_day
      : suggestedTime(input.time_of_day);
  return { title, notes, start, weekdays, time };
}
async function scheduleForDate(
  tx: SqlClient,
  ownerId: string,
  routineId: string,
  label: string,
): Promise<ScheduleRow | null> {
  return (
    cleanRows(
      (
        await tx.query<ScheduleRow>(
          `SELECT start_date,weekdays,time_of_day FROM routine_schedules
     WHERE owner_id=$1 AND routine_id=$2 AND effective_date<=$3
     ORDER BY effective_date DESC LIMIT 1`,
          [ownerId, routineId, label],
        )
      ).rows,
    )[0] ?? null
  );
}
function requireRevisionZero(revision: number | undefined): void {
  if (revision !== 0)
    throw new DomainError(
      "INVALID_INPUT",
      "expectedRevision must be 0 for a new routine.",
    );
}
function requireLive(row: RoutineRow): void {
  if (row.archived_at)
    throw new DomainError(
      "INVALID_INPUT",
      "Restore the archived routine before editing it.",
    );
}

export async function routineCommand(
  tx: SqlClient,
  command: RoutineCommand,
  input: Input,
  principal: Principal,
  expectedRevision: number | undefined,
): Promise<Change> {
  const owner = principal.ownerId;
  if (command === "routine_create") {
    requireRevisionZero(expectedRevision);
    const fields = routineFields(input);
    const routineId = id("ROU");
    const row = cleanRows(
      (
        await tx.query<RoutineRow>(
          `INSERT INTO routines(routine_id,owner_id,title,notes,start_date,weekdays,time_of_day)
       VALUES($1,$2,$3,$4,$5,$6::smallint[],$7) RETURNING *`,
          [
            routineId,
            owner,
            fields.title,
            fields.notes,
            fields.start,
            fields.weekdays,
            fields.time,
          ],
        )
      ).rows,
    )[0];
    await tx.query(
      `INSERT INTO routine_schedules(owner_id,routine_id,effective_date,start_date,weekdays,time_of_day)
       VALUES($1,$2,'0001-01-01',$3,$4::smallint[],$5)`,
      [owner, routineId, fields.start, fields.weekdays, fields.time],
    );
    return {
      entityId: routineId,
      before: null,
      after: routineDTO(row),
      affected: [],
    };
  }
  const routineId = text(input, "routine_id");
  const current = await entity<RoutineRow>(
    tx,
    "routines",
    "routine_id",
    routineId,
    owner,
  );
  if (command === "routine_checkin_set") {
    const label = date(input, "date");
    if (!label) throw new DomainError("INVALID_INPUT", "date is required.");
    if (typeof input.done !== "boolean")
      throw new DomainError("INVALID_INPUT", "done must be boolean.");
    const today = berlinToday();
    if (label > today)
      throw new DomainError(
        "INVALID_INPUT",
        "Future routine check-ins are not allowed.",
      );
    if (label < dateBefore(today, 30))
      throw new DomainError(
        "INVALID_INPUT",
        "Routine check-ins can be edited only within the last 30 calendar days.",
      );
    const existing = cleanRows(
      (
        await tx.query<CheckinRow>(
          "SELECT * FROM routine_checkins WHERE owner_id=$1 AND routine_id=$2 AND local_date=$3",
          [owner, routineId, label],
        )
      ).rows,
    )[0];
    if (existing) guard(existing, expectedRevision);
    else requireRevisionZero(expectedRevision);
    if (input.done) {
      const schedule = await scheduleForDate(tx, owner, routineId, label);
      if (
        current.archived_at ||
        !current.enabled ||
        !schedule ||
        !withinCheckinWindow(schedule, label, today)
      )
        throw new DomainError(
          "INVALID_INPUT",
          "This date is not an active scheduled day within the last 30 calendar days.",
        );
    } else if (!existing) {
      throw new DomainError(
        "INVALID_INPUT",
        "There is no check-in to undo for this date.",
      );
    }
    if (existing?.done === input.done)
      return {
        entityId: routineId,
        before: checkinDTO(existing),
        after: checkinDTO(existing),
        affected: [],
      };
    const row = cleanRows(
      (
        await tx.query<CheckinRow>(
          existing
            ? `UPDATE routine_checkins SET done=$4,checked_at=CASE WHEN $4 THEN now() ELSE NULL END,
             revision=revision+1,updated_at=now()
           WHERE owner_id=$1 AND routine_id=$2 AND local_date=$3 RETURNING *`
            : `INSERT INTO routine_checkins(owner_id,routine_id,local_date,done,checked_at)
           VALUES($1,$2,$3,$4,now()) RETURNING *`,
          [owner, routineId, label, input.done],
        )
      ).rows,
    )[0];
    return {
      entityId: routineId,
      before: existing ? checkinDTO(existing) : null,
      after: checkinDTO(row),
      affected: [],
    };
  }
  guard(current, expectedRevision);
  if (command !== "routine_restore") requireLive(current);
  if (command === "routine_update") {
    if (
      !["title", "notes", "start_date", "weekdays", "time_of_day"].some((key) =>
        Object.hasOwn(input, key),
      )
    )
      throw new DomainError(
        "INVALID_INPUT",
        "At least one routine field is required.",
      );
    const fields = routineFields(input, current);
    const row = cleanRows(
      (
        await tx.query<RoutineRow>(
          `UPDATE routines SET title=$3,notes=$4,start_date=$5,weekdays=$6::smallint[],time_of_day=$7,
       revision=revision+1,updated_at=now() WHERE routine_id=$1 AND owner_id=$2 RETURNING *`,
          [
            routineId,
            owner,
            fields.title,
            fields.notes,
            fields.start,
            fields.weekdays,
            fields.time,
          ],
        )
      ).rows,
    )[0];
    if (
      fields.start !== current.start_date.slice(0, 10) ||
      fields.time !== current.time_of_day ||
      JSON.stringify(fields.weekdays) !== JSON.stringify(current.weekdays)
    ) {
      await tx.query(
        `INSERT INTO routine_schedules(owner_id,routine_id,effective_date,start_date,weekdays,time_of_day)
         VALUES($1,$2,$3,$4,$5::smallint[],$6)
         ON CONFLICT(owner_id,routine_id,effective_date)
         DO UPDATE SET start_date=EXCLUDED.start_date,weekdays=EXCLUDED.weekdays,time_of_day=EXCLUDED.time_of_day`,
        [
          owner,
          routineId,
          dateBefore(berlinToday(), -1),
          fields.start,
          fields.weekdays,
          fields.time,
        ],
      );
    }
    return {
      entityId: routineId,
      before: routineDTO(current),
      after: routineDTO(row),
      affected: [],
    };
  }
  if (command === "routine_restore" && !current.archived_at)
    throw new DomainError("INVALID_INPUT", "Routine is not archived.");
  const state = {
    routine_pause: { enabled: false, archive: false },
    routine_resume: { enabled: true, archive: false },
    routine_archive: { enabled: current.enabled, archive: true },
    routine_restore: { enabled: current.enabled, archive: false },
  }[command];
  if (!state)
    throw new DomainError("UNSUPPORTED_OPERATION", "Unknown routine command.");
  if (command === "routine_pause" && !current.enabled)
    throw new DomainError("INVALID_INPUT", "Routine is already paused.");
  if (command === "routine_resume" && current.enabled)
    throw new DomainError("INVALID_INPUT", "Routine is already active.");
  const row = cleanRows(
    (
      await tx.query<RoutineRow>(
        `UPDATE routines SET enabled=$3,archived_at=CASE WHEN $4 THEN now() ELSE NULL END,
     revision=revision+1,updated_at=now() WHERE routine_id=$1 AND owner_id=$2 RETURNING *`,
        [routineId, owner, state.enabled, state.archive],
      )
    ).rows,
  )[0];
  return {
    entityId: routineId,
    before: routineDTO(current),
    after: routineDTO(row),
    affected: [],
  };
}

export async function routineQuery(
  tx: SqlClient,
  query: RoutineQuery,
  input: Input,
  principal: Principal,
): Promise<
  | PageDTO<RoutineDTO>
  | {
      date: string;
      items: RoutineDayItemDTO[];
      total: number;
      completed: number;
    }
  | PageDTO<RoutineCheckinDTO>
> {
  requireScope(principal, "tasks");
  const owner = principal.ownerId;
  if (query === "routine_list") {
    const limit = input.limit === undefined ? 50 : number(input, "limit");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new DomainError(
        "INVALID_INPUT",
        "limit must be between 1 and 200.",
      );
    if (
      input.include_archived !== undefined &&
      typeof input.include_archived !== "boolean"
    )
      throw new DomainError(
        "INVALID_INPUT",
        "include_archived must be boolean.",
      );
    const archived = input.include_archived === true;
    let cursor: string | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
      try {
        cursor = Buffer.from(text(input, "cursor"), "base64url").toString(
          "utf8",
        );
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid cursor.");
      }
      if (!cursor?.startsWith("ROU-"))
        throw new DomainError("INVALID_INPUT", "Invalid cursor.");
      const exists = await tx.query(
        "SELECT 1 FROM routines WHERE owner_id=$1 AND routine_id=$2 AND ($3::boolean OR archived_at IS NULL)",
        [owner, cursor, archived],
      );
      if (!exists.rows.length)
        throw new DomainError(
          "INVALID_INPUT",
          "Cursor no longer exists; refresh query.",
        );
    }
    const total = Number(
      (
        await tx.query<{ count: string }>(
          "SELECT count(*) FROM routines WHERE owner_id=$1 AND ($2::boolean OR archived_at IS NULL)",
          [owner, archived],
        )
      ).rows[0].count,
    );
    const rows = cleanRows(
      (
        await tx.query<RoutineRow>(
          `SELECT * FROM routines WHERE owner_id=$1 AND ($2::boolean OR archived_at IS NULL)
       AND ($3::text IS NULL OR routine_id>$3) ORDER BY routine_id LIMIT $4`,
          [owner, archived, cursor, limit + 1],
        )
      ).rows,
    );
    const items = rows.slice(0, limit).map(routineDTO);
    return {
      items,
      total,
      next_cursor:
        rows.length > limit
          ? Buffer.from(items[items.length - 1].routine_id).toString(
              "base64url",
            )
          : null,
    };
  }
  if (query === "routine_day") {
    const label =
      input.date === undefined ? berlinToday() : date(input, "date");
    if (!label) throw new DomainError("INVALID_INPUT", "date is required.");
    const rows = cleanRows(
      (
        await tx.query<
          RoutineRow & {
            done: boolean;
            checkin_revision: number;
            checked_at: string | null;
            schedule_start_date: string;
            schedule_weekdays: number[];
            schedule_time_of_day: string | null;
          }
        >(
          `SELECT r.*,s.start_date AS schedule_start_date,s.weekdays AS schedule_weekdays,
       s.time_of_day AS schedule_time_of_day,COALESCE(c.done,false) AS done,
       COALESCE(c.revision,0) AS checkin_revision,c.checked_at
       FROM routines r JOIN LATERAL (
         SELECT start_date,weekdays,time_of_day FROM routine_schedules
         WHERE owner_id=r.owner_id AND routine_id=r.routine_id AND effective_date<=$2::date
         ORDER BY effective_date DESC LIMIT 1
       ) s ON true
       LEFT JOIN routine_checkins c
         ON c.owner_id=r.owner_id AND c.routine_id=r.routine_id AND c.local_date=$2
       WHERE r.owner_id=$1 AND r.archived_at IS NULL AND r.enabled=true
         AND s.start_date<=$2::date
         AND (cardinality(s.weekdays)=0 OR extract(isodow from $2::date)::smallint=ANY(s.weekdays))
       ORDER BY r.routine_id LIMIT 1001`,
          [owner, label],
        )
      ).rows,
    );
    if (rows.length > 1000)
      throw new DomainError(
        "INVALID_INPUT",
        "Routine day exceeds the 1000-item limit.",
      );
    const items = rows.map((row) => ({
      ...routineDTO(row),
      start_date: row.schedule_start_date.slice(0, 10),
      weekdays: [...row.schedule_weekdays],
      time_of_day: row.schedule_time_of_day,
      done: row.done,
      checkin_revision: row.checkin_revision,
      checked_at: row.checked_at,
    }));
    return {
      date: label,
      items,
      total: items.length,
      completed: items.filter((item) => item.done).length,
    };
  }
  const routineId = text(input, "routine_id");
  await entity<RoutineRow>(tx, "routines", "routine_id", routineId, owner);
  const limit = input.limit === undefined ? 30 : number(input, "limit");
  if (!Number.isInteger(limit) || limit < 1 || limit > 90)
    throw new DomainError("INVALID_INPUT", "limit must be between 1 and 90.");
  const total = Number(
    (
      await tx.query<{ count: string }>(
        "SELECT count(*) FROM routine_checkins WHERE owner_id=$1 AND routine_id=$2",
        [owner, routineId],
      )
    ).rows[0].count,
  );
  const rows = cleanRows(
    (
      await tx.query<CheckinRow>(
        "SELECT * FROM routine_checkins WHERE owner_id=$1 AND routine_id=$2 ORDER BY local_date DESC LIMIT $3",
        [owner, routineId, limit],
      )
    ).rows,
  );
  return { items: rows.map(checkinDTO), total, next_cursor: null };
}
