# Verified Google-ledger migration

The source is read-only. Six live tabs are captured using metadata-grounded bounded CellData, then checked against a complete native XLSX export. System schema, hub configuration and workflow rules are fetched again. Original stored file bytes are downloaded privately and checked against their recorded size/SHA-256. Snapshots, IDs, mappings, hashes and reports remain outside this public repository. Folder state is checked by the original stable Drive ID; migration never moves or changes originals.

## Current verified cutover

The actual production import and idempotent same-batch replay passed on 2026-10-14: 45 source Tasks, 3 Files, 3 Links, 53 original Activity rows, 36 Settings rows and 18 Guide rows are preserved. The one native DATE deadline and 44 null deadlines match independent SQL `DATE::text` and canonical reads. Fresh source admission, complete original-field reconciliation and post-redeploy verification passed; no original Google source was written or moved and no source graph/hierarchy/checklist relationship was invented.

The actual post-DG36 check verified all 45 source tasks, 3 source files and 21 retained synthetic proof tasks. Cleanup later archived only the 25 recorded synthetic graph/redeploy tasks and removed exactly one synthetic template/rule/instance plus five recurrence membership rows through the guarded internal owner transaction. It retained task/graph/checklist/source/history/accepted-receipt rows. The current source-only native/canonical read-back again passes for all 45 tasks and 3 files. Final read-only verification confirms 45 active original tasks, 27 archived synthetic tasks and 72 total retained tasks; all three original download endpoints deny unauthenticated requests with HTTP 401 and no redirect. Source-backed counts are distinct from total physical rows containing archived proof history.

An encrypted snapshot with all 68 tasks present before cleanup was fully restored into hosted isolated staging; all tables and 48 accepted-operation results matched. The later final encrypted export after production QA-client revocation also passed persisted read-back/decryption/manifest validation: 72 tasks, 29 projects, 3 files/versions/links, 84 accepted operations, 150 activity rows, 104 source mappings and zero template/rule/instance/membership rows. This final export is not a second hosted restore claim. Live cloud bytes remain blocked; separate local encrypted byte recovery passed. See `MIGRATION_SUMMARY.md` and `BACKUP_AND_RECOVERY.md` for the observed evidence and limits. The following operator protocol remains mandatory for any future import; this successful cutover does not authorize another snapshot, changed source delta or production replacement.

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

The staging mode opens two disposable PostgreSQL engines, imports, reconciles exact original attrs and actual normalized destination fields, replays the batch, exports a full backup, restores into the second fresh engine and reconciles again. A matching retained source hash alone is insufficient: canonical task text/status/deadlines/revisions, project identity, Drive references and original version metadata, active/ended links, historical activity provenance/parsed JSON, source mappings, preferences and verified batch metadata must match too. Calendar DATE columns are reconciled using explicit SQL `DATE::text`, independently of the host timezone; the native application driver/API date readback remains a separate release gate. Neither production nor the source is written. Real production imports require the centrally owned schema to be migrated first and a fresh private live-read checkpoint with `verified_at`, `source_modified_time`, and `source_hash` matching the input. The checkpoint expires after ten minutes.

The repository's legitimate `.env.local` targets development/staging and must not select a production import. Replace the following example paths with actual absolute private paths outside Git. Verify the private production `DATABASE_URL` endpoint/branch and `OWNER_ID` against the separately recorded approved production resource and owner before committing; a successful staging rehearsal does not verify that destination.

```powershell
$productionEnvFile = 'C:/PRIVATE_LIFE_OS/production.env'
$privateSnapshot = 'C:/PRIVATE_LIFE_OS/migration-input.json'
$privateCheckpoint = 'C:/PRIVATE_LIFE_OS/source-checkpoint.json'
$privateReport = 'C:/PRIVATE_LIFE_OS/production-reconciliation.json'
pnpm exec tsx --env-file=$productionEnvFile scripts/migration/commit.ts $privateSnapshot $privateCheckpoint $privateReport --commit
```

`DATABASE_URL` and `OWNER_ID` select the owner namespace, independently from the authentication user's ID. Only the coordinator runs this production command after destination/schema admission, a private rollback export and the fresh source checkpoint. No credential is printed. The script repeats rehearsal, imports through the canonical `legacy_import` command and saves exact reconciliation privately. Repeated batch input uses the same idempotency key. It does not edit source Google data or enable any legacy writer.

Choose a new timestamped report filename and let the script create it; do not precreate an empty report. Source, checkpoint and report paths must be absolute private paths outside Git, including their resolved parents. The script reserves and synchronizes a `pending` report exclusively before acquiring the writer. Existing unrelated reports are preserved and rejected. Source freshness is checked again after rehearsal and immediately before the import. A received accepted result is saved before reconciliation, then the report becomes `verified` or `reconciliation_required`.

After a timeout or lost response, preserve the pending/accepted report and inspect it privately. An uncertain response does not prove rejection. Re-read the live source; if its hash remains identical, refresh the matching checkpoint and rerun the same snapshot/report/owner/destination. The canonical batch idempotency key remains identical and reconciles an already accepted import without duplicate records or audit events. Changed source input requires separate delta/conflict review and a new report. A reconciliation failure remains incomplete until reviewed; source originals remain untouched.

## Concurrency, rollback and cutover

One operator owns cutover. Re-read live modified time and complete rows whenever source revision changes. Compare current source against the snapshot before committing. The SQL command is owner-scoped, transactional, audited and idempotent. Google/Blob and SQL are separate systems; no cross-service atomicity is claimed. A partially uploaded byte store uses immutable operation keys and verifies read-back before SQL registration.

Before production schema/import changes, take an encrypted private backup and rehearse restore in an isolated workspace. Rollback restores an independently verified destination snapshot or fixes forward after conflict review. Source originals stay untouched and available. Preserve destination-generated tasks after cutover; a later source delta cannot silently replace them. Source freshness and private reconciliation are release evidence; passing unit tests alone is insufficient.
