import { readFile } from "node:fs/promises";
import { boundedSignIn } from "./bounded-signin.mjs";
import {
  admitPrivatePath,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

// This probe never returns event text, calendar identifiers, cookies or tokens.
// Its private receipt distinguishes app OAuth configuration from chat connectors.
async function main() {
  const [intent, origin, credentialsPath, reportPath, ...extra] =
    process.argv.slice(2);
  if (
    intent !== "--inspect-calendar" ||
    extra.length ||
    !reportPath ||
    !["https://ramin-life-os.vercel.app", "http://localhost:3000"].includes(
      origin,
    )
  )
    throw new Error("EXPLICIT_CALENDAR_PREFLIGHT_ARGUMENTS_REQUIRED");
  const credentials = JSON.parse(
    await readFile(
      await admitPrivatePath(credentialsPath, { mustExist: true }),
      "utf8",
    ),
  );
  const signedIn = await boundedSignIn(origin, credentials);
  if (!signedIn.ok) throw new Error("CALENDAR_PREFLIGHT_SIGNIN_FAILED");
  const cookie = signedIn.headers
    .getSetCookie()
    .map((line) => line.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("CALENDAR_PREFLIGHT_SESSION_MISSING");
  const query = async (operation, input = {}) => {
    const response = await fetch(
      origin +
        "/api/v1/query?" +
        new URLSearchParams({ operation, input: JSON.stringify(input) }),
      {
        headers: { Cookie: cookie },
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      },
    );
    const body = await response.json();
    return response.ok
      ? { ok: true, data: body.data }
      : { ok: false, status: response.status };
  };
  const capabilities = await query("system_capabilities");
  if (!capabilities.ok)
    throw new Error("CALENDAR_PREFLIGHT_CAPABILITIES_FAILED");
  const now = new Date(),
    from = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
    ).toISOString(),
    to = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    ).toISOString();
  const [sources, sync, events] = await Promise.all([
    query("calendar_list", { limit: 200 }),
    query("sync_status"),
    query("calendar_events_query", { from, to, limit: 200 }),
  ]);
  const states = sync.ok ? (sync.data?.external_sync?.sources ?? []) : [];
  const sourceItems = sources.ok ? (sources.data?.items ?? []) : [];
  const report = {
    format: "ramin-life-os-calendar-preflight/1",
    observed_at: new Date().toISOString(),
    origin,
    app_google_oauth_configured:
      capabilities.data.oauth_client_configured === true,
    app_external_write_capability:
      capabilities.data.external_calendar_write === true,
    google_source_write_ready: sourceItems.some(
      (source) =>
        source.provider === "google_calendar" &&
        source.enabled === true &&
        source.writable === true &&
        source.status === "connected" &&
        source.coverage?.complete === true,
    ),
    business_mutations_requested: false,
    source_query_ok: sources.ok,
    event_query_ok: events.ok,
    source_count: sources.ok ? (sources.data?.items?.length ?? 0) : null,
    returned_event_count: events.ok ? (events.data?.items?.length ?? 0) : null,
    more_event_pages: events.ok ? Boolean(events.data?.next_cursor) : null,
    sources: states.map((source) => ({
      provider: ["google_calendar", "ical"].includes(source.provider)
        ? source.provider
        : "external",
      status: /^[a-z_]{1,40}$/.test(source.status) ? source.status : "unknown",
      has_successful_sync: Boolean(source.last_success_at),
    })),
  };
  await writeExclusivePrivateJson(reportPath, report);
  console.log(JSON.stringify(report));
}
main().catch(() => {
  console.error(
    "CALENDAR_PREFLIGHT_FAILED; inspect private receipt if created; no credentials emitted",
  );
  process.exitCode = 1;
});
