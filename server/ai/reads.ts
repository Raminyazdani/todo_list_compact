import type { DomainService, Principal } from "@/shared/contracts";
import { DomainError } from "@/shared/contracts";
import type { ModelPlan } from "./policy";

// Explicit semantic projection: source URLs, provider secrets, legacy metadata and
// arbitrary stored object keys never enter a model's read result.
const fields = new Set([
  "task_id",
  "template_id",
  "project_id",
  "file_id",
  "item_id",
  "checklist_id",
  "edge_id",
  "group_id",
  "prerequisite_task_id",
  "dependent_task_id",
  "parent_task_id",
  "promoted_task_id",
  "title",
  "notes",
  "next_action",
  "waiting_for",
  "status",
  "priority",
  "category",
  "revision",
  "readiness",
  "ready_now",
  "started_at_risk",
  "due_date",
  "due_at",
  "start_date",
  "earliest_allowed_start",
  "checked",
  "operator",
  "group_operator",
  "mode",
  "qualification_policy",
  "actual_status",
  "prerequisite_archived_at",
  "waiver_reason",
  "waived_at",
  "archived_at",
  "reason",
  "estimated_minutes",
  "read_only",
  "task_count",
  "nodes",
  "edges",
  "boundary_edges",
  "hidden_neighbor_count",
  "truncated",
  "boundary_edges_truncated",
  "total",
  "next_cursor",
  "items",
  "subtasks",
  "checklists",
  "prerequisites",
  "blocked_by",
  "unblocks",
  "affected_task_ids",
  "warnings",
  "checklist_progress",
  "children_progress",
  "done",
  "blocked",
]);
export function groundedIdentity(value: unknown) {
  const ids = new Set<string>(),
    revisions = new Map<string, number>();
  function visit(input: unknown): void {
    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }
    if (!input || typeof input !== "object") return;
    const row = input as Record<string, unknown>;
    for (const [key, item] of Object.entries(row)) {
      if (key.endsWith("_id") && typeof item === "string") ids.add(item);
      if (key.endsWith("_ids") && Array.isArray(item))
        for (const id of item) if (typeof id === "string") ids.add(id);
      visit(item);
    }
    const id =
      row.item_id ??
      row.checklist_id ??
      row.template_id ??
      row.file_id ??
      row.project_id ??
      row.task_id ??
      row.edge_id;
    if (
      typeof id === "string" &&
      Number.isSafeInteger(row.revision) &&
      Number(row.revision) > 0
    )
      revisions.set(id, Number(row.revision));
  }
  visit(value);
  return { ids, revisions };
}
export function safeReadResult(value: unknown) {
  let remaining = 500,
    truncated = false;
  function visit(input: unknown, key = "", depth = 0): unknown {
    if (--remaining < 0 || depth > 8) {
      truncated = true;
      return undefined;
    }
    if (typeof input === "string") {
      const max =
        key.endsWith("_id") || key.endsWith("_ids") || key === "unblocks"
          ? 512
          : key === "notes" || key === "next_action" || key === "waiting_for"
            ? 400
            : 200;
      if (Array.from(input).length > max) {
        truncated = true;
        if (key.endsWith("_id") || key.endsWith("_ids") || key === "unblocks")
          return undefined;
      }
      return Array.from(input).slice(0, max).join("");
    }
    if (
      input === null ||
      typeof input === "boolean" ||
      typeof input === "number"
    )
      return input;
    if (Array.isArray(input)) {
      if (input.length > 40) truncated = true;
      return input
        .slice(0, 40)
        .map((item) => visit(item, key, depth + 1))
        .filter((item) => item !== undefined);
    }
    if (!input || typeof input !== "object") return undefined;
    const entries = Object.entries(input)
      .filter(([name]) => fields.has(name))
      .map(([name, item]) => [name, visit(item, name, depth + 1)] as const)
      .filter(([, item]) => item !== undefined);
    // Template definitions are never sent as raw source. Instances use canonical
    // remapping, so the planner only needs the real template identity and size.
    const definition = (input as Record<string, unknown>).definition;
    if (
      definition &&
      typeof definition === "object" &&
      "tasks" in definition &&
      Array.isArray(definition.tasks)
    )
      entries.push(["task_count", definition.tasks.length]);
    return Object.fromEntries(entries);
  }
  return { result: visit(value), truncated };
}
export async function runGroundedReads(
  domain: DomainService,
  reads: ModelPlan["reads"],
  principal: Principal,
) {
  const results = [];
  for (const read of reads) {
    const safe = safeReadResult(
      await domain.query(read.query, read.input, {
        ...principal,
        channel: "AI",
      }),
    );
    results.push({
      query: read.query,
      result: safe.result,
      truncated: safe.truncated,
    });
  }
  return results;
}
export function mergeReadContext(
  base: Record<string, unknown[]>,
  evidence: unknown[],
  maxBytes: number,
) {
  const context: Record<string, unknown[]> = {
    ...Object.fromEntries(
      Object.entries(base).map(([key, rows]) => [key, [...rows]]),
    ),
    read_results: [...(base.read_results ?? []), ...evidence],
  };
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(context), "utf8") > maxBytes) {
    const largest = Object.keys(context)
      .filter((key) => context[key].length)
      .sort(
        (a, b) =>
          Buffer.byteLength(JSON.stringify(context[b])) -
          Buffer.byteLength(JSON.stringify(context[a])),
      )[0];
    if (!largest)
      throw new DomainError(
        "INVALID_INPUT",
        "زمینه در محدودهٔ مجاز جا نمی‌گیرد.",
      );
    // Retain the most recent exact read when possible; remove old evidence first.
    if (largest === "read_results") context[largest].shift();
    else context[largest].pop();
    truncated = true;
  }
  return {
    context,
    bytes: Buffer.byteLength(JSON.stringify(context), "utf8"),
    truncated,
  };
}
