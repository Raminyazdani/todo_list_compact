import { z } from "zod";
import type { CommandName, QueryName } from "@/shared/contracts";

const object = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();
const id = z
  .string()
  .min(1)
  .max(512)
  .describe("Exact owner identifier from a prior read.");
const nullableId = id.nullable();
const title = z.string().trim().min(1).max(200);
const notes = z.string().max(10000);
const source = z.string().max(500);
const key = z.string().min(1).max(200);
const date = z.iso.date();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const cents = z.number().int().min(0).max(1_000_000_000_000);
const signedCents = z
  .number()
  .int()
  .min(-1_000_000_000_000)
  .max(1_000_000_000_000);
const kind = z.enum(["recurring", "one_off", "budget", "reserve", "liability"]);
const state = z.enum(["active", "paused", "reference"]);
const basis = z.enum(["confirmed", "reported", "estimate", "unknown"]);
const precision = z.enum(["exact", "approximate", "unknown"]);
const transactionKind = z.enum(["expense", "income", "transfer", "refund"]);
const page = {
  limit: z.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).max(10000).optional(),
};
const filters = {
  archived: z.boolean().optional(),
  search: z.string().max(200).optional(),
  ...page,
};
const archive = {
  archived_at: z.iso.datetime({ offset: true }).nullable().optional(),
};
const version = {
  effective_month: month,
  amount_cents: cents.nullable(),
  amount_basis: basis,
  interval_months: z.number().int().min(1).max(12).nullable(),
  state,
  included: z.boolean(),
  due_day: z.number().int().min(1).max(31).nullable(),
  due_precision: precision,
  due_on: date.nullable(),
  next_due_on: date.nullable(),
  target_cents: cents.nullable(),
  horizon_months: z.number().int().min(1).max(120).nullable(),
};
const versionInput = {
  effective_month: month,
  amount_cents: version.amount_cents.optional(),
  amount_basis: basis.optional(),
  interval_months: version.interval_months.optional(),
  state: state.optional(),
  included: z.boolean().optional(),
  due_day: version.due_day.optional(),
  due_precision: precision.optional(),
  due_on: date.nullable().optional(),
  next_due_on: date.nullable().optional(),
  target_cents: cents.nullable().optional(),
  horizon_months: version.horizon_months.optional(),
};
const planMetadata = {
  account_id: nullableId.optional(),
  category_id: nullableId.optional(),
  notes: notes.optional(),
  source_label: source.optional(),
};
const transactionInput = {
  title,
  kind: transactionKind,
  date,
  amount_cents: cents.positive(),
  account_id: nullableId.optional(),
  transfer_account_id: nullableId.optional(),
  category_id: nullableId.optional(),
  plan_id: nullableId.optional(),
  notes: notes.optional(),
  source_label: source.optional(),
};
const importData = object({
  format: z.literal("ramin-life-os/finance/1"),
  currency: z.literal("EUR"),
  accounts: z
    .array(
      object({
        external_key: key,
        title,
        opening_balance_cents: signedCents.nullable().optional(),
        opening_balance_date: date.nullable().optional(),
        ...archive,
      }),
    )
    .max(1000),
  categories: z
    .array(object({ external_key: key, title, ...archive }))
    .max(1000),
  plans: z
    .array(
      object({
        external_key: key,
        title,
        kind,
        account_key: key.nullable().optional(),
        category_key: key.nullable().optional(),
        notes: notes.optional(),
        source_label: source.optional(),
        versions: z.array(object(version)).min(1).max(120),
        ...archive,
      }),
    )
    .max(1000),
  transactions: z
    .array(
      object({
        external_key: key,
        title,
        kind: transactionKind,
        date,
        amount_cents: cents.positive(),
        notes: notes.optional(),
        source_label: source.optional(),
        account_key: key.nullable().optional(),
        transfer_account_key: key.nullable().optional(),
        category_key: key.nullable().optional(),
        plan_key: key.nullable().optional(),
        ...archive,
      }),
    )
    .max(1000),
}).refine(
  (value) =>
    value.accounts.length +
      value.categories.length +
      value.plans.length +
      value.transactions.length <=
    1000,
  "At most 1000 finance records per import.",
);

export const FINANCE_READ_SCHEMAS = {
  finance_account_list: object(filters),
  finance_category_list: object(filters),
  finance_plan_list: object({
    ...filters,
    month: month.optional(),
    kind: kind.optional(),
    state: state.optional(),
  }),
  finance_transaction_list: object({
    ...filters,
    month: month.optional(),
    kind: transactionKind.optional(),
    account_id: id.optional(),
    category_id: id.optional(),
    plan_id: id.optional(),
    from_date: date.optional(),
    to_date: date.optional(),
  }),
  finance_summary: object({
    month: month.optional(),
    horizon_months: z.number().int().min(1).max(12).optional(),
  }),
  finance_export: object({}),
  finance_import_preview: object({ data: importData }),
} satisfies Partial<Record<QueryName, z.ZodType>>;

