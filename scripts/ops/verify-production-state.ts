import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Pool } from "pg";
import type { Database, SqlResult } from "../../server/db/database";
import { postgresConnectionUrl } from "../../server/db/connection-target";
import type { QueryName } from "../../shared/contracts";
import {
  prepareMigration,
  reconcileMigration,
  recordHash,
  type MigrationPreparation,
} from "../migration/core";
import { EXPECTED_PROJECT } from "./provision-secrets.mjs";
import { boundedSignIn } from "./bounded-signin.mjs";
import {
  admitPrivatePath,
  replacePinnedContents,
  verifyLinkedProject,
  withPrivateFile,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

export const PRODUCTION_STATE_ORIGIN = "https://ramin-life-os.vercel.app";
const REPORT_FORMAT = "ramin-life-os-production-state-verification/1";
type Row = Record<string, unknown>;
interface Arguments {
  source: string;
  cutoverReport: string;
  credentials: string;
  report: string;
  graphProof?: string;
}
interface Dependencies {
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
  database?: (url: string) => Database;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}
class VerificationError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}
function check(value: unknown, code: string): asserts value {
  if (!value) throw new VerificationError(code);
}
function object(value: unknown): value is Row {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Named arguments are mandatory; no ordinary invocation can sign into production. */
export function parseProductionStateArguments(args: string[]): Arguments {
  check(
    args[0] === "--verify-production-state",
    "EXPLICIT_PRODUCTION_STATE_INTENT_REQUIRED",
  );
  const allowed = new Map([
    ["--source", "source"],
    ["--cutover-report", "cutoverReport"],
    ["--credentials", "credentials"],
    ["--report", "report"],
    ["--graph-proof", "graphProof"],
  ]);
  const result: Row = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = allowed.get(args[index]),
      value = args[index + 1];
    check(
      key && !Object.hasOwn(result, key) && value && !value.startsWith("--"),
      "NAMED_PRIVATE_VERIFICATION_ARGUMENTS_REQUIRED",
    );
    result[key] = value;
  }
  check(
    ["source", "cutoverReport", "credentials", "report"].every(
      (key) => typeof result[key] === "string",
    ),
    "NAMED_PRIVATE_VERIFICATION_ARGUMENTS_REQUIRED",
  );
  return result as unknown as Arguments;
}

/** Exact algorithm used by the cutover intent; credentials and query parameters are excluded. */
export function productionDestinationHash(url: string): string {
  let parsed: URL;
  try {
    parsed = postgresConnectionUrl(url);
  } catch {
    throw new VerificationError("POSTGRES_DESTINATION_INVALID");
  }
  check(
    ["postgres:", "postgresql:"].includes(parsed.protocol) &&
      parsed.hostname &&
      parsed.pathname.slice(1),
    "POSTGRES_DESTINATION_INVALID",
  );
  return recordHash({
    host: parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, ""),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.slice(1)),
  });
}

