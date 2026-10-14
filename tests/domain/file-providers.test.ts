import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type { Database } from "../../server/db/database";
import { MIGRATION_SQL } from "../../server/db/schema";
import { createDomainService } from "../../server/domain/service";
import type {
  DomainService,
  FileProvider,
  Principal,
  ReportsDTO,
} from "../../shared/contracts";
import { hash } from "../../server/domain/core";
import { createTestDatabase } from "./database";

let db: Database, domain: DomainService;
const principal: Principal = {
  ownerId: "synthetic-file-provider-owner",
  actorId: "synthetic-provider-reviewer",
  channel: "UI",
  scopes: ["admin:manage"],
};
const sha = createHash("sha256")
  .update("synthetic verified bytes")
  .digest("hex");
async function seed(fileId: string, provider: FileProvider, verified = true) {
  await db.query(
    "INSERT INTO owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
    [principal.ownerId],
  );
  const privateFile = provider !== "google_drive";
  const storageKey = privateFile
    ? `owners/${createHash("sha256").update(principal.ownerId).digest("hex")}/files/${createHash("sha256").update(fileId).digest("hex")}/original`
    : null;
  await db.query(
    "INSERT INTO files(file_id,owner_id,title,original_filename,provider,external_id,external_url,storage_key,size_bytes,sha256,version_group_id,state,parent_id,last_active_parent_id,legacy_metadata) VALUES($1,$2,$1,'synthetic.txt',$3,$4,$5,$6,24,$7,$8,$9,$10,$10,$11::jsonb)",
    [
      fileId,
      principal.ownerId,
      provider,
      privateFile ? null : "synthetic-drive-id",
      privateFile
        ? null
        : "https://drive.google.com/file/d/synthetic-drive-id/view",
      storageKey,
      sha,
      "VG-" + fileId,
      privateFile ? "Inbox" : "External",
      privateFile ? null : "synthetic-original-folder",
      JSON.stringify({
        original_note: "synthetic preserved source",
        original_provider: provider,
      }),
    ],
  );
  if (verified)
    await db.query(
      "INSERT INTO file_versions(version_id,owner_id,file_id,storage_key,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,24)",
      ["V-" + fileId, principal.ownerId, fileId, storageKey, sha],
    );
}
async function rows() {
  return (
    await db.query("SELECT * FROM files WHERE owner_id=$1 ORDER BY file_id", [
      principal.ownerId,
    ])
  ).rows;
}
beforeEach(async () => {
  db = await createTestDatabase();
  domain = createDomainService(db);
});
afterEach(async () => db.close?.());

