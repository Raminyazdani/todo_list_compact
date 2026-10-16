"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  BrainCircuit,
  Download,
  FileText,
  GitBranch,
  History,
  Link2,
  LockKeyhole,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import type {
  ActivityDTO,
  CommandName,
  FileDTO,
  MutationResult,
  PageDTO,
  ProjectDTO,
  TaskDTO,
} from "@/shared/contracts";
import { IN_APP_AI_ENABLED } from "@/shared/product-features";
import { authClient } from "@/server/auth/client";
import {
  addCalendarDays,
  instantToLocalDate,
  zonedLocalToInstant,
} from "@/shared/datetime";
import { query, useQuery, clearQueryCache, clearMutationIntents } from "./api";
import { useLocale } from "./locale";
import { TaskRow } from "./tasks";
import { ProjectWorkspace } from "./projects";
import { FullReports } from "./reports";
import { Connections } from "./connections";
import { FileWorkspace } from "./files";
import { DashboardExtras, type DashboardRange } from "./dashboard-extras";
import { ExperienceSettings } from "./experience-settings";
import { PasswordSettings } from "./security-settings";
import { InstallAppCard } from "@/components/pwa";
import { AIProposalPreview, type AISimulation } from "./ai-preview";
import {
  Button,
  Empty,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";

export interface TrendDTO {
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
type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
export interface Analytics {
  tasks: {
    total: number;
    open: number;
    done: number;
    ready: number;
    blocked: number;
    overdue: number;
  };
  projects: ProjectDTO[];
  time: { minutes: number };
  files: { total: number };
  recent_activity: ActivityDTO[];
  trends?: TrendDTO;
}

export function Dashboard({
  action,
  onOpen,
}: {
  action: Action;
  onOpen: (id: string) => void;
}) {
  const { t, language } = useLocale();
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const [preferencesSaving, setPreferencesSaving] = useState(false);
  const preferencesSavingRef = useRef(false);
  const preferencesEditable =
    !!preferences.data &&
    !preferences.error &&
    !preferences.fetching &&
    !preferencesSaving;
  const [customize, setCustomize] = useState(false);
  const [localRange, setLocalRange] = useState<DashboardRange | null>(null);
  const [fallbackDay] = useState(() =>
    instantToLocalDate(Date.now(), "Europe/Berlin"),
  );
  const fallbackRange = {
    from_date: fallbackDay,
    to_date: addCalendarDays(fallbackDay, 8),
    timezone: "Europe/Berlin",
  };
  const savedRange = preferences.data?.settings.dashboard_range as
    DashboardRange | undefined;
  let persistedRange = fallbackRange;
  try {
    if (
      savedRange &&
      savedRange.from_date &&
      savedRange.to_date &&
      savedRange.timezone &&
      Date.parse(
        zonedLocalToInstant(`${savedRange.to_date}T00:00`, savedRange.timezone),
      ) >
        Date.parse(
          zonedLocalToInstant(
            `${savedRange.from_date}T00:00`,
            savedRange.timezone,
          ),
        )
    )
      persistedRange = savedRange;
  } catch {
    /* Invalid imported preferences use the current local default. */
  }
  const range = localRange ?? persistedRange;
  const defaults = [
    { id: "focus", title: t("قدم‌های بعدی", "Next moves") },
    { id: "calendar", title: t("نمای روز", "Day preview") },
    { id: "blocked", title: t("رادار پیش‌نیازها", "Blocked radar") },
    { id: "activity", title: t("تاریخچه", "Activity") },
    { id: "projects", title: t("ریسک پروژه‌ها", "Project risks") },
    { id: "waiting", title: t("منتظر پاسخ", "Waiting for responses") },
    { id: "upcoming", title: t("مهلت‌های هفته", "Upcoming deadlines") },
    { id: "workload", title: t("زمان کار این هفته", "Work time this week") },
    { id: "review", title: t("مرور هفتگی", "Weekly review") },
    { id: "files", title: t("منابع تازه", "Recent files") },
    { id: "sources", title: t("وضعیت منابع", "Source status") },
    { id: "priority", title: t("ماتریس اولویت", "Priority matrix") },
    { id: "overdue", title: t("مهلت‌های گذشته", "Overdue") },
    { id: "meetings", title: t("رویدادهای بازه", "Events in range") },
    { id: "ai", title: t("آخرین تغییرهای دستیار", "Latest AI changes") },
    { id: "shortcuts", title: t("میان‌برها", "Shortcuts") },
  ].filter((item) => IN_APP_AI_ENABLED || item.id !== "ai");
  const saved = Array.isArray(preferences.data?.settings.dashboard_widgets)
    ? (preferences.data.settings.dashboard_widgets as {
        id: string;
        visible: boolean;
        order: number;
        width: string;
        height?: number | null;
      }[])
    : [];
  const widgets = defaults
    .map((item, index) => ({
      ...item,
      visible: saved.find((value) => value.id === item.id)?.visible !== false,
      order: saved.find((value) => value.id === item.id)?.order ?? index,
      width: saved.find((value) => value.id === item.id)?.width ?? "normal",
      height: saved.find((value) => value.id === item.id)?.height ?? null,
    }))
    .sort((a, b) => a.order - b.order);
  function widget(id: string) {
    return widgets.find((item) => item.id === id)!;
  }
  function widgetStyle(id: string) {
    return {
      order: widget(id).order,
      gridColumn: widget(id).width === "wide" ? "1 / -1" : undefined,
      height: widget(id).height || undefined,
      overflow: widget(id).height ? "auto" : undefined,
      resize: preferencesEditable ? ("vertical" as const) : ("none" as const),
    };
  }
  function widgetProps(id: string) {
    return {
      "data-widget-id": id,
      role: "region" as const,
      tabIndex: 0,
      "aria-label": widget(id).title,
      hidden: !widget(id).visible,
      style: widgetStyle(id),
      draggable: preferencesEditable,
      onDragStart: (event: React.DragEvent<HTMLElement>) => {
        if (!preferencesEditable || preferencesSavingRef.current) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData("text/lifeos-widget", id);
      },
      onDragOver: (event: React.DragEvent<HTMLElement>) => {
        if (preferencesEditable) event.preventDefault();
      },
      onDrop: (event: React.DragEvent<HTMLElement>) => dropWidget(event, id),
    };
  }
  async function saveDashboardPreferences(settings: Record<string, unknown>) {
    if (
      !preferencesEditable ||
      preferencesSavingRef.current ||
      !preferences.data
    )
      return null;
    preferencesSavingRef.current = true;
    setPreferencesSaving(true);
    try {
      return await action(
        "preferences_update",
        { settings },
        preferences.data.revision,
      );
    } finally {
      preferencesSavingRef.current = false;
      setPreferencesSaving(false);
    }
  }
  async function saveWidgets(next: typeof widgets) {
    return saveDashboardPreferences({
      dashboard_widgets: [
        ...next.map(({ id, visible, order, width, height }) => ({
          id,
          visible,
          order,
          width,
          height,
        })),
        ...(!IN_APP_AI_ENABLED ? saved.filter((item) => item.id === "ai") : []),
      ],
    });
  }
  function moveWidget(id: string, delta: number) {
    if (!preferencesEditable || preferencesSavingRef.current) return;
    const next = [...widgets];
    const from = next.findIndex((item) => item.id === id);
    const to = Math.min(next.length - 1, Math.max(0, from + delta));
    [next[from], next[to]] = [next[to], next[from]];
    void saveWidgets(next.map((item, index) => ({ ...item, order: index })));
  }
  function dropWidget(event: React.DragEvent<HTMLElement>, id: string) {
    event.preventDefault();
    if (!preferencesEditable || preferencesSavingRef.current) return;
    const source = event.dataTransfer.getData("text/lifeos-widget");
    const from = widgets.findIndex((item) => item.id === source),
      to = widgets.findIndex((item) => item.id === id);
    if (from < 0 || to < 0) return;
    const next = [...widgets];
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    void saveWidgets(next.map((item, index) => ({ ...item, order: index })));
  }
  const resizeIntent = useRef<{
    element: HTMLElement;
    before: number;
    revision: number;
  } | null>(null);
  function beginWidgetResize(event: React.PointerEvent<HTMLElement>) {
    if (
      !preferencesEditable ||
      preferencesSavingRef.current ||
      !preferences.data
    )
      return;
    const element = (event.target as HTMLElement).closest<HTMLElement>(
      ".dashboard-grid > section",
    );
    if (!element) return;
    const rect = element.getBoundingClientRect();
    if (
      event.clientY >= rect.bottom - 18 &&
      (event.clientX <= rect.left + 18 || event.clientX >= rect.right - 18)
    )
      resizeIntent.current = {
        element,
        before: rect.height,
        revision: preferences.data.revision,
      };
  }
  function finishWidgetResize(commit: boolean) {
    const active = resizeIntent.current;
    resizeIntent.current = null;
    if (!active) return;
    const height = Math.round(active.element.getBoundingClientRect().height);
    const id = active.element.dataset.widgetId;
    const current = widgets.find((item) => item.id === id);
    // Native CSS resize changes the DOM before persistence. Return to the
    // canonical height until this exact edit is acknowledged and read back.
    active.element.style.height = current?.height ? `${current.height}px` : "";
    if (
      commit &&
      preferencesEditable &&
      !preferencesSavingRef.current &&
      active.revision === preferences.data?.revision &&
      id &&
      Math.abs(height - active.before) > 4
    )
      void saveWidgets(
        widgets.map((item) =>
          item.id === id
            ? { ...item, height: Math.max(200, Math.min(1400, height)) }
            : item,
        ),
      );
  }
  const data = useQuery<Analytics>("analytics_summary", { ...range });
  const ready = useQuery<PageDTO<TaskDTO>>("task_find_ready", { limit: 6 });
  const blocked = useQuery<PageDTO<TaskDTO>>("task_find_blocked", { limit: 4 });
  const [calendarFrom, setCalendarFrom] = useState(() =>
    new Date().toISOString(),
  );
  useEffect(() => {
    const timer = window.setInterval(
      () => setCalendarFrom(new Date().toISOString()),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const calendarDay = instantToLocalDate(calendarFrom, range.timezone);
  const weekStart = addCalendarDays(
    calendarDay,
    -((new Date(`${calendarDay}T12:00:00Z`).getUTCDay() + 6) % 7),
  );
  const waiting = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    { status: "Waiting", limit: 4 },
    widget("waiting").visible,
  );
  const upcoming = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    {
      due_from: range.from_date,
      due_to: range.to_date,
      limit: 4,
    },
    widget("upcoming").visible,
  );
  const recentFiles = useQuery<PageDTO<FileDTO>>(
    "file_search",
    { limit: 4 },
    widget("files").visible,
  );
  const projectRisks = useQuery<PageDTO<ProjectDTO>>(
    "project_list",
    { limit: 100 },
    widget("projects").visible,
  );
  const weeklyTime = useQuery<{
    minutes: number;
    employers: Record<string, number>;
    entries: number;
  }>(
    "time_summary",
    {
      from: zonedLocalToInstant(`${weekStart}T00:00`, range.timezone),
      to: zonedLocalToInstant(
        `${addCalendarDays(weekStart, 7)}T00:00`,
        range.timezone,
      ),
    },
    widget("workload").visible,
  );
  const sourceStatus = useQuery<{
    migration_batches: { status: string; created_at: string }[];
    jobs: { state: string }[];
    external_sync: Record<string, unknown>;
  }>("sync_status", {}, widget("sources").visible);
  const risks =
    projectRisks.data?.items.filter(
      (project) =>
        (project.blocked ?? 0) > 0 ||
        Boolean(
          project.due_date &&
          project.due_date < calendarDay &&
          (project.done ?? 0) < (project.total ?? 0),
        ),
    ) ?? [];
  const reviewWeek = data.data?.trends?.weeks.find(
    (week) => week.week_start === weekStart,
  );
  const events = useQuery<PageDTO<Record<string, unknown>>>(
    "calendar_events_query",
    {
      from: zonedLocalToInstant(`${calendarDay}T00:00`, range.timezone),
      to: zonedLocalToInstant(
        `${addCalendarDays(calendarDay, 1)}T00:00`,
        range.timezone,
      ),
      limit: 5,
    },
  );
  const [capture, setCapture] = useState("");
  const now = new Date();
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {new Intl.DateTimeFormat(
              language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
              {
                weekday: "long",
                month: "long",
                day: "numeric",
                timeZone: range.timezone,
              },
            ).format(now)}
          </div>
          <h1>{t("امروز را روشن شروع کن.", "Make room for what matters.")}</h1>
          <p>
            {t(
              "یک نگاه به روزت، یک قدم به جلو.",
              "A view of your day. A clear next step.",
            )}
          </p>
        </div>
        <div className="form-actions">
          <Button
            disabled={!preferencesEditable}
            onClick={() => setCustomize(true)}
          >
            {t("چیدمان داشبورد", "Customize dashboard")}
          </Button>
          <div className="private-label">
            <LockKeyhole size={14} />
            {t("فضای خصوصی تو", "Your private workspace")}
          </div>
        </div>
      </div>
      <form
        className="quick-capture"
        onSubmit={async (event) => {
          event.preventDefault();
          const result = await action("task_create", { title: capture });
          if (result) setCapture("");
        }}
      >
        <div className="capture-icon">
          <Sparkles size={20} />
        </div>
        <input
          value={capture}
          onChange={(event) => setCapture(event.target.value)}
          required
          placeholder={t(
            "چیزی در ذهنته؟ همین‌جا ثبتش کن…",
            "Something on your mind? Capture it here…",
          )}
          aria-label={t("ثبت سریع کار", "Quick capture")}
        />
        <Button type="submit" variant="primary" disabled={!capture.trim()}>
          {t("ثبت کار", "Capture")}
          <ArrowUpRight size={16} />
        </Button>
      </form>
      <form
        className="filter-bar"
        key={`${range.from_date}:${range.to_date}:${range.timezone}`}
        onSubmit={async (event) => {
          event.preventDefault();
          if (!preferencesEditable || preferencesSavingRef.current) return;
          const form = new FormData(event.currentTarget);
          const next = {
            from_date: String(form.get("from_date")),
            to_date: String(form.get("to_date")),
            timezone: String(form.get("timezone")),
          };
          try {
            const start = Date.parse(
                zonedLocalToInstant(`${next.from_date}T00:00`, next.timezone),
              ),
              end = Date.parse(
                zonedLocalToInstant(`${next.to_date}T00:00`, next.timezone),
              );
            if (end <= start || end - start > 366 * 86400000)
              throw new Error(
                t(
                  "بازه باید مثبت و حداکثر یک سال باشد",
                  "Range must be ordered and at most one year",
                ),
              );
            if (await saveDashboardPreferences({ dashboard_range: next }))
              setLocalRange(next);
          } catch (error) {
            window.dispatchEvent(
              new CustomEvent("lifeos:error", {
                detail: error instanceof Error ? error.message : String(error),
              }),
            );
          }
        }}
      >
        <Field label={t("شروع بازهٔ داشبورد", "Dashboard range starts")}>
          <input
            name="from_date"
            disabled={!preferencesEditable}
            type="date"
            required
            defaultValue={range.from_date}
          />
        </Field>
        <Field
          label={t(
            "پایان بازهٔ داشبورد (شامل نمی‌شود)",
            "Dashboard range ends (exclusive)",
          )}
        >
          <input
            name="to_date"
            disabled={!preferencesEditable}
            type="date"
            required
            defaultValue={range.to_date}
          />
        </Field>
        <Field label={t("منطقهٔ زمانی داشبورد", "Dashboard timezone")}>
          <select
            disabled={!preferencesEditable}
            name="timezone"
            defaultValue={range.timezone}
          >
            <option>Europe/Berlin</option>
            <option>Asia/Tehran</option>
            <option>UTC</option>
            {!["Europe/Berlin", "Asia/Tehran", "UTC"].includes(
              range.timezone,
            ) && <option>{range.timezone}</option>}
          </select>
        </Field>
        <Button disabled={!preferencesEditable} type="submit">
          {t("ثبت بازهٔ داشبورد", "Save dashboard range")}
        </Button>
      </form>
      <QueryState {...preferences} retry={preferences.refresh} />
      <p className="small muted">
        {t(
          "بازه برای رویدادها و روندهای فعالیت در منطقهٔ زمانی انتخابی است؛ مهلت‌های پیش‌رو بر پایهٔ روز برلین فیلتر می‌شوند. شمار کارها وضعیت فعلی فضای شماست.",
          "Events and activity trends use the selected timezone; upcoming deadlines are filtered by Berlin calendar dates. Task counts describe the current workspace.",
        )}{" "}
        {range.timezone}
      </p>
      <QueryState {...data} retry={data.refresh} />
      <div className="metric-grid">
        {[
          ["ready", t("آمادهٔ شروع", "Ready to start"), "ready"],
          ["open", t("کار باز", "Open tasks"), "all"],
          [
            "blocked",
            t("منتظر پیش‌نیاز", "Waiting on prerequisites"),
            "blocked",
          ],
          ["overdue", t("مهلت گذشته", "Overdue"), "overdue"],
        ].map(([key, label, filter]) => (
          <Link
            className="metric-card"
            href={`/tasks?filter=${filter}`}
            key={key}
          >
            <span>
              {label}
              <ArrowUpRight size={14} />
            </span>
            <strong>
              {data.data
                ? data.data.tasks[key as keyof Analytics["tasks"]]
                : "—"}
            </strong>
            <small>
              {key === "ready"
                ? t("یک قدم کوچک بردار", "Take one small step")
                : key === "blocked"
                  ? t("زنجیره‌ها را روشن ببین", "See exactly what is needed")
                  : t("از داده‌های زندهٔ شما", "From your live workspace")}
            </small>
          </Link>
        ))}
      </div>
      <div
        className="dashboard-grid"
        onPointerDownCapture={beginWidgetResize}
        onPointerUpCapture={() => finishWidgetResize(true)}
        onPointerCancelCapture={() => finishWidgetResize(false)}
      >
        <DashboardExtras
          range={range}
          action={action}
          savePreferences={saveDashboardPreferences}
          onOpen={onOpen}
          settings={preferences.data?.settings ?? {}}
          revision={
            preferencesEditable ? preferences.data?.revision : undefined
          }
          widgetProps={widgetProps}
        />
        <section className="panel focus-panel" {...widgetProps("focus")}>
          <SectionHeading
            title={t("قدم‌های بعدی", "Your next moves")}
            subtitle={t(
              "کارهایی که همین حالا آمادهٔ شروع هستند",
              "Tasks with satisfied prerequisites",
            )}
            action={
              <Link className="text-link" href="/tasks?filter=ready">
                {t("همهٔ کارها", "All tasks")}
                <ChevronIcon />
              </Link>
            }
          />
          <QueryState {...ready} retry={ready.refresh} />
          {ready.data?.items.length
            ? ready.data.items.map((task) => (
                <TaskRow
                  key={task.task_id}
                  task={task}
                  onOpen={onOpen}
                  onAction={action}
                />
              ))
            : !ready.loading &&
              !ready.error &&
              ready.data && (
                <Empty
                  title={t(
                    "قدم بعدی‌ات اینجا ظاهر می‌شود",
                    "Your next step will appear here",
                  )}
                  detail={t(
                    "یک کار ثبت کن یا پیش‌نیازهای کارهای فعلی را تکمیل کن.",
                    "Capture a task or resolve an existing prerequisite.",
                  )}
                />
              )}
        </section>
        <section className="panel calendar-peek" {...widgetProps("calendar")}>
          <SectionHeading
            title={t("فضای روز", "A little room for today")}
            action={
              <Link href="/calendar" className="text-link">
                {t("تقویم", "Calendar")}
                <ChevronIcon />
              </Link>
            }
          />
          <div className="peek-date">
            <span>
              {new Intl.DateTimeFormat(
                language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                { weekday: "long", timeZone: range.timezone },
              ).format(now)}
            </span>
            <strong>
              {new Intl.DateTimeFormat(
                language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                { day: "numeric", timeZone: range.timezone },
              ).format(now)}
            </strong>
            <small>{range.timezone}</small>
          </div>
          <QueryState {...events} retry={events.refresh} />
          {events.data?.items.length ? (
            events.data.items.map((event) => (
              <div className="peek-event" key={String(event.event_id)}>
                <i />
                <div>
                  <strong>{String(event.title)}</strong>
                  <small>
                    {new Date(String(event.starts_at)).toLocaleTimeString(
                      language === "fa" ? "fa-IR" : "en-GB",
                      {
                        hour: "2-digit",
                        minute: "2-digit",
                        timeZone: range.timezone,
                      },
                    )}
                  </small>
                </div>
              </div>
            ))
          ) : !events.loading && !events.error && events.data ? (
            <p className="muted small centered">
              {t("رویداد آینده‌ای ثبت نشده.", "No upcoming events recorded.")}
            </p>
          ) : null}
          <Link href="/calendar" className="button">
            {t("برای زمانت برنامه بساز", "Plan a little time")}
            <ArrowUpRight size={14} />
          </Link>
        </section>
        <section className="panel" {...widgetProps("blocked")}>
          <SectionHeading
            title={t("رادار پیش‌نیازها", "Blocked radar")}
            subtitle={t("چه چیزی باید جلو برود؟", "What needs to move first?")}
          />
          <QueryState {...blocked} retry={blocked.refresh} />
          {blocked.data?.items.length ? (
            blocked.data.items.map((task) => (
              <button
                className="blocked-card"
                key={task.task_id}
                onClick={() => onOpen(task.task_id)}
              >
                <GitBranch size={17} />
                <div>
                  <strong>{task.title}</strong>
                  <small>
                    {task.blocked_by.map((item) => item.title).join(" · ")}
                  </small>
                </div>
                <span>{task.blocked_by.length}</span>
              </button>
            ))
          ) : !blocked.loading && !blocked.error && blocked.data ? (
            <Empty
              title={t("پیش‌نیاز ناتمامی پیدا نشد", "No blocked tasks found")}
            />
          ) : null}
        </section>
        <section className="panel" {...widgetProps("activity")}>
          <SectionHeading
            title={t("رد قدم‌ها", "Your activity")}
            action={
              <Link href="/reports" className="text-link">
                {t("گزارش", "Reports")}
                <ChevronIcon />
              </Link>
            }
          />
          <Activity
            events={data.data?.recent_activity.slice(0, 5) ?? []}
            timezone={range.timezone}
          />
        </section>

        <section className="panel" {...widgetProps("projects")}>
          <SectionHeading
            title={widget("projects").title}
            action={
              <Link className="text-link" href="/projects">
                {t("همهٔ پروژه‌ها", "All projects")}
              </Link>
            }
          />
          <QueryState {...projectRisks} retry={projectRisks.refresh} />
          {risks.slice(0, 4).map((project) => (
            <Link
              className="blocked-card"
              key={project.project_id}
              href={`/projects?project=${encodeURIComponent(project.project_id)}`}
            >
              <GitBranch size={17} />
              <div>
                <strong>{project.title}</strong>
                <small>
                  {project.blocked ?? 0} {t("کار مسدود", "blocked tasks")} ·{" "}
                  {project.done ?? 0}/{project.total ?? 0}
                  {project.due_date && ` · ${project.due_date}`}
                </small>
              </div>
            </Link>
          ))}
          {projectRisks.data && !risks.length && (
            <Empty
              title={t(
                "در این محدوده ریسکی پیدا نشد",
                "No risks found in this scope",
              )}
            />
          )}
          <p className="muted small">
            {t(
              `بررسی ${projectRisks.data?.items.length ?? 0} از ${projectRisks.data?.total ?? "—"} پروژهٔ فعال؛ ${risks.length} پروژه با پیش‌نیاز ناتمام یا مهلت گذشته.`,
              `Reviewed ${projectRisks.data?.items.length ?? 0} of ${projectRisks.data?.total ?? "—"} active projects; ${risks.length} with blockers or overdue deadlines.`,
            )}
          </p>
        </section>
        <section className="panel" {...widgetProps("waiting")}>
          <SectionHeading
            title={widget("waiting").title}
            action={
              <Link className="text-link" href="/tasks?filter=Waiting">
                {t("همهٔ منتظرها", "All waiting")}
              </Link>
            }
          />
          <QueryState {...waiting} retry={waiting.refresh} />
          {waiting.data?.items.map((task) => (
            <div key={task.task_id}>
              <TaskRow task={task} onOpen={onOpen} onAction={action} />
              <p className="muted small">
                {task.waiting_for ||
                  t("منتظر چه چیزی: ثبت نشده", "Waiting for: unspecified")}
              </p>
            </div>
          ))}
          {waiting.data && !waiting.data.items.length && (
            <Empty
              title={t("کاری در وضعیت منتظر نیست", "No tasks are waiting")}
            />
          )}
          <p className="muted small">
            {waiting.data?.items.length ?? 0}/{waiting.data?.total ?? "—"}{" "}
            {t("نمایش داده شده", "displayed")}
          </p>
        </section>
        <section className="panel" {...widgetProps("upcoming")}>
          <SectionHeading
            title={widget("upcoming").title}
            action={
              <Link className="text-link" href="/tasks">
                {t("کارها و مهلت‌ها", "Tasks & deadlines")}
              </Link>
            }
          />
          <p className="muted small">
            {calendarDay} — {addCalendarDays(calendarDay, 7)}
          </p>
          <QueryState {...upcoming} retry={upcoming.refresh} />
          {upcoming.data?.items.map((task) => (
            <TaskRow
              key={task.task_id}
              task={task}
              onOpen={onOpen}
              onAction={action}
            />
          ))}
          {upcoming.data && !upcoming.data.items.length && (
            <Empty
              title={t(
                "مهلتی در این بازه ثبت نشده",
                "No deadlines in this range",
              )}
            />
          )}
          <p className="muted small">
            {upcoming.data?.items.length ?? 0}/{upcoming.data?.total ?? "—"}{" "}
            {t("نمایش داده شده", "displayed")}
          </p>
        </section>
        <section className="panel" {...widgetProps("workload")}>
          <SectionHeading
            title={widget("workload").title}
            action={
              <Link className="text-link" href="/time">
                {t("ثبت ساعت", "Work log")}
              </Link>
            }
          />
          <p className="muted small">
            {weekStart} — {addCalendarDays(weekStart, 6)} · Europe/Berlin
          </p>
          <QueryState {...weeklyTime} retry={weeklyTime.refresh} />
          {weeklyTime.data && (
            <>
              <strong className="widget-number">
                {Math.round(weeklyTime.data.minutes / 6) / 10}{" "}
                {t("ساعت ثبت‌شده", "recorded hours")}
              </strong>
              <p>
                {weeklyTime.data.entries} {t("بازهٔ واقعی", "actual entries")}
              </p>
              {Object.entries(weeklyTime.data.employers).map(
                ([employer, minutes]) => (
                  <div className="dependency-row" key={employer}>
                    <strong>{employer}</strong>
                    <span>
                      {Math.round(minutes / 6) / 10} {t("ساعت", "hours")}
                    </span>
                  </div>
                ),
              )}
            </>
          )}
          <p className="muted small">
            {t(
              "این زمان انجام‌شده است. ظرفیت آینده و زمان برنامه‌ریزی‌شده از آن حدس زده نمی‌شود.",
              "These are worked hours. Future availability and planned time are not inferred from them.",
            )}
          </p>
        </section>
        <section className="panel" {...widgetProps("review")}>
          <SectionHeading
            title={widget("review").title}
            action={
              <Link className="text-link" href="/reports">
                {t("روندها و مرور کامل", "Trends & full review")}
              </Link>
            }
          />
          <p className="muted small">
            {weekStart} — {addCalendarDays(weekStart, 6)}
          </p>
          {reviewWeek ? (
            <>
              <div className="review-values">
                <div>
                  <strong>{reviewWeek.created}</strong>
                  <span>{t("کار ساخته‌شده", "tasks created")}</span>
                </div>
                <div>
                  <strong>{reviewWeek.completed}</strong>
                  <span>{t("کار تکمیل‌شده", "tasks completed")}</span>
                </div>
              </div>
              <p className="muted small">
                {t(
                  "شمارش کامل سرور در هفتهٔ جاری؛ روند ۱۲ هفته‌ای در گزارش‌هاست.",
                  "Complete server counts for this week; the 12-week trend is in Reports.",
                )}
              </p>
            </>
          ) : (
            <QueryState {...data} retry={data.refresh} />
          )}
        </section>
        <section className="panel" {...widgetProps("files")}>
          <SectionHeading
            title={widget("files").title}
            action={
              <Link className="text-link" href="/files">
                {t("همهٔ منابع", "All files")}
              </Link>
            }
          />
          <QueryState {...recentFiles} retry={recentFiles.refresh} />
          {recentFiles.data?.items.map((file) => (
            <Link
              className="blocked-card"
              href={`/files?file=${encodeURIComponent(file.file_id)}`}
              key={file.file_id}
            >
              <FileText size={17} />
              <div>
                <strong>{file.title}</strong>
                <small>
                  {file.provider} · {file.state}
                </small>
              </div>
            </Link>
          ))}
          {recentFiles.data && !recentFiles.data.items.length && (
            <Empty title={t("منبعی ثبت نشده", "No files recorded")} />
          )}
          <p className="muted small">
            {t(
              "آخرین منابع ثبت‌شده؛ تغییرات در تاریخچه ثبت می‌شوند.",
              "Most recently registered files; changes are recorded in history.",
            )}
          </p>
        </section>
        <section className="panel" {...widgetProps("sources")}>
          <SectionHeading
            title={widget("sources").title}
            action={
              <Link className="text-link" href="/settings">
                {t("اتصال‌ها و سلامت", "Connections & health")}
              </Link>
            }
          />
          <QueryState {...sourceStatus} retry={sourceStatus.refresh} />
          {sourceStatus.data && (
            <>
              <p>
                {t("دسته‌های مهاجرت ثبت‌شده", "Recorded migration batches")}:{" "}
                {sourceStatus.data.migration_batches.length}
              </p>
              <p>
                {t(
                  "کارهای زمان‌بند در ۱۰۰ رکورد اخیر",
                  "Scheduler jobs in the latest 100 records",
                )}
                : {sourceStatus.data.jobs.length}
              </p>
              <p>
                {t("ناموفق در همین محدوده", "Failed in this scope")}:{" "}
                {
                  sourceStatus.data.jobs.filter((job) => job.state === "Failed")
                    .length
                }
              </p>
              <p className="muted small">
                {sourceStatus.data.migration_batches[0]
                  ? `${sourceStatus.data.migration_batches[0].status} · ${sourceStatus.data.migration_batches[0].created_at}`
                  : t(
                      "هنوز مهاجرتی در این حساب ثبت نشده.",
                      "No migration recorded for this owner yet.",
                    )}
              </p>
              <p className="muted small">
                {t(
                  "وضعیت اتصال خارجی را در تنظیمات بررسی کن؛ ثبت یک دسته به‌تنهایی اثبات همگام‌سازی نیست.",
                  "Check external connection status in Settings; a recorded batch alone does not prove synchronization.",
                )}
              </p>
            </>
          )}
        </section>
      </div>
      <Modal
        title={t("چیدمان داشبورد", "Customize dashboard")}
        open={customize}
        onOpenChange={setCustomize}
      >
        <QueryState {...preferences} retry={preferences.refresh} />
        {(preferencesSaving || preferences.fetching) && (
          <p role="status" className="muted small">
            {t(
              "در حال ذخیره یا بازخوانی چیدمان…",
              "Saving or refreshing dashboard preferences…",
            )}
          </p>
        )}
        {widgets.map((item, index) => (
          <div className="widget-option" key={item.id}>
            <label>
              <input
                type="checkbox"
                disabled={!preferencesEditable}
                checked={item.visible}
                onChange={(event) =>
                  void saveWidgets(
                    widgets.map((value) =>
                      value.id === item.id
                        ? { ...value, visible: event.target.checked }
                        : value,
                    ),
                  )
                }
              />
              {item.title}
            </label>
            <select
              disabled={!preferencesEditable}
              aria-label={`${t("عرض ویجت", "Widget width")} ${item.title}`}
              value={item.width}
              onChange={(event) =>
                void saveWidgets(
                  widgets.map((value) =>
                    value.id === item.id
                      ? { ...value, width: event.target.value }
                      : value,
                  ),
                )
              }
            >
              <option value="normal">{t("عادی", "Normal")}</option>
              <option value="wide">{t("تمام عرض", "Full width")}</option>
            </select>
            <input
              type="number"
              disabled={!preferencesEditable}
              min={200}
              max={1400}
              step={20}
              value={item.height ?? ""}
              placeholder={t("ارتفاع خودکار", "Auto height")}
              aria-label={`${t("ارتفاع ویجت", "Widget height")} ${item.title}`}
              onChange={(event) =>
                void saveWidgets(
                  widgets.map((value) =>
                    value.id === item.id
                      ? {
                          ...value,
                          height: event.target.value
                            ? Math.max(
                                200,
                                Math.min(1400, Number(event.target.value)),
                              )
                            : null,
                        }
                      : value,
                  ),
                )
              }
            />
            <Button
              variant="quiet"
              disabled={!preferencesEditable || index === 0}
              onClick={() => moveWidget(item.id, -1)}
              aria-label={t("بالا بردن", "Move up")}
            >
              <ArrowUp size={15} />
            </Button>
            <Button
              variant="quiet"
              disabled={!preferencesEditable || index === widgets.length - 1}
              onClick={() => moveWidget(item.id, 1)}
              aria-label={t("پایین بردن", "Move down")}
            >
              <ArrowDown size={15} />
            </Button>
          </div>
        ))}
        <p className="muted small">
          {t(
            "ویجت‌ها را می‌توانی بکشید و جابه‌جا کنی؛ دکمه‌ها همان تغییر را با کیبورد انجام می‌دهند.",
            "Drag widgets to reorder, or use the buttons for the same change by keyboard.",
          )}
        </p>
      </Modal>
    </>
  );
}
function ChevronIcon() {
  return <ArrowUpRight size={14} />;
}
function Activity({
  events,
  timezone = "Europe/Berlin",
}: {
  events: ActivityDTO[];
  timezone?: string;
}) {
  const { t } = useLocale();
  return (
    <div className="activity-list">
      {events.length ? (
        events.map((event) => (
          <div key={event.event_id}>
            <span className="activity-dot" />
            <div>
              <strong>{event.event_type}</strong>
              <small>{event.channel}</small>
            </div>
            <time>
              {new Date(event.occurred_at).toLocaleTimeString(undefined, {
                timeZone: timezone,
                hour: "2-digit",
                minute: "2-digit",
              })}
            </time>
          </div>
        ))
      ) : (
        <Empty
          title={t(
            "تاریخچه از اولین قدم شروع می‌شود",
            "History begins with your first step",
          )}
        />
      )}
    </div>
  );
}

export function Projects({
  action,
  onOpen,
}: {
  action: Action;
  onOpen: (id: string) => void;
}) {
  return (
    <>
      <ProjectWorkspace
        action={action}
        onOpen={onOpen}
        knowledge={(id) => <ProjectKnowledge projectId={id} action={action} />}
      />
      <Templates action={action} />
    </>
  );
}

function Templates({ action }: { action: Action }) {
  const { t } = useLocale();
  const templates = useQuery<
    PageDTO<{
      template_id: string;
      title: string;
      definition: { tasks?: unknown[] };
    }>
  >("task_template_list");
  const [preview, setPreview] = useState<{
    preview_id: string;
    command: CommandName;
    changes: unknown;
    warnings: string[];
  } | null>(null);
  const [recurrenceTemplate, setRecurrenceTemplate] = useState<string | null>(
    null,
  );
  const recurrences = useQuery<
    PageDTO<{
      rule_id: string;
      title: string;
      enabled: boolean;
      next_occurrence_date: string;
      revision: number;
      timezone: string;
    }>
  >("task_recurrence_list");
  return (
    <section className="panel templates-panel">
      <SectionHeading
        title={t("الگوهای اجرای کار", "Workflow templates")}
        subtitle={t(
          "از جزئیات یک کار، ساختار و زیرکارها را به‌عنوان الگو ذخیره کن.",
          "Save a task structure and its subtasks as a template from task details.",
        )}
      />
      <QueryState {...templates} retry={templates.refresh} />
      {templates.data?.items.map((template) => (
        <div className="dependency-row" key={template.template_id}>
          <GitBranch size={16} />
          <strong>{template.title}</strong>
          <span className="muted">
            {template.definition.tasks?.length ?? 0} {t("کار", "tasks")}
          </span>
          <Button
            onClick={async () => {
              try {
                setPreview(
                  await query("task_template_instantiate_preview", {
                    template_id: template.template_id,
                  }),
                );
              } catch (error) {
                window.dispatchEvent(
                  new CustomEvent("lifeos:error", { detail: String(error) }),
                );
              }
            }}
          >
            {t("پیش‌نمایش ساخت نمونه", "Preview a new instance")}
          </Button>
          <Button onClick={() => setRecurrenceTemplate(template.template_id)}>
            {t("تعریف تکرار", "Set recurrence")}
          </Button>
        </div>
      ))}
      {!templates.loading && !templates.data?.items.length && (
        <p className="muted small">
          {t("هنوز الگویی ساخته نشده.", "No templates saved yet.")}
        </p>
      )}
      {recurrences.data?.items.map((rule) => (
        <div className="dependency-row" key={rule.rule_id}>
          <History size={14} />
          <strong>{rule.title}</strong>
          <span className="muted small">
            {rule.next_occurrence_date} · {rule.timezone}
          </span>
          <Button
            onClick={() =>
              void action(
                rule.enabled
                  ? "task_recurrence_pause"
                  : "task_recurrence_resume",
                { rule_id: rule.rule_id },
                rule.revision,
              )
            }
          >
            {rule.enabled
              ? t("توقف تکرار", "Pause recurrence")
              : t("ادامهٔ تکرار", "Resume recurrence")}
          </Button>
        </div>
      ))}
      <Modal
        title={t("ساخت چرخه از الگو", "Create a recurring workflow")}
        open={!!recurrenceTemplate}
        onOpenChange={(value) => {
          if (!value) setRecurrenceTemplate(null);
        }}
      >
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const result = await action("task_recurrence_create", {
              template_id: recurrenceTemplate,
              title: form.get("title"),
              start_date: form.get("start_date"),
              timezone: form.get("timezone"),
              rrule: form.get("frequency"),
            });
            if (result) setRecurrenceTemplate(null);
          }}
        >
          <Field label={t("نام چرخه", "Workflow name")}>
            <input name="title" required />
          </Field>
          <Field label={t("تاریخ شروع نخستین نمونه", "First occurrence date")}>
            <input name="start_date" type="date" required />
          </Field>
          <Field label={t("تکرار", "Repeat")}>
            <select name="frequency">
              <option value="FREQ=WEEKLY">{t("هر هفته", "Every week")}</option>
              <option value="FREQ=MONTHLY">{t("هر ماه", "Every month")}</option>
              <option value="FREQ=DAILY">{t("هر روز", "Every day")}</option>
            </select>
          </Field>
          <Field label={t("منطقهٔ زمانی", "Time zone")}>
            <select name="timezone">
              <option>Europe/Berlin</option>
              <option>Asia/Tehran</option>
            </select>
          </Field>
          <p className="muted small">
            {t(
              "نمونه‌ها با اجرای واقعی زمان‌بند روزانه یا اجرای دستی ساخته می‌شوند. هر نمونه زیرکارها و پیش‌نیازهای داخلی تازهٔ خودش را دارد.",
              "Occurrences are created by the actual daily scheduler or a manual run. Each has its own new internal tasks and dependencies.",
            )}
          </p>
          <Button variant="primary" type="submit">
            {t("ثبت چرخه", "Save recurrence")}
          </Button>
        </form>
      </Modal>
      <Modal
        title={t(
          "ساخت نمونهٔ تازه از الگو",
          "Create a fresh template instance",
        )}
        open={!!preview}
        onOpenChange={(value) => {
          if (!value) setPreview(null);
        }}
      >
        {preview && (
          <>
            <pre className="preview-json">
              {JSON.stringify(preview.changes, null, 2)}
            </pre>
            {preview.warnings.map((warning) => (
              <p className="warning" key={warning}>
                {warning}
              </p>
            ))}
            <Button
              variant="primary"
              onClick={async () => {
                const result = await action(preview.command, {
                  preview_id: preview.preview_id,
                });
                if (result) setPreview(null);
              }}
            >
              {t(
                "تأیید ساخت با شناسه‌های تازه",
                "Confirm with fresh identities",
              )}
            </Button>
          </>
        )}
      </Modal>
    </section>
  );
}

