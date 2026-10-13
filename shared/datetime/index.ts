export const DEFAULT_TIMEZONE = "Europe/Berlin";
export type Disambiguation = "reject" | "earlier" | "later";
interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string) {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  return formatters.get(zone)!;
}
function parts(epoch: number, zone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(epoch))
    if (part.type !== "literal") out[part.type] = Number(part.value);
  return out as unknown as LocalParts;
}
function wallEpoch(p: LocalParts) {
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}
function parseLocal(local: string): LocalParts {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(
    local,
  );
  if (!match)
    throw new RangeError(
      "Use YYYY-MM-DDTHH:mm[:ss] without a guessed UTC offset.",
    );
  const [year, month, day, hour, minute, second] = match
    .slice(1)
    .map((v) => Number(v || 0));
  const p = { year, month, day, hour, minute, second };
  if (
    new Date(wallEpoch(p)).toISOString().slice(0, 19) !==
    `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${String(second).padStart(2, "0")}`
  )
    throw new RangeError("Invalid local calendar date or time.");
  return p;
}
/** Resolve IANA rules for the actual date; reject gaps and request fold choice. */
export function zonedLocalToInstant(
  local: string,
  zone = DEFAULT_TIMEZONE,
  disambiguation: Disambiguation = "reject",
): string {
  const desired = parseLocal(local),
    target = wallEpoch(desired);
  const offsets = new Set<number>();
  for (let h = -36; h <= 36; h += 3) {
    const epoch = target + h * 3600000;
    offsets.add(wallEpoch(parts(epoch, zone)) - epoch);
  }
  const candidates = [...offsets]
    .map((offset) => target - offset)
    .filter((epoch) => wallEpoch(parts(epoch, zone)) === target)
    .sort((a, b) => a - b);
  if (!candidates.length)
    throw new RangeError(
      "This local time does not exist because of a time zone clock change.",
    );
  if (candidates.length > 1 && disambiguation === "reject")
    throw new RangeError(
      "This local time occurs twice; choose earlier or later.",
    );
  return new Date(
    disambiguation === "later"
      ? candidates[candidates.length - 1]
      : candidates[0],
  ).toISOString();
}
export function instantToLocalDate(
  instant: string | Date | number,
  zone = DEFAULT_TIMEZONE,
): string {
  const p = parts(new Date(instant).getTime(), zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function instantToLocalTime(
  instant: string | Date | number,
  zone = DEFAULT_TIMEZONE,
): string {
  const p = parts(new Date(instant).getTime(), zone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
export function instantToLocalDateTime(
  instant: string | Date | number,
  zone = DEFAULT_TIMEZONE,
): string {
  const p = parts(new Date(instant).getTime(), zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}T${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}:${String(p.second).padStart(2, "0")}`;
}
export function addCalendarDays(date: string, days: number): string {
  const value = new Date(date + "T12:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(value.getTime()) ||
    !Number.isInteger(days)
  )
    throw new RangeError("Invalid calendar date.");
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export interface TimeInterval {
  starts_at: string;
  ends_at: string;
}
export function intervalMinutes(interval: TimeInterval): number {
  const start = Date.parse(interval.starts_at),
    end = Date.parse(interval.ends_at);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    throw new RangeError(
      "Interval end must be after its actual start instant.",
    );
  return (end - start) / 60000;
}
export function findOverlaps<T extends TimeInterval>(
  intervals: T[],
): Array<{ first: T; second: T; overlap_minutes: number }> {
  const ordered = [...intervals].sort(
    (a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at),
  );
  ordered.forEach(intervalMinutes);
  const result = [] as Array<{ first: T; second: T; overlap_minutes: number }>;
  for (let i = 0; i < ordered.length; i++)
    for (
      let j = i + 1;
      j < ordered.length &&
      Date.parse(ordered[j].starts_at) < Date.parse(ordered[i].ends_at);
      j++
    ) {
      result.push({
        first: ordered[i],
        second: ordered[j],
        overlap_minutes:
          (Math.min(
            Date.parse(ordered[i].ends_at),
            Date.parse(ordered[j].ends_at),
          ) -
            Math.max(
              Date.parse(ordered[i].starts_at),
              Date.parse(ordered[j].starts_at),
            )) /
          60000,
      });
    }
  return result;
}
export function splitIntervalByLocalDate(
  interval: TimeInterval,
  zone = DEFAULT_TIMEZONE,
): Array<TimeInterval & { date: string; minutes: number }> {
  intervalMinutes(interval);
  let cursor = Date.parse(interval.starts_at);
  const end = Date.parse(interval.ends_at),
    result = [] as Array<TimeInterval & { date: string; minutes: number }>;
  if (end - cursor > 366 * 86400000)
    throw new RangeError("Interval exceeds the supported one-year bound.");
  while (cursor < end) {
    const date = instantToLocalDate(cursor, zone);
    const midnight = Date.parse(
      zonedLocalToInstant(addCalendarDays(date, 1) + "T00:00", zone, "earlier"),
    );
    const next = Math.min(end, midnight);
    if (next <= cursor)
      throw new RangeError("Time zone did not advance at the date boundary.");
    result.push({
      date,
      starts_at: new Date(cursor).toISOString(),
      ends_at: new Date(next).toISOString(),
      minutes: (next - cursor) / 60000,
    });
    cursor = next;
  }
  return result;
}
