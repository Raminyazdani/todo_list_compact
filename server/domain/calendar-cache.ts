import { DomainError, type Principal } from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  expandCalendarSource,
  type CalendarProviderSource,
} from "../integrations/calendar-provider";
import { calendarSources, sourceDTO } from "./calendar-sources";
import { cleanRows, object, requireScope, type Input } from "./core";

export async function cachedCalendarStatus(
  tx: SqlClient,
  principal: Principal,
) {
  const allowed =
    principal.scopes.includes("calendar:read") ||
    principal.scopes.includes("admin:manage");
  const rows = allowed ? await calendarSources(tx, principal.ownerId) : [],
    sources = rows.map(sourceDTO);
  return {
    connected: sources.some(
      (source) => source.enabled && source.status === "connected",
    ),
    state: sources.some(
      (source) => source.enabled && source.status === "connected",
    )
      ? "Connected"
      : sources.some(
            (source) =>
              source.enabled && ["error", "revoked"].includes(source.status),
          )
        ? "Source read failed"
        : "Not configured",
    sources,
  };
}
export async function cachedCalendarEvents(
  tx: SqlClient,
  principal: Principal,
  input: Input,
  from: string,
  to: string,
) {
  if (
    input.source_ids !== undefined &&
    (!Array.isArray(input.source_ids) ||
      input.source_ids.length > 100 ||
      input.source_ids.some(
        (value) => typeof value !== "string" || value.length > 2000,
      ))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A bounded calendar source ID list is required.",
    );
  const rows = await calendarSources(tx, principal.ownerId),
    selected = Array.isArray(input.source_ids)
      ? input.source_ids
      : input.calendar_id
        ? [input.calendar_id]
        : null,
    sources = rows.filter(
      (row) =>
        row.enabled &&
        (!selected ||
          selected.includes(row.source_id) ||
          selected.includes(row.external_calendar_id) ||
          (selected.includes("ical") && row.provider === "ical")),
    ),
    events: Input[] = [],
    warnings: string[] = [],
    coverage: Input[] = [];
  if (selected)
    for (const requested of selected) {
      if (
        requested !== "local" &&
        !sources.some(
          (source) =>
            source.source_id === requested ||
            source.external_calendar_id === requested ||
            (requested === "ical" && source.provider === "ical"),
        )
      ) {
        warnings.push("SELECTED_SOURCE_UNAVAILABLE");
        coverage.push({
          source_id: null,
          complete: false,
          stale: true,
          unavailable: true,
        });
      }
    }
  for (const source of sources) {
    const id = String(source.source_id),
      lastSuccess = source.last_success_at
        ? Date.parse(String(source.last_success_at))
        : 0,
      stale =
        source.status !== "connected" || Date.now() - lastSuccess > 5 * 60000;
    if (source.status === "revoked" || source.status === "disconnected") {
      warnings.push(id + ":ACCESS_REVOKED");
      coverage.push({ source_id: id, complete: false });
      continue;
    }
    if (stale)
      warnings.push(id + ":" + String(source.last_error ?? "SOURCE_STALE"));
    try {
      const cached = (
        await tx.query<{ external_id: string; raw: Input }>(
          "SELECT external_id,raw FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2 ORDER BY external_id",
          [principal.ownerId, id],
        )
      ).rows;
      const expanded = expandCalendarSource(
        source as unknown as CalendarProviderSource,
        cached,
        from,
        to,
      );
      events.push(
        ...expanded.map((event) => ({
          ...event,
          sync_state: stale ? "stale" : "synced",
        })),
      );
      coverage.push({
        source_id: id,
        complete: object(source.coverage ?? {}).complete === true,
        stale,
        last_success_at: source.last_success_at ?? null,
      });
    } catch {
      warnings.push(id + ":CACHE_EXPANSION_FAILED");
      coverage.push({ source_id: id, complete: false, stale: true });
    }
  }
  const intents = cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM calendar_mutation_intents WHERE owner_id=$1 AND state IN ('pending','sending','uncertain') ORDER BY created_at,intent_id",
        [principal.ownerId],
      )
    ).rows,
  );
  for (const intent of intents) {
    if (
      !sources.some(
        (source) =>
          source.source_id === intent.source_id && source.status !== "revoked",
      )
    )
      continue;
    const index = events.findIndex(
      (event) =>
        event.source_id === intent.source_id &&
        event.external_id === intent.external_event_id,
    );
    if (intent.action === "delete") {
      if (index >= 0) events.splice(index, 1);
      continue;
    }
    const payload = object(intent.payload);
    if (
      Date.parse(String(payload.starts_at)) >= Date.parse(to) ||
      Date.parse(String(payload.ends_at)) <= Date.parse(from)
    )
      continue;
    const event: Input = {
      ...(index >= 0 ? events[index] : {}),
      ...payload,
      event_id:
        index >= 0 ? events[index].event_id : "PENDING-" + intent.intent_id,
      occurrence_key: "PENDING-" + intent.intent_id,
      source_id: intent.source_id,
      external_id: intent.external_event_id,
      provider: "google_calendar",
      sync_state: intent.state,
      can_edit: false,
      source_read_only: true,
      task_id: null,
      notes: payload.notes ?? "",
      revision: intent.revision,
    };
    if (index >= 0) events.splice(index, 1, event);
    else events.push(event);
  }
  return {
    events,
    warnings,
    source_coverage: coverage,
    complete: coverage.every((source) => source.complete === true),
    fresh: coverage.every((source) => source.stale !== true),
  };
}
export async function cachedCalendarAuxiliaryQuery(
  tx: SqlClient,
  operation: string,
  input: Input,
  principal: Principal,
) {
  requireScope(principal, "calendar");
  if (operation === "calendar_sync_status") {
    const items = (await calendarSources(tx, principal.ownerId)).map(sourceDTO);
    return {
      items,
      total: items.length,
      next_cursor: null,
      complete: items
        .filter((source) => source.enabled)
        .every(
          (source) =>
            source.status !== "revoked" &&
            source.status !== "disconnected" &&
            source.coverage.complete === true,
        ),
      fresh: items
        .filter((source) => source.enabled)
        .every(
          (source) =>
            source.status === "connected" &&
            !!source.last_success_at &&
            Date.now() - Date.parse(source.last_success_at) <= 5 * 60000,
        ),
      status: items.some((source) => source.status === "syncing")
        ? "syncing"
        : "idle",
    };
  }
  if (operation === "calendar_operation_status") {
    return {
      items: cleanRows(
        (
          await tx.query<Input>(
            "SELECT intent_id,intent_id AS operation_id,source_id,external_event_id,action,state,last_error,payload,recurrence_scope,etag,master_event_id,expected_master_etag,revision,created_at,updated_at FROM calendar_mutation_intents WHERE owner_id=$1 AND ($2::text IS NULL OR intent_id=$2) ORDER BY created_at DESC LIMIT 200",
            [principal.ownerId, input.operation_id ?? null],
          )
        ).rows,
      ),
      next_cursor: null,
    };
  }
  return null;
}
