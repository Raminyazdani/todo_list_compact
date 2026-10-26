import {
  COMMAND_NAMES,
  DomainError,
  QUERY_NAMES,
  type CommandName,
  type CommandOptions,
  type DomainService,
  type MutationResult,
  type Principal,
  type QueryName,
} from "../../shared/contracts";
import { getDatabase, type Database, type SqlClient } from "../db/database";
import {
  audit,
  changedReadiness,
  entity,
  hash,
  id,
  json,
  object,
  requireScope,
  snapshot,
  text,
  type Input,
} from "./core";
import { legacyImport, restoreBackup } from "./migration";
import { domainQuery } from "./queries";
import { resourceCommand } from "./resources";
import { taskCommand, type Change } from "./tasks";
import { knowledgeCommand } from "./knowledge";
import { recurrenceCommand } from "./recurrence";
import { reservedTaskIdentity } from "./internal-options";
import { queryTransactionMode } from "./query-transaction-mode";
import { dailyFocusSet } from "./daily-focus";
import {
  prepareCalendarChangeReview,
  withTrustedCalendarReview,
} from "./calendar-sources";
import {
  freshCalendarChangeReview,
  type CalendarProviderSource,
} from "../integrations/calendar-provider";
import {
  deliverCalendarChanges,
  runCalendarSynchronization,
} from "./calendar-orchestration";

