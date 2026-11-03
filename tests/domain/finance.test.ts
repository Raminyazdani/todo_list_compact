import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { createDomainService } from "../../server/domain/service";
import { MIGRATION_SQL } from "../../server/db/schema";
import { FINANCE_MIGRATION_SQL } from "../../server/db/finance-schema";
import { FINANCE_TABLES } from "../../server/domain/finance";
import {
  FINANCE_IMPORT_MAX_BYTES,
  normalizedFinanceImport,
} from "../../server/domain/finance-import";
import { hash } from "../../server/domain/core";
import { createTestDatabase } from "./database";
import type { Database } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  FinanceImportDTO,
  FinanceImportPreviewDTO,
  FinancePlanDTO,
  FinanceSummaryDTO,
  FinanceTransactionDTO,
  PageDTO,
  Principal,
  QueryName,
} from "../../shared/contracts";

let db: Database, service: DomainService, principal: Principal;
const empty = (): FinanceImportDTO => ({
  format: "ramin-life-os/finance/1",
  currency: "EUR",
  accounts: [],
  categories: [],
  plans: [],
  transactions: [],
});
const execute = (
  command: CommandName,
  input: Record<string, unknown>,
  revision = 0,
  actor = principal,
  key = randomUUID(),
) =>
  service.execute(command, input, actor, {
    expectedRevision: revision,
    idempotencyKey: key,
  });
const query = <T>(
  operation: QueryName,
  input: Record<string, unknown> = {},
  actor = principal,
) => service.query(operation, input, actor) as Promise<T>;
const summary = (month = "2028-01", input = {}) =>
  query<FinanceSummaryDTO>("finance_summary", { month, ...input });
