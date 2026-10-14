import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import { hash } from "../../server/domain/core";
import { verifyBackupManifest } from "../../server/domain/migration";
import type {
  CommandName,
  DomainService,
  FileDTO,
  PageDTO,
  Principal,
  ReportsDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  expectedRevision?: number,
  key = randomUUID(),
  actor = principal,
) =>
  service.execute(command, input, actor, {
    expectedRevision,
    idempotencyKey: key,
  });
const metadata = (file_id: string) =>
  service.query(
    "file_get_metadata",
    { file_id },
    principal,
  ) as Promise<FileDTO>;
const file = async () => {
  const fileId = "F-synthetic-" + randomUUID();
  await exec("legacy_import", {
    batch_id: randomUUID(),
    source_hash: "synthetic-source",
    files: [
      {
        file_record_id: fileId,
        display_name: "Synthetic original",
        original_filename: "original.pdf",
        drive_file_id: "synthetic-drive",
        drive_url: "https://drive.google.com/file/d/synthetic/view",
        parent_folder_id: "synthetic-parent",
        state: "Inbox",
        sha256: "a".repeat(64),
        size_bytes: 123,
        notes: "exact source note",
        revision: 7,
      },
    ],
  });
  return fileId;
};
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-annotations-" + randomUUID(),
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});

