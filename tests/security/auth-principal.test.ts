import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  verify: vi.fn(),
  sql: vi.fn(),
  headers: vi.fn(),
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ verifyAccessTokenRequest: mocks.verify }),
}));
vi.mock("../../server/auth/config", () => ({
  appOrigin: () => "http://localhost:3000",
  getAuth: () => ({ api: { getSession: mocks.session } }),
  OWNER_SCOPES: ["tasks:read", "tasks:write", "admin:manage"],
}));
vi.mock("../../server/auth/db", () => ({
  getAuthPool: () => ({ query: mocks.sql }),
}));
import { getOwnerSession, requirePrincipal } from "../../server/auth/principal";
const owner = {
  user: { id: "synthetic-auth-user", email: "synthetic-owner@example.invalid" },
};
beforeEach(() => {
  vi.stubEnv("OWNER_ID", "synthetic-canonical-owner");
  vi.stubEnv("OWNER_EMAIL", owner.user.email);
  mocks.session.mockReset().mockResolvedValue(owner);
  mocks.verify.mockReset().mockResolvedValue({
    sub: owner.user.id,
    sid: "synthetic-active-session",
    client_id: "synthetic-registered-client",
    scope: "tasks:read",
  });
  mocks.sql.mockReset().mockImplementation(async (sql: string) =>
    sql.includes('FROM "user"')
      ? {
          rows: [{ id: owner.user.id, email: owner.user.email }],
          rowCount: 1,
        }
      : sql.includes('FROM "oauthClient"')
        ? { rows: [{ disabled: false }], rowCount: 1 }
        : { rows: [{ id: "synthetic-active-session" }], rowCount: 1 },
  );
  mocks.headers.mockReset().mockResolvedValue(new Headers());
});
afterEach(() => vi.unstubAllEnvs());
describe("owner-bound authentication business policy", () => {
  it("a valid other-user cookie cannot receive the configured canonical owner identity", async () => {
    mocks.session.mockResolvedValue({
      user: {
        id: "synthetic-other-user",
        email: "synthetic-other@example.invalid",
      },
    });
    await expect(
      requirePrincipal(new Request("http://localhost:3000/api/v1/query")),
    ).rejects.toMatchObject({ status: 401 });
    expect(await getOwnerSession()).toBeNull();
  });
  it("cookie mutation requires the exact configured origin and cannot downgrade from an invalid bearer token", async () => {
    for (const origin of [
      null,
      "https://evil.invalid",
      "http://localhost:3001",
    ]) {
      await expect(
        requirePrincipal(
          new Request("http://localhost:3000/api/v1/commands", {
            method: "POST",
            headers: origin ? { Origin: origin } : {},
          }),
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
    expect(
      await requirePrincipal(
        new Request("http://localhost:3000/api/v1/commands", {
          method: "POST",
          headers: { Origin: "http://localhost:3000" },
        }),
      ),
    ).toMatchObject({
      ownerId: "synthetic-canonical-owner",
      channel: "UI",
      scopes: ["tasks:read", "tasks:write", "admin:manage"],
    });
    mocks.session.mockClear();
    mocks.verify.mockRejectedValueOnce(
      new Error("Synthetic invalid signature"),
    );
    await expect(
      requirePrincipal(
        new Request("http://localhost:3000/api/v1/query", {
          headers: {
            Authorization: "Bearer synthetic-invalid",
            Cookie: "synthetic-owner-cookie",
          },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("verified JWT identity still requires the real owner row and active unrevoked session", async () => {
    const request = new Request("http://localhost:3000/api/v1/query", {
      headers: { Authorization: "Bearer synthetic-verified-input" },
    });
    mocks.sql.mockResolvedValueOnce({
      rows: [{ email: "synthetic-other@example.invalid" }],
      rowCount: 1,
    });
    await expect(requirePrincipal(request)).rejects.toMatchObject({
      status: 403,
    });
    mocks.sql
      .mockResolvedValueOnce({
        rows: [{ email: owner.user.email }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(requirePrincipal(request)).rejects.toMatchObject({
      status: 401,
    });
  });
  it("token channels and scopes never inherit the cookie owner admin grants", async () => {
    const request = new Request("http://localhost:3000/api/v1/query", {
      headers: { Authorization: "Bearer synthetic-verified-input" },
    });
    expect(await requirePrincipal(request)).toMatchObject({
      channel: "MCP",
      scopes: ["tasks:read"],
    });
    expect(mocks.verify).toHaveBeenCalledWith(request, {
      verifyOptions: {
        issuer: "http://localhost:3000/api/auth",
        audience: "http://localhost:3000/api/mcp",
      },
      jwksUrl: "http://localhost:3000/api/auth/jwks",
    });
    mocks.verify.mockResolvedValue({
      sub: owner.user.id,
      client_id: "synthetic-registered-client",
    });
    expect((await requirePrincipal(request)).scopes).toEqual([]);
  });
  it("a verified token without client binding is rejected rather than inheriting an owner's connection", async () => {
    mocks.verify.mockResolvedValue({ sub: owner.user.id, scope: "tasks:read" });
    await expect(
      requirePrincipal(
        new Request("http://localhost:3000/api/v1/query", {
          headers: { Authorization: "Bearer synthetic-verified-input" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      mocks.sql.mock.calls.some(([sql]) => sql.includes('FROM "oauthClient"')),
    ).toBe(false);
  });
  it("a revoked or missing registered client is denied immediately even while its JWT and session are valid", async () => {
    const request = new Request("http://localhost:3000/api/v1/query", {
      headers: { Authorization: "Bearer synthetic-verified-input" },
    });
    for (const registered of [
      { rows: [], rowCount: 0 },
      { rows: [{ disabled: true }], rowCount: 1 },
    ]) {
      mocks.sql.mockImplementation(async (sql: string) =>
        sql.includes('FROM "oauthClient"')
          ? registered
          : sql.includes('FROM "user"')
            ? {
                rows: [{ id: owner.user.id, email: owner.user.email }],
                rowCount: 1,
              }
            : { rows: [{ id: "synthetic-active-session" }], rowCount: 1 },
      );
      await expect(requirePrincipal(request)).rejects.toMatchObject({
        status: 401,
      });
    }
    expect(
      mocks.sql.mock.calls
        .filter(([sql]) => sql.includes('FROM "oauthClient"'))
        .every(
          ([, parameters]) => parameters[0] === "synthetic-registered-client",
        ),
    ).toBe(true);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it("DPoP is rejected while replay storage is unavailable and unconfigured owner fails closed", async () => {
    await expect(
      requirePrincipal(
        new Request("http://localhost:3000/api/v1/query", {
          headers: { Authorization: "DPoP synthetic-proof" },
        }),
      ),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.verify).not.toHaveBeenCalled();
    vi.stubEnv("OWNER_ID", "");
    await expect(
      requirePrincipal(new Request("http://localhost:3000/api/v1/query")),
    ).rejects.toMatchObject({ status: 503 });
  });
});
