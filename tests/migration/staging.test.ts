import { describe, expect, it } from "vitest";
import {
  rehearseMigration,
  createIsolatedStagingDatabase,
} from "../../scripts/migration/staging";
import {
  importPrepared,
  prepareMigration,
  reconcileMigration,
} from "../../scripts/migration/core";
import { createDomainService } from "../../server/domain/service";
import { syntheticSnapshot } from "./fixtures";
import type { Principal } from "../../shared/contracts";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-owner",
  channel: "import",
  scopes: ["admin:manage"],
};
describe("PostgreSQL migration and recovery", () => {
  it("source import, exact field reconciliation, replay and staging backup restore create zero invented graph data", async () => {
    expect(await rehearseMigration(syntheticSnapshot())).toMatchObject({
      pass: true,
      import_reconciled: true,
      replay_idempotent: true,
      restore_reconciled: true,
      dependency_edges_created: 0,
      checklist_items_created: 0,
      source_written: false,
      production_written: false,
    });
  }, 30000);
  it("row-order replay preserves IDs and unknown source attrs while conflicts quarantine rather than overwrite", async () => {
    const database = await createIsolatedStagingDatabase();
    try {
      const service = createDomainService(database),
        source = syntheticSnapshot();
      source.tables.Tasks[0].unknown_source_field = "retain exactly";
      const prepared = prepareMigration(source);
      await importPrepared(service, prepared, principal);
      const reordered = structuredClone(source);
      reordered.tables.Tasks.reverse();
      expect(
        (await importPrepared(service, prepareMigration(reordered), principal))
          .replayed,
      ).toBe(true);
      expect(
        (await reconcileMigration(database, principal.ownerId, prepared)).pass,
      ).toBe(true);
      const changed = structuredClone(source);
      changed.tables.Tasks[0].notes = "A newly edited source field";
      const result = await importPrepared(
        service,
        prepareMigration(changed),
        principal,
      );
      expect(result.data).toMatchObject({ counts: { quarantined: 1 } });
      const records = (
        await database.query<{ legacy_metadata: { notes: string } }>(
          "SELECT legacy_metadata FROM tasks WHERE task_id=$1",
          ["T-synthetic-one"],
        )
      ).rows;
      expect(records[0].legacy_metadata.notes).toBe("=SUM(1,2)");
      expect(
        (
          await database.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM migration_quarantine",
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await database.close?.();
    }
  }, 30000);
  it("invalid source blocks before opening a destination mutation", async () => {
    const source = syntheticSnapshot();
    source.tables.Links[0].file_record_id = "missing-file";
    expect(await rehearseMigration(source)).toMatchObject({
      pass: false,
      quarantined: 1,
      source_written: false,
      production_written: false,
    });
  });
});