const createPlan = (input: Record<string, unknown> = {}) =>
  execute("finance_plan_create", {
    title: "Synthetic cost",
    kind: "recurring",
    effective_month: "2028-01",
    amount_cents: 12001,
    amount_basis: "reported",
    interval_months: 1,
    ...input,
  });
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `finance-synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["finance:read", "finance:write"],
  };
});
afterAll(async () => db.close?.());

describe("Owner finance domain", () => {
  it("migrates the old schema additively, repeats safely and keeps the standalone SQL synchronized", async () => {
    expect(FINANCE_MIGRATION_SQL.trim()).toBe(
      readFileSync("server/db/migrations/0004_finance.sql", "utf8").trim(),
    );
    const pg = new PGlite();
    try {
      for (const name of [
        "0001_initial.sql",
        "0002_work_contract_policies.sql",
        "0003_routines.sql",
      ])
        await pg.exec(readFileSync(`server/db/migrations/${name}`, "utf8"));
      await pg.exec(
        "INSERT INTO owners(owner_id) VALUES('synthetic-existing')",
      );
      await pg.exec(
        "INSERT INTO projects(project_id,owner_id,title) VALUES('synthetic-project','synthetic-existing','Preserved')",
      );
      await pg.exec(MIGRATION_SQL);
      await pg.exec(MIGRATION_SQL);
      expect(
        (
          await pg.query<{ version: number }>(
            "SELECT version FROM schema_migrations ORDER BY version",
          )
        ).rows.map((x) => x.version),
      ).toEqual([1, 3, 4]);
      expect(
        (
          await pg.query(
            "SELECT title FROM projects WHERE project_id='synthetic-project'",
          )
        ).rows,
      ).toEqual([{ title: "Preserved" }]);
      const tables = await pg.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'finance_%' ORDER BY tablename",
      );
      expect(tables.rows.map((x) => x.tablename)).toEqual(
        [...FINANCE_TABLES].sort(),
      );
    } finally {
      await pg.close();
    }
  }, 30000);

  it("keeps bill cents, monthly budgets, reserves, optional amounts and unknown references distinct", async () => {
    await createPlan({
      amount_cents: 10001,
      interval_months: 3,
      due_precision: "exact",
      due_day: 15,
    });
    await createPlan({ title: "Budget", kind: "budget", amount_cents: 2700 });
    await createPlan({
      title: "Reserve",
      kind: "reserve",
      amount_cents: 12500,
      target_cents: 100003,
      horizon_months: 6,
    });
    await createPlan({
      title: "Optional",
      kind: "reserve",
      amount_cents: 700,
      included: false,
    });
    await createPlan({
      title: "One time",
      kind: "one_off",
      amount_cents: 99999,
      interval_months: null,
      due_precision: "exact",
      due_on: "2028-01-22",
    });
    await createPlan({
      title: "Unknown liability",
      kind: "liability",
      amount_cents: null,
      amount_basis: "unknown",
      interval_months: null,
      state: "reference",
      included: false,
    });
    await createPlan({
      title: "Unknown cadence",
      amount_cents: 800,
      interval_months: null,
    });
    const result = await summary();
    expect(result).toMatchObject({
      recurring_monthly_cents: 3334,
      budget_monthly_cents: 2700,
      reserve_monthly_cents: 12500,
      optional_reserve_monthly_cents: 700,
      monthly_cost_cents: 6034,
      monthly_allocation_cents: 18534,
      unknown_amount_count: 2,
      included_unknown_amount_count: 1,
      monthly_equivalent_is_estimate: true,
    });
    expect(result.actual.transaction_count).toBe(0);
    expect(
      result.reserve_benchmarks.find((x) => x.title === "Reserve"),
    ).toMatchObject({ projected_cents: 75000, shortfall_cents: 25003 });
    expect(result.upcoming.map((x) => x.date)).toEqual(["2028-01-22"]); // No invented quarterly anchor.
    const list = await query<PageDTO<FinancePlanDTO>>("finance_plan_list", {
      month: "2028-01",
      limit: 200,
    });
    expect(list.items.find((p) => p.title === "Synthetic cost")).toMatchObject({
      amount_cents: 10001,
      monthly_equivalent_cents: 3334,
    });
    expect(
      list.items.find((p) => p.title === "Unknown cadence")
        ?.monthly_equivalent_cents,
    ).toBeNull();
  });

  it("versions selected and future months without rewriting earlier months or registered actuals", async () => {
    const p = await createPlan({ amount_cents: 10000 });
    const tx = await execute("finance_transaction_create", {
      title: "Actual",
      kind: "expense",
      date: "2028-01-04",
      amount_cents: 3333,
      plan_id: p.entity_id,
      account_id: null,
    });
    const future = await execute(
      "finance_plan_update",
      { plan_id: p.entity_id, effective_month: "2028-03", amount_cents: 30000 },
      1,
    );
    await execute(
      "finance_plan_update",
      { plan_id: p.entity_id, effective_month: "2028-02", amount_cents: 20000 },
      future.version,
    );
    expect((await summary("2028-01")).recurring_monthly_cents).toBe(10000);
    expect((await summary("2028-02")).recurring_monthly_cents).toBe(20000);
    expect((await summary("2028-03")).recurring_monthly_cents).toBe(30000);
    expect(
      (await summary("2028-01", { horizon_months: 3 })).projection.months.map(
        (x) => x.monthly_allocation_cents,
      ),
    ).toEqual([10000, 20000, 30000]);
    const actual = await query<PageDTO<FinanceTransactionDTO>>(
      "finance_transaction_list",
      { month: "2028-01" },
    );
    expect(actual.items[0]).toMatchObject({
      transaction_id: tx.entity_id,
      amount_cents: 3333,
      revision: 1,
    });
    const paused = await execute(
      "finance_plan_archive",
      { plan_id: p.entity_id, effective_month: "2028-02" },
      3,
    );
    expect((await summary("2028-01")).recurring_monthly_cents).toBe(10000);
    expect((await summary("2028-03")).recurring_monthly_cents).toBe(0);
    await execute(
      "finance_plan_restore",
      { plan_id: p.entity_id, effective_month: "2028-04" },
      paused.version,
    );
    expect((await summary("2028-03")).recurring_monthly_cents).toBe(0);
    expect((await summary("2028-04")).recurring_monthly_cents).toBe(30000);
  });

  it("registers transfers once without turning them into expenses or income and derives only known balances", async () => {
    const a = await execute("finance_account_create", {
      title: "Account A",
      opening_balance_cents: 100000,
      opening_balance_date: "2028-01-01",
    });
    const b = await execute("finance_account_create", {
      title: "Account B",
      opening_balance_cents: 0,
      opening_balance_date: "2028-01-01",
    });
    const unknown = await execute("finance_account_create", {
      title: "Unknown balance",
    });
    for (const [kind, amount] of [
      ["expense", 12345],
      ["refund", 2345],
      ["income", 45000],
    ] as const)
      await execute("finance_transaction_create", {
        title: kind,
        kind,
        date: "2028-01-12",
        amount_cents: amount,
        account_id: a.entity_id,
      });
    await execute("finance_transaction_create", {
      title: "Transfer",
      kind: "transfer",
      date: "2028-01-14",
      amount_cents: 10000,
      account_id: a.entity_id,
      transfer_account_id: b.entity_id,
    });
    const result = await summary();
    expect(result.actual).toEqual({
      expense_cents: 12345,
      refund_cents: 2345,
      net_expense_cents: 10000,
      income_cents: 45000,
      transfer_cents: 10000,
      transaction_count: 4,
      coverage: "registered_transactions_only",
    });
    expect(
      result.by_account.find((x) => x.account_id === a.entity_id)
        ?.balance_cents,
    ).toBe(125000);
    expect(
      result.by_account.find((x) => x.account_id === b.entity_id)
        ?.balance_cents,
    ).toBe(10000);
    expect(
      result.by_account.find((x) => x.account_id === unknown.entity_id)
        ?.balance_cents,
    ).toBeNull();
    const incoming = await query<PageDTO<FinanceTransactionDTO>>(
      "finance_transaction_list",
      { month: "2028-01", account_id: b.entity_id },
    );
    expect(incoming.items).toHaveLength(1);
    expect(incoming.items[0].kind).toBe("transfer");
    expect(
      (await summary("2027-12")).by_account.find(
        (x) => x.account_id === a.entity_id,
      )?.balance_cents,
    ).toBeNull();
  });

  it("rejects imprecise cents, impossible dates and malformed transfer/balance/unknown fields", async () => {
    for (const amount of [1.5, -1, Number.MAX_SAFE_INTEGER, NaN])
      await expect(createPlan({ amount_cents: amount })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    await expect(
      createPlan({ amount_cents: null, amount_basis: "confirmed" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createPlan({ amount_cents: 0, amount_basis: "unknown" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      createPlan({ kind: "budget", interval_months: null }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute("finance_account_create", {
        title: "A",
        opening_balance_cents: 0,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute("finance_category_create", { title: "   " }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const input of [
      { kind: "expense", date: "2028-02-30", amount_cents: 1 },
      { kind: "expense", date: "2028-01-02", amount_cents: 0 },
      { kind: "transfer", date: "2028-01-02", amount_cents: 1 },
    ])
      await expect(
        execute("finance_transaction_create", { title: "Invalid", ...input }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await createPlan({ amount_cents: 0, amount_basis: "reported" });
    expect((await summary()).unknown_amount_count).toBe(0);
  });

  it("treats approximate days as labels and never guesses a nonexistent monthly or quarterly date", async () => {
    await createPlan({
      title: "Approximate",
      due_day: 15,
      due_precision: "approximate",
    });
    await createPlan({ title: "Day31", due_day: 31, due_precision: "exact" });
    await expect(
      createPlan({ due_on: "2028-01-15", due_precision: "approximate" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const result = await summary("2028-02");
    expect(result.upcoming).toEqual([
      expect.objectContaining({
        title: "Approximate",
        date: null,
        day: 15,
        precision: "approximate",
      }),
    ]);
  });

  it("uses canonical scopes, owner references, revisions, immutable source keys and idempotent audited receipts", async () => {
    const key = randomUUID(),
      input = { title: "Synthetic account", external_key: "synthetic-source" };
    await expect(
      execute("finance_account_create", input, 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const created = await execute(
      "finance_account_create",
      input,
      0,
      principal,
      key,
    );
    expect(
      (await execute("finance_account_create", input, 0, principal, key))
        .replayed,
    ).toBe(true);
    await expect(
      execute(
        "finance_account_create",
        { ...input, title: "Changed" },
        0,
        principal,
        key,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const other = { ...principal, ownerId: `synthetic-other-${randomUUID()}` };
    await expect(
      execute(
        "finance_transaction_create",
        {
          title: "Cross owner",
          kind: "expense",
          date: "2028-01-01",
          amount_cents: 1,
          account_id: created.entity_id,
        },
        0,
        other,
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await expect(
      query("finance_account_list", {}, other),
    ).resolves.toMatchObject({ total: 0 });
    await expect(
      execute("finance_account_create", { title: "Denied" }, 0, {
        ...principal,
        scopes: ["finance:read"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      query("finance_summary", {}, { ...principal, scopes: ["tasks:read"] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await execute(
      "finance_account_update",
      { account_id: created.entity_id, title: "New title" },
      1,
    );
    await expect(
      execute(
        "finance_account_update",
        { account_id: created.entity_id, title: "Stale" },
        1,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      execute(
        "finance_account_update",
        { account_id: created.entity_id, external_key: "other-source" },
        2,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const auditCount = (
      await db.query<{ count: string }>(
        "SELECT count(*) FROM activity_events WHERE owner_id=$1",
        [principal.ownerId],
      )
    ).rows[0].count;
    expect(Number(auditCount)).toBe(2);
  });

  it("paginates stable filtered lists and clears nullable references explicitly", async () => {
    const a = await execute("finance_account_create", { title: "A" });
    const category = await execute("finance_category_create", {
      title: "Category",
    });
    const p = await createPlan({
      account_id: a.entity_id,
      category_id: category.entity_id,
    });
    await execute(
      "finance_plan_update",
      {
        plan_id: p.entity_id,
        effective_month: "2028-01",
        account_id: null,
        category_id: null,
      },
      1,
    );
    const list = await query<PageDTO<FinancePlanDTO>>("finance_plan_list", {
      month: "2028-01",
    });
    expect(list.items[0]).toMatchObject({
      account_id: null,
      category_id: null,
    });
    for (let i = 0; i < 3; i++)
      await execute("finance_category_create", { title: `Search ${i}` });
    const first = await query<PageDTO<{ category_id: string }>>(
      "finance_category_list",
      { search: "Search", limit: 2 },
    );
    const last = await query<PageDTO<{ category_id: string }>>(
      "finance_category_list",
      { search: "Search", limit: 2, cursor: first.next_cursor },
    );
    expect(first.total).toBe(3);
    expect(first.items).toHaveLength(2);
    expect(last.items).toHaveLength(1);
    expect(last.next_cursor).toBeNull();
    const archived = await execute(
      "finance_category_archive",
      { category_id: category.entity_id },
      1,
    );
    expect(
      (
        await query<PageDTO<unknown>>("finance_category_list", {
          archived: true,
        })
      ).total,
    ).toBe(1);
    await execute(
      "finance_category_restore",
      { category_id: category.entity_id },
      archived.version,
    );
  });

  it("imports and exports archived multi-version records without duplicates or silent source overwrites", async () => {
    const a = await execute("finance_account_create", { title: "Account" });
    const c = await execute("finance_category_create", { title: "Category" });
    const p = await createPlan({
      account_id: a.entity_id,
      category_id: c.entity_id,
    });
    await execute(
      "finance_plan_update",
      { plan_id: p.entity_id, effective_month: "2028-02", amount_cents: 22222 },
      1,
    );
    await execute("finance_transaction_create", {
      title: "Actual",
      kind: "expense",
      date: "2028-01-12",
      amount_cents: 3000,
      account_id: a.entity_id,
      category_id: c.entity_id,
      plan_id: p.entity_id,
    });
    await execute(
      "finance_plan_archive",
      { plan_id: p.entity_id, effective_month: "2028-03" },
      2,
    );
    await execute("finance_account_archive", { account_id: a.entity_id }, 1);
    const exported = await query<FinanceImportDTO>("finance_export");
    const dest = { ...principal, ownerId: `finance-import-${randomUUID()}` };
    const preview = await query<FinanceImportPreviewDTO>(
      "finance_import_preview",
      { data: exported },
      dest,
    );
    expect(preview).toMatchObject({
      can_commit: true,
      counts: {
        accounts: 1,
        categories: 1,
        plans: 1,
        transactions: 1,
        unchanged: 0,
      },
    });
    const operation = randomUUID();
    const receipt = await execute(
      "finance_import_commit",
      { preview_id: preview.preview_id },
      0,
      dest,
      operation,
    );
    expect(receipt.data).toMatchObject({
      counts: { plans: 1, transactions: 1 },
      source_hash: preview.source_hash,
    });
    expect(
      (
        await execute(
          "finance_import_commit",
          { preview_id: preview.preview_id },
          0,
          dest,
          operation,
        )
      ).replayed,
    ).toBe(true);
    expect(await query("finance_export", {}, dest)).toEqual(exported);
    const replay = await query<FinanceImportPreviewDTO>(
      "finance_import_preview",
      { data: exported },
      dest,
    );
    expect(replay.counts).toMatchObject({
      accounts: 0,
      categories: 0,
      plans: 0,
      transactions: 0,
      unchanged: 4,
    });
    await execute(
      "finance_import_commit",
      { preview_id: replay.preview_id },
      0,
      dest,
    );
    const conflict = structuredClone(exported);
    conflict.accounts[0].title = "Different source content";
    const refused = await query<FinanceImportPreviewDTO>(
      "finance_import_preview",
      { data: conflict },
      dest,
    );
    expect(refused.can_commit).toBe(false);
    expect(refused.conflicts[0].reason).toBe("SOURCE_KEY_CONTENT_CONFLICT");
    await expect(
      execute(
        "finance_import_commit",
        { preview_id: refused.preview_id },
        0,
        dest,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("pins preview actor, expiry and financial revisions even if an edit retained the same content", async () => {
    const a = await execute("finance_account_create", { title: "Account" });
    const payload = empty();
    payload.categories.push({ external_key: "new-category", title: "New" });
    const p = await query<FinanceImportPreviewDTO>("finance_import_preview", {
      data: payload,
    });
    await expect(
      execute("finance_import_commit", { preview_id: p.preview_id }, 0, {
        ...principal,
        actorId: "other-actor",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await execute(
      "finance_account_update",
      { account_id: a.entity_id, title: "Account" },
      1,
    );
    await expect(
      execute("finance_import_commit", { preview_id: p.preview_id }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const expired = await query<FinanceImportPreviewDTO>(
      "finance_import_preview",
      { data: payload },
    );
    await db.query(
      "UPDATE command_previews SET expires_at='2000-01-01' WHERE preview_id=$1",
      [expired.preview_id],
    );
    await expect(
      execute("finance_import_commit", { preview_id: expired.preview_id }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    expect((await query<PageDTO<unknown>>("finance_category_list")).total).toBe(
      0,
    );
    await expect(
      query(
        "finance_import_preview",
        { data: payload },
        { ...principal, channel: "AI" },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });

  it("shares one canonical source namespace across manual IDs, explicit keys and recoverable exports", async () => {
    const cases: {
      command: CommandName;
      input: Record<string, unknown>;
      sql: string;
    }[] = [
      {
        command: "finance_account_create",
        input: { title: "Manual account" },
        sql: "INSERT INTO finance_accounts(account_id,owner_id,title,external_key) VALUES($1,$2,'Conflicting account',$3)",
      },
      {
        command: "finance_category_create",
        input: { title: "Manual category" },
        sql: "INSERT INTO finance_categories(category_id,owner_id,title,external_key) VALUES($1,$2,'Conflicting category',$3)",
      },
      {
        command: "finance_plan_create",
        input: {
          title: "Manual plan",
          kind: "budget",
          effective_month: "2028-01",
          amount_cents: 1500,
          amount_basis: "reported",
          interval_months: 1,
        },
        sql: "INSERT INTO finance_plans(plan_id,owner_id,title,kind,external_key) VALUES($1,$2,'Conflicting plan','budget',$3)",
      },
      {
        command: "finance_transaction_create",
        input: {
          title: "Manual actual",
          kind: "expense",
          date: "2028-01-03",
          amount_cents: 200,
          account_id: null,
        },
        sql: "INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents,external_key) VALUES($1,$2,'Conflicting actual','expense','2028-01-03',1,$3)",
      },
    ];
    for (const entry of cases) {
      const manual = await execute(entry.command, entry.input);
      const canonical = `life-os:${manual.entity_id}`;
      await expect(
        execute(entry.command, { ...entry.input, external_key: canonical }),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { external_key: canonical },
      });
      await expect(
        db.query(entry.sql, [
          `synthetic-conflict-${randomUUID()}`,
          principal.ownerId,
          canonical,
        ]),
      ).rejects.toMatchObject({ code: "23505" });
    }
    const exported = await query<FinanceImportDTO>("finance_export");
    const dest = {
      ...principal,
      ownerId: `canonical-recovery-${randomUUID()}`,
    };
    const preview = await query<FinanceImportPreviewDTO>(
      "finance_import_preview",
      { data: exported },
      dest,
    );
    expect(preview.can_commit).toBe(true);
    await execute(
      "finance_import_commit",
      { preview_id: preview.preview_id },
      0,
      dest,
    );
    expect(await query("finance_export", {}, dest)).toEqual(exported);
    const legacy = await createTestDatabase();
    try {
      const old = createDomainService(legacy);
      const original = await old.execute(
        "finance_category_create",
        { title: "Legacy manual category" },
        principal,
        { expectedRevision: 0, idempotencyKey: randomUUID() },
      );
      await legacy.query("DROP INDEX finance_categories_canonical_source_idx");
      await legacy.query(
        "INSERT INTO finance_categories(category_id,owner_id,title,external_key) VALUES($1,$2,'Legacy conflicting source',$3)",
        [
          `legacy-conflict-${randomUUID()}`,
          principal.ownerId,
          `life-os:${original.entity_id}`,
        ],
      );
      await expect(
        old.query("finance_export", {}, principal),
      ).rejects.toMatchObject({
        code: "IDEMPOTENCY_CONFLICT",
        details: { kind: "categories", alternative_query: "backup_export" },
      });
      await expect(
        old.query("finance_import_preview", { data: empty() }, principal),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    } finally {
      await legacy.close?.();
    }
  }, 30000);

  it("rejects duplicate keys, broken import references and oversized nonrecoverable finance exports explicitly", async () => {
    const payload = empty();
    payload.categories = [
      { external_key: "duplicate", title: "A" },
      { external_key: "duplicate", title: "B" },
    ];
    await expect(
      query("finance_import_preview", { data: payload }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const bad = empty();
    bad.plans = [
      {
        external_key: "p",
        title: "P",
        kind: "budget",
        account_key: "missing",
        versions: [
          {
            effective_month: "2028-01",
            amount_cents: 1,
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
    ];
    await expect(
      query("finance_import_preview", { data: bad }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await execute("finance_category_create", { title: "Initialize owner" });
    await db.query(
      "INSERT INTO finance_categories(category_id,owner_id,title) SELECT 'limit-'||$1||'-'||i,$1,'Synthetic '||i FROM generate_series(1,1000) i",
      [principal.ownerId],
    );
    await expect(query("finance_export")).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: { alternative_query: "backup_export", max_entities: 1000 },
    });
  });

  it("rejects compact imports whose normalized defaults exceed the byte limit before creating a preview", async () => {
    const compactPlan = {
      external_key: "compact-plan",
      title: "Synthetic compact history",
      kind: "budget",
      versions: Array.from({ length: 100 }, (_, i) => ({
        effective_month: `${2028 + Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`,
      })),
    };
    const normalized = normalizedFinanceImport({
      ...empty(),
      plans: [compactPlan],
    });
    expect(normalizedFinanceImport(normalized)).toEqual(normalized);
    const compact = {
      ...empty(),
      plans: Array.from({ length: 100 }, (_, i) => ({
        ...compactPlan,
        external_key: `compact-${i}`,
      })),
    };
    const expanded = {
      ...empty(),
      plans: compact.plans.map((p) => ({
        ...normalized.plans[0],
        external_key: p.external_key,
      })),
    };
    expect(Buffer.byteLength(JSON.stringify(compact), "utf8")).toBeLessThan(
      FINANCE_IMPORT_MAX_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(expanded), "utf8")).toBeGreaterThan(
      FINANCE_IMPORT_MAX_BYTES,
    );
    await expect(
      query("finance_import_preview", { data: compact }),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      details: {
        max_bytes: FINANCE_IMPORT_MAX_BYTES,
        representation: "normalized",
      },
    });
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM command_previews WHERE owner_id=$1 AND command='finance_import_commit'",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(0);
  });

  it("includes every finance table in complete backups and accepts legacy backups without additive finance tables", async () => {
    const account = await execute("finance_account_create", {
      title: "Backup account",
      opening_balance_cents: -500,
      opening_balance_date: "2028-01-01",
    });
    await createPlan({ account_id: account.entity_id });
    await execute("finance_transaction_create", {
      title: "Backup payment",
      kind: "expense",
      date: "2028-01-12",
      amount_cents: 123,
      account_id: account.entity_id,
    });
    const admin = {
      ...principal,
      scopes: [...principal.scopes, "admin:manage", "backup:export"],
    };
    const backup = await query<{
      tables: Record<string, unknown[]>;
      checksums: Record<string, string>;
      manifest_hash: string;
    }>("backup_export", {}, admin);
    expect(
      FINANCE_TABLES.every(
        (t) => Array.isArray(backup.tables[t]) && Boolean(backup.checksums[t]),
      ),
    ).toBe(true);
    const fresh = await createTestDatabase();
    try {
      const restored = createDomainService(fresh);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        admin,
        {
          idempotencyKey: randomUUID(),
        },
      );
      expect(
        await restored.query(
          "finance_summary",
          { month: "2028-01" },
          principal,
        ),
      ).toMatchObject({
        monthly_cost_cents: 12001,
        actual: { expense_cents: 123 },
      });
    } finally {
      await fresh.close?.();
    }
    const legacy = structuredClone(backup);
    for (const table of FINANCE_TABLES) {
      delete legacy.tables[table];
      delete legacy.checksums[table];
    }
    legacy.manifest_hash = hash(legacy.checksums);
    const old = await createTestDatabase();
    try {
      const restored = createDomainService(old);
      await restored.execute(
        "backup_restore",
        { backup: legacy, explicit_user_intent: true },
        admin,
        {
          idempotencyKey: randomUUID(),
        },
      );
      expect(
        await restored.query(
          "finance_summary",
          { month: "2028-01" },
          principal,
        ),
      ).toMatchObject({
        monthly_cost_cents: 0,
        actual: { transaction_count: 0 },
      });
    } finally {
      await old.close?.();
    }
  }, 30000);
});
