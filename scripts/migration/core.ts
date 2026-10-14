import { createHash } from "node:crypto";
import {
  DomainError,
  WORKFLOW_STATUSES,
  type DomainService,
  type Principal,
  type JsonValue,
} from "../../shared/contracts";
import type { Database } from "../../server/db/database";
import { hash as domainHash } from "../../server/domain/core";

export const SOURCE_TABLES = [
  "Tasks",
  "Files",
  "Links",
  "Activity",
  "Settings",
  "Guide",
] as const;
export type SourceTable = (typeof SOURCE_TABLES)[number];
export type SourceRecord = Record<string, JsonValue>;
export interface SourceSnapshot {
  format?: string;
  capturedAt?: string;
  source?: Record<string, unknown>;
  tables: Record<SourceTable, SourceRecord[]>;
}
export interface QuarantinedRecord {
  table: SourceTable;
  source_id: string;
  reasons: string[];
  original_record: SourceRecord;
}
export interface MigrationPreparation {
  sourceHash: string;
  batchId: string;
  counts: Record<SourceTable, number>;
  tables: Record<SourceTable, SourceRecord[]>;
  rowHashes: Record<SourceTable, Record<string, string>>;
  quarantine: QuarantinedRecord[];
  warnings: string[];
  ready: boolean;
}
const KEYS: Record<SourceTable, string> = {
  Tasks: "task_id",
  Files: "file_record_id",
  Links: "link_id",
  Activity: "event_id",
  Settings: "key",
  Guide: "topic",
};
const TIME_FIELDS = [
  "created_at",
  "updated_at",
  "closed_at",
  "due_at",
  "uploaded_at",
  "archived_at",
  "ended_at",
  "occurred_at",
];
const priorities = ["Low", "Normal", "High", "Urgent"];
const categories = ["Study", "Research", "Work", "Admin", "Personal", "Other"];

