import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  PageDTO,
  PreviewDTO,
  Principal,
  QueryName,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
  key = randomUUID(),
) =>
  service.execute(command, input, principal, {
    idempotencyKey: key,
    expectedRevision: revision,
  });
const query = <T>(operation: QueryName, input: Record<string, unknown> = {}) =>
  service.query(operation, input, principal) as Promise<T>;
const task = async (title = "Synthetic") => {
  const created = await exec("task_create", { title });
  return query<TaskDTO>("task_get", { task_id: created.entity_id });
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
afterAll(async () => {
  await db.close?.();
});
describe("Negative boundary and complete resource workflows", () => {
  it("task_dates_identity_and_revision_reject_invalid_or_server_managed_values", async () => {
    for (const invalid of [
      { due_date: "2030-99-99" },
      { due_date: "2030-02-30" },
      { due_at: "2030-01-01T10:00" },
      { timezone: "Invalid/Zone" },
      { estimated_minutes: -2 },
      { estimated_minutes: 1.5 },
      { status: "Blocked" },
      { title: "" },
    ])
      await expect(
        exec("task_create", { title: "Synthetic", ...invalid }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const a = await task();
    await expect(
      exec("task_update", { task_id: a.task_id, title: "Edit" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const field of ["owner_id", "created_at", "revision", "closed_at"])
      await expect(
        exec(
          "task_update",
          { task_id: a.task_id, [field]: "forged" },
          a.revision,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await exec(
      "task_update",
      {
        task_id: a.task_id,
        due_date: "2032-02-29",
        due_at: "2032-02-29T10:00:00+01:00",
        start_date: "2032-02-20",
        timezone: "Europe/Berlin",
        estimated_minutes: 45,
        priority: "Urgent",
        category: "Research",
        waiting_for: "Synthetic owner response",
        source_reference: "synthetic:source",
        sort_key: 12,
      },
      a.revision,
    );
    expect(await query("task_get", { task_id: a.task_id })).toMatchObject({
      due_date: "2032-02-29",
      due_at: "2032-02-29T09:00:00.000Z",
      estimated_minutes: 45,
      priority: "Urgent",
    });
  });
  it("task_archiving_restore_and_metadata_undo_are_revision_safe", async () => {
    const a = await task("Original");
    const edit = await exec(
      "task_update",
      { task_id: a.task_id, title: "Edited", notes: "Synthetic" },
      a.revision,
    );
    await exec("undo_last_eligible_action", {}, edit.version);
    expect(await query("task_get", { task_id: a.task_id })).toMatchObject({
      title: "Original",
      notes: "",
    });
    const current = await query<TaskDTO>("task_get", { task_id: a.task_id });
    const archived = await exec(
      "task_archive",
      { task_id: a.task_id },
      current.revision,
    );
    expect(await query("task_search")).toMatchObject({ total: 0 });
    await exec("undo_last_eligible_action", {}, archived.version);
    expect(await query("task_search")).toMatchObject({ total: 1 });
    await expect(
      exec("undo_last_eligible_action", {}, 1),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("idempotency_scope_and_operation_boundaries_cannot_be_bypassed", async () => {
    const key = randomUUID();
    await exec("task_create", { title: "Original" }, undefined, key);
    await expect(
      exec("task_create", { title: "Different" }, undefined, key),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.execute(
        "task_create",
        { title: "Forbidden" },
        { ...principal, scopes: ["tasks:read"] },
        { idempotencyKey: randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute("unsupported" as CommandName, {}, principal, {
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(query("unsupported" as QueryName)).rejects.toMatchObject({
      code: "UNSUPPORTED_OPERATION",
    });
    await expect(
      service.execute("task_create", { title: "Invalid key" }, principal, {
        idempotencyKey: "x",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      service.query("task_search", {}, { ...principal, ownerId: "" }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });
  it("owner_project_milestone_and_saved_preferences_round_trip_without_lost_fields", async () => {
    const project = await exec("project_create", {
      title: "Synthetic project",
      notes: "Initial",
      due_date: "2030-01-01",
    });
    const update = await exec(
      "project_update",
      {
        project_id: project.entity_id,
        title: "Updated",
        notes: "Decision log",
        area: "Research",
        status: "Active",
        due_date: null,
      },
      project.version,
    );
    expect(
      await query("project_get", { project_id: project.entity_id }),
    ).toMatchObject({
      title: "Updated",
      notes: "Decision log",
      due_date: null,
    });
    const a = await task();
    await exec("project_milestone_create", {
      project_id: project.entity_id,
      title: "Review",
      due_date: "2030-02-01",
      task_id: a.task_id,
    });
    expect(
      await query("project_milestone_list", { project_id: project.entity_id }),
    ).toMatchObject({ total: 1 });
    await expect(
      exec("project_milestone_create", {
        project_id: project.entity_id,
        title: "No date",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec(
        "project_update",
        { project_id: project.entity_id, title: "Stale" },
        project.version,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(update.version).toBe(2);
    const pref = await exec("preferences_update", {
      settings: { language: "fa", display_density: "compact" },
    });
    await exec(
      "preferences_update",
      { settings: { theme: "dark" } },
      pref.version,
    );
    expect(await query("preferences_get")).toMatchObject({
      settings: { language: "fa", display_density: "compact", theme: "dark" },
    });
    const view = await exec("saved_view_create", {
      title: "Ready",
      configuration: { readiness: "ready" },
    });
    await exec(
      "saved_view_update",
      {
        view_id: view.entity_id,
        title: "Ready now",
        configuration: { readiness: "ready", density: "compact" },
      },
      view.version,
    );
    expect(await query("saved_view_list")).toMatchObject({
      total: 1,
      items: [{ title: "Ready now" }],
    });
  });
  it("time_and_calendar_edit_archive_preserve_separate_entities_and_intervals", async () => {
    const a = await task();
    const event = await exec("calendar_create_local_event", {
      title: "Synthetic event",
      starts_at: "2030-01-01T09:00:00Z",
      ends_at: "2030-01-01T10:00:00Z",
      task_id: a.task_id,
    });
    const updated = await exec(
      "calendar_update_local_event",
      {
        event_id: event.entity_id,
        title: "Moved",
        starts_at: "2030-01-01T11:00:00Z",
        ends_at: "2030-01-01T12:00:00Z",
      },
      event.version,
    );
    expect(await query("calendar_list")).toMatchObject({ total: 1 });
    expect(
      await query("calendar_availability", {
        from: "2030-01-01T00:00:00Z",
        to: "2030-01-02T00:00:00Z",
      }),
    ).toMatchObject({
      busy: [
        { event_id: event.entity_id, starts_at: "2030-01-01T11:00:00.000Z" },
      ],
    });
    await exec(
      "calendar_delete_local_event",
      { event_id: event.entity_id },
      updated.version,
    );
    const entry = await exec("time_entry_create", {
      employer: "Jena",
      description: "Original",
      starts_at: "2030-01-01T09:00:00Z",
      ends_at: "2030-01-01T10:00:00Z",
      task_id: a.task_id,
    });
    const edited = await exec(
      "time_entry_update",
      {
        entry_id: entry.entity_id,
        employer: "Seewiesen",
        description: "Revised",
        ends_at: "2030-01-01T10:30:00Z",
      },
      entry.version,
    );
    expect(
      await query("time_summary", {
        from: "2030-01-01T00:00:00Z",
        to: "2030-01-02T00:00:00Z",
        employer: "Seewiesen",
      }),
    ).toMatchObject({ minutes: 90, employers: { Seewiesen: 90 } });
    await exec(
      "time_entry_archive",
      { entry_id: entry.entity_id },
      edited.version,
    );
    expect(await query("time_entry_list")).toMatchObject({ total: 0 });
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id })).status,
    ).toBe("Inbox");
    await expect(
      exec("time_entry_create", {
        employer: "Jena",
        starts_at: "2030-01-01T10:00:00Z",
        ends_at: "2030-01-01T09:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("external_calendar_and_drive_original_mutations_fail_closed", async () => {
    const event = await exec("calendar_create_local_event", {
      title: "Provider event",
      starts_at: "2030-01-01T09:00:00Z",
      ends_at: "2030-01-01T10:00:00Z",
    });
    await db.query(
      "UPDATE calendar_events SET provider='google' WHERE event_id=$1",
      [event.entity_id],
    );
    await expect(
      exec(
        "calendar_update_local_event",
        { event_id: event.entity_id, title: "Forbidden external write" },
        event.version,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const file = await exec("file_register_external_link", {
      title: "Synthetic source file",
      external_url: "https://drive.google.com/file/d/synthetic/view",
    });
    await expect(
      exec(
        "file_archive",
        { file_id: file.entity_id, explicit_user_intent: true },
        file.version,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      exec("file_restore", { file_id: file.entity_id }, file.version),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    await expect(
      exec("file_register_external_link", {
        title: "Bad URL",
        external_url: "https://private.invalid/file",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("comment_tag_and_knowledge_edits_recover_without_cross_owner_projection", async () => {
    const a = await task(),
      comment = await exec("task_comment_add", {
        task_id: a.task_id,
        body: "Original",
      });
    const edited = await exec(
      "task_comment_update",
      { comment_id: comment.entity_id, body: "Edited" },
      comment.version,
    );
    await exec(
      "task_comment_archive",
      { comment_id: comment.entity_id },
      edited.version,
    );
    expect(
      await query("task_comment_list", { task_id: a.task_id }),
    ).toMatchObject({ total: 0 });
    const tag = await exec("tag_create", { title: "Research" });
    const duplicate = await exec("tag_create", { title: "Research" });
    expect(duplicate.entity_id).toBe(tag.entity_id);
    await exec("task_tag_link", { task_id: a.task_id, tag_id: tag.entity_id });
    let current = await query<TaskDTO>("task_get", { task_id: a.task_id });
    await exec(
      "task_tag_unlink",
      { task_id: a.task_id, tag_id: tag.entity_id },
      current.revision,
    );
    current = await query<TaskDTO>("task_get", { task_id: a.task_id });
    expect(current.tags).toHaveLength(0);
    await exec("task_tag_link", { task_id: a.task_id, tag_id: tag.entity_id });
    expect(await query("tag_list")).toMatchObject({ total: 1 });
    const project = await exec("project_create", {
      title: "Synthetic knowledge project",
    });
    const knowledge = await exec("knowledge_create", {
      title: "Knowledge",
      body: "Original",
      project_id: project.entity_id,
    });
    await exec(
      "knowledge_update",
      {
        knowledge_id: knowledge.entity_id,
        title: "Updated",
        body: "Revised",
        url: "https://example.org/synthetic",
      },
      knowledge.version,
    );
    expect(
      await query("knowledge_search", {
        project_id: project.entity_id,
        search: "revised",
      }),
    ).toMatchObject({ total: 1 });
    await expect(
      exec(
        "knowledge_update",
        { knowledge_id: knowledge.entity_id, url: "javascript:alert(1)" },
        2,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec("tag_create", { title: "Invalid", color: "red" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("preview_expiry_wrong_group_and_mixed_revision_conflicts_preserve_graph", async () => {
    const a = await task("A"),
      b = await task("B"),
      c = await task("C");
    const p = await query<PreviewDTO>("task_dependency_add_preview", {
      task_id: a.task_id,
      prerequisites: [{ task_id: b.task_id }],
    });
    await db.query(
      "UPDATE command_previews SET expires_at=now()-interval'1 second' WHERE preview_id=$1",
      [p.preview_id],
    );
    await expect(
      exec("task_dependency_add_commit", { preview_id: p.preview_id }),
    ).rejects.toMatchObject({ code: "PREVIEW_EXPIRED" });
    await expect(
      exec("task_dependency_add_commit", { preview_id: "absent" }),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    const fresh = await query<PreviewDTO>("task_dependency_add_preview", {
      task_id: a.task_id,
      prerequisites: [{ task_id: b.task_id }],
    });
    await exec("task_dependency_add_commit", { preview_id: fresh.preview_id });
    const edge = (await query<TaskDTO>("task_get", { task_id: a.task_id }))
      .prerequisites[0];
    await expect(
      query("task_dependency_remove_preview", {
        task_id: c.task_id,
        edge_id: edge.edge_id,
      }),
    ).rejects.toMatchObject({ code: "INVALID_DEPENDENCY_GROUP" });
    await exec(
      "task_dependency_group_update",
      { group_id: edge.group_id, operator: "ANY", enabled: false },
      1,
    );
    expect(await query("task_get", { task_id: a.task_id })).toMatchObject({
      readiness: "ready",
    });
    await exec(
      "task_dependency_group_update",
      { group_id: edge.group_id, operator: "ALL", enabled: true },
      2,
    );
    expect(await query("task_get", { task_id: a.task_id })).toMatchObject({
      readiness: "blocked",
    });
  });
  it("task_query_filters_pagination_projection_and_graph_directions_agree", async () => {
    const project = await exec("project_create", { title: "Synthetic" }),
      a = await exec("task_create", {
        title: "فارسی ي ك ۱۲",
        notes: "Searchable",
        project_id: project.entity_id,
        due_date: "2020-01-01",
      }),
      b = await task("B");
    const p = await query<PreviewDTO>("task_dependency_add_preview", {
      task_id: b.task_id,
      prerequisites: [{ task_id: a.entity_id }],
    });
    await exec("task_dependency_add_commit", { preview_id: p.preview_id });
    expect(
      await query("task_search", {
        search: "فارسی ی ک 12",
        project_id: project.entity_id,
        status: "Inbox",
      }),
    ).toMatchObject({ total: 1 });
    expect(await query("task_list_overdue")).toMatchObject({ total: 1 });
    const first = await query<PageDTO<TaskDTO>>("task_search", { limit: 1 });
    expect(
      (
        await query<PageDTO<TaskDTO>>("task_search", {
          limit: 1,
          cursor: first.next_cursor,
        })
      ).items[0].task_id,
    ).not.toBe(first.items[0].task_id);
    await expect(query("task_search", { limit: 500 })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    await expect(
      query("task_search", { cursor: "bm90LWFuLWlk" }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await query("task_graph_get", {
        task_id: b.task_id,
        direction: "upstream",
      }),
    ).toMatchObject({ total: 2 });
    expect(
      await query("task_graph_get", {
        task_id: a.entity_id,
        direction: "both",
      }),
    ).toMatchObject({ total: 2 });
    expect(
      await query("task_dependencies_get", { task_id: b.task_id }),
    ).toMatchObject({ blocked_by: [{ task_id: a.entity_id }] });
    expect(await query("search_all", { search: "searchable" })).toMatchObject({
      tasks: { total: 1 },
    });
    expect(await query("whoami")).toMatchObject({
      owner_id: principal.ownerId,
    });
    expect(await query("system_health")).toMatchObject({ status: "ok" });
    expect(await query("system_capabilities")).toMatchObject({ graph: true });
    expect(await query("export_data_manifest")).toHaveProperty("manifest_hash");
    const restricted = (await service.query(
      "task_get",
      { task_id: a.entity_id },
      { ...principal, scopes: ["tasks:read"] },
    )) as TaskDTO;
    expect(restricted.files).toHaveLength(0);
    expect(restricted.activity).toHaveLength(0);
  });
  it("subtask_detach_keeps_identity_history_and_parent_rollups", async () => {
    const a = await task("Root"),
      child = await exec("subtask_create", {
        title: "Child",
        parent_task_id: a.task_id,
      });
    expect(await query("subtask_list", { task_id: a.task_id })).toMatchObject({
      total: 1,
    });
    const p = await query<PreviewDTO>("subtask_reparent_preview", {
      task_id: child.entity_id,
      parent_task_id: null,
    });
    await exec("subtask_reparent_commit", { preview_id: p.preview_id });
    expect(await query("task_get", { task_id: child.entity_id })).toMatchObject(
      { task_id: child.entity_id, parent_task_id: null },
    );
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id }))
        .children_progress.total,
    ).toBe(0);
  });
  it("checklist_edit_duplicate_uncheck_archive_restore_preserves_actual_items_and_progress", async () => {
    const a = await task(),
      list = await exec("task_checklist_create", {
        task_id: a.task_id,
        title: "Original",
      }),
      row = await exec(
        "task_checklist_item_add",
        {
          checklist_id: list.entity_id,
          title: "Evidence",
          notes: "Original note",
        },
        list.version,
      );
    await exec(
      "task_checklist_item_update",
      {
        item_id: row.entity_id,
        title: "Updated evidence",
        notes: "Retained note",
      },
      row.version,
    );
    const checked = await exec(
      "task_checklist_item_check",
      { item_id: row.entity_id },
      2,
    );
    await exec(
      "task_checklist_item_uncheck",
      { item_id: row.entity_id },
      checked.version,
    );
    const current = (await query<TaskDTO>("task_get", { task_id: a.task_id }))
      .checklists![0];
    const duplicate = await exec(
      "task_checklist_duplicate",
      { checklist_id: current.checklist_id, title: "Copied" },
      current.revision,
    );
    const copied = (
      await query<TaskDTO>("task_get", { task_id: a.task_id })
    ).checklists!.find((c) => c.checklist_id === duplicate.entity_id)!;
    expect(copied.items[0]).toMatchObject({
      title: "Updated evidence",
      notes: "Retained note",
      checked: false,
    });
    expect(copied.items[0].item_id).not.toBe(row.entity_id);
    const edited = await exec(
      "task_checklist_update",
      { checklist_id: copied.checklist_id, title: "Copy renamed", sort_key: 5 },
      copied.revision,
    );
    const archived = await exec(
      "task_checklist_archive",
      { checklist_id: copied.checklist_id },
      edited.version,
    );
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id }))
        .checklist_progress.total,
    ).toBe(1);
    await exec(
      "task_checklist_restore",
      { checklist_id: copied.checklist_id },
      archived.version,
    );
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id }))
        .checklist_progress.total,
    ).toBe(2);
    await expect(
      exec(
        "task_checklist_item_reorder",
        { checklist_id: copied.checklist_id, item_ids: [row.entity_id] },
        4,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("hierarchy_depth_and_deferred_database_cycle_guards_reject_unsafe_structures", async () => {
    let current = await task("Root");
    for (let index = 1; index < 12; index++) {
      const child = await exec("subtask_create", {
        title: `Depth ${index}`,
        parent_task_id: current.task_id,
      });
      current = await query<TaskDTO>("task_get", { task_id: child.entity_id });
    }
    await expect(
      exec("subtask_create", {
        title: "Depth overflow",
        parent_task_id: current.task_id,
      }),
    ).rejects.toMatchObject({ code: "HIERARCHY_DEPTH" });
    await expect(
      db.transaction(principal.ownerId, async (tx) => {
        const a = randomUUID(),
          b = randomUUID();
        await tx.query(
          "INSERT INTO tasks(task_id,owner_id,title,parent_task_id) VALUES($1,$2,$3,$4)",
          [a, principal.ownerId, "Synthetic deferred cycle A", b],
        );
        await tx.query(
          "INSERT INTO tasks(task_id,owner_id,title,parent_task_id) VALUES($1,$2,$3,$4)",
          [b, principal.ownerId, "Synthetic deferred cycle B", a],
        );
      }),
    ).rejects.toThrow("HIERARCHY_CYCLE");
  });
  it("eligible_undo_redo_retry_preserves_idempotency_and_refuses_intervening_edits", async () => {
    const a = await task("Original"),
      edit = await exec(
        "task_update",
        { task_id: a.task_id, title: "Edited" },
        a.revision,
      ),
      undo = await exec("undo_last_eligible_action", {}, edit.version),
      key = randomUUID();
    const redo = await exec("redo_last_eligible_action", {}, undo.version, key);
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id })).title,
    ).toBe("Edited");
    expect(
      (await exec("redo_last_eligible_action", {}, undo.version, key)).replayed,
    ).toBe(true);
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id })).revision,
    ).toBe(redo.version);
    const undoneAgain = await exec(
      "undo_last_eligible_action",
      {},
      redo.version,
    );
    await exec(
      "task_update",
      { task_id: a.task_id, notes: "Another edit" },
      undoneAgain.version,
    );
    await expect(
      exec("redo_last_eligible_action", {}, undoneAgain.version + 1),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });
  it("selected_graph_context_keeps_cross_project_prerequisites_and_reports_page_boundaries", async () => {
    const p = await exec("project_create", {
        title: "Synthetic external project",
      }),
      a = await task("Search root only"),
      b = await exec("task_create", {
        title: "Hidden by inventory filter",
        project_id: p.entity_id,
      });
    const preview = await query<PreviewDTO>("task_dependency_add_preview", {
      task_id: a.task_id,
      prerequisites: [{ task_id: b.entity_id }],
    });
    await exec("task_dependency_add_commit", {
      preview_id: preview.preview_id,
    });
    const complete = await query<{
      nodes: TaskDTO[];
      total: number;
      truncated: boolean;
    }>("task_graph_get", {
      task_id: a.task_id,
      direction: "upstream",
      search: "Search root only",
      project_id: "different-project",
      status: "Done",
    });
    expect(complete.total).toBe(2);
    expect(complete.nodes.map((node) => node.task_id)).toContain(b.entity_id);
    const paged = await query<{
      nodes: TaskDTO[];
      hidden_neighbor_count: number;
      boundary_edges: { prerequisite_task_id: string }[];
      truncated: boolean;
    }>("task_graph_get", { task_id: a.task_id, direction: "both", limit: 1 });
    expect(paged.nodes[0].task_id).toBe(a.task_id);
    expect(paged.hidden_neighbor_count).toBe(1);
    expect(paged.boundary_edges[0].prerequisite_task_id).toBe(b.entity_id);
    expect(paged.truncated).toBe(true);
    expect(paged.nodes[0].prerequisites[0].prerequisite_task_id).toBe(
      b.entity_id,
    );
  });
  it("task_detail_undo_redo_is_bound_to_selected_task_even_when_latest_other_task_revision_matches", async () => {
    const a = await task("Original A"),
      b = await task("Original B");
    const changedA = await exec(
      "task_update",
      { task_id: a.task_id, title: "Edited A" },
      a.revision,
    );
    await exec(
      "task_update",
      { task_id: b.task_id, title: "Edited B" },
      b.revision,
    );
    const undone = await exec(
      "undo_last_eligible_action",
      { task_id: a.task_id },
      changedA.version,
    );
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id })).title,
    ).toBe("Original A");
    expect(
      (await query<TaskDTO>("task_get", { task_id: b.task_id })).title,
    ).toBe("Edited B");
    await exec(
      "redo_last_eligible_action",
      { task_id: a.task_id },
      undone.version,
    );
    expect(
      (await query<TaskDTO>("task_get", { task_id: a.task_id })).title,
    ).toBe("Edited A");
    expect(
      (await query<TaskDTO>("task_get", { task_id: b.task_id })).title,
    ).toBe("Edited B");
  });
});
