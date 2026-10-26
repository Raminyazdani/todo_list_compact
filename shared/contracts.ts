/** Canonical contracts shared by the browser, HTTP, MCP and AI adapters. */
export const WORKFLOW_STATUSES = [
  "Inbox",
  "Next",
  "In progress",
  "Waiting",
  "Done",
  "Cancelled",
] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type Priority = "Low" | "Normal" | "High" | "Urgent";
export type Category =
  "Study" | "Research" | "Work" | "Admin" | "Personal" | "Other";
export type Readiness = "ready" | "blocked" | "scheduled" | "closed";
export type Channel = "UI" | "MCP" | "AI" | "import" | "system";
export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Principal {
  ownerId: string;
  actorId: string;
  channel: Channel;
  scopes: readonly string[];
}
export interface CommandOptions {
  idempotencyKey: string;
  expectedRevision?: number;
}
export interface BlockerDTO {
  task_id: string;
  title: string;
  actual_status: WorkflowStatus;
  group_id: string;
  group_operator: "ALL" | "ANY";
  reason: "PREREQUISITE_UNSATISFIED" | "PREREQUISITE_ARCHIVED";
}
export interface DependencyDTO {
  edge_id: string;
  group_id: string;
  dependent_task_id: string;
  prerequisite_task_id: string;
  operator: "ALL" | "ANY";
  mode: "hard" | "soft";
  title: string;
  status: WorkflowStatus;
  waived_at: string | null;
  waiver_reason: string | null;
  note: string | null;
}
export interface ChecklistItemDTO {
  item_id: string;
  checklist_id: string;
  title: string;
  notes: string;
  sort_key: number;
  checked: boolean;
  checked_at: string | null;
  promoted_task_id: string | null;
  archived_at: string | null;
  revision: number;
}
export interface ChecklistDTO {
  checklist_id: string;
  task_id: string;
  title: string;
  sort_key: number;
  archived_at: string | null;
  revision: number;
  items: ChecklistItemDTO[];
}
export interface TaskDTO {
  task_id: string;
  owner_id: string;
  project_id: string | null;
  parent_task_id: string | null;
  title: string;
  status: WorkflowStatus;
  priority: Priority;
  category: Category;
  notes: string;
  next_action: string;
  waiting_for: string;
  source_reference: string;
  start_date: string | null;
  due_date: string | null;
  due_at: string | null;
  timezone: string;
  estimated_minutes: number | null;
  sort_key: number;
  completed_at: string | null;
  closed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
  revision: number;
  legacy_metadata: Record<string, JsonValue>;
  readiness: Readiness;
  ready_now: boolean;
  earliest_allowed_start: string | null;
  blocked_by: BlockerDTO[];
  started_at_risk: boolean;
  warnings: string[];
  prerequisites: DependencyDTO[];
  unblocks: string[];
  checklist_progress: { checked: number; total: number };
  children_progress: { done: number; total: number; blocked: number };
  checklists?: ChecklistDTO[];
  subtasks?: TaskDTO[];
  tags?: TagDTO[];
  comments?: CommentDTO[];
  files?: FileDTO[];
  activity?: ActivityDTO[];
}
export interface ProjectDTO {
  project_id: string;
  title: string;
  notes: string;
  area: string;
  status: string;
  due_date: string | null;
  revision: number;
  archived_at: string | null;
  created_at: string;
  total?: number;
  done?: number;
  ready?: number;
  blocked?: number;
}
export interface DailyFocusDTO {
  date: string;
  timezone: "Europe/Berlin";
  revision: number;
  task_ids: string[];
  items: TaskDTO[];
}
export interface DailyCapacityPreviewDTO {
  date: string;
  period: "day" | "week";
  timezone: "Europe/Berlin";
  from_date: string;
  to_date_exclusive: string;
  focus: {
    open_selected_task_count: number;
    closed_selected_task_count: number;
    archived_selected_task_count: number;
    registered_estimate_minutes: number;
    unknown_estimate_task_ids: string[];
    repeated_task_ids: string[];
  };
  calendar: {
    access: "granted" | "not_granted";
    busy_minutes: number | null;
    complete: boolean | null;
    fresh: boolean | null;
    source_warnings: string[];
    source_issues: { source_title: string; code: string }[];
  };
  work: {
    access: "granted" | "not_granted";
    occupied_minutes: number | null;
    entry_count: number | null;
  };
  known_busy_minutes: number | null;
  busy_coverage: "complete" | "partial" | "unknown";
}
export type FileProvider =
  "google_drive" | "private_blob" | "neon_object_storage";