describe("App-only file annotations and truthful owner reports", () => {
  it("metadata_changes_preserve_original_bytes_versions_source_refs_and_exact_retry_result", async () => {
    const id = await file();
    const before = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM files WHERE file_id=$1",
        [id],
      )
    ).rows[0];
    const versions = (
      await db.query("SELECT * FROM file_versions WHERE file_id=$1", [id])
    ).rows;
    const input = {
        file_id: id,
        description: "Owner description فارسی",
        tags: ["Research", "یادداشت"],
      },
      key = randomUUID();
    const changed = await exec("file_metadata_update", input, 7, key);
    expect(await exec("file_metadata_update", input, 7, key)).toMatchObject({
      replayed: true,
      audit_event_id: changed.audit_event_id,
    });
    expect(await metadata(id)).toMatchObject({
      file_id: id,
      revision: 8,
      description: input.description,
      tags: input.tags,
    });
    const after = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM files WHERE file_id=$1",
        [id],
      )
    ).rows[0];
    for (const field of Object.keys(before).filter(
      (field) => !["revision", "updated_at"].includes(field),
    ))
      expect(after[field]).toEqual(before[field]);
    expect(
      (await db.query("SELECT * FROM file_versions WHERE file_id=$1", [id]))
        .rows,
    ).toEqual(versions);
    expect(hash(after.legacy_metadata)).toBe(hash(before.legacy_metadata));
    await exec(
      "file_metadata_update",
      { file_id: id, description: "", tags: [] },
      8,
    );
    expect(await metadata(id)).toMatchObject({
      description: "",
      tags: [],
      revision: 9,
    });
  });
  it("invalid_annotations_owner_scope_stale_revision_and_composite_fk_fail_without_source_changes", async () => {
    const id = await file();
    for (const fields of [
      {},
      { description: null },
      { description: "x".repeat(10001) },
      { tags: null },
      { tags: [" "] },
      { tags: ["k\u0000"] },
      { tags: ["Research", "research"] },
      { tags: ["ی", "ي"] },
      { tags: Array.from({ length: 51 }, (_, i) => String(i)) },
      { tags: ["x".repeat(81)] },
      { sha256: "b".repeat(64) },
    ])
      await expect(
        exec("file_metadata_update", { file_id: id, ...fields }, 7),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec("file_metadata_update", { file_id: id, description: "x" }, 6),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      exec(
        "file_metadata_update",
        { file_id: id, description: "x" },
        7,
        randomUUID(),
        { ...principal, scopes: ["tasks:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      exec(
        "file_metadata_update",
        { file_id: id, description: "x" },
        7,
        randomUUID(),
        { ...principal, ownerId: "synthetic-other-" + randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect((await metadata(id)).revision).toBe(7);
    await db.query("INSERT INTO owners(owner_id) VALUES($1)", [
      "foreign-" + id,
    ]);
    await expect(
      db.query(
        "INSERT INTO file_annotations(file_id,owner_id,description) VALUES($1,$2,'foreign')",
        [id, "foreign-" + id],
      ),
    ).rejects.toThrow();
  });
  it("description_and_all_normalized_tags_are_filtered_before_owner_pagination", async () => {
    const a = await file(),
      b = await file();
    await exec(
      "file_metadata_update",
      {
        file_id: a,
        description: "Find این کلمه",
        tags: ["Research", "یادداشت"],
      },
      7,
    );
    await exec(
      "file_metadata_update",
      { file_id: b, description: "Other", tags: ["Research"] },
      7,
    );
    const found = (await service.query(
      "file_search",
      { search: "كلمه", tags: ["research", "يادداشت"], limit: 1 },
      principal,
    )) as PageDTO<FileDTO>;
    expect(found.total).toBe(1);
    expect(found.items[0].file_id).toBe(a);
    await expect(
      service.query(
        "file_search",
        { tags: [""] },
        { ...principal, ownerId: "synthetic-empty" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("annotated_backup_restores_original_ids_and_old_known_additive_absence_does_not_waive_original_checksums", async () => {
    const id = await file();
    await exec(
      "file_metadata_update",
      { file_id: id, description: "Exact", tags: ["Synthetic"] },
      7,
    );
    const backup = (await service.query(
      "backup_export",
      {},
      principal,
    )) as Record<string, unknown>;
    const fresh = await createTestDatabase();
    try {
      const restored = createDomainService(fresh);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restored.query("file_get_metadata", { file_id: id }, principal),
      ).toMatchObject({
        file_id: id,
        description: "Exact",
        tags: ["Synthetic"],
        revision: 8,
      });
    } finally {
      await fresh.close?.();
    }
    const original = structuredClone(backup) as {
      tables: Record<string, unknown>;
      checksums: Record<string, unknown>;
      manifest_hash: string;
    };
    delete original.tables.file_annotations;
    delete original.checksums.file_annotations;
    delete original.tables.event_reminders;
    delete original.checksums.event_reminders;
    original.manifest_hash = hash(original.checksums);
    expect(
      verifyBackupManifest(original, principal.ownerId).file_annotations,
    ).toEqual([]);
    (original.tables.files as Record<string, unknown>[])[0].title = "tampered";
    expect(() => verifyBackupManifest(original, principal.ownerId)).toThrow(
      /Backup checksum mismatch/,
    );
    const half = structuredClone(backup) as { tables: Record<string, unknown> };
    delete half.tables.file_annotations;
    expect(() => verifyBackupManifest(half, principal.ownerId)).toThrow(
      /Backup table and checksum/,
    );
  });
  it("registered_sizes_and_only_verified_blob_hash_candidates_are_complete_and_scope_limited", async () => {
    await file();
    for (const index of [1, 2]) {
      const id = "F-synthetic-blob-" + randomUUID();
      await db.query(
        "INSERT INTO files(file_id,owner_id,title,original_filename,provider,storage_key,size_bytes,sha256,version_group_id) VALUES($1,$2,$3,'synthetic.bin','private_blob',$4,100,$5,$6)",
        [
          id,
          principal.ownerId,
          "Synthetic verified bytes " + index,
          "synthetic-private-key-" + index,
          "a".repeat(64),
          randomUUID(),
        ],
      );
      await db.query(
        "INSERT INTO file_versions(version_id,owner_id,file_id,storage_key,sha256,size_bytes) SELECT $2,owner_id,file_id,storage_key,sha256,size_bytes FROM files WHERE file_id=$1",
        [id, randomUUID()],
      );
    }
    const report = (await service.query(
      "reports_summary",
      {},
      principal,
    )) as ReportsDTO;
    expect(report.registered_files).toMatchObject({
      scope: "owner_registered_records",
      total: 3,
      known_size_bytes: "323",
      unknown_size_count: 0,
    });
    expect(report.duplicate_candidates).toMatchObject({
      total_groups: 1,
      excluded_unverified_count: 1,
      groups: [{ file_count: 2, size_bytes: "100", truncated: false }],
    });
    expect(
      report.duplicate_candidates?.groups[0].files.every(
        (f) => f.provider === "private_blob",
      ),
    ).toBe(true);
    expect(
      await service.query(
        "reports_summary",
        {},
        { ...principal, scopes: ["tasks:read"] },
      ),
    ).toMatchObject({
      files_scope_granted: false,
      registered_files: null,
      duplicate_candidates: null,
    });
    const empty = (await service.query(
      "reports_summary",
      {},
      { ...principal, ownerId: "synthetic-empty" },
    )) as ReportsDTO;
    expect(empty.registered_files?.total).toBe(0);
    expect(empty.duplicate_candidates?.total_groups).toBe(0);
  });
  it("density_accessibility_and_retention_are_durable_configuration_with_no_history_deletion", async () => {
    const task = await exec("task_create", {
      title: "Synthetic retained history",
    });
    const first = await exec(
      "preferences_update",
      {
        settings: {
          display_density: "compact",
          accessibility: { reduced_motion: true },
          retention_days: 0,
        },
      },
      0,
    );
    await exec(
      "preferences_update",
      { settings: { accessibility: { large_text: true }, retention_days: 30 } },
      first.version,
    );
    expect(await service.query("preferences_get", {}, principal)).toMatchObject(
      {
        settings: {
          display_density: "compact",
          accessibility: { reduced_motion: true, large_text: true },
          retention_days: 30,
        },
      },
    );
    for (const settings of [
      { display_density: "unknown" },
      { density: "compact" },
      { large_text: true },
      { reduce_motion: true },
      { reduced_motion: true },
      { retention_days: -1 },
      { retention_days: 36501 },
      { accessibility: { high_contrast: "yes" } },
      { accessibility: { delete_history: true } },
    ])
      await expect(
        exec("preferences_update", { settings }, 2),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec("preferences_update", { settings: { retention_days: 0 } }, 1),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      await service.query("task_get", { task_id: task.entity_id }, principal),
    ).toMatchObject({ task_id: task.entity_id });
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND entity_id=$2",
          [principal.ownerId, task.entity_id],
        )
      ).rows.length,
    ).toBeGreaterThan(0);
  });
});
