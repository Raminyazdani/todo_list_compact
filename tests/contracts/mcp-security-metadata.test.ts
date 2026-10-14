import { expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../server/mcp/server";

vi.mock("../../server/domain/service", () => ({
  getDomainService: () => ({
    query: async () => {
      throw new Error("Metadata discovery must not read owner data");
    },
    execute: async () => {
      throw new Error("Metadata discovery must not write owner data");
    },
  }),
}));

it("real_SDK_discovery_advertises_target_scope_alternatives_without_broadening_other_tool_grants", async () => {
  // Actual MCP encoding/client validation with an in-memory transport; this is
  // metadata evidence, not an HTTP OAuth or production permission proof.
  const server = createMcpServer({
    ownerId: "synthetic-metadata-owner",
    actorId: "synthetic-metadata-client",
    channel: "MCP",
    scopes: ["tasks:read"],
  });
  const client = new Client({ name: "synthetic-metadata-check", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const offered = await client.listTools();
    const security = (name: string) =>
      offered.tools.find((tool) => tool.name === name)?._meta?.securitySchemes;
    expect(security("notifications_list")).toEqual([
      { type: "oauth2", scopes: ["tasks:read"] },
      { type: "oauth2", scopes: ["calendar:read"] },
    ]);
    expect(security("notification_mark_read")).toEqual([
      { type: "oauth2", scopes: ["tasks:write"] },
      { type: "oauth2", scopes: ["calendar:write"] },
    ]);
    expect(security("file_metadata_update")).toEqual([
      { type: "oauth2", scopes: ["files:write"] },
    ]);
    expect(security("calendar_reminder_create")).toEqual([
      { type: "oauth2", scopes: ["calendar:write"] },
    ]);
    expect(security("task_get")).toEqual([
      { type: "oauth2", scopes: ["tasks:read"] },
    ]);
    expect(
      offered.tools.find((tool) => tool.name === "file_metadata_update")
        ?.annotations,
    ).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  } finally {
    await client.close();
    await server.close();
  }
});
