import { z } from "zod";
import { COMMAND_NAMES, DomainError } from "@/shared/contracts";

export const modelPlanSchema = z
  .object({
    answer: z.string().max(12000),
    actions: z
      .array(
        z
          .object({
            command: z.enum(COMMAND_NAMES),
            input: z.record(z.string(), z.unknown()),
            expected_revision: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .max(20),
    warnings: z.array(z.string().max(2000)).max(30).default([]),
  })
  .strict();
export type ModelPlan = z.infer<typeof modelPlanSchema>;
const allowed = new Set([
  "task_create",
  "task_update",
  "task_complete",
  "task_reopen",
  "project_create",
  "project_update",
  "task_checklist_create",
  "task_checklist_item_add",
  "task_checklist_item_check",
  "task_checklist_item_uncheck",
  "subtask_create",
  "task_dependency_add_commit",
  "task_dependency_remove_commit",
  "subtask_reparent_commit",
  "task_template_instantiate_commit",
  "file_link_to_task",
  "file_unlink_from_task",
  "file_archive",
  "file_restore",
  "calendar_create_local_event",
  "calendar_update_local_event",
  "time_entry_create",
  "time_entry_update",
]);
export function applyPlanPolicy(
  raw: unknown,
  message: string,
  knownIds: ReadonlySet<string>,
): ModelPlan {
  const plan = modelPlanSchema.parse(raw);
  function validateNested(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(validateNested);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (
        [
          "override_reason",
          "override",
          "confirmed",
          "force",
          "explicit_user_intent",
          "human_confirmation_id",
        ].includes(key)
      )
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "مدل نمی‌تواند برای خودش مجوز ایجاد کند.",
          {},
          403,
        );
      if (key === "preview_id")
        throw new DomainError(
          "INVALID_INPUT",
          "پیش‌نمایش باید توسط سرور ساخته شود.",
        );
      if ((key.endsWith("_id") || key.endsWith("_ids")) && item !== null) {
        const ids = Array.isArray(item) ? item : [item];
        if (ids.some((id) => typeof id !== "string" || !knownIds.has(id)))
          throw new DomainError(
            "INVALID_INPUT",
            "شناسه در داده‌های بازیابی‌شده وجود ندارد.",
          );
      }
      validateNested(item);
    }
  }
  for (const action of plan.actions) {
    validateNested(action.input);
    if (!allowed.has(action.command))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "این عملیات از دستیار قابل اجرا نیست.",
        {},
        403,
      );
    if (
      action.input.override_reason ||
      action.input.override ||
      action.input.confirmed ||
      action.input.force ||
      action.input.explicit_user_intent
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "دستیار اجازهٔ دور زدن پیش‌نیازها را ندارد.",
        {},
        403,
      );
    if (
      action.command.includes("waive") &&
      !/معاف|نادیده|waiv|override/i.test(message)
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "معاف‌کردن پیش‌نیاز به درخواست صریح نیاز دارد.",
        {},
        403,
      );
    for (const [key, value] of Object.entries(action.input)) {
      if (key === "preview_id")
        throw new DomainError(
          "INVALID_INPUT",
          "پیش‌نمایش باید توسط سرور ساخته شود.",
        );
      if ((key.endsWith("_id") || key.endsWith("_ids")) && value !== null) {
        const ids = Array.isArray(value) ? value : [value];
        if (
          ids.some((value) => typeof value !== "string" || !knownIds.has(value))
        )
          throw new DomainError(
            "INVALID_INPUT",
            "شناسهٔ پیشنهادی در داده‌های بازیابی‌شده وجود ندارد؛ مورد را دقیق‌تر مشخص کنید.",
          );
      }
    }
    // The model cannot invent a deadline when the message contains no explicit date/time.
    if (
      !/\d{4}[-/]\d{1,2}[-/]\d{1,2}|[۰-۹]{4}[-/][۰-۹]{1,2}[-/][۰-۹]{1,2}|\d{1,2}:\d{2}|فردا|پس‌فردا|هفتهٔ? آینده|tomorrow|next week/i.test(
        message,
      )
    ) {
      for (const field of ["due_date", "due_at", "start_date"])
        if (action.input[field]) {
          delete action.input[field];
          plan.warnings.push(
            "موعد پیشنهادی حذف شد؛ در درخواست شما تاریخ مشخصی نبود.",
          );
        }
    }
  }
  return plan;
}
