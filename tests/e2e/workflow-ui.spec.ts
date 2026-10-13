import {
  test,
  expect as baseExpect,
  type APIRequestContext,
  type Page,
  type APIResponse,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import AxeBuilder from "@axe-core/playwright";
import type { TaskDTO } from "../../shared/contracts";
import type { EventDTO } from "../../shared/contracts";
import { scopedToken } from "../contracts/http-fixture";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
interface TestCredentials {
  email: string;
  password: string;
}
interface Fixture {
  a: TaskDTO;
  b: TaskDTO;
  c: TaskDTO;
  d: TaskDTO;
  prefix: string;
}
let credentials: TestCredentials;
const expect = baseExpect.configure({ timeout: 30000 });
test.setTimeout(180000);

async function safeGet(
  request: APIRequestContext,
  url: string,
): Promise<APIResponse> {
  try {
    return await request.get(url);
  } catch {
    throw new Error(
      "Authenticated staging GET transport failed. Inspect the private trace; credential headers are omitted from this error.",
    );
  }
}
async function safePost(
  request: APIRequestContext,
  url: string,
  options: Parameters<APIRequestContext["post"]>[1],
): Promise<APIResponse> {
  try {
    return await request.post(url, options);
  } catch {
    throw new Error(
      "Authenticated staging POST transport failed. Inspect the private trace; credential headers are omitted from this error.",
    );
  }
}

test.beforeAll(async () => {
  test.skip(
    !credentialsPath,
    "An isolated staging credential file is required.",
  );
  credentials = JSON.parse(
    await readFile(credentialsPath!, "utf8"),
  ) as TestCredentials;
});

async function signIn(request: APIRequestContext) {
  const response = await safePost(request, "/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: { email: credentials.email, password: credentials.password },
  });
  expect(response.ok(), "Isolated staging owner authentication").toBeTruthy();
}
async function readTask(
  request: APIRequestContext,
  id: string,
): Promise<TaskDTO> {
  const response = await safeGet(
    request,
    `/api/v1/query?operation=task_get&input=${encodeURIComponent(JSON.stringify({ task_id: id }))}`,
  );
  expect(response.ok()).toBeTruthy();
  return (await response.json()).data;
}
async function mutate(
  request: APIRequestContext,
  command: string,
  input: Record<string, unknown>,
  revision?: number,
) {
  const response = await safePost(request, "/api/v1/commands", {
    headers: {
      Origin: origin,
      "Idempotency-Key": crypto.randomUUID(),
      ...(revision !== undefined ? { "If-Match": String(revision) } : {}),
    },
    data: { command, input },
  });
  const body = await response.json();
  expect(
    response.ok(),
    `${command} must succeed on synthetic staging data: ${response.status()} ${body.error?.code ?? ""}`,
  ).toBeTruthy();
  return body.data;
}
async function fixture(request: APIRequestContext): Promise<Fixture> {
  const prefix = `E2E-${crypto.randomUUID().slice(0, 8)}`;
  const values: TaskDTO[] = [];
  for (const suffix of [
    "A proposal",
    "B literature",
    "C approval",
    "D sources",
  ]) {
    const result = await mutate(request, "task_create", {
      title: `${prefix} ${suffix}`,
      status: "Next",
      category: "Research",
    });
    values.push(await readTask(request, result.entity_id));
  }
  const [a, b, c, d] = values;
  for (const [dependent, prerequisites] of [
    [a, [b, c]],
    [b, [d]],
  ] as const) {
    const response = await safeGet(
      request,
      `/api/v1/query?operation=task_dependency_add_preview&input=${encodeURIComponent(JSON.stringify({ task_id: dependent.task_id, prerequisites: prerequisites.map((task) => ({ task_id: task.task_id, mode: "hard" })), operator: "ALL" }))}`,
    );
    expect(response.ok()).toBeTruthy();
    const preview = (await response.json()).data;
    await mutate(request, "task_dependency_add_commit", {
      preview_id: preview.preview_id,
    });
  }
  return {
    a: await readTask(request, a.task_id),
    b: await readTask(request, b.task_id),
    c,
    d,
    prefix,
  };
}
async function openTask(page: Page, task: TaskDTO) {
  await page.goto("/tasks");
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(task.title);
  await page
    .getByRole("button", { name: task.title, exact: true })
    .first()
    .click();
  await expect(
    page.getByRole("dialog").filter({
      has: page.getByRole("heading", { name: task.title, exact: true }),
    }),
  ).toBeVisible();
}

