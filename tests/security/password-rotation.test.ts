import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { memoryAdapter } from "better-auth/adapters/memory";

const mocks = vi.hoisted(() => ({ database: vi.fn() }));
vi.mock("../../server/auth/db", () => ({
  getAuthPool: () => mocks.database(),
}));
import { createAuth } from "../../server/auth/config";

// Real installed BetterAuth endpoints/hash/session logic; only persistence is
// replaced with its isolated test adapter. No production credentials or HTTP.
describe("owner password rotation through the configured BetterAuth endpoints", () => {
  const origin = "https://synthetic-owner.example.invalid";
  const email = "synthetic-owner@example.invalid";
  let auth: ReturnType<typeof createAuth>;
  let tables: Record<string, Record<string, unknown>[]>;
  let userId: string, currentPassword: string, firstCookie: string;

  function responseCookie(response: Response) {
    return response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0])
      .join("; ");
  }
  async function post(
    path: string,
    body: Record<string, unknown>,
    cookie?: string,
  ) {
    return auth.handler(
      new Request(origin + "/api/auth" + path, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }
  async function session(cookie: string) {
    const response = await auth.handler(
      new Request(origin + "/api/auth/get-session", {
        headers: { Cookie: cookie },
      }),
    );
    expect(response.status).toBe(200);
    return response.json();
  }
  function credentialHash() {
    return tables.account.find(
      (row) => row.userId === userId && row.providerId === "credential",
    )?.password;
  }

  beforeEach(async () => {
    vi.stubEnv("OWNER_EMAIL", email);
    vi.stubEnv("OWNER_ID", "synthetic-business-owner");
    vi.stubEnv("BETTER_AUTH_URL", origin);
    vi.stubEnv("BETTER_AUTH_SECRET", "SYNTHETIC_TEST_" + "x".repeat(48));
    vi.stubEnv("GITHUB_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("PASSWORD_ROTATION_FIXTURE_MUST_NOT_USE_NETWORK");
      }),
    );
    tables = Object.fromEntries(
      [
        "user",
        "account",
        "session",
        "verification",
        "rateLimit",
        "jwks",
        "passkey",
        "oauthClient",
        "oauthResource",
        "oauthAccessToken",
        "oauthRefreshToken",
        "oauthConsent",
      ].map((model) => [model, []]),
    );
    mocks.database.mockReset().mockReturnValue(memoryAdapter(tables));
    currentPassword = "Synthetic-current-" + randomUUID();
    // Enrollment is confined to this empty synthetic adapter. Rotation then
    // uses the ordinary configuration with public signup disabled.
    auth = createAuth(true);
    const enrolled = await post("/sign-up/email", {
      email,
      password: currentPassword,
      name: "Synthetic owner",
    });
    expect(enrolled.status).toBe(200);
    userId = (await enrolled.json()).user.id;
    auth = createAuth(false);
    const signedIn = await post("/sign-in/email", {
      email,
      password: currentPassword,
    });
    expect(signedIn.status).toBe(200);
    expect((await signedIn.json()).user.id).toBe(userId);
    firstCookie = responseCookie(signedIn);
    expect(firstCookie).toBeTruthy();
  });
  afterEach(() => {
    expect(fetch).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("rejects seven characters without changing the credential or revoking existing sessions", async () => {
    const beforeHash = credentialHash();
    const beforeSessions = structuredClone(tables.session);
    const rejected = await post(
      "/change-password",
      {
        currentPassword,
        newPassword: "Test" + "7".repeat(3),
        revokeOtherSessions: true,
      },
      firstCookie,
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("PASSWORD_TOO_SHORT");
    expect(credentialHash()).toBe(beforeHash);
    expect(tables.session).toEqual(beforeSessions);
    expect((await session(firstCookie)).user.id).toBe(userId);
    expect(
      (await post("/sign-in/email", { email, password: currentPassword }))
        .status,
    ).toBe(200);
  });

  it("rejects an incorrect current password and preserves credentials and sessions", async () => {
    const beforeHash = credentialHash();
    const beforeSessions = structuredClone(tables.session);
    const newPassword = "Test" + "8".repeat(4);
    const rejected = await post(
      "/change-password",
      {
        currentPassword: "Synthetic-wrong-" + randomUUID(),
        newPassword,
        revokeOtherSessions: true,
      },
      firstCookie,
    );
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).code).toBe("INVALID_PASSWORD");
    expect(credentialHash()).toBe(beforeHash);
    expect(tables.session).toEqual(beforeSessions);
    expect((await session(firstCookie)).user.id).toBe(userId);
    expect(
      (await post("/sign-in/email", { email, password: newPassword })).status,
    ).toBe(401);
    expect(
      (await post("/sign-in/email", { email, password: currentPassword }))
        .status,
    ).toBe(200);
  });

  it("accepts exactly eight characters for the same owner, denies the old password and invalidates every prior session", async () => {
    const otherSignIn = await post("/sign-in/email", {
      email,
      password: currentPassword,
    });
    expect(otherSignIn.status).toBe(200);
    const otherCookie = responseCookie(otherSignIn);
    expect((await session(otherCookie)).user.id).toBe(userId);
    const oldTokens = tables.session.map((row) => row.token);
    expect(oldTokens).toHaveLength(2);
    const beforeHash = credentialHash();
    const newPassword = "Test" + "8".repeat(4);
    const changed = await post(
      "/change-password",
      { currentPassword, newPassword, revokeOtherSessions: true },
      firstCookie,
    );
    expect(changed.status).toBe(200);
    expect((await changed.json()).user).toMatchObject({ id: userId, email });
    expect(tables.user).toHaveLength(1);
    expect(credentialHash()).not.toBe(beforeHash);
    expect(tables.session).toHaveLength(1);
    expect(oldTokens).not.toContain(tables.session[0].token);
    expect(await session(firstCookie)).toBeNull();
    expect(await session(otherCookie)).toBeNull();
    expect((await session(responseCookie(changed))).user.id).toBe(userId);
    const oldSignIn = await post("/sign-in/email", {
      email,
      password: currentPassword,
    });
    expect(oldSignIn.status).toBe(401);
    expect((await oldSignIn.json()).code).toBe("INVALID_EMAIL_OR_PASSWORD");
    // The unchanged installed sign-in limit is 3 attempts per 10 seconds.
    // Advance only this synthetic fixture's clock before its fourth attempt.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11000);
    const freshSignIn = await post("/sign-in/email", {
      email,
      password: newPassword,
    });
    expect(freshSignIn.status).toBe(200);
    expect((await freshSignIn.json()).user).toMatchObject({
      id: userId,
      email,
    });
    expect((await session(responseCookie(freshSignIn))).user.id).toBe(userId);
  });

  it("keeps public signup disabled after the password policy change", async () => {
    const beforeUsers = structuredClone(tables.user);
    const denied = await post("/sign-up/email", {
      email: "synthetic-other@example.invalid",
      password: "Test" + "8".repeat(4),
      name: "Synthetic denied identity",
    });
    expect(denied.ok).toBe(false);
    expect(denied.status).toBeLessThan(500);
    expect(tables.user).toEqual(beforeUsers);
  });
});
