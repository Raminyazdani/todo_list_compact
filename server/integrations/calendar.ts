import ICAL from "ical.js";
import * as RRulePackage from "rrule";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalDateTime,
  zonedLocalToInstant,
  intervalMinutes,
} from "../../shared/datetime";
// Node selects the package's CommonJS entry, while Next selects its ESM entry.
const RRule: typeof RRulePackage.RRule =
  RRulePackage.RRule ?? Reflect.get(RRulePackage, "default")?.RRule;

export interface CalendarOccurrence {
  uid: string;
  title: string;
  starts_at: string;
  ends_at: string;
  all_day: boolean;
  timezone: string;
  notes: string;
  provider: "ical" | "local";
  occurrence_key: string;
  original_start?: string;
  busy?: boolean;
  self_declined?: boolean;
  external_url?: string;
}
function rangeBounds(start: string, end: string) {
  const a = Date.parse(start),
    b = Date.parse(end);
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    b <= a ||
    b - a > 366 * 86400000
  )
    throw new RangeError(
      "Calendar queries must use a valid range of at most one year.",
    );
  return { a, b };
}
function icalInstant(time: ICAL.Time, timezone: string) {
  const local = `${String(time.year).padStart(4, "0")}-${String(time.month).padStart(2, "0")}-${String(time.day).padStart(2, "0")}T${String(time.hour || 0).padStart(2, "0")}:${String(time.minute || 0).padStart(2, "0")}:${String(time.second || 0).padStart(2, "0")}`;
  if (time.isDate || time.zone.tzid === "floating")
    return zonedLocalToInstant(local, timezone, "earlier");
  return time.toJSDate().toISOString();
}
/** Read-only ICS ingestion; attachments/URLs/instructions in event text never execute. */
export function parseIcal(
  text: string,
  rangeStart: string,
  rangeEnd: string,
  defaultTimezone = "Europe/Berlin",
  limit = 1000,
  selfEmail?: string,
): CalendarOccurrence[] {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || limit < 1 || limit > 5000)
    throw new RangeError("Calendar feed exceeds supported bounds.");
  const { a, b } = rangeBounds(rangeStart, rangeEnd);
  ICAL.TimezoneService.reset();
  try {
    const calendar = new ICAL.Component(ICAL.parse(text));
    for (const component of calendar.getAllSubcomponents("vtimezone")) {
      const tzid = component.getFirstPropertyValue("tzid") as string;
      if (tzid)
        ICAL.TimezoneService.register(new ICAL.Timezone(component), tzid);
    }
    const components = calendar.getAllSubcomponents("vevent");
    if (components.length > 5000)
      throw new RangeError("Too many source events.");
    const events = components.map((component) => new ICAL.Event(component));
    const result: CalendarOccurrence[] = [];
    const seen = new Set<string>();
    for (const event of events.filter((e) => !e.isRecurrenceException())) {
      if (event.component.getFirstPropertyValue("status") === "CANCELLED")
        continue;
      for (const exception of events.filter(
        (e) => e.isRecurrenceException() && e.uid === event.uid,
      ))
        event.relateException(exception);
      const sourceZone = event.component
        .getFirstProperty("dtstart")
        ?.getParameter("tzid");
      const timezone =
        typeof sourceZone === "string" ? sourceZone : defaultTimezone;
      const append = (
        start: ICAL.Time,
        end: ICAL.Time,
        title: string,
        notes: string,
        cancelled = false,
        originalStart = start,
        item = event,
      ) => {
        if (cancelled) return;
        const starts_at = icalInstant(start, timezone),
          ends_at = icalInstant(end, timezone);
        if (Date.parse(starts_at) < b && Date.parse(ends_at) > a) {
          const occurrence_key = event.uid + ":" + originalStart.toString();
          if (seen.has(occurrence_key)) return;
          intervalMinutes({ starts_at, ends_at });
          if (result.length >= limit)
            throw new RangeError(
              "Too many occurrences; query a smaller range.",
            );
          const selfDeclined =
            !!selfEmail &&
            item.attendees.some(
              (attendee) =>
                String(attendee.getFirstValue())
                  .replace(/^mailto:/i, "")
                  .toLowerCase() === selfEmail.toLowerCase() &&
                String(attendee.getParameter("partstat")).toUpperCase() ===
                  "DECLINED",
            );
          let externalUrl: string | undefined;
          const originalUrl = item.component.getFirstPropertyValue("url");
          if (typeof originalUrl === "string") {
            try {
              const url = new URL(originalUrl);
              if (
                url.protocol === "https:" &&
                ["calendar.google.com", "www.google.com"].includes(
                  url.hostname,
                ) &&
                !url.username &&
                !url.password
              )
                externalUrl = url.toString();
            } catch {
              /* Invalid source links remain plain unrendered text. */
            }
          }
          result.push({
            uid: event.uid,
            title,
            starts_at,
            ends_at,
            all_day: start.isDate,
            timezone,
            notes,
            provider: "ical",
            occurrence_key,
            original_start: icalInstant(originalStart, timezone),
            self_declined: selfDeclined,
            ...(externalUrl ? { external_url: externalUrl } : {}),
            busy:
              String(
                item.component.getFirstPropertyValue("transp") ?? "OPAQUE",
              ).toUpperCase() !== "TRANSPARENT" && !selfDeclined,
          });
          seen.add(occurrence_key);
        }
      };
      if (!event.isRecurring()) {
        append(
          event.startDate,
          event.endDate,
          event.summary || "",
          event.description || "",
        );
        continue;
      }
      const iterator = event.iterator();
      let exhausted = false;
      for (let i = 0; i < 10000; i++) {
        const occurrence = iterator.next();
        if (!occurrence || Date.parse(icalInstant(occurrence, timezone)) >= b) {
          exhausted = true;
          break;
        }
        const detail = event.getOccurrenceDetails(occurrence);
        append(
          detail.startDate,
          detail.endDate,
          detail.item.summary || "",
          detail.item.description || "",
          detail.item.component.getFirstPropertyValue("status") === "CANCELLED",
          occurrence,
          detail.item,
        );
      }
      if (!exhausted)
        throw new RangeError(
          "Recurrence expansion exceeded safe iteration bound.",
        );
      // An override can be moved into this range from an original occurrence
      // after its end. The bounded master iterator cannot discover that case.
      for (const exception of events.filter(
        (item) => item.isRecurrenceException() && item.uid === event.uid,
      )) {
        append(
          exception.startDate,
          exception.endDate,
          exception.summary || "",
          exception.description || "",
          exception.component.getFirstPropertyValue("status") === "CANCELLED",
          exception.recurrenceId,
          exception,
        );
      }
    }
    return result.sort((x, y) => x.starts_at.localeCompare(y.starts_at));
  } finally {
    ICAL.TimezoneService.reset();
  }
}

