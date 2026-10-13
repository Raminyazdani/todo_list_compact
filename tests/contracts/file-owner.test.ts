import { expect, it } from "vitest";
import { createIsolatedStagingDatabase } from "../../scripts/migration/staging";
import { createDomainService } from "../../server/domain/service";
import type { Principal } from "../../shared/contracts";
it("an actually existing file owned by another workspace remains unreadable and cannot be linked", async () => {
  const database = await createIsolatedStagingDatabase();
  const first: Principal = {
      ownerId: "synthetic-owner-one",
      actorId: "synthetic-owner-one",
      channel: "UI",
      scopes: ["admin:manage"],
    },
    second = {
      ...first,
      ownerId: "synthetic-owner-two",
      actorId: "synthetic-owner-two",
    };
  try {
    const service = createDomainService(database);
    const file = await service.execute(
      "file_register_external_link",
      {
        title: "Private synthetic source",
        original_filename: "synthetic.txt",
        external_url:
          "https://drive.google.com/file/d/synthetic-private-example/view",
      },
      second,
      { idempotencyKey: "synthetic-owner-two-file" },
    );
    const task = await service.execute(
      "task_create",
      { title: "Synthetic first-owner task" },
      first,
      { idempotencyKey: "synthetic-owner-one-task" },
    );
    await expect(
      service.query("file_get_metadata", { file_id: file.entity_id }, first),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND", status: 404 });
    await expect(
      service.execute(
        "file_link_to_task",
        { file_id: file.entity_id, task_id: task.entity_id },
        first,
        { idempotencyKey: "synthetic-forbidden-cross-owner-link" },
      ),
    ).rejects.toMatchObject({ code: "ENTITY_NOT_FOUND", status: 404 });
    expect(
      (
        await database.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM file_task_links",
        )
      ).rows[0].count,
    ).toBe(0);
    expect(
      await service.query(
        "file_get_metadata",
        { file_id: file.entity_id },
        second,
      ),
    ).toMatchObject({ file_id: file.entity_id, owner_id: second.ownerId });
  } finally {
    await database.close?.();
  }
}, 30000);
