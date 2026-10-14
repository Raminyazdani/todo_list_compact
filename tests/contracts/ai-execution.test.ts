import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, type Principal } from "../../shared/contracts";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  execute: vi.fn(),
  sql: vi.fn(),
  poolQuery: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../server/auth/db", () => ({
  getAuthPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.sql, release: mocks.release }),
  }),
}));
vi.mock("../../server/domain/service", () => ({
  getDomainService: () => ({ query: mocks.query, execute: mocks.execute }),
}));
import { executePlan, planIntent } from "../../server/ai/service";
import { applyPlanPolicy } from "../../server/ai/policy";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-owner",
  channel: "UI",
  scopes: ["admin:manage"],
};
beforeEach(() => {
  mocks.query.mockReset();
  mocks.execute.mockReset();
  mocks.sql.mockReset();
  mocks.poolQuery.mockReset();
  mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mocks.release.mockReset();
  vi.stubEnv("AI_PRICING_MODEL", "synthetic-model");
  vi.stubEnv("AI_PRICING_VERIFIED_AT", new Date().toISOString());
  vi.stubEnv("AI_INPUT_USD_PER_MILLION_TOKENS", "0.1");
  vi.stubEnv("AI_OUTPUT_USD_PER_MILLION_TOKENS", "0.2");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("independent AI orchestration contracts", () => {
  it("known unexecuted and cached plans both deny a principal without ai:invoke before any database access", async () => {
    mocks.sql.mockResolvedValue({
      rows: [
        {
          executed_at: new Date().toISOString(),
          plan: {
            actions: [
              {
                command: "task_create",
                input: { title: "Private synthetic receipt" },
              },
            ],
          },
          results: [{ data: { notes: "Synthetic private receipt" } }],
        },
      ],
    });
    for (const planId of [
      "synthetic-known-unexecuted",
      "synthetic-known-cached",
    ])
      await expect(
        executePlan(planId, {
          ...principal,
          scopes: ["tasks:read", "tasks:write"],
        }),
      ).rejects.toMatchObject({
        code: "INSUFFICIENT_PERMISSIONS",
        status: 403,
      });
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(mocks.sql).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("checklist mutation verifies the actual affected parent task instead of treating a checklist ID as task ID", async () => {
    mocks.sql.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT * FROM ai_plans")
        ? {
            rows: [
              {
                expires_at: new Date(Date.now() + 60000).toISOString(),
                plan: {
                  actions: [
                    {
                      command: "task_checklist_create",
                      input: {
                        task_id: "T-synthetic",
                        title: "Synthetic list",
                      },
                    },
                  ],
                },
              },
            ],
          }
        : { rows: [] },
    );
    mocks.execute.mockResolvedValue({
      entity_id: "CL-synthetic",
      affected_task_ids: ["T-synthetic"],
      version: 1,
      data: { checklist_id: "CL-synthetic" },
    });
    mocks.query.mockImplementation(
      async (operation: string, input: { task_id: string }) => {
        if (operation === "task_get" && input.task_id === "T-synthetic")
          return {
            task_id: "T-synthetic",
            checklists: [{ checklist_id: "CL-synthetic" }],
          };
        throw new DomainError(
          "TASK_NOT_FOUND",
          "Checklist is not a task ID.",
          {},
          404,
        );
      },
    );
    expect(await executePlan("synthetic-plan", principal)).toMatchObject({
      verified: true,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      "task_get",
      { task_id: "T-synthetic" },
      principal,
    );
  });
  it("nested prerequisite IDs must originate in grounded context", () => {
    const raw = {
      answer: "Synthetic proposal",
      actions: [
        {
          command: "task_dependency_add_commit",
          input: {
            task_id: "T-synthetic",
            prerequisites: [{ task_id: "T-invented-nested" }],
          },
        },
      ],
      warnings: [],
    };
    expect(() =>
      applyPlanPolicy(
        raw,
        "Add the stated dependency",
        new Set(["T-synthetic"]),
      ),
    ).toThrow();
  });
  it("nested authorization flags cannot be smuggled through a model proposal", () => {
    const raw = {
      answer: "Synthetic proposal",
      actions: [
        {
          command: "task_dependency_add_commit",
          input: {
            task_id: "T-synthetic",
            prerequisites: [
              { task_id: "T-other-synthetic", explicit_user_intent: true },
            ],
          },
        },
      ],
      warnings: [],
    };
    expect(() =>
      applyPlanPolicy(
        raw,
        "Add the stated dependency",
        new Set(["T-synthetic", "T-other-synthetic"]),
      ),
    ).toThrow();
  });
  it("a missing model connection returns an explicit unsupported state before retrieving or exposing owner context", async () => {
    for (const key of [
      "AI_PROVIDER_URL",
      "AI_PROVIDER_KEY",
      "AI_MODEL",
      "AI_GATEWAY_API_KEY",
      "VERCEL_OIDC_TOKEN",
    ])
      vi.stubEnv(key, "");
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(
      planIntent("Synthetic user intent", principal),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION", status: 503 });
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.poolQuery).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
  it("exhausted owner budget cannot call a paid provider or claim a generated successful plan", async () => {
    vi.stubEnv("AI_PROVIDER_URL", "https://api.openai.com/v1");
    vi.stubEnv("AI_PROVIDER_KEY", "synthetic-test-key");
    vi.stubEnv("AI_MODEL", "synthetic-model");
    vi.stubEnv("AI_DAILY_BUDGET_USD", "1");
    mocks.query.mockResolvedValue({ items: [], total: 0 });
    mocks.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const network = vi.fn();
    vi.stubGlobal("fetch", network);
    await expect(
      planIntent("Synthetic user intent", principal),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS", status: 429 });
    expect(network).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
  it("provider refusal cannot persist a fake plan or mutate domain records", async () => {
    vi.stubEnv("AI_PROVIDER_URL", "https://api.openai.com/v1");
    vi.stubEnv("AI_PROVIDER_KEY", "synthetic-test-key");
    vi.stubEnv("AI_MODEL", "synthetic-model");
    vi.stubEnv("AI_DAILY_BUDGET_USD", "1");
    mocks.query.mockResolvedValue({ items: [], total: 0 });
    mocks.poolQuery.mockResolvedValue({
      rows: [{ cost_microusd: 100000 }],
      rowCount: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("synthetic provider denial", { status: 402 }),
        ),
    );
    await expect(
      planIntent("Synthetic user intent", principal),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION", status: 502 });
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(
      mocks.poolQuery.mock.calls.some((call) =>
        String(call[0]).startsWith("INSERT INTO ai_plans"),
      ),
    ).toBe(false);
  });
  it("failed readback reports failure and a retry uses the same accepted operation key", async () => {
    mocks.sql.mockImplementation(async (sql: string) =>
      sql.startsWith("SELECT * FROM ai_plans")
        ? {
            rows: [
              {
                expires_at: new Date(Date.now() + 60000).toISOString(),
                plan: {
                  actions: [
                    {
                      command: "task_create",
                      input: { title: "Synthetic retry task" },
                    },
                  ],
                },
              },
            ],
          }
        : { rows: [] },
    );
    mocks.execute
      .mockResolvedValueOnce({
        entity_id: "T-synthetic-retry",
        affected_task_ids: ["T-synthetic-retry"],
        version: 1,
      })
      .mockResolvedValueOnce({
        entity_id: "T-synthetic-retry",
        affected_task_ids: ["T-synthetic-retry"],
        version: 1,
        replayed: true,
      });
    mocks.query
      .mockRejectedValueOnce(
        new DomainError(
          "DATABASE_UNAVAILABLE",
          "Synthetic transient readback outage.",
          {},
          503,
        ),
      )
      .mockResolvedValueOnce({ task_id: "T-synthetic-retry" });
    await expect(
      executePlan("synthetic-retry-plan", principal),
    ).rejects.toMatchObject({ code: "DATABASE_UNAVAILABLE" });
    expect(await executePlan("synthetic-retry-plan", principal)).toMatchObject({
      verified: true,
    });
    expect(
      mocks.execute.mock.calls.map((call) => call[3].idempotencyKey),
    ).toEqual(["ai:synthetic-retry-plan:0", "ai:synthetic-retry-plan:0"]);
    expect(
      mocks.sql.mock.calls.filter((call) =>
        String(call[0]).startsWith("UPDATE ai_plans"),
      ),
    ).toHaveLength(1);
  });
});
