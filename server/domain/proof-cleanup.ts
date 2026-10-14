import { DomainError, type Principal } from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import { cleanRows, entity, guard, hash, object, type Input } from "./core";

export interface SyntheticTemplateCleanupInput {
  run_id: string;
  template_id: string;
  rule_id: string;
  rule_revision: number;
  instances: {
    instance_id: string;
    occurrence_date: string;
    task_ids: string[];
  }[];
  task_revisions: Record<string, number>;
}
export const SYNTHETIC_CLEANUP_OPERATION =
  "system_synthetic_template_artifacts_cleanup";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new DomainError("INVALID_INPUT", message);
}
function strict(row: Input, names: readonly string[]) {
  requireCondition(
    Object.keys(row).length === names.length &&
      names.every((name) => Object.hasOwn(row, name)),
    "The cleanup input must contain only the exact proof fields.",
  );
}
function identity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}
function revision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function sameIds(actual: string[], expected: string[]) {
  return (
    new Set(actual).size === actual.length &&
    new Set(expected).size === expected.length &&
    hash([...actual].sort()) === hash([...expected].sort())
  );
}
export function validateSyntheticCleanupInput(
  value: unknown,
): SyntheticTemplateCleanupInput {
  const row = object(value);
  strict(row, [
    "run_id",
    "template_id",
    "rule_id",
    "rule_revision",
    "instances",
    "task_revisions",
  ]);
  requireCondition(
    typeof row.run_id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        row.run_id,
      ) &&
      identity(row.template_id) &&
      identity(row.rule_id) &&
      revision(row.rule_revision),
    "A known proof run and exact template/rule identities and revision are required.",
  );
  const tasks = object(row.task_revisions);
  requireCondition(
    Object.keys(tasks).length === 21 &&
      Object.entries(tasks).every(
        ([taskId, version]) => identity(taskId) && revision(version),
      ),
    "The exact retained 21 proof task revisions are required.",
  );
  requireCondition(
    Array.isArray(row.instances) &&
      row.instances.length > 0 &&
      row.instances.length <= 30,
    "The exact bounded recurrence instances are required.",
  );
  const instanceIds: string[] = [];
  for (const value of row.instances) {
    const instance = object(value);
    strict(instance, ["instance_id", "occurrence_date", "task_ids"]);
    requireCondition(
      identity(instance.instance_id) &&
        typeof instance.occurrence_date === "string" &&
        /^\d{4}-\d{2}-\d{2}$/.test(instance.occurrence_date) &&
        Number.isFinite(Date.parse(instance.occurrence_date + "T00:00:00Z")) &&
        new Date(instance.occurrence_date + "T00:00:00Z")
          .toISOString()
          .slice(0, 10) === instance.occurrence_date &&
        Array.isArray(instance.task_ids) &&
        instance.task_ids.length > 0 &&
        instance.task_ids.length <= 21 &&
        instance.task_ids.every(
          (taskId) => identity(taskId) && Object.hasOwn(tasks, taskId),
        ) &&
        new Set(instance.task_ids).size === instance.task_ids.length,
      "Every exact instance date and member must belong to the retained proof tasks.",
    );
    instanceIds.push(instance.instance_id);
  }
  requireCondition(
    new Set(instanceIds).size === instanceIds.length,
    "Instance identities must be unique.",
  );
  return JSON.parse(JSON.stringify(row)) as SyntheticTemplateCleanupInput;
}

