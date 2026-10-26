"use client";

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Circle, CircleCheck, Pencil, RotateCcw } from "lucide-react";
import type { ProjectDTO, TaskDTO } from "@/shared/contracts";
import {
  getTaskRowField,
  type TaskRowFieldId,
  type TaskRowLayout,
} from "@/shared/task-row-fields";
import { instantToLocalDateTime } from "@/shared/datetime";
import { Button, Field } from "@/components/ui";
import { clearQueryCache, command, query } from "./api";
import { useLabels, useLocale } from "./locale";
import {
  TaskRowController,
  fieldDraftValue,
  rowDraftKey,
  type RowDraft,
  type TaskRowMutation,
} from "./task-row-controller";

const DraftContext = createContext<TaskRowController | null>(null);
interface RowEnvironment {
  layout: TaskRowLayout;
  projects: ProjectDTO[];
  onOpen: (taskId: string) => void;
}
const LayoutContext = createContext<RowEnvironment | null>(null);
export function useTaskRows() {
  return useContext(LayoutContext);
}
export function useRowController() {
  const controller = useContext(DraftContext);
  if (!controller) throw new Error("Task row draft provider is missing.");
  return controller;
}
function useRowSnapshot() {
  const controller = useRowController();
  return useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
}
export function hasUnsavedRowDraft(draft: RowDraft) {
  if (draft.state === "saved") return false;
  return (
    [
      "queued",
      "pending",
      "unconfirmed",
      "conflict",
      "error",
      "blocked",
    ].includes(draft.state) ||
    draft.value !== fieldDraftValue(draft.base, draft.field) ||
    draft.timezone !== draft.base.timezone
  );
}

export function TaskRowDraftProvider(props: {
  mutate: TaskRowMutation;
  children: ReactNode;
}) {
  const existing = useContext(DraftContext);
  return existing ? (
    <TaskRowMutationBridge controller={existing} mutate={props.mutate}>
      {props.children}
    </TaskRowMutationBridge>
  ) : (
    <IsolatedTaskRowDraftProvider {...props} />
  );
}

function TaskRowMutationBridge({
  controller,
  mutate,
  children,
}: {
  controller: TaskRowController;
  mutate: TaskRowMutation;
  children: ReactNode;
}) {
  useEffect(() => {
    controller.setMutation(mutate);
    return () => controller.setMutation(command);
  }, [controller, mutate]);
  return <>{children}</>;
}

function IsolatedTaskRowDraftProvider({
  mutate,
  children,
}: {
  mutate: TaskRowMutation;
  children: ReactNode;
}) {
  const [controller] = useState(
    () =>
      new TaskRowController(mutate, async (taskId) => {
        clearQueryCache();
        return query<TaskDTO>("task_get", { task_id: taskId });
      }),
  );
  const mutationRef = useRef(mutate);
  useEffect(() => {
    if (mutationRef.current !== mutate) controller.setMutation(mutate);
    mutationRef.current = mutate;
  }, [controller, mutate]);
  useEffect(() => {
    controller.activate();
    const acknowledge = (event: Event) => {
      const detail = (
        event as CustomEvent<
          Parameters<TaskRowController["acknowledgeBlocked"]>[0]
        >
      ).detail;
      if (
        detail &&
        typeof detail.taskId === "string" &&
        typeof detail.status === "string" &&
        Number.isInteger(detail.revision)
      )
        controller.acknowledgeBlocked(detail);
    };
    window.addEventListener("lifeos:blocked-task-ack", acknowledge);
    return () => {
      window.removeEventListener("lifeos:blocked-task-ack", acknowledge);
      controller.dispose();
    };
  }, [controller]);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const dirty = Object.values(snapshot.drafts).some(hasUnsavedRowDraft);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const leave = (event: MouseEvent) => {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link = (event.target as Element).closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (!link || link.target === "_blank" || link.hasAttribute("download"))
        return;
      const target = new URL(link.href, window.location.href);
      if (
        target.origin === location.origin &&
        target.pathname === location.pathname
      )
        return;
      if (
        !window.confirm(
          "پیش‌نویس ردیف ذخیره نشده است. از این صفحه خارج می‌شوی؟ / Leave with unsaved row drafts?",
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", leave, true);
    };
  }, [dirty]);
  return (
    <DraftContext.Provider value={controller}>{children}</DraftContext.Provider>
  );
}

