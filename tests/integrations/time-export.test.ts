import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  exportEmployerXlsx,
  monthlySummary,
  type WorkEntry,
  workOverlapSummary,
} from "../../server/integrations/time";
const entries: WorkEntry[] = [
  {
    employer: "Jena",
    starts_at: "2026-06-01T21:30Z",
    ends_at: "2026-06-01T22:30Z",
    description: "=SUM(1,2)\nشرح فارسی",
  },
  {
    employer: "Seewiesen",
    starts_at: "2026-06-02T08:00Z",
    ends_at: "2026-06-02T10:30Z",
    description: "Different workplace",
  },
];
it("exports separate Jena and Seewiesen hours and original literal descriptions across midnight", async () => {
  const bytes = await exportEmployerXlsx(entries, "2026-06", "Jena");
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    bytes as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  const sheet = book.getWorksheet("Jena")!;
  expect(sheet.getCell("A2").value).toBe("2026-06-01");
  expect(sheet.getCell("C2").value).toEqual(new Date("1899-12-31T00:00:00Z"));
  expect(sheet.getCell("D2").value).toEqual({ formula: "F2*24", result: 0.5 });
  expect(sheet.getCell("E2").value).toBe(entries[0].description);
  expect(sheet.getCell("E3").value).toBe(entries[0].description);
  expect(sheet.getCell("D4").value).toEqual({
    formula: "SUM(D2:D3)",
    result: 1,
  });
  const second = new ExcelJS.Workbook();
  await second.xlsx.load(
    (await exportEmployerXlsx(
      entries,
      "2026-06",
      "Seewiesen",
    )) as unknown as Parameters<typeof second.xlsx.load>[0],
  );
  expect(second.getWorksheet("Seewiesen")!.getCell("D2").value).toEqual({
    formula: "F2*24",
    result: 2.5,
  });
  expect(monthlySummary(entries, "2026-06", "Jena")).toMatchObject({
    hours: 1,
    days: 2,
  });
});
it("exports editable duration/daily formulas, literal text, IDs and description details", async () => {
  const bytes = await exportEmployerXlsx(
    entries.map((entry, index) => ({
      ...entry,
      entry_id: "synthetic-entry-" + index,
    })),
    "2026-06",
    "Jena",
  );
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    bytes as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  const sheet = book.getWorksheet("Jena")!;
  expect(sheet.getCell("F2").numFmt).toBe("[h]:mm");
  expect(sheet.getCell("F2").value).toEqual({
    formula: "MAX(0,C2-B2+J2/1440)",
    result: new Date("1899-12-30T00:30:00Z"),
  });
  expect(sheet.getCell("G2").value).toBe("synthetic-entry-0");
  expect(sheet.getCell("E2").type).toBe(ExcelJS.ValueType.String);
  expect(book.getWorksheet("Description details")!.getCell("C2").value).toBe(
    entries[0].description,
  );
  expect(book.getWorksheet("Daily totals")!.getCell("B2").value).toMatchObject({
    formula: "SUMIF('Jena'!A2:A3,A2,'Jena'!F2:F3)",
    result: new Date("1899-12-30T00:30:00Z"),
  });
  expect(book.getWorksheet("Overlap snapshot")).toBeDefined();
});
it("reports the union of conflict minutes separately without subtracting recorded hours", () => {
  const overlapping = [0, 15, 30].map((minute) => ({
    employer: "Jena",
    description: "Synthetic",
    starts_at: `2026-06-01T08:${String(minute).padStart(2, "0")}:00Z`,
    ends_at: "2026-06-01T09:00:00Z",
  }));
  expect(workOverlapSummary(overlapping)).toMatchObject({
    conflict_minutes: 45,
  });
  expect(monthlySummary(overlapping, "2026-06", "Jena")).toMatchObject({
    minutes: 135,
    overlap_count: 3,
    conflict_minutes: 45,
  });
});
it("uses cached legacy duration across a clock change, new elapsed duration and no empty-sheet circular formula", async () => {
  const legacy: WorkEntry = {
    employer: "Jena",
    description: "Synthetic",
    starts_at: "2026-10-24T23:30:00Z",
    ends_at: "2026-10-25T02:30:00Z",
    reporting_policy: "legacy_wall",
    reported_minutes: 120,
  };
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await exportEmployerXlsx(
      [legacy],
      "2026-10",
      "Jena",
    )) as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  expect(book.getWorksheet("Jena")!.getCell("F2").value).toMatchObject({
    result: new Date("1899-12-30T02:00:00Z"),
  });
  const empty = new ExcelJS.Workbook();
  await empty.xlsx.load(
    (await exportEmployerXlsx([], "2026-10", "Jena")) as unknown as Parameters<
      typeof empty.xlsx.load
    >[0],
  );
  expect(empty.getWorksheet("Jena")!.getCell("D2").value).toBe(0);
});
it("includes cross-employer conflict evidence without exporting the other employer's descriptions", async () => {
  const rows: WorkEntry[] = [
    {
      entry_id: "synthetic-jena",
      employer: "Jena",
      description: "Synthetic Jena text",
      starts_at: "2026-10-20T08:00Z",
      ends_at: "2026-10-20T10:00Z",
    },
    {
      entry_id: "synthetic-seewiesen",
      employer: "Seewiesen",
      description: "Synthetic other employer text",
      starts_at: "2026-10-20T09:00Z",
      ends_at: "2026-10-20T11:00Z",
    },
  ];
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(
    (await exportEmployerXlsx(
      rows,
      "2026-10",
      "Jena",
    )) as unknown as Parameters<typeof book.xlsx.load>[0],
  );
  expect(book.getWorksheet("Jena")!.getCell("H2").value).toBe(
    "Overlap warning",
  );
  expect(book.getWorksheet("Overlap snapshot")!.getCell("C2").value).toBe(60);
  expect(book.getWorksheet("Description details")!.rowCount).toBe(2);
});
