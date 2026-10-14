# Neon: actual production verification

Observed on 2026-10-14 after the owner completed the existing Neon account login. This receipt supplements the historical migration, graph and recovery evidence; no import or database restore was repeated.

The production and staging database endpoint hosts were matched to their existing Neon projects and branches. Each received a private bucket and a separate server credential restricted to storage read/write. No project replacement, plan upgrade or purchase occurred. Both actual conditional-write probes passed: initial PUT accepted, replacement with `If-None-Match: *` rejected with HTTP 412, original bytes preserved and anonymous GET denied. The exact synthetic probe objects were deleted and their absence verified.

The isolated staging domain smoke passed real Neon storage, PostgreSQL transactions and the native protected download route handler. Two versions and their canonical receipts were preserved; same-key replay did not duplicate registration. One synthetic task and two synthetic files were archived through the domain service. This is native route-handler evidence, separate from production HTTPS/browser evidence.

Production deployment `dpl_ES9QpWct7NJWY7pqpoivimFHMzWD` reached READY at `5ef90ec1387fe3243c4fb1163dad37280a80bcbb` with the verified Neon environment. Its application files are identical to fully tested `d3474048e7731cd0da4d1b92df09204825afb943`; the intervening receipt changed documentation only. [Full CI 38574338435](https://github.com/Raminyazdani/todo_list_compact/actions/runs/38574338435) remains the code/test evidence.

The actual production owner HTTPS/browser smoke passed:

- Two uploads in one version family, different immutable file/version identities and exact SHA/byte read-back of both versions.
- Same upload/idempotency key replay returned the original operation/entity/audit receipt.
- Owner-only downloads and four anonymous HTTP 401 denials, including after archive.
- Actual browser version links, preview and text comparison, without screenshots or traces.
- Nine canonical intents, exactly one persisted operation and matching audit for each.
- Only the recorded synthetic task and two files archived; registered bytes/history retained.
- Every pre-existing checked row remained unchanged, with 45 original active tasks and three original active Drive references.

S3 secrets remain in server/private configuration outside public Git. Existing files use their recorded provider; selecting Neon never rewrites original Drive references or legacy Blob metadata. Staging local server configuration was updated only after its live probe/domain proof; unrelated environment values and both database endpoints were preserved.

## Backup evidence

On 2026-10-14 the manually executed daily Neon metadata job passed cloud read-back, authenticated decryption and all 32 table checksums/manifest: 509 rows, including 73 tasks, 5 files/versions/links, 93 accepted operations and 159 Activity rows. Same-day replay preserved the exact ciphertext and single provider-specific receipt; selected-provider health reports verified with an actual timestamp. The independently encrypted original-byte package was also copied unchanged to private Neon storage, downloaded, persisted and decrypted; all three originals (6,698,095 bytes) and their retained identity/filename/parent metadata matched. The recovery key was kept separate. No new database restore was performed. This manual proof does not establish that the scheduled cron has run.

## Remaining client step

In-app AI remains deferred and disabled at the owner's request. Native Codex `life_os` OAuth login is already successful with normal business scopes, excluding admin/backup. This running chat still has no loaded `life_os` tools. Fully restart Codex, return to the same chat and perform one actual native MCP read. Repeating account enrollment, import, password rotation or OAuth authorization is unnecessary.

Private provider targets, source IDs/hashes, object keys, credentials, recovery keys, journals and recovered encrypted packages remain outside public Git. Historical failed operator attempts retain their own outcomes.