function nativeReadOnlyDatabase(url: string): Database {
  const parsed = postgresConnectionUrl(url);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (!local) parsed.searchParams.set("sslmode", "verify-full");
  // The operator does not use getDatabase/migrateDatabase or a domain command.
  // The connection itself denies writes, including an accidental future query.
  parsed.searchParams.delete("options");
  const pool = new Pool({
    connectionString: parsed.toString(),
    max: 1,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 10000,
    query_timeout: 15000,
    ssl: local ? undefined : { rejectUnauthorized: true },
    options: "-c default_transaction_read_only=on -c statement_timeout=15000",
  });
  pool.on("error", () => {});
  return {
    async query<T = Row>(
      sql: string,
      params: unknown[] = [],
    ): Promise<SqlResult<T>> {
      check(
        /^\s*SELECT\s/i.test(sql) && !sql.includes(";"),
        "READ_ONLY_SQL_REQUIRED",
      );
      const result = await pool.query(sql, params);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
    async transaction() {
      throw new VerificationError("READ_ONLY_SQL_REQUIRED");
    },
    close: () => pool.end(),
  };
}

async function privateJson(
  path: string,
  repositoryRoot: string,
): Promise<unknown> {
  return withPrivateFile(
    path,
    async (file) => {
      check(
        (await file.stat()).size <= 64 * 1024 * 1024,
        "PRIVATE_INPUT_SIZE_EXCEEDED",
      );
      try {
        return JSON.parse(await file.readFile("utf8"));
      } catch {
        throw new VerificationError("PRIVATE_INPUT_JSON_INVALID");
      }
    },
    { repositoryRoot },
  );
}
function normalize(value: unknown, field = ""): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && field.endsWith("_at") && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (field === "size_bytes" && value !== null && value !== undefined)
    return String(value);
  if (Array.isArray(value)) return value.map((item) => normalize(item));
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, normalize(item, key)]),
    );
  return value;
}
function select(row: Row, fields: readonly string[]) {
  return Object.fromEntries(
    fields.map((key) => [key, normalize(row[key], key)]),
  );
}
const TASK_FIELDS = [
  "task_id",
  "owner_id",
  "project_id",
  "parent_task_id",
  "title",
  "status",
  "priority",
  "category",
  "notes",
  "next_action",
  "waiting_for",
  "source_reference",
  "start_date",
  "due_date",
  "due_at",
  "timezone",
  "estimated_minutes",
  "sort_key",
  "completed_at",
  "closed_at",
  "archived_at",
  "created_at",
  "updated_at",
  "revision",
  "legacy_metadata",
] as const;
const FILE_FIELDS = [
  "file_id",
  "owner_id",
  "title",
  "original_filename",
  "provider",
  "external_id",
  "external_url",
  "storage_key",
  "state",
  "mime_type",
  "size_bytes",
  "sha256",
  "version_group_id",
  "parent_id",
  "last_active_parent_id",
  "protected",
  "archived_at",
  "created_at",
  "updated_at",
  "revision",
  "legacy_metadata",
] as const;
const GRAPH_FIELDS = [
  ...TASK_FIELDS,
  "readiness",
  "ready_now",
  "earliest_allowed_start",
  "blocked_by",
  "started_at_risk",
  "warnings",
  "prerequisites",
  "unblocks",
  "checklist_progress",
  "children_progress",
  "checklists",
  "subtasks",
] as const;
function fieldsMatch(
  actual: Row,
  expected: Row,
  fields: readonly string[],
  code: string,
) {
  check(
    recordHash(select(actual, fields)) === recordHash(select(expected, fields)),
    code,
  );
}
interface GraphProof {
  run_id: string;
  snapshots: Record<string, Row>;
}
function admittedGraph(
  value: unknown,
  owner: string,
  sourceIds: string[],
): GraphProof {
  check(
    object(value) &&
      value.format === "ramin-life-os-production-graph-proof/1" &&
      value.status === "passed" &&
      value.proof_mode === "production" &&
      value.origin === PRODUCTION_STATE_ORIGIN &&
      typeof value.run_id === "string" &&
      /^[0-9a-f-]{36}$/i.test(value.run_id) &&
      object(value.snapshots) &&
      object(value.created) &&
      Array.isArray(value.created.tasks),
    "PASSED_PRODUCTION_GRAPH_PROOF_REQUIRED",
  );
  const snapshots = value.snapshots;
  const ids = Object.keys(snapshots);
  const prefix = "SYNTHETIC GRAPH PROOF " + value.run_id.slice(0, 8) + " ";
  check(
    ids.length === 21 &&
      new Set(value.created.tasks).size === 21 &&
      recordHash([...value.created.tasks].sort()) ===
        recordHash([...ids].sort()) &&
      ids.every((id) => {
        const row = snapshots[id];
        return (
          object(row) &&
          row.task_id === id &&
          row.owner_id === owner &&
          typeof row.title === "string" &&
          row.title.startsWith(prefix) &&
          row.archived_at === null &&
          !sourceIds.includes(id)
        );
      }),
    "EXACT_RETAINED_SYNTHETIC_GRAPH_REQUIRED",
  );
  return { run_id: value.run_id, snapshots: snapshots as Record<string, Row> };
}

