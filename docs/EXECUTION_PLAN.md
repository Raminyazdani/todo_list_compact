# Execution plan

Current status: canonical implementation and integration verification. The repository has committed foundation work on `feat/life-os`; the default branch remains `master`. Production auth/MCP verification is tracked by the orchestrator. The full UI regression pass, source cutover and provider-specific gates remain separate evidence requirements. The milestone table retains its historical initial states; use the dependency test matrix and release checkpoint for observed outcomes.

## Architecture decisions to verify

- Full-stack strict TypeScript with Next App Router, React, accessible CSS design tokens and pnpm lockfile.
- Durable PostgreSQL, versioned SQL migrations, normalized identities/relations and serializable/advisory-lock graph mutations. Private object storage holds new uploaded bytes; imported Drive files remain external references.
- One authenticated domain command/query boundary shared by browser, REST, MCP and AI. Bound inputs with schemas; enforce actor/scopes/owner, revision, idempotency and append-only audit centrally.
- Owner authentication via mature identity/session mechanism; secure cookies and server authorization on every private path. OAuth-protected remote Streamable HTTP MCP uses supported SDK/metadata/client discovery.
- Provider adapters for calendar/storage/AI; outbox/job state is durable. Missing provider authorization disables that connection truthfully while local features remain functional.
- Persian RTL by default, English LTR supported; timezone Europe/Berlin with date-specific Asia/Tehran conversions. No invented deadlines or private demonstration fixtures.

Implementation uses the installed strict TypeScript/Next/React stack, Better Auth owner sessions/OAuth, PostgreSQL transactions and CSS theme variables. Provider configuration and successful runtime operations require their own evidence; a configured flag alone does not verify a provider.

## Milestones and barriers

| Wave               | Deliverables                                                                                                                                   | Required verification                                                                                | Initial state |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------- |
| A — discovery      | Git/tool/resource audit; full contract read; reference inventory; live private source/schema snapshot; privacy boundaries                      | Observed account/repository/provider capabilities and source freshness                               | ACTIVE        |
| B — contracts      | Shared DTO/error/auth/operation/date rules; SQL model; graph/checklist domain; design tokens; migration/calendar contracts                     | Contract approval before dependent UI/MCP work                                                       | NOT RUN       |
| C — vertical slice | Authenticated task DB/REST/UI/MCP; A(B,C), B(D); two checklists; consistent ready/blocked state                                                | Real PostgreSQL, auth negatives, retry/conflict/cycle tests, reload read-back                        | NOT RUN       |
| D — features       | Task/project/dashboard views, graph/Gantt/tree, files/version/archive, calendar/time/XLSX, AI preview/approval, operations                     | Focused module tests and independent security/UX review                                              | NOT RUN       |
| E — integration    | Complete API/MCP contracts, migration dry-run/replay/reconcile, backup restore, 40 graph tests, full E2E/load/a11y/security                    | Actual counts/commands/results; no source mutation; zero P0/P1                                       | NOT RUN       |
| F — production     | New Vercel project linked to exact repository/default branch; approved PG/private storage; owner auth; real MCP client; safe migration/cutover | Actual URL/SHA, production login/smoke, external auth discovery/write/readback, redeploy persistence | NOT RUN       |
| G — handoff        | Evidence checklist, Persian guides, operator recovery/connection docs and checkpoint                                                           | Evidence independent of implementer; every unverified gate explicit                                  | NOT RUN       |

## Working protocol

Actual runtime supports four concurrent agents total. Work in disjoint ownership paths in the shared checkout; root configuration/contracts/commits are serialized by the orchestrator. Never reset another agent's changes. Team roles can span several waves; named roles are responsibilities, not a claim that 13 agents ran.

The graph/checklist specification controls graph semantics. UI implementation waits for approved shared contracts. Domain, UI and adapter work share signatures rather than independent state copies. Reviews and release evidence come from observed tests, not agent completion messages.

## Test gates

Strict typecheck/lint/reproducible build; meaningful unit and isolated PostgreSQL integration; REST/OpenAPI and MCP transport/auth contracts; Playwright authenticated browser flows; independent attack/race/migration/backup tests; axe/keyboard/mobile/RTL/dark/light and synthetic screenshots. Measure baseline realistic data and graph 10,000 nodes/30,000 edges. Publish sanitized outcomes only.

All 40 graph scenarios and AC-01..28 remain NOT RUN initially. Target meaningful critical-domain coverage at least 85%, with branch/risk evidence prioritized over a cosmetic percentage. Production smoke and redeploy persistence require actual production resources; localhost is not equivalent.

## External boundaries

Probe before labeling a blocker. Potential owner steps include provider OAuth, approved free resource provisioning, owner identity callbacks, AI key and actual ChatGPT client eligibility. Paid resources, external calendar writes, email, source movement/sharing and irreversible actions require distinct authorization. Finish all independent code/tests before requesting the exact unavoidable step.

## Checkpoints

Update actual branch/commit, current phase, verified URL or null, operation outcome, test command/result, source migration aggregate counts, evidence references, severity and next unblocked tasks after material milestones. Unknown/uncertain outcomes are not success. Resume existing work; never restart or replay migration without operation checks.
