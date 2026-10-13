import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import { MIGRATION_SQL } from "../../server/db/schema";
import type {
  CommandName,
  DomainService,
  EventDTO,
  PageDTO,
  PreviewDTO,
  Principal,
  ProjectDTO,
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
const series = async (extra: Record<string, unknown> = {}) =>
  exec("calendar_create_local_event", {
    title: "Synthetic recurring appointment",
    starts_at: "2027-03-21T09:00:00Z",
    ends_at: "2027-03-21T10:00:00Z",
    timezone: "Europe/Berlin",
    recurrence_rule: "FREQ=WEEKLY;COUNT=4",
    notes: "Original series note",
    ...extra,
  });
const preview = (
  eventId: string,
  extra: Record<string, unknown> = {},
  actor = principal,
) =>
  service.query(
    "calendar_occurrence_reschedule_preview",
    {
      event_id: eventId,
      occurrence_starts_at: "2027-03-28T08:00:00Z",
      starts_at: "2027-03-28T09:30:00Z",
      ends_at: "2027-03-28T10:30:00Z",
      ...extra,
    },
    actor,
  ) as Promise<PreviewDTO>;
const events = () =>
  service.query(
    "calendar_events_query",
    {
      from: "2027-03-20T00:00:00Z",
      to: "2027-04-15T00:00:00Z",
      limit: 200,
    },
    principal,
  ) as Promise<PageDTO<EventDTO>>;
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
afterAll(async () => {
  await db.close?.();
});

describe("Atomic local calendar occurrence overrides and project lifecycle", () => {
  it("override_edit_invalidates_master_preview_and_whole_series_delete_cancels_all_local_overrides", async () => {
    const master = await series(),
      first = await preview(master.entity_id),
      move = await exec("calendar_occurrence_reschedule_commit", {
        preview_id: first.preview_id,
      });
    const second = await preview(master.entity_id, {
      occurrence_starts_at: "2027-04-04T08:00:00Z",
      starts_at: "2027-04-05T10:00:00Z",
      ends_at: "2027-04-05T11:00:00Z",
    });
    await exec("calendar_occurrence_reschedule_commit", {
      preview_id: second.preview_id,
    });
    const stale = await preview(master.entity_id, {
      occurrence_starts_at: "2027-04-11T08:00:00Z",
      starts_at: "2027-04-12T10:00:00Z",
      ends_at: "2027-04-12T11:00:00Z",
    });
    const edited = await exec(
      "calendar_update_local_event",
      { event_id: move.entity_id, notes: "Reviewed moved appointment" },
      move.version,
    );
    expect(edited.data).toMatchObject({ series_revision: 4 });
    await expect(
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: stale.preview_id,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const archived = await exec(
      "calendar_delete_local_event",
      { event_id: master.entity_id },
      4,
    );
    expect((await events()).total).toBe(0);
    const children = (
      await db.query<{ archived_at: unknown; revision: number }>(
        "SELECT archived_at,revision FROM calendar_events WHERE owner_id=$1 AND series_event_id=$2",
        [principal.ownerId, master.entity_id],
      )
    ).rows;
    expect(children).toHaveLength(2);
    expect(
      children.every(
        (child) => child.archived_at !== null && child.revision >= 2,
      ),
    ).toBe(true);
    expect(
      (
        await db.query<{ event_type: string }>(
          "SELECT event_type FROM activity_events WHERE operation_id=$1 AND owner_id=$2",
          [archived.operation_id, principal.ownerId],
        )
      ).rows.map((row) => row.event_type),
    ).toContain("calendar.series_overrides_archived");
  });
  it("deadline_and_archive_queries_filter_complete_owner_inventory_before_pagination", async () => {
    const byDate = await exec("task_create", {
        title: "April date",
        due_date: "2027-04-10",
      }),
      byInstant = await exec("task_create", {
        title: "Berlin April instant",
        due_at: "2027-03-31T22:30:00Z",
      }),
      expired = await exec("task_create", {
        title: "Actually overdue",
        due_date: "2020-01-01",
      }),
      archived = await exec("task_create", {
        title: "Archived April",
        due_date: "2027-04-20",
      });
    await exec("task_create", {
      title: "Exclusive next month",
      due_date: "2027-05-01",
    });
    await db.query(
      "INSERT INTO tasks(task_id,owner_id,title) SELECT $1||'-inventory-'||n,$1,'Synthetic other inventory '||n FROM generate_series(1,205) n",
      [principal.ownerId],
    );
    await exec(
      "task_archive",
      { task_id: archived.entity_id },
      archived.version,
    );
    const range = { due_from: "2027-04-01", due_to: "2027-05-01", limit: 1 };
    const first = (await service.query(
      "task_search",
      range,
      principal,
    )) as PageDTO<{ task_id: string }>;
    expect(first.total).toBe(2);
    expect(first.next_cursor).not.toBeNull();
    const second = (await service.query(
      "task_search",
      { ...range, cursor: first.next_cursor },
      principal,
    )) as PageDTO<{ task_id: string }>;
    expect(
      new Set([...first.items, ...second.items].map((task) => task.task_id)),
    ).toEqual(new Set([byDate.entity_id, byInstant.entity_id]));
    expect(
      await service.query(
        "task_search",
        { archived_only: true, limit: 1 },
        principal,
      ),
    ).toMatchObject({ total: 1, items: [{ task_id: archived.entity_id }] });
    expect(
      await service.query("task_search", { overdue: true }, principal),
    ).toMatchObject({ total: 1, items: [{ task_id: expired.entity_id }] });
    expect(
      await service.query("task_graph_get", range, principal),
    ).toMatchObject({ total: 2 });
    const edge = (await service.query(
      "task_dependency_add_preview",
      {
        task_id: byDate.entity_id,
        prerequisites: [{ task_id: expired.entity_id }],
      },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_add_commit", { preview_id: edge.preview_id });
    expect(
      await service.query(
        "task_graph_get",
        {
          task_id: byDate.entity_id,
          direction: "upstream",
          due_from: "invalid",
          overdue: true,
          archived_only: true,
        },
        principal,
      ),
    ).toMatchObject({ total: 2 });
    await expect(
      service.query("task_search", { due_from: "2027-02-30" }, principal),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.query(
        "task_search",
        { due_from: "2027-05-01", due_to: "2027-04-01" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("single_occurrence_preview_commit_retry_preserves_series_tasks_and_append_only_audit", async () => {
    const task = await exec("task_create", {
        title: "Independent task",
        due_date: "2027-05-01",
      }),
      master = await series({ task_id: task.entity_id }),
      plan = await preview(master.entity_id);
    expect((await events()).total).toBe(4);
    expect(plan.command).toBe("calendar_occurrence_reschedule_commit");
    expect(plan.changes).toMatchObject({
      original: { starts_at: "2027-03-28T08:00:00.000Z" },
      override: {
        starts_at: "2027-03-28T09:30:00.000Z",
        recurrence_id: "2027-03-28T10:00:00",
      },
      series: { starts_at: "2027-03-21T09:00:00.000Z" },
    });
    const key = randomUUID(),
      result = await exec(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        undefined,
        key,
      );
    const retry = await exec(
      "calendar_occurrence_reschedule_commit",
      { preview_id: plan.preview_id },
      undefined,
      key,
    );
    expect(retry).toMatchObject({
      entity_id: result.entity_id,
      version: 1,
      replayed: true,
    });
    expect(result.data).toMatchObject({
      series_event_id: master.entity_id,
      original_occurrence_starts_at: "2027-03-28T08:00:00.000Z",
      recurrence_id: "2027-03-28T10:00:00",
      recurrence_rule: null,
      task_id: task.entity_id,
      series_revision: 2,
    });
    const after = await events();
    expect(after.total).toBe(4);
    expect(
      after.items.some(
        (event) => event.starts_at === "2027-03-28T08:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      after.items.filter((event) => event.event_id === result.entity_id),
    ).toHaveLength(1);
    expect(
      after.items.find((event) => event.event_id === master.entity_id),
    ).toMatchObject({
      series_starts_at: "2027-03-21T09:00:00.000Z",
      recurrence_rule: "FREQ=WEEKLY;COUNT=4",
      recurrence_exceptions: ["2027-03-28T10:00:00"],
      notes: "Original series note",
      revision: 2,
    });
    expect(
      await service.query("task_get", { task_id: task.entity_id }, principal),
    ).toMatchObject({ status: "Inbox", revision: 1, due_date: "2027-05-01" });
    const audit = (
      await db.query<{ event_type: string; entity_id: string }>(
        "SELECT event_type,entity_id FROM activity_events WHERE owner_id=$1 AND operation_id=$2",
        [principal.ownerId, result.operation_id],
      )
    ).rows;
    expect(audit).toHaveLength(2);
    expect(audit).toContainEqual({
      event_type: "calendar.occurrence_excluded",
      entity_id: master.entity_id,
    });
    expect(audit).toContainEqual({
      event_type: "calendar_occurrence_reschedule_commit",
      entity_id: result.entity_id,
    });
  });
  it("occurrence_owner_scope_actor_and_external_source_boundaries_fail_closed", async () => {
    const master = await series(),
      plan = await preview(master.entity_id);
    await expect(
      preview(master.entity_id, {}, { ...principal, channel: "AI" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      preview(
        master.entity_id,
        {},
        { ...principal, scopes: ["calendar:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id, explicit_user_intent: true },
        { ...principal, scopes: ["calendar:read"], channel: "MCP" },
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        { ...principal, actorId: "different-actor" },
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const foreign = { ...principal, ownerId: `synthetic-${randomUUID()}` };
    await expect(preview(master.entity_id, {}, foreign)).rejects.toMatchObject({
      code: "ENTITY_NOT_FOUND",
    });
    await expect(
      service.execute(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        foreign,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    await service.execute(
      "calendar_create_local_event",
      {
        title: "Foreign local event",
        starts_at: "2027-03-28T08:00Z",
        ends_at: "2027-03-28T09:00Z",
      },
      foreign,
      { idempotencyKey: randomUUID() },
    );
    await expect(
      db.query(
        `INSERT INTO calendar_events(event_id,owner_id,title,starts_at,ends_at,series_event_id,original_occurrence_starts_at,recurrence_id)
      VALUES($1,$2,'Foreign forged override','2027-03-28T08:00Z','2027-03-28T09:00Z',$3,'2027-03-28T08:00Z','2027-03-28T10:00:00')`,
        [randomUUID(), foreign.ownerId, master.entity_id],
      ),
    ).rejects.toBeDefined();
    const authorizedClient = {
      ...principal,
      channel: "MCP" as const,
      scopes: ["calendar:write"],
    };
    const authorizedPreview = await preview(
      master.entity_id,
      {},
      authorizedClient,
    );
    await service.execute(
      "calendar_occurrence_reschedule_commit",
      { preview_id: authorizedPreview.preview_id },
      authorizedClient,
      { idempotencyKey: randomUUID() },
    );
    await db.query(
      "UPDATE calendar_events SET provider='google' WHERE event_id=$1",
      [master.entity_id],
    );
    await expect(preview(master.entity_id)).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSIONS",
    });
    expect(
      (
        await db.query(
          "SELECT event_id FROM calendar_events WHERE owner_id=$1 AND series_event_id IS NOT NULL",
          [principal.ownerId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("occurrence_must_match_live_expansion_and_valid_target_interval", async () => {
    const master = await series({ recurrence_exceptions: ["2027-04-04"] });
    for (const invalid of [
      { occurrence_starts_at: "2027-03-29T08:00:00Z" },
      { occurrence_starts_at: "2027-04-04T08:00:00Z" },
      { ends_at: "2027-03-28T09:00:00Z" },
      { all_day: "yes" },
      { timezone: "Invalid/Zone" },
      { starts_at: "2027-03-28T09:30" },
    ])
      await expect(preview(master.entity_id, invalid)).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
    const localSingle = await exec("calendar_create_local_event", {
      title: "Single",
      starts_at: "2027-03-28T08:00:00Z",
      ends_at: "2027-03-28T09:00:00Z",
    });
    await expect(preview(localSingle.entity_id)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await exec(
      "calendar_delete_local_event",
      { event_id: master.entity_id },
      master.version,
    );
    await expect(preview(master.entity_id)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
  it("concurrent_occurrence_previews_allow_one_move_and_reject_stale_second_without_duplicates", async () => {
    const master = await series(),
      a = await preview(master.entity_id),
      b = await preview(master.entity_id, {
        starts_at: "2027-03-29T10:00:00Z",
        ends_at: "2027-03-29T11:00:00Z",
      });
    const results = await Promise.allSettled([
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: a.preview_id,
      }),
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: b.preview_id,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason),
    ).toMatchObject([{ code: "REVISION_CONFLICT" }]);
    expect((await events()).total).toBe(4);
    expect(
      (
        await db.query(
          "SELECT event_id FROM calendar_events WHERE owner_id=$1 AND series_event_id=$2",
          [principal.ownerId, master.entity_id],
        )
      ).rows,
    ).toHaveLength(1);
    await expect(
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: a.preview_id,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
  });
  it("intervening_master_edit_or_expired_preview_does_not_exclude_or_create_occurrence", async () => {
    const master = await series(),
      a = await preview(master.entity_id),
      b = await preview(master.entity_id);
    await db.query(
      "UPDATE command_previews SET expires_at='2000-01-01' WHERE preview_id=$1",
      [b.preview_id],
    );
    await expect(
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: b.preview_id,
      }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await exec(
      "calendar_update_local_event",
      { event_id: master.entity_id, notes: "Owner intervening edit" },
      master.version,
    );
    await expect(
      exec("calendar_occurrence_reschedule_commit", {
        preview_id: a.preview_id,
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect((await events()).total).toBe(4);
    expect(
      (
        await db.query<{ recurrence_exceptions: unknown[] }>(
          "SELECT recurrence_exceptions FROM calendar_events WHERE event_id=$1",
          [master.entity_id],
        )
      ).rows[0].recurrence_exceptions,
    ).toEqual([]);
  });
  it("override_insert_failure_rolls_back_exdate_revision_preview_and_same_key_can_retry", async () => {
    const master = await series(),
      plan = await preview(master.entity_id),
      key = randomUUID();
    await db.query(
      "UPDATE command_previews SET input=jsonb_set(input,'{override_event_id}',to_jsonb($2::text)) WHERE preview_id=$1",
      [plan.preview_id, master.entity_id],
    );
    await expect(
      exec(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        undefined,
        key,
      ),
    ).rejects.toBeDefined();
    expect(
      (
        await db.query<{ revision: number; recurrence_exceptions: unknown[] }>(
          "SELECT revision,recurrence_exceptions FROM calendar_events WHERE event_id=$1",
          [master.entity_id],
        )
      ).rows[0],
    ).toEqual({ revision: 1, recurrence_exceptions: [] });
    expect(
      (
        await db.query<{ consumed_at: unknown }>(
          "SELECT consumed_at FROM command_previews WHERE preview_id=$1",
          [plan.preview_id],
        )
      ).rows[0].consumed_at,
    ).toBeNull();
    expect(
      (
        await db.query(
          "SELECT idempotency_key FROM idempotency_operations WHERE owner_id=$1 AND idempotency_key=$2",
          [principal.ownerId, key],
        )
      ).rows,
    ).toHaveLength(0);
    await db.query(
      "UPDATE command_previews SET input=$2::jsonb WHERE preview_id=$1",
      [plan.preview_id, JSON.stringify(plan.input)],
    );
    await exec(
      "calendar_occurrence_reschedule_commit",
      { preview_id: plan.preview_id },
      undefined,
      key,
    );
    expect((await events()).total).toBe(4);
  });
  it("all_day_and_ambiguous_autumn_occurrence_move_preserve_date_specific_identity", async () => {
    const allDay = await series({
      starts_at: "2027-03-26T23:00:00Z",
      ends_at: "2027-03-27T23:00:00Z",
      all_day: true,
      recurrence_rule: "FREQ=DAILY;COUNT=3",
    });
    await expect(
      preview(allDay.entity_id, {
        occurrence_starts_at: "2027-03-27T23:00:00Z",
        starts_at: "2027-03-30T08:00:00Z",
        ends_at: "2027-03-31T08:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const p = await preview(allDay.entity_id, {
        occurrence_starts_at: "2027-03-27T23:00:00Z",
        starts_at: "2027-03-30T22:00:00Z",
        ends_at: "2027-03-31T22:00:00Z",
      }),
      moved = await exec("calendar_occurrence_reschedule_commit", {
        preview_id: p.preview_id,
      });
    expect(moved.data).toMatchObject({
      recurrence_id: "2027-03-28",
      all_day: true,
      starts_at: "2027-03-30T22:00:00.000Z",
      ends_at: "2027-03-31T22:00:00.000Z",
    });
    const autumn = await series({
      starts_at: "2027-10-24T00:30:00Z",
      ends_at: "2027-10-24T01:30:00Z",
      recurrence_rule: "FREQ=WEEKLY;COUNT=2",
    });
    await expect(
      preview(autumn.entity_id, {
        occurrence_starts_at: "2027-10-31T01:30:00Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const fold = await preview(autumn.entity_id, {
      occurrence_starts_at: "2027-10-31T00:30:00Z",
      starts_at: "2027-10-31T01:30:00Z",
      ends_at: "2027-10-31T02:30:00Z",
    });
    const committed = await exec("calendar_occurrence_reschedule_commit", {
      preview_id: fold.preview_id,
    });
    expect(committed.data).toMatchObject({
      recurrence_id: "2027-10-31T02:30:00",
      original_occurrence_starts_at: "2027-10-31T00:30:00.000Z",
      starts_at: "2027-10-31T01:30:00.000Z",
    });
  });
  it("moved_occurrence_exclusion_and_series_structure_cannot_be_silently_rewritten", async () => {
    const master = await series(),
      p = await preview(master.entity_id),
      move = await exec("calendar_occurrence_reschedule_commit", {
        preview_id: p.preview_id,
      });
    await expect(
      exec(
        "calendar_update_local_event",
        { event_id: master.entity_id, recurrence_exceptions: [] },
        2,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec(
        "calendar_update_local_event",
        {
          event_id: master.entity_id,
          starts_at: "2027-03-21T10:00:00Z",
          ends_at: "2027-03-21T11:00:00Z",
          apply_to_series: true,
        },
        2,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec(
        "calendar_update_local_event",
        { event_id: move.entity_id, recurrence_rule: "FREQ=DAILY" },
        move.version,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await exec(
      "calendar_update_local_event",
      { event_id: master.entity_id, notes: "Reviewed metadata" },
      2,
    );
    await exec(
      "calendar_update_local_event",
      {
        event_id: move.entity_id,
        starts_at: "2027-03-29T12:00:00Z",
        ends_at: "2027-03-29T13:00:00Z",
      },
      move.version,
    );
    expect((await events()).total).toBe(4);
    await expect(
      db.query(
        "UPDATE calendar_events SET recurrence_id='forged' WHERE event_id=$1",
        [move.entity_id],
      ),
    ).rejects.toBeDefined();
  });
  it("backup_restore_keeps_deferred_owner_provenance_and_accepted_move_retry", async () => {
    const master = await series(),
      plan = await preview(master.entity_id),
      key = randomUUID(),
      moved = await exec(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        undefined,
        key,
      );
    const backup = await service.query("backup_export", {}, principal),
      restoredDb = await createTestDatabase();
    try {
      const restored = createDomainService(restoredDb);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const replay = await restored.execute(
        "calendar_occurrence_reschedule_commit",
        { preview_id: plan.preview_id },
        principal,
        { idempotencyKey: key },
      );
      expect(replay).toMatchObject({
        entity_id: moved.entity_id,
        replayed: true,
      });
      const output = (await restored.query(
        "calendar_events_query",
        { from: "2027-03-20T00:00:00Z", to: "2027-04-15T00:00:00Z" },
        principal,
      )) as PageDTO<EventDTO>;
      expect(output.total).toBe(4);
      expect(
        output.items.find((event) => event.event_id === moved.entity_id),
      ).toMatchObject({
        series_event_id: master.entity_id,
        recurrence_id: "2027-03-28T10:00:00",
      });
    } finally {
      await restoredDb.close?.();
    }
  });
  it("project_archive_restore_is_owner_revision_retry_safe_without_task_or_milestone_cascade", async () => {
    const project = await exec("project_create", {
        title: "Synthetic project",
      }),
      task = await exec("task_create", {
        title: "Persistent child",
        project_id: project.entity_id,
      }),
      milestone = await exec("project_milestone_create", {
        project_id: project.entity_id,
        title: "Persistent checkpoint",
        due_date: "2027-05-01",
        task_id: task.entity_id,
      }),
      key = randomUUID();
    const archived = await exec(
      "project_archive",
      { project_id: project.entity_id },
      project.version,
      key,
    );
    expect(
      await exec(
        "project_archive",
        { project_id: project.entity_id },
        project.version,
        key,
      ),
    ).toMatchObject({ replayed: true, version: archived.version });
    expect(await service.query("project_list", {}, principal)).toMatchObject({
      total: 0,
    });
    const archivedList = (await service.query(
      "project_list",
      { archived_only: true },
      principal,
    )) as PageDTO<ProjectDTO>;
    expect(archivedList.items[0]).toMatchObject({
      project_id: project.entity_id,
      status: "Active",
      total: 1,
    });
    expect(
      await service.query(
        "project_list",
        { include_archived: true },
        principal,
      ),
    ).toMatchObject({ total: 1 });
    expect(
      await service.query("task_get", { task_id: task.entity_id }, principal),
    ).toMatchObject({ revision: 1, status: "Inbox", archived_at: null });
    expect(
      await service.query(
        "project_milestone_list",
        { project_id: project.entity_id },
        principal,
      ),
    ).toMatchObject({
      total: 1,
      items: [{ milestone_id: milestone.entity_id }],
    });
    await expect(
      exec(
        "project_restore",
        { project_id: project.entity_id },
        project.version,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      service.execute(
        "project_restore",
        { project_id: project.entity_id },
        { ...principal, ownerId: `synthetic-${randomUUID()}` },
        { idempotencyKey: randomUUID(), expectedRevision: archived.version },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await exec(
      "project_restore",
      { project_id: project.entity_id },
      archived.version,
    );
    expect(await service.query("project_list", {}, principal)).toMatchObject({
      total: 1,
    });
    expect(
      await service.query("project_list", { archived_only: true }, principal),
    ).toMatchObject({ total: 0 });
  });
  it("additive_calendar_migration_preserves_preexisting_rows_and_is_idempotent", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(MIGRATION_SQL);
      await pg.exec(`INSERT INTO owners(owner_id) VALUES('synthetic-upgrade');
        INSERT INTO calendar_events(event_id,owner_id,title,starts_at,ends_at,recurrence_rule) VALUES('synthetic-existing','synthetic-upgrade','Existing series','2027-03-21T09:00Z','2027-03-21T10:00Z','FREQ=WEEKLY;COUNT=2');
      `);
      await pg.exec(`DROP TRIGGER calendar_provenance_immutable ON calendar_events;
        ALTER TABLE calendar_events DROP CONSTRAINT calendar_override_owner_fk;
        ALTER TABLE calendar_events DROP CONSTRAINT calendar_override_metadata_check;
        ALTER TABLE calendar_events DROP COLUMN series_event_id;
        ALTER TABLE calendar_events DROP COLUMN original_occurrence_starts_at;
        ALTER TABLE calendar_events DROP COLUMN recurrence_id;`);
      await pg.exec(MIGRATION_SQL);
      await pg.exec(MIGRATION_SQL);
      const row = (
        await pg.query<{
          title: string;
          revision: number;
          recurrence_rule: string;
          series_event_id: string | null;
        }>(
          "SELECT title,revision,recurrence_rule,series_event_id FROM calendar_events WHERE event_id='synthetic-existing'",
        )
      ).rows[0];
      expect(row).toEqual({
        title: "Existing series",
        revision: 1,
        recurrence_rule: "FREQ=WEEKLY;COUNT=2",
        series_event_id: null,
      });
      await expect(
        pg.query(
          "UPDATE calendar_events SET owner_id='forged' WHERE event_id='synthetic-existing'",
        ),
      ).rejects.toBeDefined();
    } finally {
      await pg.close();
    }
  });
});
