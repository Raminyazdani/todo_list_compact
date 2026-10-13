# Dependency and checklist test matrix

Initial evidence state: NOT RUN for all scenarios. The numbered contract requires 40 scenarios; a row may name multiple related assertions. Names are preserved from the normative specification. No test is PASS until observed execution is recorded.

Required layers: meaningful unit, isolated real PostgreSQL integration, REST/MCP authorization and transport contracts, authenticated browser E2E, independent security/race/backup/migration/performance and accessibility tests as appropriate. Synthetic fixtures only.

| ID | Required scenario | Initial | Evidence command / time / path |
|---|---|---|---|
| DG-01 | `multi_prerequisite_all_requires_every_task_done` — A(B,C) only ready after both qualify. | NOT RUN | Not observed |
| DG-02 | `alternative_group_any_accepts_one_done` — ANY group passes only when one qualifies; top-level groups AND together. | NOT RUN | Not observed |
| DG-03 | `deep_dependency_chain_propagates_readiness` — D->B->A with C->A, no premature unlocking. | NOT RUN | Not observed |
| DG-04 | `cycle_direct_self_link_rejected_without_mutation`. | NOT RUN | Not observed |
| DG-05 | `cycle_cross_project_long_path_rejected_with_explanation`. | NOT RUN | Not observed |
| DG-06 | `simultaneous_edge_writes_cannot_create_cycle` — concurrent transactions. | NOT RUN | Not observed |
| DG-07 | `duplicate_dependency_retry_is_idempotent`. | NOT RUN | Not observed |
| DG-08 | `cancelled_prerequisite_does_not_count_as_done` and `explicit_waiver_is_audited`. | NOT RUN | Not observed |
| DG-09 | `soft_link_does_not_block_readiness`. | NOT RUN | Not observed |
| DG-10 | `blocked_status_is_derived_without_mutating_workflow_status`. | NOT RUN | Not observed |
| DG-11 | `blocked_task_start_requires_override_reason_and_audit`. | NOT RUN | Not observed |
| DG-12 | `reopen_prerequisite_reblocks_downstream_without_status_rollback`. | NOT RUN | Not observed |
| DG-13 | `completed_downstream_task_not_undone_on_reopen`. | NOT RUN | Not observed |
| DG-14 | `checklist_toggle_persists_across_reload_and_mcp_read`. | NOT RUN | Not observed |
| DG-15 | `multiple_checklists_reorder_without_losing_items`. | NOT RUN | Not observed |
| DG-16 | `checklist_progress_does_not_auto_complete_parent`. | NOT RUN | Not observed |
| DG-17 | `checklist_item_promotion_is_single_and_traceable`. | NOT RUN | Not observed |
| DG-18 | `subtask_parent_cycle_rejected`. | NOT RUN | Not observed |
| DG-19 | `subtask_parent_rollup_matches_actual_children`. | NOT RUN | Not observed |
| DG-20 | `parent_child_dependency_deadlock_rejected`. | NOT RUN | Not observed |
| DG-21 | `template_clone_remaps_child_and_dependency_ids`. | NOT RUN | Not observed |
| DG-22 | `recurring_instance_links_do_not_point_to_unrelated_old_occurrences`. | NOT RUN | Not observed |
| DG-23 | `dependency_change_only_suggests_schedule_no_silent_due_shift`. | NOT RUN | Not observed |
| DG-24 | `no_estimates_no_fake_critical_path`. | NOT RUN | Not observed |
| DG-25 | `cross_project_dependency_search_respects_owner_auth`. | NOT RUN | Not observed |
| DG-26 | `graph_pagination_and_large_dataset_performance` — 10k nodes/30k edges with measured results. | NOT RUN | Not observed |
| DG-27 | `task_completion_impact_preview_is_read_only_and_correct`. | NOT RUN | Not observed |
| DG-28 | `ui_graph_and_linear_accessible_fallback_are_equivalent`. | NOT RUN | Not observed |
| DG-29 | `keyboard_dependency_editor_and_checklist_are_usable`. | NOT RUN | Not observed |
| DG-30 | `mcp_dependency_mutation_visible_in_browser_and_reverse`. | NOT RUN | Not observed |
| DG-31 | `ai_task_description_prompt_injection_cannot_change_graph`. | NOT RUN | Not observed |
| DG-32 | `graph_batch_commit_atomic_on_invalid_edge`. | NOT RUN | Not observed |
| DG-33 | `graph_revision_conflict_returns_updated_prerequisites`. | NOT RUN | Not observed |
| DG-34 | `legacy_import_has_no_fabricated_edges_or_checklist_items`. | NOT RUN | Not observed |
| DG-35 | `backup_restore_preserves_graph_and_checklists`. | NOT RUN | Not observed |
| DG-36 | `dependency_graph_works_after_redeploy_and_fresh_login`. | NOT RUN | Not observed |
| DG-37 | `project_ready_blocked_metrics_match_database_truth`. | NOT RUN | Not observed |
| DG-38 | `rtl_mobile_task_detail_allows_dependency_edit_without_drag`. | NOT RUN | Not observed |
| DG-39 | `checklist_deletion_is_recoverable_and_audited`. | NOT RUN | Not observed |
| DG-40 | `waive_cancelled_dependency_requires_explicit_user_intent`. | NOT RUN | Not observed |


Release mapping: DG-01..13 and DG-32..33,40 -> AC-21/22; DG-14..17,39 -> AC-23; DG-18..21 -> AC-24/27; DG-23..24,26..29,37..38 -> AC-25/27/28; DG-25,30..31 -> AC-26; DG-22,34..36 -> AC-27/28. Coverage spans several gates; this mapping does not substitute for independent evidence at every gate.

The mandatory production demonstration uses A requires B and C, B requires D; an explicit ANY group; reopen propagation; two named checklists; item promotion and nested template remapping. Browser, REST and MCP must show identical state. Measure at least 10,000 tasks/30,000 edges; do not invent a critical path when estimates are absent.

The master contract additionally requires named task persistence/retry/conflict, status/archive/version/source preservation, calendar/DST/export, authentication/IDOR/injection, restore and production smoke scenarios. They remain required and are recorded separately in the global test plan.

For every executed scenario replace NOT RUN only with PASS, FAIL or EXTERNALLY_BLOCKED plus exact command, timestamp and evidence reference. External blocks name the observed platform condition, completed independent work and minimum owner step. A test-file name alone is not proof.
