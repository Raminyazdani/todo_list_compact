# Security and disclosure

This public repository contains reusable code and synthetic fixtures only. User records, source ledger IDs, calendar feeds, provider tokens, credentials and backups are private.

Report security issues privately through the repository owner's contact; do not publish source records or secrets in an issue. Production requires durable PostgreSQL, owner-only Better Auth sessions, scoped OAuth MCP, server-side ACLs, revision/idempotency checks and append-only audit. All source Drive originals remain read-only.

Known external limits are recorded in docs/BUILD_PROGRESS.json and the release report. Missing storage or AI configuration does not permit a public or fake fallback. Uploads are attachment-only, signature-checked, size-bounded and owner-namespaced. Antivirus scanning is not configured; executable previews are disabled.

Preview/staging resources are isolated from production. Run destructive/adversarial tests only with synthetic records in an isolated environment. Do not change account permissions, disable authentication or delete historical originals to pass a release gate.

## Publication snapshot privacy boundary — 2026-10-30

Source publication does not authorize provider activation, deployment, migrations,
mail/calendar operations, paid services, or resetting a database. Keep real owner
IDs/records, contact histories, CVs, calendar feeds, credentials, database files,
exports, backups, sessions, browser cookies and actual screenshots out of Git,
even in private repositories. Use synthetic fixtures and a credential-free
environment for local checks. Optional Google, Telegram, Codex, AI, email and
calendar integrations stay inactive without their separate authorization.

Review the exact staged tree and intended history before publication. Ignore rules
protect new files; they do not remove old tracked files. Do not automatically delete
private historical data or rewrite existing repository history. An actual credential
exposure requires stopping publication and handling revocation/rotation privately.
Do not paste usable credentials or private data into issues, logs or commit messages.

Static secret scans and dependency audits have bounded coverage; they do not prove
complete PII detection, provider restrictions, hosted security or runtime acceptance.
All local-history audit refs are private local preservation material and must never
be mirrored or pushed. The publication clone uses the existing owned remote parent
and does not import source-local history objects or refs.
