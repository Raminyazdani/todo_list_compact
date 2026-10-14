import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database, SqlClient } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  PageDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { COMMAND_NAMES, DomainError } from "../../shared/contracts";
import { createDomainService } from "../../server/domain/service";
import {
  createInternalDomainService,
  type SyntheticTemplateCleanupInput,
} from "../../server/domain/internal-service";
import { SYNTHETIC_CLEANUP_OPERATION } from "../../server/domain/proof-cleanup";
import {
  recordHash,
  importPrepared,
  prepareMigration,
  reconcileMigration,
} from "../../scripts/migration/core";
import { syntheticSnapshot } from "../migration/fixtures";
import { createTestDatabase } from "./database";

let db: Database,
  service: DomainService,
  principal: Principal,
  operator: Principal;
let input: SyntheticTemplateCleanupInput, templateRevision: number;
let prepared: ReturnType<typeof prepareMigration>, templateCreateKey: string;
const kept = [
  "owners",
  "projects",
  "tasks",
  "task_dependency_groups",
  "task_dependency_edges",
  "task_checklists",
  "task_checklist_items",
  "files",
  "file_versions",
  "file_task_links",
  "preferences",
  "source_mappings",
  "migration_batches",
];
const all = [
  ...kept,
  "task_templates",
  "task_recurrence_rules",
  "task_recurrence_instances",
  "task_recurrence_instance_tasks",
  "activity_events",
  "idempotency_operations",
  "command_previews",
  "outbox",
];
const operationKey = () => randomUUID();
const execute = (
  command: CommandName,
  value: Record<string, unknown>,
  expectedRevision?: number,
  idempotencyKey: string = operationKey(),
) =>
  service.execute(command, value, principal, {
    idempotencyKey,
    expectedRevision,
  });
const get = (id: string) =>
  service.query("task_get", { task_id: id }, principal) as Promise<TaskDTO>;
const copy = () => structuredClone(input);
async function hashes(tables = all) {
  const result: Record<string, string> = {};
  for (const table of tables) {
    const rows = (
      await db.query(`SELECT * FROM ${table} WHERE owner_id=$1`, [
        principal.ownerId,
      ])
    ).rows;
    result[table] = recordHash(rows.map(recordHash).sort());
  }
  return result;
}
function cleanup(
  value = input,
  revision = templateRevision,
  key: string = operationKey(),
  actor = operator,
  database = db,
) {
  return createInternalDomainService(
    database,
  ).cleanupSyntheticTemplateArtifacts(value, actor, {
    idempotencyKey: key,
    expectedRevision: revision,
  });
}
async function unchangedRejection(
  action: () => Promise<unknown>,
  code: string,
) {
  const before = await hashes();
  await expect(action()).rejects.toMatchObject({ code });
  expect(await hashes()).toEqual(before);
}

