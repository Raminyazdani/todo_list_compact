import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Database } from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import {
  assertDomainGraphFingerprint,
  domainGraphFingerprint,
  reserveTaskIdentity,
  runDomainTransaction,
  simulateDomainTransaction,
  withReservedTaskIdentity,
} from "../../server/domain/ai-transaction";
import { hash } from "../../server/domain/core";
import type {
  DomainService,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

let db: Database, service: DomainService, ai: Principal;
let b: string, c: string;
const key = () => randomUUID();
const tables = [
  "owners",
  "tasks",
  "task_dependency_groups",
  "task_dependency_edges",
  "task_checklists",
  "task_checklist_items",
  "task_templates",
  "command_previews",
  "activity_events",
  "outbox",
  "idempotency_operations",
] as const;
async function counts() {
  const rows: Record<string, number> = {};
  for (const table of tables)
    rows[table] = Number(
      (
        await db.query<{ count: string }>(
          `SELECT count(*)::text count FROM ${table} WHERE owner_id=$1`,
          [ai.ownerId],
        )
      ).rows[0].count,
    );
  return rows;
}
const get = (domain: DomainService, taskId: string) =>
  domain.query("task_get", { task_id: taskId }, ai) as Promise<TaskDTO>;
const fingerprint = () => domainGraphFingerprint(db, ai.ownerId);

async function newTaskWithAllEdges(
  domain: DomainService,
  reservedId: string,
  createKey: string,
  edgeKey: string,
) {
  const created = await domain.execute(
    "task_create",
    { title: "Synthetic final report" },
    ai,
    withReservedTaskIdentity({ idempotencyKey: createKey }, ai, reservedId),
  );
  const preview = (await domain.query(
    "task_dependency_add_preview",
    {
      task_id: created.entity_id,
      operator: "ALL",
      prerequisites: [
        { task_id: b, mode: "hard" },
        { task_id: c, mode: "hard" },
      ],
    },
    ai,
  )) as PreviewDTO;
  const edges = await domain.execute(
    "task_dependency_add_commit",
    { preview_id: preview.preview_id },
    ai,
    { idempotencyKey: edgeKey },
  );
  return { created, preview, edges, task: await get(domain, reservedId) };
}

beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
  // Synthetic plan receipt table tests the caller's receipt and business commit
  // sharing one real SQL connection; no runtime schema is changed.
  await db.query(
    "CREATE TABLE synthetic_ai_receipts(plan_id text PRIMARY KEY,owner_id text NOT NULL,results jsonb NOT NULL)",
  );
});
afterAll(async () => db.close?.());
beforeEach(async () => {
  ai = {
    ownerId: "synthetic-ai-owner-" + randomUUID(),
    actorId: "synthetic-ai-actor",
    channel: "AI",
    scopes: ["admin:manage"],
  };
  b = (
    await service.execute(
      "task_create",
      { title: "Synthetic experiment" },
      ai,
      {
        idempotencyKey: key(),
      },
    )
  ).entity_id;
  c = (
    await service.execute("task_create", { title: "Synthetic approval" }, ai, {
      idempotencyKey: key(),
    })
  ).entity_id;
});

