import ExcelJS from "exceljs";
import {
  findOverlaps,
  instantToLocalDate,
  instantToLocalTime,
  splitIntervalByLocalDate,
  type TimeInterval,
} from "../../shared/datetime";
export interface WorkEntry extends TimeInterval {
  entry_id?: string;
  employer: string;
  description: string;
}
export interface MonthlySummary {
  month: string;
  employer: string;
  timezone: string;
  minutes: number;
  hours: number;
  days: number;
  overlap_count: number;
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
    .flatMap((entry) => splitIntervalByLocalDate(entry, timezone))
    .filter((part) => part.date.startsWith(month));
  const minutes = portions.reduce((sum, part) => sum + part.minutes, 0);
  return {
    month,
    employer,
    timezone,
    minutes,
    hours: minutes / 60,
    days: new Set(portions.map((p) => p.date)).size,
    overlap_count: findOverlaps(selected).filter(
      (pair) =>
        instantToLocalDate(pair.first.starts_at, timezone).startsWith(month) ||
        instantToLocalDate(pair.second.starts_at, timezone).startsWith(month),
    ).length,
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
  ];
  for (const entry of entries
    .filter((e) => e.employer === employer)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at)))
    for (const part of splitIntervalByLocalDate(entry, timezone))
      if (part.date.startsWith(month)) {
        sheet.addRow({
          date: part.date,
          start: instantToLocalTime(part.starts_at, timezone),
          end:
            instantToLocalDate(part.ends_at, timezone) === part.date
              ? instantToLocalTime(part.ends_at, timezone)
              : "24:00",
          hours: part.minutes / 60,
          description: entry.description,
        });
      }
  sheet.getColumn("hours").numFmt = "0.00";
  const total = sheet.addRow({ date: "Total", hours: summary.hours });
  total.font = { bold: true };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF273F56" },
  };
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount - 1), column: 5 },
  };
  return Buffer.from(await book.xlsx.writeBuffer());
}