export const FINANCE_WRITE_SCHEMAS = {
  finance_account_create: object({
    title,
    external_key: key.nullable().optional(),
    opening_balance_cents: signedCents.nullable().optional(),
    opening_balance_date: date.nullable().optional(),
  }),
  finance_account_update: object({
    account_id: id,
    title: title.optional(),
    opening_balance_cents: signedCents.nullable().optional(),
    opening_balance_date: date.nullable().optional(),
  }),
  finance_account_archive: object({ account_id: id }),
  finance_account_restore: object({ account_id: id }),
  finance_category_create: object({
    title,
    external_key: key.nullable().optional(),
  }),
  finance_category_update: object({ category_id: id, title: title.optional() }),
  finance_category_archive: object({ category_id: id }),
  finance_category_restore: object({ category_id: id }),
  finance_plan_create: object({
    title,
    kind,
    ...planMetadata,
    ...versionInput,
    external_key: key.nullable().optional(),
  }),
  finance_plan_update: object({
    plan_id: id,
    title: title.optional(),
    ...planMetadata,
    ...versionInput,
  }),
  finance_plan_archive: object({ plan_id: id, effective_month: month }),
  finance_plan_restore: object({ plan_id: id, effective_month: month }),
  finance_transaction_create: object({
    ...transactionInput,
    external_key: key.nullable().optional(),
  }),
  finance_transaction_update: object({
    transaction_id: id,
    ...Object.fromEntries(
      Object.entries(transactionInput).map(([name, schema]) => [
        name,
        schema.optional(),
      ]),
    ),
  }),
  finance_transaction_archive: object({ transaction_id: id }),
  finance_transaction_restore: object({ transaction_id: id }),
  finance_import_commit: object({ preview_id: id }),
} satisfies Partial<Record<CommandName, z.ZodType>>;

export const FINANCE_SEMANTICS = {
  finance_account_list:
    "List owner finance accounts. Missing opening balances remain unknown; registered movements do not establish a complete bank balance.",
  finance_category_list:
    "List owner finance categories without implying a bank classification.",
  finance_plan_list:
    "Read the version applicable to a selected month for recurring costs, budgets, reserves, reference quotes and liabilities. Unknown amounts remain null.",
  finance_transaction_list:
    "Read explicitly registered owner payments, income, refunds and transfers. This is not a complete bank statement.",
  finance_summary:
    "Read separate monthly planning, registered payments, category/account totals, explicit or approximate due information and reserve comparisons. Transfers and reference amounts are not monthly expenses.",
  finance_export:
    "Export all owner finance accounts, categories, plan versions, transactions and archives as recoverable private JSON. Keep it outside public Git.",
  finance_import_preview:
    "Preview bounded owner finance JSON using immutable source keys. Pin actor and financial revisions; exact repeats are unchanged and differing existing keys require resolution. This does not mark plans paid.",
  finance_account_create:
    "Create an owner EUR account with optional explicit opening balance and date; never infer a bank balance.",
  finance_account_update:
    "Update supplied owner account fields at the current revision. An opening balance and date must remain a valid pair.",
  finance_account_archive:
    "Archive one owner account while preserving references and history.",
  finance_account_restore:
    "Restore an archived owner account at its current revision.",
  finance_category_create: "Create one owner finance category.",
  finance_category_update:
    "Rename an owner finance category using its current revision; preserve existing links.",
  finance_category_archive:
    "Archive an owner category without deleting historical finance links.",
  finance_category_restore:
    "Restore an owner finance category at its current revision.",
  finance_plan_create:
    "Create an owner cost, budget, reserve or reference plan from an explicit effective month. This creates no payment and sends no money.",
  finance_plan_update:
    "Update a plan from the explicit effective month with revision protection; preserve earlier monetary versions and recorded transactions.",
  finance_plan_archive:
    "Pause an owner plan from an explicit effective month and archive its current list entry while retaining prior monthly history.",
  finance_plan_restore:
    "Restore an archived plan from an explicit effective month; no payment is inferred.",
  finance_transaction_create:
    "Register an explicit owner payment, income, refund or transfer with known positive integer cents and date. This records information and does not execute a bank payment.",
  finance_transaction_update:
    "Correct supplied recorded transaction fields at the current revision; preserve owner isolation, audit and transfer rules.",
  finance_transaction_archive:
    "Archive one recorded finance transaction at its current revision; retain its audit history.",
  finance_transaction_restore:
    "Restore one archived recorded transaction at its current revision.",
  finance_import_commit:
    "Commit one actor-bound finance preview atomically only while the pinned financial inventory still matches. Preserve source keys and do not overwrite conflicting existing data.",
} satisfies Partial<Record<QueryName | CommandName, string>>;