test.beforeEach(async ({ request, context }) => {
  await signIn(request);
  await context.addCookies((await request.storageState()).cookies);
});

test("ui_graph_and_linear_accessible_fallback_are_equivalent", async ({
  page,
  request,
}) => {
  const data = await fixture(request);
  await page.goto("/tasks");
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(data.a.title);
  await page.getByRole("button", { name: "graph", exact: true }).click();
  await expect(page.locator(".graph-boundary")).toContainText(
    "این نما همهٔ روابط را نشان نمی‌دهد",
  );
  await page
    .getByRole("combobox", { name: "کار محوری گراف", exact: true })
    .selectOption(data.a.task_id);
  await expect(page.locator(".react-flow__node")).toHaveCount(4);
  await expect(
    page.locator(".react-flow__node").filter({ hasText: data.a.title }),
  ).toBeVisible();
  const graphTitles = await page
    .locator(".react-flow__node .graph-label>span:first-child")
    .allTextContents();
  await page.getByRole("button", { name: "نمای متنی قابل دسترس" }).click();
  const linearTitles = await page
    .locator(".linear-graph-row>button")
    .allTextContents();
  expect(linearTitles.sort()).toEqual(graphTitles.sort());
  const a = page.locator(".linear-graph-row").filter({
    has: page.getByRole("button", { name: data.a.title, exact: true }),
  });
  await expect(a).toContainText(data.b.title);
  await expect(a).toContainText(data.c.title);
});

test("keyboard_dependency_editor_and_checklist_are_usable", async ({
  page,
  request,
}) => {
  const data = await fixture(request);
  await openTask(page, data.c);
  await page.getByRole("button", { name: "چک‌لیست‌ها", exact: true }).click();
  await page
    .getByPlaceholder("نام چک‌لیست تازه…")
    .fill(`${data.prefix} review`);
  await page.getByPlaceholder("نام چک‌لیست تازه…").press("Enter");
  const list = page
    .locator(".checklist")
    .filter({ hasText: `${data.prefix} review` });
  await expect(list).toBeVisible();
  await list.getByPlaceholder("افزودن یک قدم…").fill("Synthetic keyboard step");
  await list.getByPlaceholder("افزودن یک قدم…").press("Enter");
  const check = page.getByRole("checkbox", { name: "Synthetic keyboard step" });
  await expect(check).toBeVisible();
  await check.focus();
  await page.keyboard.press("Space");
  await expect(check).toBeChecked();
  await page.reload();
  await openTask(page, await readTask(request, data.c.task_id));
  await page.getByRole("button", { name: "چک‌لیست‌ها", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: "Synthetic keyboard step" }),
  ).toBeChecked();
  const stored = await readTask(request, data.c.task_id);
  expect(stored.status).toBe("Next");
  const results = await new AxeBuilder({ page })
    .include('[role="dialog"]')
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  await test.info().attach("synthetic-dialog-accessibility", {
    body: JSON.stringify(
      results.violations.map((item) => ({
        id: item.id,
        impact: item.impact,
        nodes: item.nodes.map((node) => ({
          target: node.target,
          failureSummary: node.failureSummary,
        })),
      })),
      null,
      2,
    ),
    contentType: "application/json",
  });
  expect(
    results.violations.map((item) => ({ id: item.id, impact: item.impact })),
  ).toEqual([]);
});

