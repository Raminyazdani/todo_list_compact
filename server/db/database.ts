import { Pool, type PoolClient } from "pg";
import { DomainError } from "../../shared/contracts";
import { MIGRATION_SQL } from "./schema";

export interface SqlResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount?: number | null;
}
export interface SqlClient {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<SqlResult<T>>;
}
export interface Database extends SqlClient {
  transaction<T>(
    ownerId: string,
    action: (tx: SqlClient) => Promise<T>,
  ): Promise<T>;
  close?(): Promise<void>;
}

class PostgresDatabase implements Database {
  private readonly pool: Pool;
  constructor(url: string) {
    const parsed = new URL(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (!local) parsed.searchParams.set("sslmode", "verify-full");
    this.pool = new Pool({
      connectionString: parsed.toString(),
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 8000,
      ssl: local ? undefined : { rejectUnauthorized: true },
    });
    this.pool.on("error", () =>
      console.error("DOMAIN_DATABASE_CONNECTION_FAILED"),
    );
  }
  async query<T = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<SqlResult<T>> {
    const result = await this.pool.query(sql, params);
    return { rows: result.rows as T[], rowCount: result.rowCount };
  }
  async transaction<T>(
    ownerId: string,
    action: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [ownerId],
      );
      const result = await action({
        query: async <R = Record<string, unknown>>(
          sql: string,
          params: unknown[] = [],
        ) => {
          const result = await client.query(sql, params);
          return { rows: result.rows as R[], rowCount: result.rowCount };
        },
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}
let productionDatabase: Database | undefined;
export function getDatabase(): Database {
  if (!process.env.DATABASE_URL)
    throw new DomainError(
      "DATABASE_UNAVAILABLE",
      "Durable PostgreSQL is not configured.",
      {},
      503,
    );
  productionDatabase ??= new PostgresDatabase(process.env.DATABASE_URL);
  return productionDatabase;
}
export async function migrateDatabase(database: Database): Promise<void> {
  await database.query(MIGRATION_SQL);
}
