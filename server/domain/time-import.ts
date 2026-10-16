import {
  DomainError,
  type PreviewDTO,
  type Principal,
} from "../../shared/contracts";
import { intervalMinutes } from "../../shared/datetime";
import {
  prepareWorkPlannerImport,
  type WorkPlannerImportOptions,
} from "../../scripts/migration/work-planner";
import { workMinutes, workOverlapSummary } from "./work-log";
import type { SqlClient } from "../db/database";
import {
  array,
  cleanRows,
  date,
  hash,
  id,
  instant,
  json,
  now,
  object,
  requireScope,
  text,
  timezone,
  choice,
  type Input,
} from "./core";
import type { Change } from "./tasks";

const FORMAT = "ramin-life-os-time/1",
  COMMAND = "time_entry_import_commit" as const;
interface ImportEntry {
  entry_id: string;
  employer: string;
  starts_at: string;
  ends_at: string;
  description: string;
  task_id: string | null;
  reporting_policy: "elapsed" | "legacy_wall";
  reported_minutes: number | null;
  legacy_metadata: Input;
}
function exactKeys(input: Input, keys: string[]) {
  if (Object.keys(input).some((key) => !keys.includes(key)))
    throw new DomainError(
      "INVALID_INPUT",
      "Work-log imports cannot specify owner, revision, history or other server-managed fields.",
    );
}
function importInstant(input: Input, key: string) {
  const raw = text(input, key, undefined, 40),
    match =
      /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.exec(
        raw,
      );
  if (
    !match ||
    +match[1] > 23 ||
    +match[2] > 59 ||
    +(match[3] ?? 0) > 59 ||
    !date({ day: raw.slice(0, 10) }, "day")
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Work-log timestamps require valid ISO dates/times with explicit offsets and millisecond precision.",
    );
  return instant(input, key);
}
function importData(input: Input) {
  exactKeys(input, ["data", "timezone", "resolutions"]);
  let data = object(input.data);
  if (data.version === 1) {
    const converted = prepareWorkPlannerImport(data, {
      timezone:
        typeof input.timezone === "string" ? input.timezone : "Europe/Berlin",
      resolutions: input.resolutions as WorkPlannerImportOptions["resolutions"],
    });
    if (!converted.ready)
      throw new DomainError(
        "INVALID_INPUT",
        "Resolve invalid or ambiguous legacy work intervals before importing.",
        { errors: converted.errors },
        409,
      );
    data = {
      format: FORMAT,
      timezone: input.timezone ?? "Europe/Berlin",
      entries: converted.entries,
      drafts: converted.drafts,
    };
  }
  exactKeys(data, ["format", "timezone", "entries", "drafts"]);
  if (data.format !== FORMAT || typeof data.timezone !== "string")
    throw new DomainError(
      "INVALID_INPUT",
      "Work-log format and explicit IANA timezone are required.",
    );
  const zone = timezone(data),
    rows = array(data.entries, 1000),
    seen = new Set<string>();
  if (!rows.length && (!Array.isArray(data.drafts) || !data.drafts.length))
    throw new DomainError(
      "INVALID_INPUT",
      "Import between 1 and 1000 work-log entries.",
    );
  const entries: ImportEntry[] = rows.map((row) => {
    exactKeys(row, [
      "entry_id",
      "employer",
      "starts_at",
      "ends_at",
      "description",
      "task_id",
      "timezone",
      "reporting_policy",
      "reported_minutes",
      "legacy_metadata",
    ]);
    if (row.description !== undefined && typeof row.description !== "string")
      throw new DomainError(
        "INVALID_INPUT",
        "Work-log description must be a plain string.",
      );
    const policy = choice(
        row,
        "reporting_policy",
        ["elapsed", "legacy_wall"],
        "elapsed",
      ),
      reported = row.reported_minutes ?? null;
    if (
      policy === "legacy_wall" &&
      (typeof reported !== "number" ||
        !Number.isFinite(reported) ||
        reported < 0 ||
        reported > 366 * 1440)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Legacy work logs require valid original reported minutes.",
      );
    if (policy === "elapsed" && reported !== null)
      throw new DomainError(
        "INVALID_INPUT",
        "Elapsed work logs cannot override their actual duration.",
      );
    const metadata = object(row.legacy_metadata ?? {});
    if (json(metadata).length > 20000)
      throw new DomainError(
        "INVALID_INPUT",
        "Legacy work metadata exceeds its bound.",
      );
    const entry: ImportEntry = {
      reporting_policy: policy,
      reported_minutes: reported as number | null,
      legacy_metadata: metadata,
      entry_id: text(row, "entry_id", undefined, 512),
      employer: text(row, "employer", undefined, 200),
      starts_at: importInstant(row, "starts_at"),
      ends_at: importInstant(row, "ends_at"),
      description: text(row, "description", "", 10000),
      task_id:
        row.task_id === undefined || row.task_id === null
          ? null
          : text(row, "task_id", undefined, 512),
    };
    if (
      seen.has(entry.entry_id) ||
      Object.values(entry).some(
        (value) => typeof value === "string" && value.includes("\u0000"),
      )
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Work-log entry IDs must be unique and text cannot contain null characters.",
      );
    seen.add(entry.entry_id);
    if (
      entry.task_id &&
      (entry.task_id.length > 512 ||
        /[\u0000-\u001f\u007f]/.test(entry.task_id))
    )
      throw new DomainError("INVALID_INPUT", "Invalid linked task ID.");
    if (
      /[\u0000-\u001f\u007f]/.test(entry.entry_id) ||
      entry.ends_at <= entry.starts_at ||
      intervalMinutes(entry) > 366 * 1440
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Work logs require valid identifiers and ordered intervals of at most one year.",
      );
    return entry;
  });
  const drafts = array(data.drafts ?? [], 1000).map((row) => {
    exactKeys(row, [
      "draft_id",
      "employer",
      "date",
      "start",
      "end",
      "end_next_day",
      "description",
      "timezone",
      "legacy_metadata",
    ]);
    const draftId = text(row, "draft_id", undefined, 512);
    if (seen.has(draftId) || /[\u0000-\u001f\u007f]/.test(draftId))
      throw new DomainError("INVALID_INPUT", "Work draft IDs must be unique.");
    seen.add(draftId);
    const metadata = object(row.legacy_metadata ?? {});
    if (json(metadata).length > 20000)
      throw new DomainError(
        "INVALID_INPUT",
        "Legacy draft metadata exceeds its bound.",
      );
    return {
      draft_id: draftId,
      employer: text(row, "employer", "Jena", 200),
      date: text(row, "date", "", 10),
      start: text(row, "start", "", 10),
      end: text(row, "end", "", 10),
      end_next_day: row.end_next_day === true,
      description: text(row, "description", "", 10000),
      timezone: timezone({ timezone: row.timezone ?? zone }),
      legacy_metadata: metadata,
    };
  });
  return { format: FORMAT, timezone: zone, entries, drafts };
}
function requireImport(principal: Principal) {
  requireScope(principal, "time", true);
  if (principal.channel !== "UI" && principal.channel !== "MCP")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Work-log import requires an owner review or an authorized work-log client.",
      {},
      403,
    );
}
async function timeState(tx: SqlClient, owner: string) {
  const rows = (
    await tx.query<Input>(
      `SELECT entry_id,
    encode(sha256(convert_to(jsonb_build_array(employer,starts_at,ends_at,description,task_id,revision,archived_at,reporting_policy,reported_minutes,legacy_metadata)::text,'UTF8')),'hex') AS fingerprint
    FROM time_entries WHERE owner_id=$1 ORDER BY entry_id LIMIT 50001`,
      [owner],
    )
  ).rows;
  if (rows.length > 50000)
    throw new DomainError(
      "INVALID_INPUT",
      "Owner work-log state exceeds the current bounded import preview limit.",
    );
  const drafts = cleanRows(
    (
      await tx.query<Input>(
        'SELECT draft_id,revision,archived_at,employer,date,start,"end",end_next_day,description,timezone,legacy_metadata FROM time_drafts WHERE owner_id=$1 ORDER BY draft_id LIMIT 50001',
        [owner],
      )
    ).rows,
  );
  if (drafts.length > 50000)
    throw new DomainError(
      "INVALID_INPUT",
      "Owner draft state exceeds the bounded import preview limit.",
    );
  return hash({ rows, drafts });
}
async function planImport(
  tx: SqlClient,
  data: ReturnType<typeof importData>,
  principal: Principal,
) {
  const ids = data.entries.map((entry) => entry.entry_id),
    taskIds = [
      ...new Set(
        data.entries.flatMap((entry) => (entry.task_id ? [entry.task_id] : [])),
      ),
    ];
  if (taskIds.length) {
    const owned = new Set(
      (
        await tx.query<{ task_id: string }>(
          "SELECT task_id FROM tasks WHERE owner_id=$1 AND task_id=ANY($2::text[])",
          [principal.ownerId, taskIds],
        )
      ).rows.map((row) => row.task_id),
    );
    const inaccessible = taskIds.filter((taskId) => !owned.has(taskId));
    if (inaccessible.length)
      throw new DomainError(
        "TASK_NOT_FOUND",
        "Linked work-log task is absent or inaccessible.",
        { task_ids: inaccessible },
        404,
      );
  }
  const collisions = await tx.query(
    "SELECT entry_id FROM time_entries WHERE entry_id=ANY($2::text[]) AND owner_id<>$1 LIMIT 1",
    [principal.ownerId, ids],
  );
  if (collisions.rows.length)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "A work-log identity is unavailable to this owner.",
      {},
      403,
    );
  const existing = new Map(
    cleanRows(
      (
        await tx.query<Input>(
          "SELECT * FROM time_entries WHERE owner_id=$1 AND entry_id=ANY($2::text[])",
          [principal.ownerId, ids],
        )
      ).rows,
    ).map((row) => [String(row.entry_id), row]),
  );
  const create: ImportEntry[] = [],
    skipped: string[] = [];
  for (const entry of data.entries) {
    const prior = existing.get(entry.entry_id);
    if (!prior) {
      create.push(entry);
      continue;
    }
    if (
      prior.archived_at ||
      Object.entries(entry).some(([key, value]) =>
        key === "legacy_metadata"
          ? hash(prior[key] ?? {}) !== hash(value)
          : prior[key] !== value,
      )
    )
      throw new DomainError(
        "REVISION_CONFLICT",
        "An existing work-log ID differs; review it through a separate edit instead of overwriting.",
        { entry_id: entry.entry_id },
        409,
      );
    skipped.push(entry.entry_id);
  }
  const existingActive = cleanRows(
    (
      await tx.query<Input>(
        "SELECT entry_id,starts_at,ends_at FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL ORDER BY starts_at LIMIT 50001",
        [principal.ownerId],
      )
    ).rows,
  );
  if (existingActive.length > 50000)
    throw new DomainError(
      "INVALID_INPUT",
      "Owner work logs exceed the bounded import limit.",
    );
  const overlap = workOverlapSummary([
    ...existingActive,
    ...create.map((entry) => ({ ...entry })),
  ]);
  const drafts: typeof data.drafts = [],
    skippedDrafts: string[] = [];
  for (const draft of data.drafts) {
    const collision = (
      await tx.query<Input>("SELECT * FROM time_drafts WHERE draft_id=$1", [
        draft.draft_id,
      ])
    ).rows[0];
    if (collision) {
      if (collision.owner_id !== principal.ownerId)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Work draft identity unavailable.",
          {},
          403,
        );
      if (
        collision.archived_at ||
        Object.entries(draft).some(([key, value]) =>
          key === "legacy_metadata"
            ? hash(collision[key] ?? {}) !== hash(value)
            : collision[key] !== value,
        )
      )
        throw new DomainError(
          "REVISION_CONFLICT",
          "An existing work draft differs; review separately.",
          { draft_id: draft.draft_id },
          409,
        );
      skippedDrafts.push(draft.draft_id);
    } else drafts.push(draft);
  }
  return { create, skipped, drafts, skippedDrafts, overlap };
}
export async function previewTimeImport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<PreviewDTO> {
  requireImport(principal);
  const data = importData(input),
    plan = await planImport(tx, data, principal),
    stateHash = await timeState(tx, principal.ownerId),
    previewId = id("PREVIEW"),
    expiresAt = new Date(Date.now() + 15 * 60000).toISOString(),
    payload: Input = {
      data,
      time_state_hash: stateHash,
      preview_actor_id: principal.actorId,
    },
    changes = {
      format: FORMAT,
      timezone: data.timezone,
      counts: {
        provided: data.entries.length,
        new: plan.create.length,
        skipped: plan.skipped.length,
        drafts_new: plan.drafts.length,
        drafts_skipped: plan.skippedDrafts.length,
      },
      entries_to_create: plan.create,
      skipped_entry_ids: plan.skipped,
      drafts_to_create: plan.drafts,
      overlap: plan.overlap,
      minutes_to_create: plan.create.reduce(
        (total, entry) => total + workMinutes({ ...entry }),
        0,
      ),
    };
  await tx.query(
    "INSERT INTO command_previews(preview_id,owner_id,command,input,revisions,expires_at) VALUES($1,$2,$3,$4::jsonb,'{}'::jsonb,$5)",
    [previewId, principal.ownerId, COMMAND, json(payload), expiresAt],
  );
  return {
    preview_id: previewId,
    command: COMMAND,
    input: payload,
    expires_at: expiresAt,
    revisions: {},
    affected_task_ids: [
      ...new Set(
        plan.create.flatMap((entry) => (entry.task_id ? [entry.task_id] : [])),
      ),
    ],
    changes: JSON.parse(json(changes)),
    warnings: [
      ...(plan.skipped.length || plan.skippedDrafts.length
        ? ["EXACT_EXISTING_WORK_LOGS_WILL_BE_SKIPPED"]
        : []),
      ...(plan.overlap.overlap_count ? ["WORK_INTERVAL_OVERLAP"] : []),
    ],
  };
}
export async function commitTimeImport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  operationId: string,
): Promise<Change> {
  requireImport(principal);
  exactKeys(input, ["preview_id"]);
  const previewId = text(input, "preview_id"),
    preview = (
      await tx.query<{
        command: string;
        input: Input;
        consumed_at: string | null;
        expires_at: string;
      }>(
        "SELECT command,input,consumed_at,expires_at FROM command_previews WHERE preview_id=$1 AND owner_id=$2 FOR UPDATE",
        [previewId, principal.ownerId],
      )
    ).rows[0];
  if (!preview || preview.command !== COMMAND)
    throw new DomainError(
      "PREVIEW_REQUIRED",
      "A matching owner-bound work-log preview is required.",
      {},
      409,
    );
  if (
    preview.consumed_at ||
    new Date(preview.expires_at).getTime() <= Date.now()
  )
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Work-log preview expired or was already committed.",
      {},
      409,
    );
  const payload = object(preview.input);
  if (payload.preview_actor_id !== principal.actorId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Work-log preview belongs to another authorized actor.",
      {},
      403,
    );
  if (payload.time_state_hash !== (await timeState(tx, principal.ownerId)))
    throw new DomainError(
      "REVISION_CONFLICT",
      "Work logs changed after this preview; review the import again.",
      {},
      409,
    );
  const data = importData({ data: payload.data }),
    plan = await planImport(tx, data, principal);
  let created: Input[] = [];
  if (plan.create.length) {
    created = cleanRows(
      (
        await tx.query<Input>(
          `INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at,description,task_id,reporting_policy,reported_minutes,legacy_metadata)
      SELECT e.entry_id,$1,e.employer,e.starts_at,e.ends_at,e.description,e.task_id,e.reporting_policy,e.reported_minutes,e.legacy_metadata FROM jsonb_to_recordset($2::jsonb)
      AS e(entry_id text,employer text,starts_at timestamptz,ends_at timestamptz,description text,task_id text,reporting_policy text,reported_minutes double precision,legacy_metadata jsonb) RETURNING *`,
          [principal.ownerId, json(plan.create)],
        )
      ).rows,
    );
    const events = created.map((row) => ({
      event_id: id("A"),
      entity_id: row.entry_id,
      after: row,
    }));
    await tx.query(
      `INSERT INTO activity_events(event_id,owner_id,entity_id,event_type,actor_id,channel,operation_id,before,after)
      SELECT e.event_id,$1,e.entity_id,'time.entry_imported',$2,$3,$4,NULL,e.after FROM jsonb_to_recordset($5::jsonb)
      AS e(event_id text,entity_id text,after jsonb)`,
      [
        principal.ownerId,
        principal.actorId,
        principal.channel,
        operationId,
        json(events),
      ],
    );
  }
  if (plan.drafts.length) {
    await tx.query(
      'INSERT INTO time_drafts(owner_id,draft_id,employer,date,start,"end",end_next_day,description,timezone,legacy_metadata) SELECT $1,d.draft_id,d.employer,d.date,d.start,d."end",d.end_next_day,d.description,d.timezone,d.legacy_metadata FROM jsonb_to_recordset($2::jsonb) AS d(draft_id text,employer text,date text,start text,"end" text,end_next_day boolean,description text,timezone text,legacy_metadata jsonb)',
      [principal.ownerId, json(plan.drafts)],
    );
  }
  await tx.query(
    "UPDATE command_previews SET consumed_at=$3 WHERE preview_id=$1 AND owner_id=$2",
    [previewId, principal.ownerId, now()],
  );
  return {
    entityId: id("TIME_IMPORT"),
    before: null,
    after: {
      format: FORMAT,
      timezone: data.timezone,
      counts: {
        created: created.length,
        skipped: plan.skipped.length,
        drafts_created: plan.drafts.length,
        drafts_skipped: plan.skippedDrafts.length,
      },
      entry_ids: created.map((row) => String(row.entry_id)),
      skipped_entry_ids: plan.skipped,
    },
    affected: [
      ...new Set(
        plan.create.flatMap((entry) => (entry.task_id ? [entry.task_id] : [])),
      ),
    ],
  };
}
