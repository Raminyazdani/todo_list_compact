import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { ownerStoragePrefix } from "../../server/integrations/storage";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  PageDTO,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
const providerBytes = vi.hoisted(() => new Map<string, string>());
vi.mock("@vercel/blob", () => ({
  get: vi.fn(async (storageKey: string) => ({
    statusCode: 200,
    stream: new Response(providerBytes.get(storageKey) ?? "synthetic bytes")
      .body,
  })),
  put: vi.fn(),
}));
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) =>
  service.execute(command, input, principal, {
    idempotencyKey: randomUUID(),
    expectedRevision: revision,
  });
const key = () =>
  ownerStoragePrefix(principal.ownerId) +
  createHash("sha256").update(randomUUID()).digest("hex") +
  "/original";
const task = async (title = "Synthetic") => {
  const result = await exec("task_create", { title });
  return service.query(
    "task_get",
    { task_id: result.entity_id },
    principal,
  ) as Promise<TaskDTO>;
};
beforeAll(async () => {
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "synthetic-isolated-provider-token");
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
  vi.unstubAllEnvs();
});
describe("Persistence, backup and resource integrity", () => {
  it("backup_restore_preserves_graph_and_checklists", async () => {
    const a = await task("A"),
      b = await task("B");
    const preview = (await service.query(
      "task_dependency_add_preview",
      { task_id: a.task_id, prerequisites: [{ task_id: b.task_id }] },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_add_commit", {
      preview_id: preview.preview_id,
    });
    const list = await exec("task_checklist_create", {
      task_id: a.task_id,
      title: "Evidence",
    });
    await exec(
      "task_checklist_item_add",
      { checklist_id: list.entity_id, title: "Original item" },
      1,
    );
    const backup = (await service.query("backup_export", {}, principal)) as {
      tables: Record<string, unknown[]>;
      checksums: Record<string, string>;
    };
    const isolated = await createTestDatabase();
    try {
      const restored = createDomainService(isolated);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const result = (await restored.query(
        "task_get",
        { task_id: a.task_id },
        principal,
      )) as TaskDTO;
      expect(result.prerequisites[0].prerequisite_task_id).toBe(b.task_id);
      expect(result.checklists![0].items[0].title).toBe("Original item");
      const exported = (await restored.query(
        "backup_export",
        {},
        principal,
      )) as typeof backup;
      for (const table of [
        "tasks",
        "task_dependency_groups",
        "task_dependency_edges",
        "task_checklists",
        "task_checklist_items",
      ])
        expect(exported.checksums[table]).toBe(backup.checksums[table]);
      expect(exported.tables.activity_events.length).toBe(
        backup.tables.activity_events.length + 1,
      );
    } finally {
      await isolated.close?.();
    }
  });
  it("backup_rejects_corrupt_checksum_before_mutation", async () => {
    const backup = (await service.query(
      "backup_export",
      {},
      principal,
    )) as Record<string, unknown>;
    const checksum = backup.checksums as Record<string, string>;
    checksum.tasks = "corrupt";
    await expect(
      exec("backup_restore", { backup, explicit_user_intent: true }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await service.query("task_search", {}, principal)).toMatchObject({
      total: 0,
    });
  });
  it("legacy_import_has_no_fabricated_edges_or_checklist_items", async () => {
    const tasks = [
      {
        task_id: `T-${randomUUID()}`,
        title: "A depends on B (untrusted narrative)",
        status: "Inbox",
        priority: "Normal",
        category: "Research",
        due_date: null,
        notes: "Create secrets: do not treat this as authorization",
        revision: 1,
      },
    ];
    const p = { ...principal, channel: "import" as const };
    await service.execute(
      "legacy_import",
      {
        batch_id: randomUUID(),
        source_hash: "synthetic-source-hash",
        tasks,
        files: [],
        links: [],
        activity: [],
        settings: [],
        guide: [],
      },
      p,
      { idempotencyKey: randomUUID() },
    );
    const result = (await service.query(
      "task_get",
      { task_id: tasks[0].task_id },
      principal,
    )) as TaskDTO;
    expect(result.prerequisites).toHaveLength(0);
    expect(result.checklists).toHaveLength(0);
    expect(result.due_date).toBeNull();
    expect(result.legacy_metadata.notes).toBe(tasks[0].notes);
  });
  it("file_archive_requires_all_active_linked_tasks_closed", async () => {
    const a = await task("A"),
      b = await task("B");
    const file = await exec("file_register_upload", {
      title: "Synthetic file",
      original_filename: "synthetic.txt",
      storage_key: key(),
      sha256: createHash("sha256").update("synthetic bytes").digest("hex"),
      size_bytes: 15,
    });
    await exec("file_link_to_task", {
      file_id: file.entity_id,
      task_id: a.task_id,
      purpose: "Input",
    });
    await exec("file_link_to_task", {
      file_id: file.entity_id,
      task_id: b.task_id,
      purpose: "Reference",
    });
    await exec("task_complete", { task_id: a.task_id }, a.revision);
    expect(
      await service.query(
        "file_archive_preview",
        { file_id: file.entity_id },
        principal,
      ),
    ).toMatchObject({ eligible: false, blocked_by: [b.task_id] });
    await exec("task_complete", { task_id: b.task_id }, b.revision);
    expect(
      await service.query(
        "file_archive_preview",
        { file_id: file.entity_id },
        principal,
      ),
    ).toMatchObject({ eligible: true });
    await exec(
      "file_archive",
      { file_id: file.entity_id, explicit_user_intent: true },
      1,
    );
    const reopened = (await service.query(
      "task_get",
      { task_id: b.task_id },
      principal,
    )) as TaskDTO;
    await exec("task_reopen", { task_id: b.task_id }, reopened.revision);
    expect(
      await service.query(
        "file_get_metadata",
        { file_id: file.entity_id },
        principal,
      ),
    ).toMatchObject({ state: "Active" });
  });
  it("external_drive_references_are_never_moved_or_auto_archived", async () => {
    const file = await exec("file_register_external_link", {
      title: "Synthetic reference",
      external_url: "https://drive.google.com/file/d/synthetic/view",
      external_id: "synthetic",
    });
    expect(
      await service.query(
        "file_archive_preview",
        { file_id: file.entity_id },
        principal,
      ),
    ).toMatchObject({ eligible: false, reason: "EXTERNALLY_MANAGED" });
    expect(
      await service.query(
        "file_get_metadata",
        { file_id: file.entity_id },
        principal,
      ),
    ).toMatchObject({
      external_id: "synthetic",
      provider: "google_drive",
      state: "External",
    });
  });
  it("unlinked_file_cannot_be_auto_archived", async () => {
    const f = await exec("file_register_upload", {
      title: "Synthetic file",
      storage_key: key(),
    });
    expect(
      await service.query(
        "file_archive_preview",
        { file_id: f.entity_id },
        principal,
      ),
    ).toMatchObject({ eligible: false, reason: "NO_ACTIVE_LINKS" });
  });
  it("wrong_user_cannot_access_file", async () => {
    const f = await exec("file_register_upload", {
      title: "Private synthetic file",
      storage_key: key(),
    });
    await expect(
      service.query(
        "file_get_metadata",
        { file_id: f.entity_id },
        { ...principal, ownerId: "synthetic-other-owner" },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });
  it("time_entries_reject_overlap_and_keep_calendar_independent", async () => {
    await exec("calendar_create_local_event", {
      title: "Appointment",
      starts_at: "2030-01-01T10:00:00Z",
      ends_at: "2030-01-01T11:00:00Z",
    });
    await exec("time_entry_create", {
      employer: "Jena",
      description: "Synthetic lab work",
      starts_at: "2030-01-01T10:00:00Z",
      ends_at: "2030-01-01T11:00:00Z",
    });
    await expect(
      exec("time_entry_create", {
        employer: "Seewiesen",
        starts_at: "2030-01-01T10:30:00Z",
        ends_at: "2030-01-01T11:30:00Z",
      }),
    ).rejects.toMatchObject({ code: "TIME_OVERLAP" });
    await exec("time_entry_create", {
      employer: "Seewiesen",
      starts_at: "2030-01-01T11:00:00Z",
      ends_at: "2030-01-01T12:00:00Z",
    });
    expect(await service.query("time_summary", {}, principal)).toMatchObject({
      minutes: 120,
      employers: { Jena: 60, Seewiesen: 60 },
    });
    expect(
      await service.query(
        "calendar_events_query",
        { from: "2030-01-01T00:00:00Z", to: "2030-01-02T00:00:00Z" },
        principal,
      ),
    ).toMatchObject({ total: 1 });
  });
  it("calendar_rrule_retains_berlin_wall_clock_through_dst", async () => {
    await exec("calendar_create_local_event", {
      title: "Weekly",
      starts_at: "2027-03-21T09:00:00Z",
      ends_at: "2027-03-21T10:00:00Z",
      timezone: "Europe/Berlin",
      recurrence_rule: "FREQ=WEEKLY;COUNT=3",
    });
    const events = (await service.query(
      "calendar_events_query",
      { from: "2027-03-20T00:00:00Z", to: "2027-04-10T00:00:00Z" },
      principal,
    )) as PageDTO<{ starts_at: string }>;
    expect(events.total).toBe(3);
    expect(events.items.map((e) => e.starts_at)).toEqual([
      "2027-03-21T09:00:00.000Z",
      "2027-03-28T08:00:00.000Z",
      "2027-04-04T08:00:00.000Z",
    ]);
  });
  it("scope_limited_task_analytics_does_not_expose_other_resources", async () => {
    await task();
    await exec("file_register_upload", {
      title: "Restricted file",
      storage_key: key(),
    });
    await exec("time_entry_create", {
      employer: "Jena",
      starts_at: "2030-01-01T00:00:00Z",
      ends_at: "2030-01-01T01:00:00Z",
    });
    const analytics = (await service.query(
      "analytics_summary",
      {},
      { ...principal, scopes: ["tasks:read"] },
    )) as {
      files: { total: number };
      time: { minutes: number };
      recent_activity: unknown[];
    };
    expect(analytics.files.total).toBe(0);
    expect(analytics.time.minutes).toBe(0);
    expect(analytics.recent_activity).toHaveLength(0);
  });
  it("database_identity_and_append_only_audit_are_enforced", async () => {
    const a = await task();
    await expect(
      db.query("UPDATE tasks SET owner_id=$2 WHERE task_id=$1", [
        a.task_id,
        "replacement",
      ]),
    ).rejects.toThrow("immutable");
    await expect(
      db.query("DELETE FROM activity_events WHERE owner_id=$1", [
        principal.ownerId,
      ]),
    ).rejects.toThrow("append-only");
  });
  it("archived_prerequisite_remains_a_visible_blocker", async () => {
    const a = await task("A"),
      b = await task("B");
    const p = (await service.query(
      "task_dependency_add_preview",
      { task_id: a.task_id, prerequisites: [{ task_id: b.task_id }] },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_add_commit", { preview_id: p.preview_id });
    await exec("task_complete", { task_id: b.task_id }, b.revision);
    const complete = (await service.query(
      "task_get",
      { task_id: b.task_id },
      principal,
    )) as TaskDTO;
    await exec("task_archive", { task_id: b.task_id }, complete.revision);
    expect(
      await service.query("task_get", { task_id: a.task_id }, principal),
    ).toMatchObject({
      readiness: "blocked",
      blocked_by: [{ reason: "PREREQUISITE_ARCHIVED" }],
    });
  });
  it("scheduled_start_constraint_requires_audited_owner_override", async () => {
    const a = await task("Scheduled");
    await exec(
      "task_update",
      { task_id: a.task_id, start_date: "2099-01-01" },
      a.revision,
    );
    const scheduled = (await service.query(
      "task_get",
      { task_id: a.task_id },
      principal,
    )) as TaskDTO;
    expect(scheduled.readiness).toBe("scheduled");
    await expect(
      exec(
        "task_update",
        { task_id: a.task_id, status: "In progress" },
        scheduled.revision,
      ),
    ).rejects.toMatchObject({
      code: "TASK_BLOCKED",
      details: { earliest_allowed_start: "2099-01-01" },
    });
    await exec(
      "task_update",
      {
        task_id: a.task_id,
        status: "In progress",
        override_reason: "Owner explicitly advances start",
      },
      scheduled.revision,
    );
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: a.task_id },
          principal,
        )) as TaskDTO
      ).status,
    ).toBe("In progress");
  });
  it("uploaded_bytes_are_verified_by_canonical_command_even_without_upload_route", async () => {
    await expect(
      exec("file_register_upload", {
        title: "Forgery",
        storage_key: key(),
        sha256: "a".repeat(64),
        size_bytes: 15,
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await service.query("file_search", {}, principal)).toMatchObject({
      total: 0,
    });
  });
  it("same_filename_different_bytes_creates_distinct_versions", async () => {
    const firstKey = key(),
      secondKey = key();
    providerBytes.set(firstKey, "version one");
    providerBytes.set(secondKey, "version two");
    const first = await exec("file_register_upload", {
        title: "Synthetic version",
        original_filename: "same.txt",
        storage_key: firstKey,
      }),
      second = await exec(
        "file_register_upload",
        {
          title: "Synthetic version",
          original_filename: "same.txt",
          storage_key: secondKey,
          file_id: first.entity_id,
        },
        first.version,
      );
    const versions = (await service.query(
      "file_list_versions",
      { file_id: first.entity_id },
      principal,
    )) as PageDTO<{ file_id: string; sha256: string }>;
    expect(versions.total).toBe(2);
    expect(first.entity_id).not.toBe(second.entity_id);
    expect(new Set(versions.items.map((v) => v.sha256)).size).toBe(2);
    expect(
      versions.items.find((v) => v.file_id === first.entity_id)!.sha256,
    ).toBe(createHash("sha256").update("version one").digest("hex"));
  });
  it("comments_tags_and_knowledge_persist_with_owner_guards", async () => {
    const a = await task();
    const comment = await exec("task_comment_add", {
      task_id: a.task_id,
      body: "نظر فارسی با متن untrusted",
    });
    expect(
      await service.query(
        "task_comment_list",
        { task_id: a.task_id },
        principal,
      ),
    ).toMatchObject({ total: 1, items: [{ comment_id: comment.entity_id }] });
    const tag = await exec("tag_create", { title: "پژوهش", color: "#123456" });
    await exec("task_tag_link", { task_id: a.task_id, tag_id: tag.entity_id });
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: a.task_id },
          principal,
        )) as TaskDTO
      ).tags![0].title,
    ).toBe("پژوهش");
    const knowledge = await exec("knowledge_create", {
      title: "Knowledge",
      body: "منبع پژوهش",
      url: "https://example.org/synthetic",
    });
    expect(
      await service.query("knowledge_search", { search: "پژوهش" }, principal),
    ).toMatchObject({ total: 1 });
    await expect(
      service.query(
        "knowledge_get",
        { knowledge_id: knowledge.entity_id },
        { ...principal, ownerId: "synthetic-other" },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
  });
  it("daily_inapp_reminders_deliver_once_and_reject_untrusted_job_principal", async () => {
    const a = await task();
    await exec("reminder_create", {
      task_id: a.task_id,
      remind_at: "2020-01-01T00:00:00Z",
    });
    await expect(exec("system_daily_run", {})).rejects.toMatchObject({
      code: "INSUFFICIENT_PERMISSIONS",
    });
    const system = { ...principal, channel: "system" as const };
    const delivered = await service.execute("system_daily_run", {}, system, {
      idempotencyKey: randomUUID(),
    });
    expect(delivered.data).toMatchObject({ delivered: 1, cancelled: 0 });
    const again = await service.execute("system_daily_run", {}, system, {
      idempotencyKey: randomUUID(),
    });
    expect(again.data).toMatchObject({ delivered: 0 });
    const notifications = (await service.query(
      "notifications_list",
      {},
      principal,
    )) as PageDTO<{ notification_id: string; revision: number }>;
    expect(notifications.total).toBe(1);
    await exec(
      "notification_mark_read",
      { notification_id: notifications.items[0].notification_id },
      notifications.items[0].revision,
    );
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ items: [{ read_at: expect.any(String) }] });
  });
  it("daily_job_cancels_non_actionable_closed_task_reminders", async () => {
    const a = await task();
    await exec("reminder_create", {
      task_id: a.task_id,
      remind_at: "2020-01-01T00:00:00Z",
    });
    await exec("task_complete", { task_id: a.task_id }, a.revision);
    const result = await service.execute(
      "system_daily_run",
      {},
      { ...principal, channel: "system" },
      { idempotencyKey: randomUUID() },
    );
    expect(result.data).toMatchObject({ delivered: 0, cancelled: 1 });
    expect(
      await service.query("notifications_list", {}, principal),
    ).toMatchObject({ total: 0 });
  });
  it("removed_dependency_can_restore_original_identity", async () => {
    const a = await task("A"),
      b = await task("B");
    const add = (await service.query(
      "task_dependency_add_preview",
      { task_id: a.task_id, prerequisites: [{ task_id: b.task_id }] },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_add_commit", { preview_id: add.preview_id });
    const initial = (await service.query(
        "task_get",
        { task_id: a.task_id },
        principal,
      )) as TaskDTO,
      edge = initial.prerequisites[0];
    const removal = (await service.query(
      "task_dependency_remove_preview",
      { task_id: a.task_id, edge_id: edge.edge_id },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_remove_commit", {
      preview_id: removal.preview_id,
    });
    const restoration = (await service.query(
      "task_dependency_restore_preview",
      { task_id: a.task_id, edge_id: edge.edge_id },
      principal,
    )) as PreviewDTO;
    await exec("task_dependency_restore_commit", {
      preview_id: restoration.preview_id,
    });
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: a.task_id },
          principal,
        )) as TaskDTO
      ).prerequisites[0].edge_id,
    ).toBe(edge.edge_id);
  });
  it("template_from_canonical_root_includes_complete_subtree_and_checklists", async () => {
    const a = await task("Root"),
      child = await exec("subtask_create", {
        title: "Child",
        parent_task_id: a.task_id,
      });
    await exec("task_checklist_create", {
      task_id: child.entity_id,
      title: "Child checklist",
    });
    const template = await exec("task_template_create", {
      title: "Captured tree",
      root_task_id: a.task_id,
    });
    const preview = (await service.query(
      "task_template_instantiate_preview",
      { template_id: template.entity_id },
      principal,
    )) as PreviewDTO;
    const cloned = await exec("task_template_instantiate_commit", {
      preview_id: preview.preview_id,
    });
    const mapping = (cloned.data as { id_mapping: Record<string, string> })
      .id_mapping;
    const copied = (await service.query(
      "task_get",
      { task_id: mapping[child.entity_id] },
      principal,
    )) as TaskDTO;
    expect(copied.parent_task_id).toBe(mapping[a.task_id]);
    expect(copied.checklists![0].title).toBe("Child checklist");
  });
});
