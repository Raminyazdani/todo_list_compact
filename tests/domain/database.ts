import { PGlite } from "@electric-sql/pglite";
import type { Database, SqlClient, SqlResult } from "../../server/db/database";
import { MIGRATION_SQL } from "../../server/db/schema";

/** PGlite embeds the real PostgreSQL engine. Isolated tests only, never runtime fallback. */
export async function createTestDatabase(): Promise<Database> {
  const pg = new PGlite();
  await pg.exec(MIGRATION_SQL);
  let queue: Promise<unknown> = Promise.resolve();
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    const prior = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      return await action();
    } finally {
      release();
    }
  };
  const client: SqlClient = {
    query: async <T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<SqlResult<T>> => {
      const r = await pg.query<T>(sql, params);
      return { rows: r.rows, rowCount: r.affectedRows };
    },
  };
  return {
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      run(() => client.query<T>(sql, params)),
    transaction: <T>(ownerId: string, action: (tx: SqlClient) => Promise<T>) =>
      run(async () => {
        await pg.exec("BEGIN");
        try {
          await client.query(
            "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
            [ownerId],
          );
          const result = await action(client);
          await pg.exec("COMMIT");
          return result;
        } catch (error) {
          await pg.exec("ROLLBACK");
          throw error;
        }
      }),
    close: () => pg.close(),
  };
}