beforeEach(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
  principal = {
    ownerId: "synthetic-cleanup-owner",
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  operator = {
    ...principal,
    actorId: "synthetic-verified-coordinator",
    channel: "system",
  };
  prepared = prepareMigration(syntheticSnapshot());
  await importPrepared(service, prepared, { ...principal, channel: "import" });
  const runId = randomUUID(),
    prefix = "SYNTHETIC GRAPH PROOF " + runId.slice(0, 8) + " ",
    marker = "synthetic-production-graph-proof:" + runId;
  const taskIds: string[] = [];
  async function task(role: string, parent?: string) {
    const result = await execute(parent ? "subtask_create" : "task_create", {
      title: prefix + role,
      source_reference: marker,
      ...(parent ? { parent_task_id: parent } : {}),
    });
    taskIds.push(result.entity_id);
    return result.entity_id;
  }
  const root = await task("C template root"),
    parent = await task("P parent", root),
    sibling = await task("Q sibling", root),
    grandchild = await task("G grandchild", parent);
  const list = await execute(
    "task_checklist_create",
    { task_id: root, title: prefix + "Review" },
    (await get(root)).revision,
  );
  const item = await execute(
    "task_checklist_item_add",
    { checklist_id: list.entity_id, title: prefix + "Promoted child" },
    list.version,
  );
  const promoted = await execute(
    "task_checklist_item_promote",
    { item_id: item.entity_id, original: "keep_reference" },
    1,
  );
  taskIds.push(promoted.entity_id);
  const edge = (await service.query(
    "task_dependency_add_preview",
    { task_id: sibling, prerequisites: [{ task_id: grandchild }] },
    principal,
  )) as { preview_id: string };
  await execute("task_dependency_add_commit", { preview_id: edge.preview_id });
  for (const role of ["A", "B", "D", "X", "E", "F"]) await task(role);
  templateCreateKey = operationKey();
  const template = await execute(
    "task_template_create",
    { title: prefix + "nested template", root_task_id: root },
    undefined,
    templateCreateKey,
  );
  templateRevision = template.version;
  const preview = (await service.query(
    "task_template_instantiate_preview",
    { template_id: template.entity_id, preserve_external_links: false },
    principal,
  )) as { preview_id: string };
  const clone = await execute("task_template_instantiate_commit", {
    preview_id: preview.preview_id,
  });
  taskIds.push(...clone.affected_task_ids);
  const rule = await execute("task_recurrence_create", {
    template_id: template.entity_id,
    title: prefix + "finite recurrence",
    start_date: "2020-01-01",
    timezone: "Europe/Berlin",
    rrule: "FREQ=DAILY;COUNT=1",
  });
  const daily = await service.execute("system_daily_run", {}, operator, {
    idempotencyKey: operationKey(),
  });
  const delivered = (
    daily.data as {
      recurring: { task_ids: string[]; instances_created: number };
    }
  ).recurring;
  expect(delivered.instances_created).toBe(1);
  taskIds.push(...delivered.task_ids);
  expect(new Set(taskIds).size).toBe(21);
  const rules = (await service.query(
    "task_recurrence_list",
    { limit: 200 },
    principal,
  )) as PageDTO<Record<string, unknown>>;
  const currentRule = rules.items.find(
    (row) => row.rule_id === rule.entity_id,
  )!;
  const paused = await execute(
    "task_recurrence_pause",
    { rule_id: rule.entity_id },
    Number(currentRule.revision),
  );
  const instances = (await service.query(
    "task_recurrence_instances",
    { rule_id: rule.entity_id, limit: 200 },
    principal,
  )) as PageDTO<{
    instance_id: string;
    occurrence_date: string;
    task_ids: string[];
  }>;
  const revisions: Record<string, number> = {};
  for (const taskId of taskIds) {
    const archived = await execute(
      "task_archive",
      { task_id: taskId },
      (await get(taskId)).revision,
    );
    revisions[taskId] = archived.version;
  }
  input = {
    run_id: runId,
    template_id: template.entity_id,
    rule_id: rule.entity_id,
    rule_revision: paused.version,
    instances: instances.items.map((row) => ({
      instance_id: row.instance_id,
      occurrence_date: row.occurrence_date,
      task_ids: row.task_ids,
    })),
    task_revisions: revisions,
  };
}, 30000);
afterEach(async () => db.close?.());

