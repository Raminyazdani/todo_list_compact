import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Database } from "../../../server/db/database";
import type {
  DomainService,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../../shared/contracts";

// This executable is called only by the opt-in real-PG test. Never print its
// connection, synthetic IDs, data rows or a raw driver/assertion stack.
let step = "ADMISSION",
  database: Database | undefined,
  restored: Database | undefined;
try {
  assert.equal(process.env.TEST_POSTGRES, "1");
  assert.ok(process.env.DATABASE_URL);
  assert.ok(
    ["Europe/Berlin", "Asia/Tokyo", "America/Los_Angeles"].includes(
      process.env.TZ ?? "",
    ),
  );
  const { getDatabase } = await import("../../../server/db/database");
  const { createDomainService } =
    await import("../../../server/domain/service");
  const { createTestDatabase } = await import("../database");
  database = getDatabase();
  const service: DomainService = createDomainService(database);
  const principal: Principal = {
    ownerId: "staging-synthetic-date-" + randomUUID(),
    actorId: "synthetic-date-probe",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  const read = (id: string) =>
    service.query("task_get", { task_id: id }, principal) as Promise<TaskDTO>;
  step = "NATIVE_DATE_AND_TIMESTAMP_READ";
  const native = (
    await database.query<{
      due_date: string;
      leap_date: string;
      old_date: string;
      absent: null;
      instant: Date;
    }>(
      "SELECT DATE '2055-12-20' AS due_date, DATE '2028-02-29' AS leap_date, DATE '1999-12-31' AS old_date, NULL::date AS absent, TIMESTAMPTZ '2027-03-28T08:00:00Z' AS instant",
    )
  ).rows[0];
  assert.deepEqual(
    [native.due_date, native.leap_date, native.old_date, native.absent],
    ["2055-12-20", "2028-02-29", "1999-12-31", null],
  );
  assert.ok(native.instant instanceof Date);
  assert.equal(native.instant.toISOString(), "2027-03-28T08:00:00.000Z");

  step = "CANONICAL_TASK_READBACK";
  const created = await service.execute(
    "task_create",
    {
      title: "Synthetic immutable local-date deadline",
      due_date: "2055-12-20",
      start_date: "2055-12-01",
      due_at: "2055-12-20T22:45:00.123Z",
    },
    principal,
    { idempotencyKey: randomUUID() },
  );
  assert.equal((await read(created.entity_id)).due_date, "2055-12-20");
  assert.equal((await read(created.entity_id)).start_date, "2055-12-01");
  step = "START_ONLY_PLAN_PRESERVES_DEADLINE";
  const preview = (await service.query(
    "task_batch_preview",
    {
      actions: [
        {
          command: "task_update",
          input: { task_id: created.entity_id, start_date: "2055-12-02" },
        },
      ],
    },
    principal,
  )) as PreviewDTO;
  await service.execute(
    "task_batch_commit",
    { preview_id: preview.preview_id },
    principal,
    { idempotencyKey: randomUUID() },
  );
  assert.equal((await read(created.entity_id)).start_date, "2055-12-02");
  assert.equal((await read(created.entity_id)).due_date, "2055-12-20");
  assert.equal(
    (await read(created.entity_id)).due_at,
    "2055-12-20T22:45:00.123Z",
  );

  step = "SOURCE_DATE_PRESERVATION";
  const sourceId = "T-synthetic-source-date-" + randomUUID();
  await service.execute(
    "legacy_import",
    {
      batch_id: randomUUID(),
      source_hash: "synthetic-date-source",
      tasks: [
        {
          task_id: sourceId,
          title: "Synthetic original source deadline",
          status: "Inbox",
          due_date: "2055-12-20",
          due_at: "2055-12-20T22:45:00.123Z",
          created_at: "2055-12-01T09:30:00.123Z",
          revision: 1,
        },
      ],
    },
    principal,
    { idempotencyKey: randomUUID() },
  );
  const imported = await read(sourceId);
  assert.equal(imported.due_date, "2055-12-20");
  assert.equal(imported.legacy_metadata.due_date, "2055-12-20");
  assert.equal(imported.created_at, "2055-12-01T09:30:00.123Z");
  const lexical = (
    await database.query<{ due_date: string }>(
      "SELECT due_date::text FROM tasks WHERE owner_id=$1 AND task_id=$2",
      [principal.ownerId, sourceId],
    )
  ).rows[0];
  assert.equal(imported.due_date, lexical.due_date);
  const time = await service.execute(
    "time_entry_create",
    {
      employer: "Synthetic date backup time",
      starts_at: "2055-12-19T23:00:00Z",
      ends_at: "2055-12-20T01:00:00Z",
    },
    principal,
    { idempotencyKey: randomUUID() },
  );

  step = "ACTUAL_POSTGRES_BACKUP_DATE_PRESERVATION";
  const backup = (await service.query("backup_export", {}, principal)) as {
    tables: Record<string, Record<string, unknown>[]>;
  };
  const exportedTask = backup.tables.tasks.find(
    (row) => row.task_id === created.entity_id,
  );
  assert.equal(exportedTask?.due_date, "2055-12-20");
  assert.equal(exportedTask?.start_date, "2055-12-02");
  const exportedSource = backup.tables.tasks.find(
    (row) => row.task_id === sourceId,
  );
  assert.equal(exportedSource?.due_date, "2055-12-20");
  const exportedTime = backup.tables.time_entries.find(
    (row) => row.entry_id === time.entity_id,
  );
  assert.equal(exportedTime?.starts_at, "2055-12-19T23:00:00.000Z");
  assert.equal(exportedTime?.ends_at, "2055-12-20T01:00:00.000Z");

  // Restore the actual driver's portable snapshot with original owner/IDs into
  // a fresh isolated real PostgreSQL engine. No live schemas, deletes or source
  // owner rows are touched. Hosted PG restore remains the coordinator's drill.
  step = "FRESH_ENGINE_RESTORE_PRESERVES_ORIGINAL_IDS_AND_DATES";
  restored = await createTestDatabase();
  const destination = createDomainService(restored);
  await destination.execute(
    "backup_restore",
    { backup, explicit_user_intent: true },
    principal,
    { idempotencyKey: randomUUID() },
  );
  const restoredTask = (await destination.query(
    "task_get",
    { task_id: created.entity_id },
    principal,
  )) as TaskDTO;
  assert.equal(restoredTask.task_id, created.entity_id);
  assert.equal(restoredTask.due_date, "2055-12-20");
  assert.equal(restoredTask.start_date, "2055-12-02");
  assert.equal(restoredTask.due_at, "2055-12-20T22:45:00.123Z");
  const restoredSource = (await destination.query(
    "task_get",
    { task_id: sourceId },
    principal,
  )) as TaskDTO;
  assert.equal(restoredSource.due_date, "2055-12-20");
  assert.equal(restoredSource.legacy_metadata.due_date, "2055-12-20");
  assert.equal(restoredSource.created_at, "2055-12-01T09:30:00.123Z");
  process.stdout.write("POSTGRES_DATE_PROBE_PASS\n");
} catch {
  process.stderr.write("POSTGRES_DATE_PROBE_FAILED_AT_" + step + "\n");
  process.exitCode = 1;
} finally {
  await restored?.close?.().catch(() => undefined);
  await database?.close?.().catch(() => undefined);
}
