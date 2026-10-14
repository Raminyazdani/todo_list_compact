import { z } from "zod";
import { COMMAND_NAMES, DomainError } from "@/shared/contracts";
import { READ_SCHEMAS } from "@/server/mcp/catalog";

export const AI_READ_NAMES = [
  "task_search",
  "task_get",
  "task_graph_get",
  "task_dependencies_get",
  "task_find_ready",
  "task_find_blocked",
  "task_completion_impact_preview",
  "task_template_list",
] as const;
const alias = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
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
            local_ref: alias.optional(),
          })
          .strict(),
      )
      .max(20),
    reads: z
      .array(
        z
          .object({
            query: z.enum(AI_READ_NAMES),
            input: z.record(z.string(), z.unknown()),
          })
          .strict(),
      )
      .max(4)
      .default([]),
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
  "task_checklist_item_promote",
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
const taskReferenceFields = new Set([
  "task_id",
  "parent_task_id",
  "dependent_task_id",
  "prerequisite_task_id",
]);
export function proposalReference(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 1 &&
    alias.safeParse(row.proposal_ref).success
    ? String(row.proposal_ref)
    : null;
}
export function originalItemChoice(
  message: string,
): "archive" | "keep_reference" | null {
  // The presence of a choice word is not consent. Negated, hypothetical or
  // interrogative wording stays unresolved and asks the owner explicitly.
  if (
    /\b(?:not|never|without|don't|don’t|dont|cannot|can't|can’t|should|whether|maybe)\b|نکن|نکرد|نباید|نمی|نشود|نشه|نگه\s+ندار|حفظ\s+ن|بدون|[؟?]/iu.test(
      message,
    )
  )
    return null;
  const keep =
    /keep_reference|keep\s+(?:the\s+)?(?:original|reference)|(?:اصل|اصلی|مرجع).{0,24}(?:نگه|حفظ)|حفظ.{0,16}(?:اصل|اصلی|مرجع)/i.test(
      message,
    );
  const archive =
    /archive\s+(?:the\s+)?original|(?:اصل|اصلی).{0,24}(?:آرشیو|بایگانی)|(?:آرشیو|بایگانی).{0,16}(?:اصل|اصلی)/i.test(
      message,
    );
  return keep === archive ? null : keep ? "keep_reference" : "archive";
}
export function applyPlanPolicy(
  raw: unknown,
  message: string,
  knownIds: ReadonlySet<string>,
  revisions: ReadonlyMap<string, number> = new Map(),
): ModelPlan {
  const plan = modelPlanSchema.parse(raw);
  if (plan.reads.length && plan.actions.length)
    throw new DomainError(
      "INVALID_INPUT",
      "خواندن زمینه و پیشنهاد تغییر باید در مراحل جدا باشد.",
    );
  const aliases = new Set<string>();
  function validateNested(value: unknown, allowRefs: boolean, depth = 0): void {
    if (depth > 12)
      throw new DomainError(
        "INVALID_INPUT",
        "ساختار پیشنهادی بیش از حد تو در تو است.",
      );
    if (Array.isArray(value)) {
      value.forEach((item) => validateNested(item, allowRefs, depth + 1));
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
          "owner_id",
          "ownerId",
          "reserved_task_id",
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
      if (key === "proposal_ref")
        throw new DomainError(
          "INVALID_INPUT",
          "ارجاع محلی فقط در فیلد شناسهٔ تسک مجاز است.",
        );
      if ((key.endsWith("_id") || key.endsWith("_ids")) && item !== null) {
        const ref = proposalReference(item);
        if (ref !== null) {
          if (!allowRefs || !taskReferenceFields.has(key) || !aliases.has(ref))
            throw new DomainError(
              "INVALID_INPUT",
              "ارجاع محلی باید به تسک قبلی همین پیشنهاد اشاره کند.",
            );
          continue;
        }
        const ids = Array.isArray(item) ? item : [item];
        if (ids.some((id) => typeof id !== "string" || !knownIds.has(id)))
          throw new DomainError(
            "INVALID_INPUT",
            "شناسه در داده‌های بازیابی‌شده وجود ندارد.",
          );
      }
      validateNested(item, allowRefs, depth + 1);
    }
  }
  for (const read of plan.reads) {
    validateNested(read.input, false);
    read.input = READ_SCHEMAS[read.query].parse(read.input) as Record<
      string,
      unknown
    >;
    if (typeof read.input.limit === "number" && read.input.limit > 40)
      read.input.limit = 40;
    if (
      [
        "task_search",
        "task_find_ready",
        "task_find_blocked",
        "task_graph_get",
        "task_template_list",
      ].includes(read.query)
    )
      read.input.limit ??= 40;
  }
  for (const action of plan.actions) {
    if (!allowed.has(action.command))
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "این عملیات از دستیار قابل اجرا نیست.",
        {},
        403,
      );
    if (action.command === "task_create" && "task_id" in action.input)
      throw new DomainError(
        "INVALID_INPUT",
        "شناسهٔ تسک جدید فقط توسط سرور ساخته می‌شود.",
      );
    validateNested(action.input, true);
    if (action.local_ref) {
      if (action.command !== "task_create" || aliases.has(action.local_ref))
        throw new DomainError(
          "INVALID_INPUT",
          "نام محلی یکتا فقط برای ساخت تسک مجاز است.",
        );
      aliases.add(action.local_ref);
    }
    if (action.command === "task_checklist_item_promote") {
      const choice = originalItemChoice(message);
      if (!choice) {
        plan.actions = [];
        plan.answer =
          "آیتم اصلی را پس از تبدیل به زیرکار، به‌صورت مرجعِ تیک‌خورده نگه دارم یا آرشیو کنم؟";
        return plan;
      }
      if (action.input.original !== choice)
        throw new DomainError(
          "INVALID_INPUT",
          "انتخاب آیتم اصلی باید مطابق درخواست صریح شما باشد.",
        );
      const revision = revisions.get(String(action.input.item_id));
      if (
        !revision ||
        (action.expected_revision !== undefined &&
          action.expected_revision !== revision)
      )
        throw new DomainError(
          "REVISION_CONFLICT",
          "نسخهٔ واقعی آیتم باید از زمینهٔ بازیابی‌شده تأیید شود.",
          {},
          409,
        );
      action.expected_revision = revision;
    }
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
