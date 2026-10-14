# Migration evidence

**Current scope, 2026-10-14:** [actual Neon verification](NEON_LIVE_VERIFICATION.md) supersedes the earlier Blob/AI/ChatGPT limits as current delivery conditions. Neon files and both manual metadata/original-byte cloud recovery proofs pass; native Codex OAuth login is complete but current-chat tool loading/read awaits a full restart. In-app AI is deferred. Scheduled cron execution and product-specific calendar grants remain separate. The milestones below retain their original times, counts and scope.

## Observed production result

The final authorized production import and same-batch replay passed on 2026-10-14. Complete source reconciliation preserves the following original rows, their immutable identities, canonical fields and retained source metadata. These counts identify source-backed records; they are not the total physical table counts after synthetic acceptance tests.

| Source tab | Rows |
| ---------- | ---: |
| Tasks      |   45 |
| Files      |    3 |
| Links      |    3 |
| Activity   |   53 |
| Settings   |   36 |
| Guide      |   18 |

All tasks were Inbox. Forty-four tasks have no deadline; one date-only deadline uses a real native DATE cell. There are no duplicate source IDs, Drive IDs, active relation triples or orphan file links. All three Files records are Inbox and their live parents match the ledger. Every original file's actual downloaded SHA-256 and length match the recorded values. The native full-workbook export matches the connector snapshot exactly. Source modified time stayed unchanged during capture. Live System schema/config are semantically identical to the supplied reference. Activity contains fifty Succeeded and three historical Pending events, all three with a later terminal event under the same operation; there are no unresolved pending operations.

Before the production cutover, source-schema dry-run passed with zero quarantined source rows. A complete live source rehearsal imported into a disposable PostgreSQL engine, reconciled every original task/file/link/activity attr with zero missing/changed records, preserved Settings/Guide, replayed idempotently, restored a backup into a second fresh engine and reconciled again. It created zero dependency edges/checklist items. That rehearsal wrote neither production nor original Google sources. A second complete live row read confirmed the same counts and no source delta. Private complete snapshots, original bytes and checksum manifests exist outside the repository.

The observed migration/integration suite passed 32 tests across seven files, including synthetic import/replay/conflict quarantine/backup restore, DST and exact-second recurrence, byte integrity/version boundaries, encrypted backup and employer XLSX contents. Command: `pnpm exec vitest run tests/migration tests/integrations`. Independent contracts also prove replay of an accepted operation across a full restore, preventing duplicate writes. The actual-source rehearsal command is `pnpm exec tsx scripts/migration/cli.ts PRIVATE_SNAPSHOT --staging-dry-run`; stdout contains counts/status only. A disposable embedded engine is staging test evidence, not proof of production hosting or production import.

## Production verification and cleanup

The fresh source checkpoint admitted the production import; the accepted cutover report and same deterministic batch replay verified all 45 Tasks, 3 Files, 3 Links, 53 original Activity rows, 36 Settings rows and 18 Guide rows. The one date-only deadline and 44 null deadlines are preserved. Independent native SQL `DATE::text` and canonical reads verify calendar labels without converting them to local-midnight instants. Original Google rows/files/parents remain read-only and unchanged; the import fabricated zero source dependencies, checklist items or parent relations.

After the actual DG36 redeploy and fresh login, the retained production verification passed for 45 source tasks, 3 source files and all 21 synthetic graph-proof tasks. Subsequent cleanup archived only the 25 recorded synthetic graph/redeploy tasks. A guarded internal transaction removed exactly one synthetic template, one paused recurrence rule, one instance and five membership rows after verifying exact owner, revisions, provenance, archived tasks and absence of imported/extra live references. Task/graph/checklist rows, original source records, append-only history and old accepted-operation receipts remain retained. The current source-only native/canonical verification again passes for all 45 original tasks and 3 original files. The final read-only cleanup/security proof confirms 45 active original tasks, 27 archived synthetic tasks and 72 total retained task rows; all three original file download endpoints return unauthenticated HTTP 401 without redirect.

A verified encrypted production snapshot containing all 68 tasks present at that point was restored into the independent hosted staging database under the original production owner namespace. Full table read-back and all 48 accepted-operation results matched before synthetic cleanup. The final post-cleanup/revocation snapshot also passed persisted encrypted read-back, authenticated decryption and full manifest validation: 72 tasks, 29 projects, 3 files, 3 original versions, 3 links, 84 accepted operations, 150 activity rows and 104 source mappings, with zero template/rule/instance/membership rows. Production QA client revocation has completed. The hosted restore proves the earlier 68-task snapshot; a second hosted restore of the later 72-task snapshot is not claimed.

All accepted import, replay, reconciliation, graph/redeploy, cleanup and restore reports are retained privately outside Git. Final private evidence basenames are `production-final-after-cleanup-20261014.json` and `production-final-cleanup-security-proof-20261014.json`. No source IDs, raw hashes, ledger rows, credentials or real-user screenshots are published here. Live private Blob/cloud byte backup remains blocked by the provider's HTTP 400 quota response. The separate local encrypted original-byte package and decrypt-to-files checksum/length recovery passed; relational backup and local byte recovery are distinct evidence.
