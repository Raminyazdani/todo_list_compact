# Backup and recovery

`backup_export` produces an authenticated, owner-scoped snapshot of normalized tasks/projects, dependency groups/edges, hierarchy, checklists/items, templates, file versions/relations, source mappings, Activity, preferences, events, hours, jobs and accepted idempotency-operation results. Preserving accepted results prevents old client retries from duplicating writes after a restore. Authentication credentials/sessions remain separate. Per-table checksums and a manifest hash protect consistency. Real exports contain private data and must never be Git files, public CI artifacts or issue attachments. Original external Google pointers are preserved; a relational snapshot alone is not an independent copy of external file bytes.

`server/integrations/backup.ts` provides AES-256-GCM authenticated encryption with per-backup random salt/nonce and scrypt key derivation. Use a unique strong passphrase outside logs, source and client bundles. Wrong keys/tampering fail authentication. Private original byte manifests accompany backups; `verifyByteChecksum` checks available bytes. Do not claim an object-byte backup when only metadata/pointers were exported.

Restore runs against a fresh isolated workspace after explicit owner intent. It verifies the manifest and every table checksum before inserting. All graph/checklist IDs and links are retained; append-only history is inserted as original events. Restore into a separate staging database first, check counts/relationships/byte hashes, and exercise graph readiness/reopen/checklist paths before restoring production. Migration staging rehearsal performs import/replay/backup/restore/reconciliation against two disposable PostgreSQL engines; those engines are test infrastructure only.

## Operator sequence

1. Pause destination writers while selecting a restore point; source Drive remains read-only.
2. Export the authorized database snapshot and private storage/Drive-byte manifest. Encrypt and save outside public Git with owner-only OS/private-store access. Record actual export time and verify bytes.
3. Decrypt and validate locally without logging document contents or secrets. Restore into an isolated empty staging database with the same schema version and explicit user intent.
4. Reconcile source mappings, graph/checklist foreign keys, status/date semantics, Activity and private bytes. Run the appropriate integration suite and inspect authenticated views.
5. Coordinator handles approved production replacement or forward repair, verifies deployed persistence and records the precise rollback point. Preserve the original snapshot for recovery; do not delete originals as cleanup.

The authenticated canonical `backup_export` response is the snapshot input, not a Google-ledger snapshot or its API response envelope. Save the actual backup object privately, encrypt it with the source environment's `BACKUP_ENCRYPTION_KEY` and verify its format/schema/owner/table checksums/manifest before the hosted drill. Neither `/tmp` CI artifacts nor `.env.local` select a production export. Use the approved private production environment and explicitly identify the independent staging database.

The guarded operator export performs canonical owner/manifest validation, real AES-GCM encryption and decrypted read-back, and creates its absolute private output exclusively:

```powershell
pnpm exec tsx --env-file=C:/PRIVATE_LIFE_OS/production.env scripts/ops/export-backup.ts --export-backup C:/PRIVATE_LIFE_OS/backup-encrypted.json
```

An actual pre-import production export was observed at 2026-10-13 22:06 UTC with every business-table count zero. Its encrypted file remains outside Git; this establishes the empty pre-import rollback point and does not claim a post-import hosted restore or an object-byte backup.

`scripts/ops/restore-drill.ts` takes these exact flags; replace the example paths with existing absolute private files and a new private report filename:

```powershell
pnpm exec tsx scripts/ops/restore-drill.ts --source-env C:/PRIVATE_LIFE_OS/production.env --destination-env C:/PRIVATE_LIFE_OS/restore-staging.env --snapshot C:/PRIVATE_LIFE_OS/backup-encrypted.json --report C:/PRIVATE_LIFE_OS/hosted-restore-report.json --restore-drill
```

The destination environment must contain `RESTORE_DRILL_DESTINATION=isolated-staging`, an independent database endpoint and an application `OWNER_ID` different from production. Direct/pooler aliases of the same database are rejected. The backup keeps its **original production owner ID** inside the independent staging database; it is never relabelled to the staging application's owner. Every owner-bearing public table, including operational tables omitted from exports, must be empty for that original owner and the expected schema must already exist. Existing staging app fixtures in a different owner namespace do not establish that empty condition; the script checks it under the owner lock. The report is created exclusively before mutation, full restore is transactional and read-back preserves original rows plus the accepted-operation journal. Authentication sessions/credentials are not restored. The report explicitly leaves external file-byte verification false until a separate real byte drill proves it.

No automatic scheduled backup has been proven in this release yet. Vercel Hobby scheduler limits and external provider permissions constrain frequency. RPO equals the age of the last actually verified private export; RTO must be measured during a real staging drill, not invented. Root release evidence must record actual database export/restore and object-store connection. App adapters, mocks and source download hashes alone do not prove production backup automation.

`server/jobs/backup.ts` implements a daily owner-specific immutable private object. A missing storage/encryption configuration records `disconnected`. An uncertain accepted upload is reconciled by reading the same key before retrying, preserving the stored original. Success requires private read-back, authenticated AES-GCM decryption and the canonical format/schema/owner/every-table-checksum/manifest verifier. An independent inconsistent-table-checksum regression found a false verified result; the repair now passes all six job contracts. These contracts use mocked database/domain/Blob with real encryption; they cover absent configuration, corruption/wrong owner, changed checksums and uncertain-upload salvage. Actual hosted execution and usable private Blob storage remain separate release gates.
