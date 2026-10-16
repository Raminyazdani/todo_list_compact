import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database, SqlClient } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import { queryTransactionMode } from "../../server/domain/query-transaction-mode";
import {
  QUERY_NAMES,
  type Principal,
  type PreviewDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

describe("Canonical pure-read transaction routing", () => {
  let db: Database;
  const principal: Principal = {
    ownerId: "synthetic-query-routing-" + randomUUID(),
    actorId: "synthetic-query-routing-actor",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close?.();
  });

  it("explicitly_classifies_every_query_and_preserves_delegated_writes", () => {
    const exclusive = QUERY_NAMES.filter(
      (operation) => queryTransactionMode(operation) === "exclusive",
    );
    expect(exclusive.sort()).toEqual(
      [
        "task_dependency_add_preview",
        "task_dependency_remove_preview",
        "task_dependency_waive_preview",
        "task_dependency_restore_preview",
        "subtask_reparent_preview",
        "task_template_instantiate_preview",
        "task_batch_preview",
        "calendar_occurrence_reschedule_preview",
        "time_entry_import_preview",
        "calendar_event_change_preview",
      ].sort(),
    );
    for (const operation of QUERY_NAMES)
      expect(["read", "exclusive"]).toContain(queryTransactionMode(operation));
    expect(queryTransactionMode("task_completion_impact_preview")).toBe("read");
    expect(queryTransactionMode("file_archive_preview")).toBe("read");
  });

  it("pure_first_owner_reads_do_not_initialize_owner_or_issue_SQL_writes", async () => {
    const statements: string[] = [];
    let reads = 0,
      writes = 0;
    const traced = (tx: SqlClient): SqlClient => ({
      query: async (sql, params) => {
        statements.push(sql);
        return tx.query(sql, params);
      },
    });
    const adapter: Database = {
      query: db.query,
      transaction: (owner, action) => {
        writes++;
        return db.transaction(owner, action);
      },
      readTransaction: (owner, action) => {
        reads++;
        return db.transaction(owner, (tx) => action(traced(tx)));
      },
    };
    const service = createDomainService(adapter);
    expect(await service.query("preferences_get", {}, principal)).toEqual({
      settings: {},
      revision: 0,
    });
    expect(await service.query("whoami", {}, principal)).toMatchObject({
      owner_id: principal.ownerId,
    });
    expect(reads).toBe(2);
    expect(writes).toBe(0);
    expect(statements.every((sql) => /^SELECT\b/.test(sql))).toBe(true);
    expect(
      (
        await db.query("SELECT owner_id FROM owners WHERE owner_id=$1", [
          principal.ownerId,
        ])
      ).rows,
    ).toHaveLength(0);
  });

  it("adapters_without_read_transactions_retain_owner_initialization_and_pinned_fallback", async () => {
    const fallback = {
      ...principal,
      ownerId: "synthetic-query-fallback-" + randomUUID(),
    };
    await createDomainService(db).query("whoami", {}, fallback);
    expect(
      (
        await db.query("SELECT owner_id FROM owners WHERE owner_id=$1", [
          fallback.ownerId,
        ])
      ).rows,
    ).toHaveLength(1);
  });

  it("stored_preview_uses_exclusive_path_and_persists_receipt_while_impact_preview_stays_pure", async () => {
    let reads = 0,
      writes = 0;
    const adapter: Database = {
      query: db.query,
      transaction: (owner, action) => {
        writes++;
        return db.transaction(owner, action);
      },
      readTransaction: (owner, action) => {
        reads++;
        return db.transaction(owner, action);
      },
    };
    const service = createDomainService(adapter);
    const a = await service.execute(
      "task_create",
      { title: "Synthetic routing dependent" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const b = await service.execute(
      "task_create",
      { title: "Synthetic routing prerequisite" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    reads = writes = 0;
    const impact = await service.query(
      "task_completion_impact_preview",
      { task_id: b.entity_id },
      principal,
    );
    expect(impact).toMatchObject({ read_only: true });
    const preview = (await service.query(
      "task_dependency_add_preview",
      {
        task_id: a.entity_id,
        prerequisites: [{ task_id: b.entity_id }],
      },
      principal,
    )) as PreviewDTO;
    expect(reads).toBe(1);
    expect(writes).toBe(1);
    expect(
      (
        await db.query(
          "SELECT preview_id FROM command_previews WHERE owner_id=$1 AND preview_id=$2",
          [principal.ownerId, preview.preview_id],
        )
      ).rows,
    ).toHaveLength(1);
    expect(
      (
        await db.query(
          "SELECT edge_id FROM task_dependency_edges WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows,
    ).toHaveLength(0);
  });
});
