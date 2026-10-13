# Ramin Life OS — Product and acceptance contract

Status: implementation in progress; no release gate is verified. The owner authorized implementation from the private V2 handoff and requested Persian conversation. This public specification contains reusable requirements and synthetic examples only.

## Product outcome

A private, durable personal productivity system with Persian RTL and English LTR. Website, REST, remote MCP and in-app AI must operate on the same authenticated domain services and PostgreSQL data. The legacy spreadsheet is a migration source; the new product extends its capabilities. A successful build alone is not delivery.

## Required modules

| Module               | Required behavior                                                                                                                                                                                                                                | Gates                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| Dashboard            | Configurable widgets, Today timeline, capture, overdue/upcoming, focus, project risks, waiting responses, workload, completion trends, file activity, calendar peek, weekly review and source status; every card opens a real query              | AC-04, AC-19               |
| Tasks                | Create/edit/complete/reopen, canonical statuses, priorities/categories, projects/tags, notes/comments/next-action, dates and estimates, search, table/list/Kanban, saved filters, custom order, multi-select/bulk, keyboard capture and recovery | AC-05, AC-11               |
| Workflow graph       | Explicit prerequisite DAG, default ALL and user-selected ANY groups, hard/soft links, cross-project traversal, transactional cycle rejection, derived readiness, impact/waiver previews, blocked radar and topological planning                  | AC-21, AC-22, AC-25, AC-26 |
| Checklists/hierarchy | Multiple named ordered checklists, atomic toggles/edit/reorder/undo/archive, independent nested subtasks, progress rollups, identity-preserving reparent/detach, single-operation item promotion                                                 | AC-23, AC-24               |
| Templates/planning   | Clone nested tasks/checklists/internal edges with fresh remapped IDs, deliberate external links, recurring occurrence identity, schedule suggestions without silently changing dates; truthful critical-path calculation                         | AC-27, AC-28               |
| Projects             | Overview, milestones, backlog/tree/board/timeline, notes/documents/decision log, people as labels, knowledge links, real progress and cross-project blocker summaries                                                                            | AC-06                      |
| Calendar             | Day/week/month/agenda, 24-hour timeline, create/move/resize and keyboard alternatives, all-day and recurrence exceptions, layers/source toggles, conflicts, holidays and timezone-safe rendering; truthful connection state                      | AC-07                      |
| Work/time            | Jena and Seewiesen work logs, exact duration and 15-minute snapping, overlap detection, weekly/monthly aggregates, separate verified XLSX exports, validated JSON import/export; planned blocks distinct from worked hours                       | AC-08                      |
| Files/knowledge      | Private upload/download, metadata/search/versions/checksums, many-to-many task links, Inbox/Active/Old archive/restore, safe previews and external Drive references without moving originals                                                     | AC-09                      |
| Migration            | Read all live source tabs/System schema/rules, private snapshot, dry-run, exact field/ID/history/link preservation, orphan quarantine, replay/resume, reconciliation and explicit canonical cutover                                              | AC-10, AC-28               |
| REST/MCP             | Versioned OpenAPI 3.1, typed client, stable cursors, structured errors, revisions/idempotency, protected Streamable HTTP, real OAuth discovery/scopes, resources, local skill and working client configs                                         | AC-12, AC-13, AC-26        |
| AI                   | Persian/English grounded search, entity disambiguation, typed action preview, owner approval, execute/read-back/audit/undo, budget and rate controls, injection resistance and accurate disabled state without model configuration               | AC-14, AC-15               |
| Operations           | Security/connections/revocation, sync freshness, failed outbox/jobs, reminder schedule/manual run/pause, monitoring, portable export/private backups, staging restore and recovery                                                               | AC-03, AC-16, AC-18, AC-19 |
| Experience/docs      | Responsive mobile/tablet/desktop, RTL/LTR mixed text, light/dark/system, accessible keyboard/touch alternatives, honest loading/error/offline/empty states and complete Persian operator/user handoff                                            | AC-17, AC-20               |

## Canonical invariants

1. Workflow statuses remain `Inbox`, `Next`, `In progress`, `Waiting`, `Done`, `Cancelled`. Readiness is independently derived as `ready`, `blocked`, `scheduled`, or `closed`. UI localization does not rewrite stored meaning.
2. `A requires B` has semantic direction `B -> A`. Dependency groups combine with AND. ALL needs every required hard edge; ANY needs one qualifying edge. Only `Done` qualifies by default. Soft links never block. Waivers require explicit owner intent, reason and audit.
3. Self/deep/cross-project/concurrent cycles fail atomically with an explanation. PostgreSQL constraints, indexes and transactional serialization supplement application validation. No physical cascading deletion of historical edges/events.
4. Reopening a prerequisite changes downstream readiness and risk, preserving statuses, completed tasks, checklists and history. Hard-blocked start/finish needs a policy-approved owner override with reason.
5. A checklist item, independent child task, milestone, prerequisite and ordinary related task are distinct. Checklist/child completion does not silently complete the parent. Promotion is idempotent and preserves provenance.
6. Every mutation performs server auth/ACL, bounded validation, expected revision, operation idempotency, transaction, append-only audit and verified read-back. Conflicts are explicit. Actor identity comes from authentication, never request text.
7. Stable imported IDs and source text/status/timestamps/revisions remain intact. Date-only values are local dates; instants use UTC plus originating IANA timezone. Search indexes normalize Persian variants without modifying original content.
8. Task deadlines, calendar events and work logs remain separate. Graph changes may suggest a schedule, never silently move deadlines/create events/send mail. AI and external content cannot grant scopes or authorize actions.
9. Files archive only when all active linked tasks exist and are closed; missing/unlinked tasks and protected System items block automatic archival. Versions and inactive link history survive. Reopening restores necessary references safely.
10. Source Drive/Sheet/reference planner remain read-only. Import creates zero guessed dependencies/checklist items. Unknown fields are retained or reported, not silently discarded. No real source content, IDs, feed URLs, credentials or private exports enter Git/public screenshots/logs.
11. Durable PostgreSQL is authoritative after verified cutover. LocalStorage, ephemeral serverless disk, GitHub files, spreadsheet or Blob JSON cannot replace the production transactional database. Uploaded bytes use private object storage.
12. An unavailable connection shows a truthful disabled/reconnect state. Generic MCP success does not prove ChatGPT installation/write eligibility; inspect actual client/plan separately.

## Required demonstration

Synthetic A requires B AND C; B requires D. Completing D releases B only; completing B and C releases A. An ANY group accepts either branch. Checking C's checklist alone does not complete C. Reject a cycle, reopen C, preserve downstream workflow, edit two named checklists, promote an item, clone a nested template with remapped IDs and prove matching browser/REST/MCP results across reload/redeploy/login.

## Delivery boundary

All AC-01 through AC-28 and all 40 named graph scenarios are mandatory. Evidence states are PASS, FAIL or EXTERNALLY_BLOCKED; initial state is NOT RUN. Production ready requires zero known P0/P1 and actual deployment, authenticated owner access, source reconciliation, remote MCP test, restore drill and visual/accessibility verification. External authorization restrictions must include observed reason, minimum owner step and tests still missing; independent implementation continues.

See [the normative graph specification](ADVANCED_TASK_GRAPH_SPEC.md), [acceptance checklist](ACCEPTANCE_CHECKLIST.md) and [dependency test matrix](DEPENDENCY_TEST_MATRIX.md).
