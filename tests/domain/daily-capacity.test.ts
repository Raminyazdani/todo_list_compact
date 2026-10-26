import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  DailyCapacityPreviewDTO,
  Principal,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

describe("read-only daily and weekly capacity preview", () => {
  let db: Database;
  const owner = `synthetic-capacity-${randomUUID()}`;
  const principal: Principal = {
    ownerId: owner,
    actorId: "synthetic-capacity-ui",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close?.();
  });
  const service = () => createDomainService(db);
  const preview = async (input: Record<string, unknown>, viewer = principal) =>
    (await service().query(
      "daily_capacity_preview",
      input,
      viewer,
    )) as DailyCapacityPreviewDTO;

  it("unions overlapping busy intervals and reports unknown estimates without scheduling", async () => {
    const known = await service().execute(
        "task_create",
        { title: "Synthetic planned task", estimated_minutes: 60 },
        principal,
        { idempotencyKey: randomUUID() },
      ),
      unknown = await service().execute(
        "task_create",
        { title: "Synthetic unestimated task" },
        principal,
        { idempotencyKey: randomUUID() },
      ),
      done = await service().execute(
        "task_create",
        { title: "Synthetic completed task", estimated_minutes: 90 },
        principal,
        { idempotencyKey: randomUUID() },
      ),
      archived = await service().execute(
        "task_create",
        { title: "Synthetic archived task", estimated_minutes: 120 },
        principal,
        { idempotencyKey: randomUUID() },
      );
    await service().execute(
      "task_complete",
      { task_id: done.entity_id },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    await service().execute(
      "daily_focus_set",
      {
        date: "2026-10-25",
        task_ids: [
          known.entity_id,
          unknown.entity_id,
          done.entity_id,
          archived.entity_id,
        ],
      },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 0 },
    );
    await service().execute(
      "task_archive",
      { task_id: archived.entity_id },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    await db.transaction(owner, async (tx) => {
      await tx.query(
        "INSERT INTO calendar_events(event_id,owner_id,title,starts_at,ends_at) VALUES($1,$2,$3,$4,$5),($6,$2,$7,$8,$9)",
        [
          `CE-${randomUUID()}`,
          owner,
          "Synthetic overlap one",
          "2026-10-25T08:00:00Z",
          "2026-10-25T10:00:00Z",
          `CE-${randomUUID()}`,
          "Synthetic overlap two",
          "2026-10-25T09:00:00Z",
          "2026-10-25T11:00:00Z",
        ],
      );
      await tx.query(
        "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at) VALUES($1,$2,$3,$4,$5)",
        [
          `TE-${randomUUID()}`,
          owner,
          "Synthetic employer",
          "2026-10-25T10:00:00Z",
          "2026-10-25T12:00:00Z",
        ],
      );
    });
    const result = await preview({ date: "2026-10-25", period: "day" });
    expect(result).toMatchObject({
      date: "2026-10-25",
      from_date: "2026-10-25",
      to_date_exclusive: "2026-10-26",
      focus: {
        open_selected_task_count: 2,
        closed_selected_task_count: 1,
        archived_selected_task_count: 1,
        registered_estimate_minutes: 60,
        unknown_estimate_task_ids: [unknown.entity_id],
      },
      calendar: { busy_minutes: 180, complete: true, fresh: true },
      work: { occupied_minutes: 120, entry_count: 1 },
      known_busy_minutes: 240,
      busy_coverage: "complete",
    });
    expect("free_minutes" in result).toBe(false);
    expect(
      await service().query(
        "task_get",
        { task_id: known.entity_id },
        principal,
      ),
    ).toMatchObject({ status: "Inbox", due_date: null, estimated_minutes: 60 });
  });

  it("respects optional calendar and work scopes and Berlin week boundaries across DST", async () => {
    const taskOnly: Principal = { ...principal, scopes: ["tasks:read"] };
    const restricted = await preview({ date: "2026-10-25" }, taskOnly);
    expect(restricted).toMatchObject({
      calendar: { access: "not_granted", busy_minutes: null, complete: null },
      work: { access: "not_granted", occupied_minutes: null },
      known_busy_minutes: null,
      busy_coverage: "unknown",
    });
    await expect(
      preview(
        { date: "2026-10-25" },
        { ...principal, scopes: ["calendar:read", "time:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const selected = (await service().query(
      "daily_focus_get",
      { date: "2026-10-25" },
      principal,
    )) as { task_ids: string[] };
    await service().execute(
      "daily_focus_set",
      { date: "2026-10-24", task_ids: [selected.task_ids[0]] },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 0 },
    );
    const week = await preview({ date: "2026-10-25", period: "week" });
    expect(week).toMatchObject({
      from_date: "2026-10-19",
      to_date_exclusive: "2026-10-26",
      focus: {
        registered_estimate_minutes: 60,
        repeated_task_ids: [selected.task_ids[0]],
      },
      known_busy_minutes: 240,
    });
  });

  it("clips real minutes at 25-hour and 23-hour Berlin day boundaries and marks incomplete cache", async () => {
    await db.transaction(owner, async (tx) => {
      await tx.query(
        "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at) VALUES($1,$2,$3,$4,$5),($6,$2,$3,$7,$8)",
        [
          `TE-${randomUUID()}`,
          owner,
          "Synthetic boundary work",
          "2026-10-25T22:30:00Z",
          "2026-10-25T23:30:00Z",
          `TE-${randomUUID()}`,
          "2026-03-29T21:30:00Z",
          "2026-03-29T22:30:00Z",
        ],
      );
    });
    const autumn = await preview({ date: "2026-10-25", period: "day" });
    expect(autumn).toMatchObject({
      work: { occupied_minutes: 150 },
      known_busy_minutes: 270,
    });
    const spring = await preview({ date: "2026-03-29", period: "day" });
    expect(spring).toMatchObject({
      from_date: "2026-03-29",
      to_date_exclusive: "2026-03-30",
      work: { occupied_minutes: 30 },
      known_busy_minutes: 30,
    });
    const sourceId = `CS-${randomUUID()}`;
    await db.transaction(owner, (tx) =>
      tx.query(
        "INSERT INTO calendar_sources(source_id,owner_id,provider,external_calendar_id,title,status,coverage) VALUES($1,$2,'ical',$3,$4,'pending','{}'::jsonb)",
        [
          sourceId,
          owner,
          "synthetic-private-calendar",
          "Synthetic incomplete source",
        ],
      ),
    );
    const incomplete = await preview({ date: "2026-10-25", period: "day" });
    expect(incomplete).toMatchObject({
      calendar: { complete: false, fresh: false, source_count: 1 },
      busy_coverage: "partial",
      known_busy_minutes: 270,
    });
    expect(incomplete.calendar.source_warnings).toContain(
      "پوشش رویدادهای «Synthetic incomplete source» ناقص است.",
    );
    expect(incomplete.calendar.source_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source_title: "Synthetic incomplete source",
          code: "SOURCE_COVERAGE_INCOMPLETE",
          status: "pending",
          last_success_at: null,
          next_attempt_at: null,
          action: "refresh",
        }),
      ]),
    );
    expect(incomplete.calendar.source_warnings.join(" ")).not.toContain(
      sourceId,
    );
    await db.query(
      "UPDATE calendar_sources SET status='connected',coverage='{\"complete\":true}'::jsonb,last_success_at=now()-interval '11 minutes' WHERE owner_id=$1 AND source_id=$2",
      [owner, sourceId],
    );
    const stale = await preview({ date: "2026-10-25", period: "day" });
    expect(stale.calendar.source_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_STALE",
          status: "connected",
          action: "refresh",
          last_success_at: expect.any(String),
          next_attempt_at: null,
        }),
      ]),
    );
    await db.query(
      "UPDATE calendar_sources SET status='error',last_error='SOURCE_RATE_LIMITED',next_attempt_at=now()+interval '5 minutes' WHERE owner_id=$1 AND source_id=$2",
      [owner, sourceId],
    );
    const limited = await preview({ date: "2026-10-25", period: "day" });
    expect(limited.calendar.source_issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "SOURCE_RATE_LIMITED",
          status: "error",
          action: "wait",
          next_attempt_at: expect.any(String),
        }),
      ]),
    );
  });

  it("measures the full 25-hour autumn and 23-hour spring local days", async () => {
    const isolatedOwner = `synthetic-full-dst-${randomUUID()}`,
      viewer: Principal = {
        ownerId: isolatedOwner,
        actorId: "synthetic-full-dst-ui",
        channel: "UI",
        scopes: ["tasks:read", "time:read"],
      };
    await db.transaction(isolatedOwner, async (tx) => {
      await tx.query("INSERT INTO owners(owner_id) VALUES($1)", [
        isolatedOwner,
      ]);
      await tx.query(
        "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at) VALUES($1,$2,$3,$4,$5),($6,$2,$3,$7,$8)",
        [
          `TE-${randomUUID()}`,
          isolatedOwner,
          "Synthetic all-day work",
          "2026-10-24T22:00:00Z",
          "2026-10-25T23:00:00Z",
          `TE-${randomUUID()}`,
          "2026-03-28T23:00:00Z",
          "2026-03-29T22:00:00Z",
        ],
      );
    });
    expect(await preview({ date: "2026-10-25" }, viewer)).toMatchObject({
      work: { occupied_minutes: 1500 },
      known_busy_minutes: 1500,
      busy_coverage: "partial",
    });
    expect(await preview({ date: "2026-03-29" }, viewer)).toMatchObject({
      work: { occupied_minutes: 1380 },
      known_busy_minutes: 1380,
      busy_coverage: "partial",
    });
  });
});
