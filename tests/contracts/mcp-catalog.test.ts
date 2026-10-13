import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
  it("accepts explicit work intervals while canonical overlap and range checks prevent invalid mutations", async () => {
    const entry = await write("time_entry_create", {
      employer: "Jena",
      starts_at: "2027-03-28T00:30:00Z",
      ends_at: "2027-03-28T02:30:00Z",
      description: "DST elapsed work",
    });
    await expect(
      write("time_entry_create", {
        employer: "Seewiesen",
        starts_at: "2027-03-28T02:00:00Z",
        ends_at: "2027-03-28T03:00:00Z",
      }),
    ).rejects.toMatchObject({ code: "TIME_OVERLAP" });
    await write(
      "time_entry_update",
      { entry_id: entry.entity_id, description: "Reviewed actual work" },
      entry.version,
    );
    const summary = (await read("time_summary", {
      from: "2027-03-28T00:00:00Z",
      to: "2027-03-29T00:00:00Z",
    })) as { minutes: number };
    expect(summary.minutes).toBe(120);
    const entries = (await read("time_entry_list", {
      from: "2027-03-28T00:00:00Z",
      to: "2027-03-29T00:00:00Z",
    })) as PageDTO<{ description: string }>;
    expect(entries.total).toBe(1);
    expect(entries.items[0].description).toBe("Reviewed actual work");
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
