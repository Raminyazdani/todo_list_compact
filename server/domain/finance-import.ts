import {
  DomainError,
  type FinanceImportDTO,
  type FinanceImportPreviewDTO,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  array,
  audit,
  choice,
  hash,
  id,
  json,
  object,
  requireScope,
  text,
  type Input,
} from "./core";
import {
  financeCommand,
  financeInventory,
  money,
  normalizedVersion,
  financeDate,
  type FinanceInventory,
} from "./finance";
import type { Change } from "./tasks";

export const FINANCE_IMPORT_MAX_BYTES = 2_000_000;
export const FINANCE_IMPORT_MAX_ROWS = 1000;
const FORMAT = "ramin-life-os/finance/1" as const;
const COMMAND = "finance_import_commit";
const kinds = [
  "recurring",
  "one_off",
  "budget",
  "reserve",
  "liability",
] as const;
const txKinds = ["expense", "income", "transfer", "refund"] as const;
const nullableKey = (raw: unknown) =>
  raw === null || raw === undefined || raw === ""
    ? null
    : text({ key: raw }, "key", undefined, 200).trim();
function archived(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (
    typeof raw !== "string" ||
    !/(Z|[+-]\d\d:\d\d)$/.test(raw) ||
    !Number.isFinite(Date.parse(raw))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "archived_at must be an explicit ISO instant or null.",
    );
  return new Date(raw).toISOString();
}
function key(row: Input): string {
  return text(row, "external_key", undefined, 200).trim();
}
function importTitle(row: Input): string {
  const title = text(row, "title", undefined, 200).trim();
  if (!title)
    throw new DomainError("INVALID_INPUT", "Financial title cannot be blank.");
  return title;
}
function unique(rows: { external_key: string }[], kind: string) {
  if (new Set(rows.map((r) => r.external_key)).size !== rows.length)
    throw new DomainError(
      "INVALID_INPUT",
      `Duplicate ${kind} external keys in import.`,
    );
}
function boundedImport(data: unknown, representation: "input" | "normalized") {
  const bytes = Buffer.byteLength(json(data), "utf8");
  if (bytes > FINANCE_IMPORT_MAX_BYTES)
    throw new DomainError(
      "INVALID_INPUT",
      representation === "normalized"
        ? "Financial import exceeds 2,000,000 UTF-8 bytes after normalization. Reduce the import before requesting a preview."
        : "Financial import exceeds 2,000,000 UTF-8 bytes.",
      { bytes, max_bytes: FINANCE_IMPORT_MAX_BYTES, representation },
    );
}
export function normalizedFinanceImport(raw: unknown): FinanceImportDTO {
  const data = object(raw);
  boundedImport(data, "input");
  if (data.format !== FORMAT || data.currency !== "EUR")
    throw new DomainError(
      "INVALID_INPUT",
      "Expected ramin-life-os/finance/1 with EUR currency.",
    );
  const accounts = array(data.accounts, FINANCE_IMPORT_MAX_ROWS).map((row) => {
    const balance = money(
      row.opening_balance_cents ?? null,
      "opening_balance_cents",
      true,
      true,
    );
    const when = financeDate({ date: row.opening_balance_date }, "date");
    if ((balance === null) !== (when === null))
      throw new DomainError(
        "INVALID_INPUT",
        "Opening balance and date must be supplied together.",
      );
    return {
      external_key: key(row),
      title: importTitle(row),
      opening_balance_cents: balance,
      opening_balance_date: when,
      archived_at: archived(row.archived_at),
    };
  });
  const categories = array(data.categories, FINANCE_IMPORT_MAX_ROWS).map(
    (row) => ({
      external_key: key(row),
      title: importTitle(row),
      archived_at: archived(row.archived_at),
    }),
  );
  const plans = array(data.plans, FINANCE_IMPORT_MAX_ROWS).map((row) => {
    const kind = choice(row, "kind", kinds);
    const versions = array(row.versions, 120)
      .map((v) => normalizedVersion(v, kind))
      .sort((a, b) => a.effective_month.localeCompare(b.effective_month));
    if (
      !versions.length ||
      new Set(versions.map((v) => v.effective_month)).size !== versions.length
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Plans need 1–120 distinct monthly versions.",
      );
    const archivedAt = archived(row.archived_at);
    if (archivedAt && versions.at(-1)!.state === "active")
      throw new DomainError(
        "INVALID_INPUT",
        "An archived plan needs a paused or reference final version.",
      );
    return {
      external_key: key(row),
      title: importTitle(row),
      kind,
      account_key: nullableKey(row.account_key),
      category_key: nullableKey(row.category_key),
      notes: text(row, "notes", "", 10000),
      source_label: text(row, "source_label", "", 500),
      archived_at: archivedAt,
      versions,
    };
  });
  const transactions = array(data.transactions, FINANCE_IMPORT_MAX_ROWS).map(
    (row) => {
      const kind = choice(row, "kind", txKinds),
        amount = money(row.amount_cents, "amount_cents")!;
      if (amount <= 0)
        throw new DomainError(
          "INVALID_INPUT",
          "Actual transactions need positive cents.",
        );
      const when = financeDate(row, "date");
      if (!when)
        throw new DomainError(
          "INVALID_INPUT",
          "Actual transaction date is required.",
        );
      const account = nullableKey(row.account_key),
        target = nullableKey(row.transfer_account_key);
      if (
        (kind === "transfer" && (!account || !target || account === target)) ||
        (kind !== "transfer" && target)
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Transfer imports require two distinct account keys.",
        );
      return {
        external_key: key(row),
        title: importTitle(row),
        kind,
        date: when,
        amount_cents: amount,
        account_key: account,
        transfer_account_key: target,
        category_key: nullableKey(row.category_key),
        plan_key: nullableKey(row.plan_key),
        notes: text(row, "notes", "", 10000),
        source_label: text(row, "source_label", "", 500),
        archived_at: archived(row.archived_at),
      };
    },
  );
  const count =
    accounts.length + categories.length + plans.length + transactions.length;
  if (count > FINANCE_IMPORT_MAX_ROWS)
    throw new DomainError(
      "INVALID_INPUT",
      "Financial import exceeds 1000 total entities.",
      { count, max_entities: FINANCE_IMPORT_MAX_ROWS },
    );
  for (const [label, rows] of Object.entries({
    accounts,
    categories,
    plans,
    transactions,
  }))
    unique(rows, label);
  const normalized: FinanceImportDTO = {
    format: FORMAT,
    currency: "EUR",
    accounts,
    categories,
    plans,
    transactions,
  };
  boundedImport(normalized, "normalized");
  return normalized;
}
const exportKey = (row: { external_key: string | null }, identity: string) =>
  row.external_key ?? `life-os:${identity}`;
