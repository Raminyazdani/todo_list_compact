# Verified Google-ledger migration

The source is read-only. Six live tabs are captured using metadata-grounded bounded CellData, then checked against a complete native XLSX export. System schema, hub configuration and workflow rules are fetched again. Original stored file bytes are downloaded privately and checked against their recorded size/SHA-256. Snapshots, IDs, mappings, hashes and reports remain outside this public repository. Folder state is checked by the original stable Drive ID; migration never moves or changes originals.

## Transform and preserve

Tasks retain immutable source task IDs, exact title/notes/next action/waiting text, source status/priority/category, original timestamps and revision. Spreadsheet DATE serials become local ISO calendar dates using the 1899-12-30 base. A blank deadline remains blank/null; it does not become midnight or today. UTC instants use the original explicit offset and render with Europe/Berlin. Source project labels map deterministically to normalized projects and remain in complete `legacy_metadata`.

Files retain original file-record ID, Drive ID/URL/parent, original filename, byte size/checksum, version group/label, retention timestamps and all unmapped attrs. External references remain protected. Task/file links retain link ID, active state, purpose, ended-at, notes and revision; active uniqueness is the task/file/purpose triple. Original Activity retains event/operation ID, actor, result, original JSON strings and timestamps; no historical result is rewritten. Settings and Guide are retained in private migration-batch metadata and preferences. Every original record is retained in legacy metadata and source mappings.

The old source has no authoritative dependency, checklist or hierarchy fields. Import creates **zero** invented graph/checklist records. AI suggestions require a separate review and cannot be part of historical import.

## Rehearsal and commit

`scripts/migration/core.ts` validates all six tables, required stable IDs, enums, dates, timestamp offsets, checksums, revisions, duplicate identities/relations and foreign links. Problem rows remain in quarantine reports; any source validation problem blocks the normal commit. Canonical hashes ignore spreadsheet row order. Delta reports show added/changed/missing IDs, never infer permission to delete missing records. Existing changed destination records enter SQL quarantine instead of being overwritten.

```
pnpm exec tsx scripts/migration/cli.ts PRIVATE_SNAPSHOT --dry-run --private-report PRIVATE_REPORT
pnpm exec tsx scripts/migration/cli.ts PRIVATE_SNAPSHOT --staging-dry-run
```

The staging mode opens two disposable PostgreSQL engines, imports, reconciles exact original attrs, replays the batch, exports a full backup, restores into the second fresh engine and reconciles again. Neither production nor the source is written. Real production imports require the centrally owned schema to be migrated first and a fresh private live-read checkpoint with `verified_at`, `source_modified_time`, and `source_hash` matching the input. The checkpoint expires after ten minutes.

```
pnpm exec tsx --env-file=.env.local scripts/migration/commit.ts PRIVATE_SNAPSHOT PRIVATE_CHECKPOINT PRIVATE_REPORT --commit
```

`DATABASE_URL` and `OWNER_ID` select the authenticated owner namespace. No credential is printed. The script repeats rehearsal, imports through the canonical `legacy_import` command and saves exact reconciliation privately. Repeated batch input uses the same idempotency key. It does not edit source Google data or enable any legacy writer.

## Concurrency, rollback and cutover

One operator owns cutover. Re-read live modified time and complete rows whenever source revision changes. Compare current source against the snapshot before committing. The SQL command is owner-scoped, transactional, audited and idempotent. Google/Blob and SQL are separate systems; no cross-service atomicity is claimed. A partially uploaded byte store uses immutable operation keys and verifies read-back before SQL registration.

Before production schema/import changes, take an encrypted private backup and rehearse restore in an isolated workspace. Rollback restores an independently verified destination snapshot or fixes forward after conflict review. Source originals stay untouched and available. Preserve destination-generated tasks after cutover; a later source delta cannot silently replace them. Source freshness and private reconciliation are release evidence; passing unit tests alone is insufficient.
