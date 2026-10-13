# Ramin Life OS V2 — Advanced Task Graph, Hierarchy, Checklists and Planning: Normative Specification

**STATUS: mandatory implementation and release contract.** Read this before schema/API/UI/AI or test implementation. This expands the V2 master superprompt. It MUST NOT become a separate prototype, a fake frontend, an optional deferred idea, or a static graph. Every operation uses the canonical transactional database, shared domain service and event history. All illustrations below use **synthetic tasks**, never user data.

## 1. Product intent / unambiguous language

The product must be **materially more powerful and easier to use** than a spreadsheet ledger or ordinary check-box todo list. It is a graph-aware, hierarchical personal planning system. A user can model:

- A **task**: durable action/outcome with its own status, dates, notes, references, activity, priorities and optional estimates.
- A **prerequisite/dependency**: an explicit directed relation `A requires B`, meaning B's qualifying completion is a gate for starting A. The internal edge is `B -> A` (prerequisite -> dependent); display both directions to prevent user confusion.
- Multiple prerequisites **at the same time**: default `ALL` (AND); e.g., A needs BOTH B and C done.
- An alternative group: `ANY` (OR) for workflows where *one of several* prerequisites suffices, but only when user explicitly chooses OR. A task may require multiple groups combined with top-level ALL, e.g., `(B AND C) AND (D OR E)`. Provide visual, plain-language builder; don't expose raw formulas as the primary UI.
- **Hard blocker** vs **soft/informational link**: hard link gates readiness; soft link generates warnings and visibility but never blocks by itself. An ordinary *related task* is not a prerequisite.
- **Subtask**: a child task with its own identity, permission, notes, checklists, dates, files, estimates, dependencies, assignees/labels, activity and links. Parent-child is hierarchy, not automatically a dependency edge.
- **Checklist item**: lightweight, ordered, checkable unit *inside* a task; may have short details; checklists may be multiple per task. It is NOT a task automatically and does NOT spawn its own deadline, reminder, calendar event or dependency unless explicitly promoted.
- **Milestone**: dated project checkpoint, zero-duration by default, optionally gated by tasks, shown in timeline; distinct from task completion.
- **Workflow status**: existing `Inbox | Next | In progress | Waiting | Done | Cancelled`, preserved for migration.
- **Computed readiness**: `ready | blocked | scheduled | closed` (plus reason codes) evaluated from hard dependencies, start constraint and completion status. This is **orthogonal** to the workflow status, never silently replaces `Inbox`/`Waiting` with `Blocked`.
- **Critical path**: accurately compute from known directed hard links and realistic effort/durations when enough input exists; display "insufficient estimates" instead of pretending exact criticality or inventing deadlines.

## 2. Canonical user example: chained and parallel prerequisites

Demonstrate this exact scenario with synthetic IDs:

```
D: Collect initial reference documents
    └─ required by B: Prepare literature comparison
B ───────────────┐
                 ├── required (ALL) by A: Submit research proposal
C: Get supervisor's approval ─┘
    Checklist C: [ ] Prepare questions  [ ] Email  [ ] Record approval
```

- A depends on B AND C. B depends on D. Initially A and B are blocked if D and C are unfinished. Completing D makes B ready, NOT A; completing B only makes A ready if C is also done. Checking every checklist item under C changes C's checklist progress but does not assume an approval was actually granted; C remains an incomplete task until specifically completed.
- Adding prerequisite E to A makes A gated on B, C and E, without resetting any statuses. OR group behavior uses `A requires (B OR C)` and must accept B alone.
- The task detail must explain in Persian: «این کار به‌دلیل تکمیل نشدن ۲ پیش‌نیاز هنوز آمادهٔ شروع نیست» and name exact prerequisites with links; also offer one-click navigate and show what *this* task unblocks downstream.
- User can reopen a prerequisite after dependents have begun; show a visible "at risk / prerequisites changed" alert and audit event, do NOT rewind completed/in-progress dependents without an explicit authorized decision.

## 3. Required behavior and invariants

