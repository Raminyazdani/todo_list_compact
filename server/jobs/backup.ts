import { createHash } from "node:crypto";
import { get, put } from "@vercel/blob";
import { getDatabase } from "../db/database";
import { getDomainService } from "../domain/service";
import { verifyBackupManifest } from "../domain/migration";
import { encryptBackup, decryptBackup } from "../integrations/backup";
import { DomainError, type Principal } from "../../shared/contracts";

const MAX_BYTES = 70 * 1024 * 1024;
async function boundedBytes(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > MAX_BYTES) {
        await reader.cancel();
        throw new Error("BACKUP_TOO_LARGE");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
/** A verified backup is recorded only after private provider read-back and authenticated decryption. */
export async function runEncryptedBackup(
  ownerId: string,
  day = new Date().toISOString().slice(0, 10),
) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day))
    throw new DomainError("INVALID_INPUT", "Invalid backup day");
  const configured =
    !!process.env.BLOB_READ_WRITE_TOKEN && !!process.env.BACKUP_ENCRYPTION_KEY;
  const backupId =
    "BACKUP_" +
    createHash("sha256")
      .update(ownerId + ":" + day)
      .digest("hex")
      .slice(0, 40);
  const database = getDatabase();
  const accepted = await database.query<{ status: string }>(
    "SELECT status FROM backup_runs WHERE owner_id=$1 AND backup_id=$2",
    [ownerId, backupId],
  );
  if (accepted.rows[0]?.status === "verified")
    return { backup_id: backupId, status: "verified", replayed: true };
  if (!configured) {
    await database.query(
      `INSERT INTO backup_runs(backup_id,owner_id,status,errorcode) VALUES($1,$2,'disconnected','PRIVATE_BACKUP_NOT_CONFIGURED')
      ON CONFLICT(backup_id) DO UPDATE SET status='disconnected',errorcode='PRIVATE_BACKUP_NOT_CONFIGURED'`,
      [backupId, ownerId],
    );
    return { backup_id: backupId, status: "disconnected", verified: false };
  }
  const storageKey =
    "life-os-backups/" +
    createHash("sha256").update(ownerId).digest("hex").slice(0, 32) +
    "/" +
    day +
    ".json";
  const token = process.env.BLOB_READ_WRITE_TOKEN!;
  try {
    // An uncertain previous put must be reconciled before another attempt; immutable keys prevent overwrite.
    let stored = await get(storageKey, { access: "private", token });
    let expectedManifest: string | null = null;
    if (!stored?.stream || stored.statusCode !== 200) {
      const principal: Principal = {
        ownerId,
        actorId: "approved-backup-scheduler",
        channel: "system",
        scopes: ["admin:manage", "backup:export"],
      };
      const backup = (await getDomainService().query(
        "backup_export",
        {},
        principal,
      )) as { owner_id: string; manifest_hash: string };
      expectedManifest = backup.manifest_hash;
      const encrypted = await encryptBackup(
        backup,
        process.env.BACKUP_ENCRYPTION_KEY!,
      );
      const bytes = Buffer.from(JSON.stringify(encrypted));
      if (bytes.length > MAX_BYTES) throw new Error("BACKUP_TOO_LARGE");
      await put(storageKey, bytes, {
        access: "private",
        token,
        addRandomSuffix: false,
        allowOverwrite: false,
        contentType: "application/json",
      });
      stored = await get(storageKey, { access: "private", token });
    }
    if (!stored?.stream || stored.statusCode !== 200)
      throw new Error("BACKUP_READBACK_FAILED");
    const bytes = await boundedBytes(stored.stream);
    const restored = (await decryptBackup(
      JSON.parse(bytes.toString("utf8")),
      process.env.BACKUP_ENCRYPTION_KEY!,
    )) as { owner_id?: string; manifest_hash?: string; tables?: unknown };
    verifyBackupManifest(restored, ownerId);
    if (
      restored.owner_id !== ownerId ||
      !restored.tables ||
      !restored.manifest_hash ||
      (expectedManifest && restored.manifest_hash !== expectedManifest)
    )
      throw new Error("BACKUP_MANIFEST_MISMATCH");
    await database.query(
      `INSERT INTO backup_runs(backup_id,owner_id,status,storage_key,manifest_hash,verified_at) VALUES($1,$2,'verified',$3,$4,now())
      ON CONFLICT(backup_id) DO UPDATE SET status='verified',storage_key=$3,manifest_hash=$4,verified_at=now(),errorcode=NULL`,
      [backupId, ownerId, storageKey, restored.manifest_hash],
    );
    return {
      backup_id: backupId,
      status: "verified",
      verified: true,
      manifest_hash: restored.manifest_hash,
    };
  } catch {
    await database.query(
      `INSERT INTO backup_runs(backup_id,owner_id,status,errorcode) VALUES($1,$2,'failed','PRIVATE_BACKUP_FAILED')
      ON CONFLICT(backup_id) DO UPDATE SET status='failed',errorcode='PRIVATE_BACKUP_FAILED'`,
      [backupId, ownerId],
    );
    return {
      backup_id: backupId,
      status: "failed",
      verified: false,
      error_code: "PRIVATE_BACKUP_FAILED",
    };
  }
}
