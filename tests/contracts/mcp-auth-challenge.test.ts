import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "../../server/db/database";
import type { DomainService, Principal } from "../../shared/contracts";
import { createTestDatabase } from "../domain/database";

const registry = vi.hoisted(() => ({ domain: null as DomainService | null }));
vi.mock("../../server/domain/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/domain/service")>()),
  getDomainService: () => registry.domain,
}));

import { createDomainService } from "../../server/domain/service";
import { createMcpServer } from "../../server/mcp/server";

let database: Database;
const ownerId = `mcp-oauth-scope-${randomUUID()}`;
const actorId = `mcp-oauth-actor-${randomUUID()}`;
const principal = (scopes: string[]): Principal => ({
  ownerId,
  actorId,
  channel: "MCP",
  scopes,
});

beforeAll(async () => {
  database = await createTestDatabase();
  registry.domain = createDomainService(database);
}, 30000);

afterAll(async () => {
  registry.domain = null;
  await database?.close?.();
});

async function withMcpClient<T>(
  scopes: string[],
  run: (client: Client) => Promise<T>,
  override?: Partial<Principal>,
) {
  const server = createMcpServer({ ...principal(scopes), ...override });
  const client = new Client({ name: "synthetic-scope-client", version: "1" });
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return await run(client);
  } finally {
    await client.close();
    await server.close();
  }
}

it("returns an OAuth scope challenge for a denied write while read tools still work", async () => {
  const created = await registry.domain!.execute(
    "task_create",
    { title: "Synthetic OAuth scope task" },
    principal(["tasks:write"]),
    { idempotencyKey: randomUUID() },
  );
  await withMcpClient(["tasks:read"], async (client) => {
    const offered = await client.listTools();
    expect(
      offered.tools.find((tool) => tool.name === "task_create")?._meta
        ?.securitySchemes,
    ).toEqual([{ type: "oauth2", scopes: ["tasks:write"] }]);

    const read = await client.callTool({
      name: "task_get",
      arguments: { task_id: created.entity_id },
    });
    expect(read.isError).not.toBe(true);
    expect(read.structuredContent).toMatchObject({
      data: { task_id: created.entity_id },
    });

    const denied = await client.callTool({
      name: "task_create",
      arguments: {
        input: { title: "Must not be created" },
        operation_id: randomUUID(),
      },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: "INSUFFICIENT_PERMISSIONS",
        message: "Required tasks:write scope.",
      },
    });
    expect(denied._meta?.["mcp/www_authenticate"]).toEqual([
      expect.stringMatching(
        /^Bearer resource_metadata=".+\/\.well-known\/oauth-protected-resource\/api\/mcp", error="insufficient_scope", error_description="Grant tasks:write to use this tool", scope="tasks:write"$/,
      ),
    ]);
  });
});

it("does not offer reauthorization for a missing human confirmation", async () => {
  await withMcpClient(["tasks:write"], async (client) => {
    const denied = await client.callTool({
      name: "task_dependency_waive_commit",
      arguments: {
        input: { preview_id: randomUUID() },
        operation_id: randomUUID(),
        human_confirmation_id: randomUUID(),
      },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: {
        code: "INSUFFICIENT_PERMISSIONS",
        message:
          "A matching unexpired human confirmation ticket is required for an MCP waiver.",
      },
    });
    expect(denied._meta?.["mcp/www_authenticate"]).toBeUndefined();
  });
});

it("does not present an OAuth grant when the principal has no owner", async () => {
  await withMcpClient(
    ["tasks:read"],
    async (client) => {
      const denied = await client.callTool({
        name: "task_get",
        arguments: { task_id: "synthetic-owner-only-task" },
      });
      expect(denied.structuredContent).toMatchObject({
        error: {
          code: "INSUFFICIENT_PERMISSIONS",
          message: "Authentication required.",
        },
      });
      expect(denied._meta?.["mcp/www_authenticate"]).toBeUndefined();
    },
    { ownerId: "" },
  );
});
