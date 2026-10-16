import { describe, expect, it } from "vitest";
import { prepareWorkPlannerImport } from "../../scripts/migration/work-planner";
import { monthlySummary } from "../../server/integrations/time";
const row = {
  id: "synthetic-legacy",
  jobId: "jena",
  date: "2026-10-25",
  start: "01:30",
  end: "03:30",
  endNextDay: false,
  tasks: "=SUM(1,2)\nشرح فارسی",
};
describe("one-time Work Planner conversion", () => {
  it("preserves source wall-clock reported hours while new records use actual elapsed time", () => {
    const prepared = prepareWorkPlannerImport({
      version: 1,
      revision: 22,
      entries: [row],
    });
    expect(prepared.ready).toBe(true);
    expect(prepared.entries[0]).toMatchObject({
      entry_id: "WP_synthetic-legacy",
      employer: "Jena",
      reported_minutes: 120,
      reporting_policy: "legacy_wall",
      description: row.tasks,
      legacy_metadata: row,
    });
    expect(
      (Date.parse(prepared.entries[0].ends_at) -
        Date.parse(prepared.entries[0].starts_at)) /
        60000,
    ).toBe(180);
    expect(monthlySummary(prepared.entries, "2026-10", "Jena").minutes).toBe(
      120,
    );
    expect(
      monthlySummary(
        prepared.entries.map((entry) => ({
          ...entry,
          reporting_policy: "elapsed" as const,
        })),
        "2026-10",
        "Jena",
      ).minutes,
    ).toBe(180);
  });
  it("keeps incomplete partial fields as durable draft input without inventing times", () => {
    const prepared = prepareWorkPlannerImport({
      version: 1,
      entries: [{ ...row, start: "1:", end: "" }],
    });
    expect(prepared.entries).toHaveLength(0);
    expect(prepared.drafts).toHaveLength(1);
    expect(prepared.drafts[0]).toMatchObject({
      start: "1:",
      end: "",
      description: row.tasks,
    });
  });
  it("requires an explicit autumn fold choice and rejects spring gaps even with a choice", () => {
    const folded = { ...row, start: "02:30", end: "03:30" };
    expect(
      prepareWorkPlannerImport({ version: 1, entries: [folded] }),
    ).toMatchObject({
      ready: false,
      errors: [{ source_id: row.id, code: "DST_RESOLUTION_REQUIRED" }],
    });
    expect(
      prepareWorkPlannerImport(
        { version: 1, entries: [folded] },
        { resolutions: { [row.id]: { start: "later" } } },
      ).entries[0].starts_at,
    ).toBe("2026-10-25T01:30:00.000Z");
    expect(
      prepareWorkPlannerImport(
        { version: 1, entries: [{ ...folded, date: "2026-03-29" }] },
        { resolutions: { [row.id]: { start: "earlier" } } },
      ),
    ).toMatchObject({ ready: false, errors: [{ code: "INVALID_LOCAL_TIME" }] });
  });
  it("preserves overnight/month portions, stable IDs and a byte-for-byte unchanged source", () => {
    const input = {
        version: 1,
        entries: [
          {
            ...row,
            date: "2026-10-31",
            start: "23:30",
            end: "01:30",
            endNextDay: true,
          },
        ],
      },
      original = JSON.stringify(input);
    const first = prepareWorkPlannerImport(input),
      second = prepareWorkPlannerImport(input);
    expect(first).toEqual(second);
    expect(JSON.stringify(input)).toBe(original);
    expect(monthlySummary(first.entries, "2026-10", "Jena").minutes).toBe(30);
    expect(monthlySummary(first.entries, "2026-11", "Jena").minutes).toBe(90);
  });
  it("reports invalid complete intervals without silently treating them as imported data", () => {
    expect(
      prepareWorkPlannerImport({
        version: 1,
        entries: [{ ...row, date: "2026-02-31" }],
      }),
    ).toMatchObject({ ready: false, errors: [{ code: "INVALID_INTERVAL" }] });
    expect(
      prepareWorkPlannerImport({
        version: 1,
        entries: [{ ...row, end: "01:00" }],
      }),
    ).toMatchObject({ ready: false, errors: [{ code: "INVALID_INTERVAL" }] });
    expect(() =>
      prepareWorkPlannerImport({ version: 1, entries: [row, row] }),
    ).toThrow(/unique/);
  });
});
