import type { Language } from "./locale";

const labels: Record<string, readonly [string, string]> = {
  daily_focus_set: ["تمرکز روزانه تغییر کرد", "Daily focus changed"],
  task_create: ["کار ساخته شد", "Task created"],
  task_update: ["کار ویرایش شد", "Task updated"],
  task_complete: ["کار تکمیل شد", "Task completed"],
  task_reopen: ["کار دوباره باز شد", "Task reopened"],
  task_archive: ["کار بایگانی شد", "Task archived"],
  task_restore: ["کار بازیابی شد", "Task restored"],
  task_batch_commit: ["تغییر گروهی کارها ثبت شد", "Task batch change saved"],
  subtask_create: ["زیرکار ساخته شد", "Subtask created"],
  subtask_reparent_commit: ["والد زیرکار تغییر کرد", "Subtask parent changed"],
  task_dependency_add_commit: ["پیش‌نیاز افزوده شد", "Prerequisite added"],
  task_dependency_remove_commit: [
    "پیش‌نیاز برداشته شد",
    "Prerequisite removed",
  ],
  task_dependency_restore_commit: [
    "پیش‌نیاز بازیابی شد",
    "Prerequisite restored",
  ],
  task_dependency_waive_commit: [
    "پیش‌نیاز با دلیل مستثنا شد",
    "Prerequisite waived with reason",
  ],
  task_checklist_create: ["چک‌لیست ساخته شد", "Checklist created"],
  task_checklist_item_add: ["مورد چک‌لیست افزوده شد", "Checklist item added"],
  task_checklist_item_check: [
    "مورد چک‌لیست علامت خورد",
    "Checklist item checked",
  ],
  task_checklist_item_uncheck: [
    "علامت مورد چک‌لیست برداشته شد",
    "Checklist item unchecked",
  ],
  task_checklist_item_promote: [
    "مورد چک‌لیست به زیرکار تبدیل شد",
    "Checklist item promoted to subtask",
  ],
  project_create: ["پروژه ساخته شد", "Project created"],
  project_update: ["پروژه ویرایش شد", "Project updated"],
  project_archive: ["پروژه بایگانی شد", "Project archived"],
  project_restore: ["پروژه بازیابی شد", "Project restored"],
  project_milestone_create: ["نقطهٔ عطف ثبت شد", "Milestone created"],
  file_register_upload: ["فایل ثبت شد", "File registered"],
  file_metadata_update: ["اطلاعات فایل تغییر کرد", "File details updated"],
  file_link_to_task: ["فایل به کار پیوند خورد", "File linked to task"],
  file_archive: ["فایل بایگانی شد", "File archived"],
  time_entry_create: ["ساعت کار ثبت شد", "Work time recorded"],
  time_entry_update: ["ساعت کار ویرایش شد", "Work time updated"],
  time_entry_archive: ["ساعت کار بایگانی شد", "Work time archived"],
  time_entry_undo: ["تغییر ساعت کار بازگردانده شد", "Work time change undone"],
  calendar_create_local_event: ["رویداد ساخته شد", "Calendar event created"],
  calendar_update_local_event: ["رویداد ویرایش شد", "Calendar event updated"],
  calendar_delete_local_event: ["رویداد حذف شد", "Calendar event deleted"],
  calendar_event_change_commit: [
    "تغییر رویداد ثبت شد",
    "Calendar event change saved",
  ],
  preferences_update: ["تنظیمات تغییر کرد", "Preferences updated"],
  task_comment_add: ["نظر افزوده شد", "Comment added"],
  undo_last_eligible_action: [
    "آخرین تغییر بازگردانده شد",
    "Last eligible change undone",
  ],
  redo_last_eligible_action: [
    "تغییر دوباره اعمال شد",
    "Last eligible change redone",
  ],
};

export function activityLabel(eventType: string, language: Language): string {
  const known = labels[eventType];
  if (known) return known[language === "fa" ? 0 : 1];
  const readable = eventType.replace(/[._]+/g, " ").trim();
  return language === "fa" ? `رویداد: ${readable}` : readable;
}
