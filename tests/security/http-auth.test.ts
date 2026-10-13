import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  httpEnabled,
  origin,
  ownerCookie,
  readonlyToken,
} from "../contracts/http-fixture";
let cookie = "",
  token = "",
  registration: Awaited<ReturnType<typeof readonlyToken>>;
describe.skipIf(!httpEnabled)(
  "Independent HTTP auth and policy adversarial checks",
  () => {
    beforeAll(async () => {
      cookie = await ownerCookie();
      registration = await readonlyToken(cookie);
      token = registration.accessToken;
    }, 60000);
    it("real read-only OAuth token can read but cannot mutate REST or MCP", async () => {
      const headers = { Authorization: "Bearer " + token };
      const read = await fetch(origin + "/api/v1/query?operation=task_search", {
        headers,
      });
      expect(read.status).toBe(200);
      const rejected = await fetch(origin + "/api/v1/commands", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          command: "task_create",
          input: { title: "Synthetic unauthorized write must never persist" },
        }),
      });
      expect(rejected.status).toBe(403);
      const client = new Client({
        name: "independent-scope-QA",
        version: "1.0.0",
      });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
          requestInit: { headers },
        }),
      );
      try {
        const response = await client.callTool({
          name: "task_create",
          arguments: {
            input: { title: "Synthetic MCP forbidden write" },
            operation_id: randomUUID(),
          },
        });
        expect(response.isError).toBe(true);
      } finally {
        await client.close();
      }
    }, 30000);
    it("forged, algorithm-confused and unsigned JWTs are rejected", async () => {
      const payload = {
        iss: origin + "/api/auth",
        aud: origin + "/api/mcp",
        sub: "synthetic-unowned-identity",
        scope: "admin:manage",
      };
      const forged = await new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256", kid: "synthetic-forged-key" })
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode("synthetic-untrusted-signing-secret"));
      const unsigned =
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url") +
        "." +
        Buffer.from(JSON.stringify(payload)).toString("base64url") +
        ".";
      for (const candidate of [forged, unsigned, "not-a-token"]) {
        const response = await fetch(
          origin + "/api/v1/query?operation=task_search",
          { headers: { Authorization: "Bearer " + candidate } },
        );
        expect(response.status).toBe(401);
      }
    });
    it("wrong or missing owner file ID cannot bypass authenticated ownership filter", async () => {
      const response = await fetch(
        origin + "/api/v1/files/F-synthetic-other-owner/download",
        { headers: { Cookie: cookie }, redirect: "manual" },
      );
      expect(response.status).toBe(404);
      const publicFile = await fetch(
        origin + "/api/v1/files/F-synthetic-other-owner/download",
        { redirect: "manual" },
      );
      expect(publicFile.status).toBe(401);
    });
    it("authorization rejects a redirect URI absent from registered client", async () => {
      const params = new URLSearchParams({
        response_type: "code",
        client_id: registration.clientId,
        redirect_uri: "http://127.0.0.1:39876/unregistered",
        scope: "tasks:read",
        code_challenge: "synthetic-challenge",
        code_challenge_method: "S256",
        resource: origin + "/api/mcp",
      });
      const response = await fetch(
        origin + "/api/auth/oauth2/authorize?" + params,
        { headers: { Cookie: cookie }, redirect: "manual" },
      );
      expect(response.status).toBeLessThan(500);
      let target = response.headers.get("location");
      if (
        !target &&
        response.headers.get("content-type")?.includes("application/json")
      ) {
        const value = await response.json();
        target = value.url || value.redirect_uri;
      }
      if (target?.includes("/consent")) {
        const consent = await fetch(origin + "/api/auth/oauth2/consent", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: cookie,
            Origin: origin,
          },
          body: JSON.stringify({
            accept: true,
            oauth_query: new URL(target, origin).searchParams.toString(),
          }),
        });
        const value = await consent.json();
        target = value.url || value.redirect_uri;
      }
      const redirected = target ? new URL(target, origin) : null;
      expect(redirected?.searchParams.has("code") ?? false).toBe(false);
      expect(
        !(
          redirected?.pathname === "/unregistered" &&
          !redirected.searchParams.has("error")
        ),
      ).toBe(true);
    });
    it("dynamic registration denies script and fragmented redirect URIs", async () => {
      for (const uri of [
        "javascript:alert(1)",
        "https://example.invalid/callback#fragment",
      ]) {
        const response = await fetch(origin + "/api/auth/oauth2/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_name: "Synthetic invalid redirect QA",
            application_type: "web",
            redirect_uris: [uri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code"],
            response_types: ["code"],
            scope: "tasks:read",
          }),
        });
        expect(response.status).toBeLessThan(500);
        expect(response.ok).toBe(false);
      }
    });
    it("unknown-user signup is disabled without creating accounts", async () => {
      const response = await fetch(origin + "/api/auth/sign-up/email", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          email: "synthetic-unauthorized@example.invalid",
          name: "Synthetic denied identity",
          password: "synthetic-password-long-enough",
        }),
      });
      expect(response.status).toBeLessThan(500);
      expect(response.ok).toBe(false);
    });
    it("AI lacks a real provider and cannot return a fabricated successful plan", async () => {
      const response = await fetch(origin + "/api/v1/ai/plan", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "همه کارهای ساختگی را نشان بده" }),
      });
      expect(response.status).toBe(503);
      const data = await response.json();
      expect(data.data).toBeUndefined();
      expect(data.error?.code).toBe("UNSUPPORTED_OPERATION");
    });
    it("POST queries authenticate before parsing and enforce browser Origin while preserving read-only bearer scope", async () => {
      const endpoint = origin + "/api/v1/query";
      const body = JSON.stringify({ operation: "whoami", input: {} });
      const valid = await fetch(endpoint, {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body,
      });
      expect(valid.status).toBe(200);
      for (const candidate of [
        undefined,
        "https://synthetic-cross-site.example.invalid",
      ]) {
        const rejected = await fetch(endpoint, {
          method: "POST",
          headers: {
            Cookie: cookie,
            "Content-Type": "application/json",
            ...(candidate ? { Origin: candidate } : {}),
          },
          body: "{ malformed",
        });
        expect(rejected.status).toBe(403);
      }
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: { Origin: origin, "Content-Type": "application/json" },
            body: "{ malformed",
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(endpoint, {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/json",
            },
            body,
          })
        ).status,
      ).toBe(200);
      const denied = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation: "time_entry_import_preview",
          input: {
            data: {
              format: "ramin-life-os-time/1",
              timezone: "Europe/Berlin",
              entries: [
                {
                  entry_id: "synthetic-readonly-import-" + randomUUID(),
                  employer: "Jena",
                  starts_at: "2027-01-01T09:00:00Z",
                  ends_at: "2027-01-01T10:00:00Z",
                },
              ],
            },
          },
        }),
      });
      expect(denied.status).toBe(403);
    });
    it("POST queries reject malformed JSON, wrong operation/input shape and extra authority fields without echoing content", async () => {
      const marker = "SYNTHETIC_UNTRUSTED_AUTHORITY_CONTENT";
      for (const body of [
        "{ invalid",
        JSON.stringify({ operation: "task_create", input: { title: marker } }),
        JSON.stringify({ operation: "whoami", input: [] }),
        JSON.stringify({
          operation: "whoami",
          input: {},
          explicit_user_intent: marker,
        }),
      ]) {
        const response = await fetch(origin + "/api/v1/query", {
          method: "POST",
          headers: {
            Cookie: cookie,
            Origin: origin,
            "Content-Type": "application/json",
          },
          body,
        });
        expect(response.status).toBe(400);
        const output = await response.text();
        expect(JSON.parse(output).error.code).toBe("INVALID_INPUT");
        expect(output).not.toContain(marker);
      }
    });
    it("POST query body streaming enforces the byte bound for Unicode content", async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify({
          operation: "whoami",
          input: { text: "ف".repeat(1024 * 1024 + 1) },
        }),
      );
      expect(bytes.byteLength).toBeGreaterThan(2 * 1024 * 1024);
      let position = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (position >= bytes.length) return controller.close();
          const end = Math.min(position + 65536, bytes.length);
          controller.enqueue(bytes.subarray(position, end));
          position = end;
        },
      });
      const request: RequestInit & { duplex: "half" } = {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body,
        duplex: "half",
      };
      const response = await fetch(origin + "/api/v1/query", request);
      expect(response.status).toBe(413);
      expect((await response.json()).error.code).toBe("INVALID_INPUT");
    });
  },
);
