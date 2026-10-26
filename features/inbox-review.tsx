"use client";

import { useState } from "react";
import type {
  CommandName,
  MutationResult,
  ProjectDTO,
  TaskDTO,
} from "@/shared/contracts";
import { clearQueryCache, usePagedQuery, useQuery } from "./api";
import { useLocale } from "./locale";
import { Button, Field, QueryState } from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

export function InboxReview({
  action,
  onOpen,
}: {
  action: Action;
  onOpen: (taskId: string) => void;
}) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [reviewedIds, setReviewedIds] = useState<string[]>([]);
  const [pinnedTask, setPinnedTask] = useState<TaskDTO | null>(null);
  const inbox = usePagedQuery<TaskDTO>(
    "task_search",
    { status: "Inbox" },
    open,
  );
  const projects = usePagedQuery<ProjectDTO>("project_list", {}, open);
  const latestTask = useQuery<TaskDTO>(
    "task_get",
    { task_id: pinnedTask?.task_id ?? "" },
    open && !!pinnedTask,
  );
  const reviewed = new Set(reviewedIds);
  const tasks = inbox.data?.items ?? [];
  const current = pinnedTask
    ? (latestTask.data ?? pinnedTask)
    : tasks.find((task) => !reviewed.has(task.task_id));
  function next(taskId: string) {
    setReviewedIds((ids) => (ids.includes(taskId) ? ids : [...ids, taskId]));
    if (pinnedTask?.task_id === taskId) setPinnedTask(null);
  }
  return (
    <section
      className="panel inbox-review"
      aria-label={t("مرور صندوق ورودی", "Inbox review")}
    >
      <div className="inbox-review-heading">
        <div>
          <h2>{t("مرور صندوق ورودی", "Inbox review")}</h2>
          <p className="muted small">
            {t(
              "هر بار یک کار را روشن کن. ردشدن از کار چیزی را تغییر نمی‌دهد.",
              "Clarify one task at a time. Skipping changes nothing.",
            )}
          </p>
        </div>
        <Button onClick={() => setOpen((value) => !value)}>
          {open
            ? t("بستن مرور", "Close review")
            : t("شروع مرور", "Start review")}
        </Button>
      </div>
      {open && (
        <div className="inbox-review-body">
          <QueryState {...inbox} retry={inbox.refresh} />
          <QueryState {...projects} retry={projects.refresh} />
          {pinnedTask && (
            <QueryState
              {...latestTask}
              retry={() => {
                clearQueryCache();
                latestTask.refresh();
              }}
            />
          )}
          {inbox.data && (
            <p className="small muted">
              {Math.min(reviewedIds.length, tasks.length)} / {tasks.length}{" "}
              {t("کار بررسی‌شده در این دور", "tasks reviewed this round")}
            </p>
          )}
          {current && (
            <InboxReviewForm
              key={current.task_id}
              task={current}
              projects={projects.data?.items ?? []}
              action={action}
              onOpen={onOpen}
              onDraftChange={(snapshot) =>
                setPinnedTask((existing) =>
                  existing?.task_id === snapshot.task_id ? existing : snapshot,
                )
              }
              onSaved={() => {
                next(current.task_id);
                inbox.refresh();
              }}
              onSkip={() => next(current.task_id)}
              waitingForLatest={
                !!pinnedTask && (latestTask.fetching || !!latestTask.error)
              }
              onRefresh={(snapshot) => {
                setPinnedTask(snapshot);
                clearQueryCache();
                inbox.refresh();
                latestTask.refresh();
              }}
            />
          )}
          {inbox.data && !current && (
            <div className="inbox-review-finished">
              <strong>
                {tasks.length === 0
                  ? t("صندوق ورودی خالی است", "Inbox is empty")
                  : t("این دور مرور تمام شد", "This review round is complete")}
              </strong>
              {tasks.length > 0 && (
                <Button onClick={() => setReviewedIds([])}>
                  {t("مرور دوباره", "Review again")}
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function InboxReviewForm({
  task,
  projects,
  action,
  onOpen,
  onDraftChange,
  onSaved,
  onSkip,
  waitingForLatest,
  onRefresh,
}: {
  task: TaskDTO;
  projects: ProjectDTO[];
  action: Action;
  onOpen: (taskId: string) => void;
  onDraftChange: (snapshot: TaskDTO) => void;
  onSaved: () => void;
  onSkip: () => void;
  waitingForLatest: boolean;
  onRefresh: (snapshot: TaskDTO) => void;
}) {
  const { t } = useLocale();
  const [baseRevision, setBaseRevision] = useState(task.revision);
  const [draft, setDraft] = useState({
    next_action: task.next_action,
    priority: task.priority,
    project_id: task.project_id ?? "",
    status: task.status,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const changedElsewhere = task.revision !== baseRevision;
  const currentProject = projects.find(
    (item) => item.project_id === draft.project_id,
  );
  const grouped = new Map<string, ProjectDTO[]>();
  for (const project of projects.filter((item) => !item.archived_at)) {
    const area = project.area.trim();
    const group = grouped.get(area) ?? [];
    group.push(project);
    grouped.set(area, group);
  }
  function loadLatest() {
    setDraft({
      next_action: task.next_action,
      priority: task.priority,
      project_id: task.project_id ?? "",
      status: task.status,
    });
    setBaseRevision(task.revision);
    setError("");
  }
  function updateDraft(patch: Partial<typeof draft>) {
    onDraftChange(task);
    setDraft((current) => ({ ...current, ...patch }));
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || changedElsewhere || waitingForLatest) return;
    const changes: Record<string, unknown> = { task_id: task.task_id };
    if (draft.next_action !== task.next_action)
      changes.next_action = draft.next_action;
    if (draft.priority !== task.priority) changes.priority = draft.priority;
    if (draft.project_id !== (task.project_id ?? ""))
      changes.project_id = draft.project_id || null;
    if (draft.status !== task.status) changes.status = draft.status;
    if (Object.keys(changes).length === 1) {
      onSkip();
      return;
    }
    setError("");
    setSaving(true);
    try {
      const result = await action("task_update", changes, baseRevision);
      if (result) onSaved();
      else {
        setError(
          t(
            "ذخیره تأیید نشد. پیش‌نویس تو باقی است؛ وضعیت تازه را بررسی کن.",
            "Save was not confirmed. Your draft remains; review the latest state.",
          ),
        );
        onRefresh(task);
      }
    } finally {
      setSaving(false);
    }
  }
  return (
    <form className="inbox-review-form" onSubmit={(event) => void save(event)}>
      <div className="inbox-review-task">
        <span className="chip">{task.status}</span>
        <button type="button" onClick={() => onOpen(task.task_id)}>
          {task.title}
        </button>
      </div>
      {task.status !== "Inbox" && (
        <p className="warning" role="status">
          {t(
            "این کار دیگر در صندوق ورودی نیست؛ پیش‌نویس تو تا تصمیم خودت در اینجا مانده است.",
            "This task has left Inbox; your draft stays here until you decide what to do.",
          )}
        </p>
      )}
      {changedElsewhere && (
        <div className="warning" role="alert">
          {t(
            "این کار در جای دیگری تغییر کرده است. برای ادامه نسخهٔ تازه را ببین؛ پیش‌نویس فعلی تا آن زمان حفظ می‌شود.",
            "This task changed elsewhere. Review the latest version before saving; your current draft stays here.",
          )}
          <Button type="button" onClick={loadLatest}>
            {t("بارگذاری نسخهٔ تازه", "Load latest version")}
          </Button>
        </div>
      )}
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <Field label={t("اقدام بعدی", "Next action")}>
        <input
          value={draft.next_action}
          onChange={(event) => updateDraft({ next_action: event.target.value })}
          placeholder={t(
            "اختیاری؛ فقط چیزی که می‌دانی",
            "Optional; enter only what you know",
          )}
        />
      </Field>
      <div className="form-columns">
        <Field label={t("اولویت", "Priority")}>
          <select
            value={draft.priority}
            onChange={(event) =>
              updateDraft({
                priority: event.target.value as TaskDTO["priority"],
              })
            }
          >
            <option value="Low">{t("کم", "Low")}</option>
            <option value="Normal">{t("عادی", "Normal")}</option>
            <option value="High">{t("زیاد", "High")}</option>
            <option value="Urgent">{t("فوری", "Urgent")}</option>
          </select>
        </Field>
        <Field label={t("وضعیت", "Workflow status")}>
          <select
            value={draft.status}
            onChange={(event) =>
              updateDraft({ status: event.target.value as TaskDTO["status"] })
            }
          >
            <option value="Inbox">Inbox</option>
            <option value="Next">Next</option>
            <option value="Waiting">Waiting</option>
            {!["Inbox", "Next", "Waiting"].includes(draft.status) && (
              <option value={draft.status}>{draft.status}</option>
            )}
          </select>
        </Field>
      </div>
      <Field label={t("پروژه و حوزهٔ موجود", "Existing project and area")}>
        <select
          value={draft.project_id}
          onChange={(event) => updateDraft({ project_id: event.target.value })}
        >
          <option value="">{t("بدون پروژه", "No project")}</option>
          {draft.project_id &&
            !projects.some((item) => item.project_id === draft.project_id) && (
              <option value={draft.project_id}>
                {t("پروژهٔ فعلی", "Current project")}
              </option>
            )}
          {[...grouped.entries()].map(([area, items]) => (
            <optgroup key={area} label={area || t("بدون حوزه", "Unassigned")}>
              {items.map((project) => (
                <option key={project.project_id} value={project.project_id}>
                  {project.title}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </Field>
      {currentProject && (
        <p className="small muted">
          {t("حوزهٔ پروژه", "Project area")}:{" "}
          {currentProject.area || t("بدون حوزه", "Unassigned")}
        </p>
      )}
      <div className="form-actions">
        <Button
          type="submit"
          variant="primary"
          disabled={saving || changedElsewhere || waitingForLatest}
        >
          {saving
            ? t("در حال ذخیره…", "Saving…")
            : t("ذخیره و کار بعدی", "Save and next")}
        </Button>
        <Button type="button" disabled={saving} onClick={onSkip}>
          {t("رد شدن بدون تغییر", "Skip without changes")}
        </Button>
      </div>
    </form>
  );
}
