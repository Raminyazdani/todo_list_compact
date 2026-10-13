"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  ArrowUp,
  ArrowDown,
  BrainCircuit,
  CheckCheck,
  Download,
  FileText,
  Folder,
  GitBranch,
  History,
  Link2,
  LockKeyhole,
  Send,
  ShieldCheck,
  Sparkles,
  Upload,
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
import { authClient } from "@/server/auth/client";
import { query, useQuery, clearQueryCache, clearMutationIntents } from "./api";
import { useLocale } from "./locale";
import { TaskRow } from "./tasks";
import {
  AddButton,
  Button,
  Empty,
  Field,
  Modal,
  Progress,
  QueryState,
  SectionHeading,
} from "@/components/ui";

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
  const [customize, setCustomize] = useState(false);
  const defaults = [
    { id: "focus", title: t("قدم‌های بعدی", "Next moves") },
    { id: "calendar", title: t("نمای روز", "Day preview") },
    { id: "blocked", title: t("رادار پیش‌نیازها", "Blocked radar") },
    { id: "activity", title: t("تاریخچه", "Activity") },
  ];
  const saved = Array.isArray(preferences.data?.settings.dashboard_widgets)
    ? (preferences.data.settings.dashboard_widgets as {
        id: string;
        visible: boolean;
        order: number;
        width: string;
      }[])
    : [];
  const widgets = defaults
    .map((item, index) => ({
      ...item,
      visible: saved.find((value) => value.id === item.id)?.visible !== false,
      order: saved.find((value) => value.id === item.id)?.order ?? index,
      width: saved.find((value) => value.id === item.id)?.width ?? "normal",
    }))
    .sort((a, b) => a.order - b.order);
  function widget(id: string) {
    return widgets.find((item) => item.id === id)!;
  }
  function widgetStyle(id: string) {
    return {
      order: widget(id).order,
      gridColumn: widget(id).width === "wide" ? "1 / -1" : undefined,
    };
  }
  async function saveWidgets(next: typeof widgets) {
    await action(
      "preferences_update",
      {
        settings: {
          ...preferences.data?.settings,
          dashboard_widgets: next.map(({ id, visible, order, width }) => ({
            id,
            visible,
            order,
            width,
          })),
        },
      },
      preferences.data?.revision,
    );
  }
  function moveWidget(id: string, delta: number) {
    const next = [...widgets];
    const from = next.findIndex((item) => item.id === id);
    const to = Math.min(next.length - 1, Math.max(0, from + delta));
    [next[from], next[to]] = [next[to], next[from]];
    void saveWidgets(next.map((item, index) => ({ ...item, order: index })));
  }
  function dropWidget(event: React.DragEvent<HTMLElement>, id: string) {
    event.preventDefault();
    const source = event.dataTransfer.getData("text/lifeos-widget");
    const from = widgets.findIndex((item) => item.id === source),
      to = widgets.findIndex((item) => item.id === id);
    if (from < 0 || to < 0) return;
    const next = [...widgets];
    const moved = next.splice(from, 1)[0];
    next.splice(to, 0, moved);
    void saveWidgets(next.map((item, index) => ({ ...item, order: index })));
  }
  const data = useQuery<Analytics>("analytics_summary");
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
  const events = useQuery<PageDTO<Record<string, unknown>>>(
    "calendar_events_query",
    { from: calendarFrom, limit: 3 },
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
                timeZone: "Europe/Berlin",
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
          <Button onClick={() => setCustomize(true)}>
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
      <div className="dashboard-grid">
        <section
          className="panel focus-panel"
          hidden={!widget("focus").visible}
          style={widgetStyle("focus")}
          draggable
          onDragStart={(event) =>
            event.dataTransfer.setData("text/lifeos-widget", "focus")
          }
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropWidget(event, "focus")}
        >
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
            : !ready.loading && (
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
        <section
          className="panel calendar-peek"
          hidden={!widget("calendar").visible}
          style={widgetStyle("calendar")}
          draggable
          onDragStart={(event) =>
            event.dataTransfer.setData("text/lifeos-widget", "calendar")
          }
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropWidget(event, "calendar")}
        >
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
                { weekday: "long", timeZone: "Europe/Berlin" },
              ).format(now)}
            </span>
            <strong>
              {new Intl.DateTimeFormat(
                language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                { day: "numeric", timeZone: "Europe/Berlin" },
              ).format(now)}
            </strong>
            <small>Europe/Berlin</small>
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
                        timeZone: "Europe/Berlin",
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
        <section
          className="panel"
          hidden={!widget("blocked").visible}
          style={widgetStyle("blocked")}
          draggable
          onDragStart={(event) =>
            event.dataTransfer.setData("text/lifeos-widget", "blocked")
          }
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropWidget(event, "blocked")}
        >
          <SectionHeading
            title={t("رادار پیش‌نیازها", "Blocked radar")}
            subtitle={t("چه چیزی باید جلو برود؟", "What needs to move first?")}
          />
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
          ) : (
            <Empty
              title={t("پیش‌نیاز ناتمامی پیدا نشد", "No blocked tasks found")}
            />
          )}
        </section>
        <section
          className="panel"
          hidden={!widget("activity").visible}
          style={widgetStyle("activity")}
          draggable
          onDragStart={(event) =>
            event.dataTransfer.setData("text/lifeos-widget", "activity")
          }
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropWidget(event, "activity")}
        >
          <SectionHeading
            title={t("رد قدم‌ها", "Your activity")}
            action={
              <Link href="/reports" className="text-link">
                {t("گزارش", "Reports")}
                <ChevronIcon />
              </Link>
            }
          />
          <Activity events={data.data?.recent_activity.slice(0, 5) ?? []} />
        </section>
      </div>
      <Modal
        title={t("چیدمان داشبورد", "Customize dashboard")}
        open={customize}
        onOpenChange={setCustomize}
      >
        {widgets.map((item, index) => (
          <div className="widget-option" key={item.id}>
            <label>
              <input
                type="checkbox"
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
            <Button
              variant="quiet"
              disabled={index === 0}
              onClick={() => moveWidget(item.id, -1)}
              aria-label={t("بالا بردن", "Move up")}
            >
              <ArrowUp size={15} />
            </Button>
            <Button
              variant="quiet"
              disabled={index === widgets.length - 1}
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
function Activity({ events }: { events: ActivityDTO[] }) {
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
  const { t } = useLocale();
  const projects = useQuery<PageDTO<ProjectDTO>>("project_list", {
    limit: 100,
  });
  const tasks = useQuery<PageDTO<TaskDTO>>("task_search", { limit: 200 });
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<ProjectDTO | null>(null);
  const milestones = useQuery<PageDTO<Record<string, unknown>>>(
    "project_milestone_list",
    { project_id: selected?.project_id ?? "" },
    !!selected,
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("تصویر بزرگ‌تر", "THE BIGGER PICTURE")}
          </div>
          <h1>{t("پروژه‌ها", "Projects")}</h1>
          <p>
            {t(
              "قدم‌های کوچک را به نتیجه‌های معنی‌دار وصل کن.",
              "Connect small actions to meaningful outcomes.",
            )}
          </p>
        </div>
        <AddButton onClick={() => setCreate(true)}>
          {t("پروژهٔ تازه", "New project")}
        </AddButton>
      </div>
      <QueryState {...projects} retry={projects.refresh} />
      <div className="project-grid">
        {projects.data?.items.map((project) => {
          const related =
            tasks.data?.items.filter(
              (task) => task.project_id === project.project_id,
            ) ?? [];
          const done =
            project.done ??
            related.filter((task) => task.status === "Done").length;
          const total = project.total ?? related.length;
          return (
            <button
              key={project.project_id}
              className="project-card"
              onClick={() => setSelected(project)}
            >
              <div className="project-icon">
                <Folder size={20} />
              </div>
              <span className="chip">
                {project.area || t("بدون حوزه", "Unassigned")}
              </span>
              <h2>{project.title}</h2>
              <p>
                {project.notes ||
                  t("جزئیات پروژه را باز کن", "Open the project workspace")}
              </p>
              <Progress value={done} max={total} />
              <footer>
                <span>
                  {done}/{total} {t("کار", "tasks")}
                </span>
                <span>
                  {project.blocked ??
                    related.filter((task) => task.readiness === "blocked")
                      .length}{" "}
                  {t("مسدود", "blocked")}
                </span>
              </footer>
            </button>
          );
        })}
      </div>
      {!projects.loading && !projects.data?.items.length && (
        <Empty
          title={t(
            "برای یک نتیجهٔ تازه جا باز کن",
            "Make room for a new outcome",
          )}
          action={
            <AddButton onClick={() => setCreate(true)}>
              {t("ساخت پروژه", "Create project")}
            </AddButton>
          }
        />
      )}
      <Templates action={action} />
      <Modal
        title={t("پروژهٔ تازه", "New project")}
        open={create}
        onOpenChange={setCreate}
      >
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const result = await action("project_create", {
              title: form.get("title"),
              notes: form.get("notes"),
              area: form.get("area"),
              due_date: form.get("due_date") || null,
            });
            if (result) setCreate(false);
          }}
        >
          <Field label={t("عنوان", "Title")}>
            <input name="title" required />
          </Field>
          <Field label={t("حوزه", "Area")}>
            <input name="area" />
          </Field>
          <Field label={t("مهلت", "Due date")}>
            <input type="date" name="due_date" />
          </Field>
          <Field label={t("توضیح", "Notes")}>
            <textarea name="notes" />
          </Field>
          <Button variant="primary" type="submit">
            {t("ساخت پروژه", "Create project")}
          </Button>
        </form>
      </Modal>
      <Modal
        title={selected?.title ?? ""}
        open={!!selected}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
        wide
      >
        {selected && (
          <>
            <p className="muted">{selected.notes}</p>
            <SectionHeading title={t("کارهای پروژه", "Project tasks")} />
            {tasks.data?.items
              .filter((task) => task.project_id === selected.project_id)
              .map((task) => (
                <TaskRow
                  key={task.task_id}
                  task={task}
                  onOpen={onOpen}
                  onAction={action}
                />
              ))}
            <SectionHeading title={t("نقاط عطف", "Milestones")} />
            {milestones.data?.items.map((item) => (
              <div key={String(item.milestone_id)} className="dependency-row">
                <CheckCheck size={15} />
                {String(item.title)}
                <time>{String(item.due_date ?? "")}</time>
              </div>
            ))}
            <form
              className="inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const data = new FormData(form);
                const result = await action(
                  "project_milestone_create",
                  {
                    project_id: selected.project_id,
                    title: data.get("title"),
                    due_date: data.get("due_date") || null,
                  },
                  selected.revision,
                );
                if (result) form.reset();
              }}
            >
              <input
                required
                name="title"
                placeholder={t("نقطهٔ عطف تازه…", "New milestone…")}
              />
              <input name="due_date" type="date" />
              <Button type="submit">{t("افزودن", "Add")}</Button>
            </form>
            <ProjectKnowledge projectId={selected.project_id} action={action} />
          </>
        )}
      </Modal>
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
  const knowledge = useQuery<
    PageDTO<{
      knowledge_id: string;
      title: string;
      body: string;
      url: string | null;
      revision: number;
    }>
  >("knowledge_search", { project_id: projectId });
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

