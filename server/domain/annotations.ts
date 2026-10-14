import { DomainError } from "../../shared/contracts";
import type { SqlClient } from "../db/database";
import { cleanRows, normalizedSearch, type Input } from "./core";

export function fileTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 50)
    throw new DomainError("INVALID_INPUT", "Choose at most50 file tags.");
  const seen = new Set<string>();
  return value.map((tag) => {
    if (
      typeof tag !== "string" ||
      !tag.trim() ||
      tag.trim().length > 80 ||
      /[\u0000-\u001f\u007f]/.test(tag)
    )
      throw new DomainError(
        "INVALID_INPUT",
        "File tags require bounded plain labels.",
      );
    const label = tag.trim(),
      key = normalizedSearch(label);
    if (seen.has(key))
      throw new DomainError("INVALID_INPUT", "Duplicate normalized file tag.");
    seen.add(key);
    return label;
  });
}
export async function fileMetadata(
  tx: SqlClient,
  fileId: string,
  owner: string,
): Promise<Input> {
  const result = await tx.query<Input>(
    `SELECT f.*,COALESCE(a.description,'') description,COALESCE(a.tags,'[]'::jsonb) tags
      FROM files f LEFT JOIN file_annotations a ON a.file_id=f.file_id AND a.owner_id=f.owner_id
      WHERE f.file_id=$1 AND f.owner_id=$2`,
    [fileId, owner],
  );
  if (!result.rows.length)
    throw new DomainError("ENTITY_NOT_FOUND", "File unavailable.", {}, 404);
  return cleanRows(result.rows)[0];
}
export function annotationFields(input: Input, before: Input) {
  if (
    Object.keys(input).some(
      (key) => !["file_id", "description", "tags"].includes(key),
    )
  )
    throw new DomainError(
      "INVALID_INPUT",
      "Only app description and tag annotations may change.",
    );
  if (!Object.hasOwn(input, "description") && !Object.hasOwn(input, "tags"))
    throw new DomainError(
      "INVALID_INPUT",
      "Description or tags must be supplied.",
    );
  if (
    Object.hasOwn(input, "description") &&
    (typeof input.description !== "string" ||
      input.description.length > 10000 ||
      input.description.includes("\u0000"))
  )
    throw new DomainError(
      "INVALID_INPUT",
      "File description requires bounded text.",
    );
  return {
    description: Object.hasOwn(input, "description")
      ? (input.description as string)
      : String(before.description ?? ""),
    tags: Object.hasOwn(input, "tags")
      ? fileTags(input.tags)
      : ((before.tags ?? []) as string[]),
  };
}
