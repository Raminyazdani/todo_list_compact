import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type { DomainService, Principal } from "../../shared/contracts";
import {
  DEFAULT_TASK_ROW_LAYOUTS,
  TASK_ROW_FIELDS,
  parseTaskRowLayout,
  resolveTaskRowLayout,
  type TaskRowFieldId,
  type TaskRowFieldMode,
} from "../../shared/task-row-fields";
import { createTestDatabase } from "./database";

const layout = (...fields: [TaskRowFieldId, TaskRowFieldMode][]) =>
  parseTaskRowLayout({
    schema_version: 1,
    fields: fields.map(([id, mode]) => ({ id, mode })),
  });
const principal = (): Principal => ({
  ownerId: `synthetic-task-row-layout-${randomUUID()}`,
  actorId: "synthetic-row-layout-owner",
  channel: "UI",
  scopes: ["tasks:read", "tasks:write", "admin:manage"],
});

describe("Common per-view task row policy", () => {
  it("fixed_title_empty_explicit_layout_and_all_readonly_fields_keep_the_same_policy", () => {
    expect(layout()).toEqual({
      schema_version: 1,
      fields: [{ id: "title", mode: "display" }],
    });
    expect(
      layout(["priority", "edit"], ["title", "edit"], ["due_date", "display"])
        .fields,
    ).toEqual([
      { id: "title", mode: "edit" },
      { id: "priority", mode: "edit" },
      { id: "due_date", mode: "display" },
    ]);
    expect(new Set(TASK_ROW_FIELDS.map((field) => field.id)).size).toBe(
      TASK_ROW_FIELDS.length,
    );
    expect(
      TASK_ROW_FIELDS.filter((field) => field.editable)
        .map((field) => field.id)
        .sort(),
    ).toEqual([
      "category",
      "due_at",
      "due_date",
      "estimated_minutes",
      "next_action",
      "notes",
      "priority",
      "project_id",
      "source_reference",
      "start_date",
      "status",
      "timezone",
      "title",
      "waiting_for",
    ]);
    for (const field of TASK_ROW_FIELDS) {
      expect(layout([field.id, "display"])).toBeDefined();
      if (field.editable) expect(layout([field.id, "edit"])).toBeDefined();
      else expect(() => layout([field.id, "edit"])).toThrow();
    }
    for (const view of ["list", "tree"] as const) {
      const modes = new Map(
        DEFAULT_TASK_ROW_LAYOUTS[view].fields.map((field) => [
          field.id,
          field.mode,
        ]),
      );
      expect(modes.get("priority")).toBe("edit");
      expect(modes.get("status")).toBe("edit");
      expect(modes.get("due_date")).toBe("edit");
    }
  });

  it("saved_view_precedence_inheritance_and_corrupt_legacy_fallback_are_observable_without_mutating_inputs", () => {
    const preferenceLayouts = {
      list: layout(["priority", "display"]),
      tree: layout(["children_progress", "display"]),
    };
    const savedViewConfiguration = {
      filters: { status: "Next" },
      row_fields: { schema_version: 1, fields: [] },
    };
    const before = JSON.stringify({
      preferenceLayouts,
      savedViewConfiguration,
    });
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts,
        savedViewConfiguration,
      }),
    ).toEqual({ layout: layout(), source: "saved_view", invalid: false });
    expect(resolveTaskRowLayout({ view: "tree", preferenceLayouts })).toEqual({
      layout: preferenceLayouts.tree,
      source: "preferences",
      invalid: false,
    });
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts,
        savedViewConfiguration: {
          row_fields: { schema_version: 99, fields: [] },
        },
      }),
    ).toEqual({
      layout: preferenceLayouts.list,
      source: "preferences",
      invalid: true,
    });
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts: {
          list: { fields: [{ id: "readiness", mode: "edit" }] },
        },
      }),
    ).toEqual({
      layout: DEFAULT_TASK_ROW_LAYOUTS.list,
      source: "default",
      invalid: true,
    });
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts,
        savedViewConfiguration: { row_fields: null },
      }).source,
    ).toBe("preferences");
    expect(JSON.stringify({ preferenceLayouts, savedViewConfiguration })).toBe(
      before,
    );
    const resolved = resolveTaskRowLayout({ view: "list" });
    resolved.layout.fields.length = 0;
    expect(DEFAULT_TASK_ROW_LAYOUTS.list.fields.length).toBeGreaterThan(0);
  });
});

