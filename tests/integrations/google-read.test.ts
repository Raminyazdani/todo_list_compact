import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GoogleReadClient,
  googleConnectionCapabilities,
  normalizeGoogleEvent,
} from "../../server/integrations/google";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("scoped read-only Google adapters", () => {
  it("connector presence never masquerades as a deployed app OAuth grant", () => {
    vi.stubEnv("GOOGLE_CLIENT_ID", "synthetic-client");
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "synthetic-secret");
    expect(googleConnectionCapabilities()).toMatchObject({
      oauth_client_configured: true,
      connected: false,
      source_sheet_writes: false,
      calendar_writes: false,
    });
    expect(() => new GoogleReadClient("")).toThrow(/disconnected/);
  });
  it("uses exact Google API domains, bounded values, bearer header and no redirects", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ spreadsheetId: "synthetic-sheet", valueRanges: [] }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new GoogleReadClient("synthetic-token");
    await client.spreadsheetValues("synthetic-sheet", ["Tasks!A1:P46"]);
    const [url, init] = fetcher.mock.calls[0];
    expect((url as URL).origin).toBe("https://sheets.googleapis.com");
    expect((url as URL).searchParams.get("dateTimeRenderOption")).toBe(
      "SERIAL_NUMBER",
    );
    expect(init.redirect).toBe("error");
    expect(init.headers.Authorization).toBe("Bearer synthetic-token");
    await expect(
      client.spreadsheetValues("synthetic-sheet", ["Tasks!A:A"]),
    ).rejects.toThrow(/Bounded/);
  });
  it("normalizes Google all-day local dates without adding time to a task deadline", () => {
    expect(
      normalizeGoogleEvent({
        id: "synthetic-event",
        summary: "Synthetic day",
        start: { date: "2026-03-29", timeZone: "Europe/Berlin" },
        end: { date: "2026-03-30" },
      }),
    ).toMatchObject({
      starts_at: "2026-03-28T23:00:00.000Z",
      ends_at: "2026-03-29T22:00:00.000Z",
      all_day: true,
      source_read_only: true,
    });
    expect(normalizeGoogleEvent({ status: "cancelled" })).toBeNull();
    expect(() =>
      normalizeGoogleEvent({
        id: "synthetic-invalid-time",
        start: { dateTime: "not-a-date" },
        end: { dateTime: "2026-03-29T09:00:00Z" },
      }),
    ).toThrow(/invalid time bounds/);
  });
});