export interface RecurringEvent {
  event_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  all_day: boolean;
  notes?: string;
  recurrence_rule: string | null;
  recurrence_exceptions?: string[];
}
/** Skip old periods without changing the recurrence's original interval phase.
 * COUNT must retain its original anchor: moving it would reset consumed items.
 * The normalized BY* filters and original clock are deliberately preserved;
 * reparsing with a new DTSTART would change month-end and nth-weekday defaults.
 */
function seekUncountedCalendarRule(rule: RRulePackage.RRule, lower: number) {
  const options = rule.options,
    start = options.dtstart,
    interval = options.interval;
  if (
    options.count !== null ||
    options.tzid ||
    interval < 1 ||
    lower <= start.getTime() ||
    options.freq > RRule.DAILY
  )
    return;
  const seek = new Date(start);
  if (options.freq === RRule.YEARLY) {
    const periods =
      Math.floor(
        (new Date(lower).getUTCFullYear() - start.getUTCFullYear()) / interval,
      ) - 1;
    if (periods < 1) return;
    seek.setUTCFullYear(start.getUTCFullYear() + periods * interval, 0, 1);
  } else if (options.freq === RRule.MONTHLY) {
    const after = new Date(lower),
      elapsed =
        (after.getUTCFullYear() - start.getUTCFullYear()) * 12 +
        after.getUTCMonth() -
        start.getUTCMonth(),
      periods = Math.floor(elapsed / interval) - 1;
    if (periods < 1) return;
    // Start the whole aligned month, including BYSETPOS candidates before the
    // original day-of-month. One full period of lookbehind keeps these outside
    // the lower query boundary while preserving subsequent complete periods.
    seek.setUTCDate(1);
    seek.setUTCMonth(start.getUTCMonth() + periods * interval);
  } else {
    const step = interval * 86400000 * (options.freq === RRule.WEEKLY ? 7 : 1),
      periods = Math.floor((lower - start.getTime()) / step) - 1;
    if (periods < 1) return;
    seek.setTime(start.getTime() + periods * step);
  }
  // This rule is new per query, before its first iteration/cache read. Replacing
  // only the normalized counter start leaves COUNT/UNTIL/BYSETPOS and DST policy
  // unchanged; no recurrence data or persisted DTSTART is modified.
  options.dtstart = seek;
}
/** Expand RRULE in the originating wall clock, then resolve each date's IANA offset. */
export function expandRecurrence(
  event: RecurringEvent,
  rangeStart: string,
  rangeEnd: string,
  limit = 1000,
): CalendarOccurrence[] {
  const { a, b } = rangeBounds(rangeStart, rangeEnd);
  const duration = intervalMinutes(event) * 60000;
  const base = {
    uid: event.event_id,
    title: event.title,
    timezone: event.timezone,
    all_day: event.all_day,
    notes: event.notes || "",
    provider: "local" as const,
  };
  if (!event.recurrence_rule)
    return Date.parse(event.starts_at) < b && Date.parse(event.ends_at) > a
      ? [
          {
            ...base,
            starts_at: event.starts_at,
            ends_at: event.ends_at,
            occurrence_key: event.event_id + ":" + event.starts_at,
          },
        ]
      : [];
  if (event.recurrence_rule.length > 1000 || limit < 1 || limit > 5000)
    throw new RangeError("Recurrence input exceeds supported bounds.");
  if (new Date(event.starts_at).getUTCMilliseconds() !== 0)
    throw new RangeError(
      "RFC recurrence start must use whole-second precision.",
    );
  const localStart =
    instantToLocalDateTime(event.starts_at, event.timezone) + "Z";
  const options = RRule.parseString(
    event.recurrence_rule.replace(/^RRULE:/, ""),
  );
  if (options.until && /UNTIL=\d{8}T\d{6}Z(?:;|$)/.test(event.recurrence_rule))
    options.until = new Date(
      instantToLocalDateTime(options.until, event.timezone) + "Z",
    );
  const rule = new RRule({ ...options, dtstart: new Date(localStart) });
  const lower = a - duration - 86400000;
  if (rule.options.until && rule.options.until.getTime() < lower) return [];
  seekUncountedCalendarRule(rule, lower);
  const occurrences = rule.between(
    new Date(lower),
    new Date(b + 86400000),
    true,
    (_date, index) => index <= limit,
  );
  if (occurrences.length > limit)
    throw new RangeError("Too many occurrences; query a smaller range.");
  const exceptions = new Set(event.recurrence_exceptions || []);
  const dayLength = Math.max(
    1,
    Math.round(
      (Date.parse(
        instantToLocalDate(event.ends_at, event.timezone) + "T00:00:00Z",
      ) -
        Date.parse(
          instantToLocalDate(event.starts_at, event.timezone) + "T00:00:00Z",
        )) /
        86400000,
    ),
  );
  const result: CalendarOccurrence[] = [];
  for (const occurrence of occurrences) {
    const local = occurrence.toISOString().slice(0, 19),
      date = local.slice(0, 10);
    if (exceptions.has(date) || exceptions.has(local)) continue;
    let starts_at: string;
    try {
      starts_at = zonedLocalToInstant(local, event.timezone, "earlier");
    } catch {
      continue;
    } // RFC recurrence instances in a DST gap are skipped.
    const ends_at = event.all_day
      ? zonedLocalToInstant(
          addCalendarDays(date, dayLength) + "T00:00",
          event.timezone,
          "earlier",
        )
      : new Date(Date.parse(starts_at) + duration).toISOString();
    if (Date.parse(starts_at) < b && Date.parse(ends_at) > a)
      result.push({
        ...base,
        starts_at,
        ends_at,
        occurrence_key: event.event_id + ":" + starts_at,
      });
  }
  return result;
}