function canonicalKeys<T extends { external_key: string | null }>(
  rows: T[],
  identity: (row: T) => string,
  kind: string,
): Map<string, string> {
  const result = new Map<string, string>(),
    seen = new Set<string>();
  for (const row of rows) {
    const key = exportKey(row, identity(row));
    if (seen.has(key))
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Financial records contain conflicting canonical source identities. Resolve the conflict explicitly before finance export/import.",
        { kind, external_key: key, alternative_query: "backup_export" },
        409,
      );
    seen.add(key);
    result.set(identity(row), key);
  }
  return result;
}
function exportInventory(inventory: FinanceInventory): FinanceImportDTO {
  const accountKeys = canonicalKeys(
    inventory.accounts,
    (a) => a.account_id,
    "accounts",
  );
  const categoryKeys = canonicalKeys(
    inventory.categories,
    (a) => a.category_id,
    "categories",
  );
  const planKeys = canonicalKeys(inventory.plans, (a) => a.plan_id, "plans");
  const transactionKeys = canonicalKeys(
    inventory.transactions,
    (a) => a.transaction_id,
    "transactions",
  );
  const reference = (map: Map<string, string>, identity: string | null) =>
    identity === null ? null : map.get(identity)!;
  const sort = <T extends { external_key: string }>(rows: T[]) =>
    rows.sort((a, b) => a.external_key.localeCompare(b.external_key));
  return {
    format: FORMAT,
    currency: "EUR",
    accounts: sort(
      inventory.accounts.map((a) => ({
        external_key: accountKeys.get(a.account_id)!,
        title: a.title,
        opening_balance_cents: a.opening_balance_cents,
        opening_balance_date: a.opening_balance_date,
        archived_at: a.archived_at,
      })),
    ),
    categories: sort(
      inventory.categories.map((c) => ({
        external_key: categoryKeys.get(c.category_id)!,
        title: c.title,
        archived_at: c.archived_at,
      })),
    ),
    plans: sort(
      inventory.plans.map((p) => ({
        external_key: planKeys.get(p.plan_id)!,
        title: p.title,
        kind: p.kind,
        account_key: reference(accountKeys, p.account_id),
        category_key: reference(categoryKeys, p.category_id),
        notes: p.notes,
        source_label: p.source_label,
        archived_at: p.archived_at,
        versions: p.versions,
      })),
    ),
    transactions: sort(
      inventory.transactions.map((t) => ({
        external_key: transactionKeys.get(t.transaction_id)!,
        title: t.title,
        kind: t.kind,
        date: t.date,
        amount_cents: t.amount_cents,
        account_key: reference(accountKeys, t.account_id),
        transfer_account_key: reference(accountKeys, t.transfer_account_id),
        category_key: reference(categoryKeys, t.category_id),
        plan_key: reference(planKeys, t.plan_id),
        notes: t.notes,
        source_label: t.source_label,
        archived_at: t.archived_at,
      })),
    ),
  };
}
function inventoryHash(inventory: FinanceInventory): string {
  const revisionKeys = {
    accounts: inventory.accounts.map((r) => [r.account_id, r.revision]).sort(),
    categories: inventory.categories
      .map((r) => [r.category_id, r.revision])
      .sort(),
    plans: inventory.plans.map((r) => [r.plan_id, r.revision]).sort(),
    transactions: inventory.transactions
      .map((r) => [r.transaction_id, r.revision])
      .sort(),
  };
  return hash({ data: exportInventory(inventory), revisions: revisionKeys });
}
export async function financeExport(
  tx: SqlClient,
  owner: string,
): Promise<FinanceImportDTO> {
  const data = exportInventory(await financeInventory(tx, owner));
  const counts = {
    accounts: data.accounts.length,
    categories: data.categories.length,
    plans: data.plans.length,
    transactions: data.transactions.length,
  };
  const entities = Object.values(counts).reduce((sum, n) => sum + n, 0),
    bytes = Buffer.byteLength(json(data), "utf8");
  const overVersionLimit = data.plans.some(
    (plan) => plan.versions.length > 120,
  );
  if (
    entities > FINANCE_IMPORT_MAX_ROWS ||
    bytes > FINANCE_IMPORT_MAX_BYTES ||
    overVersionLimit
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Finance JSON exceeds the recoverable import limit. Use the complete system backup export for this inventory.",
      {
        counts,
        entities,
        bytes,
        max_entities: FINANCE_IMPORT_MAX_ROWS,
        max_bytes: FINANCE_IMPORT_MAX_BYTES,
        max_versions_per_plan: 120,
        alternative_query: "backup_export",
      },
    );
  return data;
}
function importPrincipal(principal: Principal) {
  requireScope(principal, "finance", true);
  if (principal.channel === "AI")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Finance import requires explicit owner interaction.",
      {},
      403,
    );
}
type ImportPlan = {
  data: FinanceImportDTO;
  existing: FinanceImportDTO;
  counts: FinanceImportPreviewDTO["counts"];
  conflicts: FinanceImportPreviewDTO["conflicts"];
};
function checkImport(
  data: FinanceImportDTO,
  existing: FinanceImportDTO,
): ImportPlan {
  const counts = {
      accounts: 0,
      categories: 0,
      plans: 0,
      transactions: 0,
      unchanged: 0,
    },
    conflicts: FinanceImportPreviewDTO["conflicts"] = [];
  for (const group of [
    "accounts",
    "categories",
    "plans",
    "transactions",
  ] as const) {
    const prior = new Map(existing[group].map((r) => [r.external_key, r]));
    for (const row of data[group]) {
      const old = prior.get(row.external_key);
      if (!old) counts[group]++;
      else if (hash(old) === hash(row)) counts.unchanged++;
      else
        conflicts.push({
          kind: group,
          external_key: row.external_key,
          reason: "SOURCE_KEY_CONTENT_CONFLICT",
        });
    }
  }
  const accounts = new Set(
      [...existing.accounts, ...data.accounts].map((r) => r.external_key),
    ),
    categories = new Set(
      [...existing.categories, ...data.categories].map((r) => r.external_key),
    ),
    plans = new Set(
      [...existing.plans, ...data.plans].map((r) => r.external_key),
    );
  const check = (
    set: Set<string>,
    value: string | null | undefined,
    label: string,
  ) => {
    if (value && !set.has(value))
      throw new DomainError(
        "INVALID_INPUT",
        `Unknown finance ${label} source reference.`,
        { external_key: value },
      );
  };
  for (const row of data.plans) {
    check(accounts, row.account_key, "account");
    check(categories, row.category_key, "category");
  }
  for (const row of data.transactions) {
    check(accounts, row.account_key, "account");
    check(accounts, row.transfer_account_key, "transfer account");
    check(categories, row.category_key, "category");
    check(plans, row.plan_key, "plan");
  }
  return { data, existing, counts, conflicts };
}
export async function previewFinanceImport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<FinanceImportPreviewDTO> {
  importPrincipal(principal);
  const data = normalizedFinanceImport(input.data),
    inventory = await financeInventory(tx, principal.ownerId),
    existing = exportInventory(inventory);
  const planned = checkImport(data, existing),
    previewId = id("FPRE"),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  const payload = {
    data,
    state_hash: inventoryHash(inventory),
    actor_id: principal.actorId,
    source_hash: hash(data),
  };
  await tx.query(
    "INSERT INTO command_previews(preview_id,owner_id,command,input,revisions,expires_at) VALUES($1,$2,$3,$4::jsonb,'{}'::jsonb,$5)",
    [previewId, principal.ownerId, COMMAND, json(payload), expiresAt],
  );
  return {
    preview_id: previewId,
    expires_at: expiresAt,
    counts: planned.counts,
    conflicts: planned.conflicts,
    can_commit: planned.conflicts.length === 0,
    source_hash: payload.source_hash,
  };
}
export async function commitFinanceImport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  revision: number | undefined,
  operationId: string,
): Promise<Change> {
  importPrincipal(principal);
  if (revision !== 0)
    throw new DomainError(
      "INVALID_INPUT",
      "Finance import commit requires expectedRevision 0.",
    );
  const previewId = text(input, "preview_id"),
    row = (
      await tx.query<{
        command: string;
        input: Input;
        expires_at: string;
        consumed_at: string | null;
      }>(
        "SELECT command,input,expires_at,consumed_at FROM command_previews WHERE preview_id=$1 AND owner_id=$2 FOR UPDATE",
        [previewId, principal.ownerId],
      )
    ).rows[0];
  if (!row || row.command !== COMMAND)
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "An owner-bound finance import preview is required.",
      {},
      409,
    );
  if (row.consumed_at || Date.parse(row.expires_at) <= Date.now())
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Finance preview expired or has been consumed.",
      {},
      409,
    );
  const payload = object(row.input);
  if (payload.actor_id !== principal.actorId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Finance preview belongs to another actor.",
      {},
      403,
    );
  const inventory = await financeInventory(tx, principal.ownerId),
    existing = exportInventory(inventory);
  if (inventoryHash(inventory) !== payload.state_hash)
    throw new DomainError(
      "REVISION_CONFLICT",
      "Financial records changed after preview. Review the import again.",
      {},
      409,
    );
  const data = normalizedFinanceImport(payload.data),
    planned = checkImport(data, existing);
  if (planned.conflicts.length)
    throw new DomainError(
      "IDEMPOTENCY_CONFLICT",
      "Source keys conflict with existing financial records; resolve explicitly.",
      { conflicts: planned.conflicts },
      409,
    );
  const maps = {
    accounts: new Map(
      inventory.accounts.map((a) => [exportKey(a, a.account_id), a.account_id]),
    ),
    categories: new Map(
      inventory.categories.map((a) => [
        exportKey(a, a.category_id),
        a.category_id,
      ]),
    ),
    plans: new Map(
      inventory.plans.map((a) => [exportKey(a, a.plan_id), a.plan_id]),
    ),
    transactions: new Map(
      inventory.transactions.map((a) => [
        exportKey(a, a.transaction_id),
        a.transaction_id,
      ]),
    ),
  };
  const created = {
    accounts: [] as string[],
    categories: [] as string[],
    plans: [] as string[],
    transactions: [] as string[],
  };
  const archiveQueue: {
    table: string;
    column: string;
    identity: string;
    at: string;
  }[] = [];
  for (const item of data.accounts) {
    if (maps.accounts.has(item.external_key)) continue;
    const change = await financeCommand(
      tx,
      "finance_account_create",
      { ...item },
      principal,
      0,
      true,
    );
    maps.accounts.set(item.external_key, change.entityId);
    created.accounts.push(change.entityId);
    if (item.archived_at)
      archiveQueue.push({
        table: "finance_accounts",
        column: "account_id",
        identity: change.entityId,
        at: item.archived_at,
      });
  }
  for (const item of data.categories) {
    if (maps.categories.has(item.external_key)) continue;
    const change = await financeCommand(
      tx,
      "finance_category_create",
      { ...item },
      principal,
      0,
      true,
    );
    maps.categories.set(item.external_key, change.entityId);
    created.categories.push(change.entityId);
    if (item.archived_at)
      archiveQueue.push({
        table: "finance_categories",
        column: "category_id",
        identity: change.entityId,
        at: item.archived_at,
      });
  }
  for (const item of data.plans) {
    if (maps.plans.has(item.external_key)) continue;
    let planId = "",
      version = 0;
    for (const v of item.versions) {
      const change = await financeCommand(
        tx,
        planId ? "finance_plan_update" : "finance_plan_create",
        {
          title: item.title,
          kind: item.kind,
          notes: item.notes,
          source_label: item.source_label,
          external_key: item.external_key,
          account_id: item.account_key
            ? maps.accounts.get(item.account_key)
            : null,
          category_id: item.category_key
            ? maps.categories.get(item.category_key)
            : null,
          ...v,
          ...(planId ? { plan_id: planId } : {}),
        },
        principal,
        version,
        true,
      );
      planId = change.entityId;
      version = Number((change.after as Input).revision);
    }
    maps.plans.set(item.external_key, planId);
    created.plans.push(planId);
    if (item.archived_at)
      archiveQueue.push({
        table: "finance_plans",
        column: "plan_id",
        identity: planId,
        at: item.archived_at,
      });
  }
  for (const item of data.transactions) {
    if (maps.transactions.has(item.external_key)) continue;
    const change = await financeCommand(
      tx,
      "finance_transaction_create",
      {
        title: item.title,
        kind: item.kind,
        date: item.date,
        amount_cents: item.amount_cents,
        notes: item.notes,
        source_label: item.source_label,
        external_key: item.external_key,
        account_id: item.account_key
          ? maps.accounts.get(item.account_key)
          : null,
        transfer_account_id: item.transfer_account_key
          ? maps.accounts.get(item.transfer_account_key)
          : null,
        category_id: item.category_key
          ? maps.categories.get(item.category_key)
          : null,
        plan_id: item.plan_key ? maps.plans.get(item.plan_key) : null,
      },
      principal,
      0,
      true,
    );
    maps.transactions.set(item.external_key, change.entityId);
    created.transactions.push(change.entityId);
    if (item.archived_at)
      archiveQueue.push({
        table: "finance_transactions",
        column: "transaction_id",
        identity: change.entityId,
        at: item.archived_at,
      });
  }
  for (const item of archiveQueue)
    await tx.query(
      `UPDATE ${item.table} SET archived_at=$3 WHERE ${item.column}=$1 AND owner_id=$2`,
      [item.identity, principal.ownerId, item.at],
    );
  const final = await financeInventory(tx, principal.ownerId);
  for (const group of [
    "accounts",
    "categories",
    "plans",
    "transactions",
  ] as const)
    for (const identity of created[group]) {
      const column =
        group === "accounts"
          ? "account_id"
          : group === "categories"
            ? "category_id"
            : group === "plans"
              ? "plan_id"
              : "transaction_id";
      const record = final[group].find(
        (r) => (r as unknown as Input)[column] === identity,
      );
      await audit(
        tx,
        principal,
        operationId,
        "finance.record_imported",
        identity,
        null,
        record,
        null,
      );
    }
  await tx.query(
    "UPDATE command_previews SET consumed_at=now() WHERE preview_id=$1 AND owner_id=$2",
    [previewId, principal.ownerId],
  );
  return {
    entityId: previewId,
    before: null,
    after: {
      revision: 1,
      counts: planned.counts,
      source_hash: payload.source_hash,
      created,
    },
    affected: [],
  };
}
