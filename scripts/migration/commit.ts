import { readFile, writeFile } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { getDatabase } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import { importPrepared, prepareMigration, reconcileMigration } from "./core";
import { rehearseMigration } from "./staging";

async function main() {
  const [sourcePath, checkpointPath, reportPath, flag] = process.argv.slice(2);
  if (!sourcePath || !checkpointPath || !reportPath || flag !== "--commit")
    throw new Error(
      "Expected private source, fresh private live-read checkpoint, private report, and --commit.",
    );
  const reportRelative = relative(resolve(process.cwd()), resolve(reportPath));
  if (!(
    isAbsolute(reportRelative) ||
    reportRelative === ".." ||
    reportRelative.startsWith(".." + sep)
  ))
    throw new Error("Reconciliation report must stay outside public Git.");
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const checkpoint = JSON.parse(await readFile(checkpointPath, "utf8")) as {
    verified_at: string;
    source_modified_time: string;
    source_hash: string;
  };
  const prepared = prepareMigration(source);
  const age = Date.now() - Date.parse(checkpoint.verified_at);
  if (
    !Number.isFinite(age) ||
    age < -30000 ||
    age > 10 * 60000 ||
    checkpoint.source_modified_time !== source.source?.modified_time ||
    checkpoint.source_hash !== prepared.sourceHash
  )
    throw new Error(
      "Source checkpoint stale or changed. Read live metadata/complete rows and rehearse again.",
    );
  if (!process.env.OWNER_ID || !process.env.DATABASE_URL)
    throw new Error("Production database and owner are not configured.");
  const rehearsal = await rehearseMigration(source);
  if (!rehearsal.pass)
    throw new Error("Staging migration, replay or restore failed.");
  const database = getDatabase();
  try {
    const principal = {
      ownerId: process.env.OWNER_ID,
      actorId: "authorized-migration-operator",
      channel: "import" as const,
      scopes: ["admin:manage"],
    };
    const mutation = await importPrepared(
      createDomainService(database),
      prepared,
      principal,
    );
    const reconciliation = await reconcileMigration(
      database,
      principal.ownerId,
      prepared,
    );
    await writeFile(
      reportPath,
      JSON.stringify(
        {
          occurred_at: new Date().toISOString(),
          checkpoint,
          counts: prepared.counts,
          rehearsal,
          mutation,
          reconciliation,
          cutover_status: reconciliation.pass
            ? "verified import; legacy source remains read-only"
            : "reconciliation requires review",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        reconciled: reconciliation.pass,
        counts: prepared.counts,
        replayed: mutation.replayed === true,
        source_written: false,
      }),
    );
    if (!reconciliation.pass) process.exitCode = 1;
  } finally {
    await database.close?.();
  }
}
main().catch(() => {
  console.error(
    "Production migration stopped. Inspect source freshness, staging validation and private report; no source changes were requested.",
  );
  process.exitCode = 1;
});
