/** Browser-safe field policy. Layout preferences never grant task permissions. */
export type TaskRowFieldMode = "hidden" | "display" | "edit";
export type TaskRowView = "list" | "tree";
type Label = { fa: string; en: string };
export interface TaskRowFieldDefinition {
  id: string;
  label: Label;
  kind:
    | "text"
    | "multiline"
    | "choice"
    | "date"
    | "datetime"
    | "timezone"
    | "number"
    | "derived"
    | "relation"
    | "timestamp"
    | "identifier";
  editable: boolean;
  clearable: boolean;
  fixed?: boolean;
  validation?: {
    required?: boolean;
    integer?: boolean;
    min?: number;
    options?: readonly string[];
  };
  readonlyReason?: Label;
}

const derivedReason: Label = {
  fa: "از وضعیت و روابط کار محاسبه می‌شود.",
  en: "Calculated from task state and relationships.",
};
const relationshipReason: Label = {
  fa: "رابطه را از بخش مربوط و با پیش‌نمایش تغییر دهید.",
  en: "Change relationships through their preview and commit editor.",
};
const serverReason: Label = {
  fa: "این مقدار را سرور مدیریت می‌کند.",
  en: "Managed by the server.",
};

export const TASK_ROW_FIELDS = [
  {
    id: "title",
    label: { fa: "عنوان", en: "Title" },
    kind: "text",
    editable: true,
    clearable: false,
    fixed: true,
    validation: { required: true },
  },
  {
    id: "priority",
    label: { fa: "اولویت", en: "Priority" },
    kind: "choice",
    editable: true,
    clearable: false,
    validation: { options: ["Low", "Normal", "High", "Urgent"] },
  },
  {
    id: "status",
    label: { fa: "وضعیت", en: "Status" },
    kind: "choice",
    editable: true,
    clearable: false,
    validation: {
      options: ["Inbox", "Next", "In progress", "Waiting", "Done", "Cancelled"],
    },
  },
  {
    id: "project_id",
    label: { fa: "پروژه", en: "Project" },
    kind: "relation",
    editable: true,
    clearable: true,
  },
  {
    id: "category",
    label: { fa: "دسته", en: "Category" },
    kind: "choice",
    editable: true,
    clearable: false,
    validation: {
      options: ["Study", "Research", "Work", "Admin", "Personal", "Other"],
    },
  },
  {
    id: "start_date",
    label: { fa: "تاریخ شروع", en: "Start date" },
    kind: "date",
    editable: true,
    clearable: true,
  },
  {
    id: "due_date",
    label: { fa: "موعد روزانه", en: "Due date" },
    kind: "date",
    editable: true,
    clearable: true,
  },
  {
    id: "due_at",
    label: { fa: "موعد دقیق", en: "Exact deadline" },
    kind: "datetime",
    editable: true,
    clearable: true,
  },
  {
    id: "timezone",
    label: { fa: "منطقهٔ زمانی", en: "Time zone" },
    kind: "timezone",
    editable: true,
    clearable: false,
  },
  {
    id: "estimated_minutes",
    label: { fa: "برآورد دقیقه", en: "Estimated minutes" },
    kind: "number",
    editable: true,
    clearable: true,
    validation: { integer: true, min: 0 },
  },
  {
    id: "next_action",
    label: { fa: "قدم بعدی", en: "Next action" },
    kind: "text",
    editable: true,
    clearable: true,
  },
  {
    id: "waiting_for",
    label: { fa: "منتظرِ", en: "Waiting for" },
    kind: "text",
    editable: true,
    clearable: true,
  },
  {
    id: "notes",
    label: { fa: "توضیحات", en: "Notes" },
    kind: "multiline",
    editable: true,
    clearable: true,
  },
  {
    id: "source_reference",
    label: { fa: "مرجع منبع", en: "Source reference" },
    kind: "multiline",
    editable: true,
    clearable: true,
  },
  {
    id: "readiness",
    label: { fa: "آمادگی", en: "Readiness" },
    kind: "derived",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "checklist_progress",
    label: { fa: "پیشرفت چک‌لیست", en: "Checklist progress" },
    kind: "derived",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "children_progress",
    label: { fa: "پیشرفت زیرکارها", en: "Subtask progress" },
    kind: "derived",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "blocker_count",
    label: { fa: "شمار مسدودکننده‌ها", en: "Blocker count" },
    kind: "derived",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "parent_task_id",
    label: { fa: "کار والد", en: "Parent task" },
    kind: "relation",
    editable: false,
    clearable: false,
    readonlyReason: relationshipReason,
  },
  {
    id: "prerequisites",
    label: { fa: "پیش‌نیازها", en: "Prerequisites" },
    kind: "relation",
    editable: false,
    clearable: false,
    readonlyReason: relationshipReason,
  },
  {
    id: "created_at",
    label: { fa: "زمان ایجاد", en: "Created at" },
    kind: "timestamp",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "updated_at",
    label: { fa: "آخرین تغییر", en: "Updated at" },
    kind: "timestamp",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "completed_at",
    label: { fa: "زمان تکمیل", en: "Completed at" },
    kind: "timestamp",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "closed_at",
    label: { fa: "زمان بسته‌شدن", en: "Closed at" },
    kind: "timestamp",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "archived_at",
    label: { fa: "زمان بایگانی", en: "Archived at" },
    kind: "timestamp",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "task_id",
    label: { fa: "شناسهٔ کار", en: "Task ID" },
    kind: "identifier",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "revision",
    label: { fa: "نسخه", en: "Revision" },
    kind: "number",
    editable: false,
    clearable: false,
    readonlyReason: serverReason,
  },
  {
    id: "earliest_allowed_start",
    label: { fa: "زودترین شروع مجاز", en: "Earliest allowed start" },
    kind: "date",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "started_at_risk",
    label: { fa: "شروع در معرض ریسک", en: "Started at risk" },
    kind: "derived",
    editable: false,
    clearable: false,
    readonlyReason: derivedReason,
  },
  {
    id: "unblocks",
    label: { fa: "کارهای آزادشونده", en: "Unblocks" },
    kind: "relation",
    editable: false,
    clearable: false,
    readonlyReason: relationshipReason,
  },
] as const satisfies readonly TaskRowFieldDefinition[];

