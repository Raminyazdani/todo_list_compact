import { afterAll, beforeAll, describe, it } from "vitest";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FileHandle } from "node:fs/promises";
import {
  admitPrivatePath,
  replacePinnedContents,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "../../scripts/ops/private-paths.mjs";
import { getDatabase, type Database } from "../../server/db/database";
import {
  httpEnabled,
  origin,
  ownerCookie,
  scopedToken,
} from "../contracts/http-fixture";

// This is real HTTP/OAuth/PG scope evidence on SQL-seeded notifications.
// It never runs the global scheduler and does not claim delivery/provider proof.
const localOrigin = "http://localhost:3000";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
type Input = Record<string, unknown>;
type Receipt = {
  entity_id: string;
  operation_id: string;
  audit_event_id: string;
  version: number;
  replayed?: boolean;
};
type N = {
  notification_id: string;
  target_type: "task" | "calendar";
  target_id: string;
  revision: number;
  read_at: unknown;
};
type Scope = "tasks:read" | "calendar:read" | "tasks:write" | "calendar:write";
const runId = randomUUID();
const report: {
  format: string;
  proof_mode: string;
  status: string;
  owner_validated: boolean;
  created: Record<string, string>;
  operations: {
    command: string;
    key: string;
    input: Input;
    revision?: number;
    status: string;
  }[];
  oauth_clients: string[];
  checks: string[];
  cleanup: string;
  failed_step?: string;
} = {
  format: "ramin-life-os-notification-http-proof/1",
  proof_mode: "local_stage_SQL_seeded_notification_transport",
  status: "pending",
  owner_validated: false,
  created: {},
  operations: [],
  oauth_clients: [],
  checks: [],
  cleanup: "pending",
};
let cookie = "",
  owner = "",
  db: Database | undefined,
  reportPath = "",
  initialized = false;
const tokens = new Map<Scope, string>();
let step = "ADMISSION";
function check(value: unknown, code: string): asserts value {
  if (!value) throw new Error(code);
}
async function persist(handle?: FileHandle) {
  if (!reportPath) return;
  if (handle)
    await replacePinnedContents(handle, JSON.stringify(report, null, 2) + "\n");
  else
    await withPrivateFile(
      reportPath,
      (file) =>
        replacePinnedContents(file, JSON.stringify(report, null, 2) + "\n"),
      { repositoryRoot },
    );
}
async function guarded(action: () => Promise<void>) {
  try {
    await action();
  } catch {
    report.status = "failed";
    report.failed_step = step;
    await persist().catch(() => undefined);
    // No helper response, private ID, SQL error, token or stack is exposed.
    throw new Error(
      "HTTP_NOTIFICATION_SCOPES_FAILED_AT_" +
        step +
        "; inspect private scope-proof journal",
    );
  }
}
async function http(path: string, init: RequestInit = {}, scope?: Scope) {
  const headers = new Headers(init.headers);
  if (scope) {
    const token = tokens.get(scope);
    check(token, "SCOPE_TOKEN_REQUIRED");
    headers.set("Authorization", "Bearer " + token);
  } else headers.set("Cookie", cookie);
  if (init.method === "POST") headers.set("Origin", localOrigin);
  return fetch(localOrigin + path, {
    ...init,
    headers,
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(30000),
  });
}
async function query<T>(
  operation: string,
  input: Input = {},
  scope?: Scope,
): Promise<T> {
  const response = await http(
    "/api/v1/query?" +
      new URLSearchParams({ operation, input: JSON.stringify(input) }),
    {},
    scope,
  );
  check(response.status === 200, "QUERY_STATUS");
  const payload = (await response.json()) as { data: T };
  check(payload.data !== undefined, "QUERY_DATA_REQUIRED");
  return payload.data;
}
async function command(
  command: string,
  input: Input,
  revision?: number,
  scope?: Scope,
  key = randomUUID(),
) {
  const operation = { command, key, input, revision, status: "pending" };
  report.operations.push(operation);
  await persist();
  const response = await http(
    "/api/v1/commands",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": key,
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      },
      body: JSON.stringify({ command, input }),
    },
    scope,
  );
  const body = (await response.json()) as {
    data?: Receipt;
    error?: { code: string };
  };
  operation.status = response.ok
    ? "accepted"
    : response.status === 403
      ? "denied"
      : "failed";
  if (response.ok && body.data?.entity_id) {
    if (command === "task_create") report.created.task_id = body.data.entity_id;
    if (command === "calendar_create_local_event")
      report.created.event_id = body.data.entity_id;
  }
  await persist();
  return { status: response.status, body };
}
async function nativeState(id: string) {
  check(db && owner, "OWNER_DATABASE_REQUIRED");
  const row = (
    await db.query<N>(
      "SELECT notification_id,target_type,target_id,revision,read_at FROM notifications WHERE owner_id=$1 AND notification_id=$2",
      [owner, id],
    )
  ).rows[0];
  const audit = (
    await db.query<{ count: string }>(
      "SELECT count(*)::text count FROM activity_events WHERE owner_id=$1 AND entity_id=$2 AND event_type='notification_mark_read'",
      [owner, id],
    )
  ).rows[0].count;
  return { row, audit };
}
async function denied(id: string, scope: Scope) {
  const before = await nativeState(id);
  const response = await command(
    "notification_mark_read",
    { notification_id: id },
    before.row.revision,
    scope,
  );
  check(
    response.status === 403 &&
      response.body.error?.code === "INSUFFICIENT_PERMISSIONS",
    "WRITE_MUST_BE403",
  );
  check(
    JSON.stringify(await nativeState(id)) === JSON.stringify(before),
    "DENIAL_MUST_NOT_CHANGE_READ_REVISION_OR_AUDIT",
  );
}