export function Files({ action }: { action: Action }) {
  const { t } = useLocale();
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [external, setExternal] = useState(false);
  const [selected, setSelected] = useState<FileDTO | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const files = useQuery<PageDTO<FileDTO>>("file_search", {
    search,
    state: state || undefined,
    limit: 100,
  });
  const tasks = useQuery<PageDTO<TaskDTO>>("task_search", { limit: 100 });
  const capabilities = useQuery<Record<string, unknown>>("system_capabilities");
  const versions = useQuery<PageDTO<Record<string, unknown>>>(
    "file_list_versions",
    { file_id: selected?.file_id ?? "" },
    !!selected,
  );
  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadError("");
    const form = new FormData();
    form.set("file", file);
    try {
      const response = await fetch("/api/v1/files/upload", {
        method: "POST",
        body: form,
      });
      const result = await response.json();
      if (!response.ok)
        throw new Error(result.error?.message ?? "Upload failed");
      files.refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  }
  const storageConfigured =
    capabilities.data?.storage_configured === true ||
    capabilities.data?.private_storage === true;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("همهٔ چیزهای مرتبط", "EVERYTHING CONNECTED")}
          </div>
          <h1>{t("فایل‌ها و منابع", "Files & knowledge")}</h1>
          <p>
            {t(
              "نسخه‌ها و پیوندها را نگه دار؛ هیچ منبع اصلی جابه‌جا نمی‌شود.",
              "Keep versions and relationships; original source files stay in place.",
            )}
          </p>
        </div>
        <div className="form-actions">
          <Button onClick={() => setExternal(true)}>
            <Link2 size={16} />
            {t("پیوند منبع", "Link source")}
          </Button>
          <label
            className={`button primary ${!storageConfigured ? "disabled" : ""}`}
            title={
              !storageConfigured
                ? t(
                    "ذخیره‌سازی خصوصی هنوز پیکربندی نشده",
                    "Private storage is not configured",
                  )
                : ""
            }
          >
            <Upload size={16} />
            {uploading
              ? t("در حال بارگذاری…", "Uploading…")
              : t("بارگذاری فایل", "Upload file")}
            <input
              hidden
              type="file"
              disabled={!storageConfigured || uploading}
              onChange={(event) => void upload(event)}
            />
          </label>
        </div>
      </div>
      {!storageConfigured && (
        <p className="connection-notice">
          <LockKeyhole size={15} />
          {t(
            "بارگذاری فایل جدید به اتصال ذخیره‌سازی خصوصی نیاز دارد. منابع Google Drive در جای اصلی خود باقی می‌مانند.",
            "New uploads require configured private storage. Google Drive references remain at their original locations.",
          )}
        </p>
      )}
      {uploadError && (
        <p className="error" role="alert">
          {uploadError}
        </p>
      )}
      <div className="filter-bar">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("جست‌وجوی فایل‌ها…", "Search files…")}
        />
        <div className="tabs">
          {[
            ["", t("همه", "All")],
            ["Inbox", t("ورودی", "Inbox")],
            ["Active", t("فعال", "Active")],
            ["Old", t("بایگانی", "Archived")],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setState(value)}
              className={state === value ? "active" : ""}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <QueryState {...files} retry={files.refresh} />
      <div className="file-grid">
        {files.data?.items.map((file) => (
          <button
            className="file-card"
            key={file.file_id}
            onClick={() => setSelected(file)}
          >
            <div className="file-art">
              <FileText size={42} />
              <span>
                {file.original_filename.split(".").pop()?.toUpperCase()}
              </span>
            </div>
            <div className="file-info">
              <strong>{file.title}</strong>
              <small>
                {file.provider} ·{" "}
                {file.size_bytes !== null
                  ? `${Math.round(file.size_bytes / 1024)} KB`
                  : t("اندازه نامشخص", "Size unavailable")}
              </small>
              <span className="chip">{file.state}</span>
            </div>
          </button>
        ))}
      </div>
      {!files.loading && !files.data?.items.length && (
        <Empty
          title={t(
            "منابعت اینجا کنار هم می‌مانند",
            "Keep your references together here",
          )}
        />
      )}
      <Modal
        title={t("پیوند یک منبع موجود", "Register an existing source")}
        open={external}
        onOpenChange={setExternal}
      >
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const result = await action("file_register_external_link", {
              title: form.get("title"),
              external_url: form.get("url"),
              external_id: form.get("external_id"),
              provider: "google_drive",
              original_filename: form.get("title"),
            });
            if (result) setExternal(false);
          }}
        >
          <Field label={t("عنوان", "Title")}>
            <input required name="title" />
          </Field>
          <Field label={t("پیوند Google Drive", "Google Drive URL")}>
            <input
              required
              name="url"
              type="url"
              dir="ltr"
              placeholder="https://drive.google.com/…"
            />
          </Field>
          <Field label={t("شناسهٔ فایل در Drive", "Drive file ID")}>
            <input name="external_id" required dir="ltr" />
          </Field>
          <Button variant="primary" type="submit">
            {t("ثبت مرجع", "Register reference")}
          </Button>
        </form>
      </Modal>
      <Modal
        title={selected?.title ?? ""}
        open={!!selected}
        onOpenChange={(value) => {
          if (!value) setSelected(null);
        }}
      >
        {selected && (
          <>
            <div className="file-art large">
              <FileText size={58} />
            </div>
            <dl className="metadata-list">
              <dt>{t("منبع", "Provider")}</dt>
              <dd>{selected.provider}</dd>
              <dt>{t("نام اصلی", "Original filename")}</dt>
              <dd>{selected.original_filename}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">
                {selected.sha256 ?? t("محاسبه نشده", "Not available")}
              </dd>
              <dt>{t("وضعیت", "State")}</dt>
              <dd>{selected.state}</dd>
            </dl>
            <div className="form-actions">
              {selected.external_url ? (
                <a
                  className="button"
                  target="_blank"
                  rel="noreferrer"
                  href={selected.external_url}
                >
                  <ArrowUpRight size={15} />
                  {t("بازکردن منبع", "Open source")}
                </a>
              ) : (
                <a
                  className="button"
                  href={`/api/v1/files/${encodeURIComponent(selected.file_id)}/download`}
                >
                  <Download size={15} />
                  {t("دریافت فایل", "Download")}
                </a>
              )}
              <Button
                onClick={async () => {
                  if (selected.state === "Old") {
                    await action(
                      "file_restore",
                      { file_id: selected.file_id },
                      selected.revision,
                    );
                  } else {
                    try {
                      const preview = await query<Record<string, unknown>>(
                        "file_archive_preview",
                        { file_id: selected.file_id },
                      );
                      window.dispatchEvent(
                        new CustomEvent("lifeos:preview", { detail: preview }),
                      );
                    } catch (error) {
                      window.dispatchEvent(
                        new CustomEvent("lifeos:error", {
                          detail: String(error),
                        }),
                      );
                    }
                  }
                }}
              >
                {selected.state === "Old"
                  ? t("بازیابی", "Restore")
                  : t("بررسی امکان بایگانی", "Check archive eligibility")}
              </Button>
            </div>
            <SectionHeading title={t("پیوند به یک کار", "Link to a task")} />
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                await action(
                  "file_link_to_task",
                  {
                    file_id: selected.file_id,
                    task_id: data.get("task_id"),
                    purpose: data.get("purpose"),
                  },
                  selected.revision,
                );
              }}
            >
              <select name="task_id" required>
                <option value="">{t("انتخاب کار…", "Choose a task…")}</option>
                {tasks.data?.items.map((task) => (
                  <option key={task.task_id} value={task.task_id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <select name="purpose">
                {["Input", "Reference", "Output", "Other"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <Button type="submit">{t("پیوند", "Link")}</Button>
            </form>
            <SectionHeading title={t("نسخه‌ها", "Versions")} />
            {versions.data?.items.map((version, index) => (
              <div
                className="dependency-row"
                key={String(version.version_id ?? index)}
              >
                <History size={14} />
                <span>
                  {String(
                    version.original_filename ?? selected.original_filename,
                  )}
                </span>
                <time>{String(version.created_at ?? "")}</time>
              </div>
            ))}
          </>
        )}
      </Modal>
    </>
  );
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
}
export function Assistant() {
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
            {plan.actions.length > 0 && (
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
  const { t } = useLocale();
  const data = useQuery<Analytics>("analytics_summary");
  const activity = useQuery<PageDTO<ActivityDTO>>("get_activity", {
    limit: 50,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("از قدم‌هایت یاد بگیر", "LEARN FROM YOUR MOMENTUM")}
          </div>
          <h1>{t("گزارش و مرور", "Reports & review")}</h1>
          <p>
            {t(
              "اعداد واقعی، برای انتخاب قدم بعدی.",
              "Real numbers to guide your next step.",
            )}
          </p>
        </div>
      </div>
      <QueryState {...data} retry={data.refresh} />
      <div className="metric-grid">
        <div className="metric-card">
          <span>{t("کار تکمیل‌شده", "Completed tasks")}</span>
          <strong>{data.data?.tasks.done ?? "—"}</strong>
          <Progress
            value={data.data?.tasks.done ?? 0}
            max={data.data?.tasks.total ?? 0}
          />
        </div>
        <div className="metric-card">
          <span>{t("ساعت ثبت‌شده", "Recorded hours")}</span>
          <strong>
            {data.data
              ? Math.round((data.data.time.minutes / 60) * 10) / 10
              : "—"}
          </strong>
        </div>
        <div className="metric-card">
          <span>{t("منابع ثبت‌شده", "Registered files")}</span>
          <strong>{data.data?.files.total ?? "—"}</strong>
        </div>
        <div className="metric-card">
          <span>{t("پروژه‌ها", "Projects")}</span>
          <strong>{data.data?.projects.length ?? "—"}</strong>
        </div>
      </div>
      <section className="panel">
        <SectionHeading title={t("تاریخچهٔ تغییرها", "Activity history")} />
        <QueryState {...activity} retry={activity.refresh} />
        <Activity events={activity.data?.items ?? []} />
      </section>
    </>
  );
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
  const reminders = useQuery<PageDTO<Record<string, unknown>>>("reminder_list");
  const [message, setMessage] = useState("");
  const session = authClient.useSession();
  async function saveSettings(settings: Record<string, unknown>) {
    await action(
      "preferences_update",
      { settings: { ...preferences.data?.settings, ...settings } },
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
              <strong>
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
        <section className="panel">
          <SectionHeading title={t("اتصال AI و MCP", "AI & MCP connections")} />
          <p>
            {t(
              "اتصال ابزار سفارشی ChatGPT به مجوز واقعی پلن وابسته است.",
              "Custom ChatGPT tool access depends on actual account eligibility.",
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
          <Link href="/assistant" className="button">
            <BrainCircuit size={16} />
            {t("همراه داخل برنامه", "In-app assistant")}
          </Link>
        </section>
        <section className="panel">
          <SectionHeading
            title={t(
              "Google Calendar (فقط خواندنی)",
              "Google Calendar (read only)",
            )}
          />
          <p>
            {t(
              "با اجازهٔ جداگانهٔ شما، رویدادها خوانده می‌شوند. این اتصال اجازهٔ ساخت، تغییر یا حذف رویدادهای Google را ندارد.",
              "With your separate authorization, events can be read. This connection cannot create, change or delete Google events.",
            )}
          </p>
          <Button
            disabled={capabilities.data?.oauth_client_configured !== true}
            onClick={async () => {
              const result = await authClient.linkSocial({
                provider: "google",
                callbackURL: new URL(
                  "/settings",
                  window.location.origin,
                ).toString(),
                scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
              });
              if (result.error)
                setMessage(result.error.message ?? "Google connection failed");
            }}
          >
            {t(
              "اتصال خواندنی Google Calendar",
              "Connect read-only Google Calendar",
            )}
          </Button>
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
        {reminders.data?.items.map((item, index) => (
          <div
            className="dependency-row"
            key={String(item.reminder_id ?? index)}
          >
            {String(item.title ?? item.task_id ?? "")}
            <time>{String(item.due_at ?? item.scheduled_at ?? "")}</time>
            <span>{String(item.status ?? "")}</span>
          </div>
        ))}
        {!reminders.data?.items.length && (
          <p className="muted">
            {t(
              "یادآوری ثبت نشده؛ ارسال تنها با زمان‌بند و مجوز واقعی فعال می‌شود.",
              "No reminders recorded. Delivery requires an actual scheduler and permission.",
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
