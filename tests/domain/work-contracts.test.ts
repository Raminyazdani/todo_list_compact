import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import { hash } from "../../server/domain/core";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  Principal,
  TimeContractReportDTO,
  WorkContractPolicyDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

let db: Database;
let service: DomainService;
let principal: Principal;

function policy(overrides: Record<string, unknown> = {}) {
  return {
    employer: "Synthetic A",
    effective_from: "2025-04-01",
    effective_to: "2025-12-31",
    weekly_contract_max_minutes: 600,
    weekly_personal_alert_minutes: 600,
    weekly_average_target_minutes: null,
    average_window_months: null,
    monthly_reference_minutes: 1980,
    monthly_overrides: { "2025-04": 1230 },
    allowed_weekdays: [1, 2, 3, 4, 5],
    local_window_start: "08:00",
    local_window_end: "18:00",
    timesheet_due: { kind: "calendar_day", day: 5 },
    source_label: "Synthetic agreement",
    ...overrides,
  };
}
function execute(
  command: Parameters<DomainService["execute"]>[0],
  input: Record<string, unknown>,
  expectedRevision?: number,
  actor = principal,
  idempotencyKey = randomUUID(),
) {
  return service.execute(command, input, actor, {
    idempotencyKey,
    expectedRevision,
  });
}
function report(month = "2025-05", actor = principal) {
  return service.query(
    "time_contract_report",
    { month },
    actor,
  ) as Promise<TimeContractReportDTO>;
}
function employer(result: TimeContractReportDTO, name = "Synthetic A") {
  return result.employers.find((item) => item.employer === name)!;
}
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "synthetic-contract-" + randomUUID(),
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["time:read", "time:write"],
  };
});
afterAll(async () => db.close?.());

