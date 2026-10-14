"use client";

import Link from "next/link";
import type { MutationResult } from "@/shared/contracts";
import { useLocale } from "./locale";

export interface AISimulation {
  read_only: true;
  atomic: true;
  changes: {
    command: string;
    entity_id: string;
    input: Record<string, unknown>;
    after: unknown;
    after_truncated: boolean;
    readiness_changes: MutationResult["readiness_changes"];
    readiness_changes_total: number;
    readiness_changes_truncated: boolean;
    preview?: { changes: unknown; changes_truncated: boolean };
  }[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function AIProposalPreview({
  simulation,
}: {
  simulation: AISimulation;
}) {
  const { t } = useLocale();
  const names: Record<string, string> = {};
  const proposedIds = new Set<string>();
  function collectNames(value: unknown, depth = 0): void {
    if (depth > 8) return;
    if (Array.isArray(value)) {
      value.slice(0, 40).forEach((item) => collectNames(item, depth + 1));
      return;
    }
    const row = object(value);
    const id = row.task_id ?? row.prerequisite_task_id;
    if (typeof id === "string" && typeof row.title === "string")
      names[id] = row.title;
    for (const key of [
      "prerequisites",
      "blocked_by",
      "nodes",
      "subtasks",
      "items",
    ])
      collectNames(row[key], depth + 1);
  }
  for (const change of simulation.changes) {
    const after = object(change.after);
    if (typeof after.title === "string") names[change.entity_id] = after.title;
    collectNames(change.after);
    if (change.command === "task_create") proposedIds.add(change.entity_id);
  }
  const commandNames: Record<string, string> = {
    task_create: t("ساخت کار", "Create task"),
    task_update: t("ویرایش کار", "Update task"),
    task_complete: t("تکمیل کار", "Complete task"),
    task_reopen: t("بازگشایی کار", "Reopen task"),
    task_dependency_add_commit: t("افزودن پیش‌نیاز", "Add prerequisite"),
    task_dependency_remove_commit: t("حذف پیش‌نیاز", "Remove prerequisite"),
    subtask_reparent_commit: t("تغییر کار والد", "Change parent task"),
    task_template_instantiate_commit: t("ساخت از قالب", "Instantiate template"),
    task_checklist_item_promote: t(
      "تبدیل آیتم به کار",
      "Promote checklist item",
    ),
  };
  const readiness = (value: string) =>
    ({
      ready: t("آماده", "Ready"),
      blocked: t("مسدود", "Blocked"),
      scheduled: t("زمان‌بندی‌شده", "Scheduled"),
      closed: t("بسته", "Closed"),
    })[value] ?? value;
  return (
    <section aria-label={t("پیش‌نمایش اثر تغییرها", "Change impact preview")}>
      <h3>{t("اثر تغییرها پیش از تأیید", "Impact before approval")}</h3>
      <p className="muted">
        {t(
          "این تغییرها هنوز ذخیره نشده‌اند. همهٔ مراحل این پیشنهاد با هم اجرا می‌شوند؛ اگر یک مرحله ناموفق باشد، هیچ‌کدام ذخیره نمی‌شود.",
          "These changes are not saved yet. All steps run together; if a step fails, none are saved.",
        )}
      </p>
      {simulation.changes.map((change, index) => {
        const after = object(change.after);
        const target =
          typeof change.input.task_id === "string"
            ? change.input.task_id
            : null;
        const prerequisites = Array.isArray(change.input.prerequisites)
          ? change.input.prerequisites
          : [];
        const hard = prerequisites.filter(
          (item) => object(item).mode !== "soft",
        );
        const soft = prerequisites.filter(
          (item) => object(item).mode === "soft",
        );
        const prerequisiteList = (items: unknown[]) => (
          <ul>
            {items.map((item, itemIndex) => {
              const row = object(item);
              return (
                <li key={itemIndex}>
                  {typeof row.task_id === "string"
                    ? (names[row.task_id] ?? row.task_id)
                    : t(
                        "جزئیات پایین را بررسی کنید",
                        "Review the details below",
                      )}
                </li>
              );
            })}
          </ul>
        );
        return (
          <article className="ai-action" key={`${index}:${change.entity_id}`}>
            <strong>
              {index + 1}. {commandNames[change.command] ?? change.command}
            </strong>
            {typeof after.title === "string" && <p>{after.title}</p>}
            {target && (
              <p>
                {t("کار هدف: ", "Target task: ")}
                {proposedIds.has(target) ? (
                  <span>
                    {names[target] ?? target} (
                    {t("هنوز ساخته نشده", "not created yet")})
                  </span>
                ) : (
                  <Link href={`/tasks?task=${encodeURIComponent(target)}`}>
                    {names[target] ?? target}
                  </Link>
                )}
              </p>
            )}
            {hard.length > 0 && (
              <div>
                <p>
                  {change.input.operator === "ANY"
                    ? t(
                        "حداقل یکی از این پیش‌نیازها باید تکمیل شود:",
                        "At least one prerequisite must be complete:",
                      )
                    : t(
                        "همهٔ این پیش‌نیازها باید تکمیل شوند:",
                        "All prerequisites must be complete:",
                      )}
                </p>
                {prerequisiteList(hard)}
              </div>
            )}
            {soft.length > 0 && (
              <div>
                <p>
                  {t(
                    "این پیش‌نیازها پیشنهادی‌اند و شروع کار را مسدود نمی‌کنند:",
                    "These prerequisites are advisory and do not block starting:",
                  )}
                </p>
                {prerequisiteList(soft)}
              </div>
            )}
            {change.readiness_changes.length > 0 && (
              <ul>
                {change.readiness_changes.map((item) => (
                  <li key={item.task_id}>
                    {names[item.task_id] ?? item.task_id}:{" "}
                    {readiness(item.before)} → {readiness(item.after)}
                  </li>
                ))}
              </ul>
            )}
            {(change.after_truncated ||
              change.preview?.changes_truncated ||
              change.readiness_changes_truncated) && (
              <p className="warning">
                {t(
                  "بخشی از پیش‌نمایش به‌دلیل محدودیت اندازه نمایش داده نشده؛ این فهرست کامل نیست.",
                  "Some preview details exceed the display limit; this list is incomplete.",
                )}
              </p>
            )}
            <details>
              <summary>
                {t("جزئیات تغییر پیشنهادی", "Proposed change details")}
              </summary>
              <pre className="preview-json">
                {JSON.stringify(
                  {
                    input: change.input,
                    after: change.after,
                    preview: change.preview?.changes,
                    readiness_changes_total: change.readiness_changes_total,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </article>
        );
      })}
    </section>
  );
}
