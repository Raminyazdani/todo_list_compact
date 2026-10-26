import type { Principal } from "../../shared/contracts";
import type { Database } from "../db/database";
import {
  calendarProviderError,
  discoverGoogleCalendars,
  executeGoogleCalendarChange,
  syncCalendarSource,
  type CalendarChangeIntent,
  type CalendarProviderSource,
} from "../integrations/calendar-provider";
import { createCalendarProviderService } from "./calendar-provider-service";
import { sourceRecentlySynchronized } from "./calendar-cache";
import { id, object, type Input } from "./core";

const foregroundSyncs = new Map<string, Promise<Input>>();

/** Provider I/O is deliberately called only AFTER the canonical transaction. */
export async function runCalendarSynchronization(
  database: Database,
  principal: Principal,
  input: Input = {},
) {
  if (input.force === true)
    return runCalendarSynchronizationOnce(database, principal, input);
  // In-process coalescing avoids duplicate discovery requests from simultaneous
  // foreground listeners. Durable source leases still protect other instances.
  const key = JSON.stringify([
    principal.ownerId,
    principal.actorId,
    principal.channel,
    [...(Array.isArray(input.source_ids) ? input.source_ids : [])].sort(),
  ]);
  const existing = foregroundSyncs.get(key);
  if (existing) return existing;
  const run = runCalendarSynchronizationOnce(database, principal, input);
  foregroundSyncs.set(key, run);
  try {
    return await run;
  } finally {
    if (foregroundSyncs.get(key) === run) foregroundSyncs.delete(key);
  }
}

async function runCalendarSynchronizationOnce(
  database: Database,
  principal: Principal,
  input: Input,
) {
  const provider = createCalendarProviderService(database),
    trusted: Principal = { ...principal, channel: "system" },
    warnings: string[] = [];
  const known = (
      await database.query<{
        source_id: string;
        provider: string;
        status: string;
        last_error: string | null;
        next_attempt_at: string | null;
        last_success_at: string | null;
        coverage: unknown;
      }>(
        "SELECT source_id,provider,status,last_error,next_attempt_at,last_success_at,coverage FROM calendar_sources WHERE owner_id=$1 AND enabled=true",
        [principal.ownerId],
      )
    ).rows,
    requestedIds = Array.isArray(input.source_ids) ? input.source_ids : null,
    selectedKnown = requestedIds
      ? known.filter((source) => requestedIds.includes(source.source_id))
      : known;
  if (input.force !== true) {
    if (
      selectedKnown.length > 0 &&
      selectedKnown.every(sourceRecentlySynchronized) &&
      (!requestedIds || selectedKnown.length === requestedIds.length)
    ) {
      await deliverCalendarChanges(database, principal);
      return {
        sources: selectedKnown.map((source) => ({
          source_id: source.source_id,
          state: "deferred",
          reason: "RECENTLY_SYNCED",
        })),
        warnings,
      };
    }
  }
  const selectedGoogle = selectedKnown.filter(
      (source) => source.provider === "google_calendar",
    ),
    requestedKnownSourcesOnly =
      !requestedIds || selectedKnown.length === requestedIds.length,
    providerBackoff =
      selectedGoogle.length > 0 &&
      requestedKnownSourcesOnly &&
      selectedGoogle.every(
        (source) =>
          ["SOURCE_RATE_LIMITED", "SOURCE_RETRY_AFTER"].includes(
            source.last_error ?? "",
          ) &&
          !!source.next_attempt_at &&
          Date.parse(String(source.next_attempt_at)) > Date.now(),
      ),
    icalOnlySelection =
      !!requestedIds &&
      requestedKnownSourcesOnly &&
      selectedKnown.length > 0 &&
      selectedGoogle.length === 0;
  if (providerBackoff)
    warnings.push(
      ...new Set(selectedGoogle.map((source) => String(source.last_error))),
    );
  let discoveryError: ReturnType<typeof calendarProviderError> | null = null;
  if (!providerBackoff && !icalOnlySelection) {
    try {
      const sources = await discoverGoogleCalendars(principal);
      await provider.execute("discover", { sources }, trusted, {
        idempotencyKey: id("discover"),
      });
    } catch (error) {
      discoveryError = calendarProviderError(error);
      warnings.push(discoveryError.code);
    }
  }
  const state = await provider.state(trusted),
    selected = Array.isArray(input.source_ids) ? input.source_ids : null,
    sources = state.sources.filter(
      (source) =>
        source.enabled && (!selected || selected.includes(source.source_id)),
    );
  const results: Input[] = [];
  let index = 0;
  const worker = async () => {
    while (index < sources.length) {
      const source = sources[index++],
        sourceId = String(source.source_id);
      const claim = object(
        (
          await provider.execute(
            "sync_claim",
            { source_id: sourceId, force: input.force === true },
            trusted,
            { idempotencyKey: id("claim") },
          )
        ).data,
      );
      if (!claim.claimed) {
        results.push({
          source_id: sourceId,
          state: claim.state ?? "deferred",
          reason: claim.reason ?? null,
        });
        continue;
      }
      const finish: Input = {
        source_id: sourceId,
        lease_id: claim.lease_id,
        generation: claim.generation,
        cache_revision: claim.cache_revision,
      };
      try {
        if (discoveryError && source.provider === "google_calendar")
          finish.error = discoveryError;
        else
          finish.result = await syncCalendarSource(
            principal,
            object(claim.source) as unknown as CalendarProviderSource,
          );
      } catch (error) {
        finish.error = calendarProviderError(error);
      }
      const completed = await provider.execute(
        "sync_complete",
        finish,
        trusted,
        { idempotencyKey: id("receipt") },
      );
      results.push({ source_id: sourceId, ...object(completed.data) });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, sources.length) }, worker),
  );
  await deliverCalendarChanges(database, principal);
  return {
    sources: results.map((result) => ({
      source_id: result.source_id,
      state: result.state ?? "deferred",
      ignored: result.ignored ?? false,
      ...(result.reason ? { reason: result.reason } : {}),
    })),
    warnings,
  };
}
export async function deliverCalendarChanges(
  database: Database,
  principal: Principal,
  intentId?: string,
) {
  const provider = createCalendarProviderService(database),
    trusted: Principal = { ...principal, channel: "system" },
    state = await provider.state(trusted),
    results: Input[] = [];
  for (const intent of state.intents.filter(
    (value) => !intentId || value.intent_id === intentId,
  )) {
    const claim = object(
      (
        await provider.execute(
          "mutation_claim",
          { intent_id: intent.intent_id },
          trusted,
          { idempotencyKey: id("claim") },
        )
      ).data,
    );
    if (!claim.claimed) continue;
    let result: unknown;
    try {
      result = await executeGoogleCalendarChange(
        principal,
        object(claim.source) as unknown as CalendarProviderSource,
        object(claim.intent) as unknown as CalendarChangeIntent,
      );
    } catch {
      result = { status: "uncertain", error: "PROVIDER_RESULT_UNKNOWN" };
    }
    const completed = await provider.execute(
      "mutation_complete",
      {
        intent_id: intent.intent_id,
        lease_id: claim.lease_id,
        generation: claim.generation,
        result,
      },
      trusted,
      { idempotencyKey: id("receipt") },
    );
    results.push(object(completed.data));
  }
  return results;
}
