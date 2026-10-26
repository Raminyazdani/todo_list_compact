import type { CommandName, MutationResult, TaskDTO } from "@/shared/contracts";
import { getTaskRowField, type TaskRowFieldId } from "@/shared/task-row-fields";
import { instantToLocalDateTime, zonedLocalToInstant } from "@/shared/datetime";

export type TaskRowMutation = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult>;
export type RowSaveState =
  | "draft"
  | "queued"
  | "pending"
  | "saved"
  | "error"
  | "conflict"
  | "unconfirmed"
  | "blocked";
export interface RowDraft {
  key: string;
  taskId: string;
  title: string;
  field: TaskRowFieldId;
  value: string;
  timezone: string;
  disambiguation: "reject" | "earlier" | "later";
  localEdited: boolean;
  timezoneEdited: boolean;
  base: TaskDTO;
  server?: TaskDTO;
  version: number;
  state: RowSaveState;
  error?: string;
  errorCode?: string;
  editing: boolean;
}
interface WriteJob {
  key: string;
  taskId: string;
  version: number;
  draft: RowDraft;
  patch?: Record<string, unknown>;
  frozen?: {
    command: CommandName;
    input: Record<string, unknown>;
    revision: number;
  };
}
export interface RowControllerSnapshot {
  drafts: Readonly<Record<string, RowDraft>>;
  tasks: Readonly<Record<string, TaskDTO>>;
}
export const rowDraftKey = (taskId: string, field: TaskRowFieldId) =>
  `${taskId}:${field}`;

export function fieldDraftValue(task: TaskDTO, field: TaskRowFieldId): string {
  if (field === "due_at")
    return task.due_at
      ? instantToLocalDateTime(task.due_at, task.timezone)
      : "";
  const value = task[field as keyof TaskDTO];
  return value == null ? "" : String(value);
}

/** A field edit is deliberately a small patch, never a stale whole-task form. */
export function rowDraftPatch(draft: RowDraft): Record<string, unknown> {
  const { field, value, base } = draft;
  const definition = getTaskRowField(field);
  if (!definition.editable) throw new Error("This field is read-only.");
  if (
    definition.validation?.options &&
    !definition.validation.options.includes(value)
  )
    throw new Error("گزینهٔ معتبر انتخاب کن / Choose a valid option.");
  if (field === "due_at" || field === "timezone") {
    const zone = draft.timezone.trim();
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
    const patch: Record<string, unknown> = {};
    if (draft.timezoneEdited) patch.timezone = zone;
    if (field === "due_at") {
      const exact = !value
        ? null
        : !draft.localEdited
          ? base.due_at
          : zonedLocalToInstant(value, zone, draft.disambiguation);
      if (
        draft.localEdited ||
        (exact !== base.due_at &&
          !(
            exact &&
            base.due_at &&
            Date.parse(exact) === Date.parse(base.due_at)
          ))
      )
        patch.due_at = exact;
    }
    return patch;
  }
  if (field === "estimated_minutes") {
    const estimate = value === "" ? null : Number(value);
    if (estimate !== null && (!Number.isInteger(estimate) || estimate < 0))
      throw new Error(
        "برآورد باید دقیقهٔ صحیح نامنفی باشد / Use whole non-negative minutes.",
      );
    return { estimated_minutes: estimate };
  }
  if (field === "start_date" || field === "due_date") {
    if (
      value &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) ||
        new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)
    )
      throw new Error("تاریخ معتبر وارد کن / Enter a valid calendar date.");
    return { [field]: value || null };
  }
  if (field === "project_id") return { project_id: value || null };
  if (field === "title" && (!value.trim() || value.length > 2000))
    throw new Error(
      "عنوان لازم است و حداکثر ۲۰۰۰ نویسه دارد / Title is required (maximum 2000 characters).",
    );
  if (value.length > 10000)
    throw new Error("متن حداکثر ۱۰۰۰۰ نویسه دارد / Maximum 10000 characters.");
  return { [field]: value };
}

function statusCommand(task: TaskDTO, patch: Record<string, unknown>) {
  if (patch.status === "Done") return "task_complete" as const;
  if (
    (task.status === "Done" || task.status === "Cancelled") &&
    ["Inbox", "Next", "In progress", "Waiting"].includes(String(patch.status))
  )
    return "task_reopen" as const;
  return "task_update" as const;
}
function errorInfo(error: unknown) {
  const e = error as {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
  };
  return {
    code: e?.code ?? "REQUEST_FAILED",
    message: e?.message ?? String(error),
    details: e?.details ?? {},
  };
}

