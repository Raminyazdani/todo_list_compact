# Security and disclosure

This public repository contains reusable code and synthetic fixtures only. User records, source ledger IDs, calendar feeds, provider tokens, credentials and backups are private.

Report security issues privately through the repository owner's contact; do not publish source records or secrets in an issue. Production requires durable PostgreSQL, owner-only Better Auth sessions, scoped OAuth MCP, server-side ACLs, revision/idempotency checks and append-only audit. All source Drive originals remain read-only.

Known external limits are recorded in docs/BUILD_PROGRESS.json and the release report. Missing storage or AI configuration does not permit a public or fake fallback. Uploads are attachment-only, signature-checked, size-bounded and owner-namespaced. Antivirus scanning is not configured; executable previews are disabled.

Preview/staging resources are isolated from production. Run destructive/adversarial tests only with synthetic records in an isolated environment. Do not change account permissions, disable authentication or delete historical originals to pass a release gate.
