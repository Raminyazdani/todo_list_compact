import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type { Principal } from "../../shared/contracts";

const principal: Principal = {
  ownerId: "synthetic-capabilities-owner",
  actorId: "synthetic-capabilities-actor",
  channel: "MCP",
  scopes: ["calendar:read", "calendar:write"],
};

function metadataService() {
  const sql = vi.fn(async () => {
    throw new Error("Capability metadata must not query owner rows");
  });
  const exclusive = vi.fn(async () => {
    throw new Error("Capability metadata must not open a write transaction");
  });
  const reads = vi.fn();
  const network = vi.fn(async () => {
    throw new Error("Capability metadata must not contact a provider");
  });
  vi.stubGlobal("fetch", network);
  const database: Database = {
    query: sql,
    transaction: exclusive,
    readTransaction: (owner, action) => {
      reads(owner);
      return action({ query: sql });
    },
  };
  return {
    service: createDomainService(database),
    sql,
    exclusive,
    reads,
    network,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("External calendar feature capability metadata", () => {
  it.each([false, true])(
    "advertises implemented personal writes separately from OAuth configuration (%s)",
    async (configured) => {
      vi.stubEnv("GOOGLE_CLIENT_ID", configured ? "synthetic-client" : "");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", configured ? "synthetic-secret" : "");
      const { service, sql, exclusive, reads, network } = metadataService();

      expect(
        await service.query("system_capabilities", {}, principal),
      ).toMatchObject({
        external_calendar_write: true,
        external_calendar_write_policy: "owned_personal_events_only",
        oauth_client_configured: configured,
      });
      expect(reads).toHaveBeenCalledExactlyOnceWith(principal.ownerId);
      expect(sql).not.toHaveBeenCalled();
      expect(exclusive).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it.each([{ scopes: [] }, { scopes: ["tasks:read"] }])(
    "returns generic support without reading calendar resources for scopes $scopes",
    async ({ scopes }) => {
      vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
      vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
      const { service, sql, exclusive, network } = metadataService();
      const result = await service.query(
        "system_capabilities",
        {},
        { ...principal, scopes },
      );

      expect(result).toMatchObject({
        external_calendar_write: true,
        external_calendar_write_policy: "owned_personal_events_only",
      });
      expect(result).not.toHaveProperty("sources");
      expect(result).not.toHaveProperty("source_ids");
      expect(sql).not.toHaveBeenCalled();
      expect(exclusive).not.toHaveBeenCalled();
      expect(network).not.toHaveBeenCalled();
    },
  );

  it("feature support does not authorize a tasks-only caller to preview or commit Google changes", async () => {
    const { service, sql, exclusive, network } = metadataService();
    const restricted = { ...principal, scopes: ["tasks:read"] };
    expect(
      await service.query("system_capabilities", {}, restricted),
    ).toMatchObject({ external_calendar_write: true });

    await expect(
      service.query(
        "calendar_event_change_preview",
        {
          action: "update",
          source_id: "synthetic-calendar-source",
          event_id: "synthetic-event",
          payload: {},
        },
        restricted,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute(
        "calendar_event_change_commit",
        { preview_id: "synthetic-preview" },
        restricted,
        { idempotencyKey: "synthetic-denied-calendar-commit" },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(sql).not.toHaveBeenCalled();
    expect(exclusive).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
