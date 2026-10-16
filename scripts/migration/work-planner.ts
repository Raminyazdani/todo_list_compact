import { createHash } from "node:crypto";
import { DomainError, type JsonValue } from "../../shared/contracts";
import {
  addCalendarDays,
  zonedLocalToInstant,
  type Disambiguation,
} from "../../shared/datetime";

export interface WorkPlannerLegacyEntry {
  id: string;
  jobId: "jena" | "seewiesen";
  date: string;
  start: string;
  end: string;
  endNextDay: boolean;
  tasks: string;
}
export interface WorkPlannerImportOptions {
  timezone?: string;
  resolutions?: Record<
    string,
    { start?: Disambiguation; end?: Disambiguation }
  >;
}
export interface PreparedWorkPlannerImport {
  entries: Array<{
    entry_id: string;
    employer: string;
    starts_at: string;
    ends_at: string;
    timezone: string;
    description: string;
    task_id: null;
    reporting_policy: "legacy_wall";
    reported_minutes: number;
    legacy_metadata: Record<string, JsonValue>;
  }>;
  drafts: Array<{
    draft_id: string;
    employer: string;
    description: string;
    date: string;
    start: string;
    end: string;
    end_next_day: boolean;
    legacy_metadata: Record<string, JsonValue>;
  }>;
  errors: Array<{
    source_id: string;
    code: "INVALID_INTERVAL" | "DST_RESOLUTION_REQUIRED" | "INVALID_LOCAL_TIME";
  }>;
  source_hash: string;
  ready: boolean;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return (
    "{" +
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, "en"))
      .map(([key, val]) => JSON.stringify(key) + ":" + canonical(val))
      .join(",") +
    "}"
  );
}
function clock(value: string) {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [h, m] = value.split(":").map(Number);
  return h * 60 + m;
}
/** Read-only conversion. No source data, credentials or inferred relationships are written. */
export function prepareWorkPlannerImport(
  input: unknown,
  options: WorkPlannerImportOptions = {},
): PreparedWorkPlannerImport {
  const zone = options.timezone ?? "Europe/Berlin";
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone }).format(0);
  } catch {
    throw new DomainError(
      "INVALID_INPUT",
      "A valid IANA timezone is required for Work Planner import.",
    );
  }
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new DomainError(
      "INVALID_INPUT",
      "A Work Planner version 1 backup is required.",
    );
  const backup = input as { version?: number; entries?: unknown[] };
  if (
    backup.version !== 1 ||
    !Array.isArray(backup.entries) ||
    backup.entries.length > 5000 ||
    Buffer.byteLength(JSON.stringify(input), "utf8") > 32 * 1024 * 1024
  )
    throw new DomainError(
      "INVALID_INPUT",
      "A bounded Work Planner version 1 backup is required.",
    );
  const result: PreparedWorkPlannerImport = {
    entries: [],
    drafts: [],
    errors: [],
    source_hash: createHash("sha256").update(canonical(input)).digest("hex"),
    ready: true,
  };
  const seen = new Set<string>();
  for (const original of backup.entries) {
    if (!original || typeof original !== "object" || Array.isArray(original))
      throw new DomainError("INVALID_INPUT", "Invalid Work Planner record.");
    const raw = original as Record<string, unknown>;
    if (
      typeof raw.id !== "string" ||
      !/^[-_A-Za-z0-9]{1,80}$/.test(raw.id) ||
      seen.has(raw.id) ||
      !["jena", "seewiesen"].includes(String(raw.jobId))
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Work Planner IDs must be valid and unique and employer must be known.",
      );
    seen.add(raw.id);
    for (const key of ["date", "start", "end", "tasks"])
      if (raw[key] !== undefined && typeof raw[key] !== "string")
        throw new DomainError(
          "INVALID_INPUT",
          "Work Planner fields must remain literal strings.",
        );
    if (raw.endNextDay !== undefined && typeof raw.endNextDay !== "boolean")
      throw new DomainError("INVALID_INPUT", "Invalid next-day flag.");
    const row: WorkPlannerLegacyEntry = {
      id: raw.id,
      jobId: raw.jobId as WorkPlannerLegacyEntry["jobId"],
      date: String(raw.date ?? ""),
      start: String(raw.start ?? ""),
      end: String(raw.end ?? ""),
      endNextDay: raw.endNextDay === true,
      tasks: String(raw.tasks ?? ""),
    };
    if (
      row.tasks.length > 10000 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.tasks)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Invalid Work Planner description.",
      );
    const legacy_metadata: Record<string, JsonValue> = {
      ...row,
      source: "work_planner",
      source_id: row.id,
      timezone: zone,
    };
    const employer = row.jobId === "jena" ? "Jena" : "Seewiesen";
    const stableId = "WP_" + row.id;
    const start = clock(row.start),
      end = clock(row.end);
    // The original stores partial time inputs as drafts, including e.g. '1:' or '09'.
    const incomplete = !row.date || start === null || end === null;
    if (incomplete) {
      result.drafts.push({
        draft_id: stableId,
        employer,
        description: row.tasks,
        date: row.date,
        start: row.start,
        end: row.end,
        end_next_day: row.endNextDay,
        legacy_metadata,
      });
      continue;
    }
    const reported = end - start + (row.endNextDay ? 1440 : 0);
    const dateValue = new Date(row.date + "T12:00Z");
    if (
      reported <= 0 ||
      reported > 1440 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(dateValue.getTime()) ||
      dateValue.toISOString().slice(0, 10) !== row.date
    ) {
      result.errors.push({ source_id: row.id, code: "INVALID_INTERVAL" });
      continue;
    }
    try {
      const starts_at = zonedLocalToInstant(
        row.date + "T" + row.start,
        zone,
        options.resolutions?.[row.id]?.start ?? "reject",
      );
      const ends_at = zonedLocalToInstant(
        (row.endNextDay ? addCalendarDays(row.date, 1) : row.date) +
          "T" +
          row.end,
        zone,
        options.resolutions?.[row.id]?.end ?? "reject",
      );
      if (Date.parse(ends_at) <= Date.parse(starts_at)) {
        result.errors.push({ source_id: row.id, code: "INVALID_INTERVAL" });
        continue;
      }
      result.entries.push({
        entry_id: stableId,
        employer,
        starts_at,
        ends_at,
        timezone: zone,
        description: row.tasks,
        task_id: null,
        reporting_policy: "legacy_wall",
        reported_minutes: reported,
        legacy_metadata,
      });
    } catch (error) {
      result.errors.push({
        source_id: row.id,
        code:
          error instanceof Error && error.message.includes("occurs twice")
            ? "DST_RESOLUTION_REQUIRED"
            : "INVALID_LOCAL_TIME",
      });
    }
  }
  result.ready = result.errors.length === 0;
  return result;
}