async function originalRows(
  database: Database,
  owner: string,
  prepared: MigrationPreparation,
) {
  const taskIds = prepared.tables.Tasks.map((row) => String(row.task_id));
  const fileIds = prepared.tables.Files.map((row) =>
    String(row.file_record_id),
  );
  // DATE::text is independent of the client's DATE parser and host timezone.
  const tasks = (
    await database.query<Row>(
      "SELECT *,due_date::text AS due_date,start_date::text AS start_date FROM tasks WHERE owner_id=$1 AND task_id=ANY($2::text[])",
      [owner, taskIds],
    )
  ).rows;
  const files = (
    await database.query<Row>(
      "SELECT * FROM files WHERE owner_id=$1 AND file_id=ANY($2::text[])",
      [owner, fileIds],
    )
  ).rows;
  check(
    tasks.length === taskIds.length && files.length === fileIds.length,
    "ORIGINAL_NATIVE_IDENTITIES_MISSING",
  );
  const dates = new Map(
    tasks.map((row) => [String(row.task_id), row.due_date]),
  );
  check(
    prepared.tables.Tasks.every(
      (row) =>
        dates.get(String(row.task_id)) ===
        (row.due_date === "" || row.due_date === undefined
          ? null
          : row.due_date),
    ),
    "ORIGINAL_NATIVE_DATE_LABEL_CHANGED",
  );
  const relations = (
    await database.query<Row>(
      `SELECT
      (SELECT count(*)::integer FROM tasks WHERE owner_id=$1 AND (task_id=ANY($2::text[]) AND parent_task_id IS NOT NULL OR parent_task_id=ANY($2::text[]))) AS parents,
      (SELECT count(*)::integer FROM task_dependency_groups WHERE owner_id=$1 AND dependent_task_id=ANY($2::text[])) AS groups,
      (SELECT count(*)::integer FROM task_dependency_edges e JOIN task_dependency_groups g ON g.group_id=e.group_id AND g.owner_id=e.owner_id WHERE e.owner_id=$1 AND (e.prerequisite_task_id=ANY($2::text[]) OR g.dependent_task_id=ANY($2::text[]))) AS edges,
      (SELECT count(*)::integer FROM task_checklists WHERE owner_id=$1 AND task_id=ANY($2::text[])) AS checklists,
      (SELECT count(*)::integer FROM task_checklist_items i JOIN task_checklists c ON c.checklist_id=i.checklist_id AND c.owner_id=i.owner_id WHERE i.owner_id=$1 AND c.task_id=ANY($2::text[])) AS items`,
      [owner, taskIds],
    )
  ).rows[0];
  check(
    relations && Object.values(relations).every((count) => Number(count) === 0),
    "ORIGINAL_RELATIONSHIP_FABRICATION_DETECTED",
  );
  return { tasks, files };
}

