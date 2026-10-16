import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import { instantToLocalDateTime } from "../../shared/datetime";
import type { SqlClient } from "../db/database";
import {
  entity,
  guard,
  id,
  json,
  object,
  text,
  timezone,
  type Input,
} from "./core";
import type { Change } from "./tasks";

export function workMinutes(row: Input, from = -Infinity, to = Infinity) {
  const start = Date.parse(String(row.starts_at)),
    end = Date.parse(String(row.ends_at)),
    elapsed = (end - start) / 60000,
    clipped = Math.max(0, (Math.min(end, to) - Math.max(start, from)) / 60000);
  if (
    row.reporting_policy !== "legacy_wall" ||
    typeof row.reported_minutes !== "number" ||
    elapsed <= 0
  )
    return clipped;
  if (!clipped) return 0;
  if (from <= start && to >= end) return row.reported_minutes;
  const metadata = object(row.legacy_metadata ?? {}),
    zone = timezone({ timezone: metadata.timezone ?? "Europe/Berlin" }),
    wall = (at: number) =>
      Date.parse(
        instantToLocalDateTime(new Date(at).toISOString(), zone) + "Z",
      ),
    fullWall = (wall(end) - wall(start)) / 60000,
    clippedWall = Math.max(
      0,
      (wall(Math.min(end, to)) - wall(Math.max(start, from))) / 60000,
    );
  return fullWall > 0 ? (row.reported_minutes * clippedWall) / fullWall : 0;
}
export function workOverlapSummary(
  rows: Input[],
  from = -Infinity,
  to = Infinity,
) {
  const changes = rows
    .flatMap((row) => {
      const start = Math.max(from, Date.parse(String(row.starts_at))),
        end = Math.min(to, Date.parse(String(row.ends_at)));
      return end > start
        ? [
            { at: start, delta: 1 },
            { at: end, delta: -1 },
          ]
        : [];
    })
    .sort((a, b) => a.at - b.at || a.delta - b.delta);
  let count = 0,
    previous = 0,
    overlap = 0;
  for (const point of changes) {
    if (count > 1) overlap += point.at - previous;
    count += point.delta;
    previous = point.at;
  }
  const conflicts: {
      first_entry_id: string;
      second_entry_id: string;
      minutes: number;
    }[] = [],
    ordered = rows
      .map((row) => ({
        id: String(row.entry_id),
        start: Math.max(from, Date.parse(String(row.starts_at))),
        end: Math.min(to, Date.parse(String(row.ends_at))),
      }))
      .filter((row) => row.end > row.start)
      .sort((a, b) => a.start - b.start),
    active: typeof ordered = [];
  let pairs = 0;
  for (const row of ordered) {
    for (let index = active.length - 1; index >= 0; index--)
      if (active[index].end <= row.start) active.splice(index, 1);
    pairs += active.length;
    for (const prior of active) {
      if (conflicts.length >= 2000) break;
      conflicts.push({
        first_entry_id: prior.id,
        second_entry_id: row.id,
        minutes: (Math.min(prior.end, row.end) - row.start) / 60000,
      });
    }
    active.push(row);
  }
  return {
    overlap_minutes: overlap / 60000,
    overlap_count: pairs,
    conflicts,
    conflicts_truncated: pairs > conflicts.length,
  };
}
export function workReporting(
  before: Input | null,
  start: string,
  end: string,
) {
  const policy =
    before?.reporting_policy === "legacy_wall" ? "legacy_wall" : "elapsed";
  if (policy === "elapsed")
    return { reporting_policy: policy, reported_minutes: null };
  if (before?.starts_at === start && before?.ends_at === end)
    return {
      reporting_policy: policy,
      reported_minutes: before.reported_minutes,
    };
  const metadata = object(before?.legacy_metadata ?? {}),
    zone = timezone({ timezone: metadata.timezone ?? "Europe/Berlin" }),
    wall =
      (Date.parse(instantToLocalDateTime(end, zone) + "Z") -
        Date.parse(instantToLocalDateTime(start, zone) + "Z")) /
      60000;
  if (wall < 0)
    throw new DomainError(
      "INVALID_INPUT",
      "Imported wall-clock interval must have nonnegative reported duration.",
    );
  return { reporting_policy: policy, reported_minutes: wall };
}
export async function workCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision?: number,
): Promise<Change | null> {
  if (command === "time_draft_save") {
    const draftId = input.draft_id
        ? text(input, "draft_id", undefined, 512)
        : id("TD"),
      before = input.draft_id
        ? await entity(
            tx,
            "time_drafts",
            "draft_id",
            draftId,
            principal.ownerId,
          )
        : null;
    if (before) guard(before, revision);
    const value = { ...before, ...input },
      employer = text(value, "employer", "Jena", 200),
      date = text(value, "date", "", 10),
      start = text(value, "start", "", 10),
      end = text(value, "end", "", 10),
      description = text(value, "description", "", 10000),
      zone = timezone(value);
    if (before)
      await tx.query(
        'UPDATE time_drafts SET employer=$3,date=$4,start=$5,"end"=$6,end_next_day=$7,description=$8,timezone=$9,revision=revision+1,updated_at=now() WHERE owner_id=$1 AND draft_id=$2',
        [
          principal.ownerId,
          draftId,
          employer,
          date,
          start,
          end,
          value.end_next_day === true,
          description,
          zone,
        ],
      );
    else
      await tx.query(
        'INSERT INTO time_drafts(owner_id,draft_id,employer,date,start,"end",end_next_day,description,timezone) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          principal.ownerId,
          draftId,
          employer,
          date,
          start,
          end,
          value.end_next_day === true,
          description,
          zone,
        ],
      );
    return {
      entityId: draftId,
      before,
      after: await entity(
        tx,
        "time_drafts",
        "draft_id",
        draftId,
        principal.ownerId,
      ),
      affected: [],
    };
  }
  if (command === "time_draft_archive") {
    const draftId = text(input, "draft_id"),
      before = await entity(
        tx,
        "time_drafts",
        "draft_id",
        draftId,
        principal.ownerId,
      );
    guard(before, revision);
    await tx.query(
      "UPDATE time_drafts SET archived_at=now(),revision=revision+1,updated_at=now() WHERE owner_id=$1 AND draft_id=$2",
      [principal.ownerId, draftId],
    );
    return {
      entityId: draftId,
      before,
      after: await entity(
        tx,
        "time_drafts",
        "draft_id",
        draftId,
        principal.ownerId,
      ),
      affected: [],
    };
  }
  if (command !== "time_entry_undo") return null;
  if (principal.channel === "AI")
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Undo requires owner interaction.",
      {},
      403,
    );
  const last = (
    await tx.query<Input>(
      `SELECT e.* FROM activity_events e WHERE e.owner_id=$1 AND e.actor_id=$2 AND ($3::text IS NULL OR e.entity_id=$3) AND e.event_type IN ('time_entry_create','time_entry_update','time_entry_archive') AND NOT EXISTS(SELECT 1 FROM activity_events u WHERE u.owner_id=e.owner_id AND u.reason='Undo work event '||e.event_id) ORDER BY e.occurred_at DESC,e.event_id DESC LIMIT 1`,
      [principal.ownerId, principal.actorId, input.entry_id ?? null],
    )
  ).rows[0];
  if (!last)
    throw new DomainError(
      "INVALID_INPUT",
      "No eligible work interval change to undo.",
    );
  const entryId = String(last.entity_id),
    current = await entity(
      tx,
      "time_entries",
      "entry_id",
      entryId,
      principal.ownerId,
    );
  guard(current, revision);
  if (Number(current.revision) !== Number(object(last.after).revision))
    throw new DomainError(
      "REVISION_CONFLICT",
      "The work interval changed after this action.",
      { current },
      409,
    );
  if (!last.before)
    await tx.query(
      "UPDATE time_entries SET archived_at=now(),revision=revision+1 WHERE owner_id=$1 AND entry_id=$2",
      [principal.ownerId, entryId],
    );
  else {
    const previous = object(last.before);
    await tx.query(
      "UPDATE time_entries SET employer=$3,starts_at=$4,ends_at=$5,description=$6,task_id=$7,archived_at=$8,reporting_policy=$9,reported_minutes=$10,legacy_metadata=$11::jsonb,revision=revision+1 WHERE owner_id=$1 AND entry_id=$2",
      [
        principal.ownerId,
        entryId,
        previous.employer,
        previous.starts_at,
        previous.ends_at,
        previous.description,
        previous.task_id,
        previous.archived_at,
        previous.reporting_policy ?? "elapsed",
        previous.reported_minutes ?? null,
        json(previous.legacy_metadata ?? {}),
      ],
    );
  }
  return {
    entityId: entryId,
    before: current,
    after: await entity(
      tx,
      "time_entries",
      "entry_id",
      entryId,
      principal.ownerId,
    ),
    affected: current.task_id ? [String(current.task_id)] : [],
    reason: "Undo work event " + last.event_id,
  };
}
