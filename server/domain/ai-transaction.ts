import {
  DomainError,
  type DomainService,
  type Principal,
} from "../../shared/contracts";
import type { Database, SqlClient } from "../db/database";
import { hash } from "./core";
import { createDomainService } from "./service";
export {
  reserveTaskIdentity,
  withReservedTaskIdentity,
} from "./internal-options";

type Action<T> = (service: DomainService, tx: SqlClient) => Promise<T>;

function requireAiPrincipal(principal: Principal) {
  if (!principal.ownerId || !principal.actorId || principal.channel !== "AI")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "An authenticated AI principal is required for the internal plan transaction.",
      {},
      403,
    );
}

function transactionService(
  tx: SqlClient,
  principal: Principal,
): DomainService {
  // Nested canonical calls reuse this owner-locked connection, without nested BEGIN.
  const nested: Database = {
    query: tx.query,
    async transaction(ownerId, action) {
      if (ownerId !== principal.ownerId)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "A plan transaction cannot switch owners.",
          {},
          403,
        );
      return action(tx);
    },
  };
  const canonical = createDomainService(nested);
  const verify = (actor: Principal) => {
    if (
      actor.ownerId !== principal.ownerId ||
      actor.actorId !== principal.actorId ||
      actor.channel !== "AI" ||
      actor.scopes.length !== principal.scopes.length ||
      actor.scopes.some((scope, index) => scope !== principal.scopes[index])
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "The plan transaction principal cannot be replaced or elevated.",
        {},
        403,
      );
  };
  return {
    execute(command, input, actor, options) {
      verify(actor);
      return canonical.execute(command, input, actor, options);
    },
    query(operation, input, actor) {
      verify(actor);
      return canonical.query(operation, input, actor);
    },
  };
}

/** Internal only: a confirmed plan and its receipt can share one canonical commit. */
export async function runDomainTransaction<T>(
  database: Database,
  principal: Principal,
  action: Action<T>,
): Promise<T> {
  requireAiPrincipal(principal);
  const pinned = { ...principal, scopes: [...principal.scopes] };
  return database.transaction(pinned.ownerId, (tx) =>
    action(transactionService(tx, pinned), tx),
  );
}

/** Internal only: return real canonical effects after rolling every SQL row back. */
export async function simulateDomainTransaction<T>(
  database: Database,
  principal: Principal,
  action: Action<T>,
): Promise<T> {
  const rollback = new Error("INTERNAL_AI_SIMULATION_ROLLBACK");
  let result!: T;
  try {
    await runDomainTransaction(database, principal, async (service, tx) => {
      result = await action(service, tx);
      // A deferred FK failure must invalidate the preview, just as a real commit.
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
    return result;
  }
  throw new DomainError(
    "DATABASE_UNAVAILABLE",
    "The simulation transaction did not roll back.",
    {},
    503,
  );
}

/** Conservative approval baseline: excludes plan/budget/audit/preview bookkeeping. */
export async function domainGraphFingerprint(
  tx: SqlClient,
  ownerId: string,
): Promise<string> {
  if (!ownerId)
    throw new DomainError(
      "INVALID_INPUT",
      "An owner-bound baseline is required.",
    );
  const result = await tx.query<{ graph: unknown }>(
    `SELECT jsonb_build_object(
      'tasks',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY task_id),'[]'::jsonb) FROM tasks t WHERE owner_id=$1),
      'projects',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY project_id),'[]'::jsonb) FROM projects t WHERE owner_id=$1),
      'groups',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY group_id),'[]'::jsonb) FROM task_dependency_groups t WHERE owner_id=$1),
      'edges',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY edge_id),'[]'::jsonb) FROM task_dependency_edges t WHERE owner_id=$1),
      'checklists',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY checklist_id),'[]'::jsonb) FROM task_checklists t WHERE owner_id=$1),
      'items',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY item_id),'[]'::jsonb) FROM task_checklist_items t WHERE owner_id=$1),
      'templates',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY template_id),'[]'::jsonb) FROM task_templates t WHERE owner_id=$1),
      'milestones',(SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY milestone_id),'[]'::jsonb) FROM project_milestones t WHERE owner_id=$1)
    ) graph`,
    [ownerId],
  );
  return hash(result.rows[0].graph);
}

export async function assertDomainGraphFingerprint(
  tx: SqlClient,
  ownerId: string,
  expected: string,
): Promise<void> {
  if ((await domainGraphFingerprint(tx, ownerId)) !== expected)
    throw new DomainError(
      "REVISION_CONFLICT",
      "The graph or template changed after the plan preview; review a new plan.",
      {},
      409,
    );
}
