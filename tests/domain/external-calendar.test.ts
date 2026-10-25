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
import { createCalendarProviderService } from "../../server/domain/calendar-provider-service";
import { previewCalendarChange } from "../../server/domain/calendar-sources";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  PageDTO,
  EventDTO,
  Principal,
  PreviewDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
const network = vi.hoisted(() => ({
  calls: 0,
  result: "confirmed",
  block: null as null | (() => Promise<void>),
  sources: [] as Record<string, unknown>[],
  fail: [] as string[],
  reviewCalls: 0,
  reviewBlock: null as null | (() => Promise<void>),
  reviewEtag: "fresh-instance-v1",
  enforceEtag: false,
}));
vi.mock("../../server/integrations/calendar-provider", async (original) => {
  const actual =
    await original<
      typeof import("../../server/integrations/calendar-provider")
    >();
  return {
    ...actual,
    freshCalendarChangeReview: async (
      _principal: unknown,
      _source: unknown,
      input: {
        event_id: string;
        expected_master_etag?: string;
        expected_instance_etag?: string;
      },
    ) => {
      network.reviewCalls++;
      if (network.reviewBlock) await network.reviewBlock();
      const etag = input.expected_instance_etag ?? network.reviewEtag;
      return {
        event_id: input.event_id,
        etag,
        ...(input.expected_master_etag
          ? {
              master_event_id: input.event_id.replace(/_\d{8}(T\d{6}Z)?$/, ""),
              expected_master_etag: input.expected_master_etag,
            }
          : {}),
        raw: {
          id: input.event_id,
          etag,
          summary: "Fresh Google title",
          description: "Fresh Google notes",
          organizer: { self: true },
          start: { dateTime: "2030-01-01T10:00:00Z" },
          end: { dateTime: "2030-01-01T11:00:00Z" },
        },
      };
    },
    discoverGoogleCalendars: async () => {
      network.calls++;
      return network.sources;
    },
    syncCalendarSource: async (
      _principal: unknown,
      source: { external_calendar_id: string },
    ) => {
      network.calls++;
      if (network.block) await network.block();
      if (network.fail.includes(source.external_calendar_id))
        throw new Error("Synthetic provider outage");
      return {
        events: [],
        deleted_ids: [],
        replace: false,
        checkpoint: { sync_token: "next" },
        timezone: "Europe/Berlin",
        complete: true,
      };
    },
    executeGoogleCalendarChange: async (
      _p: unknown,
      _s: unknown,
      intent: {
        event_id: string;
        etag?: string;
        payload: Record<string, unknown>;
      },
    ) => {
      network.calls++;
      if (network.enforceEtag && intent.etag !== network.reviewEtag)
        return { status: "conflict", error: "PROVIDER_REVISION_CONFLICT" };
      return {
        status: network.result,
        external_id: intent.event_id,
        event: {
          id: intent.event_id,
          etag: "confirmed-v2",
          organizer: { self: true },
          summary: intent.payload.title,
          start: { dateTime: intent.payload.starts_at },
          end: { dateTime: intent.payload.ends_at },
        },
      };
    },
  };
});
let db: Database, service: DomainService, principal: Principal;
const range = { from: "2030-01-01T00:00:00Z", to: "2030-02-01T00:00:00Z" };
const event = (id: string, extra: Record<string, unknown> = {}) => ({
  external_id: id,
  raw: {
    id,
    summary: "Synthetic event",
    etag: "v1",
    organizer: { self: true },
    start: { dateTime: "2030-01-01T10:00:00Z" },
    end: { dateTime: "2030-01-01T11:00:00Z" },
    ...extra,
  },
});
const internal = () => createCalendarProviderService(db),
  trusted = () => ({ ...principal, channel: "system" as const });
const exec = (
  name: Parameters<DomainService["execute"]>[0],
  input: Record<string, unknown>,
  revision?: number,
) =>
  service.execute(name, input, principal, {
    idempotencyKey: randomUUID(),
    expectedRevision: revision,
  });
