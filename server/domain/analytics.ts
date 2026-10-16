import type {
  AnalyticsTrendsDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import {
  addCalendarDays,
  instantToLocalDate,
  splitIntervalByLocalDate,
  zonedLocalToInstant,
} from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import { DomainError } from "../../shared/contracts";
import { cleanRows, date as localDate, timezone, type Input } from "./core";
import { workMinutes } from "./work-log";

export function analyticsRange(input: Input) {
  const zone = timezone(input);
  if (input.from_date === undefined && input.to_date === undefined)
    return {
      timezone: zone,
      from_date: null,
      to_date: null,
      start: null,
      end: null,
    };
  const from = localDate(input, "from_date"),
    to = localDate(input, "to_date");
  if (
    !from ||
    !to ||
    to <= from ||
    (Date.parse(to + "T00:00:00Z") - Date.parse(from + "T00:00:00Z")) /
      86400000 >
      366
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Choose an ordered local date range of at most366days with an exclusive end.",
    );
  return {
    timezone: zone,
    from_date: from,
    to_date: to,
    start: zonedLocalToInstant(from + "T00:00", zone, "earlier"),
    end: zonedLocalToInstant(to + "T00:00", zone, "earlier"),
  };
}

/** Calendar weeks in the requested IANA zone, including the current partial week. */
export async function analyticsTrends(
  tx: SqlClient,
  tasks: TaskDTO[],
  input: Input,
  principal: Principal,
): Promise<AnalyticsTrendsDTO> {
  const range = analyticsRange(input),
    zone = range.timezone,
    today = instantToLocalDate(Date.now(), zone),
    weekday = new Date(today + "T00:00:00Z").getUTCDay(),
    currentMonday = addCalendarDays(today, -(weekday + 6) % 7),
    firstDate = range.from_date ?? addCalendarDays(currentMonday, -77),
    lastDate = range.to_date ? addCalendarDays(range.to_date, -1) : today,
    start = zonedLocalToInstant(firstDate + "T00:00", zone, "earlier"),
    end = zonedLocalToInstant(
      addCalendarDays(lastDate, 1) + "T00:00",
      zone,
      "earlier",
    );
  const days: AnalyticsTrendsDTO["days"] = [];
  for (let date = firstDate; date <= lastDate; date = addCalendarDays(date, 1))
    days.push({ date, created: 0, completed: 0, minutes: 0 });
  const byDate = new Map(days.map((day) => [day.date, day])),
    taskIds = tasks.map((task) => task.task_id),
    completed = new Set<string>();
  const recordCompletion = (taskId: string, value: string | null) => {
    const timestamp = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(timestamp)) return;
    const day = byDate.get(instantToLocalDate(timestamp, zone)),
      key = taskId + ":" + timestamp;
    if (day && !completed.has(key)) {
      completed.add(key);
      day.completed++;
    }
  };
  for (const task of tasks) {
    const created = byDate.get(instantToLocalDate(task.created_at, zone));
    if (created) created.created++;
    recordCompletion(task.task_id, task.completed_at);
  }
  // Project only completion facts, not private activity bodies. Preserve actual
  // historical completions after reopening; retries retain the same timestamp.
  const history = await tx.query<{ task_id: string; completed_at: string }>(
    `SELECT entity_id AS task_id,
      COALESCE(NULLIF(after->>'completed_at',''),NULLIF(after->>'closed_at',''),occurred_at::text) AS completed_at
      FROM activity_events WHERE owner_id=$1 AND entity_id=ANY($2::text[])
      AND occurred_at >= $3::timestamptz AND occurred_at < $4::timestamptz
      AND after->>'status'='Done' AND before->>'status' IS DISTINCT FROM 'Done'`,
    [principal.ownerId, taskIds, start, end],
  );
  for (const completion of history.rows)
    recordCompletion(completion.task_id, completion.completed_at);
  const timeScope =
    principal.scopes.includes("time:read") ||
    principal.scopes.includes("admin:manage");
  if (timeScope) {
    const intervals = cleanRows(
      (
        await tx.query<{
          starts_at: string;
          ends_at: string;
          task_id: string | null;
          reporting_policy: string;
          reported_minutes: number | null;
          legacy_metadata: Input;
        }>(
          `SELECT starts_at,ends_at,task_id,reporting_policy,reported_minutes,legacy_metadata FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL
        AND starts_at < $3::timestamptz AND ends_at > $2::timestamptz`,
          [principal.ownerId, start, end],
        )
      ).rows,
    );
    const selected = new Set(taskIds),
      filtered = Boolean(
        input.project_id ||
        input.status ||
        input.search ||
        input.query ||
        input.readiness ||
        input.due_from ||
        input.due_to ||
        input.overdue === true,
      );
    for (const interval of intervals) {
      if (filtered && (!interval.task_id || !selected.has(interval.task_id)))
        continue;
      const clipped = {
        starts_at: new Date(
          Math.max(Date.parse(start), Date.parse(interval.starts_at)),
        ).toISOString(),
        ends_at: new Date(
          Math.min(Date.parse(end), Date.parse(interval.ends_at)),
        ).toISOString(),
      };
      for (const part of splitIntervalByLocalDate(clipped, zone)) {
        const day = byDate.get(part.date);
        if (day)
          day.minutes += workMinutes(
            { ...interval },
            Date.parse(part.starts_at),
            Date.parse(part.ends_at),
          );
      }
    }
  }
  const weeks: AnalyticsTrendsDTO["weeks"] = [],
    weekByDate = new Map<string, AnalyticsTrendsDTO["weeks"][number]>();
  for (const day of days) {
    const dayOfWeek = new Date(day.date + "T00:00:00Z").getUTCDay(),
      monday = addCalendarDays(day.date, -(dayOfWeek + 6) % 7);
    let week = weekByDate.get(monday);
    if (!week) {
      week = { week_start: monday, created: 0, completed: 0, minutes: 0 };
      weeks.push(week);
      weekByDate.set(monday, week);
    }
    week.created += day.created;
    week.completed += day.completed;
    week.minutes += day.minutes;
  }
  return {
    timezone: zone,
    from_date: firstDate,
    to_date: lastDate,
    days,
    weeks,
    time_scope_granted: timeScope,
  };
}
