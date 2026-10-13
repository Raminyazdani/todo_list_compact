import type { EventDTO } from "@/shared/contracts";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalDateTime,
  zonedLocalToInstant,
} from "@/shared/datetime";

/** All-day spans follow local calendar days; timed spans follow elapsed time. */
export function moveLocalEventToDate(
  event: Pick<EventDTO, "starts_at" | "ends_at" | "timezone" | "all_day">,
  date: string,
) {
  if (event.all_day) {
    const first = instantToLocalDate(event.starts_at, event.timezone);
    const last = instantToLocalDate(event.ends_at, event.timezone);
    const days = Math.round(
      (Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) /
        86400000,
    );
    if (days < 1 || days > 366)
      throw new RangeError("Invalid all-day calendar span.");
    return {
      starts_at: zonedLocalToInstant(`${date}T00:00`, event.timezone),
      ends_at: zonedLocalToInstant(
        `${addCalendarDays(date, days)}T00:00`,
        event.timezone,
      ),
    };
  }
  const wall = zonedLocalToInstant(
    `${date}T${instantToLocalDateTime(event.starts_at, event.timezone).split("T")[1]}`,
    event.timezone,
  );
  const starts_at = new Date(
    Date.parse(wall) + new Date(event.starts_at).getUTCMilliseconds(),
  ).toISOString();
  const ends_at = new Date(
    Date.parse(starts_at) +
      Date.parse(event.ends_at) -
      Date.parse(event.starts_at),
  ).toISOString();
  return { starts_at, ends_at };
}
