# Experience and design system

Design status: implemented private workspace; authenticated synthetic browser evidence is recorded below. The goal is a calm, compact, polished Persian-first workspace with real information and dependable interactions. Automated checks do not establish complete accessibility conformance.

## Information architecture

Desktop sidebar: Today, Tasks, Projects, Calendar, Work log, Files, Reports and Settings. Header provides breadcrumb, global search/command launcher, capture and owner state. The AI command panel is context-aware. Mobile uses a bottom navigation plus accessible overflow and an agenda/day-first calendar. Detail drawers preserve task context and have a full-page fallback.

Task views: List/Table, Board, Tree/WBS, Graph and Timeline. Ready and Blocked are explicit filters independent of workflow. Task detail has Overview, Checklists, Subtasks, Prerequisites, Unblocks, Schedule, Files, Notes/Comments and History. Dependency picker states `requires`, ALL/ANY and hard/soft in plain language with actual links and impact preview.

## Tokens

| Token family | Decision                                                                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Color        | Quiet warm neutral canvas, surface/raised-surface separation, ink/subtle text; one restrained indigo action accent; semantic success/warning/danger with text/icon labels     |
| Typography   | Licensed/system Persian-capable sans fallback; readable body 14–16px, compact labels 12–13px, modest 22–30px page titles; strong numeric alignment and mixed-script isolation |
| Spacing      | 4px base scale; 8/12/16/24/32px gaps; dense lists with enough touch target height                                                                                             |
| Shape        | Consistent 10–14px cards/dialogs; subtle borders/shadows; no oversized hollow decorative cards                                                                                |
| Focus        | Visible high-contrast focus ring, logical keyboard order, clear active selection independent of color                                                                         |
| Motion       | Short purposeful transitions; respect reduced-motion; saved/pending/conflict states legible without animation                                                                 |
| Layout       | Responsive grid, min-width-safe content, collapsible nav, bounded details pane and no mobile horizontal overflow                                                              |

Implement reusable CSS variables for light/dark/system; persist theme/language/density/view/widget choices via settings. Theme initialization must not flash private content or expose unauthenticated data.

## Interaction contracts

- Capture is quick and editable. No invented due date or inferred committed dependency. Persian and English text retain original content.
- Each control has a domain operation or real navigation. Missing configured providers present disabled/reconnect states with actionable guidance; no fake metrics/events/buttons.
- All saves show pending/saved/error/conflict. Do not display a local draft as server-saved. Undo is available only for eligible audited operations.
- Drag operations have buttons/selectors/keyboard equivalents. Blocked start/finish opens blockers and owner reason/confirmation; it does not silently change readiness semantics.
- Checklists show checked/total and empty state instead of misleading 100%. Parent/subtask progress is informative; completion remains independent.
- Graph supports inspect, directed arrows, zoom/pan, upstream/downstream context and readable linear equivalent. Timeline uses actual dates/estimates and labels insufficient estimates.
- Calendar source layers distinguish deadlines, appointments and worked hours. All-day dates remain dates. Timezone and sync freshness are explicit.
- Files show source/provider, version, archive state and checksum availability; downloads and previews remain private.
- Dialogs trap/return focus and close with Esc; status/error announcements are accessible. Shortcuts: `/`, `N`, Ctrl/Cmd+K; avoid triggering while typing in fields.

## RTL/LTR and accessibility

Set document language/direction from preferences, use logical CSS properties, isolate URLs/IDs/Latin text and retain readable digit/calendar formatting. Test keyboard and touch at 375/390px, tablet about 768px and desktop 1440/1920px. Use semantic headings/buttons/forms/labels, screen-reader live statuses, sufficiently large targets, contrast and reduced motion. Follow WCAG 2.2 AA-oriented automated axe and manual checks; automated results alone do not establish full conformance.

## Reference planner review and reuse

Read-only review completed for the reference planner README, security policy, MIT license, package manifest, HTML application and its core/holiday/export tests. Behaviors reviewed include the 24-hour timeline, ruler, interval overlap checks, Jena/Seewiesen work descriptions and XLSX values, German regional holidays, iCal reads and backup/persistence. Adapted pure calendar/time/holiday/export helpers retain their license notice and focused tests. The new application uses its own PostgreSQL owner authorization and OAuth; the reference source and deployment remain unchanged. Private source identifiers, credentials and live source content are excluded from this document.

## Visual acceptance evidence

Real synthetic-only browser screenshots are required for Dashboard, Tasks, Projects, Calendar, Files, Settings, AI and error/empty states, light/dark and RTL/LTR, desktop/tablet/mobile. Inspect spacing/contrast/alignment/overflow and fix defects, then repeat only affected views. Save evidence references with test command and time.

Independent localhost production-bundle evidence includes the real lost-response task retry, notes-only recurring-series preservation, keyboard checklist persistence, genuine OAuth MCP/UI parity and fresh-session task persistence. The actual production-redeployment scenario remains NOT RUN/opt-in. Local browser tests do not establish production persistence after redeployment.

