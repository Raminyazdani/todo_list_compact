import { readFile } from "node:fs/promises";
import { getDatabase, type Database } from "../../server/db/database";
import { getDomainService } from "../../server/domain/service";
import { object } from "../../server/domain/core";
import { verifyBackupManifest } from "../../server/domain/migration";
import { decryptBackup, encryptBackup } from "../../server/integrations/backup";
import {
  admitPrivatePath,
  writeExclusivePrivateJson,
} from "./private-paths.mjs";

let database: Database | undefined;

async function main() {
  const [intent, output, ...extra] = process.argv.slice(2);
  if (intent !== "--export-backup" || !output || extra.length)
    throw new Error("BACKUP_EXPLICIT_EXPORT_REQUIRED");
  const ownerId = process.env.OWNER_ID;
  const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
  if (!ownerId || !encryptionKey || !process.env.DATABASE_URL)
    throw new Error("BACKUP_CONFIGURATION_INCOMPLETE");
  const target = await admitPrivatePath(output);
  database = getDatabase();
  const backup = object(
    await getDomainService().query(
      "backup_export",
      {},
      {
        ownerId,
        actorId: "authorized-backup-operator",
        channel: "system",
        scopes: ["admin:manage", "backup:export"],
      },
    ),
  );
  const tables = verifyBackupManifest(backup, ownerId);
  const encrypted = await encryptBackup(backup, encryptionKey);
  await writeExclusivePrivateJson(target, encrypted);
  const readback = JSON.parse(await readFile(target, "utf8"));
  const restored = object(await decryptBackup(readback, encryptionKey));
  verifyBackupManifest(restored, ownerId);
  if (restored.manifest_hash !== backup.manifest_hash)
    throw new Error("BACKUP_READBACK_MISMATCH");
  console.log(
    JSON.stringify({
      status: "verified_private_encrypted_export",
      observed_at: new Date().toISOString(),
      table_counts: Object.fromEntries(
        Object.entries(tables).map(([table, rows]) => [table, rows.length]),
      ),
      file_bytes_included: false,
    }),
  );
}
main()
  .catch(() => {
    console.error(
      "BACKUP_EXPORT_FAILED; inspect private output if created; no secret values emitted",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await database?.close?.();
  });
