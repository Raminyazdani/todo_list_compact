import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import { workMinutes, workOverlapSummary } from "../../server/domain/work-log";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  Principal,
  PreviewDTO,
  PageDTO,
  TimeEntryDTO,
  TimeDraftDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let database: Database, service: DomainService, principal: Principal;
const execute = (
  command: Parameters<DomainService["execute"]>[0],
  input: Record<string, unknown>,
  expectedRevision?: number,
  idempotencyKey = randomUUID(),
) =>
  service.execute(command, input, principal, {
    idempotencyKey,
    expectedRevision,
  });
beforeAll(async () => {
  database = await createTestDatabase();
  service = createDomainService(database);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-work-parity-" + randomUUID(),
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await database.close?.();
});
describe("Work Planner canonical parity", () => {
  it("exports_complete_original_intervals_with_owner_month_and_employer_filters", async () => {
    const create = (employer: string, starts_at: string, ends_at: string) =>
      execute("time_entry_create", {
        employer,
        starts_at,
        ends_at,
        description: "Synthetic export range",
      });
    const cross = await create(
      "Jena",
      "2026-09-30T23:30:00Z",
      "2026-10-01T01:30:00Z",
    );
    const october = await create(
      "Jena",
      "2026-10-04T09:00:00Z",
      "2026-10-04T10:00:00Z",
    );
    await create("Seewiesen", "2026-10-06T09:00:00Z", "2026-10-06T10:00:00Z");
    await create("Jena", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z");
    await create("Jena", "2026-11-01T09:00:00Z", "2026-11-01T10:00:00Z");
    expect(
      await service.query("time_entry_export", {}, principal),
    ).toMatchObject({ total: 5 });
    const range = {
      from: "2026-10-01T00:00:00Z",
      to: "2026-11-01T00:00:00Z",
      employer: "Jena",
    };
    const exported = (await service.query(
      "time_entry_export",
      range,
      principal,
    )) as PageDTO<TimeEntryDTO>;
    expect(exported.items.map((row) => row.entry_id)).toEqual([
      cross.entity_id,
      october.entity_id,
    ]);
    expect(exported.items[0].starts_at).toBe("2026-09-30T23:30:00.000Z");
    await expect(
      service.query(
        "time_entry_export",
        { from: range.to, to: range.from },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await service.query(
        "time_entry_export",
        {},
        { ...principal, ownerId: principal.ownerId + "-other" },
      ),
    ).toMatchObject({ total: 0 });
  });
  it("durable_partial_drafts_are_excluded_from_totals_and_atomic_promotion_rejects_stale_revisions", async () => {
    const first = await execute("time_draft_save", {
      employer: "Jena",
      date: "2030-01-01",
      start: "09:",
      description: "نوشتهٔ ذخیره‌شده",
    });
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      entries: 0,
      minutes: 0,
    });
    expect(await service.query("time_draft_list", {}, principal)).toMatchObject(
      { total: 1, items: [{ description: "نوشتهٔ ذخیره‌شده", start: "09:" }] },
    );
    const saved = await execute(
      "time_draft_save",
      { draft_id: first.entity_id, start: "09:00", end: "10:00" },
      1,
    );
    const promotion = {
      employer: "Jena",
      starts_at: "2030-01-01T08:00:00Z",
      ends_at: "2030-01-01T09:00:00Z",
      draft_id: first.entity_id,
      draft_revision: 1,
    };
    await expect(execute("time_entry_create", promotion)).rejects.toMatchObject(
      { code: "REVISION_CONFLICT" },
    );
    expect(await service.query("time_entry_list", {}, principal)).toMatchObject(
      { total: 0 },
    );
    await execute("time_entry_create", {
      ...promotion,
      draft_revision: saved.version,
    });
    expect(await service.query("time_draft_list", {}, principal)).toMatchObject(
      { total: 0 },
    );
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      entries: 1,
      minutes: 60,
    });
    await expect(
      execute("time_entry_create", { ...promotion, draft_revision: 3 }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  it("work_undo_is_compensating_audited_and_will_not_overwrite_later_device_edits", async () => {
    const entry = await execute("time_entry_create", {
      employer: "Jena",
      starts_at: "2030-01-01T08:00:00Z",
      ends_at: "2030-01-01T09:00:00Z",
      description: "original",
    });
    await execute(
      "time_entry_update",
      {
        entry_id: entry.entity_id,
        ends_at: "2030-01-01T10:00:00Z",
        description: "edited",
      },
      1,
    );
    await expect(
      execute("time_entry_undo", { entry_id: entry.entity_id }, 1),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      await execute("time_entry_undo", { entry_id: entry.entity_id }, 2),
    ).toMatchObject({
      version: 3,
      data: { ends_at: "2030-01-01T09:00:00.000Z", description: "original" },
    });
    expect(
      (
        await database.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND entity_id=$2",
          [principal.ownerId, entry.entity_id],
        )
      ).rows,
    ).toHaveLength(3);
    await execute("time_entry_archive", { entry_id: entry.entity_id }, 3);
    expect(
      await execute("time_entry_undo", { entry_id: entry.entity_id }, 4),
    ).toMatchObject({ version: 5, data: { archived_at: null } });
  });
  it("legacy_import_retains_wall_clock_hours_literal_text_and_incomplete_drafts_with_replay_skip", async () => {
    const data = {
      version: 1,
      revision: 18,
      entries: [
        {
          id: "synthetic-complete",
          jobId: "jena",
          date: "2026-10-25",
          start: "01:30",
          end: "03:30",
          endNextDay: false,
          tasks: "=SUM(A1:A2)\nتوضیحات",
        },
        {
          id: "synthetic-draft",
          jobId: "seewiesen",
          date: "2026-10-25",
          start: "09:",
          end: "",
          tasks: "incomplete",
        },
      ],
    };
    const preview = (await service.query(
      "time_entry_import_preview",
      { data },
      principal,
    )) as PreviewDTO;
    expect(preview.changes).toMatchObject({
      counts: { new: 1, drafts_new: 1 },
      minutes_to_create: 120,
    });
    await execute("time_entry_import_commit", {
      preview_id: preview.preview_id,
    });
    const rows = (await service.query(
      "time_entry_list",
      {},
      principal,
    )) as PageDTO<TimeEntryDTO>;
    expect(rows.items[0]).toMatchObject({
      minutes: 120,
      reported_minutes: 120,
      reporting_policy: "legacy_wall",
      description: "=SUM(A1:A2)\nتوضیحات",
    });
    expect(
      (Date.parse(rows.items[0].ends_at) -
        Date.parse(rows.items[0].starts_at)) /
        60000,
    ).toBe(180);
    const repeated = (await service.query(
      "time_entry_import_preview",
      { data },
      principal,
    )) as PreviewDTO;
    expect(repeated.changes).toMatchObject({
      counts: { new: 0, skipped: 1, drafts_new: 0, drafts_skipped: 1 },
    });
    const current = await execute("time_entry_create", {
      employer: "Jena",
      starts_at: rows.items[0].starts_at,
      ends_at: rows.items[0].ends_at,
    });
    expect(current.data).toMatchObject({
      reporting_policy: "elapsed",
      warnings: ["WORK_INTERVAL_OVERLAP"],
    });
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      minutes: 300,
      overlap_minutes: 180,
    });
    expect(
      await service.query("analytics_summary", {}, principal),
    ).toMatchObject({ time: { minutes: 300 } });
    expect(
      await service.query(
        "analytics_summary",
        {
          from_date: "2026-10-25",
          to_date: "2026-10-26",
          timezone: "Europe/Berlin",
        },
        principal,
      ),
    ).toMatchObject({
      time: { minutes: 300 },
      trends: { days: [{ date: "2026-10-25", minutes: 300 }] },
    });
  });
  it("legacy_ambiguous_and_nonexistent_times_require_resolution_without_partial_import", async () => {
    const raw = {
      version: 1,
      entries: [
        {
          id: "synthetic-fold",
          jobId: "jena",
          date: "2026-10-25",
          start: "02:30",
          end: "03:30",
          tasks: "fold",
        },
      ],
    };
    await expect(
      service.query("time_entry_import_preview", { data: raw }, principal),
    ).rejects.toMatchObject({
      details: { errors: [{ code: "DST_RESOLUTION_REQUIRED" }] },
    });
    const resolved = (await service.query(
      "time_entry_import_preview",
      { data: raw, resolutions: { "synthetic-fold": { start: "earlier" } } },
      principal,
    )) as PreviewDTO;
    expect(resolved.changes).toMatchObject({
      counts: { new: 1 },
      minutes_to_create: 60,
    });
    const gap = {
      version: 1,
      entries: [{ ...raw.entries[0], date: "2027-03-28" }],
    };
    await expect(
      service.query("time_entry_import_preview", { data: gap }, principal),
    ).rejects.toMatchObject({
      details: { errors: [{ code: "INVALID_LOCAL_TIME" }] },
    });
    expect(await service.query("time_entry_list", {}, principal)).toMatchObject(
      { total: 0 },
    );
  });
  it("all_history_export_roundtrips_reporting_metadata_and_drafts_without_duplicates", async () => {
    await execute("time_entry_create", {
      employer: "Jena",
      starts_at: "2029-12-31T22:00:00Z",
      ends_at: "2030-01-01T00:00:00Z",
      description: "overnight",
    });
    const draft = await execute("time_draft_save", {
      date: "2030-01-01",
      start: "08",
      description: "unfinished",
    });
    const exported = (await service.query(
      "time_entry_export",
      {},
      principal,
    )) as PageDTO<Record<string, unknown>>;
    const drafts = (await service.query(
      "time_draft_list",
      {},
      principal,
    )) as PageDTO<TimeDraftDTO>;
    const data = {
      format: "ramin-life-os-time/1",
      timezone: "Europe/Berlin",
      entries: exported.items,
      drafts: drafts.items.map(
        ({
          draft_id,
          employer,
          date,
          start,
          end,
          end_next_day,
          description,
          timezone,
          legacy_metadata,
        }) => ({
          draft_id,
          employer,
          date,
          start,
          end,
          end_next_day,
          description,
          timezone,
          legacy_metadata,
        }),
      ),
    };
    expect(data.drafts[0].draft_id).toBe(draft.entity_id);
    const preview = (await service.query(
      "time_entry_import_preview",
      { data },
      principal,
    )) as PreviewDTO;
    expect(preview.changes).toMatchObject({
      counts: { new: 0, skipped: 1, drafts_new: 0, drafts_skipped: 1 },
    });
  });
  it("legacy_wall_clipping_uses_local_calendar_coordinates_across_DST_month_boundary", () => {
    const row = {
      starts_at: "2024-03-31T01:00:00+01:00",
      ends_at: "2024-04-01T01:00:00+02:00",
      reporting_policy: "legacy_wall",
      reported_minutes: 1440,
      legacy_metadata: { timezone: "Europe/Berlin" },
    };
    expect(workMinutes(row)).toBe(1440);
    expect(
      workMinutes(row, -Infinity, Date.parse("2024-04-01T00:00:00+02:00")),
    ).toBe(1380);
    expect(workMinutes(row, Date.parse("2024-04-01T00:00:00+02:00"))).toBe(60);
    const overlap = workOverlapSummary([
      {
        entry_id: "a",
        starts_at: "2030-01-01T08:00Z",
        ends_at: "2030-01-01T11:00Z",
      },
      {
        entry_id: "b",
        starts_at: "2030-01-01T09:00Z",
        ends_at: "2030-01-01T10:00Z",
      },
      {
        entry_id: "c",
        starts_at: "2030-01-01T09:30Z",
        ends_at: "2030-01-01T10:30Z",
      },
    ]);
    expect(overlap).toMatchObject({ overlap_minutes: 90, overlap_count: 3 });
  });
  it("backup_restore_preserves_drafts_with_reserved_SQL_columns_and_reporting_policy", async () => {
    await execute("time_draft_save", {
      date: "2030-01-01",
      start: "08:",
      end: "",
      description: "unfinished",
    });
    const backup = await service.query("backup_export", {}, principal),
      isolated = await createTestDatabase();
    try {
      const restored = createDomainService(isolated);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restored.query("time_draft_list", {}, principal),
      ).toMatchObject({
        items: [{ start: "08:", end: "", description: "unfinished" }],
        total: 1,
      });
    } finally {
      await isolated.close?.();
    }
  });
});
