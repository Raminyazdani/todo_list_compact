"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { zonedLocalToInstant } from "@/shared/datetime";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  Circle,
  CircleCheck,
  Clock3,
  Copy,
  FileText,
  GitBranch,
  LayoutGrid,
  List,
  ListTree,
  Network,
  Plus,
  RotateCcw,
  Redo2,
  Search,
  Trash2,
  Undo2,
} from "lucide-react";
import type {
  ChecklistDTO,
  ChecklistItemDTO,
  CommandName,
  GraphDTO,
  MutationResult,
  PageDTO,
  PreviewDTO,
  ProjectDTO,
  TaskDTO,
} from "@/shared/contracts";
import { WORKFLOW_STATUSES } from "@/shared/contracts";
import { query, useQuery } from "./api";
import { useLabels, useLocale } from "./locale";
import { PlanningPanel } from "./planning";
import {
  AddButton,
  Button,
  Empty,
  Field,
  Modal,
  Progress,
  QueryState,
} from "@/components/ui";

const DependencyGraph = dynamic(
  () => import("./graph").then((module) => module.DependencyGraph),
  {
    ssr: false,
    loading: () => (
      <div className="loading-state" role="status">
        در حال دریافت گراف / Loading graph…
      </div>
    ),
  },
);

export function TaskStatus({ task }: { task: TaskDTO }) {
  const labels = useLabels();
  return (
    <span className={`readiness ${task.readiness}`}>
      <i />
      {labels.readiness[task.readiness]}
    </span>
  );
}