describe("Neon file metadata provider compatibility on isolated PostgreSQL; no provider I/O", () => {
  it("additive_provider_CHECK_migrates_old_Google_and_Blob_rows_without_changing_any_field_and_is_idempotent", async () => {
    await seed("F-synthetic-google", "google_drive");
    await seed("F-synthetic-blob", "private_blob");
    await db.query("ALTER TABLE files DROP CONSTRAINT files_provider_check");
    await db.query(
      "ALTER TABLE files ADD CONSTRAINT files_provider_check CHECK(provider IN ('google_drive','private_blob'))",
    );
    const before = hash(await rows());
    // PGlite's prepared-query adapter cannot accept the entire multi-statement
    // migration. Execute the actual single additive DO block on its PG engine.
    const addition = MIGRATION_SQL.match(/DO \$\$ BEGIN[\s\S]*?END \$\$;/)?.[0];
    expect(addition).toContain("files_provider_check");
    expect(addition).toContain("neon_object_storage");
    await db.query(addition!);
    expect(hash(await rows())).toBe(before);
    await seed("F-synthetic-neon", "neon_object_storage");
    const after = hash(await rows());
    await db.query(addition!);
    expect(hash(await rows())).toBe(after);
    const definition = (
      await db.query<{ definition: string }>(
        "SELECT pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='files'::regclass AND conname='files_provider_check'",
      )
    ).rows;
    expect(definition).toHaveLength(1);
    expect(definition[0].definition).toContain("neon_object_storage");
    await expect(
      db.query(
        "INSERT INTO files(file_id,owner_id,title,original_filename,provider,version_group_id) VALUES('F-synthetic-invalid',$1,'Invalid','invalid.txt','arbitrary_s3','VG-invalid')",
        [principal.ownerId],
      ),
    ).rejects.toThrow(/check constraint/);
    expect(hash(await rows())).toBe(after);
  });

  it("old_and_new_portable_v1_backups_restore_provider_keys_versions_and_Google_original_metadata_exactly", async () => {
    await seed("F-synthetic-google", "google_drive");
    await seed("F-synthetic-blob", "private_blob");
    const oldBackup = (await domain.query("backup_export", {}, principal)) as {
      checksums: Record<string, string>;
      tables: Record<string, unknown[]>;
    };
    await seed("F-synthetic-neon", "neon_object_storage");
    const nextBackup = (await domain.query(
      "backup_export",
      {},
      principal,
    )) as typeof oldBackup;
    for (const backup of [oldBackup, nextBackup]) {
      const isolated = await createTestDatabase();
      try {
        const restore = createDomainService(isolated);
        await restore.execute(
          "backup_restore",
          { backup, explicit_user_intent: true },
          principal,
          { idempotencyKey: "synthetic-provider-restore-operation" },
        );
        const exported = (await restore.query(
          "backup_export",
          {},
          principal,
        )) as typeof oldBackup;
        expect(exported.checksums.files).toBe(backup.checksums.files);
        expect(exported.checksums.file_versions).toBe(
          backup.checksums.file_versions,
        );
        expect(exported.tables.files).toEqual(backup.tables.files);
        expect(exported.tables.file_versions).toEqual(
          backup.tables.file_versions,
        );
      } finally {
        await isolated.close?.();
      }
    }
  });

  it("linked_task_reopen_restores_both_private_providers_without_changing_bytes_or_Google_reference", async () => {
    await seed("F-synthetic-blob", "private_blob");
    await seed("F-synthetic-neon", "neon_object_storage");
    await seed("F-synthetic-google", "google_drive");
    const created = await domain.execute(
      "task_create",
      { title: "Synthetic file review" },
      principal,
      { idempotencyKey: "synthetic-provider-task-create" },
    );
    for (const fileId of [
      "F-synthetic-blob",
      "F-synthetic-neon",
      "F-synthetic-google",
    ])
      await domain.execute(
        "file_link_to_task",
        { file_id: fileId, task_id: created.entity_id, purpose: "Reference" },
        principal,
        { idempotencyKey: "synthetic-link-" + fileId },
      );
    const completed = await domain.execute(
      "task_complete",
      { task_id: created.entity_id },
      principal,
      {
        idempotencyKey: "synthetic-provider-task-complete",
        expectedRevision: 1,
      },
    );
    const versions = (
      await db.query(
        "SELECT * FROM file_versions WHERE owner_id=$1 ORDER BY version_id",
        [principal.ownerId],
      )
    ).rows;
    const beforeGoogle = (await rows()).find(
      (row) => row.file_id === "F-synthetic-google",
    );
    for (const fileId of ["F-synthetic-blob", "F-synthetic-neon"])
      await domain.execute(
        "file_archive",
        { file_id: fileId, explicit_user_intent: true },
        principal,
        { idempotencyKey: "synthetic-archive-" + fileId, expectedRevision: 1 },
      );
    const archived = await rows();
    expect(
      archived
        .filter((row) => row.provider !== "google_drive")
        .map((row) => row.state),
    ).toEqual(["Old", "Old"]);
    await domain.execute(
      "task_reopen",
      { task_id: created.entity_id },
      principal,
      {
        idempotencyKey: "synthetic-provider-task-reopen",
        expectedRevision: completed.version,
      },
    );
    const restored = await rows();
    for (const fileId of ["F-synthetic-blob", "F-synthetic-neon"])
      expect(restored.find((row) => row.file_id === fileId)).toMatchObject({
        state: "Active",
        archived_at: null,
        revision: 3,
        sha256: sha,
        size_bytes: 24,
      });
    expect(
      restored.find((row) => row.file_id === "F-synthetic-google"),
    ).toEqual(beforeGoogle);
    expect(
      (
        await db.query(
          "SELECT * FROM file_versions WHERE owner_id=$1 ORDER BY version_id",
          [principal.ownerId],
        )
      ).rows,
    ).toEqual(versions);
  });

  it("registered_size_groups_and_duplicate_evidence_include_Neon_without_reclassifying_Google_or_unverified_bytes", async () => {
    await seed("F-synthetic-google", "google_drive");
    await seed("F-synthetic-blob", "private_blob");
    const blobOnly = (await domain.query(
      "reports_summary",
      {},
      principal,
    )) as ReportsDTO;
    expect(blobOnly.duplicate_candidates?.basis).toBe(
      "canonical_verified_private_blob_sha256",
    );
    await seed("F-synthetic-neon-one", "neon_object_storage");
    await seed("F-synthetic-neon-two", "neon_object_storage");
    await seed("F-synthetic-neon-unverified", "neon_object_storage", false);
    const report = (await domain.query(
      "reports_summary",
      {},
      principal,
    )) as ReportsDTO;
    expect(report.registered_files).toMatchObject({
      scope: "owner_registered_records",
      total: 5,
      known_size_bytes: "120",
      unknown_size_count: 0,
    });
    expect(report.registered_files?.by_source).toEqual(
      expect.arrayContaining([
        {
          source: "neon_object_storage",
          total: 3,
          known_size_bytes: "72",
          unknown_size_count: 0,
        },
        {
          source: "private_blob",
          total: 1,
          known_size_bytes: "24",
          unknown_size_count: 0,
        },
        {
          source: "external_google_reference",
          total: 1,
          known_size_bytes: "24",
          unknown_size_count: 0,
        },
      ]),
    );
    expect(report.duplicate_candidates).toMatchObject({
      basis: "canonical_verified_private_storage_sha256",
      total_groups: 1,
      excluded_unverified_count: 2,
    });
    expect(report.duplicate_candidates?.groups[0].file_count).toBe(3);
    expect(
      report.duplicate_candidates?.groups[0].files
        .map((file) => file.file_id)
        .sort(),
    ).toEqual([
      "F-synthetic-blob",
      "F-synthetic-neon-one",
      "F-synthetic-neon-two",
    ]);
    const denied = (await domain.query(
      "reports_summary",
      {},
      { ...principal, scopes: ["tasks:read"] },
    )) as ReportsDTO;
    expect(denied.registered_files).toBeNull();
    expect(denied.duplicate_candidates).toBeNull();
  });
});
