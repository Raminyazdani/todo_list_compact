"use client";

import { useState } from "react";
import type {
  CommandName,
  GraphDTO,
  MutationResult,
  PlanDTO,
  PreviewDTO,
} from "@/shared/contracts";
import { addCalendarDays, instantToLocalDate } from "@/shared/datetime";
import { query, useQuery } from "./api";
import { useLocale } from "./locale";
import {
  Button,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
type Suggestion = {
  task_id: string;
  title: string;
  original_start: string | null;
  original_due: string | null;
  start_date: string;
  finish_date: string;
};

export function PlanningPanel({
  graph,
  onOpen,
  action,
}: {
  graph: GraphDTO | null;
  onOpen: (id: string) => void;
  action: Action;
}) {
  const { t } = useLocale();
  const ids = graph?.nodes.map((task) => task.task_id) ?? [];
  const plan = useQuery<PlanDTO>(
    "dependency_topological_plan",
    { task_ids: ids },
    ids.length > 0,
  );
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [includeDeadlines, setIncludeDeadlines] = useState(false);
  const [error, setError] = useState("");
  const title = (id: string) =>
    graph?.nodes.find((task) => task.task_id === id)?.title ??
    t("کار بیرون از این صفحه", "Task outside this page");
  const unknown =
    !graph || graph.truncated || (plan.data?.hidden_neighbor_count ?? 0) > 0;
  const openCount =
    graph?.nodes.filter((task) => task.readiness !== "closed").length ?? 0;
  async function propose(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (
      !graph ||
      !plan.data ||
      !plan.data.critical_path ||
      unknown ||
      openCount > 100
    )
      return;
    try {
      const form = new FormData(event.currentTarget);
      const capacity = Number(form.get("capacity"));
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1440)
        return;
      const weekdays = form.get("weekdays") === "on";
      const nextDay = (date: string): string => {
        let result = date;
        while (
          weekdays &&
          [0, 6].includes(new Date(`${result}T12:00:00Z`).getUTCDay())
        )
          result = addCalendarDays(result, 1);
        return result;
      };
      const advance = (date: string, count: number) => {
        const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
        return addCalendarDays(
          date,
          count + (weekdays ? Math.floor((weekday + count) / 5) * 2 : 0),
        );
      };
      let day = nextDay(String(form.get("start_date"))),
        used = 0;
      const proposal: Suggestion[] = [];
      for (const id of plan.data.levels.flat()) {
        const task = graph.nodes.find((value) => value.task_id === id);
        if (!task || task.readiness === "closed") continue;
        if (task.estimated_minutes === null) return;
        if (task.start_date && task.start_date > day) {
          day = nextDay(task.start_date);
          used = 0;
        }
        const start_date = day;
        const allocated = used + task.estimated_minutes;
        const finish_date = advance(
          day,
          task.estimated_minutes === 0
            ? 0
            : Math.floor((allocated - 1) / capacity),
        );
        day = advance(day, Math.floor(allocated / capacity));
        used = allocated % capacity;
        proposal.push({
          task_id: id,
          title: task.title,
          original_start: task.start_date,
          original_due: task.due_date,
          start_date,
          finish_date,
        });
      }
      const deadlines = form.get("deadlines") === "on";
      const actual = await query<PreviewDTO>("task_batch_preview", {
        actions: proposal.map((task) => ({
          command: "task_update",
          input: {
            task_id: task.task_id,
            start_date: task.start_date,
            ...(deadlines ? { due_date: task.finish_date } : {}),
          },
        })),
      });
      setSuggestions(proposal);
      setIncludeDeadlines(deadlines);
      setPreview(actual);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <section className="panel planning-panel">
      <SectionHeading
        title={t(
          "برنامهٔ وابستگی‌ها و پیشنهاد زمان‌بندی",
          "Dependency plan & scheduling proposal",
        )}
      />
      <p className="muted small">
        {t(
          "محاسبه به همین محدودهٔ نمایش‌داده‌شده محدود است. تاریخ‌ها تنها پس از پیش‌نمایش و تأیید شما تغییر می‌کنند؛ رویداد یا یادآور خودکار ساخته نمی‌شود.",
          "Calculations use this displayed scope. Dates change only after your preview and confirmation; no event or reminder is created automatically.",
        )}
      </p>
      <QueryState {...plan} retry={plan.refresh} />
      {plan.data && (
        <>
          {unknown && (
            <p className="warning">
              {t(
                "بخشی از روابط بیرون از این محدوده است؛ برای پیشنهاد کامل یک کار محوری یا محدودهٔ کوچک‌تر انتخاب کن.",
                "Some dependencies are outside this scope. Select a focus task or a smaller complete scope before generating a schedule.",
              )}
            </p>
          )}
          <div className="planning-phases">
            {plan.data.levels.map((level, index) => (
              <div key={index}>
                <h3>
                  {t(
                    `مرحلهٔ ${index + 1} · شاخه‌های موازی`,
                    `Phase ${index + 1} · parallel branches`,
                  )}
                </h3>
                <div className="form-actions">
                  {level.slice(0, 50).map((id) => (
                    <Button key={id} onClick={() => onOpen(id)}>
                      {title(id)}
                    </Button>
                  ))}
                </div>
                {level.length > 50 && (
                  <p className="small muted">
                    {level.length - 50}{" "}
                    {t("کار دیگر در این مرحله", "more tasks in this phase")}
                  </p>
                )}
              </div>
            ))}
          </div>
          {plan.data.critical_path ? (
            <div className="critical-path">
              <h3>
                {t(
                  "طولانی‌ترین زنجیرهٔ برآوردشده",
                  "Longest estimated dependency chain",
                )}
              </h3>
              <p>
                {plan.data.total_estimated_minutes}{" "}
                {t(
                  "دقیقه؛ وابستگی‌ها و برآوردها، بدون فرض ظرفیت نامحدود واقعی",
                  "minutes; based on dependency estimates, without assuming real unlimited availability",
                )}
              </p>
              <div className="form-actions">
                {plan.data.critical_path.map((id) => (
                  <Button key={id} onClick={() => onOpen(id)}>
                    {title(id)}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <p className="warning">
              {t(
                "مسیر بحرانی قابل محاسبه نیست: برآوردهای ناقص، رابطهٔ بیرون محدوده یا گزینه‌های ANY نیازمند تصمیم‌اند. عددی حدس زده نمی‌شود.",
                "A critical path cannot be calculated: missing estimates, external boundaries or ANY alternatives need a decision. No duration is guessed.",
              )}
            </p>
          )}
          {plan.data.missing_estimates.length > 0 && (
            <details>
              <summary>
                {t("کارهای بدون برآورد", "Tasks without estimates")} ·{" "}
                {plan.data.missing_estimates.length}
              </summary>
              <div className="form-actions">
                {plan.data.missing_estimates.slice(0, 20).map((id) => (
                  <Button key={id} onClick={() => onOpen(id)}>
                    {title(id)}
                  </Button>
                ))}
              </div>
            </details>
          )}
          {plan.data.schedule_risks.map((risk, index) => (
            <div className="dependency-row warning" key={index}>
              <button onClick={() => onOpen(risk.prerequisite_task_id)}>
                {title(risk.prerequisite_task_id)}
              </button>
              <span>
                {risk.reason === "PREREQUISITE_OUTSIDE_SELECTED_PLAN"
                  ? t(
                      "پیش‌نیاز بیرون محدودهٔ برنامه است",
                      "Prerequisite is outside this plan",
                    )
                  : t(
                      "مهلت پیش‌نیاز پس از مهلت کار وابسته است",
                      "Prerequisite deadline is after its dependent deadline",
                    )}
              </span>
              <button onClick={() => onOpen(risk.task_id)}>
                {title(risk.task_id)}
              </button>
            </div>
          ))}
          <form className="form-grid schedule-proposal" onSubmit={propose}>
            <p className="small muted">
              {t(
                "پیشنهاد اجرایی برای یک نفر و ترتیب مراحل است. ظرفیت برای کل روز است؛ تعطیلات منطقه‌ای و قرارهای تقویم در این پیشنهاد رزرو نمی‌شوند. مراحل بالا امکان شاخه‌های موازی را جدا نشان می‌دهند.",
                "The execution proposal assumes one person and phase order. Capacity is for the whole day; regional holidays and calendar appointments are not reserved. The phases above separately show parallel branches.",
              )}
            </p>
            <div className="form-columns">
              <Field label={t("شروع پیشنهادی", "Proposed start")}>
                <input
                  name="start_date"
                  type="date"
                  required
                  defaultValue={instantToLocalDate(
                    new Date().toISOString(),
                    "Europe/Berlin",
                  )}
                />
              </Field>
              <Field
                label={t(
                  "ظرفیت کل روز (دقیقه)",
                  "Daily total capacity (minutes)",
                )}
              >
                <input
                  name="capacity"
                  type="number"
                  required
                  min={1}
                  max={1440}
                  defaultValue={480}
                />
              </Field>
            </div>
            <label className="check-label">
              <input name="weekdays" type="checkbox" defaultChecked />
              {t("شنبه و یکشنبه را کنار بگذار", "Skip Saturday and Sunday")}
            </label>
            <label className="check-label">
              <input name="deadlines" type="checkbox" />
              {t(
                "مهلت‌ها نیز مطابق پایان پیشنهادی تغییر کنند؛ پیش‌فرض فقط تاریخ شروع است",
                "Also change deadlines to the proposed finish; the default changes only start dates",
              )}
            </label>
            {openCount > 100 && (
              <p className="warning">
                {t(
                  "هر پیشنهاد حداکثر ۱۰۰ کار باز دارد؛ محدوده را کوچک‌تر کن.",
                  "A proposal supports up to 100 open tasks. Narrow the scope.",
                )}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button
              type="submit"
              disabled={
                unknown ||
                !plan.data.critical_path ||
                openCount === 0 ||
                openCount > 100
              }
            >
              {t(
                "پیش‌نمایش پیشنهاد؛ بدون ذخیرهٔ تاریخ",
                "Preview proposal without saving dates",
              )}
            </Button>
          </form>
        </>
      )}
      <Modal
        title={t(
          "بررسی تغییر تاریخ‌های پیشنهادی",
          "Review proposed date changes",
        )}
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        wide
      >
        <p>
          {includeDeadlines
            ? t(
                "شروع و مهلت کارها پس از تأیید تغییر می‌کنند.",
                "Start dates and deadlines change after confirmation.",
              )
            : t(
                "فقط تاریخ شروع تغییر می‌کند؛ مهلت فعلی حفظ می‌شود.",
                "Only start dates change; existing deadlines are preserved.",
              )}
        </p>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("کار", "Task")}</th>
                <th>{t("شروع فعلی", "Current start")}</th>
                <th>{t("شروع پیشنهادی", "Proposed start")}</th>
                <th>{t("پایان برآوردی", "Estimated finish")}</th>
                <th>{t("مهلت فعلی", "Current deadline")}</th>
              </tr>
            </thead>
            <tbody>
              {suggestions.map((item) => (
                <tr key={item.task_id}>
                  <td>{item.title}</td>
                  <td>{item.original_start ?? "—"}</td>
                  <td>{item.start_date}</td>
                  <td>{item.finish_date}</td>
                  <td>{item.original_due ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {preview?.warnings.map((warning) => (
          <p className="warning" key={warning}>
            {warning}
          </p>
        ))}
        <div className="form-actions">
          <Button onClick={() => setPreview(null)}>
            {t("لغو پیشنهاد", "Cancel proposal")}
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              if (
                preview &&
                (await action("task_batch_commit", {
                  preview_id: preview.preview_id,
                }))
              )
                setPreview(null);
            }}
          >
            {t("تأیید صریح و ذخیرهٔ تاریخ‌ها", "Confirm and save these dates")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
