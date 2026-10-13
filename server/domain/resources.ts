import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  choice,
  date,
  entity,
  guard,
  hash,
  id,
  instant,
  json,
  number,
  object,
  optionalText,
  text,
  timezone,
  type Input,
} from "./core";
import type { Change } from "./tasks";
import {
  isOwnerStorageKey,
  verifyPrivateFileMetadata,
} from "../integrations/storage";
import { runRecurringTasks } from "./recurrence";
import * as RRulePackage from "rrule";
const RRule = (RRulePackage.RRule ??
  Reflect.get(RRulePackage, "default")?.RRule) as typeof RRulePackage.RRule;

function recurrenceExceptions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 1000)
    throw new DomainError(
      "INVALID_INPUT",
      "At most 1000 recurrence exceptions are allowed.",
    );
  const result = value.map((entry) => {
    if (typeof entry !== "string")
      throw new DomainError(
        "INVALID_INPUT",
        "Recurrence exceptions must be local dates or date-times.",
      );
    const match =
      /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(entry);
    if (
      !match ||
      !date({ exception: match[1] }, "exception") ||
      (match[2] !== undefined &&
        (+match[2] > 23 || +match[3] > 59 || +(match[4] ?? 0) > 59))
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Invalid recurrence exception local date or time.",
      );
    return match[2] === undefined
      ? match[1]
      : `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}`;
  });
  return [...new Set(result)].sort();
}

