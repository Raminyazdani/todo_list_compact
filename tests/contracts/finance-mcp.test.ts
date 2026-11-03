import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type {
  CommandName,
  DomainService,
  FinanceSummaryDTO,
  Principal,
  QueryName,
} from "../../shared/contracts";
import { createTestDatabase } from "../domain/database";
import { createDomainService } from "../../server/domain/service";
import { TOOL_CATALOG } from "../../server/mcp/catalog";
import { createMcpServer } from "../../server/mcp/server";

let domain: DomainService;
let db: Awaited<ReturnType<typeof createTestDatabase>>;
let principal: Principal;
vi.mock("../../server/domain/service", async (original) => ({
  ...(await original<typeof import("../../server/domain/service")>()),
  getDomainService: () => domain,
}));
const tool = (name: string) => {
  const found = TOOL_CATALOG.find((item) => item.name === name);
  if (!found) throw new Error(`Missing finance tool ${name}`);
  return found;
};
const write = (
  name: CommandName,
  input: Record<string, unknown>,
  revision = 0,
  actor = principal,
  operation = randomUUID(),
) => {
  const parsed = tool(name).schema.parse({
    input,
    operation_id: operation,
    expected_revision: revision,
  }) as {
    input: Record<string, unknown>;
    operation_id: string;
    expected_revision: number;
  };
  return domain.execute(name, parsed.input, actor, {
    idempotencyKey: parsed.operation_id,
    expectedRevision: parsed.expected_revision,
  });
};
const read = (
  name: QueryName,
  input: Record<string, unknown> = {},
  actor = principal,
) =>
  domain.query(
    name,
    tool(name).schema.parse(input) as Record<string, unknown>,
    actor,
  );
beforeAll(async () => {
  db = await createTestDatabase();
  domain = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `finance-catalog-${randomUUID()}`,
    actorId: "synthetic-finance-actor",
    channel: "MCP",
    scopes: ["finance:read", "finance:write"],
  };
});
afterAll(async () => {
  await db.close?.();
});

describe("finance MCP adapter with canonical PostgreSQL service", () => {
  it("requires an explicit create revision and strict integer money", () => {
    expect(() =>
      tool("finance_account_create").schema.parse({
        input: { title: "Synthetic account" },
        operation_id: randomUUID(),
      }),
    ).toThrow();
    expect(() =>
      tool("finance_account_create").schema.parse({
        input: { title: "Synthetic account" },
        operation_id: randomUUID(),
        expected_revision: 1,
      }),
    ).toThrow();
    expect(() =>
      tool("finance_transaction_create").schema.parse({
        input: {
          title: "Synthetic purchase",
          kind: "expense",
          date: "2026-11-02",
          amount_cents: 1.5,
        },
        operation_id: randomUUID(),
        expected_revision: 0,
      }),
    ).toThrow();
    expect(() =>
      tool("finance_plan_create").schema.parse({
        input: {
          title: "Synthetic plan",
          kind: "recurring",
          effective_month: "2026-13",
          amount_cents: 100,
        },
        operation_id: randomUUID(),
        expected_revision: 0,
      }),
    ).toThrow();
    expect(tool("finance_summary").scopes).toEqual(["finance:read"]);
    expect(tool("finance_import_preview").scopes).toEqual(["finance:write"]);
  });

  it("keeps finance scopes, owner isolation and idempotency independent from tasks", async () => {
    const key = randomUUID();
    const created = await write(
      "finance_account_create",
      { title: "Synthetic wallet" },
      0,
      principal,
      key,
    );
    const replay = await write(
      "finance_account_create",
      { title: "Synthetic wallet" },
      0,
      principal,
      key,
    );
    expect(replay.entity_id).toBe(created.entity_id);
    expect(replay.replayed).toBe(true);
    const list = (await read("finance_account_list")) as { total: number };
    expect(list.total).toBe(1);
    await expect(
      read(
        "finance_account_list",
        {},
        { ...principal, scopes: ["tasks:read", "tasks:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      write(
        "finance_account_update",
        {
          account_id: created.entity_id,
          title: "Attempted cross-owner rename",
        },
        created.version,
        { ...principal, ownerId: `other-${randomUUID()}` },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await expect(
      write("finance_category_create", { title: "Synthetic category" }, 0, {
        ...principal,
        scopes: ["finance:read"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });

  it("does not invent paid expenses from plans and rejects stale import previews", async () => {
    await write("finance_plan_create", {
      title: "Synthetic quarterly bill",
      kind: "recurring",
      effective_month: "2026-11",
      amount_cents: 9900,
      amount_basis: "reported",
      interval_months: 3,
    });
    await write("finance_plan_create", {
      title: "Synthetic unknown schedule",
      kind: "recurring",
      effective_month: "2026-11",
      amount_cents: null,
      amount_basis: "unknown",
      interval_months: null,
    });
    const summary = (await read("finance_summary", {
      month: "2026-11",
    })) as FinanceSummaryDTO;
    expect(summary.recurring_monthly_cents).toBe(3300);
    expect(summary.actual.transaction_count).toBe(0);
    expect(summary.actual.expense_cents).toBe(0);
    expect(summary.actual.coverage).toBe("registered_transactions_only");
    expect(summary.unknown_amount_count).toBeGreaterThan(0);
    const preview = (await read("finance_import_preview", {
      data: {
        format: "ramin-life-os/finance/1",
        currency: "EUR",
        accounts: [],
        categories: [
          {
            external_key: "synthetic-import-category",
            title: "Synthetic import category",
          },
        ],
        plans: [],
        transactions: [],
      },
    })) as { preview_id: string };
    await write("finance_category_create", {
      title: "Intervening synthetic change",
    });
    await expect(
      write("finance_import_commit", { preview_id: preview.preview_id }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("executes actual SDK calls and returns a finance-only scope challenge", async () => {
    const server = createMcpServer(principal);
    const client = new Client({
      name: "synthetic-finance-proof",
      version: "1",
    });
    const [st, ct] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(st);
      await client.connect(ct);
      const args = {
        input: { title: "SDK synthetic account" },
        operation_id: randomUUID(),
        expected_revision: 0,
      };
      const result = await client.callTool({
        name: "finance_account_create",
        arguments: args,
      });
      expect(result.isError).not.toBe(true);
      const replay = await client.callTool({
        name: "finance_account_create",
        arguments: args,
      });
      expect(replay.structuredContent).toMatchObject({
        data: { replayed: true },
      });
      const list = await client.callTool({
        name: "finance_account_list",
        arguments: {},
      });
      expect(list.structuredContent).toMatchObject({ data: { total: 1 } });
    } finally {
      await client.close();
      await server.close();
    }
    const deniedServer = createMcpServer({
      ...principal,
      scopes: ["tasks:read"],
    });
    const deniedClient = new Client({
      name: "synthetic-narrow-client",
      version: "1",
    });
    const [dst, dct] = InMemoryTransport.createLinkedPair();
    try {
      await deniedServer.connect(dst);
      await deniedClient.connect(dct);
      const denied = await deniedClient.callTool({
        name: "finance_summary",
        arguments: { month: "2026-11" },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        error: { code: "INSUFFICIENT_PERMISSIONS" },
      });
      expect(JSON.stringify(denied._meta)).toContain("finance:read");
      expect(JSON.stringify(denied._meta)).not.toContain("admin:manage");
    } finally {
      await deniedClient.close();
      await deniedServer.close();
    }
  });
});
