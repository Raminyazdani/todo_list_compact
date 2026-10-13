import { randomUUID, createHash } from "node:crypto";
import {
  DomainError,
  WORKFLOW_STATUSES,
  type Principal,
  type TaskDTO,
  type DependencyDTO,
  type ChecklistDTO,
  type Readiness,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";

export type Input = Record<string, unknown>;
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
export const json = (value: unknown) => JSON.stringify(value);
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stable(val)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown) =>
  createHash("sha256").update(stable(value)).digest("hex");
export function text(
  input: Input,
  key: string,
  fallback?: string,
  max = 10000,
): string {
  const value = input[key] ?? fallback;
  if (
    typeof value !== "string" ||
    value.length > max ||
    (fallback === undefined && !value.trim())
  )
    throw new DomainError("INVALID_INPUT", `Invalid ${key}.`);
  return value;
}
export function optionalText(input: Input, key: string): string | null {
  const val = input[key];
  if (val === null || val === undefined || val === "") return null;
  return text(input, key);
}
export function object(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new DomainError("INVALID_INPUT", "Object input required.");
  return value as Input;
}
export function array(value: unknown, max = 1000): Input[] {
  if (!Array.isArray(value) || value.length > max)
    throw new DomainError("INVALID_INPUT", "Bounded array required.");
  return value.map(object);
}
export function number(input: Input, key: string, fallback?: number): number {
  const val = input[key] ?? fallback;
  if (typeof val !== "number" || !Number.isFinite(val))
    throw new DomainError("INVALID_INPUT", `Invalid ${key}.`);
  return val;
}
export function choice<T extends string>(
  input: Input,
  key: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = input[key] ?? fallback;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new DomainError("INVALID_INPUT", `Invalid ${key}.`);
  return value as T;
}
export function date(input: Input, key: string): string | null {
  const value = optionalText(input, key);
  if (value === null) return null;
  const parsed = Date.parse(value + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 10) !== value
  )
    throw new DomainError("INVALID_INPUT", `Invalid ${key} local date.`);
  return value;
}
export function instant(input: Input, key: string): string {
  const value = text(input, key);
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
    throw new DomainError(
      "INVALID_INPUT",
      `Invalid ${key}; timezone offset required.`,
    );
  return new Date(value).toISOString();
}
export function timezone(input: Input): string {
  const zone = text(input, "timezone", "Europe/Berlin");
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format();
  } catch {
    throw new DomainError("INVALID_INPUT", "Invalid IANA timezone.");
  }
  return zone;
}
export const normalizedSearch = (str: string) =>
  str
    .normalize("NFKD")
    .replace(/[يى]/g, "ی")
    .replace(/ك/g, "ک")
    .replace(/[۰-۹]/g, (c) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(c)))
    .replace(/[٠-٩]/g, (c) => String("٠١٢٣٤٥٦٧٨٩".indexOf(c)))
    .replace(/\s+/g, " ")
    .toLocaleLowerCase()
    .trim();
