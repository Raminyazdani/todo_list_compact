import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainService, Principal } from "../../shared/contracts";
import {
  boundedAiContext,
  estimateAiReservation,
  resolveAiConfiguration,
} from "../../server/integrations/ai-guard";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-owner",
  channel: "UI",
  scopes: ["admin:manage"],
};
beforeEach(() => {
  vi.stubEnv("AI_PROVIDER_URL", "https://api.openai.com/v1");
  vi.stubEnv("AI_PROVIDER_KEY", "synthetic-test-key");
  vi.stubEnv("AI_MODEL", "synthetic-model");
  vi.stubEnv("AI_PRICING_MODEL", "synthetic-model");
  vi.stubEnv("AI_PRICING_VERIFIED_AT", new Date().toISOString());
  vi.stubEnv("AI_INPUT_USD_PER_MILLION_TOKENS", "1");
  vi.stubEnv("AI_OUTPUT_USD_PER_MILLION_TOKENS", "4");
  vi.stubEnv("AI_DAILY_BUDGET_USD", "1");
  vi.stubEnv("AI_MAX_CONTEXT_BYTES", "24000");
  vi.stubEnv("AI_MAX_OUTPUT_TOKENS", "1200");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
describe("bounded grounded context and financial guard", () => {
  it("missing/mismatched/stale pricing cannot enable a paid configured model", () => {
    vi.stubEnv("AI_INPUT_USD_PER_MILLION_TOKENS", "");
    expect(() => resolveAiConfiguration()).toThrow(/AI_PRICING/);
    vi.stubEnv("AI_INPUT_USD_PER_MILLION_TOKENS", "1");
    vi.stubEnv("AI_PRICING_MODEL", "different-model");
    expect(() => resolveAiConfiguration()).toThrow(/AI_PRICING/);
    vi.stubEnv("AI_PRICING_MODEL", "synthetic-model");
    vi.stubEnv("AI_PRICING_VERIFIED_AT", "2000-01-01T00:00:00Z");
    expect(() => resolveAiConfiguration()).toThrow(/AI_PRICING_STALE/);
  });
  it("userinfo, arbitrary host, HTTP, unsafe port and URL query are rejected before any lookup or budget", () => {
    for (const url of [
      "https://username:secret@api.openai.com/v1",
      "https://evil.invalid/v1",
      "http://api.openai.com/v1",
      "https://api.openai.com:8443/v1",
      "https://api.openai.com/v1?secret=synthetic",
    ]) {
      vi.stubEnv("AI_PROVIDER_URL", url);
      expect(() => resolveAiConfiguration()).toThrow();
    }
  });
  it("UTF-8 bytes plus protocol overhead and output cap determine a conservative reservation", () => {
    const configuration = resolveAiConfiguration(),
      messages = [{ role: "user", content: "متن فارسی و emoji 🧪" }];
    const result = estimateAiReservation(messages, configuration);
    expect(result.inputTokenUpperBound).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(messages)),
    );
    expect(result.reservationMicros).toBe(
      Math.ceil(result.inputTokenUpperBound + 1200 * 4),
    );
    vi.stubEnv("AI_DAILY_BUDGET_USD", "0.000001");
    expect(() =>
      estimateAiReservation(messages, resolveAiConfiguration()),
    ).toThrow(/بودجه/);
  });
  it("context includes actual file/checklist/item IDs and revisions, excludes raw secrets/URLs, and caps serialized bytes", async () => {
    const query = vi
      .fn()
      .mockImplementation(
        async (operation: string, input: Record<string, unknown>) => {
          if (operation === "task_search")
            return {
              items: Array.from({ length: 100 }, (_, index) => ({
                task_id: "T-synthetic-" + index,
                title:
                  index === 50
                    ? "Important targeted checklist task"
                    : "Other synthetic task",
                notes: "الف".repeat(10000),
                revision: 3,
                source_reference: "synthetic-private-source-url",
                legacy_metadata: { hidden: "synthetic-private-context-secret" },
              })),
            };
          if (operation === "task_get")
            return {
              task_id: input.task_id,
              title: "Important targeted checklist task",
              revision: 3,
              checklists: [
                {
                  checklist_id: "CL-synthetic-target",
                  title: "Review",
                  revision: 2,
                  items: [
                    {
                      item_id: "CI-synthetic-target",
                      title: "A specific actual item",
                      checked: false,
                      revision: 4,
                    },
                  ],
                },
              ],
            };
          if (operation === "file_search")
            return {
              items: [
                {
                  file_id: "F-synthetic-target",
                  title: "Synthetic file",
                  revision: 2,
                  storage_key: "synthetic-private-storage-secret",
                  external_url:
                    "https://drive.google.com/synthetic-private-pointer",
                },
              ],
            };
          return { items: [] };
        },
      );
    const domain = { query, execute: vi.fn() } as unknown as DomainService;
    const result = await boundedAiContext(
      domain,
      "Important targeted checklist task",
      principal,
      24000,
    );
    const serialized = JSON.stringify(result.context);
    expect(result.bytes).toBeLessThanOrEqual(24000);
    expect(serialized).toContain("T-synthetic-50");
    expect(serialized).toContain("CL-synthetic-target");
    expect(serialized).toContain("CI-synthetic-target");
    expect(serialized).toContain("F-synthetic-target");
    expect(serialized).not.toContain("synthetic-private-context-secret");
    expect(serialized).not.toContain("synthetic-private-storage-secret");
    expect(serialized).not.toContain("synthetic-private-pointer");
    expect(
      query.mock.calls.filter((call) => call[0] === "task_get"),
    ).toHaveLength(6);
    expect(result.truncated).toBe(true);
  });
});
