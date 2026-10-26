import {
  type DailyCapacityPreviewDTO,
  type Principal,
} from "../../shared/contracts";
import {
  DEFAULT_TIMEZONE,
  addCalendarDays,
  instantToLocalDate,
  zonedLocalToInstant,
} from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import { choice, cleanRows, date, requireScope, type Input } from "./core";

interface Interval {
  starts_at: string;
  ends_at: string;
}
interface Availability {
  busy: Interval[];
  complete: boolean;
  fresh: boolean;
  source_warnings: string[];
}

/** Union clipped intervals: overlapping sources count only once. */
function unionMinutes(intervals: Interval[], from: string, to: string): number {
  const min = Date.parse(from),
    max = Date.parse(to),
    ordered = intervals
      .map(({ starts_at, ends_at }) => ({
        start: Math.max(min, Date.parse(starts_at)),
        end: Math.min(max, Date.parse(ends_at)),
      }))
      .filter(
        ({ start, end }) =>
          Number.isFinite(start) && Number.isFinite(end) && end > start,
      )
      .sort((a, b) => a.start - b.start);
  let minutes = 0,
    start = 0,
    end = 0;
  for (const item of ordered) {
    if (item.start > end) {
      minutes += (end - start) / 60000;
      start = item.start;
      end = item.end;
    } else end = Math.max(end, item.end);
  }
  return minutes + (end - start) / 60000;
}

async function readableCalendarWarnings(
  tx: SqlClient,
  ownerId: string,
  warnings: string[],
): Promise<{
  messages: string[];
  issues: { source_title: string; code: string }[];
}> {
  if (!warnings.length) return { messages: [], issues: [] };
  const sources = await tx.query<{ source_id: string; title: string }>(
      "SELECT source_id,title FROM calendar_sources WHERE owner_id=$1",
      [ownerId],
    ),
    names = new Map(
      sources.rows.map((source) => [source.source_id, source.title]),
    );
  const issues = warnings.map((warning) => {
    if (warning === "SELECTED_SOURCE_UNAVAILABLE")
      return { source_title: "", code: "SELECTED_SOURCE_UNAVAILABLE" };
    const separator = warning.indexOf(":"),
      sourceId = separator < 0 ? "" : warning.slice(0, separator),
      code = separator < 0 ? warning : warning.slice(separator + 1),
      title = names.get(sourceId) ?? "منبع تقویم";
    const known = [
      "SOURCE_COVERAGE_INCOMPLETE",
      "SOURCE_NOT_SYNCED",
      "SOURCE_SYNC_IN_PROGRESS",
      "SOURCE_STALE",
      "CACHE_EXPANSION_FAILED",
      "ACCESS_REVOKED",
    ];
    return {
      source_title: title,
      code: known.includes(code) ? code : "SOURCE_ERROR",
    };
  });
  return {
    issues,
    messages: issues.map(({ source_title: title, code }) => {
      if (code === "SELECTED_SOURCE_UNAVAILABLE")
        return "یکی از منابع انتخاب‌شدهٔ تقویم در دسترس نیست.";
      switch (code) {
        case "SOURCE_COVERAGE_INCOMPLETE":
          return `پوشش رویدادهای «${title}» ناقص است.`;
        case "SOURCE_NOT_SYNCED":
          return `«${title}» هنوز همگام‌سازی نشده است.`;
        case "SOURCE_SYNC_IN_PROGRESS":
          return `همگام‌سازی «${title}» هنوز کامل نشده است.`;
        case "SOURCE_STALE":
          return `اطلاعات «${title}» قدیمی است.`;
        case "CACHE_EXPANSION_FAILED":
          return `خواندن داده‌های ذخیره‌شدهٔ «${title}» ناموفق بود.`;
        case "ACCESS_REVOKED":
          return `دسترسی «${title}» قطع شده است.`;
        default:
          return `اطلاعات «${title}» کامل یا تازه نیست؛ وضعیت اتصال را بررسی کنید.`;
      }
    }),
  };
}

