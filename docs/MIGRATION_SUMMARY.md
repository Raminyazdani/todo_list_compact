# Migration evidence

Live read-only discovery on 2026-10-13 verified these nonblank data-row counts:

| Source tab | Rows |
| ---------- | ---: |
| Tasks      |   45 |
| Files      |    3 |
| Links      |    3 |
| Activity   |   53 |
| Settings   |   36 |
| Guide      |   18 |

All tasks were Inbox. Forty-four tasks have no deadline; one date-only deadline uses a real native DATE cell. There are no duplicate source IDs, Drive IDs, active relation triples or orphan file links. All three Files records are Inbox and their live parents match the ledger. Every original file's actual downloaded SHA-256 and length match the recorded values. The native full-workbook export matches the connector snapshot exactly. Source modified time stayed unchanged during capture. Live System schema/config are semantically identical to the supplied reference. Activity contains fifty Succeeded and three historical Pending events, all three with a later terminal event under the same operation; there are no unresolved pending operations.

Source-schema dry-run passed with zero quarantined source rows. A complete live source rehearsal imported into a disposable PostgreSQL engine, reconciled every original task/file/link/activity attr with zero missing/changed records, preserved Settings/Guide, replayed idempotently, restored a backup into a second fresh engine and reconciled again. It created zero dependency edges/checklist items. Production and original Google sources were untouched. A second complete live row read confirmed the same counts and no source delta. Private complete snapshots, original bytes and checksum manifests exist outside the repository.

The observed migration/integration suite passed 32 tests across seven files, including synthetic import/replay/conflict quarantine/backup restore, DST and exact-second recurrence, byte integrity/version boundaries, encrypted backup and employer XLSX contents. Command: `pnpm exec vitest run tests/migration tests/integrations`. Independent contracts also prove replay of an accepted operation across a full restore, preventing duplicate writes. The actual-source rehearsal command is `pnpm exec tsx scripts/migration/cli.ts PRIVATE_SNAPSHOT --staging-dry-run`; stdout contains counts/status only. A disposable embedded engine is staging test evidence, not proof of production hosting or production import.

Production migration/cutover remains coordinator-owned. This discovery report does **not** claim a production import, live UI reconciliation or a completed cutover. Record actual destination counts and private report evidence after the authorized production command succeeds. Original Google sources remain read-only references.
