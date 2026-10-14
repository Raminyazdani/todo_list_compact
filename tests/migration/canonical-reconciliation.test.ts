import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "../../server/db/database";
import type { Principal } from "../../shared/contracts";
import { createDomainService } from "../../server/domain/service";
import { hash as domainHash } from "../../server/domain/core";
import {
  importPrepared,
  prepareMigration,
  reconcileMigration,
  recordHash,
  type MigrationPreparation,
} from "../../scripts/migration/core";
import { createIsolatedStagingDatabase } from "../../scripts/migration/staging";
import { syntheticSnapshot } from "./fixtures";

let database: Database;
let prepared: MigrationPreparation;
let principal: Principal;
let sequence = 0;
beforeAll(async () => {
  database = await createIsolatedStagingDatabase();
}, 30000);
afterAll(async () => {
  await database?.close?.();
});
beforeEach(async () => {
  const suffix = "-canonical-" + ++sequence;
  const source = syntheticSnapshot();
  for (const table of ["Tasks", "Files", "Links", "Activity"] as const)
    for (const row of source.tables[table])
      for (const field of [
        "task_id",
        "file_record_id",
        "link_id",
        "event_id",
        "entity_id",
        "operation_id",
      ])
        if (typeof row[field] === "string" && row[field]) row[field] += suffix;
  source.tables.Tasks[0].unknown_source_field = {
    literal: "=not a formula",
    nested: ["حفظ عین متن"],
  };
  source.tables.Tasks[1].due_date = "2055-12-20";
  source.tables.Tasks[1].due_at = "2055-12-20T13:14:15+03:30";
  source.tables.Files[0].sha256 = "a".repeat(64);
  source.tables.Links.push({
    ...source.tables.Links[0],
    link_id: "L-inactive" + suffix,
    active: false,
    ended_at: "2026-10-11T16:00:00+03:30",
    notes: "Retained ended relation",
  });
  source.tables.Activity.push({
    ...source.tables.Activity[0],
    event_id: "E-pending" + suffix,
    result: "Pending",
    before_json: "malformed historical JSON",
    after_json: "null",
    entity_id: "",
  });
  principal = {
    ownerId: "reconciliation-owner" + suffix,
    actorId: "synthetic-auditor",
    channel: "import",
    scopes: ["admin:manage"],
  };
  prepared = prepareMigration(source);
  expect(prepared.ready).toBe(true);
  await importPrepared(createDomainService(database), prepared, principal);
  expect(
    (await reconcileMigration(database, principal.ownerId, prepared)).pass,
  ).toBe(true);
});
const reconcile = () =>
  reconcileMigration(database, principal.ownerId, prepared);
const sourceId = (
  table: "Tasks" | "Files" | "Links" | "Activity",
  key: string,
  index = 0,
) => String(prepared.tables[table][index][key]);

