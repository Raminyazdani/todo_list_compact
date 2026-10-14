import {
  DomainError,
  type DependencyDTO,
  type PageDTO,
  type PlanDTO,
  type Principal,
  type QueryName,
  type TaskDTO,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  cleanRows,
  choice,
  date,
  downstreamIds,
  entity,
  instant,
  normalizedSearch,
  number,
  requireScope,
  snapshot,
  taskFromSnapshot,
  text,
  timezone,
  type Input,
  type Snapshot,
} from "./core";
import { createPreview } from "./graph";
import { exportBackup } from "./migration";
import { archiveEligibility } from "./resources";
import {
  expandRecurrence,
  type RecurringEvent,
} from "../integrations/calendar";
import {
  externalCalendarEvents,
  externalCalendarList,
  externalCalendarStatus,
} from "../integrations/calendar-runtime";
import { resolveAiConfiguration } from "../integrations/ai-guard";
import { analyticsRange, analyticsTrends } from "./analytics";
import { fileMetadata, fileTags } from "./annotations";
import { reports } from "./reports";
import { taskOverdue } from "./deadline";
import { previewCalendarOccurrence } from "./calendar";
import { previewTimeImport } from "./time-import";
import { instantToLocalDate } from "../../shared/datetime";

async function calendarStatus(principal: Principal) {
  let sources: Awaited<ReturnType<typeof externalCalendarStatus>> = [];
  if (
    principal.scopes.includes("calendar:read") ||
    principal.scopes.includes("admin:manage")
  )
    try {
      sources = await externalCalendarStatus(principal);
    } catch {
      sources = [
        {
          provider: "external_calendar",
          status: "unavailable",
          last_success_at: null,
          error: "SOURCE_STATUS_UNAVAILABLE",
        },
      ];
    }
  return {
    connected: sources.some((source) => source.status === "connected"),
    state: sources.some((source) => source.status === "connected")
      ? "Connected"
      : sources.some(
            (source) =>
              source.status === "error" || source.status === "unavailable",
          )
        ? "Source read failed"
        : sources.some((source) => source.status === "awaiting_grant")
          ? "Awaiting grant"
          : "Not configured",
    sources,
  };
}
export function page<T>(
  items: T[],
  input: Input,
  getId: (value: T) => string,
): PageDTO<T> {
  const limit = input.limit === undefined ? 50 : number(input, "limit");
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new DomainError("INVALID_INPUT", "limit must be between 1 and 200.");
  let start = 0;
  if (input.cursor) {
    let value: string;
    try {
      value = Buffer.from(text(input, "cursor"), "base64url").toString();
    } catch {
      throw new DomainError("INVALID_INPUT", "Invalid cursor.");
    }
    const index = items.findIndex((item) => getId(item) === value);
    if (index < 0)
      throw new DomainError(
        "INVALID_INPUT",
        "Cursor no longer exists; refresh query.",
      );
    start = index + 1;
  }
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    total: items.length,
    next_cursor:
      start + limit < items.length
        ? Buffer.from(getId(slice[slice.length - 1])).toString("base64url")
        : null,
  };
}
export function topologicalPlan(data: Snapshot, tasks: TaskDTO[]): PlanDTO {
  const ids = new Set(tasks.map((t) => t.task_id)),
    degree = new Map(tasks.map((t) => [t.task_id, 0])),
    adj = new Map<string, string[]>();
  const hard = data.dependencies.filter(
    (e) =>
      e.mode === "hard" &&
      !e.waived_at &&
      ids.has(e.prerequisite_task_id) &&
      ids.has(e.dependent_task_id),
  );
  const boundaries = data.dependencies.filter(
    (edge) =>
      ids.has(edge.dependent_task_id) !== ids.has(edge.prerequisite_task_id),
  );
  const blockersByTask = new Map(
    tasks.map((task) => [
      task.task_id,
      new Set(task.blocked_by.map((blocker) => blocker.task_id)),
    ]),
  );
  const outsideBlockers = boundaries.filter(
    (edge) =>
      ids.has(edge.dependent_task_id) &&
      edge.mode === "hard" &&
      !edge.waived_at &&
      blockersByTask
        .get(edge.dependent_task_id)
        ?.has(edge.prerequisite_task_id),
  );
  for (const edge of hard) {
    degree.set(
      edge.dependent_task_id,
      (degree.get(edge.dependent_task_id) ?? 0) + 1,
    );
    const out = adj.get(edge.prerequisite_task_id) ?? [];
    out.push(edge.dependent_task_id);
    adj.set(edge.prerequisite_task_id, out);
  }
  const levels: string[][] = [];
  let current = [...degree]
      .filter(([, deg]) => deg === 0)
      .map(([taskId]) => taskId),
    count = 0;
  while (current.length) {
    levels.push(current);
    count += current.length;
    const next: string[] = [];
    for (const taskId of current)
      for (const dest of adj.get(taskId) ?? []) {
        degree.set(dest, degree.get(dest)! - 1);
        if (degree.get(dest) === 0) next.push(dest);
      }
    current = next;
  }
  if (count !== tasks.length)
    throw new DomainError(
      "DEPENDENCY_CYCLE",
      "Stored graph contains a cycle.",
      {},
      409,
    );
  const missing = tasks
    .filter((t) => t.estimated_minutes === null)
    .map((t) => t.task_id);
  let critical: string[] | null = null,
    total: number | null = null;
  if (
    !missing.length &&
    !outsideBlockers.length &&
    !hard.some((e) => e.operator === "ANY")
  ) {
    const distance = new Map<string, number>(),
      paths = new Map<string, string[]>();
    for (const taskId of levels.flat()) {
      const estimate = data.byId.get(taskId)!.estimated_minutes ?? 0;
      if (!distance.has(taskId)) {
        distance.set(taskId, estimate);
        paths.set(taskId, [taskId]);
      }
      for (const dest of adj.get(taskId) ?? []) {
        const candidate =
          distance.get(taskId)! + (data.byId.get(dest)!.estimated_minutes ?? 0);
        if (candidate > (distance.get(dest) ?? -1)) {
          distance.set(dest, candidate);
          paths.set(dest, [...paths.get(taskId)!, dest]);
        }
      }
    }
    const longest = [...distance].sort((a, b) => b[1] - a[1])[0];
    if (longest) {
      critical = paths.get(longest[0]) ?? [];
      total = longest[1];
    }
  }
  const risks = hard.flatMap((e) => {
    const p = data.byId.get(e.prerequisite_task_id),
      t = data.byId.get(e.dependent_task_id);
    return p?.due_date && t?.due_date && p.due_date > t.due_date
      ? [
          {
            task_id: t.task_id,
            prerequisite_task_id: p.task_id,
            reason: "PREREQUISITE_DUE_AFTER_DEPENDENT",
          },
        ]
      : [];
  });
  for (const edge of outsideBlockers)
    risks.push({
      task_id: edge.dependent_task_id,
      prerequisite_task_id: edge.prerequisite_task_id,
      reason: "PREREQUISITE_OUTSIDE_SELECTED_PLAN",
    });
  return {
    levels,
    ready_task_ids: tasks.filter((t) => t.ready_now).map((t) => t.task_id),
    critical_path: critical,
    total_estimated_minutes: total,
    missing_estimates: missing,
    schedule_risks: risks,
    boundary_edges: boundaries.slice(0, 1000),
    boundary_edges_truncated: boundaries.length > 1000,
    hidden_neighbor_count: new Set(
      boundaries.map((edge) =>
        ids.has(edge.dependent_task_id)
          ? edge.prerequisite_task_id
          : edge.dependent_task_id,
      ),
    ).size,
  };
}
function taskContext(data: Snapshot, input: Input): TaskDTO[] {
  const root = taskFromSnapshot(data, text(input, "task_id")),
    direction = choice(
      input,
      "direction",
      ["upstream", "downstream", "both"],
      "both",
    ),
    relevant = new Set([root.task_id]);
  if (direction === "downstream" || direction === "both")
    for (const taskId of downstreamIds(data, root.task_id))
      relevant.add(taskId);
  if (direction === "upstream" || direction === "both") {
    const upstream = new Map<string, string[]>();
    for (const edge of data.dependencies) {
      const neighbors = upstream.get(edge.dependent_task_id) ?? [];
      neighbors.push(edge.prerequisite_task_id);
      upstream.set(edge.dependent_task_id, neighbors);
    }
    const visited = new Set([root.task_id]),
      queue = [root.task_id];
    while (queue.length) {
      const current = queue.pop()!;
      for (const prerequisite of upstream.get(current) ?? [])
        if (!visited.has(prerequisite)) {
          visited.add(prerequisite);
          relevant.add(prerequisite);
          queue.push(prerequisite);
        }
    }
  }
  return [
    root,
    ...data.tasks.filter(
      (task) => task.task_id !== root.task_id && relevant.has(task.task_id),
    ),
  ];
}
function afterCompletionReady(task: TaskDTO, completedId: string) {
  const groups = new Map<string, DependencyDTO[]>();
  for (const e of task.prerequisites) {
    const group = groups.get(e.group_id) ?? [];
    group.push(e);
    groups.set(e.group_id, group);
  }
  return [...groups.values()].every((edges) => {
    const hard = edges.filter((e) => e.mode === "hard");
    const qualifies = (e: DependencyDTO) =>
      Boolean(e.waived_at) ||
      e.prerequisite_task_id === completedId ||
      e.status === "Done";
    return (
      !hard.length ||
      (edges[0].operator === "ANY"
        ? hard.some(qualifies)
        : hard.every(qualifies))
    );
  });
}
export async function domainQuery(
  tx: SqlClient,
  operation: QueryName,
  input: Input,
  principal: Principal,
): Promise<unknown> {
  const owner = principal.ownerId;
  if (operation === "time_entry_import_preview")
    return previewTimeImport(tx, input, principal);
  if (operation === "calendar_occurrence_reschedule_preview")
    return previewCalendarOccurrence(tx, input, principal);
  if (
    operation.endsWith("_preview") &&
    [
      "task_dependency_add_preview",
      "task_dependency_remove_preview",
      "task_dependency_waive_preview",
      "task_dependency_restore_preview",
      "subtask_reparent_preview",
      "task_template_instantiate_preview",
      "task_batch_preview",
    ].includes(operation)
  ) {
    requireScope(principal, "tasks", true);
    return createPreview(tx, operation, input, principal);
  }
  if (operation === "whoami")
    return {
      owner_id: owner,
      actor_id: principal.actorId,
      channel: principal.channel,
      scopes: principal.scopes,
    };
  if (operation === "system_capabilities") {
    let aiConfigured = false;
    try {
      resolveAiConfiguration();
      aiConfigured = true;
    } catch {
      /* Missing/stale provider authorization remains disabled. */
    }
    return {
      canonical_store: "PostgreSQL",
      schema_version: 1,
      graph: true,
      checklists: true,
      hierarchy: true,
      templates: true,
      external_calendar_write: false,
      email_send: false,
      ai_configured: aiConfigured,
      AI_configured: aiConfigured,
      oauth_client_configured: Boolean(
        process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET,
      ),
      storage_configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
      durable_database: true,
    };
  }
  if (operation === "system_health") {
    await tx.query("SELECT 1");
    const latest = cleanRows(
      (
        await tx.query<Input>(
          "SELECT status,created_at,verified_at,errorcode FROM backup_runs WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 1",
          [owner],
        )
      ).rows,
    )[0];
    const verified = cleanRows(
      (
        await tx.query<Input>(
          "SELECT verified_at FROM backup_runs WHERE owner_id=$1 AND status='verified' AND verified_at IS NOT NULL ORDER BY verified_at DESC LIMIT 1",
          [owner],
        )
      ).rows,
    )[0];
    return {
      status: "ok",
      database: "connected",
      latest_verified_backup_at: verified?.verified_at ?? null,
      backup_status:
        latest?.status ??
        (process.env.BLOB_READ_WRITE_TOKEN ? "none" : "disconnected"),
      backup_error_code: latest?.errorcode ?? null,
      private_storage_configured: Boolean(process.env.BLOB_READ_WRITE_TOKEN),
    };
  }
  if (operation === "backup_export" || operation === "export_data_manifest") {
    if (
      !principal.scopes.includes("backup:export") &&
      !principal.scopes.includes("admin:manage")
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "backup:export scope required.",
        {},
        403,
      );
    const backup = await exportBackup(tx, owner);
    return operation === "backup_export"
      ? backup
      : {
          schema_version: backup.schema_version,
          checksums: backup.checksums,
          manifest_hash: backup.manifest_hash,
          counts: Object.fromEntries(
            Object.entries(backup.tables).map(([table, rows]) => [
              table,
              rows.length,
            ]),
          ),
        };
  }
  if (operation === "preferences_get") {
    requireScope(principal, "tasks");
    return (
      cleanRows(
        (
          await tx.query(
            "SELECT settings,revision FROM preferences WHERE owner_id=$1",
            [owner],
          )
        ).rows,
      )[0] ?? { settings: {}, revision: 0 }
    );
  }
  if (operation === "knowledge_get" || operation === "knowledge_search") {
    requireScope(principal, "projects");
    if (operation === "knowledge_get")
      return entity(
        tx,
        "knowledge_items",
        "knowledge_id",
        text(input, "knowledge_id"),
        owner,
      );
    const rows = cleanRows(
      (
        await tx.query<Input>(
          "SELECT * FROM knowledge_items WHERE owner_id=$1 ORDER BY title,knowledge_id",
          [owner],
        )
      ).rows,
    ).filter(
      (r) =>
        (!input.project_id || r.project_id === input.project_id) &&
        (!input.search ||
          normalizedSearch(String(r.title) + " " + String(r.body)).includes(
            normalizedSearch(text(input, "search")),
          )),
    );
    return page(rows, input, (r) => String(r.knowledge_id));
  }
  if (operation === "tag_list") {
    requireScope(principal, "tasks");
    return page(
      cleanRows(
        (
          await tx.query<Input>(
            "SELECT * FROM tags WHERE owner_id=$1 ORDER BY title,tag_id",
            [owner],
          )
        ).rows,
      ),
      input,
      (r) => String(r.tag_id),
    );
  }
  if (operation === "task_comment_list") {
    requireScope(principal, "tasks");
    const taskId = text(input, "task_id");
    await entity(tx, "tasks", "task_id", taskId, owner);
    return page(
      cleanRows(
        (
          await tx.query<Input>(
            "SELECT * FROM task_comments WHERE task_id=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY created_at,comment_id",
            [taskId, owner],
          )
        ).rows,
      ),
      input,
      (r) => String(r.comment_id),
    );
  }
  if (operation === "notifications_list") {
    const tasksAllowed =
        principal.scopes.includes("admin:manage") ||
        principal.scopes.includes("tasks:read"),
      calendarAllowed =
        principal.scopes.includes("admin:manage") ||
        principal.scopes.includes("calendar:read");
    if (!tasksAllowed && !calendarAllowed) requireScope(principal, "tasks");
    return page(
      cleanRows(
        (
          await tx.query<Input>(
            "SELECT * FROM notifications WHERE owner_id=$1 AND ((target_type='task' AND $2) OR (target_type='calendar' AND $3)) ORDER BY created_at DESC,notification_id",
            [owner, tasksAllowed, calendarAllowed],
          )
        ).rows,
      ),
      input,
      (r) => String(r.notification_id),
    );
  }
  if (operation === "task_recurrence_list") {
    requireScope(principal, "tasks");
    const rows = cleanRows(
      (
        await tx.query<Input>(
          "SELECT * FROM task_recurrence_rules WHERE owner_id=$1 ORDER BY created_at,rule_id",
          [owner],
        )
      ).rows,
    ).map((r): Input => ({
      ...r,
      start_date: String(r.start_date).slice(0, 10),
      next_occurrence_date: r.next_occurrence_date
        ? String(r.next_occurrence_date).slice(0, 10)
        : null,
    }));
    return page(rows, input, (r) => String(r.rule_id));
  }
  if (operation === "task_recurrence_instances") {
    requireScope(principal, "tasks");
    const ruleId = text(input, "rule_id");
    await entity(tx, "task_recurrence_rules", "rule_id", ruleId, owner);
    const rows = cleanRows(
      (
        await tx.query<Input>(
          "SELECT * FROM task_recurrence_instances WHERE owner_id=$1 AND rule_id=$2 ORDER BY occurrence_date,instance_id",
          [owner, ruleId],
        )
      ).rows,
    ).map((r): Input => ({
      ...r,
      occurrence_date: String(r.occurrence_date).slice(0, 10),
    }));
    return page(rows, input, (r) => String(r.instance_id));
  }
  if (operation === "get_activity") {
    requireScope(principal, "activity");
    const params: unknown[] = [owner];
    let condition = "owner_id=$1";
    if (input.entity_id) {
      params.push(text(input, "entity_id"));
      condition += " AND entity_id=$2";
    }
    if (input.channel !== undefined) {
      params.push(
        choice(input, "channel", ["UI", "MCP", "AI", "import", "system"]),
      );
      condition += ` AND channel=$${params.length}`;
    }
    const rows = cleanRows(
      (
        await tx.query<Input>(
          `SELECT * FROM activity_events WHERE ${condition} ORDER BY occurred_at DESC,event_id DESC LIMIT 10000`,
          params,
        )
      ).rows,
    );
    return page(rows, input, (r) => String(r.event_id));
  }
  if (operation === "saved_view_list" || operation === "reminder_list") {
    requireScope(principal, "tasks");
    const table = operation === "saved_view_list" ? "saved_views" : "reminders",
      column = operation === "saved_view_list" ? "view_id" : "reminder_id";
    const rows = cleanRows(
      (
        await tx.query<Input>(
          `SELECT * FROM ${table} WHERE owner_id=$1 ORDER BY ${column}`,
          [owner],
        )
      ).rows,
    );
    return page(rows, input, (r) => String(r[column]));
  }
  if (operation === "sync_status" || operation === "import_status") {
    requireScope(principal, "tasks");
    const batches = cleanRows(
      (
        await tx.query<Input>(
          "SELECT batch_id,source_hash,status,counts,conflicts,created_at FROM migration_batches WHERE owner_id=$1 ORDER BY created_at DESC",
          [owner],
        )
      ).rows,
    );
    const jobs = cleanRows(
      (
        await tx.query<Input>(
          "SELECT outbox_id,topic,state,attempts,next_attempt_at FROM outbox WHERE owner_id=$1 ORDER BY created_at DESC LIMIT 100",
          [owner],
        )
      ).rows,
    );
    return {
      migration_batches: batches,
      jobs,
      cutover_status: "source_preserved_destination_unverified",
      external_sync: await calendarStatus(principal),
    };
  }
  if (operation.startsWith("file_")) {
    requireScope(principal, "files");
    const requestedTags =
      input.tags === undefined
        ? []
        : fileTags(input.tags).map(normalizedSearch);
    if (operation === "file_archive_preview")
      return archiveEligibility(tx, text(input, "file_id"), owner);
    if (operation === "file_get_metadata")
      return fileMetadata(tx, text(input, "file_id"), owner);
    if (operation === "file_list_versions") {
      const file = await entity(
        tx,
        "files",
        "file_id",
        text(input, "file_id"),
        owner,
      );
      const rows = cleanRows(
        (
          await tx.query<Input>(
            "SELECT f.*,COALESCE(a.description,'') description,COALESCE(a.tags,'[]'::jsonb) tags FROM files f LEFT JOIN file_annotations a ON a.file_id=f.file_id AND a.owner_id=f.owner_id WHERE f.owner_id=$1 AND f.version_group_id=$2 ORDER BY f.created_at,f.file_id",
            [owner, file.version_group_id],
          )
        ).rows,
      );
      return page(rows, input, (r) => String(r.file_id));
    }
    const rows = cleanRows(
      (
        await tx.query<Input>(
          "SELECT f.*,COALESCE(a.description,'') description,COALESCE(a.tags,'[]'::jsonb) tags FROM files f LEFT JOIN file_annotations a ON a.file_id=f.file_id AND a.owner_id=f.owner_id WHERE f.owner_id=$1 ORDER BY f.created_at DESC,f.file_id",
          [owner],
        )
      ).rows,
    ).filter(
      (f) =>
        (!input.state || f.state === input.state) &&
        (!input.search ||
          normalizedSearch(
            String(f.title) +
              " " +
              String(f.original_filename) +
              " " +
              String(f.description) +
              " " +
              (f.tags as string[]).join(" "),
          ).includes(
            normalizedSearch(text(input, "search", undefined, 2000)),
          )) &&
        requestedTags.every((tag) =>
          (f.tags as string[]).some(
            (stored) => normalizedSearch(stored) === tag,
          ),
        ),
    );
    return page(rows, input, (r) => String(r.file_id));
  }
  if (
    operation === "calendar_reminder_get" ||
    operation === "calendar_reminder_list"
  ) {
    requireScope(principal, "calendar");
    if (operation === "calendar_reminder_get")
      return entity(
        tx,
        "event_reminders",
        "reminder_id",
        text(input, "reminder_id"),
        owner,
      );
    if (input.event_id)
      await entity(
        tx,
        "calendar_events",
        "event_id",
        text(input, "event_id"),
        owner,
      );
    const reminders = cleanRows(
      (
        await tx.query<Input>(
          "SELECT r.*,e.title event_title,r.remind_at<=now() past_due FROM event_reminders r JOIN calendar_events e ON e.event_id=r.event_id AND e.owner_id=r.owner_id WHERE r.owner_id=$1 AND ($2::text IS NULL OR r.event_id=$2) ORDER BY r.remind_at,r.reminder_id",
          [owner, input.event_id ?? null],
        )
      ).rows,
    );
    return page(reminders, input, (r) => String(r.reminder_id));
  }
  if (operation.startsWith("calendar_") || operation.startsWith("time_")) {
    const isTime = operation.startsWith("time_");
    requireScope(principal, isTime ? "time" : "calendar");
    if (operation === "calendar_list") {
      let external: Awaited<ReturnType<typeof externalCalendarList>> = [],
        warnings: string[] = [];
      try {
        external = await externalCalendarList(principal);
      } catch {
        warnings = ["EXTERNAL_CALENDAR_UNAVAILABLE"];
      }
      const items = [
        {
          calendar_id: "local",
          title: "Private local calendar",
          provider: "local",
          writable: true,
        },
        ...external,
      ];
      return {
        ...page(items, input, (calendar) => calendar.calendar_id),
        source_warnings: warnings,
      };
    }
    const table = isTime ? "time_entries" : "calendar_events",
      column = isTime ? "entry_id" : "event_id";
    const params: unknown[] = [owner];
    let condition = "owner_id=$1 AND archived_at IS NULL";
    if (input.task_id) {
      const taskId = text(input, "task_id", undefined, 512);
      await entity(tx, "tasks", "task_id", taskId, owner);
      params.push(taskId);
      condition += ` AND task_id=$${params.length}`;
    }
    if (input.from) {
      params.push(instant(input, "from"));
      condition += isTime
        ? ` AND ends_at>$${params.length}`
        : ` AND (ends_at>$${params.length} OR recurrence_rule IS NOT NULL)`;
    }
    if (input.to) {
      params.push(instant(input, "to"));
      condition += ` AND starts_at<$${params.length}`;
    }
    if (input.employer && isTime) {
      params.push(text(input, "employer"));
      condition += ` AND employer=$${params.length}`;
    }
    const rows = cleanRows(
      (
        await tx.query<Input>(
          `SELECT * FROM ${table} WHERE ${condition} ORDER BY starts_at,${column}`,
          params,
        )
      ).rows,
    ).map((r): Input & { minutes: number } => ({
      ...r,
      minutes:
        (Date.parse(String(r.ends_at)) - Date.parse(String(r.starts_at))) /
        60000,
    }));
    if (operation === "time_summary") {
      const from = input.from ? Date.parse(instant(input, "from")) : -Infinity,
        to = input.to ? Date.parse(instant(input, "to")) : Infinity;
      if (to <= from)
        throw new DomainError(
          "INVALID_INPUT",
          "Time summary requires an ordered range.",
        );
      const intervals = rows.map((row): Input & { minutes: number } => ({
        ...row,
        minutes: Math.max(
          0,
          (Math.min(to, Date.parse(String(row.ends_at))) -
            Math.max(from, Date.parse(String(row.starts_at)))) /
            60000,
        ),
      }));
      const employers: Record<string, number> = {};
      for (const r of intervals)
        employers[String(r.employer)] =
          (employers[String(r.employer)] ?? 0) + r.minutes;
      return {
        minutes: intervals.reduce((sum, r) => sum + r.minutes, 0),
        employers,
        entries: rows.length,
      };
    }
    if (!isTime) {
      const from = input.from
          ? instant(input, "from")
          : new Date(Date.now() - 30 * 86400000).toISOString(),
        to = input.to
          ? instant(input, "to")
          : new Date(Date.now() + 330 * 86400000).toISOString();
      if (
        Date.parse(to) <= Date.parse(from) ||
        Date.parse(to) - Date.parse(from) > 366 * 86400000
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Calendar queries require an ordered range of at most one year.",
        );
      const expanded: Input[] = (
        !input.calendar_id || input.calendar_id === "local" ? rows : []
      )
        .flatMap((row) =>
          expandRecurrence(row as unknown as RecurringEvent, from, to).map(
            (occurrence) => ({
              ...row,
              ...occurrence,
              series_starts_at: row.starts_at,
              series_ends_at: row.ends_at,
            }),
          ),
        )
        .sort((a, b) => String(a.starts_at).localeCompare(String(b.starts_at)));
      const warnings: string[] = [];
      try {
        expanded.push(
          ...(
            await externalCalendarEvents(
              principal,
              from,
              to,
              input.calendar_id ? text(input, "calendar_id") : undefined,
            )
          ).map((event): Input => ({ ...event })),
        );
      } catch {
        warnings.push("EXTERNAL_CALENDAR_UNAVAILABLE");
      }
      const uniqueEvents = new Map<string, Input>();
      for (const event of expanded)
        uniqueEvents.set(
          String(event.event_id) + ":" + String(event.occurrence_key),
          event,
        );
      expanded.splice(0, expanded.length, ...uniqueEvents.values());
      const searched =
        input.search === undefined
          ? null
          : normalizedSearch(text(input, "search", undefined, 2000));
      const category =
        input.category === undefined
          ? null
          : choice(input, "category", ["Work", "Personal", "Other"]);
      expanded.splice(
        0,
        expanded.length,
        ...expanded.filter(
          (event) =>
            (!input.task_id || event.task_id === input.task_id) &&
            (!category || event.category === category) &&
            (!searched ||
              normalizedSearch(
                String(event.title) + " " + String(event.notes ?? ""),
              ).includes(searched)),
        ),
      );
      expanded.sort((a, b) =>
        String(a.starts_at).localeCompare(String(b.starts_at)),
      );
      if (operation === "calendar_availability")
        return {
          busy: expanded.map((r) => ({
            starts_at: r.starts_at,
            ends_at: r.ends_at,
            event_id: r.event_id,
          })),
          from,
          to,
          source_warnings: warnings,
        };
      return {
        ...page(expanded, input, (r) => String(r.occurrence_key)),
        source_warnings: warnings,
      };
    }
    return page(rows, input, (r) => String(r[column]));
  }
  if (operation.startsWith("project_")) {
    requireScope(principal, "projects");
    if (operation === "project_milestone_list") {
      const projectId = text(input, "project_id");
      await entity(tx, "projects", "project_id", projectId, owner);
      return page(
        cleanRows(
          (
            await tx.query<Input>(
              "SELECT * FROM project_milestones WHERE project_id=$1 AND owner_id=$2 ORDER BY due_date,milestone_id",
              [projectId, owner],
            )
          ).rows,
        ),
        input,
        (r) => String(r.milestone_id),
      );
    }
    if (operation === "project_list") {
      const projects = cleanRows(
        (
          await tx.query<Input>(
            `SELECT * FROM projects WHERE owner_id=$1 ${input.archived_only === true ? "AND archived_at IS NOT NULL" : input.include_archived === true ? "" : "AND archived_at IS NULL"} ORDER BY title,project_id`,
            [owner],
          )
        ).rows,
      );
      const canReadTasks =
        principal.scopes.includes("tasks:read") ||
        principal.scopes.includes("admin:manage");
      if (!canReadTasks)
        return page(projects, input, (r) => String(r.project_id));
      const all = await snapshot(tx, owner),
        counts = new Map<
          string,
          { total: number; done: number; ready: number; blocked: number }
        >();
      for (const task of all.tasks)
        if (task.project_id && !task.archived_at) {
          const group = counts.get(task.project_id) ?? {
            total: 0,
            done: 0,
            ready: 0,
            blocked: 0,
          };
          group.total++;
          if (task.status === "Done") group.done++;
          if (task.ready_now) group.ready++;
          if (task.readiness === "blocked") group.blocked++;
          counts.set(task.project_id, group);
        }
      return page(
        projects.map((p): Input => ({
          ...p,
          ...(counts.get(String(p.project_id)) ?? {
            total: 0,
            done: 0,
            ready: 0,
            blocked: 0,
          }),
        })),
        input,
        (r) => String(r.project_id),
      );
    }
    const project = await entity(
      tx,
      "projects",
      "project_id",
      text(input, "project_id"),
      owner,
    );
    if (operation === "project_get") return project;
    requireScope(principal, "tasks");
    const data = await snapshot(tx, owner),
      tasks = data.tasks.filter(
        (t) => t.project_id === project.project_id && !t.archived_at,
      );
    return {
      project,
      total: tasks.length,
      done: tasks.filter((t) => t.status === "Done").length,
      ready: tasks.filter((t) => t.ready_now).length,
      blocked: tasks.filter((t) => t.readiness === "blocked").length,
      at_risk: tasks.filter((t) => t.started_at_risk).length,
      cross_project_blockers: data.dependencies.filter(
        (e) =>
          tasks.some((t) => t.task_id === e.dependent_task_id) &&
          data.byId.get(e.prerequisite_task_id)?.project_id !==
            project.project_id,
      ).length,
      plan: topologicalPlan(data, tasks),
    };
  }
  requireScope(principal, "tasks");
  if (operation === "task_template_list")
    return page(
      cleanRows(
        (
          await tx.query<Input>(
            "SELECT * FROM task_templates WHERE owner_id=$1 ORDER BY created_at,template_id",
            [owner],
          )
        ).rows,
      ),
      input,
      (r) => String(r.template_id),
    );
  const data = await snapshot(tx, owner);
  if (operation === "task_get") {
    const task = taskFromSnapshot(data, text(input, "task_id"));
    const checklists = data.checklists.filter(
      (c) => c.task_id === task.task_id,
    );
    const subtasks = data.tasks.filter(
      (t) => t.parent_task_id === task.task_id,
    );
    const files =
      principal.scopes.includes("files:read") ||
      principal.scopes.includes("admin:manage")
        ? cleanRows(
            (
              await tx.query(
                `SELECT f.*,COALESCE(a.description,'') description,COALESCE(a.tags,'[]'::jsonb) tags FROM files f JOIN file_task_links l ON l.file_id=f.file_id AND l.owner_id=f.owner_id LEFT JOIN file_annotations a ON a.file_id=f.file_id AND a.owner_id=f.owner_id WHERE l.task_id=$1 AND l.owner_id=$2 AND l.active=true`,
                [task.task_id, owner],
              )
            ).rows,
          )
        : [];
    const activity =
      principal.scopes.includes("activity:read") ||
      principal.scopes.includes("admin:manage")
        ? cleanRows(
            (
              await tx.query(
                "SELECT * FROM activity_events WHERE entity_id=$1 AND owner_id=$2 ORDER BY occurred_at DESC LIMIT 100",
                [task.task_id, owner],
              )
            ).rows,
          )
        : [];
    const tags = cleanRows(
      (
        await tx.query(
          "SELECT t.*,l.link_id FROM tags t JOIN task_tags l ON l.tag_id=t.tag_id AND l.owner_id=t.owner_id WHERE l.task_id=$1 AND l.owner_id=$2 AND l.active=true ORDER BY t.title",
          [task.task_id, owner],
        )
      ).rows,
    );
    const comments = cleanRows(
      (
        await tx.query(
          "SELECT * FROM task_comments WHERE task_id=$1 AND owner_id=$2 AND archived_at IS NULL ORDER BY created_at,comment_id",
          [task.task_id, owner],
        )
      ).rows,
    );
    return { ...task, checklists, subtasks, files, activity, tags, comments };
  }
  if (operation === "task_checklist_get") {
    taskFromSnapshot(data, text(input, "task_id"));
    return data.checklists.filter((c) => c.task_id === input.task_id);
  }
  if (operation === "task_dependencies_get") {
    const task = taskFromSnapshot(data, text(input, "task_id"));
    return {
      task_id: task.task_id,
      revision: task.revision,
      prerequisites: task.prerequisites,
      blocked_by: task.blocked_by,
      unblocks: task.unblocks,
      readiness: task.readiness,
    };
  }
  if (operation === "subtask_list") {
    taskFromSnapshot(data, text(input, "task_id"));
    return page(
      data.tasks.filter((t) => t.parent_task_id === input.task_id),
      input,
      (t) => t.task_id,
    );
  }
  if (operation === "task_completion_impact_preview") {
    const task = taskFromSnapshot(data, text(input, "task_id"));
    const reachable = downstreamIds(data, task.task_id);
    return {
      task_id: task.task_id,
      revision: task.revision,
      blocked_by: task.blocked_by,
      unblocks: data.tasks
        .filter(
          (t) =>
            t.readiness === "blocked" &&
            task.unblocks.includes(t.task_id) &&
            afterCompletionReady(t, task.task_id),
        )
        .map((t) => ({ task_id: t.task_id, title: t.title })),
      affected_task_ids: reachable,
      read_only: true,
    };
  }
  let tasks = data.tasks.filter((t) =>
    input.archived_only === true
      ? Boolean(t.archived_at)
      : input.include_archived === true || !t.archived_at,
  );
  if (input.project_id)
    tasks = tasks.filter((t) => t.project_id === input.project_id);
  if (input.status) tasks = tasks.filter((t) => t.status === input.status);
  if (input.priority) {
    const priority = choice(input, "priority", [
      "Low",
      "Normal",
      "High",
      "Urgent",
    ]);
    tasks = tasks.filter((task) => task.priority === priority);
  }
  if (input.category) {
    const category = choice(input, "category", [
      "Study",
      "Research",
      "Work",
      "Admin",
      "Personal",
      "Other",
    ]);
    tasks = tasks.filter((task) => task.category === category);
  }
  if (input.search || input.query) {
    const needle = normalizedSearch(
      text(input, input.search ? "search" : "query"),
    );
    tasks = tasks.filter((t) =>
      normalizedSearch(`${t.title} ${t.notes} ${t.next_action}`).includes(
        needle,
      ),
    );
  }
  if (input.readiness)
    tasks = tasks.filter((t) => t.readiness === input.readiness);
  const explicitContext =
    (operation === "task_graph_get" ||
      operation === "dependency_topological_plan") &&
    (input.task_id !== undefined || input.task_ids !== undefined);
  if (
    !explicitContext &&
    (input.due_from !== undefined || input.due_to !== undefined)
  ) {
    const from = date(input, "due_from"),
      to = date(input, "due_to");
    if (from && to && to <= from)
      throw new DomainError(
        "INVALID_INPUT",
        "Deadline range must have an exclusive end after its start.",
      );
    const matches = (day: string | null) =>
      Boolean(day && (!from || day >= from) && (!to || day < to));
    tasks = tasks.filter(
      (task) =>
        matches(task.due_date) ||
        matches(
          task.due_at ? instantToLocalDate(task.due_at, timezone(input)) : null,
        ),
    );
  }
  if (operation === "task_find_ready") tasks = tasks.filter((t) => t.ready_now);
  if (operation === "task_find_blocked")
    tasks = tasks.filter((t) => t.readiness === "blocked");
  if (
    !explicitContext &&
    (operation === "task_list_overdue" || input.overdue === true)
  ) {
    tasks = tasks.filter((task) => taskOverdue(task, timezone(input)));
  }
  if (operation === "task_graph_get") {
    // A selected task's owner-authorized context takes precedence over inventory filters.
    if (input.task_id) tasks = taskContext(data, input);
    const result = page(tasks, input, (t) => t.task_id);
    const ids = new Set(result.items.map((t) => t.task_id));
    const boundaries = data.dependencies.filter(
        (edge) =>
          ids.has(edge.dependent_task_id) !==
          ids.has(edge.prerequisite_task_id),
      ),
      hiddenNeighbors = new Set(
        boundaries.flatMap((edge) =>
          ids.has(edge.dependent_task_id)
            ? [edge.prerequisite_task_id]
            : [edge.dependent_task_id],
        ),
      );
    return {
      nodes: result.items,
      edges: data.dependencies.filter(
        (e) => ids.has(e.dependent_task_id) && ids.has(e.prerequisite_task_id),
      ),
      next_cursor: result.next_cursor,
      total: result.total,
      boundary_edges: boundaries.slice(0, 1000),
      hidden_neighbor_count: hiddenNeighbors.size,
      truncated: result.next_cursor !== null || hiddenNeighbors.size > 0,
      boundary_edges_truncated: boundaries.length > 1000,
    };
  }
  if (operation === "dependency_topological_plan") {
    if (input.task_ids !== undefined) {
      if (
        input.task_id !== undefined ||
        !Array.isArray(input.task_ids) ||
        input.task_ids.length < 1 ||
        input.task_ids.length > 200
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Choose 1..200 task IDs or one task context.",
        );
      const ids = input.task_ids.map((taskId) =>
        text({ task_id: taskId }, "task_id"),
      );
      tasks = [...new Set(ids)].map((taskId) => taskFromSnapshot(data, taskId));
    } else if (input.task_id) tasks = taskContext(data, input);
    return topologicalPlan(data, tasks);
  }
  if (operation === "reports_summary")
    return reports(tx, tasks, input, principal, (items) =>
      page(items, input, (task) => task.task_id),
    );
  if (operation === "analytics_summary") {
    const range = analyticsRange(input),
      trends = await analyticsTrends(tx, tasks, input, principal);
    const recent =
      principal.scopes.includes("activity:read") ||
      principal.scopes.includes("admin:manage")
        ? cleanRows(
            (
              await tx.query(
                "SELECT * FROM activity_events WHERE owner_id=$1 ORDER BY occurred_at DESC LIMIT 12",
                [owner],
              )
            ).rows,
          )
        : [];
    const projects =
      principal.scopes.includes("projects:read") ||
      principal.scopes.includes("admin:manage")
        ? cleanRows(
            (
              await tx.query(
                "SELECT * FROM projects WHERE owner_id=$1 AND archived_at IS NULL ORDER BY title",
                [owner],
              )
            ).rows,
          )
        : [];
    const time =
      principal.scopes.includes("time:read") ||
      principal.scopes.includes("admin:manage")
        ? Number(
            (
              await tx.query<{ minutes: string }>(
                "SELECT COALESCE(sum(EXTRACT(EPOCH FROM ends_at-starts_at)/60),0) minutes FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL",
                [owner],
              )
            ).rows[0].minutes,
          )
        : 0;
    const files =
      principal.scopes.includes("files:read") ||
      principal.scopes.includes("admin:manage")
        ? Number(
            (
              await tx.query<{ count: string }>(
                "SELECT count(*) FROM files WHERE owner_id=$1",
                [owner],
              )
            ).rows[0].count,
          )
        : 0;
    return {
      tasks: {
        total: tasks.length,
        open: tasks.filter((t) => t.readiness !== "closed").length,
        done: tasks.filter((t) => t.status === "Done").length,
        ready: tasks.filter((t) => t.ready_now).length,
        blocked: tasks.filter((t) => t.readiness === "blocked").length,
        overdue: tasks.filter((task) => taskOverdue(task, range.timezone))
          .length,
      },
      projects,
      time: {
        minutes: range.start
          ? trends.days.reduce((sum, day) => sum + day.minutes, 0)
          : time,
        time_scope_granted: trends.time_scope_granted,
      },
      files: { total: files },
      recent_activity: recent,
      trends,
      range: {
        timezone: range.timezone,
        from_date: range.from_date,
        to_date: range.to_date,
        applies_to:
          "activity_and_worked_time; inventory_counts_remain_current_snapshot",
      },
    };
  }
  if (operation === "search_all") {
    const taskResults = page(tasks, input, (t) => t.task_id);
    const files =
      principal.scopes.includes("files:read") ||
      principal.scopes.includes("admin:manage")
        ? await domainQuery(tx, "file_search", input, principal)
        : { items: [], total: 0, next_cursor: null };
    return { tasks: taskResults, files };
  }
  if (
    [
      "task_search",
      "task_find_ready",
      "task_find_blocked",
      "task_list_overdue",
    ].includes(operation)
  )
    return page(tasks, input, (t) => t.task_id);
  throw new DomainError("UNSUPPORTED_OPERATION", "Query unavailable.");
}
