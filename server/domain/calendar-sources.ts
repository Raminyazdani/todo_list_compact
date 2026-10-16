import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import {
  DomainError,
  type CalendarSourceDTO,
  type CommandName,
  type PreviewDTO,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  choice,
  cleanRows,
  entity,
  guard,
  hash,
  id,
  instant,
  json,
  object,
  requireScope,
  text,
  timezone,
  type Input,
} from "./core";
import type { Change } from "./tasks";
import {
  expandCalendarSource,
  isPersonalGoogleEvent,
  type CalendarProviderSource,
  type CalendarChangeReview,
} from "../integrations/calendar-provider";
import { instantToLocalDate, instantToLocalTime } from "../../shared/datetime";
import { normalizeGoogleEvent } from "../integrations/google";
import * as RRulePackage from "rrule";
const RRule = (RRulePackage.RRule ??
  Reflect.get(RRulePackage, "default")?.RRule) as typeof RRulePackage.RRule;

function secretKey() {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32)
    throw new DomainError(
      "INVALID_INPUT",
      "Calendar source encryption requires the configured authentication secret.",
    );
  return createHash("sha256")
    .update("life-os-calendar-config/v1:" + secret)
    .digest();
}
export function encryptCalendarConfig(
  owner: string,
  sourceId: string,
  value: Input,
) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(owner + ":" + sourceId));
  const ciphertext = Buffer.concat([
    cipher.update(json(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), ciphertext]
    .map((part) => part.toString("base64url"))
    .join(".");
}
export function decryptCalendarConfig(
  owner: string,
  sourceId: string,
  value: unknown,
): Input {
  if (!value) return {};
  const [iv, tag, ciphertext] = String(value)
    .split(".")
    .map((part) => Buffer.from(part, "base64url"));
  const cipher = createDecipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(owner + ":" + sourceId));
  cipher.setAuthTag(tag);
  return object(
    JSON.parse(
      Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString(
        "utf8",
      ),
    ),
  );
}
export function sourceDTO(row: Input): CalendarSourceDTO {
  return {
    source_id: String(row.source_id),
    calendar_id: String(row.source_id),
    provider: row.provider as CalendarSourceDTO["provider"],
    title: String(row.title),
    timezone: String(row.timezone),
    writable:
      row.writable === true && row.enabled === true && row.status !== "revoked",
    enabled: row.enabled === true,
    primary: row.primary_calendar === true,
    revision: Number(row.revision),
    status: String(row.status),
    last_success_at: row.last_success_at
      ? new Date(String(row.last_success_at)).toISOString()
      : null,
    last_error: row.last_error ? String(row.last_error) : null,
    coverage: (row.coverage ?? {}) as CalendarSourceDTO["coverage"],
  };
}
export async function calendarSources(tx: SqlClient, owner: string) {
  return cleanRows(
    (
      await tx.query<Input>(
        "SELECT * FROM calendar_sources WHERE owner_id=$1 ORDER BY provider,title,source_id",
        [owner],
      )
    ).rows,
  );
}
export async function calendarSourceCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision?: number,
): Promise<Change | null> {
  if (command === "calendar_source_configure") {
    const provider = choice(input, "provider", ["google_calendar", "ical"]),
      prior = input.source_id
        ? await entity(
            tx,
            "calendar_sources",
            "source_id",
            text(input, "source_id"),
            principal.ownerId,
          )
        : null;
    if (provider === "google_calendar" && !prior)
      throw new DomainError(
        "INVALID_INPUT",
        "Google calendars are discovered automatically after connecting Google and refreshing; configure an existing source_id.",
      );
    if (prior) {
      guard(prior, revision);
      if (prior.provider !== provider)
        throw new DomainError(
          "INVALID_INPUT",
          "Source provider cannot change.",
        );
    }
    let config: Input =
      prior && input.url === undefined
        ? decryptCalendarConfig(
            principal.ownerId,
            String(prior.source_id),
            prior.encrypted_config,
          )
        : {};
    if (provider === "ical" && input.url !== undefined) {
      let url: URL;
      try {
        url = new URL(text(input, "url", undefined, 4096));
      } catch {
        throw new DomainError(
          "INVALID_INPUT",
          "An HTTPS iCal URL is required.",
        );
      }
      if (url.protocol !== "https:" || url.username || url.password || url.hash)
        throw new DomainError(
          "INVALID_INPUT",
          "An HTTPS iCal URL without embedded credentials or fragments is required.",
        );
      config = { url: url.toString(), allowed_hosts: [url.hostname] };
    }
    if (provider === "ical" && !config.url)
      throw new DomainError("INVALID_INPUT", "An iCal URL is required.");
    const external = prior
        ? String(prior.external_calendar_id)
        : provider === "ical"
          ? "feed:" + hash(config.url)
          : text(input, "external_calendar_id", "primary", 2000),
      sourceId = prior
        ? String(prior.source_id)
        : "CS-" + hash([principal.ownerId, provider, external]).slice(0, 40),
      existing =
        prior ??
        (
          await tx.query<Input>(
            "SELECT * FROM calendar_sources WHERE owner_id=$1 AND source_id=$2",
            [principal.ownerId, sourceId],
          )
        ).rows[0];
    if (!prior && existing)
      throw new DomainError(
        "REVISION_CONFLICT",
        "This source is already configured; use its current revision.",
        { current: sourceDTO(existing) },
        409,
      );
    const encrypted =
      provider === "ical"
        ? encryptCalendarConfig(principal.ownerId, sourceId, config)
        : null;
    if (prior)
      await tx.query(
        "UPDATE calendar_sources SET title=$3,timezone=$4,encrypted_config=$5,enabled=true,generation=generation+1,revision=revision+1,status='pending',last_error=NULL,checkpoint='{}',coverage='{}',lease_id=NULL,lease_until=NULL,next_attempt_at=NULL,updated_at=now() WHERE owner_id=$1 AND source_id=$2",
        [
          principal.ownerId,
          sourceId,
          text(input, "title", String(prior.title), 500),
          timezone(input),
          encrypted,
        ],
      );
    else
      await tx.query(
        "INSERT INTO calendar_sources(source_id,owner_id,provider,external_calendar_id,title,timezone,encrypted_config) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          sourceId,
          principal.ownerId,
          provider,
          external,
          text(
            input,
            "title",
            provider === "ical" ? "iCal" : "Google Calendar",
            500,
          ),
          timezone(input),
          encrypted,
        ],
      );
    return {
      entityId: sourceId,
      before: prior ? sourceDTO(prior) : null,
      after: sourceDTO(
        await entity(
          tx,
          "calendar_sources",
          "source_id",
          sourceId,
          principal.ownerId,
        ),
      ),
      affected: [],
    };
  }
  if (command === "calendar_source_disconnect") {
    const row = await entity(
      tx,
      "calendar_sources",
      "source_id",
      text(input, "source_id"),
      principal.ownerId,
    );
    guard(row, revision);
    await tx.query(
      "UPDATE calendar_sources SET enabled=false,status='disconnected',generation=generation+1,revision=revision+1,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE owner_id=$1 AND source_id=$2",
      [principal.ownerId, row.source_id],
    );
    await tx.query(
      "UPDATE calendar_mutation_intents SET state='revoked',last_error='SOURCE_DISCONNECTED',revision=revision+1 WHERE owner_id=$1 AND source_id=$2 AND state IN ('pending','sending','uncertain')",
      [principal.ownerId, row.source_id],
    );
    return {
      entityId: String(row.source_id),
      before: sourceDTO(row),
      after: sourceDTO(
        await entity(
          tx,
          "calendar_sources",
          "source_id",
          String(row.source_id),
          principal.ownerId,
        ),
      ),
      affected: [],
    };
  }
  if (command === "calendar_sync_request") {
    const selected = input.source_ids;
    if (
      selected !== undefined &&
      (!Array.isArray(selected) ||
        selected.length > 100 ||
        selected.some((value) => typeof value !== "string"))
    )
      throw new DomainError(
        "INVALID_INPUT",
        "A bounded source ID list is required.",
      );
    const rows = await calendarSources(tx, principal.ownerId);
    if (selected)
      for (const value of selected as string[])
        if (!rows.some((row) => row.source_id === value))
          throw new DomainError(
            "ENTITY_NOT_FOUND",
            "Calendar source unavailable.",
            {},
            404,
          );
    await tx.query(
      "UPDATE calendar_sources SET requested_at=now() WHERE owner_id=$1 AND enabled=true AND ($2::text[] IS NULL OR source_id=ANY($2::text[]))",
      [principal.ownerId, selected ?? null],
    );
    return {
      entityId: principal.ownerId,
      before: null,
      after: {
        requested: true,
        source_ids:
          selected ??
          rows.filter((row) => row.enabled).map((row) => row.source_id),
      },
      affected: [],
    };
  }
  if (command === "calendar_event_change_commit")
    return commitCalendarChange(tx, input, principal);
  return null;
}