/** Object keys and record identity order are canonical; user strings remain literal. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map(canonicalJson).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, item]) => JSON.stringify(key) + ":" + canonicalJson(item))
      .join(",") +
    "}"
  );
}
export function recordHash(record: unknown): string {
  return createHash("sha256").update(canonicalJson(record)).digest("hex");
}
export function sourceDate(value: JsonValue): string | null {
  if (value === "" || value === null) return null;
  if (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 2958465
  )
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000)
      .toISOString()
      .slice(0, 10);
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T00:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Deadline must be a verified local ISO date or spreadsheet DATE serial.",
    );
  return value;
}
function validInstant(value: unknown): boolean {
  return (
    typeof value === "string" &&
    /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function string(record: SourceRecord, key: string): string {
  return typeof record[key] === "string" ? (record[key] as string) : "";
}

export function prepareMigration(input: unknown): MigrationPreparation {
  if (!input || typeof input !== "object" || !("tables" in input))
    throw new DomainError(
      "INVALID_INPUT",
      "A complete six-table private source snapshot is required.",
    );
  const snapshot = input as SourceSnapshot;
  const tables = {} as Record<SourceTable, SourceRecord[]>;
  const quarantine: QuarantinedRecord[] = [];
  const rowHashes = {} as MigrationPreparation["rowHashes"];
  const counts = {} as MigrationPreparation["counts"];
  const reasons = new Map<SourceRecord, string[]>();
  for (const table of SOURCE_TABLES) {
    const rows = snapshot.tables[table];
    if (!Array.isArray(rows) || rows.length > 100000)
      throw new DomainError(
        "INVALID_INPUT",
        "Snapshot must contain all six bounded tables.",
        { table },
      );
    tables[table] = rows
      .filter(
        (row) =>
          row &&
          typeof row === "object" &&
          !Array.isArray(row) &&
          Object.values(row).some((v) => v !== "" && v !== null),
      )
      .map((row) => ({ ...row }));
    counts[table] = tables[table].length;
    rowHashes[table] = Object.create(null);
    const byId = new Map<string, SourceRecord[]>();
    for (const row of tables[table]) {
      const id = string(row, KEYS[table]);
      const problems: string[] = [];
      if (!id || id.length > 512) problems.push("missing_or_invalid_stable_id");
      if (table !== "Settings" && table !== "Guide") {
        if (
          ["Tasks", "Files", "Links"].includes(table) &&
          (!Number.isInteger(row.revision) || Number(row.revision) < 1)
        )
          problems.push("invalid_revision");
        for (const key of TIME_FIELDS)
          if (
            row[key] !== undefined &&
            row[key] !== "" &&
            row[key] !== null &&
            !validInstant(row[key])
          )
            problems.push("invalid_timestamp:" + key);
      }
      if (table === "Tasks") {
        if (!string(row, "title")) problems.push("missing_title");
        if (!validInstant(row.created_at) || !validInstant(row.updated_at))
          problems.push("missing_required_timestamp");
        if (
          !WORKFLOW_STATUSES.includes(
            row.status as (typeof WORKFLOW_STATUSES)[number],
          )
        )
          problems.push("unknown_status");
        if (!priorities.includes(string(row, "priority")))
          problems.push("unknown_priority");
        if (!categories.includes(string(row, "category")))
          problems.push("unknown_category");
        try {
          const date = sourceDate(row.due_date ?? null);
          if (typeof row.due_date === "number") row.due_date = date;
        } catch {
          problems.push("ambiguous_date");
        }
      }
      if (table === "Files") {
        if (!validInstant(row.uploaded_at) || !validInstant(row.updated_at))
          problems.push("missing_required_timestamp");
        if (
          !["Inbox", "Active", "Old", "External"].includes(string(row, "state"))
        )
          problems.push("unknown_file_state");
        if (!string(row, "drive_file_id")) problems.push("missing_drive_id");
        if (row.sha256 && !/^[a-fA-F0-9]{64}$/.test(string(row, "sha256")))
          problems.push("invalid_checksum");
      }
      if (table === "Links") {
        if (!validInstant(row.created_at))
          problems.push("missing_required_timestamp");
        if (typeof row.active !== "boolean")
          problems.push("invalid_link_boolean");
        if (
          !["Input", "Reference", "Output", "Other"].includes(
            string(row, "relation"),
          )
        )
          problems.push("unknown_relation");
      }
      if (table === "Activity") {
        if (!["Pending", "Succeeded", "Failed"].includes(string(row, "result")))
          problems.push("unknown_activity_result");
        if (!validInstant(row.occurred_at))
          problems.push("missing_required_timestamp");
      }
      reasons.set(row, problems);
      byId.set(id, [...(byId.get(id) ?? []), row]);
      rowHashes[table][id] = recordHash(row);
    }
    for (const matching of byId.values())
      if (matching.length > 1)
        for (const row of matching)
          reasons.get(row)!.push("duplicate_stable_id");
  }
  const taskIds = new Set(tables.Tasks.map((row) => string(row, "task_id")));
  const fileIds = new Set(
    tables.Files.map((row) => string(row, "file_record_id")),
  );
  const driveIds = new Set<string>();
  for (const row of tables.Files) {
    const id = string(row, "drive_file_id");
    if (driveIds.has(id)) reasons.get(row)!.push("duplicate_drive_id");
    driveIds.add(id);
  }
  const triples = new Set<string>();
  for (const row of tables.Links) {
    if (!taskIds.has(string(row, "task_id")))
      reasons.get(row)!.push("missing_task");
    if (!fileIds.has(string(row, "file_record_id")))
      reasons.get(row)!.push("missing_file");
    if (row.active) {
      const triple = canonicalJson([
        row.task_id,
        row.file_record_id,
        row.relation,
      ]);
      if (triples.has(triple))
        reasons.get(row)!.push("duplicate_active_relation");
      triples.add(triple);
    }
  }
  for (const table of SOURCE_TABLES)
    for (const row of tables[table])
      if (reasons.get(row)!.length)
        quarantine.push({
          table,
          source_id: string(row, KEYS[table]),
          reasons: reasons.get(row)!,
          original_record: row,
        });
  const canonicalTables = Object.fromEntries(
    SOURCE_TABLES.map((table) => [
      table,
      [...tables[table]].sort((a, b) =>
        string(a, KEYS[table]).localeCompare(string(b, KEYS[table]), "en"),
      ),
    ]),
  );
  const sourceHash = recordHash(canonicalTables);
  return {
    sourceHash,
    batchId: "migration-" + sourceHash.slice(0, 32),
    counts,
    tables,
    rowHashes,
    quarantine,
    ready: quarantine.length === 0,
    warnings: [
      "Source provides no authoritative dependencies, hierarchy or checklist items; import creates none.",
    ],
  };
}

export function compareSnapshots(
  previous: MigrationPreparation,
  current: MigrationPreparation,
) {
  const delta = Object.fromEntries(
    SOURCE_TABLES.map((table) => {
      const old = previous.rowHashes[table],
        next = current.rowHashes[table];
      return [
        table,
        {
          added: Object.keys(next).filter((id) => !(id in old)),
          changed: Object.keys(next).filter(
            (id) => id in old && old[id] !== next[id],
          ),
          missing: Object.keys(old).filter((id) => !(id in next)),
        },
      ];
    }),
  );
  return {
    unchanged: previous.sourceHash === current.sourceHash,
    previous_hash: previous.sourceHash,
    current_hash: current.sourceHash,
    delta,
    delete_source_records: false,
  };
}
export function migrationCommandInput(
  prepared: MigrationPreparation,
): Record<string, unknown> {
  if (!prepared.ready)
    throw new DomainError(
      "INVALID_INPUT",
      "Migration has quarantined records; resolve before committing.",
      { quarantine_count: prepared.quarantine.length },
    );
  const ordered = (table: SourceTable) =>
    [...prepared.tables[table]].sort((a, b) =>
      string(a, KEYS[table]).localeCompare(string(b, KEYS[table]), "en"),
    );
  return {
    batch_id: prepared.batchId,
    source_hash: prepared.sourceHash,
    tasks: ordered("Tasks"),
    files: ordered("Files"),
    links: ordered("Links"),
    activity: ordered("Activity"),
    settings: ordered("Settings"),
    guide: ordered("Guide"),
    source_metadata: {
      counts: prepared.counts,
      row_hashes: prepared.rowHashes,
      graph_records_created: 0,
    },
  };
}
export async function importPrepared(
  service: DomainService,
  prepared: MigrationPreparation,
  principal: Principal,
) {
  return service.execute(
    "legacy_import",
    migrationCommandInput(prepared),
    { ...principal, channel: "import" },
    { idempotencyKey: prepared.batchId },
  );
}

const sourceNullable = (value: unknown) =>
  value === undefined || value === null || value === "" ? null : value;
function sourceJson(value: unknown): unknown {
  if (typeof value === "string" && value) {
    try {
      return JSON.parse(value);
    } catch {
      return { unparsed_legacy_json: value };
    }
  }
  return value ?? null;
}
/** Compare instants semantically; exact source spelling remains in legacy_metadata. */
function sameCanonicalValue(field: string, actual: unknown, expected: unknown) {
  if (expected === null) return actual === null;
  if (field.endsWith("_at")) {
    const left =
      actual instanceof Date ? actual.getTime() : Date.parse(String(actual));
    const right = Date.parse(String(expected));
    return Number.isFinite(left) && left === right;
  }
  if (field === "size_bytes")
    return (
      /^(0|[1-9]\d*)$/.test(String(actual)) &&
      /^(0|[1-9]\d*)$/.test(String(expected)) &&
      BigInt(String(actual)) === BigInt(String(expected))
    );
  return canonicalJson(actual) === canonicalJson(expected);
}
function mismatchedFields(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  return Object.entries(expected)
    .filter(
      ([field, value]) => !sameCanonicalValue(field, actual[field], value),
    )
    .map(([field]) => field);
}
function canonicalSourceRow(
  table: SourceTable,
  source: SourceRecord,
  owner: string,
) {
  const id = string(source, KEYS[table]);
  if (table === "Tasks") {
    const project = sourceNullable(source.project);
    return {
      task_id: id,
      owner_id: owner,
      project_id: project
        ? `P-legacy-${domainHash({ owner, project }).slice(0, 24)}`
        : null,
      title: source.title,
      status: source.status,
      priority: source.priority,
      category: source.category,
      notes: source.notes ?? "",
      next_action: source.next_action ?? "",
      waiting_for: source.waiting_for ?? "",
      source_reference: source.source_reference ?? "",
      due_date: sourceNullable(source.due_date),
      due_at: sourceNullable(source.due_at),
      created_at: source.created_at,
      updated_at: source.updated_at,
      closed_at: sourceNullable(source.closed_at),
      completed_at:
        source.status === "Done" ? sourceNullable(source.closed_at) : null,
      revision: source.revision,
      parent_task_id: null,
      start_date: null,
    };
  }
  if (table === "Files")
    return {
      file_id: id,
      owner_id: owner,
      title: source.display_name ?? source.original_filename ?? id,
      original_filename: source.original_filename ?? "",
      provider: "google_drive",
      external_id: sourceNullable(source.drive_file_id),
      external_url: sourceNullable(source.drive_url),
      storage_key: null,
      state: source.state,
      mime_type: source.mime_type ?? "application/octet-stream",
      size_bytes: sourceNullable(source.size_bytes),
      sha256: sourceNullable(source.sha256),
      version_group_id: sourceNullable(source.version_group_id) ?? id,
      parent_id: sourceNullable(source.parent_folder_id),
      last_active_parent_id: sourceNullable(source.last_active_parent_id),
      protected: source.state === "External",
      archived_at: sourceNullable(source.archived_at),
      created_at: source.uploaded_at,
      updated_at: source.updated_at,
      revision: source.revision,
    };
  if (table === "Links")
    return {
      link_id: id,
      owner_id: owner,
      file_id: source.file_record_id,
      task_id: source.task_id,
      purpose: source.relation ?? source.purpose ?? "Reference",
      active: source.active === true,
      created_at: source.created_at,
      ended_at: sourceNullable(source.ended_at),
      notes: source.notes ?? "",
      revision: source.revision,
    };
  return {
    event_id: id,
    owner_id: owner,
    entity_id:
      source.entity_id ?? source.task_id ?? source.file_record_id ?? id,
    event_type: `legacy.${source.action ?? "event"}`,
    actor_id: source.actor ?? "unknown_legacy_actor",
    channel: "import",
    operation_id: source.operation_id ?? `OP-legacy-${id}`,
    before: sourceJson(source.before_json),
    after: sourceJson(source.after_json),
    reason: sourceNullable(source.note),
    occurred_at: source.occurred_at,
  };
}

