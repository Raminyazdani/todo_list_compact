import { randomUUID } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import type { Principal } from "../../shared/contracts";
import {
  getDatabase,
  type Database,
  type SqlClient,
} from "../../server/db/database";
import { hash, object, type Input } from "../../server/domain/core";
import {
  BACKUP_TABLES,
  verifyBackupManifest,
} from "../../server/domain/migration";
import { createDomainService } from "../../server/domain/service";
import {
  decryptBackup,
  type EncryptedBackup,
} from "../../server/integrations/backup";

const REPOSITORY = fileURLToPath(new URL("../../", import.meta.url));
const MAX_SNAPSHOT_BYTES = 70 * 1024 * 1024;

/** Normalize direct/pooler endpoints as the same database; credentials never enter the result. */
export function databaseIdentity(value: string): string {
  const url = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    !url.pathname.slice(1)
  )
    throw new Error("DRILL_DATABASE_CONFIGURATION_INVALID");
  const host = url.hostname.toLowerCase().replace(/-pooler(?=\.)/, "");
  return `${["localhost", "127.0.0.1", "[::1]"].includes(host) ? "localhost" : host}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`;
}

export function assertSeparateDatabases(
  source: string,
  destination: string,
): void {
  if (databaseIdentity(source) === databaseIdentity(destination))
    throw new Error("DRILL_SOURCE_EQUALS_DESTINATION");
}

export function validateDrillEnvironment(
  source: Record<string, string | undefined>,
  destination: Record<string, string | undefined>,
): { sourceOwnerId: string; destinationDatabaseUrl: string } {
  if (
    !source.DATABASE_URL ||
    !destination.DATABASE_URL ||
    !source.OWNER_ID ||
    !destination.OWNER_ID
  )
    throw new Error("DRILL_ENV_CONFIGURATION_INCOMPLETE");
  if (
    source.OWNER_ID === destination.OWNER_ID ||
    destination.RESTORE_DRILL_DESTINATION !== "isolated-staging"
  )
    throw new Error("DRILL_STAGING_ISOLATION_CONFIGURATION_REQUIRED");
  assertSeparateDatabases(source.DATABASE_URL, destination.DATABASE_URL);
  return {
    sourceOwnerId: source.OWNER_ID,
    destinationDatabaseUrl: destination.DATABASE_URL,
  };
}

/** All owner-bearing public tables must be empty, including operational tables omitted from exports. */
async function assertEmptyOwner(tx: SqlClient, ownerId: string): Promise<void> {
  const schema = await tx.query<{ version: number | null }>(
    "SELECT max(version)::int AS version FROM schema_migrations",
  );
  if (schema.rows[0]?.version !== 1)
    throw new Error("DRILL_DESTINATION_SCHEMA_VERSION_MISMATCH");
  const tables = await tx.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.columns WHERE table_schema='public' AND column_name='owner_id' ORDER BY table_name",
  );
  if (
    !BACKUP_TABLES.every((table) =>
      tables.rows.some((row) => row.table_name === table),
    )
  )
    throw new Error("DRILL_DESTINATION_SCHEMA_INCOMPLETE");
  for (const { table_name: table } of tables.rows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table))
      throw new Error("DRILL_TABLE_NAME_INVALID");
    const found = await tx.query(
      `SELECT 1 FROM "${table}" WHERE owner_id=$1 LIMIT 1`,
      [ownerId],
    );
    if (found.rows.length) throw new Error("DRILL_DESTINATION_OWNER_NOT_EMPTY");
  }
}

export interface RestoreDrillResult {
  status: "restored";
  table_counts: Record<string, number>;
  accepted_operation_count: number;
  accepted_results_preserved: true;
  original_rows_preserved: true;
}

/** Canonical restoration only. The owner lock covers admission and the complete restore transaction. */
export async function restoreDrill(
  database: Database,
  backupValue: unknown,
  sourceOwnerId: string,
  explicitRestoreDrill: boolean,
): Promise<RestoreDrillResult> {
  if (!explicitRestoreDrill) throw new Error("DRILL_EXPLICIT_INTENT_REQUIRED");
  if (!sourceOwnerId.trim()) throw new Error("DRILL_SOURCE_OWNER_REQUIRED");
  const backup = object(backupValue);
  const original = verifyBackupManifest(backup, sourceOwnerId);
  if (
    [
      ...Object.keys(object(backup.tables)),
      ...Object.keys(object(backup.checksums)),
    ].some((name) => !(BACKUP_TABLES as readonly string[]).includes(name))
  )
    throw new Error("DRILL_UNSUPPORTED_BACKUP_TABLE");
  // Never relabel the backup to the staging application's OWNER_ID.
  const principal: Principal = {
    ownerId: sourceOwnerId,
    actorId: sourceOwnerId,
    channel: "system",
    scopes: ["admin:manage", "backup:export"],
  };
  const guarded: Database = {
    query: (sql, params) => database.query(sql, params),
    transaction: (owner, action) =>
      database.transaction(owner, async (tx) => {
        await assertEmptyOwner(tx, sourceOwnerId);
        return action(tx);
      }),
  };
  await createDomainService(guarded).execute(
    "backup_restore",
    { backup, explicit_user_intent: true },
    principal,
    { idempotencyKey: `restore-drill-${randomUUID()}` },
  );
  const restoredBackup = object(
    await createDomainService(database).query("backup_export", {}, principal),
  );
  const restored = verifyBackupManifest(restoredBackup, sourceOwnerId);
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    counts[table] = original[table].length;
    const hashes = new Set(restored[table].map((row) => hash(row)));
    if (original[table].some((row) => !hashes.has(hash(row))))
      throw new Error("DRILL_ORIGINAL_ROW_READBACK_MISMATCH");
    const added = ["activity_events", "idempotency_operations"].includes(table)
      ? 1
      : 0;
    if (restored[table].length !== original[table].length + added)
      throw new Error("DRILL_COUNT_READBACK_MISMATCH");
  }
  return {
    status: "restored",
    table_counts: counts,
    accepted_operation_count: original.idempotency_operations.length,
    accepted_results_preserved: true,
    original_rows_preserved: true,
  };
}