/** Lives above every row. Filtering, paging and background reads cannot reset a draft. */
export class TaskRowController {
  private snapshot: RowControllerSnapshot = { drafts: {}, tasks: {} };
  private listeners = new Set<() => void>();
  private queues = new Map<string, WriteJob[]>();
  private running = new Set<string>();
  private disposed = false;
  private generation = 0;
  constructor(
    private mutate: TaskRowMutation,
    private readTask: (taskId: string) => Promise<TaskDTO>,
  ) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getSnapshot = () => this.snapshot;
  setMutation(mutate: TaskRowMutation) {
    this.mutate = mutate;
  }
  activate() {
    this.disposed = false;
  }
  dispose() {
    this.disposed = true;
    this.generation++;
    this.queues.clear();
    this.running.clear();
    this.snapshot = { drafts: {}, tasks: {} };
  }
  private publish(next: Partial<RowControllerSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next };
    this.listeners.forEach((listener) => listener());
  }
  private updateDraft(key: string, changes: Partial<RowDraft>) {
    const current = this.snapshot.drafts[key];
    if (current)
      this.publish({
        drafts: { ...this.snapshot.drafts, [key]: { ...current, ...changes } },
      });
  }
  observe(tasks: TaskDTO[]) {
    if (this.disposed) return;
    let next: Record<string, TaskDTO> | undefined;
    for (const task of tasks) {
      const previous = (next ?? this.snapshot.tasks)[task.task_id];
      if (
        !previous ||
        previous.revision < task.revision ||
        (previous.revision === task.revision &&
          previous !== task &&
          !!task.readiness)
      ) {
        next ??= { ...this.snapshot.tasks };
        next[task.task_id] = task;
      }
    }
    if (next) this.publish({ tasks: next });
  }
  open(task: TaskDTO, field: TaskRowFieldId) {
    this.observe([task]);
    const key = rowDraftKey(task.task_id, field);
    const previous = this.snapshot.drafts[key];
    if (previous && previous.state !== "saved") {
      this.updateDraft(key, { editing: true });
      return key;
    }
    const base = this.snapshot.tasks[task.task_id] ?? task;
    this.publish({
      drafts: {
        ...this.snapshot.drafts,
        [key]: {
          key,
          taskId: task.task_id,
          title: task.title,
          field,
          value: fieldDraftValue(base, field),
          timezone: base.timezone,
          disambiguation: "reject",
          localEdited: false,
          timezoneEdited: false,
          base,
          version: 0,
          state: "draft",
          editing: true,
        },
      },
    });
    return key;
  }
  edit(
    key: string,
    changes: Partial<Pick<RowDraft, "value" | "timezone" | "disambiguation">>,
  ) {
    const draft = this.snapshot.drafts[key];
    if (!draft) return;
    const next: Partial<RowDraft> = { ...changes, version: draft.version + 1 };
    if ("value" in changes && draft.field === "due_at") next.localEdited = true;
    if ("timezone" in changes) next.timezoneEdited = true;
    if (draft.field === "timezone" && "value" in changes) {
      next.timezone = changes.value;
      next.timezoneEdited = true;
    }
    if (
      changes.timezone &&
      draft.field === "due_at" &&
      !draft.localEdited &&
      draft.base.due_at
    ) {
      try {
        next.value = instantToLocalDateTime(
          draft.base.due_at,
          changes.timezone,
        );
      } catch {
        /* Keep typed zone and draft; validation appears on save. */
      }
    }
    if (
      !["pending", "queued", "unconfirmed", "conflict"].includes(draft.state)
    ) {
      next.state = "draft";
      next.error = undefined;
      next.errorCode = undefined;
    }
    this.updateDraft(key, next);
  }
  hide(key: string) {
    this.updateDraft(key, { editing: false });
  }
  toggleCompletion(task: TaskDTO) {
    const key = this.open(task, "status");
    if (!task.archived_at) {
      this.edit(key, { value: task.status === "Done" ? "Next" : "Done" });
      this.save(key);
      return;
    }
    const draft = this.snapshot.drafts[key];
    const queue = this.queues.get(task.task_id) ?? [];
    if (queue.some((job) => job.key === key)) return;
    queue.push({
      key,
      taskId: task.task_id,
      version: draft.version,
      draft,
      frozen: {
        command: "task_restore",
        input: { task_id: task.task_id },
        revision: draft.base.revision,
      },
    });
    this.queues.set(task.task_id, queue);
    this.updateDraft(key, { state: "queued", editing: false });
    void this.pump(task.task_id);
  }
  discard(key: string) {
    const draft = this.snapshot.drafts[key];
    if (!draft || ["pending", "queued", "unconfirmed"].includes(draft.state))
      return;
    const drafts = { ...this.snapshot.drafts };
    delete drafts[key];
    this.publish({ drafts });
  }
  save(key: string) {
    if (this.disposed) return;
    const draft = this.snapshot.drafts[key];
    if (!draft || draft.state === "unconfirmed" || draft.state === "conflict")
      return;
    let patch: Record<string, unknown>;
    try {
      patch = rowDraftPatch(draft);
    } catch (error) {
      this.updateDraft(key, {
        state: "error",
        error: errorInfo(error).message,
      });
      return;
    }
    const queue = this.queues.get(draft.taskId) ?? [];
    if (queue.some((job) => job.key === key && job.version === draft.version))
      return;
    // A newer explicitly saved draft supersedes an unsent version of this field.
    for (let index = queue.length - 1; index > 0; index--)
      if (queue[index].key === key) queue.splice(index, 1);
    queue.push({
      key,
      taskId: draft.taskId,
      version: draft.version,
      draft: { ...draft },
      patch,
    });
    this.queues.set(draft.taskId, queue);
    this.updateDraft(key, {
      state: "queued",
      error: undefined,
      errorCode: undefined,
    });
    void this.pump(draft.taskId);
  }
  async recover(key: string) {
    const draft = this.snapshot.drafts[key];
    if (!draft || draft.state !== "unconfirmed") return;
    await this.pump(draft.taskId, true);
  }
  async refreshConflict(key: string) {
    if (this.disposed) return;
    const generation = this.generation;
    const draft = this.snapshot.drafts[key];
    if (!draft) return;
    try {
      const server = await this.readTask(draft.taskId);
      if (this.disposed || generation !== this.generation) return;
      this.observe([server]);
      this.updateDraft(key, { server });
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.updateDraft(key, { error: errorInfo(error).message });
    }
  }
  useServer(key: string) {
    const draft = this.snapshot.drafts[key];
    if (!draft?.server) return;
    this.updateDraft(key, {
      base: draft.server,
      value: fieldDraftValue(draft.server, draft.field),
      timezone: draft.server.timezone,
      localEdited: false,
      timezoneEdited: false,
      state: "saved",
      error: undefined,
      errorCode: undefined,
      editing: false,
    });
  }
  applyDraft(key: string) {
    const draft = this.snapshot.drafts[key];
    if (!draft?.server || draft.state !== "conflict") return;
    // Explicit user choice supplies the freshly read revision; no silent rebase.
    this.updateDraft(key, {
      base: draft.server,
      state: "draft",
      error: undefined,
      errorCode: undefined,
      version: draft.version + 1,
    });
    this.save(key);
  }
  acknowledgeBlocked(input: {
    taskId: string;
    status: string;
    revision: number;
    result: MutationResult;
  }) {
    if (
      this.disposed ||
      input.result.entity_id !== input.taskId ||
      input.result.version <= input.revision
    )
      return;
    const key = rowDraftKey(input.taskId, "status");
    const draft = this.snapshot.drafts[key];
    if (
      !draft ||
      draft.state !== "blocked" ||
      draft.base.revision !== input.revision ||
      draft.value !== input.status
    )
      return;
    const raw = input.result.data as Partial<TaskDTO> | null;
    if (!raw || raw.task_id !== input.taskId || raw.status !== input.status)
      return;
    const acknowledged = {
      ...draft.base,
      ...raw,
      revision: input.result.version,
    } as TaskDTO;
    this.observe([acknowledged]);
    this.updateDraft(key, {
      base: acknowledged,
      state: "saved",
      editing: false,
      error: undefined,
      errorCode: undefined,
    });
  }
  private async pump(taskId: string, recover = false) {
    if (this.disposed) return;
    const generation = this.generation;
    if (this.running.has(taskId)) return;
    const queue = this.queues.get(taskId);
    if (!queue?.length) return;
    const first = this.snapshot.drafts[queue[0].key];
    if (first?.state === "unconfirmed" && !recover) return;
    this.running.add(taskId);
    try {
      while (queue.length) {
        if (this.disposed || generation !== this.generation) break;
        const job = queue[0];
        const latest = this.snapshot.tasks[taskId] ?? job.draft.base;
        if (!job.frozen) {
          // Our own preceding ACK may advance the revision. An independently
          // observed revision never implicitly authorizes overwriting that edit.
          const patch = Object.fromEntries(
            Object.entries(job.patch ?? rowDraftPatch(job.draft)).filter(
              ([field, value]) =>
                job.draft.base[field as keyof TaskDTO] !== value,
            ),
          );
          if (!Object.keys(patch).length) {
            const current = this.snapshot.drafts[job.key];
            this.updateDraft(job.key, {
              state: current?.version === job.version ? "saved" : "draft",
              editing:
                current?.version === job.version ? false : current?.editing,
              error: undefined,
            });
            queue.shift();
            continue;
          }
          const command = statusCommand(latest, patch);
          job.frozen = {
            command,
            input:
              command === "task_complete"
                ? { task_id: taskId }
                : { task_id: taskId, ...patch },
            revision: job.draft.base.revision,
          };
        }
        this.updateDraft(job.key, { state: "pending", error: undefined });
        try {
          const result = await this.mutate(
            job.frozen.command,
            job.frozen.input,
            job.frozen.revision,
          );
          if (this.disposed || generation !== this.generation) break;
          const raw = result.data as Partial<TaskDTO> | null;
          const previous = this.snapshot.tasks[taskId] ?? job.draft.base;
          const acknowledged = {
            ...previous,
            ...raw,
            task_id: taskId,
            revision: result.version,
          } as TaskDTO;
          this.observe([acknowledged]);
          const rebasedDrafts = { ...this.snapshot.drafts };
          for (const [key, other] of Object.entries(rebasedDrafts)) {
            if (
              key !== job.key &&
              other.taskId === taskId &&
              other.base.revision === job.frozen.revision
            )
              rebasedDrafts[key] = {
                ...other,
                base: acknowledged,
                ...(other.field === "timezone" && !other.timezoneEdited
                  ? {
                      timezone: acknowledged.timezone,
                      value: acknowledged.timezone,
                    }
                  : {}),
                ...(other.field === "due_at" &&
                !other.localEdited &&
                !other.timezoneEdited
                  ? {
                      timezone: acknowledged.timezone,
                      value: fieldDraftValue(acknowledged, "due_at"),
                    }
                  : {}),
              };
          }
          this.publish({ drafts: rebasedDrafts });
          const current = this.snapshot.drafts[job.key];
          this.updateDraft(job.key, {
            state: current?.version === job.version ? "saved" : "draft",
            editing:
              current?.version === job.version ? false : current?.editing,
            base: acknowledged,
            server: undefined,
            error: undefined,
            errorCode: undefined,
          });
          queue.shift();
          // Only our own confirmed write advances already queued operations.
          for (const waiting of queue) {
            if (
              !waiting.frozen &&
              waiting.draft.base.revision === job.frozen.revision
            )
              waiting.draft = { ...waiting.draft, base: acknowledged };
          }
        } catch (error) {
          if (this.disposed || generation !== this.generation) break;
          const info = errorInfo(error);
          const state: RowSaveState =
            info.code === "WRITE_UNCONFIRMED"
              ? "unconfirmed"
              : info.code === "REVISION_CONFLICT"
                ? "conflict"
                : info.code === "TASK_BLOCKED"
                  ? "blocked"
                  : "error";
          const incompleteSubtasks =
            info.code === "TASK_BLOCKED" &&
            info.details.reason === "SUBTASKS_INCOMPLETE";
          const count = info.details.incomplete_descendant_count;
          const countText =
            typeof count === "number" && Number.isInteger(count)
              ? ` (${count})`
              : "";
          this.updateDraft(job.key, {
            state,
            error: incompleteSubtasks
              ? `همهٔ زیرکارها باید پیش از تکمیل کار مادر انجام شوند${countText}. / Complete every descendant subtask before marking the parent Done${countText}.`
              : info.message,
            errorCode: incompleteSubtasks ? "SUBTASKS_INCOMPLETE" : info.code,
          });
          if (state === "unconfirmed") break;
          queue.shift();
          if (state === "conflict") {
            await this.refreshConflict(job.key);
            // Every queued edit still carries its own baseline; never rebase it
            // over an unrelated writer merely because a previous write failed.
          }
        }
      }
    } finally {
      if (generation === this.generation) this.running.delete(taskId);
    }
  }
}
