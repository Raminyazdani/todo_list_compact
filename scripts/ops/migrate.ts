import { getDatabase, migrateDatabase } from "../../server/db/database";
async function main() {
  // Schema operations use the direct endpoint, while application traffic keeps
  // using the pooled URL. Reject a mismatched direct destination before DDL.
  if (process.env.DATABASE_URL_UNPOOLED && process.env.DATABASE_URL) {
    const runtime = new URL(process.env.DATABASE_URL),
      direct = new URL(process.env.DATABASE_URL_UNPOOLED);
    if (
      runtime.hostname.replace("-pooler.", ".") !==
        direct.hostname.replace("-pooler.", ".") ||
      runtime.pathname !== direct.pathname
    )
      throw new Error(
        "Migration direct URL does not match the configured database.",
      );
    process.env.DATABASE_URL = process.env.DATABASE_URL_UNPOOLED;
  }
  const database = getDatabase();
  await migrateDatabase(database);
  console.log("Versioned domain schema migrated successfully");
  await database.close?.();
}
main().catch(() => {
  console.error("Domain migration failed; no secrets printed");
  process.exitCode = 1;
});
