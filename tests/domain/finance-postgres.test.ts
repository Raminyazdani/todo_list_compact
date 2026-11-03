import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDatabase,
  migrateDatabase,
  type Database,
} from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  CommandName,
  DomainService,
  FinanceImportDTO,
  FinanceImportPreviewDTO,
  FinanceSummaryDTO,
  Principal,
} from "../../shared/contracts";

/** Opt-in only: the release coordinator supplies an isolated expiring PG clone. */
describe.skipIf(process.env.TEST_POSTGRES !== "1")(
  "Native PostgreSQL finance constraints and races",
  () => {
    let db: Database, service: DomainService;
    const principal: Principal = {
      ownerId: `synthetic-finance-pg-${randomUUID()}`,
      actorId: "synthetic-finance-pg-runner",
      channel: "UI",
      scopes: ["finance:read", "finance:write"],
    };
    const execute = (
      command: CommandName,
      input: Record<string, unknown>,
      revision = 0,
      key = randomUUID(),
      actor = principal,
    ) =>
      service.execute(command, input, actor, {
        expectedRevision: revision,
        idempotencyKey: key,
      });
    beforeAll(async () => {
      db = getDatabase();
      await migrateDatabase(db);
      service = createDomainService(db);
    }, 60000);
    afterAll(async () => db.close?.());

    it("same-key concurrent creations create one row and one audit receipt", async () => {
      const key = randomUUID(),
        input = {
          title: "Synthetic native account",
          external_key: `synthetic-source-${randomUUID()}`,
          opening_balance_cents: 0,
          opening_balance_date: "2028-01-01",
        };
      const results = await Promise.all([
        execute("finance_account_create", input, 0, key),
        execute("finance_account_create", input, 0, key),
      ]);
      expect(results[0].entity_id).toBe(results[1].entity_id);
      expect(results.filter((r) => r.replayed)).toHaveLength(1);
      const count = await db.query<{ count: string }>(
        "SELECT count(*) FROM finance_accounts WHERE owner_id=$1 AND external_key=$2",
        [principal.ownerId, input.external_key],
      );
      expect(Number(count.rows[0].count)).toBe(1);
      const audits = await db.query<{ count: string }>(
        "SELECT count(*) FROM activity_events WHERE owner_id=$1 AND entity_id=$2 AND event_type='finance_account_create'",
        [principal.ownerId, results[0].entity_id],
      );
      expect(Number(audits.rows[0].count)).toBe(1);
    }, 30000);

    it("concurrent selected-month versions admit one revision and preserve the earlier month", async () => {
      const plan = await execute("finance_plan_create", {
        title: "Synthetic native plan",
        kind: "recurring",
        effective_month: "2028-01",
        amount_cents: 11111,
        amount_basis: "reported",
        interval_months: 1,
      });
      const updates = await Promise.allSettled(
        [22222, 33333].map((amount_cents) =>
          execute(
            "finance_plan_update",
            {
              plan_id: plan.entity_id,
              effective_month: "2028-02",
              amount_cents,
            },
            1,
          ),
        ),
      );
      expect(updates.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        (updates.find((r) => r.status === "rejected") as PromiseRejectedResult)
          .reason,
      ).toMatchObject({ code: "REVISION_CONFLICT" });
      const prior = (await service.query(
        "finance_summary",
        { month: "2028-01" },
        principal,
      )) as FinanceSummaryDTO;
      expect(prior.recurring_monthly_cents).toBe(11111);
      const versions = await db.query<{ count: string }>(
        "SELECT count(*) FROM finance_plan_versions WHERE owner_id=$1 AND plan_id=$2",
        [principal.ownerId, plan.entity_id],
      );
      expect(Number(versions.rows[0].count)).toBe(2);
    }, 30000);

    it("owner-bound composite foreign keys and cents/transfer checks also reject direct SQL", async () => {
      const a = await execute("finance_account_create", {
        title: "Synthetic guarded account",
        external_key: `synthetic-immutable-${randomUUID()}`,
      });
      const other = {
        ...principal,
        ownerId: `synthetic-finance-foreign-${randomUUID()}`,
      };
      await execute(
        "finance_category_create",
        { title: "Initialize foreign owner" },
        0,
        randomUUID(),
        other,
      );
      await expect(
        execute(
          "finance_transaction_create",
          {
            title: "Foreign link",
            kind: "expense",
            date: "2028-01-05",
            amount_cents: 1,
            account_id: a.entity_id,
          },
          0,
          randomUUID(),
          other,
        ),
      ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
      await expect(
        db.query(
          "INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents,account_id) VALUES($1,$2,'Synthetic direct foreign','expense','2028-01-05',1,$3)",
          [randomUUID(), other.ownerId, a.entity_id],
        ),
      ).rejects.toMatchObject({ code: "23503" });
      await expect(
        db.query(
          "INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents,account_id,transfer_account_id) VALUES($1,$2,'Synthetic invalid transfer','transfer','2028-01-05',1,$3,$3)",
          [randomUUID(), principal.ownerId, a.entity_id],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          "INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents) VALUES($1,$2,'Synthetic oversized','expense','2028-01-05',1000000000001)",
          [randomUUID(), principal.ownerId],
        ),
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        db.query(
          "UPDATE finance_accounts SET external_key='synthetic-changed-source' WHERE account_id=$1 AND owner_id=$2",
          [a.entity_id, principal.ownerId],
        ),
      ).rejects.toMatchObject({ code: "P0001" });
      const collisionCases: {
        command: CommandName;
        input: Record<string, unknown>;
        sql: string;
      }[] = [
        {
          command: "finance_account_create",
          input: { title: "Synthetic manual canonical account" },
          sql: "INSERT INTO finance_accounts(account_id,owner_id,title,external_key) VALUES($1,$2,'Synthetic collision',$3)",
        },
        {
          command: "finance_category_create",
          input: { title: "Synthetic manual canonical category" },
          sql: "INSERT INTO finance_categories(category_id,owner_id,title,external_key) VALUES($1,$2,'Synthetic collision',$3)",
        },
        {
          command: "finance_plan_create",
          input: {
            title: "Synthetic manual canonical plan",
            kind: "budget",
            effective_month: "2028-01",
            amount_cents: 1000,
            amount_basis: "reported",
            interval_months: 1,
          },
          sql: "INSERT INTO finance_plans(plan_id,owner_id,title,kind,external_key) VALUES($1,$2,'Synthetic collision','budget',$3)",
        },
        {
          command: "finance_transaction_create",
          input: {
            title: "Synthetic manual canonical actual",
            kind: "expense",
            date: "2028-01-05",
            amount_cents: 1,
          },
          sql: "INSERT INTO finance_transactions(transaction_id,owner_id,title,kind,posted_on,amount_cents,external_key) VALUES($1,$2,'Synthetic collision','expense','2028-01-05',1,$3)",
        },
      ];
      for (const fixture of collisionCases) {
        const original = await execute(fixture.command, fixture.input);
        const key = `life-os:${original.entity_id}`;
        await expect(
          execute(fixture.command, { ...fixture.input, external_key: key }),
        ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
        await expect(
          db.query(fixture.sql, [
            `synthetic-native-collision-${randomUUID()}`,
            principal.ownerId,
            key,
          ]),
        ).rejects.toMatchObject({ code: "23505" });
      }
    }, 30000);

    it("stale pinned imports reject after another connection writes and migration is repeatable", async () => {
      const data: FinanceImportDTO = {
        format: "ramin-life-os/finance/1",
        currency: "EUR",
        accounts: [],
        categories: [
          {
            external_key: `synthetic-import-${randomUUID()}`,
            title: "Synthetic pending import",
          },
        ],
        plans: [],
        transactions: [],
      };
      const preview = (await service.query(
        "finance_import_preview",
        { data },
        principal,
      )) as FinanceImportPreviewDTO;
      await execute("finance_category_create", {
        title: "Synthetic independent write",
      });
      await expect(
        execute("finance_import_commit", { preview_id: preview.preview_id }),
      ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
      const row = await db.query<{ count: string }>(
        "SELECT count(*) FROM finance_categories WHERE owner_id=$1 AND external_key=$2",
        [principal.ownerId, data.categories[0].external_key],
      );
      expect(Number(row.rows[0].count)).toBe(0);
      const before = await db.query<{ count: string }>(
        "SELECT count(*) FROM finance_accounts WHERE owner_id=$1",
        [principal.ownerId],
      );
      await migrateDatabase(db);
      const after = await db.query<{ count: string }>(
        "SELECT count(*) FROM finance_accounts WHERE owner_id=$1",
        [principal.ownerId],
      );
      expect(after.rows).toEqual(before.rows);
      const version = await db.query<{ count: string }>(
        "SELECT count(*) FROM schema_migrations WHERE version=4",
      );
      expect(Number(version.rows[0].count)).toBe(1);
    }, 60000);
  },
);
