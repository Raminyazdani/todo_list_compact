import { createHash } from "node:crypto";
import ICAL from "ical.js";
import { getAuth } from "../auth/config";
import { getAuthPool } from "../auth/db";
import {
  DomainError,
  type EventDTO,
  type Principal,
} from "../../shared/contracts";
import {
  instantToLocalDate,
  instantToLocalDateTime,
  zonedLocalToInstant,
} from "../../shared/datetime";
import { GoogleCalendarClient, normalizeGoogleEvent } from "./google";
import { fetchIcalFeedConditional, IcalFeedError } from "./ical-fetch";
import { parseIcal } from "./calendar";

export const GOOGLE_CALENDAR_READ_SCOPE =
  "https://www.googleapis.com/auth/calendar.readonly";
export const GOOGLE_CALENDAR_WRITE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events.owned";
export interface CalendarProviderSource {
  source_id: string;
  provider: "google_calendar" | "ical";
  external_calendar_id: string;
  title: string;
  timezone: string;
  writable: boolean;
  primary?: boolean;
  grant_fingerprint?: string;
  config?: { url?: string; allowed_hosts?: string[] };
  checkpoint?: {
    sync_token?: string;
    etag?: string;
    last_modified?: string;
    feed_text?: string;
  };
  events?: Array<{ external_id: string; raw: Record<string, unknown> }>;
}
export interface CalendarProviderSyncResult {
  events: Array<{ external_id: string; raw: Record<string, unknown> }>;
  deleted_ids: string[];
  replace: boolean;
  checkpoint: NonNullable<CalendarProviderSource["checkpoint"]>;
  timezone: string;
  complete: true;
}
export interface CalendarChangeIntent {
  operation_id: string;
  action: "create" | "update" | "delete";
  event_id?: string;
  etag?: string;
  recurrence_scope?: "instance" | "series";
  master_event_id?: string;
  expected_master_etag?: string;
  payload: Record<string, unknown>;
}
export interface CalendarChangeReviewInput {
  event_id: string;
  recurrence_scope?: "instance" | "series";
  expected_master_etag?: string;
  expected_instance_etag?: string;
}
export interface CalendarChangeReview {
  event_id: string;
  etag: string;
  master_event_id?: string;
  expected_master_etag?: string;
  raw: Record<string, unknown>;
}
export type CalendarChangeResult = {
  status: "confirmed" | "conflict" | "uncertain" | "revoked" | "error";
  external_id?: string;
  event?: Record<string, unknown>;
  etag?: string;
  error?: string;
  retry_after_seconds?: number;
};
export function calendarProviderError(error: unknown) {
  const details =
    error instanceof DomainError
      ? error.details
      : error instanceof IcalFeedError
        ? { upstream_status: error.upstream_status, source_code: error.code }
        : {};
  const status = Number(details.upstream_status ?? 0);
  return {
    code:
      status === 412
        ? "PROVIDER_REVISION_CONFLICT"
        : details.configuration_error
          ? "GOOGLE_CALENDAR_API_NOT_ENABLED"
          : details.rate_limited
            ? "SOURCE_RATE_LIMITED"
            : typeof details.source_code === "string"
              ? details.source_code
              : "SOURCE_READ_FAILED",
    revoked:
      ((status === 401 || status === 403 || status === 404) &&
        !details.rate_limited &&
        !details.configuration_error) ||
      (error instanceof DomainError &&
        error.code === "INSUFFICIENT_PERMISSIONS"),
    ...(typeof details.retry_after_seconds === "number"
      ? { retry_after_seconds: details.retry_after_seconds }
      : {}),
  };
}