describe("server-only exact synthetic proof metadata cleanup on real isolated PostgreSQL", () => {
  it("removes_only_guarded_metadata_keeps_all_source_tasks_graph_history_and_old_receipts_then_replays_one_audit", async () => {
    const before = await hashes(kept),
      key = operationKey(),
      oldAudit = (
        await db.query("SELECT * FROM activity_events WHERE owner_id=$1", [
          principal.ownerId,
        ])
      ).rows,
      oldReceipts = (
        await db.query(
          "SELECT * FROM idempotency_operations WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows;
    const result = await cleanup(input, templateRevision, key);
    expect(result.data).toMatchObject({
      removed: true,
      counts: { templates: 1, rules: 1, instances: 1, memberships: 5 },
      tasks_deleted: 0,
      graph_rows_deleted: 0,
      history_rows_deleted: 0,
    });
    expect(await hashes(kept)).toEqual(before);
    expect(
      (
        (await service.query(
          "task_template_list",
          {},
          principal,
        )) as PageDTO<unknown>
      ).total,
    ).toBe(0);
    expect(
      (
        (await service.query(
          "task_recurrence_list",
          {},
          principal,
        )) as PageDTO<unknown>
      ).total,
    ).toBe(0);
    const audit = (
      await db.query<Record<string, unknown>>(
        "SELECT * FROM activity_events WHERE event_id=$1",
        [result.audit_event_id],
      )
    ).rows[0];
    expect(audit).toMatchObject({
      event_type: SYNTHETIC_CLEANUP_OPERATION,
      actor_id: operator.actorId,
      channel: "system",
      entity_id: input.template_id,
    });
    expect(audit.before).toMatchObject({
      template: { template_id: input.template_id },
      rule: { rule_id: input.rule_id },
      task_revisions: input.task_revisions,
    });
    const currentAudit = (
      await db.query("SELECT * FROM activity_events WHERE owner_id=$1", [
        principal.ownerId,
      ])
    ).rows;
    const currentReceipts = (
      await db.query("SELECT * FROM idempotency_operations WHERE owner_id=$1", [
        principal.ownerId,
      ])
    ).rows;
    expect(currentAudit).toHaveLength(oldAudit.length + 1);
    expect(currentReceipts).toHaveLength(oldReceipts.length + 1);
    for (const row of oldAudit)
      expect(currentAudit.map(recordHash)).toContain(recordHash(row));
    for (const row of oldReceipts)
      expect(currentReceipts.map(recordHash)).toContain(recordHash(row));
    const after = await hashes();
    expect(await cleanup(input, templateRevision, key)).toMatchObject({
      ...result,
      replayed: true,
    });
    expect(await hashes()).toEqual(after);
    const oldCreate = await execute(
      "task_template_create",
      {
        title:
          "SYNTHETIC GRAPH PROOF " +
          input.run_id.slice(0, 8) +
          " nested template",
        root_task_id: String(
          (
            audit.before as {
              template: {
                definition: {
                  tasks: { task_id: string; parent_task_id: string | null }[];
                };
              };
            }
          ).template.definition.tasks.find((task) => !task.parent_task_id)!
            .task_id,
        ),
      },
      undefined,
      templateCreateKey,
    );
    expect(oldCreate).toMatchObject({
      entity_id: input.template_id,
      replayed: true,
    });
    expect(await hashes()).toEqual(after);
    expect(
      (await reconcileMigration(db, principal.ownerId, prepared)).pass,
    ).toBe(true);
  });

  it("is_not_a_public_command_and_denies_UI_MCP_AI_readonly_and_foreign_owners_without_mutation", async () => {
    expect(COMMAND_NAMES).not.toContain(SYNTHETIC_CLEANUP_OPERATION);
    await unchangedRejection(
      () =>
        service.execute(
          SYNTHETIC_CLEANUP_OPERATION as CommandName,
          {},
          principal,
          { idempotencyKey: operationKey() },
        ),
      "UNSUPPORTED_OPERATION",
    );
    for (const actor of [
      { ...operator, channel: "UI" as const },
      { ...operator, channel: "MCP" as const },
      { ...operator, channel: "AI" as const },
      { ...operator, scopes: ["tasks:write"] },
      { ...operator, actorId: "" },
    ])
      await unchangedRejection(
        () => cleanup(input, templateRevision, operationKey(), actor),
        "INSUFFICIENT_PERMISSIONS",
      );
    await unchangedRejection(
      () =>
        cleanup(input, templateRevision, operationKey(), {
          ...operator,
          ownerId: "synthetic-foreign-owner",
        }),
      "ENTITY_NOT_FOUND",
    );
  });

  it("strict_input_and_stale_template_rule_or_task_revision_fail_before_metadata_deletion", async () => {
    await unchangedRejection(
      () =>
        cleanup({
          ...input,
          owner_id: principal.ownerId,
        } as SyntheticTemplateCleanupInput),
      "INVALID_INPUT",
    );
    const omitted = copy();
    delete omitted.task_revisions[Object.keys(omitted.task_revisions)[0]];
    await unchangedRejection(() => cleanup(omitted), "INVALID_INPUT");
    await unchangedRejection(
      () => cleanup(input, templateRevision + 1),
      "REVISION_CONFLICT",
    );
    await unchangedRejection(
      () => cleanup({ ...input, rule_revision: input.rule_revision + 1 }),
      "REVISION_CONFLICT",
    );
    const stale = copy();
    stale.task_revisions[Object.keys(stale.task_revisions)[0]]++;
    await unchangedRejection(() => cleanup(stale), "REVISION_CONFLICT");
    const duplicate = copy();
    duplicate.instances.push(duplicate.instances[0]);
    await unchangedRejection(() => cleanup(duplicate), "INVALID_INPUT");
    const wrongRun = copy();
    wrongRun.run_id = input.run_id.slice(0, 8) + "-" + randomUUID().slice(9);
    await unchangedRejection(() => cleanup(wrongRun), "INVALID_INPUT");
  });

  it("requires_all_tasks_archived_and_rule_paused_and_checks_current_privileges_even_on_accepted_retry", async () => {
    const taskId = Object.keys(input.task_revisions)[0];
    const restored = await execute(
      "task_restore",
      { task_id: taskId },
      input.task_revisions[taskId],
    );
    input.task_revisions[taskId] = restored.version;
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    const archived = await execute(
      "task_archive",
      { task_id: taskId },
      restored.version,
    );
    input.task_revisions[taskId] = archived.version;
    const resumed = await execute(
      "task_recurrence_resume",
      { rule_id: input.rule_id },
      input.rule_revision,
    );
    input.rule_revision = resumed.version;
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    const paused = await execute(
      "task_recurrence_pause",
      { rule_id: input.rule_id },
      resumed.version,
    );
    input.rule_revision = paused.version;
    const key = operationKey();
    await cleanup(input, templateRevision, key);
    await unchangedRejection(
      () =>
        cleanup(input, templateRevision, key, {
          ...operator,
          scopes: ["tasks:write"],
        }),
      "INSUFFICIENT_PERMISSIONS",
    );
    await unchangedRejection(
      () =>
        cleanup(
          { ...input, rule_revision: input.rule_revision + 1 },
          templateRevision,
          key,
        ),
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("rejects_additional_rules_instances_membership_corruption_or_cloned_tasks_outside_the_private_proof", async () => {
    const extraRule = await execute("task_recurrence_create", {
      template_id: input.template_id,
      title: "Unrelated real synthetic configuration",
      start_date: "2028-01-01",
      rrule: "FREQ=DAILY;COUNT=1",
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "DELETE FROM task_recurrence_rules WHERE owner_id=$1 AND rule_id=$2",
      [principal.ownerId, extraRule.entity_id],
    );
    const original = input.instances[0],
      extraId = "RI-synthetic-extra";
    await db.query(
      "INSERT INTO task_recurrence_instances(instance_id,owner_id,rule_id,occurrence_date,task_ids) VALUES($1,$2,$3,'2020-01-02',$4::jsonb)",
      [
        extraId,
        principal.ownerId,
        input.rule_id,
        JSON.stringify(original.task_ids),
      ],
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "DELETE FROM task_recurrence_instances WHERE owner_id=$1 AND instance_id=$2",
      [principal.ownerId, extraId],
    );
    await db.query(
      "DELETE FROM task_recurrence_instance_tasks WHERE owner_id=$1 AND instance_id=$2 AND task_id=$3",
      [principal.ownerId, original.instance_id, original.task_ids[0]],
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "INSERT INTO task_recurrence_instance_tasks VALUES($1,$2,$3)",
      [original.instance_id, principal.ownerId, original.task_ids[0]],
    );
    const extraClone = await execute("task_create", {
      title:
        "SYNTHETIC GRAPH PROOF " + input.run_id.slice(0, 8) + " extra clone",
      legacy_metadata: { template_id: input.template_id },
    });
    await execute(
      "task_archive",
      { task_id: extraClone.entity_id },
      extraClone.version,
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
  });

  it("preserves_imported_mappings_and_rejects_outside_hierarchy_edges_templates_and_live_owner_references", async () => {
    const selected = Object.keys(input.task_revisions)[0],
      originalSource = String(prepared.tables.Tasks[0].task_id);
    await db.query(
      "INSERT INTO source_mappings(owner_id,source_kind,source_id,destination_id,batch_id,source_hash) VALUES($1,'SyntheticProof','synthetic-claimed-import',$2,$3,'synthetic')",
      [principal.ownerId, selected, prepared.batchId],
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "DELETE FROM source_mappings WHERE owner_id=$1 AND source_id='synthetic-claimed-import'",
      [principal.ownerId],
    );
    await db.query(
      "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id) VALUES('synthetic-outside-group',$1,$2)",
      [principal.ownerId, originalSource],
    );
    await db.query(
      "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id) VALUES('synthetic-outside-edge',$1,'synthetic-outside-group',$2)",
      [principal.ownerId, selected],
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "DELETE FROM task_dependency_edges WHERE edge_id='synthetic-outside-edge'",
    );
    await db.query(
      "DELETE FROM task_dependency_groups WHERE group_id='synthetic-outside-group'",
    );
    const outside = await execute("subtask_create", {
      title: "Real synthetic outside child",
      parent_task_id: selected,
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    // Native fault fixture removes the extra parent relation without touching any
    // production data; public task_update intentionally has no parent bypass.
    await db.query(
      "UPDATE tasks SET parent_task_id=NULL WHERE owner_id=$1 AND task_id=$2",
      [principal.ownerId, outside.entity_id],
    );
    await execute("task_template_create", {
      title: "Unrelated retained owner template",
      definition: {
        tasks: [{ task_id: selected, title: "Copied historical step" }],
      },
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
  });

  it("checks_instance_provenance_and_live_previews_with_full_rollback_on_late_SQL_failure_then_exact_retry", async () => {
    const preview = (await service.query(
      "task_template_instantiate_preview",
      { template_id: input.template_id },
      principal,
    )) as { preview_id: string };
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "UPDATE command_previews SET expires_at=now()-interval '1 second' WHERE owner_id=$1 AND preview_id=$2",
      [principal.ownerId, preview.preview_id],
    );
    const memberId = input.instances[0].task_ids[0];
    await db.query(
      'UPDATE tasks SET legacy_metadata=legacy_metadata||\'{"recurrence_rule_id":"RR-synthetic-corrupted"}\'::jsonb WHERE owner_id=$1 AND task_id=$2',
      [principal.ownerId, memberId],
    );
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await db.query(
      "UPDATE tasks SET legacy_metadata=legacy_metadata||jsonb_build_object('recurrence_rule_id',$3::text) WHERE owner_id=$1 AND task_id=$2",
      [principal.ownerId, memberId, input.rule_id],
    );
    const failing: Database = {
      query: db.query,
      transaction: (owner, action) =>
        db.transaction(owner, (tx) => {
          const wrapped: SqlClient = {
            query: (sql, params) => {
              if (sql.startsWith("DELETE FROM task_recurrence_rules"))
                throw new DomainError(
                  "DATABASE_UNAVAILABLE",
                  "Synthetic injected late SQL failure",
                  {},
                  503,
                );
              return tx.query(sql, params);
            },
          };
          return action(wrapped);
        }),
    };
    const key = operationKey();
    await unchangedRejection(
      () => cleanup(input, templateRevision, key, operator, failing),
      "DATABASE_UNAVAILABLE",
    );
    expect((await cleanup(input, templateRevision, key)).data).toMatchObject({
      removed: true,
    });
    const after = await hashes();
    expect(await cleanup(input, templateRevision, key)).toMatchObject({
      replayed: true,
    });
    expect(await hashes()).toEqual(after);
  });

  it("refuses_live_file_event_time_and_reminder_references_but_retains_their_closed_history", async () => {
    const selected = Object.keys(input.task_revisions)[0];
    const fileId = String(prepared.tables.Files[0].file_record_id);
    const link = await execute("file_link_to_task", {
      file_id: fileId,
      task_id: selected,
      purpose: "Reference",
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await execute(
      "file_unlink_from_task",
      { link_id: link.entity_id },
      link.version,
    );
    const event = await execute("calendar_create_local_event", {
      title: "Retained synthetic owner appointment",
      task_id: selected,
      starts_at: "2028-01-01T10:00:00Z",
      ends_at: "2028-01-01T11:00:00Z",
      timezone: "Europe/Berlin",
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await execute(
      "calendar_delete_local_event",
      { event_id: event.entity_id },
      event.version,
    );
    const entry = await execute("time_entry_create", {
      employer: "Synthetic employer",
      task_id: selected,
      starts_at: "2028-01-01T11:00:00Z",
      ends_at: "2028-01-01T12:00:00Z",
      description: "Retained synthetic interval",
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await execute(
      "time_entry_archive",
      { entry_id: entry.entity_id },
      entry.version,
    );
    const reminder = await execute("reminder_create", {
      task_id: selected,
      remind_at: "2028-01-01T09:00:00Z",
    });
    await unchangedRejection(() => cleanup(), "INVALID_INPUT");
    await execute(
      "reminder_cancel",
      { reminder_id: reminder.entity_id },
      reminder.version,
    );
    const retained = await hashes([
      ...kept,
      "calendar_events",
      "time_entries",
      "reminders",
    ]);
    await cleanup();
    expect(
      await hashes([...kept, "calendar_events", "time_entries", "reminders"]),
    ).toEqual(retained);
    expect(
      (await reconcileMigration(db, principal.ownerId, prepared)).pass,
    ).toBe(true);
  });
});