1. **No cycles.** Reject A->A, A->B->A, and long or cross-project cycles; give the path in a typed `DEPENDENCY_CYCLE` error without mutating data. Validate transactionally; prevent concurrent writers introducing a cycle (transaction isolation/advisory lock or proven equivalent; test it).
2. **No duplicate edges** for the same relation/group; enforce constraints/indexes. Preserve stable IDs. Reject inaccessible, physically absent or invalid target tasks. Archived/soft-deleted links must be handled explicitly and reversibly, not become invisible dangling gates.
3. **ALL/ANY semantics.** A task with no hard prerequisites is dependency-ready by default. Every ALL group's required hard edges must qualify; any one edge in an ANY group must qualify. Task's groups combine with AND. A waived edge is a documented explicit owner decision and remains in history. Soft links never block.
4. **Completion policy.** Default prerequisite passes only on `Done`. `Cancelled` is NOT equivalent to success. Provide an explicit audited waiver/override or alternative branch selection; never auto-waive a cancelled prerequisite. User-configurable nondefault policies, if any, must be visible and tested.
5. **Readiness derivation.** Compute from verified DB state within bounded queries/transactions; don't persist a manually editable `Blocked` status that can drift. Distinguish `blocked_by`, `earliest_allowed_start`, `ready_now`, and `started_at_risk`. Expose reason codes. If a task is complete, show `closed` regardless of past blockers; still surface historical issues in Activity.
6. **Reopening.** Reopen a previously Done prerequisite -> recalculate downstream readiness transitively, update affected views, log impact; do not erase unrelated workflow status, checked checklist items or timestamps. Downstream already-completed tasks are not automatically undone.
7. **Status operations.** If user/AI attempts to start or finish a hard-blocked task, offer preview with exact blockers. Normal start is rejected until resolved; explicit owner override with reason may proceed and MUST be audited. AI must never perform override silently. Repeated completion is idempotent.
8. **Parallel branches.** Display tasks runnable simultaneously and those queued behind several branches. Distinguish **ready tasks** from **blocked/at-risk** tasks across dashboard, project, board, timeline, command palette and MCP.
9. **Dates aren't silently changed.** Start date, scheduled block, deadline, target completion, reminders and estimated duration are distinct. Dependency change can compute *suggested* schedule and downstream impact with preview; do not cascade user deadlines or create calendar events without approval. Detect impossible plans (prerequisite due after dependent's deadline) as risks, not silent rewriting.
10. **Cross-project relations.** Permit A in thesis and B in admin/other project when owner-authorized; show context, breadcrumbs, backlink and cross-project blocker counts; no artificial same-project restriction. Efficient indexed traversal and pagination protect large graphs.
11. **Hierarchy.** Nested subtasks with user-configurable reasonable depth. Reject hierarchy cycles. Parent task and child task each have independent state. Display total/done/blocked children; don't auto-complete parent because all children are done unless a clearly configured and audited rule is enabled. A parent and its descendants may have prerequisites but reject deadlock-inducing combined rules; test hierarchy/dependency interactions.
12. **Checklist atomicity.** Checking/unchecking an item is independently persistent, idempotent under retries, revision guarded, keyboard accessible and audited. Multiple named checklists; add/edit/reorder/duplicate/remove with non-destructive recovery (soft archive) and dragless alternative. Show progress `(checked / total)` and optional weighted progress if weights explicitly configured. Empty checklist has no misleading 100% completion.
13. **Promotion.** Convert checklist item -> real subtask in ONE idempotent service operation retaining title/note/source provenance. Ask whether to keep a linked completed checklist reference or archive the original item; never duplicate unnoticed. No silent creation of dependency links. Also allow subtask -> full task (detach), preserve identity/history.
14. **Bulk editing.** Adding multiple dependencies, reordering subtasks, marking checklist items, templates and batch actions must have `preview -> validate -> commit` for potentially disruptive operations, with a stable idempotency key and atomicity where feasible. UI shows exact before/after differences.
15. **Task templates and recurring instances.** A multi-task project template may include nested tasks/checklists/dependency links. Instantiating clones MUST remap every internal ID/edge to the new instance. Preserve external links only if owner intentionally opts in. For recurring tasks, dependencies can be between corresponding occurrences only by explicit rule; never make a new monthly instance depend forever on an old unrelated one. Test Europe/Berlin DST/date behavior.
16. **Provenance & safe AI.** Every state mutation records actor/channel (UI/MCP/AI/import), operation ID, revision, relevant before/after and reason. Prompt injection inside task descriptions/checklist text must never grant permission. Agent suggestion vs committed relation is explicit.
17. **Migration safety.** Existing Sheet source has NO formal dependency/checklist columns. Import tasks accurately without inventing relationships. AI may propose inferred prerequisites based on descriptions but MUST present them as **uncommitted suggestions** for review. Never turn unknown historical structure into confirmed edges; preserve all 45+ source tasks even when new structured fields are empty.
18. **Concurrency, offline and rollback.** Two users/tabs/agents cannot silently overwrite graph edits; expected revision and idempotency keys required; conflicting changes give clear merge/retry with updated blocker preview. App refresh/redeploy must retain all state. For momentary offline, drafts may be local encrypted/limited transient storage if appropriate but cannot masquerade as server-saved authoritative data.
19. **Performance.** Reachability/blocked queries must avoid N+1; index both ends of edges, maintain bounded graph traversal or materialization strategy with invalidation tests. Synthetic load with >=10,000 tasks, >=30,000 edges, nested hierarchies and multiple project roots; record measured latency. No repeated O(V*E) work per card render.
20. **Safety and accessibility.** Readable text alternatives to visual graph, keyboard add/remove dependency, screen reader relationship announcements, clear AND/OR group labels, touch-friendly interaction, RTL Persian order, mixed-script text, high contrast and reduced motion.

