# RAMIN LIFE OS — DELIVERY ACCEPTANCE CHECKLIST (initial statuses: NOT RUN)

> Agents must replace `NOT RUN` only after **observed** evidence, and maintain the real checklist in repository `docs/` alongside tests. The ZIP is the initial contract, not a finished build report.

## Mandatory evidence syntax

For each item record `PASS`, `FAIL`, or `EXTERNALLY_BLOCKED` and an evidence link/path, exact test command and timestamp. No status should be marked PASS merely because code exists.

| ID    | Acceptance gate                                                     | Initial | Minimum evidence                                                         |
| ----- | ------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------ |
| AC-01 | Exact GitHub repo, reproducible commits/lockfile, clean public repo | NOT RUN | Repo URL, SHA, CI, secret scan                                           |
| AC-02 | New Vercel project, production site, durable server state           | NOT RUN | Observed project/deployment URL, persistence-after-redeploy test         |
| AC-03 | Owner-only login and secure private endpoints                       | NOT RUN | Login smoke + negative unauthenticated API/file test                     |
| AC-04 | Beautiful real responsive dashboard, customizable widgets           | NOT RUN | Interactive E2E + desktop/mobile screenshots                             |
| AC-05 | Full task CRUD, status/reopen, search, views, bulk actions          | NOT RUN | Playwright E2E + unit edge cases                                         |
| AC-06 | Projects, relations, milestones, notes, progress                    | NOT RUN | Integration + UI E2E                                                     |
| AC-07 | Calendar day/week/month/agenda and correct local events             | NOT RUN | DST/recurrence tests + UI interactions                                   |
| AC-08 | Work Planner timeline/work hours/Excel Jena & Seewiesen             | NOT RUN | XLSX file content assertions + E2E                                       |
| AC-09 | Secure files, metadata, versions, archive/restore relations         | NOT RUN | Byte/checksum + archive-rule integration tests                           |
| AC-10 | Google source migration no loss/no moves, idempotent replay         | NOT RUN | Private reconciliation report + dry-run proof                            |
| AC-11 | Activity audit history append-only/operation provenance             | NOT RUN | Integration test + rendered UI history                                   |
| AC-12 | Remote Streamable HTTP MCP tools listed with secure discovery       | NOT RUN | Inspector captured tool list, unauthorized rejection                     |
| AC-13 | Authenticated MCP mutations share DB with browser                   | NOT RUN | Remote client write then UI read-after-write                             |
| AC-14 | Real ChatGPT plan/access researched; actual connection if eligible  | NOT RUN | Eligible client demo OR explicit verified eligibility blocker + fallback |
| AC-15 | In-app AI preview, approval, execute and verify                     | NOT RUN | Model/tool simulation + real configured AI test if authorized            |
| AC-16 | Export, backup, staging restore with integrity                      | NOT RUN | Restore drill, counts, links and file hashes                             |
| AC-17 | Accessibility/mobile/RTL/dark theme                                 | NOT RUN | axe/keyboard/mobile visual tests                                         |
| AC-18 | Unit, integration, contract, E2E, threat/security, migration CI     | NOT RUN | CI run/test report with actual counts                                    |
| AC-19 | Monitoring, sync status, fallback, backup age and runbook           | NOT RUN | Owner view + failure injection                                           |
| AC-20 | Complete Persian documentation and secure owner handoff             | NOT RUN | Verified files, operation guide, auth setup steps                        |

## V2 additional P0 release gates (NO deferral)

| ID    | Acceptance gate                                                                                               | Initial | Minimum evidence                                                                                              |
| ----- | ------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------- |
| AC-21 | Hard task dependency DAG; all-of and user-defined any-of prerequisite groups                                  | NOT RUN | UI+SQL+API/MCP E2E demonstrating A requires B & C, B requires D and OR group; real readiness changes          |
| AC-22 | Transactional cycle/retry/reopen/waiver safety and at-risk impact                                             | NOT RUN | Self/cross-project/deep/concurrent cycle tests; no partial writes; audit on waivers; downstream recalculation |
| AC-23 | Multiple named checklists with atomic toggle, editing, order, progress and audit                              | NOT RUN | UI + DB + MCP read-after-write; reload, keyboard/mobile and concurrency tests                                 |
| AC-24 | Nested subtask hierarchy, accurate progress and promotion/reparenting                                         | NOT RUN | Parent-cycle rejection, parent-independent status, promotion once, identity retained                          |
| AC-25 | Graph/Gantt/tree/blocked views + accessible text alternative and consistent summaries                         | NOT RUN | Visual mobile/desktop screenshots + keyboard axe + actual linked DB content                                   |
| AC-26 | Graph/Checklist API, MCP and in-app AI share domain, auth and idempotency                                     | NOT RUN | Authorized MCP mutation appears in UI; unauthorized and AI injection tests fail closed                        |
| AC-27 | Recurrence and task-template clone remaps internal edges; scheduling preview doesn't silently shift deadlines | NOT RUN | Synthetic nested template fixture/recurrence/DST/preview tests                                                |
| AC-28 | Source migration zero fabricated edges, large graph, backup/restore graph state                               | NOT RUN | Source reconciliation, 10k/30k load test, verified private restore graph invariants                           |

All 40 named scenarios in `ADVANCED_TASK_GRAPH_SPEC.md` §8 are part of these gates. These are separate from, and in addition to, AC-01..AC-20. Record observed evidence only.

## Migration-specific checklist

