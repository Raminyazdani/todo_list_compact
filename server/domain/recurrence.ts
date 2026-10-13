import * as RRulePackage from "rrule";
const RRule = (RRulePackage.RRule ??
  Reflect.get(RRulePackage, "default")?.RRule) as typeof RRulePackage.RRule;
import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  cleanRows,
  date,
  entity,
  guard,
  hash,
  id,
  json,
  text,
  timezone,
  type Input,
} from "./core";
import { instantiateTemplate, type Change } from "./tasks";

function nextOccurrence(
  rrule: string,
  startDate: string,
  afterDate?: string,
): string | null {
  let options: Partial<ConstructorParameters<typeof RRule>[0]>;
  try {
    options = RRule.parseString(rrule);
  } catch {
    throw new DomainError("INVALID_INPUT", "Invalid recurrence RRULE.");
  }
  if (
    !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(
      rrule,
    ) ||
    rrule.length > 1000
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Supported recurrence frequencies are DAILY/WEEKLY/MONTHLY/YEARLY.",
    );
  if (
    options?.interval !== undefined &&
    (!Number.isInteger(options.interval) ||
      options.interval < 1 ||
      options.interval > 365)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Recurrence interval must be a positive bounded integer.",
    );
  if (
    options?.count !== undefined &&
    options.count !== null &&
    (!Number.isInteger(options.count) ||
      options.count < 1 ||
      options.count > 10000)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Recurrence count must be between1 and10000.",
    );
  const rule = new RRule({
    ...options,
    dtstart: new Date(startDate + "T00:00:00Z"),
  });
  const from = new Date((afterDate ?? startDate) + "T00:00:00Z"),
    next = rule.after(from, !afterDate);
  return next ? next.toISOString().slice(0, 10) : null;
}
export async function recurrenceCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
): Promise<Change> {
  if (command === "task_recurrence_create") {
    const templateId = text(input, "template_id");
    await entity(
      tx,
      "task_templates",
      "template_id",
      templateId,
      principal.ownerId,
    );
    const start = date(input, "start_date");
    if (!start)
      throw new DomainError(
        "INVALID_INPUT",
        "An explicit recurrence start_date is required.",
      );
    const zone = timezone(input),
      rrule = text(input, "rrule"),
      next = nextOccurrence(rrule, start),
      ruleId = id("RR");
    if (!next)
      throw new DomainError(
        "INVALID_INPUT",
        "The rule has no valid occurrences.",
      );
    await tx.query(
      "INSERT INTO task_recurrence_rules(rule_id,owner_id,title,template_id,start_date,timezone,rrule,next_occurrence_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        ruleId,
        principal.ownerId,
        text(input, "title", "Recurring tasks"),
        templateId,
        start,
        zone,
        rrule,
        next,
      ],
    );
    return {
      entityId: ruleId,
      before: null,
      after: await entity(
        tx,
        "task_recurrence_rules",
        "rule_id",
        ruleId,
        principal.ownerId,
      ),
      affected: [],
    };
  }
  const ruleId = text(input, "rule_id"),
    before = await entity(
      tx,
      "task_recurrence_rules",
      "rule_id",
      ruleId,
      principal.ownerId,
    );
  guard(before, revision);
  await tx.query(
    "UPDATE task_recurrence_rules SET enabled=$3,revision=revision+1 WHERE rule_id=$1 AND owner_id=$2",
    [ruleId, principal.ownerId, command === "task_recurrence_resume"],
  );
  return {
    entityId: ruleId,
    before,
    after: await entity(
      tx,
      "task_recurrence_rules",
      "rule_id",
      ruleId,
      principal.ownerId,
    ),
    affected: [],
  };
}
export async function runRecurringTasks(
  tx: SqlClient,
  principal: Principal,
  at = new Date(),
  operationId = id("OP"),
) {
  const rows = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM task_recurrence_rules WHERE owner_id=$1 AND enabled=true AND next_occurrence_date IS NOT NULL ORDER BY next_occurrence_date,rule_id LIMIT 100",
        [principal.ownerId],
      )
    ).rows,
  );
  const instances: string[] = [],
    taskIds: string[] = [];
  let skipped = 0,
    budgetExhausted = false;
  for (const row of rows) {
    if (instances.length >= 30 || taskIds.length >= 1000) {
      budgetExhausted = true;
      break;
    }
    const today = new Intl.DateTimeFormat("sv-SE", {
      timeZone: String(row.timezone),
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
    let occurrence = String(row.next_occurrence_date).slice(0, 10);
    let createdForRule = 0;
    // A bounded catch-up preserves explicitly configured missed dates without
    // guessing new dependencies. The next daily/manual run resumes remaining work.
    while (
      occurrence &&
      occurrence <= today &&
      createdForRule < 30 &&
      instances.length < 30 &&
      taskIds.length < 1000
    ) {
      const instanceId = `RI-${hash({ owner: principal.ownerId, rule: row.rule_id, occurrence }).slice(0, 32)}`,
        prior = await tx.query(
          "SELECT instance_id FROM task_recurrence_instances WHERE owner_id=$1 AND rule_id=$2 AND occurrence_date=$3",
          [principal.ownerId, row.rule_id, occurrence],
        );
      if (prior.rows.length) {
        skipped++;
      } else {
        const template = await entity(
          tx,
          "task_templates",
          "template_id",
          String(row.template_id),
          principal.ownerId,
        );
        const definition = template.definition as Input;
        if (
          Array.isArray(definition.tasks) &&
          taskIds.length + definition.tasks.length > 1000
        ) {
          budgetExhausted = true;
          break;
        }
        const cloned = await instantiateTemplate(
          tx,
          {
            template_id: row.template_id,
            definition: template.definition,
            instance_id: instanceId,
            preserve_external_links: false,
          },
          principal,
          operationId,
        );
        const ids = cloned.affected;
        await tx.query(
          "INSERT INTO task_recurrence_instances(instance_id,owner_id,rule_id,occurrence_date,task_ids) VALUES($1,$2,$3,$4,$5::jsonb)",
          [instanceId, principal.ownerId, row.rule_id, occurrence, json(ids)],
        );
        for (const taskId of ids) {
          await tx.query(
            "INSERT INTO task_recurrence_instance_tasks(instance_id,owner_id,task_id) VALUES($1,$2,$3)",
            [instanceId, principal.ownerId, taskId],
          );
          await tx.query(
            "UPDATE tasks SET start_date=$3,legacy_metadata=legacy_metadata||$4::jsonb WHERE task_id=$1 AND owner_id=$2",
            [
              taskId,
              principal.ownerId,
              occurrence,
              json({
                recurrence_rule_id: row.rule_id,
                occurrence_date: occurrence,
              }),
            ],
          );
        }
        instances.push(instanceId);
        taskIds.push(...ids);
      }
      createdForRule++;
      const next = nextOccurrence(
        String(row.rrule),
        String(row.start_date).slice(0, 10),
        occurrence,
      );
      await tx.query(
        "UPDATE task_recurrence_rules SET next_occurrence_date=$3,revision=revision+1 WHERE rule_id=$1 AND owner_id=$2",
        [row.rule_id, principal.ownerId, next],
      );
      if (!next) break;
      occurrence = next;
    }
  }
  return {
    instances_created: instances.length,
    instance_ids: instances,
    task_ids: taskIds,
    already_existing: skipped,
    run_limit_reached:
      budgetExhausted || instances.length >= 30 || taskIds.length >= 1000,
  };
}
