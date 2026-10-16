import ExcelJS from "exceljs";
import {
  findOverlaps,
  instantToLocalDate,
  instantToLocalTime,
  splitIntervalByLocalDate,
  instantToLocalDateTime,
  zonedLocalToInstant,
  type TimeInterval,
} from "../../shared/datetime";
export interface WorkEntry extends TimeInterval {
  entry_id?: string;
  employer: string;
  description: string;
  reporting_policy?: "elapsed" | "legacy_wall";
  reported_minutes?: number | null;
  legacy_metadata?: Record<string, unknown>;
}
export interface MonthlySummary {
  month: string;
  employer: string;
  timezone: string;
  minutes: number;
  hours: number;
  days: number;
  overlap_count: number;
  conflict_minutes: number;
}
/** Reporting does not remove overlapping recorded time. */
export function reportedWorkPortions(
  entry: WorkEntry,
  timezone = "Europe/Berlin",
) {
  const portions = splitIntervalByLocalDate(entry, timezone);
  if (entry.reporting_policy !== "legacy_wall") return portions;
  const reportingZone =
    typeof entry.legacy_metadata?.timezone === "string"
      ? entry.legacy_metadata.timezone
      : timezone;
  const wallMinutes = portions.map(
    (part) =>
      (Date.parse(instantToLocalDateTime(part.ends_at, reportingZone) + "Z") -
        Date.parse(
          instantToLocalDateTime(part.starts_at, reportingZone) + "Z",
        )) /
      60000,
  );
  const totalWall = wallMinutes.reduce((sum, minutes) => sum + minutes, 0);
  const total = entry.reported_minutes ?? totalWall;
  if (total === 0) return portions.map((part) => ({ ...part, minutes: 0 }));
  if (!Number.isFinite(total) || total < 0 || totalWall <= 0)
    throw new RangeError("Invalid legacy reported duration.");
  return portions.map((part, index) => ({
    ...part,
    minutes: (wallMinutes[index] / totalWall) * total,
  }));
}
export function workOverlapSummary(
  entries: WorkEntry[],
  from = -Infinity,
  to = Infinity,
) {
  const pairs = findOverlaps(entries)
    .map((pair) => ({
      ...pair,
      start: Math.max(
        Date.parse(pair.first.starts_at),
        Date.parse(pair.second.starts_at),
        from,
      ),
      end: Math.min(
        Date.parse(pair.first.ends_at),
        Date.parse(pair.second.ends_at),
        to,
      ),
    }))
    .filter((pair) => pair.end > pair.start)
    .map((pair) => ({
      ...pair,
      overlap_minutes: (pair.end - pair.start) / 60000,
    }));
  const spans = pairs
    .map((pair) => [pair.start, pair.end])
    .sort((a, b) => a[0] - b[0]);
  let minutes = 0,
    last: number[] | undefined;
  for (const span of spans) {
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else {
      if (last) minutes += (last[1] - last[0]) / 60000;
      last = [...span];
    }
  }
  if (last) minutes += (last[1] - last[0]) / 60000;
  return { pairs, conflict_minutes: minutes };
}
export function monthlySummary(
  entries: WorkEntry[],
  month: string,
  employer: string,
  timezone = "Europe/Berlin",
): MonthlySummary {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new RangeError("Month must use YYYY-MM.");
  const selected = entries.filter((e) => e.employer === employer);
  const portions = selected
    .flatMap((entry) => reportedWorkPortions(entry, timezone))
    .filter((part) => part.date.startsWith(month));
  const minutes = portions.reduce((sum, part) => sum + part.minutes, 0);
  const [year, monthNumber] = month.split("-").map(Number);
  const nextMonth = new Date(Date.UTC(year, monthNumber, 1))
    .toISOString()
    .slice(0, 7);
  const overlap = workOverlapSummary(
    selected,
    Date.parse(zonedLocalToInstant(month + "-01T00:00", timezone, "earlier")),
    Date.parse(
      zonedLocalToInstant(nextMonth + "-01T00:00", timezone, "earlier"),
    ),
  );
  return {
    month,
    employer,
    timezone,
    minutes,
    hours: minutes / 60,
    days: new Set(portions.map((p) => p.date)).size,
    overlap_count: overlap.pairs.length,
    conflict_minutes: overlap.conflict_minutes,
  };
}
/** Employer-specific portable Excel; source text is a literal string, never formula. */
export async function exportEmployerXlsx(
  entries: WorkEntry[],
  month: string,
  employer: "Jena" | "Seewiesen",
  timezone = "Europe/Berlin",
): Promise<Buffer> {
  const summary = monthlySummary(entries, month, employer, timezone);
  const book = new ExcelJS.Workbook();
  book.creator = "Ramin Life OS";
  const sheet = book.addWorksheet(employer, {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Start", key: "start", width: 12 },
    { header: "End", key: "end", width: 12 },
    { header: "Hours", key: "hours", width: 12 },
    { header: "Description", key: "description", width: 65 },
    { header: "Duration", key: "duration", width: 14 },
    { header: "EntryID", key: "entry_id", width: 36 },
    { header: "Overlap", key: "overlap", width: 18 },
    { header: "Reporting policy", key: "policy", width: 22 },
    {
      header: "Clock adjustment (minutes)",
      key: "clock_adjustment",
      width: 25,
    },
  ];
  const overlap = workOverlapSummary(entries);
  const descriptions = book.addWorksheet("Description details");
  descriptions.columns = [
    { header: "EntryID", key: "entry_id", width: 36 },
    { header: "Date", key: "date", width: 14 },
    { header: "Description", key: "description", width: 90 },
  ];
  for (const entry of entries
    .filter((e) => e.employer === employer)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
    for (const part of reportedWorkPortions(entry, timezone))
      if (part.date.startsWith(month)) {
        const rowNumber = sheet.rowCount + 1;
        const startClock = instantToLocalTime(part.starts_at, timezone)
          .split(":")
          .map(Number);
        const endClock =
          instantToLocalDate(part.ends_at, timezone) === part.date
            ? instantToLocalTime(part.ends_at, timezone).split(":").map(Number)
            : [24, 0];
        const clockDuration =
          endClock[0] * 60 + endClock[1] - startClock[0] * 60 - startClock[1];
        const row = sheet.addRow({
          date: part.date,
          start: (startClock[0] * 60 + startClock[1]) / 1440,
          end: (endClock[0] * 60 + endClock[1]) / 1440,
          hours: { formula: `F${rowNumber}*24`, result: part.minutes / 60 },
          description: entry.description,
          duration: {
            formula: `MAX(0,C${rowNumber}-B${rowNumber}+J${rowNumber}/1440)`,
            result: part.minutes / 1440,
          },
          entry_id: entry.entry_id ?? "",
          overlap: overlap.pairs.some(
            (pair) => pair.first === entry || pair.second === entry,
          )
            ? "Overlap warning"
            : "",
          policy: entry.reporting_policy ?? "elapsed",
          clock_adjustment: part.minutes - clockDuration,
        });
        row.getCell("description").alignment = {
          wrapText: true,
          vertical: "top",
        };
        descriptions
          .addRow({
            entry_id: entry.entry_id ?? "",
            date: part.date,
            description: entry.description,
          })
          .getCell("description").alignment = { wrapText: true };
      }
  sheet.getColumn("hours").numFmt = "0.00";
  sheet.getColumn("start").numFmt = "hh:mm";
  sheet.getColumn("end").numFmt = "[h]:mm";
  sheet.getColumn("duration").numFmt = "[h]:mm";
  const lastEntryRow = sheet.rowCount;
  const total = sheet.addRow({
    date: "Total",
    hours:
      lastEntryRow < 2
        ? 0
        : { formula: `SUM(D2:D${lastEntryRow})`, result: summary.hours },
    duration:
      lastEntryRow < 2
        ? 0
        : {
            formula: `SUM(F2:F${lastEntryRow})`,
            result: summary.minutes / 1440,
          },
  });
  total.font = { bold: true };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF273F56" },
  };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount - 1), column: 10 },
  };
  const daily = book.addWorksheet("Daily totals");
  daily.columns = [
    { header: "Date", key: "date", width: 14 },
    { header: "Duration", key: "duration", width: 14 },
    { header: "Hours", key: "hours", width: 14 },
  ];
  daily.getColumn("duration").numFmt = "[h]:mm";
  const dates = [
    ...new Set(
      entries
        .filter((entry) => entry.employer === employer)
        .flatMap((entry) => reportedWorkPortions(entry, timezone))
        .filter((part) => part.date.startsWith(month))
        .map((part) => part.date),
    ),
  ].sort();
  for (const date of dates) {
    const n = daily.rowCount + 1,
      minutes = entries
        .filter((entry) => entry.employer === employer)
        .flatMap((entry) => reportedWorkPortions(entry, timezone))
        .filter((part) => part.date === date)
        .reduce((sum, part) => sum + part.minutes, 0);
    daily.addRow({
      date,
      duration: {
        formula: `SUMIF('${employer}'!A2:A${Math.max(2, lastEntryRow)},A${n},'${employer}'!F2:F${Math.max(2, lastEntryRow)})`,
        result: minutes / 1440,
      },
      hours: { formula: `B${n}*24`, result: minutes / 60 },
    });
  }
  const conflicts = book.addWorksheet("Overlap snapshot");
  conflicts.columns = [
    { header: "Entry A", key: "first", width: 36 },
    { header: "Entry B", key: "second", width: 36 },
    { header: "Minutes", key: "minutes", width: 14 },
  ];
  for (const pair of overlap.pairs.filter(
    (pair) =>
      (pair.first.employer === employer || pair.second.employer === employer) &&
      (instantToLocalDate(pair.start, timezone).startsWith(month) ||
        instantToLocalDate(pair.end - 1, timezone).startsWith(month)),
  ))
    conflicts.addRow({
      first: pair.first.entry_id ?? "",
      second: pair.second.entry_id ?? "",
      minutes: pair.overlap_minutes,
    });
  book.calcProperties.fullCalcOnLoad = true;
  return Buffer.from(await book.xlsx.writeBuffer());
}
