import { test, expect } from "@playwright/test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { boundedSignIn } from "../../scripts/ops/bounded-signin.mjs";
import {
  withPrivateFile,
  writeExclusivePrivateJson,
  replacePinnedContents,
} from "../../scripts/ops/private-paths.mjs";
import type { TaskDTO } from "../../shared/contracts";

test("accepted_redeployment_retains_exact_DG36_graph_after_fresh_owner_login", async ({
  page,
  context,
}) => {
  test.skip(
    process.env.RUN_DG36_RECOVERY_READBACK !== "1",
    "Requires a verified accepted deployment and its retained private fixtures.",
  );
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const origin = process.env.E2E_BASE_URL;
  const inputPath = process.env.DG36_RETAINED_REPORT_PATH;
  const outputPath = process.env.DG36_READBACK_REPORT_PATH;
  const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
  if (
    origin !== "https://ramin-life-os.vercel.app" ||
    !inputPath ||
    !outputPath ||
    !credentialsPath
  )
    throw new Error("EXACT_PRIVATE_PRODUCTION_DG36_INPUTS_REQUIRED");
  const options = { repositoryRoot };
  const retained = await withPrivateFile(
    inputPath,
    async (file) => JSON.parse(await file.readFile("utf8")),
    options,
  );
  expect(retained.format).toBe("ramin-life-os-dg36-retained-proof/1");
  expect(retained.status).toBe("awaiting_fresh_login_readback");
  expect(retained.origin).toBe(origin);
  expect(retained.expected_sha).toMatch(/^[a-f0-9]{40}$/);
  expect(retained.deployment_id).toMatch(/^dpl_[A-Za-z0-9]+$/);
  const roles = retained.roles as Record<"A" | "B" | "C" | "D", TaskDTO>;
  const tasks = Object.values(roles);
  expect(tasks).toHaveLength(4);
  expect(new Set(tasks.map((task) => task.task_id)).size).toBe(4);
  expect(retained.prefix).toMatch(/^E2E-[a-f0-9]{8}$/);
  expect(
    tasks.every(
      (task) =>
        task.title.startsWith(retained.prefix + " ") && !task.archived_at,
    ),
  ).toBe(true);
  const result: Record<string, unknown> = {
    format: "ramin-life-os-dg36-recovered-readback/1",
    status: "pending",
    origin,
    expected_sha: retained.expected_sha,
    deployment_id: retained.deployment_id,
    started_at: new Date().toISOString(),
    factory_repeated: false,
    deployment_repeated: false,
    original_failed_browser_run_preserved: true,
  };
  const target = await writeExclusivePrivateJson(outputPath, result, options);
  await withPrivateFile(
    target,
    async (file) => {
      const persist = () =>
        replacePinnedContents(file, JSON.stringify(result, null, 2) + "\n");
      try {
        const credentials = await withPrivateFile(
          credentialsPath,
          async (source) => JSON.parse(await source.readFile("utf8")),
          options,
        );
        const response = await boundedSignIn(origin, credentials);
        expect(response.status).toBe(200);
        const cookies = response.headers.getSetCookie().map((line) => {
          const pair = line.split(";")[0];
          const separator = pair.indexOf("=");
          if (separator < 1) throw new Error("OWNER_COOKIE_INVALID");
          return {
            name: pair.slice(0, separator),
            value: pair.slice(separator + 1),
            domain: new URL(origin).hostname,
            path: "/",
            httpOnly: /;\s*HttpOnly/i.test(line),
            secure: true,
            sameSite: "Lax" as const,
          };
        });
        expect(cookies.length).toBeGreaterThan(0);
        await context.addCookies(cookies);
        const current: Record<string, TaskDTO> = {};
        for (const [role, expected] of Object.entries(roles)) {
          const read = await page.request.get(
            origin +
              "/api/v1/query?" +
              new URLSearchParams({
                operation: "task_get",
                input: JSON.stringify({ task_id: expected.task_id }),
              }),
          );
          expect(read.status()).toBe(200);
          const task = (await read.json()).data as TaskDTO;
          expect(task.task_id).toBe(expected.task_id);
          expect(task.title).toBe(expected.title);
          expect(task.status).toBe(expected.status);
          expect(task.revision).toBe(expected.revision);
          expect(task.project_id).toBeNull();
          expect(task.due_date).toBeNull();
          expect(task.due_at).toBeNull();
          expect(task.archived_at).toBeNull();
          current[role] = task;
        }
        expect(
          current.A.prerequisites
            .map((edge) => edge.prerequisite_task_id)
            .sort(),
        ).toEqual([roles.B.task_id, roles.C.task_id].sort());
        expect(
          current.B.prerequisites.map((edge) => edge.prerequisite_task_id),
        ).toEqual([roles.D.task_id]);
        for (const role of ["A", "B"] as const) {
          expect(
            current[role].prerequisites.every((edge) => edge.mode === "hard"),
          ).toBe(true);
          await page.goto(
            `/tasks?task=${encodeURIComponent(roles[role].task_id)}`,
          );
          const dialog = page.getByRole("dialog").first();
          await expect(dialog).toContainText(roles[role].title);
          await dialog
            .getByRole("button", { name: "پیش‌نیازها", exact: true })
            .click();
          for (const prerequisite of role === "A" ? ["B", "C"] : ["D"])
            await expect(dialog).toContainText(
              roles[prerequisite as keyof typeof roles].title,
            );
          await page.screenshot({
            path: join(dirname(target), `private-DG36-recovered-${role}.png`),
            fullPage: true,
          });
        }
        result.status = "passed";
        result.tasks_verified = 4;
        result.prerequisite_groups_verified = 2;
        result.edges_verified = 3;
        result.fresh_owner_login = "PASS";
        result.business_writes = false;
        result.completed_at = new Date().toISOString();
        await persist();
      } catch (error) {
        result.status = "failed";
        result.completed_at = new Date().toISOString();
        await persist();
        throw error;
      }
    },
    options,
  );
});
