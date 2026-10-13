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
  private async request(url: URL): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: "Bearer " + this.accessToken },
        signal: AbortSignal.timeout(8000),
        redirect: "error",
        cache: "no-store",
      });
    } catch {
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google source could not be reached; reconnect or retry the source.",
        {},
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        response.status === 401 || response.status === 403
          ? "Google grant expired, revoked, or insufficient; reconnect the source."
          : "Google source could not be read.",
        { upstream_status: response.status },
        502,
      );
    }
    const maxBytes = 2 * 1024 * 1024;
    const reader = response.body?.getReader();
    if (!reader)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google source returned no data.",
        {},
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
export function normalizeGoogleEvent(
  event: Record<string, unknown>,
  fallbackTimezone = "Europe/Berlin",
) {
  const start = event.start as
      { date?: string; dateTime?: string; timeZone?: string } | undefined,
    end = event.end as typeof start;
  if (!start || !end || event.status === "cancelled") return null;
  const timezone = start.timeZone || fallbackTimezone;
  const starts_at =
    start.dateTime ||
    (start.date
      ? zonedLocalToInstant(start.date + "T00:00", timezone, "earlier")
      : null);
  const ends_at =
    end.dateTime ||
    (end.date
      ? zonedLocalToInstant(end.date + "T00:00", timezone, "earlier")
      : null);
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
  return {
    external_uid: event.id,
    title: typeof event.summary === "string" ? event.summary : "",
    notes: typeof event.description === "string" ? event.description : "",
    starts_at,
    ends_at,
    timezone,
    all_day: !!start.date,
    provider: "google_calendar",
    source_read_only: true,
  };
}