/** Reconcile immutable identities, real normalized fields and complete retained attrs. */
export async function reconcileMigration(
  database: Database,
  ownerId: string,
  prepared: MigrationPreparation,
) {
  const mappings: Record<string, [string, string]> = {
    Tasks: ["tasks", "task_id"],
    Files: ["files", "file_id"],
    Links: ["file_task_links", "link_id"],
    Activity: ["activity_events", "event_id"],
  };
  const results: Record<
    string,
    {
      source: number;
      destination: number;
      missing: string[];
      changed: string[];
      canonical_mismatches: Record<string, string[]>;
    }
  > = {};
  const projects = new Map(
    (
      await database.query<Record<string, unknown>>(
        "SELECT * FROM projects WHERE owner_id=$1",
        [ownerId],
      )
    ).rows.map((row) => [String(row.project_id), row]),
  );
  const versions = new Map(
    (
      await database.query<Record<string, unknown>>(
        "SELECT * FROM file_versions WHERE owner_id=$1",
        [ownerId],
      )
    ).rows.map((row) => [String(row.version_id), row]),
  );
  const sourceMappings = new Map(
    (
      await database.query<Record<string, unknown>>(
        "SELECT * FROM source_mappings WHERE owner_id=$1",
        [ownerId],
      )
    ).rows.map((row) => [canonicalJson([row.source_kind, row.source_id]), row]),
  );
  for (const table of ["Tasks", "Files", "Links", "Activity"] as const) {
    const [sqlTable, idField] = mappings[table];
    const rows = (
      await database.query<Record<string, unknown>>(
        (table === "Tasks"
          ? "SELECT *,due_date::text AS due_date,start_date::text AS start_date FROM tasks"
          : "SELECT * FROM " + sqlTable) + " WHERE owner_id=$1",
        [ownerId],
      )
    ).rows;
    const byId = new Map(rows.map((row) => [String(row[idField]), row]));
    const missing: string[] = [],
      changed: string[] = [];
    const canonicalMismatches: Record<string, string[]> = Object.create(null);
    let destination = 0;
    for (const source of prepared.tables[table]) {
      const id = string(source, KEYS[table]);
      const row = byId.get(id);
      if (!row) {
        missing.push(id);
        continue;
      }
      destination++;
      const retained = row.legacy_metadata;
      const fields = mismatchedFields(
        row,
        canonicalSourceRow(table, source, ownerId),
      );
      const mapping = sourceMappings.get(canonicalJson([table, id]));
      if (
        !mapping ||
        mapping.destination_id !== id ||
        mapping.source_hash !== domainHash(source)
      )
        fields.push("source_mapping");
      if (table === "Tasks" && sourceNullable(source.project)) {
        const project = sourceNullable(source.project);
        const projectId = `P-legacy-${domainHash({ owner: ownerId, project }).slice(0, 24)}`;
        const actual = projects.get(projectId);
        if (
          !actual ||
          actual.title !== String(project) ||
          recordHash(actual.legacy_metadata) !==
            recordHash({ source_project: project })
        )
          fields.push("project_source");
      }
      if (table === "Files") {
        const versionId = `V-legacy-${domainHash({ owner: ownerId, fileId: id }).slice(0, 24)}`;
        const original = versions.get(versionId);
        const versionFields = original
          ? mismatchedFields(original, {
              version_id: versionId,
              owner_id: ownerId,
              file_id: id,
              storage_key: null,
              sha256: sourceNullable(source.sha256),
              size_bytes: sourceNullable(source.size_bytes),
              created_at: source.uploaded_at,
            })
          : ["missing"];
        fields.push(
          ...versionFields.map((field) => "original_version." + field),
        );
      }
      if (fields.length) canonicalMismatches[id] = fields;
      if (fields.length || recordHash(retained) !== recordHash(source))
        changed.push(id);
    }
    results[table] = {
      source: prepared.counts[table],
      destination,
      missing,
      changed,
      canonical_mismatches: canonicalMismatches,
    };
  }
  const batches = (
    await database.query<{
      source_metadata: Record<string, unknown>;
      source_hash: string;
      status: string;
    }>(
      "SELECT source_metadata,source_hash,status FROM migration_batches WHERE owner_id=$1 AND batch_id=$2",
      [ownerId, prepared.batchId],
    )
  ).rows;
  const metadata = batches[0]?.source_metadata;
  const orderedRows = (table: SourceTable, rows: unknown) =>
    Array.isArray(rows)
      ? [...rows].sort((a, b) =>
          string(a as SourceRecord, KEYS[table]).localeCompare(
            string(b as SourceRecord, KEYS[table]),
            "en",
          ),
        )
      : [];
  const guidesPreserved =
    !!metadata &&
    recordHash(orderedRows("Guide", metadata.guide ?? metadata.Guide)) ===
      recordHash(orderedRows("Guide", prepared.tables.Guide));
  const settingsPreserved =
    !!metadata &&
    recordHash(
      orderedRows("Settings", metadata.settings ?? metadata.Settings),
    ) === recordHash(orderedRows("Settings", prepared.tables.Settings));
  const preferences = (
    await database.query<{ settings: Record<string, unknown> }>(
      "SELECT settings FROM preferences WHERE owner_id=$1",
      [ownerId],
    )
  ).rows[0]?.settings;
  const canonicalSettingsPreserved =
    !!preferences &&
    recordHash(preferences.legacy_settings) ===
      recordHash(
        Object.fromEntries(
          prepared.tables.Settings.map((row) => [
            string(row, "key"),
            row.value ?? null,
          ]),
        ),
      );
  const canonicalGuidePreserved =
    !!preferences &&
    recordHash(orderedRows("Guide", preferences.legacy_guide)) ===
      recordHash(orderedRows("Guide", prepared.tables.Guide));
  const batchVerified =
    batches[0]?.source_hash === prepared.sourceHash &&
    batches[0]?.status === "Verified import";
  return {
    batch_id: prepared.batchId,
    results,
    guides_preserved: guidesPreserved,
    settings_preserved: settingsPreserved,
    canonical_settings_preserved: canonicalSettingsPreserved,
    canonical_guide_preserved: canonicalGuidePreserved,
    batch_verified: batchVerified,
    source_unchanged: true,
    pass:
      Object.values(results).every(
        (result) => result.missing.length === 0 && result.changed.length === 0,
      ) &&
      guidesPreserved &&
      settingsPreserved &&
      canonicalSettingsPreserved &&
      canonicalGuidePreserved &&
      batchVerified,
  };
}
