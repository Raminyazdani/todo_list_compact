import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  unlink,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FinanceImportDTO } from "../../shared/contracts";
import { normalizedFinanceImport } from "../../server/domain/finance-import";
import {
  extractFinanceMarkdownTables,
  financeSourceHash,
  parseFinanceMoney,
  prepareFinanceSource,
  reconcileFinanceSource,
  type FinanceMarkdownMapping,
} from "../../server/integrations/finance-source";
import { financeImportCli } from "../../scripts/migration/finance-import";

const payload = (): FinanceImportDTO => ({
  format: "ramin-life-os/finance/1",
  currency: "EUR",
  accounts: [
    {
      external_key: "sample-account",
      title: "Sample account",
      opening_balance_cents: null,
      opening_balance_date: null,
    },
  ],
  categories: [{ external_key: "sample-category", title: "Sample category" }],
  plans: [
    {
      external_key: "sample-cost",
      title: "Sample cost",
      kind: "recurring",
      account_key: "sample-account",
      category_key: "sample-category",
      notes: "=literal_source_text",
      source_label: "Synthetic source",
      versions: [
        {
          effective_month: "2027-02",
          amount_cents: 1245,
          amount_basis: "reported",
          interval_months: 1,
          state: "active",
          included: true,
          due_day: null,
          due_precision: "unknown",
          due_on: null,
          next_due_on: null,
          target_cents: null,
          horizon_months: null,
        },
      ],
    },
  ],
  transactions: [],
});
function unnormalizedPayload() {
  const data = payload();
  data.accounts[0].external_key = " sample-account ";
  data.accounts[0].title = " Sample account ";
  data.categories[0].archived_at = "2027-01-01T02:00:00+02:00";
  data.plans[0].title = " Sample cost ";
  data.plans[0].account_key = " sample-account ";
  data.plans[0].versions.push({
    ...data.plans[0].versions[0],
    effective_month: "2027-01",
  });
  return data;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const source =
  "| Label | Amount |\n| --- | ---: |\n| A literal \\| label | €12.45 |\n| Unknown amount | — |\n";
function mapping(text = source): FinanceMarkdownMapping {
  const data = payload() as unknown as Record<string, unknown>;
  const plan = (data.plans as Record<string, unknown>[])[0];
  plan.title = { $cell: { table: 0, row: 0, column: "Label" } };
  (plan.versions as Record<string, unknown>[])[0].amount_cents = {
    $cell: { table: 0, row: 0, column: "Amount" },
    as: "cents",
  };
  return {
    format: "ramin-life-os/finance-markdown-map/1",
    expected_source_hash: sha(text),
    data,
  };
}
const folders: string[] = [];
async function folder() {
  const value = await mkdtemp(join(tmpdir(), "life-os-finance-synthetic-"));
  folders.push(value);
  return value;
}
afterEach(async () => {
  for (const path of folders.splice(0)) {
    const target = resolve(path),
      parent = resolve(tmpdir());
    if (!target.startsWith(parent + "/") && !target.startsWith(parent + "\\"))
      throw new Error("Unsafe test cleanup target");
    for (const name of await readdir(target)) await unlink(join(target, name));
    await rmdir(target);
  }
});

describe("finance source normalization", () => {
  it("parses exact decimal cents, international digits and unknown separately from zero", () => {
    expect(parseFinanceMoney("€12.45")).toBe(1245);
    expect(parseFinanceMoney("**€12.45**")).toBe(1245);
    expect(parseFinanceMoney("۱٬۲۳۴٫۵۶")).toBe(123456);
    expect(parseFinanceMoney("1.234,56 EUR")).toBe(123456);
    expect(parseFinanceMoney("1,234.56")).toBe(123456);
    expect(parseFinanceMoney("0.00")).toBe(0);
    expect(parseFinanceMoney("نامشخص")).toBeNull();
    expect(parseFinanceMoney("—")).toBeNull();
    expect(parseFinanceMoney("-2,50", { allowNegative: true })).toBe(-250);
    expect(parseFinanceMoney("1,000", { decimalSeparator: "." })).toBe(100000);
  });
  it("rejects ambiguous grouping, precision loss, formulas and unsafe amounts", () => {
    for (const value of [
      "1,234",
      "1.2345",
      "12,34.56",
      "=SUM(1,2)",
      "12 34",
      "-1.00",
      "10000000001.00",
    ])
      expect(() => parseFinanceMoney(value)).toThrow(/FINANCE_SOURCE_/);
  });
  it("uses literal table text and a source-hash-pinned mapping without interpreting instructions", () => {
    const original = source;
    const result = prepareFinanceSource(source, {
      kind: "markdown",
      mapping: mapping(),
    });
    expect(result.data.plans[0]).toMatchObject({
      title: "A literal | label",
      notes: "=literal_source_text",
      versions: [{ amount_cents: 1245 }],
    });
    expect(result.counts).toEqual({
      accounts: 1,
      categories: 1,
      plans: 1,
      transactions: 0,
    });
    expect(result.used_cells).toEqual([
      { table: 0, row: 0, column: 0 },
      { table: 0, row: 0, column: 1 },
    ]);
    expect(source).toBe(original);
    expect(
      prepareFinanceSource(source, { kind: "markdown", mapping: mapping() }),
    ).toEqual(result);
    expect(() =>
      prepareFinanceSource(source + "changed", {
        kind: "markdown",
        mapping: mapping(),
      }),
    ).toThrow("REVIEWED_MAPPING_REQUIRED");
  });
  it("keeps unknown cells null and requires explicit valid table references", () => {
    const config = mapping(),
      plan = (
        config.data as { plans: { versions: Record<string, unknown>[] }[] }
      ).plans[0];
    plan.versions[0].amount_cents = {
      $cell: { table: 0, row: 1, column: "Amount" },
      as: "cents",
    };
    expect(
      prepareFinanceSource(source, { kind: "markdown", mapping: config }).data
        .plans[0].versions[0].amount_cents,
    ).toBeNull();
    plan.versions[0].amount_cents = {
      $cell: { table: 0, row: 1, column: "Missing" },
      as: "cents",
    };
    expect(() =>
      prepareFinanceSource(source, { kind: "markdown", mapping: config }),
    ).toThrow("MISSING_CELL");
    expect(
      extractFinanceMarkdownTables(
        "```\n| hidden | table |\n| --- | --- |\n| 1 | 2 |\n```\n",
      ),
    ).toEqual([]);
    expect(
      extractFinanceMarkdownTables(
        "| a | b |\n| --- | --- |\n| `a|b` | c\\|d |\n",
      )[0].rows,
    ).toEqual([["`a|b`", "c|d"]]);
  });
  it("preserves literal backslashes and pipes inside code spans", () => {
    expect(
      extractFinanceMarkdownTables(
        "| a | b |\n| --- | --- |\n| `a\\b|c\\` | c\\|d |\n| ``a\\`b|c\\\\d`` | plain |\n",
      )[0].rows,
    ).toEqual([
      ["`a\\b|c\\`", "c|d"],
      ["``a\\`b|c\\\\d``", "plain"],
    ]);
  });
  it("rejects duplicate source keys, server-managed fields and fractional cents", () => {
    const duplicate = payload();
    duplicate.accounts.push({ ...duplicate.accounts[0] });
    expect(() =>
      prepareFinanceSource(JSON.stringify(duplicate), { kind: "json" }),
    ).toThrow("UNIQUE_EXTERNAL_KEYS");
    const managed = payload();
    Object.assign(managed.accounts[0], { owner_id: "not-authority" });
    expect(() =>
      prepareFinanceSource(JSON.stringify(managed), { kind: "json" }),
    ).toThrow("SERVER_FIELDS_FORBIDDEN");
    const fractional = payload();
    fractional.plans[0].versions[0].amount_cents = 1.2;
    expect(() =>
      prepareFinanceSource(JSON.stringify(fractional), { kind: "json" }),
    ).toThrow("INTEGER_CENTS_REQUIRED");
  });
  it("rejects a total above 1000 records and a source above the two-megabyte bound", () => {
    const bounded = payload();
    bounded.categories = Array.from({ length: 998 }, (_, index) => ({
      external_key: `category-${index}`,
      title: `Category ${index}`,
    }));
    expect(
      prepareFinanceSource(JSON.stringify(bounded), { kind: "json" }).counts
        .categories,
    ).toBe(998);
    bounded.categories.push({ external_key: "one-too-many", title: "Extra" });
    expect(() =>
      prepareFinanceSource(JSON.stringify(bounded), { kind: "json" }),
    ).toThrow("TOO_MANY_RECORDS");
    expect(() =>
      prepareFinanceSource(" ".repeat(2_000_001), { kind: "json" }),
    ).toThrow("TOO_LARGE");
  });
  it("reconciles this source's exact records while preserving unrelated owner rows", () => {
    const wanted = payload(),
      actual = payload();
    actual.categories.push({ external_key: "unrelated", title: "Other" });
    expect(reconcileFinanceSource(wanted, actual).verified).toBe(true);
    actual.plans[0].versions[0].amount_cents = 1300;
    expect(reconcileFinanceSource(wanted, actual)).toMatchObject({
      verified: false,
      differences: [
        {
          kind: "plans",
          external_key: "sample-cost",
          reason: "saved_record_differs",
        },
      ],
    });
  });
  it("reconciles authoritative trimmed keys, titles, sorted versions and archive instants", () => {
    const raw = unnormalizedPayload(),
      rawJson = JSON.stringify(raw),
      actual = normalizedFinanceImport(raw);
    expect(actual.accounts[0].external_key).toBe("sample-account");
    expect(actual.categories[0].archived_at).toBe("2027-01-01T00:00:00.000Z");
    expect(actual.plans[0].versions[0].effective_month).toBe("2027-01");
    expect(reconcileFinanceSource(raw, actual).verified).toBe(true);
    expect(JSON.stringify(raw)).toBe(rawJson);
  });
});

describe("private finance import CLI", () => {
  it("normalizes Markdown to an external private payload, replays exactly and leaves the source unchanged", async () => {
    const dir = await folder(),
      src = join(dir, "source.md"),
      map = join(dir, "mapping.json"),
      out = join(dir, "payload.json");
    await writeFile(src, source);
    await writeFile(map, JSON.stringify(mapping()));
    const args = ["--normalize", src, out, map];
    expect(await financeImportCli(args)).toMatchObject({
      status: "normalized",
      source_written: false,
      counts: { plans: 1, transactions: 0 },
    });
    expect(await financeImportCli(args)).toMatchObject({
      status: "normalized",
    });
    expect(await readFile(src, "utf8")).toBe(source);
    expect(
      JSON.parse(await readFile(out, "utf8")).plans[0].versions[0].amount_cents,
    ).toBe(1245);
  });
  it("emits a compact near-limit payload that the preview can read", async () => {
    const dir = await folder(),
      src = join(dir, "source.json"),
      out = join(dir, "payload.json"),
      creds = join(dir, "credentials.json"),
      receipt = join(dir, "receipt.json");
    const data = normalizedFinanceImport({
      ...payload(),
      accounts: [],
      categories: [],
      plans: Array.from({ length: 190 }, (_, index) => ({
        external_key: `large-plan-${index}`,
        title: "Synthetic near-limit plan",
        kind: "budget",
        notes: "x".repeat(9900),
        versions: [payload().plans[0].versions[0]],
      })),
    });
    const serialized = JSON.stringify(data);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(2_000_000);
    expect(
      Buffer.byteLength(JSON.stringify(data, null, 2) + "\n", "utf8"),
    ).toBeGreaterThan(2_000_000);
    await writeFile(src, serialized);
    await financeImportCli(["--normalize", src, out]);
    expect(await readFile(out, "utf8")).toBe(serialized);
    await writeFile(
      creds,
      JSON.stringify({
        origin: "https://synthetic.example",
        owner_id: "synthetic-owner",
        user_id: "synthetic-actor",
        email: "synthetic@example.test",
        password: "synthetic-test-only",
      }),
    );
    const request: typeof fetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      const result =
        body.operation === "whoami"
          ? { owner_id: "synthetic-owner", actor_id: "synthetic-actor" }
          : {
              preview_id: "synthetic-large-preview",
              expires_at: "2027-02-03T00:00:00Z",
              counts: {
                accounts: 0,
                categories: 0,
                plans: 190,
                transactions: 0,
                unchanged: 0,
              },
              conflicts: [],
              can_commit: true,
              source_hash: financeSourceHash(
                normalizedFinanceImport(body.input.data),
              ),
            };
      return new Response(JSON.stringify({ data: result }), { status: 200 });
    };
    expect(
      await financeImportCli(
        ["--preview", "https://synthetic.example", creds, out, receipt],
        {
          fetch: request,
          signIn: async () =>
            new Response(null, {
              status: 200,
              headers: { "Set-Cookie": "session=synthetic; HttpOnly" },
            }),
        },
      ),
    ).toMatchObject({ status: "previewed", can_commit: true });
  });
  it("retains the original preview and operation key through an uncertain commit and verifies readback", async () => {
    const dir = await folder(),
      src = join(dir, "source.json"),
      creds = join(dir, "credentials.json"),
      receipt = join(dir, "receipt.json");
    const owner = "synthetic-owner",
      actor = "synthetic-actor",
      target = "https://synthetic.example";
    const raw = unnormalizedPayload(),
      rawJson = JSON.stringify(raw);
    await writeFile(src, rawJson);
    await writeFile(
      creds,
      JSON.stringify({
        origin: target,
        owner_id: owner,
        user_id: actor,
        email: "synthetic@example.test",
        password: "synthetic-test-only",
      }),
    );
    const attempts: { key: string | null; body: unknown }[] = [];
    let uncertain = true,
      exportTooLarge = true;
    const response = (data: unknown) =>
      new Response(JSON.stringify({ data }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const request: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/query")) {
        if (body.operation === "whoami")
          return response({ owner_id: owner, actor_id: actor });
        if (body.operation === "finance_import_preview")
          return response({
            preview_id: "synthetic-preview",
            expires_at: "2027-02-03T00:00:00Z",
            counts: {
              accounts: 1,
              categories: 1,
              plans: 1,
              transactions: 0,
              unchanged: 0,
            },
            conflicts: [],
            can_commit: true,
            source_hash: "a".repeat(64),
          });
        if (body.operation === "finance_export")
          return exportTooLarge
            ? new Response(null, { status: 413 })
            : response(normalizedFinanceImport(raw));
      }
      if (String(url).endsWith("/commands")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("If-Match")).toBe("0");
        attempts.push({ key: headers.get("Idempotency-Key"), body });
        if (uncertain) {
          uncertain = false;
          throw new Error("transport details must not escape");
        }
        return response({
          operation_id: "synthetic-operation",
          data: { source_hash: "a".repeat(64) },
        });
      }
      throw new Error("Unexpected synthetic request");
    };
    const dependencies = {
      fetch: request,
      now: () => Date.parse("2027-02-02T00:00:00Z"),
      signIn: async () =>
        new Response(null, {
          status: 200,
          headers: { "Set-Cookie": "session=synthetic; HttpOnly" },
        }),
    };
    expect(
      await financeImportCli(
        ["--preview", target, creds, src, receipt],
        dependencies,
      ),
    ).toMatchObject({ status: "previewed", can_commit: true });
    await expect(
      financeImportCli(["--commit", target, creds, src, receipt], dependencies),
    ).rejects.toThrow("OUTCOME_UNCERTAIN_RETAIN_RECEIPT");
    const attempted = JSON.parse(await readFile(receipt, "utf8"));
    expect(attempted.status).toBe("attempted");
    expect(attempted.document_hash).toBe(sha(rawJson));
    expect(attempted.payload_hash).toBe(financeSourceHash(raw));
    await expect(
      financeImportCli(["--commit", target, creds, src, receipt], dependencies),
    ).rejects.toThrow("QUERY_FAILED_413");
    expect(JSON.parse(await readFile(receipt, "utf8")).status).toBe(
      "confirmed",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    expect(attempts[0].key).toBe(attempted.operation_key);
    exportTooLarge = false;
    expect(
      await financeImportCli(
        ["--commit", target, creds, src, receipt],
        dependencies,
      ),
    ).toMatchObject({ status: "verified" });
    expect(attempts).toHaveLength(2);
  });
});
