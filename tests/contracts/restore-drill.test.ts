import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Principal, PreviewDTO, TaskDTO } from "../../shared/contracts";
import { createDomainService } from "../../server/domain/service";
import { hash } from "../../server/domain/core";
import { createTestDatabase } from "../domain/database";
import {
  assertPrivatePath,
  assertSeparateDatabases,
  parseDrillArguments,
  restoreDrill,
  validateDrillEnvironment,
} from "../../scripts/ops/restore-drill";

const originalOwner: Principal = {
  ownerId: "synthetic-original-recovery-owner",
  actorId: "synthetic-owner-auth-user",
  channel: "UI",
  scopes: ["admin:manage"],
};

describe("Operator restore drill admission and canonical recovery", () => {
  it("old_populated_v1_calendar_and_notifications_restore_all_original_fields_with_only_registered_additive_defaults", async () => {
    const source = await createTestDatabase(),
      destination = await createTestDatabase();
    try {
      const service = createDomainService(source);
      const event = await service.execute(
        "calendar_create_local_event",
        {
          title: "Synthetic old-schema calendar",
          starts_at: "2027-03-28T07:07:00.123Z",
          ends_at: "2027-03-28T08:37:00.123Z",
          timezone: "Europe/Berlin",
        },
        originalOwner,
        { idempotencyKey: "synthetic-old-schema-calendar" },
      );
      await source.query(
        "INSERT INTO notifications(notification_id,owner_id,title,body) VALUES($1,$2,$3,$4)",
        [
          "synthetic-old-notification",
          originalOwner.ownerId,
          "Synthetic old task notice",
          "Exact historical body فارسی",
        ],
      );
      const backup = structuredClone(
        await service.query("backup_export", {}, originalOwner),
      ) as {
        tables: Record<string, Record<string, unknown>[]>;
        checksums: Record<string, string>;
        manifest_hash: string;
      };
      for (const name of ["file_annotations", "event_reminders"]) {
        delete backup.tables[name];
        delete backup.checksums[name];
      }
      for (const row of backup.tables.calendar_events) delete row.category;
      for (const row of backup.tables.notifications) {
        delete row.target_type;
        delete row.target_id;
      }
      for (const [table, rows] of Object.entries(backup.tables))
        backup.checksums[table] = hash(rows);
      backup.manifest_hash = hash(backup.checksums);
      expect(
        await restoreDrill(destination, backup, originalOwner.ownerId, true),
      ).toMatchObject({
        status: "restored",
        original_rows_preserved: true,
        table_counts: { calendar_events: 1, notifications: 1 },
      });
      expect(
        (
          await destination.query(
            "SELECT title,category,starts_at FROM calendar_events WHERE event_id=$1",
            [event.entity_id],
          )
        ).rows[0],
      ).toMatchObject({
        title: "Synthetic old-schema calendar",
        category: "Other",
      });
      expect(
        (
          await destination.query(
            "SELECT body,target_type,target_id FROM notifications WHERE notification_id=$1",
            ["synthetic-old-notification"],
          )
        ).rows[0],
      ).toEqual({
        body: "Exact historical body فارسی",
        target_type: "task",
        target_id: null,
      });
    } finally {
      await source.close?.();
      await destination.close?.();
    }
  });
  it("rejects direct/pooler aliases, credential-only changes and loopback aliases of the source database", () => {
    for (const [source, destination] of [
      [
        "postgresql://user@ep-synthetic.example.test/lifeos",
        "postgres://other@ep-synthetic-pooler.example.test:5432/lifeos?sslmode=require",
      ],
      [
        "postgresql://user@localhost/lifeos",
        "postgresql://other@127.0.0.1:5432/lifeos",
      ],
    ])
      expect(() => assertSeparateDatabases(source, destination)).toThrow(
        "DRILL_SOURCE_EQUALS_DESTINATION",
      );
    expect(() =>
      assertSeparateDatabases(
        "postgresql://localhost/original",
        "postgresql://localhost/staging",
      ),
    ).not.toThrow();
  });

  it("requires explicit drill intent, complete absolute private arguments and rejects repository report/input paths", async () => {
    expect(() => parseDrillArguments([])).toThrow(
      "DRILL_EXPLICIT_INTENT_REQUIRED",
    );
    expect(() =>
      parseDrillArguments(["--restore-drill", "--source-env", "relative.env"]),
    ).toThrow("DRILL_PRIVATE_ABSOLUTE_PATHS_REQUIRED");
    const root = fileURLToPath(new URL("../../", import.meta.url));
    await expect(assertPrivatePath(join(root, "package.json"))).rejects.toThrow(
      "DRILL_PRIVATE_PATH_INSIDE_REPOSITORY",
    );
    await expect(
      assertPrivatePath(join(root, "synthetic-report.json"), root, true),
    ).rejects.toThrow("DRILL_PRIVATE_PATH_INSIDE_REPOSITORY");
    await expect(
      assertPrivatePath(
        join(tmpdir(), "synthetic-lifeos-drill-report.json"),
        root,
        true,
      ),
    ).resolves.toBeTruthy();
  });

  it("requires a staging marker and an app owner different from the preserved source owner before connecting", () => {
    const source = {
      DATABASE_URL: "postgresql://localhost/original",
      OWNER_ID: "synthetic-source-owner",
    };
    const destination = {
      DATABASE_URL: "postgresql://localhost/staging",
      OWNER_ID: "synthetic-staging-owner",
      RESTORE_DRILL_DESTINATION: "isolated-staging",
    };
    expect(() => validateDrillEnvironment(source, destination)).not.toThrow();
    expect(() =>
      validateDrillEnvironment(source, {
        ...destination,
        RESTORE_DRILL_DESTINATION: "production",
      }),
    ).toThrow("DRILL_STAGING_ISOLATION_CONFIGURATION_REQUIRED");
    expect(() =>
      validateDrillEnvironment(source, {
        ...destination,
        OWNER_ID: source.OWNER_ID,
      }),
    ).toThrow("DRILL_STAGING_ISOLATION_CONFIGURATION_REQUIRED");
  });

  it("retains original owner, graph/checklist IDs and exact accepted results while staging app data stays separate", async () => {
    const source = await createTestDatabase(),
      destination = await createTestDatabase();
    try {
      const service = createDomainService(source);
      const originalInput = {
        title: "Synthetic accepted intent before snapshot",
      };
      const options = { idempotencyKey: "synthetic-original-accepted-intent" };
      const accepted = await service.execute(
        "task_create",
        originalInput,
        originalOwner,
        options,
      );
      const prerequisite = await service.execute(
        "task_create",
        { title: "Synthetic prerequisite" },
        originalOwner,
        { idempotencyKey: "synthetic-prerequisite-intent" },
      );
      const preview = (await service.query(
        "task_dependency_add_preview",
        {
          task_id: accepted.entity_id,
          prerequisites: [{ task_id: prerequisite.entity_id }],
        },
        originalOwner,
      )) as PreviewDTO;
      await service.execute(
        "task_dependency_add_commit",
        { preview_id: preview.preview_id },
        originalOwner,
        { idempotencyKey: "synthetic-link-intent" },
      );
      const checklist = await service.execute(
        "task_checklist_create",
        { task_id: accepted.entity_id, title: "Synthetic original checklist" },
        originalOwner,
        { idempotencyKey: "synthetic-checklist-intent" },
      );
      const item = await service.execute(
        "task_checklist_item_add",
        { checklist_id: checklist.entity_id, title: "Synthetic original item" },
        originalOwner,
        { idempotencyKey: "synthetic-item-intent", expectedRevision: 1 },
      );
      const stagingOwner = {
        ...originalOwner,
        ownerId: "synthetic-staging-app-owner",
      };
      const stagingService = createDomainService(destination);
      const stagingAccepted = await stagingService.execute(
        "task_create",
        { title: "Synthetic staging app task" },
        stagingOwner,
        { idempotencyKey: "synthetic-staging-existing-intent" },
      );
      const backup = await service.query("backup_export", {}, originalOwner);
      const result = await restoreDrill(
        destination,
        backup,
        originalOwner.ownerId,
        true,
      );
      expect(result).toMatchObject({
        accepted_results_preserved: true,
        original_rows_preserved: true,
        accepted_operation_count: 5,
        table_counts: {
          tasks: 2,
          task_dependency_edges: 1,
          task_checklist_items: 1,
        },
      });
      const retry = await stagingService.execute(
        "task_create",
        originalInput,
        originalOwner,
        options,
      );
      expect(retry).toEqual({ ...accepted, replayed: true });
      const recovered = (await stagingService.query(
        "task_get",
        { task_id: accepted.entity_id },
        originalOwner,
      )) as TaskDTO;
      expect(recovered.prerequisites[0].prerequisite_task_id).toBe(
        prerequisite.entity_id,
      );
      expect(recovered.checklists?.[0].items[0].item_id).toBe(item.entity_id);
      expect(
        (
          (await stagingService.query(
            "task_get",
            { task_id: stagingAccepted.entity_id },
            stagingOwner,
          )) as TaskDTO
        ).title,
      ).toBe("Synthetic staging app task");
      await expect(
        stagingService.query(
          "task_get",
          { task_id: accepted.entity_id },
          stagingOwner,
        ),
      ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
      await expect(
        restoreDrill(destination, backup, originalOwner.ownerId, true),
      ).rejects.toThrow("DRILL_DESTINATION_OWNER_NOT_EMPTY");
    } finally {
      await source.close?.();
      await destination.close?.();
    }
  });

  it("rejects absent intent, a tampered manifest, another owner and even an existing empty owner before restoration", async () => {
    const source = await createTestDatabase(),
      destination = await createTestDatabase();
    try {
      const backup = (await createDomainService(source).query(
        "backup_export",
        {},
        originalOwner,
      )) as Record<string, unknown>;
      await expect(
        restoreDrill(destination, backup, originalOwner.ownerId, false),
      ).rejects.toThrow("DRILL_EXPLICIT_INTENT_REQUIRED");
      await expect(
        restoreDrill(
          destination,
          { ...backup, manifest_hash: "synthetic-tampered" },
          originalOwner.ownerId,
          true,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        restoreDrill(destination, backup, "synthetic-wrong-owner", true),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
      const unsupportedRows = [
        {
          owner_id: originalOwner.ownerId,
          title: "Synthetic unsupported schema content",
        },
      ];
      const checksums = {
        ...(backup.checksums as Record<string, string>),
        unsupported_records: hash(unsupportedRows),
      };
      await expect(
        restoreDrill(
          destination,
          {
            ...backup,
            tables: {
              ...(backup.tables as Record<string, unknown>),
              unsupported_records: unsupportedRows,
            },
            checksums,
            manifest_hash: hash(checksums),
          },
          originalOwner.ownerId,
          true,
        ),
      ).rejects.toThrow("DRILL_UNSUPPORTED_BACKUP_TABLE");
      expect(
        (await destination.query("SELECT owner_id FROM owners")).rows,
      ).toEqual([]);
      await destination.query("INSERT INTO owners(owner_id) VALUES($1)", [
        originalOwner.ownerId,
      ]);
      await expect(
        restoreDrill(destination, backup, originalOwner.ownerId, true),
      ).rejects.toThrow("DRILL_DESTINATION_OWNER_NOT_EMPTY");
    } finally {
      await source.close?.();
      await destination.close?.();
    }
  });

  it("rolls back the full restore when preserved IDs collide with a separate owner", async () => {
    const source = await createTestDatabase(),
      destination = await createTestDatabase();
    try {
      const service = createDomainService(source);
      const task = await service.execute(
        "task_create",
        { title: "Synthetic ID collision source" },
        originalOwner,
        { idempotencyKey: "synthetic-collision-original-intent" },
      );
      const backup = await service.query("backup_export", {}, originalOwner);
      await destination.query(
        "INSERT INTO owners(owner_id) VALUES('synthetic-collision-staging-owner')",
      );
      await destination.query(
        "INSERT INTO tasks(task_id,owner_id,title) VALUES($1,'synthetic-collision-staging-owner','Synthetic conflicting task')",
        [task.entity_id],
      );
      await expect(
        restoreDrill(destination, backup, originalOwner.ownerId, true),
      ).rejects.toThrow();
      expect(
        (
          await destination.query(
            "SELECT owner_id FROM owners WHERE owner_id=$1",
            [originalOwner.ownerId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await destination.query(
            "SELECT * FROM idempotency_operations WHERE owner_id=$1",
            [originalOwner.ownerId],
          )
        ).rows,
      ).toEqual([]);
      expect(
        (
          await destination.query("SELECT title FROM tasks WHERE task_id=$1", [
            task.entity_id,
          ])
        ).rows,
      ).toEqual([{ title: "Synthetic conflicting task" }]);
    } finally {
      await source.close?.();
      await destination.close?.();
    }
  });
});
