import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createDomainService } from "../../server/domain/service";
import { berlinToday } from "../../server/domain/routines";
import type { Database } from "../../server/db/database";
import { MIGRATION_SQL, SCHEMA_VERSION } from "../../server/db/schema";
import type {
  CommandName,
  DomainService,
  PageDTO,
  Principal,
  RoutineCheckinDTO,
  RoutineDTO,
  RoutineDayItemDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

let database: Database;
let service: DomainService;
let principal: Principal;
const dateBefore = (label: string, days: number) =>
  new Date(Date.parse(`${label}T12:00:00Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
const isoWeekday = (label: string) =>
  new Date(`${label}T12:00:00Z`).getUTCDay() || 7;
const execute = (
  command: CommandName,
  input: Record<string, unknown>,
  revision: number,
  key = randomUUID(),
  actor = principal,
) =>
  service.execute(command, input, actor, {
    idempotencyKey: key,
    expectedRevision: revision,
  });
const day = (date?: string, actor = principal) =>
  service.query("routine_day", date ? { date } : {}, actor) as Promise<{
    date: string;
    items: RoutineDayItemDTO[];
    total: number;
    completed: number;
  }>;

beforeAll(async () => {
  database = await createTestDatabase();
  service = createDomainService(database);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["tasks:read", "tasks:write", "backup:export"],
  };
});
afterAll(async () => database.close?.());

describe("Personal routines", () => {
  it("migrates a version-1 database additively and remains idempotent", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(
        readFileSync(resolve("server/db/migrations/0001_initial.sql"), "utf8"),
      );
      await pg.exec(
        readFileSync(
          resolve("server/db/migrations/0002_work_contract_policies.sql"),
          "utf8",
        ),
      );
      await pg.exec(MIGRATION_SQL);
      await pg.exec(MIGRATION_SQL);
      const versions = await pg.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.map((row) => row.version)).toEqual([1, 3]);
      const tables = await pg.query<{ name: string }>(
        "SELECT tablename AS name FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'routine%' ORDER BY tablename",
      );
      expect(tables.rows.map((row) => row.name)).toEqual([
        "routine_checkins",
        "routine_schedules",
        "routines",
      ]);
    } finally {
      await pg.close();
    }
  }, 30000);

  it("uses Berlin calendar dates across both DST transitions", () => {
    expect(berlinToday(new Date("2027-03-27T23:30:00Z"))).toBe("2027-03-28");
    expect(berlinToday(new Date("2027-03-28T22:30:00Z"))).toBe("2027-03-29");
    expect(berlinToday(new Date("2027-10-30T22:30:00Z"))).toBe("2027-10-31");
    expect(berlinToday(new Date("2027-10-31T23:30:00Z"))).toBe("2027-11-01");
  });

  it("checks and unchecks today with durable revisions, audit and idempotency, without generating tasks", async () => {
    const today = berlinToday();
    await expect(
      execute("routine_create", { title: "Read" }, 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const created = await execute(
      "routine_create",
      {
        title: "Read",
        notes: "Ten pages",
        start_date: today,
        time_of_day: "08:15",
      },
      0,
    );
    expect(created.version).toBe(1);
    const due = await day();
    expect(due).toMatchObject({ date: today, total: 1, completed: 0 });
    expect(due.items[0]).toMatchObject({
      routine_id: created.entity_id,
      time_of_day: "08:15",
      checkin_revision: 0,
    });
    const key = randomUUID();
    const check = await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: today, done: true },
      0,
      key,
    );
    expect(check.version).toBe(1);
    const replay = await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: today, done: true },
      0,
      key,
    );
    expect(replay).toMatchObject({
      replayed: true,
      entity_id: created.entity_id,
    });
    expect((await day()).completed).toBe(1);
    await expect(
      execute(
        "routine_checkin_set",
        { routine_id: created.entity_id, date: today, done: false },
        0,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const undone = await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: today, done: false },
      check.version,
    );
    expect(undone.version).toBe(2);
    expect((await day()).completed).toBe(0);
    const history = (await service.query(
      "routine_history",
      { routine_id: created.entity_id },
      principal,
    )) as PageDTO<RoutineCheckinDTO>;
    expect(history.items).toEqual([
      {
        routine_id: created.entity_id,
        date: today,
        done: false,
        checked_at: null,
        revision: 2,
      },
    ]);
    expect(
      ((await service.query("task_search", {}, principal)) as PageDTO<unknown>)
        .total,
    ).toBe(0);
    const audits = await database.query<{ event_type: string }>(
      "SELECT event_type FROM activity_events WHERE owner_id=$1 AND entity_id=$2 ORDER BY occurred_at",
      [principal.ownerId, created.entity_id],
    );
    expect(audits.rows.map((item) => item.event_type)).toEqual([
      "routine_create",
      "routine_checkin_set",
      "routine_checkin_set",
    ]);
  });

  it("keeps check-in history across schedule edits, pause, archive and restore", async () => {
    const today = berlinToday();
    const created = await execute(
      "routine_create",
      {
        title: "Walk",
        start_date: dateBefore(today, 40),
        weekdays: [isoWeekday(today)],
      },
      0,
    );
    const checked = await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: today, done: true },
      0,
    );
    const tomorrow = dateBefore(today, -1);
    const nextWeekday = isoWeekday(tomorrow);
    const updated = await execute(
      "routine_update",
      { routine_id: created.entity_id, weekdays: [nextWeekday] },
      created.version,
    );
    expect((await day()).items[0].weekdays).toEqual([isoWeekday(today)]);
    expect((await day(tomorrow)).items[0].weekdays).toEqual([nextWeekday]);
    const rescheduled = await execute(
      "routine_update",
      { routine_id: created.entity_id, time_of_day: "07:00" },
      updated.version,
    );
    expect((await day()).items[0].time_of_day).toBeNull();
    expect((await day(tomorrow)).items[0].time_of_day).toBe("07:00");
    const snapshots = await database.query<{ count: string }>(
      "SELECT count(*) FROM routine_schedules WHERE owner_id=$1 AND routine_id=$2",
      [principal.ownerId, created.entity_id],
    );
    expect(Number(snapshots.rows[0].count)).toBe(2);
    await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: dateBefore(today, 7), done: true },
      0,
    );
    const unchecked = await execute(
      "routine_checkin_set",
      { routine_id: created.entity_id, date: today, done: false },
      checked.version,
    );
    expect(unchecked.version).toBe(2);
    const paused = await execute(
      "routine_pause",
      { routine_id: created.entity_id },
      rescheduled.version,
    );
    const archived = await execute(
      "routine_archive",
      { routine_id: created.entity_id },
      paused.version,
    );
    const visible = (await service.query(
      "routine_list",
      {},
      principal,
    )) as PageDTO<RoutineDTO>;
    expect(visible.total).toBe(0);
    const all = (await service.query(
      "routine_list",
      { include_archived: true },
      principal,
    )) as PageDTO<RoutineDTO>;
    expect(all.items[0].enabled).toBe(false);
    const restored = await execute(
      "routine_restore",
      { routine_id: created.entity_id },
      archived.version,
    );
    expect((restored.data as RoutineDTO).enabled).toBe(false);
    const resumed = await execute(
      "routine_resume",
      { routine_id: created.entity_id },
      restored.version,
    );
    expect((resumed.data as RoutineDTO).enabled).toBe(true);
    const history = (await service.query(
      "routine_history",
      { routine_id: created.entity_id },
      principal,
    )) as PageDTO<RoutineCheckinDTO>;
    expect(history.items[0].revision).toBe(2);
  });

  it("rejects future, unscheduled and older-than-30-calendar-day check-ins", async () => {
    const today = berlinToday();
    const start = dateBefore(today, 50);
    const routine = await execute(
      "routine_create",
      { title: "Stretch", start_date: start },
      0,
    );
    await expect(
      execute(
        "routine_checkin_set",
        {
          routine_id: routine.entity_id,
          date: dateBefore(today, -1),
          done: true,
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute(
        "routine_checkin_set",
        {
          routine_id: routine.entity_id,
          date: dateBefore(today, 31),
          done: true,
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await execute(
      "routine_checkin_set",
      {
        routine_id: routine.entity_id,
        date: dateBefore(today, 30),
        done: true,
      },
      0,
    );
    const weekly = await execute(
      "routine_update",
      { routine_id: routine.entity_id, weekdays: [isoWeekday(today)] },
      routine.version,
    );
    // The edit takes effect tomorrow; yesterday remains part of the old daily schedule.
    await execute(
      "routine_checkin_set",
      { routine_id: routine.entity_id, date: dateBefore(today, 1), done: true },
      0,
    );
    const weeklyOnly = await execute(
      "routine_create",
      { title: "Weekly", start_date: start, weekdays: [isoWeekday(today)] },
      0,
    );
    await expect(
      execute(
        "routine_checkin_set",
        {
          routine_id: weeklyOnly.entity_id,
          date: dateBefore(today, 1),
          done: true,
        },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await execute(
      "routine_pause",
      { routine_id: routine.entity_id },
      weekly.version,
    );
    await expect(
      execute(
        "routine_checkin_set",
        { routine_id: routine.entity_id, date: today, done: true },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute(
        "routine_create",
        { title: "Invalid", start_date: today, weekdays: [2, 2] },
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("isolates owners and preserves routines and check-ins in portable backup restore", async () => {
    const today = berlinToday();
    const routine = await execute(
      "routine_create",
      { title: "Journal", start_date: today },
      0,
    );
    await execute(
      "routine_checkin_set",
      { routine_id: routine.entity_id, date: today, done: true },
      0,
    );
    const another: Principal = {
      ...principal,
      ownerId: `synthetic-${randomUUID()}`,
    };
    expect((await day(undefined, another)).total).toBe(0);
    await expect(
      execute(
        "routine_checkin_set",
        { routine_id: routine.entity_id, date: today, done: false },
        1,
        randomUUID(),
        another,
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    const backup = await service.query("backup_export", {}, principal);
    const fresh = await createTestDatabase();
    try {
      const versions = await fresh.query<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      expect(versions.rows.at(-1)?.version).toBe(SCHEMA_VERSION);
      const restored = createDomainService(fresh);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        { ...principal, scopes: [...principal.scopes, "admin:manage"] },
        { idempotencyKey: randomUUID() },
      );
      const after = (await restored.query("routine_day", {}, principal)) as {
        items: RoutineDayItemDTO[];
        completed: number;
      };
      expect(after.completed).toBe(1);
      expect(after.items[0].routine_id).toBe(routine.entity_id);
    } finally {
      await fresh.close?.();
    }
  });
});
