# Canonical relational data model

The production authority is PostgreSQL. `server/db/schema.ts` holds versioned SQL and `server/domain/service.ts` is the single command/query boundary for UI, HTTP, MCP and approved AI actions. Missing `DATABASE_URL` fails closed with `DATABASE_UNAVAILABLE`; PGlite exists only in isolated tests.

```mermaid
erDiagram
  owners ||--o{ projects : owns
  owners ||--o{ tasks : owns
  projects ||--o{ tasks : contains
  tasks ||--o{ tasks : parent
  tasks ||--o{ task_dependency_groups : requires
  task_dependency_groups ||--o{ task_dependency_edges : groups
  tasks ||--o{ task_dependency_edges : prerequisite
  tasks ||--o{ task_checklists : has
  task_checklists ||--o{ task_checklist_items : contains
  tasks ||--o{ file_task_links : references
  files ||--o{ file_task_links : linked
  files ||--o{ file_versions : versions
  projects ||--o{ project_milestones : checkpoints
  tasks ||--o{ calendar_events : optional_link
  tasks ||--o{ time_entries : optional_link
```

IDs are immutable text identifiers; source IDs retain their exact original values. Each owned relation uses a composite `(entity_id, owner_id)` foreign key so a cross-owner link cannot be inserted. Cross-project links are supported within the same owner. Tasks retain all original legacy columns, a normalized project mapping where the source explicitly named a project, plus `legacy_metadata` containing every original source attribute. Date-only deadlines remain PostgreSQL `date`; actual instants use `timestamptz` and a separate originating IANA zone.

`tasks.parent_task_id` is hierarchy. It creates no dependency or completion rule. Every task owns its status independently. Hierarchy uses transactional validation and immediate/deferred database cycle triggers, with maximum depth 12. Checklists have independent revisions and recoverable archive markers; checked items never complete a task. Promotion remaps a checklist item into exactly one real child task, stores `promoted_task_id`, and requires choosing archive or keep-reference behavior.

Dependency edges mean prerequisite → dependent. Every dependent may own multiple ALL/ANY groups, combined with top-level AND. Only active hard edges gate readiness; a prerequisite qualifies when Done and not archived, or explicitly waived with owner actor/reason/time. Cancelled never qualifies automatically. Soft links show warnings. Removing an edge archives it, preserving history. Readiness is derived in a bounded snapshot query and never stored as a workflow status.

Concurrent mutations acquire a PostgreSQL advisory transaction lock keyed by owner, then enforce expected entity revision. Graph checks also run as database triggers, protecting direct database writers. Reachability uses recursive SQL `UNION` to deduplicate visited vertices; error explanations reconstruct the actual path. Idempotency stores the complete result keyed by owner + stable request key, with an input/actor hash; changed reuse is rejected. Activity is append-only, including old/new values and provenance. Preview records are owner-bound, expire after 15 minutes and pin all affected revisions.

Files and tasks have many-to-many links with relation purpose and inactive history. Filename is never identity. Version families retain immutable individual file IDs and checksum metadata. Canonical archive eligibility requires all existing active linked tasks closed, at least one active link and an unprotected private Blob record. Google Drive originals are pointers and never moved by these domain services; their archive/restore mutations fail closed until a separately authorized move adapter exists. Reopening a linked task restores only private Blob archive state. Original Drive identifiers, parent metadata and link history remain unchanged. Canonical private file registration verifies actual provider bytes, SHA-256, size and owner namespace independently of the upload route.

Calendar events and worked time are separate entities. Local events support RFC5545 recurrence expansion through the calendar integration helper; overlap checks apply only to time entries. Calendar mutation never follows implicitly from a task deadline or status change. Reminders are durable in-app records; scheduling/delivery capability must be verified separately.

`calendar_events.recurrence_exceptions` is an owner-validated JSONB array of local dates (`YYYY-MM-DD`) or local date-times (`YYYY-MM-DDTHH:mm:ss`) in the series IANA zone. Dates exclude all occurrences that date; date-times exclude the matching local occurrence. Notes-only writes preserve the master rule, time and exceptions, and expanded DTOs expose the original master times separately. Whole-series time changes require explicit `apply_to_series` intent. Read-only analytics derives complete task/history counts and scoped time aggregates; these do not create a second persistent ledger or sample the first UI page.

A moved local occurrence is another nonrecurring `calendar_events` row, with immutable `series_event_id`, `original_occurrence_starts_at` and local `recurrence_id`. The master receives the matching exclusion in the same owner-locked transaction; its base start/end/rule are preserved. Composite owner foreign keys and a unique original-occurrence index prevent cross-owner or duplicate overrides. The self-reference is deferred so portable restore can insert events in either order. Additive idempotent migration preserves preexisting event rows. Override changes advance the master revision; whole-series deletion soft-archives its overrides with audit. Structural master edits with stored overrides require a separately reviewed replacement series; metadata and override time edits remain supported. Removing a moved exclusion is rejected to prevent duplicate appointments.

Additional normalized tables include milestones, templates, comments, tags/relations, notes/knowledge, saved views, preferences, reminders, notifications, append-only activity, idempotency results, command previews, outbox and migration batches/mappings/quarantine. Outbox is an operation journal, not a claim that external services share PostgreSQL transactions. A trusted system principal can run the daily job: due actionable in-app reminders become durable notifications once; closed/archived reminders are cancelled. Explicit owner-configured RRULE task recurrence materializes template instances with unique owner/rule/date identity, new internal task/edge/checklist IDs and no links to unrelated old occurrences. Daily catch-up is bounded to 30 instances/1,000 tasks; the next occurrence remains durable for later runs. Exact delivery time is not promised by a daily scheduler.

Migration retains raw Tasks/Files/Links/Activity/Settings/Guide snapshots inside private database metadata. Unknown fields remain intact. Existing destination edits require conflict review; orphan links are quarantined. No source narrative creates dependency edges or checklists. Backup snapshots include full graph/checklist/history, recurrence and accepted idempotency result tables and SHA-256 table/manifest checksums; restoration requires an empty isolated workspace with the same owner identity and explicit owner intent. Restored accepted operation keys remain replayable, preventing duplicate creates across restoration. JSONB scalar values are serialized according to actual database column type, preserving legacy audit values.

Public test fixtures are synthetic. Source data, private IDs, source snapshots, auth values and backups are excluded from the public repository.
