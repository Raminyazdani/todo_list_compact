import {
  DomainError,
  type FinanceAccountDTO,
  type FinanceCategoryDTO,
  type FinancePlanDTO,
  type FinancePlanKind,
  type FinancePlanVersionDTO,
  type FinanceSummaryDTO,
  type FinanceTransactionDTO,
  type PageDTO,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  cleanRows,
  choice,
  date as calendarDate,
  entity,
  guard,
  id,
  normalizedSearch,
  requireScope,
  text,
  type Input,
} from "./core";
import type { Change } from "./tasks";

export const FINANCE_MAX_CENTS = 1_000_000_000_000;
export const FINANCE_TABLES = [
  "finance_accounts",
  "finance_categories",
  "finance_plans",
  "finance_plan_versions",
  "finance_transactions",
] as const;
const PLAN_KINDS = [
  "recurring",
  "one_off",
  "budget",
  "reserve",
  "liability",
] as const;
const BASES = ["confirmed", "reported", "estimate", "unknown"] as const;
const STATES = ["active", "paused", "reference"] as const;
const PRECISIONS = ["exact", "approximate", "unknown"] as const;
const TX_KINDS = ["expense", "income", "transfer", "refund"] as const;
type Row = Input & { revision: number; archived_at: string | null };
export type FinanceInventory = {
  accounts: FinanceAccountDTO[];
  categories: FinanceCategoryDTO[];
  plans: (Omit<
    FinancePlanDTO,
    | keyof FinancePlanVersionDTO
    | "applicable"
    | "monthly_equivalent_cents"
    | "versions"
  > & { versions: FinancePlanVersionDTO[] })[];
  transactions: FinanceTransactionDTO[];
};

export function financeMonth(raw: unknown, fallback?: string): string {
  const value = raw ?? fallback;
  if (
    typeof value !== "string" ||
    !/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/.test(value)
  )
    throw new DomainError("INVALID_INPUT", "month must be YYYY-MM.");
  return value;
}
export function financeToday(): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
const currentMonth = () => financeToday().slice(0, 7);
export function financeDate(input: Input, key: string): string | null {
  const value = calendarDate(input, key);
  if (value?.startsWith("0000-"))
    throw new DomainError(
      "INVALID_INPUT",
      `${key} must use a calendar year from 0001 to 9999.`,
    );
  return value;
}
export function money(
  raw: unknown,
  key: string,
  nullable = false,
  signed = false,
): number | null {
  if (nullable && raw === null) return null;
  if (
    typeof raw !== "number" ||
    !Number.isSafeInteger(raw) ||
    Math.abs(raw) > FINANCE_MAX_CENTS ||
    (!signed && raw < 0)
  )
    throw new DomainError(
      "INVALID_INPUT",
      `${key} must be integer EUR cents within the supported range.`,
    );
  return raw;
}
function integer(
  raw: unknown,
  key: string,
  low: number,
  high: number,
  nullable = false,
): number | null {
  if (nullable && (raw === null || raw === undefined)) return null;
  if (
    typeof raw !== "number" ||
    !Number.isInteger(raw) ||
    raw < low ||
    raw > high
  )
    throw new DomainError(
      "INVALID_INPUT",
      `${key} must be an integer from ${low} to ${high}.`,
    );
  return raw;
}
function bool(raw: unknown, key: string): boolean {
  if (typeof raw !== "boolean")
    throw new DomainError("INVALID_INPUT", `${key} must be boolean.`);
  return raw;
}
function optionalString(raw: unknown, key: string, max = 200): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  return text({ [key]: raw }, key, undefined, max).trim();
}
function scalarCents(raw: unknown): number | null {
  return raw === null || raw === undefined ? null : Number(raw);
}
const isoDate = (raw: unknown) =>
  raw === null || raw === undefined ? null : String(raw).slice(0, 10);
