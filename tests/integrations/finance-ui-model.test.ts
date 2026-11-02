import { describe, expect, it } from "vitest";
import {
  euroInput,
  FINANCE_JSON_MAX_BYTES,
  financeMonth,
  financeEditInput,
  normalizeFinanceDigits,
  parseEuroCents,
  serializeFinanceExport,
  shiftFinanceMonth,
} from "../../features/finance-model";

describe("finance JSON download boundaries", () => {
  it("downloads a near-limit multilingual export that direct import can read", () => {
    const data = {
      format: "ramin-life-os/finance/1",
      accounts: [],
      categories: [],
      plans: Array.from({ length: 1000 }, (_, index) => ({
        title: `هزینهٔ آزمایشی ${index}`,
        notes: "",
      })),
      transactions: [],
    };
    const baseBytes = new TextEncoder().encode(JSON.stringify(data)).byteLength;
    data.plans[0].notes = "x".repeat(FINANCE_JSON_MAX_BYTES - baseBytes);
    expect(new Blob([JSON.stringify(data, null, 2)]).size).toBeGreaterThan(
      FINANCE_JSON_MAX_BYTES,
    );

    const download = serializeFinanceExport(data);
    expect(new Blob([download]).size).toBe(FINANCE_JSON_MAX_BYTES);
    expect(JSON.parse(download)).toEqual(data);
    data.plans[0].notes += "ی";
    expect(() => serializeFinanceExport(data)).toThrow(/2 MB/);
  });
});

describe("finance money inputs", () => {
  it("parses Latin, Persian and Arabic digits without fractional arithmetic", () => {
    expect(parseEuroCents("12.35")).toBe(1235);
    expect(parseEuroCents("۱۲٫۳۵")).toBe(1235);
    expect(parseEuroCents("١٢,٣٥")).toBe(1235);
    expect(parseEuroCents("0.29")).toBe(29);
    expect(parseEuroCents("۰")).toBe(0);
    expect(normalizeFinanceDigits(" \u200f۱۲٣ ")).toBe("123");
  });
  it("accepts unambiguous pasted grouping but rejects ambiguous precision", () => {
    expect(parseEuroCents("1,234.56")).toBe(123456);
    expect(parseEuroCents("1.234,56")).toBe(123456);
    expect(parseEuroCents("۱٬۲۳۴٫۵۶")).toBe(123456);
    expect(parseEuroCents("۱٬۲۳۴.۵۶")).toBe(123456);
    expect(() => parseEuroCents("1,234")).toThrow();
    expect(() => parseEuroCents("12,34.56")).toThrow();
    expect(() => parseEuroCents("1.005")).toThrow();
    expect(() => parseEuroCents("3e2")).toThrow();
    expect(() => parseEuroCents("2 00")).toThrow();
  });
  it("keeps unknown values separate from zero and restricts signed amounts", () => {
    expect(parseEuroCents("", { nullable: true })).toBeNull();
    expect(() => parseEuroCents("")).toThrow();
    expect(() => parseEuroCents("-2")).toThrow();
    expect(parseEuroCents("-2.05", { signed: true })).toBe(-205);
    expect(() => parseEuroCents("999999999999999999")).toThrow();
    expect(euroInput(null)).toBe("");
    expect(euroInput(-205)).toBe("-2.05");
    expect(euroInput(1)).toBe("0.01");
  });
});

describe("finance month navigation", () => {
  it("rolls months over year boundaries independently of local timezone", () => {
    expect(shiftFinanceMonth("2028-12", 1)).toBe("2029-01");
    expect(shiftFinanceMonth("2028-01", -1)).toBe("2027-12");
    expect(shiftFinanceMonth("2028-02", 12)).toBe("2029-02");
    expect(financeMonth("2028-02")).toBe("2028-02");
    expect(() => financeMonth("2028-13")).toThrow();
    expect(() => financeMonth("2028-2")).toThrow();
    expect(() => financeMonth("0000-01")).toThrow();
  });
});

describe("finance revision conflict drafts", () => {
  it("inherits untouched future-month values after rebasing a changed effective month", () => {
    const january = {
      plan_id: "synthetic-future-plan",
      effective_month: "2028-01",
      title: "Original",
      amount_cents: 1000,
      interval_months: 1,
      notes: "Original note",
    };
    const changed = financeEditInput(
      { ...january, effective_month: "2028-02", amount_cents: 1500 },
      january,
      ["plan_id", "effective_month"],
    );
    expect(changed).toEqual({
      plan_id: "synthetic-future-plan",
      effective_month: "2028-02",
      amount_cents: 1500,
    });
    const currentFebruary = {
      ...january,
      effective_month: "2028-02",
      title: "Remote title",
      amount_cents: 2000,
      interval_months: 3,
      notes: "Remote note",
    };
    expect({ ...currentFebruary, ...changed }).toEqual({
      ...currentFebruary,
      amount_cents: 1500,
    });
  });
  it("does not overwrite untouched fields when the user rebases a draft", () => {
    expect(
      financeEditInput(
        {
          plan_id: "synthetic-plan",
          effective_month: "2028-02",
          title: "Existing",
          amount_cents: 2500,
          notes: "My change",
          included: true,
        },
        {
          plan_id: "synthetic-plan",
          effective_month: "2028-01",
          title: "Existing",
          amount_cents: 2500,
          notes: "Old note",
          included: true,
        },
        ["plan_id", "effective_month"],
      ),
    ).toEqual({
      plan_id: "synthetic-plan",
      effective_month: "2028-02",
      notes: "My change",
    });
  });
});