describe("trusted AI canonical transaction bridges on real isolated PostgreSQL", () => {
  it("new_task_and_two_ALL_edges_have_exact_preview_but_leave_zero_business_or_bookkeeping_rows_before_approval", async () => {
    const reserved = reserveTaskIdentity(),
      before = await counts(),
      baseline = await fingerprint();
    const simulated = await simulateDomainTransaction(db, ai, (domain) =>
      newTaskWithAllEdges(domain, reserved, key(), key()),
    );
    expect(simulated.created.entity_id).toBe(reserved);
    expect(simulated.task).toMatchObject({
      task_id: reserved,
      status: "Inbox",
      readiness: "blocked",
      due_date: null,
    });
    expect(
      simulated.task.prerequisites
        .map((edge) => edge.prerequisite_task_id)
        .sort(),
    ).toEqual([b, c].sort());
    expect(
      simulated.task.prerequisites.every(
        (edge) => edge.operator === "ALL" && edge.mode === "hard",
      ),
    ).toBe(true);
    expect(simulated.preview.revisions).toMatchObject({
      [reserved]: 1,
      [b]: 1,
      [c]: 1,
    });
    expect(await counts()).toEqual(before);
    expect(await fingerprint()).toBe(baseline);
    await expect(get(service, reserved)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
    expect(
      (
        await db.query("SELECT 1 FROM command_previews WHERE preview_id=$1", [
          simulated.preview.preview_id,
        ])
      ).rows,
    ).toEqual([]);
  });

  it("approved_new_identity_edges_and_receipt_commit_together_and_lost_ACK_replay_reads_one_result", async () => {
    const reserved = reserveTaskIdentity(),
      createKey = key(),
      edgeKey = key(),
      planId = key();
    const baseline = await fingerprint();
    const preview = await simulateDomainTransaction(db, ai, (domain) =>
      newTaskWithAllEdges(domain, reserved, createKey, edgeKey),
    );
    const execute = () =>
      runDomainTransaction(db, ai, async (domain, tx) => {
        const prior = await tx.query<{ results: { task: TaskDTO } }>(
          "SELECT results FROM synthetic_ai_receipts WHERE plan_id=$1 AND owner_id=$2 FOR UPDATE",
          [planId, ai.ownerId],
        );
        if (prior.rows[0]) return { ...prior.rows[0].results, replayed: true };
        await assertDomainGraphFingerprint(tx, ai.ownerId, baseline);
        const actual = await newTaskWithAllEdges(
          domain,
          reserved,
          createKey,
          edgeKey,
        );
        await tx.query(
          "INSERT INTO synthetic_ai_receipts VALUES($1,$2,$3::jsonb)",
          [planId, ai.ownerId, JSON.stringify(actual)],
        );
        return { ...actual, replayed: false };
      });
    const committed = await execute();
    expect(committed.task.task_id).toBe(preview.task.task_id);
    expect(
      committed.task.prerequisites
        .map((edge) => edge.prerequisite_task_id)
        .sort(),
    ).toEqual([b, c].sort());
    const beforeReplay = await counts();
    expect(await execute()).toMatchObject({
      replayed: true,
      task: { task_id: reserved },
    });
    expect(await counts()).toEqual(beforeReplay);
    expect((await counts()).tasks).toBe(3);
    expect((await counts()).task_dependency_edges).toBe(2);
    const retryCreate = await service.execute(
      "task_create",
      { title: "Synthetic final report" },
      ai,
      withReservedTaskIdentity({ idempotencyKey: createKey }, ai, reserved),
    );
    expect(retryCreate).toMatchObject({ entity_id: reserved, replayed: true });
    expect(await counts()).toEqual(beforeReplay);
  });

  it("a_later_cycle_error_rolls_back_new_task_first_edges_receipt_preview_audit_and_operation_rows", async () => {
    const reserved = reserveTaskIdentity(),
      before = await counts();
    await expect(
      runDomainTransaction(db, ai, async (domain, tx) => {
        const actual = await newTaskWithAllEdges(
          domain,
          reserved,
          key(),
          key(),
        );
        await tx.query(
          "INSERT INTO synthetic_ai_receipts VALUES($1,$2,$3::jsonb)",
          [
            "synthetic-failing-plan-" + reserved,
            ai.ownerId,
            JSON.stringify(actual),
          ],
        );
        await domain.query(
          "task_dependency_add_preview",
          { task_id: b, prerequisites: [{ task_id: reserved }] },
          ai,
        );
      }),
    ).rejects.toMatchObject({ code: "DEPENDENCY_CYCLE" });
    expect(await counts()).toEqual(before);
    expect(
      (
        await db.query(
          "SELECT 1 FROM synthetic_ai_receipts WHERE owner_id=$1",
          [ai.ownerId],
        )
      ).rows,
    ).toEqual([]);
    await expect(get(service, reserved)).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });
  });

  it("simulation_checks_deferred_owner_parent_FK_before_returning_a_successful_preview", async () => {
    const reserved = reserveTaskIdentity(),
      before = await counts();
    let returned = false;
    await expect(
      simulateDomainTransaction(db, ai, async (_domain, tx) => {
        await tx.query(
          "INSERT INTO tasks(task_id,owner_id,title,parent_task_id) VALUES($1,$2,'Synthetic invalid deferred parent',$3)",
          [reserved, ai.ownerId, "T-missing-synthetic-parent"],
        );
        returned = true;
        return { seemingly_valid: true };
      }),
    ).rejects.toThrow();
    expect(returned).toBe(true);
    expect(await counts()).toEqual(before);
  });

  it("JSON_options_and_public_input_cannot_choose_an_ID_and_capability_is_bound_to_actor_owner_channel_and_command", async () => {
    const reserved = reserveTaskIdentity();
    const fakeOptions = JSON.parse(
      JSON.stringify({
        idempotencyKey: key(),
        reservedTaskId: reserved,
        reserved_task_id: reserved,
      }),
    );
    const ordinary = await service.execute(
      "task_create",
      {
        title: "Synthetic public create",
        task_id: reserved,
        reserved_task_id: reserved,
      },
      ai,
      fakeOptions,
    );
    expect(ordinary.entity_id).not.toBe(reserved);
    const branded = withReservedTaskIdentity(
        { idempotencyKey: key() },
        ai,
        reserved,
      ),
      before = await counts();
    for (const forged of [
      { ...ai, ownerId: "synthetic-foreign-owner" },
      { ...ai, actorId: "synthetic-other-actor" },
      { ...ai, channel: "MCP" as const },
      { ...ai, channel: "UI" as const },
    ])
      await expect(
        service.execute(
          "task_create",
          { title: "Synthetic invalid reservation" },
          forged,
          branded,
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      service.execute(
        "task_update",
        { task_id: b, title: "Synthetic wrong command" },
        ai,
        branded,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(await counts()).toEqual(before);
    const copied = { ...branded, idempotencyKey: key() };
    const copyResult = await service.execute(
      "task_create",
      { title: "Synthetic copied JSON capability" },
      ai,
      copied,
    );
    expect(copyResult.entity_id).not.toBe(reserved);
    const accepted = await service.execute(
      "task_create",
      { title: "Synthetic trusted create" },
      ai,
      branded,
    );
    expect(accepted.entity_id).toBe(reserved);
    await expect(
      service.execute(
        "task_create",
        { title: "Synthetic trusted create" },
        ai,
        withReservedTaskIdentity(
          { idempotencyKey: branded.idempotencyKey },
          ai,
          reserveTaskIdentity(),
        ),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(
      service.execute(
        "task_create",
        { title: "Synthetic other intent" },
        ai,
        withReservedTaskIdentity({ idempotencyKey: key() }, ai, reserved),
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("ordinary_accepted_operation_hash_remains_wire_compatible_and_replays_without_reserved_metadata", async () => {
    const input = { title: "Synthetic old accepted operation" },
      operationKey = key();
    const accepted = await service.execute("task_create", input, ai, {
      idempotencyKey: operationKey,
    });
    // This is the pre-bridge hash shape, used by accepted backups/older clients.
    const legacyHash = hash({
      command: "task_create",
      input,
      actor: ai.actorId,
      channel: ai.channel,
      expectedRevision: null,
    });
    const stored = (
      await db.query<{ input_hash: string }>(
        "SELECT input_hash FROM idempotency_operations WHERE owner_id=$1 AND idempotency_key=$2",
        [ai.ownerId, operationKey],
      )
    ).rows[0];
    expect(stored.input_hash).toBe(legacyHash);
    const before = await counts();
    expect(
      await service.execute("task_create", input, ai, {
        idempotencyKey: operationKey,
      }),
    ).toMatchObject({ ...accepted, replayed: true });
    expect(await counts()).toEqual(before);
  });

  it("approval_fingerprint_ignores_bookkeeping_and_other_owners_but_detects_actual_checklist_and_template_mutation", async () => {
    const baseline = await fingerprint();
    await service.query(
      "task_dependency_add_preview",
      { task_id: b, prerequisites: [{ task_id: c }] },
      ai,
    );
    const foreign = { ...ai, ownerId: "synthetic-other-owner-" + key() };
    await service.execute(
      "task_create",
      { title: "Synthetic foreign mutation" },
      foreign,
      { idempotencyKey: key() },
    );
    expect(await fingerprint()).toBe(baseline);
    const list = await service.execute(
      "task_checklist_create",
      { task_id: b, title: "Synthetic grounded checklist" },
      ai,
      {
        idempotencyKey: key(),
        expectedRevision: (await get(service, b)).revision,
      },
    );
    const item = await service.execute(
      "task_checklist_item_add",
      { checklist_id: list.entity_id, title: "Synthetic item" },
      ai,
      { idempotencyKey: key(), expectedRevision: 1 },
    );
    const afterList = await fingerprint();
    expect(afterList).not.toBe(baseline);
    await service.execute(
      "task_checklist_item_check",
      { item_id: item.entity_id },
      ai,
      { idempotencyKey: key(), expectedRevision: 1 },
    );
    expect(await fingerprint()).not.toBe(afterList);
    const template = await service.execute(
      "task_template_create",
      { title: "Synthetic plan template", root_task_id: b },
      ai,
      { idempotencyKey: key() },
    );
    const templateBaseline = await fingerprint();
    await db.query(
      "UPDATE task_templates SET title='Synthetic changed template',revision=revision+1 WHERE owner_id=$1 AND template_id=$2",
      [ai.ownerId, template.entity_id],
    );
    const beforeDenied = await counts();
    await expect(
      runDomainTransaction(db, ai, async (domain, tx) => {
        await assertDomainGraphFingerprint(tx, ai.ownerId, templateBaseline);
        await newTaskWithAllEdges(domain, reserveTaskIdentity(), key(), key());
      }),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    expect(await counts()).toEqual(beforeDenied);
  });

  it("transaction_services_cannot_switch_principal_or_elevate_readonly_scopes_and_AI_blocker_guard_still_applies", async () => {
    const before = await counts();
    for (const replacement of [
      { ...ai, ownerId: "synthetic-other-owner" },
      { ...ai, actorId: "synthetic-other-actor" },
      { ...ai, channel: "UI" as const },
      { ...ai, scopes: ["admin:manage", "tasks:write"] },
    ])
      await expect(
        simulateDomainTransaction(db, ai, (domain) =>
          domain.query("task_get", { task_id: b }, replacement),
        ),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const readOnly = { ...ai, scopes: ["tasks:read"] };
    await expect(
      simulateDomainTransaction(db, readOnly, (domain) =>
        domain.execute(
          "task_create",
          { title: "Synthetic denied readonly plan" },
          readOnly,
          { idempotencyKey: key() },
        ),
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    for (const override of [false, true])
      await expect(
        simulateDomainTransaction(db, ai, async (domain) => {
          const created = await newTaskWithAllEdges(
            domain,
            reserveTaskIdentity(),
            key(),
            key(),
          );
          return domain.execute(
            "task_complete",
            {
              task_id: created.task.task_id,
              ...(override ? { override_reason: "Synthetic AI override" } : {}),
            },
            ai,
            { idempotencyKey: key(), expectedRevision: created.task.revision },
          );
        }),
      ).rejects.toMatchObject({
        code: override ? "INSUFFICIENT_PERMISSIONS" : "TASK_BLOCKED",
      });
    expect(await counts()).toEqual(before);
  });
});
