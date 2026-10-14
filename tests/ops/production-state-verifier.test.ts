import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { postgresConnectionUrl } from "../../server/db/connection-target";
import {
  parseProductionStateArguments,
  productionDestinationHash,
  PRODUCTION_STATE_ORIGIN,
  verifyProductionState,
} from "../../scripts/ops/verify-production-state";
import { EXPECTED_PROJECT } from "../../scripts/ops/provision-secrets.mjs";
import { createTestDatabase } from "../domain/database";
import { syntheticSnapshot } from "../migration/fixtures";
import {
  importPrepared,
  prepareMigration,
  recordHash,
} from "../../scripts/migration/core";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type { Principal, QueryName, TaskDTO } from "../../shared/contracts";

let folder: string, repository: string, privateDir: string;
let sourcePath: string,
  cutoverPath: string,
  credentialPath: string,
  reportPath: string;
let database: Database;
const owner = "synthetic-verifier-owner";
const fixtureUrl = new URL(
  "postgresql://synthetic-production.neon.invalid/fixture",
);
fixtureUrl.username = "synthetic-user";
fixtureUrl.password = "synthetic-db-secret";
const url = fixtureUrl.toString();
const principal: Principal = {
  ownerId: owner,
  actorId: owner,
  channel: "UI",
  scopes: ["admin:manage"],
};
const syntheticCredentials = {
  email: "synthetic-verifier@example.invalid",
  password: "synthetic-private-pass-not-for-report",
};
const cookie = "synthetic-cookie-not-for-report";
const source = () => syntheticSnapshot();
const args = (graph?: string) => [
  "--verify-production-state",
  "--source",
  sourcePath,
  "--cutover-report",
  cutoverPath,
  "--credentials",
  credentialPath,
  "--report",
  reportPath,
  ...(graph ? ["--graph-proof", graph] : []),
];
const environment = () => ({
  OWNER_ID: owner,
  DATABASE_URL: url,
  BETTER_AUTH_URL: PRODUCTION_STATE_ORIGIN,
});
async function changeCutover(patch: Record<string, unknown>) {
  await writeFile(
    cutoverPath,
    JSON.stringify({
      ...JSON.parse(await readFile(cutoverPath, "utf8")),
      ...patch,
    }),
  );
}
function dependencies() {
  const service = createDomainService(database);
  const observedSql: string[] = [];
  const acquisition = vi.fn((): Database => ({
    query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => {
      if (!/^\s*SELECT\s/i.test(sql))
        throw new Error("FIXTURE_VERIFIER_WRITE_ATTEMPT");
      observedSql.push(sql);
      return database.query<T>(sql, params);
    },
    transaction: vi.fn(async () => {
      throw new Error("FIXTURE_VERIFIER_TRANSACTION_ATTEMPT");
    }),
    close: vi.fn(async () => {}),
  }));
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const target = new URL(String(input));
    if (target.origin !== PRODUCTION_STATE_ORIGIN)
      throw new Error("FIXTURE_FOREIGN_ORIGIN");
    if (target.pathname === "/api/auth/sign-in/email") {
      expect(init?.redirect).toBe("manual");
      expect(init?.method).toBe("POST");
      return Response.json(
        {},
        {
          headers: {
            "Set-Cookie": `synthetic-session=${cookie}; HttpOnly; Secure`,
          },
        },
      );
    }
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("manual");
    expect(new Headers(init?.headers).get("cookie")).toBe(
      `synthetic-session=${cookie}`,
    );
    expect(target.pathname).toBe("/api/v1/query");
    const operation = target.searchParams.get("operation") as QueryName;
    const value = JSON.parse(target.searchParams.get("input") ?? "{}");
    const result = await service.query(operation, value, principal);
    return Response.json({ data: result, request_id: "synthetic-request" });
  });
  return {
    repositoryRoot: repository,
    environment: environment(),
    database: acquisition,
    fetch: request,
    observedSql,
  };
}
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "life-os-state-admission-"));
  repository = join(folder, "repository");
  privateDir = join(folder, "private");
  await mkdir(repository);
  await mkdir(privateDir);
  await mkdir(join(repository, ".vercel"));
  await writeFile(
    join(repository, ".vercel", "project.json"),
    JSON.stringify(EXPECTED_PROJECT),
  );
  sourcePath = join(privateDir, "source.json");
  cutoverPath = join(privateDir, "cutover.json");
  credentialPath = join(privateDir, "credentials.json");
  reportPath = join(privateDir, "verification.json");
  const snapshot = source(),
    prepared = prepareMigration(snapshot);
  await writeFile(sourcePath, JSON.stringify(snapshot));
  await writeFile(credentialPath, JSON.stringify(syntheticCredentials));
  await writeFile(
    cutoverPath,
    JSON.stringify({
      format: "ramin-life-os-migration-cutover/1",
      status: "verified",
      owner_id: owner,
      source_hash: prepared.sourceHash,
      batch_id: prepared.batchId,
      destination_hash: productionDestinationHash(url),
      checkpoint: { verified_at: "2000-01-01T00:00:00Z" },
    }),
  );
  database = await createTestDatabase();
  await importPrepared(createDomainService(database), prepared, {
    ...principal,
    channel: "import",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("AUTHOR_TEST_MUST_NOT_USE_LIVE_HTTP");
    }),
  );
}, 30000);
afterEach(async () => {
  await database?.close?.();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  const canonical = await realpath(folder),
    parent = await realpath(tmpdir());
  if (
    !canonical
      .toLowerCase()
      .startsWith(join(parent, "life-os-state-admission-").toLowerCase())
  )
    throw new Error("Unsafe operator fixture cleanup.");
  await rm(canonical, { recursive: true, force: true });
});

