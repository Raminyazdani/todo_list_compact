import type { EventDTO, TimeEntryDTO } from "@/shared/contracts";
import { formatInTimeZone } from "date-fns-tz";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalTime,
  splitIntervalByLocalDate,
} from "@/shared/datetime";

export const WORK_ZONE = "Europe/Berlin";
export function monthDays(month: string) {
  const end = new Date(`${month}-01T12:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  const boundary = end.toISOString().slice(0, 10);
  const days: string[] = [];
  for (
    let date = `${month}-01`;
    date < boundary;
    date = addCalendarDays(date, 1)
  )
    days.push(date);
  return days;
}
export function minuteClock(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
export function snappedMinute(x: number, left: number, width: number) {
  return Math.min(
    1440,
    Math.max(0, Math.round(((x - left) / width) * 96) * 15),
  );
}
export function localPoint(date: string, minute: number) {
  return minute >= 1440
    ? `${addCalendarDays(date, Math.floor(minute / 1440))}T${minuteClock(minute % 1440)}`
    : `${date}T${minuteClock(Math.max(0, minute))}`;
}
export function intervalUnionMinutes(
  intervals: { starts_at: string; ends_at: string }[],
) {
  const sorted = intervals
    .map((value) => [Date.parse(value.starts_at), Date.parse(value.ends_at)])
    .filter(([start, end]) => Number.isFinite(start) && end > start)
    .sort((a, b) => a[0] - b[0]);
  let total = 0,
    start = 0,
    end = 0;
  for (const [a, b] of sorted) {
    if (a > end) {
      total += Math.max(0, end - start);
      start = a;
      end = b;
    } else end = Math.max(end, b);
  }
  return (total + Math.max(0, end - start)) / 60000;
}
export function workConflicts(
  entries: TimeEntryDTO[],
  events: EventDTO[],
  from: string,
  to: string,
) {
  const intersections: {
    starts_at: string;
    ends_at: string;
    first: string;
    second: string;
    label: string;
    kind: "work" | "event";
  }[] = [];
  const lower = Date.parse(from),
    upper = Date.parse(to);
  const overlap = (
    a: { starts_at: string; ends_at: string },
    b: { starts_at: string; ends_at: string },
  ) => {
    const start = Math.max(
        Date.parse(a.starts_at),
        Date.parse(b.starts_at),
        lower,
      ),
      end = Math.min(Date.parse(a.ends_at), Date.parse(b.ends_at), upper);
    return start < end
      ? {
          starts_at: new Date(start).toISOString(),
          ends_at: new Date(end).toISOString(),
        }
      : null;
  };
  entries.forEach((entry, index) => {
    for (const other of entries.slice(index + 1)) {
      const range = overlap(entry, other);
      if (range)
        intersections.push({
          ...range,
          first: entry.entry_id,
          second: other.entry_id,
          label: `${entry.employer} / ${other.employer}`,
          kind: "work",
        });
    }
    for (const event of events) {
      const metadata = event as EventDTO & {
        busy?: boolean;
        transparency?: string;
        self_response_status?: string;
      };
      if (
        metadata.busy === false ||
        event.self_declined === true ||
        metadata.transparency === "transparent" ||
        metadata.self_response_status === "declined"
      )
        continue;
      const range = overlap(entry, event);
      if (range)
        intersections.push({
          ...range,
          first: entry.entry_id,
          second: event.occurrence_key ?? event.event_id,
          label: `${entry.employer} / ${event.title}`,
          kind: "event",
        });
    }
  });
  return {
    intersections,
    minutes: intervalUnionMinutes(intersections),
    workMinutes: intervalUnionMinutes(
      intersections.filter((value) => value.kind === "work"),
    ),
    eventMinutes: intervalUnionMinutes(
      intersections.filter((value) => value.kind === "event"),
    ),
  };
}
export function workSegments(entry: TimeEntryDTO) {
  return splitIntervalByLocalDate(entry, WORK_ZONE).flatMap((segment) => {
    const start = Date.parse(segment.starts_at),
      end = Date.parse(segment.ends_at);
    const offset = (epoch: number) => formatInTimeZone(epoch, WORK_ZONE, "xxx");
    const boundaries = [start];
    let previous = start;
    for (
      let probe = Math.min(start + 3600000, end - 1);
      probe > previous;
      probe = Math.min(probe + 3600000, end - 1)
    ) {
      if (offset(probe) !== offset(previous)) {
        let lower = previous,
          upper = probe;
        while (upper - lower > 1) {
          const middle = Math.floor((lower + upper) / 2);
          if (offset(middle) === offset(previous)) lower = middle;
          else upper = middle;
        }
        boundaries.push(upper);
      }
      previous = probe;
    }
    boundaries.push(end);
    return boundaries.slice(0, -1).map((a, index) => {
      const b = boundaries[index + 1],
        [hour, minute, second = 0] = instantToLocalTime(a, WORK_ZONE)
          .split(":")
          .map(Number);
      const startMinute = hour * 60 + minute + second / 60,
        minutes = (b - a) / 60000;
      return {
        ...segment,
        starts_at: new Date(a).toISOString(),
        ends_at: new Date(b).toISOString(),
        minutes,
        startMinute,
        endMinute: startMinute + minutes,
        offset_label: offset(a),
        clock_change: boundaries.length > 2,
      };
    });
  });
}
export function entryLocal(entry: TimeEntryDTO) {
  const date = instantToLocalDate(entry.starts_at, WORK_ZONE);
  return {
    date,
    start: instantToLocalTime(entry.starts_at, WORK_ZONE),
    end: instantToLocalTime(entry.ends_at, WORK_ZONE),
    end_next_day: instantToLocalDate(entry.ends_at, WORK_ZONE) !== date,
    employer: entry.employer,
    description: entry.description,
  };
}
