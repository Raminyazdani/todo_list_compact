import { DomainError, type Principal } from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  expandCalendarSource,
  type CalendarProviderSource,
} from "../integrations/calendar-provider";
import { calendarSources, sourceDTO } from "./calendar-sources";
import {
  cleanRows,
  number,
  object,
  requireScope,
  text,
  type Input,
} from "./core";

// Foreground synchronization runs every five minutes. Allow one cycle to finish
// before treating a healthy, in-flight source as stale.
const CALENDAR_STALE_AFTER_MS = 10 * 60_000;
/** Avoid repeated provider requests when focus and visibility events arrive together. */
const CALENDAR_SYNC_INTERVAL_MS = 4.5 * 60_000;
function sourceFresh(source: { status?: unknown; last_success_at?: unknown }) {
  const age = Date.now() - Date.parse(String(source.last_success_at));
  return (
    (source.status === "connected" || source.status === "syncing") &&
    !!source.last_success_at &&
    Number.isFinite(age) &&
    age >= 0 &&
    age <= CALENDAR_STALE_AFTER_MS
  );
}
export function sourceRecentlySynchronized(source: {
  status?: unknown;
  last_success_at?: unknown;
  coverage?: unknown;
}) {
  const age = Date.now() - Date.parse(String(source.last_success_at));
  const coverage = source.coverage;
  return (
    source.status === "connected" &&
    !!coverage &&
    typeof coverage === "object" &&
    !Array.isArray(coverage) &&
    Reflect.get(coverage, "complete") === true &&
    !!source.last_success_at &&
    Number.isFinite(age) &&
    age >= 0 &&
    age < CALENDAR_SYNC_INTERVAL_MS
  );
}

function selectedSourceIds(input: Input): string[] | null {
  if (input.source_ids === undefined) return null;
  if (
    !Array.isArray(input.source_ids) ||
    input.source_ids.length > 100 ||
    input.source_ids.some(
      (value) => typeof value !== "string" || value.length > 2000,
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A bounded calendar source ID list is required.",
    );
  return input.source_ids;
}

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
  const requested = selectedSourceIds(input);
  const rows = await calendarSources(tx, principal.ownerId),
    selected = requested
      ? requested
      : input.calendar_id
        ? [input.calendar_id]
        : null,
    sources = rows.filter(
      (row) =>
        row.enabled &&
        (!selected ||
          selected.includes(String(row.source_id)) ||
          selected.includes(String(row.external_calendar_id)) ||
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
      stale = !sourceFresh(source),
      complete = object(source.coverage ?? {}).complete === true;
    if (source.status === "revoked" || source.status === "disconnected") {
      warnings.push(id + ":" + String(source.last_error ?? "ACCESS_REVOKED"));
      coverage.push({ source_id: id, complete: false, stale: true });
      continue;
    }
    if (stale)
      warnings.push(
        id +
          ":" +
          String(
            source.last_error ??
              (source.status === "syncing"
                ? "SOURCE_SYNC_IN_PROGRESS"
                : source.status === "pending"
                  ? "SOURCE_NOT_SYNCED"
                  : "SOURCE_STALE"),
          ),
      );
    if (!complete) warnings.push(id + ":SOURCE_COVERAGE_INCOMPLETE");
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
        complete,
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
    const requested = selectedSourceIds(input),
      items = (await calendarSources(tx, principal.ownerId))
        .filter(
          (source) =>
            !requested || requested.includes(String(source.source_id)),
        )
        .map((source) => {
          const nextAttempt = Date.parse(String(source.next_attempt_at));
          return {
            ...sourceDTO(source),
            fresh: sourceFresh(source),
            next_attempt_at: Number.isFinite(nextAttempt)
              ? new Date(nextAttempt).toISOString()
              : null,
          };
        }),
      unavailable = requested
        ? requested.filter(
            (sourceId) =>
              !items.some((source) => source.source_id === sourceId),
          )
        : [];
    return {
      items,
      total: items.length,
      next_cursor: null,
      unavailable_source_count: unavailable.length,
      source_warnings:
        unavailable.length > 0 ? ["SELECTED_SOURCE_UNAVAILABLE"] : [],
      complete:
        unavailable.length === 0 &&
        items
          .filter((source) => source.enabled)
          .every(
            (source) =>
              source.status !== "revoked" &&
              source.status !== "disconnected" &&
              source.coverage.complete === true,
          ),
      fresh:
        unavailable.length === 0 &&
        items.filter((source) => source.enabled).every(sourceFresh),
      status: items.some((source) => source.status === "syncing")
        ? "syncing"
        : "idle",
    };
  }
  if (operation === "calendar_operation_status") {
    const limit = input.limit === undefined ? 50 : number(input, "limit"),
      operationId =
        input.operation_id === undefined ? null : text(input, "operation_id"),
      cursor = input.cursor === undefined ? null : text(input, "cursor");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200)
      throw new DomainError(
        "INVALID_INPUT",
        "limit must be between 1 and 200.",
      );
    if (operationId && cursor)
      throw new DomainError(
        "INVALID_INPUT",
        "A cursor cannot be combined with an exact calendar operation ID.",
      );
    let cursorId: string | null = null;
    let cursorCreatedAt: string | null = null;
    if (cursor) {
      if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512)
        throw new DomainError(
          "INVALID_INPUT",
          "Invalid calendar operation cursor.",
        );
      cursorId = Buffer.from(cursor, "base64url").toString("utf8");
      if (
        !cursorId ||
        cursorId.length > 200 ||
        Buffer.from(cursorId).toString("base64url") !== cursor
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Invalid calendar operation cursor.",
        );
      const anchor = (
        await tx.query<{ created_at: string }>(
          "SELECT created_at::text AS created_at FROM calendar_mutation_intents WHERE owner_id=$1 AND intent_id=$2",
          [principal.ownerId, cursorId],
        )
      ).rows[0];
      if (!anchor)
        throw new DomainError(
          "INVALID_INPUT",
          "Calendar operation cursor no longer exists; refresh the list.",
        );
      cursorCreatedAt = anchor.created_at;
    }
    const rows = cleanRows(
        (
          await tx.query<Input>(
            "SELECT intent_id,intent_id AS operation_id,source_id,external_event_id,action,state,last_error,payload,recurrence_scope,etag,master_event_id,expected_master_etag,revision,created_at,updated_at FROM calendar_mutation_intents WHERE owner_id=$1 AND ($2::text IS NULL OR intent_id=$2) AND ($3::timestamptz IS NULL OR (created_at,intent_id)<($3::timestamptz,$4::text)) ORDER BY created_at DESC,intent_id DESC LIMIT $5",
            [
              principal.ownerId,
              operationId,
              cursorCreatedAt,
              cursorId,
              operationId ? 1 : limit + 1,
            ],
          )
        ).rows,
      ),
      items = rows.slice(0, limit);
    return {
      items,
      next_cursor:
        rows.length > limit
          ? Buffer.from(String(items[items.length - 1].intent_id)).toString(
              "base64url",
            )
          : null,
    };
  }
  return null;
}