test("mcp_dependency_mutation_visible_in_browser_and_reverse", async ({
  page,
  request,
  context,
}) => {
  const data = await fixture(request);
  const cookies = await context.cookies(origin);
  const cookieHeader = cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  const oauth = await scopedToken(cookieHeader, ["tasks:read", "tasks:write"]);
  const client = new Client({
    name: "lifeos-browser-parity",
    version: "1.0.0",
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`${origin}/api/mcp`),
    {
      requestInit: {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          Origin: origin,
        },
      },
    },
  );
  await client.connect(transport);
  const result = await client.callTool({
    name: "task_complete",
    arguments: {
      input: { task_id: data.d.task_id },
      operation_id: crypto.randomUUID(),
      expected_revision: (await readTask(request, data.d.task_id)).revision,
    },
  });
  expect(result.isError).not.toBe(true);
  expect((await readTask(request, data.b.task_id)).readiness).toBe("ready");
  await openTask(page, await readTask(request, data.b.task_id));
  await expect(
    page.getByRole("dialog").first().locator(".detail-top .readiness"),
  ).toHaveText("آمادهٔ شروع");
  await page.getByRole("button", { name: "تکمیل کار", exact: true }).click();
  await expect
    .poll(async () => (await readTask(request, data.b.task_id)).status)
    .toBe("Done");
  const read = await client.callTool({
    name: "task_get",
    arguments: { task_id: data.b.task_id },
  });
  const structure = read.structuredContent as { data: TaskDTO };
  expect(structure.data.status).toBe("Done");
  await client.close();
});

test("dependency_graph_survives_reload_and_fresh_login", async ({
  page,
  request,
  context,
}) => {
  const data = await fixture(request);
  await openTask(page, data.a);
  await expect(page.getByRole("dialog").first()).toContainText(data.b.title);
  await page.reload();
  await page.goto("/settings");
  await page.getByRole("button", { name: "خروج از حساب", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  await signIn(request);
  await context.addCookies((await request.storageState()).cookies);
  await openTask(page, await readTask(request, data.a.task_id));
  await expect(page.getByRole("dialog").first()).toContainText(data.c.title);
  // Redeployment persistence is separately exercised by the production operator;
  // this named contract verifies browser reload and a fresh authenticated session.
  test.info().annotations.push({
    type: "production-evidence-required",
    description:
      "Actual redeploy persistence requires the production operator drill.",
  });
});

test("dependency_graph_works_after_redeploy_and_fresh_login", async ({
  page,
  request,
  context,
}) => {
  const redeployScript = process.env.E2E_REDEPLOY_SCRIPT;
  test.skip(
    !redeployScript,
    "An approved production redeployment script and isolated production test namespace are required.",
  );
  const data = await fixture(request);
  await new Promise<void>((resolve, reject) => {
    const processHandle = spawn(process.execPath, [redeployScript!], {
      stdio: "ignore",
      env: process.env,
    });
    processHandle.once("error", reject);
    processHandle.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              "Approved redeployment script did not complete successfully.",
            ),
          ),
    );
  });
  await signIn(request);
  await context.addCookies((await request.storageState()).cookies);
  const persisted = await readTask(request, data.a.task_id);
  expect(
    persisted.prerequisites.map((edge) => edge.prerequisite_task_id).sort(),
  ).toEqual([data.b.task_id, data.c.task_id].sort());
  await openTask(page, persisted);
  await expect(page.getByRole("dialog").first()).toContainText(data.b.title);
});

test("rtl_mobile_task_detail_allows_dependency_edit_without_drag", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const prefix = `E2E-${crypto.randomUUID().slice(0, 8)}`;
  const aResult = await mutate(request, "task_create", {
    title: `${prefix} mobile dependent`,
  });
  const bResult = await mutate(request, "task_create", {
    title: `${prefix} mobile prerequisite`,
  });
  const a = await readTask(request, aResult.entity_id);
  const b = await readTask(request, bResult.entity_id);
  await openTask(page, a);
  await page.getByRole("button", { name: "پیش‌نیازها", exact: true }).click();
  await page.getByPlaceholder("جست‌وجوی پیش‌نیاز…").fill(b.title);
  await page.getByRole("listbox").selectOption(b.task_id);
  await page
    .getByRole("button", { name: "پیش‌نمایش وابستگی", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تأیید و اعمال تغییر", exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, a.task_id)).blocked_by.length)
    .toBe(1);
  await expect(
    page.getByRole("dialog").first().locator(".detail-top .readiness"),
  ).toHaveText("پیش‌نیاز ناتمام");
  await expect(
    page
      .getByRole("dialog")
      .first()
      .locator(".dependency-row")
      .filter({ hasText: b.title }),
  ).toBeVisible();
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "artifacts/screenshots/synthetic-mobile-dependency.png",
    fullPage: true,
  });
});