- [ ] Live Google account/Sheet/folder access validated before migration.
- [ ] All six actual Sheet tabs read fully and independently counted; blank/template rows excluded.
- [ ] Actual `ledger-schema.json`, `hub-config.json`, `workflow-rules.md` fetched from System and compared to ZIP references.
- [ ] Private source snapshot stored outside public repo with access controls.
- [ ] Source task IDs, title/body/next_action, nullable due dates/times, priorities, statuses, timestamps and revisions preserved.
- [ ] Every original Files record and Drive ID/URL/parent/version verified; original Drive bytes/location unchanged.
- [ ] Every active/inactive task-file Link preserved and referentially validated.
- [ ] All historical Activity entries preserved with source actor/op id and source JSON fields; append-only behavior tested.
- [ ] Legacy Settings/Guide retained and unmapped fields accounted for.
- [ ] Dry-run passed without side effects; real import idempotent across reruns/interruption.
- [ ] Source-vs-destination reconciled to live counts, row hashes/field diffs, relationships, status distribution and source-revision checkpoint.
- [ ] Source Sheet remains protected/read-only reference after cutover; legacy write split-brain addressed safely without unauthorized edit.
- [ ] Migration problems presented for resolution rather than silently dropped.

## MCP-specific checklist

- [ ] Endpoint deployed and has correct HTTPS URL, SDK protocol, content negotiation and Streamable HTTP transport.
- [ ] Protected-resource and OAuth discovery metadata work as required by actual client.
- [ ] Token/scopes are server-validated, owner-bound, revocable, not logged.
- [ ] All tool schemas match implementation with bounded cursor pagination and typed errors.
- [ ] Create/update/complete/reopen task works through remote client and UI read-back.
- [ ] Idempotency and conflict detection verified.
- [ ] File/Calendar write policies deny unsafe operations without extra authorization.
- [ ] Security negatives: no auth, expired token, read-only scope, IDOR, prompt injection.
- [ ] ChatGPT eligibility/installation explicitly distinguished from generic remote MCP success.
- [ ] In-app AI fallback and local generic MCP client setup work where ChatGPT write is unavailable.

## UX-specific checklist

- [ ] No fake buttons, placeholder stats, fake calendar events, or mock tasks in production.
- [ ] Persian RTL typography/mixed-script rendering accurate.
- [ ] English LTR fully functional.
- [ ] Mobile navigation/keyboard/touch workable without horizontal overflow.
- [ ] Dark/light/system theme durable across reload.
- [ ] Drag/drop calendar/tasks have accessible alternatives.
- [ ] Time zones Europe/Berlin/Asia/Tehran are correct across DST.
- [ ] Search/filter/query tied to live DB, with loading/error/empty/retry states.
- [ ] No private content in public screenshots, analytics, unauthenticated responses or Git history.

## Final gate

**Do not claim production ready if any P0/P1 blocker remains.** An external OAuth/billing restriction can be `EXTERNALLY_BLOCKED` only after completing independent code/tests and recording exact permission, UI step and test still missing. If the environment cannot run true parallel agents, report honest sequential implementation rather than fabricated teams.

## Observed UI checkpoint

The tables above preserve initial states; final release decisions belong to the orchestrator's observed checkpoint. Local production-bundle browser evidence proves graph/text equivalence, keyboard checklists/dependency editing, genuine OAuth MCP/browser parity, session persistence and exact-once recovery after a lost response. The build-8 full regression recorded 13 PASS / 4 FAIL / 1 production-redeploy SKIP; subsequent bounded reminder and native-drag tests passed, and build-9 scheduling passed with date-only preservation. Calendar contrast was repaired, but build-9 all-view evidence found an unfocusable Work log scroll region. The native focus fix and project-view/manual-order test await fresh execution. All-view screenshots, actual production redeployment, remaining master breadth and provider runtime gates must be checked before final acceptance. See the current [scope audit](PRODUCT_SPEC.md#remaining-scope-audit) and [visual evidence](UX_DESIGN_SYSTEM.md#visual-acceptance-evidence).

Build-10 execution subsequently recorded 20 PASS / 3 FAIL / 2 gated SKIP in 6.6 minutes. Project-view/manual-order and hourly keyboard-focus fixes passed their actual flows. Calendar's remaining failure was a test datetime-format issue; Dashboard premature preference submission and Files mobile card overflow were concrete app defects. Their bounded repairs are source-frozen and require fresh affected verification. All-view completion, remaining settings/PWA/native-resize assertions, actual production proofs and provider-specific gates remain separate requirements.

Build-11 affected execution recorded 2 PASS / 1 FAIL in 2.7 minutes. All 30 main-view desktop/mobile/tablet axe/overflow/capture checks passed (57 seconds) and all four Dashboard/Graph appearance checks passed (37.4 seconds); the resulting images were inspected. Dashboard range HTTP200, reload/read-back, keyboard height and native mouse widget resize persisted correctly. Retention read-back failed after a background settings refresh discarded an uncontrolled draft. Its controlled, revision-pinned repair is source-ready with type/lint checks passing; the Settings/PWA/report tail awaits build-12 execution. These observed local results neither mark production/provider gates complete nor close the separate AI scope review.

Build-12 targeted verification passed 1/1 in 52.6 seconds: the complete Dashboard/Settings/PWA/Reports case proved exact retention/accessibility/density persistence, native keyboard operation, saved-preference Settings whole-page axe, range HTTP200/reload, both widget-resize paths, real manifest/icons/worker and no private cache entries. Earlier build-11 failures are retained as historical evidence; the repaired local Settings flow is now PASS. Actual OS installation, independent AI scope work and production/provider acceptance remain separate.
