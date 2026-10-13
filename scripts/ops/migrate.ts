import { getDatabase, migrateDatabase } from "../../server/db/database";
async function main() {
  const database = getDatabase();
  await migrateDatabase(database);
  console.log("Versioned domain schema migrated successfully");
  await database.close?.();
}
main().catch(() => {
  console.error("Domain migration failed; no secrets printed");
  process.exitCode = 1;
});