export function requireScope(
  principal: Principal,
  resource: string,
  write = false,
) {
  if (!principal.ownerId || !principal.actorId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Authenticated owner required.",
      {},
      403,
    );
  if (
    !principal.scopes.includes("admin:manage") &&
    !principal.scopes.includes(`${resource}:${write ? "write" : "read"}`)
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      `Required ${resource}:${write ? "write" : "read"} scope.`,
      {},
      403,
    );
}
export function closed(status: string) {
  return status === "Done" || status === "Cancelled";
}
export function cleanRows<T>(rows: T[]): T[] {
  return JSON.parse(JSON.stringify(rows)) as T[];
}
export async function entity<T extends Input>(
  tx: SqlClient,
  table: string,
  column: string,
  entityId: string,
  ownerId: string,
): Promise<T> {
  const rows = await tx.query<T>(
    `SELECT * FROM ${table} WHERE ${column}=$1 AND owner_id=$2`,
    [entityId, ownerId],
  );
  if (!rows.rows[0])
    throw new DomainError(
      table === "tasks" ? "TASK_NOT_FOUND" : "ENTITY_NOT_FOUND",
      "Entity unavailable.",
      { entity_id: entityId },
      404,
    );
  return cleanRows(rows.rows)[0];
}
export function guard(row: Input, revision: number | undefined) {
  if (revision === undefined || !Number.isInteger(revision))
    throw new DomainError(
      "INVALID_INPUT",
      "expectedRevision is required for existing entity mutation.",
    );
  if (Number(row.revision) !== revision)
    throw new DomainError(
      "REVISION_CONFLICT",
      "The record changed. Read the current record and retry.",
      {
        expected_revision: revision,
        actual_revision: Number(row.revision),
        current: row,
      },
      409,
    );
}
export async function bumpTask(tx: SqlClient, taskId: string, ownerId: string) {
  await tx.query(
    "UPDATE tasks SET revision=revision+1,updated_at=now() WHERE task_id=$1 AND owner_id=$2",
    [taskId, ownerId],
  );
}
export interface Snapshot {
  tasks: TaskDTO[];
  byId: Map<string, TaskDTO>;
  dependencies: DependencyDTO[];
  checklists: ChecklistDTO[];
  downstream: Map<string, string[]>;
}
export async function snapshot(
  tx: SqlClient,
  ownerId: string,
): Promise<Snapshot> {
  const tasks = cleanRows(
    (
      await tx.query<TaskDTO>(
        "SELECT * FROM tasks WHERE owner_id=$1 ORDER BY sort_key,task_id LIMIT 50001",
        [ownerId],
      )
    ).rows,
  );
  if (tasks.length > 50000)
    throw new DomainError(
      "INVALID_INPUT",
      "Owner graph exceeds current bounded traversal limit.",
    );
  const dependencies = cleanRows(
    (
      await tx.query<DependencyDTO>(
        `SELECT e.edge_id,e.group_id,g.dependent_task_id,e.prerequisite_task_id,g.operator,e.mode,t.title,t.status,e.waived_at,e.waiver_reason,e.note,t.archived_at AS prerequisite_archived_at FROM task_dependency_edges e JOIN task_dependency_groups g ON g.group_id=e.group_id AND g.owner_id=e.owner_id JOIN tasks t ON t.task_id=e.prerequisite_task_id AND t.owner_id=e.owner_id WHERE e.owner_id=$1 AND e.archived_at IS NULL AND g.archived_at IS NULL AND g.enabled=true ORDER BY g.sort_key,e.created_at LIMIT 200001`,
        [ownerId],
      )
    ).rows,
  );
  if (dependencies.length > 200000)
    throw new DomainError(
      "INVALID_INPUT",
      "Owner edge graph exceeds current bounded traversal limit.",
    );
  const checklists = cleanRows(
    (
      await tx.query<ChecklistDTO>(
        "SELECT * FROM task_checklists WHERE owner_id=$1 ORDER BY sort_key,checklist_id",
        [ownerId],
      )
    ).rows,
  );
  const items = cleanRows(
    (
      await tx.query<ChecklistDTO["items"][number]>(
        "SELECT * FROM task_checklist_items WHERE owner_id=$1 ORDER BY sort_key,item_id",
        [ownerId],
      )
    ).rows,
  );
  const listMap = new Map(checklists.map((c) => [c.checklist_id, c]));
  for (const c of checklists) c.items = [];
  for (const i of items) listMap.get(i.checklist_id)?.items.push(i);
  const byId = new Map(tasks.map((t) => [t.task_id, t])),
    downstream = new Map<string, string[]>(),
    deps = new Map<string, DependencyDTO[]>(),
    checks = new Map<string, ChecklistDTO[]>(),
    children = new Map<string, TaskDTO[]>();
  for (const edge of dependencies) {
    const list = deps.get(edge.dependent_task_id) ?? [];
    list.push(edge);
    deps.set(edge.dependent_task_id, list);
    const out = downstream.get(edge.prerequisite_task_id) ?? [];
    out.push(edge.dependent_task_id);
    downstream.set(edge.prerequisite_task_id, out);
  }
  for (const c of checklists)
    if (!c.archived_at) {
      const list = checks.get(c.task_id) ?? [];
      list.push(c);
      checks.set(c.task_id, list);
    }
  for (const t of tasks)
    if (t.parent_task_id && !t.archived_at) {
      const list = children.get(t.parent_task_id) ?? [];
      list.push(t);
      children.set(t.parent_task_id, list);
    }
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  for (const t of tasks) {
    for (const field of ["due_date", "start_date"] as const)
      if (t[field]) t[field] = String(t[field]).slice(0, 10);
    t.prerequisites = deps.get(t.task_id) ?? [];
    t.unblocks = [...new Set(downstream.get(t.task_id) ?? [])];
    t.blocked_by = [];
    t.warnings = [];
    const groups = new Map<string, DependencyDTO[]>();
    for (const e of t.prerequisites) {
      const list = groups.get(e.group_id) ?? [];
      list.push(e);
      groups.set(e.group_id, list);
    }
    for (const edges of groups.values()) {
      const hard = edges.filter((e) => e.mode === "hard");
      const qualifies = (e: DependencyDTO) =>
        Boolean(e.waived_at) ||
        (e.status === "Done" && !byId.get(e.prerequisite_task_id)?.archived_at);
      const satisfied =
        hard.length === 0 ||
        (edges[0].operator === "ALL"
          ? hard.every(qualifies)
          : hard.some(qualifies));
      if (!satisfied)
        for (const e of hard.filter((e) => !qualifies(e)))
          t.blocked_by.push({
            task_id: e.prerequisite_task_id,
            title: e.title,
            actual_status: e.status,
            group_id: e.group_id,
            group_operator: e.operator,
            reason: byId.get(e.prerequisite_task_id)?.archived_at
              ? "PREREQUISITE_ARCHIVED"
              : "PREREQUISITE_UNSATISFIED",
          });
      for (const e of edges.filter((e) => e.mode === "soft" && !qualifies(e)))
        t.warnings.push(`SOFT_PREREQUISITE:${e.prerequisite_task_id}`);
    }
    t.readiness =
      closed(t.status) || t.archived_at
        ? "closed"
        : t.blocked_by.length
          ? "blocked"
          : t.start_date && t.start_date > today
            ? "scheduled"
            : "ready";
    t.ready_now = t.readiness === "ready";
    t.earliest_allowed_start = t.start_date;
    t.started_at_risk = t.status === "In progress" && t.blocked_by.length > 0;
    const activeItems = (checks.get(t.task_id) ?? []).flatMap((c) =>
      c.items.filter((i) => !i.archived_at),
    );
    t.checklist_progress = {
      checked: activeItems.filter((i) => i.checked).length,
      total: activeItems.length,
    };
    t.children_progress = { total: 0, done: 0, blocked: 0 };
    for (const e of t.prerequisites) {
      const p = byId.get(e.prerequisite_task_id);
      if (p?.due_date && t.due_date && p.due_date > t.due_date)
        t.warnings.push(`IMPOSSIBLE_DEADLINE:${p.task_id}`);
    }
  }
  for (const t of tasks) {
    const kids = children.get(t.task_id) ?? [];
    t.children_progress = {
      total: kids.length,
      done: kids.filter((k) => k.status === "Done").length,
      blocked: kids.filter((k) => k.readiness === "blocked").length,
    };
  }
  return { tasks, byId, dependencies, checklists, downstream };
}
export function downstreamIds(data: Snapshot, taskId: string): string[] {
  const visited = new Set<string>(),
    queue = [taskId];
  while (queue.length) {
    const curr = queue.shift()!;
    for (const dest of data.downstream.get(curr) ?? [])
      if (!visited.has(dest)) {
        visited.add(dest);
        queue.push(dest);
      }
  }
  return [...visited];
}
export function taskFromSnapshot(data: Snapshot, taskId: string) {
  const task = data.byId.get(taskId);
  if (!task)
    throw new DomainError("TASK_NOT_FOUND", "Task unavailable.", {}, 404);
  return task;
}
export function changedReadiness(
  before: Snapshot,
  after: Snapshot,
): { task_id: string; before: Readiness; after: Readiness }[] {
  return after.tasks.flatMap((t) => {
    const old = before.byId.get(t.task_id);
    return old && old.readiness !== t.readiness
      ? [{ task_id: t.task_id, before: old.readiness, after: t.readiness }]
      : [];
  });
}
export async function audit(
  tx: SqlClient,
  principal: Principal,
  operationId: string,
  type: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason: string | null = null,
): Promise<string> {
  const eventId = id("E");
  await tx.query(
    "INSERT INTO activity_events(event_id,owner_id,entity_id,event_type,actor_id,channel,operation_id,before,after,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)",
    [
      eventId,
      principal.ownerId,
      entityId,
      type,
      principal.actorId,
      principal.channel,
      operationId,
      json(before),
      json(after),
      reason,
    ],
  );
  return eventId;
}
export const statuses = WORKFLOW_STATUSES;
