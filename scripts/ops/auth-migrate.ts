import { mkdir, writeFile } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { getAuth } from "../../server/auth/config";
import { getAuthPool } from "../../server/auth/db";

async function main() {
  const migrations = await getMigrations(getAuth().options);
  if (migrations.unsafeChanges.length || migrations.schemaProblems.length)
    throw new Error("Unsafe auth schema plan");
  if (process.argv.includes("--compile")) {
    await mkdir("server/auth/migrations", { recursive: true });
    await writeFile(
      "server/auth/migrations/0001-auth.sql",
      await migrations.compileMigrations(),
    );
  }
  await migrations.runMigrations();
  await getAuthPool()
    .query(`CREATE TABLE IF NOT EXISTS runtime_rate_limits (key text PRIMARY KEY,bucket timestamptz NOT NULL,count integer NOT NULL CHECK(count>0));
    CREATE TABLE IF NOT EXISTS ai_plans (plan_id text PRIMARY KEY,owner_id text NOT NULL,actor_id text NOT NULL,plan jsonb NOT NULL,expires_at timestamptz NOT NULL,executed_at timestamptz,results jsonb);
    CREATE TABLE IF NOT EXISTS ai_usage (owner_id text NOT NULL,usage_date date NOT NULL,tokens bigint NOT NULL DEFAULT 0,cost_microusd bigint NOT NULL DEFAULT 0,PRIMARY KEY(owner_id,usage_date));
    CREATE TABLE IF NOT EXISTS human_confirmations (confirmation_id text PRIMARY KEY,owner_id text NOT NULL,actor_id text NOT NULL,command text NOT NULL,input_hash text NOT NULL,expires_at timestamptz NOT NULL,operation_key text);
    CREATE TABLE IF NOT EXISTS integration_sync_state (owner_id text NOT NULL,provider text NOT NULL,last_success_at timestamptz,status text NOT NULL,error text,PRIMARY KEY(owner_id,provider));`);
  console.log(
    "Authentication, rate limits and AI schema migrated successfully",
  );
  await getAuthPool().end();
}
main().catch(() => {
  console.error("Authentication migration failed; no credentials printed.");
  process.exitCode = 1;
});
