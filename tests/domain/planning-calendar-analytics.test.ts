import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  AnalyticsTrendsDTO,
  CommandName,
  DomainService,
  EventDTO,
  PageDTO,
  PlanDTO,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  expectedRevision?: number,
  key = randomUUID(),
) =>
  service.execute(command, input, principal, {
    idempotencyKey: key,
    expectedRevision,
  });
const task = async (title: string, estimated_minutes = 10) => {
  const result = await exec("task_create", { title, estimated_minutes });
  return service.query(
    "task_get",
    { task_id: result.entity_id },
    principal,
  ) as Promise<TaskDTO>;
};
const link = async (dependent: string, prerequisite: string) => {
  const preview = (await service.query(
    "task_dependency_add_preview",
    {
      task_id: dependent,
      prerequisites: [{ task_id: prerequisite }],
    },
    principal,
  )) as PreviewDTO;
  await exec("task_dependency_add_commit", { preview_id: preview.preview_id });
};
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await db.close?.();
});

describe("Canonical recurrence exceptions, scoped planning and historical trends", () => {
  it("time_monthly_summary_clips_cross_month_entries_and_ignores_page_limit", async () => {
    await exec("time_entry_create", {
      employer: "Synthetic overnight",
      starts_at: "2027-03-31T21:30:00Z",
      ends_at: "2027-03-31T23:30:00Z",
    });
    await exec("time_entry_create", {
      employer: "Synthetic day",
      starts_at: "2027-04-01T08:00:00Z",
      ends_at: "2027-04-01T09:00:00Z",
    });
    const range = {
      from: "2027-03-31T22:00:00Z",
      to: "2027-04-30T22:00:00Z",
      limit: 1,
    };
    expect(await service.query("time_summary", range, principal)).toEqual({
      minutes: 150,
      entries: 2,
      employers: { "Synthetic overnight": 90, "Synthetic day": 60 },
    });
    const list = (await service.query(
      "time_entry_list",
      range,
      principal,
    )) as PageDTO<{ minutes: number }>;
    expect(list.items[0].minutes).toBe(120);
    expect(list.total).toBe(2);
    expect(
      await service.query(
        "time_summary",
        { from: "2027-02-28T23:00:00Z", to: range.from },
        principal,
      ),
    ).toMatchObject({ minutes: 30 });
    await expect(
      service.query(
        "time_summary",
        { from: range.to, to: range.from },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("calendar_exdates_persist_skip_dst_occurrence_and_note_retry_preserves_series", async () => {
    const created = await exec("calendar_create_local_event", {
      title: "Weekly synthetic series",
      starts_at: "2027-03-21T09:00:00Z",
      ends_at: "2027-03-21T10:00:00Z",
      timezone: "Europe/Berlin",
      recurrence_rule: "FREQ=WEEKLY;COUNT=4",
      recurrence_exceptions: ["2027-03-28", "2027-04-04T10:00", "2027-03-28"],
    });
    const input = {
        event_id: created.entity_id,
        notes: "Owner-reviewed note only",
      },
      key = randomUUID();
    const changed = await exec(
      "calendar_update_local_event",
      input,
      created.version,
      key,
    );
    const repeated = await exec(
      "calendar_update_local_event",
      input,
      created.version,
      key,
    );
    expect(repeated.replayed).toBe(true);
    expect(repeated.version).toBe(changed.version);
    const events = (await service.query(
      "calendar_events_query",
      {
        from: "2027-03-20T00:00:00Z",
        to: "2027-04-15T00:00:00Z",
      },
      principal,
    )) as PageDTO<EventDTO>;
    expect(events.total).toBe(2);
    expect(events.items.map((event) => event.starts_at)).toEqual([
      "2027-03-21T09:00:00.000Z",
      "2027-04-11T08:00:00.000Z",
    ]);
    expect(events.items[1]).toMatchObject({
      series_starts_at: "2027-03-21T09:00:00.000Z",
      series_ends_at: "2027-03-21T10:00:00.000Z",
      notes: input.notes,
      recurrence_rule: "FREQ=WEEKLY;COUNT=4",
      recurrence_exceptions: ["2027-03-28", "2027-04-04T10:00:00"],
    });
    await exec(
      "calendar_update_local_event",
      { event_id: created.entity_id, recurrence_exceptions: [] },
      changed.version,
    );
    expect(
      await service.query(
        "calendar_events_query",
        {
          from: "2027-03-20T00:00:00Z",
          to: "2027-04-15T00:00:00Z",
        },
        principal,
      ),
    ).toMatchObject({ total: 4 });
  });
  it("calendar_exception_and_rrule_failures_are_atomic_and_whole_series_move_requires_explicit_intent", async () => {
    const created = await exec("calendar_create_local_event", {
      title: "Weekly",
      starts_at: "2027-03-21T09:00:00Z",
      ends_at: "2027-03-21T10:00:00Z",
      recurrence_rule: "FREQ=WEEKLY;COUNT=3",
    });
    for (const recurrence_exceptions of [
      null,
      {},
      [4],
      ["2027-02-30"],
      ["2027-03-28T25:00"],
      ["2027-03-28T10:00Z"],
      Array(1001).fill("2027-03-28"),
    ])
      await expect(
        exec(
          "calendar_update_local_event",
          { event_id: created.entity_id, recurrence_exceptions },
          created.version,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const recurrence_rule of [
      "FREQ=DAILY;COUNT=0",
      "FREQ=DAILY;INTERVAL=0",
      "FREQ=WEEKLY;BYDAY=XX",
    ])
      await expect(
        exec(
          "calendar_update_local_event",
          { event_id: created.entity_id, recurrence_rule },
          created.version,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const move = {
      event_id: created.entity_id,
      starts_at: "2027-03-28T08:00:00Z",
      ends_at: "2027-03-28T09:00:00Z",
    };
    await expect(
      exec("calendar_update_local_event", move, created.version),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const retained = (
      await db.query<{ revision: number; starts_at: Date }>(
        "SELECT revision,starts_at FROM calendar_events WHERE event_id=$1",
        [created.entity_id],
      )
    ).rows[0];
    expect(retained.revision).toBe(created.version);
    expect(new Date(retained.starts_at).toISOString()).toBe(
      "2027-03-21T09:00:00.000Z",
    );
    const committed = await exec(
      "calendar_update_local_event",
      { ...move, apply_to_series: true },
      created.version,
    );
    expect(committed.version).toBe(created.version + 1);
  });
  it("all_day_exdate_uses_local_date_and_preserves_exclusive_end_across_dst", async () => {
    await exec("calendar_create_local_event", {
      title: "Daily all-day",
      starts_at: "2027-03-26T23:00:00Z",
      ends_at: "2027-03-27T23:00:00Z",
      timezone: "Europe/Berlin",
      all_day: true,
      recurrence_rule: "FREQ=DAILY;COUNT=3",
      recurrence_exceptions: ["2027-03-27"],
    });
    const events = (await service.query(
      "calendar_events_query",
      { from: "2027-03-26T00:00:00Z", to: "2027-03-31T00:00:00Z" },
      principal,
    )) as PageDTO<EventDTO>;
    expect(events.total).toBe(2);
    expect(events.items[0]).toMatchObject({
      starts_at: "2027-03-27T23:00:00.000Z",
      ends_at: "2027-03-28T22:00:00.000Z",
    });
    expect(events.items[1]).toMatchObject({
      starts_at: "2027-03-28T22:00:00.000Z",
      ends_at: "2027-03-29T22:00:00.000Z",
    });
  });
  it("plan_selected_owner_context_matches_graph_and_subset_discloses_missing_external_gate", async () => {
    const a = await task("A dependent"),
      b = await task("B middle", 20),
      c = await task("C prerequisite", 30),
      d = await task("Unrelated", 100);
    await link(a.task_id, b.task_id);
    await link(b.task_id, c.task_id);
    const context = {
      task_id: a.task_id,
      direction: "upstream",
      search: "A dependent",
      status: "Done",
      project_id: "other",
    };
    const graph = (await service.query(
      "task_graph_get",
      context,
      principal,
    )) as { nodes: TaskDTO[] };
    const plan = (await service.query(
      "dependency_topological_plan",
      context,
      principal,
    )) as PlanDTO;
    expect(new Set(plan.levels.flat())).toEqual(
      new Set(graph.nodes.map((node) => node.task_id)),
    );
    expect(plan.critical_path).toEqual([c.task_id, b.task_id, a.task_id]);
    expect(plan.total_estimated_minutes).toBe(60);
    expect(plan.levels.flat()).not.toContain(d.task_id);
    const subset = (await service.query(
      "dependency_topological_plan",
      { task_ids: [a.task_id, a.task_id], limit: 1 },
      principal,
    )) as PlanDTO;
    expect(subset.levels).toEqual([[a.task_id]]);
    expect(subset.ready_task_ids).toEqual([]);
    expect(subset.critical_path).toBeNull();
    expect(subset.hidden_neighbor_count).toBe(1);
    expect(subset.schedule_risks).toContainEqual({
      task_id: a.task_id,
      prerequisite_task_id: b.task_id,
      reason: "PREREQUISITE_OUTSIDE_SELECTED_PLAN",
    });
    const downstream = (await service.query(
      "dependency_topological_plan",
      { task_id: c.task_id, direction: "downstream" },
      principal,
    )) as PlanDTO;
    expect(downstream.levels.flat()).toEqual([c.task_id, b.task_id, a.task_id]);
  });
  it("plan_rejects_malformed_oversize_or_foreign_ids_before_returning_partial_result", async () => {
    const a = await task("Owner task");
    const other = { ...principal, ownerId: `synthetic-${randomUUID()}` };
    const foreign = await service.execute(
      "task_create",
      { title: "Foreign" },
      other,
      { idempotencyKey: randomUUID() },
    );
    for (const input of [
      { task_ids: [] },
      { task_ids: "all" },
      { task_ids: [a.task_id, 1] },
      { task_ids: Array(201).fill(a.task_id) },
      { task_ids: [a.task_id], task_id: a.task_id },
      { task_id: a.task_id, direction: "invalid" },
    ])
      await expect(
        service.query("dependency_topological_plan", input, principal),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.query(
        "dependency_topological_plan",
        { task_ids: [a.task_id, foreign.entity_id] },
        principal,
      ),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("analytics_uses_all_owner_tasks_and_keeps_reopened_completion_history_without_retry_double_count", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-03-31T12:00:00Z"));
    const a = await task("Fixture owner"),
      done = await task("Completed"),
      reopened = await task("Reopened");
    await db.query(
      "UPDATE tasks SET created_at='2026-01-01T00:00:00Z' WHERE owner_id=$1",
      [principal.ownerId],
    );
    await db.query(
      `INSERT INTO tasks(task_id,owner_id,title,created_at) SELECT $1||'-'||n,$1,'Synthetic load '||n,'2027-03-27T23:30:00Z'::timestamptz FROM generate_series(1,205) n`,
      [principal.ownerId],
    );
    await db.query(
      "UPDATE tasks SET status='Done',completed_at='2027-03-28T01:40:00Z' WHERE task_id=$1",
      [done.task_id],
    );
    for (const [taskId, completedAt] of [
      [done.task_id, "2027-03-28T01:40:00Z"],
      [reopened.task_id, "2027-03-27T22:30:00Z"],
    ])
      await db.query(
        `INSERT INTO activity_events(event_id,owner_id,entity_id,event_type,actor_id,channel,operation_id,before,after,occurred_at)
        VALUES($1,$2,$3,'task_complete','synthetic-owner','UI',$4,'{"status":"Inbox"}'::jsonb,$5::jsonb,$6)`,
        [
          randomUUID(),
          principal.ownerId,
          taskId,
          randomUUID(),
          JSON.stringify({ status: "Done", completed_at: completedAt }),
          completedAt,
        ],
      );
    const analytics = (await service.query(
      "analytics_summary",
      { limit: 1, timezone: "Europe/Berlin" },
      principal,
    )) as { tasks: { total: number }; trends: AnalyticsTrendsDTO };
    expect(analytics.tasks.total).toBe(208);
    expect(analytics.trends.weeks).toHaveLength(12);
    expect(analytics.trends.from_date).toBe("2027-01-11");
    expect(
      analytics.trends.days.find((day) => day.date === "2027-03-28"),
    ).toMatchObject({ created: 205, completed: 1 });
    expect(
      analytics.trends.days.find((day) => day.date === "2027-03-27"),
    ).toMatchObject({ completed: 1 });
    expect(
      analytics.trends.days.reduce((sum, day) => sum + day.completed, 0),
    ).toBe(2);
    expect(
      analytics.trends.weeks.reduce((sum, week) => sum + week.created, 0),
    ).toBe(205);
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: a.task_id },
          principal,
        )) as TaskDTO
      ).status,
    ).toBe("Inbox");
  });
  it("analytics_elapsed_minutes_split_overnight_dst_and_clip_window_with_time_scope_enforced", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-03-31T12:00:00Z"));
    const a = await task("Owner task");
    await exec("time_entry_create", {
      employer: "Synthetic",
      starts_at: "2027-03-27T22:30:00Z",
      ends_at: "2027-03-28T02:30:00Z",
      task_id: a.task_id,
    });
    await exec("time_entry_create", {
      employer: "Synthetic",
      starts_at: "2027-01-10T22:30:00Z",
      ends_at: "2027-01-10T23:30:00Z",
    });
    const analytics = (await service.query(
      "analytics_summary",
      {},
      principal,
    )) as { trends: AnalyticsTrendsDTO };
    expect(
      analytics.trends.days.find((day) => day.date === "2027-03-27")?.minutes,
    ).toBe(30);
    expect(
      analytics.trends.days.find((day) => day.date === "2027-03-28")?.minutes,
    ).toBe(210);
    expect(analytics.trends.days[0].minutes).toBe(30);
    expect(
      analytics.trends.weeks.reduce((sum, week) => sum + week.minutes, 0),
    ).toBe(270);
    const restricted = (await service.query(
      "analytics_summary",
      {},
      { ...principal, scopes: ["tasks:read"] },
    )) as { trends: AnalyticsTrendsDTO; time: { minutes: number } };
    expect(restricted.trends.time_scope_granted).toBe(false);
    expect(restricted.trends.days.every((day) => day.minutes === 0)).toBe(true);
    expect(restricted.time.minutes).toBe(0);
    await expect(
      service.query(
        "analytics_summary",
        { timezone: "Invalid/Zone" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
