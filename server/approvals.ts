import { randomUUID, createHash } from "node:crypto";
import { getAuthPool } from "@/server/auth/db";
import { DomainError, type Principal } from "@/shared/contracts";
const digest = (command: string, input: Record<string, unknown>) =>
  createHash("sha256")
    .update(JSON.stringify({ command, preview_id: input.preview_id }))
    .digest("hex");
export async function issueConfirmation(
  command: string,
  input: Record<string, unknown>,
  principal: Principal,
) {
  if (
    principal.channel !== "UI" ||
    command !== "task_dependency_waive_commit" ||
    typeof input.preview_id !== "string"
  )
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Confirmation requires the owner's web session",
      {},
      403,
    );
  const preview = await getAuthPool().query(
    "SELECT command,input FROM command_previews WHERE preview_id=$1 AND owner_id=$2 AND consumed_at IS NULL AND expires_at>now()",
    [input.preview_id, principal.ownerId],
  );
  if (!preview.rowCount || preview.rows[0].command !== command)
    throw new DomainError(
      "PREVIEW_EXPIRED",
      "Preview expired or belongs to another command",
    );
  const confirmationId = randomUUID();
  await getAuthPool().query(
    "INSERT INTO human_confirmations(confirmation_id,owner_id,actor_id,command,input_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '5 minutes')",
    [
      confirmationId,
      principal.ownerId,
      principal.actorId,
      command,
      digest(command, input),
    ],
  );
  return { confirmation_id: confirmationId, command, expires_in_seconds: 300 };
}
export async function verifyConfirmation(
  confirmationId: string,
  command: string,
  input: Record<string, unknown>,
  operationId: string,
  principal: Principal,
) {
  const result = await getAuthPool().query(
    "UPDATE human_confirmations SET operation_key=$6 WHERE confirmation_id=$1 AND owner_id=$2 AND command=$3 AND input_hash=$4 AND actor_id=$5 AND expires_at>now() AND (operation_key IS NULL OR operation_key=$6) RETURNING confirmation_id",
    [
      confirmationId,
      principal.ownerId,
      command,
      digest(command, input),
      principal.actorId,
      operationId,
    ],
  );
  if (!result.rowCount)
    throw new DomainError(
      "INSUFFICIENT_PERMISSIONS",
      "Open the waiver preview in the web app and obtain a human confirmation ticket",
      {},
      403,
    );
}
