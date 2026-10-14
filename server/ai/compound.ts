import type { Database, SqlClient } from "@/server/db/database";
import {
  assertDomainGraphFingerprint,
  domainGraphFingerprint,
  reserveTaskIdentity,
  runDomainTransaction,
  simulateDomainTransaction,
  withReservedTaskIdentity,
} from "@/server/domain/ai-transaction";
import {
  DomainError,
  type CommandOptions,
  type DomainService,
  type MutationResult,
  type Principal,
  type QueryName,
} from "@/shared/contracts";
import { proposalReference, type ModelPlan } from "./policy";
import { safeReadResult } from "./reads";
import { requireAiActionScopes, requireAiScope } from "./authority";

export const AI_PREVIEWS: Partial<Record<string, QueryName>> = {
  task_dependency_add_commit: "task_dependency_add_preview",
  task_dependency_remove_commit: "task_dependency_remove_preview",
  subtask_reparent_commit: "subtask_reparent_preview",
  task_template_instantiate_commit: "task_template_instantiate_preview",
};
type Action = ModelPlan["actions"][number];
export interface AtomicPlan {
  version: 1;
  fingerprint: string;
  reserved_task_ids: Record<string, string>;
  actions: Action[];
}
export function needsAtomicProposal(actions: Action[]) {
  return actions.some(
    (action) =>
      action.local_ref !== undefined ||
      AI_PREVIEWS[action.command] !== undefined,
  );
}
function resolvedActions(actions: Action[]) {
  const aliases = new Map<string, string>(),
    reserved: Record<string, string> = {};
  function resolve(value: unknown): unknown {
    const ref = proposalReference(value);
    if (ref) {
      const id = aliases.get(ref);
      if (!id)
        throw new DomainError("INVALID_INPUT", "ارجاع محلی نامعتبر است.");
      return id;
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, resolve(item)]),
      );
    return value;
  }
  const resolved = actions.map((action, index) => {
    const input = resolve(action.input) as Record<string, unknown>;
    if (action.command === "task_create") {
      const id = reserveTaskIdentity();
      reserved[index] = id;
      if (action.local_ref) aliases.set(action.local_ref, id);
    }
    return { ...action, input };
  });
  return { actions: resolved, reserved };
}
function revisionTarget(action: Action): [string, string, unknown] | null {
  const command = action.command,
    input = action.input;
  if (command === "task_checklist_item_add")
    return ["task_checklists", "checklist_id", input.checklist_id];
  if (command.startsWith("task_checklist_item_"))
    return ["task_checklist_items", "item_id", input.item_id];
  if (command.startsWith("task_checklist_"))
    return command === "task_checklist_create"
      ? ["tasks", "task_id", input.task_id]
      : ["task_checklists", "checklist_id", input.checklist_id];
  if (["task_update", "task_complete", "task_reopen"].includes(command))
    return ["tasks", "task_id", input.task_id];
  if (command === "project_update")
    return ["projects", "project_id", input.project_id];
  if (command.startsWith("file_")) return ["files", "file_id", input.file_id];
  if (command === "calendar_update_local_event")
    return ["calendar_events", "event_id", input.event_id];
  if (command === "time_entry_update")
    return ["time_entries", "entry_id", input.entry_id];
  return null;
}
async function runActions(
  service: DomainService,
  tx: SqlClient,
  atomic: AtomicPlan,
  planId: string,
  principal: Principal,
) {
  const results: MutationResult[] = [],
    changes = [],
    touched = new Set<string>();
  for (const [index, action] of atomic.actions.entries()) {
    let input = action.input,
      expectedRevision = action.expected_revision;
    const previewName = AI_PREVIEWS[action.command];
    let preview: Record<string, unknown> | undefined;
    if (previewName) {
      preview = (await service.query(previewName, input, principal)) as Record<
        string,
        unknown
      >;
      input = { preview_id: preview.preview_id };
    } else {
      const target = revisionTarget(action);
      if (target && typeof target[2] === "string" && touched.has(target[2])) {
        const current = await tx.query<{ revision: number }>(
          `SELECT revision FROM ${target[0]} WHERE ${target[1]}=$1 AND owner_id=$2`,
          [target[2], principal.ownerId],
        );
        if (!current.rows[0])
          throw new DomainError(
            "ENTITY_NOT_FOUND",
            "هدف تغییر پیدا نشد.",
            {},
            404,
          );
        expectedRevision = Number(current.rows[0].revision);
      }
    }
    let options: CommandOptions = {
      idempotencyKey: `ai:${planId}:${index}`,
      expectedRevision,
    };
    if (atomic.reserved_task_ids[index])
      options = withReservedTaskIdentity(
        options,
        principal,
        atomic.reserved_task_ids[index],
      );
    const result = await service.execute(
      action.command,
      input,
      principal,
      options,
    );
    results.push(result);
    const changedTarget = revisionTarget(action);
    if (changedTarget && typeof changedTarget[2] === "string")
      touched.add(changedTarget[2]);
    touched.add(result.entity_id);
    for (const id of result.affected_task_ids) {
      touched.add(id);
      await service.query("task_get", { task_id: id }, principal);
    }
    const after = safeReadResult(result.data);
    const proposed = preview ? safeReadResult(preview.changes) : undefined;
    changes.push({
      command: action.command,
      entity_id: result.entity_id,
      input: action.input,
      version: result.version,
      after: after.result,
      after_truncated: after.truncated,
      readiness_changes: result.readiness_changes.slice(0, 100),
      readiness_changes_total: result.readiness_changes.length,
      readiness_changes_truncated: result.readiness_changes.length > 100,
      ...(preview
        ? {
            preview: {
              changes: proposed?.result,
              changes_truncated: proposed?.truncated,
              revisions: preview.revisions,
              warnings: preview.warnings,
            },
          }
        : {}),
    });
  }
  return { results, changes };
}
export async function prepareAtomicProposal(
  database: Database,
  plan: ModelPlan,
  planId: string,
  principal: Principal,
) {
  const aiPrincipal = { ...principal, channel: "AI" as const };
  const resolved = resolvedActions(plan.actions);
  return simulateDomainTransaction(
    database,
    aiPrincipal,
    async (service, tx) => {
      const fingerprint = await domainGraphFingerprint(tx, principal.ownerId);
      const atomic: AtomicPlan = {
        version: 1,
        fingerprint,
        reserved_task_ids: resolved.reserved,
        actions: resolved.actions,
      };
      const simulation = await runActions(
        service,
        tx,
        atomic,
        planId,
        aiPrincipal,
      );
      if (
        Buffer.byteLength(JSON.stringify(simulation.changes), "utf8") > 100000
      )
        throw new DomainError(
          "INVALID_INPUT",
          "پیش‌نمایش بزرگ‌تر از سقف مجاز است؛ درخواست را محدودتر کنید.",
        );
      return {
        atomic,
        actions: resolved.actions,
        simulation: {
          read_only: true,
          atomic: true,
          changes: simulation.changes,
        },
      };
    },
  );
}
export async function executeAtomicPlan(
  database: Database,
  planId: string,
  principal: Principal,
) {
  requireAiScope(principal);
  const aiPrincipal = { ...principal, channel: "AI" as const };
  return runDomainTransaction(database, aiPrincipal, async (service, tx) => {
    const selected = await tx.query<{
      plan: { _atomic?: AtomicPlan };
      executed_at: string | null;
      expires_at: string;
      results: MutationResult[];
    }>(
      "SELECT * FROM ai_plans WHERE plan_id=$1 AND owner_id=$2 AND actor_id=$3 FOR UPDATE",
      [planId, principal.ownerId, principal.actorId],
    );
    const row = selected.rows[0];
    if (!row)
      throw new DomainError("ENTITY_NOT_FOUND", "پیش‌نمایش پیدا نشد.", {}, 404);
    const atomic = row.plan._atomic;
    if (atomic?.version !== 1)
      throw new DomainError("INVALID_INPUT", "طرح اتمی معتبر نیست.");
    requireAiActionScopes(atomic.actions, principal);
    if (row.executed_at)
      return { plan_id: planId, results: row.results, replayed: true };
    if (new Date(row.expires_at).getTime() < Date.now())
      throw new DomainError(
        "PREVIEW_EXPIRED",
        "پیش‌نمایش منقضی شده است؛ دوباره بررسی کنید.",
      );
    await assertDomainGraphFingerprint(
      tx,
      principal.ownerId,
      atomic.fingerprint,
    );
    const { results } = await runActions(
      service,
      tx,
      atomic,
      planId,
      aiPrincipal,
    );
    await tx.query(
      "UPDATE ai_plans SET executed_at=now(),results=$2::jsonb WHERE plan_id=$1",
      [planId, JSON.stringify(results)],
    );
    return { plan_id: planId, results, verified: true };
  });
}
