import { beforeEach, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
  rateLimit: vi.fn(),
}));
vi.mock("@/server/auth/principal", () => ({
  requirePrincipal: mocks.principal,
}));
vi.mock("@/server/ai/service", () => ({
  aiMessageSchema: { parse: vi.fn() },
  planIntent: mocks.plan,
  executePlan: mocks.execute,
}));
vi.mock("@/server/http", async (original) => ({
  ...(await original<typeof import("@/server/http")>()),
  rateLimit: mocks.rateLimit,
}));
import { DomainError } from "@/shared/contracts";
import { POST as plan } from "@/app/api/v1/ai/plan/route";
import { POST as execute } from "@/app/api/v1/ai/execute/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.principal.mockResolvedValue({
    ownerId: "synthetic-owner",
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["*"],
  });
});

test.each([plan, execute])(
  "deferred AI rejects authenticated requests before reading input or invoking providers",
  async (route) => {
    const response = await route(
      new Request("https://example.test/api/v1/ai", {
        method: "POST",
        body: "invalid-json-is-never-processed",
      }),
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("FEATURE_DISABLED");
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);

test.each([plan, execute])(
  "deferred AI still requires an authenticated principal",
  async (route) => {
    mocks.principal.mockRejectedValue(
      new DomainError("INSUFFICIENT_PERMISSIONS", "Sign in required", {}, 401),
    );
    expect(
      (await route(new Request("https://example.test/api/v1/ai"))).status,
    ).toBe(401);
    expect(mocks.plan).not.toHaveBeenCalled();
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