/** OAuth token access is confined to this network adapter, outside owner transactions. */
async function authenticatedClient(principal: Principal, write = false) {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Google OAuth client is not configured.",
      { awaiting_grant: true },
      503,
    );
  const rows = await getAuthPool().query<{
    id: string;
    user_id: string;
    scope: string | null;
    provider_account_id?: string;
    grant_created_at?: string;
  }>(
    `SELECT a.id,a."userId" AS user_id,a.scope,a."accountId" AS provider_account_id,a."createdAt" AS grant_created_at FROM account a JOIN "user" u ON u.id=a."userId"
     WHERE a."providerId"='google' AND lower(u.email)=$1 AND ($2::text IS NULL OR u.id=$2) ORDER BY a."createdAt" LIMIT 1`,
    [
      process.env.OWNER_EMAIL?.toLowerCase(),
      principal.channel === "system" ? null : principal.actorId,
    ],
  );
  const account = rows.rows[0];
  if (!account)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Connect Google Calendar in Life OS.",
      { awaiting_grant: true },
      503,
    );
  const scopes = account.scope?.split(/[ ,]+/) ?? [];
  const required = write
    ? [GOOGLE_CALENDAR_READ_SCOPE, GOOGLE_CALENDAR_WRITE_SCOPE]
    : [GOOGLE_CALENDAR_READ_SCOPE];
  if (!required.every((scope) => scopes.includes(scope)))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Reconnect Google Calendar with the required calendar permissions.",
      {},
      403,
    );
  let token: { accessToken: string; scopes: string[] };
  try {
    token = await getAuth().api.getAccessToken({
      body: { accountId: account.id, userId: account.user_id },
    });
  } catch (error) {
    // Better Auth intentionally collapses refresh outages and invalid grants
    // into FAILED_TO_GET_ACCESS_TOKEN. That generic error is not proof that
    // access was revoked, so retain last-good data until an authoritative 401/403.
    const response =
      error && typeof error === "object"
        ? (error as {
            status?: unknown;
            statusCode?: unknown;
            body?: { code?: unknown; error?: unknown };
          })
        : {};
    const explicitRevocation =
      [401, 403].includes(Number(response.statusCode ?? response.status)) ||
      response.body?.error === "invalid_grant" ||
      response.body?.code === "INVALID_GRANT" ||
      response.body?.code === "ACCOUNT_NOT_FOUND";
    throw new DomainError(
      explicitRevocation ? "INSUFFICIENT_PERMISSIONS" : "UNSUPPORTED_OPERATION",
      "Google Calendar token could not be obtained; retry or reconnect Google Calendar.",
      explicitRevocation ? { upstream_status: 401 } : {},
      explicitRevocation ? 403 : 503,
    );
  }
  if (!required.every((scope) => token.scopes.includes(scope)))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Google Calendar permission is missing.",
      {},
      403,
    );
  // Account identity and granted scope set are stable across access-token refreshes.
  const grant_fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        account.id,
        account.user_id,
        account.provider_account_id,
        account.grant_created_at,
        [...scopes].sort(),
      ]),
    )
    .digest("hex");
  return {
    client: new GoogleCalendarClient(token.accessToken),
    writable:
      scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE) &&
      token.scopes.includes(GOOGLE_CALENDAR_WRITE_SCOPE),
    grant_fingerprint,
  };
}
function sourceId(provider: string, id: string) {
  return (
    "CS_" +
    createHash("sha256")
      .update(provider + "\0" + id)
      .digest("hex")
      .slice(0, 40)
  );
}
export async function discoverGoogleCalendars(
  principal: Principal,
): Promise<CalendarProviderSource[]> {
  const { client, writable, grant_fingerprint } =
    await authenticatedClient(principal);
  const result: CalendarProviderSource[] = [];
  const deadline = Date.now() + 105000;
  let pageToken: string | undefined;
  const tokens = new Set<string>();
  for (let page = 0; page < 100; page++) {
    if (Date.now() > deadline)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Calendar discovery exceeded the bounded request budget.",
        {},
        503,
      );
    const response = await client.listCalendars(pageToken);
    for (const item of (response.items ?? []) as Record<string, unknown>[]) {
      if (typeof item.id !== "string") continue;
      result.push({
        source_id: sourceId("google_calendar", item.id),
        provider: "google_calendar",
        external_calendar_id: item.id,
        title: String(
          item.summaryOverride ?? item.summary ?? "Google Calendar",
        ),
        timezone: String(item.timeZone ?? "Europe/Berlin"),
        writable: writable && item.accessRole === "owner",
        primary: item.primary === true,
        grant_fingerprint,
      });
    }
    pageToken =
      typeof response.nextPageToken === "string"
        ? response.nextPageToken
        : undefined;
    if (!pageToken) return result;
    if (tokens.has(pageToken)) break;
    tokens.add(pageToken);
  }
  throw new DomainError(
    "INVALID_INPUT",
    "Calendar discovery exceeded the safe pagination bound.",
  );
}
export async function syncCalendarSource(
  principal: Principal,
  source: CalendarProviderSource,
): Promise<CalendarProviderSyncResult> {
  if (source.provider === "ical") {
    const url = source.config?.url;
    if (!url)
      throw new DomainError(
        "INVALID_INPUT",
        "A private iCalendar source URL is required.",
      );
    const checkpoint = source.checkpoint ?? {};
    const response = await fetchIcalFeedConditional(url, {
      allowedHosts: source.config?.allowed_hosts ?? [],
      etag: checkpoint.etag,
      lastModified: checkpoint.last_modified,
    });
    const text = response.text ?? checkpoint.feed_text;
    if (!text)
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Calendar returned no cached feed.",
        {},
        502,
      );
    // Validate the actual calendar before an atomic cache replacement, without expanding it.
    if (!text.includes("BEGIN:VCALENDAR") || !text.includes("END:VCALENDAR"))
      throw new DomainError("INVALID_INPUT", "Invalid calendar document.");
    const document = new ICAL.Component(ICAL.parse(text));
    if (
      document.name !== "vcalendar" ||
      document.getAllSubcomponents("vevent").length > 5000
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Invalid or excessive calendar document.",
      );
    let timezone = source.timezone;
    const feedZone = document.getFirstPropertyValue("x-wr-timezone");
    if (typeof feedZone === "string") {
      try {
        new Intl.DateTimeFormat("en", { timeZone: feedZone }).format(0);
        timezone = feedZone;
      } catch {
        /* Keep the explicitly configured IANA fallback. */
      }
    }
    return {
      events: [{ external_id: "ical_feed", raw: { feed_text: text } }],
      deleted_ids: [],
      replace: true,
      checkpoint: {
        feed_text: text,
        etag: response.etag ?? checkpoint.etag,
        last_modified: response.lastModified ?? checkpoint.last_modified,
      },
      timezone,
      complete: true,
    };
  }
  const { client, grant_fingerprint } = await authenticatedClient(principal);
  if (
    source.grant_fingerprint &&
    source.grant_fingerprint !== grant_fingerprint
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Google account or grant changed; rediscover calendar sources.",
      {},
      403,
    );
  let token = source.checkpoint?.sync_token;
  let replace = !token;
  const deadline = Date.now() + 105000;
  // 410 restarts into a staging result; callers retain the last-good cache until completion.
  for (let attempt = 0; attempt < 2; attempt++) {
    let pageToken: string | undefined;
    const events = new Map<string, Record<string, unknown>>();
    const deleted = new Set<string>();
    const pages = new Set<string>();
    let timezone = source.timezone;
    try {
      for (let page = 0; page < 100; page++) {
        if (Date.now() > deadline)
          throw new DomainError(
            "UNSUPPORTED_OPERATION",
            "Calendar synchronization exceeded the bounded request budget.",
            {},
            503,
          );
        const data = await client.syncEvents(
          source.external_calendar_id,
          token,
          pageToken,
        );
        if (typeof data.timeZone === "string") timezone = data.timeZone;
        if (!Array.isArray(data.items))
          throw new DomainError(
            "INVALID_INPUT",
            "Invalid calendar event page.",
          );
        for (const raw of data.items as Record<string, unknown>[]) {
          if (typeof raw.id !== "string") continue;
          // Cancelled exceptions must survive to suppress their original recurrence instance.
          if (raw.status === "cancelled" && !raw.recurringEventId) {
            deleted.add(raw.id);
            events.delete(raw.id);
          } else {
            events.set(raw.id, raw);
            deleted.delete(raw.id);
          }
        }
        if (events.size + deleted.size > 50000)
          throw new DomainError(
            "INVALID_INPUT",
            "Calendar source exceeded its safe record bound.",
          );
        pageToken =
          typeof data.nextPageToken === "string"
            ? data.nextPageToken
            : undefined;
        if (!pageToken) {
          if (typeof data.nextSyncToken !== "string" || !data.nextSyncToken)
            throw new DomainError(
              "INVALID_INPUT",
              "Google returned no final sync checkpoint.",
            );
          return {
            events: [...events].map(([external_id, raw]) => ({
              external_id,
              raw,
            })),
            deleted_ids: [...deleted],
            replace,
            checkpoint: { sync_token: data.nextSyncToken },
            timezone,
            complete: true,
          };
        }
        if (pages.has(pageToken)) break;
        pages.add(pageToken);
      }
      throw new DomainError(
        "INVALID_INPUT",
        "Calendar source exceeded the safe pagination bound.",
      );
    } catch (error) {
      if (
        token &&
        error instanceof DomainError &&
        error.details.upstream_status === 410 &&
        attempt === 0
      ) {
        token = undefined;
        replace = true;
        continue;
      }
      throw error;
    }
  }
  throw new DomainError(
    "UNSUPPORTED_OPERATION",
    "Calendar could not be synchronized.",
    {},
    502,
  );
}

