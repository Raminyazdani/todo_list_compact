import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createDomainService } from "../../server/domain/service";
import type { Database } from "../../server/db/database";
import type {
  CommandName,
  DomainService,
  PreviewDTO,
  Principal,
  TaskDTO,
} from "../../shared/contracts";
import { createTestDatabase } from "./database";
let db: Database, service: DomainService, principal: Principal;
const exec = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
  p = principal,
  key = randomUUID(),
) =>
  service.execute(command, input, p, {
    idempotencyKey: key,
    expectedRevision: revision,
  });
beforeAll(async () => {
  db = await createTestDatabase();
  service = createDomainService(db);
}, 30000);
beforeEach(() => {
  principal = {
    ownerId: `synthetic-${randomUUID()}`,
    actorId: "synthetic-owner",
    channel: "UI",
    scopes: ["admin:manage"],
  };
});
afterAll(async () => {
  await db.close?.();
});
async function fixture() {
  const a = await exec("task_create", { title: "Synthetic dependent" }),
    b = await exec("task_create", { title: "Synthetic prerequisite" });
  const add = (await service.query(
    "task_dependency_add_preview",
    { task_id: a.entity_id, prerequisites: [{ task_id: b.entity_id }] },
    principal,
  )) as PreviewDTO;
  await exec("task_dependency_add_commit", { preview_id: add.preview_id });
  const task = (await service.query(
    "task_get",
    { task_id: a.entity_id },
    principal,
  )) as TaskDTO;
  const preview = (await service.query(
    "task_dependency_waive_preview",
    {
      task_id: a.entity_id,
      edge_id: task.prerequisites[0].edge_id,
      reason: "Explicit synthetic owner decision",
      explicit_user_intent: true,
    },
    principal,
  )) as PreviewDTO;
  return { task, preview };
}
async function uiIssuedTicket(
  previewId: string,
  changes: Record<string, unknown> = {},
) {
  const ticket = randomUUID(),
    command = "task_dependency_waive_commit";
  const digest = createHash("sha256")
    .update(JSON.stringify({ command, preview_id: previewId }))
    .digest("hex");
  await db.query(
    "INSERT INTO human_confirmations(confirmation_id,owner_id,actor_id,command,input_hash,expires_at,operation_key) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      ticket,
      changes.owner_id ?? principal.ownerId,
      changes.actor_id ?? principal.actorId,
      command,
      digest,
      changes.expires_at ?? new Date(Date.now() + 300000).toISOString(),
      changes.operation_key ?? null,
    ],
  );
  return ticket;
}
describe("Human intent authority is enforced by the canonical transaction", () => {
  it("mcp_fake_flags_forged_and_wrong_actor_tickets_cannot_waive_via_generic_rest_path", async () => {
    const { task, preview } = await fixture(),
      mcp = { ...principal, channel: "MCP" as const };
    for (const input of [
      { preview_id: preview.preview_id, explicit_user_intent: true },
      { preview_id: preview.preview_id, human_confirmation_id: randomUUID() },
    ])
      await expect(
        exec("task_dependency_waive_commit", input, undefined, mcp),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const wrong = await uiIssuedTicket(preview.preview_id, {
      actor_id: "another-actor",
    });
    await expect(
      exec(
        "task_dependency_waive_commit",
        { preview_id: preview.preview_id, human_confirmation_id: wrong },
        undefined,
        mcp,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const expired = await uiIssuedTicket(preview.preview_id, {
      expires_at: "2020-01-01T00:00:00Z",
    });
    await expect(
      exec(
        "task_dependency_waive_commit",
        { preview_id: preview.preview_id, human_confirmation_id: expired },
        undefined,
        mcp,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: task.task_id },
          principal,
        )) as TaskDTO
      ).readiness,
    ).toBe("blocked");
  });
  it("ui_issued_exact_intent_ticket_allows_one_atomic_mcp_waiver_and_expired_retry_replays", async () => {
    const { task, preview } = await fixture(),
      mcp = { ...principal, channel: "MCP" as const },
      ticket = await uiIssuedTicket(preview.preview_id),
      key = randomUUID(),
      input = { preview_id: preview.preview_id, human_confirmation_id: ticket };
    const result = await exec(
      "task_dependency_waive_commit",
      input,
      undefined,
      mcp,
      key,
    );
    expect(
      (
        (await service.query(
          "task_get",
          { task_id: task.task_id },
          principal,
        )) as TaskDTO
      ).ready_now,
    ).toBe(true);
    expect(
      (
        await db.query<{ operation_key: string }>(
          "SELECT operation_key FROM human_confirmations WHERE confirmation_id=$1",
          [ticket],
        )
      ).rows[0].operation_key,
    ).toBe(key);
    await db.query(
      "UPDATE human_confirmations SET expires_at=now()-interval'1 second' WHERE confirmation_id=$1",
      [ticket],
    );
    const retry = await exec(
      "task_dependency_waive_commit",
      input,
      undefined,
      mcp,
      key,
    );
    expect(retry.replayed).toBe(true);
    expect(retry.operation_id).toBe(result.operation_id);
  });
  it("ticket_reuse_for_another_preview_or_operation_and_mcp_override_are_denied", async () => {
    const first = await fixture(),
      second = await fixture(),
      mcp = { ...principal, channel: "MCP" as const },
      ticket = await uiIssuedTicket(first.preview.preview_id, {
        operation_key: "different-accepted-intent",
      });
    await expect(
      exec(
        "task_dependency_waive_commit",
        { preview_id: first.preview.preview_id, human_confirmation_id: ticket },
        undefined,
        mcp,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    const valid = await uiIssuedTicket(first.preview.preview_id);
    await expect(
      exec(
        "task_dependency_waive_commit",
        { preview_id: second.preview.preview_id, human_confirmation_id: valid },
        undefined,
        mcp,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
    await expect(
      exec(
        "task_update",
        {
          task_id: first.task.task_id,
          status: "In progress",
          override_reason: "MCP model self-issued reason",
        },
        first.task.revision,
        mcp,
      ),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_PERMISSIONS" });
  });
});
