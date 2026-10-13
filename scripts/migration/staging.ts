import { PGlite } from "@electric-sql/pglite";
import { createDomainService } from "../../server/domain/service";
import {
  migrateDatabase,
  type Database,
  type SqlResult,
  type SqlClient,
} from "../../server/db/database";
import type { Principal } from "../../shared/contracts";
import { importPrepared, prepareMigration, reconcileMigration } from "./core";

/** Disposable PostgreSQL engine used only for migration rehearsal, never production. */
export async function createIsolatedStagingDatabase(): Promise<Database> {
  const engine = new PGlite();
  await engine.waitReady;
  let queue: Promise<unknown> = Promise.resolve();
  const client: SqlClient = {
    async query<T = Record<string, unknown>>(
      sql: string,
      params: unknown[] = [],
    ): Promise<SqlResult<T>> {
      if (
        !params.length &&
        /CREATE TABLE|CREATE OR REPLACE FUNCTION/.test(sql)
      ) {
        await engine.exec(sql);
        return { rows: [] };
      }
      const result = await engine.query<T>(sql, params);
      return { rows: result.rows, rowCount: result.affectedRows };
    },
  };
  const database: Database = {
    ...client,
    async transaction<T>(
      _owner: string,
      action: (tx: SqlClient) => Promise<T>,
    ): Promise<T> {
      const work = queue.then(async () => {
        await engine.exec("BEGIN");
        try {
          const result = await action(client);
          await engine.exec("COMMIT");
          return result;
        } catch (error) {
          await engine.exec("ROLLBACK");
          throw error;
        }
      });
      queue = work.catch(() => undefined);
      return work;
    },
    async close() {
      await queue;
      await engine.close();
    },
  };
  await migrateDatabase(database);
  return database;
}
export async function rehearseMigration(input: unknown) {
  const prepared = prepareMigration(input);
  if (!prepared.ready)
    return {
      pass: false,
      counts: prepared.counts,
      quarantined: prepared.quarantine.length,
      source_written: false,
      production_written: false,
    };
  const database = await createIsolatedStagingDatabase(),
    restored = await createIsolatedStagingDatabase();
  const principal: Principal = {
    ownerId: "isolated-migration-rehearsal-owner",
    actorId: "migration-rehearsal",
    channel: "import",
    scopes: ["admin:manage"],
  };
  try {
    const service = createDomainService(database);
    await importPrepared(service, prepared, principal);
    const replay = await importPrepared(service, prepared, principal);
    const reconciliation = await reconcileMigration(
      database,
      principal.ownerId,
      prepared,
    );
    const backup = await service.query("backup_export", {}, principal);
    await createDomainService(restored).execute(
      "backup_restore",
      { backup, explicit_user_intent: true },
      principal,
      { idempotencyKey: "isolated-restore-rehearsal" },
    );
    const restoreReconciliation = await reconcileMigration(
      restored,
      principal.ownerId,
      prepared,
    );
    const graph = (
      await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM task_dependency_edges",
      )
    ).rows[0].count;
    const items = (
      await database.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM task_checklist_items",
      )
    ).rows[0].count;
    return {
      pass:
        reconciliation.pass &&
        restoreReconciliation.pass &&
        replay.replayed === true &&
        graph === 0 &&
        items === 0,
      counts: prepared.counts,
      quarantined: prepared.quarantine.length,
      import_reconciled: reconciliation.pass,
      reconciled_tables: Object.fromEntries(
        Object.entries(reconciliation.results).map(([table, value]) => [
          table,
          {
            source: value.source,
            destination: value.destination,
            missing: value.missing.length,
            changed: value.changed.length,
          },
        ]),
      ),
      guide_preserved: reconciliation.guides_preserved,
      settings_preserved: reconciliation.settings_preserved,
      replay_idempotent: replay.replayed === true,
      restore_reconciled: restoreReconciliation.pass,
      dependency_edges_created: graph,
      checklist_items_created: items,
      source_written: false,
      production_written: false,
    };
  } finally {
    await database.close?.();
    await restored.close?.();
  }
}