function ProjectKnowledge({
  projectId,
  action,
}: {
  projectId: string;
  action: Action;
}) {
  const { t } = useLocale();
  const [knowledgeCursor, setKnowledgeCursor] = useState<string | null>(null);
  const [editingKnowledge, setEditingKnowledge] = useState<string | null>(null);
  const knowledge = useQuery<
    PageDTO<{
      knowledge_id: string;
      title: string;
      body: string;
      url: string | null;
      revision: number;
    }>
  >("knowledge_search", {
    project_id: projectId,
    limit: 50,
    cursor: knowledgeCursor,
  });
  return (
    <section className="project-knowledge">
      <SectionHeading
        title={t("دانش و تصمیم‌های پروژه", "Project knowledge & decisions")}
      />
      <QueryState {...knowledge} retry={knowledge.refresh} />
      {knowledge.data?.items.map((item) => (
        <article key={item.knowledge_id} className="comment-card">
          <h3>{item.title}</h3>
          <p>{item.body}</p>
          <Button
            onClick={() =>
              setEditingKnowledge(
                editingKnowledge === item.knowledge_id
                  ? null
                  : item.knowledge_id,
              )
            }
          >
            {t("ویرایش یادداشت پروژه", "Edit project note")}
          </Button>
          {editingKnowledge === item.knowledge_id && (
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                if (
                  await action(
                    "knowledge_update",
                    {
                      knowledge_id: item.knowledge_id,
                      title: form.get("title"),
                      body: form.get("body"),
                      url: form.get("url") || null,
                    },
                    item.revision,
                  )
                )
                  setEditingKnowledge(null);
              }}
            >
              <Field label={t("عنوان یادداشت ویرایش‌شده", "Edited note title")}>
                <input name="title" required defaultValue={item.title} />
              </Field>
              <Field label={t("متن یادداشت ویرایش‌شده", "Edited note body")}>
                <textarea name="body" defaultValue={item.body} />
              </Field>
              <Field label={t("پیوند یادداشت ویرایش‌شده", "Edited note URL")}>
                <input name="url" type="url" defaultValue={item.url ?? ""} />
              </Field>
              <Button type="submit">
                {t("ذخیرهٔ یادداشت پروژه", "Save project note")}
              </Button>
            </form>
          )}
          {item.url && /^https?:\/\//.test(item.url) && (
            <a
              className="text-link"
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <Link2 size={13} />
              {t("بازکردن مرجع", "Open reference")}
            </a>
          )}
        </article>
      ))}
      <div className="form-actions">
        {knowledgeCursor && (
          <Button onClick={() => setKnowledgeCursor(null)}>
            {t("ابتدای دانش پروژه", "First project notes")}
          </Button>
        )}
        {knowledge.data?.next_cursor && (
          <Button
            onClick={() => setKnowledgeCursor(knowledge.data!.next_cursor)}
          >
            {t("دانش بیشتر پروژه", "More project notes")}
          </Button>
        )}
      </div>
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const labels = String(data.get("people"))
            .split(/[,،\n]/)
            .map((item) => item.trim())
            .filter(Boolean);
          if (
            await action("knowledge_create", {
              project_id: projectId,
              title: t("برچسب افراد پروژه", "Project people labels"),
              body: labels.join("\n"),
            })
          )
            form.reset();
        }}
      >
        <Field
          label={t(
            "افراد پروژه (برچسب‌های ساده)",
            "Project people (plain labels)",
          )}
        >
          <textarea
            name="people"
            required
            rows={2}
            placeholder={t(
              "نام‌ها را با ویرگول یا خط تازه جدا کن",
              "Separate names with commas or new lines",
            )}
          />
        </Field>
        <p className="small muted">
          {t(
            "این نام‌ها به‌صورت یادداشت پروژه ذخیره می‌شوند و پیام یا دعوتی ارسال نمی‌شود.",
            "Names are stored as a project note; no messages or invitations are sent.",
          )}
        </p>
        <Button type="submit">
          {t("ثبت برچسب افراد پروژه", "Save project people labels")}
        </Button>
      </form>
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          const result = await action("knowledge_create", {
            project_id: projectId,
            title: data.get("title"),
            body: data.get("body"),
            url: data.get("url") || null,
          });
          if (result) form.reset();
        }}
      >
        <Field label={t("عنوان یادداشت یا تصمیم", "Note or decision title")}>
          <input name="title" required />
        </Field>
        <Field label={t("متن", "Body")}>
          <textarea name="body" rows={3} />
        </Field>
        <Field label={t("پیوند مرجع (اختیاری)", "Reference URL (optional)")}>
          <input name="url" type="url" dir="ltr" />
        </Field>
        <Button type="submit">
          {t("ثبت دانش پروژه", "Save project knowledge")}
        </Button>
      </form>
    </section>
  );
}