describe("owner-scoped work contract dashboard", () => {
  it("counts complete Berlin edge weeks while clipping the selected month", async () => {
    await execute("time_contract_policy_upsert", policy(), 0);
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-04-01T08:00:00Z",
      ends_at: "2025-04-01T09:00:00Z",
    });
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-04-30T08:00:00Z",
      ends_at: "2025-04-30T10:00:00Z",
    });
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-01T08:00:00Z",
      ends_at: "2025-05-01T16:00:00Z",
    });
    const exact = await report();
    expect(exact.data_complete).toBe(true);
    expect(exact.week_starts_on).toBe("monday");
    expect(employer(exact).monthly).toMatchObject({
      minutes: 480,
      entry_count: 1,
      reference_minutes: 1980,
      delta_minutes: -1500,
    });
    expect(employer(exact).cumulative).toMatchObject({
      from: "2025-04-01",
      months: 2,
      reported_minutes: 660,
      reference_minutes: 3210,
      delta_minutes: -2550,
    });
    expect(employer(exact).weeks[0]).toMatchObject({
      week_start: "2025-04-28",
      week_end_exclusive: "2025-05-05",
      minutes: 600,
      contract_state: "within",
      personal_state: "within",
      contract_over_minutes: 0,
    });
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-02T08:00:00Z",
      ends_at: "2025-05-02T08:01:00Z",
    });
    const over = employer(await report()).weeks[0];
    expect(over).toMatchObject({
      minutes: 601,
      contract_state: "over",
      personal_state: "over",
      contract_over_minutes: 1,
    });
  });

  it("keeps personal alerts distinct from average targets and contract caps", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({
        weekly_contract_max_minutes: null,
        weekly_personal_alert_minutes: 600,
        weekly_average_target_minutes: 477,
        average_window_months: 3,
      }),
      0,
    );
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-05T08:00:00Z",
      ends_at: "2025-05-05T19:00:00Z",
    });
    const week = employer(await report()).weeks[1];
    expect(week).toMatchObject({
      minutes: 660,
      contract_state: "not_set",
      personal_state: "over",
      average_target_minutes: 477,
      window_review_count: 1,
    });
    expect(week.issues[0]).toMatchObject({
      code: "LOCAL_WINDOW_REVIEW",
      local_date: "2025-05-05",
    });
  });

  it("shows precise weekday and out-of-term review issues without declaring breach", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({ effective_from: "2025-05-01", effective_to: "2025-05-31" }),
      0,
    );
    const before = await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-04-30T08:00:00Z",
      ends_at: "2025-04-30T09:00:00Z",
    });
    const weekend = await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-03T08:00:00Z",
      ends_at: "2025-05-03T09:00:00Z",
    });
    const week = employer(await report()).weeks[0];
    expect(week.contract_state).toBe("review");
    expect(week.out_of_term_review_count).toBe(1);
    expect(week.weekday_review_count).toBe(1);
    expect(week.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OUTSIDE_EFFECTIVE_TERM",
          entry_id: before.entity_id,
          local_date: "2025-04-30",
        }),
        expect.objectContaining({
          code: "WEEKDAY_REVIEW",
          entry_id: weekend.entity_id,
          local_date: "2025-05-03",
        }),
      ]),
    );
  });

  it("flags a whole week before the single known contract term as unknown with exact evidence", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({ effective_from: "2025-05-15", effective_to: "2025-12-31" }),
      0,
    );
    const before = await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-06T08:00:00Z",
      ends_at: "2025-05-06T09:00:00Z",
    });
    const week = employer(await report()).weeks[1];
    expect(week.contract_state).toBe("unknown");
    expect(week.out_of_term_review_count).toBe(1);
    expect(week.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "OUTSIDE_EFFECTIVE_TERM",
          entry_id: before.entity_id,
          local_date: "2025-05-06",
        }),
      ]),
    );
  });

  it("preserves legacy reported minutes through DST and excludes drafts and archived entries", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({
        effective_from: "2024-01-01",
        effective_to: "2024-12-31",
        weekly_contract_max_minutes: 120,
      }),
      0,
    );
    await db.query(
      "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at,reporting_policy,reported_minutes,legacy_metadata) VALUES($1,$2,$3,$4,$5,'legacy_wall',120,$6::jsonb)",
      [
        randomUUID(),
        principal.ownerId,
        "Synthetic A",
        "2024-10-26T22:30:00Z",
        "2024-10-27T01:30:00Z",
        JSON.stringify({ timezone: "Europe/Berlin" }),
      ],
    );
    await execute("time_draft_save", {
      employer: "Synthetic A",
      date: "2024-10-27",
      start: "09:",
      end: "",
    });
    const archived = await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2024-10-28T09:00:00Z",
      ends_at: "2024-10-28T10:00:00Z",
    });
    await execute("time_entry_archive", { entry_id: archived.entity_id }, 1);
    const result = await report("2024-10");
    expect(employer(result).monthly.minutes).toBe(120);
    expect(employer(result).weeks[3].minutes).toBe(120);
    expect(employer(result).weeks[3]).toMatchObject({
      contract_state: "review",
      personal_state: "review",
      elapsed_minutes: 180,
    });
    expect(employer(result).weeks[3].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "LEGACY_DURATION_REVIEW" }),
      ]),
    );
    expect(employer(result).weeks[4].minutes).toBe(0);
  });

  it("keeps unknown employers unclassified and combined 20-hour review advisory", async () => {
    await execute("time_contract_policy_upsert", policy(), 0);
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-05-05T06:00:00Z",
      ends_at: "2025-05-05T16:00:00Z",
    });
    await execute("time_entry_create", {
      employer: "Unknown B",
      starts_at: "2025-05-06T06:00:00Z",
      ends_at: "2025-05-06T16:01:00Z",
    });
    const result = await report();
    expect(employer(result, "Unknown B").policy_status).toBe("missing");
    expect(employer(result, "Unknown B").weeks[1].contract_state).toBe(
      "unknown",
    );
    expect(result.combined_weeks[1]).toMatchObject({
      minutes: 1201,
      review_over_20h: true,
    });
  });

  it("uses elapsed time for the combined 20-hour advisory when legacy settlement differs", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({ effective_from: "2024-01-01", effective_to: "2024-12-31" }),
      0,
    );
    await db.query(
      "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at,reporting_policy,reported_minutes,legacy_metadata) VALUES($1,$2,$3,$4,$5,'legacy_wall',120,$6::jsonb)",
      [
        randomUUID(),
        principal.ownerId,
        "Synthetic A",
        "2024-10-26T22:30:00Z",
        "2024-10-27T01:30:00Z",
        JSON.stringify({ timezone: "Europe/Berlin" }),
      ],
    );
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2024-10-22T00:00:00Z",
      ends_at: "2024-10-22T18:00:00Z",
    });
    const week = (await report("2024-10")).combined_weeks[3];
    expect(week).toMatchObject({
      minutes: 1200,
      elapsed_minutes: 1260,
      review_over_20h: true,
    });
  });

  it("shows a completed three-month average as recorded trend, never a weekly breach", async () => {
    await execute(
      "time_contract_policy_upsert",
      policy({
        effective_from: "2025-08-01",
        effective_to: "2025-12-31",
        weekly_contract_max_minutes: null,
        weekly_average_target_minutes: 477,
        average_window_months: 3,
      }),
      0,
    );
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-08-04T08:00:00Z",
      ends_at: "2025-08-04T10:00:00Z",
    });
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-09-04T08:00:00Z",
      ends_at: "2025-09-04T10:00:00Z",
    });
    await execute("time_entry_create", {
      employer: "Synthetic A",
      starts_at: "2025-10-04T08:00:00Z",
      ends_at: "2025-10-04T10:00:00Z",
    });
    const result = employer(await report("2025-10"));
    expect(result.average).toMatchObject({
      window_months: 3,
      window_start: "2025-08-01",
      reported_minutes: 360,
      target_minutes_per_week: 477,
      status: "informational",
      reason: "RECORDED_ENTRIES_ONLY",
    });
    expect(result.weeks[0].contract_state).toBe("not_set");
  });

  it("fails closed when a bounded report cannot include every qualifying entry", async () => {
    await execute("time_contract_policy_upsert", policy(), 0);
    await db.query(
      "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at) SELECT 'synthetic-'||$1||'-'||g,$1,'Synthetic A','2025-05-05T08:00:00Z','2025-05-05T08:01:00Z' FROM generate_series(1,10001) g",
      [principal.ownerId],
    );
    await expect(report()).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.stringContaining("exceeds 10,000 entries"),
    });
  });

  it("validates policy versions, revisions, scopes, owner isolation and backup roundtrip", async () => {
    await expect(
      execute("time_contract_policy_upsert", policy({ bogus: 1 }), 0),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute(
        "time_contract_policy_upsert",
        policy({ allowed_weekdays: [1, 1] }),
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const createKey = randomUUID();
    const created = await execute(
      "time_contract_policy_upsert",
      policy(),
      0,
      principal,
      createKey,
    );
    const replay = await execute(
      "time_contract_policy_upsert",
      policy(),
      0,
      principal,
      createKey,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.entity_id).toBe(created.entity_id);
    const original = created.data as unknown as WorkContractPolicyDTO;
    await expect(
      execute(
        "time_contract_policy_upsert",
        policy({ effective_from: "2025-05-01" }),
        0,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      execute("time_contract_policy_upsert", policy({ id: original.id }), 0),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const updated = await execute(
      "time_contract_policy_upsert",
      policy({ id: original.id, weekly_personal_alert_minutes: 540 }),
      1,
    );
    expect(updated.version).toBe(2);
    const next = await execute(
      "time_contract_policy_upsert",
      policy({ effective_from: "2026-01-01", effective_to: null }),
      0,
    );
    expect(next.version).toBe(1);
    const tasksOnly: Principal = {
      ...principal,
      scopes: ["tasks:read", "tasks:write"],
    };
    await expect(report("2025-05", tasksOnly)).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSIONS",
    });
    await expect(
      service.query("time_contract_policy_list", {}, tasksOnly),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      execute("time_contract_policy_upsert", policy(), 0, tasksOnly),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const other: Principal = {
      ...principal,
      ownerId: "synthetic-other-" + randomUUID(),
    };
    expect(
      await service.query("time_contract_policy_list", {}, other),
    ).toMatchObject({ total: 0 });
    expect((await report("2025-05", other)).employers).toEqual([]);
    const backup = (await service.query(
      "backup_export",
      {},
      { ...principal, scopes: ["admin:manage"] },
    )) as Record<string, unknown>;
    expect(
      (backup.tables as Record<string, unknown[]>).work_contract_policies,
    ).toHaveLength(2);
    const restored = await createTestDatabase();
    try {
      const restoredService = createDomainService(restored);
      await restoredService.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        { ...principal, scopes: ["admin:manage"] },
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restoredService.query("time_contract_policy_list", {}, principal),
      ).toMatchObject({ total: 2 });
    } finally {
      await restored.close?.();
    }
    const oldBackup = structuredClone(backup) as Record<string, unknown>;
    delete (oldBackup.tables as Record<string, unknown>).work_contract_policies;
    delete (oldBackup.checksums as Record<string, unknown>)
      .work_contract_policies;
    oldBackup.manifest_hash = hash(oldBackup.checksums);
    const oldRestored = await createTestDatabase();
    try {
      await createDomainService(oldRestored).execute(
        "backup_restore",
        { backup: oldBackup, explicit_user_intent: true },
        { ...principal, scopes: ["admin:manage"] },
        { idempotencyKey: randomUUID() },
      );
      expect(
        (await oldRestored.query("SELECT * FROM work_contract_policies")).rows,
      ).toEqual([]);
    } finally {
      await oldRestored.close?.();
    }
  });
});
