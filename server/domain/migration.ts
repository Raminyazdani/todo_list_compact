import { DomainError, type Principal } from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import { array, hash, id, json, object, text, type Input } from "./core";
import type { Change } from "./tasks";

export const BACKUP_TABLES = [
  "projects",
  "tasks",
  "task_dependency_groups",
  "task_dependency_edges",
  "task_checklists",
  "task_checklist_items",
  "task_templates",
  "task_recurrence_rules",
  "task_recurrence_instances",
  "task_recurrence_instance_tasks",
  "routines",
  "routine_schedules",
  "routine_checkins",
  "project_milestones",
  "files",
  "file_annotations",
  "file_versions",
  "file_task_links",
  "task_comments",
  "tags",
  "task_tags",
  "knowledge_items",
  "calendar_events",
  "event_reminders",
  "time_entries",
  "time_drafts",
  "work_contract_policies",
  "calendar_sources",
  "calendar_external_events",
  "calendar_mutation_intents",
  "preferences",
  "daily_focus_days",
  "daily_focus_items",
  "saved_views",
  "reminders",
  "notifications",
  "activity_events",
  "migration_batches",
  "source_mappings",
  "migration_quarantine",
  "outbox",
  "idempotency_operations",
] as const;
const nullable = (val: unknown) =>
  val === undefined || val === null || val === "" ? null : val;
const originalTime = (val: unknown) =>
  nullable(val) ?? new Date().toISOString();