export type PrivateFileProvider = Exclude<FileProvider, "google_drive">;
export interface FileDTO {
  file_id: string;
  title: string;
  original_filename: string;
  provider: FileProvider;
  external_id: string | null;
  external_url: string | null;
  state: "Inbox" | "Active" | "Old" | "External";
  mime_type: string;
  size_bytes: number | null;
  sha256: string | null;
  version_group_id: string;
  revision: number;
  archived_at: string | null;
  legacy_metadata: Record<string, JsonValue>;
  description?: string;
  tags?: string[];
}
export interface ReportRangeDTO {
  timezone: string;
  from_date: string | null;
  to_date: string | null;
  applies_to: string;
}
export interface ReportsDTO {
  range: ReportRangeDTO;
  overdue_ageing: {
    as_of_date: string;
    total: number;
    buckets: {
      key: string;
      min_days: number;
      max_days: number | null;
      count: number;
    }[];
    items: PageDTO<TaskDTO & { due_local_date: string; overdue_days: number }>;
  };
  files_scope_granted: boolean;
  registered_files: null | {
    scope: "owner_registered_records";
    total: number;
    known_size_bytes: string;
    unknown_size_count: number;
    by_source: {
      source: string;
      total: number;
      known_size_bytes: string;
      unknown_size_count: number;
    }[];
  };
  duplicate_candidates: null | {
    basis:
      | "canonical_verified_private_blob_sha256"
      | "canonical_verified_private_storage_sha256";
    total_groups: number;
    excluded_unverified_count: number;
    groups: {
      sha256: string;
      size_bytes: string;
      file_count: number;
      files: FileDTO[];
      truncated: boolean;
    }[];
    truncated: boolean;
  };
}
export interface EventDTO {
  event_id: string;
  occurrence_key?: string;
  series_starts_at?: string;
  series_ends_at?: string;
  series_event_id?: string | null;
  original_occurrence_starts_at?: string | null;
  recurrence_id?: string | null;
  title: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  all_day: boolean;
  provider: string;
  category?: "Work" | "Personal" | "Other";
  task_id: string | null;
  notes: string;
  recurrence_rule: string | null;
  recurrence_exceptions?: string[];
  source_id?: string;
  source_title?: string;
  external_id?: string;
  external_url?: string;
  busy?: boolean;
  self_declined?: boolean;
  etag?: string;
  series_etag?: string;
  can_edit?: boolean;
  source_read_only?: boolean;
  sync_state?: string;
  revision: number;
}
export interface TimeEntryDTO {
  entry_id: string;
  employer: string;
  starts_at: string;
  ends_at: string;
  description: string;
  task_id: string | null;
  revision: number;
  minutes: number;
  reporting_policy?: "elapsed" | "legacy_wall";
  reported_minutes?: number | null;
  legacy_metadata?: Record<string, JsonValue>;
  overlap_entry_ids?: string[];
  warnings?: string[];
}
export interface WorkContractPolicyDTO {
  id: string;
  employer: string;
  effective_from: string;
  effective_to: string | null;
  weekly_contract_max_minutes: number | null;
  weekly_personal_alert_minutes: number | null;
  weekly_average_target_minutes: number | null;
  average_window_months: number | null;
  monthly_reference_minutes: number | null;
  monthly_overrides: Record<string, number>;
  allowed_weekdays: number[];
  local_window_start: string | null;
  local_window_end: string | null;
  timesheet_due: { kind: "calendar_day" | "business_day"; day: number } | null;
  source_label: string;
  revision: number;
  updated_at: string;
}
export interface TimeContractIssueDTO {
  code:
    | "WEEKDAY_REVIEW"
    | "LOCAL_WINDOW_REVIEW"
    | "OUTSIDE_EFFECTIVE_TERM"
    | "LEGACY_DURATION_REVIEW";
  entry_id: string;
  local_date: string;
  starts_at: string;
  ends_at: string;
}
export type TimeContractStatus =
  "within" | "over" | "review" | "not_set" | "unknown";