describe("Canonical destination reconciliation independently of retained raw source", () => {
  it("correct offset instants, null/date deadlines, ended links, malformed historical JSON and source metadata survive real export and restore", async () => {
    const backup = await createDomainService(database).query(
      "backup_export",
      {},
      principal,
    );
    const restored = await createIsolatedStagingDatabase();
    try {
      await createDomainService(restored).execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: "canonical-restore" },
      );
      expect(
        await reconcileMigration(restored, principal.ownerId, prepared),
      ).toMatchObject({
        pass: true,
        batch_verified: true,
        canonical_settings_preserved: true,
        canonical_guide_preserved: true,
      });
      const activity = (
        await restored.query<{
          before: unknown;
          after: unknown;
          entity_id: string;
        }>(
          "SELECT before,after,entity_id FROM activity_events WHERE event_id=$1",
          [sourceId("Activity", "event_id", 1)],
        )
      ).rows[0];
      expect(activity).toEqual({
        before: { unparsed_legacy_json: "malformed historical JSON" },
        after: null,
        entity_id: "",
      });
    } finally {
      await restored.close?.();
    }
  }, 30000);

  it("title/status/notes/revision tampering fails although legacy_metadata is still byte-equivalent", async () => {
    const id = sourceId("Tasks", "task_id");
    await database.query(
      "UPDATE tasks SET title='changed',status='Next',notes='changed body',revision=99 WHERE task_id=$1",
      [id],
    );
    const retained = (
      await database.query<{ legacy_metadata: unknown }>(
        "SELECT legacy_metadata FROM tasks WHERE task_id=$1",
        [id],
      )
    ).rows[0].legacy_metadata;
    expect(recordHash(retained)).toBe(recordHash(prepared.tables.Tasks[0]));
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Tasks.changed).toContain(id);
    expect(result.results.Tasks.canonical_mismatches[id]).toEqual(
      expect.arrayContaining(["title", "status", "notes", "revision"]),
    );
  });

  it("changed SQL DATE or blank deadline changed to a date is detected without using a local-midnight DATE driver value", async () => {
    const first = sourceId("Tasks", "task_id"),
      second = sourceId("Tasks", "task_id", 1);
    await database.query(
      "UPDATE tasks SET due_date='2055-12-19' WHERE task_id=$1",
      [second],
    );
    await database.query(
      "UPDATE tasks SET due_date='2055-12-20' WHERE task_id=$1",
      [first],
    );
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Tasks.canonical_mismatches[first]).toContain(
      "due_date",
    );
    expect(result.results.Tasks.canonical_mismatches[second]).toContain(
      "due_date",
    );
    // Model the unsafe scalar DATE parser only for a query without explicit casts.
    const dangerousDriver: Database = {
      ...database,
      query: async <T>(sql: string, params?: unknown[]) => {
        const result = await database.query<T>(sql, params);
        if (sql.includes("FROM tasks") && !sql.includes("due_date::text"))
          for (const row of result.rows as Record<string, unknown>[])
            if (row.due_date) row.due_date = new Date("2055-12-19T23:00:00Z");
        return result;
      },
    };
    await database.query("UPDATE tasks SET due_date=$2 WHERE task_id=$1", [
      first,
      null,
    ]);
    await database.query("UPDATE tasks SET due_date=$2 WHERE task_id=$1", [
      second,
      "2055-12-20",
    ]);
    expect(
      (await reconcileMigration(dangerousDriver, principal.ownerId, prepared))
        .pass,
    ).toBe(true);
  });

  it("active flags, ended timestamps and relationship pointers are compared independently for both active and historical links", async () => {
    const active = sourceId("Links", "link_id"),
      ended = sourceId("Links", "link_id", 1);
    await database.query(
      "UPDATE file_task_links SET active=false,task_id=$2,ended_at='2026-12-01T00:00:00Z' WHERE link_id=$1",
      [active, sourceId("Tasks", "task_id", 1)],
    );
    await database.query(
      "UPDATE file_task_links SET ended_at=NULL WHERE link_id=$1",
      [ended],
    );
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Links.canonical_mismatches[active]).toEqual(
      expect.arrayContaining(["active", "task_id", "ended_at"]),
    );
    expect(result.results.Links.canonical_mismatches[ended]).toContain(
      "ended_at",
    );
  });

  it("Drive provider/reference/parent/protection and original immutable version metadata are real destination gates", async () => {
    const id = sourceId("Files", "file_record_id");
    await database.query(
      "UPDATE files SET provider='private_blob',external_url='https://example.invalid/changed',parent_id='changed',protected=false WHERE file_id=$1",
      [id],
    );
    await database.query(
      "UPDATE file_versions SET sha256=$2,size_bytes=8 WHERE file_id=$1",
      [id, "b".repeat(64)],
    );
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Files.canonical_mismatches[id]).toEqual(
      expect.arrayContaining([
        "provider",
        "external_url",
        "parent_id",
        "protected",
        "original_version.sha256",
        "original_version.size_bytes",
      ]),
    );
  });

  it("historical actor/channel/operation/entity provenance and parsed JSON corruption cannot hide behind original activity metadata", async () => {
    const id = sourceId("Activity", "event_id");
    // Append-only protects ordinary writes. Model an importer/restore mapping
    // defect by restoring a validly checksummed synthetic backup into a fresh DB.
    await expect(
      database.query(
        "UPDATE activity_events SET actor_id='forged' WHERE event_id=$1",
        [id],
      ),
    ).rejects.toThrow("append-only");
    const backup = structuredClone(
      await createDomainService(database).query("backup_export", {}, principal),
    ) as {
      tables: Record<string, Record<string, unknown>[]>;
      checksums: Record<string, string>;
      manifest_hash: string;
    };
    const activity = backup.tables.activity_events.find(
      (row) => row.event_id === id,
    )!;
    Object.assign(activity, {
      actor_id: "forged",
      channel: "UI",
      operation_id: "forged",
      after: {},
    });
    backup.checksums.activity_events = domainHash(
      backup.tables.activity_events,
    );
    backup.manifest_hash = domainHash(backup.checksums);
    const restored = await createIsolatedStagingDatabase();
    try {
      await createDomainService(restored).execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: "corrupt-canonical-history" },
      );
      const result = await reconcileMigration(
        restored,
        principal.ownerId,
        prepared,
      );
      expect(result.pass).toBe(false);
      expect(result.results.Activity.canonical_mismatches[id]).toEqual(
        expect.arrayContaining([
          "actor_id",
          "channel",
          "operation_id",
          "after",
        ]),
      );
    } finally {
      await restored.close?.();
    }
  }, 30000);

  it("project identity and source mapping corruption are detected independently from the correctly retained task metadata", async () => {
    const id = sourceId("Tasks", "task_id");
    const projectId = `P-legacy-${domainHash({ owner: principal.ownerId, project: prepared.tables.Tasks[0].project }).slice(0, 24)}`;
    await database.query(
      "UPDATE projects SET title='tampered project' WHERE project_id=$1",
      [projectId],
    );
    await database.query(
      "UPDATE source_mappings SET destination_id='wrong' WHERE owner_id=$1 AND source_kind='Tasks' AND source_id=$2",
      [principal.ownerId, id],
    );
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Tasks.canonical_mismatches[id]).toEqual(
      expect.arrayContaining(["project_source", "source_mapping"]),
    );
  });

  it("canonical settings/guide and verified batch metadata are gates even if the raw six-table batch snapshot still matches", async () => {
    await database.query(
      "UPDATE preferences SET settings=jsonb_set(settings,'{legacy_settings,timezone}','\"Asia/Tehran\"'::jsonb) WHERE owner_id=$1",
      [principal.ownerId],
    );
    await database.query(
      "UPDATE preferences SET settings=jsonb_set(settings,'{legacy_guide}','[]'::jsonb) WHERE owner_id=$1",
      [principal.ownerId],
    );
    await database.query(
      "UPDATE migration_batches SET source_hash='wrong' WHERE batch_id=$1",
      [prepared.batchId],
    );
    expect(await reconcile()).toMatchObject({
      pass: false,
      settings_preserved: true,
      guides_preserved: true,
      canonical_settings_preserved: false,
      canonical_guide_preserved: false,
      batch_verified: false,
    });
  });

  it("unknown source attributes remain required even when every normalized destination field is correct", async () => {
    const id = sourceId("Tasks", "task_id");
    await database.query(
      "UPDATE tasks SET legacy_metadata=legacy_metadata-'unknown_source_field' WHERE task_id=$1",
      [id],
    );
    const result = await reconcile();
    expect(result.pass).toBe(false);
    expect(result.results.Tasks.changed).toContain(id);
    expect(result.results.Tasks.canonical_mismatches[id]).toBeUndefined();
  });
});