export function parseDrillArguments(args: string[]): Record<string, string> {
  if (!args.includes("--restore-drill"))
    throw new Error("DRILL_EXPLICIT_INTENT_REQUIRED");
  const values: Record<string, string> = {};
  const names = ["--source-env", "--destination-env", "--snapshot", "--report"];
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (name === "--restore-drill") continue;
    if (
      !names.includes(name) ||
      values[name] ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      throw new Error("DRILL_ARGUMENTS_INVALID");
    values[name] = args[++index];
  }
  if (names.some((name) => !values[name] || !isAbsolute(values[name])))
    throw new Error("DRILL_PRIVATE_ABSOLUTE_PATHS_REQUIRED");
  return values;
}

export async function assertPrivatePath(
  path: string,
  repository = REPOSITORY,
  newFile = false,
): Promise<string> {
  const root = await realpath(repository);
  const actual = newFile
    ? resolve(await realpath(dirname(path)), path.split(/[\\/]/).at(-1)!)
    : await realpath(path);
  const inside = relative(root, actual);
  if (
    !inside ||
    (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside))
  )
    throw new Error("DRILL_PRIVATE_PATH_INSIDE_REPOSITORY");
  return actual;
}

async function boundedJson(path: string, maxBytes: number): Promise<Input> {
  if ((await stat(path)).size > maxBytes)
    throw new Error("DRILL_INPUT_TOO_LARGE");
  return object(JSON.parse(await readFile(path, "utf8")));
}

async function main(): Promise<void> {
  const args = parseDrillArguments(process.argv.slice(2));
  const sourcePath = await assertPrivatePath(args["--source-env"]);
  const destinationPath = await assertPrivatePath(args["--destination-env"]);
  const snapshotPath = await assertPrivatePath(args["--snapshot"]);
  const reportPath = await assertPrivatePath(
    args["--report"],
    REPOSITORY,
    true,
  );
  if (
    reportPath === sourcePath ||
    reportPath === destinationPath ||
    reportPath === snapshotPath
  )
    throw new Error("DRILL_REPORT_PATH_CONFLICT");
  for (const envPath of [sourcePath, destinationPath])
    if ((await stat(envPath)).size > 1024 * 1024)
      throw new Error("DRILL_ENV_TOO_LARGE");
  const source = parseEnv(await readFile(sourcePath, "utf8"));
  const destination = parseEnv(await readFile(destinationPath, "utf8"));
  const { sourceOwnerId, destinationDatabaseUrl } = validateDrillEnvironment(
    source,
    destination,
  );
  let backup: unknown = await boundedJson(snapshotPath, MAX_SNAPSHOT_BYTES);
  if (object(backup).format === "ramin-life-os-encrypted-backup/v1") {
    if (!source.BACKUP_ENCRYPTION_KEY)
      throw new Error("DRILL_DECRYPTION_KEY_MISSING");
    backup = await decryptBackup(
      backup as EncryptedBackup,
      source.BACKUP_ENCRYPTION_KEY,
    );
  }
  verifyBackupManifest(object(backup), sourceOwnerId);
  // Create exclusively before any mutation. Never overwrite an earlier drill report.
  const report = await open(reportPath, "wx", 0o600);
  const started = Date.now();
  let database: Database | undefined;
  try {
    process.env.DATABASE_URL = destinationDatabaseUrl;
    database = getDatabase();
    const result = await restoreDrill(database, backup, sourceOwnerId, true);
    const evidence = {
      ...result,
      observed_at: new Date().toISOString(),
      duration_ms: Date.now() - started,
      source_owner_id: sourceOwnerId,
      manifest_hash: object(backup).manifest_hash,
      scope: "isolated_staging_original_owner",
      external_file_bytes_verified: false,
    };
    await report.writeFile(JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch {
    await report.writeFile(
      JSON.stringify({
        status: "failed",
        code: "DRILL_RESTORE_FAILED",
        observed_at: new Date().toISOString(),
      }) + "\n",
    );
    throw new Error("DRILL_RESTORE_FAILED");
  } finally {
    await report.close();
    await database?.close?.();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
)
  main().catch((error: unknown) => {
    const code =
      error instanceof Error && /^DRILL_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DRILL_RESTORE_FAILED";
    console.error(
      `${code}; inspect the private report if created; no production replacement was attempted`,
    );
    process.exitCode = 1;
  });
