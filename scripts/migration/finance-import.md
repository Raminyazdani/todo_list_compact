# Reviewed finance source import

This operator workflow imports an explicit owner finance snapshot through the same REST/domain service as the application. It never treats a budget as a paid transaction or interprets source prose as instructions.

All source, mapping, credential, normalized payload and receipt paths must be absolute regular files outside the repository. Parent directories must already exist. Source files are read only.

## Input

JSON uses `FinanceImportDTO` from `shared/contracts.ts`: format `ramin-life-os/finance/1`, currency `EUR`, and `accounts`, `categories`, `plans`, `transactions` arrays. References use stable source `external_key` values, not guessed workspace IDs. The service validates the complete contract. Imports are bounded to 1,000 total records and 2,000,000 UTF-8 bytes. Money uses integer cents; unknown amounts and account balances remain `null`.

For descriptive Markdown, provide a separate reviewed mapping:

```json
{
  "format": "ramin-life-os/finance-markdown-map/1",
  "expected_source_hash": "<SHA-256 of the exact UTF-8 Markdown source>",
  "data": "<FinanceImportDTO containing literals and explicit cell references>"
}
```

The example above describes the mapping structure; `data` must be an object in a real file. Inside it, this synthetic fragment selects a money cell:

```json
{
  "$cell": { "table": 0, "row": 0, "column": "Amount" },
  "as": "cents"
}
```

Tables and data rows are zero based; columns may use an exact header or zero-based index. Conversions are `text` (default), `cents`, or `integer`. Money references may specify `decimal_separator` (`.` or `,`) and `allow_negative: true` for an explicitly signed source amount. Ambiguous separators, fractional cents and missing cells stop normalization. Blank/unknown money is `null`, while a written zero remains zero. Escaped pipes and code spans are literal table content. A changed Markdown hash requires a new source review; rows are never silently remapped.

## Commands

Run from the repository with the project's installed runtime. Paths and hostname below are placeholders for a private operator workspace and the intended application origin.

```text
pnpm exec tsx scripts/migration/finance-import.ts --normalize C:/private/finance/source.md C:/private/finance/payload.json C:/private/finance/mapping.json
pnpm exec tsx scripts/migration/finance-import.ts --normalize C:/private/finance/source.json C:/private/finance/payload.json
pnpm exec tsx scripts/migration/finance-import.ts --preview https://life-os.example C:/private/finance/credentials.json C:/private/finance/payload.json C:/private/finance/cutover.json
pnpm exec tsx scripts/migration/finance-import.ts --commit https://life-os.example C:/private/finance/credentials.json C:/private/finance/payload.json C:/private/finance/cutover.json
```

The credential file contains the exact `origin`, authenticated `user_id`, `owner_id`, `email`, and `password`. It stays private and is never printed. HTTPS is required except for an explicit localhost origin. The CLI verifies `whoami` before preview or commit and binds the retained receipt to that actor, owner, destination and payload.

Normalization writes a compact payload within the exact two-megabyte read limit plus a private normalization receipt. Identical reruns preserve the same output; different content cannot overwrite it. Preview stores the service's conflict/count result in the private cutover receipt. Review that receipt before committing. Existing differing source keys are conflicts, not permission to overwrite owner edits.

Commit pins the preview, uses `If-Match: 0`, and stores an `attempted` receipt before contacting the service. A timeout is an uncertain outcome. Keep the source and receipt and rerun the identical commit: it retains the original preview and idempotency key. Do not delete the receipt or invent another key to retry. A confirmed result is read back using `finance_export`; imported keys must match the authoritative domain-normalized representation before the receipt becomes `verified`. This accounts for trimmed titles/keys, sorted monthly versions and canonical archive instants while retaining the original source hashes and intent. Unrelated owner rows remain untouched. A denied or oversized export leaves the acknowledged import `confirmed`, not falsely verified; a later retry performs readback without resending the confirmed mutation.

An expired preview with no attempted commit requires a fresh reviewed preview/receipt. The CLI does not replace an uncertain intent with a new preview. No credentials, source rows or private source identifiers belong in public logs or Git.
