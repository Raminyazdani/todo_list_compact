import { randomBytes, randomUUID, createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { boundedSignIn } from "./bounded-signin.mjs";
import { boundedRegistration } from "../../tests/contracts/bounded-registration.ts";
import {
  admitPrivatePath,
  withPrivateFile,
  replacePinnedContents,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

const requiredTools = [
  "calendar_list",
  "calendar_events_query",
  "calendar_sync_status",
  "calendar_operation_status",
  "calendar_source_configure",
  "calendar_source_disconnect",
  "calendar_sync_request",
  "calendar_event_change_preview",
  "calendar_event_change_commit",
  "time_draft_list",
  "time_draft_save",
  "time_draft_archive",
  "time_entry_export",
  "time_entry_create",
  "time_entry_update",
  "time_entry_archive",
  "time_entry_undo",
];
function check(value, code) {
  if (!value) throw new Error(code);
}
function object(value) {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "CALENDAR_RUNTIME_INVALID_RESPONSE",
  );
  return value;
}
function unpack(result) {
  if (result.structuredContent) return result.structuredContent;
  const block = result.content?.find((item) => item.type === "text");
  return block?.text ? JSON.parse(block.text) : {};
}
function commandResult(result) {
  const body = unpack(result);
  check(!result.isError && !body.error, "CALENDAR_RUNTIME_MCP_COMMAND_FAILED");
  return object(body.data ?? body);
}
async function readPrivate(path) {
  return withPrivateFile(path, async (file) =>
    JSON.parse(await file.readFile("utf8")),
  );
}

/** Preserve the journaled DCR identity; only explicit 429 rejections can retry. */
export async function registerCalendarRuntimeGrant(
  origin,
  grant,
  metadata,
  save,
  dependencies = {},
) {
  check(
    !grant.client_id && grant.registration_state !== "attempted",
    "CALENDAR_RUNTIME_DCR_OUTCOME_UNKNOWN_RETAIN_JOURNAL",
  );
  if (grant.registration_metadata)
    check(
      JSON.stringify(grant.registration_metadata) === JSON.stringify(metadata),
      "CALENDAR_RUNTIME_DCR_RETAINED_METADATA_MISMATCH",
    );
  else grant.registration_metadata = metadata;
  grant.registration_state = "attempted";
  await save();
  let response;
  try {
    response = await boundedRegistration(
      origin,
      grant.registration_metadata,
      dependencies,
    );
  } catch {
    // Acceptance may precede transport failure. Retain attempted, never retry.
    throw new Error("CALENDAR_RUNTIME_DCR_OUTCOME_UNKNOWN_RETAIN_JOURNAL");
  }
  if (!response.ok) {
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 408
    ) {
      grant.registration_state = "rejected";
      await save();
      throw new Error("CALENDAR_RUNTIME_DCR_REJECTED_" + response.status);
    }
    throw new Error("CALENDAR_RUNTIME_DCR_OUTCOME_UNKNOWN_RETAIN_JOURNAL");
  }
  const registration = await response.json();
  check(registration.client_id, "CALENDAR_RUNTIME_DCR_ACK_INVALID");
  grant.client_id = registration.client_id;
  grant.registration_state = "confirmed";
  await save();
}

