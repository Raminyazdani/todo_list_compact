/** Canonical contracts shared by the browser, HTTP, MCP and AI adapters. */
export const WORKFLOW_STATUSES = ['Inbox', 'Next', 'In progress', 'Waiting', 'Done', 'Cancelled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];
export type Priority = 'Low' | 'Normal' | 'High' | 'Urgent';
export type Category = 'Study' | 'Research' | 'Work' | 'Admin' | 'Personal' | 'Other';
export type Readiness = 'ready' | 'blocked' | 'scheduled' | 'closed';
export type Channel = 'UI' | 'MCP' | 'AI' | 'import' | 'system';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface Principal { ownerId: string; actorId: string; channel: Channel; scopes: readonly string[]; }
export interface CommandOptions { idempotencyKey: string; expectedRevision?: number; }
export interface BlockerDTO { task_id: string; title: string; actual_status: WorkflowStatus; group_id: string; group_operator: 'ALL' | 'ANY'; reason: 'PREREQUISITE_UNSATISFIED' | 'PREREQUISITE_ARCHIVED'; }
export interface DependencyDTO { edge_id: string; group_id: string; dependent_task_id: string; prerequisite_task_id: string; operator: 'ALL' | 'ANY'; mode: 'hard' | 'soft'; title: string; status: WorkflowStatus; waived_at: string | null; waiver_reason: string | null; note: string | null; }
export interface ChecklistItemDTO { item_id: string; checklist_id: string; title: string; notes: string; sort_key: number; checked: boolean; checked_at: string | null; promoted_task_id: string | null; archived_at: string | null; revision: number; }
export interface ChecklistDTO { checklist_id: string; task_id: string; title: string; sort_key: number; archived_at: string | null; revision: number; items: ChecklistItemDTO[]; }
export interface TaskDTO { task_id: string; owner_id: string; project_id: string | null; parent_task_id: string | null; title: string; status: WorkflowStatus; priority: Priority; category: Category; notes: string; next_action: string; waiting_for: string; source_reference: string; start_date: string | null; due_date: string | null; due_at: string | null; timezone: string; estimated_minutes: number | null; sort_key: number; completed_at: string | null; closed_at: string | null; archived_at: string | null; created_at: string; updated_at: string; revision: number; legacy_metadata: Record<string, JsonValue>; readiness: Readiness; ready_now: boolean; earliest_allowed_start: string | null; blocked_by: BlockerDTO[]; started_at_risk: boolean; warnings: string[]; prerequisites: DependencyDTO[]; unblocks: string[]; checklist_progress: { checked: number; total: number }; children_progress: { done: number; total: number; blocked: number }; checklists?: ChecklistDTO[]; subtasks?: TaskDTO[]; files?: FileDTO[]; activity?: ActivityDTO[]; }
export interface ProjectDTO { project_id: string; title: string; notes: string; area: string; status: string; due_date: string | null; revision: number; archived_at: string | null; created_at: string; }
export interface FileDTO { file_id: string; title: string; original_filename: string; provider: 'google_drive' | 'private_blob'; external_id: string | null; external_url: string | null; state: 'Inbox' | 'Active' | 'Old' | 'External'; mime_type: string; size_bytes: number | null; sha256: string | null; version_group_id: string; revision: number; archived_at: string | null; legacy_metadata: Record<string, JsonValue>; }
export interface EventDTO { event_id: string; title: string; starts_at: string; ends_at: string; timezone: string; all_day: boolean; provider: string; task_id: string | null; notes: string; recurrence_rule: string | null; revision: number; }
export interface TimeEntryDTO { entry_id: string; employer: string; starts_at: string; ends_at: string; description: string; task_id: string | null; revision: number; minutes: number; }
export interface ActivityDTO { event_id: string; entity_id: string; event_type: string; actor_id: string; channel: string; operation_id: string; before: JsonValue; after: JsonValue; reason: string | null; occurred_at: string; }
export interface PageDTO<T> { items: T[]; next_cursor: string | null; total: number; }
export interface GraphDTO { nodes: TaskDTO[]; edges: DependencyDTO[]; next_cursor: string | null; total: number; }
export interface PlanDTO { levels: string[][]; ready_task_ids: string[]; critical_path: string[] | null; total_estimated_minutes: number | null; missing_estimates: string[]; schedule_risks: { task_id: string; prerequisite_task_id: string; reason: string }[]; }
export interface PreviewDTO { preview_id: string; command: CommandName; input: Record<string, unknown>; expires_at: string; revisions: Record<string, number>; affected_task_ids: string[]; changes: JsonValue; warnings: string[]; }
export interface MutationResult { operation_id: string; audit_event_id: string; entity_id: string; version: number; affected_task_ids: string[]; readiness_changes: { task_id: string; before: Readiness; after: Readiness }[]; changed_fields: string[]; data: unknown; replayed?: boolean; }
export const COMMAND_NAMES = [
  'task_create','task_update','task_complete','task_reopen','task_archive','task_restore','task_batch_commit',
  'project_create','project_update','project_milestone_create',
  'task_dependency_add_commit','task_dependency_remove_commit','task_dependency_group_update','task_dependency_waive_commit',
  'task_checklist_create','task_checklist_update','task_checklist_archive','task_checklist_restore','task_checklist_item_add','task_checklist_item_update','task_checklist_item_check','task_checklist_item_uncheck','task_checklist_item_reorder','task_checklist_item_archive','task_checklist_item_restore','task_checklist_item_promote',
  'subtask_create','subtask_reparent_commit','task_template_create','task_template_instantiate_commit',
  'file_register_external_link','file_register_upload','file_link_to_task','file_unlink_from_task','file_archive','file_restore',
  'calendar_create_local_event','calendar_update_local_event','calendar_delete_local_event',
  'time_entry_create','time_entry_update','time_entry_archive','preferences_update','saved_view_create','saved_view_update','reminder_create','legacy_import','backup_restore','undo_last_eligible_action'
] as const;
export type CommandName = (typeof COMMAND_NAMES)[number];
export const QUERY_NAMES = [
  'system_capabilities','system_health','whoami','task_search','task_get','task_find_ready','task_find_blocked','task_list_overdue','task_graph_get','task_dependencies_get','task_checklist_get','subtask_list','task_completion_impact_preview','dependency_topological_plan',
  'task_dependency_add_preview','task_dependency_remove_preview','task_dependency_waive_preview','subtask_reparent_preview','task_template_instantiate_preview','task_batch_preview',
  'project_list','project_get','project_summary','project_dependency_summary','project_milestone_list','task_template_list',
  'file_search','file_get_metadata','file_list_versions','file_archive_preview','calendar_list','calendar_events_query','calendar_availability','time_entry_list','time_summary','get_activity','search_all','analytics_summary','preferences_get','saved_view_list','reminder_list','sync_status','export_data_manifest','backup_export','import_status'
] as const;
export type QueryName = (typeof QUERY_NAMES)[number];
export type QueryResult = unknown;
export type ErrorCode = 'INVALID_INPUT' | 'DEPENDENCY_CYCLE' | 'DEPENDENCY_ALREADY_EXISTS' | 'TASK_NOT_FOUND' | 'ENTITY_NOT_FOUND' | 'TASK_BLOCKED' | 'REVISION_CONFLICT' | 'PREREQUISITE_UNSATISFIED' | 'INSUFFICIENT_PERMISSIONS' | 'INVALID_DEPENDENCY_GROUP' | 'HIERARCHY_CYCLE' | 'HIERARCHY_DEPTH' | 'PREVIEW_REQUIRED' | 'PREVIEW_EXPIRED' | 'IDEMPOTENCY_CONFLICT' | 'TIME_OVERLAP' | 'FILE_ARCHIVE_INELIGIBLE' | 'DATABASE_UNAVAILABLE' | 'UNSUPPORTED_OPERATION';
export class DomainError extends Error { constructor(public readonly code: ErrorCode, message: string, public readonly details: Record<string, unknown> = {}, public readonly status = 400) { super(message); this.name = 'DomainError'; } }
export interface DomainService { execute(command: CommandName, input: Record<string, unknown>, principal: Principal, options: CommandOptions): Promise<MutationResult>; query(operation: QueryName, input: Record<string, unknown>, principal: Principal): Promise<QueryResult>; }