function accountDTO(row: Input): FinanceAccountDTO {
  return {
    account_id: String(row.account_id),
    title: String(row.title),
    opening_balance_cents: scalarCents(row.opening_balance_cents),
    opening_balance_date: isoDate(row.opening_balance_date),
    external_key: row.external_key as string | null,
    archived_at: row.archived_at as string | null,
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
function categoryDTO(row: Input): FinanceCategoryDTO {
  return {
    category_id: String(row.category_id),
    title: String(row.title),
    external_key: row.external_key as string | null,
    archived_at: row.archived_at as string | null,
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
function versionDTO(row: Input): FinancePlanVersionDTO {
  return {
    effective_month: String(row.effective_month),
    amount_cents: scalarCents(row.amount_cents),
    amount_basis: row.amount_basis as FinancePlanVersionDTO["amount_basis"],
    interval_months: scalarCents(row.interval_months),
    state: row.state as FinancePlanVersionDTO["state"],
    included: Boolean(row.included),
    due_day: scalarCents(row.due_day),
    due_precision: row.due_precision as FinancePlanVersionDTO["due_precision"],
    due_on: isoDate(row.due_on),
    next_due_on: isoDate(row.next_due_on),
    target_cents: scalarCents(row.target_cents),
    horizon_months: scalarCents(row.horizon_months),
  };
}
function planRecord(
  row: Input,
  versions: FinancePlanVersionDTO[],
): FinanceInventory["plans"][number] {
  return {
    plan_id: String(row.plan_id),
    title: String(row.title),
    kind: row.kind as FinancePlanKind,
    account_id: row.account_id as string | null,
    category_id: row.category_id as string | null,
    notes: String(row.notes),
    source_label: String(row.source_label),
    external_key: row.external_key as string | null,
    archived_at: row.archived_at as string | null,
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    versions,
  };
}
function transactionDTO(row: Input): FinanceTransactionDTO {
  return {
    transaction_id: String(row.transaction_id),
    title: String(row.title),
    kind: row.kind as FinanceTransactionDTO["kind"],
    date: String(row.posted_on).slice(0, 10),
    amount_cents: Number(row.amount_cents),
    account_id: row.account_id as string | null,
    transfer_account_id: row.transfer_account_id as string | null,
    category_id: row.category_id as string | null,
    plan_id: row.plan_id as string | null,
    notes: String(row.notes),
    source_label: String(row.source_label),
    external_key: row.external_key as string | null,
    archived_at: row.archived_at as string | null,
    revision: Number(row.revision),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}
export function monthlyEquivalent(
  kind: FinancePlanKind,
  version: FinancePlanVersionDTO,
): number | null {
  if (version.amount_cents === null) return null;
  if (kind === "budget" || kind === "reserve") return version.amount_cents;
  if (kind !== "recurring") return null;
  if (version.interval_months === null) return null;
  // Whole bill cents are preserved; this display estimate rounds only once.
  const divisor = version.interval_months!;
  return Number(
    (BigInt(version.amount_cents) + BigInt(Math.floor(divisor / 2))) /
      BigInt(divisor),
  );
}
export function selectedPlan(
  plan: FinanceInventory["plans"][number],
  month: string,
): FinancePlanDTO {
  const candidates = plan.versions.filter((v) => v.effective_month <= month);
  const version = candidates.at(-1) ?? plan.versions[0];
  if (!version)
    throw new DomainError("INVALID_INPUT", "Financial plan has no version.");
  const applicable = candidates.length > 0;
  return {
    ...plan,
    ...version,
    applicable,
    monthly_equivalent_cents: applicable
      ? monthlyEquivalent(plan.kind, version)
      : null,
    versions: plan.versions,
  };
}
export async function financeInventory(
  tx: SqlClient,
  owner: string,
): Promise<FinanceInventory> {
  const read = async (table: string) => {
    const rows = cleanRows(
      (
        await tx.query<Input>(
          `SELECT * FROM ${table} WHERE owner_id=$1 LIMIT 50001`,
          [owner],
        )
      ).rows,
    );
    if (rows.length > 50000)
      throw new DomainError(
        "INVALID_INPUT",
        "Financial inventory exceeds the supported traversal limit.",
      );
    return rows;
  };
  const accounts = (await read("finance_accounts")).map(accountDTO);
  const categories = (await read("finance_categories")).map(categoryDTO);
  const rawPlans = await read("finance_plans");
  const versions = await read("finance_plan_versions");
  const byPlan = new Map<string, FinancePlanVersionDTO[]>();
  for (const row of versions) {
    const key = String(row.plan_id);
    const rows = byPlan.get(key) ?? [];
    rows.push(versionDTO(row));
    byPlan.set(key, rows);
  }
  for (const rows of byPlan.values())
    rows.sort((a, b) => a.effective_month.localeCompare(b.effective_month));
  const plans = rawPlans.map((row) =>
    planRecord(row, byPlan.get(String(row.plan_id)) ?? []),
  );
  const transactions = (await read("finance_transactions")).map(transactionDTO);
  return { accounts, categories, plans, transactions };
}
function requireCreate(revision: number | undefined) {
  if (revision !== 0)
    throw new DomainError(
      "INVALID_INPUT",
      "expectedRevision must be 0 for a new finance record.",
    );
}
function title(input: Input, existing?: Input): string {
  const result = text(
    input,
    "title",
    existing?.title as string | undefined,
    200,
  ).trim();
  if (!result)
    throw new DomainError("INVALID_INPUT", "Financial title cannot be blank.");
  return result;
}
function field(
  input: Input,
  key: string,
  existing?: Input,
  fallback: unknown = null,
): unknown {
  return input[key] === undefined ? (existing?.[key] ?? fallback) : input[key];
}
async function reference(
  tx: SqlClient,
  owner: string,
  table: string,
  column: string,
  value: unknown,
  existing?: unknown,
): Promise<string | null> {
  const resolved = optionalString(value, column, 512);
  if (!resolved) return null;
  const row = await entity(tx, table, column, resolved, owner);
  if (row.archived_at && resolved !== existing)
    throw new DomainError(
      "INVALID_INPUT",
      `Restore the archived ${column} before linking it.`,
    );
  return resolved;
}
async function sourceKey(
  tx: SqlClient,
  table: string,
  owner: string,
  input: Input,
  existing?: Input,
  identity?: string,
): Promise<string | null> {
  const key = optionalString(
    field(input, "external_key", existing),
    "external_key",
  );
  if (existing && key !== existing.external_key)
    throw new DomainError("INVALID_INPUT", "external_key is immutable.");
  const columns: Record<string, string> = {
    finance_accounts: "account_id",
    finance_categories: "category_id",
    finance_plans: "plan_id",
    finance_transactions: "transaction_id",
  };
  const column = columns[table];
  if (!column || (!existing && !identity))
    throw new DomainError(
      "INVALID_INPUT",
      "Financial source identity is required.",
    );
  const canonical = key ?? `life-os:${identity ?? existing?.[column]}`;
  if (
    !existing &&
    (
      await tx.query(
        `SELECT 1 FROM ${table} WHERE owner_id=$1 AND COALESCE(external_key,'life-os:'||${column})=$2`,
        [owner, canonical],
      )
    ).rows.length
  )
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "This financial source key already exists.",
      { external_key: canonical },
      409,
    );
  return key;
}
export function normalizedVersion(
  input: Input,
  kind: FinancePlanKind,
  existing?: FinancePlanVersionDTO,
): FinancePlanVersionDTO {
  const inherited = existing as unknown as Input | undefined;
  const effective_month = financeMonth(input.effective_month);
  const amount_cents = money(
    field(input, "amount_cents", inherited),
    "amount_cents",
    true,
  );
  const amount_basis = choice(
    {
      amount_basis: field(
        input,
        "amount_basis",
        inherited,
        amount_cents === null ? "unknown" : "reported",
      ),
    },
    "amount_basis",
    BASES,
  );
  if ((amount_cents === null) !== (amount_basis === "unknown"))
    throw new DomainError(
      "INVALID_INPUT",
      "Unknown amounts must use null and amount_basis=unknown.",
    );
  const interval_months = integer(
    field(
      input,
      "interval_months",
      inherited,
      kind === "budget" || kind === "reserve" ? 1 : null,
    ),
    "interval_months",
    1,
    12,
    true,
  );
  if (
    ((kind === "budget" || kind === "reserve") && interval_months !== 1) ||
    ((kind === "one_off" || kind === "liability") && interval_months !== null)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Cadence must match plan kind; budget/reserve are monthly, one-off/liability have no interval.",
    );
  const due_precision = choice(
    { due_precision: field(input, "due_precision", inherited, "unknown") },
    "due_precision",
    PRECISIONS,
  );
  const due_day = integer(
    field(input, "due_day", inherited),
    "due_day",
    1,
    31,
    true,
  );
  const due_on = financeDate(
    { due_on: field(input, "due_on", inherited) },
    "due_on",
  );
  const next_due_on = financeDate(
    { next_due_on: field(input, "next_due_on", inherited) },
    "next_due_on",
  );
  if (
    due_precision === "unknown" &&
    (due_day !== null || due_on || next_due_on)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Unknown payment timing cannot contain a due date/day.",
    );
  if (due_precision === "approximate" && (due_on || next_due_on))
    throw new DomainError(
      "INVALID_INPUT",
      "Approximate day labels cannot be promoted to exact dates.",
    );
  if (due_precision === "exact" && due_day === null && !due_on && !next_due_on)
    throw new DomainError(
      "INVALID_INPUT",
      "Exact payment timing requires an explicit date/day.",
    );
  return {
    effective_month,
    amount_cents,
    amount_basis,
    interval_months,
    state: choice(
      { state: field(input, "state", inherited, "active") },
      "state",
      STATES,
    ),
    included: bool(field(input, "included", inherited, true), "included"),
    due_day,
    due_precision,
    due_on,
    next_due_on,
    target_cents: money(
      field(input, "target_cents", inherited),
      "target_cents",
      true,
    ),
    horizon_months: integer(
      field(input, "horizon_months", inherited),
      "horizon_months",
      1,
      120,
      true,
    ),
  };
}
async function putVersion(
  tx: SqlClient,
  owner: string,
  planId: string,
  v: FinancePlanVersionDTO,
) {
  await tx.query(
    `INSERT INTO finance_plan_versions(plan_id,owner_id,effective_month,amount_cents,amount_basis,interval_months,state,included,due_day,due_precision,due_on,next_due_on,target_cents,horizon_months) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(owner_id,plan_id,effective_month) DO UPDATE SET amount_cents=$4,amount_basis=$5,interval_months=$6,state=$7,included=$8,due_day=$9,due_precision=$10,due_on=$11,next_due_on=$12,target_cents=$13,horizon_months=$14,updated_at=now()`,
    [
      planId,
      owner,
      v.effective_month,
      v.amount_cents,
      v.amount_basis,
      v.interval_months,
      v.state,
      v.included,
      v.due_day,
      v.due_precision,
      v.due_on,
      v.next_due_on,
      v.target_cents,
      v.horizon_months,
    ],
  );
}
async function planRead(
  tx: SqlClient,
  owner: string,
  planId: string,
  month: string,
): Promise<FinancePlanDTO> {
  const row = await entity(tx, "finance_plans", "plan_id", planId, owner);
  const versions = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM finance_plan_versions WHERE owner_id=$1 AND plan_id=$2 ORDER BY effective_month",
        [owner, planId],
      )
    ).rows,
  ).map(versionDTO);
  return selectedPlan(planRecord(row, versions), month);
}

export async function financeCommand(
  tx: SqlClient,
  command: string,
  input: Input,
  principal: Principal,
  revision: number | undefined,
  allowArchivedReferences = false,
): Promise<Change> {
  requireScope(principal, "finance", true);
  if (input.currency !== undefined && input.currency !== "EUR")
    throw new DomainError("INVALID_INPUT", "Finance v1 supports EUR only.");
  const owner = principal.ownerId;
  if (
    command.startsWith("finance_account_") ||
    command.startsWith("finance_category_")
  ) {
    const account = command.startsWith("finance_account_");
    const table = account ? "finance_accounts" : "finance_categories",
      column = account ? "account_id" : "category_id";
    const create = command.endsWith("_create");
    const before = create
      ? null
      : await entity<Row>(tx, table, column, text(input, column), owner);
    if (create) requireCreate(revision);
    else guard(before!, revision);
    if (command.endsWith("_archive") || command.endsWith("_restore")) {
      const archive = command.endsWith("_archive");
      const row = cleanRows(
        (
          await tx.query<Input>(
            `UPDATE ${table} SET archived_at=${archive ? "now()" : "NULL"},revision=revision+1,updated_at=now() WHERE ${column}=$1 AND owner_id=$2 RETURNING *`,
            [before![column], owner],
          )
        ).rows,
      )[0];
      return {
        entityId: String(row[column]),
        before,
        after: account ? accountDTO(row) : categoryDTO(row),
        affected: [],
      };
    }
    if (before?.archived_at)
      throw new DomainError(
        "INVALID_INPUT",
        "Restore the archived financial record before editing.",
      );
    const name = title(input, before ?? undefined);
    const identity = create
      ? id(account ? "FAC" : "FCA")
      : String(before![column]);
    const externalKey = await sourceKey(
      tx,
      table,
      owner,
      input,
      before ?? undefined,
      identity,
    );
    let row: Input;
    if (account) {
      const balance = money(
        field(input, "opening_balance_cents", before ?? undefined),
        "opening_balance_cents",
        true,
        true,
      );
      const openingDate = financeDate(
        {
          opening_balance_date: field(
            input,
            "opening_balance_date",
            before ?? undefined,
          ),
        },
        "opening_balance_date",
      );
      if ((balance === null) !== (openingDate === null))
        throw new DomainError(
          "INVALID_INPUT",
          "Opening balance and its date must be supplied together.",
        );
      row = cleanRows(
        (
          await tx.query<Input>(
            create
              ? `INSERT INTO finance_accounts(account_id,owner_id,title,opening_balance_cents,opening_balance_date,external_key) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`
              : `UPDATE finance_accounts SET title=$3,opening_balance_cents=$4,opening_balance_date=$5,revision=revision+1,updated_at=now() WHERE account_id=$1 AND owner_id=$2 RETURNING *`,
            create
              ? [identity, owner, name, balance, openingDate, externalKey]
              : [identity, owner, name, balance, openingDate],
          )
        ).rows,
      )[0];
    } else
      row = cleanRows(
        (
          await tx.query<Input>(
            create
              ? `INSERT INTO finance_categories(category_id,owner_id,title,external_key) VALUES($1,$2,$3,$4) RETURNING *`
              : `UPDATE finance_categories SET title=$3,revision=revision+1,updated_at=now() WHERE category_id=$1 AND owner_id=$2 RETURNING *`,
            create
              ? [identity, owner, name, externalKey]
              : [identity, owner, name],
          )
        ).rows,
      )[0];
    return {
      entityId: identity,
      before,
      after: account ? accountDTO(row) : categoryDTO(row),
      affected: [],
    };
  }
  if (command.startsWith("finance_plan_")) {
    const create = command.endsWith("_create"),
      month = financeMonth(input.effective_month);
    const row = create
      ? null
      : await entity<Row>(
          tx,
          "finance_plans",
          "plan_id",
          text(input, "plan_id"),
          owner,
        );
    if (create) requireCreate(revision);
    else guard(row!, revision);
    const before = row
      ? await planRead(tx, owner, String(row.plan_id), month)
      : null;
    const identity = create ? id("FPL") : String(row!.plan_id);
    const kind = choice(input, "kind", PLAN_KINDS, before?.kind);
    if (before && kind !== before.kind)
      throw new DomainError(
        "INVALID_INPUT",
        "Plan kind is immutable; create a different plan.",
      );
    if (command.endsWith("_archive") || command.endsWith("_restore")) {
      const archive = command.endsWith("_archive");
      await putVersion(
        tx,
        owner,
        identity,
        normalizedVersion(
          {
            ...before,
            effective_month: month,
            state: archive ? "paused" : "active",
          },
          kind,
        ),
      );
      await tx.query(
        `UPDATE finance_plans SET archived_at=${archive ? "now()" : "NULL"},revision=revision+1,updated_at=now() WHERE plan_id=$1 AND owner_id=$2`,
        [identity, owner],
      );
      if (archive)
        await tx.query(
          "UPDATE finance_plan_versions SET state='paused',updated_at=now() WHERE plan_id=$1 AND owner_id=$2 AND effective_month>$3",
          [identity, owner, month],
        );
    } else {
      if (row?.archived_at)
        throw new DomainError(
          "INVALID_INPUT",
          "Restore the archived plan before editing.",
        );
      const accountId = await reference(
        tx,
        owner,
        "finance_accounts",
        "account_id",
        field(input, "account_id", row ?? undefined),
        allowArchivedReferences
          ? field(input, "account_id", row ?? undefined)
          : row?.account_id,
      );
      const categoryId = await reference(
        tx,
        owner,
        "finance_categories",
        "category_id",
        field(input, "category_id", row ?? undefined),
        allowArchivedReferences
          ? field(input, "category_id", row ?? undefined)
          : row?.category_id,
      );
      const key = await sourceKey(
        tx,
        "finance_plans",
        owner,
        input,
        row ?? undefined,
        identity,
      );
      const values = [
        identity,
        owner,
        title(input, row ?? undefined),
        kind,
        accountId,
        categoryId,
        text(input, "notes", String(row?.notes ?? ""), 10000),
        text(input, "source_label", String(row?.source_label ?? ""), 500),
      ];
      if (create)
        await tx.query(
          `INSERT INTO finance_plans(plan_id,owner_id,title,kind,account_id,category_id,notes,source_label,external_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [...values, key],
        );
      else
        await tx.query(
          `UPDATE finance_plans SET title=$3,kind=$4,account_id=$5,category_id=$6,notes=$7,source_label=$8,revision=revision+1,updated_at=now() WHERE plan_id=$1 AND owner_id=$2`,
          values,
        );
      await putVersion(
        tx,
        owner,
        identity,
        normalizedVersion(input, kind, before ?? undefined),
      );
    }
    return {
      entityId: identity,
      before,
      after: await planRead(tx, owner, identity, month),
      affected: [],
    };
  }
  if (command.startsWith("finance_transaction_")) {
    const create = command.endsWith("_create");
    const beforeRow = create
      ? null
      : await entity<Row>(
          tx,
          "finance_transactions",
          "transaction_id",
          text(input, "transaction_id"),
          owner,
        );
    if (create) requireCreate(revision);
    else guard(beforeRow!, revision);
    const identity = create ? id("FTX") : String(beforeRow!.transaction_id);
    const before = beforeRow ? transactionDTO(beforeRow) : null;
    if (command.endsWith("_archive") || command.endsWith("_restore")) {
      const row = cleanRows(
        (
          await tx.query<Input>(
            `UPDATE finance_transactions SET archived_at=${command.endsWith("_archive") ? "now()" : "NULL"},revision=revision+1,updated_at=now() WHERE transaction_id=$1 AND owner_id=$2 RETURNING *`,
            [identity, owner],
          )
        ).rows,
      )[0];
      return {
        entityId: identity,
        before,
        after: transactionDTO(row),
        affected: [],
      };
    }
    if (beforeRow?.archived_at)
      throw new DomainError(
        "INVALID_INPUT",
        "Restore the archived transaction before editing.",
      );
    const kind = choice(input, "kind", TX_KINDS, before?.kind);
    const amount = money(
      field(input, "amount_cents", beforeRow ?? undefined),
      "amount_cents",
    )!;
    if (amount <= 0)
      throw new DomainError(
        "INVALID_INPUT",
        "A registered transaction requires positive cents.",
      );
    const posted = financeDate(
      {
        date: field(input, "date", before ? { date: before.date } : undefined),
      },
      "date",
    );
    if (!posted)
      throw new DomainError(
        "INVALID_INPUT",
        "A registered transaction requires its actual date.",
      );
    const accountId = await reference(
      tx,
      owner,
      "finance_accounts",
      "account_id",
      field(input, "account_id", beforeRow ?? undefined),
      allowArchivedReferences
        ? field(input, "account_id", beforeRow ?? undefined)
        : beforeRow?.account_id,
    );
    const transferId = await reference(
      tx,
      owner,
      "finance_accounts",
      "account_id",
      field(input, "transfer_account_id", beforeRow ?? undefined),
      allowArchivedReferences
        ? field(input, "transfer_account_id", beforeRow ?? undefined)
        : beforeRow?.transfer_account_id,
    );
    if (
      (kind === "transfer" &&
        (!accountId || !transferId || accountId === transferId)) ||
      (kind !== "transfer" && transferId)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "A transfer requires two distinct accounts; other transactions have no destination account.",
      );
    const categoryId = await reference(
      tx,
      owner,
      "finance_categories",
      "category_id",
      field(input, "category_id", beforeRow ?? undefined),
      allowArchivedReferences
        ? field(input, "category_id", beforeRow ?? undefined)
        : beforeRow?.category_id,
    );
    const planId = await reference(
      tx,
      owner,
      "finance_plans",
      "plan_id",
      field(input, "plan_id", beforeRow ?? undefined),
      allowArchivedReferences
        ? field(input, "plan_id", beforeRow ?? undefined)
        : beforeRow?.plan_id,
    );
    const key = await sourceKey(
      tx,
      "finance_transactions",
      owner,
      input,
      beforeRow ?? undefined,
      identity,
    );
    const values = [
      identity,
      owner,
      title(input, beforeRow ?? undefined),
      kind,
      posted,
      amount,
      accountId,
      transferId,
      categoryId,
      planId,
      text(input, "notes", String(beforeRow?.notes ?? ""), 10000),
      text(input, "source_label", String(beforeRow?.source_label ?? ""), 500),
    ];
    const row = cleanRows(
      (
        await tx.query<Input>(
          create
            ? `INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents,account_id,transfer_account_id,category_id,plan_id,notes,source_label,external_key) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`
            : `UPDATE finance_transactions SET title=$3,kind=$4,posted_on=$5,amount_cents=$6,account_id=$7,transfer_account_id=$8,category_id=$9,plan_id=$10,notes=$11,source_label=$12,revision=revision+1,updated_at=now() WHERE transaction_id=$1 AND owner_id=$2 RETURNING *`,
          create ? [...values, key] : values,
        )
      ).rows,
    )[0];
    return {
      entityId: identity,
      before,
      after: transactionDTO(row),
      affected: [],
    };
  }
  throw new DomainError("UNSUPPORTED_OPERATION", "Unknown financial command.");
}

function add(a: number, b: number): number {
  const result = a + b;
  if (!Number.isSafeInteger(result))
    throw new DomainError(
      "INVALID_INPUT",
      "Financial aggregate exceeds safe integer cents.",
    );
  return result;
}
function monthAfter(month: string, offset: number): string {
  const date = new Date(`${month}-01T12:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + offset);
  if (date.getUTCFullYear() > 9999)
    throw new DomainError(
      "INVALID_INPUT",
      "Financial projection exceeds the supported calendar range.",
    );
  return date.toISOString().slice(0, 7);
}
function monthlyTotals(plans: FinancePlanDTO[]) {
  let recurring = 0,
    budget = 0,
    reserve = 0,
    optional = 0,
    unknown = 0,
    count = 0;
  for (const p of plans) {
    if (!p.applicable || p.state !== "active") continue;
    if (p.kind === "reserve" && !p.included && p.amount_cents !== null)
      optional = add(optional, p.amount_cents);
    if (!p.included || !["recurring", "budget", "reserve"].includes(p.kind))
      continue;
    count++;
    if (p.monthly_equivalent_cents === null) {
      unknown++;
      continue;
    }
    if (p.kind === "recurring")
      recurring = add(recurring, p.monthly_equivalent_cents);
    if (p.kind === "budget") budget = add(budget, p.monthly_equivalent_cents);
    if (p.kind === "reserve")
      reserve = add(reserve, p.monthly_equivalent_cents);
  }
  return {
    recurring,
    budget,
    reserve,
    optional,
    unknown,
    count,
    cost: add(recurring, budget),
    allocation: add(add(recurring, budget), reserve),
  };
}
function paginate<T>(
  items: T[],
  input: Input,
  identity: (item: T) => string,
): PageDTO<T> {
  const limit = integer(input.limit ?? 50, "limit", 1, 200)!;
  let offset = 0;
  if (input.cursor) {
    const cursor = Buffer.from(
      text(input, "cursor", undefined, 1024),
      "base64url",
    ).toString();
    const index = items.findIndex((item) => identity(item) === cursor);
    if (index < 0)
      throw new DomainError(
        "INVALID_INPUT",
        "Financial list cursor is unavailable; reload this list.",
      );
    offset = index + 1;
  }
  const result = items.slice(offset, offset + limit);
  return {
    items: result,
    total: items.length,
    next_cursor:
      offset + limit < items.length && result.length
        ? Buffer.from(identity(result.at(-1)!)).toString("base64url")
        : null,
  };
}
function listFilter<
  T extends { title: string; archived_at: string | null; notes?: string },
>(items: T[], input: Input): T[] {
  const archived =
    input.archived === undefined ? false : bool(input.archived, "archived");
  const search =
    input.search === undefined
      ? ""
      : normalizedSearch(text(input, "search", "", 200));
  return items.filter(
    (item) =>
      Boolean(item.archived_at) === archived &&
      (!search ||
        normalizedSearch(item.title + " " + (item.notes ?? "")).includes(
          search,
        )),
  );
}
export async function financeQuery(
  tx: SqlClient,
  operation: string,
  input: Input,
  principal: Principal,
): Promise<unknown> {
  requireScope(principal, "finance");
  const inventory = await financeInventory(tx, principal.ownerId);
  const month = financeMonth(input.month, currentMonth());
  if (operation === "finance_account_list")
    return paginate(
      listFilter(inventory.accounts, input).sort((a, b) =>
        a.account_id.localeCompare(b.account_id),
      ),
      input,
      (a) => a.account_id,
    );
  if (operation === "finance_category_list")
    return paginate(
      listFilter(inventory.categories, input).sort((a, b) =>
        a.category_id.localeCompare(b.category_id),
      ),
      input,
      (a) => a.category_id,
    );
  if (operation === "finance_plan_list") {
    let plans = listFilter(
      inventory.plans.map((p) => selectedPlan(p, month)),
      input,
    );
    if (input.kind !== undefined)
      plans = plans.filter((p) => p.kind === choice(input, "kind", PLAN_KINDS));
    if (input.state !== undefined)
      plans = plans.filter((p) => p.state === choice(input, "state", STATES));
    return paginate(
      plans.sort((a, b) => a.plan_id.localeCompare(b.plan_id)),
      input,
      (p) => p.plan_id,
    );
  }
  if (operation === "finance_transaction_list") {
    let rows = listFilter(inventory.transactions, input);
    if (input.month) rows = rows.filter((r) => r.date.startsWith(month));
    if (input.kind !== undefined)
      rows = rows.filter((r) => r.kind === choice(input, "kind", TX_KINDS));
    for (const key of ["account_id", "category_id", "plan_id"] as const)
      if (input[key]) {
        const selected = text(input, key);
        rows = rows.filter(
          (r) =>
            r[key] === selected ||
            (key === "account_id" && r.transfer_account_id === selected),
        );
      }
    const from = financeDate(input, "from_date"),
      to = financeDate(input, "to_date");
    if (from && to && from >= to)
      throw new DomainError(
        "INVALID_INPUT",
        "Transaction dates require an ordered exclusive range.",
      );
    if (from) rows = rows.filter((r) => r.date >= from);
    if (to) rows = rows.filter((r) => r.date < to);
    return paginate(
      rows.sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.transaction_id.localeCompare(b.transaction_id),
      ),
      input,
      (r) => r.transaction_id,
    );
  }
  if (operation !== "finance_summary")
    throw new DomainError("UNSUPPORTED_OPERATION", "Unknown financial query.");
  const plans = inventory.plans.map((p) => selectedPlan(p, month));
  const totals = monthlyTotals(plans);
  const actual = {
    expense_cents: 0,
    refund_cents: 0,
    net_expense_cents: 0,
    income_cents: 0,
    transfer_cents: 0,
    transaction_count: 0,
    coverage: "registered_transactions_only" as const,
  };
  const byCategory = new Map<
    string | null,
    FinanceSummaryDTO["by_category"][number]
  >();
  const byAccount = new Map<
    string | null,
    FinanceSummaryDTO["by_account"][number]
  >();
  const category = (key: string | null) => {
    if (!byCategory.has(key))
      byCategory.set(key, {
        category_id: key,
        title:
          inventory.categories.find((c) => c.category_id === key)?.title ??
          "بدون دسته‌بندی",
        planned_cents: 0,
        expense_cents: 0,
        refund_cents: 0,
      });
    return byCategory.get(key)!;
  };
  const account = (key: string | null) => {
    if (!byAccount.has(key))
      byAccount.set(key, {
        account_id: key,
        title:
          inventory.accounts.find((a) => a.account_id === key)?.title ??
          "حساب نامشخص",
        planned_cents: 0,
        expense_cents: 0,
        income_cents: 0,
        refund_cents: 0,
        transfer_in_cents: 0,
        transfer_out_cents: 0,
        balance_cents: null,
      });
    return byAccount.get(key)!;
  };
  for (const p of plans)
    if (
      p.applicable &&
      p.state === "active" &&
      p.included &&
      p.monthly_equivalent_cents !== null &&
      ["recurring", "budget", "reserve"].includes(p.kind)
    ) {
      category(p.category_id).planned_cents = add(
        category(p.category_id).planned_cents,
        p.monthly_equivalent_cents,
      );
      account(p.account_id).planned_cents = add(
        account(p.account_id).planned_cents,
        p.monthly_equivalent_cents,
      );
    }
  const activeTransactions = inventory.transactions.filter(
    (t) => !t.archived_at,
  );
  for (const t of activeTransactions.filter((t) => t.date.startsWith(month))) {
    actual.transaction_count++;
    const a = account(t.account_id),
      c = category(t.category_id);
    if (t.kind === "expense") {
      actual.expense_cents = add(actual.expense_cents, t.amount_cents);
      a.expense_cents = add(a.expense_cents, t.amount_cents);
      c.expense_cents = add(c.expense_cents, t.amount_cents);
    }
    if (t.kind === "income") {
      actual.income_cents = add(actual.income_cents, t.amount_cents);
      a.income_cents = add(a.income_cents, t.amount_cents);
    }
    if (t.kind === "refund") {
      actual.refund_cents = add(actual.refund_cents, t.amount_cents);
      a.refund_cents = add(a.refund_cents, t.amount_cents);
      c.refund_cents = add(c.refund_cents, t.amount_cents);
    }
    if (t.kind === "transfer") {
      actual.transfer_cents = add(actual.transfer_cents, t.amount_cents);
      a.transfer_out_cents = add(a.transfer_out_cents, t.amount_cents);
      const dest = account(t.transfer_account_id);
      dest.transfer_in_cents = add(dest.transfer_in_cents, t.amount_cents);
    }
  }
  actual.net_expense_cents = add(actual.expense_cents, -actual.refund_cents);
  const toMonth = monthAfter(month, 1);
  for (const a of inventory.accounts) {
    const row = account(a.account_id);
    if (
      a.opening_balance_cents === null ||
      !a.opening_balance_date ||
      a.opening_balance_date >= toMonth + "-01"
    )
      continue;
    let balance = a.opening_balance_cents;
    for (const t of activeTransactions.filter(
      (t) => t.date >= a.opening_balance_date! && t.date < toMonth + "-01",
    )) {
      if (t.account_id === a.account_id)
        balance = add(
          balance,
          (t.kind === "income" || t.kind === "refund" ? 1 : -1) *
            t.amount_cents,
        );
      if (t.kind === "transfer" && t.transfer_account_id === a.account_id)
        balance = add(balance, t.amount_cents);
    }
    row.balance_cents = balance;
  }
  const upcoming: FinanceSummaryDTO["upcoming"] = [];
  for (const p of plans) {
    if (
      !p.applicable ||
      p.state !== "active" ||
      !p.included ||
      p.kind === "budget" ||
      p.kind === "reserve"
    )
      continue;
    if (p.due_precision === "approximate" && p.due_day !== null)
      upcoming.push({
        plan_id: p.plan_id,
        title: p.title,
        date: null,
        day: p.due_day,
        precision: "approximate",
        amount_cents: p.amount_cents,
        account_id: p.account_id,
      });
    if (p.due_precision !== "exact") continue;
    const explicit = [p.next_due_on, p.due_on].filter((d): d is string =>
      Boolean(d && d.startsWith(month)),
    );
    let exact = explicit[0] ?? null;
    if (
      !exact &&
      p.kind === "recurring" &&
      p.interval_months === 1 &&
      p.due_day !== null
    ) {
      const last = new Date(`${toMonth}-01T12:00:00Z`);
      last.setUTCDate(0);
      if (p.due_day <= last.getUTCDate())
        exact = `${month}-${String(p.due_day).padStart(2, "0")}`;
    }
    if (exact)
      upcoming.push({
        plan_id: p.plan_id,
        title: p.title,
        date: exact,
        day: null,
        precision: "exact",
        amount_cents: p.amount_cents,
        account_id: p.account_id,
      });
  }
  const reserve_benchmarks = plans
    .filter((p) => p.applicable && p.state === "active" && p.kind === "reserve")
    .map((p) => {
      const projected =
        p.amount_cents !== null && p.horizon_months !== null
          ? p.amount_cents * p.horizon_months
          : null;
      if (projected !== null && !Number.isSafeInteger(projected))
        throw new DomainError(
          "INVALID_INPUT",
          "Reserve projection exceeds safe integer cents.",
        );
      return {
        plan_id: p.plan_id,
        title: p.title,
        monthly_cents: p.amount_cents,
        target_cents: p.target_cents,
        horizon_months: p.horizon_months,
        projected_cents: projected,
        shortfall_cents:
          projected !== null && p.target_cents !== null
            ? Math.max(0, p.target_cents - projected)
            : null,
        included: p.included,
      };
    });
  const horizon = integer(input.horizon_months ?? 6, "horizon_months", 1, 12)!;
  const projection = Array.from({ length: horizon }, (_, offset) => {
    const label = monthAfter(month, offset),
      t = monthlyTotals(inventory.plans.map((p) => selectedPlan(p, label)));
    return {
      month: label,
      monthly_cost_cents: t.cost,
      reserve_monthly_cents: t.reserve,
      monthly_allocation_cents: t.allocation,
      unknown_amount_count: t.unknown,
    };
  });
  const result: FinanceSummaryDTO = {
    currency: "EUR",
    month,
    recurring_monthly_cents: totals.recurring,
    budget_monthly_cents: totals.budget,
    reserve_monthly_cents: totals.reserve,
    optional_reserve_monthly_cents: totals.optional,
    monthly_cost_cents: totals.cost,
    monthly_allocation_cents: totals.allocation,
    unknown_amount_count: plans.filter(
      (p) =>
        p.applicable &&
        !p.archived_at &&
        (p.amount_cents === null ||
          (p.kind === "recurring" && p.interval_months === null)),
    ).length,
    included_unknown_amount_count: totals.unknown,
    included_plan_count: totals.count,
    actual,
    by_category: [...byCategory.values()],
    by_account: [...byAccount.values()],
    upcoming: upcoming.sort((a, b) =>
      (a.date ?? `${month}-${String(a.day).padStart(2, "0")}`).localeCompare(
        b.date ?? `${month}-${String(b.day).padStart(2, "0")}`,
      ),
    ),
    reserve_benchmarks,
    monthly_equivalent_is_estimate: true,
    projection: {
      horizon_months: horizon,
      total_known_allocation_cents: projection.reduce(
        (sum, p) => add(sum, p.monthly_allocation_cents),
        0,
      ),
      unknown_month_count: projection.filter((p) => p.unknown_amount_count > 0)
        .length,
      months: projection,
    },
  };
  return result;
}