export function TaskRowLayoutProvider({
  layout,
  projects,
  tasks,
  onOpen,
  children,
}: RowEnvironment & { tasks: TaskDTO[]; children: ReactNode }) {
  const controller = useRowController();
  useEffect(() => {
    controller.observe(tasks);
  }, [controller, tasks]);
  return (
    <LayoutContext.Provider value={{ layout, projects, onOpen }}>
      {children}
    </LayoutContext.Provider>
  );
}

function optionLabel(
  field: TaskRowFieldId,
  value: string,
  labels: ReturnType<typeof useLabels>,
  language: "fa" | "en",
) {
  if (field === "priority")
    return labels.priority[value as keyof typeof labels.priority] ?? value;
  if (field === "status")
    return labels.statuses[value as keyof typeof labels.statuses] ?? value;
  if (field === "category" && language === "fa")
    return (
      (
        {
          Study: "تحصیل",
          Research: "پژوهش",
          Work: "کار",
          Admin: "اداری",
          Personal: "شخصی",
          Other: "سایر",
        } as Record<string, string>
      )[value] ?? value
    );
  return value;
}
function displayField(
  task: TaskDTO,
  field: TaskRowFieldId,
  environment: RowEnvironment,
  labels: ReturnType<typeof useLabels>,
  language: "fa" | "en",
) {
  const t = (fa: string, en: string) => (language === "fa" ? fa : en);
  if (field === "priority" || field === "status" || field === "category")
    return optionLabel(field, String(task[field]), labels, language);
  if (field === "project_id")
    return (
      environment.projects.find(
        (project) => project.project_id === task.project_id,
      )?.title ??
      task.project_id ??
      t("بدون پروژه", "No project")
    );
  if (field === "readiness") return labels.readiness[task.readiness];
  if (field === "checklist_progress")
    return `${task.checklist_progress.checked}/${task.checklist_progress.total}`;
  if (field === "children_progress")
    return `${task.children_progress.done}/${task.children_progress.total}`;
  if (field === "blocker_count") return String(task.blocked_by.length);
  if (field === "prerequisites") return String(task.prerequisites.length);
  if (field === "unblocks") return String(task.unblocks.length);
  if (field === "started_at_risk")
    return task.started_at_risk ? t("نیازمند توجه", "At risk") : t("خیر", "No");
  if (field === "due_at")
    return task.due_at
      ? `${instantToLocalDateTime(task.due_at, task.timezone).replace("T", " ")} · ${task.timezone}`
      : "";
  const raw = task[field as keyof TaskDTO];
  if (getTaskRowField(field).kind === "timestamp" && typeof raw === "string") {
    try {
      return new Date(raw).toLocaleString(
        language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
        { timeZone: task.timezone },
      );
    } catch {
      return raw;
    }
  }
  return raw == null ? "" : String(raw);
}