function icsText(value: unknown) {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}
type GoogleTime = { date?: string; dateTime?: string; timeZone?: string };
function timeLine(name: string, value: GoogleTime, timezone: string) {
  if (value.date) return name + ";VALUE=DATE:" + value.date.replaceAll("-", "");
  if (!value.dateTime || !Number.isFinite(Date.parse(value.dateTime)))
    throw new DomainError("INVALID_INPUT", "Invalid Google calendar time.");
  const zone = value.timeZone || timezone;
  const local = instantToLocalDateTime(value.dateTime, zone).replace(
    /[-:]/g,
    "",
  );
  return name + ";TZID=" + zone + ":" + local;
}
function eventLines(
  event: Record<string, unknown>,
  timezone: string,
  master?: Record<string, unknown>,
) {
  const eventZone =
    (event.start as GoogleTime | undefined)?.timeZone ??
    (master?.start as GoogleTime | undefined)?.timeZone ??
    timezone;
  const original = event.originalStartTime as GoogleTime | undefined;
  const start = (event.start as GoogleTime | undefined) ?? original;
  let end = event.end as GoogleTime | undefined;
  if (!start) return [];
  if (!end && event.status === "cancelled") {
    const normalized = master && normalizeGoogleEvent(master, timezone);
    if (start.date)
      end = {
        date: new Date(Date.parse(start.date + "T12:00Z") + 86400000)
          .toISOString()
          .slice(0, 10),
      };
    else if (start.dateTime)
      end = {
        dateTime: new Date(
          Date.parse(start.dateTime) +
            (normalized
              ? Date.parse(normalized.ends_at) -
                Date.parse(normalized.starts_at)
              : 3600000),
        ).toISOString(),
      };
  }
  if (!end) return [];
  return [
    "BEGIN:VEVENT",
    "UID:" + icsText(master?.id ?? event.id),
    timeLine("DTSTART", { ...start, timeZone: eventZone }, eventZone),
    timeLine("DTEND", { ...end, timeZone: eventZone }, eventZone),
    ...(original
      ? [
          timeLine(
            "RECURRENCE-ID",
            { ...original, timeZone: eventZone },
            eventZone,
          ),
        ]
      : []),
    "SUMMARY:" + icsText(event.summary),
    "DESCRIPTION:" + icsText(event.description),
    "TRANSP:" +
      (event.transparency === "transparent" ? "TRANSPARENT" : "OPAQUE"),
    ...(event.status === "cancelled" ? ["STATUS:CANCELLED"] : []),
    ...(Array.isArray(event.recurrence)
      ? event.recurrence.filter(
          (line): line is string =>
            typeof line === "string" &&
            /^(RRULE|RDATE|EXDATE):|^(RDATE|EXDATE);/.test(line) &&
            !/[\r\n]/.test(line),
        )
      : []),
    "END:VEVENT",
  ];
}
function externalEventId(source: string, id: string) {
  return (
    "EXT_" +
    createHash("sha256")
      .update(source + "\0" + id)
      .digest("hex")
      .slice(0, 40)
  );
}
function googleRecurrenceRule(event: Record<string, unknown>): string | null {
  if (!Array.isArray(event.recurrence)) return null;
  const rule = event.recurrence.find(
    (line): line is string =>
      typeof line === "string" && line.startsWith("RRULE:"),
  );
  return rule ? rule.slice(6) : null;
}
/** Pure, bounded recurrence expansion: safe to call from cache-only domain queries. */
export function expandCalendarSource(
  source: CalendarProviderSource,
  rows: Array<{ external_id: string; raw: Record<string, unknown> }>,
  from: string,
  to: string,
): EventDTO[] {
  if (
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    Date.parse(to) <= Date.parse(from) ||
    Date.parse(to) - Date.parse(from) > 366 * 86400000 ||
    rows.length > 50000
  )
    throw new RangeError(
      "Calendar queries require a bounded source and a valid range of at most one year.",
    );
  if (source.provider === "ical") {
    const feed = rows.find((row) => typeof row.raw.feed_text === "string")?.raw
      .feed_text;
    if (typeof feed !== "string") return [];
    return parseIcal(
      feed,
      from,
      to,
      source.timezone,
      5000,
      process.env.OWNER_EMAIL,
    ).map((event) => ({
      ...event,
      event_id: externalEventId(source.source_id, event.uid),
      source_id: source.source_id,
      source_title: source.title,
      external_id: event.uid,
      source_read_only: true,
      can_edit: false,
      task_id: null,
      recurrence_rule: null,
      revision: 1,
    }));
  }
  const raw = rows.map((row) => row.raw);
  const masters = raw.filter(
    (event) => !event.recurringEventId && event.status !== "cancelled",
  );
  const result: EventDTO[] = [];
  for (const master of masters) {
    if (typeof master.id !== "string") continue;
    const masterNormalized = normalizeGoogleEvent(master, source.timezone);
    if (!masterNormalized) continue;
    const recurring =
      Array.isArray(master.recurrence) && master.recurrence.length > 0;
    if (!recurring) {
      if (
        Date.parse(masterNormalized.starts_at) < Date.parse(to) &&
        Date.parse(masterNormalized.ends_at) > Date.parse(from)
      ) {
        const canEdit = source.writable && isPersonalGoogleEvent(master);
        result.push({
          ...masterNormalized,
          event_id: externalEventId(source.source_id, master.id),
          external_id: master.id,
          source_id: source.source_id,
          source_title: source.title,
          external_url: masterNormalized.original_url ?? undefined,
          etag: masterNormalized.provider_etag ?? undefined,
          can_edit: canEdit,
          source_read_only: !canEdit,
          occurrence_key:
            externalEventId(source.source_id, master.id) +
            ":" +
            masterNormalized.starts_at,
          task_id: null,
          recurrence_rule: null,
          revision: 1,
        });
      }
      continue;
    }
    const exceptions = raw.filter(
      (event) => event.recurringEventId === master.id,
    );
    const lines = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      ...eventLines(master, source.timezone),
      ...exceptions.flatMap((event) =>
        eventLines(event, source.timezone, master),
      ),
      "END:VCALENDAR",
      "",
    ];
    const occurrences = parseIcal(
      lines.join("\r\n"),
      from,
      to,
      source.timezone,
      5000 - result.length,
    );
    for (const occurrence of occurrences) {
      const changed = exceptions.find((event) => {
        const time = event.originalStartTime as GoogleTime | undefined;
        const original =
          time?.dateTime ??
          (time?.date
            ? zonedLocalToInstant(
                time.date + "T00:00",
                source.timezone,
                "earlier",
              )
            : null);
        return (
          original &&
          (Date.parse(original) ===
            Date.parse(occurrence.original_start ?? occurrence.starts_at) ||
            instantToLocalDateTime(original, occurrence.timezone) ===
              instantToLocalDateTime(
                occurrence.original_start ?? occurrence.starts_at,
                occurrence.timezone,
              ))
        );
      });
      const item = changed ?? master;
      const normalized =
        normalizeGoogleEvent(item, masterNormalized.timezone) ??
        masterNormalized;
      const changedOriginal = changed?.originalStartTime as
        GoogleTime | undefined;
      const originalStart = changedOriginal?.dateTime
        ? new Date(changedOriginal.dateTime).toISOString()
        : changedOriginal?.date
          ? zonedLocalToInstant(
              changedOriginal.date + "T00:00",
              occurrence.timezone,
              "earlier",
            )
          : (occurrence.original_start ?? occurrence.starts_at);
      const externalId =
        typeof changed?.id === "string"
          ? changed.id
          : recurring
            ? master.id +
              "_" +
              (occurrence.all_day
                ? instantToLocalDate(
                    originalStart,
                    occurrence.timezone,
                  ).replaceAll("-", "")
                : new Date(originalStart)
                    .toISOString()
                    .replace(/[-:]/g, "")
                    .replace(/\.\d{3}Z$/, "Z"))
            : master.id;
      const canEdit =
        source.writable &&
        isPersonalGoogleEvent(master) &&
        isPersonalGoogleEvent(item);
      // Explicit provider offsets are authoritative for moved instances, including a DST fold.
      result.push({
        ...normalized,
        ...occurrence,
        ...(changed
          ? { starts_at: normalized.starts_at, ends_at: normalized.ends_at }
          : {}),
        event_id: externalEventId(source.source_id, master.id),
        external_id: externalId,
        source_id: source.source_id,
        source_title: source.title,
        external_url: normalized.original_url ?? undefined,
        etag: normalized.provider_etag ?? undefined,
        can_edit: canEdit,
        source_read_only: !canEdit,
        provider: "google_calendar",
        occurrence_key:
          externalEventId(source.source_id, master.id) + ":" + originalStart,
        series_event_id: recurring ? master.id : null,
        series_starts_at: masterNormalized.starts_at,
        series_ends_at: masterNormalized.ends_at,
        series_etag: masterNormalized.provider_etag ?? undefined,
        original_occurrence_starts_at: recurring ? originalStart : null,
        recurrence_id: recurring ? externalId : null,
        task_id: null,
        recurrence_rule: googleRecurrenceRule(master),
        revision: 1,
        busy: normalized.busy,
      });
    }
  }
  // Source offsets, rather than a floating ICS representation, decide whether a
  // moved exception lies in a sub-day range during the autumn repeated hour.
  for (const exception of raw.filter(
    (event) => event.recurringEventId && event.status !== "cancelled",
  )) {
    const master = masters.find(
      (event) => event.id === exception.recurringEventId,
    );
    const masterNormalized =
      master && normalizeGoogleEvent(master, source.timezone);
    const normalized = normalizeGoogleEvent(
      exception,
      masterNormalized?.timezone ?? source.timezone,
    );
    if (
      !master ||
      !normalized ||
      typeof exception.id !== "string" ||
      Date.parse(normalized.starts_at) >= Date.parse(to) ||
      Date.parse(normalized.ends_at) <= Date.parse(from) ||
      result.some((event) => event.external_id === exception.id)
    )
      continue;
    const original = exception.originalStartTime as GoogleTime | undefined;
    const originalStart = original?.dateTime
      ? new Date(original.dateTime).toISOString()
      : original?.date
        ? zonedLocalToInstant(
            original.date + "T00:00",
            source.timezone,
            "earlier",
          )
        : normalized.starts_at;
    const canEdit =
      source.writable &&
      isPersonalGoogleEvent(master) &&
      isPersonalGoogleEvent(exception);
    result.push({
      ...normalized,
      event_id: externalEventId(source.source_id, String(master.id)),
      external_id: exception.id,
      source_id: source.source_id,
      source_title: source.title,
      external_url: normalized.original_url ?? undefined,
      etag: normalized.provider_etag ?? undefined,
      can_edit: canEdit,
      source_read_only: !canEdit,
      provider: "google_calendar",
      occurrence_key:
        externalEventId(source.source_id, String(master.id)) +
        ":" +
        originalStart,
      series_event_id: String(master.id),
      series_starts_at: normalizeGoogleEvent(master, source.timezone)
        ?.starts_at,
      series_ends_at: normalizeGoogleEvent(master, source.timezone)?.ends_at,
      series_etag: typeof master.etag === "string" ? master.etag : undefined,
      original_occurrence_starts_at: originalStart,
      recurrence_id: exception.id,
      task_id: null,
      recurrence_rule: googleRecurrenceRule(master),
      revision: 1,
    });
  }
  if (result.length > 5000)
    throw new RangeError("Too many occurrences; query a smaller range.");
  return result
    .filter(
      (event) =>
        Date.parse(event.starts_at) < Date.parse(to) &&
        Date.parse(event.ends_at) > Date.parse(from),
    )
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}
export function isPersonalGoogleEvent(event: Record<string, unknown>) {
  const organizer = event.organizer as Record<string, unknown> | undefined;
  return (
    event.status !== "cancelled" &&
    organizer?.self === true &&
    !event.locked &&
    !event.attendeesOmitted &&
    (!event.eventType || event.eventType === "default") &&
    (!event.attendees ||
      (Array.isArray(event.attendees) &&
        event.attendees.every(
          (attendee) =>
            attendee &&
            typeof attendee === "object" &&
            (attendee as Record<string, unknown>).self === true,
        )))
  );
}
/** Authoritative preview read. The domain stores this in its private receipt,
 * outside the owner lock, and never accepts these fields from a client. */
