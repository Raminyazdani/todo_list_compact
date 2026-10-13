import { Pool } from "pg";

let pool: Pool | undefined;
export function getAuthPool() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_UNAVAILABLE");
  const databaseUrl = new URL(process.env.DATABASE_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(
    databaseUrl.hostname,
  );
  if (!local) databaseUrl.searchParams.set("sslmode", "verify-full");
  if (!pool) {
    pool = new Pool({
      connectionString: databaseUrl.toString(),
      ssl: local ? undefined : { rejectUnauthorized: true },
      max: 3,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 10000,
    });
    pool.on("error", () => console.error("AUTH_DATABASE_CONNECTION_FAILED"));
  }
  return pool;
}
