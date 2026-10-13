import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  EventDTO,
  PageDTO,
  Principal,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
const provider = vi.hoisted(() => ({ fail: false, calls: 0 }));
vi.mock("../../server/integrations/calendar-runtime", () => ({
  externalCalendarList: async () => {
    provider.calls++;
    if (provider.fail) throw new Error("Provider unavailable");
    return [
      {
        calendar_id: "synthetic-source",
        title: "Synthetic external calendar",
        provider: "google_calendar",
        writable: false,
      },
    ];
  },
  externalCalendarEvents: async (
    _principal: unknown,
    _from: string,
    _to: string,
    calendarId?: string,
  ) => {
    provider.calls++;
    if (provider.fail) throw new Error("Provider unavailable");
    if (calendarId === "local") return [];
    return [
      {
        event_id: "EXT-synthetic",
        title: "Synthetic external event",
        starts_at: "2030-01-01T10:00:00.000Z",
        ends_at: "2030-01-01T11:00:00.000Z",
        timezone: "Europe/Berlin",
        all_day: false,
        provider: "google_calendar",
        task_id: null,
        notes: "Untrusted external content",
        recurrence_rule: null,
        revision: 1,
        occurrence_key: "EXT-synthetic:2030-01-01",
        source_read_only: true,
      },
    ];
  },
  externalCalendarStatus: async () => [
    {
      provider: "google_calendar",
      status: provider.fail ? "error" : "connected",
      last_success_at: provider.fail ? null : "2030-01-01T00:00:00Z",
      error: provider.fail ? "SOURCE_READ_FAILED" : null,
    },
  ],
}));
let db: Database, service: DomainService, principal: Principal;
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  provider.fail = false;
  provider.calls = 0;
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});
describe("Canonical local and authorized external calendar consistency", () => {
  const range = { from: "2030-01-01T00:00:00Z", to: "2030-01-02T00:00:00Z" };
  it("canonical_calendar_merges_readonly_sources_without_inventing_tasks_or_local_rows", async () => {
    const local = await service.execute(
      "calendar_create_local_event",
      {
        title: "Synthetic local",
        starts_at: "2030-01-01T09:00:00Z",
        ends_at: "2030-01-01T10:00:00Z",
      },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const calendars = (await service.query(
      "calendar_list",
      {},
      principal,
    )) as PageDTO<{ calendar_id: string; writable: boolean }>;
    expect(calendars.total).toBe(2);
    expect(
      calendars.items.find((c) => c.calendar_id === "synthetic-source")!
        .writable,
    ).toBe(false);
    const events = (await service.query(
      "calendar_events_query",
      range,
      principal,
    )) as PageDTO<EventDTO & { source_read_only?: boolean }>;
    expect(events.total).toBe(2);
    expect(events.items.map((e) => e.event_id)).toEqual([
      local.entity_id,
      "EXT-synthetic",
    ]);
    expect(events.items[1].source_read_only).toBe(true);
    expect(
      await service.query("calendar_availability", range, principal),
    ).toMatchObject({
      busy: [{ event_id: local.entity_id }, { event_id: "EXT-synthetic" }],
    });
    expect(await service.query("task_search", {}, principal)).toMatchObject({
      total: 0,
    });
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) FROM calendar_events WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("external_failure_keeps_local_calendar_and_reports_explicit_source_warning", async () => {
    await service.execute(
      "calendar_create_local_event",
      {
        title: "Local remains usable",
        starts_at: "2030-01-01T09:00:00Z",
        ends_at: "2030-01-01T10:00:00Z",
      },
      principal,
      { idempotencyKey: randomUUID() },
    );
    provider.fail = true;
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      total: 1,
      source_warnings: ["EXTERNAL_CALENDAR_UNAVAILABLE"],
    });
    expect(await service.query("calendar_list", {}, principal)).toMatchObject({
      total: 1,
      source_warnings: ["EXTERNAL_CALENDAR_UNAVAILABLE"],
    });
    expect(await service.query("sync_status", {}, principal)).toMatchObject({
      external_sync: {
        connected: false,
        state: "Source read failed",
        sources: [{ status: "error" }],
      },
    });
  });
  it("calendar_scope_and_range_are_checked_before_provider_read", async () => {
    await expect(
      service.query(
        "calendar_list",
        {},
        { ...principal, scopes: ["tasks:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(provider.calls).toBe(0);
    await expect(
      service.query(
        "calendar_events_query",
        { from: "2030-01-02T00:00:00Z", to: "2030-01-01T00:00:00Z" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(provider.calls).toBe(0);
    expect(
      await service.query(
        "calendar_events_query",
        { ...range, calendar_id: "synthetic-source" },
        principal,
      ),
    ).toMatchObject({ total: 1 });
  });
});