## 4. Concrete schema guidance (adapt if justified, document ADR)

- `tasks`: immutable task ID; existing status fields; `parent_task_id` nullable; `start_date`, `due_date`, `due_at`, `estimated_minutes`, `completed_at`, `sort_key`, `revision`, timestamps, project ID. Don't replace imported source `task_id` with a spreadsheet row number.
- `task_dependency_groups`: UUID, `dependent_task_id`, operator `ALL|ANY`, ordered display key, enabled flag, `created_at` and revision. Multiple groups for one dependent combine with ALL.
- `task_dependency_edges`: UUID, group ID, `prerequisite_task_id`, mode `hard|soft`, optional note, qualification policy (default Done only), waiver metadata (`waived_at`, `waived_by`, `waiver_reason`) and stable timestamps. One direction is always `prerequisite -> dependent` semantically even if storage keys point to dependent group.
- `task_checklists`: UUID, parent task, title, order, optional required flag, metadata, revision.
- `task_checklist_items`: UUID, checklist UUID, title, description/notes, order, `checked`, `checked_at`, `checked_by`, optional `promoted_task_id`, archive flags, revision.
- `task_hierarchy`: prefer `tasks.parent_task_id` with validated transitive closure, or materialized path/closure table if needed and correctly maintained; optional `task_parent_history`/activity events.
- `project_milestones`, `task_templates`, `task_template_steps`, `task_template_edges`, `task_completion_policies`, `task_schedule_proposals`, if actual features warrant them.
- `activity_events`: append-only event types `dependency.created|removed|waived|reopened_impact`, `checklist.item_checked|unchecked|promoted`, `task.parent_changed`, `task.override_blocker`, `schedule.proposed|accepted` plus actor/operation/revisions.
- **Enforce** DB uniqueness, indexes, foreign keys, transactional validation, owner access and constraints; don't rely on JavaScript-only cycle checks or UI-only validation. Disallow cascading physical deletion of historical graph and events.

Derived query example (not a schema of a persisted editable status):

```json
{
  "task_id": "task-A-synthetic",
  "workflow_status": "Next",
  "readiness": "blocked",
  "blocked_by": [
    {"task_id": "task-B-synthetic", "required_status": "Done", "actual_status": "In progress", "group_operator": "ALL"},
    {"task_id": "task-C-synthetic", "required_status": "Done", "actual_status": "Waiting", "group_operator": "ALL"}
  ],
  "unblocks_downstream": [],
  "checklist_progress": {"checked": 1, "total": 3},
  "revision": 4
}
```