export function CustomizedTaskRow({
  task: incoming,
  selected,
  onSelect,
}: {
  task: TaskDTO;
  selected?: boolean;
  onSelect?: () => void;
}) {
  const environment = useTaskRows()!;
  const controller = useRowController();
  const snapshot = useRowSnapshot();
  const task =
    snapshot.tasks[incoming.task_id]?.revision > incoming.revision
      ? snapshot.tasks[incoming.task_id]
      : incoming;
  const { t } = useLocale();
  const rowRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(
    () => () => {
      if (rowRef.current?.contains(document.activeElement))
        queueMicrotask(() =>
          document
            .querySelector<HTMLElement>('[data-testid="row-settings-button"]')
            ?.focus(),
        );
    },
    [],
  );
  const statusDraft = snapshot.drafts[rowDraftKey(task.task_id, "status")];
  return (
    <div
      ref={rowRef}
      className={`task-row task-row-custom ${task.status === "Done" ? "completed" : ""}`}
      data-task-row={task.task_id}
    >
      <div className="task-row-heading">
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
          disabled={
            !!statusDraft &&
            ["pending", "queued", "unconfirmed"].includes(statusDraft.state)
          }
          onClick={() => controller.toggleCompletion(task)}
        >
          {task.archived_at ? (
            <RotateCcw size={19} />
          ) : task.status === "Done" ? (
            <CircleCheck size={19} />
          ) : (
            <Circle size={19} />
          )}
        </button>
        <button
          className="task-title"
          data-task-id={task.task_id}
          onClick={() => environment.onOpen(task.task_id)}
        >
          <span>{task.title}</span>
        </button>
        {environment.layout.fields.find((field) => field.id === "title")
          ?.mode === "edit" && <RowField task={task} field="title" />}
      </div>
      <div className="task-row-fields">
        {environment.layout.fields
          .filter((entry) => entry.id !== "title" && entry.mode !== "hidden")
          .map((entry) => (
            <RowField key={entry.id} task={task} field={entry.id} />
          ))}
      </div>
    </div>
  );
}

function RowField({ task, field }: { task: TaskDTO; field: TaskRowFieldId }) {
  const environment = useTaskRows()!;
  const controller = useRowController();
  const snapshot = useRowSnapshot();
  const { t, language } = useLocale();
  const labels = useLabels();
  const definition = getTaskRowField(field);
  const label = definition.label[language];
  const mode = environment.layout.fields.find(
    (entry) => entry.id === field,
  )?.mode;
  const value = displayField(task, field, environment, labels, language);
  const draft = snapshot.drafts[rowDraftKey(task.task_id, field)];
  const derivedLink = [
    "readiness",
    "checklist_progress",
    "children_progress",
    "blocker_count",
    "parent_task_id",
    "prerequisites",
    "unblocks",
  ].includes(field);
  return (
    <div className={`row-field row-field-${field}`} data-row-field={field}>
      {mode === "edit" && definition.editable ? (
        <button
          type="button"
          className={`row-field-trigger ${field === "priority" ? `row-priority-${task.priority.toLowerCase()}` : ""}`}
          aria-label={`${t("ویرایش", "Edit")} ${label}`}
          aria-expanded={!!draft?.editing}
          onClick={() => controller.open(task, field)}
        >
          <span className="row-field-label">{label}</span>
          <span className="row-field-value">
            {field === "title" ? (
              <Pencil size={13} />
            ) : (
              value || t("افزودن…", "Add…")
            )}
          </span>
        </button>
      ) : derivedLink ? (
        <button
          className="row-field-trigger read-only"
          type="button"
          onClick={() =>
            environment.onOpen(
              field === "parent_task_id" && task.parent_task_id
                ? task.parent_task_id
                : task.task_id,
            )
          }
          title={definition.readonlyReason?.[language]}
        >
          <span className="row-field-label">{label}</span>
          <span className="row-field-value">{value || "—"}</span>
        </button>
      ) : (
        <span className="row-field-display">
          <span className="row-field-label">{label}</span>
          <span className="row-field-value">{value || "—"}</span>
        </span>
      )}
      {draft && <RowSaveStatus draft={draft} />}
      {draft?.editing && (
        <TaskFieldEditor draft={draft} projects={environment.projects} />
      )}
    </div>
  );
}

