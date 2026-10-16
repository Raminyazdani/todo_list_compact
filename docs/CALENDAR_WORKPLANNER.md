# Calendar and Work Planner integration

## App-specific Google activation

The authenticated production preflight on 2026-10-16 observed `oauth_client_configured=false`. Google and iCal were unconfigured in that deployment. A Google connector in a Codex chat is a separate grant and cannot supply the app's OAuth credentials.

Create an OAuth **Web application**, enable Google Calendar API, and configure redirect URI `https://ramin-life-os.vercel.app/api/auth/callback/google`. Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the intended Vercel environment, redeploy, and use Settings → Google connection while signed in as the existing owner. Do not paste credentials into chat or public receipts. Configuring the client alone does not establish user consent.

The app requests `calendar.readonly` plus `calendar.events.owned`. Personal-event changes require fresh organizer/guest/type and master/instance checks. Invited, locked and special events remain read-only. Writes use `sendUpdates=none`, ETag `If-Match`, stable creation identifiers and reconciliation after uncertain delivery. Recurring edits support one occurrence or the complete series.

References: [Better Auth Google setup](https://better-auth.com/docs/authentication/google), [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [conditional updates](https://developers.google.com/workspace/calendar/api/guides/version-resources).

## Persistent foreground synchronization

Display queries read owner-bound PostgreSQL cache without provider network traffic. Remote calls run outside owner write transactions; source/intent claims and receipts use short audited transactions. Each source retains its own last success, coverage and sanitized error. Transient errors retain stale data; revoked sources are hidden. Generation, lease and cache-revision fences reject obsolete completions.

Google caches raw masters, exceptions and cancellations. Incremental checkpoints advance only after every page succeeds; `410` rebuilds a complete staging snapshot before replacement. Recurrence expansion is bounded to the displayed range. See [Google incremental sync](https://developers.google.com/workspace/calendar/api/guides/sync).

Refresh runs on opening/focusing Calendar, every five minutes while visible, and manually. Outgoing intents are attempted immediately. Unfinished operations persist until subsequent foreground reconciliation; no new closed-app scheduler is installed. Completeness and freshness are distinct states.

Multiple private iCal sources support conditional reads. Feed URLs are encrypted with owner/source-bound authenticated encryption and omitted from public DTOs. HTTPS requests deny redirects, URL credentials, arbitrary ports, IP hosts and nonpublic DNS results, and pin the validated public address. Time, byte and recurrence limits remain enforced. Source timezone, all-day exclusive ends, recurrence exceptions and free/declined metadata are preserved.

## Native work planning and migration

Calendar and Work time use Life OS tabs and design tokens; `/time` remains a compatible work-tab route. Appointments, task deadlines, recorded work and incomplete drafts are distinct records. Work rows never invent task deadlines or relationships.

Legacy imports preserve origin IDs, multilingual descriptions, original local inputs and `legacy_wall` reported minutes. New entries use `elapsed` duration. Ambiguous local times require explicit earlier/later choices; DST gaps are rejected. Incomplete rows persist as drafts outside totals and Excel. Overlaps are warnings: recorded hours are summed, while conflict minutes count the union separately. Undo compensates a revision-checked work change and retains audit history.

Whole-history JSON retains drafts and reporting metadata, with bounded import batches and replay checks. Employer Excel includes daily formulas, `[h]:mm` durations, entry IDs, conflict snapshots and description details. User text is literal; generated formulas alone execute. The Work Planner MIT notice remains in `server/integrations/WORK_PLANNER_LICENSE.txt`.

`scripts/ops/workplanner-source-snapshot.ts` uses SELECT in a READ ONLY PostgreSQL snapshot; it never initializes or alters the source store. It verifies an encrypted private readback. `scripts/migration/workplanner-cutover.ts` previews and imports through canonical owner HTTP APIs with a private retry journal. Source snapshots, identifiers, feed configuration and rollback backups stay outside Git. The source site/database remain unchanged.

## Verification status

Implementation evidence and remaining live activation gates are recorded in [BUILD_PROGRESS.json](BUILD_PROGRESS.json). Tests against mocked Google responses verify behavior but do not establish a real app-specific OAuth grant. A successful build does not establish deployment, migration or actual Google two-way sync.

## Reference parity matrix

The reference is Work Planner commit `14fc5aefd727bc71505403b94e8b8fbb3563e57a`. Its source and original database are read-only. These checks use synthetic fixtures unless a private operational receipt explicitly records a live check.

| Reference capability                     | Life OS location                     | Verification                                                       |
| ---------------------------------------- | ------------------------------------ | ------------------------------------------------------------------ |
| Employer rows and multiline descriptions | Calendar → Work time                 | Browser autosave and canonical readback                            |
| Incomplete rows                          | Persistent work drafts               | Reload, promotion and JSON roundtrip                               |
| Monthly totals for Jena and Seewiesen    | Work summary and employer filter     | Domain policy and Excel tests                                      |
| Horizontal 00–24 monthly timeline        | Work time                            | Reverse draw, move, resize and keyboard browser tests              |
| Overnight and month-boundary work        | Exact interval editor                | Domain elapsed/legacy clipping tests                               |
| Calendar overlay and busy conflicts      | Work timeline and conflict summary   | Free/declined, interval union and source tests                     |
| Private iCal feeds                       | Shared source controls               | Encrypted configuration, isolated failures and bounded HTTPS tests |
| All reference holiday regions            | Shared holiday selector              | Calendar integration tests and native controls                     |
| Undo                                     | Work toolbar                         | Audited compensation and revision tests; browser readback          |
| JSON import/export                       | Work transfer controls               | Legacy, drafts, large batches and uncertain ACK browser tests      |
| Employer Excel                           | Work transfer controls               | Daily formulas, `[h]:mm`, identities and literal-text tests        |
| Concurrent devices                       | Conflict choices with retained draft | Revision rejection and exact retry tests                           |
| Native Life OS theme                     | Shared workspace components          | Dark/light × desktop/mobile accessibility checks                   |

Google personal-event writes, source checkpoints, stale data and foreground refresh are additional Life OS capabilities. Their synthetic provider tests and live app authorization are recorded separately.
