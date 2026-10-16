import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { z } from "zod";
import { TOOL_CATALOG, toolDescription } from "../../server/mcp/catalog";
import { createDomainService } from "../../server/domain/service";
import { createTestDatabase } from "../domain/database";
import type { Database } from "../../server/db/database";
import {
  COMMAND_NAMES,
  QUERY_NAMES,
  type CommandName,
  type DomainService,
  type Principal,
  type QueryName,
  type TaskDTO,
  type PreviewDTO,
  type PageDTO,
  type EventDTO,
  type FileDTO,
  type ReportsDTO,
} from "../../shared/contracts";

let db: Database, service: DomainService, principal: Principal;
const tool = (name: string) => {
  const found = TOOL_CATALOG.find((entry) => entry.name === name);
  if (!found) throw new Error("Missing offered tool: " + name);
  return found;
};
const write = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
  actor = principal,
  operationId = randomUUID(),
) => {
  const parsed = tool(name).schema.parse({
    input,
    operation_id: operationId,
    ...(revision !== undefined ? { expected_revision: revision } : {}),
  }) as {
    input: Record<string, unknown>;
    operation_id: string;
    expected_revision?: number;
  };
  return service.execute(name, parsed.input, actor, {
    idempotencyKey: parsed.operation_id,
    expectedRevision: parsed.expected_revision,
  });
};
const read = (
  name: QueryName,
  input: Record<string, unknown>,
  actor = principal,
) =>
  service.query(
    name,
    tool(name).schema.parse(input) as Record<string, unknown>,
    actor,
  );
const task = async (title = "Synthetic owner task") => {
  const created = await write("task_create", { title });
  return read("task_get", { task_id: created.entity_id }) as Promise<TaskDTO>;
};
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: "catalog-synthetic-" + randomUUID(),
    actorId: "catalog-owner",
    channel: "MCP",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});

