import { expect, it } from "vitest";
import ExcelJS from "exceljs";
import {
  exportEmployerXlsx,
  monthlySummary,
  type WorkEntry,
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
  expect(sheet.getCell("C2").value).toBe("24:00");
  expect(sheet.getCell("D2").value).toBe(0.5);
  expect(sheet.getCell("E2").value).toBe(entries[0].description);
  expect(sheet.getCell("E3").value).toBe(entries[0].description);
  expect(sheet.getCell("D4").value).toBe(1);
  const second = new ExcelJS.Workbook();
  await second.xlsx.load(
    (await exportEmployerXlsx(
      entries,
      "2026-06",
      "Seewiesen",
    )) as unknown as Parameters<typeof second.xlsx.load>[0],
  );
  expect(second.getWorksheet("Seewiesen")!.getCell("D2").value).toBe(2.5);
  expect(monthlySummary(entries, "2026-06", "Jena")).toMatchObject({
    hours: 1,
    days: 2,
  });
});