/** Coordinator-only read verification. Injected engines/HTTP are author-test fixtures, not production evidence. */
export async function verifyProductionState(
  args: string[],
  dependencies: Dependencies = {},
) {
  const input = parseProductionStateArguments(args);
  const repositoryRoot =
    dependencies.repositoryRoot ??
    fileURLToPath(new URL("../../", import.meta.url));
  const options = { repositoryRoot };
  const paths: Arguments = {
    source: await admitPrivatePath(input.source, {
      ...options,
      mustExist: true,
    }),
    cutoverReport: await admitPrivatePath(input.cutoverReport, {
      ...options,
      mustExist: true,
    }),
    credentials: await admitPrivatePath(input.credentials, {
      ...options,
      mustExist: true,
    }),
    report: await admitPrivatePath(input.report, options),
    ...(input.graphProof
      ? {
          graphProof: await admitPrivatePath(input.graphProof, {
            ...options,
            mustExist: true,
          }),
        }
      : {}),
  };
  check(
    new Set(Object.values(paths).map((path) => path.toLowerCase())).size ===
      Object.keys(paths).length,
    "DISTINCT_PRIVATE_INPUT_AND_REPORT_PATHS_REQUIRED",
  );
  await verifyLinkedProject(repositoryRoot, EXPECTED_PROJECT);
  const environment = dependencies.environment ?? process.env;
  check(
    environment.BETTER_AUTH_URL === PRODUCTION_STATE_ORIGIN,
    "EXACT_PRODUCTION_ORIGIN_REQUIRED",
  );
  const owner = environment.OWNER_ID,
    databaseUrl = environment.DATABASE_URL;
  check(
    typeof owner === "string" &&
      owner.trim() &&
      typeof databaseUrl === "string" &&
      databaseUrl,
    "PRODUCTION_OWNER_AND_DATABASE_REQUIRED",
  );
  const prepared = prepareMigration(
    await privateJson(paths.source, repositoryRoot),
  );
  check(prepared.ready, "SOURCE_VALIDATION_FAILED");
  const cutover = await privateJson(paths.cutoverReport, repositoryRoot);
  const destination = productionDestinationHash(databaseUrl);
  check(
    object(cutover) &&
      cutover.format === "ramin-life-os-migration-cutover/1" &&
      ["accepted", "verified"].includes(String(cutover.status)) &&
      cutover.source_hash === prepared.sourceHash &&
      cutover.batch_id === prepared.batchId &&
      cutover.owner_id === owner &&
      cutover.destination_hash === destination,
    "ACCEPTED_CUTOVER_INTENT_BINDING_REQUIRED",
  );
  // Deliberately no 10-minute/live-source freshness admission: this reads the known
  // immutable import snapshot after a redeploy; it does not authorize another import.
  const credentials = await privateJson(paths.credentials, repositoryRoot);
  check(
    object(credentials) &&
      typeof credentials.email === "string" &&
      credentials.email.length > 0 &&
      credentials.email.length <= 320 &&
      typeof credentials.password === "string" &&
      credentials.password.length > 0 &&
      credentials.password.length <= 10000,
    "PRIVATE_OWNER_CREDENTIALS_INVALID",
  );
  const loginCredentials = {
    email: credentials.email as string,
    password: credentials.password as string,
  };
  const graph = paths.graphProof
    ? admittedGraph(
        await privateJson(paths.graphProof, repositoryRoot),
        owner,
        prepared.tables.Tasks.map((row) => String(row.task_id)),
      )
    : undefined;
  const now = dependencies.now ?? Date.now;
  const report: Row = {
    format: REPORT_FORMAT,
    status: "pending",
    evidence_mode:
      dependencies.database || dependencies.fetch
        ? "author_fixture_not_production"
        : "native_postgres_and_first_party_https",
    origin: PRODUCTION_STATE_ORIGIN,
    started_at: new Date(now()).toISOString(),
    intent: {
      owner_id: owner,
      destination_hash: destination,
      source_hash: prepared.sourceHash,
      batch_id: prepared.batchId,
    },
    source_counts: prepared.counts,
    graph_selected: !!graph,
    source_written: false,
    domain_writes: false,
    steps: [],
  };
  // A NEW wx file is durable before acquiring any connection or authentication.
  await writeExclusivePrivateJson(paths.report, report, options);
  return withPrivateFile(
    paths.report,
    async (file) => {
      let database: Database | undefined;
      const persist = () =>
        replacePinnedContents(file, JSON.stringify(report, null, 2) + "\n");
      try {
        database = (dependencies.database ?? nativeReadOnlyDatabase)(
          databaseUrl,
        );
        const reconciliation = await reconcileMigration(
          database,
          owner,
          prepared,
        );
        report.native_reconciliation = reconciliation;
        check(reconciliation.pass, "ORIGINAL_CANONICAL_RECONCILIATION_FAILED");
        const originals = await originalRows(database, owner, prepared);
        (report.steps as string[]).push(
          "native_source_fields_dates_relationships_verified",
        );
        await persist();
        const request = dependencies.fetch ?? globalThis.fetch;
        const login = await boundedSignIn(
          PRODUCTION_STATE_ORIGIN,
          loginCredentials,
          { fetch: request },
        );
        check(login.ok, "FIRST_PARTY_OWNER_SIGN_IN_FAILED");
        const cookie = login.headers
          .getSetCookie()
          .map((line) => line.split(";")[0])
          .join("; ");
        check(
          cookie.length > 0 && !/[\r\n]/.test(cookie),
          "FIRST_PARTY_OWNER_SESSION_REQUIRED",
        );
        // The cookie exists only in memory; response headers/bodies are never persisted.
        const deadline = now() + 5 * 60000;
        async function query(
          operation: QueryName,
          data: Row = {},
        ): Promise<Row> {
          check(now() < deadline, "CANONICAL_API_READ_BUDGET_EXCEEDED");
          let response: Response;
          try {
            response = await request(
              PRODUCTION_STATE_ORIGIN +
                "/api/v1/query?" +
                new URLSearchParams({
                  operation,
                  input: JSON.stringify(data),
                }),
              {
                method: "GET",
                redirect: "manual",
                headers: { Cookie: cookie },
                signal: AbortSignal.timeout(
                  Math.min(15000, Math.max(1, deadline - now())),
                ),
              },
            );
          } catch {
            throw new VerificationError("CANONICAL_API_TRANSPORT_FAILED");
          }
          check(response.ok, "CANONICAL_OWNER_API_READ_FAILED");
          const text = await response.text();
          check(
            Buffer.byteLength(text, "utf8") <= 2_000_000,
            "CANONICAL_API_RESPONSE_SIZE_EXCEEDED",
          );
          let body: unknown;
          try {
            body = JSON.parse(text);
          } catch {
            throw new VerificationError("CANONICAL_API_RESPONSE_INVALID");
          }
          check(
            object(body) && object(body.data),
            "CANONICAL_API_RESPONSE_INVALID",
          );
          return body.data;
        }
        check(
          (await query("whoami")).owner_id === owner,
          "FIRST_PARTY_OWNER_ID_MISMATCH",
        );
        for (const expected of originals.tasks) {
          const actual = await query("task_get", { task_id: expected.task_id });
          fieldsMatch(
            actual,
            expected,
            TASK_FIELDS,
            "ORIGINAL_TASK_API_NATIVE_MISMATCH",
          );
          check(
            Array.isArray(actual.prerequisites) &&
              actual.prerequisites.length === 0 &&
              Array.isArray(actual.checklists) &&
              actual.checklists.length === 0 &&
              Array.isArray(actual.subtasks) &&
              actual.subtasks.length === 0,
            "ORIGINAL_API_RELATIONSHIP_FABRICATION_DETECTED",
          );
        }
        report.api_tasks_verified = originals.tasks.length;
        for (const expected of originals.files) {
          const actual = await query("file_get_metadata", {
            file_id: expected.file_id,
          });
          fieldsMatch(
            actual,
            expected,
            FILE_FIELDS,
            "ORIGINAL_FILE_API_NATIVE_MISMATCH",
          );
        }
        report.api_files_verified = originals.files.length;
        (report.steps as string[]).push(
          "first_party_owner_and_every_source_task_file_api_verified",
        );
        await persist();
        if (graph) {
          const ids = Object.keys(graph.snapshots);
          const native = (
            await database.query<Row>(
              "SELECT *,due_date::text AS due_date,start_date::text AS start_date FROM tasks WHERE owner_id=$1 AND task_id=ANY($2::text[])",
              [owner, ids],
            )
          ).rows;
          check(
            native.length === 21,
            "RETAINED_GRAPH_NATIVE_IDENTITIES_MISSING",
          );
          const byId = new Map(native.map((row) => [String(row.task_id), row]));
          for (const [id, expected] of Object.entries(graph.snapshots)) {
            const actual = await query("task_get", { task_id: id });
            fieldsMatch(
              actual,
              expected,
              GRAPH_FIELDS,
              "RETAINED_GRAPH_API_SNAPSHOT_MISMATCH",
            );
            fieldsMatch(
              actual,
              byId.get(id)!,
              TASK_FIELDS,
              "RETAINED_GRAPH_API_NATIVE_MISMATCH",
            );
          }
          report.graph_tasks_verified = ids.length;
          report.graph_run_id = graph.run_id;
          (report.steps as string[]).push(
            "retained_21_graph_api_snapshots_and_native_tasks_verified",
          );
        } else report.graph_tasks_verified = 0;
        const finalReconciliation = await reconcileMigration(
          database,
          owner,
          prepared,
        );
        check(
          finalReconciliation.pass,
          "ORIGINAL_SOURCE_CHANGED_DURING_VERIFICATION",
        );
        await originalRows(database, owner, prepared);
        report.final_native_reconciliation = finalReconciliation;
        report.status = "passed";
        report.completed_at = new Date(now()).toISOString();
        await persist();
        return {
          status: "passed" as const,
          source_counts: prepared.counts,
          api_tasks_verified: originals.tasks.length,
          api_files_verified: originals.files.length,
          graph_tasks_verified: graph ? 21 : 0,
          source_written: false,
          domain_writes: false,
        };
      } catch (error) {
        report.status = "failed";
        report.failed_check =
          error instanceof VerificationError
            ? error.code
            : "VERIFICATION_INTERNAL_FAILURE";
        report.completed_at = new Date(now()).toISOString();
        await persist();
        throw new VerificationError(String(report.failed_check));
      } finally {
        await database?.close?.();
      }
    },
    options,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  verifyProductionState(process.argv.slice(2))
    .then((result) => {
      // Only fixed labels/counts go to stdout; identities/values remain private.
      console.log(JSON.stringify(result));
    })
    .catch(() => {
      console.error(
        "PRODUCTION_STATE_VERIFICATION_FAILED_INSPECT_PRIVATE_REPORT",
      );
      process.exitCode = 1;
    });
}