export type TaskRowFieldId = (typeof TASK_ROW_FIELDS)[number]["id"];
export interface TaskRowLayout {
  schema_version: 1;
  fields: { id: TaskRowFieldId; mode: TaskRowFieldMode }[];
}
export type TaskRowLayouts = Partial<Record<TaskRowView, TaskRowLayout>>;
const definitions = new Map<string, TaskRowFieldDefinition>(
  TASK_ROW_FIELDS.map((field) => [field.id, field]),
);
export function getTaskRowField(id: TaskRowFieldId): TaskRowFieldDefinition {
  return definitions.get(id)!;
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

/** Strict write validation; omitted optional fields are hidden, even for []. */
export function parseTaskRowLayout(value: unknown): TaskRowLayout {
  if (
    !record(value) ||
    !exactKeys(value, ["schema_version", "fields"]) ||
    value.schema_version !== 1 ||
    !Array.isArray(value.fields) ||
    value.fields.length > TASK_ROW_FIELDS.length
  )
    throw new Error("Invalid task row layout schema.");
  const seen = new Set<string>();
  const fields: TaskRowLayout["fields"] = value.fields.map((entry: unknown) => {
    if (
      !record(entry) ||
      !exactKeys(entry, ["id", "mode"]) ||
      typeof entry.id !== "string" ||
      typeof entry.mode !== "string"
    )
      throw new Error("Invalid task row field.");
    const definition = definitions.get(entry.id);
    if (
      !definition ||
      seen.has(entry.id) ||
      !["hidden", "display", "edit"].includes(entry.mode) ||
      (entry.mode === "edit" && !definition.editable) ||
      (entry.id === "title" && entry.mode === "hidden")
    )
      throw new Error("Unknown, repeated or unsupported task row field mode.");
    seen.add(entry.id);
    return {
      id: entry.id as TaskRowFieldId,
      mode: entry.mode as TaskRowFieldMode,
    };
  });
  const title = fields.find((field) => field.id === "title") ?? {
    id: "title" as const,
    mode: "display" as const,
  };
  return {
    schema_version: 1,
    fields: [title, ...fields.filter((field) => field.id !== "title")],
  };
}

const defaultLayout: TaskRowLayout = {
  schema_version: 1,
  fields: [
    { id: "title", mode: "display" },
    { id: "next_action", mode: "display" },
    { id: "priority", mode: "edit" },
    { id: "readiness", mode: "display" },
    { id: "checklist_progress", mode: "display" },
    { id: "due_date", mode: "edit" },
    { id: "status", mode: "edit" },
  ],
};
export const DEFAULT_TASK_ROW_LAYOUTS: Record<TaskRowView, TaskRowLayout> = {
  list: parseTaskRowLayout(defaultLayout),
  tree: parseTaskRowLayout(defaultLayout),
};

/** Bad stored documents are observable fallbacks, never editable field policy. */
export function resolveTaskRowLayout(input: {
  view: TaskRowView;
  preferenceLayouts?: unknown;
  savedViewConfiguration?: unknown;
}): {
  layout: TaskRowLayout;
  source: "default" | "preferences" | "saved_view";
  invalid: boolean;
} {
  let invalid = false;
  const saved = input.savedViewConfiguration;
  if (saved !== undefined && saved !== null && !record(saved)) invalid = true;
  if (record(saved) && "row_fields" in saved && saved.row_fields !== null) {
    try {
      return {
        layout: parseTaskRowLayout(saved.row_fields),
        source: "saved_view",
        invalid,
      };
    } catch {
      invalid = true;
    }
  }
  const preferences = input.preferenceLayouts;
  if (preferences !== undefined && preferences !== null && !record(preferences))
    invalid = true;
  if (record(preferences)) {
    if (!exactKeys(preferences, ["list", "tree"])) invalid = true;
    if (input.view in preferences && preferences[input.view] !== null) {
      try {
        return {
          layout: parseTaskRowLayout(preferences[input.view]),
          source: "preferences",
          invalid,
        };
      } catch {
        invalid = true;
      }
    }
  }
  return {
    layout: parseTaskRowLayout(DEFAULT_TASK_ROW_LAYOUTS[input.view]),
    source: "default",
    invalid,
  };
}
