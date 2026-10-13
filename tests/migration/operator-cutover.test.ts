import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { commitMigration } from "../../scripts/migration/commit";
import { prepareMigration } from "../../scripts/migration/core";
import type { rehearseMigration } from "../../scripts/migration/staging";
import { createTestDatabase } from "../domain/database";
import type { Database } from "../../server/db/database";

let root: string,
  repository: string,
  privateDir: string,
  snapshot: string,
  checkpoint: string,
  report: string,
  db: Database,
  clock: number;
const owner = "synthetic-cutover-owner";
const input = () => ({
  source: { modified_time: "2026-10-13T10:00:00.000Z" },
  tables: {
    Tasks: [
      {
        task_id: "original-cutover-" + randomUUID(),
        title: "Synthetic source task",
        status: "Inbox",
        priority: "Normal",
        category: "Other",
        due_date: "",
        created_at: "2026-10-13T09:00:00.000Z",
        updated_at: "2026-10-13T09:00:00.000Z",
        revision: 1,
      },
    ],
    Files: [],
    Links: [],
    Activity: [],
    Settings: [],
    Guide: [],
  },
});
const rehearsed = () =>
  vi.fn(
    async () =>
      ({ pass: true }) as Awaited<ReturnType<typeof rehearseMigration>>,
  );
const options = (
  rehearse = rehearsed(),
  database: () => Database = vi.fn(() => ({ ...db, close: vi.fn() })),
) => ({
  repositoryRoot: repository,
  environment: {
    OWNER_ID: owner,
    DATABASE_URL:
      "postgresql://synthetic:synthetic@localhost:5432/cutover_fixture",
  },
  now: () => clock,
  rehearse,
  database,
});
const args = () => [snapshot, checkpoint, report, "--commit"];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "life-os-cutover-"));
  repository = join(root, "repository");
  privateDir = join(root, "private");
  await mkdir(repository);
  await mkdir(privateDir);
  snapshot = join(privateDir, "source.json");
  checkpoint = join(privateDir, "checkpoint.json");
  report = join(privateDir, "report.json");
  clock = Date.parse("2026-10-13T10:10:00.000Z");
  const source = input();
  await writeFile(snapshot, JSON.stringify(source));
  await writeFile(
    checkpoint,
    JSON.stringify({
      verified_at: new Date(clock).toISOString(),
      source_modified_time: source.source.modified_time,
      source_hash: prepareMigration(source).sourceHash,
    }),
  );
  db = await createTestDatabase();
}, 30000);
afterEach(async () => {
  await db.close?.();
  const target = await realpath(root),
    parent = await realpath(tmpdir());
  if (
    !target
      .toLowerCase()
      .startsWith(join(parent, "life-os-cutover-").toLowerCase())
  )
    throw new Error("Unsafe cutover fixture cleanup path.");
  await rm(target, { recursive: true, force: true });
});
describe("production cutover operator admission on actual isolated filesystem and PostgreSQL", () => {
  it("rejects relative/private-in-Git/junction report paths before acquiring a writer", async () => {
    const deps = options();
    for (const unsafe of [
      "relative-private.json",
      join(repository, "dump.json"),
    ])
      await expect(
        commitMigration([snapshot, checkpoint, unsafe, "--commit"], deps),
      ).rejects.toThrow(/absolute|outside Git/);
    const junction = join(privateDir, "public-junction");
    await symlink(repository, junction, "junction");
    await expect(
      commitMigration(
        [snapshot, checkpoint, join(junction, "dump.json"), "--commit"],
        deps,
      ),
    ).rejects.toThrow(/outside Git/);
    expect(deps.database).not.toHaveBeenCalled();
    expect(deps.rehearse).not.toHaveBeenCalled();
  });
  it("preserves an unrelated existing report byte-for-byte and refuses the writer", async () => {
    const prior = '{"status":"verified","source_hash":"unrelated-preserved"}\n';
    await writeFile(report, prior);
    const deps = options();
    await expect(commitMigration(args(), deps)).rejects.toThrow(
      /another migration intent/,
    );
    expect(await readFile(report, "utf8")).toBe(prior);
    expect(deps.database).not.toHaveBeenCalled();
  });
  it("rechecks source age after a long rehearsal before report reservation or database mutation", async () => {
    const rehearsal = vi.fn(async () => {
      clock += 600001;
      return { pass: true } as Awaited<ReturnType<typeof rehearseMigration>>;
    });
    const deps = options(rehearsal);
    await expect(commitMigration(args(), deps)).rejects.toThrow(/stale/);
    expect(deps.database).not.toHaveBeenCalled();
    await expect(stat(report)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("durably reserves pending evidence before acquiring a writer and retains it on pre-acceptance connection failure", async () => {
    const failure = vi.fn(() => {
      throw new Error("Synthetic connection unavailable");
    });
    const deps = options(rehearsed(), failure);
    await expect(commitMigration(args(), deps)).rejects.toThrow(/unavailable/);
    const saved = JSON.parse(await readFile(report, "utf8"));
    expect(saved).toMatchObject({
      format: "ramin-life-os-migration-cutover/1",
      status: "pending",
      owner_id: owner,
    });
    expect((await db.query("SELECT task_id FROM tasks")).rows).toHaveLength(0);
  });
  it("recovers an uncertain accepted transaction through the original canonical key without duplicate source rows or audit events", async () => {
    let acceptedResponseLost = false;
    const uncertain: Database = {
      ...db,
      close: vi.fn(),
      transaction: async (ownerId, action) => {
        const result = await db.transaction(ownerId, action);
        if (!acceptedResponseLost) {
          acceptedResponseLost = true;
          throw new Error("Synthetic accepted response lost");
        }
        return result;
      },
    };
    const deps = options(
      rehearsed(),
      vi.fn(() => uncertain),
    );
    await expect(commitMigration(args(), deps)).rejects.toThrow(
      /accepted response lost/,
    );
    expect(JSON.parse(await readFile(report, "utf8")).status).toBe("pending");
    const beforeTasks = (
      await db.query("SELECT task_id FROM tasks WHERE owner_id=$1", [owner])
    ).rows;
    const beforeAudit = (
      await db.query("SELECT event_id FROM activity_events WHERE owner_id=$1", [
        owner,
      ])
    ).rows;
    expect(beforeTasks).toHaveLength(1);
    const retry = await commitMigration(args(), options());
    expect(retry).toMatchObject({
      reconciled: true,
      replayed: true,
      source_written: false,
    });
    expect(
      (await db.query("SELECT task_id FROM tasks WHERE owner_id=$1", [owner]))
        .rows,
    ).toEqual(beforeTasks);
    expect(
      (
        await db.query(
          "SELECT event_id FROM activity_events WHERE owner_id=$1",
          [owner],
        )
      ).rows,
    ).toEqual(beforeAudit);
    expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({
      status: "verified",
      reconciliation: { pass: true },
    });
  });
});
