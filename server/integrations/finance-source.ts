import { createHash } from "node:crypto";
import type { FinanceImportDTO } from "../../shared/contracts";

const MAX_BYTES = 2_000_000;
const MAX_RECORDS = 1000;
const MAX_CENTS = 1_000_000_000_000;
type ObjectValue = Record<string, unknown>;
export interface MarkdownTable {
  headers: string[];
  rows: string[][];
  header_line: number;
  row_lines: number[];
}
export interface FinanceMarkdownMapping {
  format: "ramin-life-os/finance-markdown-map/1";
  expected_source_hash: string;
  data: unknown;
}
export interface PreparedFinanceSource {
  data: FinanceImportDTO;
  document_hash: string;
  payload_hash: string;
  mapping_hash: string | null;
  counts: Record<"accounts" | "categories" | "plans" | "transactions", number>;
  used_cells: { table: number; row: number; column: number }[];
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("FINANCE_SOURCE_OBJECT_REQUIRED");
  return value as ObjectValue;
}
export function canonicalFinanceJson(value: unknown): string {
  if (Array.isArray(value))
    return "[" + value.map(canonicalFinanceJson).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(
          ([key, item]) =>
            JSON.stringify(key) + ":" + canonicalFinanceJson(item),
        )
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function financeSourceHash(value: unknown): string {
  return createHash("sha256").update(canonicalFinanceJson(value)).digest("hex");
}
const documentHash = (value: string) =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Decimal text is parsed as integer cents; unknown is distinct from zero. */
export function parseFinanceMoney(
  input: string,
  options: { decimalSeparator?: "." | ","; allowNegative?: boolean } = {},
): number | null {
  if (input.length > 200) throw new Error("FINANCE_SOURCE_AMOUNT_TOO_LARGE");
  let value = input
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 1776))
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 1632))
    .replace(/٫/g, ".")
    .replace(/٬/g, ",")
    .trim();
  value = value.replace(/^(\*\*|__)(.*?)\1$/, "$2").trim();
  if (
    ["", "-", "—", "unknown", "null", "n/a", "نامشخص"].includes(
      value.toLowerCase(),
    )
  )
    return null;
  value = value.replace(/^(?:EUR|€)\s*/i, "").replace(/\s*(?:EUR|€)$/i, "");
  const negative = value.startsWith("-");
  if (negative && !options.allowNegative)
    throw new Error("FINANCE_SOURCE_NEGATIVE_AMOUNT");
  if (/^[+-]/.test(value)) value = value.slice(1);
  if (/\s/u.test(value)) {
    if (!/^\d{1,3}(?:[\s\u00a0\u202f]\d{3})+(?:[.,]\d{1,2})?$/u.test(value))
      throw new Error("FINANCE_SOURCE_AMBIGUOUS_MONEY");
    value = value.replace(/[\s\u00a0\u202f]/gu, "");
  }
  if (!/^\d+(?:[.,]\d+)*$/.test(value))
    throw new Error("FINANCE_SOURCE_INVALID_MONEY");
  let decimal = options.decimalSeparator;
  if (!decimal) {
    if (value.includes(".") && value.includes(","))
      decimal = value.lastIndexOf(".") > value.lastIndexOf(",") ? "." : ",";
    else {
      const separator = value.includes(".")
        ? "."
        : value.includes(",")
          ? ","
          : null;
      if (separator) {
        if (
          value.split(separator).length !== 2 ||
          value.split(separator)[1].length > 2
        )
          throw new Error("FINANCE_SOURCE_AMBIGUOUS_MONEY");
        decimal = separator;
      }
    }
  }
  const grouping = decimal === "." ? "," : ".";
  const parts = decimal ? value.split(decimal) : [value];
  if (
    parts.length > 2 ||
    (parts[1] !== undefined && !/^\d{1,2}$/.test(parts[1]))
  )
    throw new Error("FINANCE_SOURCE_INVALID_MONEY_PRECISION");
  let whole = parts[0];
  if (whole.includes(grouping)) {
    const groups = whole.split(grouping);
    if (
      !/^\d{1,3}$/.test(groups[0]) ||
      groups.slice(1).some((group) => !/^\d{3}$/.test(group))
    )
      throw new Error("FINANCE_SOURCE_INVALID_GROUPING");
    whole = groups.join("");
  }
  if (!/^\d+$/.test(whole)) throw new Error("FINANCE_SOURCE_INVALID_MONEY");
  const absolute =
    BigInt(whole) * 100n + BigInt((parts[1] ?? "").padEnd(2, "0"));
  if (absolute > BigInt(MAX_CENTS))
    throw new Error("FINANCE_SOURCE_AMOUNT_TOO_LARGE");
  return Number(negative ? -absolute : absolute);
}