Whole-page WCAG 2 A/AA-tagged axe reported zero violations for Dashboard and Graph in dark Persian RTL and light English LTR at 1440x1000 on 2026-10-14 Europe/Berlin. Actual screenshots were inspected: `artifacts/screenshots/synthetic-dashboard-dark-rtl.png`, `synthetic-dashboard-light-ltr.png`, `synthetic-graph-dark-rtl.png` and `synthetic-graph-light-ltr.png`; the latest four captures were written at 2026-10-13 23:30:40–57 UTC. The earlier light-graph zoom defect was repaired with a node-scope remount/fit and horizontal handles; the fresh images show all four synthetic nodes and dependency arrows. The 375px persisted dependency screenshot passed read-back and no document overflow.

The build-8 full run observed 13 PASS, 4 FAIL and one explicit production-redeploy SKIP. Failures were not counted as PASS: a PostgreSQL date-only decoding defect shifted a scheduling deadline, calendar outside-month text failed contrast, a reminder test acted before receiving the refreshed revision, and a native drag test started with an off-screen target. The date parser and contrast defects were fixed; reminder and real mouse drag tests subsequently passed with canonical response/read-back assertions, without disabling checks or rebasing stale writes. The build-9 affected scheduling test passed in 45 seconds with the original date preserved. Projects and calendar month/week/day/agenda desktop axe checks then passed, but the Work log hourly scroll area failed keyboard-focusability. Calendar and Work log hourly regions now have native focus and accessible names; fresh affected all-view verification remains required.

Evidence command: `pnpm exec playwright test --reporter=list`, with private staging credentials supplied through `E2E_CREDENTIALS_PATH`; affected retries select changed scenarios with `--grep`. The all-view test captures 30 synthetic desktop/mobile/tablet images across Projects, four Calendar modes, Work log, Files, Reports, Settings and Assistant, with page-level axe and overflow assertions. Its first complete PASS was observed on build 11 below. Local synthetic screenshots may be public artifacts; remote screenshots require an absolute directory outside the repository. Authenticated traces are disabled in CI and remote evidence. No live source content or credentials are included in public Git. Automated axe results alone do not establish complete WCAG conformance.

The breadth pass reached source freeze with successful TypeScript, scoped ESLint and formatting checks. `playwright test --list` observed 24 workflow scenarios plus one separately gated retained-production-proof scenario; discovery alone was not counted as execution. At that checkpoint the new breadth flows were NOT RUN. Installation UI describes actual browser support; it never claims an OS installation or stores private offline data. Retention preferences configure owner review without enabling automatic deletion. Calendar and file source views retain explicit scope/authorization boundaries.

The coherent build-10 full run then observed 20 PASS / 3 FAIL / 2 explicit opt-in SKIP in 6.6 minutes. Precise deadline/project/reference/linked intervals, rejected password changes, file annotations preserving source references and all five project views/manual order passed. All ten desktop main-view axe checks and eight mobile view checks passed before Files mobile document overflow failed. The new native Calendar creation/resize/source/category assertions passed before a test-only zero-seconds input-format rejection; that fixture was normalized. Dashboard range-save diagnostics captured the actual missing-revision HTTP400; preferences-dependent actions now wait for current verified settings. Nested file cards were constrained to their grid without masking overflow. These two app fixes and the remaining responsive/PWA/settings/native-widget checks require the next affected run. Earlier failed runs remain in the private checkpoint and are not replaced by an inferred PASS.

Build-11 affected execution recorded 2 PASS / 1 FAIL in 2.7 minutes on 2026-10-14. All 30 main-view page-level axe/overflow checks and synthetic captures passed in 57 seconds; the four Dashboard/Graph dark RTL/light LTR axe/capture checks passed in 37.4 seconds. All 30 main-view images were inspected at 1440px desktop, 375px mobile and 768px tablet. File cards remain inside their grid with explicit title ellipsis, filters wrap without overlapping controls, and Calendar's wide week grid uses a bounded internal scroller with agenda as an alternative. No new visible blocking layout defect was found in these captures. The Settings account identifier is intentionally masked in evidence.

The build-11 Dashboard scenario proved HTTP200 and durable range read-back, keyboard widget height, and native mouse resize followed by canonical persistence. It then failed retention read-back: a settings refresh remounted an uncontrolled form and discarded an in-progress value. Build-12 source replaces that form with a controlled draft, disables editing before verified preferences arrive, pins the revision at the first edit, and retains the draft through background refresh or a stale-revision conflict. Dashboard date/event/activity labels now use its selected timezone; upcoming task-deadline filtering is explicitly disclosed as Berlin calendar dates. TypeScript and scoped ESLint pass, but the repaired Settings/PWA/report tail remains NOT RUN until the next coherent bundle is exercised. Actual OS installation, live provider grants and production redeployment are separate gates.

Build-12 affected execution then passed the complete `dashboard_preferences_accessibility_and_pwa_capabilities_are_persistent_and_truthful` scenario in 51.4 seconds (runner 52.6 seconds) on 2026-10-14 UTC. It observed range-save HTTP200 and canonical reload/read-back, keyboard and native mouse widget resizing, exact retention 365 and nested accessibility/density persistence, native Space/focus operation, and zero whole-page Settings axe findings with the saved accessibility preferences enabled. It also verified the real manifest and PNG dimensions, active service-worker registration, absence of private API/task/file/calendar CacheStorage entries, and range-aware Reports with the registered-record/account-quota distinction. The test restored its own changed preferences. Actual OS installation and live provider/runtime/production gates remain unclaimed; the independent AI scope review is still open.