describe.skipIf(!httpEnabled)(
  "Real local HTTP notification target scopes on SQL-seeded synthetic notifications (not scheduler delivery)",
  () => {
    beforeAll(
      async () =>
        guarded(async () => {
          check(
            origin === localOrigin &&
              new URL(process.env.BETTER_AUTH_URL ?? "").origin === localOrigin,
            "EXACT_LOOPBACK_STAGE_REQUIRED",
          );
          check(
            process.env.DATABASE_URL && process.env.OWNER_ID,
            "STAGE_CONFIGURATION_REQUIRED",
          );
          const ciOwner =
            process.env.CI === "true" &&
            process.env.OWNER_ID === "synthetic-ci-owner";
          check(
            ciOwner || process.env.HTTP_NOTIFICATION_SCOPE_STAGING === "1",
            "EXPLICIT_LOCAL_STAGE_INTENT_REQUIRED",
          );
          check(
            process.env.TEST_CREDENTIALS_PATH,
            "PRIVATE_STAGE_CREDENTIALS_REQUIRED",
          );
          const admitted = await admitPrivatePath(
            process.env.TEST_CREDENTIALS_PATH,
            { repositoryRoot, mustExist: true },
          );
          reportPath = await writeExclusivePrivateJson(
            join(
              dirname(admitted),
              "notification-scope-proof-" + runId + ".json",
            ),
            report,
            { repositoryRoot },
          );
          step = "OWNER_AUTH_AND_WORKSPACE_MATCH";
          cookie = await ownerCookie();
          const identity = await query<{ owner_id: string; actor_id: string }>(
            "whoami",
          );
          check(
            identity.owner_id === process.env.OWNER_ID &&
              Boolean(identity.actor_id),
            "EXACT_STAGE_OWNER_REQUIRED",
          );
          owner = identity.owner_id;
          report.owner_validated = true;
          await persist();
          db = getDatabase();
          step = "CANONICAL_SYNTHETIC_FIXTURE_CREATE";
          const task = await command("task_create", {
            title: "Synthetic HTTP notification task " + runId,
            source_reference: "synthetic-notification-scope:" + runId,
          });
          const event = await command("calendar_create_local_event", {
            title: "Synthetic HTTP notification event " + runId,
            starts_at: "2028-06-01T08:00:00Z",
            ends_at: "2028-06-01T09:00:00Z",
            timezone: "Europe/Berlin",
            category: "Work",
          });
          check(
            task.status === 200 &&
              event.status === 200 &&
              report.created.task_id &&
              report.created.event_id,
            "CANONICAL_FIXTURE_RECEIPTS_REQUIRED",
          );
          step = "NATIVE_APP_DATABASE_AND_OWNER_TARGET_MATCH";
          const bound = (
            await db.query<{ task: boolean; event: boolean }>(
              "SELECT EXISTS(SELECT 1 FROM tasks WHERE owner_id=$1 AND task_id=$2 AND source_reference=$4) task,EXISTS(SELECT 1 FROM calendar_events WHERE owner_id=$1 AND event_id=$3 AND provider='local' AND title=$5 AND task_id IS NULL) event",
              [
                owner,
                report.created.task_id,
                report.created.event_id,
                "synthetic-notification-scope:" + runId,
                "Synthetic HTTP notification event " + runId,
              ],
            )
          ).rows[0];
          check(
            bound.task && bound.event,
            "NATIVE_DATABASE_MUST_MATCH_NEW_APP_FIXTURES",
          );
          report.created.task_notification_id =
            "N-http-scope-task-" + randomUUID();
          report.created.calendar_notification_id =
            "N-http-scope-calendar-" + randomUUID();
          await persist();
          step = "OWN_TARGET_BOUND_SQL_SEED";
          const taskSeed = await db.query(
            "INSERT INTO notifications(notification_id,owner_id,title,body,target_type,target_id) SELECT $3,owner_id,'Synthetic task scope transport','SQL-seeded HTTP scope proof','task',task_id FROM tasks WHERE owner_id=$1 AND task_id=$2 AND source_reference=$4 RETURNING notification_id",
            [
              owner,
              report.created.task_id,
              report.created.task_notification_id,
              "synthetic-notification-scope:" + runId,
            ],
          );
          const eventSeed = await db.query(
            "INSERT INTO notifications(notification_id,owner_id,title,body,target_type,target_id) SELECT $3,owner_id,'Synthetic calendar scope transport','SQL-seeded HTTP scope proof','calendar',event_id FROM calendar_events WHERE owner_id=$1 AND event_id=$2 AND title=$4 AND provider='local' RETURNING notification_id",
            [
              owner,
              report.created.event_id,
              report.created.calendar_notification_id,
              "Synthetic HTTP notification event " + runId,
            ],
          );
          check(
            taskSeed.rows.length === 1 && eventSeed.rows.length === 1,
            "EXACT_TWO_SQL_SEEDS_REQUIRED",
          );
          const joined = (
            await db.query<{ count: string }>(
              "SELECT count(*)::text count FROM notifications n LEFT JOIN tasks t ON n.target_type='task' AND t.task_id=n.target_id AND t.owner_id=n.owner_id LEFT JOIN calendar_events e ON n.target_type='calendar' AND e.event_id=n.target_id AND e.owner_id=n.owner_id WHERE n.owner_id=$1 AND n.notification_id=ANY($2::text[]) AND (t.task_id IS NOT NULL OR e.event_id IS NOT NULL)",
              [
                owner,
                [
                  report.created.task_notification_id,
                  report.created.calendar_notification_id,
                ],
              ],
            )
          ).rows[0];
          check(joined.count === "2", "NATIVE_OWNER_TARGET_RELATIONS_REQUIRED");
          step = "EXACT_FOUR_SCOPED_OAUTH_GRANTS";
          for (const scope of [
            "tasks:read",
            "calendar:read",
            "tasks:write",
            "calendar:write",
          ] as const) {
            const issued = await scopedToken(cookie, [scope]);
            report.oauth_clients.push(issued.clientId);
            await persist();
            const claims = JSON.parse(
              Buffer.from(
                issued.accessToken.split(".")[1],
                "base64url",
              ).toString("utf8"),
            ) as { scope: string };
            check(
              claims.scope.split(" ").length === 1 && claims.scope === scope,
              "JWT_MUST_HAVE_ONLY_REQUESTED_TARGET_SCOPE",
            );
            tokens.set(scope, issued.accessToken);
          }
          initialized = true;
          await persist();
        }),
      120000,
    );

    it("actual_tasks_read_and_calendar_read_JWTs_project_only_their_target_and_unauthenticated_read_is401", async () =>
      guarded(async () => {
        step = "READ_PROJECTION_AND_UNAUTH401";
        for (const [scope, type, ownId, deniedId] of [
          [
            "tasks:read",
            "task",
            report.created.task_notification_id,
            report.created.calendar_notification_id,
          ],
          [
            "calendar:read",
            "calendar",
            report.created.calendar_notification_id,
            report.created.task_notification_id,
          ],
        ] as const) {
          const page = await query<{ items: N[] }>(
            "notifications_list",
            { limit: 200 },
            scope,
          );
          check(
            page.items.some((row) => row.notification_id === ownId) &&
              !page.items.some((row) => row.notification_id === deniedId) &&
              page.items.every((row) => row.target_type === type),
            "TOKEN_MUST_NOT_READ_OTHER_TARGET_CONTENT",
          );
        }
        const response = await fetch(
          localOrigin + "/api/v1/query?operation=notifications_list",
          { redirect: "manual", signal: AbortSignal.timeout(30000) },
        );
        check(response.status === 401, "UNAUTHENTICATED_READ_MUST_BE401");
        report.checks.push("real_OAuth_target_read_projection_and_unauth401");
        await persist();
      }));
    it("wrong_target_and_readonly_JWTs_are403_with_no_read_timestamp_revision_or_audit_mutation", async () =>
      guarded(async () => {
        step = "WRONG_TARGET_AND_READONLY_DENIAL";
        await denied(report.created.calendar_notification_id, "tasks:write");
        await denied(report.created.task_notification_id, "calendar:write");
        await denied(report.created.task_notification_id, "tasks:read");
        await denied(report.created.calendar_notification_id, "calendar:read");
        report.checks.push(
          "four_real_JWT_denials_leave_native_SQL_state_and_audit_unchanged",
        );
        await persist();
      }));
    it("matching_target_writes_succeed_and_exact_retry_does_not_duplicate_audit_or_revision", async () =>
      guarded(async () => {
        step = "MATCHING_WRITE_AND_ACCEPTED_RETRY";
        for (const [scope, id] of [
          ["tasks:write", report.created.task_notification_id],
          ["calendar:write", report.created.calendar_notification_id],
        ] as const) {
          const before = await nativeState(id),
            key = randomUUID(),
            input = { notification_id: id };
          const accepted = await command(
            "notification_mark_read",
            input,
            before.row.revision,
            scope,
            key,
          );
          check(
            accepted.status === 200 && accepted.body.data?.entity_id === id,
            "MATCHING_WRITE_MUST_SUCCEED",
          );
          const after = await nativeState(id);
          check(
            after.row.read_at !== null &&
              after.row.revision === before.row.revision + 1 &&
              Number(after.audit) === Number(before.audit) + 1,
            "MATCHING_WRITE_NATIVE_AUDIT_AND_REVISION_REQUIRED",
          );
          const replay = await command(
            "notification_mark_read",
            input,
            before.row.revision,
            scope,
            key,
          );
          check(
            replay.status === 200 &&
              replay.body.data?.replayed === true &&
              replay.body.data.audit_event_id ===
                accepted.body.data.audit_event_id,
            "EXACT_ACCEPTED_RETRY_REQUIRED",
          );
          check(
            JSON.stringify(await nativeState(id)) === JSON.stringify(after),
            "RETRY_MUST_NOT_DUPLICATE_STATE_OR_AUDIT",
          );
        }
        if (report.status !== "failed") report.status = "passed";
        report.checks.push(
          "two_real_target_writes_with_native_SQL_audit_and_idempotent_retry",
        );
        await persist();
      }));

    afterAll(async () => {
      if (!report.owner_validated || !db) return;
      try {
        step = "EXACT_SYNTHETIC_CLEANUP";
        const ids = [
          report.created.task_notification_id,
          report.created.calendar_notification_id,
        ].filter(Boolean);
        if (ids.length) {
          const removed = await db.query(
            "DELETE FROM notifications WHERE owner_id=$1 AND notification_id=ANY($2::text[]) AND ((target_type='task' AND target_id=$3) OR (target_type='calendar' AND target_id=$4)) RETURNING notification_id",
            [owner, ids, report.created.task_id, report.created.event_id],
          );
          check(
            !initialized || removed.rows.length === 2,
            "EXACT_SEEDED_ROWS_MUST_BE_REMOVED",
          );
        }
        const task = (
          await db.query<{ revision: number }>(
            "SELECT revision FROM tasks WHERE owner_id=$1 AND task_id=$2 AND source_reference=$3",
            [
              owner,
              report.created.task_id,
              "synthetic-notification-scope:" + runId,
            ],
          )
        ).rows[0];
        check(
          !report.created.task_id || task,
          "KNOWN_SYNTHETIC_TASK_MUST_MATCH_FOR_CLEANUP",
        );
        if (task) {
          const archive = await command(
            "task_archive",
            { task_id: report.created.task_id },
            task.revision,
          );
          check(archive.status === 200, "SYNTHETIC_TASK_ARCHIVE_REQUIRED");
        }
        const event = (
          await db.query<{ revision: number }>(
            "SELECT revision FROM calendar_events WHERE owner_id=$1 AND event_id=$2 AND title=$3 AND provider='local'",
            [
              owner,
              report.created.event_id,
              "Synthetic HTTP notification event " + runId,
            ],
          )
        ).rows[0];
        check(
          !report.created.event_id || event,
          "KNOWN_SYNTHETIC_EVENT_MUST_MATCH_FOR_CLEANUP",
        );
        if (event) {
          const archive = await command(
            "calendar_delete_local_event",
            { event_id: report.created.event_id },
            event.revision,
          );
          check(archive.status === 200, "SYNTHETIC_EVENT_ARCHIVE_REQUIRED");
        }
        for (const clientId of report.oauth_clients) {
          const revoked = await http("/api/v1/connections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              client_id: clientId,
              explicit_confirmation: true,
            }),
          });
          const body = (await revoked.json()) as {
            data?: { revoked: boolean };
          };
          check(
            revoked.status === 200 && body.data?.revoked === true,
            "EXACT_TEST_CLIENT_REVOCATION_REQUIRED",
          );
        }
        const residue = (
          await db.query<{ count: string }>(
            "SELECT count(*)::text count FROM notifications WHERE owner_id=$1 AND notification_id=ANY($2::text[])",
            [owner, ids],
          )
        ).rows[0];
        check(
          residue.count === "0",
          "SEEDED_NOTIFICATION_CLEANUP_READBACK_REQUIRED",
        );
        report.cleanup = initialized
          ? "exact_seeded_notifications_removed_native_fixtures_archived_own_clients_revoked_immutable_audit_retained"
          : "known_partial_fixture_ids_only_cleaned_inspect_pending_intents";
        await persist();
      } catch {
        report.status = "failed";
        report.failed_step = step;
        report.cleanup = "failed_inspect_private_known_ids_only";
        await persist().catch(() => undefined);
        throw new Error(
          "HTTP_NOTIFICATION_SCOPE_EXACT_CLEANUP_FAILED; inspect private journal",
        );
      } finally {
        await db.close?.();
      }
    }, 60000);
  },
);
