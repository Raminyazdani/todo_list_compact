# Ramin Life OS source snapshot provenance

Import preparation UTC: `2026-10-30T11:20:18.406256+00:00`.

Source HEAD label: `99b3508ead0df599d16a8dda7b3b32dba53c8b2f` (provenance only; local history is not imported).

Owned remote parent: `99b3508ead0df599d16a8dda7b3b32dba53c8b2f` on `master`.

Original copied code-file count: 333. Aggregate SHA256 of ordered path/source-file-SHA records: `00900e32f57433c4d405587a48f3a7d4bb43d770be13a241f06444eac38dbb23`.

The source snapshot was stable before/after copying; originals and every local Git ref remain preserved. Existing safe tracked files from the owned remote parent are retained unchanged where the code snapshot excludes operational context. Text normalization in the isolated publication Git configuration preserves the existing LF commit convention; original copied file hashes remain in the private publication receipt.

The source HEAD already equals the existing remote base; no new product feature implementation is claimed. Local checks are isolated and scoped. The original-code rights notice is added because no root license was present; existing third-party licenses remain unchanged.

Refer to the authoritative `TODO_PUBLICATION_READY.json` receipt kept outside the source repository for exact check outcomes, file hashes, exclusions and limitations. No commit, push, default-branch change, cloud setting or deployment was performed in preparation.

## Observed isolated validation

Frozen pnpm install, typecheck and production compilation passed in the isolated copy. Synthetic domain checks passed: 31 files and 260 tests; two opt-in files/ten tests remained skipped. The tests used in-memory PGlite, not a live owner database. The original frozen lock reported five moderate and two low advisories. A compatible security update now resolves Vitest/coverage-v8/mocker 4.1.12, ajv>fast-uri 3.1.9 and express>qs 6.16.1; the updated frozen audit is zero. The same 260 domain tests, typecheck and production compilation passed again on the updated dependency graph. Original source files and the baseline lock remain preserved outside this publication copy. No hosted/provider/browser or real PostgreSQL acceptance is claimed.

The initial unit launch failed because a Windows package realpath exceeded 260 characters; the unchanged source hashes passed from a fresh short-path test workspace. No application-code fix was made to bypass that tooling error. Runtime credentials were absent, external test traffic was guarded, installation hooks were disabled, and source workspaces were not executed or changed.