function parsed(val: unknown): unknown {
  if (typeof val === "string" && val) {
    try {
      return JSON.parse(val);
    } catch {
      return { unparsed_legacy_json: val };
    }
  }
  return val ?? null;
}
export async function legacyImport(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<Change> {
  const owner = principal.ownerId,
    batchId = text(input, "batch_id"),
    sourceHash = text(input, "source_hash");
  if (principal.channel !== "import" && principal.channel !== "UI")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Import requires a trusted owner import channel.",
      {},
      403,
    );
  const previous = await tx.query<Input>(
    "SELECT * FROM migration_batches WHERE batch_id=$1 AND owner_id=$2",
    [batchId, owner],
  );
  if (previous.rows[0]) {
    if (previous.rows[0].source_hash !== sourceHash)
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "Batch ID belongs to a different source snapshot.",
        {},
        409,
      );
    return {
      entityId: batchId,
      before: previous.rows[0],
      after: previous.rows[0],
      affected: [],
    };
  }
  const tasks = array(input.tasks ?? [], 50000),
    files = array(input.files ?? [], 50000),
    links = array(input.links ?? [], 100000),
    activity = array(input.activity ?? [], 200000),
    settings = array(input.settings ?? [], 10000),
    guide = array(input.guide ?? [], 10000);
  const counts = {
    tasks: 0,
    files: 0,
    links: 0,
    activity: 0,
    settings: settings.length,
    guide: guide.length,
    quarantined: 0,
  };
  const conflicts: Input[] = [];
  await tx.query(
    "INSERT INTO migration_batches(batch_id,owner_id,source_hash,status,source_metadata) VALUES($1,$2,$3,$4,$5::jsonb)",
    [
      batchId,
      owner,
      sourceHash,
      "Importing",
      json({
        tasks,
        files,
        links,
        activity,
        settings,
        guide,
        source_metadata: input.source_metadata ?? {},
      }),
    ],
  );
  const sourceMap = async (
    kind: string,
    sourceId: string,
    destinationId: string,
    row: Input,
  ) => {
    await tx.query(
      "INSERT INTO source_mappings(owner_id,source_kind,source_id,destination_id,batch_id,source_hash) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(owner_id,source_kind,source_id) DO UPDATE SET batch_id=$5,source_hash=$6",
      [owner, kind, sourceId, destinationId, batchId, hash(row)],
    );
  };
  const quarantine = async (
    kind: string,
    sourceId: string,
    row: Input,
    reason: string,
  ) => {
    counts.quarantined++;
    conflicts.push({ source_kind: kind, source_id: sourceId, reason });
    await tx.query(
      "INSERT INTO migration_quarantine(quarantine_id,owner_id,batch_id,source_kind,source_id,reason,original_record) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [id("Q"), owner, batchId, kind, sourceId, reason, json(row)],
    );
  };
  const priorMapping = async (kind: string, sourceId: string, row: Input) => {
    const mapped = await tx.query<{ source_hash: string }>(
      "SELECT source_hash FROM source_mappings WHERE owner_id=$1 AND source_kind=$2 AND source_id=$3",
      [owner, kind, sourceId],
    );
    if (!mapped.rows[0]) return "new";
    return mapped.rows[0].source_hash === hash(row) ? "same" : "changed";
  };
  for (const row of tasks) {
    const taskId = text(row, "task_id"),
      existing = await tx.query<Input>("SELECT * FROM tasks WHERE task_id=$1", [
        taskId,
      ]);
    if (existing.rows[0]) {
      if (existing.rows[0].owner_id !== owner)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Source identity conflicts with another owner.",
          {},
          403,
        );
      const state = await priorMapping("Tasks", taskId, row);
      if (state !== "same")
        await quarantine(
          "Tasks",
          taskId,
          row,
          "EXISTING_DESTINATION_REQUIRES_CONFLICT_REVIEW",
        );
      continue;
    }
    let projectId: string | null = null;
    const project = nullable(row.project);
    if (project) {
      projectId = `P-legacy-${hash({ owner, project }).slice(0, 24)}`;
      await tx.query(
        "INSERT INTO projects(project_id,owner_id,title,legacy_metadata) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT DO NOTHING",
        [projectId, owner, String(project), json({ source_project: project })],
      );
    }
    await tx.query(
      `INSERT INTO tasks(task_id,owner_id,project_id,title,status,priority,category,due_date,next_action,waiting_for,due_at,notes,created_at,updated_at,closed_at,completed_at,source_reference,revision,legacy_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)`,
      [
        taskId,
        owner,
        projectId,
        text(row, "title"),
        text(row, "status", "Inbox"),
        text(row, "priority", "Normal"),
        text(row, "category", "Other"),
        nullable(row.due_date),
        row.next_action ?? "",
        row.waiting_for ?? "",
        nullable(row.due_at),
        row.notes ?? "",
        originalTime(row.created_at),
        originalTime(row.updated_at),
        nullable(row.closed_at),
        row.status === "Done" ? nullable(row.closed_at) : null,
        row.source_reference ?? "",
        row.revision ?? 1,
        json(row),
      ],
    );
    counts.tasks++;
    await sourceMap("Tasks", taskId, taskId, row);
  }
  for (const row of files) {
    const fileId = text(
      row,
      "file_record_id",
      typeof row.file_id === "string" ? row.file_id : undefined,
    );
    const existing = await tx.query<Input>(
      "SELECT * FROM files WHERE file_id=$1",
      [fileId],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].owner_id !== owner)
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "File identity belongs to another owner.",
          {},
          403,
        );
      if ((await priorMapping("Files", fileId, row)) !== "same")
        await quarantine(
          "Files",
          fileId,
          row,
          "EXISTING_DESTINATION_REQUIRES_CONFLICT_REVIEW",
        );
      continue;
    }
    await tx.query(
      `INSERT INTO files(file_id,owner_id,title,original_filename,provider,external_id,external_url,state,mime_type,size_bytes,sha256,version_group_id,parent_id,last_active_parent_id,archived_at,created_at,updated_at,revision,legacy_metadata,protected) VALUES($1,$2,$3,$4,'google_drive',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)`,
      [
        fileId,
        owner,
        row.display_name ?? row.original_filename ?? fileId,
        row.original_filename ?? "",
        nullable(row.drive_file_id),
        nullable(row.drive_url),
        row.state ?? "Inbox",
        row.mime_type ?? "application/octet-stream",
        nullable(row.size_bytes),
        nullable(row.sha256),
        nullable(row.version_group_id) ?? fileId,
        nullable(row.parent_folder_id),
        nullable(row.last_active_parent_id),
        nullable(row.archived_at),
        originalTime(row.uploaded_at),
        originalTime(row.updated_at),
        row.revision ?? 1,
        json(row),
        row.state === "External",
      ],
    );
    counts.files++;
    await sourceMap("Files", fileId, fileId, row);
    await tx.query(
      "INSERT INTO file_versions(version_id,owner_id,file_id,sha256,size_bytes,created_at) VALUES($1,$2,$3,$4,$5,$6)",
      [
        `V-legacy-${hash({ owner, fileId }).slice(0, 24)}`,
        owner,
        fileId,
        nullable(row.sha256),
        nullable(row.size_bytes),
        originalTime(row.uploaded_at),
      ],
    );
  }
  for (const row of links) {
    const linkId = text(row, "link_id"),
      fileId = text(
        row,
        "file_record_id",
        typeof row.file_id === "string" ? row.file_id : undefined,
      ),
      taskId = text(row, "task_id");
    const exists = await tx.query(
      "SELECT link_id FROM file_task_links WHERE link_id=$1 AND owner_id=$2",
      [linkId, owner],
    );
    if (exists.rows.length) {
      if ((await priorMapping("Links", linkId, row)) !== "same")
        await quarantine(
          "Links",
          linkId,
          row,
          "EXISTING_LINK_REQUIRES_CONFLICT_REVIEW",
        );
      continue;
    }
    const targets = await tx.query(
      "SELECT t.task_id,f.file_id FROM tasks t JOIN files f ON f.owner_id=t.owner_id WHERE t.task_id=$1 AND f.file_id=$2 AND t.owner_id=$3",
      [taskId, fileId, owner],
    );
    if (!targets.rows.length) {
      await quarantine("Links", linkId, row, "ORPHAN_LINK");
      continue;
    }
    await tx.query(
      "INSERT INTO file_task_links(link_id,owner_id,file_id,task_id,purpose,active,created_at,ended_at,notes,revision,legacy_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
      [
        linkId,
        owner,
        fileId,
        taskId,
        row.relation ?? row.purpose ?? "Reference",
        row.active === true || row.active === "TRUE",
        originalTime(row.created_at),
        nullable(row.ended_at),
        row.notes ?? "",
        row.revision ?? 1,
        json(row),
      ],
    );
    counts.links++;
    await sourceMap("Links", linkId, linkId, row);
  }
  for (const row of activity) {
    const eventId = text(row, "event_id");
    const exists = await tx.query(
      "SELECT event_id FROM activity_events WHERE event_id=$1",
      [eventId],
    );
    if (exists.rows.length) continue;
    await tx.query(
      "INSERT INTO activity_events(event_id,owner_id,entity_id,event_type,actor_id,channel,operation_id,before,after,reason,occurred_at,legacy_metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12::jsonb)",
      [
        eventId,
        owner,
        row.entity_id ?? row.task_id ?? row.file_record_id ?? eventId,
        `legacy.${row.action ?? "event"}`,
        row.actor ?? "unknown_legacy_actor",
        "import",
        row.operation_id ?? `OP-legacy-${eventId}`,
        json(parsed(row.before_json)),
        json(parsed(row.after_json)),
        nullable(row.note),
        originalTime(row.occurred_at),
        json(row),
      ],
    );
    counts.activity++;
    await sourceMap("Activity", eventId, eventId, row);
  }
  const pref = Object.fromEntries(
    settings.map((row) => [text(row, "key"), row.value ?? null]),
  );
  await tx.query(
    "INSERT INTO preferences(owner_id,settings) VALUES($1,$2::jsonb) ON CONFLICT(owner_id) DO UPDATE SET settings=preferences.settings||$2::jsonb,revision=preferences.revision+1",
    [owner, json({ legacy_settings: pref, legacy_guide: guide })],
  );
  await tx.query(
    "UPDATE migration_batches SET status=$3,counts=$4::jsonb,conflicts=$5::jsonb WHERE batch_id=$1 AND owner_id=$2",
    [
      batchId,
      owner,
      conflicts.length ? "Needs review" : "Verified import",
      json(counts),
      json(conflicts),
    ],
  );
  return {
    entityId: batchId,
    before: null,
    after: {
      batch_id: batchId,
      source_hash: sourceHash,
      counts,
      conflicts,
      cutover_status: "not_authorized",
    },
    affected: tasks.map((t) => String(t.task_id)),
  };
}
const ADDITIVE_BACKUP_TABLES: readonly string[] = [
  "routines",
  "routine_schedules",
  "routine_checkins",
  "daily_focus_days",
  "daily_focus_items",
  "time_drafts",
  "work_contract_policies",
  "calendar_sources",
  "calendar_external_events",
  "calendar_mutation_intents",
  "file_annotations",
  "event_reminders",
];
export async function exportBackup(
  tx: SqlClient,
  ownerId: string,
  options: { allowKnownMissingAdditions?: boolean } = {},
) {
  const tables: Record<string, Input[]> = {};
  const checksums: Record<string, string> = {};
  for (const table of BACKUP_TABLES) {
    // Coordinator pre-DDL snapshots may explicitly preserve the older v1 table
    // set. Probe only these registered additions; never ALTER during export.
    if (
      options.allowKnownMissingAdditions === true &&
      ADDITIVE_BACKUP_TABLES.includes(table)
    ) {
      const exists = (
        await tx.query<{ relation: string | null }>(
          "SELECT to_regclass($1) relation",
          ["public." + table],
        )
      ).rows[0].relation;
      if (exists === null) continue;
    }
    const rows = (
      await tx.query<Input>(`SELECT * FROM ${table} WHERE owner_id=$1`, [
        ownerId,
      ])
    ).rows;
    tables[table] = JSON.parse(json(rows));
    tables[table].sort((a, b) => json(a).localeCompare(json(b)));
    checksums[table] = hash(tables[table]);
  }
  return {
    format: "ramin-life-os/1",
    schema_version: 1,
    exported_at: new Date().toISOString(),
    owner_id: ownerId,
    tables,
    checksums,
    manifest_hash: hash(checksums),
  };
}
/** Verify the portable inner manifest independently of encryption/provider I/O. */
export function verifyBackupManifest(
  backup: Input,
  ownerId: string,
): Record<string, Input[]> {
  if (backup.format !== "ramin-life-os/1" || backup.schema_version !== 1)
    throw new DomainError("INVALID_INPUT", "Unsupported backup format.");
  if (backup.owner_id !== ownerId)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Backup belongs to another owner.",
      {},
      403,
    );
  const tables = object(backup.tables),
    checksums = object(backup.checksums);
  if (
    [...Object.keys(tables), ...Object.keys(checksums)].some(
      (table) => !(BACKUP_TABLES as readonly string[]).includes(table),
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Backup contains unsupported tables or checksum keys.",
    );
  if (hash(checksums) !== backup.manifest_hash)
    throw new DomainError(
      "INVALID_INPUT",
      "Backup manifest checksum mismatch.",
    );
  const verified: Record<string, Input[]> = {};
  for (const table of BACKUP_TABLES) {
    // Original schema-v1 snapshots lacked this registered additive table only.
    if (
      ADDITIVE_BACKUP_TABLES.includes(table) &&
      !Object.hasOwn(tables, table) &&
      !Object.hasOwn(checksums, table)
    ) {
      verified[table] = [];
      continue;
    }
    if (!Object.hasOwn(tables, table) || !Object.hasOwn(checksums, table))
      throw new DomainError(
        "INVALID_INPUT",
        `Backup table and checksum are required: ${table}.`,
      );
    const rows = array(tables[table] ?? [], 250000);
    if (hash(rows) !== checksums[table])
      throw new DomainError(
        "INVALID_INPUT",
        `Backup checksum mismatch: ${table}.`,
      );
    if (rows.some((row) => row.owner_id !== ownerId))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Backup rows contain inconsistent owner identities.",
        {},
        403,
      );
    verified[table] = rows;
  }
  return verified;
}
export async function restoreBackup(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<Change> {
  if (input.explicit_user_intent !== true || principal.channel === "AI")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Restoration requires explicit owner approval.",
      {},
      403,
    );
  const backup = object(input.backup);
  const tables = verifyBackupManifest(backup, principal.ownerId);
  for (const table of BACKUP_TABLES) {
    const count = await tx.query<{ count: string }>(
      `SELECT count(*) FROM ${table} WHERE owner_id=$1`,
      [principal.ownerId],
    );
    if (Number(count.rows[0].count) > 0)
      throw new DomainError(
        "INVALID_INPUT",
        "Restore requires a fresh isolated owner workspace.",
      );
  }
  const layouts = new Map<
    string,
    { columns: string[]; jsonColumns: Set<string> }
  >();
  for (const table of BACKUP_TABLES) {
    const columnRows = (
      await tx.query<{ column_name: string; data_type: string }>(
        "SELECT column_name,data_type FROM information_schema.columns WHERE table_name=$1 AND table_schema='public' ORDER BY ordinal_position",
        [table],
      )
    ).rows;
    const columns = columnRows.map((r) => r.column_name);
    const jsonColumns = new Set(
      columnRows
        .filter((r) => r.data_type === "jsonb" || r.data_type === "json")
        .map((r) => r.column_name),
    );
    for (const row of tables[table]) {
      if (Object.keys(row).some((column) => !columns.includes(column)))
        throw new DomainError(
          "INVALID_INPUT",
          `Backup contains unsupported columns: ${table}.`,
        );
    }
    layouts.set(table, { columns, jsonColumns });
  }
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const rows = tables[table],
      { columns, jsonColumns } = layouts.get(table)!;
    for (const row of rows) {
      const data: Input = { ...row, owner_id: principal.ownerId };
      const keys = columns.filter((c) => c in data);
      const vals = keys.map((c) => {
        const value = data[c];
        return jsonColumns.has(c) && value !== null ? json(value) : value;
      });
      await tx.query(
        `INSERT INTO ${table}(${keys.map((key) => '"' + key.replaceAll('"', '""') + '"').join(",")}) VALUES(${keys.map((_, index) => `$${index + 1}`).join(",")})`,
        vals,
      );
    }
    counts[table] = rows.length;
  }
  return {
    entityId: id("RESTORE"),
    before: null,
    after: { counts, manifest_hash: backup.manifest_hash },
    affected: array(tables.tasks ?? [], 250000).map((t) => String(t.task_id)),
  };
}
