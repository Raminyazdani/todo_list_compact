import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { getDatabase, migrateDatabase } from "../../server/db/database";
import {
  admitPrivatePath,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

const [referencePath, receiptPath, ...extra] = process.argv.slice(2);
if (!referencePath || !receiptPath || extra.length)
  throw new Error("Expected private reference env and private receipt paths.");
const reference = parseEnv(
  await readFile(
    await admitPrivatePath(referencePath, { mustExist: true }),
    "utf8",
  ),
);
const destination = (value: string | undefined) => {
  if (!value) throw new Error("Explicit database target required.");
  const url = new URL(value);
  return `${url.hostname.replace("-pooler.", ".")}${url.pathname}`;
};
if (
  destination(process.env.DATABASE_URL) === destination(reference.DATABASE_URL)
)
  throw new Error(
    "Migration proof requires a database isolated from the reference environment.",
  );
if (
  process.env.DATABASE_URL_UNPOOLED &&
  destination(process.env.DATABASE_URL) !==
    destination(process.env.DATABASE_URL_UNPOOLED)
)
  throw new Error("Direct and runtime proof targets differ.");
if (process.env.DATABASE_URL_UNPOOLED)
  process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
const db = getDatabase();
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
async function tables() {
  return (
    await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
    )
  ).rows.map((x) => x.tablename);
}
async function fingerprints(names: string[]) {
  const rows: Record<string, unknown> = {};
  for (const name of names) {
    const result = await db.query(
      `SELECT count(*)::text AS rows,md5(coalesce(string_agg(row_to_json(t)::text,E'\\n' ORDER BY row_to_json(t)::text),'')) AS checksum FROM ${quoted(name)} t`,
    );
    rows[name] = result.rows[0];
  }
  return rows;
}
try {
  const previousTables = (await tables()).filter(
    (name) => name !== "schema_migrations",
  );
  const before = await fingerprints(previousTables);
  await migrateDatabase(db);
  const afterFirst = await fingerprints(previousTables);
  await migrateDatabase(db);
  const afterSecond = await fingerprints(previousTables);
  const unchanged =
    JSON.stringify(before) === JSON.stringify(afterFirst) &&
    JSON.stringify(before) === JSON.stringify(afterSecond);
  if (!unchanged)
    throw new Error("Existing table contents changed during schema migration.");
  const financeTables = (await tables()).filter((name) =>
    name.startsWith("finance_"),
  );
  if (financeTables.length !== 5)
    throw new Error("Expected all five finance tables.");
  const schemaVersion = Number(
    (
      await db.query<{ version: number }>(
        "SELECT max(version) AS version FROM schema_migrations",
      )
    ).rows[0].version,
  );
  if (schemaVersion !== 4)
    throw new Error("Finance schema version was not applied.");
  await writeExclusivePrivateJson(receiptPath, {
    status: "passed",
    observed_at: new Date().toISOString(),
    isolated_target: true,
    migration_runs: 2,
    old_tables_unchanged: true,
    schema_version: schemaVersion,
    finance_tables: financeTables,
    before,
    after: afterSecond,
  });
  console.log(
    JSON.stringify({
      status: "passed",
      isolatedTarget: true,
      migrationRuns: 2,
      oldTablesUnchanged: true,
      financeTables: financeTables.length,
      schemaVersion,
    }),
  );
} finally {
  await db.close?.();
}
