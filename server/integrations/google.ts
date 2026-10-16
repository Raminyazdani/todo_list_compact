import { DomainError } from "../../shared/contracts";
import { zonedLocalToInstant } from "../../shared/datetime";
export function googleConnectionCapabilities() {
  return {
    oauth_client_configured:
      !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    connected: false,
    mode: "disconnected",
    source_sheet_writes: false,
    drive_original_moves: false,
    calendar_writes: false,
    explanation:
      "Connector access in the build chat does not grant the deployed app a Google OAuth session.",
  };
}
function stableId(id: string) {
  if (!/^[-_A-Za-z0-9]{1,200}$/.test(id))
    throw new DomainError(
      "INVALID_INPUT",
      "Invalid Google resource identifier.",
    );
  return encodeURIComponent(id);
}
/** Scoped read-only Google adapter. Tokens supplied by the owner's encrypted OAuth grant. */
export class GoogleReadClient {
  constructor(private readonly accessToken: string) {
    if (!accessToken)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google OAuth is disconnected.",
        {},
        503,
      );
  }
  protected async request(
    url: URL,
    options: {
      method?: string;
      body?: Record<string, unknown>;
      etag?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers: {
          Authorization: "Bearer " + this.accessToken,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.etag ? { "If-Match": options.etag } : {}),
        },
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google source could not be reached; reconnect or retry the source.",
        { outcome_unknown: !!options.method && options.method !== "GET" },
        503,
      );
    }
    if (!response.ok) {
      // Never retain the provider error text (it can include private identifiers).
      let reason = "";
      const errorReader = response.body?.getReader();
      if (errorReader) {
        try {
          const errorChunks: Uint8Array[] = [];
          let errorBytes = 0;
          while (errorBytes <= 16384) {
            const chunk = await errorReader.read();
            if (chunk.done) break;
            errorBytes += chunk.value.byteLength;
            if (errorBytes <= 16384) errorChunks.push(chunk.value);
          }
          if (errorBytes > 0 && errorBytes <= 16384) {
            const error = JSON.parse(
              Buffer.concat(errorChunks).toString("utf8"),
            );
            reason = String(
              error?.error?.errors?.[0]?.reason ??
                error?.error?.details?.find(
                  (detail: { reason?: string }) => detail?.reason,
                )?.reason ??
                "",
            );
          }
        } catch {
          /* Provider details are intentionally discarded. */
        } finally {
          await errorReader.cancel().catch(() => {});
          errorReader.releaseLock();
        }
      }
      const retryAfter = response.headers.get("retry-after");
      const retrySeconds = retryAfter
        ? /^\d+$/.test(retryAfter)
          ? Number(retryAfter)
          : Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000))
        : undefined;
      const configurationError = [
        "accessNotConfigured",
        "serviceDisabled",
        "SERVICE_DISABLED",
        "apiNotActivated",
        "API_NOT_ACTIVATED",
      ].includes(reason);
      const rateLimited =
        response.status === 429 ||
        [
          "rateLimitExceeded",
          "userRateLimitExceeded",
          "quotaExceeded",
        ].includes(reason);
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        configurationError
          ? "The requested Google API is disabled for this OAuth project; enable it in Google Cloud."
          : rateLimited
            ? "Google source is rate limited; retry after the indicated delay."
            : response.status === 401 || response.status === 403
              ? "Google grant expired, revoked, or insufficient; reconnect the source."
              : "Google source could not be read.",
        {
          upstream_status: response.status,
          configuration_error: configurationError,
          rate_limited: rateLimited,
          ...(Number.isFinite(retrySeconds)
            ? { retry_after_seconds: Math.min(86400, retrySeconds!) }
            : {}),
        },
        502,
      );
    }
    if (response.status === 204) return {};
    const maxBytes = 2 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google source returned no data.",
        { outcome_unknown: !!options.method && options.method !== "GET" },
        502,
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error("SOURCE_TOO_LARGE");
        }
        chunks.push(part.value);
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("INVALID_SOURCE");
      return value as Record<string, unknown>;
    } catch {
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google source returned invalid or excessive data; narrow the range and retry.",
        {},
        502,
      );
    } finally {
      reader.releaseLock();
    }
  }
  private async read(
    path: string,
    parameters: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const url = new URL(
      path.startsWith("sheets/v4/")
        ? "https://sheets.googleapis.com/v4/" + path.slice("sheets/v4/".length)
        : "https://www.googleapis.com/" + path,
    );
    for (const [name, value] of Object.entries(parameters))
      url.searchParams.set(name, value);
    return this.request(url);
  }
  fileMetadata(id: string) {
    return this.read("drive/v3/files/" + stableId(id), {
      fields:
        "id,name,mimeType,size,parents,webViewLink,modifiedTime,version,sha256Checksum,trashed",
    });
  }
  spreadsheetMetadata(id: string) {
    return this.read("sheets/v4/spreadsheets/" + stableId(id), {
      fields:
        "spreadsheetId,spreadsheetUrl,properties,sheets(properties,tables)",
    });
  }
  async spreadsheetValues(id: string, ranges: string[]) {
    if (
      ranges.length < 1 ||
      ranges.length > 30 ||
      ranges.some(
        (range) =>
          !/^[A-Za-z][A-Za-z0-9 _-]*![A-Z]{1,3}\d+:[A-Z]{1,3}\d+$/.test(range),
      )
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Bounded verified source sheet ranges are required.",
      );
    const url = new URL(
      "https://sheets.googleapis.com/v4/spreadsheets/" +
        stableId(id) +
        "/values:batchGet",
    );
    url.searchParams.set("valueRenderOption", "UNFORMATTED_VALUE");
    url.searchParams.set("dateTimeRenderOption", "SERIAL_NUMBER");
    ranges.forEach((range) => url.searchParams.append("ranges", range));
    return this.request(url) as Promise<{
      spreadsheetId: string;
      valueRanges: Array<{ range: string; values: unknown[][] }>;
    }>;
  }
  listCalendars(pageToken?: string) {
    return this.read("calendar/v3/users/me/calendarList", {
      maxResults: "100",
      ...(pageToken ? { pageToken } : {}),
    });
  }
  async calendarEvents(
    calendarId: string,
    from: string,
    to: string,
    pageToken?: string,
  ) {
    if (
      !Number.isFinite(Date.parse(from)) ||
      !Number.isFinite(Date.parse(to)) ||
      Date.parse(to) <= Date.parse(from) ||
      Date.parse(to) - Date.parse(from) > 366 * 86400000
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Calendar range must not exceed one year.",
      );
    if (!calendarId || calendarId.length > 512)
      throw new DomainError("INVALID_INPUT", "Invalid calendar identifier.");
    return this.read(
      "calendar/v3/calendars/" + encodeURIComponent(calendarId) + "/events",
      {
        timeMin: from,
        timeMax: to,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
        ...(pageToken ? { pageToken } : {}),
      },
    );
  }
}
/** Calendar writes are deliberately limited to personal events by the provider dispatcher. */
export class GoogleCalendarClient extends GoogleReadClient {
  calendar(id: string) {
    return this.request(
      new URL(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList/" +
          encodeURIComponent(id),
      ),
    );
  }
  syncEvents(calendarId: string, syncToken?: string, pageToken?: string) {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(calendarId) +
        "/events",
    );
    // These parameters are identical for initial and incremental sync. In particular,
    // a moving timeMin/timeMax/orderBy must never be combined with a sync token.
    url.searchParams.set("singleEvents", "false");
    url.searchParams.set("showDeleted", "true");
    url.searchParams.set("maxResults", "1000");
    if (syncToken) url.searchParams.set("syncToken", syncToken);
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return this.request(url);
  }
  event(calendarId: string, eventId: string) {
    return this.request(
      new URL(
        "https://www.googleapis.com/calendar/v3/calendars/" +
          encodeURIComponent(calendarId) +
          "/events/" +
          encodeURIComponent(eventId),
      ),
    );
  }
  change(
    calendarId: string,
    eventId: string | null,
    method: "POST" | "PUT" | "DELETE",
    body?: Record<string, unknown>,
    etag?: string,
  ) {
    const url = new URL(
      "https://www.googleapis.com/calendar/v3/calendars/" +
        encodeURIComponent(calendarId) +
        "/events" +
        (eventId ? "/" + encodeURIComponent(eventId) : ""),
    );
    url.searchParams.set("sendUpdates", "none");
    return this.request(url, { method, body, etag });
  }
}
export function normalizeGoogleEvent(
  event: Record<string, unknown>,
  fallbackTimezone = "Europe/Berlin",
) {
  const start = event.start as
      { date?: string; dateTime?: string; timeZone?: string } | undefined,
    end = event.end as typeof start;
  if (!start || !end || event.status === "cancelled") return null;
  const timezone = start.timeZone || fallbackTimezone;
  const resolveTime = (time: NonNullable<typeof start>) => {
    try {
      if (time.dateTime)
        return /(?:Z|[+-]\d{2}:\d{2})$/.test(time.dateTime)
          ? time.dateTime
          : zonedLocalToInstant(
              time.dateTime,
              time.timeZone || timezone,
              "earlier",
            );
      return time.date
        ? zonedLocalToInstant(
            time.date + "T00:00",
            time.timeZone || timezone,
            "earlier",
          )
        : null;
    } catch {
      return null;
    }
  };
  const starts_at = resolveTime(start);
  const ends_at = resolveTime(end);
  if (
    !starts_at ||
    !ends_at ||
    !Number.isFinite(Date.parse(starts_at)) ||
    !Number.isFinite(Date.parse(ends_at)) ||
    Date.parse(ends_at) <= Date.parse(starts_at)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Google event has invalid time bounds.",
    );
  const attendees = Array.isArray(event.attendees)
    ? (event.attendees as Record<string, unknown>[])
    : [];
  const selfDeclined = attendees.some(
    (attendee) =>
      attendee.self === true && attendee.responseStatus === "declined",
  );
  let originalUrl: string | null = null;
  if (typeof event.htmlLink === "string") {
    try {
      const url = new URL(event.htmlLink);
      if (
        url.protocol === "https:" &&
        ["calendar.google.com", "www.google.com"].includes(url.hostname) &&
        !url.username &&
        !url.password
      )
        originalUrl = url.toString();
    } catch {
      /* A malformed provider link is never rendered. */
    }
  }
  return {
    external_uid: event.id,
    title: typeof event.summary === "string" ? event.summary : "",
    notes: typeof event.description === "string" ? event.description : "",
    starts_at: new Date(starts_at).toISOString(),
    ends_at: new Date(ends_at).toISOString(),
    timezone,
    all_day: !!start.date,
    provider: "google_calendar",
    source_read_only: true,
    busy: event.transparency !== "transparent" && !selfDeclined,
    transparency:
      event.transparency === "transparent" ? "transparent" : "opaque",
    self_declined: selfDeclined,
    original_url: originalUrl,
    provider_etag: typeof event.etag === "string" ? event.etag : null,
    recurring_event_id:
      typeof event.recurringEventId === "string"
        ? event.recurringEventId
        : null,
    original_start: event.originalStartTime ?? null,
  };
}
