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
import { hash } from "../../server/domain/core";
import { MIGRATION_SQL } from "../../server/db/schema";
import {
  exportBackup,
  verifyBackupManifest,
} from "../../server/domain/migration";
import { readFile } from "node:fs/promises";
import type {
  CommandName,
  DomainService,
  PageDTO,
  Principal,
  ReportsDTO,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  actor = principal,
) => service.execute(command, input, actor, { idempotencyKey: randomUUID() });
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-report-" + randomUUID(),
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

describe("Complete report ranges, local dates and scope boundaries", () => {
  it("expired_due_instant_is_overdue_even_when_date_is_today_future_or_absent_and_all_reports_agree", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-04-01T09:00:00Z"));
    const both = await exec("task_create", {
      title: "Synthetic today date expired instant",
      due_date: "2027-04-01",
      due_at: "2027-04-01T08:00:00Z",
    });
    const instantOnly = await exec("task_create", {
      title: "Synthetic expired instant only",
      due_at: "2027-03-31T22:30:00Z",
    });
    const futureLabel = await exec("task_create", {
      title: "Synthetic future label expired instant",
      due_date: "2027-04-03",
      due_at: "2027-03-31T08:00:00Z",
    });
    await exec("task_create", {
      title: "Synthetic today date only",
      due_date: "2027-04-01",
    });
    const inventory = (await service.query(
      "task_list_overdue",
      { timezone: "Europe/Berlin" },
      principal,
    )) as PageDTO<TaskDTO>;
    expect(inventory.total).toBe(3);
    expect(new Set(inventory.items.map((t) => t.task_id))).toEqual(
      new Set([both.entity_id, instantOnly.entity_id, futureLabel.entity_id]),
    );
    expect(
      await service.query(
        "analytics_summary",
        { timezone: "Europe/Berlin" },
        principal,
      ),
    ).toMatchObject({ tasks: { overdue: 3 } });
    const report = (await service.query(
      "reports_summary",
      { timezone: "Europe/Berlin" },
      principal,
    )) as ReportsDTO;
    expect(report.overdue_ageing.total).toBe(3);
    expect(
      report.overdue_ageing.items.items.find(
        (t) => t.task_id === both.entity_id,
      ),
    ).toMatchObject({ overdue_days: 0, due_local_date: "2027-04-01" });
    expect(
      report.overdue_ageing.items.items.find(
        (t) => t.task_id === futureLabel.entity_id,
      ),
    ).toMatchObject({ overdue_days: 1, due_local_date: "2027-03-31" });
  });
  it("overdue_ageing_uses_local_deadline_days_real_buckets_and_complete_page_totals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-04-01T09:00:00Z"));
    await exec("task_create", {
      title: "Synthetic seven days",
      due_date: "2027-03-25",
    });
    await exec("task_create", {
      title: "Synthetic thirtyone days",
      due_date: "2027-03-01",
    });
    await exec("task_create", {
      title: "Synthetic same day instant",
      due_at: "2027-04-01T08:00:00Z",
    });
    await exec("task_create", {
      title: "Synthetic future",
      due_date: "2027-04-02",
    });
    const closedTask = await exec("task_create", {
      title: "Synthetic closed",
      due_date: "2020-01-01",
    });
    await service.execute(
      "task_update",
      { task_id: closedTask.entity_id, status: "Cancelled" },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    const report = (await service.query(
      "reports_summary",
      { timezone: "Europe/Berlin", limit: 1 },
      principal,
    )) as ReportsDTO;
    expect(report.overdue_ageing.total).toBe(3);
    expect(report.overdue_ageing.items.total).toBe(3);
    expect(report.overdue_ageing.items.items[0].overdue_days).toBe(31);
    expect(report.overdue_ageing.items.next_cursor).toBeTruthy();
    expect(report.overdue_ageing.buckets.map((b) => [b.key, b.count])).toEqual([
      ["same_day", 1],
      ["1_7", 1],
      ["8_30", 0],
      ["31_90", 1],
      ["91_plus", 0],
    ]);
    const ranged = (await service.query(
      "reports_summary",
      {
        from_date: "2027-03-20",
        to_date: "2027-03-30",
        timezone: "Europe/Berlin",
      },
      principal,
    )) as ReportsDTO;
    expect(ranged.overdue_ageing.total).toBe(1);
    expect(ranged.range.applies_to).toBe(
      "overdue_deadline_dates_and_file_registration_dates",
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2027-04-01T23:00:00Z"));
    const localBoundary = await exec("task_create", {
      title: "Synthetic local-date boundary",
      due_date: "2027-04-01",
    });
    const east = (await service.query(
      "reports_summary",
      { timezone: "Europe/Berlin", search: "local-date boundary" },
      principal,
    )) as ReportsDTO;
    const west = (await service.query(
      "reports_summary",
      { timezone: "America/Los_Angeles", search: "local-date boundary" },
      principal,
    )) as ReportsDTO;
    expect(east.overdue_ageing.items.items[0]).toMatchObject({
      task_id: localBoundary.entity_id,
      overdue_days: 1,
    });
    expect(west.overdue_ageing.total).toBe(0);
  });
  it("explicit_DST_range_counts_actual_elapsed_minutes_and_discloses_current_inventory_semantics", async () => {
    const linked = await exec("task_create", { title: "Synthetic linked" }),
      unrelated = await exec("task_create", { title: "Synthetic unrelated" });
    await db.query(
      "UPDATE tasks SET created_at='2027-03-28T08:00:00Z',status='Done',completed_at='2027-03-28T12:00:00Z' WHERE task_id=$1",
      [linked.entity_id],
    );
    await exec("time_entry_create", {
      employer: "Synthetic DST",
      task_id: linked.entity_id,
      starts_at: "2027-03-27T23:00:00Z",
      ends_at: "2027-03-28T22:00:00Z",
    });
    await exec("time_entry_create", {
      employer: "Synthetic next day",
      task_id: unrelated.entity_id,
      starts_at: "2027-03-29T08:00:00Z",
      ends_at: "2027-03-29T09:00:00Z",
    });
    const input = {
      timezone: "Europe/Berlin",
      from_date: "2027-03-28",
      to_date: "2027-03-29",
    };
    const result = (await service.query(
      "analytics_summary",
      input,
      principal,
    )) as {
      range: { applies_to: string };
      tasks: { total: number };
      time: { minutes: number };
      trends: {
        days: {
          date: string;
          minutes: number;
          created: number;
          completed: number;
        }[];
        weeks: { week_start: string; minutes: number }[];
      };
    };
    expect(result.tasks.total).toBe(2);
    expect(result.time.minutes).toBe(1380);
    expect(result.trends.days).toEqual([
      { date: "2027-03-28", created: 1, completed: 1, minutes: 1380 },
    ]);
    expect(result.trends.weeks).toEqual([
      { week_start: "2027-03-22", created: 1, completed: 1, minutes: 1380 },
    ]);
    expect(result.range.applies_to).toContain(
      "inventory_counts_remain_current_snapshot",
    );
    expect(
      await service.query("analytics_summary", input, {
        ...principal,
        scopes: ["tasks:read"],
      }),
    ).toMatchObject({
      time: { minutes: 0, time_scope_granted: false },
      trends: { time_scope_granted: false },
    });
    for (const bad of [
      { from_date: "2027-01-01" },
      { from_date: "2027-01-01", to_date: "2027-01-01" },
      { from_date: "2027-01-01", to_date: "2029-01-01" },
      { timezone: "Bad/Zone" },
    ])
      await expect(
        service.query("analytics_summary", bad, principal),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("task_scoped_calendar_search_category_and_uncapped_time_summary_never_include_unrelated_or_foreign_tasks", async () => {
    const a = await exec("task_create", { title: "Synthetic A" }),
      b = await exec("task_create", { title: "Synthetic B" });
    await exec("time_entry_create", {
      employer: "Synthetic",
      task_id: a.entity_id,
      starts_at: "2027-03-01T08:00:00Z",
      ends_at: "2027-03-01T09:00:00Z",
    });
    await exec("time_entry_create", {
      employer: "Synthetic",
      task_id: a.entity_id,
      starts_at: "2027-03-01T09:00:00Z",
      ends_at: "2027-03-01T10:00:00Z",
    });
    await exec("time_entry_create", {
      employer: "Synthetic",
      task_id: b.entity_id,
      starts_at: "2027-03-01T10:00:00Z",
      ends_at: "2027-03-01T11:00:00Z",
    });
    expect(
      await service.query(
        "time_entry_list",
        { task_id: a.entity_id, limit: 1 },
        principal,
      ),
    ).toMatchObject({ total: 2 });
    expect(
      await service.query(
        "time_summary",
        { task_id: a.entity_id, limit: 1 },
        principal,
      ),
    ).toMatchObject({ entries: 2, minutes: 120 });
    for (const [taskId, category] of [
      [a.entity_id, "Work"],
      [b.entity_id, "Personal"],
    ])
      await exec("calendar_create_local_event", {
        title: "Synthetic calendar",
        notes: "کلمه",
        task_id: taskId,
        category,
        starts_at: "2027-03-01T08:00:00Z",
        ends_at: "2027-03-01T09:00:00Z",
      });
    expect(
      await service.query(
        "calendar_events_query",
        {
          task_id: a.entity_id,
          category: "Work",
          search: "كلمه",
          from: "2027-03-01T00:00:00Z",
          to: "2027-03-02T00:00:00Z",
        },
        principal,
      ),
    ).toMatchObject({
      total: 1,
      items: [{ task_id: a.entity_id, category: "Work" }],
    });
    for (const operation of [
      "calendar_events_query",
      "time_entry_list",
      "time_summary",
    ] as const)
      await expect(
        service.query(
          operation,
          { task_id: a.entity_id },
          { ...principal, ownerId: "synthetic-foreign" },
        ),
      ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
  it("priority_category_and_AI_channel_filter_before_pagination_with_real_totals", async () => {
    await exec("task_create", { title: "Synthetic seed" });
    await db.query(
      "INSERT INTO tasks(task_id,owner_id,title,priority,category) SELECT 'T-synthetic-matrix-'||$1||'-'||n,$1,'Synthetic matrix '||n,CASE WHEN n%2=0 THEN 'High' ELSE 'Low' END,'Work' FROM generate_series(1,500) n",
      [principal.ownerId],
    );
    expect(
      await service.query(
        "task_search",
        { priority: "High", category: "Work", limit: 3 },
        principal,
      ),
    ).toMatchObject({ total: 250 });
    const low = (
      (await service.query(
        "task_search",
        { priority: "Low", limit: 1 },
        principal,
      )) as PageDTO<TaskDTO>
    ).items[0];
    expect(
      await service.query(
        "task_graph_get",
        { task_id: low.task_id, priority: "High" },
        principal,
      ),
    ).toMatchObject({ total: 1, nodes: [{ task_id: low.task_id }] });
    const ai = await exec(
      "task_create",
      { title: "Synthetic AI channel" },
      { ...principal, channel: "AI" },
    );
    expect(
      await service.query(
        "get_activity",
        { channel: "AI", limit: 1 },
        principal,
      ),
    ).toMatchObject({
      total: 1,
      items: [{ entity_id: ai.entity_id, channel: "AI" }],
    });
    expect(
      await service.query(
        "get_activity",
        { channel: "AI" },
        { ...principal, ownerId: "synthetic-other" },
      ),
    ).toMatchObject({ total: 0 });
  });
  it("known_old_empty_v1_backup_restores_without_additive_tables_and_SQL_source_matches_migration", async () => {
    const backup = (await service.query("backup_export", {}, principal)) as {
      tables: Record<string, unknown>;
      checksums: Record<string, unknown>;
      manifest_hash: string;
    };
    for (const table of ["file_annotations", "event_reminders"]) {
      delete backup.tables[table];
      delete backup.checksums[table];
    }
    backup.manifest_hash = hash(backup.checksums);
    const fresh = await createTestDatabase();
    try {
      await createDomainService(fresh).execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      expect(
        (await fresh.query("SELECT * FROM file_annotations")).rows,
      ).toEqual([]);
      expect((await fresh.query("SELECT * FROM event_reminders")).rows).toEqual(
        [],
      );
    } finally {
      await fresh.close?.();
    }
    expect(
      (
        await readFile(
          new URL(
            "../../server/db/migrations/0001_initial.sql",
            import.meta.url,
          ),
          "utf8",
        )
      )
        .replace(/\r\n/g, "\n")
        .trim(),
    ).toBe(MIGRATION_SQL.replace(/\r\n/g, "\n").trim());
  });
  it("authentic_unknown_table_or_checksum_and_unsupported_row_columns_fail_closed_instead_of_being_dropped", async () => {
    const project = await exec("project_create", {
      title: "Synthetic first restore table",
    });
    const task = await exec("task_create", {
      title: "Synthetic portable row",
      project_id: project.entity_id,
    });
    const original = (await service.query("backup_export", {}, principal)) as {
      tables: Record<string, Record<string, unknown>[]>;
      checksums: Record<string, string>;
      manifest_hash: string;
    };
    const unknown = structuredClone(original);
    unknown.tables.future_table = [
      {
        owner_id: principal.ownerId,
        synthetic_value: "must not silently disappear",
      },
    ];
    unknown.checksums.future_table = hash(unknown.tables.future_table);
    unknown.manifest_hash = hash(unknown.checksums);
    expect(() => verifyBackupManifest(unknown, principal.ownerId)).toThrow(
      /unsupported tables/,
    );
    const extraChecksum = structuredClone(original);
    extraChecksum.checksums.future_table = hash([]);
    extraChecksum.manifest_hash = hash(extraChecksum.checksums);
    expect(() =>
      verifyBackupManifest(extraChecksum, principal.ownerId),
    ).toThrow(/unsupported tables/);
    const extraColumn = structuredClone(original);
    extraColumn.tables.tasks.find(
      (row) => row.task_id === task.entity_id,
    )!.future_column = "synthetic retained value";
    extraColumn.checksums.tasks = hash(extraColumn.tables.tasks);
    extraColumn.manifest_hash = hash(extraColumn.checksums);
    const fresh = await createTestDatabase();
    try {
      let projectInserts = 0;
      const observed: Database = {
        query: fresh.query.bind(fresh),
        transaction: (owner, action) =>
          fresh.transaction(owner, (tx) =>
            action({
              query: (sql, params) => {
                if (sql.startsWith("INSERT INTO projects")) projectInserts++;
                return tx.query(sql, params);
              },
            }),
          ),
      };
      await expect(
        createDomainService(observed).execute(
          "backup_restore",
          { backup: extraColumn, explicit_user_intent: true },
          principal,
          { idempotencyKey: randomUUID() },
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(projectInserts).toBe(0);
      expect((await fresh.query("SELECT * FROM tasks")).rows).toEqual([]);
      expect((await fresh.query("SELECT * FROM projects")).rows).toEqual([]);
    } finally {
      await fresh.close?.();
    }
  });
  it("coordinator_explicit_pre_DDL_export_only_omits_registered_missing_additions_without_changing_schema", async () => {
    const old = await createTestDatabase();
    try {
      await old.query("DROP TABLE file_annotations,event_reminders");
      await expect(
        old.transaction(principal.ownerId, (tx) =>
          exportBackup(tx, principal.ownerId),
        ),
      ).rejects.toThrow();
      const snapshot = await old.transaction(principal.ownerId, (tx) =>
        exportBackup(tx, principal.ownerId, {
          allowKnownMissingAdditions: true,
        }),
      );
      expect(Object.hasOwn(snapshot.tables, "file_annotations")).toBe(false);
      expect(Object.hasOwn(snapshot.checksums, "event_reminders")).toBe(false);
      expect(
        verifyBackupManifest(snapshot, principal.ownerId).event_reminders,
      ).toEqual([]);
      expect(
        (
          await old.query(
            "SELECT to_regclass('public.file_annotations') relation",
          )
        ).rows[0],
      ).toEqual({ relation: null });
    } finally {
      await old.close?.();
    }
  });
});
