import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { encryptBackup, decryptBackup } from "../../server/integrations/backup";
import { writeExclusivePrivateJson } from "./private-paths.mjs";

// Source connection is deliberately not passed to createStore: that adapter
// initializes tables. This exporter issues only SELECT in a READ ONLY snapshot.
async function main() {
  const [intent, encryptedPath, importPath, ...extra] = process.argv.slice(2);
  if (intent !== "--read-only-source" || !importPath || extra.length)
    throw new Error("EXPLICIT_SOURCE_SNAPSHOT_ARGUMENTS_REQUIRED");
  if (!process.env.BACKUP_ENCRYPTION_KEY)
    throw new Error("SOURCE_SNAPSHOT_CONFIGURATION_REQUIRED");
  const connection =
    process.env.WORK_PLANNER_DATABASE_URL ??
    process.env.DATABASE_URL_UNPOOLED ??
    process.env.DATABASE_URL;
  if (!connection) throw new Error("SOURCE_DATABASE_REQUIRED");
  const url = new URL(connection);
  if (!url.hostname.endsWith(".neon.tech"))
    throw new Error("SOURCE_NEON_TARGET_REQUIRED");
  url.searchParams.set("sslmode", "verify-full");
  const namespace = `${process.env.WORK_PLANNER_STORAGE_PREFIX || "work-planner"}-production`;
  const pool = new Pool({
    connectionString: url.toString(),
    ssl: { rejectUnauthorized: true },
    max: 1,
    connectionTimeoutMillis: 10000,
  });
  try {
    const client = await pool.connect();
    let rows: Array<{ key: string; body: string; etag: string }>;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      rows = (
        await client.query<{ key: string; body: string; etag: string }>(
          "SELECT key,body,etag FROM public.work_planner_documents WHERE namespace=$1 AND key=ANY($2::text[]) ORDER BY key",
          [namespace, ["state", "calendar-settings"]],
        )
      ).rows;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      const code =
        error &&
        typeof error === "object" &&
        "code" in error &&
        /^[A-Z0-9_]{2,30}$/.test(String(error.code))
          ? String(error.code)
          : "UNKNOWN";
      throw new Error("SOURCE_READ_ONLY_SNAPSHOT_FAILED_" + code);
    } finally {
      client.release();
    }
    const stateRow = rows.find((row) => row.key === "state");
    if (!stateRow) throw new Error("SOURCE_STATE_MISSING_NO_EMPTY_FALLBACK");
    const state = JSON.parse(stateRow.body) as {
      version: number;
      entries: unknown[];
    };
    if (state.version !== 1 || !Array.isArray(state.entries))
      throw new Error("SOURCE_STATE_INVALID");
    const snapshot = {
      format: "ramin-workplanner-source-snapshot/1",
      observed_at: new Date().toISOString(),
      namespace,
      rows,
    };
    const encrypted = await encryptBackup(
      snapshot,
      process.env.BACKUP_ENCRYPTION_KEY,
    );
    await writeExclusivePrivateJson(encryptedPath, encrypted);
    const readback = await decryptBackup(
      JSON.parse(await readFile(encryptedPath, "utf8")),
      process.env.BACKUP_ENCRYPTION_KEY,
    );
    if (JSON.stringify(readback) !== JSON.stringify(snapshot))
      throw new Error("SOURCE_ENCRYPTED_READBACK_MISMATCH");
    await writeExclusivePrivateJson(importPath, state);
    console.log(
      JSON.stringify({
        status: "verified_read_only_source_snapshot",
        observed_at: snapshot.observed_at,
        entry_count: state.entries.length,
        calendar_configuration_present: rows.some(
          (row) => row.key === "calendar-settings",
        ),
        source_hash: createHash("sha256").update(stateRow.body).digest("hex"),
        encrypted_backup_verified: true,
        source_written: false,
      }),
    );
  } finally {
    await pool.end();
  }
}
main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]{2,100}$/.test(error.message)
      ? error.message
      : "WORKPLANNER_SOURCE_SNAPSHOT_FAILED";
  console.error(code + "; no source or credential values emitted");
  process.exitCode = 1;
});