## 5. Required interface: task detail is a true command center

### 5.1 Task details
- Clearly separated panels/tabs: Overview, Checklists, Subtasks, Dependencies/Blocked By, Unblocks, Schedule, Files & Links, Notes/Comments, History.
- Inline add/edit of checklist rows; nested list groups; progress and optional next unchecked item.
- Dependency picker: full-text search to select existing tasks, create another task inline, select AND vs OR, hard vs soft, optional explanatory note, cycle preview and reverse impact. Each selected prerequisite is a real clickable task.
- Status pill and a separate readiness badge, explanation popover of blockers; “Go to prerequisite”; list of downstream tasks unlocked if this completes; optional completion-impact preview.
- Start/resume/blocker override with explicit owner confirmation and reason; distinct `Waiting` reason for external response.
- Linked documents, source email/Drive references, project/area, reminders, estimated and tracked time, work sessions, custom fields where sensible.

### 5.2 Distinct views with persisted preferences
- **List/Table:** dense configurable columns including parent, checklist progress, blocking count, unblocks count, readiness, priority, due date, next action and progress.
- **Kanban:** group by status/project/priority or readiness; blocked cards show clear reason, prevent accidental drag-to-in-progress without preview/override.
- **Dependency Graph:** interactive zoom/pan, color-by-readiness, directed arrows, grouping by project or parent, click-to-inspect, upstream/downstream/both modes, mini-map for large graphs, auto layout with performance budget. Include linear accessible list/table alternative, no graph-only capability.
- **Timeline/Gantt:** duration bars, planned start/finish, dependency arrows and milestones, critical path only when warranted by estimates, scenario preview for rescheduling. Never silently change due dates.
- **Project Tree / WBS:** hierarchical expandable subtasks and parent progress rollups, drag-to-reparent with cycle checks and keyboard alternative.
- **Checklist View:** focus-friendly full-page execution view for a task, quick check, progress and keyboard shortcuts.
- **Today / Next Actions / Unblocked:** shows only actionable tasks by default, with separate obvious "blocked" inventory so no task disappears unexpectedly.
- **Blocked Radar:** stalled dependencies, who/what is needed, age, due-risk, which prerequisite unlocks most downstream work, one-click action navigation.
- **Dependency-first planning board:** can arrange tasks into sequential phases and parallel tracks; explain topological order and show what can run now.
- Saved filters + shareable private deep links; never expose private task titles in unauthenticated Open Graph metadata.

### 5.3 Delight and speed
- Universal Quick Add understands Persian/English sentences WITHOUT inventing due dates or committed dependencies; e.g. "تسک پایان‌نامه بساز که به اتمام ادبیات و تأیید Sven وابسته باشه" becomes explicit editable preview.
- Undo/redo for safe eligible edits; inline changes with server commit indicators (pending/saved/conflict), bulk multi-select and keyboard-first controls.
- Mobile bottom navigation, easy collapsing sections, persistent last view, useful offline state, subtle motion, meaningful skeleton/empty/error states. All buttons must work.
- Prevent dashboard clutter with progressive disclosure and individually configurable widgets; avoid overwhelming the owner with configuration.

## 6. API + MCP + AI contracts: first-class graph operations

Expose REST endpoints and discoverable MCP tools using EXACT SAME domain services. Names may be adapted to verified conventions, but capabilities and safety cannot be dropped.

**Read tools:** `task_get` returns `checklists`, `subtasks`, `prerequisites`, `blocked_by`, `unblocks`, `readiness`, version; `task_graph_get`, `task_dependencies_get`, `task_find_ready`, `task_find_blocked`, `task_checklist_get`, `subtask_list`, `project_dependency_summary`, `task_completion_impact_preview`, `dependency_topological_plan` (with transparent missing estimates).