export async function freshCalendarChangeReview(
  principal: Principal,
  source: CalendarProviderSource,
  input: CalendarChangeReviewInput,
): Promise<CalendarChangeReview> {
  if (
    source.provider !== "google_calendar" ||
    !source.writable ||
    !principal.scopes.some(
      (scope) => scope === "calendar:write" || scope === "admin:manage",
    )
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Only personal events on an owned writable calendar can be reviewed.",
      {},
      403,
    );
  if (!input.event_id || input.event_id.length > 2000)
    throw new DomainError(
      "INVALID_INPUT",
      "A bounded provider event ID is required.",
    );
  const { client, grant_fingerprint } = await authenticatedClient(
    principal,
    true,
  );
  if (
    source.grant_fingerprint &&
    source.grant_fingerprint !== grant_fingerprint
  )
    throw new DomainError(
      "REVISION_CONFLICT",
      "Google account or grant changed; refresh calendar sources before reviewing.",
      {},
      409,
    );
  const calendar = await client.calendar(source.external_calendar_id);
  if (calendar.accessRole !== "owner")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Only an owned calendar can be changed.",
      {},
      403,
    );
  let instance: Record<string, unknown>;
  try {
    instance = await client.event(source.external_calendar_id, input.event_id);
  } catch (error) {
    if (error instanceof DomainError && error.details.upstream_status === 404)
      throw new DomainError(
        "REVISION_CONFLICT",
        "The Google event was removed; refresh before reviewing.",
        {},
        409,
      );
    throw error;
  }
  if (!isPersonalGoogleEvent(instance))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Invited, locked or special events must be managed in Google.",
      {},
      403,
    );
  if (
    input.recurrence_scope !== "series" &&
    Array.isArray(instance.recurrence) &&
    instance.recurrence.length
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Choose a specific recurring occurrence or explicitly review the entire series.",
    );
  if (typeof instance.etag !== "string" || !instance.etag)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Google returned no event revision for review.",
      {},
      502,
    );
  if (
    input.expected_instance_etag &&
    instance.etag !== input.expected_instance_etag
  )
    throw new DomainError(
      "REVISION_CONFLICT",
      "The Google occurrence changed; refresh and review the current event.",
      {},
      409,
    );
  const masterId =
    typeof instance.recurringEventId === "string"
      ? instance.recurringEventId
      : null;
  const master = masterId
    ? await client.event(source.external_calendar_id, masterId)
    : instance;
  if (!isPersonalGoogleEvent(master))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "This recurring series must be managed in Google.",
      {},
      403,
    );
  if (typeof master.etag !== "string" || !master.etag)
    throw new DomainError(
      "UNSUPPORTED_OPERATION",
      "Google returned no series revision for review.",
      {},
      502,
    );
  if (input.expected_master_etag && master.etag !== input.expected_master_etag)
    throw new DomainError(
      "REVISION_CONFLICT",
      "The Google series changed; refresh before reviewing.",
      {},
      409,
    );
  const series = input.recurrence_scope === "series",
    selected = series ? master : instance;
  return {
    event_id: series && masterId ? masterId : input.event_id,
    etag: String(selected.etag),
    ...(masterId && !series
      ? { master_event_id: masterId, expected_master_etag: master.etag }
      : {}),
    raw: selected,
  };
}
function changeBody(payload: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  if (payload.title !== undefined)
    output.summary = String(payload.title).slice(0, 4000);
  if (payload.notes !== undefined)
    output.description = String(payload.notes).slice(0, 50000);
  if (payload.starts_at !== undefined || payload.ends_at !== undefined) {
    const start = String(payload.starts_at),
      end = String(payload.ends_at),
      zone = String(payload.timezone ?? "Europe/Berlin");
    if (
      ![start, end].every(
        (time) =>
          /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(time) &&
          Number.isFinite(Date.parse(time)),
      ) ||
      Date.parse(end) <= Date.parse(start)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "An explicit valid event interval is required.",
      );
    output.start = payload.all_day
      ? { date: instantToLocalDate(start, zone) }
      : { dateTime: start, timeZone: zone };
    output.end = payload.all_day
      ? { date: instantToLocalDate(end, zone) }
      : { dateTime: end, timeZone: zone };
  }
  if (payload.recurrence_rule !== undefined) {
    const rule = payload.recurrence_rule;
    if (
      rule !== null &&
      (typeof rule !== "string" || rule.length > 1000 || /[\r\n]/.test(rule))
    )
      throw new DomainError("INVALID_INPUT", "Invalid recurrence rule.");
    output.recurrence = rule
      ? [String(rule).startsWith("RRULE:") ? rule : "RRULE:" + rule]
      : [];
  }
  return output;
}
/** Remote I/O only. The canonical service claims and fences each durable intent. */
export async function executeGoogleCalendarChange(
  principal: Principal,
  source: CalendarProviderSource,
  intent: CalendarChangeIntent,
): Promise<CalendarChangeResult> {
  let mayHaveWritten = false;
  let targetId = intent.event_id;
  try {
    if (source.provider !== "google_calendar" || !source.writable)
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "This calendar is read-only.",
        {},
        403,
      );
    const { client, grant_fingerprint } = await authenticatedClient(
      principal,
      true,
    );
    if (
      source.grant_fingerprint &&
      source.grant_fingerprint !== grant_fingerprint
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Google account or grant changed; rediscover calendar sources.",
        {},
        403,
      );
    const calendar = await client.calendar(source.external_calendar_id);
    if (calendar.accessRole !== "owner")
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Only an owned calendar can be changed.",
        {},
        403,
      );
    if (intent.master_event_id) {
      const master = await client.event(
        source.external_calendar_id,
        intent.master_event_id,
      );
      if (!isPersonalGoogleEvent(master))
        return { status: "error", error: "PERSONAL_EVENTS_ONLY" };
      if (
        !intent.expected_master_etag ||
        intent.expected_master_etag !== master.etag
      )
        return {
          status: "conflict",
          error: "PROVIDER_REVISION_CONFLICT",
          event: master,
          etag: String(master.etag ?? ""),
        };
      if (intent.recurrence_scope === "series")
        targetId = intent.master_event_id;
    }
    const marker = createHash("sha256")
      .update(source.source_id + "\0" + intent.operation_id)
      .digest("hex");
    if (intent.action === "create")
      targetId = intent.event_id ?? "los" + marker;
    if (intent.action === "create" && !/^[0-9a-v]{5,1024}$/.test(targetId!))
      throw new DomainError(
        "INVALID_INPUT",
        "A stable Google-compatible creation identifier is required.",
      );
    if (!targetId)
      throw new DomainError(
        "INVALID_INPUT",
        "A provider event ID is required.",
      );
    let fresh: Record<string, unknown> | undefined;
    try {
      fresh = await client.event(source.external_calendar_id, targetId);
    } catch (error) {
      if (!(
        error instanceof DomainError && error.details.upstream_status === 404
      ))
        throw error;
      if (intent.action === "delete")
        return { status: "confirmed", external_id: targetId };
      if (intent.action !== "create")
        return {
          status: "conflict",
          external_id: targetId,
          error: "EVENT_REMOVED",
        };
    }
    if (fresh?.recurringEventId && intent.recurrence_scope === "series") {
      targetId = String(fresh.recurringEventId);
      fresh = await client.event(source.external_calendar_id, targetId);
    }
    if (fresh) {
      // A deleted event may remain as a minimal Google tombstone. Reconcile it
      // before personal-event guards, since tombstones omit organizer details.
      if (fresh.status === "cancelled")
        return {
          status: intent.action === "delete" ? "confirmed" : "conflict",
          external_id: targetId,
          ...(intent.action === "delete" ? {} : { error: "EVENT_REMOVED" }),
        };
      if (!isPersonalGoogleEvent(fresh))
        return {
          status: "error",
          external_id: targetId,
          error: "PERSONAL_EVENTS_ONLY",
        };
      if (fresh.recurringEventId) {
        const master = await client.event(
          source.external_calendar_id,
          String(fresh.recurringEventId),
        );
        if (!isPersonalGoogleEvent(master))
          return { status: "error", error: "PERSONAL_EVENTS_ONLY" };
      }
      const properties = fresh.extendedProperties as
        { private?: Record<string, string> } | undefined;
      if (
        intent.action !== "delete" &&
        properties?.private?.life_os_operation === marker
      )
        return {
          status: "confirmed",
          external_id: targetId,
          event: fresh,
          etag: String(fresh.etag ?? ""),
        };
      if (intent.action === "create")
        return {
          status: "conflict",
          external_id: targetId,
          error: "PROVIDER_ID_COLLISION",
        };
      if (
        intent.recurrence_scope !== "series" &&
        Array.isArray(fresh.recurrence) &&
        fresh.recurrence.length
      )
        return {
          status: "error",
          error: "RECURRING_INSTANCE_ID_REQUIRED",
          external_id: targetId,
        };
      if ((intent.etag && intent.etag !== fresh.etag) || !intent.etag)
        return {
          status: "conflict",
          external_id: targetId,
          event: fresh,
          etag: String(fresh.etag ?? ""),
          error: "PROVIDER_REVISION_CONFLICT",
        };
    }
    const payload =
      intent.action === "delete" ? undefined : changeBody(intent.payload);
    if (
      payload &&
      Array.isArray(payload.recurrence) &&
      payload.recurrence.length &&
      Array.isArray(fresh?.recurrence)
    ) {
      payload.recurrence = [
        ...payload.recurrence,
        ...fresh.recurrence.filter(
          (line) => typeof line === "string" && !line.startsWith("RRULE:"),
        ),
      ];
    }
    if (intent.action === "create" && (!payload?.start || !payload.end))
      throw new DomainError(
        "INVALID_INPUT",
        "New events require a start and end.",
      );
    const body = payload
      ? {
          ...(fresh ?? {}),
          ...payload,
          ...(intent.action === "create" ? { id: targetId } : {}),
          extendedProperties: {
            ...((fresh?.extendedProperties ?? {}) as Record<string, unknown>),
            private: {
              ...((
                fresh?.extendedProperties as
                  { private?: Record<string, string> } | undefined
              )?.private ?? {}),
              life_os_operation: marker,
            },
          },
        }
      : undefined;
    mayHaveWritten = true;
    const event = await client.change(
      source.external_calendar_id,
      intent.action === "create" ? null : targetId,
      intent.action === "create"
        ? "POST"
        : intent.action === "delete"
          ? "DELETE"
          : "PUT",
      body,
      intent.action === "create"
        ? undefined
        : String(fresh?.etag ?? intent.etag),
    );
    return {
      status: "confirmed",
      external_id: targetId,
      ...(intent.action === "delete"
        ? {}
        : { event, etag: String(event.etag ?? "") }),
    };
  } catch (error) {
    const details = error instanceof DomainError ? error.details : {};
    const classified = calendarProviderError(error);
    const transient =
      details.rate_limited === true ||
      [408, 500, 502, 503, 504].includes(Number(details.upstream_status)) ||
      (error instanceof DomainError &&
        error.code === "UNSUPPORTED_OPERATION" &&
        error.status === 503 &&
        details.awaiting_grant !== true &&
        details.configuration_error !== true &&
        !classified.revoked);
    return {
      status: transient
        ? "uncertain"
        : details.upstream_status === 412
          ? "conflict"
          : classified.revoked
            ? "revoked"
            : mayHaveWritten &&
                (!details.upstream_status ||
                  Number(details.upstream_status) >= 500 ||
                  details.outcome_unknown)
              ? "uncertain"
              : "error",
      ...(targetId ? { external_id: targetId } : {}),
      error: classified.code,
      ...(transient || classified.retry_after_seconds
        ? {
            retry_after_seconds: Math.max(
              5,
              classified.retry_after_seconds ?? 300,
            ),
          }
        : {}),
    };
  }
}