export function TaskRow({
  task,
  onOpen,
  onAction,
  selected,
  onSelect,
}: {
  task: TaskDTO;
  onOpen: (id: string) => void;
  onAction: (
    name: CommandName,
    input: Record<string, unknown>,
    revision?: number,
  ) => Promise<MutationResult | null>;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const labels = useLabels();
  const { t } = useLocale();
  return (
    <div className={`task-row ${task.status === "Done" ? "completed" : ""}`}>
      {onSelect && (
        <input
          type="checkbox"
          checked={selected}
          onChange={onSelect}
          aria-label={`${t("انتخاب", "Select")} ${task.title}`}
        />
      )}
      <button
        className="task-check"
        aria-label={`${task.archived_at ? t("بازیابی", "Restore") : task.status === "Done" ? t("بازکردن", "Reopen") : t("تکمیل", "Complete")} ${task.title}`}
        onClick={() =>
          void onAction(
            task.archived_at
              ? "task_restore"
              : task.status === "Done"
                ? "task_reopen"
                : "task_complete",
            { task_id: task.task_id },
            task.revision,
          )
        }
      >
        {task.archived_at ? (
          <RotateCcw size={19} />
        ) : task.status === "Done" ? (
          <CircleCheck size={19} />
        ) : (
          <Circle size={19} />
        )}
      </button>
      <button className="task-title" onClick={() => onOpen(task.task_id)}>
        <span>{task.title}</span>
        {task.next_action && <small>{task.next_action}</small>}
      </button>
      <span
        className={`priority ${task.priority.toLowerCase()}`}
        title={labels.priority[task.priority]}
      >
        ◧
      </span>
      <TaskStatus task={task} />
      {task.checklist_progress.total > 0 && (
        <span className="task-meta">
          <List size={13} />
          {task.checklist_progress.checked}/{task.checklist_progress.total}
        </span>
      )}
      {task.due_date && (
        <time className="task-date" dateTime={task.due_date}>
          {task.due_date}
        </time>
      )}
      <span className="task-workflow">{labels.statuses[task.status]}</span>
    </div>
  );
}

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

export function CreateTask({
  open,
  setOpen,
  action,
  parentId,
  projectId,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  action: Action;
  parentId?: string;
  projectId?: string;
}) {
  const { t } = useLocale();
  const projects = useQuery<PageDTO<ProjectDTO>>(
    "project_list",
    {
      limit: 100,
    },
    open,
  );
  const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    const result = await action(parentId ? "subtask_create" : "task_create", {
      title: data.get("title"),
      notes: data.get("notes"),
      priority: data.get("priority"),
      category: data.get("category"),
      due_date: data.get("due_date") || null,
      project_id: data.get("project_id") || projectId || null,
      ...(parentId ? { parent_task_id: parentId } : {}),
    });
    setBusy(false);
    if (result) setOpen(false);
  }
  return (
    <Modal
      title={
        parentId
          ? t("زیرکار تازه", "New subtask")
          : t("ثبت یک کار تازه", "Capture a task")
      }
      open={open}
      onOpenChange={setOpen}
    >
      <form onSubmit={submit} className="form-grid">
        <Field
          label={t(
            "چه کاری می‌خواهی انجام بدهی؟",
            "What would you like to do?",
          )}
        >
          <input
            autoFocus
            name="title"
            placeholder={t(
              "مثلاً: مرور منابع مقاله",
              "For example: Review paper references",
            )}
            required
            maxLength={500}
          />
        </Field>
        <Field label={t("یادداشت", "Notes")}>
          <textarea name="notes" rows={3} />
        </Field>
        <div className="form-columns">
          <Field label={t("اولویت", "Priority")}>
            <select name="priority" defaultValue="Normal">
              {["Low", "Normal", "High", "Urgent"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </Field>
          <Field label={t("حوزه", "Category")}>
            <select name="category" defaultValue="Other">
              {["Study", "Research", "Work", "Admin", "Personal", "Other"].map(
                (value) => (
                  <option key={value}>{value}</option>
                ),
              )}
            </select>
          </Field>
        </div>
        <div className="form-columns">
          <Field label={t("پروژه", "Project")}>
            <select name="project_id" defaultValue={projectId ?? ""}>
              <option value="">{t("بدون پروژه", "No project")}</option>
              {projects.data?.items?.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("مهلت (اختیاری)", "Due date (optional)")}>
            <input name="due_date" type="date" />
          </Field>
        </div>
        <p className="muted small">
          {t(
            "اگر تاریخی انتخاب نکنی، کار بدون مهلت ثبت می‌شود.",
            "Leave the date empty to create a task without a deadline.",
          )}
        </p>
        <Button variant="primary" type="submit" disabled={busy}>
          {busy ? t("در حال ذخیره…", "Saving…") : t("ثبت کار", "Create task")}
        </Button>
      </form>
    </Modal>
  );
}

export function TaskExplorer({
  onOpen,
  action,
}: {
  onOpen: (id: string) => void;
  action: Action;
}) {
  const { t } = useLocale();
  const labels = useLabels();
  const params = useSearchParams();
  const [search, setSearch] = useState(params.get("search") ?? "");
  const [filter, setFilter] = useState(params.get("filter") ?? "all");
  const [cursor, setCursor] = useState<string | null>(null);
  const [graphCursor, setGraphCursor] = useState<string | null>(null);
  const [graphRoot, setGraphRoot] = useState("");
  const [graphDirection, setGraphDirection] = useState("both");
  const [view, setView] = useState("list");
  const [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const input = {
    limit: 100,
    ...(cursor ? { cursor } : {}),
    ...(search ? { search } : {}),
    ...(filter === "archived"
      ? { include_archived: true, archived_only: true }
      : {}),
    ...(filter === "ready" || filter === "blocked"
      ? { readiness: filter }
      : filter !== "all" && filter !== "overdue" && filter !== "archived"
        ? { status: filter }
        : {}),
  };
  const tasks = useQuery<PageDTO<TaskDTO>>(
    filter === "overdue" ? "task_list_overdue" : "task_search",
    input,
  );
  const graph = useQuery<GraphDTO>(
    "task_graph_get",
    {
      limit: 200,
      ...(graphCursor ? { cursor: graphCursor } : {}),
      ...(search ? { search } : {}),
      ...(filter === "overdue" ? { overdue: true } : {}),
      ...(filter === "archived"
        ? { include_archived: true, archived_only: true }
        : {}),
      ...(filter === "ready" || filter === "blocked"
        ? { readiness: filter }
        : filter !== "all" && filter !== "overdue" && filter !== "archived"
          ? { status: filter }
          : {}),
      ...(graphRoot ? { task_id: graphRoot, direction: graphDirection } : {}),
    },
    view === "graph" || view === "timeline",
  );
  const savedViews = useQuery<
    PageDTO<{
      view_id: string;
      title: string;
      configuration: { filters?: Record<string, unknown>; layout?: string };
    }>
  >("saved_view_list");
  const [bulkPreview, setBulkPreview] = useState<PreviewDTO | null>(null);
  async function bulk() {
    try {
      const preview = await query<PreviewDTO>("task_batch_preview", {
        task_ids: selected,
        action: filter === "archived" ? "restore" : "complete",
      });
      setBulkPreview(preview);
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("lifeos:error", {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  async function saveView() {
    await action("saved_view_create", {
      title: `${filter} · ${view}${search ? ` · ${search}` : ""}`,
      configuration: { filters: input, layout: view },
    });
  }
  const rows = tasks.data?.items ?? [];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("فضای اجرای کارها", "YOUR EXECUTION SPACE")}
          </div>
          <h1>{t("کارهای من", "My tasks")}</h1>
          <p>
            {t(
              "هر کار، یک قدم روشن به سمت چیزهای مهم.",
              "A clear next step for everything that matters.",
            )}
          </p>
        </div>
        <AddButton onClick={() => setCreate(true)}>
          {t("کار تازه", "New task")}
        </AddButton>
      </div>
      <div className="view-bar">
        <div className="tabs">
          {[
            ["all", t("همه", "All")],
            ["ready", t("آماده", "Ready now")],
            ["blocked", t("مسدود", "Blocked")],
            ["Inbox", t("ورودی", "Inbox")],
            ["Waiting", t("منتظر", "Waiting")],
            ["Done", t("انجام شده", "Done")],
            ["archived", t("بایگانی", "Archived")],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? "active" : ""}
              onClick={() => {
                setFilter(value);
                setCursor(null);
                setGraphCursor(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="icon-group">
          {[
            ["list", List],
            ["board", LayoutGrid],
            ["tree", ListTree],
            ["graph", Network],
            ["timeline", GitBranch],
          ].map(([value, Icon]) => {
            const IconComponent = Icon as typeof List;
            return (
              <button
                key={String(value)}
                className={view === value ? "active" : ""}
                aria-label={String(value)}
                title={String(value)}
                onClick={() => setView(String(value))}
              >
                <IconComponent size={17} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="filter-bar">
        <select
          aria-label={t("نماهای ذخیره‌شده", "Saved views")}
          defaultValue=""
          onChange={(event) => {
            const saved = savedViews.data?.items.find(
              (item) => item.view_id === event.target.value,
            );
            if (saved) {
              const filters = saved.configuration.filters ?? {};
              setSearch(
                typeof filters.search === "string" ? filters.search : "",
              );
              setFilter(
                filters.archived_only === true
                  ? "archived"
                  : filters.overdue === true
                    ? "overdue"
                    : typeof filters.readiness === "string"
                      ? filters.readiness
                      : typeof filters.status === "string"
                        ? filters.status
                        : "all",
              );
              setView(
                ["list", "board", "tree", "graph", "timeline"].includes(
                  saved.configuration.layout ?? "",
                )
                  ? saved.configuration.layout!
                  : "list",
              );
              setCursor(null);
              setGraphCursor(null);
            }
          }}
        >
          <option value="">{t("نماهای ذخیره‌شده", "Saved views")}</option>
          {savedViews.data?.items.map((item) => (
            <option key={item.view_id} value={item.view_id}>
              {item.title}
            </option>
          ))}
        </select>
        <label className="search-box">
          <Search size={16} />
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setCursor(null);
              setGraphCursor(null);
            }}
            placeholder={t("جست‌وجو بین کارها…", "Search tasks…")}
          />
        </label>
        <span className="muted small">
          {tasks.data?.total ?? "—"} {t("کار", "tasks")}
        </span>
        <Button onClick={() => void saveView()}>
          {t("ذخیرهٔ نما", "Save view")}
        </Button>
      </div>
      {(view === "graph" || view === "timeline") && (
        <div className="filter-bar graph-scope">
          <Field label={t("کار محوری گراف", "Graph focus task")}>
            <select
              value={graphRoot}
              onChange={(event) => {
                setGraphRoot(event.target.value);
                setGraphCursor(null);
              }}
            >
              <option value="">
                {t("فهرست مطابق فیلتر", "Filtered task inventory")}
              </option>
              {graphRoot &&
                !rows.some((task) => task.task_id === graphRoot) && (
                  <option value={graphRoot}>
                    {graph.data?.nodes.find(
                      (task) => task.task_id === graphRoot,
                    )?.title ?? t("کار انتخاب‌شده", "Selected task")}
                  </option>
                )}
              {rows.map((task) => (
                <option key={task.task_id} value={task.task_id}>
                  {task.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("محدودهٔ وابستگی‌ها", "Dependency direction")}>
            <select
              value={graphDirection}
              disabled={!graphRoot}
              onChange={(event) => {
                setGraphDirection(event.target.value);
                setGraphCursor(null);
              }}
            >
              <option value="both">
                {t(
                  "پیش‌نیازها و کارهای وابسته",
                  "Prerequisites and downstream tasks",
                )}
              </option>
              <option value="upstream">
                {t("زنجیرهٔ پیش‌نیازها", "Prerequisite chain")}
              </option>
              <option value="downstream">
                {t("کارهای آزادشونده", "Downstream tasks")}
              </option>
            </select>
          </Field>
          <p className="small muted">
            {t(
              "برای یافتن کار محوری جست‌وجو کن. با انتخاب آن، روابط مجاز بین پروژه‌ها و پیش‌نیازهای بایگانی‌شده هم نمایش داده می‌شوند.",
              "Search for a focus task. Selecting it includes authorized cross-project and archived dependency context.",
            )}
          </p>
        </div>
      )}
      {selected.length > 0 && (
        <div className="selection-bar">
          {selected.length} {t("انتخاب شده", "selected")}
          <Button onClick={() => void bulk()}>
            {filter === "archived"
              ? t("پیش‌نمایش بازیابی گروهی", "Preview restoration")
              : t("پیش‌نمایش تکمیل گروهی", "Preview completion")}
          </Button>
          <Button onClick={() => setSelected([])}>
            {t("لغو انتخاب", "Clear")}
          </Button>
        </div>
      )}
      <QueryState
        {...(view === "graph" ? graph : tasks)}
        retry={view === "graph" ? graph.refresh : tasks.refresh}
      />
      {!(view === "graph" ? graph.loading : tasks.loading) &&
      !(view === "graph" ? graph.error : tasks.error) &&
      (view === "graph" ? (graph.data?.nodes.length ?? 0) : rows.length) ===
        0 ? (
        <Empty
          title={t("جا برای یک شروع تازه", "A fresh place to begin")}
          detail={t(
            "یک کار ثبت کن یا فیلتر را تغییر بده.",
            "Capture a task or adjust your filters.",
          )}
          action={
            <AddButton onClick={() => setCreate(true)}>
              {t("ثبت اولین کار", "Capture a task")}
            </AddButton>
          }
        />
      ) : view === "graph" ? (
        <DependencyGraph graph={graph.data} onOpen={onOpen} />
      ) : view === "board" ? (
        <div className="board">
          {WORKFLOW_STATUSES.map((status) => (
            <div
              className="board-column"
              key={status}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const id = event.dataTransfer.getData("text/lifeos-task");
                const task = rows.find((item) => item.task_id === id);
                if (task)
                  void action(
                    "task_update",
                    { task_id: id, status },
                    task.revision,
                  );
              }}
            >
              <header>
                <span>{labels.statuses[status]}</span>
                <b>{rows.filter((task) => task.status === status).length}</b>
              </header>
              {rows
                .filter((task) => task.status === status)
                .map((task) => (
                  <div
                    className="board-card"
                    key={task.task_id}
                    draggable
                    onDragStart={(event) =>
                      event.dataTransfer.setData(
                        "text/lifeos-task",
                        task.task_id,
                      )
                    }
                  >
                    <button onClick={() => onOpen(task.task_id)}>
                      {task.title}
                    </button>
                    <TaskStatus task={task} />
                    <select
                      aria-label={t("تغییر وضعیت", "Change status")}
                      value={task.status}
                      onChange={(event) =>
                        void action(
                          "task_update",
                          { task_id: task.task_id, status: event.target.value },
                          task.revision,
                        )
                      }
                    >
                      {WORKFLOW_STATUSES.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </div>
                ))}
            </div>
          ))}
        </div>
      ) : view === "timeline" ? (
        <>
          <TaskTimeline tasks={graph.data?.nodes ?? rows} onOpen={onOpen} />
          <PlanningPanel graph={graph.data} onOpen={onOpen} action={action} />
        </>
      ) : view === "tree" ? (
        <TaskTree tasks={rows} onOpen={onOpen} action={action} />
      ) : (
        <div className="task-list">
          {rows.map((task) => (
            <TaskRow
              key={task.task_id}
              task={task}
              onOpen={onOpen}
              onAction={action}
              selected={selected.includes(task.task_id)}
              onSelect={() =>
                setSelected((ids) =>
                  ids.includes(task.task_id)
                    ? ids.filter((id) => id !== task.task_id)
                    : [...ids, task.task_id],
                )
              }
            />
          ))}
        </div>
      )}
      <div className="form-actions pagination">
        {view === "graph" ? (
          <>
            {graphCursor && (
              <Button onClick={() => setGraphCursor(null)}>
                {t("ابتدای گراف", "First graph page")}
              </Button>
            )}
            {graph.data?.next_cursor && (
              <Button
                onClick={() => setGraphCursor(graph.data?.next_cursor ?? null)}
              >
                {t("بخش بعدی گراف", "Next graph page")}
              </Button>
            )}
          </>
        ) : (
          <>
            {cursor && (
              <Button onClick={() => setCursor(null)}>
                {t("صفحهٔ اول", "First page")}
              </Button>
            )}
            {tasks.data?.next_cursor && (
              <Button
                onClick={() => setCursor(tasks.data?.next_cursor ?? null)}
              >
                {t("صفحهٔ بعد", "Next page")}
              </Button>
            )}
          </>
        )}
      </div>
      <CreateTask open={create} setOpen={setCreate} action={action} />
      <Modal
        title={t("تأیید تغییر گروهی", "Confirm batch change")}
        open={!!bulkPreview}
        onOpenChange={() => setBulkPreview(null)}
      >
        {bulkPreview && (
          <>
            <pre className="preview-json">
              {JSON.stringify(bulkPreview.changes, null, 2)}
            </pre>
            <p>{bulkPreview.warnings.join("\n")}</p>
            <Button
              variant="primary"
              onClick={async () => {
                const result = await action("task_batch_commit", {
                  preview_id: bulkPreview.preview_id,
                });
                if (result) {
                  setBulkPreview(null);
                  setSelected([]);
                }
              }}
            >
              {t("تأیید و اجرا", "Confirm and apply")}
            </Button>
          </>
        )}
      </Modal>
    </>
  );
}

function TaskTree({
  tasks,
  onOpen,
  action,
}: {
  tasks: TaskDTO[];
  onOpen: (id: string) => void;
  action: Action;
}) {
  const [collapsed, setCollapsed] = useState<string[]>([]);
  function branch(parentId: string | null, depth: number): React.ReactNode {
    return tasks
      .filter(
        (task) =>
          task.parent_task_id === parentId ||
          (parentId === null &&
            !tasks.some((parent) => parent.task_id === task.parent_task_id)),
      )
      .map((task) => (
        <div key={task.task_id} style={{ marginInlineStart: depth ? 20 : 0 }}>
          <div className="tree-row">
            <button
              className="icon-button"
              aria-label="Expand/collapse"
              onClick={() =>
                setCollapsed((ids) =>
                  ids.includes(task.task_id)
                    ? ids.filter((id) => id !== task.task_id)
                    : [...ids, task.task_id],
                )
              }
            >
              {collapsed.includes(task.task_id) ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronDown size={16} />
              )}
            </button>
            <TaskRow task={task} onOpen={onOpen} onAction={action} />
          </div>
          {!collapsed.includes(task.task_id) &&
            depth < 12 &&
            branch(task.task_id, depth + 1)}
        </div>
      ));
  }
  return <div className="task-list">{branch(null, 0)}</div>;
}

function TaskTimeline({
  tasks,
  onOpen,
}: {
  tasks: TaskDTO[];
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const dated = tasks.filter((task) => task.start_date || task.due_date);
  if (!dated.length)
    return (
      <Empty
        title={t("هنوز تاریخی انتخاب نشده", "No scheduled dates yet")}
        detail={t(
          "تاریخ شروع یا مهلت را در جزئیات کار تعیین کن.",
          "Set a start or due date in task details.",
        )}
      />
    );
  const starts = dated.map((task) =>
    new Date((task.start_date || task.due_date) + "T12:00:00Z").getTime(),
  );
  const ends = dated.map((task) =>
    new Date((task.due_date || task.start_date) + "T12:00:00Z").getTime(),
  );
  const min = Math.min(...starts);
  const max = Math.max(...ends);
  const range = Math.max(86400000, max - min);
  return (
    <div className="timeline-list">
      <div className="timeline-range">
        <time>{new Date(min).toISOString().slice(0, 10)}</time>
        <span>
          {t(
            "تاریخ‌ها فقط با تأیید شما تغییر می‌کنند",
            "Dates change only with your approval",
          )}
        </span>
        <time>{new Date(max).toISOString().slice(0, 10)}</time>
      </div>
      {dated.map((task, index) => (
        <div key={task.task_id} className="gantt-row">
          <button onClick={() => onOpen(task.task_id)}>{task.title}</button>
          <div className="gantt-track">
            <button
              onClick={() => onOpen(task.task_id)}
              className={`gantt-bar ${task.readiness}`}
              style={{
                insetInlineStart: `${((starts[index] - min) / range) * 80}%`,
                width: `${Math.max(3, ((ends[index] - starts[index]) / range) * 80)}%`,
              }}
              aria-label={task.title}
            >
              <Clock3 size={12} />
            </button>
          </div>
        </div>
      ))}
      <p className="muted small">
        {t(
          "مسیر بحرانی فقط با برآورد کافی محاسبه می‌شود.",
          "Critical paths require sufficient estimates.",
        )}
      </p>
    </div>
  );
}

export function TaskDetail({
  taskId,
  onClose,
  onOpen,
  action,
}: {
  taskId: string | null;
  onClose: () => void;
  onOpen: (id: string) => void;
  action: Action;
}) {
  const { t } = useLocale();
  const data = useQuery<TaskDTO>(
    "task_get",
    { task_id: taskId ?? "" },
    !!taskId,
  );
  const [candidateSearch, setCandidateSearch] = useState("");
  const candidates = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    { limit: 100, search: candidateSearch || undefined },
    !!taskId,
  );
  const [tab, setTab] = useState("overview");
  const [child, setChild] = useState(false);
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [waiver, setWaiver] = useState<string | null>(null);
  const [selectedPrerequisites, setSelectedPrerequisites] = useState<string[]>(
    [],
  );
  const task = data.data;
  async function getPreview(
    operation:
      | "task_dependency_add_preview"
      | "task_dependency_remove_preview"
      | "task_dependency_waive_preview"
      | "subtask_reparent_preview",
    input: Record<string, unknown>,
  ) {
    try {
      setPreview(await query<PreviewDTO>(operation, input));
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("lifeos:error", {
          detail: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  async function saveOverview(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!task) return;
    const form = new FormData(event.currentTarget);
    await action(
      "task_update",
      {
        task_id: task.task_id,
        title: form.get("title"),
        notes: form.get("notes"),
        next_action: form.get("next_action"),
        waiting_for: form.get("waiting_for"),
        priority: form.get("priority"),
        category: form.get("category"),
        start_date: form.get("start_date") || null,
        due_date: form.get("due_date") || null,
        estimated_minutes: form.get("estimated_minutes")
          ? Number(form.get("estimated_minutes"))
          : null,
      },
      task.revision,
    );
  }
  return (
    <Modal
      title={task?.title ?? t("جزئیات کار", "Task details")}
      open={!!taskId}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      wide
    >
      <QueryState {...data} retry={data.refresh} />
      {task && (
        <>
          <div className="detail-top">
            <TaskStatus task={task} />
            <span className="muted small">
              {task.category} · {task.priority}
            </span>
            <span className="muted small">
              {t("نسخه", "Revision")} {task.revision}
            </span>
            <div className="spacer" />
            <Button
              variant="quiet"
              title={t(
                "برگرداندن آخرین تغییر قابل برگشت همین کار؛ تغییر بعدی ممکن است آن را نامعتبر کند",
                "Undo this task's last eligible change; an intervening edit may prevent it",
              )}
              onClick={() =>
                void action(
                  "undo_last_eligible_action",
                  { task_id: task.task_id },
                  task.revision,
                )
              }
            >
              <Undo2 size={15} /> {t("برگردان", "Undo")}
            </Button>
            <Button
              variant="quiet"
              title={t(
                "اجرای دوبارهٔ تغییر برگردانده‌شدهٔ همین کار",
                "Redo this task's last eligible undone change",
              )}
              onClick={() =>
                void action(
                  "redo_last_eligible_action",
                  { task_id: task.task_id },
                  task.revision,
                )
              }
            >
              <Redo2 size={15} /> {t("دوباره", "Redo")}
            </Button>
            <Button
              variant={
                task.status === "Done" && !task.archived_at ? "" : "primary"
              }
              onClick={() =>
                void action(
                  task.archived_at
                    ? "task_restore"
                    : task.status === "Done"
                      ? "task_reopen"
                      : "task_complete",
                  { task_id: task.task_id },
                  task.revision,
                )
              }
            >
              {task.archived_at || task.status === "Done" ? (
                <RotateCcw size={15} />
              ) : (
                <Check size={15} />
              )}{" "}
              {task.archived_at
                ? t("بازیابی کار", "Restore task")
                : task.status === "Done"
                  ? t("بازکردن", "Reopen")
                  : t("تکمیل کار", "Complete task")}
            </Button>
          </div>
          {task.blocked_by.length > 0 && (
            <div className="blocker-banner">
              <GitBranch size={18} />
              <div>
                <strong>
                  {t(
                    `این کار ${task.blocked_by.length} پیش‌نیاز ناتمام دارد`,
                    `${task.blocked_by.length} prerequisites remain`,
                  )}
                </strong>
                <div>
                  {task.blocked_by.map((blocker) => (
                    <button
                      key={`${blocker.group_id}-${blocker.task_id}`}
                      onClick={() => onOpen(blocker.task_id)}
                    >
                      {blocker.title} <ChevronLeft size={12} />
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
          <div className="tabs detail-tabs">
            {[
              ["overview", t("نمای کلی", "Overview")],
              ["checklists", t("چک‌لیست‌ها", "Checklists")],
              ["subtasks", t("زیرکارها", "Subtasks")],
              ["dependencies", t("پیش‌نیازها", "Prerequisites")],
              ["unblocks", t("آزاد می‌کند", "Unblocks")],
              ["files", t("فایل‌ها", "Files")],
              ["discussion", t("یادداشت و برچسب", "Discussion & tags")],
              ["history", t("تاریخچه", "History")],
            ].map(([value, label]) => (
              <button
                key={value}
                className={tab === value ? "active" : ""}
                onClick={() => setTab(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {tab === "overview" && (
            <form
              className="form-grid"
              key={`${task.task_id}-${task.revision}`}
              onSubmit={saveOverview}
            >
              <Field label={t("عنوان", "Title")}>
                <input name="title" required defaultValue={task.title} />
              </Field>
              <div className="form-columns">
                <Field label={t("اولویت", "Priority")}>
                  <select name="priority" defaultValue={task.priority}>
                    {["Low", "Normal", "High", "Urgent"].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
                <Field label={t("حوزه", "Category")}>
                  <select name="category" defaultValue={task.category}>
                    {[
                      "Study",
                      "Research",
                      "Work",
                      "Admin",
                      "Personal",
                      "Other",
                    ].map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="form-columns">
                <Field label={t("شروع", "Start date")}>
                  <input
                    name="start_date"
                    type="date"
                    defaultValue={task.start_date ?? ""}
                  />
                </Field>
                <Field label={t("مهلت", "Due date")}>
                  <input
                    name="due_date"
                    type="date"
                    defaultValue={task.due_date ?? ""}
                  />
                </Field>
                <Field label={t("برآورد (دقیقه)", "Estimate (minutes)")}>
                  <input
                    name="estimated_minutes"
                    type="number"
                    min="0"
                    defaultValue={task.estimated_minutes ?? ""}
                  />
                </Field>
              </div>
              <Field label={t("قدم بعدی", "Next action")}>
                <input name="next_action" defaultValue={task.next_action} />
              </Field>
              <Field label={t("منتظر چه کسی / چیزی؟", "Waiting for")}>
                <input name="waiting_for" defaultValue={task.waiting_for} />
              </Field>
              <Field label={t("یادداشت‌ها", "Notes")}>
                <textarea name="notes" rows={5} defaultValue={task.notes} />
              </Field>
              <div className="form-actions">
                <Button variant="primary" type="submit">
                  {t("ذخیرهٔ تغییرات", "Save changes")}
                </Button>
                <select
                  aria-label={t("وضعیت گردش کار", "Workflow status")}
                  value={task.status}
                  onChange={(event) =>
                    void action(
                      "task_update",
                      { task_id: task.task_id, status: event.target.value },
                      task.revision,
                    )
                  }
                >
                  {WORKFLOW_STATUSES.map((value) => (
                    <option key={value}>{value}</option>
                  ))}
                </select>
                <Button
                  variant="danger"
                  type="button"
                  onClick={() => {
                    void action(
                      task.archived_at ? "task_restore" : "task_archive",
                      { task_id: task.task_id },
                      task.revision,
                    ).then((result) => {
                      if (result) onClose();
                    });
                  }}
                >
                  {task.archived_at
                    ? t("بازیابی کار", "Restore task")
                    : t("انتقال به بایگانی", "Archive task")}
                </Button>
                <Button
                  type="button"
                  onClick={() =>
                    void action("task_template_create", {
                      title: `${t("الگو", "Template")}: ${task.title}`,
                      root_task_id: task.task_id,
                    })
                  }
                >
                  {t(
                    "ساخت الگو از این ساختار",
                    "Save this structure as a template",
                  )}
                </Button>
              </div>
            </form>
          )}
          {tab === "checklists" && <Checklists task={task} action={action} />}
          {tab === "subtasks" && (
            <>
              <div className="section-heading">
                <p>
                  {task.children_progress.done}/{task.children_progress.total}{" "}
                  {t("زیرکار تکمیل شده", "subtasks complete")}
                </p>
                <AddButton onClick={() => setChild(true)}>
                  {t("زیرکار تازه", "New subtask")}
                </AddButton>
              </div>
              <Progress
                label={t(
                  `پیشرفت زیرکارهای ${task.title}`,
                  `Subtask progress for ${task.title}`,
                )}
                value={task.children_progress.done}
                max={task.children_progress.total}
              />
              {task.subtasks?.map((item) => (
                <TaskRow
                  key={item.task_id}
                  task={item}
                  onOpen={onOpen}
                  onAction={action}
                />
              ))}
              {!task.subtasks?.length && (
                <Empty
                  title={t(
                    "کار را به قدم‌های کوچک‌تر تقسیم کن",
                    "Break this into smaller steps",
                  )}
                />
              )}
              <CreateTask
                open={child}
                setOpen={setChild}
                action={action}
                parentId={task.task_id}
                projectId={task.project_id ?? undefined}
              />
              <form
                className="form-grid"
                onSubmit={(event) => {
                  event.preventDefault();
                  const parent = new FormData(event.currentTarget).get(
                    "parent_task_id",
                  );
                  void getPreview("subtask_reparent_preview", {
                    task_id: task.task_id,
                    parent_task_id: parent || null,
                  });
                }}
              >
                <Field
                  label={t(
                    "جابجایی این کار در سلسله‌مراتب",
                    "Move this task in the hierarchy",
                  )}
                >
                  <select
                    name="parent_task_id"
                    defaultValue={task.parent_task_id ?? ""}
                  >
                    <option value="">
                      {t(
                        "کار مستقل (بدون والد)",
                        "Independent task (no parent)",
                      )}
                    </option>
                    {candidates.data?.items
                      .filter((item) => item.task_id !== task.task_id)
                      .map((item) => (
                        <option key={item.task_id} value={item.task_id}>
                          {item.title}
                        </option>
                      ))}
                  </select>
                </Field>
                <Button type="submit">
                  {t("پیش‌نمایش تغییر والد", "Preview parent change")}
                </Button>
              </form>
            </>
          )}
          {tab === "dependencies" && (
            <>
              <div className="dependency-builder">
                <Field
                  label={t(
                    "جست‌وجوی کار در همهٔ پروژه‌ها",
                    "Search tasks across projects",
                  )}
                >
                  <input
                    value={candidateSearch}
                    onChange={(event) => setCandidateSearch(event.target.value)}
                    placeholder={t(
                      "جست‌وجوی پیش‌نیاز…",
                      "Search prerequisites…",
                    )}
                  />
                </Field>
                <Field
                  label={t(
                    "پیش‌نیازها را انتخاب کن (یک یا چند کار)",
                    "Choose one or more prerequisite tasks",
                  )}
                >
                  <select
                    multiple
                    size={5}
                    value={selectedPrerequisites}
                    onChange={(event) =>
                      setSelectedPrerequisites(
                        Array.from(
                          event.target.selectedOptions,
                          (option) => option.value,
                        ),
                      )
                    }
                  >
                    {candidates.data?.items
                      .filter((item) => item.task_id !== task.task_id)
                      .map((item) => (
                        <option key={item.task_id} value={item.task_id}>
                          {item.title}
                        </option>
                      ))}
                  </select>
                </Field>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = new FormData(event.currentTarget);
                    void getPreview("task_dependency_add_preview", {
                      task_id: task.task_id,
                      prerequisites: selectedPrerequisites.map((task_id) => ({
                        task_id,
                        mode: form.get("mode"),
                      })),
                      operator: form.get("operator"),
                    });
                  }}
                >
                  <div className="form-columns">
                    <Field label={t("شرط گروه", "Group rule")}>
                      <select name="operator">
                        <option value="ALL">
                          ALL · {t("همه باید تکمیل شوند", "All must complete")}
                        </option>
                        <option value="ANY">
                          ANY · {t("یکی کافی است", "Any one is enough")}
                        </option>
                      </select>
                    </Field>
                    <Field label={t("نوع رابطه", "Link mode")}>
                      <select name="mode">
                        <option value="hard">
                          {t("پیش‌نیاز الزامی", "Hard prerequisite")}
                        </option>
                        <option value="soft">
                          {t("رابطهٔ اطلاع‌رسانی", "Soft information link")}
                        </option>
                      </select>
                    </Field>
                  </div>
                  <Button
                    type="submit"
                    disabled={!selectedPrerequisites.length}
                  >
                    {t("پیش‌نمایش وابستگی", "Preview dependency")}
                  </Button>
                </form>
              </div>
              {task.prerequisites.map((edge) => (
                <div className="dependency-row" key={edge.edge_id}>
                  <GitBranch size={16} />
                  <button
                    className="task-title"
                    onClick={() => onOpen(edge.prerequisite_task_id)}
                  >
                    {edge.title}
                  </button>
                  <span className="chip">{edge.operator}</span>
                  <span className="muted small">
                    {edge.mode} · {edge.status}
                  </span>
                  {edge.waived_at ? (
                    <span className="chip">{t("معاف شده", "Waived")}</span>
                  ) : (
                    <>
                      <Button onClick={() => setWaiver(edge.edge_id)}>
                        {t("معافیت با دلیل", "Waive with a reason")}
                      </Button>
                      <Button
                        onClick={() =>
                          void getPreview("task_dependency_remove_preview", {
                            task_id: task.task_id,
                            edge_id: edge.edge_id,
                          })
                        }
                      >
                        <Trash2 size={14} />
                        {t("حذف رابطه", "Remove link")}
                      </Button>
                    </>
                  )}
                </div>
              ))}
              {!task.prerequisites.length && (
                <Empty
                  title={t("این کار پیش‌نیازی ندارد", "No prerequisites yet")}
                />
              )}
            </>
          )}
          {tab === "unblocks" && (
            <>
              {task.unblocks.map((id) => (
                <button
                  className="dependency-row"
                  key={id}
                  onClick={() => onOpen(id)}
                >
                  <GitBranch size={16} />
                  {candidates.data?.items.find((item) => item.task_id === id)
                    ?.title ?? id}
                </button>
              ))}
              {!task.unblocks.length && (
                <Empty
                  title={t(
                    "هنوز کار وابسته‌ای ندارد",
                    "No downstream tasks yet",
                  )}
                />
              )}
              <Button
                onClick={async () => {
                  try {
                    const impact = await query(
                      "task_completion_impact_preview",
                      { task_id: task.task_id },
                    );
                    window.dispatchEvent(
                      new CustomEvent("lifeos:preview", { detail: impact }),
                    );
                  } catch (error) {
                    window.dispatchEvent(
                      new CustomEvent("lifeos:error", {
                        detail: String(error),
                      }),
                    );
                  }
                }}
              >
                {t("پیش‌نمایش اثر تکمیل", "Preview completion impact")}
              </Button>
            </>
          )}
          {tab === "files" && (
            <>
              {task.files?.map((file) => (
                <div className="dependency-row" key={file.file_id}>
                  <FileText size={18} />
                  <span>{file.title}</span>
                  <span className="chip">{file.state}</span>
                  {file.external_url && (
                    <a
                      href={file.external_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("بازکردن منبع", "Open source")}
                    </a>
                  )}
                </div>
              ))}
              {!task.files?.length && (
                <Empty
                  title={t("فایلی پیوند داده نشده", "No linked files")}
                  detail={t(
                    "از بخش فایل‌ها، فایل را به این کار پیوند بده.",
                    "Link a file from the Files section.",
                  )}
                />
              )}
            </>
          )}
          {tab === "history" && (
            <div className="activity-list">
              {task.activity?.map((event) => (
                <div key={event.event_id}>
                  <span className="activity-dot" />
                  <div>
                    <strong>{event.event_type}</strong>
                    <small>
                      {event.channel} · {event.reason}
                    </small>
                  </div>
                  <time>{new Date(event.occurred_at).toLocaleString()}</time>
                </div>
              ))}
              {!task.activity?.length && (
                <Empty title={t("رویدادی ثبت نشده", "No activity yet")} />
              )}
            </div>
          )}
          {tab === "discussion" && (
            <TaskDiscussion task={task} action={action} />
          )}
        </>
      )}
      <Modal
        title={t("پیش‌نمایش تغییر", "Review change")}
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
              <p key={warning} className="warning">
                {warning}
              </p>
            ))}
            <Button
              variant="primary"
              onClick={async () => {
                const result = await action(
                  preview.command,
                  { preview_id: preview.preview_id },
                  task?.revision,
                );
                if (result) setPreview(null);
              }}
            >
              {t("تأیید و اعمال تغییر", "Confirm and apply")}
            </Button>
          </>
        )}
      </Modal>
      <Modal
        title={t("معافیت از پیش‌نیاز", "Waive a prerequisite")}
        open={!!waiver}
        onOpenChange={(value) => {
          if (!value) setWaiver(null);
        }}
      >
        <form
          className="form-grid"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void getPreview("task_dependency_waive_preview", {
              task_id: task?.task_id,
              edge_id: waiver,
              reason: form.get("reason"),
              explicit_user_intent: true,
            }).then(() => setWaiver(null));
          }}
        >
          <p className="warning">
            {t(
              "لغو شدن یک پیش‌نیاز به معنی موفقیت آن نیست. معافیت انتخاب صریح شماست و با دلیل در تاریخچه ثبت می‌شود.",
              "A cancelled prerequisite is not a successful prerequisite. A waiver is your explicit decision and its reason is recorded.",
            )}
          </p>
          <Field label={t("دلیل معافیت", "Reason for waiver")}>
            <textarea name="reason" required minLength={3} />
          </Field>
          <label className="check-label">
            <input type="checkbox" required />
            {t(
              "من معافیت این پیش‌نیاز را انتخاب می‌کنم.",
              "I explicitly choose to waive this prerequisite.",
            )}
          </label>
          <Button type="submit">
            {t("بررسی و پیش‌نمایش معافیت", "Review waiver preview")}
          </Button>
        </form>
      </Modal>
    </Modal>
  );
}

function TaskDiscussion({ task, action }: { task: TaskDTO; action: Action }) {
  const { t } = useLocale();
  const comments = useQuery<
    PageDTO<{ comment_id: string; body: string; created_at: string }>
  >("task_comment_list", { task_id: task.task_id });
  const tags = useQuery<PageDTO<{ tag_id: string; title: string }>>("tag_list");
  return (
    <div className="form-grid">
      <div className="form-actions">
        {task.tags?.map((tag) => (
          <Button
            key={tag.tag_id}
            variant="quiet"
            onClick={() =>
              void action(
                "task_tag_unlink",
                { task_id: task.task_id, tag_id: tag.tag_id },
                task.revision,
              )
            }
          >
            {tag.title} ×
          </Button>
        ))}
      </div>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const tag_id = new FormData(event.currentTarget).get("tag_id");
          await action(
            "task_tag_link",
            { task_id: task.task_id, tag_id },
            task.revision,
          );
        }}
      >
        <select name="tag_id" required>
          <option value="">{t("برچسب موجود…", "Existing tag…")}</option>
          {tags.data?.items.map((tag) => (
            <option key={tag.tag_id} value={tag.tag_id}>
              {tag.title}
            </option>
          ))}
        </select>
        <Button type="submit">{t("پیوند برچسب", "Link tag")}</Button>
      </form>
      <form
        className="inline-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const result = await action("tag_create", {
            title: new FormData(form).get("title"),
          });
          if (result) form.reset();
        }}
      >
        <input
          name="title"
          required
          placeholder={t("برچسب تازه…", "New tag…")}
        />
        <Button type="submit">{t("ساخت برچسب", "Create tag")}</Button>
      </form>
      <QueryState {...comments} retry={comments.refresh} />
      {comments.data?.items.map((comment) => (
        <article key={comment.comment_id} className="comment-card">
          <p>{comment.body}</p>
          <time>{new Date(comment.created_at).toLocaleString()}</time>
        </article>
      ))}
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const result = await action(
            "task_comment_add",
            { task_id: task.task_id, body: new FormData(form).get("body") },
            task.revision,
          );
          if (result) form.reset();
        }}
      >
        <Field
          label={t("یک یادداشت در گفتگو اضافه کن", "Add a discussion note")}
        >
          <textarea name="body" required rows={3} />
        </Field>
        <Button variant="primary" type="submit">
          {t("ثبت یادداشت", "Post note")}
        </Button>
      </form>
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const instant = new FormData(form).get("remind_at");
          try {
            const result = await action(
              "reminder_create",
              {
                task_id: task.task_id,
                remind_at: instant
                  ? zonedLocalToInstant(String(instant), "Europe/Berlin")
                  : null,
              },
              task.revision,
            );
            if (result) form.reset();
          } catch (error) {
            window.dispatchEvent(
              new CustomEvent("lifeos:error", { detail: String(error) }),
            );
          }
        }}
      >
        <Field
          label={t(
            "زمان یادآوری (Europe/Berlin)",
            "Reminder time (Europe/Berlin)",
          )}
        >
          <input name="remind_at" required type="datetime-local" />
        </Field>
        <Button type="submit">{t("ثبت یادآور", "Save reminder")}</Button>
        <p className="muted small">
          {t(
            "تحویل اعلان تنها با زمان‌بند و مجوز واقعی ممکن است.",
            "Notification delivery requires an actual scheduler and permission.",
          )}
        </p>
      </form>
    </div>
  );
}

function Checklists({ task, action }: { task: TaskDTO; action: Action }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState<{
    kind: "list" | "item";
    id: string;
    title: string;
    notes: string;
    revision: number;
  } | null>(null);
  const [promotion, setPromotion] = useState<ChecklistItemDTO | null>(null);
  const lists = useQuery<ChecklistDTO[]>("task_checklist_get", {
    task_id: task.task_id,
  });
  async function addList(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = new FormData(form).get("title");
    const result = await action(
      "task_checklist_create",
      { task_id: task.task_id, title },
      task.revision,
    );
    if (result) form.reset();
  }
  return (
    <>
      <form className="inline-form" onSubmit={addList}>
        <input
          name="title"
          required
          placeholder={t("نام چک‌لیست تازه…", "Name a new checklist…")}
        />
        <Button type="submit">
          <Plus size={16} />
          {t("ساخت چک‌لیست", "Create checklist")}
        </Button>
      </form>
      <QueryState {...lists} retry={lists.refresh} />
      {lists.data
        ?.filter((list) => !list.archived_at)
        .map((list) => (
          <div className="checklist" key={list.checklist_id}>
            <header>
              <button
                className="checklist-edit-title"
                onClick={() =>
                  setEditing({
                    kind: "list",
                    id: list.checklist_id,
                    title: list.title,
                    notes: "",
                    revision: list.revision,
                  })
                }
                aria-label={`${t("ویرایش چک‌لیست", "Edit checklist")} ${list.title}`}
              >
                {list.title}
              </button>
              <span>
                {
                  list.items.filter((item) => !item.archived_at && item.checked)
                    .length
                }
                /{list.items.filter((item) => !item.archived_at).length}
              </span>
              <Button
                variant="quiet"
                aria-label={t(
                  "کپی چک‌لیست با آیتم‌های انجام‌نشده",
                  "Duplicate checklist with unchecked items",
                )}
                title={t(
                  "کپی چک‌لیست با آیتم‌های انجام‌نشده",
                  "Duplicate checklist with unchecked items",
                )}
                onClick={() =>
                  void action(
                    "task_checklist_duplicate",
                    {
                      checklist_id: list.checklist_id,
                      preserve_checked: false,
                    },
                    list.revision,
                  )
                }
              >
                <Copy size={14} />
              </Button>
              <Button
                variant="quiet"
                onClick={() =>
                  void action(
                    "task_checklist_archive",
                    { checklist_id: list.checklist_id },
                    list.revision,
                  )
                }
                aria-label={t("بایگانی چک‌لیست", "Archive checklist")}
              >
                <Trash2 size={14} />
              </Button>
            </header>
            {list.items
              .filter((item) => !item.archived_at)
              .map((item, index, items) => (
                <div className="checklist-item" key={item.item_id}>
                  <input
                    type="checkbox"
                    checked={item.checked}
                    onChange={() =>
                      void action(
                        item.checked
                          ? "task_checklist_item_uncheck"
                          : "task_checklist_item_check",
                        { item_id: item.item_id },
                        item.revision,
                      )
                    }
                    aria-label={item.title}
                  />
                  <button
                    className={`checklist-edit-item ${item.checked ? "checked" : ""}`}
                    onClick={() =>
                      setEditing({
                        kind: "item",
                        id: item.item_id,
                        title: item.title,
                        notes: item.notes,
                        revision: item.revision,
                      })
                    }
                    aria-label={`${t("ویرایش آیتم", "Edit item")} ${item.title}`}
                  >
                    {item.title}
                    {item.notes && <small>{item.notes}</small>}
                  </button>
                  <Button
                    variant="quiet"
                    disabled={index === 0}
                    aria-label={t("بالا بردن", "Move up")}
                    onClick={() => {
                      const ids = items.map((value) => value.item_id);
                      [ids[index - 1], ids[index]] = [
                        ids[index],
                        ids[index - 1],
                      ];
                      void action(
                        "task_checklist_item_reorder",
                        { checklist_id: list.checklist_id, item_ids: ids },
                        list.revision,
                      );
                    }}
                  >
                    <ArrowUp size={13} />
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={index === items.length - 1}
                    aria-label={t("پایین بردن", "Move down")}
                    onClick={() => {
                      const ids = items.map((value) => value.item_id);
                      [ids[index], ids[index + 1]] = [
                        ids[index + 1],
                        ids[index],
                      ];
                      void action(
                        "task_checklist_item_reorder",
                        { checklist_id: list.checklist_id, item_ids: ids },
                        list.revision,
                      );
                    }}
                  >
                    <ArrowDown size={13} />
                  </Button>
                  {!item.promoted_task_id && (
                    <Button
                      variant="quiet"
                      onClick={() => setPromotion(item)}
                      title={t(
                        "تبدیل به زیرکار با نگه‌داشتن مرجع",
                        "Promote to subtask and retain reference",
                      )}
                    >
                      <ListTree size={14} />
                    </Button>
                  )}
                  <Button
                    variant="quiet"
                    onClick={() =>
                      void action(
                        "task_checklist_item_archive",
                        { item_id: item.item_id },
                        item.revision,
                      )
                    }
                    aria-label={t("بایگانی آیتم", "Archive item")}
                  >
                    <Trash2 size={13} />
                  </Button>
                </div>
              ))}
            <form
              className="inline-form"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const result = await action(
                  "task_checklist_item_add",
                  {
                    checklist_id: list.checklist_id,
                    title: new FormData(form).get("title"),
                  },
                  list.revision,
                );
                if (result) form.reset();
              }}
            >
              <input
                required
                name="title"
                placeholder={t("افزودن یک قدم…", "Add a step…")}
              />
              <Button
                type="submit"
                aria-label={t("افزودن آیتم", "Add checklist item")}
              >
                <Plus size={15} />
              </Button>
            </form>
            {list.items.some((item) => item.archived_at) && (
              <details className="small muted">
                <summary>{t("آیتم‌های بایگانی‌شده", "Archived items")}</summary>
                {list.items
                  .filter((item) => item.archived_at)
                  .map((item) => (
                    <div className="dependency-row" key={item.item_id}>
                      {item.title}
                      <Button
                        onClick={() =>
                          void action(
                            "task_checklist_item_restore",
                            { item_id: item.item_id },
                            item.revision,
                          )
                        }
                      >
                        {t("بازیابی", "Restore")}
                      </Button>
                    </div>
                  ))}
              </details>
            )}
          </div>
        ))}
      {lists.data
        ?.filter((list) => list.archived_at)
        .map((list) => (
          <div className="dependency-row" key={list.checklist_id}>
            {list.title}
            <Button
              onClick={() =>
                void action(
                  "task_checklist_restore",
                  { checklist_id: list.checklist_id },
                  list.revision,
                )
              }
            >
              {t("بازیابی چک‌لیست", "Restore checklist")}
            </Button>
          </div>
        ))}
      <Modal
        title={t("ویرایش چک‌لیست یا آیتم", "Edit checklist or item")}
        open={!!editing}
        onOpenChange={(value) => {
          if (!value) setEditing(null);
        }}
      >
        {editing && (
          <form
            className="form-grid"
            key={editing.id}
            onSubmit={async (event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              const result = await action(
                editing.kind === "list"
                  ? "task_checklist_update"
                  : "task_checklist_item_update",
                {
                  [editing.kind === "list" ? "checklist_id" : "item_id"]:
                    editing.id,
                  title: form.get("title"),
                  ...(editing.kind === "item"
                    ? { notes: form.get("notes") }
                    : {}),
                },
                editing.revision,
              );
              if (result) setEditing(null);
            }}
          >
            <Field label={t("عنوان", "Title")}>
              <input name="title" required defaultValue={editing.title} />
            </Field>
            {editing.kind === "item" && (
              <Field label={t("توضیح", "Notes")}>
                <textarea name="notes" defaultValue={editing.notes} />
              </Field>
            )}
            <Button variant="primary" type="submit">
              {t("ذخیره", "Save")}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        title={t(
          "تبدیل به یک زیرکار مستقل",
          "Promote to an independent subtask",
        )}
        open={!!promotion}
        onOpenChange={(value) => {
          if (!value) setPromotion(null);
        }}
      >
        {promotion && (
          <>
            <p>{promotion.title}</p>
            <p className="muted small">
              {t(
                "کار تازه شناسه و وضعیت مستقل دارد. دربارهٔ آیتم اصلی انتخاب کن:",
                "The new task has its own identity and status. Choose what happens to the original item:",
              )}
            </p>
            <div className="form-grid">
              <Button
                onClick={async () => {
                  const result = await action(
                    "task_checklist_item_promote",
                    { item_id: promotion.item_id, original: "keep_reference" },
                    promotion.revision,
                  );
                  if (result) setPromotion(null);
                }}
              >
                {t(
                  "تبدیل و نگه‌داشتن مرجع آیتم",
                  "Promote and retain a linked reference",
                )}
              </Button>
              <Button
                onClick={async () => {
                  const result = await action(
                    "task_checklist_item_promote",
                    { item_id: promotion.item_id, original: "archive" },
                    promotion.revision,
                  );
                  if (result) setPromotion(null);
                }}
              >
                {t(
                  "تبدیل و بایگانی آیتم اصلی",
                  "Promote and archive the original item",
                )}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </>
  );
}