/** Only called by the owner-bound internal service; never a public command. */
export async function removeSyntheticTemplateArtifacts(
  tx: SqlClient,
  input: SyntheticTemplateCleanupInput,
  principal: Principal,
  templateRevision: number | undefined,
) {
  const owner = principal.ownerId,
    taskIds = Object.keys(input.task_revisions),
    instanceIds = input.instances.map((row) => row.instance_id),
    prefix = "SYNTHETIC GRAPH PROOF " + input.run_id.slice(0, 8) + " ";
  const template = await entity(
    tx,
    "task_templates",
    "template_id",
    input.template_id,
    owner,
  );
  guard(template, templateRevision);
  requireCondition(
    typeof template.title === "string" && template.title.startsWith(prefix),
    "Only the exact synthetic proof template can be removed.",
  );
  const rules = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM task_recurrence_rules WHERE owner_id=$1 AND template_id=$2 ORDER BY rule_id",
        [owner, input.template_id],
      )
    ).rows,
  );
  requireCondition(
    rules.length === 1 && rules[0].rule_id === input.rule_id,
    "The template has missing or additional recurrence references.",
  );
  const rule = rules[0];
  guard(rule, input.rule_revision);
  requireCondition(
    rule.enabled === false &&
      typeof rule.title === "string" &&
      rule.title.startsWith(prefix),
    "The exact synthetic recurrence rule must already be paused.",
  );
  const instances = cleanRows(
    (
      await tx.query<Input>(
        "SELECT *,occurrence_date::text AS occurrence_date FROM task_recurrence_instances WHERE owner_id=$1 AND rule_id=$2 ORDER BY instance_id",
        [owner, input.rule_id],
      )
    ).rows,
  );
  requireCondition(
    sameIds(
      instances.map((row) => String(row.instance_id)),
      instanceIds,
    ),
    "Every recurrence instance must be explicitly selected; no additional instances are removed.",
  );
  const members = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM task_recurrence_instance_tasks WHERE owner_id=$1 AND instance_id=ANY($2::text[]) ORDER BY instance_id,task_id",
        [owner, instanceIds],
      )
    ).rows,
  );
  for (const instance of instances) {
    const expected = input.instances.find(
      (row) => row.instance_id === instance.instance_id,
    )!;
    requireCondition(
      instance.occurrence_date === expected.occurrence_date &&
        Array.isArray(instance.task_ids) &&
        instance.task_ids.every(identity) &&
        sameIds(instance.task_ids, expected.task_ids) &&
        sameIds(
          members
            .filter((row) => row.instance_id === instance.instance_id)
            .map((row) => String(row.task_id)),
          expected.task_ids,
        ),
      "The instance JSON and native membership must match the exact proof members.",
    );
  }
  const tasks = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM tasks WHERE owner_id=$1 AND task_id=ANY($2::text[]) ORDER BY task_id",
        [owner, taskIds],
      )
    ).rows,
  );
  requireCondition(
    sameIds(
      tasks.map((row) => String(row.task_id)),
      taskIds,
    ),
    "Every retained proof task must belong to this owner.",
  );
  const byId = new Map(tasks.map((row) => [String(row.task_id), row]));
  for (const task of tasks) {
    guard(task, input.task_revisions[String(task.task_id)]);
    requireCondition(
      task.archived_at !== null &&
        task.archived_at !== undefined &&
        typeof task.title === "string" &&
        task.title.startsWith(prefix) &&
        (task.parent_task_id === null ||
          task.parent_task_id === undefined ||
          taskIds.includes(String(task.parent_task_id))),
      "Every proof task must remain archived and inside its own synthetic hierarchy.",
    );
  }
  const definition = object(template.definition);
  requireCondition(
    Array.isArray(definition.tasks) &&
      definition.tasks.length > 0 &&
      definition.tasks.length <= 21,
    "The synthetic template definition must be intact.",
  );
  const originalIds = definition.tasks.map((value) =>
    String(object(value).task_id),
  );
  requireCondition(
    new Set(originalIds).size === originalIds.length &&
      originalIds.every((id) => byId.has(id)),
    "Every original template task must be part of the archived proof.",
  );
  const roots = definition.tasks.filter(
    (value) => !object(value).parent_task_id,
  );
  requireCondition(
    roots.length === 1 &&
      byId.get(String(object(roots[0]).task_id))?.source_reference ===
        "synthetic-production-graph-proof:" + input.run_id,
    "The original template root must retain the exact proof run marker.",
  );
  const recurringTaskIds = new Set<string>();
  for (const instance of input.instances) {
    requireCondition(
      instance.task_ids.length === originalIds.length,
      "The recurrence instance must contain every template step.",
    );
    for (const taskId of instance.task_ids) {
      const metadata = object(byId.get(taskId)?.legacy_metadata);
      requireCondition(
        metadata.template_id === input.template_id &&
          metadata.instance_id === instance.instance_id &&
          metadata.recurrence_rule_id === input.rule_id &&
          metadata.occurrence_date === instance.occurrence_date,
        "Every recurrence member must retain its exact template/rule/instance provenance.",
      );
      recurringTaskIds.add(taskId);
    }
  }
  const cloned = (
    await tx.query<{ task_id: string }>(
      "SELECT task_id FROM tasks WHERE owner_id=$1 AND legacy_metadata->>'template_id'=$2 ORDER BY task_id",
      [owner, input.template_id],
    )
  ).rows;
  requireCondition(
    cloned.every((row) => byId.has(row.task_id)),
    "The template has an additional task instance outside the exact proof.",
  );
  const recurring = (
    await tx.query<{ task_id: string }>(
      "SELECT task_id FROM tasks WHERE owner_id=$1 AND legacy_metadata->>'recurrence_rule_id'=$2 ORDER BY task_id",
      [owner, input.rule_id],
    )
  ).rows;
  requireCondition(
    sameIds(
      recurring.map((row) => row.task_id),
      [...recurringTaskIds],
    ),
    "The recurrence rule has additional or missing task provenance references.",
  );
  const targetIds = [
    ...taskIds,
    input.template_id,
    input.rule_id,
    ...instanceIds,
  ];
  const references = (
    await tx.query<Record<string, number>>(
      `SELECT
      (SELECT count(*)::integer FROM source_mappings WHERE owner_id=$1 AND destination_id=ANY($2::text[])) AS source,
      (SELECT count(*)::integer FROM tasks WHERE owner_id=$1 AND parent_task_id=ANY($3::text[]) AND NOT(task_id=ANY($3::text[]))) AS children,
      (SELECT count(*)::integer FROM task_dependency_edges e JOIN task_dependency_groups g ON g.group_id=e.group_id AND g.owner_id=e.owner_id WHERE e.owner_id=$1 AND ((g.dependent_task_id=ANY($3::text[]) AND NOT(e.prerequisite_task_id=ANY($3::text[]))) OR (e.prerequisite_task_id=ANY($3::text[]) AND NOT(g.dependent_task_id=ANY($3::text[]))))) AS edges,
      (SELECT count(*)::integer FROM task_recurrence_instance_tasks WHERE owner_id=$1 AND task_id=ANY($3::text[]) AND NOT(instance_id=ANY($4::text[]))) AS memberships,
      (SELECT count(*)::integer FROM task_recurrence_instances r WHERE r.owner_id=$1 AND NOT(r.instance_id=ANY($4::text[])) AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(r.task_ids)='array' THEN r.task_ids ELSE '[]'::jsonb END) m WHERE m=ANY($3::text[]))) AS instance_json,
      (SELECT count(*)::integer FROM task_templates t WHERE t.owner_id=$1 AND t.template_id<>$5 AND EXISTS(SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t.definition->'tasks')='array' THEN t.definition->'tasks' ELSE '[]'::jsonb END) s WHERE s->>'task_id'=ANY($3::text[]))) AS templates,
      (SELECT count(*)::integer FROM file_task_links WHERE owner_id=$1 AND task_id=ANY($3::text[]) AND active=true) AS files,
      (SELECT count(*)::integer FROM calendar_events WHERE owner_id=$1 AND task_id=ANY($3::text[]) AND archived_at IS NULL) AS events,
      (SELECT count(*)::integer FROM time_entries WHERE owner_id=$1 AND task_id=ANY($3::text[]) AND archived_at IS NULL) AS time_entries,
      (SELECT count(*)::integer FROM reminders WHERE owner_id=$1 AND task_id=ANY($3::text[]) AND state IN ('Pending','Paused')) AS reminders,
      (SELECT count(*)::integer FROM command_previews WHERE owner_id=$1 AND input->>'template_id'=$5 AND consumed_at IS NULL AND expires_at>now()) AS previews`,
      [owner, targetIds, taskIds, instanceIds, input.template_id],
    )
  ).rows[0];
  requireCondition(
    Object.values(references).every((count) => Number(count) === 0),
    "Imported identities or additional live/foreign proof references block cleanup.",
  );

  const removedMembers = await tx.query(
    "DELETE FROM task_recurrence_instance_tasks WHERE owner_id=$1 AND instance_id=ANY($2::text[]) RETURNING instance_id,task_id",
    [owner, instanceIds],
  );
  const removedInstances = await tx.query(
    "DELETE FROM task_recurrence_instances WHERE owner_id=$1 AND rule_id=$2 AND instance_id=ANY($3::text[]) RETURNING instance_id",
    [owner, input.rule_id, instanceIds],
  );
  const removedRules = await tx.query(
    "DELETE FROM task_recurrence_rules WHERE owner_id=$1 AND rule_id=$2 AND template_id=$3 AND revision=$4 AND enabled=false RETURNING rule_id",
    [owner, input.rule_id, input.template_id, input.rule_revision],
  );
  const removedTemplates = await tx.query(
    "DELETE FROM task_templates WHERE owner_id=$1 AND template_id=$2 AND revision=$3 RETURNING template_id",
    [owner, input.template_id, templateRevision],
  );
  requireCondition(
    removedMembers.rows.length === members.length &&
      removedInstances.rows.length === instances.length &&
      removedRules.rows.length === 1 &&
      removedTemplates.rows.length === 1,
    "The exact artifact deletion counts must match the guarded proof.",
  );
  return {
    before: {
      run_id: input.run_id,
      template,
      rule,
      instances,
      members,
      task_revisions: input.task_revisions,
    },
    after: {
      run_id: input.run_id,
      removed: true,
      template_id: input.template_id,
      rule_id: input.rule_id,
      instance_ids: instanceIds,
      counts: {
        templates: removedTemplates.rows.length,
        rules: removedRules.rows.length,
        instances: removedInstances.rows.length,
        memberships: removedMembers.rows.length,
      },
      retained_task_ids: taskIds,
      tasks_deleted: 0,
      graph_rows_deleted: 0,
      history_rows_deleted: 0,
    },
    version: Number(template.revision),
  };
}