**Write tools:** `task_dependency_add_preview`, `task_dependency_add_commit`, `task_dependency_remove_preview`, `task_dependency_remove_commit`, `task_dependency_group_update`, `task_dependency_waive_preview`, `task_dependency_waive_commit`, `task_checklist_create`, `task_checklist_item_add`, `task_checklist_item_check`, `task_checklist_item_uncheck`, `task_checklist_item_reorder`, `task_checklist_item_promote`, `subtask_create`, `subtask_reparent_preview`, `subtask_reparent_commit`, `task_template_instantiate_preview`, `task_template_instantiate_commit`. Tools that mutate must require write scopes and meet policy; disruptive changes use explicit confirm/commit.

**Request requirements:** entity IDs, expected revision or ETag, operation ID/idempotency key, actor principal from actual auth, server-side ACL checks and validated bounded input. Use cursor pagination for graph neighbors and stable sorting; return stable typed errors `DEPENDENCY_CYCLE`, `DEPENDENCY_ALREADY_EXISTS`, `TASK_NOT_FOUND`, `TASK_BLOCKED`, `REVISION_CONFLICT`, `PREREQUISITE_UNSATISFIED`, `INSUFFICIENT_PERMISSIONS`, `INVALID_DEPENDENCY_GROUP`. Never let an AI bypass previews merely by giving itself a flag.

**Result shape:** action returns affected task IDs, before/after references, readiness changes, upstream and downstream impact, audit operation ID and updated revisions. UI reflects commits via read-after-write. MCP can search by project/title/IDs but ambiguous references MUST be resolved before mutation.

**Natural language examples (Persian):**
- «تسک گزارش نهایی رو بساز و وابسته کن به تکمیل آزمایش و تأیید سوپروایزر» -> preview two ALL edges, then commit only with consent.
- «برای این کار سه تا چک‌لیست بساز: منابع، تحلیل، بررسی نهایی» -> create three real checklists associated with correct task.
- «کدوم کارها رو الان می‌تونم انجام بدم که چیزی جلوشون نباشه؟» -> query derived readiness, not just `status=Next`.
- «اگر تسک استخراج دیتا رو تکمیل کنم کدوم کارها آزاد میشن؟» -> safe read-only impact preview.
- «چرا پروپوزالم Blocked شده؟» -> exact IDs/names and unmet group logic with links.
- «چک‌لیست این آیتم رو به یک تسک مستقل تبدیل کن» -> idempotent promotion preserving provenance.
- «تسک A به B و C وابسته است؛ B هم به D» -> preview graph with correct edge orientation, reject cycles and commit atomically.

## 7. Migration and current Google Sheet

The old `Ramin Task Ledger` is an INCOMPLETE *subset* of the desired V2 product, not a design ceiling. It is a verified DATA SOURCE, not an interface template or a full-featured schema. Its six tabs are Tasks/Files/Links/Activity/Settings/Guide; it has no native `task_dependencies`, checklist-item or hierarchy tables. Existing source rows keep their IDs, status, text, dates, links and history. Migration must create zero invented dependencies/checklist records unless explicit authoritative external evidence exists and the user authorizes adding them. Provide optional `AI Suggested Structure` review queue after import; suggestions are not committed changes. The new Postgres schema becomes authoritative only after verified cutover. Never overwrite source or add new columns to make V2 features work.

## 8. Engineering test plan and release gates

**All named scenarios below MUST be automated, named and independently reviewed.** Use unit, real DB integration, REST/MCP contract and Playwright E2E layers, with synthetic fixtures. Rely on isolated test DB, not source Drive or production.