export function Files({
  action,
  onOpen,
}: {
  action: Action;
  onOpen: (id: string) => void;
}) {
  return <FileWorkspace action={action} onOpen={onOpen} />;
}

interface AIPlan {
  plan_id: string;
  answer: string;
  actions: {
    command: string;
    input: Record<string, unknown>;
    expected_revision?: number;
  }[];
  warnings: string[];
  expires_at: string;
  requires_confirmation: boolean;
  simulation?: AISimulation;
}
export function Assistant() {
  const { t } = useLocale();
  if (IN_APP_AI_ENABLED) return <InAppAssistant />;
  return (
    <section className="panel">
      <h1>
        {t("دستیار داخل برنامه غیرفعال است", "In-app assistant is disabled")}
      </h1>
      <p>
        {t(
          "برای مدیریت این فضا، Codex را از طریق MCP متصل کن.",
          "Connect Codex through MCP to manage this workspace.",
        )}
      </p>
      <Link href="/settings#mcp-connection" className="button">
        {t("تنظیمات اتصال MCP", "MCP connection settings")}
      </Link>
    </section>
  );
}
function InAppAssistant() {
  const { t } = useLocale();
  const [message, setMessage] = useState("");
  const [plan, setPlan] = useState<AIPlan | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);
  async function makePlan(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setResult(null);
    setPlan(null);
    try {
      const response = await fetch("/api/v1/ai/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? "AI provider not configured");
      setPlan(body.data ?? body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!plan) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/v1/ai/execute", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({ plan_id: plan.plan_id }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error?.message ?? "Execution failed");
      setResult(body.data ?? body);
      setPlan(null);
      window.dispatchEvent(new Event("lifeos:changed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("فکر کن، بررسی کن، اجرا کن", "THINK, REVIEW, ACT")}
          </div>
          <h1>{t("همراه هوشمند", "Your assistant")}</h1>
          <p>
            {t(
              "از داده‌های واقعی بپرس؛ تغییرها را پیش از اجرا ببین.",
              "Ask about real records and review changes before applying them.",
            )}
          </p>
        </div>
        <BrainCircuit size={28} className="accent" />
      </div>
      <div className="assistant-layout">
        <div className="assistant-intro">
          <div className="ai-orb">
            <Sparkles size={30} />
          </div>
          <h2>{t("از کجا شروع کنیم؟", "Where shall we start?")}</h2>
          <p>
            {t(
              "جست‌وجو، توضیح پیش‌نیازها یا یک برنامهٔ قابل بررسی.",
              "Search, explain prerequisites or create a plan you can review.",
            )}
          </p>
          <div className="suggestion-grid">
            {[
              t(
                "کدام کارها آمادهٔ شروع هستند؟",
                "Which tasks are ready to start?",
              ),
              t("چرا کارهایم مسدود شده‌اند؟", "Why are my tasks blocked?"),
              t(
                "کارهای مربوط به پایان‌نامه را نشان بده",
                "Show tasks related to my thesis",
              ),
            ].map((text) => (
              <button key={text} onClick={() => setMessage(text)}>
                {text}
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="error-state" role="alert">
            {error}
          </p>
        )}
        {plan && (
          <section className="panel ai-response">
            <p>{plan.answer}</p>
            {plan.simulation && (
              <AIProposalPreview simulation={plan.simulation} />
            )}
            {plan.actions.length > 0 && !plan.simulation && (
              <>
                <SectionHeading
                  title={t("تغییرهای پیشنهادی", "Proposed changes")}
                />
                {plan.actions.map((item, index) => (
                  <div className="ai-action" key={index}>
                    <span className="chip">{item.command}</span>
                    <pre>{JSON.stringify(item.input, null, 2)}</pre>
                  </div>
                ))}
              </>
            )}
            {plan.warnings.map((warning) => (
              <p key={warning} className="warning">
                {warning}
              </p>
            ))}
            <div className="form-actions">
              {plan.actions.length > 0 && (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void execute()}
                >
                  <ShieldCheck size={16} />
                  {t(
                    "تأیید و اجرای این تغییرها",
                    "Approve and execute these changes",
                  )}
                </Button>
              )}
              <Button onClick={() => setPlan(null)}>
                {t("بستن پیش‌نمایش", "Dismiss preview")}
              </Button>
            </div>
          </section>
        )}
        {result !== null && (
          <section className="panel">
            <SectionHeading title={t("نتیجهٔ بررسی‌شده", "Verified result")} />
            <pre className="preview-json">
              {JSON.stringify(result, null, 2)}
            </pre>
          </section>
        )}
        <form className="assistant-input" onSubmit={makePlan}>
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            required
            rows={2}
            placeholder={t(
              "با من فارسی یا انگلیسی صحبت کن…",
              "Ask in Persian or English…",
            )}
          />
          <Button
            variant="primary"
            type="submit"
            disabled={busy || !message.trim()}
          >
            <Send size={18} />
            {busy
              ? t("در حال بررسی…", "Thinking…")
              : t("بررسی درخواست", "Review request")}
          </Button>
        </form>
        <p className="muted small centered">
          {t(
            "مدل باید توسط صاحب حساب پیکربندی شود. متن کارها و فایل‌ها هرگز مجوز تغییر نیست.",
            "A model provider must be configured by the owner. Task and file content never grants write permission.",
          )}
        </p>
      </div>
    </>
  );
}

export function Reports() {
  return <FullReports />;
}

export function Settings({
  action,
  language,
  setLanguage,
  theme,
  setTheme,
}: {
  action: Action;
  language: string;
  setLanguage: (value: "fa" | "en") => void;
  theme: string;
  setTheme: (value: string) => void;
}) {
  const router = useRouter();
  const { t } = useLocale();
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const sync = useQuery<Record<string, unknown>>("sync_status");
  const health = useQuery<Record<string, unknown>>("system_health");
  const capabilities = useQuery<Record<string, unknown>>("system_capabilities");
  const [reminderCursor, setReminderCursor] = useState<string | null>(null);
  const reminders = useQuery<PageDTO<Record<string, unknown>>>(
    "reminder_list",
    { limit: 100, cursor: reminderCursor },
  );
  const [reminderChange, setReminderChange] = useState<{
    item: Record<string, unknown>;
    command: "reminder_resume" | "reminder_cancel";
  } | null>(null);
  const [message, setMessage] = useState("");
  const session = authClient.useSession();
  const [googlePending, setGooglePending] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const [googleAuthorizationUrl, setGoogleAuthorizationUrl] = useState<
    string | null
  >(null);
  async function saveSettings(settings: Record<string, unknown>) {
    if (!preferences.data || preferences.error || preferences.fetching) return;
    await action(
      "preferences_update",
      { settings },
      preferences.data?.revision,
    );
  }
  async function backup() {
    try {
      const data = await query("backup_export");
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `life-os-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("فضایی که با تو هماهنگ می‌شود", "A WORKSPACE THAT FITS YOU")}
          </div>
          <h1>{t("تنظیمات و اتصال‌ها", "Settings & connections")}</h1>
        </div>
      </div>
      <div className="settings-grid">
        <section className="panel">
          <SectionHeading title={t("ظاهر و زبان", "Appearance & language")} />
          <Field label={t("زبان", "Language")}>
            <select
              disabled={
                !preferences.data || !!preferences.error || preferences.fetching
              }
              value={language}
              onChange={(event) => {
                const value = event.target.value as "fa" | "en";
                setLanguage(value);
                void saveSettings({ language: value });
              }}
            >
              <option value="fa">فارسی</option>
              <option value="en">English</option>
            </select>
          </Field>
          <Field label={t("پوسته", "Theme")}>
            <select
              disabled={
                !preferences.data || !!preferences.error || preferences.fetching
              }
              value={theme}
              onChange={(event) => {
                setTheme(event.target.value);
                void saveSettings({ theme: event.target.value });
              }}
            >
              <option value="dark">{t("تیره", "Dark")}</option>
              <option value="light">{t("روشن", "Light")}</option>
              <option value="system">{t("سیستم", "System")}</option>
            </select>
          </Field>
          <p className="muted small">Europe/Berlin · Ctrl/Cmd + K · N · /</p>
        </section>
        <section className="panel">
          <SectionHeading title={t("ورود امن", "Secure sign-in")} />
          <div className="connection-card">
            <LockKeyhole size={22} />
            <div>
              <strong data-private>
                {session.data?.user.email ??
                  t("نشست صاحب حساب", "Owner session")}
              </strong>
              <small>
                {t(
                  "فقط صاحب حساب به داده‌های این فضا دسترسی دارد.",
                  "Only the owner can access this workspace.",
                )}
              </small>
            </div>
          </div>
          <Button
            onClick={async () => {
              const result = await authClient.passkey.addPasskey({
                name: "Ramin Life OS",
              });
              setMessage(
                result.error?.message ??
                  t("Passkey ثبت شد.", "Passkey registered."),
              );
            }}
          >
            {t("ثبت Passkey روی دستگاه", "Register a device passkey")}
          </Button>
          <Button
            onClick={async () => {
              await authClient.signOut();
              clearQueryCache();
              clearMutationIntents();
              router.replace("/login");
              router.refresh();
            }}
          >
            {t("خروج از حساب", "Sign out")}
          </Button>
        </section>
        <section className="panel">
          <SectionHeading title={t("نسخهٔ پشتیبان", "Your backup")} />
          <p>
            {t(
              "خروجی داده‌های خصوصی را در جای امن نگه دار.",
              "Keep exported private data in a secure location.",
            )}
          </p>
          <Button onClick={() => void backup()}>
            <Download size={16} />
            {t("دریافت پشتیبان خصوصی", "Export private backup")}
          </Button>
          <p className="muted small">
            {t(
              "بازیابی staging باید توسط اپراتور تأیید شود.",
              "Staging restore must be verified by the operator.",
            )}
          </p>
        </section>
        <section className="panel" id="mcp-connection">
          <SectionHeading
            title={t("اتصال Codex از طریق MCP", "Connect Codex through MCP")}
          />
          <p>
            {t(
              "Codex می‌تواند از طریق MCP به کارها، پروژه‌ها و فایل‌های این فضا دسترسی داشته باشد. دسترسی‌ها را هنگام اتصال تأیید و هر زمان لغو کن.",
              "Codex can access this workspace's tasks, projects and files through MCP. Approve its permissions when connecting and revoke them at any time.",
            )}
          </p>
          <div className="endpoint-box" dir="ltr">
            /api/mcp
          </div>
          <p className="muted small">
            {t(
              "Streamable HTTP · OAuth · دسترسی محدود و قابل لغو",
              "Streamable HTTP · OAuth · scoped, revocable access",
            )}
          </p>
          {IN_APP_AI_ENABLED && (
            <Link href="/assistant" className="button">
              <BrainCircuit size={16} />
              {t("همراه داخل برنامه", "In-app assistant")}
            </Link>
          )}
        </section>
        <section className="panel">
          <SectionHeading
            title={t(
              "Google Calendar؛ همگام‌سازی دوطرفه",
              "Google Calendar · two-way synchronization",
            )}
          />
          <p>
            {t(
              "با رضایت جداگانهٔ شما، تقویم‌ها خوانده و رویدادهای شخصی در تقویم‌های متعلق به شما ساخته، ویرایش یا حذف می‌شوند. رویدادهای دارای مهمان و دعوت‌ها از Google مدیریت می‌شوند.",
              "With your separate consent, calendars are read and personal events in calendars you own can be created, edited or deleted. Manage guest events and invitations in Google.",
            )}
          </p>
          <Button
            disabled={
              capabilities.data?.oauth_client_configured !== true ||
              googlePending
            }
            aria-busy={googlePending}
            onClick={async () => {
              setGooglePending(true);
              setGoogleError("");
              setGoogleAuthorizationUrl(null);
              try {
                const result = await authClient.linkSocial({
                  provider: "google",
                  callbackURL: new URL(
                    "/settings",
                    window.location.origin,
                  ).toString(),
                  scopes: [
                    "https://www.googleapis.com/auth/calendar.readonly",
                    "https://www.googleapis.com/auth/calendar.events.owned",
                  ],
                });
                if (result.error) {
                  setGoogleError(
                    result.error.message ??
                      t(
                        "اتصال Google برقرار نشد؛ دوباره تلاش کن.",
                        "Google connection failed. Please retry.",
                      ),
                  );
                  return;
                }
                // Better Auth performs its normal redirect. Keep a native link
                // available if the browser remains on this page afterwards.
                const url = new URL(result.data?.url ?? "");
                if (
                  url.origin !== "https://accounts.google.com" ||
                  url.username ||
                  url.password
                )
                  throw new Error("INVALID_AUTHORIZATION_URL");
                setGoogleAuthorizationUrl(url.href);
              } catch {
                setGoogleError(
                  t(
                    "صفحهٔ اتصال Google باز نشد. اتصال اینترنت را بررسی کن و دوباره تلاش کن.",
                    "The Google connection page could not be opened. Check your connection and retry.",
                  ),
                );
              } finally {
                setGooglePending(false);
              }
            }}
          >
            {t(
              "اتصال یا ارتقای مجوز Google Calendar",
              "Connect or upgrade Google Calendar permission",
            )}
          </Button>
          {googlePending && (
            <p role="status" aria-live="polite">
              {t(
                "در حال بازکردن صفحهٔ اتصال Google…",
                "Opening the Google connection page…",
              )}
            </p>
          )}
          {googleError && (
            <p role="alert" className="error">
              {googleError}
            </p>
          )}
          {googleAuthorizationUrl && (
            <p className="connection-notice">
              {t(
                "اگر صفحهٔ Google باز نشد، از این لینک ادامه بده.",
                "If the Google page did not open, continue using this link.",
              )}{" "}
              <a className="button" href={googleAuthorizationUrl}>
                {t("ادامه در Google", "Continue in Google")}
              </a>
            </p>
          )}
          {capabilities.data?.oauth_client_configured !== true && (
            <p className="muted small">
              {t(
                "پیکربندی OAuth توسط صاحب پروژه هنوز کامل نشده است.",
                "Owner OAuth configuration is not complete yet.",
              )}
            </p>
          )}
        </section>
      </div>
      <Connections />
      <InstallAppCard fa={language === "fa"} />
      <PasswordSettings />
      <ExperienceSettings
        settings={preferences.data?.settings ?? {}}
        revision={preferences.data?.revision}
        pending={preferences.fetching || !!preferences.error}
        action={action}
      />
      <section className="panel">
        <SectionHeading
          title={t("وضعیت سیستم و منابع", "System & source status")}
        />
        <QueryState {...health} retry={health.refresh} />
        <div className="diagnostic-grid">
          {[
            [t("سلامت سیستم", "Health"), health.data],
            [t("اتصال‌ها", "Capabilities"), capabilities.data],
            [t("همگام‌سازی", "Sync"), sync.data],
          ].map(([title, data]) => (
            <details key={String(title)}>
              <summary>{String(title)}</summary>
              <pre className="preview-json">
                {JSON.stringify(data, null, 2)}
              </pre>
            </details>
          ))}
        </div>
        <p className="muted small">
          {t(
            "منبع متصل‌نشده به معنی همگام‌سازی موفق نیست.",
            "An unconfigured source is not a successful sync.",
          )}
        </p>
      </section>
      <section className="panel">
        <SectionHeading title={t("یادآورهای ثبت‌شده", "Saved reminders")} />
        <Button
          onClick={async () => {
            try {
              const response = await fetch("/api/v1/jobs/run", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "Idempotency-Key": crypto.randomUUID(),
                },
                body: "{}",
              });
              const result = await response.json();
              if (!response.ok)
                throw new Error(
                  result.error?.message ?? "Job execution failed",
                );
              window.dispatchEvent(new Event("lifeos:changed"));
              setMessage(
                t(
                  "اجرای زمان‌بند بررسی شد. نتیجه در تاریخچه و اعلان‌ها ثبت می‌شود.",
                  "Scheduler run checked; results appear in activity and notifications.",
                ),
              );
            } catch (error) {
              setMessage(
                error instanceof Error ? error.message : String(error),
              );
            }
          }}
        >
          {t(
            "اجرای دستی یادآورها و کارهای روزانه",
            "Run reminders and daily jobs now",
          )}
        </Button>
        <QueryState {...reminders} retry={reminders.refresh} />
        {reminders.data?.items.map((item, index) => (
          <div
            className="grant-row"
            key={String(item.reminder_id ?? index)}
            data-reminder-id={String(item.reminder_id)}
          >
            <div>
              <strong>
                {String(item.title ?? t("یادآور کار", "Task reminder"))}
              </strong>
              <time className="small muted">
                {new Date(String(item.remind_at)).toLocaleString(
                  language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                  { timeZone: "Europe/Berlin" },
                )}{" "}
                · Europe/Berlin
              </time>
            </div>
            <span className="chip">
              {item.state === "Pending"
                ? t("در انتظار", "Pending")
                : item.state === "Paused"
                  ? t("متوقف", "Paused")
                  : item.state === "Succeeded"
                    ? t("تحویل در برنامه", "Delivered in app")
                    : item.state === "Cancelled"
                      ? t("لغوشده", "Cancelled")
                      : String(item.state ?? "")}
            </span>
            {item.state === "Pending" && (
              <Button
                onClick={() =>
                  void action(
                    "reminder_pause",
                    { reminder_id: item.reminder_id },
                    Number(item.revision),
                  )
                }
              >
                {t("توقف یادآور", "Pause reminder")}
              </Button>
            )}
            {item.state === "Paused" && (
              <Button
                onClick={() =>
                  setReminderChange({ item, command: "reminder_resume" })
                }
              >
                {t("ازسرگیری یادآور", "Resume reminder")}
              </Button>
            )}
            {(item.state === "Pending" || item.state === "Paused") && (
              <Button
                onClick={() =>
                  setReminderChange({ item, command: "reminder_cancel" })
                }
              >
                {t("لغو یادآور", "Cancel reminder")}
              </Button>
            )}
          </div>
        ))}
        <div className="form-actions">
          <span className="small muted">
            {reminders.data?.items.length ?? 0}/{reminders.data?.total ?? "—"}
          </span>
          {reminderCursor && (
            <Button onClick={() => setReminderCursor(null)}>
              {t("صفحهٔ اول یادآورها", "First reminder page")}
            </Button>
          )}
          {reminders.data?.next_cursor && (
            <Button
              onClick={() => setReminderCursor(reminders.data!.next_cursor)}
            >
              {t("یادآورهای بعدی", "Next reminders")}
            </Button>
          )}
        </div>
        <Modal
          title={
            reminderChange?.command === "reminder_cancel"
              ? t("لغو یادآور", "Cancel reminder")
              : t("ازسرگیری یادآور", "Resume reminder")
          }
          open={!!reminderChange}
          onOpenChange={(open) => {
            if (!open) setReminderChange(null);
          }}
        >
          <p>
            {reminderChange?.command === "reminder_cancel"
              ? t(
                  "این یادآور لغو می‌شود و دوباره قابل ارسال نیست.",
                  "This reminder will be cancelled and cannot be sent again.",
                )
              : t(
                  "زمان اصلی حفظ می‌شود. اگر زمان گذشته باشد، اجرای بعدی کار روزانه یادآور را در همین برنامه تحویل می‌دهد.",
                  "The original time is preserved. If it is past due, the next daily job delivers the reminder inside this app.",
                )}
          </p>
          <Button
            variant="primary"
            onClick={async () => {
              if (
                reminderChange &&
                (await action(
                  reminderChange.command,
                  { reminder_id: reminderChange.item.reminder_id },
                  Number(reminderChange.item.revision),
                ))
              )
                setReminderChange(null);
            }}
          >
            {t("تأیید تغییر یادآور", "Confirm reminder change")}
          </Button>
        </Modal>
        {!reminders.loading &&
          !reminders.error &&
          !reminders.data?.items.length && (
            <p className="muted">
              {t(
                "یادآوری ثبت نشده؛ تحویل درون برنامه با اجرای روزانه یا دستی انجام می‌شود.",
                "No reminders recorded. In-app delivery runs through the daily or manual job.",
              )}
            </p>
          )}
      </section>
      {message && (
        <p role="status" className="connection-notice">
          {message}
        </p>
      )}
    </>
  );
}
