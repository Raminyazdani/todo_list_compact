import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { admitPrivatePath } from "../../scripts/ops/private-paths.mjs";
import { fileURLToPath } from "node:url";
export const httpEnabled = !!process.env.TEST_CREDENTIALS_PATH;
export const origin = process.env.HTTP_TEST_ORIGIN || "http://localhost:3000";
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
export async function ownerCookie(
  options: { productionGraphDemo?: boolean } = {},
) {
  const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname);
  check(
    local ||
      (options.productionGraphDemo === true &&
        process.env.RUN_PRODUCTION_GRAPH_DEMO === "1" &&
        origin === "https://ramin-life-os.vercel.app"),
    "HTTP security tests are restricted to the isolated local staging server.",
  );
  check(
    process.env.TEST_CREDENTIALS_PATH,
    "Private staging credentials are required.",
  );
  if (!local)
    await admitPrivatePath(process.env.TEST_CREDENTIALS_PATH, {
      mustExist: true,
      repositoryRoot: fileURLToPath(new URL("../../", import.meta.url)),
    });
  const credentials = JSON.parse(
    await readFile(process.env.TEST_CREDENTIALS_PATH, "utf8"),
  ) as { email: string; password: string };
  const response = await fetch(origin + "/api/auth/sign-in/email", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
    }),
  });
  check(
    response.ok,
    "Staging owner sign-in failed with status " + response.status,
  );
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  check(cookie, "Staging session cookie was not returned.");
  return cookie;
}
export async function scopedToken(
  cookie: string,
  scopes: string[],
  options: { nonce?: string } = {},
) {
  const oidcScopes = new Set(["openid", "profile", "email"]);
  check(
    scopes.length > 0 &&
      scopes.length <= 20 &&
      scopes.every(
        (scope) => oidcScopes.has(scope) || /^[a-z_]+:[a-z_]+$/.test(scope),
      ),
    "Bounded explicit OAuth scopes are required.",
  );
  const requestedScope = [...new Set(scopes)].join(" ");
  const callback = "http://127.0.0.1:39875/callback";
  const registration = await fetch(origin + "/api/auth/oauth2/register", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Synthetic independent security QA",
      application_type: "native",
      redirect_uris: [callback],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code"],
      response_types: ["code"],
      scope: requestedScope,
      resources: [origin + "/api/mcp"],
    }),
  });
  const info = await registration.json();
  check(
    registration.ok && info.client_id,
    "Read-only test client registration failed: " + registration.status,
  );
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url"),
    state = randomUUID();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: info.client_id,
    redirect_uri: callback,
    scope: requestedScope,
    resource: origin + "/api/mcp",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  });
  if (options.nonce) params.set("nonce", options.nonce);
  const authz = await fetch(origin + "/api/auth/oauth2/authorize?" + params, {
    headers: { Cookie: cookie },
    redirect: "manual",
  });
  let target = authz.headers.get("location");
  if (
    !target &&
    authz.headers.get("content-type")?.includes("application/json")
  ) {
    const value = await authz.json();
    target = value.url || value.redirect_uri;
  }
  if (target?.includes("/consent")) {
    const consent = await fetch(origin + "/api/auth/oauth2/consent", {
      method: "POST",
      redirect: "manual",
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
    const result = await consent.json();
    check(consent.ok, "Owner test consent failed: " + consent.status);
    target = result.url || result.redirect_uri;
  }
  check(target, "No OAuth redirect after read-only consent.");
  const url = new URL(target, origin);
  check(
    url.searchParams.get("state") === state,
    "Read-only authorization state mismatch.",
  );
  const code = url.searchParams.get("code");
  check(code, "No authorization code.");
  const exchange = await fetch(origin + "/api/auth/oauth2/token", {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: info.client_id,
      code,
      redirect_uri: callback,
      code_verifier: verifier,
      resource: origin + "/api/mcp",
    }),
  });
  const tokens = await exchange.json();
  check(
    exchange.ok && tokens.access_token,
    "Read-only PKCE token exchange failed: " + exchange.status,
  );
  const claims = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1], "base64url").toString(
      "utf8",
    ),
  ) as { exp: number; scope: string };
  check(
    typeof claims.exp === "number" &&
      scopes
        .filter((scope) => !oidcScopes.has(scope))
        .every((scope) => claims.scope.split(" ").includes(scope)),
    "Token is missing a requested scope.",
  );
  return {
    accessToken: tokens.access_token as string,
    expiresAt: claims.exp * 1000,
    clientId: info.client_id as string,
    callback,
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : undefined,
  };
}
export async function readonlyToken(cookie: string) {
  const result = await scopedToken(cookie, ["tasks:read", "files:read"]);
  const claims = JSON.parse(
    Buffer.from(result.accessToken.split(".")[1], "base64url").toString("utf8"),
  ) as { scope: string };
  check(
    !claims.scope.split(" ").includes("tasks:write"),
    "Read-only token unexpectedly has write scope.",
  );
  const privatePath = join(
    dirname(process.env.TEST_CREDENTIALS_PATH!),
    "qa-expiring-token-private.json",
  );
  await writeFile(
    privatePath,
    JSON.stringify({
      access_token: result.accessToken,
      expires_at: result.expiresAt,
      origin,
      client_id: result.clientId,
    }),
    { mode: 0o600 },
  );
  return result;
}