describe("Canonical persisted task row layouts", () => {
  let db: Database, service: DomainService;
  beforeAll(async () => {
    db = await createTestDatabase();
    service = createDomainService(db);
  });
  afterAll(async () => {
    await db.close?.();
  });

  it("preference_namespace_patches_preserve_other_views_theme_and_tasks_with_revision_receipts_and_one_audit", async () => {
    const owner = principal();
    const task = await service.execute(
      "task_create",
      {
        title: "Synthetic row layout invariant",
        estimated_minutes: 0,
      },
      owner,
      { idempotencyKey: randomUUID() },
    );
    await service.execute("task_complete", { task_id: task.entity_id }, owner, {
      idempotencyKey: randomUUID(),
      expectedRevision: 1,
    });
    const tasksBefore = (
      await db.query("SELECT * FROM tasks WHERE owner_id=$1", [owner.ownerId])
    ).rows;
    const start = await service.execute(
      "preferences_update",
      {
        settings: {
          theme: "dark",
          language: "fa",
          dashboard: { widget: "keep" },
          task_row_layouts: { tree: layout(["children_progress", "display"]) },
        },
      },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 0 },
    );
    const input = {
      settings: {
        task_row_layouts: {
          list: layout(["title", "edit"], ["priority", "edit"]),
        },
      },
    };
    const options = {
      idempotencyKey: randomUUID(),
      expectedRevision: start.version,
    };
    const result = await service.execute(
      "preferences_update",
      input,
      owner,
      options,
    );
    expect(result).toMatchObject({
      version: 2,
      affected_task_ids: [],
      readiness_changes: [],
    });
    expect(result.data).toMatchObject({
      settings: {
        theme: "dark",
        language: "fa",
        dashboard: { widget: "keep" },
        task_row_layouts: {
          list: input.settings.task_row_layouts.list,
          tree: layout(["children_progress", "display"]),
        },
      },
    });
    expect(
      await service.execute("preferences_update", input, owner, options),
    ).toEqual({ ...result, replayed: true });
    await expect(
      service.execute(
        "preferences_update",
        { settings: { task_row_layouts: { tree: layout() } } },
        owner,
        { idempotencyKey: randomUUID(), expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const audits = (
      await db.query(
        "SELECT * FROM activity_events WHERE owner_id=$1 AND event_id=$2",
        [owner.ownerId, result.audit_event_id],
      )
    ).rows;
    expect(audits).toEqual([
      expect.objectContaining({
        event_type: "preferences_update",
        actor_id: owner.actorId,
        channel: "UI",
        operation_id: result.operation_id,
        after: result.data,
      }),
    ]);
    const reset = await service.execute(
      "preferences_update",
      { settings: { task_row_layouts: { list: null } } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 2 },
    );
    expect(reset.data).toMatchObject({
      settings: {
        task_row_layouts: { tree: layout(["children_progress", "display"]) },
        theme: "dark",
      },
    });
    expect(
      (reset.data as { settings: { task_row_layouts: object } }).settings
        .task_row_layouts,
    ).not.toHaveProperty("list");
    const allReset = await service.execute(
      "preferences_update",
      { settings: { task_row_layouts: null } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 3 },
    );
    expect((allReset.data as { settings: object }).settings).not.toHaveProperty(
      "task_row_layouts",
    );
    expect(
      (await db.query("SELECT * FROM tasks WHERE owner_id=$1", [owner.ownerId]))
        .rows,
    ).toEqual(tasksBefore);
    expect(
      (
        await db.query(
          "SELECT * FROM activity_events WHERE owner_id=$1 AND event_type='preferences_update'",
          [owner.ownerId],
        )
      ).rows,
    ).toHaveLength(4);
  });

  it("invalid_schema_duplicates_editing_derived_and_task_specific_overrides_reject_atomically", async () => {
    const owner = principal();
    const invalid = [
      null,
      [],
      {},
      { schema_version: 2, fields: [] },
      { schema_version: 1, fields: [], task_id: "synthetic-task" },
      {
        schema_version: 1,
        fields: [
          { id: "priority", mode: "edit" },
          { id: "priority", mode: "display" },
        ],
      },
      { schema_version: 1, fields: [{ id: "readiness", mode: "edit" }] },
      { schema_version: 1, fields: [{ id: "title", mode: "hidden" }] },
      {
        schema_version: 1,
        fields: [{ id: "legacy_metadata", mode: "display" }],
      },
      { schema_version: 1, fields: [{ id: "priority", mode: "editable" }] },
      {
        schema_version: 1,
        fields: [{ id: "priority", mode: "edit", task_id: "synthetic-task" }],
      },
    ];
    for (const row_fields of invalid) {
      // Null means reset in storage, but is not a layout document.
      expect(() => parseTaskRowLayout(row_fields)).toThrow();
      if (row_fields === null) continue;
      for (const [command, input] of [
        [
          "preferences_update",
          { settings: { task_row_layouts: { list: row_fields } } },
        ],
        [
          "saved_view_create",
          { title: "Synthetic invalid view", configuration: { row_fields } },
        ],
      ] as const) {
        await expect(
          service.execute(command, input, owner, {
            idempotencyKey: randomUUID(),
            expectedRevision: 0,
          }),
        ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      }
    }
    for (const task_row_layouts of [
      [],
      "invalid",
      { "synthetic-task-id": layout() },
      { list: layout(), board: layout() },
    ])
      await expect(
        service.execute(
          "preferences_update",
          { settings: { task_row_layouts } },
          owner,
          { idempotencyKey: randomUUID(), expectedRevision: 0 },
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    for (const table of [
      "preferences",
      "saved_views",
      "activity_events",
      "idempotency_operations",
    ])
      expect(
        (
          await db.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [
            owner.ownerId,
          ])
        ).rows,
      ).toEqual([]);
  });

  it("saved_view_targeted_patch_reset_and_legacy_replacement_preserve_their_distinct_contracts", async () => {
    const owner = principal();
    const original = {
      filters: { status: "Waiting", project_id: null },
      layout: "tree",
      custom: { collapsed: true },
    };
    const created = await service.execute(
      "saved_view_create",
      { title: "Synthetic common view", configuration: original },
      owner,
      { idempotencyKey: randomUUID() },
    );
    const input = {
      view_id: created.entity_id,
      configuration: {
        row_fields: layout(["parent_task_id", "display"], ["status", "edit"]),
      },
    };
    const options = { idempotencyKey: randomUUID(), expectedRevision: 1 };
    const changed = await service.execute(
      "saved_view_update",
      input,
      owner,
      options,
    );
    expect(changed.data).toMatchObject({
      title: "Synthetic common view",
      configuration: { ...original, ...input.configuration },
      revision: 2,
    });
    expect(
      await service.execute("saved_view_update", input, owner, options),
    ).toEqual({ ...changed, replayed: true });
    await expect(
      service.execute(
        "saved_view_update",
        { view_id: created.entity_id, configuration: { row_fields: layout() } },
        owner,
        { idempotencyKey: randomUUID(), expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const reset = await service.execute(
      "saved_view_update",
      { view_id: created.entity_id, configuration: { row_fields: null } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 2 },
    );
    expect(reset.data).toMatchObject({ configuration: original, revision: 3 });
    const replacement = await service.execute(
      "saved_view_update",
      { view_id: created.entity_id, configuration: {} },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 3 },
    );
    expect(replacement.data).toMatchObject({ configuration: {}, revision: 4 });
    await expect(
      service.execute(
        "saved_view_update",
        {
          view_id: created.entity_id,
          configuration: {
            row_fields: {
              schema_version: 1,
              fields: [{ id: "created_at", mode: "edit" }],
            },
          },
        },
        owner,
        { idempotencyKey: randomUUID(), expectedRevision: 4 },
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await service.query("saved_view_list", {}, owner)).toMatchObject({
      items: [{ configuration: {}, revision: 4 }],
    });
  });

  it("layout_modes_never_grant_write_permission_or_cross_owner_view_access", async () => {
    const owner = principal(),
      other = principal();
    const view = await service.execute(
      "saved_view_create",
      {
        title: "Synthetic private layout",
        configuration: { row_fields: layout(["title", "edit"]) },
      },
      owner,
      { idempotencyKey: randomUUID() },
    );
    const readonly = {
      ...owner,
      channel: "MCP" as const,
      scopes: ["tasks:read"],
    };
    for (const [command, input] of [
      [
        "preferences_update",
        { settings: { task_row_layouts: { list: layout() } } },
      ],
      [
        "saved_view_update",
        { view_id: view.entity_id, configuration: { row_fields: layout() } },
      ],
    ] as const)
      await expect(
        service.execute(command, input, readonly, {
          idempotencyKey: randomUUID(),
          expectedRevision: 1,
        }),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute(
        "saved_view_update",
        { view_id: view.entity_id, configuration: { row_fields: layout() } },
        other,
        { idempotencyKey: randomUUID(), expectedRevision: 1 },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(await service.query("saved_view_list", {}, other)).toMatchObject({
      items: [],
      total: 0,
    });
    expect(await service.query("preferences_get", {}, other)).toEqual({
      settings: {},
      revision: 0,
    });
    expect(await service.query("saved_view_list", {}, readonly)).toMatchObject({
      items: [{ view_id: view.entity_id, revision: 1 }],
    });
    const mcp = {
      ...owner,
      actorId: "synthetic-layout-mcp-client",
      channel: "MCP" as const,
      scopes: ["tasks:read", "tasks:write"],
    };
    const accepted = await service.execute(
      "preferences_update",
      {
        settings: { task_row_layouts: { list: layout(["due_date", "edit"]) } },
      },
      mcp,
      { idempotencyKey: randomUUID(), expectedRevision: 0 },
    );
    expect(
      (
        await db.query(
          "SELECT actor_id,channel,after FROM activity_events WHERE owner_id=$1 AND event_id=$2",
          [owner.ownerId, accepted.audit_event_id],
        )
      ).rows,
    ).toEqual([
      { actor_id: mcp.actorId, channel: "MCP", after: accepted.data },
    ]);
  });

  it("old_corrupt_layouts_do_not_break_unrelated_preference_or_title_updates_and_can_be_reset", async () => {
    const owner = principal();
    await db.query("INSERT INTO owners(owner_id) VALUES($1)", [owner.ownerId]);
    await db.query(
      "INSERT INTO preferences(owner_id,settings,revision) VALUES($1,$2::jsonb,1)",
      [
        owner.ownerId,
        JSON.stringify({
          theme: "dark",
          task_row_layouts: { list: { schema_version: 0, fields: [] } },
        }),
      ],
    );
    const result = await service.execute(
      "preferences_update",
      { settings: { language: "fa" } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    const settings = (result.data as { settings: Record<string, unknown> })
      .settings;
    expect(settings).toMatchObject({
      theme: "dark",
      language: "fa",
      task_row_layouts: { list: { schema_version: 0 } },
    });
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts: settings.task_row_layouts,
      }),
    ).toMatchObject({ invalid: true, source: "default" });
    const fixed = await service.execute(
      "preferences_update",
      { settings: { task_row_layouts: { list: layout() } } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 2 },
    );
    expect(
      resolveTaskRowLayout({
        view: "list",
        preferenceLayouts: (fixed.data as { settings: Record<string, unknown> })
          .settings.task_row_layouts,
      }),
    ).toEqual({ invalid: false, source: "preferences", layout: layout() });
    const viewId = "synthetic-corrupt-view-" + randomUUID();
    const legacy = {
      filters: { status: "Waiting" },
      layout: "list",
      row_fields: { schema_version: 0, fields: [] },
    };
    await db.query(
      "INSERT INTO saved_views(view_id,owner_id,title,configuration) VALUES($1,$2,$3,$4::jsonb)",
      [viewId, owner.ownerId, "Synthetic legacy view", JSON.stringify(legacy)],
    );
    const renamed = await service.execute(
      "saved_view_update",
      { view_id: viewId, title: "Synthetic renamed legacy view" },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 1 },
    );
    expect(renamed.data).toMatchObject({ configuration: legacy, revision: 2 });
    const reset = await service.execute(
      "saved_view_update",
      { view_id: viewId, configuration: { row_fields: null } },
      owner,
      { idempotencyKey: randomUUID(), expectedRevision: 2 },
    );
    expect(reset.data).toMatchObject({
      configuration: { filters: { status: "Waiting" }, layout: "list" },
      revision: 3,
    });
    expect(
      (reset.data as { configuration: object }).configuration,
    ).not.toHaveProperty("row_fields");
  });

  it("existing_backup_format_roundtrips_new_layouts_receipts_and_legacy_absence_without_schema_migration", async () => {
    for (const includeLayouts of [false, true]) {
      const owner = principal();
      const input = {
        settings: {
          theme: "dark",
          ...(includeLayouts
            ? {
                task_row_layouts: {
                  list: layout(["notes", "edit"]),
                  tree: layout(),
                },
              }
            : {}),
        },
      };
      const options = { idempotencyKey: randomUUID(), expectedRevision: 0 };
      const receipt = await service.execute(
        "preferences_update",
        input,
        owner,
        options,
      );
      await service.execute(
        "saved_view_create",
        {
          title: "Synthetic backed-up view",
          configuration: {
            filters: { status: "Next" },
            layout: "list",
            ...(includeLayouts ? { row_fields: layout() } : {}),
          },
        },
        owner,
        { idempotencyKey: randomUUID() },
      );
      const backup = await service.query("backup_export", {}, owner);
      const fresh = await createTestDatabase();
      try {
        const restored = createDomainService(fresh);
        await restored.execute(
          "backup_restore",
          { backup, explicit_user_intent: true },
          owner,
          { idempotencyKey: randomUUID() },
        );
        expect(await restored.query("preferences_get", {}, owner)).toEqual(
          await service.query("preferences_get", {}, owner),
        );
        expect(await restored.query("saved_view_list", {}, owner)).toEqual(
          await service.query("saved_view_list", {}, owner),
        );
        expect(
          await restored.execute("preferences_update", input, owner, options),
        ).toEqual({ ...receipt, replayed: true });
      } finally {
        await fresh.close?.();
      }
    }
  }, 30000);
});
