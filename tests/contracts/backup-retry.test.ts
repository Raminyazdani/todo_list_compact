import { expect, it } from "vitest";
import { createIsolatedStagingDatabase } from "../../scripts/migration/staging";
import { createDomainService } from "../../server/domain/service";
import type { Principal } from "../../shared/contracts";
it("restored accepted operation IDs prevent duplicate writes from retries made before the backup", async () => {
  const original = await createIsolatedStagingDatabase(),
    target = await createIsolatedStagingDatabase();
  const principal: Principal = {
    ownerId: "synthetic-recovery-owner",
    actorId: "synthetic-recovery-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  try {
    const first = createDomainService(original),
      restored = createDomainService(target);
    const input = { title: "Synthetic retry crossing restore" },
      options = { idempotencyKey: "synthetic-original-operation-key" };
    const accepted = await first.execute(
      "task_create",
      input,
      principal,
      options,
    );
    const backup = await first.query("backup_export", {}, principal);
    await restored.execute(
      "backup_restore",
      { backup, explicit_user_intent: true },
      principal,
      { idempotencyKey: "synthetic-new-restore-operation-key" },
    );
    const retry = await restored.execute(
      "task_create",
      input,
      principal,
      options,
    );
    expect(retry.replayed).toBe(true);
    expect(retry.entity_id).toBe(accepted.entity_id);
    expect(
      (
        await target.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM tasks WHERE owner_id=$1",
          [principal.ownerId],
        )
      ).rows[0].count,
    ).toBe(1);
  } finally {
    await original.close?.();
    await target.close?.();
  }
}, 30000);
