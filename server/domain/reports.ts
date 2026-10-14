import type {
  FileDTO,
  Principal,
  ReportsDTO,
  TaskDTO,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import { instantToLocalDate } from "../../shared/datetime";
import { analyticsRange } from "./analytics";
import { cleanRows, type Input } from "./core";
import { expiredDeadlineDates } from "./deadline";

/** Complete owner aggregates, with explicitly bounded candidate/detail lists. */
export async function reports(
  tx: SqlClient,
  tasks: TaskDTO[],
  input: Input,
  principal: Principal,
  pageTasks: (
    items: (TaskDTO & { due_local_date: string; overdue_days: number })[],
  ) => ReportsDTO["overdue_ageing"]["items"],
): Promise<ReportsDTO> {
  const range = analyticsRange(input),
    today = instantToLocalDate(Date.now(), range.timezone);
  const ageing = tasks
    .flatMap((task) => {
      const due = expiredDeadlineDates(task, range.timezone)[0];
      if (
        !due ||
        (range.from_date && due < range.from_date) ||
        (range.to_date && due >= range.to_date)
      )
        return [];
      return [
        {
          ...task,
          due_local_date: due,
          overdue_days: Math.max(
            0,
            (Date.parse(today + "T00:00:00Z") -
              Date.parse(due + "T00:00:00Z")) /
              86400000,
          ),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.overdue_days - a.overdue_days || a.task_id.localeCompare(b.task_id),
    );
  const buckets = [
    { key: "same_day", min_days: 0, max_days: 0 },
    { key: "1_7", min_days: 1, max_days: 7 },
    { key: "8_30", min_days: 8, max_days: 30 },
    { key: "31_90", min_days: 31, max_days: 90 },
    { key: "91_plus", min_days: 91, max_days: null },
  ].map((bucket) => ({
    ...bucket,
    count: ageing.filter(
      (t) =>
        t.overdue_days >= bucket.min_days &&
        (bucket.max_days === null || t.overdue_days <= bucket.max_days),
    ).length,
  }));
  const result: ReportsDTO = {
    range: {
      timezone: range.timezone,
      from_date: range.from_date,
      to_date: range.to_date,
      applies_to: "overdue_deadline_dates_and_file_registration_dates",
    },
    overdue_ageing: {
      as_of_date: today,
      total: ageing.length,
      buckets,
      items: pageTasks(ageing),
    },
    files_scope_granted:
      principal.scopes.includes("files:read") ||
      principal.scopes.includes("admin:manage"),
    registered_files: null,
    duplicate_candidates: null,
  };
  if (!result.files_scope_granted) return result;
  const params = [principal.ownerId, range.start, range.end],
    filter =
      "f.owner_id=$1 AND ($2::timestamptz IS NULL OR f.created_at >= $2::timestamptz) AND ($3::timestamptz IS NULL OR f.created_at < $3::timestamptz)";
  const counts = (
    await tx.query<{
      source: string;
      total: string;
      known_size_bytes: string;
      unknown_size_count: string;
    }>(
      `SELECT CASE WHEN f.provider='private_blob' THEN 'private_blob' WHEN f.provider='neon_object_storage' THEN 'neon_object_storage' WHEN f.state='External' THEN 'external_google_reference' ELSE 'managed_google_reference' END source, count(*)::text total, COALESCE(sum(f.size_bytes),0)::text known_size_bytes, count(*) FILTER(WHERE f.size_bytes IS NULL)::text unknown_size_count FROM files f WHERE ${filter} GROUP BY 1 ORDER BY 1`,
      params,
    )
  ).rows;
  const bySource = counts.map((row) => ({
    source: row.source,
    total: Number(row.total),
    known_size_bytes: row.known_size_bytes,
    unknown_size_count: Number(row.unknown_size_count),
  }));
  result.registered_files = {
    scope: "owner_registered_records",
    total: bySource.reduce((sum, r) => sum + r.total, 0),
    known_size_bytes: bySource
      .reduce((sum, r) => sum + BigInt(r.known_size_bytes), 0n)
      .toString(),
    unknown_size_count: bySource.reduce(
      (sum, r) => sum + r.unknown_size_count,
      0,
    ),
    by_source: bySource,
  };
  const verified = `f.provider IN ('private_blob','neon_object_storage') AND f.sha256 ~ '^[a-f0-9]{64}$' AND f.size_bytes IS NOT NULL AND f.storage_key IS NOT NULL AND EXISTS(SELECT 1 FROM file_versions v WHERE v.owner_id=f.owner_id AND v.file_id=f.file_id AND v.sha256=f.sha256 AND v.size_bytes=f.size_bytes AND v.storage_key=f.storage_key)`;
  const groups = (
    await tx.query<{
      sha256: string;
      size_bytes: string;
      file_count: string;
      total_groups: string;
    }>(
      `SELECT f.sha256,f.size_bytes::text,count(*)::text file_count,count(*) OVER()::text total_groups FROM files f WHERE ${filter} AND ${verified} GROUP BY f.sha256,f.size_bytes HAVING count(*)>1 ORDER BY f.sha256,f.size_bytes LIMIT 100`,
      params,
    )
  ).rows;
  const unverified = (
    await tx.query<{ count: string }>(
      `SELECT count(*)::text count FROM files f WHERE ${filter} AND NOT COALESCE((${verified}),false)`,
      params,
    )
  ).rows[0];
  const details = groups.length
    ? cleanRows(
        (
          await tx.query<FileDTO & { rank: string }>(
            `SELECT ranked.* FROM (SELECT f.*,COALESCE(a.description,'') description,COALESCE(a.tags,'[]'::jsonb) tags,row_number() OVER(PARTITION BY f.sha256,f.size_bytes ORDER BY f.file_id) rank FROM files f LEFT JOIN file_annotations a ON a.owner_id=f.owner_id AND a.file_id=f.file_id WHERE ${filter} AND ${verified} AND f.sha256=ANY($4::text[])) ranked WHERE rank<=20 ORDER BY sha256,file_id`,
            [...params, groups.map((g) => g.sha256)],
          )
        ).rows,
      )
    : [];
  result.duplicate_candidates = {
    basis: bySource.some((row) => row.source === "neon_object_storage")
      ? "canonical_verified_private_storage_sha256"
      : "canonical_verified_private_blob_sha256",
    total_groups: Number(groups[0]?.total_groups ?? 0),
    excluded_unverified_count: Number(unverified.count),
    groups: groups.map((g) => ({
      sha256: g.sha256,
      size_bytes: g.size_bytes,
      file_count: Number(g.file_count),
      files: details.filter(
        (f) => f.sha256 === g.sha256 && String(f.size_bytes) === g.size_bytes,
      ),
      truncated: Number(g.file_count) > 20,
    })),
    truncated: Number(groups[0]?.total_groups ?? 0) > groups.length,
  };
  return result;
}