function eventPayload(input: Input, action: string) {
  if (action === "delete") return {};
  const value = object(input.payload),
    result: Input = {};
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "title",
          "starts_at",
          "ends_at",
          "timezone",
          "all_day",
          "notes",
          "recurrence_rule",
        ].includes(key),
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Only personal event fields are editable.",
    );
  result.title = text(value, "title", undefined, 2000);
  result.starts_at = instant(value, "starts_at");
  result.ends_at = instant(value, "ends_at");
  if (
    String(result.ends_at) <= String(result.starts_at) ||
    Date.parse(String(result.ends_at)) - Date.parse(String(result.starts_at)) >
      366 * 86400000
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A valid event interval of at most one year is required.",
    );
  result.timezone = timezone(value);
  if (value.all_day !== undefined && typeof value.all_day !== "boolean")
    throw new DomainError("INVALID_INPUT", "all_day must be boolean.");
  result.all_day = value.all_day === true;
  if (
    result.all_day &&
    (instantToLocalTime(String(result.starts_at), String(result.timezone)) !==
      "00:00" ||
      instantToLocalTime(String(result.ends_at), String(result.timezone)) !==
        "00:00" ||
      new Date(String(result.starts_at)).getUTCSeconds() !== 0 ||
      new Date(String(result.ends_at)).getUTCSeconds() !== 0 ||
      new Date(String(result.starts_at)).getUTCMilliseconds() !== 0 ||
      new Date(String(result.ends_at)).getUTCMilliseconds() !== 0 ||
      instantToLocalDate(String(result.ends_at), String(result.timezone)) <=
        instantToLocalDate(String(result.starts_at), String(result.timezone)))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "All-day events require local midnight boundaries and an exclusive later end date.",
    );
  result.notes = text(value, "notes", "", 10000);
  if (value.recurrence_rule !== undefined)
    result.recurrence_rule =
      value.recurrence_rule === null
        ? null
        : text(value, "recurrence_rule", undefined, 4000);
  if (result.recurrence_rule) {
    const raw = String(result.recurrence_rule),
      rule = raw.replace(/^RRULE:/, "");
    try {
      if (raw.length > 1000 || /[\r\n]/.test(raw) || !/^FREQ=/.test(rule))
        throw new Error("Invalid rule");
      const options = RRule.parseString(rule);
      if (
        options.freq === undefined ||
        (options.count !== undefined &&
          options.count !== null &&
          options.count < 1) ||
        (options.interval !== undefined && options.interval < 1)
      )
        throw new Error("Invalid recurrence bounds");
      new RRule({ ...options, dtstart: new Date(String(result.starts_at)) });
    } catch {
      throw new DomainError(
        "INVALID_INPUT",
        "A valid bounded-length recurrence rule is required.",
      );
    }
  }
  return result;
}
function editableRaw(raw: Input) {
  return isPersonalGoogleEvent(raw);
}
async function cachedEditableEvent(
  tx: SqlClient,
  owner: string,
  source: Input,
  externalId: string,
  recurrenceScope: string,
) {
  const rows = (
    await tx.query<{ external_id: string; raw: Input }>(
      "SELECT external_id,raw FROM calendar_external_events WHERE owner_id=$1 AND source_id=$2 ORDER BY external_id",
      [owner, source.source_id],
    )
  ).rows;
  const exact = rows.find((row) => row.external_id === externalId),
    masterId = exact?.raw.recurringEventId
      ? String(exact.raw.recurringEventId)
      : rows.find(
          (row) =>
            Array.isArray(row.raw.recurrence) &&
            externalId.startsWith(row.external_id + "_") &&
            /^\d{8}(T\d{6}Z)?$/.test(
              externalId.slice(row.external_id.length + 1),
            ),
        )?.external_id,
    master = masterId
      ? rows.find((row) => row.external_id === masterId)
      : undefined;
  if (
    exact &&
    Array.isArray(exact.raw.recurrence) &&
    recurrenceScope === "instance"
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Select a specific recurring occurrence or explicitly choose the entire series.",
    );
  if (!exact && master) {
    const suffix = externalId.slice(masterId!.length + 1),
      label =
        suffix.slice(0, 4) +
        "-" +
        suffix.slice(4, 6) +
        "-" +
        suffix.slice(6, 8),
      at = Date.parse(label + "T12:00:00Z");
    const exists =
      Number.isFinite(at) &&
      expandCalendarSource(
        source as unknown as CalendarProviderSource,
        rows,
        new Date(at - 2 * 86400000).toISOString(),
        new Date(at + 2 * 86400000).toISOString(),
      ).some((event) => event.external_id === externalId);
    if (!exists) return null;
  }
  if (recurrenceScope === "series" && master)
    return {
      raw: master.raw,
      external_id: master.external_id,
      master_event_id: null,
      expected_master_etag: null,
      generated: false,
      selection_etag: master.raw.etag,
    };
  const row = exact ?? master;
  return row
    ? {
        raw: row.raw,
        external_id: externalId,
        master_event_id: master?.external_id ?? null,
        expected_master_etag: master?.raw.etag ?? null,
        generated: !exact,
        selection_etag: row.raw.etag,
      }
    : null;
}
function requireReviewedCalendarPrincipal(principal: Principal) {
  requireScope(principal, "calendar", true);
  if (principal.channel !== "UI" && principal.channel !== "MCP")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Google changes require owner review through an authorized calendar client.",
      {},
      403,
    );
}
function calendarReviewFingerprint(
  source: Input,
  row: NonNullable<Awaited<ReturnType<typeof cachedEditableEvent>>>,
) {
  return hash({
    source_id: source.source_id,
    generation: source.generation,
    revision: source.revision,
    cache_revision: source.cache_revision,
    grant_fingerprint: source.grant_fingerprint,
    event: row,
  });
}
export interface PreparedCalendarChangeReview {
  ownerId: string;
  actorId: string;
  inputHash: string;
  source: Input;
  cacheFingerprint: string;
  event_id: string;
  recurrence_scope: "instance" | "series";
  master_event_id?: string;
  expected_instance_etag?: string;
  expected_master_etag?: string;
}
interface TrustedCalendarReview {
  prepared: PreparedCalendarChangeReview;
  review: CalendarChangeReview;
  expiresAt: number;
}
const calendarReviews = new WeakMap<Input, TrustedCalendarReview>();
/** Pure short owner read; the caller must finish this transaction before HTTP. */
export async function prepareCalendarChangeReview(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<PreparedCalendarChangeReview> {
  requireReviewedCalendarPrincipal(principal);
  const action = choice(input, "action", ["update", "delete"]),
    source = await entity(
      tx,
      "calendar_sources",
      "source_id",
      text(input, "source_id"),
      principal.ownerId,
    ),
    recurrenceScope = choice(
      input,
      "recurrence_scope",
      ["instance", "series"],
      "instance",
    );
  if (
    source.provider !== "google_calendar" ||
    !source.enabled ||
    !source.writable ||
    ["revoked", "disconnected"].includes(String(source.status))
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Choose an owned writable Google calendar.",
      {},
      403,
    );
  eventPayload(input, action);
  const row = await cachedEditableEvent(
    tx,
    principal.ownerId,
    source,
    text(input, "event_id", undefined, 2000),
    recurrenceScope,
  );
  if (!row || !editableRaw(row.raw))
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "This event is read-only; manage invited or special events in Google.",
      {},
      403,
    );
  if (input.etag !== undefined && input.etag !== row.selection_etag)
    throw new DomainError(
      "REVISION_CONFLICT",
      "Google event changed; refresh and review again.",
      {},
      409,
    );
  const pending = await tx.query(
    "SELECT intent_id FROM calendar_mutation_intents WHERE owner_id=$1 AND source_id=$2 AND external_event_id=$3 AND state IN ('pending','sending','uncertain') LIMIT 1",
    [principal.ownerId, source.source_id, row.external_id],
  );
  if (pending.rows.length)
    throw new DomainError(
      "REVISION_CONFLICT",
      "An earlier change is still awaiting Google confirmation.",
      {},
      409,
    );
  return {
    ownerId: principal.ownerId,
    actorId: principal.actorId,
    inputHash: hash(input),
    source,
    cacheFingerprint: calendarReviewFingerprint(source, row),
    event_id: row.external_id,
    recurrence_scope: recurrenceScope,
    ...(row.master_event_id ? { master_event_id: row.master_event_id } : {}),
    ...(row.generated
      ? {}
      : { expected_instance_etag: text(row.raw, "etag", undefined, 1000) }),
    ...(row.expected_master_etag
      ? { expected_master_etag: String(row.expected_master_etag) }
      : {}),
  };
}
/** In-process capability: a JSON body or tool argument cannot forge this receipt. */
export function withTrustedCalendarReview(
  input: Input,
  principal: Principal,
  prepared: PreparedCalendarChangeReview,
  review: CalendarChangeReview,
): Input {
  if (
    principal.ownerId !== prepared.ownerId ||
    principal.actorId !== prepared.actorId ||
    hash(input) !== prepared.inputHash ||
    review.event_id !== prepared.event_id ||
    (review.master_event_id ?? null) !== (prepared.master_event_id ?? null) ||
    review.raw.id !== review.event_id ||
    typeof review.etag !== "string" ||
    !review.etag ||
    !editableRaw(review.raw) ||
    (prepared.expected_master_etag &&
      review.expected_master_etag !== prepared.expected_master_etag)
  )
    throw new DomainError(
      "REVISION_CONFLICT",
      "Google review identity or revision changed.",
      {},
      409,
    );
  const branded = Object.freeze(object(JSON.parse(json(input))));
  calendarReviews.set(branded, {
    prepared: JSON.parse(json(prepared)),
    review: JSON.parse(json(review)),
    expiresAt: Date.now() + 60000,
  });
  return branded;
}
export async function previewCalendarChange(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<PreviewDTO> {
  requireReviewedCalendarPrincipal(principal);
  const source = await entity(
      tx,
      "calendar_sources",
      "source_id",
      text(input, "source_id"),
      principal.ownerId,
    ),
    action = choice(input, "action", ["create", "update", "delete"]),
    recurrenceScope = choice(
      input,
      "recurrence_scope",
      ["instance", "series"],
      "instance",
    );
  if (
    source.provider !== "google_calendar" ||
    !source.enabled ||
    !source.writable ||
    source.status === "revoked"
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Choose an owned writable Google calendar.",
      {},
      403,
    );
  let externalId =
    action === "create"
      ? randomBytes(16).toString("hex")
      : text(input, "event_id", undefined, 2000);
  let etag: string | null = null;
  let masterId: string | null = null,
    masterEtag: unknown = null;
  let cacheFingerprint: string | null = null,
    original: Input | null = null;
  if (action !== "create") {
    const row = await cachedEditableEvent(
      tx,
      principal.ownerId,
      source,
      externalId,
      recurrenceScope,
    );
    if (!row || !editableRaw(row.raw))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "This event is read-only; manage invited or special events in Google.",
        {},
        403,
      );
    externalId = row.external_id;
    masterId = row.master_event_id;
    masterEtag = row.expected_master_etag;
    cacheFingerprint = calendarReviewFingerprint(source, row);
    const receipt = calendarReviews.get(input);
    if (
      !receipt ||
      receipt.expiresAt < Date.now() ||
      receipt.prepared.ownerId !== principal.ownerId ||
      receipt.prepared.actorId !== principal.actorId ||
      receipt.prepared.inputHash !== hash(input) ||
      receipt.prepared.cacheFingerprint !== cacheFingerprint ||
      receipt.review.event_id !== externalId
    )
      throw new DomainError(
        "PREVIEW_REQUIRED",
        "A fresh server-verified Google event review is required; refresh and review again.",
        {},
        409,
      );
    etag = receipt.review.etag;
    masterId = receipt.review.master_event_id ?? null;
    masterEtag = receipt.review.expected_master_etag ?? null;
    const normalized = normalizeGoogleEvent(
      receipt.review.raw,
      String(source.timezone),
    );
    if (!normalized)
      throw new DomainError(
        "REVISION_CONFLICT",
        "Google event is no longer a valid editable event.",
        {},
        409,
      );
    original = {
      title: normalized.title,
      starts_at: normalized.starts_at,
      ends_at: normalized.ends_at,
      timezone: normalized.timezone,
      all_day: normalized.all_day,
      notes: normalized.notes,
      etag,
    };
    if (input.etag !== undefined && input.etag !== row.selection_etag)
      throw new DomainError(
        "REVISION_CONFLICT",
        "Google event changed; refresh and review again.",
        {},
        409,
      );
    const pending = await tx.query(
      "SELECT intent_id FROM calendar_mutation_intents WHERE owner_id=$1 AND source_id=$2 AND external_event_id=$3 AND state IN ('pending','sending','uncertain') LIMIT 1",
      [principal.ownerId, source.source_id, externalId],
    );
    if (pending.rows.length)
      throw new DomainError(
        "REVISION_CONFLICT",
        "An earlier change is still awaiting Google confirmation.",
        {},
        409,
      );
  }
  const previewId = id("PREVIEW"),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString(),
    payload = {
      source_id: source.source_id,
      source_generation: source.generation,
      source_revision: source.revision,
      action,
      event_id: externalId,
      etag,
      master_event_id: masterId,
      expected_master_etag: masterEtag,
      reviewed_cache_fingerprint: cacheFingerprint,
      payload: eventPayload(input, action),
      recurrence_scope: recurrenceScope,
      preview_actor_id: principal.actorId,
    };
  await tx.query(
    "INSERT INTO command_previews(preview_id,owner_id,command,input,revisions,expires_at) VALUES($1,$2,'calendar_event_change_commit',$3::jsonb,$4::jsonb,$5)",
    [
      previewId,
      principal.ownerId,
      json(payload),
      json({ [String(source.source_id)]: Number(source.revision) }),
      expiresAt,
    ],
  );
  return {
    preview_id: previewId,
    command: "calendar_event_change_commit",
    input: payload,
    expires_at: expiresAt,
    revisions: { [String(source.source_id)]: Number(source.revision) },
    affected_task_ids: [],
    changes: JSON.parse(
      json({ ...payload, ...(original ? { original } : {}) }),
    ),
    warnings: [
      "GOOGLE_CONFIRMATION_PENDING_UNTIL_PROVIDER_ACK",
      "PERSONAL_EVENTS_ONLY_NO_INVITATIONS",
    ],
  };
}
async function commitCalendarChange(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<Change> {
  const row = (
    await tx.query<Input>(
      "SELECT * FROM command_previews WHERE owner_id=$1 AND preview_id=$2 FOR UPDATE",
      [principal.ownerId, text(input, "preview_id")],
    )
  ).rows[0];
  if (!row || row.command !== "calendar_event_change_commit")
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "A reviewed owner-bound Google change preview is required.",
      {},
      409,
    );
  if (row.consumed_at || Date.parse(String(row.expires_at)) <= Date.now())
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Google change preview expired.",
      {},
      409,
    );
  const payload = object(row.input);
  if (payload.preview_actor_id !== principal.actorId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "The preview belongs to another actor.",
      {},
      403,
    );
  const source = await entity(
    tx,
    "calendar_sources",
    "source_id",
    String(payload.source_id),
    principal.ownerId,
  );
  guard(source, Number(payload.source_revision));
  if (
    !source.enabled ||
    !source.writable ||
    source.generation !== payload.source_generation ||
    source.status === "revoked"
  )
    throw new DomainError(
      "REVISION_CONFLICT",
      "Calendar connection changed after review.",
      {},
      409,
    );
  if (payload.action !== "create") {
    const current = await cachedEditableEvent(
      tx,
      principal.ownerId,
      source,
      String(payload.event_id),
      String(payload.recurrence_scope),
    );
    if (
      !current ||
      !payload.reviewed_cache_fingerprint ||
      calendarReviewFingerprint(source, current) !==
        payload.reviewed_cache_fingerprint ||
      typeof payload.etag !== "string" ||
      !payload.etag ||
      !editableRaw(current.raw)
    )
      throw new DomainError(
        "REVISION_CONFLICT",
        "Google event changed after review.",
        {},
        409,
      );
    const pending = await tx.query(
      "SELECT intent_id FROM calendar_mutation_intents WHERE owner_id=$1 AND source_id=$2 AND external_event_id=$3 AND state IN ('pending','sending','uncertain') LIMIT 1",
      [principal.ownerId, source.source_id, payload.event_id],
    );
    if (pending.rows.length)
      throw new DomainError(
        "REVISION_CONFLICT",
        "An earlier Google change is pending.",
        {},
        409,
      );
  }
  const intentId = id("GOP");
  await tx.query(
    "INSERT INTO calendar_mutation_intents(intent_id,owner_id,source_id,source_generation,action,external_event_id,etag,payload,recurrence_scope,master_event_id,expected_master_etag) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)",
    [
      intentId,
      principal.ownerId,
      source.source_id,
      source.generation,
      payload.action,
      payload.event_id,
      payload.etag,
      json(payload.payload),
      payload.recurrence_scope,
      payload.master_event_id,
      payload.expected_master_etag,
    ],
  );
  await tx.query(
    "UPDATE command_previews SET consumed_at=now() WHERE owner_id=$1 AND preview_id=$2",
    [principal.ownerId, row.preview_id],
  );
  return {
    entityId: intentId,
    before: null,
    after: {
      intent_id: intentId,
      operation_id: intentId,
      source_id: source.source_id,
      external_event_id: payload.event_id,
      action: payload.action,
      payload: payload.payload,
      recurrence_scope: payload.recurrence_scope,
      expected_etag: payload.etag,
      expected_master_etag: payload.expected_master_etag,
      state: "pending",
      revision: 1,
    },
    affected: [],
  };
}
