# Domain implementation decisions and verified limits

1. **Parameterized PostgreSQL SQL is the schema and transaction source.** The normalized schema is versioned SQL with database constraints/triggers, not an ORM-generated parallel model. This makes cycle/reachability checks and original text identifiers explicit. Drizzle is available to other adapters, but graph rules never depend on a client-side model.
2. **Owner lock serializes graph and hierarchy mutations.** A single-owner workspace can accept a conservative per-owner transaction lock. Revision guards still expose conflicts, rather than accepting stale writes after waiting. Direct SQL mutation triggers take the same lock. Real Neon staging multi-connection tests have passed both service and direct-SQL concurrent opposite-edge writes; only one can persist.
3. **PGlite is a real PostgreSQL engine for isolated tests.** It is not a deployed persistence option. The test adapter serializes its single connection. Multi-connection guarantees are separately verified against staging PostgreSQL; they are not inferred from PGlite.
4. **Graph queries build one bounded indexed snapshot.** Tasks, edges, groups and checklists are read in set queries and maps derive each task's readiness in O(V+E). Current explicit bounds are 50,000 tasks and 200,000 edges per owner; pages are capped at 200. A 10,000-task/30,000-edge/20-project/100-hierarchy-root synthetic fixture passed query latency assertions. Actual measured values are in `artifacts/domain-performance.json`; these are local engine timings, not deployed browser/network latency. Fixture seeding temporarily disables only the isolated test database's graph/hierarchy mutation triggers for an analytically acyclic bulk dataset, then enables them before measurement. Mutation guard behavior is covered independently. Full bulk seed-write performance is not claimed.
5. **Parent/child hard gates are conservatively rejected.** Hierarchy and task state remain independent, with no hidden auto-completion. Direct parent-child hard dependencies are disallowed to avoid ambiguous combined containment/gate rules; unrelated children and parent tasks can have normal cross-project prerequisites. This policy is explicit and tested.
6. **Critical paths require complete estimates and fixed branches.** Missing durations yield null critical path/duration. Unselected ANY branches also yield null rather than an invented exact plan. Deadlines are never changed by dependency edits; risks are suggestions.
7. **Disruptive commands consume a stored preview.** Dependency add/remove/waive, reparent, template instantiation and task batches commit only a valid owner-bound preview with pinned revisions. Human waiver/override intent is required; an AI-channel flag cannot authorize an override. Ordinary checklist check/uncheck uses the item's revision and stable idempotency key.
8. **Source migration is preservation first.** Exact canonical IDs, times, original fields and unknown attributes remain available in legacy metadata. Explicit source project names justify deterministic project mappings. Existing destination differences are quarantined for review, never blindly overwritten. No inferred historical prerequisites/checklists are committed.
9. **Restore targets are empty isolated workspaces.** Checksums and schema are validated before inserts. A successful restore adds one append-only restore event; original events are retained exactly. Entity table checksums match the exported snapshot when restored to the same owner ID in a separate database.
10. **External actions require separate adapters/authorization.** Calendar writes to external providers, Drive moves/sharing, email delivery, precise schedulers and AI provider access are not implied by domain record creation. Google Drive archive/restore is rejected until a separately authorized verified move adapter exists; SQL labels never claim an original Drive move. Canonical private file registration verifies actual provider bytes and owner namespace, independent of the upload route; version uploads append a new immutable file in the original family. External calendar sources merge into the same authorized query path as local events, remain read-only and report explicit warnings while local data stays usable on provider failure.
11. **Safe undo and redo preserve the audit trail.** Eligible metadata/archive edits link immutable undo/redo events, pin the current revision and reject intervening changes. Status, graph, waiver and external provider actions cannot bypass their policies through undo/redo.
12. **Task recurrence is explicitly configured.** An owner chooses a real template, start date, IANA zone and bounded RRULE. The trusted daily job creates corresponding new instances once, remaps internal IDs, skips external old links and leaves deadlines unset. It persists catch-up progress, honors pause/resume and never promises minute precision. Named DST, corresponding-branch, pause/revision and repeat-run tests cover this behavior.
13. **Recurring calendar series retain explicit exceptions.** Canonical local calendar writes validate and persist at most 1,000 local date/date-time exceptions in JSONB. Omission preserves the array; an explicit empty array clears it. Expanded events retain original series start/end metadata. Changing the times, zone or all-day flag of a recurring master requires `apply_to_series: true`; notes-only changes preserve its recurrence and times. Individual occurrence moves remain unsupported; no external provider writes are implied.
14. **Plans state their actual owner-authorized scope.** An explicit selection accepts 1..200 task IDs, checks every ID and ignores inventory filters. A selected root uses the same upstream/downstream/both context as the graph. Unresolved prerequisites outside a subset remain visible as boundary edges and risks and suppress an invented complete critical path. Boundary details are capped at 1,000 with an explicit truncation flag and actual hidden-neighbor count.
15. **Trends and monthly summaries use elapsed time at local date boundaries.** Analytics returns all verified owner task counts and 12 calendar weeks including the current partial week, independent of UI pagination. Completion facts survive reopening and deduplicate the same task/completion instant. Time aggregates require time-read scope; intervals are clipped to the requested window and split at IANA local midnights, so DST days retain real elapsed minutes. Monthly `time_summary` clips overlap entries to its from/to range; individual list entries retain their full duration.

## Contract examples

```ts
const preview = await service.query(
  "task_dependency_add_preview",
  {
    task_id: dependentId,
    prerequisites: [{ task_id: prerequisiteId, mode: "hard" }],
    operator: "ALL",
  },
  principal,
);
await service.execute(
  "task_dependency_add_commit",
  {
    preview_id: preview.preview_id,
  },
  principal,
  { idempotencyKey: stableRequestKey },
);
```

Existing entity writes require `expectedRevision`: task commands use the task revision, checklist metadata/item-add/reorder use the checklist revision, item toggle/edit/promote use the item revision, and file/event/time/project updates use their entity revision. Preview commits instead verify all stored affected task revisions atomically. `task_batch_preview` accepts either explicit `{actions:[{command,input}]}` or `{task_ids,action:'complete'|'reopen'|'archive'|'restore'}`. Blank deadlines remain null. Both graph APIs and checklist APIs return stored IDs and audit operation IDs, never a separate runtime array.

## Evidence

- `tests/domain/graph.test.ts`: meaningful graph, hierarchy, checklist, preview, idempotency, prompt-injection and database-trigger tests.
- `tests/domain/resources.test.ts`: backup reconstruction, resource ACL, calendar DST, time overlap, archival/recovery, source preservation.
- `tests/domain/postgres.test.ts`: opt-in real staging multi-connection race tests (`TEST_POSTGRES=1`, private environment).
- `tests/domain/performance.test.ts`: 10k/30k graph read measurements and pagination.
- Independent `tests/migration/staging.test.ts`: migration reconcile/replay/quarantine/backup verification.
- `tests/domain/planning-calendar-analytics.test.ts`: EXDATE persistence, whole-series intent/retry, all-day DST, selected-plan owner/boundary guards, uncapped historical trends, DST/overnight/window clipping and cross-month time summaries.

UI/mobile/keyboard/MCP interoperability and actual deployment persistence are separate integration release gates; passing domain tests alone does not mark those gates complete.