export function RowSaveStatus({ draft }: { draft: RowDraft }) {
  const { t } = useLocale();
  const names = {
    draft: t("پیش‌نویس", "Draft"),
    queued: t("در صف ذخیره", "Queued"),
    pending: t("در حال ذخیره…", "Saving…"),
    saved: t("ذخیره شد", "Saved"),
    error: t("خطای ذخیره", "Save failed"),
    conflict: t("تعارض؛ انتخاب لازم است", "Conflict; choose a value"),
    unconfirmed: t("نتیجهٔ ذخیره نامعلوم است", "Save is unconfirmed"),
    blocked: t("تأیید پیش‌نیاز لازم است", "Prerequisite confirmation required"),
  };
  return (
    <span
      className={`row-save-status row-save-${draft.state}`}
      data-save-state={draft.state}
      role="status"
    >
      {draft.errorCode === "SUBTASKS_INCOMPLETE"
        ? t(
            "زیرکارهای ناتمام؛ ابتدا آن‌ها را انجام بده",
            "Unfinished subtasks; complete them first",
          )
        : names[draft.state]}
    </span>
  );
}

export function TaskFieldEditor({
  draft,
  projects,
  dock = false,
  onClose,
}: {
  draft: RowDraft;
  projects: ProjectDTO[];
  dock?: boolean;
  onClose?: () => void;
}) {
  const controller = useRowController();
  const { t, language } = useLocale();
  const labels = useLabels();
  const definition = getTaskRowField(draft.field);
  const label = definition.label[language];
  const field = draft.field;
  const busy = ["pending", "queued", "unconfirmed"].includes(draft.state);
  const locked = draft.state === "conflict" || draft.state === "unconfirmed";
  const editorRef = useRef<HTMLFormElement>(null);
  const timezoneListId = useId();
  const returnFocus = () =>
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(
          `[data-task-row="${CSS.escape(draft.taskId)}"] [data-row-field="${field}"] button`,
        )
        ?.focus(),
    );
  const close = () => {
    controller.hide(draft.key);
    onClose?.();
    returnFocus();
  };
  useEffect(() => {
    const element = editorRef.current?.querySelector<HTMLElement>(
      "input,select,textarea",
    );
    element?.focus();
  }, [draft.key, dock]);
  const editValue = (value: string, immediate = false) => {
    controller.edit(draft.key, { value });
    if (immediate) controller.save(draft.key);
  };
  const input =
    field === "project_id" ? (
      <select
        name={field}
        aria-label={label}
        value={draft.value}
        disabled={locked}
        onChange={(event) => editValue(event.target.value, true)}
      >
        <option value="">{t("بدون پروژه", "No project")}</option>
        {draft.value &&
          !projects.some((project) => project.project_id === draft.value) && (
            <option value={draft.value}>{draft.value}</option>
          )}
        {projects.map((project) => (
          <option value={project.project_id} key={project.project_id}>
            {project.title}
            {project.archived_at ? t(" (بایگانی)", " (archived)") : ""}
          </option>
        ))}
      </select>
    ) : definition.kind === "choice" ? (
      <select
        name={field}
        aria-label={label}
        value={draft.value}
        disabled={locked}
        onChange={(event) => editValue(event.target.value, true)}
      >
        {definition.validation?.options?.map((option) => (
          <option key={option} value={option}>
            {optionLabel(field, option, labels, language)}
          </option>
        ))}
      </select>
    ) : definition.kind === "multiline" ? (
      <textarea
        name={field}
        aria-label={label}
        rows={4}
        maxLength={10000}
        value={draft.value}
        disabled={locked}
        onChange={(event) => editValue(event.target.value)}
      />
    ) : field === "timezone" ? null : (
      <input
        name={field}
        aria-label={label}
        type={
          definition.kind === "date"
            ? "date"
            : definition.kind === "datetime"
              ? "datetime-local"
              : definition.kind === "number"
                ? "number"
                : "text"
        }
        step={
          definition.kind === "datetime"
            ? 1
            : definition.kind === "number"
              ? 1
              : undefined
        }
        min={definition.kind === "number" ? 0 : undefined}
        maxLength={field === "title" ? 2000 : 10000}
        required={field === "title"}
        value={draft.value}
        disabled={locked}
        onChange={(event) => editValue(event.target.value)}
      />
    );
  return (
    <form
      ref={editorRef}
      className="task-field-editor"
      data-testid="task-field-editor"
      data-draft-key={draft.key}
      aria-label={`${t("ویرایش", "Edit")} ${label}`}
      onSubmit={(event) => {
        event.preventDefault();
        controller.save(draft.key);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (!busy) controller.discard(draft.key);
          close();
        }
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
          event.preventDefault();
          controller.save(draft.key);
        }
      }}
    >
      {input && <Field label={label}>{input}</Field>}
      {(field === "due_at" || field === "timezone") && (
        <>
          <Field label={t("منطقهٔ زمانی", "Time zone")}>
            <input
              aria-label={t("منطقهٔ زمانی", "Time zone")}
              name="timezone"
              required
              value={draft.timezone}
              disabled={locked}
              onChange={(event) =>
                controller.edit(draft.key, {
                  timezone: event.target.value,
                  ...(field === "timezone"
                    ? { value: event.target.value }
                    : {}),
                })
              }
              list={timezoneListId}
            />
          </Field>
          <datalist id={timezoneListId}>
            <option value="Europe/Berlin" />
            <option value="Asia/Tehran" />
            <option value="UTC" />
          </datalist>
          {field === "due_at" && (
            <Field label={t("ساعت تکراری پاییز", "Repeated autumn time")}>
              <select
                name="disambiguation"
                aria-label={t("ساعت تکراری پاییز", "Repeated autumn time")}
                value={draft.disambiguation}
                disabled={locked}
                onChange={(event) =>
                  controller.edit(draft.key, {
                    disambiguation: event.target
                      .value as RowDraft["disambiguation"],
                  })
                }
              >
                <option value="reject">
                  {t(
                    "انتخاب برای ساعت مبهم لازم است",
                    "Require a choice for ambiguous time",
                  )}
                </option>
                <option value="earlier">
                  {t("بار اول", "First occurrence")}
                </option>
                <option value="later">
                  {t("بار دوم", "Second occurrence")}
                </option>
              </select>
            </Field>
          )}
          <p className="small muted">
            {t(
              "تغییر فقط منطقهٔ زمانی، لحظهٔ مهلت را حفظ می‌کند. موعد روزانه مستقل می‌ماند.",
              "Changing only the zone preserves the deadline instant. The due date stays independent.",
            )}
          </p>
        </>
      )}
      {draft.error && (
        <p role="alert" className="row-editor-error">
          {draft.error}
        </p>
      )}
      {draft.state === "conflict" && (
        <div className="row-conflict">
          <strong>{t("مقدار تازهٔ سرور", "Latest server value")}</strong>
          <p>
            {draft.server
              ? fieldDraftValue(draft.server, field) || "—"
              : t("در حال دریافت…", "Loading…")}
          </p>
          <strong>{t("پیش‌نویس من", "My draft")}</strong>
          <p>{draft.value || "—"}</p>
          <Button
            type="button"
            disabled={!draft.server}
            onClick={() => {
              controller.useServer(draft.key);
              onClose?.();
            }}
          >
            {t("استفاده از مقدار سرور", "Use server value")}
          </Button>
          <Button
            type="button"
            disabled={!draft.server}
            onClick={() => controller.applyDraft(draft.key)}
          >
            {t("ثبت پیش‌نویس من", "Apply my draft")}
          </Button>
          <Button
            type="button"
            onClick={() => void controller.refreshConflict(draft.key)}
          >
            {t("دریافت دوبارهٔ مقدار سرور", "Refresh server value")}
          </Button>
        </div>
      )}
      <div className="row-editor-actions">
        {draft.state === "unconfirmed" ? (
          <Button
            type="button"
            onClick={() => void controller.recover(draft.key)}
          >
            {t("بررسی دوبارهٔ همین ذخیره", "Recover this save")}
          </Button>
        ) : (
          <Button
            variant="primary"
            type="submit"
            disabled={busy || draft.state === "conflict"}
          >
            {t("ثبت", "Save")}
          </Button>
        )}
        <Button type="button" onClick={close}>
          {t("بستن و نگه‌داشتن پیش‌نویس", "Close and keep draft")}
        </Button>
        {!busy && (
          <Button
            type="button"
            onClick={() => {
              controller.discard(draft.key);
              onClose?.();
              returnFocus();
            }}
          >
            {t("لغو", "Cancel")}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Remains mounted even when the edited row leaves a filter, page or tree branch. */
export function TaskRowDraftShelf({ projects }: { projects: ProjectDTO[] }) {
  const controller = useRowController();
  const snapshot = useRowSnapshot();
  const { t, language } = useLocale();
  const [dockKey, setDockKey] = useState<string | null>(null);
  const previous = useRef(snapshot.drafts);
  useEffect(() => {
    for (const [key, draft] of Object.entries(snapshot.drafts)) {
      if (draft.state === "saved" && previous.current[key]?.state !== "saved") {
        const row = document.querySelector<HTMLElement>(
          `[data-task-row="${CSS.escape(draft.taskId)}"]`,
        );
        const trigger =
          row?.querySelector<HTMLElement>(
            `[data-row-field="${draft.field}"] button`,
          ) ??
          row?.querySelector<HTMLElement>(".task-title") ??
          document.querySelector<HTMLElement>(
            '[data-testid="row-settings-button"]',
          );
        if (
          previous.current[key]?.editing &&
          (!document.activeElement ||
            document.activeElement === document.body ||
            document.activeElement
              .closest(".task-field-editor")
              ?.getAttribute("data-draft-key") === key)
        )
          trigger?.focus();
      }
    }
    previous.current = snapshot.drafts;
  }, [snapshot.drafts]);
  const unsaved = Object.values(snapshot.drafts).filter(hasUnsavedRowDraft);
  const dock = dockKey ? snapshot.drafts[dockKey] : undefined;
  return (
    <>
      <div className="row-save-announcement visually-hidden" aria-live="polite">
        {Object.values(snapshot.drafts)
          .filter((draft) => draft.state === "saved")
          .map((draft) => `${draft.title}: ${t("ذخیره شد", "Saved")}`)
          .join(". ")}
      </div>
      {unsaved.length > 0 && (
        <section
          className="task-row-drafts"
          aria-label={t("پیش‌نویس‌های ردیف‌ها", "Row drafts")}
        >
          <strong>
            {t("پیش‌نویس‌ها و ذخیره‌های در انتظار", "Drafts and pending saves")}{" "}
            · {unsaved.length}
          </strong>
          <p className="small muted">
            {t(
              "تغییر نما یا فیلتر، این پیش‌نویس‌ها را حذف نمی‌کند. برای ادامه روی مورد بزن.",
              "Changing this view or filter keeps these drafts. Select one to continue.",
            )}
          </p>
          <div className="row-draft-list">
            {unsaved.map((draft) => (
              <button
                type="button"
                key={draft.key}
                onClick={() => {
                  controller.hide(draft.key);
                  setDockKey(draft.key);
                }}
              >
                <span>
                  {draft.title} · {getTaskRowField(draft.field).label[language]}
                </span>
                <RowSaveStatus draft={draft} />
              </button>
            ))}
          </div>
          {dock && dock.state !== "saved" && (
            <TaskFieldEditor
              draft={dock}
              projects={projects}
              dock
              onClose={() => setDockKey(null)}
            />
          )}
        </section>
      )}
    </>
  );
}
