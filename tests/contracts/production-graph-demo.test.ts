import { it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  admitPrivatePath,
  replacePinnedContents,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "../../scripts/ops/private-paths.mjs";
import { ownerCookie, origin, scopedToken } from "./http-fixture";
import { TOOL_CATALOG } from "../../server/mcp/catalog";
import { singleFlightRenewal } from "./single-flight-renewal";
import type {
  ChecklistDTO,
  ActivityDTO,
  CommandName,
  MutationResult,
  PageDTO,
  PreviewDTO,
  QueryName,
  TaskDTO,
} from "../../shared/contracts";

/** Coordinator-only remote proof. No cleanup: these exact IDs are restore/UI evidence. */
const production = process.env.RUN_PRODUCTION_GRAPH_DEMO === "1";
const rehearsal = process.env.RUN_PRODUCTION_GRAPH_REHEARSAL === "1";
const enabled = production || rehearsal;
const resume = process.env.RUN_PRODUCTION_GRAPH_RESUME === "1";
const proofMode = production ? "production" : "staging_rehearsal";
const target = production
  ? "https://ramin-life-os.vercel.app"
  : "http://localhost:3000";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
type Input = Record<string, unknown>;
type Token = Awaited<ReturnType<typeof scopedToken>>;
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
type RecordedOperation = {
  command: CommandName | "owner_daily_job";
  operation_id: string;
  input: Input;
  expected_revision?: number;
  status: "pending" | "accepted" | "denied";
  result?: MutationResult;
};
type Report = {
  format: "ramin-life-os-production-graph-proof/1";
  status: "pending" | "failed" | "passed";
  proof_mode: "production" | "staging_rehearsal";
  origin: string;
  run_id: string;
  started_at: string;
  completed_at?: string;
  failed_step?: string;
  failed_check?: string;
  failed_kind?: string;
  resume_tasks_verified?: number;
  cleanup: "retain_until_coordinator_restore_and_redeploy_proof";
  operations: RecordedOperation[];
  oauth_clients: { client_id: string; scopes: string[] }[];
  created: Record<string, string[]>;
  roles: Record<string, string>;
  steps: string[];
  snapshots: Record<string, TaskDTO>;
  verified_audit_receipts?: number;
  resume_attempts?: {
    started_at: string;
    failed_step?: string;
    failed_check?: string;
  }[];
};

function check(value: unknown, code: string): asserts value {
  // A public failure contains only a fixed diagnostic code, never a response body/ID.
  if (!value) throw new Error(code);
}
function envelope(result: ToolResult): {
  data?: unknown;
  error?: { code: string };
} {
  const value = result.structuredContent;
  check(value && typeof value === "object", "MCP_STRUCTURED_RESULT_REQUIRED");
  return value as { data?: unknown; error?: { code: string } };
}
function sorted(values: string[]) {
  return [...values].sort();
}
function sameIds(a: string[], b: string[]) {
  return JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
}
function graphState(tasks: TaskDTO[]) {
  return tasks.map((t) => ({
    task_id: t.task_id,
    revision: t.revision,
    status: t.status,
    readiness: t.readiness,
    prerequisites: t.prerequisites,
  }));
}

it.skipIf(!enabled)(
  `${proofMode}: real OAuth MCP writes and REST SQL reads prove synthetic ALL/ANY, reopen, checklists, templates, recurrence and scope denial`,
  async () => {
    // Reserve and pin the private journal before any sign-in, OAuth registration or write.
    // Re-running requires a NEW report file; pending writes must be inspected, not repeated.
    try {
      check(production !== rehearsal, "GRAPH_PROOF_EXACTLY_ONE_MODE_REQUIRED");
      check(origin === target, "PRODUCTION_GRAPH_EXACT_ORIGIN_REQUIRED");
      // Validate the complete authored MCP vocabulary before sign-in or any
      // registration. These are schema admissions, not remote acceptance evidence.
      const offlineId = "synthetic-schema-admission",
        offlineKey = "synthetic-operation-admission";
      const authoredArguments: [QueryName | CommandName, Input][] = [
        ["task_get", { task_id: offlineId }],
        [
          "task_dependency_add_preview",
          {
            task_id: offlineId,
            prerequisites: [
              { task_id: "synthetic-prerequisite", mode: "hard" },
            ],
            operator: "ALL",
          },
        ],
        [
          "task_template_instantiate_preview",
          {
            template_id: offlineId,
            project_id: offlineId,
            preserve_external_links: false,
          },
        ],
        ...(
          [
            ["project_create", { title: "Synthetic admission project" }],
            [
              "task_create",
              {
                title: "Synthetic admission task",
                project_id: offlineId,
                source_reference: "synthetic-admission",
              },
            ],
            [
              "subtask_create",
              {
                title: "Synthetic admission child",
                project_id: offlineId,
                parent_task_id: offlineId,
                source_reference: "synthetic-admission",
              },
            ],
            ["task_dependency_add_commit", { preview_id: offlineId }],
            ["task_complete", { task_id: offlineId }],
            ["task_reopen", { task_id: offlineId }],
            ["task_update", { task_id: offlineId, status: "In progress" }],
            [
              "task_checklist_create",
              { task_id: offlineId, title: "Synthetic admission checklist" },
            ],
            [
              "task_checklist_item_add",
              { checklist_id: offlineId, title: "Synthetic admission item" },
            ],
            ["task_checklist_item_check", { item_id: offlineId }],
            ["task_checklist_item_uncheck", { item_id: offlineId }],
            [
              "task_checklist_item_promote",
              { item_id: offlineId, original: "keep_reference" },
            ],
            [
              "task_template_create",
              {
                title: "Synthetic admission template",
                root_task_id: offlineId,
              },
            ],
            ["task_template_instantiate_commit", { preview_id: offlineId }],
            [
              "task_recurrence_create",
              {
                template_id: offlineId,
                title: "Synthetic admission recurrence",
                start_date: "2026-10-14",
                timezone: "Europe/Berlin",
                rrule: "FREQ=DAILY;COUNT=1",
              },
            ],
          ] as [CommandName, Input][]
        ).map(([name, input]): [CommandName, Input] => [
          name,
          { input, operation_id: offlineKey, expected_revision: 1 },
        ]),
      ];
      for (const [name, args] of authoredArguments) {
        const offered = TOOL_CATALOG.find((entry) => entry.name === name);
        check(
          offered?.schema.safeParse(args).success,
          "AUTHORED_MCP_ARGUMENT_SCHEMA_INVALID",
        );
      }
      check(
        process.env.TEST_CREDENTIALS_PATH,
        "PRODUCTION_GRAPH_PRIVATE_CREDENTIALS_REQUIRED",
      );
      check(
        process.env.PRODUCTION_GRAPH_REPORT_PATH,
        "PRODUCTION_GRAPH_PRIVATE_REPORT_REQUIRED",
      );
      await admitPrivatePath(process.env.TEST_CREDENTIALS_PATH, {
        repositoryRoot,
        mustExist: true,
      });
      const report: Report = resume
        ? await withPrivateFile(
            process.env.PRODUCTION_GRAPH_REPORT_PATH,
            async (file) => JSON.parse(await file.readFile("utf8")),
            { repositoryRoot },
          )
        : {
            format: "ramin-life-os-production-graph-proof/1",
            status: "pending",
            proof_mode: proofMode,
            origin,
            run_id: randomUUID(),
            started_at: new Date().toISOString(),
            cleanup: "retain_until_coordinator_restore_and_redeploy_proof",
            operations: [],
            oauth_clients: [],
            created: {},
            roles: {},
            steps: [],
            snapshots: {},
          };
      if (resume) {
        check(
          report.format === "ramin-life-os-production-graph-proof/1" &&
            report.status === "failed" &&
            [
              "OAUTH_SCOPED_CONNECTION",
              "RETAINED_SCOPE_PHASE_RESUME_READBACK",
            ].includes(report.failed_step ?? "") &&
            report.proof_mode === proofMode &&
            report.origin === target &&
            report.created.tasks.length === 21 &&
            new Set(report.created.tasks).size === 21 &&
            report.operations.every((op) => op.status !== "pending") &&
            report.steps.length === 9 &&
            report.steps.at(-1) ===
              "configured_finite_recurrence_runs_once_with_isolated_nested_instance",
          "EXACT_RETAINED_SCOPE_PHASE_RESUME_REQUIRED",
        );
      }
      const reportPath = resume
        ? await admitPrivatePath(process.env.PRODUCTION_GRAPH_REPORT_PATH, {
            repositoryRoot,
            mustExist: true,
          })
        : await writeExclusivePrivateJson(
            process.env.PRODUCTION_GRAPH_REPORT_PATH,
            report,
            { repositoryRoot },
          );
      await withPrivateFile(
        reportPath,
        async (file) => {
          let step = "OWNER_SIGN_IN",
            cookie = "";
          let writer: { token: Token; client: Client } | undefined;
          let reader: { token: Token; client: Client } | undefined;
          const resumedTasks = new Map<string, TaskDTO>();
          type Connection = NonNullable<typeof writer>;
          const persist = () =>
            replacePinnedContents(file, JSON.stringify(report, null, 2) + "\n");
          const remember = (kind: string, ids: string[]) => {
            report.created[kind] = [
              ...new Set([...(report.created[kind] ?? []), ...ids]),
            ];
          };
          const passed = async (name: string) => {
            report.steps.push(name);
            await persist();
          };
          const scopes = [
            "tasks:read",
            "tasks:write",
            "projects:read",
            "projects:write",
            "files:read",
            "activity:read",
          ];
          async function connection(requestedScopes: string[]) {
            step = "OAUTH_SCOPED_CONNECTION";
            // This pending step precedes the helper's real registration/consent mutations.
            await persist();
            const token = await scopedToken(cookie, requestedScopes);
            report.oauth_clients.push({
              client_id: token.clientId,
              scopes: requestedScopes,
            });
            await persist();
            const client = new Client({
              name: "synthetic-production-graph-proof",
              version: "1.0.0",
            });
            await client.connect(
              new StreamableHTTPClientTransport(new URL(target + "/api/mcp"), {
                requestInit: {
                  headers: { Authorization: "Bearer " + token.accessToken },
                },
              }),
            );
            return { token, client };
          }
          const renewWriter = singleFlightRenewal<Connection>(
            () => writer,
            (value) => Date.now() < value.token.expiresAt,
            async (previous) => {
              await previous.client.close().catch(() => undefined);
              return (writer = await connection(scopes));
            },
          );
          const renewReader = singleFlightRenewal<Connection>(
            () => reader,
            (value) => Date.now() < value.token.expiresAt,
            async (previous) => {
              await previous.client.close().catch(() => undefined);
              return (reader = await connection(["tasks:read", "files:read"]));
            },
          );
          async function tool(
            name: QueryName | CommandName,
            args: Input,
            readonly = false,
          ) {
            const definition = TOOL_CATALOG.find(
              (entry) => entry.name === name,
            );
            check(definition, "OFFERED_MCP_TOOL_REQUIRED");
            // Queries take their direct strict fields; commands take the
            // published {input,operation_id,expected_revision} envelope.
            check(
              definition.schema.safeParse(args).success,
              "MCP_ARGUMENTS_MUST_MATCH_PUBLISHED_CATALOG",
            );
            let conn = readonly ? reader : writer;
            check(conn, "MCP_CONNECTION_REQUIRED");
            try {
              return await conn.client.callTool(
                { name, arguments: args },
                undefined,
                { timeout: 30000 },
              );
            } catch (error) {
              // Renew ONLY an observed transport401 after this token's actual exp.
              // A premature401 or uncertain command acknowledgement is a failure, never a retry.
              if (
                !(error instanceof StreamableHTTPError) ||
                error.code !== 401 ||
                Date.now() < conn.token.expiresAt
              )
                throw new Error(
                  "MCP_TRANSPORT_FAILED_INSPECT_PRIVATE_PENDING_OPERATION",
                );
              conn = await (readonly ? renewReader(conn) : renewWriter(conn));
              return conn.client.callTool(
                { name, arguments: args },
                undefined,
                { timeout: 30000 },
              );
            }
          }
          async function restResponse(
            path: string,
            init: RequestInit = {},
            mode:
              "writer" | "reader" | "cookie" | "none" | "invalid" = "writer",
          ) {
            const conn = mode === "reader" ? reader : writer;
            const headers = new Headers(init.headers);
            if (mode === "cookie") headers.set("Cookie", cookie);
            else if (mode === "invalid")
              headers.set("Authorization", "Bearer synthetic-invalid-bearer");
            else if (mode !== "none") {
              check(conn, "REST_CONNECTION_REQUIRED");
              headers.set("Authorization", "Bearer " + conn.token.accessToken);
            }
            if (init.method === "POST") headers.set("Origin", target);
            const response = await fetch(target + path, {
              ...init,
              headers,
              redirect: "manual",
              cache: "no-store",
              signal: AbortSignal.timeout(30000),
            });
            if (
              response.status === 401 &&
              (mode === "reader" || mode === "writer") &&
              conn &&
              Date.now() >= conn.token.expiresAt
            ) {
              const renewed = await (mode === "reader"
                ? renewReader(conn)
                : renewWriter(conn));
              headers.set(
                "Authorization",
                "Bearer " + renewed.token.accessToken,
              );
              return fetch(target + path, {
                ...init,
                headers,
                redirect: "manual",
                cache: "no-store",
                signal: AbortSignal.timeout(30000),
              });
            }
            return response;
          }
          async function query<T>(
            operation: QueryName,
            input: Input,
            mode: "writer" | "cookie" = "writer",
          ): Promise<T> {
            const params = new URLSearchParams({
              operation,
              input: JSON.stringify(input),
            });
            const response = await restResponse(
              "/api/v1/query?" + params,
              {},
              mode,
            );
            check(response.ok, "REST_QUERY_FAILED");
            const body = (await response.json()) as { data?: T };
            check(body.data !== undefined, "REST_QUERY_DATA_REQUIRED");
            return body.data;
          }
          const task = (task_id: string) =>
            query<TaskDTO>("task_get", { task_id });
          async function allPages<T>(
            operation: QueryName,
            input: Input = {},
            mode: "writer" | "cookie" = "writer",
          ) {
            const rows: T[] = [];
            let cursor: string | null = null;
            const visited = new Set<string>();
            do {
              const page: PageDTO<T> = await query(
                operation,
                { ...input, limit: 200, ...(cursor ? { cursor } : {}) },
                mode,
              );
              rows.push(...page.items);
              cursor = page.next_cursor;
              if (cursor) {
                check(!visited.has(cursor), "PAGING_CURSOR_REPEATED");
                visited.add(cursor);
              }
              check(visited.size <= 50, "AUTOMATION_PREFLIGHT_BOUND_EXCEEDED");
            } while (cursor);
            return rows;
          }
          async function write(
            command: CommandName,
            input: Input,
            expected_revision?: number,
            operation_id = randomUUID(),
          ) {
            step = "COMMAND_" + command.toUpperCase();
            const op: RecordedOperation = {
              command,
              operation_id,
              input,
              expected_revision,
              status: "pending",
            };
            report.operations.push(op);
            await persist();
            const args = {
              input,
              operation_id,
              ...(expected_revision === undefined ? {} : { expected_revision }),
            };
            const result = await tool(command, args);
            const body = envelope(result);
            check(
              !result.isError && !body.error && body.data,
              "CANONICAL_WRITE_FAILED",
            );
            const value = body.data as MutationResult;
            check(
              typeof value.entity_id === "string" &&
                typeof value.audit_event_id === "string",
              "CANONICAL_WRITE_RECEIPT_REQUIRED",
            );
            op.status = "accepted";
            op.result = value;
            if (command === "project_create")
              remember("projects", [value.entity_id]);
            if (
              command === "task_create" ||
              command === "subtask_create" ||
              command === "task_checklist_item_promote"
            )
              remember("tasks", [value.entity_id]);
            if (command === "task_checklist_create")
              remember("checklists", [value.entity_id]);
            if (command === "task_checklist_item_add")
              remember("items", [value.entity_id]);
            if (command === "task_template_create")
              remember("templates", [value.entity_id]);
            if (command === "task_recurrence_create")
              remember("recurrence_rules", [value.entity_id]);
            if (command === "task_template_instantiate_commit")
              remember("tasks", value.affected_task_ids);
            await persist();
            return value;
          }
          async function preview(operation: QueryName, input: Input) {
            step = "PREVIEW_" + operation.toUpperCase();
            const result = await tool(operation, input),
              body = envelope(result);
            check(
              !result.isError && !body.error && body.data,
              "CANONICAL_PREVIEW_FAILED",
            );
            const value = body.data as PreviewDTO;
            check(typeof value.preview_id === "string", "PREVIEW_ID_REQUIRED");
            remember("previews", [value.preview_id]);
            await persist();
            return value;
          }
          async function dependencies(
            dependent: string,
            prerequisites: string[],
            operator: "ALL" | "ANY",
          ) {
            const plan = await preview("task_dependency_add_preview", {
              task_id: dependent,
              prerequisites: prerequisites.map((task_id) => ({
                task_id,
                mode: "hard",
              })),
              operator,
            });
            const key = randomUUID(),
              input = { preview_id: plan.preview_id };
            const accepted = await write(
              "task_dependency_add_commit",
              input,
              undefined,
              key,
            );
            const read = await task(dependent);
            const edges = read.prerequisites.filter((e) =>
              prerequisites.includes(e.prerequisite_task_id),
            );
            check(
              edges.length === prerequisites.length &&
                edges.every(
                  (e) => e.operator === operator && e.mode === "hard",
                ),
              "GRAPH_MCP_WRITE_REST_READ_MISMATCH",
            );
            remember(
              "edges",
              edges.map((e) => e.edge_id),
            );
            remember(
              "groups",
              edges.map((e) => e.group_id),
            );
            const replay = await write(
              "task_dependency_add_commit",
              input,
              undefined,
              key,
            );
            check(
              replay.replayed === true &&
                replay.audit_event_id === accepted.audit_event_id,
              "GRAPH_ACCEPTED_RETRY_NOT_IDEMPOTENT",
            );
            check(
              sameIds(
                (await task(dependent)).prerequisites.map((e) => e.edge_id),
                read.prerequisites.map((e) => e.edge_id),
              ),
              "GRAPH_RETRY_DUPLICATED_EDGE",
            );
            await persist();
          }
          async function transition(
            id: string,
            command: "task_complete" | "task_reopen",
          ) {
            const before = await task(id);
            await write(command, { task_id: id }, before.revision);
            return task(id);
          }
          async function daily() {
            // Recheck immediately before EACH global run, including the replay
            // proof. The coordinator must serialize all other destination writers.
            step = "GLOBAL_JOB_IMMEDIATE_SAFETY_PREFLIGHT";
            const allowed = new Set(report.created.recurrence_rules ?? []);
            const currentRules = await allPages<{
              rule_id: string;
              enabled: boolean;
            }>("task_recurrence_list");
            const currentReminders = await allPages<{ state: string }>(
              "reminder_list",
            );
            const currentEventReminders = await allPages<{ state: string }>(
              "calendar_reminder_list",
              {},
              "cookie",
            );
            check(
              !currentRules.some((r) => r.enabled && !allowed.has(r.rule_id)) &&
                !currentReminders.some((r) => r.state === "Pending") &&
                !currentEventReminders.some((r) => r.state === "Pending"),
              "NONFIXTURE_AUTOMATION_BLOCKS_GLOBAL_JOB",
            );
            step = "OWNER_DAILY_JOB";
            // This UUID identifies the journal intent. The owner route assigns the
            // actual canonical key; an uncertain response is never retried here.
            report.operations.push({
              command: "owner_daily_job",
              operation_id: "journal-intent:" + randomUUID(),
              input: {},
              status: "pending",
            });
            const op = report.operations.at(-1)!;
            await persist();
            const response = await restResponse(
              "/api/v1/jobs/run",
              { method: "POST" },
              "cookie",
            );
            check(
              response.ok,
              "OWNER_DAILY_JOB_FAILED_INSPECT_PENDING_JOURNAL",
            );
            const body = (await response.json()) as { data: MutationResult };
            op.result = body.data;
            op.status = "accepted";
            const data = body.data.data as {
              delivered: number;
              cancelled: number;
              recurring: {
                instances_created: number;
                instance_ids: string[];
                task_ids: string[];
              };
            };
            remember("tasks", data.recurring.task_ids);
            remember("recurrence_instances", data.recurring.instance_ids);
            await persist();
            return data;
          }
          try {
            if (resume) {
              report.resume_attempts = [
                ...(report.resume_attempts ?? []),
                {
                  started_at: new Date().toISOString(),
                  failed_step: report.failed_step,
                  failed_check: report.failed_check,
                },
              ];
              report.status = "pending";
            }
            await persist();
            cookie = await ownerCookie(
              production ? { productionGraphDemo: true } : {},
            );
            writer = await connection(scopes);
            async function createFixture() {
              // Only automation state is read here, never legacy tasks/files. The owner job is
              // global, so it is refused if any unrelated configured work could be delivered.
              step = "GLOBAL_JOB_SAFETY_PREFLIGHT";
              const rules = await allPages<{ enabled: boolean }>(
                "task_recurrence_list",
              );
              const reminders = await allPages<{ state: string }>(
                "reminder_list",
              );
              const eventReminders = await allPages<{ state: string }>(
                "calendar_reminder_list",
                {},
                "cookie",
              );
              check(
                !rules.some((r) => r.enabled) &&
                  !reminders.some((r) => r.state === "Pending") &&
                  !eventReminders.some((r) => r.state === "Pending"),
                "NONFIXTURE_AUTOMATION_BLOCKS_GLOBAL_JOB",
              );
              await passed(
                "unrelated_automation_absent_before_fixture_creation",
              );

              const prefix =
                "SYNTHETIC GRAPH PROOF " + report.run_id.slice(0, 8) + " ";
              const project = await write("project_create", {
                title: prefix + "project",
                notes:
                  "Coordinator synthetic fixture; retain for hosted restore proof.",
              });
              report.roles.project = project.entity_id;
              async function create(role: string, parent?: string) {
                const result = await write(
                  parent ? "subtask_create" : "task_create",
                  {
                    title: prefix + role,
                    project_id: project.entity_id,
                    source_reference:
                      "synthetic-production-graph-proof:" + report.run_id,
                    ...(parent ? { parent_task_id: parent } : {}),
                  },
                );
                report.roles[role] = result.entity_id;
                const read = await task(result.entity_id);
                check(
                  read.title === prefix + role &&
                    read.status === "Inbox" &&
                    read.due_date === null &&
                    read.due_at === null &&
                    read.archived_at === null,
                  "SYNTHETIC_TASK_READBACK_FAILED",
                );
                await persist();
                return result.entity_id;
              }
              const A = await create("A ALL root"),
                B = await create("B chain"),
                C = await create("C checklist template root"),
                D = await create("D leaf");
              const X = await create("X ANY root"),
                E = await create("E ANY option"),
                F = await create("F ANY option");
              await dependencies(A, [B, C], "ALL");
              await dependencies(B, [D], "ALL");
              await dependencies(X, [E, F], "ANY");
              check(
                (await task(A)).readiness === "blocked" &&
                  (await task(B)).readiness === "blocked" &&
                  (await task(C)).ready_now &&
                  (await task(D)).ready_now,
                "INITIAL_ALL_CHAIN_READINESS_WRONG",
              );
              check(
                (await task(X)).readiness === "blocked",
                "INITIAL_ANY_READINESS_WRONG",
              );
              await passed(
                "MCP_graph_commit_REST_read_and_exact_idempotent_edge_replay",
              );

              step = "ATOMIC_CYCLE_DENIAL";
              const beforeCycle = graphState(
                await Promise.all([A, B, C, D].map(task)),
              );
              const rejected = await tool("task_dependency_add_preview", {
                task_id: D,
                prerequisites: [{ task_id: A }],
                operator: "ALL",
              });
              check(
                rejected.isError === true &&
                  envelope(rejected).error?.code === "DEPENDENCY_CYCLE",
                "TYPED_CYCLE_DENIAL_REQUIRED",
              );
              check(
                JSON.stringify(
                  graphState(await Promise.all([A, B, C, D].map(task))),
                ) === JSON.stringify(beforeCycle),
                "CYCLE_DENIAL_CHANGED_GRAPH_OR_REVISION",
              );
              await passed(
                "typed_cycle_denial_preserves_known_graph_atomically",
              );

              await transition(D, "task_complete");
              check(
                (await task(B)).ready_now &&
                  (await task(A)).readiness === "blocked",
                "CHAIN_D_COMPLETION_WRONG",
              );
              await transition(B, "task_complete");
              check(
                (await task(A)).readiness === "blocked" &&
                  (await task(A)).blocked_by.some((b) => b.task_id === C),
                "ALL_REQUIRES_EACH_DONE_PREREQUISITE",
              );

              const first = await write("task_checklist_create", {
                task_id: C,
                title: prefix + "Preparation",
              });
              const second = await write("task_checklist_create", {
                task_id: C,
                title: prefix + "Submission",
              });
              const lists = () =>
                query<ChecklistDTO[]>("task_checklist_get", { task_id: C });
              async function addItem(checklist: string, title: string) {
                const list = (await lists()).find(
                  (c) => c.checklist_id === checklist,
                );
                check(list, "CHECKLIST_READBACK_REQUIRED");
                return (
                  await write(
                    "task_checklist_item_add",
                    { checklist_id: checklist, title: prefix + title },
                    list.revision,
                  )
                ).entity_id;
              }
              const I1 = await addItem(first.entity_id, "prepare document"),
                I2 = await addItem(first.entity_id, "verify document"),
                I3 = await addItem(second.entity_id, "independent follow-up");
              async function toggle(
                item: string,
                command:
                  "task_checklist_item_check" | "task_checklist_item_uncheck",
              ) {
                const existing = (await lists())
                  .flatMap((c) => c.items)
                  .find((i) => i.item_id === item);
                check(existing, "CHECKLIST_ITEM_READBACK_REQUIRED");
                await write(command, { item_id: item }, existing.revision);
              }
              await toggle(I1, "task_checklist_item_check");
              await toggle(I2, "task_checklist_item_check");
              await toggle(I3, "task_checklist_item_check");
              await toggle(I1, "task_checklist_item_uncheck");
              check(
                (await lists())
                  .find((c) => c.checklist_id === first.entity_id)
                  ?.items.find((i) => i.item_id === I1)?.checked === false,
                "UNCHECK_READBACK_FAILED",
              );
              await toggle(I1, "task_checklist_item_check");
              const completedLists = await lists();
              check(
                completedLists.length === 2 &&
                  completedLists.every((c) =>
                    c.items.every((i) => i.checked),
                  ) &&
                  (await task(C)).status === "Inbox" &&
                  (await task(A)).readiness === "blocked",
                "CHECKLISTS_MUST_NOT_COMPLETE_TASK_OR_GATE",
              );
              await passed(
                "two_named_checklists_check_uncheck_readback_independent_of_workflow",
              );
              await transition(C, "task_complete");
              check((await task(A)).ready_now, "ALL_DONE_READINESS_WRONG");
              const readyA = await task(A);
              await write(
                "task_update",
                { task_id: A, status: "In progress" },
                readyA.revision,
              );
              await transition(B, "task_reopen");
              const atRisk = await task(A);
              check(
                atRisk.status === "In progress" &&
                  atRisk.readiness === "blocked" &&
                  atRisk.started_at_risk,
                "REOPEN_MUST_RECOMPUTE_WITHOUT_REWINDING_STATUS",
              );
              await transition(D, "task_reopen");
              check(
                (await task(B)).readiness === "blocked" &&
                  (await task(C)).status === "Done" &&
                  (await lists()).every((c) => c.items.every((i) => i.checked)),
                "REOPEN_PROPAGATION_CORRUPTED_INDEPENDENT_STATE",
              );
              await transition(D, "task_complete");
              check(
                (await task(B)).ready_now &&
                  (await task(A)).readiness === "blocked",
                "RECOMPLETION_MUST_NOT_AUTO_COMPLETE_DOWNSTREAM",
              );
              await passed(
                "ALL_completion_and_transitive_reopen_preserve_downstream_workflow",
              );
              await transition(E, "task_complete");
              check(
                (await task(X)).ready_now && (await task(F)).status === "Inbox",
                "ANY_ONE_DONE_MUST_QUALIFY",
              );
              await transition(E, "task_reopen");
              check(
                (await task(X)).readiness === "blocked",
                "ANY_REOPEN_LAST_QUALIFIER_MUST_BLOCK",
              );
              await transition(F, "task_complete");
              check(
                (await task(X)).ready_now &&
                  (await task(E)).status === "Next" &&
                  (await task(F)).status === "Done",
                "ANY_ALTERNATIVE_DONE_MUST_QUALIFY",
              );
              await passed("ANY_alternative_and_reopen_readiness");

              const promotionItem = (await lists())
                .flatMap((c) => c.items)
                .find((i) => i.item_id === I3)!;
              const promotionKey = randomUUID(),
                promotionInput = { item_id: I3, original: "keep_reference" };
              const promoted = await write(
                "task_checklist_item_promote",
                promotionInput,
                promotionItem.revision,
                promotionKey,
              );
              const promotedReplay = await write(
                "task_checklist_item_promote",
                promotionInput,
                promotionItem.revision,
                promotionKey,
              );
              check(
                promotedReplay.replayed === true &&
                  promotedReplay.entity_id === promoted.entity_id,
                "PROMOTION_RETRY_IDENTITY_CHANGED",
              );
              const afterPromotion = (await lists())
                .flatMap((c) => c.items)
                .find((i) => i.item_id === I3)!;
              const repeatIntent = await write(
                "task_checklist_item_promote",
                promotionInput,
                afterPromotion.revision,
              );
              const promotedTask = await task(promoted.entity_id);
              check(
                repeatIntent.entity_id === promoted.entity_id &&
                  afterPromotion.promoted_task_id === promoted.entity_id &&
                  promotedTask.parent_task_id === C &&
                  promotedTask.status === "Inbox" &&
                  promotedTask.source_reference === "checklist:" + I3 &&
                  (await task(C)).status === "Done",
                "PROMOTION_MUST_CREATE_EXACTLY_ONE_INDEPENDENT_CHILD",
              );
              report.roles.promoted = promoted.entity_id;
              await passed(
                "item_promotion_preserves_reference_and_identity_once",
              );

              const P = await create("P nested parent", C),
                Q = await create("Q nested sibling", C),
                G = await create("G nested grandchild", P);
              await dependencies(Q, [G], "ALL");
              const template = await write("task_template_create", {
                title: prefix + "nested template",
                root_task_id: C,
              });
              const templatePlan = await preview(
                "task_template_instantiate_preview",
                {
                  template_id: template.entity_id,
                  project_id: project.entity_id,
                  preserve_external_links: false,
                },
              );
              const instanceKey = randomUUID(),
                instanceInput = { preview_id: templatePlan.preview_id };
              const instantiated = await write(
                "task_template_instantiate_commit",
                instanceInput,
                undefined,
                instanceKey,
              );
              const clone = instantiated.data as {
                instance_id: string;
                id_mapping: Record<string, string>;
                tasks: TaskDTO[];
              };
              const originalIds = [C, promoted.entity_id, P, Q, G];
              check(
                sameIds(Object.keys(clone.id_mapping), originalIds) &&
                  new Set(Object.values(clone.id_mapping)).size ===
                    originalIds.length &&
                  Object.values(clone.id_mapping).every(
                    (id) => !originalIds.includes(id),
                  ),
                "TEMPLATE_SUBTREE_ID_REMAP_WRONG",
              );
              const clonedTasks = await Promise.all(
                Object.values(clone.id_mapping).map(task),
              );
              const cloneById = new Map(clonedTasks.map((t) => [t.task_id, t]));
              check(
                cloneById.get(clone.id_mapping[G])?.parent_task_id ===
                  clone.id_mapping[P] &&
                  cloneById.get(clone.id_mapping[Q])?.parent_task_id ===
                    clone.id_mapping[C],
                "TEMPLATE_PARENT_REMAP_WRONG",
              );
              check(
                cloneById.get(clone.id_mapping[Q])?.prerequisites[0]
                  ?.prerequisite_task_id === clone.id_mapping[G] &&
                  clonedTasks.every((t) =>
                    t.prerequisites.every((e) =>
                      Object.values(clone.id_mapping).includes(
                        e.prerequisite_task_id,
                      ),
                    ),
                  ),
                "TEMPLATE_EDGE_REMAP_LEAKED_OLD_INSTANCE",
              );
              const clonedLists = await query<ChecklistDTO[]>(
                "task_checklist_get",
                { task_id: clone.id_mapping[C] },
              );
              check(
                clonedTasks.every(
                  (t) =>
                    t.status === "Inbox" &&
                    t.due_date === null &&
                    t.due_at === null,
                ) &&
                  clonedLists.length === 2 &&
                  clonedLists.every(
                    (c) =>
                      ![first.entity_id, second.entity_id].includes(
                        c.checklist_id,
                      ) &&
                      c.items.every(
                        (i) =>
                          !i.checked &&
                          ![I1, I2, I3].includes(i.item_id) &&
                          i.promoted_task_id === null,
                      ),
                  ),
                "TEMPLATE_INSTANCE_MUST_RESET_INDEPENDENT_CHECKLIST_AND_WORKFLOW",
              );
              remember("template_instances", [clone.instance_id]);
              remember(
                "checklists",
                clonedLists.map((c) => c.checklist_id),
              );
              remember(
                "items",
                clonedLists.flatMap((c) => c.items.map((i) => i.item_id)),
              );
              remember(
                "edges",
                clonedTasks.flatMap((t) =>
                  t.prerequisites.map((e) => e.edge_id),
                ),
              );
              remember(
                "groups",
                clonedTasks.flatMap((t) =>
                  t.prerequisites.map((e) => e.group_id),
                ),
              );
              const templateReplay = await write(
                "task_template_instantiate_commit",
                instanceInput,
                undefined,
                instanceKey,
              );
              check(
                templateReplay.replayed === true &&
                  sameIds(
                    templateReplay.affected_task_ids,
                    Object.values(clone.id_mapping),
                  ),
                "TEMPLATE_RETRY_CREATED_SECOND_INSTANCE",
              );
              report.roles.template_root = clone.id_mapping[C];
              await passed(
                "nested_template_remaps_every_parent_edge_and_named_checklist_once",
              );

              step = "RECURRENCE_EXPLICIT_OWNER_RULE";
              const today = new Intl.DateTimeFormat("sv-SE", {
                timeZone: "Europe/Berlin",
                year: "numeric",
                month: "2-digit",
                day: "2-digit",
              }).format(new Date());
              const rule = await write("task_recurrence_create", {
                template_id: template.entity_id,
                title: prefix + "one configured occurrence",
                start_date: today,
                timezone: "Europe/Berlin",
                rrule: "FREQ=DAILY;COUNT=1",
              });
              report.roles.recurrence_rule = rule.entity_id;
              const run = await daily();
              check(
                run.delivered === 0 &&
                  run.cancelled === 0 &&
                  run.recurring.instances_created === 1 &&
                  run.recurring.task_ids.length === originalIds.length,
                "RECURRENCE_RUN_MUST_ONLY_CREATE_CONFIGURED_FIXTURE",
              );
              const recurring = await Promise.all(
                run.recurring.task_ids.map(task),
              );
              const recurringIds = run.recurring.task_ids;
              check(
                recurring.every(
                  (t) =>
                    !originalIds.includes(t.task_id) &&
                    !Object.values(clone.id_mapping).includes(t.task_id) &&
                    t.status === "Inbox" &&
                    t.start_date === today &&
                    t.due_date === null &&
                    t.due_at === null &&
                    (!t.parent_task_id ||
                      recurringIds.includes(t.parent_task_id)) &&
                    t.prerequisites.every((e) =>
                      recurringIds.includes(e.prerequisite_task_id),
                    ),
                ),
                "RECURRENCE_MUST_NOT_LINK_PRIOR_INSTANCES_OR_INVENT_DEADLINES",
              );
              const recurringRoot = recurring.find(
                (t) => t.title === prefix + "C checklist template root",
              );
              check(recurringRoot, "RECURRENCE_ROOT_READBACK_REQUIRED");
              const recurringLists = await query<ChecklistDTO[]>(
                "task_checklist_get",
                { task_id: recurringRoot.task_id },
              );
              check(
                recurringLists.length === 2 &&
                  recurringLists.every((c) => c.items.every((i) => !i.checked)),
                "RECURRENCE_CHECKLIST_RESET_WRONG",
              );
              remember(
                "checklists",
                recurringLists.map((c) => c.checklist_id),
              );
              remember(
                "items",
                recurringLists.flatMap((c) => c.items.map((i) => i.item_id)),
              );
              remember(
                "edges",
                recurring.flatMap((t) => t.prerequisites.map((e) => e.edge_id)),
              );
              remember(
                "groups",
                recurring.flatMap((t) =>
                  t.prerequisites.map((e) => e.group_id),
                ),
              );
              const instances = await query<
                PageDTO<{
                  instance_id: string;
                  occurrence_date: string;
                  task_ids: string[];
                }>
              >("task_recurrence_instances", { rule_id: rule.entity_id });
              check(
                instances.total === 1 &&
                  instances.items[0].occurrence_date === today &&
                  sameIds(instances.items[0].task_ids, recurringIds),
                "RECURRENCE_DURABLE_INSTANCE_READBACK_WRONG",
              );
              const secondRun = await daily();
              check(
                secondRun.delivered === 0 &&
                  secondRun.cancelled === 0 &&
                  secondRun.recurring.instances_created === 0 &&
                  (
                    await query<PageDTO<unknown>>("task_recurrence_instances", {
                      rule_id: rule.entity_id,
                    })
                  ).total === 1,
                "RECURRENCE_SECOND_JOB_DUPLICATED_INSTANCE",
              );
              report.roles.recurring_root = recurringRoot.task_id;
              await passed(
                "configured_finite_recurrence_runs_once_with_isolated_nested_instance",
              );
              return { A, X, prefix };
            }
            async function retainedFixture() {
              step = "RETAINED_SCOPE_PHASE_RESUME_READBACK";
              const prefix =
                "SYNTHETIC GRAPH PROOF " + report.run_id.slice(0, 8) + " ";
              const recurring = new Set(
                report.operations
                  .filter(
                    (op) =>
                      op.command === "owner_daily_job" &&
                      op.status === "accepted",
                  )
                  .flatMap((op) => {
                    const data = op.result?.data as
                      { recurring?: { task_ids?: string[] } } | undefined;
                    return data?.recurring?.task_ids ?? [];
                  }),
              );
              check(
                recurring.size === 5 &&
                  [...recurring].every((id) =>
                    report.created.tasks.includes(id),
                  ) &&
                  report.created.tasks.includes(report.roles.promoted) &&
                  !recurring.has(report.roles.promoted),
                "EXACT_PROMOTED_AND_RECURRING_CREATION_RECEIPTS_REQUIRED",
              );
              for (const id of report.created.tasks) {
                const current = await task(id);
                check(
                  current.task_id === id &&
                    current.title.startsWith(prefix) &&
                    current.project_id ===
                      (id === report.roles.promoted || recurring.has(id)
                        ? null
                        : report.roles.project) &&
                    current.archived_at === null,
                  "RETAINED_OWNER_FIXTURE_IDENTITY_REQUIRED",
                );
                resumedTasks.set(id, current);
                report.resume_tasks_verified = resumedTasks.size;
                await persist();
              }
              const A = report.roles["A ALL root"],
                X = report.roles["X ANY root"];
              check(
                report.created.tasks.includes(A) &&
                  report.created.tasks.includes(X),
                "RETAINED_CORE_ROLES_REQUIRED",
              );
              check(
                (await task(A)).started_at_risk && (await task(X)).ready_now,
                "RETAINED_FINAL_GRAPH_STATE_REQUIRED",
              );
              return { A, X, prefix };
            }
            const { A, X, prefix } = resume
              ? await retainedFixture()
              : await createFixture();

            step = "REMOTE_AUTH_AND_READONLY_SCOPE_DENIAL";
            reader = await connection(["tasks:read", "files:read"]);
            step = "REMOTE_AUTH_AND_READONLY_SCOPE_DENIAL";
            const readonlyRead = envelope(
              await tool("task_get", { task_id: A }, true),
            );
            check(
              (readonlyRead.data as TaskDTO)?.task_id === A,
              "READONLY_TOKEN_REAL_READ_FAILED",
            );
            const deniedKey = randomUUID(),
              deniedInput = { title: prefix + "MUST NEVER BE CREATED" };
            const deniedMcpOp: RecordedOperation = {
              command: "task_create",
              operation_id: deniedKey,
              input: deniedInput,
              status: "pending",
            };
            report.operations.push(deniedMcpOp);
            await persist();
            const denial = await tool(
              "task_create",
              { input: deniedInput, operation_id: deniedKey },
              true,
            );
            const deniedMcpData = envelope(denial).data as
              MutationResult | undefined;
            if (deniedMcpData?.entity_id) {
              // Preserve the exact synthetic ID even if a permission regression
              // unexpectedly accepts this negative security probe.
              deniedMcpOp.status = "accepted";
              deniedMcpOp.result = deniedMcpData;
              remember("tasks", [deniedMcpData.entity_id]);
              await persist();
            }
            check(
              denial.isError === true &&
                envelope(denial).error?.code === "INSUFFICIENT_PERMISSIONS",
              "REMOTE_MCP_READONLY_WRITE_NOT_DENIED",
            );
            deniedMcpOp.status = "denied";
            await persist();
            const deniedRestKey = randomUUID(),
              deniedRestOp: RecordedOperation = {
                command: "task_create",
                operation_id: deniedRestKey,
                input: deniedInput,
                status: "pending",
              };
            report.operations.push(deniedRestOp);
            await persist();
            const deniedRest = await restResponse(
              "/api/v1/commands",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": deniedRestKey,
                },
                body: JSON.stringify({
                  command: "task_create",
                  input: deniedInput,
                }),
              },
              "reader",
            );
            const deniedRestBody = (await deniedRest.json()) as {
              error?: { code: string };
              data?: MutationResult;
            };
            if (deniedRestBody.data?.entity_id) {
              deniedRestOp.status = "accepted";
              deniedRestOp.result = deniedRestBody.data;
              remember("tasks", [deniedRestBody.data.entity_id]);
              await persist();
            }
            check(
              deniedRest.status === 403 &&
                deniedRestBody.error?.code === "INSUFFICIENT_PERMISSIONS",
              "REMOTE_REST_READONLY_WRITE_NOT_DENIED",
            );
            deniedRestOp.status = "denied";
            await persist();
            const readPath =
              "/api/v1/query?" +
              new URLSearchParams({
                operation: "task_get",
                input: JSON.stringify({ task_id: A }),
              });
            check(
              (await restResponse(readPath, {}, "none")).status === 401,
              "REMOTE_UNAUTHENTICATED_READ_NOT_DENIED",
            );
            check(
              (await restResponse(readPath, {}, "invalid")).status === 401,
              "REMOTE_INVALID_BEARER_NOT_DENIED",
            );
            const unknownPath =
              "/api/v1/files/" +
              encodeURIComponent("F-synthetic-absent-" + report.run_id) +
              "/download";
            check(
              (await restResponse(unknownPath, {}, "reader")).status === 404,
              "REMOTE_UNKNOWN_FILE_NOT_FAIL_CLOSED",
            );
            check(
              (await restResponse(unknownPath, {}, "none")).status === 401,
              "REMOTE_UNAUTHENTICATED_FILE_NOT_DENIED",
            );
            await passed(
              "real_readonly_OAuth_REST_MCP_and_unauth_invalid_unknown_file_denials",
            );

            step = "FINAL_ACTIVE_FIXTURE_READBACK";
            for (
              let offset = 0;
              offset < report.created.tasks.length;
              offset += 5
            ) {
              const ids = report.created.tasks.slice(offset, offset + 5);
              // Independent reads may share the five-connection pool. Near
              // token expiry retain sequential renewal and journal persistence.
              const reads: TaskDTO[] = [];
              if (writer && writer.token.expiresAt - Date.now() > 30000)
                reads.push(...(await Promise.all(ids.map((id) => task(id)))));
              else for (const id of ids) reads.push(await task(id));
              for (const read of reads) {
                if (resume)
                  check(
                    JSON.stringify(read) ===
                      JSON.stringify(resumedTasks.get(read.task_id)),
                    "RETAINED_FIXTURE_CHANGED_DURING_SCOPE_PROOF",
                  );
                check(
                  read.archived_at === null,
                  "FIXTURE_MUST_REMAIN_ACTIVE_FOR_RESTORE_PROOF",
                );
                report.snapshots[read.task_id] = read;
              }
            }
            check(
              report.created.tasks.length === 21,
              "FIXTURE_TASK_COUNT_MUST_MATCH_EXACT_PLAN",
            );
            check(
              report.snapshots[A].started_at_risk &&
                report.snapshots[X].ready_now,
              "FINAL_GRAPH_DEMO_STATE_WRONG",
            );
            const receipts = new Map(
              report.operations
                .filter((op) => op.status === "accepted" && op.result)
                .map((op) => [op.result!.audit_event_id, op.result!]),
            );
            const missingReceipts = new Set(receipts.keys());
            let auditCursor: string | null = null;
            const auditCursors = new Set<string>();
            for (let page = 0; page < 50 && missingReceipts.size; page += 1) {
              const history: PageDTO<ActivityDTO> = await query(
                "get_activity",
                {
                  limit: 200,
                  ...(auditCursor ? { cursor: auditCursor } : {}),
                },
              );
              for (const event of history.items) {
                const receipt = receipts.get(event.event_id);
                if (
                  receipt &&
                  event.operation_id === receipt.operation_id &&
                  event.entity_id === receipt.entity_id
                )
                  missingReceipts.delete(event.event_id);
              }
              auditCursor = history.next_cursor;
              if (!auditCursor) break;
              check(!auditCursors.has(auditCursor), "PAGING_CURSOR_REPEATED");
              auditCursors.add(auditCursor);
            }
            check(
              receipts.size > 0 && missingReceipts.size === 0,
              "MCP_MUTATION_RECEIPTS_MUST_HAVE_DURABLE_REST_AUDIT",
            );
            report.verified_audit_receipts = receipts.size;
            await passed(
              "accepted_mutation_receipts_have_owner_bound_durable_audit",
            );
            report.status = "passed";
            delete report.failed_step;
            delete report.failed_check;
            delete report.failed_kind;
            report.completed_at = new Date().toISOString();
            await passed(
              "all_created_ids_retained_active_for_UI_hosted_restore_and_redeploy",
            );
          } catch (error) {
            report.status = "failed";
            report.failed_step = step;
            report.failed_kind =
              error instanceof Error &&
              [
                "Error",
                "TimeoutError",
                "AbortError",
                "TypeError",
                "SyntaxError",
                "StreamableHTTPError",
              ].includes(error.name)
                ? error.name
                : "Unknown";
            if (
              error instanceof Error &&
              /^[A-Z][A-Z0-9_]+$/.test(error.message)
            )
              report.failed_check = error.message;
            await persist();
            throw new Error(
              "PRODUCTION_GRAPH_PROOF_FAILED_AT_" +
                step +
                "; inspect private pending journal before any retry",
            );
          } finally {
            await writer?.client.close().catch(() => undefined);
            await reader?.client.close().catch(() => undefined);
          }
        },
        { repositoryRoot },
      );
    } catch (error) {
      // File admission/helper/SDK errors may include paths or response bodies. Redact.
      if (
        error instanceof Error &&
        /^PRODUCTION_GRAPH_PROOF_FAILED_AT_[A-Z_]+;/.test(error.message)
      )
        throw error;
      throw new Error(
        "PRODUCTION_GRAPH_ADMISSION_OR_TRANSPORT_FAILED; inspect private journal before any retry",
      );
    }
  },
  // Aggregate operator allowance follows the observed remote Stage latency
  // (the first five proof steps took359s). Each REST call keeps its30s bound;
  // graph assertions and the separate performance gates are unchanged.
  rehearsal ? 1200000 : 600000,
);
