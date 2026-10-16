import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../shared/contracts";
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  accessToken: vi.fn(),
  ical: vi.fn(),
}));
vi.mock("../../server/auth/db", () => ({
  getAuthPool: () => ({ query: mocks.query }),
}));
vi.mock("../../server/auth/config", () => ({
  getAuth: () => ({ api: { getAccessToken: mocks.accessToken } }),
}));
vi.mock("../../server/integrations/ical-fetch", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../server/integrations/ical-fetch")
  >()),
  fetchIcalFeedConditional: mocks.ical,
}));
import {
  calendarProviderError,
  discoverGoogleCalendars,
  executeGoogleCalendarChange,
  freshCalendarChangeReview,
  expandCalendarSource,
  GOOGLE_CALENDAR_READ_SCOPE,
  GOOGLE_CALENDAR_WRITE_SCOPE,
  syncCalendarSource,
  type CalendarProviderSource,
} from "../../server/integrations/calendar-provider";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-user",
  channel: "MCP",
  scopes: ["calendar:read", "calendar:write"],
};
const source: CalendarProviderSource = {
  source_id: "synthetic-source",
  provider: "google_calendar",
  external_calendar_id: "synthetic@example.invalid",
  title: "Synthetic calendar",
  timezone: "Europe/Berlin",
  writable: true,
};
const event = {
  id: "syntheticevent",
  summary: "Synthetic personal event",
  etag: '"version1"',
  organizer: { self: true },
  start: { dateTime: "2026-10-20T08:00:00Z", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-10-20T09:00:00Z" },
};
let provider: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("OWNER_EMAIL", "synthetic@example.invalid");
  mocks.query.mockReset().mockResolvedValue({
    rows: [
      {
        id: "synthetic-account",
        user_id: principal.actorId,
        scope: GOOGLE_CALENDAR_READ_SCOPE + " " + GOOGLE_CALENDAR_WRITE_SCOPE,
        provider_account_id: "synthetic-subject",
        grant_created_at: "2026-01-01T00:00:00Z",
      },
    ],
  });
  mocks.accessToken.mockReset().mockResolvedValue({
    accessToken: "synthetic-token",
    scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
  });
  mocks.ical.mockReset();
  provider = vi
    .fn()
    .mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : event,
      ),
    );
  vi.stubGlobal("fetch", provider);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("persistent calendar provider network boundary", () => {
  it("discovers owner-only write capabilities and stable grant identities independent of access tokens", async () => {
    provider.mockResolvedValue(
      Response.json({
        items: [
          {
            id: "primary-calendar",
            accessRole: "owner",
            timeZone: "Asia/Tehran",
            primary: true,
          },
          { id: "holiday-calendar", accessRole: "reader" },
        ],
      }),
    );
    const first = await discoverGoogleCalendars(principal);
    expect(first.map((item) => item.writable)).toEqual([true, false]);
    expect(first[0].timezone).toBe("Asia/Tehran");
    mocks.accessToken.mockResolvedValue({
      accessToken: "different-synthetic-token",
      scopes: [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE],
    });
    provider.mockResolvedValue(
      Response.json({
        items: [{ id: "primary-calendar", accessRole: "owner" }],
      }),
    );
    expect(
      (await discoverGoogleCalendars(principal))[0].grant_fingerprint,
    ).toBe(first[0].grant_fingerprint);
    expect(JSON.stringify(first)).not.toContain("synthetic-token");
    expect(mocks.query.mock.calls[0][1]).toEqual([
      "synthetic@example.invalid",
      principal.actorId,
    ]);
  });
  it("stages every page and advances checkpoint only at final page with immutable sync parameters", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.searchParams.has("pageToken")
          ? {
              items: [
                {
                  ...event,
                  id: "syntheticexception",
                  status: "cancelled",
                  recurringEventId: event.id,
                  originalStartTime: event.start,
                },
              ],
              nextSyncToken: "final-checkpoint",
              timeZone: "Asia/Tehran",
            }
          : {
              items: [event, { id: "deleted", status: "cancelled" }],
              nextPageToken: "second-page",
            },
      ),
    );
    const result = await syncCalendarSource(principal, {
      ...source,
      checkpoint: { sync_token: "previous-checkpoint" },
    });
    expect(result).toMatchObject({
      replace: false,
      complete: true,
      checkpoint: { sync_token: "final-checkpoint" },
      timezone: "Asia/Tehran",
      deleted_ids: ["deleted"],
    });
    expect(result.events).toHaveLength(2);
    for (const [url] of provider.mock.calls) {
      expect(url.searchParams.get("singleEvents")).toBe("false");
      expect(url.searchParams.get("showDeleted")).toBe("true");
      expect(url.searchParams.get("syncToken")).toBe("previous-checkpoint");
      expect(
        url.searchParams.has("timeMin") ||
          url.searchParams.has("timeMax") ||
          url.searchParams.has("orderBy"),
      ).toBe(false);
    }
  });
  it("410 returns a complete replacement only after a successful fresh full sync", async () => {
    provider.mockImplementation(async (url: URL) =>
      url.searchParams.has("syncToken")
        ? new Response("", { status: 410 })
        : Response.json({ items: [event], nextSyncToken: "fresh" }),
    );
    expect(
      await syncCalendarSource(principal, {
        ...source,
        checkpoint: { sync_token: "expired" },
      }),
    ).toMatchObject({ replace: true, checkpoint: { sync_token: "fresh" } });
    expect(provider).toHaveBeenCalledTimes(2);
  });
  it("a later page failure cannot return a partial successful checkpoint or private error", async () => {
    provider.mockImplementation(async (url: URL) =>
      url.searchParams.has("pageToken")
        ? new Response("private-provider-body", { status: 503 })
        : Response.json({
            items: [event],
            nextSyncToken: "premature",
            nextPageToken: "next",
          }),
    );
    await expect(syncCalendarSource(principal, source)).rejects.toMatchObject({
      details: { upstream_status: 503 },
    });
    const failure = await syncCalendarSource(principal, source).catch(
      calendarProviderError,
    );
    expect(JSON.stringify(failure)).not.toContain("private-provider-body");
  });
  it("classifies 403 quota as retryable and respects Retry-After without treating it as grant revocation", async () => {
    provider.mockResolvedValue(
      Response.json(
        { error: { errors: [{ reason: "rateLimitExceeded" }] } },
        { status: 403, headers: { "Retry-After": "600" } },
      ),
    );
    const failure = await syncCalendarSource(principal, source).catch(
      calendarProviderError,
    );
    expect(failure).toEqual({
      code: "SOURCE_RATE_LIMITED",
      revoked: false,
      retry_after_seconds: 600,
    });
  });
  it.each(["accessNotConfigured", "serviceDisabled", "SERVICE_DISABLED"])(
    "classifies API-disabled reason %s as configuration, retaining last-good source access",
    async (reason) => {
      provider.mockResolvedValue(
        Response.json({ error: { errors: [{ reason }] } }, { status: 403 }),
      );
      expect(
        await syncCalendarSource(principal, source).catch(
          calendarProviderError,
        ),
      ).toMatchObject({
        code: "GOOGLE_CALENDAR_API_NOT_ENABLED",
        revoked: false,
      });
    },
  );
  it("recognizes the modern Google ErrorInfo service-disabled reason", async () => {
    provider.mockResolvedValue(
      Response.json(
        {
          error: {
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                reason: "SERVICE_DISABLED",
              },
            ],
          },
        },
        { status: 403 },
      ),
    );
    expect(
      await syncCalendarSource(principal, source).catch(calendarProviderError),
    ).toMatchObject({
      code: "GOOGLE_CALENDAR_API_NOT_ENABLED",
      revoked: false,
    });
  });
  it("conditionally reuses a private iCal feed without any Google token call", async () => {
    const text = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n";
    mocks.ical.mockResolvedValue({ notModified: true, etag: '"same"' });
    const result = await syncCalendarSource(principal, {
      ...source,
      provider: "ical",
      config: {
        url: "https://feeds.example.invalid/private-key",
        allowed_hosts: ["feeds.example.invalid"],
      },
      checkpoint: { etag: '"same"', feed_text: text },
    });
    expect(result.events[0].raw.feed_text).toBe(text);
    expect(mocks.ical.mock.calls[0][1].etag).toBe('"same"');
    expect(mocks.accessToken).not.toHaveBeenCalled();
  });
  it("does not mistake a generic token refresh outage for proven grant revocation", async () => {
    mocks.accessToken.mockRejectedValue({
      status: "BAD_REQUEST",
      body: { code: "FAILED_TO_GET_ACCESS_TOKEN" },
    });
    expect(
      await syncCalendarSource(principal, source).catch(calendarProviderError),
    ).toMatchObject({ revoked: false, code: "SOURCE_READ_FAILED" });
    mocks.accessToken.mockRejectedValue({
      statusCode: 401,
      body: { code: "INVALID_GRANT" },
    });
    expect(
      await syncCalendarSource(principal, source).catch(calendarProviderError),
    ).toMatchObject({ revoked: true });
  });
});
describe("bounded cached master and exception expansion", () => {
  it("expands a forever series only within the requested range, with moved and cancelled exceptions", () => {
    const master = {
      ...event,
      id: "series",
      start: { dateTime: "2026-10-18T08:00:00Z", timeZone: "Europe/Berlin" },
      end: { dateTime: "2026-10-18T09:00:00Z" },
      recurrence: ["RRULE:FREQ=DAILY"],
    };
    const moved = {
      ...event,
      id: "series_20261020T080000Z",
      recurringEventId: "series",
      originalStartTime: { dateTime: "2026-10-20T08:00:00Z" },
      start: { dateTime: "2026-10-20T10:00:00Z" },
      end: { dateTime: "2026-10-20T11:00:00Z" },
    };
    const cancelled = {
      id: "series_20261021T080000Z",
      recurringEventId: "series",
      originalStartTime: { dateTime: "2026-10-21T08:00:00Z" },
      status: "cancelled",
    };
    const expanded = expandCalendarSource(
      source,
      [master, moved, cancelled].map((raw) => ({ external_id: raw.id, raw })),
      "2026-10-19T00:00:00Z",
      "2026-10-23T00:00:00Z",
    );
    expect(expanded).toHaveLength(3);
    expect(expanded.map((item) => item.starts_at)).toEqual([
      "2026-10-19T08:00:00.000Z",
      "2026-10-20T10:00:00.000Z",
      "2026-10-22T08:00:00.000Z",
    ]);
    expect(expanded[1].original_occurrence_starts_at).toBe(
      "2026-10-20T08:00:00.000Z",
    );
    expect(expanded[1].external_id).toBe(moved.id);
  });
  it("keeps local recurrence time across DST with EXDATE/RDATE and all-day source timezone", () => {
    const raw = {
      ...event,
      id: "dayseries",
      start: { date: "2026-10-24" },
      end: { date: "2026-10-25" },
      recurrence: [
        "RRULE:FREQ=DAILY;COUNT=4",
        "EXDATE;VALUE=DATE:20261025",
        "RDATE;VALUE=DATE:20261029",
      ],
    };
    const expanded = expandCalendarSource(
      source,
      [{ external_id: raw.id, raw }],
      "2026-10-23T00:00Z",
      "2026-10-30T00:00Z",
    );
    expect(expanded.map((item) => instantDate(item.starts_at))).toEqual([
      "2026-10-23",
      "2026-10-25",
      "2026-10-26",
      "2026-10-28",
    ]);
    const tehran = expandCalendarSource(
      { ...source, timezone: "Asia/Tehran" },
      [
        {
          external_id: "day",
          raw: {
            ...event,
            start: { date: "2026-10-20" },
            end: { date: "2026-10-21" },
          },
        },
      ],
      "2026-10-19T00:00Z",
      "2026-10-22T00:00Z",
    )[0];
    expect(tehran.starts_at).toBe("2026-10-19T20:30:00.000Z");
  });
  it("shows free/self-declined events without busy conflicts and only valid Google original links", () => {
    const raw = {
      ...event,
      transparency: "transparent",
      attendees: [{ self: true, responseStatus: "declined" }],
      htmlLink: "javascript:alert(1)",
    };
    expect(
      expandCalendarSource(
        source,
        [{ external_id: event.id, raw }],
        "2026-10-01T00:00Z",
        "2026-11-01T00:00Z",
      )[0],
    ).toMatchObject({
      busy: false,
      self_declined: true,
      external_url: undefined,
    });
  });
  it("preserves explicit later-fold offsets for single events and moved recurring instances", () => {
    const later = {
      ...event,
      start: {
        dateTime: "2026-10-25T02:15:00+01:00",
        timeZone: "Europe/Berlin",
      },
      end: { dateTime: "2026-10-25T02:45:00+01:00" },
    };
    const single = expandCalendarSource(
      source,
      [{ external_id: later.id, raw: later }],
      "2026-10-24T00:00Z",
      "2026-10-26T00:00Z",
    )[0];
    expect(Date.parse(single.starts_at)).toBe(
      Date.parse("2026-10-25T01:15:00Z"),
    );
    expect(Date.parse(single.ends_at) - Date.parse(single.starts_at)).toBe(
      30 * 60000,
    );
    const master = {
        ...event,
        id: "series",
        start: { dateTime: "2026-10-24T08:00:00Z", timeZone: "Europe/Berlin" },
        end: { dateTime: "2026-10-24T09:00:00Z" },
        recurrence: ["RRULE:FREQ=DAILY;COUNT=2"],
      },
      moved = {
        ...later,
        id: "series_20261025T090000Z",
        recurringEventId: "series",
        originalStartTime: { dateTime: "2026-10-25T09:00:00Z" },
      };
    const occurrences = expandCalendarSource(
      source,
      [master, moved].map((raw) => ({ external_id: raw.id, raw })),
      "2026-10-24T00:00Z",
      "2026-10-26T00:00Z",
    );
    expect(Date.parse(occurrences[1].starts_at)).toBe(
      Date.parse("2026-10-25T01:15:00Z"),
    );
    const laterHourOnly = expandCalendarSource(
      source,
      [master, moved].map((raw) => ({ external_id: raw.id, raw })),
      "2026-10-25T01:00:00Z",
      "2026-10-25T02:00:00Z",
    );
    expect(laterHourOnly).toHaveLength(1);
    expect(Date.parse(laterHourOnly[0].starts_at)).toBe(
      Date.parse("2026-10-25T01:15:00Z"),
    );
  });
  it("includes an exception moved into the range from a later original occurrence", () => {
    const master = { ...event, id: "series", recurrence: ["RRULE:FREQ=DAILY"] };
    const moved = {
      ...event,
      id: "series_20261120T090000Z",
      recurringEventId: "series",
      originalStartTime: { dateTime: "2026-11-20T09:00:00Z" },
      start: { dateTime: "2026-10-21T10:00:00Z" },
      end: { dateTime: "2026-10-21T11:00:00Z" },
    };
    const expanded = expandCalendarSource(
      source,
      [master, moved].map((raw) => ({ external_id: raw.id, raw })),
      "2026-10-21T00:00Z",
      "2026-10-22T00:00Z",
    );
    expect(expanded).toHaveLength(2);
    expect(
      expanded.find((item) => item.external_id === moved.id)
        ?.original_occurrence_starts_at,
    ).toBe("2026-11-20T09:00:00.000Z");
  });
  it("uses a recurring event's own timezone for both ends and exception identities", () => {
    const master = {
      ...event,
      id: "tehran-series",
      start: { dateTime: "2026-10-24T06:30:00Z", timeZone: "Asia/Tehran" },
      end: { dateTime: "2026-10-24T07:30:00Z" },
      recurrence: ["RRULE:FREQ=DAILY;COUNT=3"],
    };
    const moved = {
      ...event,
      id: "tehran-series_20261025T063000Z",
      recurringEventId: master.id,
      originalStartTime: { dateTime: "2026-10-25T06:30:00Z" },
      start: { dateTime: "2026-10-25T08:00:00Z" },
      end: { dateTime: "2026-10-25T09:00:00Z" },
    };
    const expanded = expandCalendarSource(
      source,
      [master, moved].map((raw) => ({ external_id: raw.id, raw })),
      "2026-10-24T00:00Z",
      "2026-10-27T00:00Z",
    );
    expect(expanded.map((item) => item.starts_at)).toEqual([
      "2026-10-24T06:30:00.000Z",
      "2026-10-25T08:00:00.000Z",
      "2026-10-26T06:30:00.000Z",
    ]);
    expect(
      Date.parse(expanded[0].ends_at) - Date.parse(expanded[0].starts_at),
    ).toBe(3600000);
  });
});
function instantDate(value: string) {
  return value.slice(0, 10);
}
describe("personal Google change safety and reconciliation", () => {
  const payload = {
    title: "Synthetic updated",
    starts_at: "2026-10-20T08:00:00Z",
    ends_at: "2026-10-20T09:00:00Z",
    timezone: "Europe/Berlin",
    all_day: false,
  };
  it("re-reads current event, preserves existing fields and uses If-Match with no invitations", async () => {
    provider.mockImplementation(async (url: URL, init: RequestInit) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : init.method === "PUT"
            ? { ...event, etag: '"version2"' }
            : { ...event, location: "Synthetic location" },
      ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-op",
        action: "update",
        event_id: event.id,
        etag: event.etag,
        payload,
      }),
    ).toMatchObject({ status: "confirmed", etag: '"version2"' });
    const [url, init] = provider.mock.calls.find(
      ([, init]) => init.method === "PUT",
    )!;
    expect(init.headers["If-Match"]).toBe(event.etag);
    expect(url.searchParams.get("sendUpdates")).toBe("none");
    expect(JSON.parse(init.body)).toMatchObject({
      location: "Synthetic location",
      summary: payload.title,
    });
  });
  it.each([
    { attendees: [{ email: "guest@example.invalid" }] },
    { attendeesOmitted: true },
    { organizer: { self: false } },
    { eventType: "outOfOffice" },
    { locked: true },
  ])(
    "rejects invited/special/locked or incomplete attendee data before any write: %j",
    async (unsafe) => {
      provider.mockImplementation(async (url: URL) =>
        Response.json(
          url.pathname.includes("calendarList/")
            ? { accessRole: "owner" }
            : { ...event, ...unsafe },
        ),
      );
      expect(
        await executeGoogleCalendarChange(principal, source, {
          operation_id: "synthetic-op",
          action: "delete",
          event_id: event.id,
          etag: event.etag,
          payload: {},
        }),
      ).toMatchObject({ status: "error", error: "PERSONAL_EVENTS_ONLY" });
      expect(provider.mock.calls.every(([, init]) => !init.method)).toBe(true);
    },
  );
  it("rejects stale ETags and provider 412 without overwriting", async () => {
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-op",
        action: "update",
        event_id: event.id,
        etag: '"stale"',
        payload,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
    provider.mockImplementation(async (url: URL, init: RequestInit) =>
      init.method
        ? new Response("", { status: 412 })
        : Response.json(
            url.pathname.includes("calendarList/")
              ? { accessRole: "owner" }
              : event,
          ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-op",
        action: "update",
        event_id: event.id,
        etag: event.etag,
        payload,
      }),
    ).toMatchObject({ status: "conflict" });
  });
  it("reconciles an uncertain create with the same stable ID and performs no second POST", async () => {
    let accepted: Record<string, unknown> | null = null;
    provider.mockImplementation(async (url: URL, init: RequestInit) => {
      if (url.pathname.includes("calendarList/"))
        return Response.json({ accessRole: "owner" });
      if (init.method === "POST") {
        accepted = {
          ...JSON.parse(String(init.body)),
          organizer: { self: true },
          etag: '"created"',
        };
        throw new Error("synthetic connection lost after accept");
      }
      return accepted
        ? Response.json(accepted)
        : new Response("", { status: 404 });
    });
    const intent = {
      operation_id: "synthetic-create",
      action: "create" as const,
      event_id: "abcde12345",
      payload,
    };
    expect(
      await executeGoogleCalendarChange(principal, source, intent),
    ).toMatchObject({ status: "uncertain", external_id: "abcde12345" });
    expect(
      await executeGoogleCalendarChange(principal, source, intent),
    ).toMatchObject({ status: "confirmed", external_id: "abcde12345" });
    expect(
      provider.mock.calls.filter(([, init]) => init.method === "POST"),
    ).toHaveLength(1);
  });
  it("checks a recurring master before writing an unmodified instance using fresh instance ETag", async () => {
    provider.mockImplementation(async (url: URL, init: RequestInit) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : url.pathname.endsWith("/series")
            ? { ...event, id: "series", etag: '"master"' }
            : init.method
              ? { ...event, etag: '"updated"' }
              : { ...event, recurringEventId: "series", etag: '"instance"' },
      ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-instance",
        action: "update",
        event_id: "series_20261020T080000Z",
        etag: '"instance"',
        master_event_id: "series",
        expected_master_etag: '"master"',
        recurrence_scope: "instance",
        payload,
      }),
    ).toMatchObject({ status: "confirmed" });
    expect(
      provider.mock.calls.find(([, init]) => init.method === "PUT")![1].headers[
        "If-Match"
      ],
    ).toBe('"instance"');
  });
  it("does not overwrite a changed exception even if its master ETag still matches", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : url.pathname.endsWith("/series")
            ? { ...event, id: "series", etag: '"master"' }
            : { ...event, recurringEventId: "series", etag: '"new-instance"' },
      ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-instance",
        action: "update",
        event_id: "series_20261020T080000Z",
        etag: '"old-instance"',
        master_event_id: "series",
        expected_master_etag: '"master"',
        payload,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it("requires the previewed instance ETag even for a generated recurring instance with a pinned master", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : url.pathname.endsWith("/series")
            ? { ...event, id: "series", etag: '"master"' }
            : { ...event, recurringEventId: "series", etag: '"new-exception"' },
      ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-unreviewed-instance",
        action: "update",
        event_id: "series_20261020T080000Z",
        master_event_id: "series",
        expected_master_etag: '"master"',
        payload,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it("pins a remote generated occurrence at preview and rejects an exception created after review", async () => {
    let currentEtag = '"reviewed-instance"';
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : url.pathname.endsWith("/series")
            ? { ...event, id: "series", etag: '"master"' }
            : {
                ...event,
                id: "series_20261020T080000Z",
                recurringEventId: "series",
                etag: currentEtag,
              },
      ),
    );
    const review = await freshCalendarChangeReview(principal, source, {
      event_id: "series_20261020T080000Z",
      expected_master_etag: '"master"',
    });
    expect(review).toMatchObject({
      event_id: "series_20261020T080000Z",
      etag: '"reviewed-instance"',
      master_event_id: "series",
      expected_master_etag: '"master"',
    });
    currentEtag = '"new-exception"';
    expect(
      await executeGoogleCalendarChange(principal, source, {
        ...review,
        operation_id: "synthetic-reviewed-instance",
        action: "update",
        payload,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it("fresh personal review pins the master for whole-series changes and rejects stale cached revisions", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : url.pathname.endsWith("/series")
            ? { ...event, id: "series", etag: '"master"' }
            : { ...event, recurringEventId: "series", etag: '"instance"' },
      ),
    );
    expect(
      await freshCalendarChangeReview(principal, source, {
        event_id: "series_20261020T080000Z",
        recurrence_scope: "series",
        expected_master_etag: '"master"',
      }),
    ).toMatchObject({ event_id: "series", etag: '"master"' });
    await expect(
      freshCalendarChangeReview(principal, source, {
        event_id: "series_20261020T080000Z",
        expected_instance_etag: '"stale-instance"',
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT", status: 409 });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it("does not interpret a master ID with instance scope as permission to change the entire series", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : { ...event, recurrence: ["RRULE:FREQ=DAILY"] },
      ),
    );
    await expect(
      freshCalendarChangeReview(principal, source, {
        event_id: event.id,
        recurrence_scope: "instance",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-scope-guard",
        action: "update",
        event_id: event.id,
        etag: event.etag,
        recurrence_scope: "instance",
        payload,
      }),
    ).toMatchObject({
      status: "error",
      error: "RECURRING_INSTANCE_ID_REQUIRED",
    });
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it.each([429, 403])(
    "keeps an outgoing Google %s rate limit durably retryable using the same operation",
    async (rateStatus) => {
      let postCount = 0,
        acceptedCount = 0;
      provider.mockImplementation(async (url: URL, init: RequestInit) => {
        if (url.pathname.includes("calendarList/"))
          return Response.json({ accessRole: "owner" });
        if (init.method === "POST") {
          postCount++;
          if (postCount === 1)
            return Response.json(
              { error: { errors: [{ reason: "rateLimitExceeded" }] } },
              { status: rateStatus, headers: { "Retry-After": "600" } },
            );
          acceptedCount++;
          return Response.json({
            ...JSON.parse(String(init.body)),
            organizer: { self: true },
            etag: '"created"',
          });
        }
        return new Response("", { status: 404 });
      });
      const intent = {
        operation_id: "synthetic-rate-limited-create",
        action: "create" as const,
        event_id: "abcde12345",
        payload,
      };
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({
        status: "uncertain",
        error: "SOURCE_RATE_LIMITED",
        retry_after_seconds: 600,
      });
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({ status: "confirmed", external_id: "abcde12345" });
      expect(acceptedCount).toBe(1);
      expect(postCount).toBe(2);
    },
  );
  it.each([408, 500, 502, 503, 504])(
    "retries the same create after a pre-dispatch Google GET %s without a second preview or duplicate",
    async (upstreamStatus) => {
      let failed = false,
        accepted = 0;
      provider.mockImplementation(async (url: URL, init: RequestInit) => {
        if (!failed) {
          failed = true;
          return new Response("", { status: upstreamStatus });
        }
        if (url.pathname.includes("calendarList/"))
          return Response.json({ accessRole: "owner" });
        if (init.method === "POST") {
          accepted++;
          return Response.json({
            ...JSON.parse(String(init.body)),
            organizer: { self: true },
            etag: '"created"',
          });
        }
        return new Response("", { status: 404 });
      });
      const intent = {
        operation_id: "synthetic-preflight-outage",
        action: "create" as const,
        event_id: "abcde12345",
        payload,
      };
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({ status: "uncertain", retry_after_seconds: 300 });
      expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({ status: "confirmed", external_id: intent.event_id });
      expect(accepted).toBe(1);
    },
  );
  it.each(["transport", "token-refresh"])(
    "retains an outgoing intent after a transient preflight %s outage",
    async (kind) => {
      let failed = false,
        accepted = 0;
      if (kind === "token-refresh")
        mocks.accessToken.mockRejectedValueOnce({
          status: "BAD_REQUEST",
          body: { code: "FAILED_TO_GET_ACCESS_TOKEN" },
        });
      provider.mockImplementation(async (url: URL, init: RequestInit) => {
        if (kind === "transport" && !failed) {
          failed = true;
          throw new Error("Synthetic network timeout");
        }
        if (url.pathname.includes("calendarList/"))
          return Response.json({ accessRole: "owner" });
        if (init.method === "POST") {
          accepted++;
          return Response.json({
            ...JSON.parse(String(init.body)),
            organizer: { self: true },
            etag: '"created"',
          });
        }
        return new Response("", { status: 404 });
      });
      const intent = {
        operation_id: "synthetic-transient-create",
        action: "create" as const,
        event_id: "abcde12345",
        payload,
      };
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({ status: "uncertain", retry_after_seconds: 300 });
      expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
      expect(
        await executeGoogleCalendarChange(principal, source, intent),
      ).toMatchObject({ status: "confirmed" });
      expect(accepted).toBe(1);
    },
  );
  it("keeps invalid input terminal and grant revocation suppressed without making a mutation request", async () => {
    const invalid = await executeGoogleCalendarChange(principal, source, {
      operation_id: "synthetic-invalid-event",
      action: "update",
      event_id: event.id,
      etag: event.etag,
      payload: { ...payload, starts_at: "invalid" },
    });
    expect(invalid).toMatchObject({ status: "error" });
    expect(invalid.retry_after_seconds).toBeUndefined();
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
    provider.mockResolvedValue(new Response("", { status: 401 }));
    const revoked = await executeGoogleCalendarChange(principal, source, {
      operation_id: "synthetic-revoked-event",
      action: "delete",
      event_id: event.id,
      etag: event.etag,
      payload: {},
    });
    expect(revoked.status).toBe("revoked");
    expect(revoked.retry_after_seconds).toBeUndefined();
    expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
  });
  it.each(["delete", "update"] as const)(
    "reconciles a cancelled Google tombstone before personal guards for %s",
    async (action) => {
      provider.mockImplementation(async (url: URL) =>
        Response.json(
          url.pathname.includes("calendarList/")
            ? { accessRole: "owner" }
            : { id: event.id, status: "cancelled" },
        ),
      );
      const result = await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-cancelled-retry",
        action,
        event_id: event.id,
        etag: event.etag,
        payload: action === "delete" ? {} : payload,
      });
      expect(result).toMatchObject(
        action === "delete"
          ? { status: "confirmed", external_id: event.id }
          : {
              status: "conflict",
              error: "EVENT_REMOVED",
              external_id: event.id,
            },
      );
      expect(provider.mock.calls.some(([, init]) => init.method)).toBe(false);
    },
  );
  it("retains EXDATE/RDATE when a whole-series RRULE is edited", async () => {
    const master = {
      ...event,
      recurrence: [
        "RRULE:FREQ=DAILY",
        "EXDATE:20261021T080000Z",
        "RDATE:20261023T080000Z",
      ],
    };
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.includes("calendarList/")
          ? { accessRole: "owner" }
          : master,
      ),
    );
    expect(
      await executeGoogleCalendarChange(principal, source, {
        operation_id: "synthetic-series",
        action: "update",
        event_id: event.id,
        etag: event.etag,
        recurrence_scope: "series",
        payload: { ...payload, recurrence_rule: "FREQ=WEEKLY" },
      }),
    ).toMatchObject({ status: "confirmed" });
    expect(
      JSON.parse(
        provider.mock.calls.find(([, init]) => init.method === "PUT")![1].body,
      ).recurrence,
    ).toEqual([
      "RRULE:FREQ=WEEKLY",
      "EXDATE:20261021T080000Z",
      "RDATE:20261023T080000Z",
    ]);
  });
});
