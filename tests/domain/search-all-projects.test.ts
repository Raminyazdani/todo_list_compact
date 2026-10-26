import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type { Principal } from "../../shared/contracts";
import { createTestDatabase } from "./database";

describe("unified search includes scoped projects", () => {
  let db: Database;
  const owner = `synthetic-search-${randomUUID()}`;
  const principal: Principal = {
    ownerId: owner,
    actorId: "synthetic-search-ui",
    channel: "UI",
    scopes: ["admin:manage"],
  };
  beforeAll(async () => {
    db = await createTestDatabase();
  });
  afterAll(async () => {
    await db.close?.();
  });
  const service = () => createDomainService(db);
  it("returns matching projects with their own cursor and respects project scope", async () => {
    for (const title of ["Synthetic Alpha", "Synthetic Beta"])
      await service().execute(
        "project_create",
        { title, area: "Synthetic Research" },
        principal,
        { idempotencyKey: randomUUID() },
      );
    await service().execute(
      "task_create",
      { title: "Synthetic Research task" },
      principal,
      { idempotencyKey: randomUUID() },
    );
    await service().execute(
      "file_register_external_link",
      {
        title: "Synthetic Research file",
        external_url: "https://drive.google.com/file/d/synthetic-example/view",
      },
      principal,
      { idempotencyKey: randomUUID() },
    );
    const first = (await service().query(
      "search_all",
      { query: "Synthetic Research", limit: 1 },
      principal,
    )) as {
      tasks: { items: unknown[] };
      projects: {
        items: { title: string }[];
        total: number;
        next_cursor: string | null;
      };
      files: { items: unknown[] };
    };
    expect(first.tasks.items).toHaveLength(1);
    expect(first.files.items).toHaveLength(1);
    expect(first.projects.total).toBe(2);
    expect(first.projects.items).toHaveLength(1);
    expect(first.projects.next_cursor).not.toBeNull();
    const next = (await service().query(
      "search_all",
      {
        query: "Synthetic Research",
        limit: 1,
        project_cursor: first.projects.next_cursor,
      },
      principal,
    )) as typeof first;
    expect(next.projects.items).toHaveLength(1);
    expect(next.projects.items[0].title).not.toBe(
      first.projects.items[0].title,
    );
    expect(next.projects.next_cursor).toBeNull();
    await expect(
      service().query(
        "search_all",
        { query: "Synthetic Research", project_cursor: "foreign" },
        principal,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    const taskOnly: Principal = { ...principal, scopes: ["tasks:read"] };
    const restricted = (await service().query(
      "search_all",
      { query: "Synthetic Research", limit: 1 },
      taskOnly,
    )) as typeof first;
    expect(restricted.projects).toEqual({
      items: [],
      total: 0,
      next_cursor: null,
    });
    expect(restricted.tasks.items).toHaveLength(1);
    expect(restricted.files).toEqual({
      items: [],
      total: 0,
      next_cursor: null,
    });
  });
});
