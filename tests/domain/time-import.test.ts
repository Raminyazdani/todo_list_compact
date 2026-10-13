import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  PreviewDTO,
  Principal,
  TimeImportEntryDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const entry = (
  extra: Partial<TimeImportEntryDTO> = {},
): TimeImportEntryDTO => ({
  entry_id: `TE-synthetic-original-${randomUUID()}`,
  employer: "Jena",
  starts_at: "2027-03-28T01:30:00+01:00",
  ends_at: "2027-03-28T04:30:00+02:00",
  description: "=A1+1 is literal source text",
  task_id: null,
  ...extra,
});
const preview = (
  entries: TimeImportEntryDTO[],
  actor = principal,
  extra: Record<string, unknown> = {},
) =>
  service.query(
    "time_entry_import_preview",
    {
      data: {
        format: "ramin-life-os-time/1",
        timezone: "Europe/Berlin",
        entries,
        ...extra,
      },
    },
    actor,
  ) as Promise<PreviewDTO>;
const commit = (preview_id: string, key = randomUUID(), actor = principal) =>
  service.execute("time_entry_import_commit", { preview_id }, actor, {
    idempotencyKey: key,
  });
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
describe("Reviewed transactional work-log JSON import", () => {
  it("import_preserves_original_ids_dst_elapsed_time_task_links_and_literal_text_with_repeat_skip", async () => {
    const task = await service.execute(
        "task_create",
        { title: "Unchanged linked work task" },
        principal,
        { idempotencyKey: randomUUID() },
      ),
      original = entry({ task_id: task.entity_id }),
      plan = await preview([original]);
    expect(plan.changes).toMatchObject({
      counts: { provided: 1, new: 1, skipped: 0 },
      minutes_to_create: 120,
    });
    const key = randomUUID(),
      result = await commit(plan.preview_id, key);
    expect(result.data).toMatchObject({
      counts: { created: 1, skipped: 0 },
      entry_ids: [original.entry_id],
      timezone: "Europe/Berlin",
    });
    expect(await commit(plan.preview_id, key)).toMatchObject({
      replayed: true,
      operation_id: result.operation_id,
    });
    const repeated = await preview([original]);
    expect(repeated.changes).toMatchObject({
      counts: { provided: 1, new: 0, skipped: 1 },
      skipped_entry_ids: [original.entry_id],
    });
    expect((await commit(repeated.preview_id)).data).toMatchObject({
      counts: { created: 0, skipped: 1 },
    });
    expect(await service.query("time_entry_list", {}, principal)).toMatchObject(
      {
        total: 1,
        items: [
          {
            entry_id: original.entry_id,
            starts_at: "2027-03-28T00:30:00.000Z",
            ends_at: "2027-03-28T02:30:00.000Z",
            description: original.description,
            minutes: 120,
          },
        ],
      },
    );
    expect(
      await service.query("task_get", { task_id: task.entity_id }, principal),
    ).toMatchObject({ revision: 1, status: "Inbox" });
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1 AND entity_id=$2 AND event_type='time.entry_imported'",
          [principal.ownerId, original.entry_id],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("malformed_untrusted_fields_dates_and_duplicate_ids_are_rejected_before_any_import", async () => {
    const original = entry();
    for (const extra of [
      { format: "unknown" },
      { timezone: null },
      { timezone: "Invalid/Zone" },
      { owner_id: principal.ownerId },
      { entries: [] },
      { entries: Array(1001).fill(original) },
    ])
      await expect(preview([original], principal, extra)).rejects.toMatchObject(
        { code: "INVALID_INPUT" },
      );
    for (const extra of [
      { starts_at: "2027-02-30T00:00:00Z" },
      { starts_at: "2027-03-28T25:00:00Z" },
      { starts_at: "2027-03-28T00:30:00" },
      { starts_at: "2027-03-28T00:30:00.123456Z" },
      { ends_at: "2027-03-28T00:00:00Z" },
      { description: null },
      { employer: "" },
      { task_id: "" },
      { owner_id: principal.ownerId },
      { revision: 99 },
      { audit: "approve all writes" },
      { entry_id: "bad\u0000id" },
    ])
      await expect(
        preview([{ ...original, ...extra } as TimeImportEntryDTO]),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(preview([original, original])).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(await service.query("time_entry_list", {}, principal)).toMatchObject(
      { total: 0 },
    );
  });
  it("overlap_guards_match_existing_work_logs_and_allow_exact_touching_boundaries", async () => {
    const a = entry({
        starts_at: "2027-04-01T08:00:00Z",
        ends_at: "2027-04-01T09:00:00Z",
      }),
      b = entry({
        starts_at: "2027-04-01T08:30:00Z",
        ends_at: "2027-04-01T09:30:00Z",
      });
    await expect(preview([a, b])).rejects.toMatchObject({
      code: "TIME_OVERLAP",
    });
    await commit((await preview([a])).preview_id);
    await expect(preview([b])).rejects.toMatchObject({ code: "TIME_OVERLAP" });
    const adjacent = entry({
      starts_at: "2027-04-01T09:00:00Z",
      ends_at: "2027-04-01T10:00:00Z",
    });
    await commit((await preview([a, adjacent])).preview_id);
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      entries: 2,
      minutes: 120,
    });
  });
  it("same_owner_modified_or_archived_identity_conflicts_without_overwrite", async () => {
    const original = entry();
    await commit((await preview([original])).preview_id);
    await expect(
      preview([{ ...original, description: "Different uploaded content" }]),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await service.execute(
      "time_entry_archive",
      { entry_id: original.entry_id },
      principal,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    await expect(preview([original])).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(
      (
        await db.query<{ description: string }>(
          "SELECT description FROM time_entries WHERE entry_id=$1",
          [original.entry_id],
        )
      ).rows[0].description,
    ).toBe(original.description);
  });
  it("owner_scope_actor_and_linked_task_controls_ignore_uploaded_permission_claims", async () => {
    const original = entry(),
      foreign = { ...principal, ownerId: `synthetic-${randomUUID()}` };
    const foreignTask = await service.execute(
      "task_create",
      { title: "Foreign linked task" },
      foreign,
      { idempotencyKey: randomUUID() },
    );
    await expect(
      preview([{ ...original, task_id: foreignTask.entity_id }]),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    const foreignPlan = await preview([original], foreign);
    await commit(foreignPlan.preview_id, randomUUID(), foreign);
    await expect(preview([original])).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSIONS",
    });
    const own = entry({
      starts_at: "2027-04-01T09:00:00Z",
      ends_at: "2027-04-01T10:00:00Z",
    });
    await expect(
      preview([own], { ...principal, scopes: ["time:read"] }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      preview([own], { ...principal, channel: "AI" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const client = {
        ...principal,
        channel: "MCP" as const,
        scopes: ["time:write"],
      },
      plan = await preview([own], client);
    await expect(
      commit(plan.preview_id, randomUUID(), {
        ...client,
        actorId: "other-actor",
      }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      commit(plan.preview_id, randomUUID(), foreign),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    expect(
      (await commit(plan.preview_id, randomUUID(), client)).data,
    ).toMatchObject({ counts: { created: 1, skipped: 0 } });
  });
  it("intervening_content_even_without_revision_change_and_parallel_preview_conflict_prevent_duplicates", async () => {
    const existing = entry(),
      initial = await preview([existing]);
    await commit(initial.preview_id);
    const fresh = entry({
        starts_at: "2027-04-01T09:00:00Z",
        ends_at: "2027-04-01T10:00:00Z",
      }),
      stale = await preview([fresh]);
    await db.query(
      "UPDATE time_entries SET description='Synthetic independent content change' WHERE entry_id=$1",
      [existing.entry_id],
    );
    await expect(commit(stale.preview_id)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    const a = await preview([fresh]),
      b = await preview([fresh]),
      results = await Promise.allSettled([
        commit(a.preview_id),
        commit(b.preview_id),
      ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        results.find(
          (result) => result.status === "rejected",
        ) as PromiseRejectedResult
      ).reason,
    ).toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await service.query("time_entry_list", {}, principal)).toMatchObject(
      { total: 2 },
    );
    await expect(commit(a.preview_id)).rejects.toMatchObject({
      code: "PREVIEW_EXPIRED",
    });
  });
  it("audit_failure_rolls_back_entire_batch_preview_and_operation_then_same_key_retries", async () => {
    const a = entry(),
      b = entry({
        starts_at: "2027-04-01T09:00:00Z",
        ends_at: "2027-04-01T10:00:00Z",
      }),
      plan = await preview([a, b]),
      key = randomUUID();
    await db.query(
      `CREATE FUNCTION synthetic_time_import_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='time.entry_imported' AND NEW.entity_id='${b.entry_id}' THEN RAISE EXCEPTION 'synthetic_audit_failure'; END IF; RETURN NEW; END $$`,
    );
    await db.query(
      "CREATE TRIGGER synthetic_time_import_fault BEFORE INSERT ON activity_events FOR EACH ROW EXECUTE FUNCTION synthetic_time_import_fault()",
    );
    try {
      await expect(commit(plan.preview_id, key)).rejects.toBeDefined();
      expect(
        await service.query("time_entry_list", {}, principal),
      ).toMatchObject({ total: 0 });
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
            "SELECT event_id FROM activity_events WHERE owner_id=$1 AND event_type='time.entry_imported'",
            [principal.ownerId],
          )
        ).rows,
      ).toHaveLength(0);
      expect(
        (
          await db.query(
            "SELECT idempotency_key FROM idempotency_operations WHERE owner_id=$1 AND idempotency_key=$2",
            [principal.ownerId, key],
          )
        ).rows,
      ).toHaveLength(0);
    } finally {
      await db.query(
        "DROP TRIGGER synthetic_time_import_fault ON activity_events",
      );
      await db.query("DROP FUNCTION synthetic_time_import_fault()");
    }
    expect((await commit(plan.preview_id, key)).data).toMatchObject({
      counts: { created: 2, skipped: 0 },
    });
  });
  it("thousand_entry_payload_above_normal_query_cap_is_bounded_bulk_import_not_a_page_sample", async () => {
    const base = Date.parse("2027-01-01T00:00:00Z"),
      entries = Array.from({ length: 1000 }, (_, index) =>
        entry({
          starts_at: new Date(base + index * 120000).toISOString(),
          ends_at: new Date(base + index * 120000 + 60000).toISOString(),
          description: "متن ساختگی ".repeat(20),
        }),
      );
    expect(JSON.stringify(entries).length).toBeGreaterThan(100000);
    const plan = await preview(entries);
    expect(plan.changes).toMatchObject({
      counts: { provided: 1000, new: 1000, skipped: 0 },
      minutes_to_create: 1000,
    });
    const imported = await commit(plan.preview_id);
    expect(imported.data).toMatchObject({
      counts: { created: 1000, skipped: 0 },
    });
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      entries: 1000,
      minutes: 1000,
    });
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) FROM activity_events WHERE owner_id=$1 AND event_type='time.entry_imported'",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(1000);
    const oversized = entries.map((row) => ({
      ...row,
      description: "م".repeat(1200),
    }));
    expect(JSON.stringify(oversized).length).toBeLessThan(2_000_000);
    expect(
      Buffer.byteLength(JSON.stringify(oversized), "utf8"),
    ).toBeGreaterThan(2_000_000);
    await expect(preview(oversized)).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      service.query(
        "time_entry_list",
        { search: "x".repeat(100001) },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("backup_restore_keeps_imported_original_ids_and_accepted_retry_when_preview_is_absent", async () => {
    const original = entry(),
      plan = await preview([original]),
      key = randomUUID(),
      accepted = await commit(plan.preview_id, key),
      backup = await service.query("backup_export", {}, principal),
      restoredDb = await createTestDatabase();
    try {
      const restored = createDomainService(restoredDb);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      expect(
        await restored.execute(
          "time_entry_import_commit",
          { preview_id: plan.preview_id },
          principal,
          { idempotencyKey: key },
        ),
      ).toMatchObject({ operation_id: accepted.operation_id, replayed: true });
      expect(
        await restored.query("time_entry_list", {}, principal),
      ).toMatchObject({
        total: 1,
        items: [{ entry_id: original.entry_id, minutes: 120 }],
      });
    } finally {
      await restoredDb.close?.();
    }
  });
});