test("task_create_is_persistent_and_visible_via_mcp", async ({
  page,
  request,
  context,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} ثبت فارسی بدون مهلت`;
  await page.goto("/tasks");
  await page.getByRole("button", { name: "کار تازه", exact: true }).click();
  await page.getByPlaceholder("مثلاً: مرور منابع مقاله").fill(title);
  await page.getByRole("button", { name: "ثبت کار", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "ثبت یک کار تازه", exact: true }),
  ).not.toBeVisible();
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(title);
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(title);
  await expect(
    page.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  const response = await safeGet(
    request,
    `/api/v1/query?operation=task_search&input=${encodeURIComponent(JSON.stringify({ search: title }))}`,
  );
  const items = (await response.json()).data.items as TaskDTO[];
  expect(items).toHaveLength(1);
  expect(items[0].due_date).toBeNull();
  const cookies = await context.cookies(origin);
  const oauth = await scopedToken(
    cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    ["tasks:read"],
  );
  const client = new Client({
    name: "lifeos-ui-persistence",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${origin}/api/mcp`), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          Origin: origin,
        },
      },
    }),
  );
  const mcpRead = await client.callTool({
    name: "task_get",
    arguments: { task_id: items[0].task_id },
  });
  expect(mcpRead.isError).not.toBe(true);
  expect((mcpRead.structuredContent as { data: TaskDTO }).data.title).toBe(
    title,
  );
  await client.close();
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(title);
  await page.screenshot({
    path: "artifacts/screenshots/synthetic-desktop-tasks.png",
    fullPage: false,
  });
});

