import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  array,
  audit,
  bumpTask,
  choice,
  closed,
  date,
  entity,
  guard,
  id,
  instant,
  json,
  number,
  object,
  optionalText,
  snapshot,
  statuses,
  taskFromSnapshot,
  text,
  timezone,
  type Input,
} from "./core";
import { consumePreview, validateEdge, validateHierarchy } from "./graph";

export interface Change {
  entityId: string;
  before: unknown;
  after: unknown;
  affected: string[];
  reason?: string | null;
}
export async function createTask(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  forcedId?: string,
): Promise<Input> {
  const taskId = forcedId ?? id("T"),
    projectId = optionalText(input, "project_id"),
    parentId = optionalText(input, "parent_task_id");
  if (projectId)
    await entity(tx, "projects", "project_id", projectId, principal.ownerId);
  if (parentId)
    await validateHierarchy(tx, principal.ownerId, taskId, parentId);
  const status = choice(input, "status", statuses, "Inbox");
  if (status === "Done" || status === "Cancelled")
    throw new DomainError(
      "INVALID_INPUT",
      "Create an open task, then use an audited completion command.",
    );
  const estimate =
    input.estimated_minutes === undefined || input.estimated_minutes === null
      ? null
      : number(input, "estimated_minutes");
  if (estimate !== null && (!Number.isInteger(estimate) || estimate < 0))
    throw new DomainError(
      "INVALID_INPUT",
      "Estimate must be non-negative whole minutes.",
    );
  await tx.query(
    `INSERT INTO tasks(task_id,owner_id,project_id,parent_task_id,title,status,priority,category,notes,next_action,waiting_for,source_reference,start_date,due_date,due_at,timezone,estimated_minutes,sort_key,legacy_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
    [
      taskId,
      principal.ownerId,
      projectId,
      parentId,
      text(input, "title", undefined, 2000),
      status,
      choice(input, "priority", ["Low", "Normal", "High", "Urgent"], "Normal"),
      choice(
        input,
        "category",
        ["Study", "Research", "Work", "Admin", "Personal", "Other"],
        "Other",
      ),
      text(input, "notes", ""),
      text(input, "next_action", ""),
      text(input, "waiting_for", ""),
      text(input, "source_reference", ""),
      date(input, "start_date"),
      date(input, "due_date"),
      input.due_at ? instant(input, "due_at") : null,
      timezone(input),
      estimate,
      input.sort_key === undefined ? 0 : number(input, "sort_key"),
      json(input.legacy_metadata ?? {}),
    ],
  );
  return entity(tx, "tasks", "task_id", taskId, principal.ownerId);
}
async function updateTask(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
  operationId: string,
): Promise<Change> {
  const taskId = text(input, "task_id"),
    before = await entity(tx, "tasks", "task_id", taskId, principal.ownerId);
  guard(before, revision);
  const updates: Input = {};
  if (command === "task_update") {
    const forbidden = [
      "owner_id",
      "ownerId",
      "revision",
      "task_id",
      "completed_at",
      "closed_at",
      "created_at",
      "updated_at",
      "legacy_metadata",
    ];
    for (const key of forbidden)
      if (key !== "task_id" && key in input)
        throw new DomainError(
          "INVALID_INPUT",
          `Field ${key} is immutable or server-managed.`,
        );
    for (const key of [
      "title",
      "notes",
      "next_action",
      "waiting_for",
      "source_reference",
    ] as const)
      if (key in input)
        updates[key] = text(
          input,
          key,
          key === "title" ? undefined : "",
          key === "title" ? 2000 : 10000,
        );
    for (const key of ["start_date", "due_date"] as const)
      if (key in input) updates[key] = date(input, key);
    if ("due_at" in input)
      updates.due_at = input.due_at ? instant(input, "due_at") : null;
    if ("timezone" in input) updates.timezone = timezone(input);
    if ("priority" in input)
      updates.priority = choice(input, "priority", [
        "Low",
        "Normal",
        "High",
        "Urgent",
      ]);
    if ("category" in input)
      updates.category = choice(input, "category", [
        "Study",
        "Research",
        "Work",
        "Admin",
        "Personal",
        "Other",
      ]);
    if ("project_id" in input) {
      updates.project_id = optionalText(input, "project_id");
      if (updates.project_id)
        await entity(
          tx,
          "projects",
          "project_id",
          String(updates.project_id),
          principal.ownerId,
        );
    }
    if ("estimated_minutes" in input) {
      updates.estimated_minutes =
        input.estimated_minutes === null
          ? null
          : number(input, "estimated_minutes");
      if (
        updates.estimated_minutes !== null &&
        (!Number.isInteger(updates.estimated_minutes) ||
          Number(updates.estimated_minutes) < 0)
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Estimate must be non-negative whole minutes.",
        );
    }
    if ("sort_key" in input) updates.sort_key = number(input, "sort_key");
    if ("status" in input) updates.status = choice(input, "status", statuses);
  }
  if (command === "task_complete") updates.status = "Done";
  if (command === "task_reopen") {
    if (!closed(String(before.status)))
      throw new DomainError(
        "INVALID_INPUT",
        "Only closed tasks can be reopened.",
      );
    updates.status = choice(
      input,
      "status",
      ["Inbox", "Next", "In progress", "Waiting"],
      "Next",
    );
  }
  if (command === "task_archive")
    updates.archived_at = new Date().toISOString();
  if (command === "task_restore") updates.archived_at = null;
  if (
    updates.status &&
    (updates.status === "In progress" || updates.status === "Done") &&
    updates.status !== before.status
  ) {
    const data = await snapshot(tx, principal.ownerId),
      task = taskFromSnapshot(data, taskId);
    if (task.blocked_by.length || task.readiness === "scheduled") {
      if (!input.override_reason)
        throw new DomainError(
          "TASK_BLOCKED",
          "Task has unsatisfied prerequisites or a future start constraint.",
          {
            blocked_by: task.blocked_by,
            earliest_allowed_start: task.earliest_allowed_start,
            readiness: task.readiness,
          },
          409,
        );
      if (principal.channel !== "UI")
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Prerequisite overrides require the authenticated owner's web interaction.",
          {},
          403,
        );
      const reason = text(input, "override_reason");
      await audit(
        tx,
        principal,
        operationId,
        "task.override_blocker",
        taskId,
        {
          blocked_by: task.blocked_by,
          earliest_allowed_start: task.earliest_allowed_start,
        },
        { status: updates.status },
        reason,
      );
    }
  }
  if (updates.status && updates.status !== before.status) {
    if (closed(String(updates.status))) {
      updates.closed_at = before.closed_at ?? new Date().toISOString();
      updates.completed_at =
        updates.status === "Done"
          ? (before.completed_at ?? new Date().toISOString())
          : null;
    } else {
      updates.closed_at = null;
      updates.completed_at = null;
    }
  }
  const changed = Object.entries(updates).filter(
    ([key, val]) => before[key] !== val,
  );
  if (changed.length) {
    const params: unknown[] = [taskId, principal.ownerId];
    const fields = changed.map(([key, val]) => {
      params.push(val);
      return `${key}=$${params.length}`;
    });
    await tx.query(
      `UPDATE tasks SET ${fields.join(",")},revision=revision+1,updated_at=now() WHERE task_id=$1 AND owner_id=$2`,
      params,
    );
  }
  if (before.status === "Done" && updates.status && updates.status !== "Done") {
    const archivedFiles = await tx.query<{ file_id: string }>(
      "SELECT DISTINCT f.file_id FROM files f JOIN file_task_links l ON l.file_id=f.file_id AND l.owner_id=f.owner_id WHERE l.task_id=$1 AND l.owner_id=$2 AND l.active=true AND f.state='Old' AND f.provider='private_blob'",
      [taskId, principal.ownerId],
    );
    for (const f of archivedFiles.rows)
      await tx.query(
        "UPDATE files SET state='Active',archived_at=NULL,revision=revision+1 WHERE file_id=$1 AND owner_id=$2",
        [f.file_id, principal.ownerId],
      );
  }
  return {
    entityId: taskId,
    before,
    after: await entity(tx, "tasks", "task_id", taskId, principal.ownerId),
    affected: [taskId],
    reason: optionalText(input, "override_reason"),
  };
}
export async function taskCommand(
  tx: SqlClient,
  command: CommandName,
  initial: Input,
  principal: Principal,
  revision: number | undefined,
  operationId: string,
): Promise<Change> {
  let input = initial;
  if (
    [
      "task_dependency_add_commit",
      "task_dependency_remove_commit",
      "task_dependency_waive_commit",
      "task_dependency_restore_commit",
      "subtask_reparent_commit",
      "task_template_instantiate_commit",
      "task_batch_commit",
    ].includes(command)
  )
    input = await consumePreview(tx, command, input, principal);
  if (command === "task_create" || command === "subtask_create") {
    if (command === "subtask_create" && !input.parent_task_id)
      throw new DomainError("INVALID_INPUT", "parent_task_id required.");
    const task = await createTask(tx, input, principal);
    return {
      entityId: String(task.task_id),
      before: null,
      after: task,
      affected: [String(task.task_id)],
    };
  }
  if (
    [
      "task_update",
      "task_complete",
      "task_reopen",
      "task_archive",
      "task_restore",
    ].includes(command)
  )
    return updateTask(tx, command, input, principal, revision, operationId);
  if (command === "task_batch_commit") {
    const result: Change[] = [];
    for (const action of array(input.actions, 100)) {
      const item = object(action.input);
      const current = await entity(
        tx,
        "tasks",
        "task_id",
        text(item, "task_id"),
        principal.ownerId,
      );
      result.push(
        await updateTask(
          tx,
          choice(action, "command", [
            "task_update",
            "task_complete",
            "task_reopen",
            "task_archive",
            "task_restore",
          ]),
          item,
          principal,
          Number(current.revision),
          operationId,
        ),
      );
    }
    return {
      entityId: result[0]?.entityId ?? operationId,
      before: result.map((r) => r.before),
      after: result.map((r) => r.after),
      affected: result.flatMap((r) => r.affected),
    };
  }
  if (command === "task_dependency_add_commit") {
    const taskId = text(input, "task_id"),
      groupId = text(input, "group_id"),
      before = await entity(tx, "tasks", "task_id", taskId, principal.ownerId);
    const exists = await tx.query<{
      dependent_task_id: string;
      operator: string;
    }>(
      "SELECT * FROM task_dependency_groups WHERE group_id=$1 AND owner_id=$2",
      [groupId, principal.ownerId],
    );
    if (
      exists.rows[0] &&
      (exists.rows[0].dependent_task_id !== taskId ||
        exists.rows[0].operator !==
          choice(input, "operator", ["ALL", "ANY"], "ALL"))
    )
      throw new DomainError(
        "INVALID_DEPENDENCY_GROUP",
        "Group does not match task or operator.",
      );
    if (!exists.rows[0])
      await tx.query(
        "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id,operator) VALUES($1,$2,$3,$4)",
        [
          groupId,
          principal.ownerId,
          taskId,
          choice(input, "operator", ["ALL", "ANY"], "ALL"),
        ],
      );
    for (const prerequisite of array(input.prerequisites, 100)) {
      const pid = text(prerequisite, "task_id"),
        mode = choice(prerequisite, "mode", ["hard", "soft"], "hard");
      await validateEdge(tx, principal.ownerId, taskId, pid, mode);
      const duplicate = await tx.query(
        "SELECT edge_id FROM task_dependency_edges WHERE group_id=$1 AND prerequisite_task_id=$2 AND archived_at IS NULL",
        [groupId, pid],
      );
      if (duplicate.rows.length)
        throw new DomainError(
          "DEPENDENCY_ALREADY_EXISTS",
          "Dependency already exists.",
          {},
          409,
        );
      await tx.query(
        "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id,mode,note) VALUES($1,$2,$3,$4,$5,$6)",
        [
          text(prerequisite, "edge_id"),
          principal.ownerId,
          groupId,
          pid,
          mode,
          optionalText(prerequisite, "note"),
        ],
      );
    }
    await bumpTask(tx, taskId, principal.ownerId);
    return {
      entityId: taskId,
      before,
      after: taskFromSnapshot(await snapshot(tx, principal.ownerId), taskId),
      affected: [taskId],
    };
  }
  if (
    command === "task_dependency_remove_commit" ||
    command === "task_dependency_waive_commit"
  ) {
    const taskId = text(input, "task_id"),
      edgeId = text(input, "edge_id"),
      before = await entity(
        tx,
        "task_dependency_edges",
        "edge_id",
        edgeId,
        principal.ownerId,
      );
    if (command === "task_dependency_remove_commit")
      await tx.query(
        "UPDATE task_dependency_edges SET archived_at=now(),revision=revision+1 WHERE edge_id=$1 AND owner_id=$2",
        [edgeId, principal.ownerId],
      );
    else {
      if (principal.channel === "AI" || input.explicit_user_intent !== true)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Explicit human intent required.",
          {},
          403,
        );
      await tx.query(
        "UPDATE task_dependency_edges SET waived_at=now(),waived_by=$3,waiver_reason=$4,revision=revision+1 WHERE edge_id=$1 AND owner_id=$2",
        [edgeId, principal.ownerId, principal.actorId, text(input, "reason")],
      );
    }
    await bumpTask(tx, taskId, principal.ownerId);
    return {
      entityId: taskId,
      before,
      after: await entity(
        tx,
        "task_dependency_edges",
        "edge_id",
        edgeId,
        principal.ownerId,
      ),
      affected: [taskId],
      reason: optionalText(input, "reason"),
    };
  }
  if (command === "task_dependency_restore_commit") {
    const taskId = text(input, "task_id"),
      edgeId = text(input, "edge_id"),
      before = await entity(
        tx,
        "task_dependency_edges",
        "edge_id",
        edgeId,
        principal.ownerId,
      );
    await validateEdge(
      tx,
      principal.ownerId,
      taskId,
      String(before.prerequisite_task_id),
      String(before.mode),
    );
    const duplicate = await tx.query(
      "SELECT edge_id FROM task_dependency_edges WHERE group_id=$1 AND prerequisite_task_id=$2 AND archived_at IS NULL",
      [before.group_id, before.prerequisite_task_id],
    );
    if (duplicate.rows.length)
      throw new DomainError(
        "DEPENDENCY_ALREADY_EXISTS",
        "An active replacement relation already exists.",
        {},
        409,
      );
    await tx.query(
      "UPDATE task_dependency_edges SET archived_at=NULL,revision=revision+1 WHERE edge_id=$1 AND owner_id=$2",
      [edgeId, principal.ownerId],
    );
    await bumpTask(tx, taskId, principal.ownerId);
    return {
      entityId: taskId,
      before,
      after: await entity(
        tx,
        "task_dependency_edges",
        "edge_id",
        edgeId,
        principal.ownerId,
      ),
      affected: [taskId],
    };
  }
  if (command === "task_dependency_group_update") {
    const groupId = text(input, "group_id"),
      before = await entity(
        tx,
        "task_dependency_groups",
        "group_id",
        groupId,
        principal.ownerId,
      );
    guard(before, revision);
    await tx.query(
      "UPDATE task_dependency_groups SET operator=$3,enabled=$4,revision=revision+1 WHERE group_id=$1 AND owner_id=$2",
      [
        groupId,
        principal.ownerId,
        choice(input, "operator", ["ALL", "ANY"]),
        input.enabled === undefined
          ? Boolean(before.enabled)
          : input.enabled === true,
      ],
    );
    const taskId = String(before.dependent_task_id);
    await bumpTask(tx, taskId, principal.ownerId);
    return {
      entityId: taskId,
      before,
      after: await entity(
        tx,
        "task_dependency_groups",
        "group_id",
        groupId,
        principal.ownerId,
      ),
      affected: [taskId],
    };
  }
  if (command === "subtask_reparent_commit") {
    const taskId = text(input, "task_id"),
      before = await entity(tx, "tasks", "task_id", taskId, principal.ownerId),
      parentId =
        input.parent_task_id === null ? null : text(input, "parent_task_id");
    await validateHierarchy(tx, principal.ownerId, taskId, parentId);
    await tx.query(
      "UPDATE tasks SET parent_task_id=$3,revision=revision+1,updated_at=now() WHERE task_id=$1 AND owner_id=$2",
      [taskId, principal.ownerId, parentId],
    );
    return {
      entityId: taskId,
      before,
      after: await entity(tx, "tasks", "task_id", taskId, principal.ownerId),
      affected: [taskId, ...(parentId ? [parentId] : [])],
    };
  }
  if (command.startsWith("task_checklist"))
    return checklistCommand(tx, command, input, principal, revision);
  if (command === "task_template_create") {
    const templateId = id("TPL");
    let definition: Input;
    if (input.root_task_id) {
      const data = await snapshot(tx, principal.ownerId),
        root = text(input, "root_task_id");
      taskFromSnapshot(data, root);
      const ids = new Set([root]),
        queue = [root];
      while (queue.length) {
        const parent = queue.shift()!;
        for (const child of data.tasks.filter(
          (t) => t.parent_task_id === parent && !t.archived_at,
        ))
          if (!ids.has(child.task_id)) {
            ids.add(child.task_id);
            queue.push(child.task_id);
          }
      }
      if (ids.size > 500)
        throw new DomainError(
          "INVALID_INPUT",
          "Subtree exceeds template limit500; split into smaller templates.",
        );
      definition = {
        tasks: data.tasks
          .filter((t) => ids.has(t.task_id))
          .map((t) => ({
            task_id: t.task_id,
            title: t.title,
            notes: t.notes,
            priority: t.priority,
            category: t.category,
            estimated_minutes: t.estimated_minutes,
            parent_task_id: ids.has(t.parent_task_id ?? "")
              ? t.parent_task_id
              : null,
          })),
        edges: data.dependencies
          .filter(
            (e) =>
              ids.has(e.dependent_task_id) && ids.has(e.prerequisite_task_id),
          )
          .map((e) => ({ ...e })),
        checklists: data.checklists
          .filter((c) => ids.has(c.task_id) && !c.archived_at)
          .map((c) => ({
            task_id: c.task_id,
            title: c.title,
            items: c.items
              .filter((i) => !i.archived_at)
              .map((i) => ({ title: i.title, notes: i.notes })),
          })),
      };
    } else definition = object(input.definition);
    array(definition.tasks, 500);
    if (definition.edges) array(definition.edges, 2000);
    await tx.query(
      "INSERT INTO task_templates(template_id,owner_id,title,definition) VALUES($1,$2,$3,$4::jsonb)",
      [templateId, principal.ownerId, text(input, "title"), json(definition)],
    );
    return {
      entityId: templateId,
      before: null,
      after: await entity(
        tx,
        "task_templates",
        "template_id",
        templateId,
        principal.ownerId,
      ),
      affected: [],
    };
  }
  if (command === "task_template_instantiate_commit")
    return instantiateTemplate(tx, input, principal, operationId);
  throw new DomainError("UNSUPPORTED_OPERATION", "Unsupported task command.");
}
async function checklistCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
): Promise<Change> {
  const owner = principal.ownerId;
  if (command === "task_checklist_duplicate") {
    const original = await entity(
      tx,
      "task_checklists",
      "checklist_id",
      text(input, "checklist_id"),
      owner,
    );
    guard(original, revision);
    const originalItems = (
      await tx.query<Input>(
        "SELECT * FROM task_checklist_items WHERE checklist_id=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY sort_key,item_id",
        [original.checklist_id, owner],
      )
    ).rows;
    const checklistId = id("CL"),
      mapping: Record<string, string> = {};
    await tx.query(
      "INSERT INTO task_checklists(checklist_id,owner_id,task_id,title,sort_key,required) VALUES($1,$2,$3,$4,$5,$6)",
      [
        checklistId,
        owner,
        original.task_id,
        text(input, "title", String(original.title)),
        Number(original.sort_key) + 1,
        original.required,
      ],
    );
    for (const item of originalItems) {
      const itemId = id("CI");
      mapping[String(item.item_id)] = itemId;
      const checked = input.preserve_checked === true && item.checked === true;
      await tx.query(
        "INSERT INTO task_checklist_items(item_id,owner_id,checklist_id,title,notes,sort_key,checked,checked_at,checked_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
        [
          itemId,
          owner,
          checklistId,
          item.title,
          item.notes,
          item.sort_key,
          checked,
          checked ? item.checked_at : null,
          checked ? item.checked_by : null,
        ],
      );
    }
    await bumpTask(tx, String(original.task_id), owner);
    return {
      entityId: checklistId,
      before: { ...original, items: originalItems },
      after: {
        ...(await entity(
          tx,
          "task_checklists",
          "checklist_id",
          checklistId,
          owner,
        )),
        copied_from_checklist_id: original.checklist_id,
        item_id_mapping: mapping,
      },
      affected: [String(original.task_id)],
    };
  }
  if (command === "task_checklist_create") {
    const taskId = text(input, "task_id");
    await entity(tx, "tasks", "task_id", taskId, owner);
    const checklistId = id("CL");
    await tx.query(
      "INSERT INTO task_checklists(checklist_id,owner_id,task_id,title,sort_key) VALUES($1,$2,$3,$4,$5)",
      [checklistId, owner, taskId, text(input, "title"), input.sort_key ?? 0],
    );
    await bumpTask(tx, taskId, owner);
    return {
      entityId: checklistId,
      before: null,
      after: await entity(
        tx,
        "task_checklists",
        "checklist_id",
        checklistId,
        owner,
      ),
      affected: [taskId],
    };
  }
  if (
    [
      "task_checklist_update",
      "task_checklist_archive",
      "task_checklist_restore",
      "task_checklist_item_add",
      "task_checklist_item_reorder",
    ].includes(command)
  ) {
    const checklistId = text(input, "checklist_id"),
      before = await entity(
        tx,
        "task_checklists",
        "checklist_id",
        checklistId,
        owner,
      );
    guard(before, revision);
    const taskId = String(before.task_id);
    let entityId = checklistId;
    if (command === "task_checklist_item_add") {
      entityId = id("CI");
      await tx.query(
        "INSERT INTO task_checklist_items(item_id,owner_id,checklist_id,title,notes,sort_key) VALUES($1,$2,$3,$4,$5,$6)",
        [
          entityId,
          owner,
          checklistId,
          text(input, "title"),
          text(input, "notes", ""),
          input.sort_key ?? Date.now(),
        ],
      );
    }
    if (command === "task_checklist_item_reorder") {
      if (
        !Array.isArray(input.item_ids) ||
        input.item_ids.some((v) => typeof v !== "string")
      )
        throw new DomainError("INVALID_INPUT", "item_ids required.");
      const all = await tx.query<{ item_id: string }>(
        "SELECT item_id FROM task_checklist_items WHERE checklist_id=$1 AND owner_id=$2 AND archived_at IS NULL",
        [checklistId, owner],
      );
      const itemIds = input.item_ids as string[];
      if (
        itemIds.length !== new Set(itemIds).size ||
        itemIds.length !== all.rows.length ||
        all.rows.some((r) => !itemIds.includes(r.item_id))
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Reorder must contain every active item exactly once.",
        );
      for (let index = 0; index < itemIds.length; index++)
        await tx.query(
          "UPDATE task_checklist_items SET sort_key=$3,revision=revision+1 WHERE item_id=$1 AND owner_id=$2",
          [itemIds[index], owner, index],
        );
    }
    if (command === "task_checklist_update")
      await tx.query(
        "UPDATE task_checklists SET title=$3,sort_key=$4 WHERE checklist_id=$1 AND owner_id=$2",
        [
          checklistId,
          owner,
          text(input, "title", String(before.title)),
          input.sort_key ?? before.sort_key,
        ],
      );
    if (
      command === "task_checklist_archive" ||
      command === "task_checklist_restore"
    )
      await tx.query(
        "UPDATE task_checklists SET archived_at=$3 WHERE checklist_id=$1 AND owner_id=$2",
        [
          checklistId,
          owner,
          command === "task_checklist_archive"
            ? new Date().toISOString()
            : null,
        ],
      );
    await tx.query(
      "UPDATE task_checklists SET revision=revision+1 WHERE checklist_id=$1 AND owner_id=$2",
      [checklistId, owner],
    );
    await bumpTask(tx, taskId, owner);
    return {
      entityId,
      before,
      after: await entity(
        tx,
        entityId === checklistId ? "task_checklists" : "task_checklist_items",
        entityId === checklistId ? "checklist_id" : "item_id",
        entityId,
        owner,
      ),
      affected: [taskId],
    };
  }
  const itemId = text(input, "item_id"),
    before = await entity(tx, "task_checklist_items", "item_id", itemId, owner);
  guard(before, revision);
  const checklist = await entity(
      tx,
      "task_checklists",
      "checklist_id",
      String(before.checklist_id),
      owner,
    ),
    taskId = String(checklist.task_id);
  if (command === "task_checklist_item_promote") {
    if (before.promoted_task_id)
      return {
        entityId: String(before.promoted_task_id),
        before,
        after: await entity(
          tx,
          "tasks",
          "task_id",
          String(before.promoted_task_id),
          owner,
        ),
        affected: [taskId, String(before.promoted_task_id)],
      };
    const original = choice(input, "original", ["archive", "keep_reference"]);
    const task = await createTask(
      tx,
      {
        title: before.title,
        notes: before.notes,
        parent_task_id: taskId,
        source_reference: `checklist:${itemId}`,
      },
      principal,
    );
    await tx.query(
      "UPDATE task_checklist_items SET promoted_task_id=$3,archived_at=$4,checked=$5,checked_at=$6,checked_by=$7,revision=revision+1 WHERE item_id=$1 AND owner_id=$2",
      [
        itemId,
        owner,
        task.task_id,
        original === "archive" ? new Date().toISOString() : null,
        original === "keep_reference" ? true : before.checked,
        original === "keep_reference"
          ? (before.checked_at ?? new Date().toISOString())
          : before.checked_at,
        original === "keep_reference"
          ? (before.checked_by ?? principal.actorId)
          : before.checked_by,
      ],
    );
    await bumpTask(tx, taskId, owner);
    return {
      entityId: String(task.task_id),
      before,
      after: task,
      affected: [taskId, String(task.task_id)],
    };
  }
  if (
    command === "task_checklist_item_check" ||
    command === "task_checklist_item_uncheck"
  ) {
    const checked = command === "task_checklist_item_check";
    if (before.checked !== checked)
      await tx.query(
        "UPDATE task_checklist_items SET checked=$3,checked_at=$4,checked_by=$5,revision=revision+1 WHERE item_id=$1 AND owner_id=$2",
        [
          itemId,
          owner,
          checked,
          checked ? new Date().toISOString() : null,
          checked ? principal.actorId : null,
        ],
      );
  } else if (
    command === "task_checklist_item_archive" ||
    command === "task_checklist_item_restore"
  )
    await tx.query(
      "UPDATE task_checklist_items SET archived_at=$3,revision=revision+1 WHERE item_id=$1 AND owner_id=$2",
      [
        itemId,
        owner,
        command === "task_checklist_item_archive"
          ? new Date().toISOString()
          : null,
      ],
    );
  else if (command === "task_checklist_item_update")
    await tx.query(
      "UPDATE task_checklist_items SET title=$3,notes=$4,revision=revision+1 WHERE item_id=$1 AND owner_id=$2",
      [
        itemId,
        owner,
        text(input, "title", String(before.title)),
        text(input, "notes", String(before.notes)),
      ],
    );
  else
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Unknown checklist command.",
    );
  await bumpTask(tx, taskId, owner);
  return {
    entityId: itemId,
    before,
    after: await entity(tx, "task_checklist_items", "item_id", itemId, owner),
    affected: [taskId],
  };
}
export async function instantiateTemplate(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  operationId = id("OP"),
): Promise<Change> {
  const definition = object(input.definition),
    definitions = array(definition.tasks, 500),
    mapping = new Map<string, string>();
  for (const step of definitions) {
    const originalId = text(step, "task_id");
    if (mapping.has(originalId))
      throw new DomainError("INVALID_INPUT", "Duplicate template task ID.");
    mapping.set(originalId, id("T"));
  }
  const created: Input[] = [];
  for (const step of definitions) {
    const clean = {
      ...step,
      status: "Inbox",
      parent_task_id: null,
      project_id: input.project_id ?? null,
      due_date: null,
      due_at: null,
      legacy_metadata: {
        template_id: input.template_id,
        instance_id: input.instance_id,
      },
    };
    created.push(
      await createTask(
        tx,
        clean,
        principal,
        mapping.get(text(step, "task_id")),
      ),
    );
  }
  for (const step of definitions)
    if (step.parent_task_id) {
      const dest = mapping.get(text(step, "task_id"))!,
        parent = mapping.get(String(step.parent_task_id));
      if (!parent)
        throw new DomainError("INVALID_INPUT", "Template parent missing.");
      await validateHierarchy(tx, principal.ownerId, dest, parent);
      await tx.query(
        "UPDATE tasks SET parent_task_id=$3 WHERE task_id=$1 AND owner_id=$2",
        [dest, principal.ownerId, parent],
      );
    }
  const groups = new Map<string, string>();
  for (const edge of definition.edges ? array(definition.edges, 2000) : []) {
    const dependent = mapping.get(text(edge, "dependent_task_id"));
    let prerequisite = mapping.get(text(edge, "prerequisite_task_id"));
    if (!dependent)
      throw new DomainError("INVALID_INPUT", "Template dependent missing.");
    if (!prerequisite) {
      if (input.preserve_external_links !== true) continue;
      prerequisite = text(edge, "prerequisite_task_id");
    }
    await validateEdge(
      tx,
      principal.ownerId,
      dependent,
      prerequisite,
      choice(edge, "mode", ["hard", "soft"], "hard"),
    );
    const originalGroup = text(edge, "group_id", dependent),
      groupKey = `${dependent}:${originalGroup}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = id("G");
      groups.set(groupKey, group);
      await tx.query(
        "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id,operator) VALUES($1,$2,$3,$4)",
        [
          group,
          principal.ownerId,
          dependent,
          choice(edge, "operator", ["ALL", "ANY"], "ALL"),
        ],
      );
    }
    await tx.query(
      "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id,mode) VALUES($1,$2,$3,$4,$5)",
      [
        id("D"),
        principal.ownerId,
        group,
        prerequisite,
        choice(edge, "mode", ["hard", "soft"], "hard"),
      ],
    );
  }
  for (const checklist of definition.checklists
    ? array(definition.checklists, 1000)
    : []) {
    const taskId = mapping.get(text(checklist, "task_id"));
    if (!taskId)
      throw new DomainError(
        "INVALID_INPUT",
        "Template checklist task missing.",
      );
    const list = id("CL");
    await tx.query(
      "INSERT INTO task_checklists(checklist_id,owner_id,task_id,title) VALUES($1,$2,$3,$4)",
      [list, principal.ownerId, taskId, text(checklist, "title")],
    );
    for (const item of checklist.items ? array(checklist.items, 1000) : [])
      await tx.query(
        "INSERT INTO task_checklist_items(item_id,owner_id,checklist_id,title,notes) VALUES($1,$2,$3,$4,$5)",
        [
          id("CI"),
          principal.ownerId,
          list,
          text(item, "title"),
          text(item, "notes", ""),
        ],
      );
  }
  const finalSnapshot = await snapshot(tx, principal.ownerId);
  const finalTasks = created.map((task) =>
    taskFromSnapshot(finalSnapshot, String(task.task_id)),
  );
  for (const task of finalTasks)
    await audit(
      tx,
      principal,
      operationId,
      "task.template_instantiated",
      task.task_id,
      null,
      task,
    );
  return {
    entityId: String(input.instance_id),
    before: null,
    after: {
      instance_id: input.instance_id,
      id_mapping: Object.fromEntries(mapping),
      tasks: finalTasks,
    },
    affected: [...mapping.values()],
  };
}
