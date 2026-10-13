import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "../../shared/contracts";
import { DomainError } from "../../shared/contracts";
import { PGlite } from "@electric-sql/pglite";
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
vi.mock("../../server/integrations/ical-fetch", () => ({
  fetchIcalFeed: mocks.ical,
}));
import {
  externalCalendarEvents,
  externalCalendarList,
  externalCalendarStatus,
} from "../../server/integrations/calendar-runtime";
const readScope = "https://www.googleapis.com/auth/calendar.readonly";
const principal: Principal = {
  ownerId: "synthetic-owner",
  actorId: "synthetic-user",
  channel: "UI",
  scopes: ["admin:manage"],
};
let provider: ReturnType<typeof vi.fn>;
const event = {
  id: "synthetic-same-uid",
  summary: "Synthetic event",
  start: { dateTime: "2026-03-29T08:00:00Z", timeZone: "Europe/Berlin" },
  end: { dateTime: "2026-03-29T09:00:00Z" },
};
beforeEach(() => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
  vi.stubEnv("OWNER_EMAIL", "SYNTHETIC-OWNER@example.invalid");
  vi.stubEnv("GOOGLE_ICAL_URL", "");
  vi.stubEnv("GOOGLE_ICAL_ALLOWED_HOSTS", "");
  mocks.query.mockReset().mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM account")
      ? [
          {
            id: "synthetic-google-account",
            user_id: "synthetic-user",
            scope: readScope,
          },
        ]
      : [],
    rowCount: 1,
  }));
  mocks.accessToken.mockReset().mockResolvedValue({
    accessToken: "synthetic-scoped-token",
    scopes: [readScope],
  });
  mocks.ical.mockReset();
  provider = vi.fn().mockImplementation(async (url: URL) =>
    Response.json(
      url.pathname.endsWith("/calendarList")
        ? {
            items: [
              { id: "synthetic-calendar-a", summary: "A" },
              { id: "synthetic-calendar-b", summary: "B" },
            ],
          }
        : { items: [event] },
    ),
  );
  vi.stubGlobal("fetch", provider);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("external calendar runtime contracts with mocked OAuth/database/provider", () => {
  it("a revoked grant records failure and retains the real SQL last success; disabled configuration hides stale connected state", async () => {
    const sql = new PGlite();
    await sql.waitReady;
    try {
      await sql.exec(
        "CREATE TABLE integration_sync_state(owner_id text,provider text,last_success_at timestamptz,status text,error text,PRIMARY KEY(owner_id,provider))",
      );
      await sql.query(
        "INSERT INTO integration_sync_state(owner_id,provider,last_success_at,status) VALUES($1,'google_calendar',$2,'connected'),($3,'google_calendar',$4,'connected')",
        [
          principal.ownerId,
          "2026-03-29T05:00:00Z",
          "synthetic-other-owner",
          "2026-01-01T00:00:00Z",
        ],
      );
      mocks.query.mockImplementation(
        async (query: string, parameters: unknown[] = []) =>
          query.includes("FROM account")
            ? {
                rows: [
                  {
                    id: "synthetic-account",
                    user_id: principal.actorId,
                    scope: readScope,
                  },
                ],
              }
            : sql.query(query, parameters),
      );
      mocks.accessToken.mockRejectedValue(
        new Error(
          "https://private.invalid/refresh?secret=synthetic-refresh-secret",
        ),
      );
      await expect(externalCalendarList(principal)).rejects.toMatchObject({
        status: 503,
      });
      const state = (await externalCalendarStatus(principal)).find(
        (row) => row.provider === "google_calendar",
      )!;
      expect(state.status).toBe("error");
      expect(state.error).toBe("SOURCE_READ_FAILED");
      expect(new Date(state.last_success_at!).toISOString()).toBe(
        "2026-03-29T05:00:00.000Z",
      );
      expect(JSON.stringify(state)).not.toContain("synthetic-refresh-secret");
      expect(provider).not.toHaveBeenCalled();
      vi.stubEnv("GOOGLE_CLIENT_ID", "");
      vi.stubEnv("GOOGLE_ICAL_URL", "https://feeds.example.invalid/private");
      vi.stubEnv("GOOGLE_ICAL_ALLOWED_HOSTS", "feeds.example.invalid");
      await sql.query(
        "UPDATE integration_sync_state SET status='connected' WHERE owner_id=$1",
        [principal.ownerId],
      );
      expect(
        (await externalCalendarStatus(principal)).find(
          (row) => row.provider === "google_calendar",
        ),
      ).toMatchObject({ status: "not_configured", last_success_at: null });
    } finally {
      await sql.close();
    }
  });
  it("explicit local or iCal selection stays usable when the separate Google grant is insufficient", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "synthetic-account",
          user_id: "synthetic-user",
          scope: "unrelated-scope",
        },
      ],
    });
    expect(
      await externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "local",
      ),
    ).toEqual([]);
    vi.stubEnv(
      "GOOGLE_ICAL_URL",
      "https://feeds.example.invalid/private?key=synthetic-feed-secret",
    );
    vi.stubEnv("GOOGLE_ICAL_ALLOWED_HOSTS", "feeds.example.invalid");
    mocks.ical.mockResolvedValue(
      "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic-independent-ical\r\nDTSTART:20260329T080000Z\r\nDTEND:20260329T090000Z\r\nSUMMARY:Synthetic independent calendar\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n",
    );
    const result = await externalCalendarEvents(
      principal,
      "2026-03-01T00:00:00Z",
      "2026-04-01T00:00:00Z",
      "ical",
    );
    expect(result).toHaveLength(1);
    expect(result[0].source_read_only).toBe(true);
    expect(result[0].event_id).toMatch(/^EXT_[0-9a-f]{40}$/);
    expect(mocks.accessToken).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    expect(
      mocks.query.mock.calls.every(([sql]) => !sql.includes("FROM account")),
    ).toBe(true);
  });
  it("configuration and build connector access cannot fabricate an app grant", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    expect(await externalCalendarStatus(principal)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google_calendar",
          status: "not_configured",
          last_success_at: null,
        }),
      ]),
    );
    expect(await externalCalendarList(principal)).toEqual([]);
    expect(
      await externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
    ).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.accessToken).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await externalCalendarList(principal)).toEqual([]);
    expect(await externalCalendarStatus(principal)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google_calendar",
          status: "awaiting_grant",
        }),
      ]),
    );
    expect(mocks.accessToken).not.toHaveBeenCalled();
  });
  it("selects only the configured owner and verified actor account; decrypt/refresh is internal", async () => {
    const result = await externalCalendarList(principal);
    const accountQuery = mocks.query.mock.calls.find(([sql]) =>
      sql.includes("FROM account"),
    )!;
    expect(accountQuery[0]).toContain('JOIN "user"');
    expect(accountQuery[0]).toContain("u.id=$2");
    expect(accountQuery[1]).toEqual([
      "synthetic-owner@example.invalid",
      principal.actorId,
    ]);
    expect(mocks.accessToken).toHaveBeenCalledWith({
      body: { accountId: "synthetic-google-account", userId: "synthetic-user" },
    });
    expect(result).toHaveLength(2);
    expect(result.every((row) => row.writable === false)).toBe(true);
    for (const [url, init] of provider.mock.calls) {
      expect(url.origin).toBe("https://www.googleapis.com");
      expect(init.method ?? "GET").toBe("GET");
      expect(init.body).toBeUndefined();
      expect(init.redirect).toBe("error");
      expect(init.headers.Authorization).toBe("Bearer synthetic-scoped-token");
    }
    expect(JSON.stringify(result)).not.toContain("synthetic-scoped-token");
    mocks.query.mockClear();
    await externalCalendarList({ ...principal, channel: "system" });
    expect(
      mocks.query.mock.calls.find(([sql]) => sql.includes("FROM account"))![1],
    ).toEqual(["synthetic-owner@example.invalid", null]);
  });
  it("requires exact stored and refreshed read-only calendar scope without trusting write or Drive scope", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "synthetic-account",
          user_id: "synthetic-user",
          scope:
            "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/drive.readonly",
        },
      ],
    });
    await expect(externalCalendarList(principal)).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSIONS",
      status: 403,
    });
    expect(mocks.accessToken).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue({
      rows: [
        {
          id: "synthetic-account",
          user_id: "synthetic-user",
          scope: readScope,
        },
      ],
    });
    mocks.accessToken.mockResolvedValue({
      accessToken: "synthetic-token",
      scopes: [],
    });
    await expect(externalCalendarList(principal)).rejects.toMatchObject({
      status: 503,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it("keeps occurrence IDs stable, separates identical UIDs across calendars, and preserves all-day DST", async () => {
    provider.mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.endsWith("/calendarList")
          ? {
              items: [
                { id: "synthetic-calendar-a" },
                { id: "synthetic-calendar-b" },
              ],
            }
          : {
              items: [
                event,
                { id: "synthetic-cancelled", status: "cancelled" },
                {
                  id: "synthetic-day",
                  start: { date: "2026-03-29", timeZone: "Europe/Berlin" },
                  end: { date: "2026-03-30" },
                },
              ],
            },
      ),
    );
    const result = await externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
      replay = await externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      );
    expect(result).toHaveLength(4);
    expect(new Set(result.map((row) => row.event_id)).size).toBe(4);
    expect(replay.map((row) => row.occurrence_key)).toEqual(
      result.map((row) => row.occurrence_key),
    );
    for (const row of result) {
      expect(row.event_id).toMatch(/^EXT_[0-9a-f]{40}$/);
      expect(row.source_read_only).toBe(true);
      expect(row.task_id).toBeNull();
      expect(row.recurrence_rule).toBeNull();
    }
    const allDay = result.find((row) => row.all_day)!;
    expect(
      new Date(allDay.ends_at).getTime() - new Date(allDay.starts_at).getTime(),
    ).toBe(23 * 3600000);
    provider.mockClear();
    await expect(
      externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "synthetic-unknown-calendar",
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      provider.mock.calls.every(([url]) =>
        url.pathname.endsWith("/calendarList"),
      ),
    ).toBe(true);
  });
  it("bounds pagination and event records and records source failure without source contents", async () => {
    provider.mockImplementation(async () =>
      Response.json({
        items: [{ id: "synthetic-calendar-a" }],
        nextPageToken: "synthetic-next",
      }),
    );
    await expect(externalCalendarList(principal)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(provider).toHaveBeenCalledTimes(10);
    expect(
      mocks.query.mock.calls.some(
        ([sql, params]) =>
          sql.includes("INSERT INTO integration_sync_state") &&
          params[4] === "SOURCE_READ_FAILED",
      ),
    ).toBe(true);
    provider.mockClear().mockImplementation(async (url: URL) =>
      Response.json(
        url.pathname.endsWith("/calendarList")
          ? { items: [{ id: "synthetic-calendar-a" }] }
          : {
              items: Array.from({ length: 5001 }, (_, index) => ({
                ...event,
                id: "synthetic-event-" + index,
              })),
            },
      ),
    );
    await expect(
      externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("bounds Google response bytes and sanitizes provider and refresh errors", async () => {
    const privateMarker =
      "https://private-source.invalid/feed?secret=synthetic-url-secret";
    provider.mockRejectedValue(new Error(privateMarker));
    try {
      await externalCalendarList(principal);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect(JSON.stringify(error) + String(error)).not.toContain(
        privateMarker,
      );
    }
    provider.mockResolvedValue(new Response("x".repeat(2 * 1024 * 1024 + 1)));
    await expect(externalCalendarList(principal)).rejects.toMatchObject({
      status: 502,
    });
    mocks.accessToken.mockRejectedValue(new Error(privateMarker));
    await expect(externalCalendarList(principal)).rejects.toMatchObject({
      status: 503,
    });
    expect(JSON.stringify(mocks.query.mock.calls)).not.toContain(privateMarker);
  });
  it("never discloses private iCal URLs in source state or failure details", async () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const url =
      "https://feeds.example.invalid/private?key=synthetic-feed-secret";
    vi.stubEnv("GOOGLE_ICAL_URL", url);
    vi.stubEnv("GOOGLE_ICAL_ALLOWED_HOSTS", "feeds.example.invalid");
    expect(await externalCalendarList(principal)).toEqual([
      {
        calendar_id: "ical",
        title: "Private iCalendar",
        provider: "ical",
        writable: false,
      },
    ]);
    mocks.ical.mockRejectedValue(new Error(url));
    try {
      await externalCalendarEvents(
        principal,
        "2026-03-01T00:00:00Z",
        "2026-04-01T00:00:00Z",
        "ical",
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({
        code: "UNSUPPORTED_OPERATION",
        status: 503,
      });
      expect(String(error) + JSON.stringify(error)).not.toContain(
        "synthetic-feed-secret",
      );
    }
    expect(
      JSON.stringify(await externalCalendarStatus(principal)) +
        JSON.stringify(mocks.query.mock.calls),
    ).not.toContain(url);
  });
});
