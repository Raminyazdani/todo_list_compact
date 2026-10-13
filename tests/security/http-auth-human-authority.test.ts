import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import {
  httpEnabled,
  origin,
  ownerCookie,
  scopedToken,
} from "../contracts/http-fixture";
let cookie = "",
  token = "",
  taskId = "",
  revision = 0,
  previewId = "";
const uiHeaders = () => ({
  Cookie: cookie,
  Origin: origin,
  "Content-Type": "application/json",
});
async function uiCommand(command: string, input: Record<string, unknown>) {
  const response = await fetch(origin + "/api/v1/commands", {
    method: "POST",
    headers: { ...uiHeaders(), "Idempotency-Key": randomUUID() },
    body: JSON.stringify({ command, input }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
async function uiQuery(operation: string, input: Record<string, unknown>) {
  const parameters = new URLSearchParams({
    operation,
    input: JSON.stringify(input),
  });
  const response = await fetch(origin + "/api/v1/query?" + parameters, {
    headers: { Cookie: cookie },
  });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}
describe.skipIf(!httpEnabled)(
  "Actual JWT REST boundary cannot manufacture human graph authority",
  () => {
    beforeAll(async () => {
      cookie = await ownerCookie();
      token = (await scopedToken(cookie, ["tasks:read", "tasks:write"]))
        .accessToken;
      const a = await uiCommand("task_create", {
          title: "Synthetic independent JWT authority dependent",
        }),
        b = await uiCommand("task_create", {
          title: "Synthetic independent JWT authority prerequisite",
        });
      taskId = a.entity_id;
      const add = await uiQuery("task_dependency_add_preview", {
        task_id: taskId,
        prerequisites: [{ task_id: b.entity_id }],
      });
      await uiCommand("task_dependency_add_commit", {
        preview_id: add.preview_id,
      });
      const task = await uiQuery("task_get", { task_id: taskId });
      revision = task.revision;
      const waive = await uiQuery("task_dependency_waive_preview", {
        task_id: taskId,
        edge_id: task.prerequisites[0].edge_id,
        reason: "Synthetic owner preview only; no waiver authorized",
        explicit_user_intent: true,
      });
      previewId = waive.preview_id;
    }, 60000);
    it("self-issued intent flags or forged tickets cannot waive through generic REST", async () => {
      for (const input of [
        { preview_id: previewId, explicit_user_intent: true },
        { preview_id: previewId, human_confirmation_id: randomUUID() },
      ]) {
        const response = await fetch(origin + "/api/v1/commands", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            "Idempotency-Key": randomUUID(),
          },
          body: JSON.stringify({
            command: "task_dependency_waive_commit",
            input,
          }),
        });
        expect(response.status).toBe(403);
        expect((await response.json()).error.code).toBe(
          "INSUFFICIENT_PERMISSIONS",
        );
      }
      const task = await uiQuery("task_get", { task_id: taskId });
      expect(task.readiness).toBe("blocked");
      expect(task.revision).toBe(revision);
    });
    it("JWT cannot obtain a human ticket or self-authorize a blocker override", async () => {
      const ticket = await fetch(origin + "/api/v1/approvals", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          command: "task_dependency_waive_commit",
          preview_id: previewId,
        }),
      });
      expect(ticket.status).toBe(403);
      const response = await fetch(origin + "/api/v1/commands", {
        method: "POST",
        headers: {
          Authorization: "Bearer " + token,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          "If-Match": String(revision),
        },
        body: JSON.stringify({
          command: "task_update",
          input: {
            task_id: taskId,
            status: "In progress",
            explicit_user_intent: true,
            override_reason:
              "Synthetic self-issued JWT override must be denied",
          },
        }),
      });
      expect(response.status).toBe(403);
      expect((await response.json()).error.code).toBe(
        "INSUFFICIENT_PERMISSIONS",
      );
      const task = await uiQuery("task_get", { task_id: taskId });
      expect(task.status).toBe("Inbox");
      expect(task.readiness).toBe("blocked");
      expect(task.revision).toBe(revision);
    });
  },
);
