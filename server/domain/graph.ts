import {
  DomainError,
  type CommandName,
  type Principal,
  type PreviewDTO,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  array,
  choice,
  entity,
  guard,
  id,
  json,
  now,
  object,
  snapshot,
  taskFromSnapshot,
  text,
  type Input,
  type Snapshot,
} from "./core";

export async function validateHierarchy(
  tx: SqlClient,
  ownerId: string,
  taskId: string,
  parentId: string | null,
) {
  if (!parentId) return;
  await entity(tx, "tasks", "task_id", parentId, ownerId);
  const result = await tx.query<{ task_id: string; path: string[] }>(
    `WITH RECURSIVE parents AS (SELECT task_id,parent_task_id,ARRAY[task_id]::text[] path FROM tasks WHERE task_id=$1 AND owner_id=$2 UNION ALL SELECT t.task_id,t.parent_task_id,p.path||t.task_id FROM tasks t JOIN parents p ON t.task_id=p.parent_task_id WHERE t.owner_id=$2 AND NOT t.task_id=ANY(p.path)) SELECT task_id,path FROM parents`,
    [parentId, ownerId],
  );
  const cyclic = result.rows.find((r) => r.task_id === taskId);
  if (cyclic)
    throw new DomainError(
      "HIERARCHY_CYCLE",
      "Hierarchy cycle rejected.",
      { path: [taskId, ...cyclic.path] },
      409,
    );
  if (result.rows.length >= 12)
    throw new DomainError(
      "HIERARCHY_DEPTH",
      "Maximum supported hierarchy depth is 12.",
    );
  const children = await tx.query<{ depth: number }>(
    `WITH RECURSIVE descendants(task_id,depth,path) AS (SELECT task_id,1,ARRAY[task_id] FROM tasks WHERE task_id=$1 AND owner_id=$2 UNION ALL SELECT t.task_id,d.depth+1,d.path||t.task_id FROM tasks t JOIN descendants d ON t.parent_task_id=d.task_id WHERE t.owner_id=$2 AND NOT t.task_id=ANY(d.path)) SELECT max(depth)::integer depth FROM descendants`,
    [taskId, ownerId],
  );
  if (result.rows.length + (children.rows[0]?.depth ?? 1) > 12)
    throw new DomainError(
      "HIERARCHY_DEPTH",
      "Reparenting would exceed maximum hierarchy depth.",
    );
  const data = await snapshot(tx, ownerId);
  const edges = data.dependencies.filter((e) => e.mode === "hard");
  if (
    edges.some(
      (e) =>
        (e.dependent_task_id === taskId &&
          result.rows.some((p) => p.task_id === e.prerequisite_task_id)) ||
        (e.prerequisite_task_id === taskId &&
          result.rows.some((p) => p.task_id === e.dependent_task_id)),
    )
  )
    throw new DomainError(
      "DEPENDENCY_CYCLE",
      "A parent-child hard dependency would introduce conflicting hierarchy gates.",
      { task_id: taskId, parent_task_id: parentId },
      409,
    );
}
export async function validateEdge(
  tx: SqlClient,
  ownerId: string,
  dependent: string,
  prerequisite: string,
  mode = "hard",
) {
  const a = await entity(tx, "tasks", "task_id", dependent, ownerId),
    b = await entity(tx, "tasks", "task_id", prerequisite, ownerId);
  if (a.archived_at || b.archived_at)
    throw new DomainError(
      "INVALID_INPUT",
      "Archived tasks must be restored before adding a dependency.",
    );
  if (dependent === prerequisite)
    throw new DomainError(
      "DEPENDENCY_CYCLE",
      "Self dependency rejected.",
      { path: [dependent, dependent] },
      409,
    );
  const result = await tx.query<{ task_id: string }>(
    `WITH RECURSIVE reachable(task_id) AS (SELECT $1::text UNION SELECT g.dependent_task_id FROM reachable r JOIN task_dependency_edges e ON e.prerequisite_task_id=r.task_id JOIN task_dependency_groups g ON g.group_id=e.group_id WHERE e.owner_id=$3 AND g.owner_id=$3 AND e.archived_at IS NULL AND g.archived_at IS NULL) SELECT task_id FROM reachable WHERE task_id=$2 LIMIT 1`,
    [dependent, prerequisite, ownerId],
  );
  if (result.rows[0]) {
    const data = await snapshot(tx, ownerId),
      queue: { taskId: string; path: string[] }[] = [
        { taskId: dependent, path: [prerequisite, dependent] },
      ],
      seen = new Set<string>();
    let path: string[] = [prerequisite, dependent, prerequisite];
    while (queue.length) {
      const node = queue.shift()!;
      if (node.taskId === prerequisite) {
        path = node.path;
        break;
      }
      if (seen.has(node.taskId)) continue;
      seen.add(node.taskId);
      for (const next of data.downstream.get(node.taskId) ?? [])
        queue.push({ taskId: next, path: [...node.path, next] });
    }
    throw new DomainError(
      "DEPENDENCY_CYCLE",
      "Dependency cycle rejected.",
      { path },
      409,
    );
  }
  if (mode === "hard") {
    const related = await tx.query<{ task_id: string }>(
      `WITH RECURSIVE ancestors(task_id,parent_task_id) AS (SELECT task_id,parent_task_id FROM tasks WHERE task_id IN ($1,$2) AND owner_id=$3 UNION SELECT t.task_id,t.parent_task_id FROM tasks t JOIN ancestors a ON a.parent_task_id=t.task_id WHERE t.owner_id=$3) SELECT task_id FROM ancestors WHERE parent_task_id IN ($1,$2)`,
      [dependent, prerequisite, ownerId],
    );
    if (
      related.rows.length &&
      (a.parent_task_id === prerequisite || b.parent_task_id === dependent)
    )
      throw new DomainError(
        "DEPENDENCY_CYCLE",
        "Direct parent-child hard gates are rejected to prevent hierarchy deadlocks.",
        { path: [dependent, prerequisite, dependent] },
        409,
      );
  }
}
function validateProposed(
  data: Snapshot,
  dependent: string,
  proposed: Input[],
) {
  const adjacency = new Map<string, string[]>();
  for (const e of data.dependencies) {
    const dest = adjacency.get(e.prerequisite_task_id) ?? [];
    dest.push(e.dependent_task_id);
    adjacency.set(e.prerequisite_task_id, dest);
  }
  for (const p of proposed) {
    const prerequisite = text(p, "task_id");
    taskFromSnapshot(data, prerequisite);
    const stack: { id: string; path: string[] }[] = [
        { id: dependent, path: [prerequisite, dependent] },
      ],
      visited = new Set<string>();
    while (stack.length) {
      const node = stack.pop()!;
      if (node.id === prerequisite)
        throw new DomainError(
          "DEPENDENCY_CYCLE",
          "Dependency cycle rejected.",
          { path: node.path },
          409,
        );
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      for (const next of adjacency.get(node.id) ?? [])
        stack.push({ id: next, path: [...node.path, next] });
    }
    const dest = adjacency.get(prerequisite) ?? [];
    dest.push(dependent);
    adjacency.set(prerequisite, dest);
  }
}
export async function createPreview(
  tx: SqlClient,
  operation: string,
  input: Input,
  principal: Principal,
): Promise<PreviewDTO> {
  const data = await snapshot(tx, principal.ownerId);
  const revisions: Record<string, number> = {};
  let command: CommandName;
  const payload = { ...input };
  let affected: string[] = [];
  const warnings: string[] = [];
  const addTask = (taskId: string) => {
    const t = taskFromSnapshot(data, taskId);
    revisions[taskId] = t.revision;
    affected.push(taskId);
    return t;
  };
  switch (operation) {
    case "task_dependency_add_preview": {
      command = "task_dependency_add_commit";
      const taskId = text(input, "task_id");
      addTask(taskId);
      const prerequisites = array(input.prerequisites, 100);
      if (!prerequisites.length)
        throw new DomainError(
          "INVALID_INPUT",
          "At least one prerequisite required.",
        );
      choice(input, "operator", ["ALL", "ANY"], "ALL");
      const seen = new Set<string>();
      for (const p of prerequisites) {
        const pid = text(p, "task_id");
        if (seen.has(pid))
          throw new DomainError(
            "DEPENDENCY_ALREADY_EXISTS",
            "Duplicate prerequisite.",
          );
        seen.add(pid);
        addTask(pid);
        await validateEdge(
          tx,
          principal.ownerId,
          taskId,
          pid,
          choice(p, "mode", ["hard", "soft"], "hard"),
        );
      }
      validateProposed(data, taskId, prerequisites);
      payload.group_id = input.group_id ?? id("G");
      payload.prerequisites = prerequisites.map((p) => ({
        ...p,
        edge_id: id("D"),
      }));
      break;
    }
    case "task_dependency_remove_preview":
    case "task_dependency_waive_preview":
    case "task_dependency_restore_preview": {
      command =
        operation === "task_dependency_remove_preview"
          ? "task_dependency_remove_commit"
          : operation === "task_dependency_restore_preview"
            ? "task_dependency_restore_commit"
            : "task_dependency_waive_commit";
      const taskId = text(input, "task_id");
      addTask(taskId);
      const edge = await entity(
        tx,
        "task_dependency_edges",
        "edge_id",
        text(input, "edge_id"),
        principal.ownerId,
      );
      const group = await entity(
        tx,
        "task_dependency_groups",
        "group_id",
        String(edge.group_id),
        principal.ownerId,
      );
      if (group.dependent_task_id !== taskId)
        throw new DomainError(
          "INVALID_DEPENDENCY_GROUP",
          "The edge does not belong to this task.",
        );
      addTask(String(edge.prerequisite_task_id));
      if (command === "task_dependency_restore_commit") {
        if (!edge.archived_at)
          throw new DomainError(
            "INVALID_INPUT",
            "Dependency is already active.",
          );
        await validateEdge(
          tx,
          principal.ownerId,
          taskId,
          String(edge.prerequisite_task_id),
          String(edge.mode),
        );
      }
      if (command === "task_dependency_waive_commit") {
        if (input.explicit_user_intent !== true || principal.channel === "AI")
          throw new DomainError(
            "INSUFFICIENT_PERMISSIONS",
            "Waiver requires explicit human intent recorded outside untrusted AI content.",
            {},
            403,
          );
        payload.reason = text(input, "reason");
      }
      break;
    }
    case "subtask_reparent_preview": {
      command = "subtask_reparent_commit";
      const taskId = text(input, "task_id");
      addTask(taskId);
      const parent =
        input.parent_task_id === null ? null : text(input, "parent_task_id");
      if (parent) addTask(parent);
      await validateHierarchy(tx, principal.ownerId, taskId, parent);
      break;
    }
    case "task_batch_preview": {
      command = "task_batch_commit";
      let actions: Input[];
      if (input.task_ids) {
        if (
          !Array.isArray(input.task_ids) ||
          input.task_ids.length > 100 ||
          input.task_ids.some((v) => typeof v !== "string")
        )
          throw new DomainError("INVALID_INPUT", "Bounded task_ids required.");
        const action = choice(input, "action", [
          "complete",
          "reopen",
          "archive",
          "restore",
        ]);
        actions = input.task_ids.map((taskId) => ({
          command: `task_${action}`,
          input: { task_id: taskId },
        }));
        payload.actions = actions;
      } else actions = array(input.actions, 100);
      for (const action of actions) {
        choice(action, "command", [
          "task_update",
          "task_complete",
          "task_reopen",
          "task_archive",
          "task_restore",
        ]);
        const actionInput = object(action.input);
        const task = addTask(text(actionInput, "task_id"));
        if (action.command === "task_complete" && task.blocked_by.length)
          warnings.push(`TASK_BLOCKED:${task.task_id}`);
      }
      break;
    }
    case "task_template_instantiate_preview": {
      command = "task_template_instantiate_commit";
      const template = await entity(
        tx,
        "task_templates",
        "template_id",
        text(input, "template_id"),
        principal.ownerId,
      );
      payload.definition = template.definition;
      payload.instance_id = id("INSTANCE");
      if (
        input.preserve_external_links === true &&
        input.explicit_user_intent !== true
      )
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "External template links require explicit owner intent.",
          {},
          403,
        );
      break;
    }
    default:
      throw new DomainError("UNSUPPORTED_OPERATION", "Unsupported preview.");
  }
  affected = [...new Set(affected)];
  const previewId = id("PREVIEW"),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString();
  await tx.query(
    "INSERT INTO command_previews(preview_id,owner_id,command,input,revisions,expires_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)",
    [
      previewId,
      principal.ownerId,
      command,
      json(payload),
      json(revisions),
      expiresAt,
    ],
  );
  return {
    preview_id: previewId,
    command,
    input: payload,
    expires_at: expiresAt,
    revisions,
    affected_task_ids: affected,
    changes: JSON.parse(json(payload)),
    warnings,
  };
}
export async function consumePreview(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
): Promise<Input> {
  const previewId = text(input, "preview_id");
  const rows = await tx.query<{
    command: string;
    input: Input;
    revisions: Record<string, number>;
    expires_at: string;
    consumed_at: string | null;
  }>("SELECT * FROM command_previews WHERE preview_id=$1 AND owner_id=$2", [
    previewId,
    principal.ownerId,
  ]);
  const preview = rows.rows[0];
  if (!preview || preview.command !== command)
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "A matching owner-bound preview is required.",
      {},
      409,
    );
  if (
    new Date(preview.expires_at).getTime() < Date.now() ||
    preview.consumed_at
  )
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Preview expired or already committed.",
      {},
      409,
    );
  for (const [taskId, revision] of Object.entries(preview.revisions)) {
    const task = await entity(
      tx,
      "tasks",
      "task_id",
      taskId,
      principal.ownerId,
    );
    guard(task, revision);
  }
  await tx.query(
    "UPDATE command_previews SET consumed_at=$2 WHERE preview_id=$1 AND owner_id=$3",
    [previewId, now(), principal.ownerId],
  );
  return preview.input;
}
