# Ramin Life OS engineering contract

User language: Persian. Source code destination is this repository only; reference work_planner and Google Drive originals stay read-only.

Private source files, IDs, ledger rows, calendar feeds, credentials, backups and real screenshots MUST remain outside public Git. Public tests use synthetic data.

All browser/REST/MCP/AI writes invoke the shared domain service with owner-bound principal, scope, idempotency key, expected revision, transaction and append-only audit. Production persistence is PostgreSQL; transient filesystem/localStorage are not a database.

Read docs/ADVANCED_TASK_GRAPH_SPEC.md before task graph changes. ALL/ANY prerequisites, Done-only qualification, derived readiness, transactional cycle rejection, independently tracked child tasks and multiple checklists are mandatory. Never invent imported relationships or deadlines.

Ownership while parallel agents are active: coordinator owns root configuration/auth/API/MCP/release; domain agent owns server/db, server/domain, shared/contracts.ts and tests/domain; UI agent owns app except app/api, components, features and styles; migration agent owns scripts/migration and server/integrations. Coordinator serializes commits. Do not edit another owner's files without assignment.

Complete meaningful type/lint/unit/integration/E2E/security checks. Record observed evidence in docs/BUILD_PROGRESS.json. A source file or successful build alone does not prove an acceptance gate. Never declare production-ready with unverified deployment/migration or unresolved P0/P1.

<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