describe("author-only admission and native PostgreSQL-engine fixtures; mocked HTTPS is not production evidence", () => {
  it("requires the exact intent, complete named paths and no duplicate or unknown argument before any provider", async () => {
    const deps = dependencies();
    for (const invalid of [
      args().slice(1),
      [...args(), "--unknown", reportPath],
      [...args(), "--source", sourcePath],
      args().slice(0, -2),
      [...args(), "extra"],
    ])
      await expect(verifyProductionState(invalid, deps)).rejects.toThrow(
        /INTENT|ARGUMENTS/,
      );
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(parseProductionStateArguments(args()).report).toBe(reportPath);
  });
  it("uses the same normalized endpoint hash as cutover and distinguishes a restored staging endpoint", () => {
    expect(productionDestinationHash(url)).toBe(
      recordHash({
        host: "synthetic-production.neon.invalid",
        port: "5432",
        database: "fixture",
      }),
    );
    const variant = new URL(url);
    variant.hostname = "SYNTHETIC-PRODUCTION-pooler.neon.invalid";
    variant.username = "other";
    variant.password = "other";
    variant.port = "5432";
    variant.searchParams.set("sslmode", "require");
    expect(productionDestinationHash(variant.toString())).toBe(
      productionDestinationHash(url),
    );
    expect(
      productionDestinationHash(url.replace("production", "staging")),
    ).not.toBe(productionDestinationHash(url));
    for (const invalid of [
      "https://example.invalid/fixture",
      "postgresql://localhost/",
    ])
      expect(() => productionDestinationHash(invalid)).toThrow(
        "POSTGRES_DESTINATION_INVALID",
      );
  });
  it("rejects relative, public and junction paths before database acquisition or authentication", async () => {
    const deps = dependencies();
    const junction = join(privateDir, "public-junction");
    await symlink(repository, junction, "junction");
    for (const path of [
      "relative.json",
      join(repository, "report.json"),
      join(junction, "report.json"),
    ]) {
      const invalid = args();
      invalid[invalid.indexOf("--report") + 1] = path;
      await expect(verifyProductionState(invalid, deps)).rejects.toThrow(
        /absolute|outside Git/,
      );
    }
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("rejects pg query-routing overrides before DB/auth and pins the actual driver port despite PGPORT", async () => {
    const deps = dependencies();
    const redirected = new URL(url);
    redirected.searchParams.set("host", "synthetic-staging.neon.invalid");
    redirected.searchParams.set("port", "5433");
    const unsafe = new Client({ connectionString: redirected.toString() });
    const unsafeParameters = Reflect.get(unsafe, "connectionParameters") as {
      host: string;
      port: number;
    };
    expect(unsafeParameters.host).toBe("synthetic-staging.neon.invalid");
    expect(unsafeParameters.port).toBe(5433);
    for (const key of [
      "host",
      "HOST",
      "hostaddr",
      "port",
      "database",
      "dbname",
      "user",
      "password",
      "service",
      "servicefile",
      "path",
      "connectionString",
    ]) {
      const value = new URL(url);
      value.searchParams.set(key, "synthetic-other-route");
      await expect(
        verifyProductionState(args(), {
          ...deps,
          environment: { ...environment(), DATABASE_URL: value.toString() },
        }),
      ).rejects.toThrow("POSTGRES_DESTINATION_INVALID");
    }
    vi.stubEnv("PGPORT", "5433");
    const admitted = postgresConnectionUrl(url);
    const pinned = new Client({ connectionString: admitted.toString() });
    const pinnedParameters = Reflect.get(pinned, "connectionParameters") as {
      host: string;
      port: number;
    };
    expect(pinnedParameters.host).toBe("synthetic-production.neon.invalid");
    expect(pinnedParameters.port).toBe(5432);
    expect(admitted.port).toBe("5432");
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("rejects a hardlinked credential file without exposing its contents", async () => {
    await link(credentialPath, join(privateDir, "credential-alias.json"));
    const deps = dependencies();
    await expect(verifyProductionState(args(), deps)).rejects.toThrow(
      /unlinked/,
    );
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.database).not.toHaveBeenCalled();
  });
  it("rejects each mismatched linked project, team and name before connecting", async () => {
    const deps = dependencies();
    for (const patch of [
      { projectId: "synthetic-wrong-project" },
      { orgId: "synthetic-wrong-team" },
      { name: "synthetic-wrong-name" },
    ]) {
      await writeFile(
        join(repository, ".vercel", "project.json"),
        JSON.stringify({ ...EXPECTED_PROJECT, ...patch }),
      );
      await expect(verifyProductionState(args(), deps)).rejects.toThrow(
        /mismatch/,
      );
    }
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("rejects production origin aliases rather than following redirects", async () => {
    const deps = dependencies();
    for (const origin of [
      PRODUCTION_STATE_ORIGIN + "/",
      PRODUCTION_STATE_ORIGIN + ":443",
      "http://ramin-life-os.vercel.app",
      "https://example.invalid",
    ])
      await expect(
        verifyProductionState(args(), {
          ...deps,
          environment: { ...environment(), BETTER_AUTH_URL: origin },
        }),
      ).rejects.toThrow("EXACT_PRODUCTION_ORIGIN_REQUIRED");
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("binds the accepted cutover owner, source hash, batch and destination even when staging has identical rows", async () => {
    const deps = dependencies(),
      original = await readFile(cutoverPath, "utf8");
    for (const patch of [
      { owner_id: "synthetic-other-owner" },
      { source_hash: "0".repeat(64) },
      { batch_id: "synthetic-other-batch" },
      {
        destination_hash: productionDestinationHash(
          url.replace("production", "staging"),
        ),
      },
      { status: "pending" },
      { status: "reconciliation_required" },
    ]) {
      await writeFile(cutoverPath, original);
      await changeCutover(patch);
      await expect(verifyProductionState(args(), deps)).rejects.toThrow(
        "ACCEPTED_CUTOVER_INTENT_BINDING_REQUIRED",
      );
    }
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("never overwrites an existing verification report and makes no connection", async () => {
    const prior = '{"status":"pending","preserve":"synthetic prior intent"}\n';
    await writeFile(reportPath, prior);
    const deps = dependencies();
    await expect(verifyProductionState(args(), deps)).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(await readFile(reportPath, "utf8")).toBe(prior);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("durably reserves pending private evidence before opening a native connection", async () => {
    const deps = dependencies();
    let pending = false;
    const acquisition = vi.fn(() => {
      pending =
        JSON.parse(readFileSync(reportPath, "utf8")).status === "pending";
      throw new Error(syntheticCredentials.password + " " + cookie);
    });
    await expect(
      verifyProductionState(args(), { ...deps, database: acquisition }),
    ).rejects.toThrow("VERIFICATION_INTERNAL_FAILURE");
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(pending).toBe(true);
    expect(report).toMatchObject({
      status: "failed",
      evidence_mode: "author_fixture_not_production",
      failed_check: "VERIFICATION_INTERNAL_FAILURE",
    });
    expect(report.started_at).toBeTruthy();
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(report)).not.toContain(syntheticCredentials.password);
    expect(JSON.stringify(report)).not.toContain(cookie);
  });
  it("reads an old known import snapshot without reauthorizing an import, preserves native rows and labels mocked HTTP evidence", async () => {
    const deps = dependencies();
    const before = (
      await database.query("SELECT * FROM activity_events ORDER BY event_id")
    ).rows;
    const result = await verifyProductionState(args(), deps);
    expect(result).toMatchObject({
      status: "passed",
      api_tasks_verified: 2,
      api_files_verified: 1,
      graph_tasks_verified: 0,
      source_written: false,
      domain_writes: false,
    });
    expect(
      (await database.query("SELECT * FROM activity_events ORDER BY event_id"))
        .rows,
    ).toEqual(before);
    expect(deps.database).toHaveBeenCalledOnce();
    const acquired = deps.database.mock.results[0].value;
    expect(acquired.transaction).not.toHaveBeenCalled();
    expect(deps.observedSql.every((sql) => /^\s*SELECT\s/i.test(sql))).toBe(
      true,
    );
    expect(deps.observedSql.some((sql) => sql.includes("due_date::text"))).toBe(
      true,
    );
    const serialized = await readFile(reportPath, "utf8"),
      report = JSON.parse(serialized);
    expect(report).toMatchObject({
      status: "passed",
      evidence_mode: "author_fixture_not_production",
    });
    for (const secret of [
      syntheticCredentials.email,
      syntheticCredentials.password,
      cookie,
      "synthetic-db-secret",
    ])
      expect(serialized).not.toContain(secret);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("detects canonical task corruption even when the retained legacy row still matches", async () => {
    await database.query(
      "UPDATE tasks SET notes='synthetic canonical corruption' WHERE task_id=$1",
      [source().tables.Tasks[0].task_id],
    );
    const deps = dependencies();
    await expect(verifyProductionState(args(), deps)).rejects.toThrow(
      "ORIGINAL_CANONICAL_RECONCILIATION_FAILED",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    expect(
      report.native_reconciliation.results.Tasks.canonical_mismatches[
        "T-synthetic-one"
      ],
    ).toContain("notes");
  });
  it.each([
    [
      "links",
      "UPDATE file_task_links SET purpose='Output' WHERE link_id='L-synthetic-one'",
    ],
    [
      "historical activity",
      "UPDATE activity_events SET actor_id='synthetic corrupted actor' WHERE event_id='E-synthetic-one'",
    ],
    ["preserved preferences", "UPDATE preferences SET settings='{}'::jsonb"],
  ])(
    "detects actual isolated SQL corruption of %s before sign-in",
    async (_label, sql) => {
      if (_label === "historical activity") {
        // A damaged-restore fixture only: the production append-only trigger is
        // untouched. Ordinary UPDATE denial is proved before fault injection.
        await expect(database.query(sql)).rejects.toThrow(/append-only/);
        await database.query(
          "ALTER TABLE activity_events DISABLE TRIGGER USER",
        );
      }
      await database.query(sql);
      if (_label === "historical activity")
        await database.query("ALTER TABLE activity_events ENABLE TRIGGER USER");
      const deps = dependencies();
      await expect(verifyProductionState(args(), deps)).rejects.toThrow(
        "ORIGINAL_CANONICAL_RECONCILIATION_FAILED",
      );
      expect(deps.fetch).not.toHaveBeenCalled();
    },
  );
  it("rejects fabricated original dependency and checklist structures independently of metadata preservation", async () => {
    await database.query(
      "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id) VALUES('synthetic-fabricated-group',$1,'T-synthetic-one')",
      [owner],
    );
    await database.query(
      "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id) VALUES('synthetic-fabricated-edge',$1,'synthetic-fabricated-group','T-synthetic-two')",
      [owner],
    );
    await database.query(
      "INSERT INTO task_checklists(checklist_id,owner_id,task_id,title) VALUES('synthetic-fabricated-list',$1,'T-synthetic-one','Synthetic invented checklist')",
      [owner],
    );
    const deps = dependencies();
    await expect(verifyProductionState(args(), deps)).rejects.toThrow(
      "ORIGINAL_RELATIONSHIP_FABRICATION_DETECTED",
    );
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("requires whoami to bind the first-party session to the cutover owner", async () => {
    const deps = dependencies(),
      initial = deps.fetch.getMockImplementation()!;
    deps.fetch.mockImplementation(async (input, init) => {
      const target = new URL(String(input));
      return target.searchParams.get("operation") === "whoami"
        ? Response.json({ data: { owner_id: "synthetic-other-owner" } })
        : initial(input, init);
    });
    await expect(verifyProductionState(args(), deps)).rejects.toThrow(
      "FIRST_PARTY_OWNER_ID_MISMATCH",
    );
    expect(
      JSON.parse(await readFile(reportPath, "utf8")).api_tasks_verified,
    ).toBeUndefined();
  });
  it.each([
    [
      "task_get",
      "ORIGINAL_TASK_API_NATIVE_MISMATCH",
      (row: Record<string, unknown>) => ({ ...row, due_date: "2026-11-02" }),
    ],
    [
      "file_get_metadata",
      "ORIGINAL_FILE_API_NATIVE_MISMATCH",
      (row: Record<string, unknown>) => ({
        ...row,
        external_id: "synthetic-corrupted-drive-reference",
      }),
    ],
  ])(
    "compares every %s API row to actual source-backed SQL fields",
    async (operation, code, corrupt) => {
      const deps = dependencies(),
        initial = deps.fetch.getMockImplementation()!;
      deps.fetch.mockImplementation(async (input, init) => {
        const response = await initial(input, init);
        if (new URL(String(input)).searchParams.get("operation") !== operation)
          return response;
        const body = await response.json();
        return Response.json({ ...body, data: corrupt(body.data) });
      });
      await expect(verifyProductionState(args(), deps)).rejects.toThrow(code);
    },
  );
  it("denies a staging or failed optional graph journal before DB/auth", async () => {
    const path = join(privateDir, "graph.json");
    await writeFile(
      path,
      JSON.stringify({
        format: "ramin-life-os-production-graph-proof/1",
        status: "passed",
        proof_mode: "staging_rehearsal",
        origin: "http://localhost:3000",
      }),
    );
    const deps = dependencies();
    await expect(verifyProductionState(args(path), deps)).rejects.toThrow(
      "PASSED_PRODUCTION_GRAPH_PROOF_REQUIRED",
    );
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.fetch).not.toHaveBeenCalled();
  });
  it("checks all 21 retained synthetic snapshots against native identities/revisions and refuses an intervening graph edit", async () => {
    const path = join(privateDir, "graph.json"),
      runId = randomUUID(),
      prefix = "SYNTHETIC GRAPH PROOF " + runId.slice(0, 8) + " ";
    const service = createDomainService(database),
      snapshots: Record<string, TaskDTO> = {};
    for (let index = 0; index < 21; index++) {
      const result = await service.execute(
        "task_create",
        { title: prefix + index },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const task = (await service.query(
        "task_get",
        { task_id: result.entity_id },
        principal,
      )) as TaskDTO;
      snapshots[task.task_id] = task;
    }
    await writeFile(
      path,
      JSON.stringify({
        format: "ramin-life-os-production-graph-proof/1",
        status: "passed",
        proof_mode: "production",
        origin: PRODUCTION_STATE_ORIGIN,
        run_id: runId,
        snapshots,
        created: { tasks: Object.keys(snapshots) },
      }),
    );
    expect(
      (await verifyProductionState(args(path), dependencies()))
        .graph_tasks_verified,
    ).toBe(21);
    await database.query(
      "UPDATE tasks SET revision=revision+1 WHERE task_id=$1",
      [Object.keys(snapshots)[0]],
    );
    reportPath = join(privateDir, "after-intervening-edit.json");
    await expect(
      verifyProductionState(args(path), dependencies()),
    ).rejects.toThrow("RETAINED_GRAPH_API_SNAPSHOT_MISMATCH");
    expect(fetch).not.toHaveBeenCalled();
  });
});
