import {
  DomainError,
  type CommandName,
  type Principal,
} from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import {
  bumpTask,
  entity,
  guard,
  id,
  optionalText,
  text,
  type Input,
} from "./core";
import type { Change } from "./tasks";

export async function knowledgeCommand(
  tx: SqlClient,
  command: CommandName,
  input: Input,
  principal: Principal,
  revision: number | undefined,
): Promise<Change> {
  const owner = principal.ownerId;
  if (command === "task_comment_add") {
    const taskId = text(input, "task_id");
    await entity(tx, "tasks", "task_id", taskId, owner);
    const commentId = id("COMMENT");
    await tx.query(
      "INSERT INTO task_comments(comment_id,owner_id,task_id,body,actor_id) VALUES($1,$2,$3,$4,$5)",
      [
        commentId,
        owner,
        taskId,
        text(input, "body", undefined, 20000),
        principal.actorId,
      ],
    );
    return {
      entityId: commentId,
      before: null,
      after: await entity(tx, "task_comments", "comment_id", commentId, owner),
      affected: [taskId],
    };
  }
  if (command === "task_comment_update" || command === "task_comment_archive") {
    const commentId = text(input, "comment_id"),
      before = await entity(
        tx,
        "task_comments",
        "comment_id",
        commentId,
        owner,
      );
    guard(before, revision);
    if (command === "task_comment_update")
      await tx.query(
        "UPDATE task_comments SET body=$3,revision=revision+1 WHERE comment_id=$1 AND owner_id=$2",
        [commentId, owner, text(input, "body", undefined, 20000)],
      );
    else
      await tx.query(
        "UPDATE task_comments SET archived_at=now(),revision=revision+1 WHERE comment_id=$1 AND owner_id=$2",
        [commentId, owner],
      );
    return {
      entityId: commentId,
      before,
      after: await entity(tx, "task_comments", "comment_id", commentId, owner),
      affected: [String(before.task_id)],
    };
  }
  if (command === "tag_create") {
    const title = text(input, "title", undefined, 200),
      color = text(input, "color", "#64748b");
    if (!/^#[0-9a-fA-F]{6}$/.test(color))
      throw new DomainError(
        "INVALID_INPUT",
        "Tag color must be a six-digit hex color.",
      );
    const existing = await tx.query<Input>(
      "SELECT * FROM tags WHERE owner_id=$1 AND title=$2",
      [owner, title],
    );
    if (existing.rows[0])
      return {
        entityId: String(existing.rows[0].tag_id),
        before: existing.rows[0],
        after: existing.rows[0],
        affected: [],
      };
    const tagId = id("TAG");
    await tx.query(
      "INSERT INTO tags(tag_id,owner_id,title,color) VALUES($1,$2,$3,$4)",
      [tagId, owner, title, color],
    );
    return {
      entityId: tagId,
      before: null,
      after: await entity(tx, "tags", "tag_id", tagId, owner),
      affected: [],
    };
  }
  if (command === "task_tag_link" || command === "task_tag_unlink") {
    const taskId = text(input, "task_id"),
      tagId = text(input, "tag_id");
    const task = await entity(tx, "tasks", "task_id", taskId, owner);
    await entity(tx, "tags", "tag_id", tagId, owner);
    const existing = await tx.query<Input>(
      "SELECT * FROM task_tags WHERE owner_id=$1 AND task_id=$2 AND tag_id=$3",
      [owner, taskId, tagId],
    );
    const before = existing.rows[0] ?? null;
    if (command === "task_tag_unlink") guard(task, revision);
    const linkId = before ? String(before.link_id) : id("TT");
    if (!before) {
      if (command === "task_tag_unlink")
        throw new DomainError(
          "ENTITY_NOT_FOUND",
          "Tag relation unavailable.",
          {},
          404,
        );
      await tx.query(
        "INSERT INTO task_tags(link_id,owner_id,task_id,tag_id) VALUES($1,$2,$3,$4)",
        [linkId, owner, taskId, tagId],
      );
    } else
      await tx.query(
        "UPDATE task_tags SET active=$3,revision=revision+1 WHERE link_id=$1 AND owner_id=$2",
        [linkId, owner, command === "task_tag_link"],
      );
    await bumpTask(tx, taskId, owner);
    return {
      entityId: linkId,
      before,
      after: await entity(tx, "task_tags", "link_id", linkId, owner),
      affected: [taskId],
    };
  }
  if (command === "knowledge_create" || command === "knowledge_update") {
    const creation = command === "knowledge_create",
      knowledgeId = creation ? id("K") : text(input, "knowledge_id"),
      before = creation
        ? null
        : await entity(
            tx,
            "knowledge_items",
            "knowledge_id",
            knowledgeId,
            owner,
          );
    if (before) guard(before, revision);
    const merged = { ...before, ...input },
      projectId = optionalText(merged, "project_id");
    if (projectId) await entity(tx, "projects", "project_id", projectId, owner);
    const url = optionalText(merged, "url");
    if (url) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new DomainError("INVALID_INPUT", "Invalid knowledge link URL.");
      }
      if (parsed.protocol !== "https:" || parsed.username || parsed.password)
        throw new DomainError(
          "INVALID_INPUT",
          "Knowledge links require HTTPS and no embedded credentials.",
        );
    }
    if (creation)
      await tx.query(
        "INSERT INTO knowledge_items(knowledge_id,owner_id,project_id,title,body,url) VALUES($1,$2,$3,$4,$5,$6)",
        [
          knowledgeId,
          owner,
          projectId,
          text(merged, "title"),
          text(merged, "body", "", 50000),
          url,
        ],
      );
    else
      await tx.query(
        "UPDATE knowledge_items SET project_id=$3,title=$4,body=$5,url=$6,revision=revision+1 WHERE knowledge_id=$1 AND owner_id=$2",
        [
          knowledgeId,
          owner,
          projectId,
          text(merged, "title"),
          text(merged, "body", "", 50000),
          url,
        ],
      );
    return {
      entityId: knowledgeId,
      before,
      after: await entity(
        tx,
        "knowledge_items",
        "knowledge_id",
        knowledgeId,
        owner,
      ),
      affected: [],
    };
  }
  throw new DomainError(
    "UNSUPPORTED_OPERATION",
    "Knowledge command unavailable.",
  );
}
