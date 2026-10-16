import {
  DomainError,
  type CommandOptions,
  type MutationResult,
  type Principal,
} from "../../shared/contracts";
import type { Database, SqlClient } from "../db/database";
import {
  audit,
  cleanRows,
  entity,
  hash,
  id,
  json,
  object,
  requireScope,
  text,
  type Input,
} from "./core";
import {
  calendarSources,
  decryptCalendarConfig,
  sourceDTO,
} from "./calendar-sources";

export type CalendarProviderAction =
  | "discover"
  | "sync_claim"
  | "sync_complete"
  | "mutation_claim"
  | "mutation_complete";
async function revokeCalendarSource(
  tx: SqlClient,
  owner: string,
  sourceId: string,
  code: string,
) {
  const source = (
    await tx.query<{ generation: number }>(
      "UPDATE calendar_sources SET status='revoked',writable=false,last_error=$3,generation=generation+1,lease_id=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=now() WHERE owner_id=$1 AND source_id=$2 RETURNING generation",
      [owner, sourceId, code],
    )
  ).rows[0];
  const invalidated = await tx.query(
    "UPDATE calendar_mutation_intents SET state='revoked',last_error=$3,lease_id=NULL,lease_until=NULL,next_attempt_at=NULL,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND source_id=$2 AND state IN ('pending','sending','uncertain') RETURNING intent_id",
    [owner, sourceId, code],
  );
  return {
    generation: source.generation,
    invalidated_intents: invalidated.rows.length,
  };
}
function trusted(principal: Principal) {
  requireScope(principal, "calendar", true);
  if (principal.channel !== "system")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Calendar provider receipts require trusted server orchestration.",
      {},
      403,
    );
}
async function sourceState(
  tx: SqlClient,
  owner: string,
  row: Input,
): Promise<
  Input & { config: Input; events: { external_id: string; raw: Input }[] }