/** Actual SDK/HTTP proof. It never calls a source or Google mutation command. */
export async function verifyCalendarRuntime(args) {
  const [flag, origin, credentialsPath, journalPath, ...extra] = args;
  check(
    flag === "--verify-calendar-runtime" &&
      ["http://localhost:3000", "https://ramin-life-os.vercel.app"].includes(
        origin,
      ) &&
      journalPath &&
      !extra.length,
    "CALENDAR_RUNTIME_EXPLICIT_ARGUMENTS_REQUIRED",
  );
  await admitPrivatePath(journalPath);
  const credentials = await readPrivate(credentialsPath);
  check(
    credentials.email &&
      credentials.password &&
      credentials.user_id &&
      (!credentials.origin || credentials.origin === origin),
    "CALENDAR_RUNTIME_PRIVATE_IDENTITY_REQUIRED",
  );
  const login = await boundedSignIn(origin, credentials);
  check(login.ok, "CALENDAR_RUNTIME_SIGNIN_FAILED");
  const cookie = login.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  check(cookie, "CALENDAR_RUNTIME_SESSION_REQUIRED");
  const http = async (path, init = {}) =>
    fetch(origin + path, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      ...init,
    });
  const query = async (operation, input = {}, token) => {
    const response = await http(
      "/api/v1/query?" +
        new URLSearchParams({ operation, input: JSON.stringify(input) }),
      {
        headers: token
          ? { Authorization: "Bearer " + token }
          : { Cookie: cookie },
      },
    );
    const body = await response.json();
    check(response.ok, "CALENDAR_RUNTIME_REST_READ_FAILED");
    return object(body.data);
  };
  const identity = await query("whoami");
  check(
    identity.actor_id === credentials.user_id &&
      identity.owner_id &&
      (!credentials.owner_id || credentials.owner_id === identity.owner_id),
    "CALENDAR_RUNTIME_OWNER_MISMATCH",
  );
  let journal;
  try {
    journal = await readPrivate(journalPath);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    journal = {
      format: "ramin-calendar-runtime-proof/1",
      origin,
      actor_id: identity.actor_id,
      owner_id: identity.owner_id,
      run_id: randomUUID(),
      status: "pending",
      grants: [],
      operations: {},
      evidence: {},
    };
    await writeExclusivePrivateJson(journalPath, journal);
  }
  check(
    journal.format === "ramin-calendar-runtime-proof/1" &&
      journal.origin === origin &&
      journal.actor_id === identity.actor_id &&
      journal.owner_id === identity.owner_id,
    "CALENDAR_RUNTIME_JOURNAL_IDENTITY_MISMATCH",
  );
  const save = () =>
    withPrivateFile(journalPath, (file) =>
      replacePinnedContents(file, JSON.stringify(journal, null, 2) + "\n"),
    );
  if (
    journal.status === "passed" &&
    journal.grants.every((grant) => grant.revoked)
  )
    return journal.receipt;
  const marker = "Synthetic calendar runtime QA " + journal.run_id;
  const clients = [];
  let writable;
  const authorize = async (grant) => {
    const callback = "http://127.0.0.1:39876/callback";
    if (!grant.client_id) {
      await registerCalendarRuntimeGrant(
        origin,
        grant,
        {
          client_name:
            "Synthetic calendar runtime QA " +
            journal.run_id +
            " " +
            grant.role,
          application_type: "native",
          redirect_uris: [callback],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code"],
          response_types: ["code"],
          scope: grant.scopes.join(" "),
          resources: [origin + "/api/mcp"],
        },
        save,
      );
    }
    if (grant.access_token && grant.expires_at > Date.now() + 60000)
      return grant.access_token;
    const verifier = randomBytes(32).toString("base64url"),
      state = randomUUID();
    grant.authorization = { verifier, state, status: "attempted" };
    await save();
    const parameters = new URLSearchParams({
      response_type: "code",
      client_id: grant.client_id,
      redirect_uri: callback,
      scope: grant.scopes.join(" "),
      resource: origin + "/api/mcp",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      state,
    });
    const response = await http("/api/auth/oauth2/authorize?" + parameters, {
      headers: { Cookie: cookie },
      redirect: "manual",
    });
    let target = response.headers.get("location");
    if (
      !target &&
      response.headers.get("content-type")?.includes("application/json")
    ) {
      const data = await response.json();
      target = data.url ?? data.redirect_uri;
    }
    if (target && new URL(target, origin).pathname === "/consent") {
      const consent = await http("/api/auth/oauth2/consent", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          accept: true,
          oauth_query: new URL(target, origin).searchParams.toString(),
        }),
      });
      const data = await consent.json();
      check(consent.ok, "CALENDAR_RUNTIME_CONSENT_FAILED");
      target = data.url ?? data.redirect_uri;
    }
    check(target, "CALENDAR_RUNTIME_OAUTH_REDIRECT_REQUIRED");
    const redirected = new URL(target, origin),
      code = redirected.searchParams.get("code");
    check(
      redirected.origin === new URL(callback).origin &&
        redirected.pathname === new URL(callback).pathname &&
        redirected.searchParams.get("state") === state &&
        code,
      "CALENDAR_RUNTIME_PKCE_REDIRECT_MISMATCH",
    );
    const exchange = await http("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: grant.client_id,
        code,
        redirect_uri: callback,
        code_verifier: verifier,
        resource: origin + "/api/mcp",
      }),
    });
    const token = await exchange.json();
    check(
      exchange.ok && token.access_token,
      "CALENDAR_RUNTIME_PKCE_EXCHANGE_FAILED",
    );
    const claims = JSON.parse(
      Buffer.from(token.access_token.split(".")[1], "base64url").toString(
        "utf8",
      ),
    );
    check(
      claims.sub === identity.actor_id &&
        claims.client_id === grant.client_id &&
        grant.scopes.every((scope) => claims.scope?.split(" ").includes(scope)),
      "CALENDAR_RUNTIME_TOKEN_IDENTITY_OR_SCOPE_MISMATCH",
    );
    grant.access_token = token.access_token;
    grant.expires_at = claims.exp * 1000;
    grant.authorization.status = "confirmed";
    await save();
    return grant.access_token;
  };
  const sdk = async (role, scopes) => {
    let grant = journal.grants.findLast(
      (value) => value.role === role && !value.revoked,
    );
    if (!grant) {
      grant = { role, scopes, revoked: false };
      journal.grants.push(grant);
      await save();
    }
    const token = await authorize(grant),
      client = new Client({
        name: "ramin-calendar-runtime-QA",
        version: "1.0.0",
      });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(origin + "/api/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    clients.push(client);
    return { client, grant };
  };
  const mutate = async (label, name, input, revision) => {
    let operation = journal.operations[label];
    const args = {
      input,
      operation_id: "calendar-runtime-" + journal.run_id + "-" + label,
      ...(revision !== undefined ? { expected_revision: revision } : {}),
    };
    if (!operation) {
      operation = { name, args, status: "prepared" };
      journal.operations[label] = operation;
      await save();
    }
    check(
      operation.name === name &&
        JSON.stringify(operation.args) === JSON.stringify(args),
      "CALENDAR_RUNTIME_RETAINED_INTENT_MISMATCH",
    );
    if (operation.status === "confirmed") return operation.result;
    operation.status = "attempted";
    await save();
    const result = commandResult(
      await writable.client.callTool({
        name: operation.name,
        arguments: operation.args,
      }),
    );
    operation.result = result;
    operation.status = "confirmed";
    await save();
    return result;
  };
  const find = async (operation, id, idField, input = {}) => {
    let cursor;
    for (let page = 0; page < 250; page++) {
      const result = await query(operation, {
        ...input,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      check(Array.isArray(result.items), "CALENDAR_RUNTIME_READBACK_INVALID");
      const found = result.items.find((row) => row[idField] === id);
      if (found) return found;
      cursor = result.next_cursor;
      if (!cursor) return null;
    }
    throw new Error("CALENDAR_RUNTIME_READBACK_BOUND_EXCEEDED");
  };
  let failure;
  try {
    writable = await sdk("writer", [
      "calendar:read",
      "time:read",
      "time:write",
    ]);
    const readonly = await sdk("reader", ["calendar:read", "time:read"]);
    const tools = await writable.client.listTools();
    check(
      requiredTools.every((name) =>
        tools.tools.some((tool) => tool.name === name),
      ),
      "CALENDAR_RUNTIME_CATALOG_MISSING_TOOLS",
    );
    journal.evidence.catalog_count = tools.tools.length;
    for (const name of [
      "calendar_list",
      "calendar_sync_status",
      "calendar_operation_status",
    ]) {
      const result = await readonly.client.callTool({
        name,
        arguments: name === "calendar_list" ? { limit: 200 } : {},
      });
      check(
        !result.isError && !unpack(result).error,
        "CALENDAR_RUNTIME_MCP_CALENDAR_READ_FAILED",
      );
    }
    journal.evidence.mcp_calendar_reads = "PASS";
    await save();
    const deniedInput = {
      employer: "Jena",
      date: "2036-01-15",
      start: "09:",
      end: "",
      end_next_day: false,
      description: marker + " denied",
      timezone: "Europe/Berlin",
    };
    let denial = journal.operations.readonly_denial;
    if (!denial) {
      denial = {
        name: "time_draft_save",
        args: {
          input: deniedInput,
          operation_id: "calendar-runtime-" + journal.run_id + "-denied",
        },
        status: "attempted",
      };
      journal.operations.readonly_denial = denial;
      await save();
    }
    if (denial.status !== "denied") {
      const denied = await readonly.client.callTool({
        name: denial.name,
        arguments: denial.args,
      });
      const data = unpack(denied);
      if (!denied.isError || data.error?.code !== "INSUFFICIENT_PERMISSIONS") {
        denial.result = data.data ?? data;
        await save();
        throw new Error("CALENDAR_RUNTIME_READONLY_WRITE_NOT_DENIED");
      }
      denial.status = "denied";
      await save();
    }
    journal.evidence.readonly_write_denial = "PASS";
    const draftInput = {
      employer: "Jena",
      date: "2036-01-15",
      start: "09:",
      end: "",
      end_next_day: false,
      description: marker,
      timezone: "Europe/Berlin",
    };
    const draft = await mutate("draft", "time_draft_save", draftInput);
    const replay = commandResult(
      await writable.client.callTool({
        name: "time_draft_save",
        arguments: journal.operations.draft.args,
      }),
    );
    check(
      replay.replayed === true && replay.entity_id === draft.entity_id,
      "CALENDAR_RUNTIME_REPLAY_DUPLICATED_DRAFT",
    );
    journal.evidence.exactly_once = "PASS";
    if (!journal.operations.promote) {
      const visible = await find(
        "time_draft_list",
        draft.entity_id,
        "draft_id",
      );
      check(
        visible?.description === marker &&
          visible.start === "09:" &&
          !visible.end,
        "CALENDAR_RUNTIME_DRAFT_REST_READBACK_FAILED",
      );
    }
    journal.evidence.draft_rest_readback = "PASS";
    await save();
    const start = "2036-01-15T08:00:00.000Z",
      end = "2036-01-15T09:00:00.000Z";
    const promoted = await mutate("promote", "time_entry_create", {
      employer: "Jena",
      starts_at: start,
      ends_at: end,
      description: marker,
      draft_id: draft.entity_id,
      draft_revision: draft.version,
    });
    if (!journal.operations.edit) {
      const visible = await find(
        "time_entry_list",
        promoted.entity_id,
        "entry_id",
        { from: start, to: "2036-01-15T11:00:00.000Z" },
      );
      check(
        visible?.description === marker &&
          visible.minutes === 60 &&
          visible.starts_at === start &&
          visible.ends_at === end,
        "CALENDAR_RUNTIME_PROMOTION_READBACK_FAILED",
      );
    }
    journal.evidence.promotion_rest_readback = "PASS";
    await save();
    const edited = await mutate(
      "edit",
      "time_entry_update",
      { entry_id: promoted.entity_id, ends_at: "2036-01-15T10:00:00.000Z" },
      promoted.version,
    );
    const undone = await mutate(
      "undo",
      "time_entry_undo",
      { entry_id: promoted.entity_id },
      edited.version,
    );
    if (!journal.operations.archive_entry) {
      const visible = await find(
        "time_entry_list",
        promoted.entity_id,
        "entry_id",
        { from: start, to: "2036-01-15T11:00:00.000Z" },
      );
      check(
        visible?.description === marker &&
          visible.minutes === 60 &&
          visible.ends_at === end &&
          visible.revision === undone.version,
        "CALENDAR_RUNTIME_UNDO_READBACK_FAILED",
      );
    }
    journal.evidence.undo_rest_readback = "PASS";
    await save();
    await mutate(
      "archive_entry",
      "time_entry_archive",
      { entry_id: promoted.entity_id },
      undone.version,
    );
    // Promotion atomically archives this exact draft and increments its revision.
    await mutate(
      "archive_draft",
      "time_draft_archive",
      { draft_id: draft.entity_id },
      draft.version + 1,
    );
    check(
      !(await find("time_entry_list", promoted.entity_id, "entry_id", {
        from: start,
        to: "2036-01-15T11:00:00.000Z",
      })) && !(await find("time_draft_list", draft.entity_id, "draft_id")),
      "CALENDAR_RUNTIME_SYNTHETIC_CLEANUP_FAILED",
    );
    journal.evidence.synthetic_cleanup = "PASS";
    await save();
  } catch (error) {
    failure = error;
    journal.status = "pending_recovery";
    await save();
  } finally {
    await Promise.allSettled(clients.map((client) => client.close()));
    for (const grant of journal.grants.filter(
      (value) => value.client_id && !value.revoked,
    )) {
      try {
        const listing = await http("/api/v1/connections", {
          headers: { Cookie: cookie },
        });
        const data = (await listing.json()).data;
        check(
          listing.ok && Array.isArray(data?.items),
          "CALENDAR_RUNTIME_CONNECTION_READ_FAILED",
        );
        const existing = data.items.find(
          (row) => row.client_id === grant.client_id,
        );
        check(
          existing?.name ===
            "Synthetic calendar runtime QA " +
              journal.run_id +
              " " +
              grant.role,
          "CALENDAR_RUNTIME_QA_CLIENT_IDENTITY_MISMATCH",
        );
        if (!existing?.revoked) {
          grant.revocation_state = "attempted";
          await save();
          const revoked = await http("/api/v1/connections", {
            method: "POST",
            headers: {
              Cookie: cookie,
              Origin: origin,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              client_id: grant.client_id,
              explicit_confirmation: true,
            }),
          });
          check(
            revoked.ok && (await revoked.json()).data?.revoked,
            "CALENDAR_RUNTIME_CLIENT_REVOCATION_FAILED",
          );
        }
        if (grant.access_token) {
          const probe = await http(
            "/api/v1/query?operation=calendar_sync_status",
            { headers: { Authorization: "Bearer " + grant.access_token } },
          );
          await probe.body?.cancel();
          check(
            probe.status === 401,
            "CALENDAR_RUNTIME_REVOKED_TOKEN_STILL_ACCEPTED",
          );
        }
        grant.revoked = true;
        grant.revocation_state = "confirmed";
        await save();
      } catch (error) {
        failure ??= error;
      }
    }
  }
  if (failure) throw failure;
  check(
    journal.grants.every((grant) => grant.revoked),
    "CALENDAR_RUNTIME_QA_CLIENT_CLEANUP_INCOMPLETE",
  );
  journal.status = "passed";
  journal.receipt = {
    status: "PASS",
    sdk_mcp: "PASS",
    catalog_tools: journal.evidence.catalog_count,
    calendar_source_status_reads: "PASS",
    readonly_write_denial: "PASS",
    draft_create_replay_rest_readback: "PASS",
    promotion_and_undo_rest_readback: "PASS",
    exact_synthetic_archival: "PASS",
    revoked_qa_clients: journal.grants.length,
    external_calendar_writes: 0,
  };
  await save();
  return journal.receipt;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyCalendarRuntime(process.argv.slice(2))
    .then((receipt) => console.log(JSON.stringify(receipt)))
    .catch((error) => {
      const code =
        typeof error?.message === "string" &&
        /^CALENDAR_RUNTIME_[A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "CALENDAR_RUNTIME_FAILED_OR_UNCERTAIN_RETAIN_PRIVATE_JOURNAL";
      console.error(
        code + "; no private records, identifiers or tokens emitted",
      );
      process.exitCode = 1;
    });
}
