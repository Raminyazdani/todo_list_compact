"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown, ChevronLeft, Folder } from "lucide-react";
import type {
  CommandName,
  MutationResult,
  PageDTO,
  ProjectDTO,
  TaskDTO,
} from "@/shared/contracts";
import { clearQueryCache, useQuery } from "./api";
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

export function ProjectWorkspace({
  action,
  onOpen,
  knowledge,
}: {
  action: Action;
  onOpen: (id: string) => void;
  knowledge: (id: string) => React.ReactNode;
}) {
  const { t, language } = useLocale();
  const [archived, setArchived] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [taskCursor, setTaskCursor] = useState<string | null>(null);
  const params = useSearchParams();
  const linkedProjectId = params.get("project");
  const [selected, setSelected] = useState<string | null>(
    () => linkedProjectId,
  );
  const [create, setCreate] = useState(false);
  const [edit, setEdit] = useState(false);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [areaFilter, setAreaFilter] = useState("");
  const [areaSaving, setAreaSaving] = useState(false);
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const projects = useQuery<PageDTO<ProjectDTO>>("project_list", {
    limit: 100,
    cursor,
    ...(archived ? { include_archived: true, archived_only: true } : {}),
  });
  const project = useQuery<ProjectDTO>(
    "project_get",
    { project_id: selected },
    !!selected,
  );
  const tasks = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    { project_id: selected, limit: 100, cursor: taskCursor },
    !!selected,
  );
  const milestones = useQuery<PageDTO<Record<string, unknown>>>(
    "project_milestone_list",
    { project_id: selected, limit: 100 },
    !!selected,
  );
  function pick(id: string) {
    setSelected(id);
    setTaskCursor(null);
    setEdit(false);
    setArchiveConfirm(false);
  }
  const areaGroups = new Map<string, ProjectDTO[]>();
  for (const item of projects.data?.items ?? []) {
    const area = item.area.trim();
    const group = areaGroups.get(area) ?? [];
    group.push(item);
    areaGroups.set(area, group);
  }
  const areaNames = [...areaGroups.keys()].sort((a, b) =>
    a.localeCompare(b, language === "fa" ? "fa" : "en"),
  );
  const savedCollapsed = preferences.data?.settings.project_area_collapsed;
  const collapsedAreas = new Set(
    Array.isArray(savedCollapsed)
      ? savedCollapsed.filter(
          (area): area is string => typeof area === "string",
        )
      : [],
  );
  async function saveCollapsedAreas(next: Set<string>) {
    if (!preferences.data || preferences.fetching || areaSaving) return;
    setAreaSaving(true);
    try {
      const result = await action(
        "preferences_update",
        { settings: { project_area_collapsed: [...next] } },
        preferences.data.revision,
      );
      if (!result) clearQueryCache();
      preferences.refresh();
    } finally {
      setAreaSaving(false);
    }
  }
  function toggleArea(area: string) {
    const next = new Set(collapsedAreas);
    if (next.has(area)) next.delete(area);
    else next.add(area);
    void saveCollapsedAreas(next);
  }
  function setAllAreas(collapsed: boolean) {
    const next = new Set(collapsedAreas);
    for (const area of areaNames) {
      if (collapsed) next.add(area);
      else next.delete(area);
    }
    void saveCollapsedAreas(next);
  }
  const current = project.data;
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
      <div className="tabs">
        <button
          className={!archived ? "active" : ""}
          onClick={() => {
            setArchived(false);
            setCursor(null);
            setAreaFilter("");
          }}
        >
          {t("فعال", "Active")}
        </button>
        <button
          className={archived ? "active" : ""}
          onClick={() => {
            setArchived(true);
            setCursor(null);
            setAreaFilter("");
          }}
        >
          {t("بایگانی", "Archived")}
        </button>
      </div>
      <QueryState {...projects} retry={projects.refresh} />
      {projects.data && projects.data.items.length > 0 && (
        <div className="project-area-controls">
          <Field label={t("نمایش حوزه", "Show area")}>
            <select
              value={areaFilter}
              onChange={(event) => setAreaFilter(event.target.value)}
            >
              <option value="">
                {t("همهٔ حوزه‌های این صفحه", "All areas on this page")}
              </option>
              {areaFilter && !areaGroups.has(areaFilter) && (
                <option value={areaFilter}>{areaFilter} (0)</option>
              )}
              {areaNames.map((area) => (
                <option key={area} value={area}>
                  {area || t("بدون حوزه", "Unassigned")} (
                  {areaGroups.get(area)?.length ?? 0})
                </option>
              ))}
            </select>
          </Field>
          <span className="small muted">
            {t(
              "گروه‌بندی فقط پروژه‌های این صفحه",
              "Grouping covers projects on this page",
            )}
          </span>
          <div className="form-actions">
            <Button
              disabled={!preferences.data || preferences.fetching || areaSaving}
              onClick={() => setAllAreas(true)}
            >
              {t("بستن همهٔ حوزه‌ها", "Collapse all areas")}
            </Button>
            <Button
              disabled={!preferences.data || preferences.fetching || areaSaving}
              onClick={() => setAllAreas(false)}
            >
              {t("بازکردن همهٔ حوزه‌ها", "Expand all areas")}
            </Button>
          </div>
        </div>
      )}
      <QueryState {...preferences} retry={preferences.refresh} />
      {areaNames
        .filter((area) => !areaFilter || area === areaFilter)
        .map((area) => {
          const items = areaGroups.get(area) ?? [];
          const collapsed = collapsedAreas.has(area);
          return (
            <section className="project-area" key={area}>
              <div className="project-area-heading">
                <button
                  className="project-area-toggle"
                  aria-expanded={!collapsed}
                  aria-controls={`project-area-${area.length}-${encodeURIComponent(area)}`}
                  disabled={
                    !preferences.data || preferences.fetching || areaSaving
                  }
                  onClick={() => toggleArea(area)}
                >
                  {collapsed ? (
                    <ChevronLeft size={17} />
                  ) : (
                    <ChevronDown size={17} />
                  )}
                  <span>{area || t("بدون حوزه", "Unassigned")}</span>
                  <span className="chip">{items.length}</span>
                </button>
              </div>
              <div
                className="project-grid"
                id={`project-area-${area.length}-${encodeURIComponent(area)}`}
                hidden={collapsed}
              >
                {items.map((item) => (
                  <button
                    key={item.project_id}
                    className="project-card"
                    onClick={() => pick(item.project_id)}
                  >
                    <div className="project-icon">
                      <Folder size={20} />
                    </div>
                    <span className="chip">
                      {item.area || t("بدون حوزه", "Unassigned")}
                    </span>
                    <h2>{item.title}</h2>
                    <p>
                      {item.notes ||
                        t(
                          "جزئیات پروژه را باز کن",
                          "Open the project workspace",
                        )}
                    </p>
                    <Progress
                      value={item.done ?? 0}
                      max={item.total ?? 0}
                      label={t(
                        `پیشرفت پروژهٔ ${item.title}`,
                        `Progress for ${item.title}`,
                      )}
                    />
                    <footer>
                      <span>
                        {item.done ?? 0}/{item.total ?? 0} {t("کار", "tasks")}
                      </span>
                      <span>
                        {item.blocked ?? 0} {t("مسدود", "blocked")}
                      </span>
                    </footer>
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      {projects.data && areaFilter && !areaGroups.has(areaFilter) && (
        <Empty
          title={t(
            "این حوزه در صفحهٔ فعلی پروژه‌ای ندارد",
            "No projects in this area on the current page",
          )}
        />
      )}
      {projects.data && !projects.data.items.length && (
        <Empty
          title={t("پروژه‌ای در این بخش نیست", "No projects in this section")}
        />
      )}
      <div className="form-actions">
        <span className="small muted">
          {projects.data?.items.length ?? 0} / {projects.data?.total ?? "—"}{" "}
          {t("پروژه در این صفحه", "projects on this page")}
        </span>
        {cursor && (
          <Button
            onClick={() => {
              setCursor(null);
              setAreaFilter("");
            }}
          >
            {t("صفحهٔ اول", "First page")}
          </Button>
        )}
        {projects.data?.next_cursor && (
          <Button
            onClick={() => {
              setCursor(projects.data!.next_cursor);
              setAreaFilter("");
            }}
          >
            {t("صفحهٔ بعد", "Next page")}
          </Button>
        )}
      </div>
      <Modal
        title={t("پروژهٔ تازه", "New project")}
        open={create}
        onOpenChange={setCreate}
      >
        <ProjectForm
          onSubmit={async (input) => {
            if (await action("project_create", input)) setCreate(false);
          }}
        />
      </Modal>
      <Modal
        title={current?.title ?? t("پروژه", "Project")}
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        wide
      >
        <QueryState {...project} retry={project.refresh} />
        {current && (
          <>
            <div className="form-actions">
              <Button onClick={() => setEdit(!edit)}>
                {t("ویرایش پروژه", "Edit project")}
              </Button>
              <Button onClick={() => setArchiveConfirm(true)}>
                {current.archived_at
                  ? t("بازیابی پروژه", "Restore project")
                  : t("بایگانی پروژه", "Archive project")}
              </Button>
              <span className="chip">{current.status}</span>
              {current.due_date && <time>{current.due_date}</time>}
            </div>
            {edit ? (
              <ProjectForm
                key={`${current.project_id}:${current.revision}`}
                project={current}
                onSubmit={async (input) => {
                  if (
                    await action(
                      "project_update",
                      { project_id: current.project_id, ...input },
                      current.revision,
                    )
                  ) {
                    setEdit(false);
                    project.refresh();
                  }
                }}
              />
            ) : (
              <p className="muted">{current.notes}</p>
            )}
            <SectionHeading title={t("کارهای پروژه", "Project tasks")} />
            <nav
              className="form-actions"
              aria-label={t("نماهای کارهای پروژه", "Project task views")}
            >
              {[
                ["list", t("فهرست پروژه", "Project backlog")],
                ["tree", t("درخت پروژه", "Project tree")],
                ["board", t("برد پروژه", "Project board")],
                ["timeline", t("زمان‌بندی پروژه", "Project timeline")],
                ["graph", t("گراف پروژه", "Project graph")],
              ].map(([view, label]) => (
                <Link
                  className="button"
                  key={view}
                  href={`/tasks?project_id=${encodeURIComponent(current.project_id)}&view=${view}`}
                >
                  {label}
                </Link>
              ))}
            </nav>
            <QueryState {...tasks} retry={tasks.refresh} />
            {tasks.data?.items.map((task) => (
              <TaskRow
                key={task.task_id}
                task={task}
                onOpen={onOpen}
                onAction={action}
              />
            ))}
            {tasks.data && !tasks.data.items.length && (
              <Empty
                title={t(
                  "کاری به پروژه وصل نشده",
                  "No tasks are linked to this project",
                )}
              />
            )}
            <div className="form-actions">
              <span className="small muted">
                {tasks.data?.items.length ?? 0} / {tasks.data?.total ?? "—"}{" "}
                {t("کار در این صفحه", "tasks on this page")}
              </span>
              {taskCursor && (
                <Button onClick={() => setTaskCursor(null)}>
                  {t("صفحهٔ اول", "First page")}
                </Button>
              )}
              {tasks.data?.next_cursor && (
                <Button onClick={() => setTaskCursor(tasks.data!.next_cursor)}>
                  {t("صفحهٔ بعد", "Next page")}
                </Button>
              )}
            </div>
            <SectionHeading title={t("نقاط عطف", "Milestones")} />
            <QueryState {...milestones} retry={milestones.refresh} />
            {milestones.data?.items.map((item) => (
              <div key={String(item.milestone_id)} className="dependency-row">
                <strong>{String(item.title)}</strong>
                <time>{String(item.due_date ?? "")}</time>
              </div>
            ))}
            {milestones.data?.next_cursor && (
              <p className="warning">
                {t(
                  "۱۰۰ نقطهٔ عطف نخست نمایش داده می‌شود.",
                  "The first 100 milestones are displayed.",
                )}
              </p>
            )}
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                const form = event.currentTarget;
                const values = new FormData(form);
                if (
                  await action(
                    "project_milestone_create",
                    {
                      project_id: current.project_id,
                      title: values.get("title"),
                      due_date: values.get("due_date") || null,
                    },
                    current.revision,
                  )
                )
                  form.reset();
              }}
            >
              <div className="form-columns">
                <Field label={t("عنوان نقطهٔ عطف", "Milestone title")}>
                  <input required name="title" />
                </Field>
                <Field label={t("مهلت نقطهٔ عطف", "Milestone deadline")}>
                  <input name="due_date" type="date" required />
                </Field>
              </div>
              <Button type="submit">
                {t("افزودن نقطهٔ عطف", "Add milestone")}
              </Button>
            </form>
            {knowledge(current.project_id)}
          </>
        )}
        <Modal
          title={
            current?.archived_at
              ? t("بازیابی پروژه", "Restore project")
              : t("بایگانی پروژه", "Archive project")
          }
          open={archiveConfirm}
          onOpenChange={setArchiveConfirm}
        >
          <p>
            {t(
              "وضعیت خود پروژه تغییر می‌کند؛ کارها، وابستگی‌ها و فایل‌های آن مستقل باقی می‌مانند.",
              "This changes the project itself; its tasks, dependencies and files keep their independent state.",
            )}
          </p>
          <Button
            variant="primary"
            onClick={async () => {
              if (
                current &&
                (await action(
                  current.archived_at ? "project_restore" : "project_archive",
                  { project_id: current.project_id },
                  current.revision,
                ))
              ) {
                setArchiveConfirm(false);
                setSelected(null);
                projects.refresh();
              }
            }}
          >
            {t("تأیید تغییر پروژه", "Confirm project change")}
          </Button>
        </Modal>
      </Modal>
    </>
  );
}

function ProjectForm({
  project,
  onSubmit,
}: {
  project?: ProjectDTO;
  onSubmit: (input: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useLocale();
  return (
    <form
      className="form-grid"
      onSubmit={async (event) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        await onSubmit({
          title: values.get("title"),
          notes: values.get("notes"),
          area: values.get("area"),
          due_date: values.get("due_date") || null,
          ...(project ? { status: values.get("status") } : {}),
        });
      }}
    >
      <Field label={t("عنوان", "Title")}>
        <input name="title" required defaultValue={project?.title ?? ""} />
      </Field>
      <Field label={t("حوزه", "Area")}>
        <input name="area" defaultValue={project?.area ?? ""} />
      </Field>
      <Field label={t("مهلت", "Due date")}>
        <input
          type="date"
          name="due_date"
          defaultValue={project?.due_date ?? ""}
        />
      </Field>
      {project && (
        <Field label={t("وضعیت پروژه", "Project status")}>
          <input name="status" required defaultValue={project.status} />
        </Field>
      )}
      <Field label={t("توضیح", "Notes")}>
        <textarea name="notes" defaultValue={project?.notes ?? ""} />
      </Field>
      <Button variant="primary" type="submit">
        {project
          ? t("ذخیرهٔ پروژه", "Save project")
          : t("ساخت پروژه", "Create project")}
      </Button>
    </form>
  );
}