describe("MCP advertised schemas against the real canonical PostgreSQL service", () => {
  it("offers every supported safe operation with concrete serializable properties, explicit semantics and least required scopes", () => {
    const excluded = new Set([
      "legacy_import",
      "backup_restore",
      "file_register_upload",
      "system_daily_run",
      "backup_export",
    ]);
    const expected = [...QUERY_NAMES, ...COMMAND_NAMES].filter(
      (name) => !excluded.has(name),
    );
    expect(TOOL_CATALOG.map((entry) => entry.name).sort()).toEqual(
      expected.sort(),
    );
    expect(new Set(TOOL_CATALOG.map((entry) => entry.name)).size).toBe(
      expected.length,
    );
    for (const entry of TOOL_CATALOG) {
      const schema = z.toJSONSchema(entry.schema) as {
        type?: string;
        properties?: Record<string, unknown>;
        additionalProperties?: unknown;
        required?: string[];
      };
      expect(schema.type, entry.name).toBe("object");
      expect(schema.additionalProperties, entry.name).toBe(false);
      expect(schema.properties, entry.name).toBeDefined();
      const description = toolDescription(entry.name, entry.readOnly);
      expect(description, entry.name).not.toContain(
        "canonical " + entry.name.replaceAll("_", " ") + " operation",
      );
      expect(description.length, entry.name).toBeGreaterThan(80);
      if (!entry.readOnly) {
        expect(schema.required, entry.name).toContain("input");
        expect(schema.required, entry.name).toContain("operation_id");
        const input = schema.properties!.input as {
          type: string;
          properties: Record<string, unknown>;
          additionalProperties: unknown;
        };
        expect(input.type, entry.name).toBe("object");
        expect(
          Object.keys(input.properties).length,
          entry.name,
        ).toBeGreaterThan(0);
        expect(input.additionalProperties, entry.name).toBe(false);
      }
    }
    expect(tool("task_dependency_add_preview").scopes).toEqual(["tasks:write"]);
    expect(tool("calendar_occurrence_reschedule_preview").scopes).toEqual([
      "calendar:write",
    ]);
    expect(tool("time_entry_import_preview").scopes).toEqual(["time:write"]);
    expect(tool("project_dependency_summary").scopes).toEqual([
      "projects:read",
      "tasks:read",
    ]);
    expect(tool("export_data_manifest").scopes).toEqual(["backup:export"]);
    expect(tool("whoami").scopes).toEqual([]);
    expect(tool("calendar_events_query").openWorld).toBe(true);
    expect(tool("file_register_external_link").openWorld).toBe(false);
    expect(tool("reminder_cancel").destructive).toBe(true);
  });
  it("rejects absent required IDs, unsafe authorization properties and out-of-bounds payloads before execution", () => {
    for (const name of [
      "task_get",
      "file_get_metadata",
      "task_dependency_remove_preview",
      "calendar_occurrence_reschedule_preview",
    ])
      expect(tool(name).schema.safeParse({}).success, name).toBe(false);
    expect(
      tool("task_create").schema.safeParse({
        input: { title: "Accepted", explicit_user_intent: true },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      tool("task_update").schema.safeParse({
        input: { task_id: "T", title: "Changed" },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      tool("task_update").schema.safeParse({
        input: { task_id: "T", parent_task_id: "Other" },
        operation_id: randomUUID(),
        expected_revision: 1,
      }).success,
    ).toBe(false);
    expect(tool("task_search").schema.safeParse({ limit: 201 }).success).toBe(
      false,
    );
    expect(
      tool("task_search").schema.safeParse({ due_from: "2027-02-30" }).success,
    ).toBe(false);
    expect(
      tool("task_create").schema.safeParse({
        input: { title: "x".repeat(2001) },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      tool("dependency_topological_plan").schema.safeParse({
        task_id: "A",
        task_ids: ["B"],
      }).success,
    ).toBe(false);
    expect(
      tool("task_batch_preview").schema.safeParse({
        task_ids: ["A"],
        action: "complete",
        actions: [],
      }).success,
    ).toBe(false);
    expect(
      tool("task_dependency_waive_commit").schema.safeParse({
        input: { preview_id: "P" },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      tool("calendar_create_local_event").schema.safeParse({
        input: {
          title: "Appointment",
          starts_at: "2027-03-21T09:00:00",
          ends_at: "2027-03-21T10:00:00Z",
        },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(
      tool("time_entry_import_preview").schema.safeParse({
        data: {
          format: "ramin-life-os-time/1",
          timezone: "Europe/Berlin",
          entries: [
            {
              entry_id: "Synthetic",
              employer: "Jena",
              starts_at: "2027-01-01T09:00:00Z",
              ends_at: "2027-01-01T10:00:00Z",
              owner_id: "foreign",
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
  it("preserves Persian text and unset dates through create/update/status and exact accepted retry", async () => {
    const created = await write("task_create", {
      title: "بررسی آزمایش",
      due_date: "",
      start_date: null,
      estimated_minutes: null,
      notes: "نام اصلی",
    });
    const original = (await read("task_get", {
      task_id: created.entity_id,
    })) as TaskDTO;
    expect(original).toMatchObject({
      title: "بررسی آزمایش",
      due_date: null,
      start_date: null,
      estimated_minutes: null,
      status: "Inbox",
    });
    const key = randomUUID(),
      input = { task_id: original.task_id, next_action: "خواندن نتیجه" };
    const updated = await write(
      "task_update",
      input,
      original.revision,
      principal,
      key,
    );
    expect(
      await write("task_update", input, original.revision, principal, key),
    ).toMatchObject({
      entity_id: updated.entity_id,
      version: updated.version,
      replayed: true,
    });
    await expect(
      write(
        "task_update",
        { task_id: original.task_id, title: "Stale edit" },
        original.revision,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const completed = await write(
      "task_complete",
      { task_id: original.task_id },
      updated.version,
    );
    expect(await read("task_get", { task_id: original.task_id })).toMatchObject(
      {
        status: "Done",
        notes: "نام اصلی",
        next_action: "خواندن نتیجه",
        due_date: null,
      },
    );
    await write(
      "task_reopen",
      { task_id: original.task_id, status: "Next" },
      completed.version,
    );
    expect(await read("task_get", { task_id: original.task_id })).toMatchObject(
      { status: "Next", due_date: null, estimated_minutes: null },
    );
  });
  it("keeps advertised read scopes insufficient for writes/previews and project summaries require both resources", async () => {
    const existing = await task(),
      second = await task();
    const reader = { ...principal, scopes: ["tasks:read"] };
    expect(
      await read("task_get", { task_id: existing.task_id }, reader),
    ).toMatchObject({ task_id: existing.task_id });
    await expect(
      write(
        "task_complete",
        { task_id: existing.task_id },
        existing.revision,
        reader,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      read(
        "task_dependency_add_preview",
        {
          task_id: existing.task_id,
          prerequisites: [{ task_id: second.task_id }],
        },
        reader,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const project = await write("project_create", {
      title: "Synthetic project",
    });
    await expect(
      read(
        "project_summary",
        { project_id: project.entity_id },
        { ...principal, scopes: ["projects:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(
      await read(
        "project_summary",
        { project_id: project.entity_id },
        { ...principal, scopes: tool("project_summary").scopes },
      ),
    ).toBeDefined();
    expect(await read("task_get", { task_id: existing.task_id })).toMatchObject(
      { status: "Inbox", revision: existing.revision },
    );
  });
  it("adds real dependency groups via actor-pinned preview and refuses blocked completion and cycles", async () => {
    const dependent = await task("Dependent"),
      prerequisite = await task("Prerequisite");
    const preview = (await read("task_dependency_add_preview", {
      task_id: dependent.task_id,
      operator: "ALL",
      prerequisites: [
        {
          task_id: prerequisite.task_id,
          mode: "hard",
          note: "Explicit owner relation",
        },
      ],
    })) as PreviewDTO;
    await write("task_dependency_add_commit", {
      preview_id: preview.preview_id,
    });
    const blocked = (await read("task_get", {
      task_id: dependent.task_id,
    })) as TaskDTO;
    expect(blocked.blocked_by.map((entry) => entry.task_id)).toContain(
      prerequisite.task_id,
    );
    await expect(
      write("task_complete", { task_id: dependent.task_id }, blocked.revision),
    ).rejects.toMatchObject({ code: "TASK_BLOCKED" });
    await expect(
      read("task_dependency_add_preview", {
        task_id: prerequisite.task_id,
        prerequisites: [{ task_id: dependent.task_id }],
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
    await write(
      "task_complete",
      { task_id: prerequisite.task_id },
      prerequisite.revision,
    );
    const ready = (await read("task_get", {
      task_id: dependent.task_id,
    })) as TaskDTO;
    expect(ready.ready_now).toBe(true);
    await write(
      "task_complete",
      { task_id: dependent.task_id },
      ready.revision,
    );
    expect(
      await read("task_get", { task_id: dependent.task_id }),
    ).toMatchObject({ status: "Done" });
  });
  it("uses checklist and item revisions distinctly and checking does not fabricate task completion", async () => {
    const existing = await task();
    const checklist = await write("task_checklist_create", {
      task_id: existing.task_id,
      title: "Owner checklist",
    });
    const added = await write(
      "task_checklist_item_add",
      {
        checklist_id: checklist.entity_id,
        title: "Collect evidence",
        notes: "Original note",
      },
      checklist.version,
    );
    const checked = await write(
      "task_checklist_item_check",
      { item_id: added.entity_id },
      added.version,
    );
    const current = (await read("task_get", {
      task_id: existing.task_id,
    })) as TaskDTO;
    expect(current.status).toBe("Inbox");
    expect(current.checklists![0].items[0]).toMatchObject({
      checked: true,
      notes: "Original note",
    });
    const promoted = await write(
      "task_checklist_item_promote",
      { item_id: added.entity_id, original: "keep_reference" },
      checked.version,
    );
    expect(promoted.affected_task_ids).toContain(existing.task_id);
    const children = (await read("subtask_list", {
      task_id: existing.task_id,
      limit: 1,
    })) as PageDTO<TaskDTO>;
    expect(
      children.items.some(
        (entry) =>
          entry.title === "Collect evidence" &&
          entry.parent_task_id === existing.task_id,
      ),
    ).toBe(true);
  });
  it("moves one DST recurrence occurrence through the advertised preview without rewriting the master series", async () => {
    const created = await write("calendar_create_local_event", {
      title: "Berlin appointment",
      starts_at: "2027-03-21T09:00:00Z",
      ends_at: "2027-03-21T10:00:00Z",
      timezone: "Europe/Berlin",
      recurrence_rule: "FREQ=WEEKLY;COUNT=4",
      recurrence_exceptions: ["2027-04-04"],
    });
    const preview = (await read("calendar_occurrence_reschedule_preview", {
      event_id: created.entity_id,
      occurrence_starts_at: "2027-03-28T08:00:00Z",
      starts_at: "2027-03-28T09:30:00Z",
      ends_at: "2027-03-28T10:30:00Z",
    })) as PreviewDTO;
    const moved = await write("calendar_occurrence_reschedule_commit", {
      preview_id: preview.preview_id,
    });
    const result = (await read("calendar_events_query", {
      from: "2027-03-20T00:00:00Z",
      to: "2027-04-15T00:00:00Z",
      limit: 200,
    })) as PageDTO<EventDTO>;
    expect(
      result.items.some(
        (event) =>
          event.event_id === moved.entity_id &&
          event.starts_at === "2027-03-28T09:30:00.000Z",
      ),
    ).toBe(true);
    expect(
      result.items.some(
        (event) => event.starts_at === "2027-03-28T08:00:00.000Z",
      ),
    ).toBe(false);
    expect(
      result.items.some((event) => event.starts_at.startsWith("2027-04-04")),
    ).toBe(false);
    expect(
      result.items.some(
        (event) =>
          event.event_id === created.entity_id &&
          event.starts_at === "2027-04-11T08:00:00.000Z",
      ),
    ).toBe(true);
  });
  it("retains overlapping work intervals with warnings and keeps reported totals separate from conflict minutes", async () => {
    const entry = await write("time_entry_create", {
      employer: "Jena",
      starts_at: "2027-03-28T00:30:00Z",
      ends_at: "2027-03-28T02:30:00Z",
      description: "DST elapsed work",
    });
    const overlapping = await write("time_entry_create", {
      employer: "Seewiesen",
      starts_at: "2027-03-28T02:00:00Z",
      ends_at: "2027-03-28T03:00:00Z",
    });
    expect(overlapping.data).toMatchObject({
      warnings: ["WORK_INTERVAL_OVERLAP"],
    });
    await write(
      "time_entry_update",
      { entry_id: entry.entity_id, description: "Reviewed actual work" },
      entry.version,
    );
    const summary = (await read("time_summary", {
      from: "2027-03-28T00:00:00Z",
      to: "2027-03-29T00:00:00Z",
    })) as { minutes: number; overlap_minutes: number };
    expect(summary.minutes).toBe(180);
    expect(summary.overlap_minutes).toBe(30);
    const entries = (await read("time_entry_list", {
      from: "2027-03-28T00:00:00Z",
      to: "2027-03-29T00:00:00Z",
    })) as PageDTO<{ description: string }>;
    expect(entries.total).toBe(2);
    expect(
      entries.items.some((item) => item.description === "Reviewed actual work"),
    ).toBe(true);
  });
  it("offers scope-bound calendar sources without exposing their private feed URL", async () => {
    vi.stubEnv(
      "BETTER_AUTH_SECRET",
      "synthetic-calendar-contract-secret-at-least-32-characters",
    );
    try {
      const privateUrl =
        "https://calendar.example.invalid/private/synthetic-feed-token/basic.ics";
      const created = await write("calendar_source_configure", {
        provider: "ical",
        title: "Synthetic private feed",
        url: privateUrl,
      });
      const sources = await read("calendar_list", { limit: 200 });
      const status = await read("calendar_sync_status", {});
      expect(JSON.stringify({ created, sources, status })).not.toContain(
        privateUrl,
      );
      expect(JSON.stringify(status)).not.toContain("synthetic-feed-token");
      const sourceRow = (
        await db.query<{ encrypted_config: string }>(
          "SELECT encrypted_config FROM calendar_sources WHERE owner_id=$1 AND source_id=$2",
          [principal.ownerId, created.entity_id],
        )
      ).rows[0];
      expect(sourceRow.encrypted_config).not.toContain("synthetic-feed-token");
      expect(tool("calendar_event_change_preview").scopes).toEqual([
        "calendar:write",
      ]);
      expect(tool("calendar_sync_request").openWorld).toBe(true);
      expect(tool("calendar_event_change_commit").destructive).toBe(true);
      const reader = { ...principal, scopes: ["calendar:read"] };
      await expect(
        write(
          "calendar_source_disconnect",
          { source_id: created.entity_id },
          created.version,
          reader,
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
      const otherOwner = {
        ...principal,
        ownerId: principal.ownerId + "-other",
      };
      await expect(
        write(
          "calendar_source_disconnect",
          { source_id: created.entity_id },
          created.version,
          otherOwner,
        ),
      ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it("promotes a durable draft once through MCP and rejects stale promotion without changing work totals", async () => {
    const draft = await write("time_draft_save", {
      employer: "Jena",
      date: "2026-10-10",
      start: "09:",
      end: "",
      end_next_day: false,
      description: "Synthetic unfinished work",
    });
    expect(
      (await read("time_summary", {})) as { minutes: number },
    ).toMatchObject({ minutes: 0 });
    const input = {
      employer: "Jena",
      starts_at: "2026-10-10T07:00:00Z",
      ends_at: "2026-10-10T08:00:00Z",
      description: "Synthetic completed work",
      draft_id: draft.entity_id,
      draft_revision: draft.version,
    };
    const operation = randomUUID();
    const promoted = await write(
      "time_entry_create",
      input,
      undefined,
      principal,
      operation,
    );
    const replayed = await write(
      "time_entry_create",
      input,
      undefined,
      principal,
      operation,
    );
    expect(replayed.entity_id).toBe(promoted.entity_id);
    expect(replayed.replayed).toBe(true);
    expect(
      (await read("time_draft_list", {})) as PageDTO<unknown>,
    ).toMatchObject({ total: 0 });
    await expect(write("time_entry_create", input)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    expect(
      (await read("time_summary", {})) as { minutes: number },
    ).toMatchObject({ minutes: 60 });
  });
  it("links distinct file purposes, retains immutable external metadata and fails wrong-owner references", async () => {
    const existing = await task();
    const registered = await write("file_register_external_link", {
      external_url: "https://drive.google.com/file/d/synthetic-reference/view",
      title: "Synthetic reference",
      original_filename: "original.html",
      mime_type: "text/html",
      size_bytes: 0,
    });
    const first = await write("file_link_to_task", {
      file_id: registered.entity_id,
      task_id: existing.task_id,
      purpose: "Input",
    });
    await write("file_link_to_task", {
      file_id: registered.entity_id,
      task_id: existing.task_id,
      purpose: "Reference",
    });
    const foreign = { ...principal, ownerId: "foreign-" + randomUUID() };
    await expect(
      write(
        "file_link_to_task",
        { file_id: registered.entity_id, task_id: existing.task_id },
        undefined,
        foreign,
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    await write(
      "file_unlink_from_task",
      { link_id: first.entity_id },
      first.version,
    );
    const metadata = (await read("file_get_metadata", {
      file_id: registered.entity_id,
    })) as { provider: string; original_filename: string; state: string };
    expect(metadata).toMatchObject({
      provider: "google_drive",
      original_filename: "original.html",
      state: "External",
    });
    await expect(
      write(
        "file_archive",
        { file_id: registered.entity_id, explicit_user_intent: true },
        registered.version,
      ),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPERATION" });
    expect(
      ((await read("file_search", { state: "External" })) as PageDTO<unknown>)
        .total,
    ).toBe(1);
  });
  it("edits app annotations on external references with strict bounds/revision/scopes while immutable source columns and versions stay identical", async () => {
    const registered = await write("file_register_external_link", {
      external_url: "https://drive.google.com/file/d/synthetic-annotated/view",
      external_id: "synthetic-annotated",
      title: "Synthetic original",
      original_filename: "original.txt",
    });
    const original = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM files WHERE file_id=$1",
        [registered.entity_id],
      )
    ).rows[0];
    const originalVersions = (
      await db.query("SELECT * FROM file_versions WHERE file_id=$1", [
        registered.entity_id,
      ])
    ).rows;
    expect(tool("file_metadata_update").scopes).toEqual(["files:write"]);
    for (const input of [
      { file_id: registered.entity_id },
      { file_id: registered.entity_id, tags: null },
      { file_id: registered.entity_id, tags: ["Tag", "tag"] },
      { file_id: registered.entity_id, tags: ["كتاب", "کتاب"] },
      { file_id: registered.entity_id, tags: ["hidden\t"] },
      { file_id: registered.entity_id, description: "x\u0000" },
      { file_id: registered.entity_id, description: "x".repeat(10001) },
      {
        file_id: registered.entity_id,
        provider: "private_blob",
        description: "x",
      },
    ])
      expect(
        tool("file_metadata_update").schema.safeParse({
          input,
          operation_id: randomUUID(),
          expected_revision: registered.version,
        }).success,
      ).toBe(false);
    const edited = await write(
      "file_metadata_update",
      {
        file_id: registered.entity_id,
        description: "<script>literal owner note</script>",
        tags: [" Research ", "کتاب"],
      },
      registered.version,
    );
    const metadata = (await read("file_get_metadata", {
      file_id: registered.entity_id,
    })) as FileDTO;
    expect(metadata).toMatchObject({
      description: "<script>literal owner note</script>",
      tags: ["Research", "کتاب"],
      provider: "google_drive",
      original_filename: "original.txt",
      revision: edited.version,
    });
    expect(
      (
        (await read("file_search", {
          search: "literal owner note",
          tags: ["research", "كتاب"],
          limit: 1,
        })) as PageDTO<FileDTO>
      ).items[0].file_id,
    ).toBe(registered.entity_id);
    const after = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM files WHERE file_id=$1",
        [registered.entity_id],
      )
    ).rows[0];
    for (const column of Object.keys(original).filter(
      (field) => !["updated_at", "revision"].includes(field),
    ))
      expect(after[column]).toEqual(original[column]);
    expect(
      (
        await db.query("SELECT * FROM file_versions WHERE file_id=$1", [
          registered.entity_id,
        ])
      ).rows,
    ).toEqual(originalVersions);
    await expect(
      write(
        "file_metadata_update",
        { file_id: registered.entity_id, description: "stale edit" },
        registered.version,
      ),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    await expect(
      write(
        "file_metadata_update",
        { file_id: registered.entity_id, description: "denied" },
        edited.version,
        { ...principal, scopes: ["files:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      write(
        "file_metadata_update",
        { file_id: registered.entity_id, description: "foreign" },
        edited.version,
        { ...principal, ownerId: "foreign-" + randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    const cleared = await write(
      "file_metadata_update",
      { file_id: registered.entity_id, description: "", tags: [] },
      edited.version,
    );
    expect(
      await read("file_get_metadata", { file_id: registered.entity_id }),
    ).toMatchObject({ description: "", tags: [], revision: cleared.version });
  });
  it("reports honor exclusive local range and omit file statistics without files scope, distinguishing registered records from unverified cloud originals", async () => {
    await write("task_create", {
      title: "Synthetic aged deadline",
      due_date: "2020-01-02",
    });
    await write("task_create", {
      title: "Excluded end boundary",
      due_date: "2020-01-03",
    });
    await write("file_register_external_link", {
      external_url: "https://drive.google.com/file/d/synthetic-report/view",
      title: "Synthetic report reference",
      size_bytes: 7,
    });
    const restricted = (await read(
      "reports_summary",
      {
        from_date: "2020-01-01",
        to_date: "2020-01-03",
        timezone: "Asia/Tehran",
        limit: 1,
      },
      { ...principal, scopes: ["tasks:read"] },
    )) as ReportsDTO;
    expect(restricted.range).toMatchObject({
      timezone: "Asia/Tehran",
      from_date: "2020-01-01",
      to_date: "2020-01-03",
    });
    expect(restricted.overdue_ageing.total).toBe(1);
    expect(restricted.overdue_ageing.items.items[0].title).toBe(
      "Synthetic aged deadline",
    );
    expect(restricted).toMatchObject({
      files_scope_granted: false,
      registered_files: null,
      duplicate_candidates: null,
    });
    const complete = (await read("reports_summary", {})) as ReportsDTO;
    expect(complete.registered_files).toMatchObject({
      scope: "owner_registered_records",
      total: 1,
      known_size_bytes: "7",
    });
    expect(complete.duplicate_candidates).toMatchObject({
      total_groups: 0,
      excluded_unverified_count: 1,
    });
    for (const input of [
      { from_date: "2020-01-01" },
      { from_date: "2020-01-03", to_date: "2020-01-01" },
      { from_date: "2020-01-01", to_date: "2022-01-01" },
      { timezone: "invalid/zone" },
    ])
      expect(tool("reports_summary").schema.safeParse(input).success).toBe(
        false,
      );
  });
  it("local-event reminder schemas preserve current revisions, exact occurrences and terminal lifecycle without external messages", async () => {
    const event = await write("calendar_create_local_event", {
      title: "Synthetic local reminder event",
      starts_at: "2030-03-31T08:00:00Z",
      ends_at: "2030-03-31T09:00:00Z",
      timezone: "Europe/Berlin",
      category: "Work",
    });
    expect(
      await read("calendar_events_query", {
        from: "2030-03-31T00:00:00Z",
        to: "2030-04-01T00:00:00Z",
      }),
    ).toMatchObject({ items: [expect.objectContaining({ category: "Work" })] });
    const reminder = await write("calendar_reminder_create", {
      event_id: event.entity_id,
      remind_at: "2020-01-01T00:00:00Z",
    });
    const paused = await write(
      "calendar_reminder_pause",
      { reminder_id: reminder.entity_id },
      reminder.version,
    );
    const resumed = await write(
      "calendar_reminder_resume",
      { reminder_id: reminder.entity_id },
      paused.version,
    );
    expect(resumed.data).toMatchObject({
      remind_at: "2020-01-01T00:00:00.000Z",
      state: "Pending",
      past_due: true,
    });
    const cancelled = await write(
      "calendar_reminder_cancel",
      { reminder_id: reminder.entity_id },
      resumed.version,
    );
    expect(
      await read("calendar_reminder_get", { reminder_id: reminder.entity_id }),
    ).toMatchObject({ state: "Cancelled", revision: cancelled.version });
    expect(
      (
        (await read("calendar_reminder_list", {
          event_id: event.entity_id,
        })) as PageDTO<unknown>
      ).total,
    ).toBe(1);
    await expect(
      write(
        "calendar_reminder_resume",
        { reminder_id: reminder.entity_id },
        cancelled.version,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      write("calendar_reminder_create", {
        event_id: event.entity_id,
        remind_at: "2030-01-01T00:00:00Z",
        occurrence_starts_at: "2040-01-01T00:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      tool("calendar_reminder_pause").schema.safeParse({
        input: { reminder_id: reminder.entity_id },
        operation_id: randomUUID(),
      }).success,
    ).toBe(false);
    expect(tool("calendar_reminder_create").scopes).toEqual(["calendar:write"]);
    await expect(
      read(
        "calendar_reminder_get",
        { reminder_id: reminder.entity_id },
        { ...principal, ownerId: "foreign-" + randomUUID() },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND" });
    expect(
      (
        await db.query<{ count: number }>(
          "SELECT count(*)::int count FROM notifications WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("notification OAuth alternatives are OR while actual reads and mark-read writes remain bound to the granted target type", async () => {
    const existing = await task();
    await write("reminder_create", {
      task_id: existing.task_id,
      remind_at: "2020-01-01T00:00:00Z",
    });
    const event = await write("calendar_create_local_event", {
      title: "Synthetic notification event",
      starts_at: "2030-01-01T12:00:00Z",
      ends_at: "2030-01-01T13:00:00Z",
    });
    await write("calendar_reminder_create", {
      event_id: event.entity_id,
      remind_at: "2020-01-01T00:00:00Z",
    });
    await service.execute(
      "system_daily_run",
      {},
      { ...principal, channel: "system" },
      { idempotencyKey: randomUUID() },
    );
    expect(tool("notifications_list").scopeAlternatives).toEqual([
      ["tasks:read"],
      ["calendar:read"],
    ]);
    expect(tool("notification_mark_read").scopeAlternatives).toEqual([
      ["tasks:write"],
      ["calendar:write"],
    ]);
    type Notification = {
      notification_id: string;
      target_type: string;
      revision: number;
      read_at: string | null;
    };
    const tasks = (await read(
      "notifications_list",
      {},
      { ...principal, scopes: ["tasks:read"] },
    )) as PageDTO<Notification>;
    const calendar = (await read(
      "notifications_list",
      {},
      { ...principal, scopes: ["calendar:read"] },
    )) as PageDTO<Notification>;
    expect(tasks.total).toBe(1);
    expect(calendar.total).toBe(1);
    expect(tasks.items[0].target_type).toBe("task");
    expect(calendar.items[0].target_type).toBe("calendar");
    await expect(
      write(
        "notification_mark_read",
        { notification_id: tasks.items[0].notification_id },
        tasks.items[0].revision,
        { ...principal, scopes: ["calendar:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      write(
        "notification_mark_read",
        { notification_id: calendar.items[0].notification_id },
        calendar.items[0].revision,
        { ...principal, scopes: ["tasks:write"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await write(
      "notification_mark_read",
      { notification_id: calendar.items[0].notification_id },
      calendar.items[0].revision,
      { ...principal, scopes: ["calendar:write"] },
    );
    expect(
      (
        (await read(
          "notifications_list",
          {},
          { ...principal, scopes: ["calendar:read"] },
        )) as PageDTO<Notification>
      ).items[0].read_at,
    ).not.toBeNull();
  });
  it("exposes exact reminder controls with revision guards and preserves scheduled timestamps through pause/resume/cancel", async () => {
    const existing = await task(),
      due = "2020-01-01T12:00:00Z";
    const reminder = await write("reminder_create", {
      task_id: existing.task_id,
      remind_at: due,
    });
    const paused = await write(
      "reminder_pause",
      { reminder_id: reminder.entity_id },
      reminder.version,
    );
    expect(paused.data).toMatchObject({
      state: "Paused",
      remind_at: "2020-01-01T12:00:00.000Z",
    });
    const resumed = await write(
      "reminder_resume",
      { reminder_id: reminder.entity_id },
      paused.version,
    );
    expect(resumed.data).toMatchObject({
      state: "Pending",
      past_due: true,
      warnings: ["REMINDER_PAST_DUE_RESUMED"],
    });
    const cancelled = await write(
      "reminder_cancel",
      { reminder_id: reminder.entity_id },
      resumed.version,
    );
    await expect(
      write(
        "reminder_resume",
        { reminder_id: reminder.entity_id },
        cancelled.version,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(
      ((await read("reminder_list", {})) as PageDTO<{ state: string }>).items[0]
        .state,
    ).toBe("Cancelled");
  });
  it("imports only a pinned explicit work-log file, preserves source IDs and accepted retries, and refuses intervening changes", async () => {
    const data = {
      format: "ramin-life-os-time/1",
      timezone: "Europe/Berlin",
      entries: [
        {
          entry_id: "original-synthetic-work-" + randomUUID(),
          employer: "Jena",
          starts_at: "2027-01-01T09:00:00Z",
          ends_at: "2027-01-01T10:00:00Z",
          description: "Owner reviewed original work",
          task_id: null,
        },
      ],
    };
    await expect(
      read(
        "time_entry_import_preview",
        { data },
        { ...principal, scopes: ["time:read"] },
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const preview = (await read("time_entry_import_preview", {
      data,
    })) as PreviewDTO;
    const key = randomUUID(),
      input = { preview_id: preview.preview_id };
    const accepted = await write(
      "time_entry_import_commit",
      input,
      undefined,
      principal,
      key,
    );
    expect(
      await write("time_entry_import_commit", input, undefined, principal, key),
    ).toMatchObject({ entity_id: accepted.entity_id, replayed: true });
    const original = (await read("time_entry_list", {})) as PageDTO<{
      entry_id: string;
      description: string;
    }>;
    expect(original.total).toBe(1);
    expect(original.items[0]).toMatchObject({
      entry_id: data.entries[0].entry_id,
      description: data.entries[0].description,
    });
    await expect(
      read("time_entry_import_preview", {
        data: {
          ...data,
          entries: [
            { ...data.entries[0], description: "Unapproved replacement" },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const next = {
      ...data,
      entries: [
        {
          ...data.entries[0],
          entry_id: "second-original-" + randomUUID(),
          starts_at: "2027-01-02T09:00:00Z",
          ends_at: "2027-01-02T10:00:00Z",
        },
      ],
    };
    const stale = (await read("time_entry_import_preview", {
      data: next,
    })) as PreviewDTO;
    await write("time_entry_create", {
      employer: "Seewiesen",
      starts_at: "2027-01-03T09:00:00Z",
      ends_at: "2027-01-03T10:00:00Z",
    });
    await expect(
      write("time_entry_import_commit", { preview_id: stale.preview_id }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(
      ((await read("time_entry_list", {})) as PageDTO<unknown>).total,
    ).toBe(2);
  });
});