test("lost_create_acknowledgement_retries_same_intent_exactly_once", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} lost acknowledgement`;
  const keys: string[] = [];
  await page.route("**/api/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.command !== "task_create" || body.input.title !== title) {
      await route.continue();
      return;
    }
    keys.push(route.request().headers()["idempotency-key"]);
    if (keys.length === 1) {
      let committed;
      try {
        committed = await route.fetch();
      } catch {
        throw new Error(
          "The synthetic committed-request probe could not read a server acknowledgement. Authenticated headers are omitted.",
        );
      }
      expect(committed.ok()).toBeTruthy();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.goto("/tasks");
  await page.getByRole("button", { name: "کار تازه", exact: true }).click();
  await page.getByPlaceholder("مثلاً: مرور منابع مقاله").fill(title);
  await page.getByRole("button", { name: "ثبت کار", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("ذخیره هنوز تأیید نشده");
  await expect(
    page.getByRole("dialog", { name: "ثبت یک کار تازه", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "ثبت کار", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "ثبت یک کار تازه", exact: true }),
  ).not.toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBe(keys[1]);
  const stored = await safeGet(
    request,
    `/api/v1/query?operation=task_search&input=${encodeURIComponent(JSON.stringify({ search: title }))}`,
  );
  expect((await stored.json()).data.items).toHaveLength(1);
});

test("notes_only_recurring_event_edit_preserves_series_rule_timezone_and_seconds", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} recurring preservation`;
  const month = new Date().toISOString().slice(0, 7);
  const starts_at = `${month}-01T08:07:23Z`;
  const ends_at = `${month}-01T09:37:23Z`;
  const recurrence_rule = "FREQ=WEEKLY;BYDAY=TU,TH";
  const created = await mutate(request, "calendar_create_local_event", {
    title,
    starts_at,
    ends_at,
    timezone: "Asia/Tehran",
    recurrence_rule,
  });
  const next = new Date(`${month}-01T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const input = {
    from: `${month}-01T00:00:00Z`,
    to: next.toISOString(),
    limit: 200,
  };
  async function occurrences() {
    const response = await safeGet(
      request,
      `/api/v1/query?operation=calendar_events_query&input=${encodeURIComponent(JSON.stringify(input))}`,
    );
    expect(response.ok()).toBeTruthy();
    return ((await response.json()).data.items as EventDTO[]).filter(
      (event) => event.event_id === created.entity_id,
    );
  }
  const before = await occurrences();
  expect(before.length).toBeGreaterThan(0);
  await page.goto("/calendar");
  await page.getByRole("button", { name: "فهرست", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(
    page.getByRole("combobox", { name: "منطقهٔ زمانی", exact: true }),
  ).toHaveValue("Asia/Tehran");
  await expect(
    page.getByRole("combobox", { name: "تکرار", exact: true }),
  ).toHaveValue("keep");
  await page
    .getByLabel("یادداشت", { exact: true })
    .fill("Synthetic notes only; preserve the entire series.");
  await page
    .getByRole("checkbox", { name: /تأیید می‌کنم این ویرایش روی کل سری/ })
    .check();
  await page
    .getByRole("button", { name: "ذخیرهٔ رویداد", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "جزئیات رویداد", exact: true }),
  ).not.toBeVisible();
  const after = await occurrences();
  expect(after.map((event) => event.starts_at)).toEqual(
    before.map((event) => event.starts_at),
  );
  for (const event of after) {
    expect(event.recurrence_rule).toBe(recurrence_rule);
    expect(event.timezone).toBe("Asia/Tehran");
    expect(Date.parse(event.series_starts_at!)).toBe(Date.parse(starts_at));
    expect(Date.parse(event.series_ends_at!)).toBe(Date.parse(ends_at));
    expect(event.notes).toBe(
      "Synthetic notes only; preserve the entire series.",
    );
  }
});

test("synthetic_desktop_dark_rtl_and_light_ltr_are_accessible", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const data = await fixture(request);
  const preferenceURL = "/api/v1/query?operation=preferences_get&input=%7B%7D";
  const initial = (await (await safeGet(request, preferenceURL)).json()).data;
  try {
    for (const appearance of [
      { theme: "dark", language: "fa", dir: "rtl" },
      { theme: "light", language: "en", dir: "ltr" },
    ]) {
      const current = (await (await safeGet(request, preferenceURL)).json())
        .data;
      await mutate(
        request,
        "preferences_update",
        {
          settings: {
            ...initial.settings,
            theme: appearance.theme,
            language: appearance.language,
          },
        },
        current.revision,
      );
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("dir", appearance.dir);
      await expect(page.locator("html")).toHaveAttribute(
        "data-theme",
        appearance.theme,
      );
      await expect(page.locator(".dashboard-grid")).toBeVisible();
      await expect(page.locator(".dashboard-grid .loading-state")).toHaveCount(
        0,
      );
      for (const location of ["dashboard", "graph"]) {
        if (location === "graph") {
          await page.goto("/tasks");
          await page
            .getByPlaceholder(
              appearance.language === "fa"
                ? "جست‌وجو بین کارها…"
                : "Search tasks…",
            )
            .fill(data.a.title);
          await page
            .getByRole("button", { name: "graph", exact: true })
            .click();
          await page
            .getByRole("combobox", {
              name:
                appearance.language === "fa"
                  ? "کار محوری گراف"
                  : "Graph focus task",
              exact: true,
            })
            .selectOption(data.a.task_id);
          await expect(page.locator(".react-flow__node")).toHaveCount(4);
        }
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa"])
          .analyze();
        await test
          .info()
          .attach(
            `${location}-${appearance.theme}-${appearance.dir}-accessibility`,
            {
              body: JSON.stringify(
                axe.violations.map((item) => ({
                  id: item.id,
                  impact: item.impact,
                  targets: item.nodes.map((node) => node.target),
                })),
              ),
              contentType: "application/json",
            },
          );
        expect(
          axe.violations.map((item) => ({
            id: item.id,
            impact: item.impact,
            targets: item.nodes.map((node) => node.target),
          })),
        ).toEqual([]);
        await page.screenshot({
          path: `artifacts/screenshots/synthetic-${location}-${appearance.theme}-${appearance.dir}.png`,
          fullPage: false,
        });
      }
    }
  } finally {
    const current = (await (await safeGet(request, preferenceURL)).json()).data;
    if (current.revision > 0)
      await mutate(
        request,
        "preferences_update",
        {
          settings: {
            ...initial.settings,
            theme: initial.settings.theme ?? "dark",
            language: initial.settings.language ?? "fa",
          },
        },
        current.revision,
      );
  }
});
