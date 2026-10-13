import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  DomainService,
  GraphDTO,
  PageDTO,
  PlanDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";

describe("Bounded graph performance on the real PostgreSQL engine", () => {
  let db: Database, service: DomainService;
  const token = `load-${randomUUID()}-`,
    principal: Principal = {
      ownerId: token,
      actorId: "synthetic-load-runner",
      channel: "UI",
      scopes: ["admin:manage"],
    };
  beforeAll(async () => {
    db = await createTestDatabase();
    service = createDomainService(db);
    await db.transaction(principal.ownerId, async (tx) => {
      // Bulk fixture generation is trusted, isolated and analytically acyclic (four
      // root prerequisites -> 7500 leaf dependents). Mutation guards are separately
      // exercised against PGlite and real multi-connection PostgreSQL, and enabled
      // again before measuring queries. This measures reads, not seed-write latency.
      await tx.query("ALTER TABLE tasks DISABLE TRIGGER hierarchy_dag_guard");
      await tx.query(
        "ALTER TABLE tasks DISABLE TRIGGER hierarchy_dag_final_guard",
      );
      await tx.query(
        "ALTER TABLE task_dependency_edges DISABLE TRIGGER dependency_dag_guard",
      );
      await tx.query("INSERT INTO owners(owner_id) VALUES($1)", [token]);
      await tx.query(
        `INSERT INTO projects(project_id,owner_id,title) SELECT $1||'project-'||i,$1,'Synthetic load project '||i FROM generate_series(0,19) i`,
        [token],
      );
      await tx.query(
        `INSERT INTO tasks(task_id,owner_id,title,project_id,parent_task_id,estimated_minutes,sort_key) SELECT $1||'task-'||i,$1,'Synthetic load task '||i,$1||'project-'||(i%20),CASE WHEN i>=200 THEN $1||'task-'||(100+i%100) ELSE NULL END,30,i FROM generate_series(0,9999) i`,
        [token],
      );
      await tx.query(
        `INSERT INTO task_dependency_groups(group_id,owner_id,dependent_task_id) SELECT $1||'group-'||i,$1,$1||'task-'||i FROM generate_series(2500,9999) i`,
        [token],
      );
      await tx.query(
        `INSERT INTO task_dependency_edges(edge_id,owner_id,group_id,prerequisite_task_id) SELECT $1||'edge-'||i,$1,$1||'group-'||(2500+i%7500),$1||'task-'||(i/7500) FROM generate_series(0,29999) i`,
        [token],
      );
      await tx.query("SET CONSTRAINTS ALL IMMEDIATE");
      await tx.query("ALTER TABLE tasks ENABLE TRIGGER hierarchy_dag_guard");
      await tx.query(
        "ALTER TABLE tasks ENABLE TRIGGER hierarchy_dag_final_guard",
      );
      await tx.query(
        "ALTER TABLE task_dependency_edges ENABLE TRIGGER dependency_dag_guard",
      );
    });
  }, 60000);
  afterAll(async () => {
    await db.close?.();
  });
  it("graph_pagination_and_large_dataset_performance", async () => {
    const measurements: Record<string, number> = {};
    let started = performance.now();
    const graph = (await service.query(
      "task_graph_get",
      { limit: 200 },
      principal,
    )) as GraphDTO;
    measurements.graph_page_ms = performance.now() - started;
    expect(graph.nodes).toHaveLength(200);
    expect(graph.total).toBe(10000);
    expect(graph.next_cursor).not.toBeNull();
    started = performance.now();
    const next = (await service.query(
      "task_graph_get",
      { limit: 200, cursor: graph.next_cursor },
      principal,
    )) as GraphDTO;
    measurements.graph_second_page_ms = performance.now() - started;
    expect(
      new Set([...graph.nodes, ...next.nodes].map((t) => t.task_id)).size,
    ).toBe(400);
    started = performance.now();
    const blocked = (await service.query(
      "task_find_blocked",
      { limit: 200 },
      principal,
    )) as PageDTO<TaskDTO>;
    measurements.blocked_page_ms = performance.now() - started;
    expect(blocked.total).toBe(7500);
    expect(blocked.items[0].blocked_by).toHaveLength(4);
    started = performance.now();
    const plan = (await service.query(
      "dependency_topological_plan",
      {},
      principal,
    )) as PlanDTO;
    measurements.topological_plan_ms = performance.now() - started;
    expect(plan.levels.flat()).toHaveLength(10000);
    expect(plan.critical_path).toHaveLength(2);
    expect(plan.total_estimated_minutes).toBe(60);
    const count = await db.query<{ count: string }>(
      "SELECT count(*) FROM task_dependency_edges WHERE owner_id=$1",
      [token],
    );
    expect(Number(count.rows[0].count)).toBe(30000);
    for (const latency of Object.values(measurements))
      expect(latency).toBeLessThan(5000);
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/domain-performance.json",
      JSON.stringify(
        {
          engine: "PGlite real PostgreSQL isolated WASM",
          captured_at: new Date().toISOString(),
          tasks: 10000,
          edges: 30000,
          projects: 20,
          hierarchy_roots: 100,
          max_depth: 2,
          measurements,
          scope:
            "Local domain query latency; not production network or browser latency",
        },
        null,
        2,
      ),
    );
  }, 30000);
});