> {
  return {
    ...row,
    config: decryptCalendarConfig(
      owner,
      String(row.source_id),
      row.encrypted_config,
    ),
    events: (
      await tx.query<{ external_id: string; raw: Input }>(
        "SELECT external_id,raw FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2 ORDER BY external_id",
        [owner, row.source_id],
      )
    ).rows,
  };
}
/** Internal server-only lifecycle. Never expose this object through REST or MCP. */
export function createCalendarProviderService(database: Database) {
  return {
    async state(principal: Principal) {
      trusted(principal);
      return database.transaction(principal.ownerId, async (tx) => ({
        sources: await Promise.all(
          (await calendarSources(tx, principal.ownerId)).map((row) =>
            sourceState(tx, principal.ownerId, row),
          ),
        ),
        intents: cleanRows(
          (
            await tx.query<Input>(
              "SELECT * FROM calendar_mutation_intents WHERE owner_id=$1 AND state IN ('pending','sending','uncertain') ORDER BY created_at,intent_id",
              [principal.ownerId],
            )
          ).rows,
        ),
      }));
    },
    async execute(
      action: CalendarProviderAction,
      input: Input,
      principal: Principal,
      options: CommandOptions,
    ): Promise<MutationResult> {
      trusted(principal);
      if (
        !options.idempotencyKey ||
        options.idempotencyKey.length < 8 ||
        options.idempotencyKey.length > 200
      )
        throw new DomainError(
          "INVALID_INPUT",
          "A stable provider operation key is required.",
        );
      const inputHash = hash({
        action,
        input,
        owner: principal.ownerId,
        actor: principal.actorId,
      });
      return database.transaction(principal.ownerId, async (tx) => {
        await tx.query(
          "INSERT INTO owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING",
          [principal.ownerId],
        );
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
              "Provider operation key reused with different receipt.",
              {},
              409,
            );
          const data = object(replay.result.data);
          if (data.replay_source_id && data.claimed === true) {
            const source = await entity(
              tx,
              "calendar_sources",
              "source_id",
              String(data.replay_source_id),
              principal.ownerId,
            );
            return {
              ...replay.result,
              replayed: true,
              data: {
                ...data,
                source: await sourceState(tx, principal.ownerId, source),
              },
            };
          }
          return { ...replay.result, replayed: true };
        }
        const data = await providerAction(tx, action, input, principal),
          operationId = id("OP"),
          entityId = String(
            input.source_id ?? input.intent_id ?? principal.ownerId,
          );
        // Claim data may contain private feed URL / sync cursors. Audit only the
        // lifecycle receipt, never decrypted source configuration or event bodies.
        const safe = {
          action,
          source_id: input.source_id ?? null,
          intent_id: input.intent_id ?? null,
          claimed: data.claimed ?? null,
          ignored: data.ignored ?? null,
          state: data.state ?? null,
          generation: data.generation ?? input.generation ?? null,
          receipt_hash:
            input.result || input.error
              ? hash(input.result ?? input.error)
              : null,
        };
        const auditId = await audit(
          tx,
          principal,
          operationId,
          "calendar.provider." + action,
          entityId,
          null,
          safe,
        );
        const result: MutationResult = {
          operation_id: operationId,
          audit_event_id: auditId,
          entity_id: entityId,
          version: Number(data.revision ?? 1),
          affected_task_ids: [],
          readiness_changes: [],
          changed_fields: [action],
          data,
        };
        // The internal receipt is encrypted at rest wherever it contains a
        // decrypted source. Replay reconstructs the claim from owner state.
        const persisted = {
          ...result,
          data: {
            ...data,
            ...(data.source
              ? {
                  source: null,
                  replay_source_id: object(data.source).source_id,
                }
              : {}),
          },
        };
        await tx.query(
          "INSERT INTO idempotency_operations(owner_id,idempotency_key,input_hash,command,result) VALUES($1,$2,$3,$4,$5::jsonb)",
          [
            principal.ownerId,
            options.idempotencyKey,
            inputHash,
            "calendar.provider." + action,
            json(persisted),
          ],
        );
        return JSON.parse(json(result)) as MutationResult;
      });
    },
  };
}
async function providerAction(
  tx: SqlClient,
  action: CalendarProviderAction,
  input: Input,
  principal: Principal,
): Promise<Input> {
  const owner = principal.ownerId;
  if (action === "discover") {
    if (!Array.isArray(input.sources) || input.sources.length > 1000)
      throw new DomainError(
        "INVALID_INPUT",
        "Bounded discovered sources required.",
      );
    const found: string[] = [];
    for (const item of input.sources) {
      const source = object(item),
        external = text(source, "external_calendar_id", undefined, 2000),
        sourceId =
          "CS-" + hash([owner, "google_calendar", external]).slice(0, 40);
      found.push(sourceId);
      const prior = (
        await tx.query<Input>(
          "SELECT * FROM calendar_sources WHERE owner_id=$1 AND source_id=$2",
          [owner, sourceId],
        )
      ).rows[0];
      if (prior) {
        const changed =
          prior.grant_fingerprint !== (source.grant_fingerprint ?? null) ||
          prior.status === "revoked";
        await tx.query(
          "UPDATE calendar_sources SET title=$3,timezone=$4,writable=$5,grant_fingerprint=$6,primary_calendar=$9,generation=generation+$7,checkpoint=CASE WHEN $8 THEN '{}'::jsonb ELSE checkpoint END,coverage=CASE WHEN $8 THEN '{}'::jsonb ELSE coverage END,status=CASE WHEN $8 THEN 'pending' ELSE status END,lease_id=CASE WHEN $8 THEN NULL ELSE lease_id END,lease_until=CASE WHEN $8 THEN NULL ELSE lease_until END,next_attempt_at=CASE WHEN $8 THEN NULL ELSE next_attempt_at END,updated_at=now() WHERE owner_id=$1 AND source_id=$2",
          [
            owner,
            sourceId,
            text(source, "title", "Google Calendar", 500),
            text(source, "timezone", "Europe/Berlin", 200),
            source.writable === true,
            source.grant_fingerprint ?? null,
            changed ? 1 : 0,
            changed,
            source.primary === true,
          ],
        );
      } else
        await tx.query(
          "INSERT INTO calendar_sources(source_id,owner_id,provider,external_calendar_id,title,timezone,writable,grant_fingerprint,primary_calendar) VALUES($1,$2,'google_calendar',$3,$4,$5,$6,$7,$8)",
          [
            sourceId,
            owner,
            external,
            text(source, "title", "Google Calendar", 500),
            text(source, "timezone", "Europe/Berlin", 200),
            source.writable === true,
            source.grant_fingerprint ?? null,
            source.primary === true,
          ],
        );
    }
    // A successful complete discovery authoritatively removes access, while an
    // unavailable discovery must never be passed as a synthetic empty list.
    await tx.query(
      "UPDATE calendar_sources SET status='revoked',writable=false,generation=generation+1,lease_id=NULL,lease_until=NULL,last_error='GOOGLE_SOURCE_ACCESS_REMOVED' WHERE owner_id=$1 AND provider='google_calendar' AND enabled=true AND NOT(source_id=ANY($2::text[])) AND status<>'revoked'",
      [owner, found],
    );
    return { source_ids: found };
  }
  if (action === "sync_claim" || action === "sync_complete") {
    const source = await entity(
      tx,
      "calendar_sources",
      "source_id",
      text(input, "source_id"),
      owner,
    );
    if (action === "sync_claim") {
      if (
        !source.enabled ||
        source.status === "revoked" ||
        source.status === "disconnected" ||
        (source.lease_until &&
          Date.parse(String(source.lease_until)) > Date.now()) ||
        (source.next_attempt_at &&
          Date.parse(String(source.next_attempt_at)) > Date.now())
      )
        return { claimed: false };
      const leaseId = id("LEASE");
      await tx.query(
        "UPDATE calendar_sources SET lease_id=$3,lease_until=now()+interval '120 seconds',status='syncing',updated_at=now() WHERE owner_id=$1 AND source_id=$2",
        [owner, source.source_id, leaseId],
      );
      return {
        claimed: true,
        lease_id: leaseId,
        generation: source.generation,
        cache_revision: source.cache_revision,
        source: await sourceState(tx, owner, source),
      };
    }
    if (
      !source.enabled ||
      source.status === "revoked" ||
      source.status === "disconnected" ||
      source.lease_id !== input.lease_id ||
      source.generation !== input.generation
    )
      return { ignored: true, reason: "STALE_PROVIDER_COMPLETION" };
    if (source.cache_revision !== input.cache_revision) {
      await tx.query(
        "UPDATE calendar_sources SET lease_id=NULL,lease_until=NULL,status=CASE WHEN last_success_at IS NULL THEN 'pending' ELSE 'connected' END,requested_at=now() WHERE owner_id=$1 AND source_id=$2",
        [owner, source.source_id],
      );
      return { ignored: true, reason: "OUTBOUND_CHANGE_AFTER_SYNC_CLAIM" };
    }
    if (input.error) {
      const error = object(input.error),
        revoked = error.revoked === true,
        code = text(error, "code", "SOURCE_READ_FAILED", 100),
        retry = Math.max(
          5,
          Math.min(86400, Number(error.retry_after_seconds) || 300),
        );
      if (revoked)
        return {
          state: "revoked",
          ...(await revokeCalendarSource(
            tx,
            owner,
            String(source.source_id),
            code.replace(/[^A-Z0-9_]/g, "_"),
          )),
        };
      await tx.query(
        "UPDATE calendar_sources SET status=$3,last_error=$4,lease_id=NULL,lease_until=NULL,next_attempt_at=$5,updated_at=now() WHERE owner_id=$1 AND source_id=$2",
        [
          owner,
          source.source_id,
          revoked ? "revoked" : "error",
          code.replace(/[^A-Z0-9_]/g, "_"),
          new Date(Date.now() + retry * 1000).toISOString(),
        ],
      );
      return { state: revoked ? "revoked" : "error" };
    }
    const result = object(input.result);
    if (
      result.complete !== true ||
      !Array.isArray(result.events) ||
      !Array.isArray(result.deleted_ids) ||
      result.events.length > 100000 ||
      result.deleted_ids.length > 100000
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Only a complete bounded provider snapshot can advance a checkpoint.",
      );
    if (result.replace === true)
      await tx.query(
        "DELETE FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2",
        [owner, source.source_id],
      );
    if (result.deleted_ids.length)
      await tx.query(
        "DELETE FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2 AND external_id=ANY($3::text[])",
        [owner, source.source_id, result.deleted_ids],
      );
    const events = result.events.map((item) => {
      const event = object(item);
      return {
        external_id: text(event, "external_id", undefined, 2000),
        raw: object(event.raw),
      };
    });
    if (events.length)
      await tx.query(
        "INSERT INTO calendar_external_events(owner_id,source_id,external_id,raw) SELECT $1,$2,e.external_id,e.raw FROM jsonb_to_recordset($3::jsonb) AS e(external_id text,raw jsonb) ON CONFLICT(owner_id,source_id,external_id) DO UPDATE SET raw=EXCLUDED.raw,updated_at=now()",
        [owner, source.source_id, json(events)],
      );
    await tx.query(
      "UPDATE calendar_sources SET status='connected',last_success_at=now(),last_error=NULL,checkpoint=$3::jsonb,coverage=$4::jsonb,timezone=$5,lease_id=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=now() WHERE owner_id=$1 AND source_id=$2",
      [
        owner,
        source.source_id,
        json(result.checkpoint ?? {}),
        json(result.coverage ?? { complete: true }),
        result.timezone ?? source.timezone,
      ],
    );
    return {
      state: "connected",
      count: events.length,
      source: sourceDTO({
        ...source,
        status: "connected",
        last_success_at: new Date().toISOString(),
      }),
    };
  }
  const intent = await entity(
      tx,
      "calendar_mutation_intents",
      "intent_id",
      text(input, "intent_id"),
      owner,
    ),
    source = await entity(
      tx,
      "calendar_sources",
      "source_id",
      String(intent.source_id),
      owner,
    );
  if (action === "mutation_claim") {
    if (
      !source.enabled ||
      source.status === "revoked" ||
      source.generation !== intent.source_generation
    ) {
      await tx.query(
        "UPDATE calendar_mutation_intents SET state='revoked',last_error='SOURCE_CHANGED',revision=revision+1 WHERE owner_id=$1 AND intent_id=$2",
        [owner, intent.intent_id],
      );
      return { claimed: false, state: "revoked" };
    }
    if (
      !["pending", "uncertain", "sending"].includes(String(intent.state)) ||
      (intent.lease_until &&
        Date.parse(String(intent.lease_until)) > Date.now()) ||
      (intent.next_attempt_at &&
        Date.parse(String(intent.next_attempt_at)) > Date.now())
    )
      return { claimed: false };
    const leaseId = id("LEASE"),
      priorState =
        intent.state === "sending" ? "uncertain" : String(intent.state);
    await tx.query(
      "UPDATE calendar_mutation_intents SET state='sending',lease_id=$3,lease_until=now()+interval '120 seconds',revision=revision+1,updated_at=now() WHERE owner_id=$1 AND intent_id=$2",
      [owner, intent.intent_id, leaseId],
    );
    return {
      claimed: true,
      lease_id: leaseId,
      generation: source.generation,
      source: await sourceState(tx, owner, source),
      intent: {
        ...intent,
        operation_id: intent.intent_id,
        event_id: intent.external_event_id,
        state: priorState,
      },
    };
  }
  if (
    source.generation !== input.generation ||
    intent.lease_id !== input.lease_id ||
    !source.enabled ||
    source.status === "revoked" ||
    source.status === "disconnected"
  )
    return { ignored: true, reason: "STALE_PROVIDER_COMPLETION" };
  const result = object(input.result),
    state = String(result.state ?? result.status);
  if (
    !["confirmed", "uncertain", "conflict", "revoked", "error"].includes(state)
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A valid provider delivery result is required.",
    );
  await tx.query(
    "UPDATE calendar_mutation_intents SET state=$3,result=$4::jsonb,last_error=$5,lease_id=NULL,lease_until=NULL,next_attempt_at=$6,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND intent_id=$2",
    [
      owner,
      intent.intent_id,
      state,
      json(result),
      result.code ?? result.error ?? null,
      state === "uncertain"
        ? new Date(
            Date.now() +
              Math.max(5, Number(result.retry_after_seconds) || 300) * 1000,
          ).toISOString()
        : null,
    ],
  );
  if (state === "revoked")
    await revokeCalendarSource(
      tx,
      owner,
      String(source.source_id),
      "GOOGLE_GRANT_REVOKED",
    );
  if (state === "confirmed") {
    await tx.query(
      "UPDATE calendar_sources SET cache_revision=cache_revision+1 WHERE owner_id=$1 AND source_id=$2",
      [owner, source.source_id],
    );
    if (intent.action === "delete") {
      const targetId = String(result.external_id ?? intent.external_event_id);
      if (intent.master_event_id && intent.recurrence_scope === "instance") {
        const suffix = targetId.slice(
            String(intent.master_event_id).length + 1,
          ),
          date =
            suffix.slice(0, 4) +
            "-" +
            suffix.slice(4, 6) +
            "-" +
            suffix.slice(6, 8),
          original =
            suffix.length === 8
              ? { date }
              : {
                  dateTime:
                    date +
                    "T" +
                    suffix.slice(9, 11) +
                    ":" +
                    suffix.slice(11, 13) +
                    ":" +
                    suffix.slice(13, 15) +
                    "Z",
                },
          raw = {
            id: targetId,
            status: "cancelled",
            recurringEventId: intent.master_event_id,
            originalStartTime: original,
          };
        await tx.query(
          "INSERT INTO calendar_external_events(owner_id,source_id,external_id,raw) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,source_id,external_id) DO UPDATE SET raw=EXCLUDED.raw,updated_at=now()",
          [owner, source.source_id, targetId, json(raw)],
        );
      } else
        await tx.query(
          "DELETE FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2 AND (external_id=$3 OR raw->>'recurringEventId'=$3)",
          [owner, source.source_id, targetId],
        );
    } else if (result.event || result.raw) {
      const raw = object(result.event ?? result.raw);
      await tx.query(
        "INSERT INTO calendar_external_events(owner_id,source_id,external_id,raw) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,source_id,external_id) DO UPDATE SET raw=EXCLUDED.raw,updated_at=now()",
        [
          owner,
          source.source_id,
          raw.id ?? intent.external_event_id,
          json(raw),
        ],
      );
    }
  }
  return { state, intent_id: intent.intent_id };
}
