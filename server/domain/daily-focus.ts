import {
  DomainError,
  type DailyFocusDTO,
  type Principal,
} from "../../shared/contracts";
import { DEFAULT_TIMEZONE, instantToLocalDate } from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import { date, requireScope, snapshot, text, type Input } from "./core";
import type { Change } from "./tasks";

function focusDate(input: Input, required: boolean): string {
  const value = date(input, "date");
  if (required && !value)
    throw new DomainError("INVALID_INPUT", "A local focus date is required.");
  return value ?? instantToLocalDate(Date.now(), DEFAULT_TIMEZONE);
}

async function selectedIds(tx: SqlClient, ownerId: string, focusDate: string) {
  const result = await tx.query<{ task_id: string }>(
    "SELECT task_id FROM daily_focus_items WHERE owner_id=$1 AND focus_date=$2 ORDER BY sort_key",
    [ownerId, focusDate],
  );
  return result.rows.map((row) => row.task_id);
}

export async function dailyFocusGet(
  tx: SqlClient,
  input: Input,
  principal: Principal,
): Promise<DailyFocusDTO> {
  requireScope(principal, "tasks");
  const focusDate = focusDateForQuery(input),
    day = await tx.query<{ revision: number }>(
      "SELECT revision FROM daily_focus_days WHERE owner_id=$1 AND focus_date=$2",
      [principal.ownerId, focusDate],
    ),
    taskIds = await selectedIds(tx, principal.ownerId, focusDate);
  const graph = taskIds.length ? await snapshot(tx, principal.ownerId) : null;
  return {
    date: focusDate,
    timezone: DEFAULT_TIMEZONE,
    revision: Number(day.rows[0]?.revision ?? 0),
    task_ids: taskIds,
    items: taskIds.flatMap((taskId) => {
      const task = graph?.byId.get(taskId);
      return task ? [task] : [];
    }),
  };
}

function focusDateForQuery(input: Input): string {
  return focusDate(input, false);
}

export async function dailyFocusSet(
  tx: SqlClient,
  input: Input,
  principal: Principal,
  expectedRevision: number | undefined,
): Promise<Change> {
  requireScope(principal, "tasks", true);
  const focusDate = focusDateForCommand(input);
  if (
    !Array.isArray(input.task_ids) ||
    input.task_ids.length > 5 ||
    input.task_ids.some((taskId) => typeof taskId !== "string")
  )
    throw new DomainError("INVALID_INPUT", "Choose at most five task IDs.");
  const taskIds = input.task_ids.map((taskId) =>
    text({ task_id: taskId }, "task_id", undefined, 512),
  );
  if (new Set(taskIds).size !== taskIds.length)
    throw new DomainError("INVALID_INPUT", "Focus task IDs must be unique.");
  if (!Number.isInteger(expectedRevision) || expectedRevision! < 0)
    throw new DomainError(
      "INVALID_INPUT",
      "expectedRevision is required for the focus day.",
    );
  const day = await tx.query<{ revision: number }>(
    "SELECT revision FROM daily_focus_days WHERE owner_id=$1 AND focus_date=$2",
    [principal.ownerId, focusDate],
  );
  const currentRevision = Number(day.rows[0]?.revision ?? 0),
    previousIds = await selectedIds(tx, principal.ownerId, focusDate),
    before = {
      date: focusDate,
      timezone: DEFAULT_TIMEZONE,
      revision: currentRevision,
      task_ids: previousIds,
    };
  if (currentRevision !== expectedRevision)
    throw new DomainError(
      "REVISION_CONFLICT",
      "The focus selection changed. Review the current day and retry.",
      {
        expected_revision: expectedRevision,
        actual_revision: currentRevision,
        current: before,
      },
      409,
    );
  if (taskIds.length) {
    const found = await tx.query<{ task_id: string }>(
      "SELECT task_id FROM tasks WHERE owner_id=$1 AND task_id=ANY($2::text[]) AND archived_at IS NULL",
      [principal.ownerId, taskIds],
    );
    if (found.rows.length !== taskIds.length)
      throw new DomainError(
        "INVALID_INPUT",
        "All focus tasks must be active tasks in this workspace.",
      );
  }
  if (currentRevision === 0) {
    const created = await tx.query(
      "INSERT INTO daily_focus_days(owner_id,focus_date) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING revision",
      [principal.ownerId, focusDate],
    );
    if (!created.rows.length)
      throw new DomainError(
        "REVISION_CONFLICT",
        "The focus day changed.",
        {},
        409,
      );
  } else {
    const updated = await tx.query(
      "UPDATE daily_focus_days SET revision=revision+1 WHERE owner_id=$1 AND focus_date=$2 AND revision=$3 RETURNING revision",
      [principal.ownerId, focusDate, currentRevision],
    );
    if (!updated.rows.length)
      throw new DomainError(
        "REVISION_CONFLICT",
        "The focus day changed.",
        {},
        409,
      );
  }
  await tx.query(
    "DELETE FROM daily_focus_items WHERE owner_id=$1 AND focus_date=$2",
    [principal.ownerId, focusDate],
  );
  for (const [sortKey, taskId] of taskIds.entries())
    await tx.query(
      "INSERT INTO daily_focus_items(owner_id,focus_date,task_id,sort_key) VALUES($1,$2,$3,$4)",
      [principal.ownerId, focusDate, taskId, sortKey],
    );
  return {
    entityId: `daily-focus:${focusDate}`,
    before,
    after: {
      ...before,
      revision: currentRevision + 1,
      task_ids: taskIds,
    },
    affected: [...new Set([...previousIds, ...taskIds])],
  };
}

function focusDateForCommand(input: Input): string {
  return focusDate(input, true);
}