/** Read-only load preview. No calendar calls leave the cache or infer working hours. */
export async function dailyCapacityPreview(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  calendarAvailability: (from: string, to: string) => Promise<Availability>,
): Promise<DailyCapacityPreviewDTO> {
  requireScope(principal, "tasks");
  const requestedDate =
      date(input, "date") ?? instantToLocalDate(Date.now(), DEFAULT_TIMEZONE),
    period = choice(input, "period", ["day", "week"] as const, "day"),
    weekday = new Date(requestedDate + "T12:00:00Z").getUTCDay(),
    fromDate =
      period === "week"
        ? addCalendarDays(requestedDate, -((weekday + 6) % 7))
        : requestedDate,
    toDate = addCalendarDays(fromDate, period === "week" ? 7 : 1),
    from = zonedLocalToInstant(fromDate + "T00:00", DEFAULT_TIMEZONE),
    to = zonedLocalToInstant(toDate + "T00:00", DEFAULT_TIMEZONE);
  const focusRows = cleanRows(
    (
      await tx.query<{
        task_id: string;
        estimated_minutes: number | null;
        status: string;
        archived_at: string | null;
      }>(
        "SELECT i.task_id,t.estimated_minutes,t.status,t.archived_at FROM daily_focus_items i JOIN tasks t ON t.task_id=i.task_id AND t.owner_id=i.owner_id WHERE i.owner_id=$1 AND i.focus_date>=$2 AND i.focus_date<$3 ORDER BY i.focus_date,i.sort_key",
        [principal.ownerId, fromDate, toDate],
      )
    ).rows,
  );
  const counts = new Map<string, number>();
  for (const row of focusRows)
    counts.set(row.task_id, (counts.get(row.task_id) ?? 0) + 1);
  const unique = [
      ...new Map(focusRows.map((row) => [row.task_id, row])).values(),
    ],
    active = unique.filter((row) => row.archived_at === null),
    open = active.filter(
      (row) => row.status !== "Done" && row.status !== "Cancelled",
    ),
    calendarAllowed =
      principal.scopes.includes("calendar:read") ||
      principal.scopes.includes("admin:manage"),
    timeAllowed =
      principal.scopes.includes("time:read") ||
      principal.scopes.includes("admin:manage"),
    calendar = calendarAllowed ? await calendarAvailability(from, to) : null,
    calendarWarnings = calendar
      ? await readableCalendarWarnings(
          tx,
          principal.ownerId,
          calendar.source_warnings,
        )
      : { messages: [], issues: [] },
    workRows = timeAllowed
      ? cleanRows(
          (
            await tx.query<Interval>(
              "SELECT starts_at,ends_at FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL AND starts_at<$3 AND ends_at>$2 ORDER BY starts_at,entry_id",
              [principal.ownerId, from, to],
            )
          ).rows,
        )
      : null,
    knownIntervals = [...(calendar?.busy ?? []), ...(workRows ?? [])];
  return {
    date: requestedDate,
    period,
    timezone: DEFAULT_TIMEZONE,
    from_date: fromDate,
    to_date_exclusive: toDate,
    focus: {
      open_selected_task_count: open.length,
      closed_selected_task_count: active.length - open.length,
      archived_selected_task_count: unique.length - active.length,
      registered_estimate_minutes: open.reduce(
        (sum, row) => sum + (row.estimated_minutes ?? 0),
        0,
      ),
      unknown_estimate_task_ids: open
        .filter((row) => row.estimated_minutes === null)
        .map((row) => row.task_id),
      repeated_task_ids: [...counts]
        .filter(([, count]) => count > 1)
        .map(([taskId]) => taskId),
    },
    calendar: {
      access: calendarAllowed ? "granted" : "not_granted",
      busy_minutes: calendar ? unionMinutes(calendar.busy, from, to) : null,
      complete: calendar?.complete ?? null,
      fresh: calendar?.fresh ?? null,
      source_warnings: calendarWarnings.messages,
      source_issues: calendarWarnings.issues,
    },
    work: {
      access: timeAllowed ? "granted" : "not_granted",
      occupied_minutes: workRows ? unionMinutes(workRows, from, to) : null,
      entry_count: workRows?.length ?? null,
    },
    known_busy_minutes:
      calendarAllowed || timeAllowed
        ? unionMinutes(knownIntervals, from, to)
        : null,
    busy_coverage:
      calendarAllowed && timeAllowed && calendar?.complete && calendar.fresh
        ? "complete"
        : calendarAllowed || timeAllowed
          ? "partial"
          : "unknown",
  };
}
