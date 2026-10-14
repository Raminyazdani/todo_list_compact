import {
  Pool,
  types as postgresTypes,
  type PoolClient,
  type CustomTypesConfig,
} from "pg";
import { DomainError } from "../../shared/contracts";
import { MIGRATION_SQL } from "./schema";
import { postgresConnectionUrl } from "./connection-target";

/** DATE is a calendar label, never a local-midnight timestamp. */
function calendarDate(value: string | Buffer): string {
  let label: string;
  if (Buffer.isBuffer(value)) {
    if (value.length !== 4) throw new TypeError("DOMAIN_DATABASE_DATE_INVALID");
    // PostgreSQL binary DATE is a signed day count since2000-01-01.
    const days = value.readInt32BE();
    if (days === 2147483647 || days === -2147483648)
      throw new RangeError("DOMAIN_DATABASE_DATE_NONFINITE");
    const date = new Date(Date.UTC(2000, 0, 1) + days * 86400000);
    if (!Number.isFinite(date.getTime()))
      throw new RangeError("DOMAIN_DATABASE_DATE_INVALID");
    label = date.toISOString().slice(0, 10);
  } else label = value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(label) || label.startsWith("0000-"))
    throw new TypeError("DOMAIN_DATABASE_DATE_INVALID");
  const parsed = Date.parse(label + "T00:00:00Z");
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== label
  )
    throw new TypeError("DOMAIN_DATABASE_DATE_INVALID");
  return label;
}
const domainTypes: CustomTypesConfig = {
  getTypeParser(oid, format) {
    return oid === 1082
      ? calendarDate
      : postgresTypes.getTypeParser(oid, format);
  },
};

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
  /** Optional for adapters already pinned inside an exclusive transaction. */
  readTransaction?<T>(
    ownerId: string,
    action: (tx: SqlClient) => Promise<T>,
  ): Promise<T>;
  close?(): Promise<void>;
}

class PostgresDatabase implements Database {
  private readonly pool: Pool;
  constructor(url: string) {
    const parsed = postgresConnectionUrl(url);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if (!local) parsed.searchParams.set("sslmode", "verify-full");
    this.pool = new Pool({
      connectionString: parsed.toString(),
      max: 5,
      idleTimeoutMillis: 20000,
      connectionTimeoutMillis: 8000,
      ssl: local ? undefined : { rejectUnauthorized: true },
      types: domainTypes,
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
    return this.runTransaction(ownerId, action, false);
  }
  async readTransaction<T>(
    ownerId: string,
    action: (tx: SqlClient) => Promise<T>,
  ): Promise<T> {
    return this.runTransaction(ownerId, action, true);
  }
  private async runTransaction<T>(
    ownerId: string,
    action: (tx: SqlClient) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    const client: PoolClient = await this.pool.connect();
    try {
      // Parallel readers use one consistent MVCC snapshot and cannot write SQL.
      // The same owner lock remains exclusive for commands and stored previews.
      await client.query(
        readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      await client.query(
        readOnly
          ? "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))"
          : "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
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
