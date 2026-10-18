import { describe, expect, it, vi } from "vitest";
import type { MutationResult, TaskDTO } from "@/shared/contracts";
import {
  TaskRowController,
  rowDraftPatch,
  type TaskRowMutation,
} from "@/features/task-row-controller";

function task(changes: Partial<TaskDTO> = {}): TaskDTO {
  return {
    task_id: "T-synthetic-row",
    owner_id: "owner-synthetic",
    title: "Synthetic task",
    project_id: null,
    parent_task_id: null,
    status: "Inbox",
    priority: "Normal",
    category: "Other",
    notes: "Original note",
    next_action: "",
    waiting_for: "",
    source_reference: "",
    start_date: null,
    due_date: null,
    due_at: "2026-10-18T10:12:34.000Z",
    timezone: "Europe/Berlin",
    estimated_minutes: null,
    sort_key: 1,
    completed_at: null,
    closed_at: null,
    archived_at: null,
    created_at: "2026-10-18T09:00:00Z",
    updated_at: "2026-10-18T09:00:00Z",
    revision: 1,
    legacy_metadata: {},
    readiness: "ready",
    ready_now: true,
    earliest_allowed_start: null,
    blocked_by: [],
    started_at_risk: false,
    warnings: [],
    prerequisites: [],
    unblocks: [],
    checklist_progress: { checked: 0, total: 0 },
    children_progress: { done: 0, total: 0, blocked: 0 },
    ...changes,
  };
}
function receipt(value: TaskDTO): MutationResult {
  return {
    operation_id: "synthetic-operation",
    audit_event_id: "synthetic-audit",
    entity_id: value.task_id,
    version: value.revision,
    affected_task_ids: [value.task_id],
    readiness_changes: [],
    changed_fields: [],
    data: value,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function controller(
  mutate: TaskRowMutation = vi.fn(),
  initial = task(),
  latest = initial,
) {
  const value = new TaskRowController(mutate, async () => latest);
  value.observe([initial]);
  return value;
}

describe("task row patch semantics", () => {
  it("keeps zero distinct from clearing an estimate, validates dates, title and derived fields", () => {
    const c = controller();
    const key = c.open(task(), "estimated_minutes");
    c.edit(key, { value: "0" });
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      estimated_minutes: 0,
    });
    c.edit(key, { value: "" });
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      estimated_minutes: null,
    });
    c.edit(key, { value: "1.5" });
    expect(() => rowDraftPatch(c.getSnapshot().drafts[key])).toThrow();
    const date = c.open(task(), "due_date");
    c.edit(date, { value: "2027-02-29" });
    expect(() => rowDraftPatch(c.getSnapshot().drafts[date])).toThrow();
    c.edit(date, { value: "" });
    expect(rowDraftPatch(c.getSnapshot().drafts[date])).toEqual({
      due_date: null,
    });
    const title = c.open(task(), "title");
    c.edit(title, { value: "  " });
    expect(() => rowDraftPatch(c.getSnapshot().drafts[title])).toThrow();
    const derived = c.open(task(), "readiness");
    expect(() => rowDraftPatch(c.getSnapshot().drafts[derived])).toThrow(
      "read-only",
    );
  });

  it("preserves exact seconds and the instant when only timezone changes; daily and exact dates clear independently", () => {
    const c = controller();
    const key = c.open(task(), "due_at");
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({});
    c.edit(key, { timezone: "Asia/Tehran" });
    expect(c.getSnapshot().drafts[key].value).toBe("2026-10-18T13:42:34");
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      timezone: "Asia/Tehran",
    });
    c.edit(key, { value: "" });
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      timezone: "Asia/Tehran",
      due_at: null,
    });
  });

  it("rejects spring gaps and requires an explicit occurrence for a repeated Berlin hour", () => {
    const c = controller();
    const key = c.open(task(), "due_at");
    c.edit(key, { value: "2027-03-28T02:30:00" });
    expect(() => rowDraftPatch(c.getSnapshot().drafts[key])).toThrow(
      "does not exist",
    );
    c.edit(key, { value: "2026-10-25T02:30:00" });
    expect(() => rowDraftPatch(c.getSnapshot().drafts[key])).toThrow("twice");
    c.edit(key, { disambiguation: "earlier" });
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      due_at: "2026-10-25T00:30:00.000Z",
    });
    c.edit(key, { disambiguation: "later" });
    expect(rowDraftPatch(c.getSnapshot().drafts[key])).toEqual({
      due_at: "2026-10-25T01:30:00.000Z",
    });
  });
});

