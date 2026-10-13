import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  getDatabase,
  migrateDatabase,
  type Database,
} from "../../server/db/database";
import { createDomainService } from "../../server/domain/service";
import type {
  DomainService,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";

describe.skipIf(process.env.TEST_POSTGRES !== "1")(
  "Real staging PostgreSQL multi-connection concurrency",
  () => {
    let db: Database, service: DomainService;
    const principal: Principal = {
      ownerId: `staging-synthetic-race-${randomUUID()}`,
      actorId: "synthetic-test-runner",
      channel: "UI",
      scopes: ["admin:manage"],
    };
    beforeAll(async () => {
      db = getDatabase();
      await migrateDatabase(db);
      service = createDomainService(db);
    }, 30000);
    afterAll(async () => {
      await db.close?.();
    });
    it("postgres_simultaneous_edge_writes_cannot_create_cycle", async () => {
      const a = await service.execute(
          "task_create",
          { title: "Synthetic staging race A" },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        b = await service.execute(
          "task_create",
          { title: "Synthetic staging race B" },
          principal,
          { idempotencyKey: randomUUID() },
        );
      const [pa, pb] = (await Promise.all([
        service.query(
          "task_dependency_add_preview",
          { task_id: a.entity_id, prerequisites: [{ task_id: b.entity_id }] },
          principal,
        ),
        service.query(
          "task_dependency_add_preview",
          { task_id: b.entity_id, prerequisites: [{ task_id: a.entity_id }] },
          principal,
        ),
      ])) as [PreviewDTO, PreviewDTO];
      const results = await Promise.allSettled([
        service.execute(
          "task_dependency_add_commit",
          { preview_id: pa.preview_id },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        service.execute(
          "task_dependency_add_commit",
          { preview_id: pb.preview_id },
          principal,
          { idempotencyKey: randomUUID() },
        ),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      const rejected = results.find(
        (result) => result.status === "rejected",
      ) as PromiseRejectedResult;
      expect(["REVISION_CONFLICT", "DEPENDENCY_CYCLE"]).toContain(
        rejected.reason.code,
      );
      const [ta, tb] = (await Promise.all([
        service.query("task_get", { task_id: a.entity_id }, principal),
        service.query("task_get", { task_id: b.entity_id }, principal),
      ])) as [TaskDTO, TaskDTO];
      expect(ta.prerequisites.length + tb.prerequisites.length).toBe(1);
    }, 30000);
    it("postgres_direct_concurrent_writers_are_guarded_by_database_trigger", async () => {
      const a = await service.execute(
          "task_create",
          { title: "Synthetic direct guard A" },
          principal,
          { idempotencyKey: randomUUID() },
        ),
        b = await service.execute(
          "task_create",
          { title: "Synthetic direct guard B" },
          principal,
          { idempotencyKey: randomUUID() },
        );
      const write = (dependent: string, prerequisite: string) =>
        db.transaction(principal.ownerId, async (tx) => {
          const group = randomUUID();
          await tx.query(
            "INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id) VALUES($1,$2,$3)",
            [group, principal.ownerId, dependent],
          );
          await tx.query(
            "INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id) VALUES($1,$2,$3,$4)",
            [randomUUID(), principal.ownerId, group, prerequisite],
          );
        });
      const results = await Promise.allSettled([
        write(a.entity_id, b.entity_id),
        write(b.entity_id, a.entity_id),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        String(
          (
            results.find(
              (r) => r.status === "rejected",
            ) as PromiseRejectedResult
          ).reason,
        ),
      ).toContain("DEPENDENCY_CYCLE");
    }, 30000);
  },
);
