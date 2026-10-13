import { readFile } from "node:fs/promises";
import { randomBytes, createHash, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const [credentialsPath, origin = "http://localhost:3000"] =
  process.argv.slice(2);
const credentials = JSON.parse(await readFile(credentialsPath, "utf8"));
const check = (value, message) => {
  if (!value) throw new Error(message);
};
const unauth = await fetch(`${origin}/api/mcp`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: 1 }),
});
check(
  unauth.status === 401 && unauth.headers.has("www-authenticate"),
  "Unauthenticated MCP discovery challenge failed",
);
const publicData = await fetch(`${origin}/api/v1/query?operation=task_search`);
check(publicData.status === 401, "Unauthenticated task data leaked");
const login = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin },
  body: JSON.stringify({
    email: credentials.email,
    password: credentials.password,
  }),
});
check(login.ok, `Owner sign-in failed (${login.status})`);
const cookie = login.headers
  .getSetCookie()
  .map((line) => line.split(";")[0])
  .join("; ");
const read = await fetch(`${origin}/api/v1/query?operation=task_search`, {
  headers: { Cookie: cookie },
});
check(read.ok, `Authenticated API failed (${read.status})`);
const forgedOrigin = await fetch(`${origin}/api/v1/commands`, {
  method: "POST",
  headers: {
    Cookie: cookie,
    Origin: "https://evil.invalid",
    "Content-Type": "application/json",
    "Idempotency-Key": randomUUID(),
  },
  body: JSON.stringify({
    command: "task_create",
    input: { title: "Should never exist" },
  }),
});
check(forgedOrigin.status === 403, "Cross-origin mutation was accepted");
const callback = "http://127.0.0.1:39871/callback";
const registration = await fetch(`${origin}/api/auth/oauth2/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    client_name: "Synthetic integration smoke",
    application_type: "native",
    redirect_uris: [callback],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "tasks:read tasks:write",
    resources: [`${origin}/api/mcp`],
  }),
});
const clientInfo = await registration.json();
check(
  registration.ok && clientInfo.client_id,
  `OAuth registration failed (${registration.status}): ${clientInfo.error ?? clientInfo.code ?? ""} ${clientInfo.error_description ?? clientInfo.message ?? ""}`,
);
const verifier = randomBytes(32).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomUUID();
const params = new URLSearchParams({
  response_type: "code",
  client_id: clientInfo.client_id,
  redirect_uri: callback,
  scope: "tasks:read tasks:write",
  resource: `${origin}/api/mcp`,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state,
});
let authz = await fetch(`${origin}/api/auth/oauth2/authorize?${params}`, {
  headers: { Cookie: cookie },
  redirect: "manual",
});
let target = authz.headers.get("location");
if (
  !target &&
  authz.headers.get("content-type")?.includes("application/json")
) {
  const json = await authz.json();
  target = json.url || json.redirect_uri;
}
if (target?.includes("/consent")) {
  const consentUrl = new URL(target, origin);
  const oauthQuery = consentUrl.searchParams.toString();
  const consent = await fetch(`${origin}/api/auth/oauth2/consent`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
      Origin: origin,
    },
    body: JSON.stringify({ accept: true, oauth_query: oauthQuery }),
  });
  const consentResult = await consent.json();
  check(consent.ok, `OAuth consent failed (${consent.status})`);
  target = consentResult.redirect_uri || consentResult.url;
}
check(target, `OAuth authorization redirect missing (${authz.status})`);
const redirected = new URL(target, origin);
check(redirected.searchParams.get("state") === state, "OAuth state mismatch");
const code = redirected.searchParams.get("code");
check(code, "OAuth authorization code missing");
const tokenResponse = await fetch(`${origin}/api/auth/oauth2/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientInfo.client_id,
    code,
    redirect_uri: callback,
    code_verifier: verifier,
    resource: `${origin}/api/mcp`,
  }),
});
const tokens = await tokenResponse.json();
check(
  tokenResponse.ok && tokens.access_token,
  `OAuth PKCE exchange failed (${tokenResponse.status})`,
);
const client = new Client({ name: "ramin-life-os-smoke", version: "0.1.0" });
await client.connect(
  new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
    requestInit: {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    },
  }),
);
const toolList = await client.listTools();
check(
  toolList.tools.some((tool) => tool.name === "task_create") &&
    toolList.tools.some((tool) => tool.name === "task_dependency_add_commit"),
  "MCP tools missing",
);
const operation = randomUUID();
const title = `Synthetic MCP smoke ${randomUUID()}`;
const created = await client.callTool({
  name: "task_create",
  arguments: { input: { title }, operation_id: operation },
});
check(!created.isError, "MCP task creation failed");
const mutation =
  created.structuredContent?.data ?? JSON.parse(created.content[0].text);
const replay = await client.callTool({
  name: "task_create",
  arguments: { input: { title }, operation_id: operation },
});
const repeated =
  replay.structuredContent?.data ?? JSON.parse(replay.content[0].text);
check(
  repeated.entity_id === mutation.entity_id && repeated.replayed,
  "MCP retry duplicated the task",
);
const taskRead = await fetch(
  `${origin}/api/v1/query?operation=task_get&input=${encodeURIComponent(JSON.stringify({ task_id: mutation.entity_id }))}`,
  { headers: { Cookie: cookie } },
);
const readback = await taskRead.json();
check(
  taskRead.ok && readback.data.title === title,
  "MCP write was not visible through browser API",
);
const archived = await client.callTool({
  name: "task_archive",
  arguments: {
    input: { task_id: mutation.entity_id },
    operation_id: randomUUID(),
    expected_revision: mutation.version,
  },
});
check(!archived.isError, "Synthetic smoke cleanup failed");
await client.close();
console.log(
  JSON.stringify({
    origin,
    unauthorized_mcp: "PASS",
    unauthorized_data: "PASS",
    login: "PASS",
    csrf: "PASS",
    oauth_pkce: "PASS",
    mcp_tools: toolList.tools.length,
    mcp_write_readback: "PASS",
    retry_exactly_once: "PASS",
    synthetic_cleanup: "archived",
    production_ledger_mutated: false,
  }),
);