1. `multi_prerequisite_all_requires_every_task_done` — A(B,C) only ready after both qualify.
2. `alternative_group_any_accepts_one_done` — ANY group passes only when one qualifies; top-level groups AND together.
3. `deep_dependency_chain_propagates_readiness` — D->B->A with C->A, no premature unlocking.
4. `cycle_direct_self_link_rejected_without_mutation`.
5. `cycle_cross_project_long_path_rejected_with_explanation`.
6. `simultaneous_edge_writes_cannot_create_cycle` — concurrent transactions.
7. `duplicate_dependency_retry_is_idempotent`.
8. `cancelled_prerequisite_does_not_count_as_done` and `explicit_waiver_is_audited`.
9. `soft_link_does_not_block_readiness`.
10. `blocked_status_is_derived_without_mutating_workflow_status`.
11. `blocked_task_start_requires_override_reason_and_audit`.
12. `reopen_prerequisite_reblocks_downstream_without_status_rollback`.
13. `completed_downstream_task_not_undone_on_reopen`.
14. `checklist_toggle_persists_across_reload_and_mcp_read`.
15. `multiple_checklists_reorder_without_losing_items`.
16. `checklist_progress_does_not_auto_complete_parent`.
17. `checklist_item_promotion_is_single_and_traceable`.
18. `subtask_parent_cycle_rejected`.
19. `subtask_parent_rollup_matches_actual_children`.
20. `parent_child_dependency_deadlock_rejected`.
21. `template_clone_remaps_child_and_dependency_ids`.
22. `recurring_instance_links_do_not_point_to_unrelated_old_occurrences`.
23. `dependency_change_only_suggests_schedule_no_silent_due_shift`.
24. `no_estimates_no_fake_critical_path`.
25. `cross_project_dependency_search_respects_owner_auth`.
26. `graph_pagination_and_large_dataset_performance` — 10k nodes/30k edges with measured results.
27. `task_completion_impact_preview_is_read_only_and_correct`.
28. `ui_graph_and_linear_accessible_fallback_are_equivalent`.
29. `keyboard_dependency_editor_and_checklist_are_usable`.
30. `mcp_dependency_mutation_visible_in_browser_and_reverse`.
31. `ai_task_description_prompt_injection_cannot_change_graph`.
32. `graph_batch_commit_atomic_on_invalid_edge`.
33. `graph_revision_conflict_returns_updated_prerequisites`.
34. `legacy_import_has_no_fabricated_edges_or_checklist_items`.
35. `backup_restore_preserves_graph_and_checklists`.
36. `dependency_graph_works_after_redeploy_and_fresh_login`.
37. `project_ready_blocked_metrics_match_database_truth`.
38. `rtl_mobile_task_detail_allows_dependency_edit_without_drag`.
39. `checklist_deletion_is_recoverable_and_audited`.
40. `waive_cancelled_dependency_requires_explicit_user_intent`.

Production readiness is blocked if prerequisite and checklist operations are in-memory mockups, allow undetected cycles, silently change task status, invent source relationships, or have inconsistent UI/API/MCP behavior. Record actual test results. Require review by domain/backend, QA, AI/MCP, and UX/a11y teams independently.

## 9. Implementation schedule: true parallelism with shared contracts

Orchestrator publishes SQL domain contracts and graph invariants BEFORE UI/MCP/AI parallel work. Domain graph team owns graph commands/queries and invariants; UI team owns editor/list/graph/Gantt/checklists; MCP/AI team owns thin authorized adapters; QA creates adversarial tests independently; migration team ensures zero fabricated historical relationships. Merge worktrees only after contract tests and independent review. First complete a **vertical slice** A depends on B and C -> check B/C -> readiness flips -> UI and MCP agree -> tests pass. Then OR, nesting, templates, advanced visualization and load testing. No agent gets permission to mutate source Google Drive for graph experiments.

## 10. Definition of done: demonstration using actual deployed application

In the deployed authenticated app, create A, B, C, D; set A requiring B & C, B requiring D; prove at UI, API and MCP each step of downstream readiness. Create a task with two separate checklists and child subtasks, check/uncheck/reorder, promote an item to subtask, refresh and reload on another device, verify persistence and history. Trigger a cycle and show the rejection without lost edits. Use a synthetic template with two branches; instantiate and show remapped IDs. Show project graph, board, list, Gantt and accessible alternative. Show clearly that imported private Google Sheet rows remain unchanged and no dependencies were fabricated. Attach test evidence, production screenshots and versioned DB migration details to the final report. This entire spec is a **P0/mandatory** component of Ramin Life OS V2.
