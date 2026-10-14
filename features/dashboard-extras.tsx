"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  ActivityDTO,
  CommandName,
  MutationResult,
  EventDTO,
  PageDTO,
  TaskDTO,
} from "@/shared/contracts";
import { zonedLocalToInstant } from "@/shared/datetime";
import { IN_APP_AI_ENABLED } from "@/shared/product-features";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import { TaskRow } from "./tasks";
import {
  Button,
  Empty,
  Field,
  QueryState,
  SectionHeading,
} from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
export interface DashboardRange {
  from_date: string;
  to_date: string;
  timezone: string;
}
const allRoutes = [
  "/tasks",
  "/tasks?filter=ready",
  "/tasks?filter=blocked",
  "/tasks?filter=overdue",
  "/projects",
  "/calendar",
  "/time",
  "/files",
  "/reports",
  "/assistant",
  "/settings",
];
const routes = allRoutes.filter(
  (route) => IN_APP_AI_ENABLED || route !== "/assistant",
);

export function DashboardExtras({
  range,
  action,
  savePreferences,
  onOpen,
  settings,
  revision,
  widgetProps,
}: {
  range: DashboardRange;
  action: Action;
  savePreferences: (
    settings: Record<string, unknown>,
  ) => Promise<MutationResult | null>;
  onOpen: (id: string) => void;
  settings: Record<string, unknown>;
  revision?: number;
  widgetProps: (id: string) => React.HTMLAttributes<HTMLElement>;
}) {
  const { t, language } = useLocale();
  const urgent = useQuery<PageDTO<TaskDTO>>("task_search", {
    priority: "Urgent",
    limit: 3,
  });
  const high = useQuery<PageDTO<TaskDTO>>("task_search", {
    priority: "High",
    limit: 3,
  });
  const normal = useQuery<PageDTO<TaskDTO>>("task_search", {
    priority: "Normal",
    limit: 3,
  });
  const low = useQuery<PageDTO<TaskDTO>>("task_search", {
    priority: "Low",
    limit: 3,
  });
  const overdue = useQuery<PageDTO<TaskDTO>>("task_list_overdue", { limit: 4 });
  const meetings = useQuery<PageDTO<EventDTO>>("calendar_events_query", {
    from: zonedLocalToInstant(`${range.from_date}T00:00`, range.timezone),
    to: zonedLocalToInstant(`${range.to_date}T00:00`, range.timezone),
    limit: 5,
  });
  const ai = useQuery<PageDTO<ActivityDTO>>(
    "get_activity",
    { channel: "AI", limit: 5 },
    IN_APP_AI_ENABLED,
  );
  const [editing, setEditing] = useState(false);
  const savedShortcuts = Array.isArray(settings.dashboard_shortcuts)
    ? (settings.dashboard_shortcuts as { title: string; path: string }[])
        .filter(
          (item) =>
            typeof item.title === "string" && allRoutes.includes(item.path),
        )
        .slice(0, 12)
    : [];
  const shortcuts = savedShortcuts.filter((item) => routes.includes(item.path));
  return (
    <>
      <section className="panel" {...widgetProps("priority")}>
        <SectionHeading
          title={t("ماتریس اولویت‌های واقعی", "Actual priority matrix")}
        />
        <p className="small muted">
          {t(
            "گروه‌بندی بر پایهٔ اولویت ثبت‌شدهٔ کارهاست؛ اهمیت دیگری حدس زده نمی‌شود.",
            "Groups use each task's recorded priority.",
          )}
        </p>
        <div className="priority-matrix">
          {[
            ["Urgent", t("فوری", "Urgent"), urgent],
            ["High", t("بالا", "High"), high],
            ["Normal", t("عادی", "Normal"), normal],
            ["Low", t("کم", "Low"), low],
          ].map(([priority, label, state]) => {
            const result = state as typeof urgent;
            return (
              <div key={String(priority)}>
                <Link href={`/tasks?priority=${priority}`}>
                  <strong>
                    {String(label)} · {result.data?.total ?? "—"}
                  </strong>
                </Link>
                <QueryState {...result} retry={result.refresh} />
                {result.data?.items.map((task) => (
                  <button
                    className="text-link"
                    key={task.task_id}
                    onClick={() => onOpen(task.task_id)}
                  >
                    {task.title}
                  </button>
                ))}
                <small className="muted">
                  {t("۳ کار نخست هر گروه", "First 3 tasks in each group")}
                </small>
              </div>
            );
          })}
        </div>
      </section>
      <section className="panel" {...widgetProps("overdue")}>
        <SectionHeading
          title={t("مهلت‌های گذشته", "Overdue deadlines")}
          action={
            <Link href="/tasks?filter=overdue" className="text-link">
              {overdue.data?.total ?? "—"} {t("کار", "tasks")}
            </Link>
          }
        />
        <QueryState {...overdue} retry={overdue.refresh} />
        {overdue.data?.items.map((task) => (
          <TaskRow
            key={task.task_id}
            task={task}
            onOpen={onOpen}
            onAction={action}
          />
        ))}
        {overdue.data && !overdue.data.items.length && (
          <Empty title={t("مهلت عقب‌افتاده‌ای نیست", "No overdue deadlines")} />
        )}
      </section>
      <section className="panel" {...widgetProps("meetings")}>
        <SectionHeading
          title={t("رویدادهای بازهٔ انتخابی", "Events in selected range")}
          action={
            <Link href="/calendar" className="text-link">
              {t("تقویم", "Calendar")}
            </Link>
          }
        />
        <QueryState {...meetings} retry={meetings.refresh} />
        {meetings.data?.items.map((event) => (
          <div
            className="dependency-row"
            key={event.occurrence_key ?? event.event_id}
          >
            <strong>{event.title}</strong>
            <time>
              {new Date(event.starts_at).toLocaleString(
                language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                { timeZone: range.timezone },
              )}
            </time>
            <span className="chip">{event.provider}</span>
          </div>
        ))}
        {meetings.data && !meetings.data.items.length && (
          <Empty
            title={t("رویدادی در این بازه نیست", "No events in this range")}
          />
        )}
        <p className="muted small">
          {t("۵ رویداد نخست بازه", "First 5 events in range")} ·{" "}
          {range.timezone}
        </p>
      </section>
      {IN_APP_AI_ENABLED && (
        <section className="panel" {...widgetProps("ai")}>
          <SectionHeading
            title={t("آخرین تغییرهای دستیار", "Latest assistant changes")}
            action={
              <Link className="text-link" href="/assistant">
                {t("گفت‌وگو", "Chat")}
              </Link>
            }
          />
          <QueryState {...ai} retry={ai.refresh} />
          {ai.data?.items.map((event) => (
            <div key={event.event_id} className="dependency-row">
              <strong>{event.event_type}</strong>
              <time>
                {new Date(event.occurred_at).toLocaleString(
                  language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                  { timeZone: range.timezone },
                )}
              </time>
            </div>
          ))}
          {ai.data && !ai.data.items.length && (
            <Empty
              title={t(
                "تغییری از دستیار ثبت نشده",
                "No assistant changes recorded",
              )}
            />
          )}
        </section>
      )}
      <section className="panel" {...widgetProps("shortcuts")}>
        <SectionHeading
          title={t("میان‌برهای شخصی", "Personal shortcuts")}
          action={
            <Button
              disabled={revision === undefined}
              onClick={() => setEditing(!editing)}
            >
              {t("ویرایش میان‌برها", "Edit shortcuts")}
            </Button>
          }
        />
        <div className="form-actions">
          {shortcuts.map((item, index) => (
            <Link
              className="button"
              key={`${item.path}:${index}`}
              href={item.path}
            >
              {item.title}
            </Link>
          ))}
          {!shortcuts.length && (
            <Empty
              title={t("میان‌بر دلخواهت را ثبت کن", "Add a personal shortcut")}
            />
          )}
        </div>
        {editing && (
          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              if (revision === undefined) return;
              const form = event.currentTarget;
              const data = new FormData(form);
              const next = [
                ...savedShortcuts,
                {
                  title: String(data.get("title")),
                  path: String(data.get("path")),
                },
              ];
              if (await savePreferences({ dashboard_shortcuts: next }))
                form.reset();
            }}
          >
            <Field label={t("عنوان میان‌بر", "Shortcut title")}>
              <input
                name="title"
                required
                maxLength={100}
                disabled={revision === undefined}
              />
            </Field>
            <Field label={t("مقصد میان‌بر", "Shortcut destination")}>
              <select name="path" disabled={revision === undefined}>
                {routes.map((route) => (
                  <option key={route} value={route}>
                    {route}
                  </option>
                ))}
              </select>
            </Field>
            <Button
              type="submit"
              disabled={revision === undefined || savedShortcuts.length >= 12}
            >
              {t("ثبت میان‌بر", "Save shortcut")}
            </Button>
            {shortcuts.map((item, index) => (
              <Button
                key={index}
                type="button"
                disabled={revision === undefined}
                onClick={() =>
                  void savePreferences({
                    dashboard_shortcuts: savedShortcuts.filter(
                      (_, i) => i !== savedShortcuts.indexOf(item),
                    ),
                  })
                }
              >
                {t("حذف میان‌بر", "Remove shortcut")} {item.title}
              </Button>
            ))}
          </form>
        )}
      </section>
    </>
  );
}
