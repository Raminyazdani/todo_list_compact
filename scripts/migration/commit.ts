import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { getDatabase, type Database } from "../../server/db/database";
import { postgresConnectionUrl } from "../../server/db/connection-target";
import { createDomainService } from "../../server/domain/service";
import {
  importPrepared,
  prepareMigration,
  reconcileMigration,
  recordHash,
} from "./core";
import { rehearseMigration } from "./staging";
import {
  admitPrivatePath,
  withPrivateFile,
  writeExclusivePrivateJson,
  replacePinnedContents,
} from "../ops/private-paths.mjs";

const REPORT_FORMAT = "ramin-life-os-migration-cutover/1";
interface Checkpoint {
  verified_at: string;
  source_modified_time: string;
  source_hash: string;
}
interface Dependencies {
  repositoryRoot?: string;
  environment?: Record<string, string | undefined>;
  now?: () => number;
  rehearse?: typeof rehearseMigration;
  database?: () => Database;
}
function destinationHash(url: string) {
  const parsed = postgresConnectionUrl(url);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname ||
    !parsed.pathname.slice(1)
  )
    throw new Error(
      "Migration destination must be a configured PostgreSQL database.",
    );
  return recordHash({
    host: parsed.hostname.toLowerCase().replace(/-pooler(?=\.)/, ""),
    port: parsed.port || "5432",
    database: decodeURIComponent(parsed.pathname.slice(1)),
  });
}
export function assertFreshSourceCheckpoint(
  checkpoint: Checkpoint,
  sourceModifiedTime: unknown,
  sourceHash: string,
  now = Date.now(),
) {
  if (
    !checkpoint ||
    typeof checkpoint.verified_at !== "string" ||
    typeof sourceModifiedTime !== "string" ||
    !Number.isFinite(Date.parse(sourceModifiedTime)) ||
    typeof checkpoint.source_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(checkpoint.source_hash)
  )
    throw new Error("Source checkpoint metadata is invalid.");
  const age = now - Date.parse(checkpoint.verified_at);
  if (
    !Number.isFinite(age) ||
    age < -30000 ||
    age > 10 * 60000 ||
    checkpoint.source_modified_time !== sourceModifiedTime ||
    checkpoint.source_hash !== sourceHash
  )
    throw new Error(
      "Source checkpoint stale or changed. Read live metadata/complete rows and rehearse again.",
    );
}

/** Only the coordinator's CLI selects real production. Tests inject a disposable engine, never a runtime fallback. */
export async function commitMigration(
  args: string[],
  dependencies: Dependencies = {},
) {
  const [sourcePath, checkpointPath, reportPath, flag, ...extra] = args;
  if (
    !sourcePath ||
    !checkpointPath ||
    !reportPath ||
    flag !== "--commit" ||
    extra.length
  )
    throw new Error(
      "Expected private source, fresh private live-read checkpoint, private report, and --commit.",
    );
  const repositoryRoot =
    dependencies.repositoryRoot ??
    fileURLToPath(new URL("../../", import.meta.url));
  const admission = { repositoryRoot };
  const sourceFile = await admitPrivatePath(sourcePath, {
    ...admission,
    mustExist: true,
  });
  const checkpointFile = await admitPrivatePath(checkpointPath, {
    ...admission,
    mustExist: true,
  });
  const reportFile = await admitPrivatePath(reportPath, admission);
  const source = JSON.parse(await readFile(sourceFile, "utf8"));
  const checkpoint = JSON.parse(
    await readFile(checkpointFile, "utf8"),
  ) as Checkpoint;
  const prepared = prepareMigration(source);
  const now = dependencies.now ?? Date.now;
  const assertFresh = () =>
    assertFreshSourceCheckpoint(
      checkpoint,
      source.source?.modified_time,
      prepared.sourceHash,
      now(),
    );
  assertFresh();
  if (!prepared.ready)
    throw new Error("Source validation/quarantine blocks migration.");
  const environment = dependencies.environment ?? process.env;
  const ownerId = environment.OWNER_ID,
    databaseUrl = environment.DATABASE_URL;
  if (!ownerId?.trim() || !databaseUrl)
    throw new Error("Production database and owner are not configured.");
  const intent = {
    format: REPORT_FORMAT,
    source_hash: prepared.sourceHash,
    batch_id: prepared.batchId,
    owner_id: ownerId,
    destination_hash: destinationHash(databaseUrl),
  };
  const rehearsal = await (dependencies.rehearse ?? rehearseMigration)(source);
  if (!rehearsal.pass)
    throw new Error("Staging migration, replay or restore failed.");
  assertFresh();
  // Durable pending evidence exists before a provider call can accept the import.
  try {
    await writeExclusivePrivateJson(
      reportFile,
      {
        ...intent,
        status: "pending",
        reserved_at: new Date(now()).toISOString(),
        checkpoint,
        counts: prepared.counts,
        rehearsal,
      },
      admission,
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
  return withPrivateFile(
    reportFile,
    async (file) => {
      const existing = JSON.parse(await file.readFile("utf8"));
      if (
        !existing ||
        !Object.entries(intent).every(
          ([key, value]) => existing[key] === value,
        ) ||
        ![
          "pending",
          "accepted",
          "verified",
          "reconciliation_required",
        ].includes(existing.status)
      )
        throw new Error(
          "Existing private report belongs to another migration intent; preserve it and choose a new report path.",
        );
      assertFresh();
      const database = (dependencies.database ?? getDatabase)();
      try {
        const principal = {
          ownerId,
          actorId: "authorized-migration-operator",
          channel: "import" as const,
          scopes: ["admin:manage"],
        };
        assertFresh();
        // Same canonical batch key reconciles uncertain and accepted outcomes before retrying.
        const mutation = await importPrepared(
          createDomainService(database),
          prepared,
          principal,
        );
        const accepted = {
          ...intent,
          status: "accepted",
          occurred_at: new Date(now()).toISOString(),
          checkpoint,
          counts: prepared.counts,
          rehearsal,
          mutation,
        };
        await replacePinnedContents(
          file,
          JSON.stringify(accepted, null, 2) + "\n",
        );
        const reconciliation = await reconcileMigration(
          database,
          ownerId,
          prepared,
        );
        await replacePinnedContents(
          file,
          JSON.stringify(
            {
              ...accepted,
              status: reconciliation.pass
                ? "verified"
                : "reconciliation_required",
              reconciliation,
              cutover_status: reconciliation.pass
                ? "verified import; legacy source remains read-only"
                : "reconciliation requires review",
            },
            null,
            2,
          ) + "\n",
        );
        return {
          reconciled: reconciliation.pass,
          counts: prepared.counts,
          replayed: mutation.replayed === true,
          source_written: false,
        };
      } finally {
        await database.close?.();
      }
    },
    admission,
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  commitMigration(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!result.reconciled) process.exitCode = 1;
    })
    .catch(() => {
      console.error(
        "Production migration stopped. Inspect source freshness, staging validation and the preserved private pending/accepted report; retry the same source and canonical batch key. No source changes were requested.",
      );
      process.exitCode = 1;
    });
}