function resource(command: CommandName): string {
  if (command.startsWith("project_") || command.startsWith("knowledge_"))
    return "projects";
  if (command.startsWith("file_")) return "files";
  if (command.startsWith("calendar_")) return "calendar";
  if (command.startsWith("time_")) return "time";
  if (command === "legacy_import" || command === "backup_restore")
    return "admin";
  return "tasks";
}
export function createDomainService(database: Database): DomainService {
  return {
    async execute(
      command: CommandName,
      input: Input,
      principal: Principal,
      options: CommandOptions,
    ): Promise<MutationResult> {
      if (!COMMAND_NAMES.includes(command))
        throw new DomainError("UNSUPPORTED_OPERATION", "Unknown command.");
      object(input);
      if (json(input).length > 25_000_000)
        throw new DomainError("INVALID_INPUT", "Command payload too large.");
      requireScope(
        principal,
        command === "notification_mark_read" &&
          principal.scopes.includes("calendar:write")
          ? "calendar"
          : resource(command),
        true,
      );
      if (
        !options?.idempotencyKey ||
        options.idempotencyKey.length < 8 ||
        options.idempotencyKey.length > 200
      )
        throw new DomainError(
          "INVALID_INPUT",
          "A stable 8–200 character idempotency key is required.",
        );
      const reservedId = reservedTaskIdentity(options, principal, command);
      const inputHash = hash({
        command,
        input,
        actor: principal.actorId,
        channel: principal.channel,
        expectedRevision: options.expectedRevision ?? null,
        ...(reservedId === undefined ? {} : { reservedTaskId: reservedId }),
      });
      const committed = await database.transaction(
        principal.ownerId,
        async (tx) => {
          await tx.query(
            "INSERT INTO owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
            [principal.ownerId],
          );
          const replay = await tx.query<{
            input_hash: string;
            result: MutationResult;
          }>(
            "SELECT input_hash,result FROM idempotency_operations WHERE owner_id=$1 AND idempotency_key=$2",
            [principal.ownerId, options.idempotencyKey],
          );
          if (replay.rows[0]) {
            if (replay.rows[0].input_hash !== inputHash)
              throw new DomainError(
                "IDEMPOTENCY_CONFLICT",
                "Idempotency key reused with different input.",
                {},
                409,
              );
            return { ...replay.rows[0].result, replayed: true };
          }
          if (
            command === "task_dependency_waive_commit" &&
            principal.channel === "MCP"
          ) {
            if (
              typeof input.human_confirmation_id !== "string" ||
              !input.human_confirmation_id
            )
              throw new DomainError(
                "INSUFFICIENT_PERMISSIONS",
                "A human confirmation ticket is required for an MCP waiver.",
                {},
                403,
              );
            const confirmationId = input.human_confirmation_id;
            const confirmed = await tx.query(
              "UPDATE human_confirmations SET operation_key=$6 WHERE confirmation_id=$1 AND owner_id=$2 AND command=$3 AND input_hash=$4 AND actor_id=$5 AND expires_at>now() AND (operation_key IS NULL OR operation_key=$6) RETURNING confirmation_id",
              [
                confirmationId,
                principal.ownerId,
                command,
                hash({ command, preview_id: input.preview_id }),
                principal.actorId,
                options.idempotencyKey,
              ],
            );
            if (!confirmed.rows.length)
              throw new DomainError(
                "INSUFFICIENT_PERMISSIONS",
                "A matching unexpired human confirmation ticket is required for an MCP waiver.",
                {},
                403,
              );
          }
          const operationId = id("OP"),
            // Display/retention configuration never mutates the task graph.
            // Keep its owner lock, revision, audit and receipt without scanning it.
            before =
              command === "preferences_update" ||
              command === "daily_focus_set" ||
              command.startsWith("calendar_") ||
              command.startsWith("time_")
                ? null
                : await snapshot(tx, principal.ownerId);
          let change: Change;
          if (command === "legacy_import")
            change = await legacyImport(tx, input, principal);
          else if (command === "backup_restore")
            change = await restoreBackup(tx, input, principal);
          else if (
            command === "undo_last_eligible_action" ||
            command === "redo_last_eligible_action"
          ) {
            const redo = command === "redo_last_eligible_action";
            const targetTaskId =
              input.task_id === undefined ? null : text(input, "task_id");
            if (targetTaskId)
              await entity(
                tx,
                "tasks",
                "task_id",
                targetTaskId,
                principal.ownerId,
              );
            if (principal.channel === "AI")
              throw new DomainError(
                "INSUFFICIENT_PERMISSIONS",
                "Undo/redo requires explicit owner interaction.",
                {},
                403,
              );
            const rows = await tx.query<{
              event_id: string;
              entity_id: string;
              event_type: string;
              before: Input;
              after: Input;
            }>(
              redo
                ? `SELECT e.* FROM activity_events e WHERE e.owner_id=$1 AND e.actor_id=$2 AND ($3::text IS NULL OR e.entity_id=$3) AND e.event_type='undo_last_eligible_action' AND NOT EXISTS (SELECT 1 FROM activity_events redone WHERE redone.owner_id=e.owner_id AND redone.reason='Redo event '||e.event_id) ORDER BY e.occurred_at DESC LIMIT 1`
                : `SELECT e.* FROM activity_events e WHERE e.owner_id=$1 AND e.actor_id=$2 AND ($3::text IS NULL OR e.entity_id=$3) AND (e.event_type IN ('task_archive','task_restore','redo_last_eligible_action') OR (e.event_type='task_update' AND e.before->>'status'=e.after->>'status')) AND NOT EXISTS (SELECT 1 FROM activity_events undone WHERE undone.owner_id=e.owner_id AND undone.reason='Undo event '||e.event_id) ORDER BY e.occurred_at DESC LIMIT 1`,
              [principal.ownerId, principal.actorId, targetTaskId],
            );
            const last = rows.rows[0];
            if (!last?.before)
              throw new DomainError(
                "INVALID_INPUT",
                "No eligible task edit is available for undo/redo.",
              );
            const current = await entity(
              tx,
              "tasks",
              "task_id",
              last.entity_id,
              principal.ownerId,
            );
            if (Number(current.revision) !== Number(last.after.revision))
              throw new DomainError(
                "REVISION_CONFLICT",
                "The task changed after this edit; review its history before restoring fields.",
                { current },
                409,
              );
            if (
              last.event_type === "task_archive" ||
              last.event_type === "task_restore" ||
              last.before.archived_at !== last.after.archived_at
            )
              change = await taskCommand(
                tx,
                last.before.archived_at ? "task_archive" : "task_restore",
                { task_id: last.entity_id },
                principal,
                options.expectedRevision,
                operationId,
              );
            else {
              const restore: Input = { task_id: last.entity_id };
              for (const field of [
                "title",
                "notes",
                "next_action",
                "waiting_for",
                "priority",
                "category",
                "project_id",
                "due_date",
                "due_at",
                "start_date",
                "estimated_minutes",
              ])
                restore[field] = last.before[field];
              change = await taskCommand(
                tx,
                "task_update",
                restore,
                principal,
                options.expectedRevision,
                operationId,
              );
            }
            change.reason = `${redo ? "Redo" : "Undo"} event ${last.event_id}`;
          } else if (command === "daily_focus_set")
            change = await dailyFocusSet(
              tx,
              input,
              principal,
              options.expectedRevision,
            );
          else if (command.startsWith("task_recurrence_"))
            change = await recurrenceCommand(
              tx,
              command,
              input,
              principal,
              options.expectedRevision,
            );
          else if (
            command.startsWith("task_comment_") ||
            command.startsWith("task_tag_") ||
            command === "tag_create" ||
            command.startsWith("knowledge_")
          )
            change = await knowledgeCommand(
              tx,
              command,
              input,
              principal,
              options.expectedRevision,
            );
          else if (
            command.startsWith("task_") ||
            command.startsWith("subtask_")
          )
            change = await taskCommand(
              tx,
              command,
              input,
              principal,
              options.expectedRevision,
              operationId,
              reservedId,
            );
          else
            change = await resourceCommand(
              tx,
              command,
              input,
              principal,
              options.expectedRevision,
              operationId,
            );
          const after =
              before === null ? null : await snapshot(tx, principal.ownerId),
            readinessChanges =
              before && after ? changedReadiness(before, after) : [];
          const auditId = await audit(
            tx,
            principal,
            operationId,
            command,
            change.entityId,
            change.before,
            change.after,
            change.reason ?? null,
          );
          if (
            before &&
            after &&
            (command === "task_reopen" ||
              (command === "task_update" &&
                (change.before as Input)?.status === "Done" &&
                (change.after as Input)?.status !== "Done"))
          )
            await audit(
              tx,
              principal,
              operationId,
              "dependency.reopened_impact",
              change.entityId,
              { readiness: before.byId.get(change.entityId)?.readiness },
              {
                affected: readinessChanges,
                at_risk: after.tasks
                  .filter((t) => t.started_at_risk)
                  .map((t) => t.task_id),
              },
            );
          const changedFields = Object.keys(
            (change.after && typeof change.after === "object"
              ? change.after
              : {}) as Input,
          ).filter(
            (key) =>
              json((change.before as Input | null)?.[key]) !==
              json((change.after as Input)[key]),
          );
          const version = Number(
            (change.after as Input | null)?.revision ??
              after?.byId.get(change.entityId)?.revision ??
              1,
          );
          const result: MutationResult = {
            operation_id: operationId,
            audit_event_id: auditId,
            entity_id: change.entityId,
            version,
            affected_task_ids: [
              ...new Set([
                ...change.affected,
                ...readinessChanges.map((r) => r.task_id),
              ]),
            ],
            readiness_changes: readinessChanges,
            changed_fields: changedFields,
            data: change.after,
          };
          await tx.query(
            "INSERT INTO idempotency_operations(owner_id,idempotency_key,input_hash,command,result) VALUES($1,$2,$3,$4,$5::jsonb)",
            [
              principal.ownerId,
              options.idempotencyKey,
              inputHash,
              command,
              json(result),
            ],
          );
          return JSON.parse(json(result)) as MutationResult;
        },
      );
      if (command === "calendar_sync_request") {
        const sync = await runCalendarSynchronization(
          database,
          principal,
          input,
        );
        return { ...committed, data: { ...object(committed.data), sync } };
      }
      if (command === "calendar_event_change_commit") {
        const delivery = await deliverCalendarChanges(
          database,
          principal,
          committed.entity_id,
        );
        return { ...committed, data: { ...object(committed.data), delivery } };
      }
      return committed;
    },
    async query(
      operation: QueryName,
      input: Input,
      principal: Principal,
    ): Promise<unknown> {
      if (!QUERY_NAMES.includes(operation))
        throw new DomainError("UNSUPPORTED_OPERATION", "Unknown query.");
      object(input);
      if (
        operation === "time_entry_import_preview"
          ? Buffer.byteLength(json(input), "utf8") > 2_000_000
          : json(input).length > 100000
      )
        throw new DomainError("INVALID_INPUT", "Query payload too large.");
      if (!principal.ownerId || !principal.actorId)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Authentication required.",
          {},
          403,
        );
      if (
        operation === "calendar_event_change_preview" &&
        input.action !== "create"
      ) {
        input = object(JSON.parse(json(input)));
        // Finish the short owner-bound read BEFORE contacting Google. The
        // private in-process receipt is rechecked inside the stored-preview TX.
        const prepare = (tx: SqlClient) =>
          prepareCalendarChangeReview(tx, input, principal);
        const prepared = database.readTransaction
          ? await database.readTransaction(principal.ownerId, prepare)
          : await database.transaction(principal.ownerId, prepare);
        const review = await freshCalendarChangeReview(
          principal,
          prepared.source as unknown as CalendarProviderSource,
          {
            event_id: prepared.event_id,
            recurrence_scope: prepared.recurrence_scope,
            expected_instance_etag: prepared.expected_instance_etag,
            expected_master_etag: prepared.expected_master_etag,
          },
        );
        input = withTrustedCalendarReview(input, principal, prepared, review);
      }
      if (
        queryTransactionMode(operation) === "read" &&
        database.readTransaction
      )
        return database.readTransaction(principal.ownerId, (tx) =>
          domainQuery(tx, operation, input, principal),
        );
      // Stored previews need writes; pinned AI/PGlite adapters retain their
      // existing transaction semantics without opening a nested read transaction.
      return database.transaction(principal.ownerId, async (tx) => {
        await tx.query(
          "INSERT INTO owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
          [principal.ownerId],
        );
        return domainQuery(tx, operation, input, principal);
      });
    },
  };
}
export function getDomainService(): DomainService {
  return createDomainService(getDatabase());
}
