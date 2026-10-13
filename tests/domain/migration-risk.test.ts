import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type { DomainService, Principal, TaskDTO } from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "import",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});
describe("Source migration adversarial integrity", () => {
  const record = (taskId: string) => ({
    task_id: taskId,
    title: "Synthetic unchanged source",
    status: "Inbox",
    priority: "Normal",
    category: "Other",
    due_date: null,
    revision: 1,
    unknown_original_field: "retain exact",
  });
  it("source_batch_hash_collision_and_untrusted_ai_import_cannot_modify_existing_data", async () => {
    const taskId = randomUUID(),
      batchId = randomUUID(),
      input = {
        batch_id: batchId,
        source_hash: "synthetic-source-one",
        tasks: [record(taskId)],
      };
    await service.execute("legacy_import", input, principal, {
      idempotencyKey: randomUUID(),
    });
    const before = (await service.query(
      "task_get",
      { task_id: taskId },
      principal,
    )) as TaskDTO;
    await expect(
      service.execute(
        "legacy_import",
        { ...input, source_hash: "different-source" },
        principal,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.execute(
        "legacy_import",
        { ...input, batch_id: randomUUID() },
        { ...principal, channel: "AI" },
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: taskId },
          principal,
        )) as TaskDTO
      ).revision,
    ).toBe(before.revision);
  });
  it("source_identity_collision_with_other_owner_rolls_back_entire_import", async () => {
    const taskId = randomUUID(),
      original = {
        batch_id: randomUUID(),
        source_hash: "original-owner",
        tasks: [record(taskId)],
      };
    await service.execute("legacy_import", original, principal, {
      idempotencyKey: randomUUID(),
    });
    const other = { ...principal, ownerId: `synthetic-other-${randomUUID()}` };
    await expect(
      service.execute(
        "legacy_import",
        {
          batch_id: randomUUID(),
          source_hash: "other",
          tasks: [record(randomUUID()), record(taskId)],
        },
        other,
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(await service.query("task_search", {}, other)).toMatchObject({
      total: 0,
    });
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: taskId },
          principal,
        )) as TaskDTO
      ).title,
    ).toBe("Synthetic unchanged source");
  });
  it("orphan_source_links_quarantine_exact_original_values_and_replay_is_nonduplicating", async () => {
    const taskId = randomUUID(),
      fileId = randomUUID(),
      linkId = randomUUID(),
      input = {
        batch_id: randomUUID(),
        source_hash: "synthetic-orphan-source",
        tasks: [record(taskId)],
        files: [
          {
            file_record_id: fileId,
            display_name: "Synthetic source",
            original_filename: "original.pdf",
            state: "Inbox",
            drive_file_id: "synthetic-drive-id",
            drive_url: "https://drive.google.com/file/d/synthetic/view",
            revision: 1,
          },
        ],
        links: [
          {
            link_id: linkId,
            task_id: taskId,
            file_record_id: "missing-synthetic-file",
            relation: "Reference",
            active: true,
            notes: "Exact orphan note",
          },
        ],
        activity: [
          {
            event_id: randomUUID(),
            entity_id: taskId,
            actor: "original-source-actor",
            action: "create",
            before_json: "malformed original JSON",
            after_json: "false",
          },
        ],
        settings: [{ key: "unknown_setting", value: "unchanged" }],
        guide: [{ topic: "Original guide", guidance_fa: "متن عیناً حفظ شود" }],
      };
    const result = await service.execute("legacy_import", input, principal, {
      idempotencyKey: randomUUID(),
    });
    expect(result.data).toMatchObject({
      counts: { tasks: 1, files: 1, links: 0, activity: 1, quarantined: 1 },
    });
    const quarantine = await db.query<{
      original_record: Record<string, unknown>;
    }>("SELECT original_record FROM migration_quarantine WHERE owner_id=$1", [
      principal.ownerId,
    ]);
    expect(quarantine.rows[0].original_record.notes).toBe("Exact orphan note");
    await service.execute("legacy_import", input, principal, {
      idempotencyKey: randomUUID(),
    });
    expect(
      (
        await db.query<{ count: string }>(
          "SELECT count(*) FROM migration_quarantine WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(1);
    const backup = (await service.query("backup_export", {}, principal)) as {
      tables: { activity_events: { before: unknown; after: unknown }[] };
    };
    expect(
      backup.tables.activity_events.some(
        (e) =>
          typeof e.before === "object" &&
          e.before !== null &&
          "unparsed_legacy_json" in e.before,
      ),
    ).toBe(true);
    expect(backup.tables.activity_events.some((e) => e.after === false)).toBe(
      true,
    );
  });
});