async function source(
  external = "primary",
  extra: Record<string, unknown> = {},
) {
  const result = await internal().execute(
    "discover",
    {
      sources: [
        {
          external_calendar_id: external,
          provider: "google_calendar",
          title: "Synthetic Google",
          timezone: "Europe/Berlin",
          writable: true,
          grant_fingerprint: "synthetic-grant",
          ...extra,
        },
      ],
    },
    trusted(),
    { idempotencyKey: randomUUID() },
  );
  return (result.data as { source_ids: string[] }).source_ids[0];
}
async function claim(sourceId: string) {
  return (
    await internal().execute("sync_claim", { source_id: sourceId }, trusted(), {
      idempotencyKey: randomUUID(),
    })
  ).data as Record<string, unknown>;
}
async function finish(
  sourceId: string,
  lease: Record<string, unknown>,
  result: Record<string, unknown>,
) {
  return internal().execute(
    "sync_complete",
    {
      source_id: sourceId,
      lease_id: lease.lease_id,
      generation: lease.generation,
      cache_revision: lease.cache_revision,
      ...result,
    },
    trusted(),
    { idempotencyKey: randomUUID() },
  );
}
async function seed(sourceId: string, events: ReturnType<typeof event>[]) {
  return finish(sourceId, await claim(sourceId), {
    result: {
      events,
      deleted_ids: [],
      replace: true,
      checkpoint: { sync_token: "synthetic-next" },
      timezone: "Europe/Berlin",
      complete: true,
    },
  });
}
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-calendar-" + randomUUID(),
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  network.calls = 0;
  network.result = "confirmed";
  network.block = null;
  network.sources = [];
  network.fail = [];
  network.reviewCalls = 0;
  network.reviewBlock = null;
  network.reviewEtag = "fresh-instance-v1";
  network.enforceEtag = false;
  vi.stubEnv(
    "BETTER_AUTH_SECRET",
    "synthetic-calendar-secret-32-characters-minimum",
  );
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.close?.();
});
describe("Durable owner-bound calendar cache and provider receipts", () => {
  it("calendar_queries_are_pure_cache_reads_and_unclassified_free_events_do_not_block", async () => {
    const id = await source();
    await seed(id, [
      event("busy"),
      event("free", { transparency: "transparent" }),
      event("declined", {
        attendees: [{ self: true, responseStatus: "declined" }],
      }),
    ]);
    const rows = (await service.query(
      "calendar_events_query",
      { ...range, category: "Unclassified" },
      principal,
    )) as PageDTO<EventDTO>;
    expect(rows.total).toBe(3);
    expect(rows.items.every((row) => row.source_id === id)).toBe(true);
    expect(
      (
        (await service.query("calendar_availability", range, principal)) as {
          busy: unknown[];
        }
      ).busy,
    ).toHaveLength(1);
    await service.query("calendar_list", {}, principal);
    expect(network.calls).toBe(0);
    expect(
      await service.query("calendar_events_query", range, {
        ...principal,
        ownerId: "foreign",
      }),
    ).toMatchObject({ total: 0 });
  });
  it("source_failures_retain_last_good_cache_and_revoked_access_hides_only_that_source", async () => {
    const google = await source();
    await seed(google, [event("google")]);
    const ical = await exec("calendar_source_configure", {
      provider: "ical",
      title: "Synthetic feed",
      url: "https://calendar.example.test/private/synthetic.ics",
    });
    await finish(ical.entity_id, await claim(ical.entity_id), {
      result: {
        events: [
          {
            external_id: "ical_feed",
            raw: {
              feed_text:
                "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:synthetic\r\nDTSTART:20300102T100000Z\r\nDTEND:20300102T110000Z\r\nSUMMARY:Synthetic feed\r\nEND:VEVENT\r\nEND:VCALENDAR",
            },
          },
        ],
        deleted_ids: [],
        replace: true,
        checkpoint: {},
        timezone: "Europe/Berlin",
        complete: true,
      },
    });
    await finish(google, await claim(google), {
      error: { code: "SOURCE_UNAVAILABLE", revoked: false },
    });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ total: 2 });
    await db.query(
      "UPDATE calendar_sources SET next_attempt_at=NULL WHERE owner_id=$1",
      [principal.ownerId],
    );
    await finish(google, await claim(google), {
      error: { code: "GRANT_REVOKED", revoked: true },
    });
    const rows = (await service.query(
      "calendar_events_query",
      range,
      principal,
    )) as PageDTO<EventDTO>;
    expect(rows.total).toBe(1);
    expect(rows.items[0].source_id).toBe(ical.entity_id);
    expect(
      (
        await db.query(
          "SELECT external_id FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2",
          [principal.ownerId, google],
        )
      ).rows,
    ).toHaveLength(1);
    const publicState = JSON.stringify(
      await service.query("calendar_sync_status", {}, principal),
    );
    expect(publicState).not.toContain("private/synthetic");
    expect(publicState).not.toContain("encrypted_config");
    expect(
      JSON.stringify(await service.query("get_activity", {}, principal)),
    ).not.toContain("https://calendar.example.test");
  });
  it("all_pages_are_available_and_source_selection_has_no_200_event_truncation", async () => {
    const id = await source();
    await seed(
      id,
      Array.from({ length: 451 }, (_, index) => event("e" + index)),
    );
    const all: EventDTO[] = [];
    let cursor: string | undefined;
    do {
      const result = (await service.query(
        "calendar_events_query",
        { ...range, source_ids: [id], limit: 200, cursor },
        principal,
      )) as PageDTO<EventDTO>;
      all.push(...result.items);
      cursor = result.next_cursor ?? undefined;
    } while (cursor);
    expect(all).toHaveLength(451);
    expect(new Set(all.map((row) => row.event_id)).size).toBe(451);
    expect(
      (
        (await service.query("calendar_availability", range, principal)) as {
          busy: unknown[];
        }
      ).busy,
    ).toHaveLength(451);
  });
  it("lease_generation_fences_reject_stale_sync_results", async () => {
    const id = await source();
    await seed(id, [event("old")]);
    const lease = await claim(id);
    await exec("calendar_source_disconnect", { source_id: id }, 1);
    expect(
      (
        await finish(id, lease, {
          result: {
            complete: true,
            events: [event("stale")],
            deleted_ids: [],
            replace: true,
            checkpoint: { sync_token: "wrong" },
          },
        })
      ).data,
    ).toMatchObject({ ignored: true });
    expect(
      (
        await db.query(
          "SELECT external_id FROM calendar_external_events WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows,
    ).toEqual([{ external_id: "old" }]);
  });
  it("personal_google_changes_are_reviewed_idempotent_and_guest_events_are_read_only", async () => {
    const id = await source();
    await seed(id, [
      event("personal"),
      event("meeting", {
        attendees: [{ self: false, email: "guest@example.test" }],
      }),
    ]);
    await expect(
      service.query(
        "calendar_event_change_preview",
        { source_id: id, action: "delete", event_id: "meeting" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const input = {
        source_id: id,
        action: "update",
        event_id: "personal",
        etag: "v1",
        payload: {
          title: "Changed",
          starts_at: "2030-01-01T12:00:00Z",
          ends_at: "2030-01-01T13:00:00Z",
        },
      },
      preview = (await service.query(
        "calendar_event_change_preview",
        input,
        principal,
      )) as PreviewDTO,
      key = randomUUID();
    const result = await service.execute(
      "calendar_event_change_commit",
      { preview_id: preview.preview_id },
      principal,
      { idempotencyKey: key },
    );
    expect(result.data).toMatchObject({ delivery: [{ state: "confirmed" }] });
    expect(
      await service.execute(
        "calendar_event_change_commit",
        { preview_id: preview.preview_id },
        principal,
        { idempotencyKey: key },
      ),
    ).toMatchObject({ replayed: true });
    expect(network.calls).toBe(1);
    expect(
      await service.query(
        "calendar_operation_status",
        { operation_id: result.entity_id },
        principal,
      ),
    ).toMatchObject({ items: [{ state: "confirmed" }] });
    await expect(
      service.query("calendar_event_change_preview", input, {
        ...principal,
        scopes: ["calendar:read"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });
  it("provider_network_wait_does_not_hold_the_owner_transaction", async () => {
    const id = await source();
    network.sources = [
      {
        external_calendar_id: "primary",
        title: "Synthetic Google",
        timezone: "Europe/Berlin",
        writable: true,
        grant_fingerprint: "synthetic-grant",
      },
    ];
    let release!: () => void, entered!: () => void;
    const barrier = new Promise<void>((resolve) => {
        release = resolve;
      }),
      reached = new Promise<void>((resolve) => {
        entered = resolve;
      });
    network.block = async () => {
      entered();
      await barrier;
    };
    const syncing = exec("calendar_sync_request", { source_ids: [id] });
    try {
      await reached;
      expect(
        (await exec("task_create", { title: "Saved while provider waits" }))
          .version,
      ).toBe(1);
      expect(
        await exec("preferences_update", { settings: { theme: "dark" } }),
      ).toMatchObject({ version: 1 });
    } finally {
      release();
      await syncing;
      network.block = null;
    }
  });
  it("generated_recurring_instances_preview_against_master_and_series_targets_master", async () => {
    const id = await source();
    await seed(id, [
      event("master", { recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] }),
    ]);
    const rows = (await service.query(
        "calendar_events_query",
        range,
        principal,
      )) as PageDTO<EventDTO>,
      instance = rows.items[1];
    const single = (await service.query(
      "calendar_event_change_preview",
      {
        source_id: id,
        action: "delete",
        event_id: instance.external_id,
        recurrence_scope: "instance",
      },
      principal,
    )) as PreviewDTO;
    expect(single.input).toMatchObject({
      master_event_id: "master",
      expected_master_etag: "v1",
      etag: "fresh-instance-v1",
      event_id: instance.external_id,
    });
    const series = (await service.query(
      "calendar_event_change_preview",
      {
        source_id: id,
        action: "delete",
        event_id: instance.external_id,
        recurrence_scope: "series",
      },
      principal,
    )) as PreviewDTO;
    expect(series.input).toMatchObject({ event_id: "master", etag: "v1" });
    await exec("calendar_event_change_commit", {
      preview_id: single.preview_id,
    });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ total: 1 });
  });
  it("generated_instance_review_pins_actual_instance_etag_and_rejects_later_external_exception_edit", async () => {
    const id = await source();
    await seed(id, [
      event("master", { recurrence: ["RRULE:FREQ=DAILY;COUNT=2"] }),
    ]);
    const rows = (await service.query(
        "calendar_events_query",
        range,
        principal,
      )) as PageDTO<EventDTO>,
      selected = rows.items[1];
    const preview = (await service.query(
      "calendar_event_change_preview",
      {
        source_id: id,
        event_id: selected.external_id,
        action: "update",
        payload: {
          title: "Proposed",
          starts_at: "2030-01-02T12:00:00Z",
          ends_at: "2030-01-02T13:00:00Z",
        },
      },
      principal,
    )) as PreviewDTO;
    expect(preview.input).toMatchObject({
      etag: "fresh-instance-v1",
      expected_master_etag: "v1",
    });
    expect(preview.changes).toMatchObject({
      original: {
        title: "Fresh Google title",
        notes: "Fresh Google notes",
        etag: "fresh-instance-v1",
      },
    });
    network.reviewEtag = "fresh-instance-v2";
    network.enforceEtag = true;
    const result = await exec("calendar_event_change_commit", {
      preview_id: preview.preview_id,
    });
    expect(result.data).toMatchObject({ delivery: [{ state: "conflict" }] });
    expect(
      await service.query(
        "calendar_operation_status",
        { operation_id: result.entity_id },
        principal,
      ),
    ).toMatchObject({ items: [{ state: "conflict" }] });
  });
  it.each(["cache", "generation"])(
    "fresh_review_HTTP_is_outside_owner_lock_and_%s_change_invalidates_receipt",
    async (change) => {
      const id = await source();
      await seed(id, [event("personal")]);
      let release!: () => void, entered!: () => void;
      const barrier = new Promise<void>((resolve) => {
          release = resolve;
        }),
        reached = new Promise<void>((resolve) => {
          entered = resolve;
        });
      network.reviewBlock = async () => {
        entered();
        await barrier;
      };
      const review = service
        .query(
          "calendar_event_change_preview",
          { source_id: id, event_id: "personal", action: "delete" },
          principal,
        )
        .then(
          (value) => ({ value }),
          (error: unknown) => ({ error }),
        );
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await reached;
        const task = await Promise.race([
          exec("task_create", {
            title: "Task saved while Google review waits",
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("OWNER_LOCK_HELD_DURING_GOOGLE_REVIEW")),
              3000,
            );
          }),
        ]);
        expect(task.version).toBe(1);
        if (change === "cache")
          await seed(id, [
            event("personal", { summary: "Concurrent cached edit" }),
          ]);
        else
          await exec(
            "calendar_source_configure",
            {
              provider: "google_calendar",
              source_id: id,
              title: "Reconfigured during review",
            },
            1,
          );
      } finally {
        if (timer) clearTimeout(timer);
        release();
        network.reviewBlock = null;
      }
      expect(await review).toMatchObject({
        error: { code: "PREVIEW_REQUIRED" },
      });
      expect(
        (
          await db.query(
            "SELECT preview_id FROM command_previews WHERE owner_id=$1",
            [principal.ownerId],
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it("caller_supplied_review_JSON_cannot_forge_the_private_receipt_or_skip_scope_checks", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    const input = {
      source_id: id,
      event_id: "personal",
      action: "delete",
      provider_review: { etag: "forged", owner_id: principal.ownerId },
    };
    await expect(
      db.transaction(principal.ownerId, (tx) =>
        previewCalendarChange(tx, input, principal),
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    await expect(
      service.query("calendar_event_change_preview", input, {
        ...principal,
        scopes: ["calendar:read"],
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.query("calendar_event_change_preview", input, {
        ...principal,
        ownerId: "synthetic-foreign-owner",
      }),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(network.reviewCalls).toBe(0);
  });
  it("an_outbound_confirmation_fences_an_older_incoming_snapshot", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    const old = await claim(id),
      preview = (await service.query(
        "calendar_event_change_preview",
        {
          source_id: id,
          event_id: "personal",
          action: "update",
          payload: {
            title: "Confirmed latest",
            starts_at: "2030-01-01T12:00:00Z",
            ends_at: "2030-01-01T13:00:00Z",
          },
        },
        principal,
      )) as PreviewDTO;
    await exec("calendar_event_change_commit", {
      preview_id: preview.preview_id,
    });
    expect(
      (
        await finish(id, old, {
          result: {
            events: [event("personal")],
            deleted_ids: [],
            replace: true,
            checkpoint: { sync_token: "stale" },
            complete: true,
          },
        })
      ).data,
    ).toMatchObject({
      ignored: true,
      reason: "OUTBOUND_CHANGE_AFTER_SYNC_CLAIM",
    });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ items: [{ title: "Confirmed latest" }] });
    expect(
      (await internal().state(trusted())).sources[0].checkpoint,
    ).toMatchObject({ sync_token: "synthetic-next" });
  });
  it("uncertain_outgoing_edits_survive_incoming_cache_refresh_and_honor_retry_backoff", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    network.result = "uncertain";
    const preview = (await service.query(
      "calendar_event_change_preview",
      {
        source_id: id,
        event_id: "personal",
        action: "update",
        payload: {
          title: "Pending retained",
          starts_at: "2030-01-01T12:00:00Z",
          ends_at: "2030-01-01T13:00:00Z",
        },
      },
      principal,
    )) as PreviewDTO;
    const result = await exec("calendar_event_change_commit", {
      preview_id: preview.preview_id,
    });
    await seed(id, [event("personal")]);
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      items: [{ title: "Pending retained", sync_state: "uncertain" }],
    });
    expect(
      (
        await internal().execute(
          "mutation_claim",
          { intent_id: result.entity_id },
          trusted(),
          { idempotencyKey: randomUUID() },
        )
      ).data,
    ).toMatchObject({ claimed: false });
    expect(network.calls).toBe(1);
  });
  it("explicitly_selected_unavailable_sources_have_incomplete_coverage", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    await exec("calendar_source_disconnect", { source_id: id }, 1);
    expect(
      await service.query(
        "calendar_events_query",
        { ...range, source_ids: [id] },
        principal,
      ),
    ).toMatchObject({
      total: 0,
      complete: false,
      source_warnings: ["SELECTED_SOURCE_UNAVAILABLE"],
    });
    expect(
      await service.query(
        "calendar_events_query",
        { ...range, source_ids: ["synthetic-foreign"] },
        principal,
      ),
    ).toMatchObject({
      total: 0,
      complete: false,
      source_warnings: ["SELECTED_SOURCE_UNAVAILABLE"],
    });
    expect(
      await service.query(
        "calendar_events_query",
        { ...range, source_ids: ["local"] },
        principal,
      ),
    ).toMatchObject({ total: 0, complete: true });
  });
  it("does_not_warn_for_a_recent_cache_during_sync_but_reports_incomplete_or_old_coverage", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    await db.query(
      "UPDATE calendar_sources SET last_success_at=now()-interval '6 minutes' WHERE owner_id=$1 AND source_id=$2",
      [principal.ownerId, id],
    );
    const lease = await claim(id);
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      source_warnings: [],
      items: [{ sync_state: "synced" }],
    });
    await finish(id, lease, {
      result: {
        events: [],
        deleted_ids: [],
        replace: false,
        checkpoint: { sync_token: "next" },
        timezone: "Europe/Berlin",
        complete: true,
        coverage: { complete: false },
      },
    });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      complete: false,
      source_warnings: [id + ":SOURCE_COVERAGE_INCOMPLETE"],
    });
    await db.query(
      "UPDATE calendar_sources SET last_success_at=now()-interval '11 minutes' WHERE owner_id=$1 AND source_id=$2",
      [principal.ownerId, id],
    );
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      source_warnings: [
        id + ":SOURCE_STALE",
        id + ":SOURCE_COVERAGE_INCOMPLETE",
      ],
      items: [{ sync_state: "stale" }],
    });
  });
  it("manual_refresh_retries_ordinary_errors_without_bypassing_leases_or_provider_backoff", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    await finish(id, await claim(id), {
      error: { code: "SOURCE_READ_FAILED" },
    });
    network.sources = [
      {
        external_calendar_id: "primary",
        title: "Synthetic Google",
        timezone: "Europe/Berlin",
        writable: true,
        grant_fingerprint: "synthetic-grant",
      },
    ];
    expect(
      (await exec("calendar_sync_request", { source_ids: [id] })).data,
    ).toMatchObject({ sync: { sources: [{ state: "deferred" }] } });
    expect(
      (
        await exec("calendar_sync_request", {
          source_ids: [id],
          force: true,
        })
      ).data,
    ).toMatchObject({ sync: { sources: [{ state: "connected" }] } });
    const active = await claim(id);
    expect(
      (
        await exec("calendar_sync_request", {
          source_ids: [id],
          force: true,
        })
      ).data,
    ).toMatchObject({ sync: { sources: [{ state: "deferred" }] } });
    await finish(id, active, {
      error: { code: "SOURCE_RATE_LIMITED", retry_after_seconds: 600 },
    });
    expect(
      (
        await exec("calendar_sync_request", {
          source_ids: [id],
          force: true,
        })
      ).data,
    ).toMatchObject({ sync: { sources: [{ state: "deferred" }] } });
    await db.query(
      "UPDATE calendar_sources SET next_attempt_at=NULL WHERE owner_id=$1 AND source_id=$2",
      [principal.ownerId, id],
    );
    await finish(id, await claim(id), {
      error: { code: "SOURCE_RETRY_AFTER", retry_after_seconds: 600 },
    });
    expect(
      (
        await exec("calendar_sync_request", {
          source_ids: [id],
          force: true,
        })
      ).data,
    ).toMatchObject({ sync: { sources: [{ state: "deferred" }] } });
  });
  it("a_revoked_source_cannot_be_claimed_or_revealed_by_foreground_retries", async () => {
    const id = await source();
    await seed(id, [event("synthetic-private-cached-event")]);
    await internal().execute("discover", { sources: [] }, trusted(), {
      idempotencyKey: randomUUID(),
    });
    const claim = await internal().execute(
      "sync_claim",
      { source_id: id },
      trusted(),
      { idempotencyKey: randomUUID() },
    );
    expect(claim.data).toMatchObject({ claimed: false });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({
      total: 0,
      source_warnings: [id + ":GOOGLE_SOURCE_ACCESS_REMOVED"],
    });
    // Empty successful discovery and a repeated foreground request must not
    // turn authoritative access revocation into a visible stale snapshot.
    network.sources = [];
    network.calls = 0;
    await exec("calendar_sync_request", {});
    expect(network.calls).toBe(1);
    expect(
      await service.query("calendar_sync_status", {}, principal),
    ).toMatchObject({ items: [{ status: "revoked" }] });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ total: 0 });
  });
  it("outgoing_revocation_invalidates_an_already_running_sync_and_keeps_private_cache_hidden", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    const oldSync = await claim(id),
      preview = (await service.query(
        "calendar_event_change_preview",
        { source_id: id, event_id: "personal", action: "delete" },
        principal,
      )) as PreviewDTO;
    network.result = "revoked";
    expect(
      (
        await exec("calendar_event_change_commit", {
          preview_id: preview.preview_id,
        })
      ).data,
    ).toMatchObject({ delivery: [{ state: "revoked" }] });
    expect(
      (
        await finish(id, oldSync, {
          result: {
            events: [event("stale-snapshot")],
            deleted_ids: [],
            replace: true,
            checkpoint: { sync_token: "late-token" },
            complete: true,
          },
        })
      ).data,
    ).toMatchObject({ ignored: true });
    const row = (
      await db.query<{
        status: string;
        generation: number;
        lease_id: string | null;
      }>(
        "SELECT status,generation,lease_id FROM calendar_sources WHERE owner_id=$1 AND source_id=$2",
        [principal.ownerId, id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: "revoked",
      generation: 2,
      lease_id: null,
    });
    expect(await claim(id)).toMatchObject({ claimed: false });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ total: 0 });
    expect(
      (
        await db.query(
          "SELECT external_id FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2",
          [principal.ownerId, id],
        )
      ).rows,
    ).toEqual([{ external_id: "personal" }]);
  });
  it("incoming_revocation_invalidates_an_inflight_outgoing_receipt_and_all_pending_intents", async () => {
    const id = await source();
    await seed(id, [event("personal")]);
    network.result = "uncertain";
    const preview = (await service.query(
      "calendar_event_change_preview",
      {
        source_id: id,
        event_id: "personal",
        action: "update",
        payload: {
          title: "Queued edit",
          starts_at: "2030-01-01T12:00:00Z",
          ends_at: "2030-01-01T13:00:00Z",
        },
      },
      principal,
    )) as PreviewDTO;
    const queued = await exec("calendar_event_change_commit", {
      preview_id: preview.preview_id,
    });
    await db.query(
      "UPDATE calendar_mutation_intents SET next_attempt_at=NULL WHERE owner_id=$1 AND intent_id=$2",
      [principal.ownerId, queued.entity_id],
    );
    const outgoing = (
        await internal().execute(
          "mutation_claim",
          { intent_id: queued.entity_id },
          trusted(),
          { idempotencyKey: randomUUID() },
        )
      ).data as Record<string, unknown>,
      incoming = await claim(id);
    expect(outgoing.claimed).toBe(true);
    await finish(id, incoming, {
      error: { code: "GOOGLE_GRANT_REVOKED", revoked: true },
    });
    const late = await internal().execute(
      "mutation_complete",
      {
        intent_id: queued.entity_id,
        lease_id: outgoing.lease_id,
        generation: outgoing.generation,
        result: {
          status: "confirmed",
          event: { ...event("personal").raw, summary: "Late accepted event" },
        },
      },
      trusted(),
      { idempotencyKey: randomUUID() },
    );
    expect(late.data).toMatchObject({ ignored: true });
    expect(
      await service.query(
        "calendar_operation_status",
        { operation_id: queued.entity_id },
        principal,
      ),
    ).toMatchObject({ items: [{ state: "revoked" }] });
    expect(
      await service.query("calendar_events_query", range, principal),
    ).toMatchObject({ total: 0 });
    expect(
      (
        await db.query<{ raw: { summary: string } }>(
          "SELECT raw FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2",
          [principal.ownerId, id],
        )
      ).rows[0].raw.summary,
    ).toBe("Synthetic event");
  });
  it("one_failed_google_source_does_not_discard_another_google_source", async () => {
    network.sources = ["first", "second"].map((external_calendar_id) => ({
      external_calendar_id,
      title: external_calendar_id,
      timezone: "Europe/Berlin",
      writable: false,
      grant_fingerprint: "synthetic-grant",
    }));
    const discovered = await internal().execute(
      "discover",
      { sources: network.sources },
      trusted(),
      { idempotencyKey: randomUUID() },
    );
    const ids = (discovered.data as { source_ids: string[] }).source_ids;
    await seed(ids[0], [event("first-event")]);
    await seed(ids[1], [event("second-event")]);
    network.fail = ["first"];
    const result = await exec("calendar_sync_request", {});
    expect(result.data).toMatchObject({
      sync: {
        sources: expect.arrayContaining([
          { source_id: ids[0], state: "error", ignored: false },
          { source_id: ids[1], state: "connected", ignored: false },
        ]),
      },
    });
    const rows = (await service.query(
      "calendar_events_query",
      range,
      principal,
    )) as PageDTO<EventDTO>;
    expect(rows.total).toBe(2);
    expect(rows.items.find((row) => row.source_id === ids[0])?.sync_state).toBe(
      "stale",
    );
    expect(rows.items.find((row) => row.source_id === ids[1])?.sync_state).toBe(
      "synced",
    );
  });
});