describe("task row write coordination", () => {
  it("never restores private data or drains later writes when disposed during a deferred conflict read", async () => {
    const read = deferred<TaskDTO>();
    const mutation = deferred<MutationResult>();
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockReturnValueOnce(mutation.promise);
    const c = new TaskRowController(mutate, () => read.promise);
    c.observe([task()]);
    const priority = c.open(task(), "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    const notes = c.open(task(), "notes");
    c.edit(notes, { value: "Later private draft" });
    c.save(notes);
    mutation.reject(
      Object.assign(new Error("Conflict"), { code: "REVISION_CONFLICT" }),
    );
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[priority].state).toBe("conflict"),
    );
    c.dispose();
    read.resolve(task({ notes: "Remote private value", revision: 2 }));
    await read.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toEqual({ drafts: {}, tasks: {} });
  });
  it("does not send an untouched standalone timezone over an earlier confirmed zone edit", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi.fn<TaskRowMutation>().mockReturnValue(first.promise);
    const initial = task({ timezone: "UTC" });
    const c = controller(mutate, initial);
    const exact = c.open(initial, "due_at");
    c.edit(exact, { timezone: "Asia/Tehran" });
    c.save(exact);
    const zone = c.open(initial, "timezone");
    c.save(zone);
    first.resolve(receipt(task({ timezone: "Asia/Tehran", revision: 2 })));
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[zone].state).toBe("saved"),
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().drafts[zone].value).toBe("Asia/Tehran");
    expect(c.getSnapshot().tasks[initial.task_id].timezone).toBe("Asia/Tehran");
  });

  it("drops private drafts and never drains queued writes after the owner scope is disposed", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi.fn<TaskRowMutation>().mockReturnValue(first.promise);
    const c = controller(mutate);
    const priority = c.open(task(), "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    const notes = c.open(task(), "notes");
    c.edit(notes, { value: "Queued note" });
    c.save(notes);
    c.dispose();
    first.resolve(receipt(task({ priority: "High", revision: 2 })));
    await first.promise;
    await Promise.resolve();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).toEqual({ drafts: {}, tasks: {} });
  });

  it("settles only the exact blocked status draft after an explicit owner override receipt", async () => {
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockRejectedValue(
        Object.assign(new Error("Blocked"), { code: "TASK_BLOCKED" }),
      );
    const c = controller(mutate);
    const status = c.open(task(), "status");
    c.edit(status, { value: "Done" });
    c.save(status);
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[status].state).toBe("blocked"),
    );
    const result = receipt(task({ status: "Done", revision: 2 }));
    c.acknowledgeBlocked({
      taskId: task().task_id,
      status: "Done",
      revision: 99,
      result,
    });
    expect(c.getSnapshot().drafts[status].state).toBe("blocked");
    c.acknowledgeBlocked({
      taskId: task().task_id,
      status: "Next",
      revision: 1,
      result,
    });
    expect(c.getSnapshot().drafts[status].state).toBe("blocked");
    c.acknowledgeBlocked({
      taskId: task().task_id,
      status: "Done",
      revision: 1,
      result,
    });
    expect(c.getSnapshot().drafts[status].state).toBe("saved");
    expect(c.getSnapshot().tasks[task().task_id].status).toBe("Done");
    expect(mutate).toHaveBeenCalledTimes(1);
  });
  it("honors an explicit return to the original value while an earlier same-field ACK is pending", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(
        receipt(task({ priority: "Normal", revision: 3 })),
      );
    const c = controller(mutate);
    const priority = c.open(task(), "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    c.edit(priority, { value: "Normal" });
    c.save(priority);
    first.resolve(receipt(task({ priority: "High", revision: 2 })));
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[priority].state).toBe("saved"),
    );
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1]).toEqual([
      "task_update",
      { task_id: task().task_id, priority: "Normal" },
      2,
    ]);
    expect(c.getSnapshot().tasks[task().task_id].priority).toBe("Normal");
  });
  it("serializes fields of one task using the preceding acknowledged revision and exact field deltas", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(
        receipt(
          task({ priority: "High", due_date: "2027-04-01", revision: 3 }),
        ),
      );
    const c = controller(mutate);
    const priority = c.open(task(), "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    const date = c.open(task(), "due_date");
    c.edit(date, { value: "2027-04-01" });
    c.save(date);
    expect(mutate).toHaveBeenCalledTimes(1);
    first.resolve(receipt(task({ priority: "High", revision: 2 })));
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate.mock.calls[0]).toEqual([
      "task_update",
      { task_id: task().task_id, priority: "High" },
      1,
    ]);
    expect(mutate.mock.calls[1]).toEqual([
      "task_update",
      { task_id: task().task_id, due_date: "2027-04-01" },
      2,
    ]);
  });

  it("pins an uncertain request for same-intent recovery and blocks queued later writes", async () => {
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockRejectedValueOnce(
        Object.assign(new Error("Unknown"), { code: "WRITE_UNCONFIRMED" }),
      )
      .mockResolvedValueOnce(receipt(task({ priority: "High", revision: 2 })))
      .mockResolvedValueOnce(
        receipt(
          task({ priority: "High", due_date: "2027-04-02", revision: 3 }),
        ),
      );
    const c = controller(mutate);
    const priority = c.open(task(), "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[priority].state).toBe("unconfirmed"),
    );
    const date = c.open(task(), "due_date");
    c.edit(date, { value: "2027-04-02" });
    c.save(date);
    c.discard(priority);
    expect(c.getSnapshot().drafts[priority]).toBeDefined();
    expect(mutate).toHaveBeenCalledTimes(1);
    await c.recover(priority);
    expect(mutate.mock.calls[1]).toEqual(mutate.mock.calls[0]);
    expect(mutate.mock.calls[2]).toEqual([
      "task_update",
      { task_id: task().task_id, due_date: "2027-04-02" },
      2,
    ]);
  });

  it("keeps new text typed during an ACK and refresh instead of marking it saved or resetting it", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi.fn<TaskRowMutation>().mockReturnValue(first.promise);
    const c = controller(mutate);
    const notes = c.open(task(), "notes");
    c.edit(notes, { value: "First proposed note" });
    c.save(notes);
    c.edit(notes, { value: "Newer text still being typed" });
    c.observe([task({ notes: "First proposed note", revision: 2 })]);
    first.resolve(receipt(task({ notes: "First proposed note", revision: 2 })));
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[notes].state).toBe("draft"),
    );
    expect(c.getSnapshot().drafts[notes].value).toBe(
      "Newer text still being typed",
    );
    expect(c.getSnapshot().drafts[notes].editing).toBe(true);
    expect(c.getSnapshot().drafts[notes].base.revision).toBe(2);
  });

  it("preserves a conflicted draft and only uses a fresh revision after explicit user selection", async () => {
    const remote = task({ notes: "Changed on another device", revision: 2 });
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockRejectedValueOnce(
        Object.assign(new Error("Conflict"), { code: "REVISION_CONFLICT" }),
      )
      .mockResolvedValueOnce(receipt(task({ notes: "My note", revision: 3 })));
    const c = controller(mutate, task(), remote);
    const notes = c.open(task(), "notes");
    c.edit(notes, { value: "My note" });
    c.observe([remote]);
    c.save(notes);
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[notes].server?.revision).toBe(2),
    );
    expect(c.getSnapshot().drafts[notes].value).toBe("My note");
    expect(mutate.mock.calls[0][2]).toBe(1);
    c.applyDraft(notes);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(2));
    expect(mutate.mock.calls[1]).toEqual([
      "task_update",
      { task_id: task().task_id, notes: "My note" },
      2,
    ]);
  });

  it("edits metadata of Done tasks without reopening and uses canonical complete/reopen commands", async () => {
    const done = task({ status: "Done", readiness: "closed" });
    const mutate = vi
      .fn<TaskRowMutation>()
      .mockResolvedValueOnce(
        receipt(task({ ...done, priority: "High", revision: 2 })),
      )
      .mockResolvedValueOnce(
        receipt(task({ priority: "High", status: "Next", revision: 3 })),
      )
      .mockResolvedValueOnce(
        receipt(task({ status: "Done", priority: "High", revision: 4 })),
      );
    const c = controller(mutate, done);
    const priority = c.open(done, "priority");
    c.edit(priority, { value: "High" });
    c.save(priority);
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[priority].state).toBe("saved"),
    );
    expect(mutate.mock.calls[0]).toEqual([
      "task_update",
      { task_id: done.task_id, priority: "High" },
      1,
    ]);
    const status = c.open(c.getSnapshot().tasks[done.task_id], "status");
    c.edit(status, { value: "Next" });
    c.save(status);
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[status].state).toBe("saved"),
    );
    expect(mutate.mock.calls[1][0]).toBe("task_reopen");
    c.toggleCompletion(c.getSnapshot().tasks[done.task_id]);
    await vi.waitFor(() => expect(mutate).toHaveBeenCalledTimes(3));
    expect(mutate.mock.calls[2]).toEqual([
      "task_complete",
      { task_id: done.task_id },
      3,
    ]);
  });

  it("does not revert an acknowledged timezone when an unchanged exact deadline was queued", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi.fn<TaskRowMutation>().mockReturnValue(first.promise);
    const c = controller(mutate);
    const exact = c.open(task(), "due_at");
    const zone = c.open(task(), "timezone");
    c.edit(zone, { value: "Asia/Tehran", timezone: "Asia/Tehran" });
    c.save(zone);
    c.save(exact);
    first.resolve(receipt(task({ timezone: "Asia/Tehran", revision: 2 })));
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[exact].state).toBe("saved"),
    );
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot().tasks[task().task_id].timezone).toBe("Asia/Tehran");
  });

  it("does not erase newer unsaved input when an earlier queued no-op settles", async () => {
    const first = deferred<MutationResult>();
    const mutate = vi.fn<TaskRowMutation>().mockReturnValue(first.promise);
    const original = task({ timezone: "UTC" });
    const c = controller(mutate, original);
    const notes = c.open(original, "notes");
    c.edit(notes, { value: "New note" });
    c.save(notes);
    const zone = c.open(original, "timezone");
    c.save(zone);
    c.edit(zone, { value: "Asia/Tehran", timezone: "Asia/Tehran" });
    first.resolve(
      receipt(task({ timezone: "UTC", notes: "New note", revision: 2 })),
    );
    await vi.waitFor(() =>
      expect(c.getSnapshot().drafts[zone].state).toBe("draft"),
    );
    expect(c.getSnapshot().drafts[zone].editing).toBe(true);
    expect(c.getSnapshot().drafts[zone].value).toBe("Asia/Tehran");
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
