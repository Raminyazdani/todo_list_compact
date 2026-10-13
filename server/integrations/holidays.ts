// Adapted from Raminyazdani/work_planner/public/holidays.mjs (MIT).
// Copyright (c) 2026 ramin_yz. Full notice: WORK_PLANNER_LICENSE.txt.
import { addCalendarDays } from "../../shared/datetime";
export const HOLIDAY_REGIONS = [
  "BOTH",
  "DE",
  "BW",
  "BY",
  "BE",
  "BB",
  "HB",
  "HH",
  "HE",
  "MV",
  "NI",
  "NW",
  "RP",
  "SL",
  "SN",
  "ST",
  "SH",
  "TH",
] as const;
export type HolidayRegion = (typeof HOLIDAY_REGIONS)[number];
export interface Holiday {
  date: string;
  name: string;
  regions: string[];
  local: boolean;
}
export interface HolidayOptions {
  assumptionDay?: boolean;
  augsburgPeaceFestival?: boolean;
  corpusChristiLocal?: boolean;
}
export const HOLIDAY_SOURCES = [
  "https://www.bundesbank.de/de/aufgaben/unbarer-zahlungsverkehr/target/feiertagskalender-2026-749314",
  "https://www.gesetze-bayern.de/Content/Document/BayFTG/true",
  "https://bravors.brandenburg.de/gesetze/ftg_2015",
  "https://www.poecking.de/unsere-gemeinde/lernen-sie-uns-kennen/ortsteile",
] as const;
export function easterSunday(year: number): string {
  if (!Number.isInteger(year) || year < 1583 || year > 9999)
    throw new RangeError("Expected a Gregorian year from 1583 to 9999.");
  const a = year % 19,
    b = Math.floor(year / 100),
    c = year % 100,
    d = Math.floor(b / 4),
    e = b % 4;
  const f = Math.floor((b + 8) / 25),
    g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30,
    i = Math.floor(c / 4),
    k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7,
    m = Math.floor((a + 11 * h + 22 * l) / 451),
    n = h + l - 7 * m + 114;
  return `${year}-${String(Math.floor(n / 31)).padStart(2, "0")}-${String((n % 31) + 1).padStart(2, "0")}`;
}
/** Recurring civil-date holidays; no historical/one-off/employer rules inferred. */
export function holidaysForYear(
  year: number,
  region: HolidayRegion = "BOTH",
  options: HolidayOptions = {},
): Holiday[] {
  const easter = easterSunday(year);
  if (!HOLIDAY_REGIONS.includes(region))
    throw new RangeError("Unknown German holiday region.");
  const selected: readonly string[] =
      region === "BOTH" ? ["TH", "BY"] : [region],
    result: Holiday[] = [];
  const add = (date: string, name: string, regions = ["DE"], local = false) => {
    const matched =
      regions[0] === "DE"
        ? regions
        : regions.filter((r) => selected.includes(r));
    if (matched.length) result.push({ date, name, regions: matched, local });
  };
  const fixed = (
    date: string,
    name: string,
    regions?: string[],
    local?: boolean,
  ) => add(`${year}-${date}`, name, regions, local);
  const relative = (
    days: number,
    name: string,
    regions?: string[],
    local?: boolean,
  ) => add(addCalendarDays(easter, days), name, regions, local);
  fixed("01-01", "Neujahr");
  relative(-2, "Karfreitag");
  relative(1, "Ostermontag");
  fixed("05-01", "Tag der Arbeit");
  relative(39, "Christi Himmelfahrt");
  relative(50, "Pfingstmontag");
  fixed("10-03", "Tag der Deutschen Einheit");
  fixed("12-25", "1. Weihnachtsfeiertag");
  fixed("12-26", "2. Weihnachtsfeiertag");
  fixed("01-06", "Heilige Drei Könige", ["BW", "BY", "ST"]);
  fixed("03-08", "Internationaler Frauentag", ["BE", "MV"]);
  relative(0, "Ostersonntag", ["BB"]);
  relative(49, "Pfingstsonntag", ["BB"]);
  relative(60, "Fronleichnam", ["BW", "BY", "HE", "NW", "RP", "SL"]);
  if (options.corpusChristiLocal)
    relative(60, "Fronleichnam", ["SN", "TH"], true);
  fixed("08-15", "Mariä Himmelfahrt", ["SL"]);
  if (options.assumptionDay ?? region === "BOTH")
    fixed("08-15", "Mariä Himmelfahrt", ["BY"], true);
  if (options.augsburgPeaceFestival)
    fixed("08-08", "Augsburger Friedensfest", ["BY"], true);
  fixed("09-20", "Weltkindertag", ["TH"]);
  fixed("10-31", "Reformationstag", [
    "BB",
    "HB",
    "HH",
    "MV",
    "NI",
    "SN",
    "ST",
    "SH",
    "TH",
  ]);
  fixed("11-01", "Allerheiligen", ["BW", "BY", "NW", "RP", "SL"]);
  let repentance = `${year}-11-22`;
  while (new Date(repentance + "T12:00:00Z").getUTCDay() !== 3)
    repentance = addCalendarDays(repentance, -1);
  add(repentance, "Buß- und Bettag", ["SN"]);
  const merged = new Map<string, Holiday>();
  for (const item of result) {
    const key = item.date + "|" + item.name,
      prior = merged.get(key);
    if (prior) {
      prior.regions = [...new Set([...prior.regions, ...item.regions])];
      prior.local &&= item.local;
    } else merged.set(key, item);
  }
  return [...merged.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name),
  );
}
export function dayFlags(
  date: string,
  region: HolidayRegion = "BOTH",
  options: HolidayOptions = {},
) {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    new Date(date + "T12:00:00Z").toISOString().slice(0, 10) !== date
  )
    throw new RangeError("Expected an ISO civil date.");
  const weekday = new Date(date + "T12:00:00Z").getUTCDay(),
    holidays = holidaysForYear(
      Number(date.slice(0, 4)),
      region,
      options,
    ).filter((h) => h.date === date);
  return {
    date,
    weekend: weekday === 0 || weekday === 6,
    isHoliday: holidays.length > 0,
    red: weekday === 0 || weekday === 6 || holidays.length > 0,
    names: holidays.map((h) => h.name),
    holidays,
  };
}
