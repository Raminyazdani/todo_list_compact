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

The independent localhost production-bundle browser evidence now contains nine passing scenarios across the stable full baseline and bounded affected reruns, with the actual production-redeployment scenario explicitly NOT RUN/opt-in. The meaningful lost-response test committed a real task, discarded only the browser acknowledgement and recovered exactly one record with the same operation key. Notes-only recurring event edits retained the actual master rule, timezone and timestamps including seconds. Keyboard checklist persistence, genuine OAuth MCP/UI parity and fresh-session task persistence passed.

Whole-page WCAG 2 A/AA-tagged axe reported zero violations for Dashboard and Graph in dark Persian RTL and light English LTR at 1440x1000 on 2026-10-14 Europe/Berlin. Actual screenshots were inspected: `artifacts/screenshots/synthetic-dashboard-dark-rtl.png`, `synthetic-dashboard-light-ltr.png`, `synthetic-graph-dark-rtl.png` and `synthetic-graph-light-ltr.png`; last light captures were written at 2026-10-13 22:02:30/39 UTC. The light graph revealed retained zoom after focus change despite the DOM and axe passing; the next implementation uses a node-scope remount/fit and horizontal handles, and requires another actual visual check. The 375px persisted dependency screenshot passed read-back and no document overflow.

Evidence command: `node node_modules/@playwright/test/cli.js test tests/e2e/workflow-ui.spec.ts --reporter=list`, with private staging credentials supplied through `E2E_CREDENTIALS_PATH`; affected retries selected only changed scenarios with `--grep`. Screenshots and authenticated traces are ignored/private local artifacts. No live source content or credentials are included in public Git. Automatic axe results alone do not establish complete WCAG conformance. Additional Projects, Calendar modes, Work log, Files, Reports, Settings, Assistant and responsive/empty/error screenshots and new feature browser checks remain pending until observed.
