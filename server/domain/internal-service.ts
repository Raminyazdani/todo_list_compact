import {
  DomainError,
  type CommandOptions,
  type DomainService,
  type MutationResult,
  type Principal,
} from "../../shared/contracts";
import { getDatabase, type Database } from "../db/database";
import { audit, hash, id, json } from "./core";
import { createDomainService } from "./service";
import {
  removeSyntheticTemplateArtifacts,
  SYNTHETIC_CLEANUP_OPERATION,
  validateSyntheticCleanupInput,
  type SyntheticTemplateCleanupInput,
} from "./proof-cleanup";
export type { SyntheticTemplateCleanupInput } from "./proof-cleanup";

export interface InternalDomainService extends DomainService {
  cleanupSyntheticTemplateArtifacts(
    input: SyntheticTemplateCleanupInput,
    principal: Principal,
    options: CommandOptions,
  ): Promise<MutationResult>;
}

/** This factory is for trusted owner operators. No public command/tool is added. */
export function createInternalDomainService(
  database: Database,
): InternalDomainService {
  return {
    ...createDomainService(database),
    async cleanupSyntheticTemplateArtifacts(value, principal, options) {
      if (
        !principal.ownerId ||
        !principal.actorId ||
        principal.channel !== "system" ||
        !principal.scopes.includes("admin:manage")
      )
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Synthetic proof cleanup requires the owner-bound trusted system operator and admin:manage.",
          {},
          403,
        );
      const input = validateSyntheticCleanupInput(value);
      if (
        !options?.idempotencyKey ||
        options.idempotencyKey.length < 8 ||
        options.idempotencyKey.length > 200 ||
        !Number.isSafeInteger(options.expectedRevision) ||
        Number(options.expectedRevision) < 1
      )
        throw new DomainError(
          "INVALID_INPUT",
          "A stable operation key and current template revision are required.",
        );
      const inputHash = hash({
        command: SYNTHETIC_CLEANUP_OPERATION,
        input,
        actor: principal.actorId,
        channel: principal.channel,
        expectedRevision: options.expectedRevision,
      });
      return database.transaction(principal.ownerId, async (tx) => {
        const replay = (
          await tx.query<{ input_hash: string; result: MutationResult }>(
            "SELECT input_hash,result FROM idempotency_operations WHERE owner_id=$1 AND idempotency_key=$2",
            [principal.ownerId, options.idempotencyKey],
          )
        ).rows[0];
        if (replay) {
          if (replay.input_hash !== inputHash)
            throw new DomainError(
              "IDEMPOTENCY_CONFLICT",
              "Idempotency key reused with different cleanup input.",
              {},
              409,
            );
          return { ...replay.result, replayed: true };
        }
        const operationId = id("OP");
        const removed = await removeSyntheticTemplateArtifacts(
          tx,
          input,
          principal,
          options.expectedRevision,
        );
        const auditId = await audit(
          tx,
          principal,
          operationId,
          SYNTHETIC_CLEANUP_OPERATION,
          input.template_id,
          removed.before,
          removed.after,
          "Remove exact synthetic proof automation metadata after verified restore and archived task cleanup.",
        );
        const result: MutationResult = {
          operation_id: operationId,
          audit_event_id: auditId,
          entity_id: input.template_id,
          version: removed.version,
          affected_task_ids: [],
          readiness_changes: [],
          changed_fields: [
            "task_templates",
            "task_recurrence_rules",
            "task_recurrence_instances",
            "task_recurrence_instance_tasks",
          ],
          data: removed.after,
        };
        await tx.query(
          "INSERT INTO idempotency_operations(owner_id,idempotency_key,input_hash,command,result) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            principal.ownerId,
            options.idempotencyKey,
            inputHash,
            SYNTHETIC_CLEANUP_OPERATION,
            json(result),
          ],
        );
        return JSON.parse(json(result)) as MutationResult;
      });
    },
  };
}

export function getInternalDomainService(): InternalDomainService {
  return createInternalDomainService(getDatabase());
}