export async function archiveEligibility(
  tx: SqlClient,
  fileId: string,
  ownerId: string,
) {
  const file = await entity(tx, "files", "file_id", fileId, ownerId);
  const links = await tx.query<{
    task_id: string;
    status: string | null;
    archived_at: string | null;
  }>(
    `SELECT l.task_id,t.status,t.archived_at FROM file_task_links l LEFT JOIN tasks t ON t.task_id=l.task_id AND t.owner_id=l.owner_id WHERE l.file_id=$1 AND l.owner_id=$2 AND l.active=true`,
    [fileId, ownerId],
  );
  const blockers = links.rows.filter(
    (l) => !l.status || !["Done", "Cancelled"].includes(l.status),
  );
  const eligible =
    !file.protected &&
    file.state !== "External" &&
    file.provider !== "google_drive" &&
    links.rows.length > 0 &&
    blockers.length === 0;
  return {
    file_id: fileId,
    eligible,
    linked_task_count: links.rows.length,
    blocked_by: blockers.map((l) => l.task_id),
    reason:
      file.provider === "google_drive"
        ? "EXTERNALLY_MANAGED"
        : file.protected
          ? "PROTECTED_SOURCE"
          : file.state === "External"
            ? "EXTERNALLY_MANAGED"
            : !links.rows.length
              ? "NO_ACTIVE_LINKS"
              : blockers.length
                ? "OPEN_OR_MISSING_TASKS"
                : null,
    revision: Number(file.revision),
    provider: file.provider,
  };
}
export async function resourceCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
  operationId = id("OP"),
): Promise<Change> {
  const owner = principal.ownerId;
  if (command === "project_create") {
    const projectId = id("P");
    await tx.query(
      "INSERT INTO projects(project_id,owner_id,title,notes,area,due_date) VALUES($1,$2,$3,$4,$5,$6)",
      [
        projectId,
        owner,
        text(input, "title"),
        text(input, "notes", ""),
        text(input, "area", "Other"),
        date(input, "due_date"),
      ],
    );
    return {
      entityId: projectId,
      before: null,
      after: await entity(tx, "projects", "project_id", projectId, owner),
      affected: [],
    };
  }
  if (command === "project_update") {
    const projectId = text(input, "project_id"),
      before = await entity(tx, "projects", "project_id", projectId, owner);
    guard(before, revision);
    await tx.query(
      "UPDATE projects SET title=$3,notes=$4,area=$5,status=$6,due_date=$7,revision=revision+1,updated_at=now() WHERE project_id=$1 AND owner_id=$2",
      [
        projectId,
        owner,
        text(input, "title", String(before.title)),
        text(input, "notes", String(before.notes)),
        text(input, "area", String(before.area)),
        text(input, "status", String(before.status)),
        "due_date" in input ? date(input, "due_date") : before.due_date,
      ],
    );
    return {
      entityId: projectId,
      before,
      after: await entity(tx, "projects", "project_id", projectId, owner),
      affected: [],
    };
  }
  if (command === "project_milestone_create") {
    const projectId = text(input, "project_id");
    await entity(tx, "projects", "project_id", projectId, owner);
    const taskId = optionalText(input, "task_id");
    if (taskId) await entity(tx, "tasks", "task_id", taskId, owner);
    const dueDate = date(input, "due_date");
    if (!dueDate)
      throw new DomainError("INVALID_INPUT", "Milestone date required.");
    const milestoneId = id("M");
    await tx.query(
      "INSERT INTO project_milestones(milestone_id,owner_id,project_id,title,due_date,task_id) VALUES($1,$2,$3,$4,$5,$6)",
      [milestoneId, owner, projectId, text(input, "title"), dueDate, taskId],
    );
    return {
      entityId: milestoneId,
      before: null,
      after: await entity(
        tx,
        "project_milestones",
        "milestone_id",
        milestoneId,
        owner,
      ),
      affected: taskId ? [taskId] : [],
    };
  }
  if (
    command === "file_register_external_link" ||
    command === "file_register_upload"
  ) {
    const fileId = id("F"),
      external = command === "file_register_external_link";
    let url: string | null = null,
      externalId: string | null = null,
      storageKey: string | null = null;
    if (external) {
      url = text(input, "external_url");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid Drive reference URL.");
      }
      if (
        parsed.protocol !== "https:" ||
        !["drive.google.com", "docs.google.com"].includes(parsed.hostname) ||
        parsed.username ||
        parsed.password
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Only verified HTTPS Google Drive references are supported.",
        );
      externalId = optionalText(input, "external_id");
    } else {
      storageKey = text(input, "storage_key");
      if (!isOwnerStorageKey(storageKey, owner))
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Upload storage key must be owner-bound.",
          {},
          403,
        );
    }
    let sha = optionalText(input, "sha256"),
      size =
        input.size_bytes === undefined ? null : number(input, "size_bytes");
    if (sha && !/^[a-f0-9]{64}$/.test(sha))
      throw new DomainError("INVALID_INPUT", "Invalid SHA-256.");
    if (!external) {
      const verified = await verifyPrivateFileMetadata(storageKey!, principal);
      if (
        (sha && sha !== verified.sha256) ||
        (size !== null && size !== verified.size_bytes)
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Uploaded bytes do not match the supplied checksum or size.",
        );
      sha = verified.sha256;
      size = verified.size_bytes;
    }
    const filename = text(
      input,
      "original_filename",
      text(input, "title", "file"),
      500,
    );
    let versionGroup = optionalText(input, "version_group_id") ?? id("VG");
    if (input.file_id) {
      const previous = await entity(
        tx,
        "files",
        "file_id",
        text(input, "file_id"),
        owner,
      );
      guard(previous, revision);
      if (
        input.version_group_id &&
        input.version_group_id !== previous.version_group_id
      )
        throw new DomainError(
          "INVALID_INPUT",
          "Version family does not match the original file.",
        );
      versionGroup = String(previous.version_group_id);
    } else if (input.version_group_id) {
      const siblings = await tx.query(
        "SELECT file_id FROM files WHERE version_group_id=$1 AND owner_id=$2",
        [versionGroup, owner],
      );
      if (!siblings.rows.length)
        throw new DomainError(
          "ENTITY_NOT_FOUND",
          "Existing version family unavailable.",
          {},
          404,
        );
    }
    await tx.query(
      "INSERT INTO files(file_id,owner_id,title,original_filename,provider,external_id,external_url,storage_key,mime_type,size_bytes,sha256,version_group_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
      [
        fileId,
        owner,
        text(input, "title", filename),
        filename,
        external ? "google_drive" : "private_blob",
        externalId,
        url,
        storageKey,
        text(input, "mime_type", "application/octet-stream"),
        size,
        sha,
        versionGroup,
        external ? "External" : "Inbox",
      ],
    );
    await tx.query(
      "INSERT INTO file_versions(version_id,owner_id,file_id,storage_key,sha256,size_bytes) VALUES($1,$2,$3,$4,$5,$6)",
      [id("V"), owner, fileId, storageKey, sha, size],
    );
    return {
      entityId: fileId,
      before: null,
      after: await entity(tx, "files", "file_id", fileId, owner),
      affected: [],
    };
  }
  if (command === "file_link_to_task") {
    const fileId = text(input, "file_id"),
      taskId = text(input, "task_id");
    await entity(tx, "files", "file_id", fileId, owner);
    await entity(tx, "tasks", "task_id", taskId, owner);
    const purpose = choice(
      input,
      "purpose",
      ["Input", "Reference", "Output", "Other"],
      "Reference",
    );
    const existing = await tx.query<{ link_id: string }>(
      "SELECT link_id FROM file_task_links WHERE file_id=$1 AND task_id=$2 AND purpose=$3 AND owner_id=$4 AND active=true",
      [fileId, taskId, purpose, owner],
    );
    if (existing.rows[0])
      return {
        entityId: existing.rows[0].link_id,
        before: null,
        after: await entity(
          tx,
          "file_task_links",
          "link_id",
          existing.rows[0].link_id,
          owner,
        ),
        affected: [taskId],
      };
    const linkId = id("L");
    await tx.query(
      "INSERT INTO file_task_links(link_id,owner_id,file_id,task_id,purpose) VALUES($1,$2,$3,$4,$5)",
      [linkId, owner, fileId, taskId, purpose],
    );
    return {
      entityId: linkId,
      before: null,
      after: await entity(tx, "file_task_links", "link_id", linkId, owner),
      affected: [taskId],
    };
  }
  if (command === "file_unlink_from_task") {
    const linkId = text(input, "link_id"),
      before = await entity(tx, "file_task_links", "link_id", linkId, owner);
    guard(before, revision);
    await tx.query(
      "UPDATE file_task_links SET active=false,ended_at=now(),revision=revision+1 WHERE link_id=$1 AND owner_id=$2",
      [linkId, owner],
    );
    return {
      entityId: linkId,
      before,
      after: await entity(tx, "file_task_links", "link_id", linkId, owner),
      affected: [String(before.task_id)],
    };
  }
  if (command === "file_archive" || command === "file_restore") {
    const fileId = text(input, "file_id"),
      before = await entity(tx, "files", "file_id", fileId, owner);
    guard(before, revision);
    if (before.provider === "google_drive")
      throw new DomainError(
        "UNSUPPORTED_OPERATION",
        "Google Drive originals remain read-only. A separately authorized verified move adapter is required.",
        {},
        409,
      );
    if (command === "file_archive") {
      if (input.explicit_user_intent !== true || principal.channel === "AI")
        throw new DomainError(
          "INSUFFICIENT_PERMISSIONS",
          "Explicit file archive approval required.",
          {},
          403,
        );
      const eligibility = await archiveEligibility(tx, fileId, owner);
      if (!eligibility.eligible)
        throw new DomainError(
          "FILE_ARCHIVE_INELIGIBLE",
          "Archive is blocked by file linkage or external management.",
          eligibility,
          409,
        );
    }
    await tx.query(
      "UPDATE files SET state=$3,archived_at=$4,revision=revision+1,updated_at=now() WHERE file_id=$1 AND owner_id=$2",
      [
        fileId,
        owner,
        command === "file_archive" ? "Old" : "Active",
        command === "file_archive" ? new Date().toISOString() : null,
      ],
    );
    return {
      entityId: fileId,
      before,
      after: await entity(tx, "files", "file_id", fileId, owner),
      affected: [],
    };
  }
  if (command.startsWith("calendar_") || command.startsWith("time_entry_"))
    return scheduledCommand(tx, command, input, principal, revision);
  if (command === "preferences_update") {
    const rows = await tx.query<Input>(
      "SELECT * FROM preferences WHERE owner_id=$1",
      [owner],
    );
    const before = rows.rows[0] ?? { revision: 0, settings: {} };
    if (rows.rows[0]) guard(before, revision);
    const settings = { ...object(before.settings), ...object(input.settings) };
    const encoded = json(settings);
    if (encoded.length > 50000)
      throw new DomainError("INVALID_INPUT", "Preference document too large.");
    await tx.query(
      "INSERT INTO preferences(owner_id,settings,revision) VALUES($1,$2::jsonb,1) ON CONFLICT(owner_id) DO UPDATE SET settings=$2::jsonb,revision=preferences.revision+1",
      [owner, encoded],
    );
    return {
      entityId: owner,
      before,
      after: (
        await tx.query("SELECT * FROM preferences WHERE owner_id=$1", [owner])
      ).rows[0],
      affected: [],
    };
  }
  if (command === "saved_view_create") {
    const viewId = id("VIEW");
    await tx.query(
      "INSERT INTO saved_views(view_id,owner_id,title,configuration) VALUES($1,$2,$3,$4::jsonb)",
      [viewId, owner, text(input, "title"), json(object(input.configuration))],
    );
    return {
      entityId: viewId,
      before: null,
      after: await entity(tx, "saved_views", "view_id", viewId, owner),
      affected: [],
    };
  }
  if (command === "saved_view_update") {
    const viewId = text(input, "view_id"),
      before = await entity(tx, "saved_views", "view_id", viewId, owner);
    guard(before, revision);
    await tx.query(
      "UPDATE saved_views SET title=$3,configuration=$4::jsonb,revision=revision+1 WHERE view_id=$1 AND owner_id=$2",
      [
        viewId,
        owner,
        text(input, "title", String(before.title)),
        json(object(input.configuration ?? before.configuration)),
      ],
    );
    return {
      entityId: viewId,
      before,
      after: await entity(tx, "saved_views", "view_id", viewId, owner),
      affected: [],
    };
  }
  if (command === "reminder_create") {
    const taskId = text(input, "task_id");
    await entity(tx, "tasks", "task_id", taskId, owner);
    const reminderId = id("R");
    await tx.query(
      "INSERT INTO reminders(reminder_id,owner_id,task_id,remind_at) VALUES($1,$2,$3,$4)",
      [reminderId, owner, taskId, instant(input, "remind_at")],
    );
    return {
      entityId: reminderId,
      before: null,
      after: await entity(tx, "reminders", "reminder_id", reminderId, owner),
      affected: [taskId],
    };
  }
  if (command === "notification_mark_read") {
    const notificationId = text(input, "notification_id"),
      before = await entity(
        tx,
        "notifications",
        "notification_id",
        notificationId,
        owner,
      );
    guard(before, revision);
    if (!before.read_at)
      await tx.query(
        "UPDATE notifications SET read_at=now(),revision=revision+1 WHERE notification_id=$1 AND owner_id=$2",
        [notificationId, owner],
      );
    return {
      entityId: notificationId,
      before,
      after: await entity(
        tx,
        "notifications",
        "notification_id",
        notificationId,
        owner,
      ),
      affected: [],
    };
  }
  if (command === "system_daily_run") {
    if (
      principal.channel !== "system" ||
      !principal.scopes.includes("admin:manage")
    )
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "Daily jobs require a trusted system principal and admin scope.",
        {},
        403,
      );
    const due = await tx.query<Input>(
      `SELECT r.*,t.title,t.status task_status,t.archived_at task_archived_at FROM reminders r JOIN tasks t ON t.task_id=r.task_id AND t.owner_id=r.owner_id WHERE r.owner_id=$1 AND r.state='Pending' AND r.remind_at<=now() ORDER BY r.remind_at,r.reminder_id LIMIT 1000`,
      [owner],
    );
    let delivered = 0,
      cancelled = 0;
    const notifications: string[] = [];
    for (const reminder of due.rows) {
      if (
        reminder.task_archived_at ||
        ["Done", "Cancelled"].includes(String(reminder.task_status))
      ) {
        await tx.query(
          "UPDATE reminders SET state='Cancelled',revision=revision+1 WHERE reminder_id=$1 AND owner_id=$2",
          [reminder.reminder_id, owner],
        );
        cancelled++;
        continue;
      }
      const notificationId = `N-${hash({ owner, reminder: reminder.reminder_id }).slice(0, 32)}`;
      await tx.query(
        "INSERT INTO notifications(notification_id,owner_id,title,body) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [
          notificationId,
          owner,
          String(reminder.title),
          `یادآوری برای کار ${reminder.task_id}`,
        ],
      );
      await tx.query(
        "UPDATE reminders SET state='Succeeded',revision=revision+1 WHERE reminder_id=$1 AND owner_id=$2",
        [reminder.reminder_id, owner],
      );
      delivered++;
      notifications.push(notificationId);
    }
    const recurring = await runRecurringTasks(
      tx,
      principal,
      new Date(),
      operationId,
    );
    const expired = await tx.query(
      "DELETE FROM command_previews WHERE owner_id=$1 AND expires_at<now() RETURNING preview_id",
      [owner],
    );
    return {
      entityId: id("JOB"),
      before: { due_reminder_ids: due.rows.map((r) => r.reminder_id) },
      after: {
        delivered,
        cancelled,
        pruned_previews: expired.rows.length,
        notification_ids: notifications,
        recurring,
        channel: "in_app",
        precision: "daily scheduler; manual run supported",
      },
      affected: [
        ...due.rows.map((r) => String(r.task_id)),
        ...recurring.task_ids,
      ],
    };
  }
  throw new DomainError(
    "UNSUPPORTED_OPERATION",
    "Resource command unavailable.",
  );
}
async function scheduledCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
): Promise<Change> {
  const isTime = command.startsWith("time_"),
    table = isTime ? "time_entries" : "calendar_events",
    column = isTime ? "entry_id" : "event_id",
    owner = principal.ownerId,
    creation =
      command.endsWith("create_local_event") || command === "time_entry_create",
    entityId = creation ? id(isTime ? "TE" : "CE") : text(input, column),
    before = creation ? null : await entity(tx, table, column, entityId, owner);
  if (before) {
    guard(before, revision);
    if (!isTime && before.provider !== "local")
      throw new DomainError(
        "INSUFFICIENT_PERMISSIONS",
        "External calendars are read-only without separately authorized integration.",
        {},
        403,
      );
  }
  if (
    command === "calendar_delete_local_event" ||
    command === "time_entry_archive"
  ) {
    await tx.query(
      `UPDATE ${table} SET archived_at=now(),revision=revision+1 WHERE ${column}=$1 AND owner_id=$2`,
      [entityId, owner],
    );
    return {
      entityId,
      before,
      after: await entity(tx, table, column, entityId, owner),
      affected: [],
    };
  }
  const source = { ...before, ...input },
    start = instant(source, "starts_at"),
    end = instant(source, "ends_at");
  if (end <= start)
    throw new DomainError("INVALID_INPUT", "End must be after start.");
  if (Date.parse(end) - Date.parse(start) > 366 * 86400000)
    throw new DomainError("INVALID_INPUT", "Time range is too large.");
  const taskId = optionalText(source, "task_id");
  if (taskId) await entity(tx, "tasks", "task_id", taskId, owner);
  if (isTime) {
    const overlaps = await tx.query<{ entry_id: string }>(
      "SELECT entry_id FROM time_entries WHERE owner_id=$1 AND archived_at IS NULL AND entry_id<>$2 AND starts_at<$4 AND ends_at>$3",
      [owner, entityId, start, end],
    );
    if (overlaps.rows.length)
      throw new DomainError(
        "TIME_OVERLAP",
        "Worked time overlaps an existing entry.",
        { entry_ids: overlaps.rows.map((r) => r.entry_id) },
        409,
      );
    if (creation)
      await tx.query(
        "INSERT INTO time_entries(entry_id,owner_id,employer,starts_at,ends_at,description,task_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [
          entityId,
          owner,
          text(source, "employer"),
          start,
          end,
          text(source, "description", "", 10000),
          taskId,
        ],
      );
    else
      await tx.query(
        "UPDATE time_entries SET employer=$3,starts_at=$4,ends_at=$5,description=$6,task_id=$7,revision=revision+1 WHERE entry_id=$1 AND owner_id=$2",
        [
          entityId,
          owner,
          text(source, "employer"),
          start,
          end,
          text(source, "description", ""),
          taskId,
        ],
      );
  } else {
    const recurrence = optionalText(source, "recurrence_rule");
    const zone = timezone(source),
      exceptions = recurrenceExceptions(
        source.recurrence_exceptions === undefined
          ? []
          : source.recurrence_exceptions,
      );
    if (
      before?.recurrence_rule &&
      input.apply_to_series !== true &&
      (start !== before.starts_at ||
        end !== before.ends_at ||
        zone !== before.timezone ||
        (source.all_day === true) !== before.all_day)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Changing recurring event times requires an explicit whole-series decision.",
      );
    if (
      recurrence &&
      !/^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;[A-Z]+=[A-Z0-9,+-]+)*$/.test(
        recurrence,
      )
    )
      throw new DomainError(
        "INVALID_INPUT",
        "Invalid RFC5545 recurrence rule.",
      );
    if (recurrence) {
      try {
        const options = RRule.parseString(recurrence);
        if (
          recurrence.length > 1000 ||
          new Date(start).getUTCMilliseconds() !== 0 ||
          (options.interval !== undefined &&
            (!Number.isInteger(options.interval) ||
              options.interval < 1 ||
              options.interval > 365)) ||
          (options.count != null &&
            (!Number.isInteger(options.count) ||
              options.count < 1 ||
              options.count > 10000))
        )
          throw new Error("Invalid recurrence bound.");
        new RRule({ ...options, dtstart: new Date(start) });
      } catch {
        throw new DomainError(
          "INVALID_INPUT",
          "Invalid or unsupported bounded recurrence rule.",
        );
      }
    }
    if (creation)
      await tx.query(
        "INSERT INTO calendar_events(event_id,owner_id,title,starts_at,ends_at,timezone,all_day,task_id,notes,recurrence_rule,recurrence_exceptions) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
        [
          entityId,
          owner,
          text(source, "title"),
          start,
          end,
          zone,
          source.all_day === true,
          taskId,
          text(source, "notes", ""),
          recurrence,
          json(exceptions),
        ],
      );
    else
      await tx.query(
        "UPDATE calendar_events SET title=$3,starts_at=$4,ends_at=$5,timezone=$6,all_day=$7,task_id=$8,notes=$9,recurrence_rule=$10,recurrence_exceptions=$11::jsonb,revision=revision+1 WHERE event_id=$1 AND owner_id=$2",
        [
          entityId,
          owner,
          text(source, "title"),
          start,
          end,
          zone,
          source.all_day === true,
          taskId,
          text(source, "notes", ""),
          recurrence,
          json(exceptions),
        ],
      );
  }
  return {
    entityId,
    before,
    after: await entity(tx, table, column, entityId, owner),
    affected: taskId ? [taskId] : [],
  };
}
