import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import { runRecurringTasks } from "../../server/domain/recurrence";
import type { Database } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  PageDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) =>
  service.execute(command, input, principal, {
    idempotencyKey: randomUUID(),
    expectedRevision: revision,
  });
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});
describe("Explicit task recurrence and restoration retry safety", () => {
  it("configured_recurring_tasks_span_berlin_dst_with_only_corresponding_instance_edges", async () => {
    const old = await exec("task_create", {
      title: "Unrelated old occurrence",
    });
    const template = await exec("task_template_create", {
      title: "Configured synthetic recurrence",
      definition: {
        tasks: [
          { task_id: "a", title: "A" },
          { task_id: "b", title: "B" },
        ],
        edges: [
          { dependent_task_id: "a", prerequisite_task_id: "b" },
          { dependent_task_id: "a", prerequisite_task_id: old.entity_id },
        ],
      },
    });
    const rule = await exec("task_recurrence_create", {
      template_id: template.entity_id,
      start_date: "2027-03-27",
      timezone: "Europe/Berlin",
      rrule: "FREQ=DAILY;COUNT=3",
    });
    const run = await db.transaction(principal.ownerId, (tx) =>
      runRecurringTasks(
        tx,
        { ...principal, channel: "system" },
        new Date("2027-03-29T12:00:00Z"),
      ),
    );
    expect(run.instances_created).toBe(3);
    const instances = (await service.query(
      "task_recurrence_instances",
      { rule_id: rule.entity_id },
      principal,
    )) as PageDTO<{ occurrence_date: string; task_ids: string[] }>;
    expect(instances.items.map((i) => i.occurrence_date)).toEqual([
      "2027-03-27",
      "2027-03-28",
      "2027-03-29",
    ]);
    const allIds = new Set<string>();
    for (const instance of instances.items) {
      expect(instance.task_ids).toHaveLength(2);
      const tasks = (await Promise.all(
        instance.task_ids.map((taskId) =>
          service.query("task_get", { task_id: taskId }, principal),
        ),
      )) as TaskDTO[];
      const dependent = tasks.find((t) => t.title === "A")!,
        prerequisite = tasks.find((t) => t.title === "B")!;
      expect(
        dependent.prerequisites.map((e) => e.prerequisite_task_id),
      ).toEqual([prerequisite.task_id]);
      expect(dependent.start_date).toBe(instance.occurrence_date);
      expect(dependent.due_date).toBeNull();
      for (const task of tasks) {
        expect(allIds.has(task.task_id)).toBe(false);
        allIds.add(task.task_id);
      }
    }
    const retry = await db.transaction(principal.ownerId, (tx) =>
      runRecurringTasks(
        tx,
        { ...principal, channel: "system" },
        new Date("2027-03-29T12:00:00Z"),
      ),
    );
    expect(retry.instances_created).toBe(0);
  });
  it("recurrence_pause_resume_is_revision_guarded_and_persists", async () => {
    const template = await exec("task_template_create", {
      title: "Template",
      definition: { tasks: [{ task_id: "a", title: "A" }] },
    });
    const rule = await exec("task_recurrence_create", {
      template_id: template.entity_id,
      start_date: "2027-01-01",
      rrule: "FREQ=MONTHLY;COUNT=2",
    });
    await exec(
      "task_recurrence_pause",
      { rule_id: rule.entity_id },
      rule.version,
    );
    const paused = await db.transaction(principal.ownerId, (tx) =>
      runRecurringTasks(
        tx,
        { ...principal, channel: "system" },
        new Date("2027-02-01T00:00:00Z"),
      ),
    );
    expect(paused.instances_created).toBe(0);
    await expect(
      exec("task_recurrence_resume", { rule_id: rule.entity_id }, rule.version),
    ).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
    const rules = (await service.query(
      "task_recurrence_list",
      {},
      principal,
    )) as PageDTO<{ rule_id: string; revision: number }>;
    await exec(
      "task_recurrence_resume",
      { rule_id: rule.entity_id },
      rules.items[0].revision,
    );
    const resumed = await db.transaction(principal.ownerId, (tx) =>
      runRecurringTasks(
        tx,
        { ...principal, channel: "system" },
        new Date("2027-02-01T00:00:00Z"),
      ),
    );
    expect(resumed.instances_created).toBe(2);
  });
  it("recurrence_rejects_unbounded_or_zero_interval_and_requires_explicit_start", async () => {
    const template = await exec("task_template_create", {
      title: "Template",
      definition: { tasks: [{ task_id: "a", title: "A" }] },
    });
    await expect(
      exec("task_recurrence_create", {
        template_id: template.entity_id,
        rrule: "FREQ=DAILY;INTERVAL=0",
        start_date: "2027-01-01",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(
      exec("task_recurrence_create", {
        template_id: template.entity_id,
        rrule: "FREQ=DAILY",
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
  it("accepted_operation_idempotency_survives_backup_restore_and_retry", async () => {
    const key = randomUUID(),
      input = { title: "Retry-safe synthetic task" };
    const original = await service.execute("task_create", input, principal, {
      idempotencyKey: key,
    });
    const backup = await service.query("backup_export", {}, principal);
    const separate = await createTestDatabase();
    try {
      const restored = createDomainService(separate);
      await restored.execute(
        "backup_restore",
        { backup, explicit_user_intent: true },
        principal,
        { idempotencyKey: randomUUID() },
      );
      const replay = await restored.execute("task_create", input, principal, {
        idempotencyKey: key,
      });
      expect(replay.replayed).toBe(true);
      expect(replay.entity_id).toBe(original.entity_id);
      expect(await restored.query("task_search", {}, principal)).toMatchObject({
        total: 1,
      });
    } finally {
      await separate.close?.();
    }
  });
});