export interface TimeContractWeekDTO {
  week_start: string;
  week_end_exclusive: string;
  minutes: number;
  elapsed_minutes: number;
  entry_count: number;
  policy_id: string | null;
  contract_limit_minutes: number | null;
  contract_remaining_minutes: number | null;
  contract_over_minutes: number;
  contract_state: TimeContractStatus;
  personal_alert_minutes: number | null;
  personal_remaining_minutes: number | null;
  personal_over_minutes: number;
  personal_state: TimeContractStatus;
  average_target_minutes: number | null;
  weekday_review_count: number;
  window_review_count: number;
  out_of_term_review_count: number;
  issues: TimeContractIssueDTO[];
}
export interface EmployerContractReportDTO {
  employer: string;
  policy: WorkContractPolicyDTO | null;
  policies: WorkContractPolicyDTO[];
  policy_status: "configured" | "missing" | "mixed";
  monthly: {
    minutes: number;
    entry_count: number;
    reference_minutes: number | null;
    delta_minutes: number | null;
  };
  cumulative: {
    from: string | null;
    through_month: string;
    months: number;
    reported_minutes: number | null;
    reference_minutes: number | null;
    delta_minutes: number | null;
    status: "informational" | "unknown";
    reason: string | null;
  };
  average: {
    window_months: number | null;
    window_start: string | null;
    window_end_exclusive: string;
    reported_minutes: number | null;
    recorded_average_minutes_per_week: number | null;
    target_minutes_per_week: number | null;
    status: "informational" | "unknown";
    reason: string | null;
  };
  weeks: TimeContractWeekDTO[];
}
export interface TimeContractReportDTO {
  month: string;
  timezone: "Europe/Berlin";
  week_starts_on: "monday";
  reporting_basis: "entry_reporting_policy";
  data_complete: true;
  employers: EmployerContractReportDTO[];
  combined_weeks: Array<{
    week_start: string;
    week_end_exclusive: string;
    minutes: number;
    elapsed_minutes: number;
    review_over_20h: boolean;
  }>;
}
export interface CalendarSourceDTO {
  source_id: string;
  calendar_id: string;
  provider: "google_calendar" | "ical";
  title: string;
  timezone: string;
  writable: boolean;
  primary?: boolean;
  enabled: boolean;
  revision: number;
  status: string;
  last_success_at: string | null;
  last_error: string | null;
  coverage: Record<string, JsonValue>;
}
export interface TimeDraftDTO {
  draft_id: string;
  employer: string;
  date: string;
  start: string;
  end: string;
  end_next_day: boolean;
  description: string;
  timezone: string;
  revision: number;
  legacy_metadata?: Record<string, JsonValue>;
}
export interface ReminderDTO {
  reminder_id: string;
  task_id: string;
  remind_at: string;
  channel: "in_app";
  state: "Pending" | "Paused" | "Cancelled" | "Succeeded";
  revision: number;
  past_due?: boolean;
  warnings?: string[];
}
export interface CalendarReminderDTO {
  reminder_id: string;
  event_id: string;
  occurrence_starts_at: string | null;
  remind_at: string;
  channel: "in_app";
  state: "Pending" | "Paused" | "Cancelled" | "Succeeded";
  revision: number;
  past_due?: boolean;
  warnings?: string[];
  event_title?: string;
}
export interface TimeImportEntryDTO {
  entry_id: string;
  employer: string;
  starts_at: string;
  ends_at: string;
  description?: string;
  task_id?: string | null;
  reporting_policy?: "elapsed" | "legacy_wall";
  reported_minutes?: number | null;
  legacy_metadata?: Record<string, JsonValue>;
}
export interface TimeImportDataDTO {
  format: "ramin-life-os-time/1";
  timezone: string;
  entries: TimeImportEntryDTO[];
  drafts?: Omit<TimeDraftDTO, "revision">[];
}
export interface ActivityDTO {
  event_id: string;
  entity_id: string;
  event_type: string;
  actor_id: string;
  channel: string;
  operation_id: string;
  before: JsonValue;
  after: JsonValue;
  reason: string | null;
  occurred_at: string;
}
export interface TagDTO {
  tag_id: string;
  title: string;
  color: string;
  revision: number;
  link_id?: string;
}
export interface CommentDTO {
  comment_id: string;
  task_id: string;
  body: string;
  actor_id: string;
  created_at: string;
  revision: number;
  archived_at: string | null;
}
export interface KnowledgeDTO {
  knowledge_id: string;
  project_id: string | null;
  title: string;
  body: string;
  url: string | null;
  revision: number;
}
export interface PageDTO<T> {
  items: T[];
  next_cursor: string | null;
  total: number;
}
export interface GraphDTO {
  nodes: TaskDTO[];
  edges: DependencyDTO[];
  next_cursor: string | null;
  total: number;
  boundary_edges?: DependencyDTO[];
  hidden_neighbor_count?: number;
  truncated?: boolean;
  boundary_edges_truncated?: boolean;
}
export interface PlanDTO {
  levels: string[][];
  ready_task_ids: string[];
  critical_path: string[] | null;
  total_estimated_minutes: number | null;
  missing_estimates: string[];
  schedule_risks: {
    task_id: string;
    prerequisite_task_id: string;
    reason: string;
  }[];
  boundary_edges?: DependencyDTO[];
  hidden_neighbor_count?: number;
  boundary_edges_truncated?: boolean;
}
export interface AnalyticsTrendsDTO {
  timezone: string;
  from_date: string;
  to_date: string;
  days: { date: string; created: number; completed: number; minutes: number }[];
  weeks: {
    week_start: string;
    created: number;
    completed: number;
    minutes: number;
  }[];
  time_scope_granted: boolean;
}
export interface PreviewDTO {
  preview_id: string;
  command: CommandName;
  input: Record<string, unknown>;
  expires_at: string;
  revisions: Record<string, number>;
  affected_task_ids: string[];
  changes: JsonValue;
  warnings: string[];
}
export interface MutationResult {
  operation_id: string;
  audit_event_id: string;
  entity_id: string;
  version: number;
  affected_task_ids: string[];
  readiness_changes: { task_id: string; before: Readiness; after: Readiness }[];
  changed_fields: string[];
  data: unknown;
  replayed?: boolean;
}
export const COMMAND_NAMES = [
  "daily_focus_set",
  "task_create",
  "task_update",
  "task_complete",
  "task_reopen",
  "task_archive",
  "task_restore",
  "task_batch_commit",
  "project_create",
  "project_update",
  "project_archive",
  "project_restore",
  "project_milestone_create",
  "task_dependency_add_commit",
  "task_dependency_remove_commit",
  "task_dependency_group_update",
  "task_dependency_waive_commit",
  "task_checklist_create",
  "task_checklist_duplicate",
  "task_checklist_update",
  "task_checklist_archive",
  "task_checklist_restore",
  "task_checklist_item_add",
  "task_checklist_item_update",
  "task_checklist_item_check",
  "task_checklist_item_uncheck",
  "task_checklist_item_reorder",
  "task_checklist_item_archive",
  "task_checklist_item_restore",
  "task_checklist_item_promote",
  "subtask_create",
  "subtask_reparent_commit",
  "task_template_create",
  "task_template_instantiate_commit",
  "file_register_external_link",
  "file_register_upload",
  "file_metadata_update",
  "file_link_to_task",
  "file_unlink_from_task",
  "file_archive",
  "file_restore",
  "calendar_create_local_event",
  "calendar_source_configure",
  "calendar_source_disconnect",
  "calendar_sync_request",
  "calendar_event_change_commit",
  "calendar_update_local_event",
  "calendar_delete_local_event",
  "calendar_occurrence_reschedule_commit",
  "calendar_reminder_create",
  "calendar_reminder_pause",
  "calendar_reminder_resume",
  "calendar_reminder_cancel",
  "time_entry_create",
  "time_draft_save",
  "time_draft_archive",
  "time_entry_undo",
  "time_entry_update",
  "time_entry_archive",
  "time_entry_import_commit",
  "time_contract_policy_upsert",
  "preferences_update",
  "saved_view_create",
  "saved_view_update",
  "reminder_create",
  "reminder_pause",
  "reminder_resume",
  "reminder_cancel",
  "task_recurrence_create",
  "task_recurrence_pause",
  "task_recurrence_resume",
  "system_daily_run",
  "notification_mark_read",
  "task_comment_add",
  "task_comment_update",
  "task_comment_archive",
  "tag_create",
  "task_tag_link",
  "task_tag_unlink",
  "knowledge_create",
  "knowledge_update",
  "task_dependency_restore_commit",
  "legacy_import",
  "backup_restore",
  "undo_last_eligible_action",
  "redo_last_eligible_action",
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export const QUERY_NAMES = [
  "daily_focus_get",
  "daily_capacity_preview",
  "system_capabilities",
  "calendar_sync_status",
  "calendar_event_change_preview",
  "calendar_operation_status",
  "time_draft_list",
  "time_entry_export",
  "system_health",
  "whoami",
  "task_search",
  "task_get",
  "task_find_ready",
  "task_find_blocked",
  "task_list_overdue",
  "task_graph_get",
  "task_dependencies_get",
  "task_checklist_get",
  "subtask_list",
  "task_completion_impact_preview",
  "dependency_topological_plan",
  "task_dependency_add_preview",
  "task_dependency_remove_preview",
  "task_dependency_waive_preview",
  "subtask_reparent_preview",
  "task_template_instantiate_preview",
  "task_batch_preview",
  "project_list",
  "project_get",
  "project_summary",
  "project_dependency_summary",
  "project_milestone_list",
  "task_template_list",
  "file_search",
  "file_get_metadata",
  "file_list_versions",
  "file_archive_preview",
  "calendar_list",
  "calendar_events_query",
  "calendar_availability",
  "calendar_occurrence_reschedule_preview",
  "calendar_reminder_list",
  "calendar_reminder_get",
  "time_entry_list",
  "time_summary",
  "time_contract_policy_list",
  "time_contract_report",
  "time_entry_import_preview",
  "get_activity",
  "search_all",
  "analytics_summary",
  "reports_summary",
  "preferences_get",
  "saved_view_list",
  "reminder_list",
  "task_recurrence_list",
  "task_recurrence_instances",
  "notifications_list",
  "task_comment_list",
  "tag_list",
  "knowledge_search",
  "knowledge_get",
  "task_dependency_restore_preview",
  "sync_status",
  "export_data_manifest",
  "backup_export",
  "import_status",
] as const;
export type QueryName = (typeof QUERY_NAMES)[number];
export type QueryResult = unknown;
export type ErrorCode =
  | "INVALID_INPUT"
  | "DEPENDENCY_CYCLE"
  | "DEPENDENCY_ALREADY_EXISTS"
  | "TASK_NOT_FOUND"
  | "ENTITY_NOT_FOUND"
  | "TASK_BLOCKED"
  | "REVISION_CONFLICT"
  | "PREREQUISITE_UNSATISFIED"
  | "INSUFFICIENT_PERMISSIONS"
  | "INVALID_DEPENDENCY_GROUP"
  | "HIERARCHY_CYCLE"
  | "HIERARCHY_DEPTH"
  | "PREVIEW_REQUIRED"
  | "PREVIEW_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "TIME_OVERLAP"
  | "FILE_ARCHIVE_INELIGIBLE"
  | "DATABASE_UNAVAILABLE"
  | "UNSUPPORTED_OPERATION"
  | "FEATURE_DISABLED";
export class DomainError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly details: Record<string, unknown> = {},
    public readonly status = 400,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
export interface DomainService {
  execute(
    command: CommandName,
    input: Record<string, unknown>,
    principal: Principal,
    options: CommandOptions,
  ): Promise<MutationResult>;
  query(
    operation: QueryName,
    input: Record<string, unknown>,
    principal: Principal,
  ): Promise<QueryResult>;
}