function markdownCells(line: string): string[] {
  const result: string[] = [];
  let cell = "",
    escaped = false,
    codeFence = 0,
    trailingDelimiter = false;
  const trimmed = line.trim();
  for (let index = 0; index < trimmed.length; index++) {
    const char = trimmed[index];
    if (escaped) {
      cell += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      let count = 1;
      while (trimmed[index + count] === "`") count++;
      if (!codeFence) codeFence = count;
      else if (codeFence === count) codeFence = 0;
      cell += "`".repeat(count);
      index += count - 1;
      continue;
    }
    if (char === "|" && !codeFence) {
      result.push(cell.trim());
      cell = "";
      trailingDelimiter = index === trimmed.length - 1;
    } else cell += char;
  }
  if (escaped) cell += "\\";
  result.push(cell.trim());
  if (trimmed.startsWith("|")) result.shift();
  if (trailingDelimiter) result.pop();
  return result;
}
/** Tables are evidence only. No prose or cell can grant an action or execute code. */
export function extractFinanceMarkdownTables(
  markdown: string,
): MarkdownTable[] {
  if (Buffer.byteLength(markdown, "utf8") > MAX_BYTES)
    throw new Error("FINANCE_SOURCE_TOO_LARGE");
  const lines = markdown.replace(/^\uFEFF/, "").split(/\r?\n/),
    tables: MarkdownTable[] = [];
  let fence: string | null = null;
  for (let index = 0; index < lines.length - 1; index++) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(lines[index])?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length)
        fence = null;
      continue;
    }
    if (fence || !lines[index].includes("|")) continue;
    const headers = markdownCells(lines[index]),
      separator = markdownCells(lines[index + 1]);
    if (
      headers.length < 2 ||
      separator.length !== headers.length ||
      !separator.every((cell) => /^:?-{3,}:?$/.test(cell))
    )
      continue;
    if (new Set(headers).size !== headers.length)
      throw new Error("FINANCE_SOURCE_DUPLICATE_TABLE_HEADER");
    const table: MarkdownTable = {
      headers,
      rows: [],
      header_line: index + 1,
      row_lines: [],
    };
    index += 2;
    for (
      ;
      index < lines.length && lines[index].trim() && lines[index].includes("|");
      index++
    ) {
      const cells = markdownCells(lines[index]);
      if (cells.length !== headers.length)
        throw new Error("FINANCE_SOURCE_MARKDOWN_COLUMN_COUNT");
      table.rows.push(cells);
      table.row_lines.push(index + 1);
      if (table.rows.length > MAX_RECORDS)
        throw new Error("FINANCE_SOURCE_TABLE_TOO_LARGE");
    }
    tables.push(table);
    index--;
  }
  return tables;
}
function mappingValue(
  value: unknown,
  tables: MarkdownTable[],
  used: PreparedFinanceSource["used_cells"],
  depth = 0,
): unknown {
  if (depth > 30) throw new Error("FINANCE_SOURCE_MAPPING_TOO_DEEP");
  if (Array.isArray(value))
    return value.map((item) => mappingValue(item, tables, used, depth + 1));
  if (!value || typeof value !== "object") return value;
  const input = object(value);
  if ("$cell" in input) {
    if (
      Object.keys(input).some(
        (key) =>
          !["$cell", "as", "decimal_separator", "allow_negative"].includes(key),
      )
    )
      throw new Error("FINANCE_SOURCE_INVALID_CELL_MAPPING");
    const ref = object(input.$cell),
      tableIndex = ref.table,
      rowIndex = ref.row;
    if (
      Object.keys(ref).some((key) => !["table", "row", "column"].includes(key))
    )
      throw new Error("FINANCE_SOURCE_INVALID_CELL_REFERENCE");
    if (
      !Number.isInteger(tableIndex) ||
      !Number.isInteger(rowIndex) ||
      Number(tableIndex) < 0 ||
      Number(rowIndex) < 0
    )
      throw new Error("FINANCE_SOURCE_INVALID_CELL_REFERENCE");
    const table = tables[Number(tableIndex)];
    const column =
      typeof ref.column === "string"
        ? table?.headers.indexOf(ref.column)
        : ref.column;
    if (
      !table ||
      !Number.isInteger(column) ||
      Number(column) < 0 ||
      !table.rows[Number(rowIndex)] ||
      Number(column) >= table.headers.length
    )
      throw new Error("FINANCE_SOURCE_MISSING_CELL");
    used.push({
      table: Number(tableIndex),
      row: Number(rowIndex),
      column: Number(column),
    });
    const cell = table.rows[Number(rowIndex)][Number(column)];
    if (input.as === undefined || input.as === "text") return cell;
    if (input.as === "cents") {
      if (
        input.decimal_separator !== undefined &&
        ![".", ","].includes(String(input.decimal_separator))
      )
        throw new Error("FINANCE_SOURCE_INVALID_DECIMAL_SEPARATOR");
      return parseFinanceMoney(cell, {
        decimalSeparator: input.decimal_separator as "." | "," | undefined,
        allowNegative: input.allow_negative === true,
      });
    }
    if (
      input.as === "integer" &&
      /^\d+$/.test(cell) &&
      Number.isSafeInteger(Number(cell))
    )
      return Number(cell);
    throw new Error("FINANCE_SOURCE_INVALID_CELL_CONVERSION");
  }
  return Object.fromEntries(
    Object.entries(input).map(([key, item]) => [
      key,
      mappingValue(item, tables, used, depth + 1),
    ]),
  );
}
function validatePayload(value: unknown): FinanceImportDTO {
  const data = object(value),
    keys = [
      "format",
      "currency",
      "accounts",
      "categories",
      "plans",
      "transactions",
    ];
  if (
    Object.keys(data).some((key) => !keys.includes(key)) ||
    data.format !== "ramin-life-os/finance/1" ||
    data.currency !== "EUR"
  )
    throw new Error("FINANCE_SOURCE_FORMAT_REQUIRED");
  let total = 0;
  for (const kind of [
    "accounts",
    "categories",
    "plans",
    "transactions",
  ] as const) {
    const rows = data[kind];
    if (!Array.isArray(rows) || rows.length > MAX_RECORDS)
      throw new Error("FINANCE_SOURCE_BOUNDED_ARRAY_REQUIRED");
    total += rows.length;
    const seen = new Set<string>();
    for (const raw of rows) {
      const row = object(raw);
      if (
        typeof row.external_key !== "string" ||
        !row.external_key.trim() ||
        seen.has(row.external_key)
      )
        throw new Error("FINANCE_SOURCE_UNIQUE_EXTERNAL_KEYS_REQUIRED");
      seen.add(row.external_key);
      if (typeof row.title !== "string" || !row.title.trim())
        throw new Error("FINANCE_SOURCE_TITLE_REQUIRED");
      if (
        Object.keys(row).some((key) =>
          /^(?:owner|actor)(?:_|[A-Z])|^(?:revision|operation_id)$/.test(key),
        )
      )
        throw new Error("FINANCE_SOURCE_SERVER_FIELDS_FORBIDDEN");
    }
  }
  if (total > MAX_RECORDS) throw new Error("FINANCE_SOURCE_TOO_MANY_RECORDS");
  const money = (item: unknown, key = "", depth = 0) => {
    if (depth > 30) throw new Error("FINANCE_SOURCE_TOO_DEEP");
    if (
      key.endsWith("_cents") &&
      item !== null &&
      (typeof item !== "number" ||
        !Number.isSafeInteger(item) ||
        Math.abs(item) > MAX_CENTS ||
        (key !== "opening_balance_cents" && item < 0))
    )
      throw new Error("FINANCE_SOURCE_INTEGER_CENTS_REQUIRED");
    if (Array.isArray(item)) item.forEach((row) => money(row, "", depth + 1));
    else if (item && typeof item === "object")
      Object.entries(item).forEach(([name, child]) =>
        money(child, name, depth + 1),
      );
  };
  money(data);
  return data as unknown as FinanceImportDTO;
}
export function prepareFinanceSource(
  source: string,
  options: { kind: "json" | "markdown"; mapping?: FinanceMarkdownMapping },
): PreparedFinanceSource {
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES)
    throw new Error("FINANCE_SOURCE_TOO_LARGE");
  const document_hash = documentHash(source),
    used_cells: PreparedFinanceSource["used_cells"] = [];
  let payload: unknown,
    mapping_hash: string | null = null;
  if (options.kind === "json")
    payload = JSON.parse(source.replace(/^\uFEFF/, ""));
  else {
    const mapping = options.mapping;
    if (
      !mapping ||
      mapping.format !== "ramin-life-os/finance-markdown-map/1" ||
      mapping.expected_source_hash !== document_hash
    )
      throw new Error("FINANCE_SOURCE_REVIEWED_MAPPING_REQUIRED");
    mapping_hash = financeSourceHash(mapping);
    payload = mappingValue(
      mapping.data,
      extractFinanceMarkdownTables(source),
      used_cells,
    );
  }
  const data = validatePayload(payload);
  return {
    data,
    document_hash,
    payload_hash: financeSourceHash(data),
    mapping_hash,
    used_cells,
    counts: {
      accounts: data.accounts.length,
      categories: data.categories.length,
      plans: data.plans.length,
      transactions: data.transactions.length,
    },
  };
}

/** Verify only this import's stable keys while preserving unrelated owner records. */
export function reconcileFinanceSource(
  expected: FinanceImportDTO,
  actual: FinanceImportDTO,
) {
  const differences: { kind: string; external_key: string; reason: string }[] =
    [];
  const same = (left: unknown, right: unknown): boolean => {
    if (Array.isArray(left))
      return (
        Array.isArray(right) &&
        left.length === right.length &&
        left.every((item, index) => same(item, right[index]))
      );
    if (left && typeof left === "object")
      return (
        !!right &&
        typeof right === "object" &&
        Object.entries(left).every(([key, value]) =>
          same(value, (right as ObjectValue)[key]),
        )
      );
    return left === right;
  };
  for (const kind of [
    "accounts",
    "categories",
    "plans",
    "transactions",
  ] as const) {
    const byKey = new Map(actual[kind].map((row) => [row.external_key, row]));
    for (const row of expected[kind]) {
      const saved = byKey.get(row.external_key);
      if (!saved || !same(row, saved))
        differences.push({
          kind,
          external_key: row.external_key,
          reason: saved ? "saved_record_differs" : "missing_record",
        });
    }
  }
  return { verified: differences.length === 0, differences };
}
