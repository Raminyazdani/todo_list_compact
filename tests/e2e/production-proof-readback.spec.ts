import { test, expect } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { boundedSignIn } from "../../scripts/ops/bounded-signin.mjs";
import {
  withPrivateFile,
  writeExclusivePrivateJson,
  replacePinnedContents,
} from "../../scripts/ops/private-paths.mjs";
import type { TaskDTO, ChecklistDTO } from "../../shared/contracts";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const enabled = process.env.RUN_GRAPH_UI_READBACK === "1";

test("retained_real_MCP_graph_proof_matches_owner_UI_and_canonical_API_after_fresh_login", async ({
  page,
  context,
}) => {
  test.skip(
    !enabled,
    "Requires an explicitly selected private graph proof journal.",
  );
  test.setTimeout(180000);
  let resultPath: string | undefined;
  const result: Record<string, unknown> = {
    format: "ramin-life-os-graph-ui-proof/1",
    status: "pending",
    origin,
    started_at: new Date().toISOString(),
    browser_steps: [],
  };
  try {
    if (
      !process.env.PRODUCTION_GRAPH_REPORT_PATH ||
      !process.env.GRAPH_UI_REPORT_PATH ||
      !process.env.E2E_CREDENTIALS_PATH
    )
      throw new Error("PRIVATE_GRAPH_UI_INPUTS_REQUIRED");
    const proof = await withPrivateFile(
      process.env.PRODUCTION_GRAPH_REPORT_PATH,
      async (file) => JSON.parse(await file.readFile("utf8")),
      { repositoryRoot },
    );
    if (
      proof.format !== "ramin-life-os-production-graph-proof/1" ||
      proof.status !== "passed" ||
      proof.origin !== origin ||
      (proof.proof_mode === "production"
        ? origin !== "https://ramin-life-os.vercel.app"
        : proof.proof_mode !== "staging_rehearsal" ||
          origin !== "http://localhost:3000")
    )
      throw new Error("PASSED_GRAPH_PROOF_EXACT_ORIGIN_REQUIRED");
    const snapshots = Object.values(proof.snapshots) as TaskDTO[];
    const prefix = "SYNTHETIC GRAPH PROOF " + proof.run_id.slice(0, 8) + " ";
    if (
      snapshots.length !== 21 ||
      snapshots.some(
        (task) => !task.title.startsWith(prefix) || task.archived_at,
      )
    )
      throw new Error("EXACT_RETAINED_SYNTHETIC_GRAPH_REQUIRED");
    result.proof_mode = proof.proof_mode;
    result.graph_run_id = proof.run_id;
    resultPath = await writeExclusivePrivateJson(
      process.env.GRAPH_UI_REPORT_PATH,
      result,
      { repositoryRoot },
    );
    const credentials = await withPrivateFile(
      process.env.E2E_CREDENTIALS_PATH,
      async (file) => JSON.parse(await file.readFile("utf8")),
      { repositoryRoot },
    );
    if (
      typeof credentials.email !== "string" ||
      typeof credentials.password !== "string"
    )
      throw new Error("PRIVATE_OWNER_CREDENTIALS_INVALID");
    const login = await boundedSignIn(origin, credentials);
    if (!login.ok) throw new Error("OWNER_LOGIN_FAILED");
    const cookies = login.headers.getSetCookie().map((line) => {
      const pair = line.split(";")[0],
        split = pair.indexOf("=");
      if (split <= 0) throw new Error("OWNER_SESSION_COOKIE_INVALID");
      return {
        name: pair.slice(0, split),
        value: pair.slice(split + 1),
        domain: new URL(origin).hostname,
        path: "/",
        httpOnly: /;\s*HttpOnly/i.test(line),
        secure: new URL(origin).protocol === "https:",
        sameSite: "Lax" as const,
      };
    });
    if (!cookies.length) throw new Error("OWNER_SESSION_COOKIE_REQUIRED");
    await context.addCookies(cookies);
    page.setDefaultTimeout(30000);
    async function query<T>(operation: string, input: Record<string, unknown>) {
      const response = await page.request.get(
        origin +
          "/api/v1/query?" +
          new URLSearchParams({ operation, input: JSON.stringify(input) }),
      );
      if (!response.ok()) throw new Error("CANONICAL_OWNER_READ_FAILED");
      return (await response.json()).data as T;
    }
    const selected = (task: TaskDTO) => ({
      task_id: task.task_id,
      title: task.title,
      status: task.status,
      revision: task.revision,
      readiness: task.readiness,
      ready_now: task.ready_now,
      parent_task_id: task.parent_task_id,
      prerequisites: task.prerequisites,
      checklist_progress: task.checklist_progress,
      started_at_risk: task.started_at_risk,
      due_date: task.due_date,
      due_at: task.due_at,
    });
    for (const expected of snapshots) {
      const current = await query<TaskDTO>("task_get", {
        task_id: expected.task_id,
      });
      if (
        JSON.stringify(selected(current)) !== JSON.stringify(selected(expected))
      )
        throw new Error("CANONICAL_GRAPH_CHANGED_SINCE_RETAINED_PROOF");
    }
    result.canonical_api_snapshots_matched = snapshots.length;
    const steps = result.browser_steps as string[];
    async function openRole(role: string) {
      const id = proof.roles[role] as string;
      const expected = proof.snapshots[id] as TaskDTO;
      if (!expected) throw new Error("RETAINED_GRAPH_ROLE_MISSING");
      await page.goto("/tasks?" + new URLSearchParams({ task: id }));
      const dialog = page.getByRole("dialog").filter({
        has: page.getByRole("heading", { name: expected.title, exact: true }),
      });
      await expect(dialog).toBeVisible({ timeout: 30000 });
      return { dialog, expected };
    }
    for (const [role, operator] of [
      ["A ALL root", "ALL"],
      ["X ANY root", "ANY"],
    ]) {
      const { dialog, expected } = await openRole(role);
      await dialog
        .getByRole("button", { name: /^(پیش‌نیازها|Prerequisites)$/ })
        .click();
      await expect(dialog).toContainText(operator);
      for (const edge of expected.prerequisites)
        await expect(dialog).toContainText(edge.title);
      steps.push(operator + "_canonical_prerequisites_visible");
    }
    const checklist = await openRole("C checklist template root");
    const lists = await query<ChecklistDTO[]>("task_checklist_get", {
      task_id: checklist.expected.task_id,
    });
    if (lists.filter((list) => !list.archived_at).length !== 2)
      throw new Error("TWO_RETAINED_CHECKLISTS_REQUIRED");
    await checklist.dialog
      .getByRole("button", { name: /^(چک‌لیست‌ها|Checklists)$/ })
      .click();
    for (const list of lists.filter((item) => !item.archived_at)) {
      const block = checklist.dialog
        .locator(".checklist")
        .filter({ hasText: list.title });
      await expect(block).toBeVisible();
      for (const item of list.items.filter((row) => !row.archived_at))
        await expect(
          block.getByRole("checkbox", { name: item.title, exact: true }),
        ).toBeChecked({ checked: item.checked });
    }
    steps.push("two_named_checklists_match_canonical_checked_state");
    const promoted = await openRole("promoted");
    await expect(
      promoted.dialog.getByRole("button", {
        name: /^(بازکردن کار والد|Open parent task)$/,
      }),
    ).toBeVisible();
    steps.push("promoted_child_independent_identity_and_parent_visible");
    for (const role of ["template_root", "recurring_root"]) {
      const { dialog, expected } = await openRole(role);
      await expect(
        dialog.getByLabel(/^(عنوان|Title)$/, { exact: true }),
      ).toHaveValue(expected.title);
      steps.push(role + "_exact_clone_identity_visible");
    }
    const screenshotPath = join(
      dirname(resultPath),
      "graph-ui-" + randomUUID() + ".png",
    );
    await writeExclusivePrivateJson(
      screenshotPath,
      { status: "pending_capture" },
      { repositoryRoot },
    );
    await withPrivateFile(
      screenshotPath,
      async (file) => {
        const bytes = await page.screenshot({ fullPage: true });
        await file.truncate(0);
        let offset = 0;
        while (offset < bytes.length)
          offset += (
            await file.write(bytes, offset, bytes.length - offset, offset)
          ).bytesWritten;
        await file.sync();
      },
      { repositoryRoot },
    );
    result.screenshot_path = screenshotPath;
    result.status = "passed";
    result.completed_at = new Date().toISOString();
  } catch (error) {
    result.status = "failed";
    result.private_diagnostic =
      error instanceof Error
        ? error.message.slice(0, 4000)
        : "Unknown browser failure";
    throw new Error("GRAPH_UI_READBACK_FAILED_INSPECT_PRIVATE_REPORT");
  } finally {
    if (resultPath)
      await withPrivateFile(
        resultPath,
        (file) => replacePinnedContents(file, JSON.stringify(result, null, 2)),
        { repositoryRoot },
      );
  }
});
