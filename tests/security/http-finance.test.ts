import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  httpEnabled,
  origin,
  ownerCookie,
  scopedToken,
} from "../contracts/http-fixture";
import { admitPrivatePath } from "../../scripts/ops/private-paths.mjs";
import { boundedSignIn } from "../../scripts/ops/bounded-signin.mjs";

const local = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(origin).hostname,
);
const productionReadback =
  process.env.RUN_FINANCE_PRODUCTION_READBACK === "1" &&
  origin === "https://ramin-life-os.vercel.app";
describe.skipIf(!httpEnabled || (!local && !productionReadback))(
  "Finance HTTPS/REST/real MCP transport",
  () => {
    let cookie = "";
    const issued: Awaited<ReturnType<typeof scopedToken>>[] = [];
    let reader: Awaited<ReturnType<typeof scopedToken>>;
    beforeAll(async () => {
      if (local) cookie = await ownerCookie();
      else {
        const path = await admitPrivatePath(
          process.env.TEST_CREDENTIALS_PATH!,
          { mustExist: true },
        );
        const credentials = JSON.parse(await readFile(path, "utf8"));
        expect(credentials.origin).toBe(origin);
        const login = await boundedSignIn(origin, credentials);
        expect(login.ok).toBe(true);
        cookie = login.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ");
      }
      reader = await scopedToken(cookie, ["finance:read"]);
      issued.push(reader);
    }, 120000);
    afterAll(async () => {
      for (const token of issued) {
        const response = await fetch(origin + "/api/v1/connections", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            client_id: token.clientId,
            explicit_confirmation: true,
          }),
        });
        expect(response.status).toBe(200);
        const denied = await fetch(
          origin + "/api/v1/query?operation=finance_summary",
          { headers: { Authorization: `Bearer ${token.accessToken}` } },
        );
        expect(denied.status).toBe(401);
      }
    }, 60000);
    async function connect(token: string) {
      const client = new Client({
        name: "synthetic-finance-transport-proof",
        version: "1",
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      return client;
    }
    it("denies anonymous finance reads and keeps the scoped MCP summary identical to owner REST", async () => {
      const anonymous = await fetch(
        origin + "/api/v1/query?operation=finance_summary",
      );
      expect(anonymous.status).toBe(401);
      const rest = await fetch(
        origin + "/api/v1/query?operation=finance_summary",
        { headers: { Cookie: cookie } },
      );
      expect(rest.status).toBe(200);
      const summary = (await rest.json()).data;
      const client = await connect(reader.accessToken);
      try {
        const result = await client.callTool({
          name: "finance_summary",
          arguments: { month: summary.month },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toEqual({ data: summary });
        const denied = await client.callTool({
          name: "finance_account_create",
          arguments: {
            input: { title: "Must never be created" },
            expected_revision: 0,
            operation_id: randomUUID(),
          },
        });
        expect(denied.isError).toBe(true);
        expect(denied.structuredContent).toMatchObject({
          error: { code: "INSUFFICIENT_PERMISSIONS" },
        });
        expect(JSON.stringify(denied._meta)).toContain("finance:write");
      } finally {
        await client.close();
      }
    }, 60000);
    it.skipIf(!local)(
      "writes once over MCP and reads and archives that same synthetic record over REST",
      async () => {
        const writer = await scopedToken(cookie, [
          "finance:read",
          "finance:write",
        ]);
        issued.push(writer);
        const client = await connect(writer.accessToken);
        const title = `SYNTHETIC FINANCE MCP ${randomUUID()}`;
        let accountId: string | undefined;
        let revision = 1;
        try {
          const args = {
            input: { title },
            operation_id: randomUUID(),
            expected_revision: 0,
          };
          const first = await client.callTool({
            name: "finance_account_create",
            arguments: args,
          });
          expect(first.isError).not.toBe(true);
          const record = (
            first.structuredContent as {
              data: { entity_id: string; version: number };
            }
          ).data;
          accountId = record.entity_id;
          revision = record.version;
          const second = await client.callTool({
            name: "finance_account_create",
            arguments: args,
          });
          expect(second.structuredContent).toMatchObject({
            data: { entity_id: accountId, replayed: true },
          });
          const response = await fetch(
            origin +
              "/api/v1/query?operation=finance_account_list&input=" +
              encodeURIComponent(JSON.stringify({ search: title })),
            { headers: { Cookie: cookie } },
          );
          const data = (await response.json()).data;
          expect(data.total).toBe(1);
          expect(data.items[0]).toMatchObject({
            account_id: accountId,
            title,
            opening_balance_cents: null,
          });
        } finally {
          if (accountId) {
            const cleanup = await fetch(origin + "/api/v1/commands", {
              method: "POST",
              headers: {
                Cookie: cookie,
                Origin: origin,
                "Content-Type": "application/json",
                "Idempotency-Key": randomUUID(),
                "If-Match": String(revision),
              },
              body: JSON.stringify({
                command: "finance_account_archive",
                input: { account_id: accountId },
              }),
            });
            expect(cleanup.status).toBe(200);
          }
          await client.close();
        }
      },
      120000,
    );
  },
);
