import {
  test,
  expect as baseExpect,
  type APIRequestContext,
  type Page,
  type APIResponse,
} from "@playwright/test";
import { readFile, mkdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import AxeBuilder from "@axe-core/playwright";
import type { TaskDTO } from "../../shared/contracts";
import type {
  EventDTO,
  PageDTO,
  TimeEntryDTO,
  ProjectDTO,
  FileDTO,
  CalendarReminderDTO,
  ReportsDTO,
} from "../../shared/contracts";
import { zonedLocalToInstant, addCalendarDays } from "../../shared/datetime";
import { moveLocalEventToDate } from "../../features/calendar-dates";
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
let screenshotDirectory: string;
let originalPreferences:
  { settings: Record<string, unknown>; revision: number } | undefined;
const expect = baseExpect.configure({ timeout: 30000 });
test.setTimeout(180000);

// BetterAuth's configured 60-request window restarts after 60 seconds of
// inactivity, not at each wall-clock minute. These many independent hard page
// navigations must leave a quiet auth boundary instead of weakening that policy.
const authIdleMilliseconds = 61000;
const authCheckpointRequests = 25;
let authRequestsSinceIdle = 0;
let totalBrowserSessionRequests = 0;
let lastBrowserSessionRequestAt = 0;
let maximumAuthCheckpointCount = 0;
let initialAuthIdleComplete = false;

async function authIdleBoundary(initial = false) {
  if (!initial && authRequestsSinceIdle < authCheckpointRequests) return;
  if (initial) lastBrowserSessionRequestAt = Date.now();
  const startedAt = Date.now();
  console.log(
    "WORKFLOW_AUTH_IDLE",
    JSON.stringify({
      reason: initial ? "initial_file_boundary" : "observed_request_budget",
      requests_since_idle: authRequestsSinceIdle,
      wait_ms: Math.max(
        0,
        lastBrowserSessionRequestAt + authIdleMilliseconds - startedAt,
      ),
    }),
  );
  for (;;) {
    const remaining =
      lastBrowserSessionRequestAt + authIdleMilliseconds - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(remaining, 30000)),
    );
  }
  authRequestsSinceIdle = 0;
  console.log(
    "WORKFLOW_AUTH_IDLE",
    JSON.stringify({
      reason: "idle_boundary_complete",
      waited_ms: Date.now() - startedAt,
      total_session_requests: totalBrowserSessionRequests,
    }),
  );
}

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
  const remote = !["localhost", "127.0.0.1", "[::1]"].includes(
    new URL(origin).hostname,
  );
  const configuredDirectory = process.env.E2E_SCREENSHOT_DIRECTORY;
  if (remote && (!configuredDirectory || !isAbsolute(configuredDirectory))) {
    throw new Error(
      "Remote browser evidence requires an absolute E2E_SCREENSHOT_DIRECTORY outside the repository.",
    );
  }
  if (configuredDirectory && !isAbsolute(configuredDirectory)) {
    throw new Error("E2E_SCREENSHOT_DIRECTORY must be absolute.");
  }
  const workspace = await realpath(process.cwd());
  const insideWorkspace = (candidate: string) => {
    const part = relative(workspace, candidate);
    return (
      part === "" ||
      (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
    );
  };
  const destination = resolve(configuredDirectory ?? "artifacts/screenshots");
  if (remote && insideWorkspace(destination))
    throw new Error(
      "Remote screenshots cannot be stored inside the repository.",
    );
  await mkdir(destination, { recursive: true });
  screenshotDirectory = await realpath(destination);
  if (remote && insideWorkspace(screenshotDirectory))
    throw new Error(
      "Remote screenshot realpath resolves inside the repository.",
    );
});

test("task_precise_deadline_project_reference_and_linked_intervals_share_canonical_state", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} precise task`;
  const project = await mutate(request, "project_create", {
    title: `${title} project`,
    area: "Research",
  });
  const original = "2062-02-12T10:30:00.123Z";
  const created = await mutate(request, "task_create", {
    title,
    due_date: "2062-02-12",
    due_at: original,
    timezone: "Europe/Berlin",
  });
  await page.goto(`/tasks?task=${encodeURIComponent(created.entity_id)}`);
  const detail = page.getByRole("dialog").first();
  await detail
    .getByLabel("پروژهٔ کار", { exact: true })
    .selectOption(project.entity_id);
  await detail
    .getByLabel("منطقهٔ زمانی کار", { exact: true })
    .fill("Asia/Tehran");
  await detail
    .getByLabel("مرجع اصلی (پیوند یا شناسه)", { exact: true })
    .fill("https://example.test/synthetic-reference");
  await page
    .getByRole("button", { name: "ذخیرهٔ تغییرات", exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, created.entity_id)).timezone)
    .toBe("Asia/Tehran");
  const task = await readTask(request, created.entity_id);
  expect(Date.parse(task.due_at!)).toBe(Date.parse(original));
  expect(task.due_date).toBe("2062-02-12");
  expect(task.project_id).toBe(project.entity_id);
  expect(task.source_reference).toBe(
    "https://example.test/synthetic-reference",
  );
  await expect(
    detail.getByRole("link", { name: "بازکردن مرجع اصلی", exact: true }),
  ).toHaveAttribute("href", task.source_reference);
  await detail
    .getByRole("button", { name: "تقویم و زمان واقعی", exact: true })
    .click();
  const day = `${2100 + Math.floor(Math.random() * 6900)}-03-15`;
  await detail
    .getByRole("button", { name: "ثبت زمان واقعی برای این کار", exact: true })
    .click();
  const timeDialog = page.getByRole("dialog").last();
  await timeDialog
    .getByLabel("شروع بازهٔ مرتبط", { exact: true })
    .fill(`${day}T09:00:05`);
  await timeDialog
    .getByLabel("پایان بازهٔ مرتبط", { exact: true })
    .fill(`${day}T09:30:05`);
  await timeDialog
    .getByLabel("شرح بازهٔ مرتبط", { exact: true })
    .fill("Synthetic task-linked actual time.");
  const timeAcknowledged = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/commands") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.command === "time_entry_create" &&
      response.request().postDataJSON()?.input?.task_id === created.entity_id,
  );
  await timeDialog
    .getByRole("button", { name: "تأیید ثبت بازهٔ مرتبط", exact: true })
    .click();
  expect((await timeAcknowledged).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const summary = await readQuery<{ minutes: number; entries: number }>(
    request,
    "time_summary",
    { task_id: created.entity_id },
  );
  expect(summary.minutes).toBe(30);
  expect(summary.entries).toBe(1);
  const times = await readQuery<PageDTO<TimeEntryDTO>>(
    request,
    "time_entry_list",
    { task_id: created.entity_id },
  );
  expect(times.items).toHaveLength(1);
  expect(times.items[0].task_id).toBe(created.entity_id);
  await detail
    .getByLabel("شروع بازهٔ تقویم این کار", { exact: true })
    .fill(day);
  await detail
    .getByRole("button", { name: "ثبت رویداد محلی مرتبط", exact: true })
    .click();
  const eventDialog = page.getByRole("dialog").last();
  await eventDialog
    .getByLabel("عنوان رویداد مرتبط", { exact: true })
    .fill(`${title} linked event`);
  await eventDialog
    .getByLabel("شروع بازهٔ مرتبط", { exact: true })
    .fill(`${day}T10:00:07`);
  await eventDialog
    .getByLabel("پایان بازهٔ مرتبط", { exact: true })
    .fill(`${day}T11:00:07`);
  const eventAcknowledged = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/commands") &&
      response.request().method() === "POST" &&
      response.request().postDataJSON()?.command ===
        "calendar_create_local_event" &&
      response.request().postDataJSON()?.input?.task_id === created.entity_id,
  );
  await eventDialog
    .getByRole("button", { name: "تأیید ثبت بازهٔ مرتبط", exact: true })
    .click();
  expect((await eventAcknowledged).status()).toBe(200);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  const events = await readQuery<PageDTO<EventDTO>>(
    request,
    "calendar_events_query",
    {
      task_id: created.entity_id,
      from: zonedLocalToInstant(`${day}T00:00`, "Asia/Tehran"),
      to: zonedLocalToInstant(
        `${addCalendarDays(day, 1)}T00:00`,
        "Asia/Tehran",
      ),
    },
  );
  expect(events.items).toHaveLength(1);
  expect(events.items[0].task_id).toBe(created.entity_id);
  await expect(detail.locator(".task-schedule")).toContainText(
    `${title} linked event`,
  );
  expect((await readTask(request, created.entity_id)).due_date).toBe(
    "2062-02-12",
  );
});

test("calendar_pointer_creation_resize_source_filter_and_event_reminder_are_real", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} pointer calendar`;
  const day = "2063-06-15";
  await page.goto("/calendar");
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill(day);
  await page.getByRole("button", { name: "روز", exact: true }).click();
  const start = page.getByRole("button", {
    name: `ساخت رویداد در ${day} 09:00`,
    exact: true,
  });
  const end = page.getByRole("button", {
    name: `ساخت رویداد در ${day} 10:00`,
    exact: true,
  });
  await start.scrollIntoViewIfNeeded();
  const first = await start.boundingBox();
  const last = await end.boundingBox();
  expect(first).not.toBeNull();
  expect(last).not.toBeNull();
  await page.mouse.move(
    first!.x + first!.width / 2,
    first!.y + first!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(last!.x + last!.width / 2, last!.y + last!.height / 2, {
    steps: 5,
  });
  await page.mouse.up();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByLabel("عنوان", { exact: true }).fill(title);
  await dialog.getByLabel("دستهٔ رویداد", { exact: true }).selectOption("Work");
  await expect(dialog.getByLabel("شروع", { exact: true })).toHaveValue(
    `${day}T09:00`,
  );
  await expect(dialog.getByLabel("پایان", { exact: true })).toHaveValue(
    `${day}T10:00`,
  );
  await dialog
    .getByRole("button", { name: "ذخیرهٔ رویداد", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByLabel("جست‌وجوی تقویم", { exact: true }).fill(title);
  await page.getByLabel("منبع تقویم", { exact: true }).selectOption("local");
  await page.getByLabel("کار یا شخصی", { exact: true }).selectOption("Work");
  await expect(page.locator(".week-calendar .time-block")).toHaveCount(1);
  const input = {
    from: zonedLocalToInstant(`${day}T00:00`),
    to: zonedLocalToInstant(`${addCalendarDays(day, 1)}T00:00`),
    search: title,
    calendar_id: "local",
  };
  const original = (
    await readQuery<PageDTO<EventDTO>>(request, "calendar_events_query", input)
  ).items[0];
  expect(original.title).toBe(title);
  expect(original.category).toBe("Work");
  const resize = page.getByRole("button", {
    name: `تغییر طول رویداد ${title}`,
    exact: true,
  });
  await resize.scrollIntoViewIfNeeded();
  const box = await resize.boundingBox();
  const ack = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/commands") &&
      response.request().postDataJSON().command ===
        "calendar_update_local_event",
  );
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2,
    box!.y + box!.height / 2 + 26,
    { steps: 4 },
  );
  await page.mouse.up();
  expect((await ack).ok()).toBeTruthy();
  await expect
    .poll(
      async () =>
        Date.parse(
          (
            await readQuery<PageDTO<EventDTO>>(
              request,
              "calendar_events_query",
              input,
            )
          ).items[0].ends_at,
        ) - Date.parse(original.ends_at),
    )
    .toBe(30 * 60000);
  await page.locator(".time-block-open").click();
  await page
    .getByLabel("زمان یادآور رویداد", { exact: true })
    .fill(`${day}T08:00`);
  const reminderAcknowledged = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/commands") &&
      response.request().postDataJSON()?.command === "calendar_reminder_create",
  );
  await page
    .getByRole("button", { name: "ثبت یادآور رویداد", exact: true })
    .click();
  expect((await reminderAcknowledged).status()).toBe(200);
  let reminders = await readQuery<PageDTO<CalendarReminderDTO>>(
    request,
    "calendar_reminder_list",
    { event_id: original.event_id },
  );
  expect(reminders.items).toHaveLength(1);
  const reminder = reminders.items[0];
  try {
    await expect(
      page.locator(`[data-event-reminder-id="${reminder.reminder_id}"]`),
    ).toContainText("Pending");
    await page
      .getByRole("button", { name: "توقف یادآور رویداد", exact: true })
      .click();
    await expect(
      page.locator(`[data-event-reminder-id="${reminder.reminder_id}"]`),
    ).toContainText("Paused");
    await page
      .getByRole("button", { name: "لغو یادآور رویداد", exact: true })
      .click();
    await page
      .getByRole("button", { name: "تأیید تغییر یادآور رویداد", exact: true })
      .click();
    await expect(
      page.locator(`[data-event-reminder-id="${reminder.reminder_id}"]`),
    ).toContainText("Cancelled");
    reminders = await readQuery<PageDTO<CalendarReminderDTO>>(
      request,
      "calendar_reminder_list",
      { event_id: original.event_id },
    );
    expect(reminders.items[0].state).toBe("Cancelled");
  } finally {
    const actual = await readQuery<CalendarReminderDTO>(
      request,
      "calendar_reminder_get",
      { reminder_id: reminder.reminder_id },
    );
    if (actual.state === "Pending" || actual.state === "Paused")
      await mutate(
        request,
        "calendar_reminder_cancel",
        { reminder_id: actual.reminder_id },
        actual.revision,
      );
  }
});

test("dashboard_preferences_accessibility_and_pwa_capabilities_are_persistent_and_truthful", async ({
  page,
  request,
}) => {
  const before = await readQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>(request, "preferences_get");
  const preferenceResponses: {
    status: number;
    code: string | null;
    message: string | null;
  }[] = [];
  let releaseHeightAcknowledgement = () => {};
  page.on("response", async (response) => {
    if (
      response.request().method() !== "POST" ||
      !response.url().endsWith("/api/v1/commands")
    )
      return;
    const payload = response.request().postDataJSON();
    if (payload.command !== "preferences_update") return;
    let code: string | null = null;
    let message: string | null = null;
    try {
      const body = await response.json();
      code = body.error?.code ?? null;
      message = body.error?.message ?? null;
    } catch {
      /* Transport diagnostic retains status only. */
    }
    preferenceResponses.push({ status: response.status(), code, message });
  });
  try {
    await page.goto("/");
    await page
      .getByLabel("شروع بازهٔ داشبورد", { exact: true })
      .fill("2064-01-01");
    await page
      .getByLabel("پایان بازهٔ داشبورد (شامل نمی‌شود)", { exact: true })
      .fill("2064-02-01");
    await page
      .getByLabel("منطقهٔ زمانی داشبورد", { exact: true })
      .selectOption("Asia/Tehran");
    await page
      .getByRole("button", { name: "ثبت بازهٔ داشبورد", exact: true })
      .click();
    await expect.poll(() => preferenceResponses.length).toBeGreaterThan(0);
    expect(
      preferenceResponses[0].status,
      JSON.stringify(preferenceResponses[0]),
    ).toBe(200);
    await expect
      .poll(
        async () =>
          (
            await readQuery<{ settings: Record<string, unknown> }>(
              request,
              "preferences_get",
            )
          ).settings.dashboard_range,
      )
      .toEqual({
        from_date: "2064-01-01",
        to_date: "2064-02-01",
        timezone: "Asia/Tehran",
      });
    await page
      .getByRole("button", { name: "ویرایش میان‌برها", exact: true })
      .click();
    await page
      .getByRole("button", { name: "چیدمان داشبورد", exact: true })
      .click();
    const widgetHeight = page.getByLabel("ارتفاع ویجت ماتریس اولویت", {
      exact: true,
    });
    await expect(widgetHeight).toBeEnabled();
    let announceAcceptedHeight!: () => void;
    const acceptedHeight = new Promise<void>((resolve) => {
      announceAcceptedHeight = resolve;
    });
    const heldAcknowledgement = new Promise<void>((resolve) => {
      releaseHeightAcknowledgement = resolve;
    });
    let heightWriteCount = 0;
    await page.route("**/api/v1/commands", async (route) => {
      const payload = route.request().postDataJSON();
      if (
        payload.command !== "preferences_update" ||
        !payload.input?.settings?.dashboard_widgets?.some(
          (item: { id: string; height: number }) =>
            item.id === "priority" && item.height === 400,
        )
      ) {
        await route.continue();
        return;
      }
      heightWriteCount += 1;
      const response = await route.fetch();
      announceAcceptedHeight();
      await heldAcknowledgement;
      await route.fulfill({ response });
    });
    const heightAccepted = page.waitForResponse((response) => {
      if (
        response.request().method() !== "POST" ||
        !response.url().endsWith("/api/v1/commands")
      )
        return false;
      const payload = response.request().postDataJSON();
      return (
        payload.command === "preferences_update" &&
        payload.input?.settings?.dashboard_widgets?.some(
          (item: { id: string; height: number }) =>
            item.id === "priority" && item.height === 400,
        )
      );
    });
    await widgetHeight.fill("400");
    await acceptedHeight;
    await expect(widgetHeight).toBeDisabled();
    await expect(
      page.getByLabel("عرض ویجت ماتریس اولویت", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("عنوان میان‌بر", { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("مقصد میان‌بر", { exact: true }),
    ).toBeDisabled();
    await expect(page.locator('[data-widget-id="priority"]')).toHaveAttribute(
      "draggable",
      "false",
    );
    expect(heightWriteCount).toBe(1);
    releaseHeightAcknowledgement();
    expect((await heightAccepted).status()).toBe(200);
    await page.unroute("**/api/v1/commands");
    await expect
      .poll(
        async () =>
          (
            (
              await readQuery<{ settings: Record<string, unknown> }>(
                request,
                "preferences_get",
              )
            ).settings.dashboard_widgets as
              { id: string; height: number }[] | undefined
          )?.find((item) => item.id === "priority")?.height,
      )
      .toBe(400);
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(
      page.getByLabel("شروع بازهٔ داشبورد", { exact: true }),
    ).toHaveValue("2064-01-01");
    await expect(page.locator('[data-widget-id="priority"]')).toHaveCSS(
      "height",
      "400px",
    );
    const widget = page.locator('[data-widget-id="priority"]');
    await expect(widget).toHaveAttribute("draggable", "true");
    await expect(widget).toHaveCSS("resize", "vertical");
    await widget.scrollIntoViewIfNeeded();
    const rectangle = await widget.boundingBox();
    await page.mouse.move(
      rectangle!.x + 5,
      rectangle!.y + rectangle!.height - 5,
    );
    await page.mouse.down();
    await page.mouse.move(
      rectangle!.x + 5,
      rectangle!.y + rectangle!.height + 55,
      { steps: 6 },
    );
    await page.mouse.up();
    await expect
      .poll(
        async () =>
          (
            (
              await readQuery<{ settings: Record<string, unknown> }>(
                request,
                "preferences_get",
              )
            ).settings.dashboard_widgets as
              { id: string; height: number }[] | undefined
          )?.find((item) => item.id === "priority")?.height,
      )
      .toBeGreaterThan(400);
    await page.goto("/settings");
    await page
      .getByLabel("تراکم نمایش", { exact: true })
      .selectOption("compact");
    await page.getByLabel("نوشته‌های کوچک درشت‌تر", { exact: true }).check();
    await page.getByLabel("کنتراست بیشتر", { exact: true }).check();
    const reducedMotion = page.getByLabel("کاهش حرکت‌های رابط", {
      exact: true,
    });
    await reducedMotion.focus();
    await expect(reducedMotion).toBeFocused();
    if (!(await reducedMotion.isChecked())) await page.keyboard.press("Space");
    await expect(reducedMotion).toBeChecked();
    await page
      .getByLabel("فاصلهٔ پیشنهادی بازبینی بایگانی (روز)", { exact: true })
      .fill("365");
    await page
      .getByRole("button", {
        name: "ثبت تنظیمات خوانایی و نگهداری",
        exact: true,
      })
      .click();
    await expect
      .poll(
        async () =>
          (
            await readQuery<{ settings: Record<string, unknown> }>(
              request,
              "preferences_get",
            )
          ).settings.retention_days,
      )
      .toBe(365);
    const actual = await readQuery<{ settings: Record<string, unknown> }>(
      request,
      "preferences_get",
    );
    expect(actual.settings.display_density).toBe("compact");
    expect(actual.settings.accessibility).toMatchObject({
      reduced_motion: true,
      high_contrast: true,
      large_text: true,
    });
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute(
      "data-density",
      "compact",
    );
    await expect(page.locator("html")).toHaveAttribute(
      "data-large-text",
      "true",
    );
    await safeAxe(page, "settings-persisted-accessibility-preferences");
    await expect(
      page
        .getByRole("region", { name: "نصب برنامه", exact: true })
        .or(page.locator('section[aria-label="نصب برنامه"]')),
    ).toContainText("نسخهٔ آفلاین از اطلاعات خصوصی ذخیره نمی‌شود");
    const manifest = await safeGet(request, "/manifest.webmanifest");
    expect(manifest.ok()).toBeTruthy();
    const metadata = await manifest.json();
    expect(metadata.display).toBe("standalone");
    expect(metadata.start_url).toBe("/");
    for (const icon of metadata.icons as { src: string; sizes: string }[]) {
      const response = await safeGet(request, icon.src);
      expect(response.ok()).toBeTruthy();
      const bytes = await response.body();
      expect(
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
      ).toBeTruthy();
      expect(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`).toBe(
        icon.sizes,
      );
    }
    await expect
      .poll(async () =>
        page.evaluate(async () =>
          (await navigator.serviceWorker.getRegistrations()).some(
            (registration) => !!registration.active,
          ),
        ),
      )
      .toBeTruthy();
    const privateCaches = await page.evaluate(async () => {
      const names = await caches.keys();
      const urls: string[] = [];
      for (const name of names) {
        for (const key of await (await caches.open(name)).keys())
          urls.push(key.url);
      }
      return urls.filter((url) =>
        /\/api\/(?:v1|auth)|\/tasks|\/files|\/calendar/.test(url),
      );
    });
    expect(privateCaches).toEqual([]);
    await page.goto("/reports");
    await page
      .getByLabel("شروع بازهٔ گزارش", { exact: true })
      .fill("2064-01-01");
    await page
      .getByLabel("پایان بازهٔ گزارش (شامل نمی‌شود)", { exact: true })
      .fill("2064-02-01");
    await page
      .getByLabel("منطقهٔ زمانی گزارش", { exact: true })
      .fill("Asia/Tehran");
    await page
      .getByRole("button", { name: "نمایش این بازه", exact: true })
      .click();
    const reports = await readQuery<ReportsDTO>(request, "reports_summary", {
      from_date: "2064-01-01",
      to_date: "2064-02-01",
      timezone: "Asia/Tehran",
      limit: 50,
    });
    expect(reports.range.timezone).toBe("Asia/Tehran");
    await expect(
      page.locator("section.panel").filter({
        has: page.getByRole("heading", {
          name: "سن مهلت‌های عقب‌افتاده",
          exact: true,
        }),
      }),
    ).toContainText(String(reports.overdue_ageing.total));
    await expect(
      page.locator("section.panel").filter({
        has: page.getByRole("heading", {
          name: "حجم فایل‌های ثبت‌شده",
          exact: true,
        }),
      }),
    ).toContainText("سهمیهٔ حساب ذخیره‌ساز را نشان نمی‌دهد");
  } finally {
    releaseHeightAcknowledgement();
    await test.info().attach("preferences-command-responses", {
      body: JSON.stringify(preferenceResponses),
      contentType: "application/json",
    });
    const current = await readQuery<{
      settings: Record<string, unknown>;
      revision: number;
    }>(request, "preferences_get");
    await mutate(
      request,
      "preferences_update",
      {
        settings: {
          dashboard_range: before.settings.dashboard_range ?? null,
          dashboard_widgets: before.settings.dashboard_widgets ?? [],
          display_density: before.settings.display_density ?? "comfortable",
          accessibility: before.settings.accessibility ?? {
            reduced_motion: false,
            high_contrast: false,
            large_text: false,
          },
          retention_days: before.settings.retention_days ?? 0,
        },
      },
      current.revision,
    );
  }
});

test("deferred_in_app_ai_has_no_ui_entry_or_requests_and_mcp_remains_available", async ({
  page,
}) => {
  // Only the imported preference presentation is synthetic; this exercises actual
  // navigation and the deferred route without invoking an AI provider or write.
  const aiRequests: string[] = [];
  const aiActivityRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/v1/ai/")) aiRequests.push(url.pathname);
    if (
      url.pathname === "/api/v1/query" &&
      url.searchParams.get("operation") === "get_activity" &&
      JSON.parse(url.searchParams.get("input") ?? "{}").channel === "AI"
    )
      aiActivityRequests.push(url.pathname);
  });
  await page.route("**/api/v1/query?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("operation") !== "preferences_get") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = await response.json();
    body.data.settings.dashboard_widgets = [
      ...(body.data.settings.dashboard_widgets ?? []).filter(
        (item: { id: string }) => item.id !== "ai",
      ),
      { id: "ai", visible: true, order: 0, width: "wide", height: 400 },
    ];
    body.data.settings.dashboard_shortcuts = [
      { title: "Synthetic saved assistant shortcut", path: "/assistant" },
      { title: "Synthetic tasks shortcut", path: "/tasks" },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "امروز را روشن شروع کن.", exact: true }),
  ).toBeVisible();
  await expect(page.locator("main .loading-state")).toHaveCount(0);
  await expect(page.locator('a[href="/assistant"]')).toHaveCount(0);
  await expect(page.locator('[data-widget-id="ai"]')).toHaveCount(0);
  await expect(
    page.getByText("Synthetic saved assistant shortcut", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Synthetic tasks shortcut", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "ویرایش میان‌برها", exact: true })
    .click();
  await expect(
    page
      .getByLabel("مقصد میان‌بر", { exact: true })
      .locator('option[value="/assistant"]'),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "چیدمان داشبورد", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("آخرین تغییرهای دستیار", { exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "جست‌وجو و فرمان‌ها", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("dialog").locator('a[href="/assistant"]'),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.goto("/assistant");
  await expect(
    page.getByRole("heading", {
      name: "دستیار داخل برنامه غیرفعال است",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("با من فارسی یا انگلیسی صحبت کن…"),
  ).toHaveCount(0);
  await expect(page.locator("main form")).toHaveCount(0);
  await page
    .getByRole("link", { name: "تنظیمات اتصال MCP", exact: true })
    .click();
  await expect(page).toHaveURL(/\/settings#mcp-connection$/);
  await expect(
    page.getByRole("heading", { name: "اتصال Codex از طریق MCP", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#mcp-connection")).toContainText("/api/mcp");
  await expect(page.locator('a[href="/assistant"]')).toHaveCount(0);
  expect(aiRequests).toEqual([]);
  expect(aiActivityRequests).toEqual([]);
  await safeAxe(page, "deferred-ai-mcp-settings");
});
test("password_mismatch_and_invalid_current_password_do_not_change_owner_credentials", async ({
  page,
}) => {
  await page.goto("/settings");
  let requests = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/auth/change-password")) requests++;
  });
  let wrong = `E2E-invalid-current-${crypto.randomUUID()}`;
  while (wrong === credentials.password)
    wrong = `E2E-invalid-current-${crypto.randomUUID()}`;
  await page.getByLabel("رمز فعلی", { exact: true }).fill(wrong);
  const password = `E2E-unused-${crypto.randomUUID()}`;
  await page.getByLabel("رمز تازه", { exact: true }).fill(password);
  await page
    .getByLabel("تکرار رمز تازه", { exact: true })
    .fill(`${password}-mismatch`);
  await page
    .getByRole("button", {
      name: "ثبت رمز تازه و لغو نشست‌های دیگر",
      exact: true,
    })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "تکرار رمز با رمز تازه یکسان نیست" }),
  ).toBeVisible();
  expect(requests).toBe(0);
  await page.getByLabel("تکرار رمز تازه", { exact: true }).fill(password);
  const rejected = page.waitForResponse((response) =>
    response.url().endsWith("/api/auth/change-password"),
  );
  await page
    .getByRole("button", {
      name: "ثبت رمز تازه و لغو نشست‌های دیگر",
      exact: true,
    })
    .click();
  expect((await rejected).ok()).toBeFalsy();
  await expect(
    page.getByRole("button", {
      name: "ثبت رمز تازه و لغو نشست‌های دیگر",
      exact: true,
    }),
  ).toBeEnabled();
  expect(requests).toBe(1);
});

test("external_file_annotations_are_persistent_and_preserve_original_reference", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} annotated file`;
  const reference = `https://drive.google.com/file/d/synthetic-${crypto.randomUUID()}/view`;
  const result = await mutate(request, "file_register_external_link", {
    title,
    provider: "google_drive",
    external_id: `synthetic-${crypto.randomUUID()}`,
    external_url: reference,
    original_filename: `${title}.txt`,
  });
  await page.goto(`/files?file=${encodeURIComponent(result.entity_id)}`);
  await page
    .getByLabel("توضیح فایل", { exact: true })
    .fill("Synthetic annotation <script>never executed</script>");
  await page
    .getByLabel("برچسب‌های فایل؛ هر برچسب یک خط", { exact: true })
    .fill("پژوهش\nsynthetic-e2e");
  await page
    .getByRole("button", { name: "ذخیرهٔ توضیح و برچسب‌ها", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await readQuery<FileDTO>(request, "file_get_metadata", {
            file_id: result.entity_id,
          })
        ).description,
    )
    .toBe("Synthetic annotation <script>never executed</script>");
  const actual = await readQuery<FileDTO>(request, "file_get_metadata", {
    file_id: result.entity_id,
  });
  expect(actual.tags).toEqual(["پژوهش", "synthetic-e2e"]);
  expect(actual.external_url).toBe(reference);
  expect(actual.original_filename).toBe(`${title}.txt`);
  await page.reload();
  await expect(page.getByLabel("توضیح فایل", { exact: true })).toHaveValue(
    actual.description!,
  );
  await expect(
    page.getByRole("link", { name: "بازکردن منبع", exact: true }),
  ).toHaveAttribute("href", reference);
});

function screenshotPath(filename: string) {
  if (basename(filename) !== filename)
    throw new Error("Screenshot filenames cannot contain directories.");
  return join(screenshotDirectory, filename);
}

async function signIn(request: APIRequestContext) {
  let response: APIResponse | undefined;
  let waited = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    response = await safePost(request, "/api/auth/sign-in/email", {
      headers: { Origin: origin },
      data: { email: credentials.email, password: credentials.password },
    });
    if (response.status() !== 429 || attempt === 2) break;
    const headers = response.headers();
    const retry = headers["x-retry-after"] ?? headers["retry-after"];
    const seconds = retry
      ? Number.isFinite(Number(retry))
        ? Number(retry)
        : (Date.parse(retry) - Date.now()) / 1000
      : NaN;
    const delay = Math.ceil(seconds * 1000);
    if (!Number.isFinite(delay) || delay < 0 || waited + delay > 30000) break;
    waited += delay;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  expect(
    response?.ok(),
    `Isolated staging owner authentication must succeed (HTTP ${response?.status() ?? "unavailable"}); only a bounded 429 retry is permitted.`,
  ).toBeTruthy();
}
async function readTask(
  request: APIRequestContext,
  id: string,
): Promise<TaskDTO> {
  const response = await safeGet(
    request,
    `/api/v1/query?operation=task_get&input=${encodeURIComponent(JSON.stringify({ task_id: id }))}`,
  );
  const body = await response.json();
  expect(
    response.ok(),
    `task_get HTTP ${response.status()} ${body.error?.code ?? ""}`,
  ).toBeTruthy();
  expect(body.data, "task_get must return canonical data").toBeTruthy();
  return body.data;
}

async function readQuery<T>(
  request: APIRequestContext,
  operation: string,
  input: Record<string, unknown> = {},
): Promise<T> {
  const response = await safeGet(
    request,
    `/api/v1/query?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  const body = await response.json();
  expect(
    response.ok(),
    `${operation} HTTP ${response.status()} ${body.error?.code ?? ""}`,
  ).toBeTruthy();
  expect(body.data, `${operation} must return canonical data`).toBeTruthy();
  return body.data;
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

test.beforeEach(async ({ request, context, page }, testInfo) => {
  test.skip(
    testInfo.title ===
      "dependency_graph_works_after_redeploy_and_fresh_login" &&
      !process.env.E2E_REDEPLOY_SCRIPT,
    "Actual redeploy proof requires the explicitly configured coordinator script.",
  );
  context.on("request", (request) => {
    if (
      !["GET", "POST"].includes(request.method()) ||
      new URL(request.url()).pathname !== "/api/auth/get-session"
    )
      return;
    authRequestsSinceIdle++;
    totalBrowserSessionRequests++;
    lastBrowserSessionRequestAt = Date.now();
    maximumAuthCheckpointCount = Math.max(
      maximumAuthCheckpointCount,
      authRequestsSinceIdle,
    );
  });
  // Prior files share the IP bucket. Establish the first boundary here, within
  // the existing 180s test budget; beforeAll has a separate 60s hook budget.
  // The largest case makes 24 navigations, so later checkpoints at 25 leave
  // room for a whole case without any inter-action auth delay.
  await authIdleBoundary(!initialAuthIdleComplete);
  initialAuthIdleComplete = true;
  originalPreferences = undefined;
  await signIn(request);
  const captured = await readQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>(request, "preferences_get");
  originalPreferences = captured;
  if (
    captured.settings.language !== "fa" ||
    captured.settings.theme !== "dark"
  ) {
    await mutate(
      request,
      "preferences_update",
      { settings: { language: "fa", theme: "dark" } },
      captured.revision,
    );
  }
  await context.addCookies((await request.storageState()).cookies);
  page.setDefaultTimeout(30000);
});

test.afterEach(() => {
  console.log(
    "WORKFLOW_AUTH_BUDGET",
    JSON.stringify({
      requests_since_idle: authRequestsSinceIdle,
      max_checkpoint_count: maximumAuthCheckpointCount,
      total_session_requests: totalBrowserSessionRequests,
    }),
  );
});

test.afterEach(async ({ request }) => {
  if (
    !originalPreferences ||
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)
  )
    return;
  const current = await readQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>(request, "preferences_get");
  await mutate(
    request,
    "preferences_update",
    {
      settings: {
        language: originalPreferences.settings.language ?? null,
        theme: originalPreferences.settings.theme ?? null,
      },
    },
    current.revision,
  );
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
  const longSearch = "ی".repeat(2500);
  const encodedQuery = page.waitForResponse((response) => {
    if (
      !response.url().endsWith("/api/v1/query") ||
      response.request().method() !== "POST"
    )
      return false;
    const body = response.request().postDataJSON();
    return (
      body.operation === "task_graph_get" && body.input.search === longSearch
    );
  });
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(longSearch);
  const fallback = await encodedQuery;
  expect(fallback.ok()).toBeTruthy();
  expect((await fallback.json()).data.nodes).toHaveLength(4);
  await page.getByPlaceholder("جست‌وجو بین کارها…").fill(data.a.title);
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
  test.setTimeout(25 * 60 * 1000);
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
    path: screenshotPath("synthetic-mobile-dependency.png"),
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
    path: screenshotPath("synthetic-desktop-tasks.png"),
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
  const data =
    await test.step("Create the canonical synthetic graph fixture", () =>
      fixture(request));
  const preferenceURL = "/api/v1/query?operation=preferences_get&input=%7B%7D";
  const initial = (await (await safeGet(request, preferenceURL)).json()).data;
  try {
    for (const appearance of [
      { theme: "dark", language: "fa", dir: "rtl" },
      { theme: "light", language: "en", dir: "ltr" },
    ]) {
      const current = (await (await safeGet(request, preferenceURL)).json())
        .data;
      await test.step(`Persist ${appearance.theme} ${appearance.language} appearance`, () =>
        mutate(
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
        ));
      await test.step(`Open the ${appearance.theme} dashboard`, () =>
        page.goto("/"));
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
          await expect(page.locator("html")).toHaveAttribute(
            "lang",
            appearance.language,
          );
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
        const axe =
          await test.step(`Whole-page axe ${location} ${appearance.theme}`, () =>
            new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze());
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
        await test.step(`Capture ${location} ${appearance.theme}`, () =>
          page.screenshot({
            path: screenshotPath(
              `synthetic-${location}-${appearance.theme}-${appearance.dir}.png`,
            ),
            fullPage: false,
          }));
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

test("schedule_preview_requires_estimates_and_preserves_deadlines_until_confirmation", async ({
  page,
  request,
}) => {
  const data = await fixture(request);
  async function openPlan() {
    await page.goto("/tasks");
    await page.getByPlaceholder("جست‌وجو بین کارها…").fill(data.prefix);
    await page.getByRole("button", { name: "timeline", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "برنامهٔ وابستگی‌ها و پیشنهاد زمان‌بندی",
        exact: true,
      }),
    ).toBeVisible();
  }
  await openPlan();
  await expect(
    page.getByRole("button", {
      name: "پیش‌نمایش پیشنهاد؛ بدون ذخیرهٔ تاریخ",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByText("مسیر بحرانی قابل محاسبه نیست:", { exact: false }),
  ).toBeVisible();
  for (const task of [data.a, data.b, data.c, data.d]) {
    const current = await readTask(request, task.task_id);
    await mutate(
      request,
      "task_update",
      { task_id: task.task_id, estimated_minutes: 30, due_date: "2055-12-20" },
      current.revision,
    );
  }
  await openPlan();
  await expect(
    page.getByRole("heading", {
      name: "طولانی‌ترین زنجیرهٔ برآوردشده",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByLabel("شروع پیشنهادی", { exact: true }).fill("2055-12-10");
  await page.getByLabel("ظرفیت کل روز (دقیقه)", { exact: true }).fill("60");
  await page
    .getByRole("button", {
      name: "پیش‌نمایش پیشنهاد؛ بدون ذخیرهٔ تاریخ",
      exact: true,
    })
    .click();
  const review = page.getByRole("dialog", {
    name: "بررسی تغییر تاریخ‌های پیشنهادی",
    exact: true,
  });
  await expect(review).toBeVisible();
  expect((await readTask(request, data.a.task_id)).start_date).toBeNull();
  await review
    .getByRole("button", { name: "لغو پیشنهاد", exact: true })
    .click();
  expect((await readTask(request, data.a.task_id)).start_date).toBeNull();
  await page
    .getByRole("button", {
      name: "پیش‌نمایش پیشنهاد؛ بدون ذخیرهٔ تاریخ",
      exact: true,
    })
    .click();
  await review
    .getByRole("button", { name: "تأیید صریح و ذخیرهٔ تاریخ‌ها", exact: true })
    .click();
  await expect(review).not.toBeVisible();
  for (const task of [data.a, data.b, data.c, data.d]) {
    const actual = await readTask(request, task.task_id);
    expect(actual.start_date).not.toBeNull();
    expect(actual.due_date).toBe("2055-12-20");
  }
});

test("calendar_single_occurrence_preview_preserves_series_and_saves_linked_override", async ({
  page,
  request,
}) => {
  const month = new Date().toISOString().slice(0, 7);
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} occurrence`;
  const starts_at = `${month}-02T08:15:23Z`,
    ends_at = `${month}-02T09:15:23Z`;
  const created = await mutate(request, "calendar_create_local_event", {
    title,
    starts_at,
    ends_at,
    timezone: "Europe/Berlin",
    recurrence_rule: "FREQ=DAILY;COUNT=7",
  });
  const input = {
    from: `${month}-01T00:00:00Z`,
    to: `${month}-20T00:00:00Z`,
    limit: 200,
  };
  const before = (
    await readQuery<PageDTO<EventDTO>>(request, "calendar_events_query", input)
  ).items.filter((event) => event.event_id === created.entity_id);
  expect(before).toHaveLength(7);
  await page.goto("/calendar");
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill(`${month}-02`);
  await page.getByRole("button", { name: "فهرست", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await page
    .getByRole("button", { name: "تغییر فقط این نوبت", exact: true })
    .click();
  const editor = page.getByRole("dialog", {
    name: "جابه‌جایی یا تغییر طول فقط این نوبت",
    exact: true,
  });
  await editor
    .getByLabel("شروع این نوبت", { exact: true })
    .fill(`${month}-02T14:30`);
  await editor
    .getByLabel("پایان این نوبت", { exact: true })
    .fill(`${month}-02T16:00`);
  await editor
    .getByRole("button", { name: "پیش‌نمایش تغییر نوبت", exact: true })
    .click();
  await expect(
    editor.getByRole("button", {
      name: "تأیید تغییر فقط این نوبت",
      exact: true,
    }),
  ).toBeVisible();
  const previewOnly = (
    await readQuery<PageDTO<EventDTO>>(request, "calendar_events_query", input)
  ).items.filter((event) => event.event_id === created.entity_id);
  expect(previewOnly.map((event) => event.starts_at)).toEqual(
    before.map((event) => event.starts_at),
  );
  await editor
    .getByRole("button", { name: "تأیید تغییر فقط این نوبت", exact: true })
    .click();
  await expect(editor).not.toBeVisible();
  const after = (
    await readQuery<PageDTO<EventDTO>>(request, "calendar_events_query", input)
  ).items;
  const series = after.filter((event) => event.event_id === created.entity_id);
  const override = after.find(
    (event) => event.series_event_id === created.entity_id,
  );
  expect(series).toHaveLength(6);
  expect(
    series.every(
      (event) =>
        Date.parse(event.series_starts_at!) === Date.parse(starts_at) &&
        event.recurrence_rule === "FREQ=DAILY;COUNT=7",
    ),
  ).toBeTruthy();
  expect(override).toBeDefined();
  expect(Date.parse(override!.starts_at)).toBe(
    Date.parse(zonedLocalToInstant(`${month}-02T14:30`)),
  );
  expect(override!.original_occurrence_starts_at).toBe(before[0].starts_at);
  expect(
    series.some((event) => event.starts_at === before[0].starts_at),
  ).toBeFalsy();
});

test("project_and_task_archives_restore_without_cascading_to_children", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} project`;
  const created = await mutate(request, "project_create", {
    title,
    notes: "Synthetic independent archive",
    area: "Research",
  });
  const taskResult = await mutate(request, "task_create", {
    title: `${title} task`,
    project_id: created.entity_id,
  });
  const task = await readTask(request, taskResult.entity_id);
  await page.goto("/projects");
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await page.getByRole("button", { name: "ویرایش پروژه", exact: true }).click();
  await page
    .getByRole("dialog")
    .first()
    .getByLabel("توضیح", { exact: true })
    .fill("Edited through owner UI.");
  await page.getByRole("button", { name: "ذخیرهٔ پروژه", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "ذخیرهٔ پروژه", exact: true }),
  ).not.toBeVisible();
  expect(
    (
      await readQuery<ProjectDTO>(request, "project_get", {
        project_id: created.entity_id,
      })
    ).notes,
  ).toBe("Edited through owner UI.");
  await page
    .getByRole("button", { name: "بایگانی پروژه", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تأیید تغییر پروژه", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (
      await readQuery<ProjectDTO>(request, "project_get", {
        project_id: created.entity_id,
      })
    ).archived_at,
  ).not.toBeNull();
  expect((await readTask(request, task.task_id)).archived_at).toBeNull();
  await page.getByRole("button", { name: "بایگانی", exact: true }).click();
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await page
    .getByRole("button", { name: "بازیابی پروژه", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تأیید تغییر پروژه", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(
    (
      await readQuery<ProjectDTO>(request, "project_get", {
        project_id: created.entity_id,
      })
    ).archived_at,
  ).toBeNull();
  await openTask(page, task);
  await page
    .getByRole("button", { name: "انتقال به بایگانی", exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, task.task_id)).archived_at)
    .not.toBeNull();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "بایگانی", exact: true }).click();
  await page
    .getByRole("button", { name: task.title, exact: true })
    .first()
    .click();
  await page
    .getByRole("button", { name: "بازیابی کار", exact: true })
    .first()
    .click();
  await expect
    .poll(async () => (await readTask(request, task.task_id)).archived_at)
    .toBeNull();
});

async function safeAxe(page: Page, name: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  const violations = results.violations.map((item) => ({
    id: item.id,
    impact: item.impact,
    targets: item.nodes.map((node) => node.target),
  }));
  await test.info().attach(`${name}-accessibility`, {
    body: JSON.stringify(violations),
    contentType: "application/json",
  });
  expect(violations, `${name} automated accessibility findings`).toEqual([]);
}

test("all_main_views_have_synthetic_desktop_mobile_and_tablet_evidence", async ({
  page,
  request,
}) => {
  test.setTimeout(300000);
  const current = await readQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>(request, "preferences_get");
  await mutate(
    request,
    "preferences_update",
    { settings: { ...current.settings, language: "fa", theme: "dark" } },
    current.revision,
  );
  const day = new Date().toISOString().slice(0, 10);
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} visual event`;
  await mutate(request, "calendar_create_local_event", {
    title,
    starts_at: zonedLocalToInstant(`${day}T09:00`),
    ends_at: zonedLocalToInstant(`${day}T10:30`),
    timezone: "Europe/Berlin",
  });
  await mutate(request, "calendar_create_local_event", {
    title: `${title} all day`,
    starts_at: zonedLocalToInstant(`${day}T00:00`),
    ends_at: zonedLocalToInstant(`${addCalendarDays(day, 1)}T00:00`),
    timezone: "Europe/Berlin",
    all_day: true,
  });
  const views = [
    ["projects", "پروژه‌ها"],
    ["calendar", "تقویم"],
    ["time", "ساعات کار"],
    ["files", "فایل‌ها و منابع"],
    ["reports", "گزارش و مرور"],
    ["settings", "تنظیمات و اتصال‌ها"],
  ];
  for (const viewport of [
    { width: 1440, height: 1000, label: "desktop" },
    { width: 375, height: 812, label: "mobile" },
    { width: 768, height: 1024, label: "tablet" },
  ]) {
    await page.setViewportSize(viewport);
    for (const [route, heading] of views) {
      await page.goto(`/${route}`);
      await expect(
        page.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
      await expect(page.locator("main .loading-state")).toHaveCount(0);
      await expect(page.locator("main [role=alert]")).toHaveCount(0);
      if (route === "settings")
        await expect(
          page.getByRole("button", { name: "تازه‌سازی اتصال‌ها", exact: true }),
        ).toBeEnabled();
      if (route === "calendar") {
        await page.getByLabel("تاریخ تقویم", { exact: true }).fill(day);
        for (const name of ["ماه", "هفته", "روز", "فهرست"]) {
          await page.getByRole("button", { name, exact: true }).click();
          await expect(page.locator("main .loading-state")).toHaveCount(0);
          await safeAxe(page, `calendar-${name}-${viewport.label}`);
          await page.screenshot({
            path: screenshotPath(
              `synthetic-calendar-${name}-${viewport.label}.png`,
            ),
            fullPage: false,
          });
        }
      } else {
        await safeAxe(page, `${route}-${viewport.label}`);
        await page.screenshot({
          path: screenshotPath(`synthetic-${route}-${viewport.label}.png`),
          fullPage: false,
          mask: [page.locator("[data-private]")],
        });
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${route} ${viewport.label} must not overflow the page`,
      ).toBeTruthy();
    }
  }
});

test("worklog_exact_edit_month_summary_json_preview_export_and_archive_are_canonical", async ({
  page,
  request,
}) => {
  const year = 2100 + (parseInt(crypto.randomUUID().slice(0, 4), 16) % 7000);
  const month = `${year}-12`;
  const employer = `E2E-${crypto.randomUUID().slice(0, 8)}`;
  const first = await mutate(request, "time_entry_create", {
    employer,
    starts_at: zonedLocalToInstant(`${year}-11-30T23:30`),
    ends_at: zonedLocalToInstant(`${year}-12-01T01:30`),
    description: `${employer} overnight`,
  });
  const second = await mutate(request, "time_entry_create", {
    employer,
    starts_at: `${year}-12-02T11:00:33Z`,
    ends_at: `${year}-12-02T12:00:33Z`,
    description: `${employer} precise`,
  });
  const from = zonedLocalToInstant(`${year}-12-01T00:00`),
    to = zonedLocalToInstant(`${year + 1}-01-01T00:00`);
  const summary = await readQuery<{
    minutes: number;
    employers: Record<string, number>;
  }>(request, "time_summary", { from, to });
  expect(summary.employers[employer]).toBe(150);
  await page.goto("/time");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور");
  await page.getByLabel("ماه", { exact: true }).fill(month);
  const row = page.locator(`[data-work-entry="${second.entity_id}"]`);
  await row
    .locator("xpath=following-sibling::tr[1]")
    .getByLabel("شرح فعالیت ردیف", { exact: true })
    .fill(`${employer} notes-only edit`);
  await page
    .getByRole("heading", { name: "جدول ساعات و توضیحات", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await readQuery<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
            from,
            to,
            limit: 200,
          })
        ).items.find((entry) => entry.entry_id === second.entity_id)
          ?.description,
    )
    .toBe(`${employer} notes-only edit`);
  const afterEdit = (
    await readQuery<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
      from,
      to,
      limit: 200,
    })
  ).items.find((entry) => entry.entry_id === second.entity_id);
  expect(afterEdit?.starts_at).toBe(`${year}-12-02T11:00:33.000Z`);
  expect(afterEdit?.ends_at).toBe(`${year}-12-02T12:00:33.000Z`);
  const data = {
    format: "ramin-life-os-time/1",
    timezone: "Europe/Berlin",
    entries: [
      {
        entry_id: `W-E2E-${crypto.randomUUID()}`,
        employer,
        starts_at: `${year}-12-03T10:00:12Z`,
        ends_at: `${year}-12-03T11:00:12Z`,
        description: `${employer} import`,
        task_id: null,
      },
    ],
  };
  const input = page.locator(".time-transfer input[type=file]");
  await input.setInputFiles({
    name: "synthetic-time.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const review = page.getByRole("dialog", {
    name: "بررسی واردسازی بازه‌های کار",
    exact: true,
  });
  await expect(review).toBeVisible();
  expect(
    (
      await readQuery<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
        from,
        to,
        limit: 200,
      })
    ).items.some((entry) => entry.entry_id === data.entries[0].entry_id),
  ).toBeFalsy();
  await review
    .getByRole("button", { name: "لغو واردسازی", exact: true })
    .click();
  await input.setInputFiles({
    name: "synthetic-time.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  await review
    .getByRole("button", { name: "تأیید صریح و واردسازی بازه‌ها", exact: true })
    .click();
  await expect(review).not.toBeVisible();
  const canonical = (
    await readQuery<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
      from,
      to,
      limit: 200,
    })
  ).items;
  expect(
    canonical.find((entry) => entry.entry_id === data.entries[0].entry_id)
      ?.starts_at,
  ).toBe(`${year}-12-03T10:00:12.000Z`);
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "خروجی JSON همهٔ بازه‌های ماه", exact: true })
    .click();
  const download = await downloadEvent;
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const exported = JSON.parse(await readFile(downloadedPath!, "utf8"));
  expect(exported.format).toBe("ramin-life-os-time/1");
  expect(
    exported.entries.find(
      (entry: { entry_id: string }) =>
        entry.entry_id === data.entries[0].entry_id,
    ),
  ).toEqual({
    ...data.entries[0],
    starts_at: `${year}-12-03T10:00:12.000Z`,
    ends_at: `${year}-12-03T11:00:12.000Z`,
    reporting_policy: "elapsed",
    reported_minutes: null,
    legacy_metadata: {},
  });
  expect(
    exported.entries.every((entry: Record<string, unknown>) =>
      Object.keys(entry).every((key) =>
        [
          "entry_id",
          "employer",
          "starts_at",
          "ends_at",
          "description",
          "task_id",
          "reporting_policy",
          "reported_minutes",
          "legacy_metadata",
        ].includes(key),
      ),
    ),
  ).toBeTruthy();
  expect(Array.isArray(exported.drafts)).toBe(true);
  const fullDownloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "خروجی JSON تمام تاریخچه و پیش‌نویس‌ها",
      exact: true,
    })
    .click();
  const fullDownload = await fullDownloadEvent;
  const allHistory = JSON.parse(
    await readFile((await fullDownload.path())!, "utf8"),
  );
  expect(
    allHistory.entries.some(
      (entry: { entry_id: string }) => entry.entry_id === first.entity_id,
    ),
  ).toBe(true);
  expect(
    allHistory.entries.some(
      (entry: { entry_id: string }) =>
        entry.entry_id === data.entries[0].entry_id,
    ),
  ).toBe(true);
  await page
    .locator(`[data-work-entry="${first.entity_id}"]`)
    .getByRole("button", { name: "بایگانی", exact: true })
    .click();
  await expect
    .poll(async () =>
      (
        await readQuery<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
          from,
          to,
          limit: 200,
        })
      ).items.some((entry) => entry.entry_id === first.entity_id),
    )
    .toBe(false);
  expect(
    (
      await readQuery<{ employers: Record<string, number> }>(
        request,
        "time_summary",
        { from, to },
      )
    ).employers[employer],
  ).toBe(120);
});

test("file_provider_disabled_and_archive_eligibility_are_truthful", async ({
  page,
  request,
}) => {
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} readonly reference`;
  const fileId = `synthetic-${crypto.randomUUID()}`;
  const created = await mutate(request, "file_register_external_link", {
    title,
    provider: "google_drive",
    external_id: fileId,
    external_url: `https://drive.google.com/file/d/${fileId}/view`,
    original_filename: `${title}.pdf`,
  });
  const capabilities = await readQuery<Record<string, unknown>>(
    request,
    "system_capabilities",
  );
  await page.goto("/files");
  if (capabilities.storage_configured !== true) {
    await expect(
      page.getByText(
        "بارگذاری فایل جدید به اتصال ذخیره‌سازی خصوصی نیاز دارد.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(page.locator(".page-heading input[type=file]")).toBeDisabled();
  }
  await page.getByPlaceholder("جست‌وجوی فایل‌ها…").fill(title);
  await page
    .getByRole("button", { name: new RegExp(title) })
    .first()
    .click();
  await expect(
    page.getByRole("link", { name: "بازکردن منبع", exact: true }),
  ).toHaveAttribute("href", `https://drive.google.com/file/d/${fileId}/view`);
  await expect(
    page.getByRole("dialog").first().locator("input[type=file]"),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "بررسی امکان بایگانی", exact: true })
    .click();
  const review = page.getByRole("dialog", {
    name: "بررسی و تأیید بایگانی فایل",
    exact: true,
  });
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("button", { name: /تأیید.*بایگانی/ }),
  ).toHaveCount(0);
  expect(
    (
      await readQuery<{ state: string }>(request, "file_get_metadata", {
        file_id: created.entity_id,
      })
    ).state,
  ).toBe("External");
});

test("reminder_pause_resume_cancel_and_tool_revocation_require_real_owner_actions", async ({
  page,
  request,
}) => {
  const taskResult = await mutate(request, "task_create", {
    title: `E2E-${crypto.randomUUID().slice(0, 8)} reminder`,
  });
  const reminder = await mutate(request, "reminder_create", {
    task_id: taskResult.entity_id,
    remind_at: "2055-12-12T12:00:00Z",
  });
  const token = await scopedToken(
    (await request.storageState()).cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; "),
    ["tasks:read"],
  );
  await page.goto("/settings");
  const reminderRow = page.locator(
    `[data-reminder-id="${reminder.entity_id}"]`,
  );
  await reminderRow
    .getByRole("button", { name: "توقف یادآور", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await readQuery<PageDTO<{ reminder_id: string; state: string }>>(
            request,
            "reminder_list",
            { limit: 200 },
          )
        ).items.find((item) => item.reminder_id === reminder.entity_id)?.state,
    )
    .toBe("Paused");
  const paused = page.locator(`[data-reminder-id="${reminder.entity_id}"]`);
  await paused
    .getByRole("button", { name: "ازسرگیری یادآور", exact: true })
    .click();
  await page
    .getByRole("button", { name: "تأیید تغییر یادآور", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await readQuery<PageDTO<{ reminder_id: string; state: string }>>(
            request,
            "reminder_list",
            { limit: 200 },
          )
        ).items.find((item) => item.reminder_id === reminder.entity_id)?.state,
    )
    .toBe("Pending");
  await expect(
    page
      .locator(`[data-reminder-id="${reminder.entity_id}"]`)
      .getByRole("button", { name: "توقف یادآور", exact: true }),
  ).toBeVisible();
  await page
    .locator(`[data-reminder-id="${reminder.entity_id}"]`)
    .getByRole("button", { name: "لغو یادآور", exact: true })
    .click();
  const cancellationResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/commands") &&
      response.request().postDataJSON()?.command === "reminder_cancel",
  );
  await page
    .getByRole("button", { name: "تأیید تغییر یادآور", exact: true })
    .click();
  const cancelled = await cancellationResponse;
  expect(
    cancelled.ok(),
    `Reminder cancellation must acknowledge success: HTTP ${cancelled.status()}`,
  ).toBeTruthy();
  await expect
    .poll(
      async () =>
        (
          await readQuery<PageDTO<{ reminder_id: string; state: string }>>(
            request,
            "reminder_list",
            { limit: 200 },
          )
        ).items.find((item) => item.reminder_id === reminder.entity_id)?.state,
    )
    .toBe("Cancelled");
  const connections = await safeGet(request, "/api/v1/connections");
  expect(connections.ok()).toBeTruthy();
  const client = (await connections.json()).data.items.find(
    (item: { client_id: string }) => item.client_id === token.clientId,
  );
  expect(client).toBeDefined();
  const grant = page.locator(`[data-client-id="${token.clientId}"]`);
  // The client is newly created for this test; other staging tool grants are untouched.
  await grant
    .last()
    .getByRole("button", { name: "لغو دسترسی", exact: true })
    .click();
  const revoke = page.getByRole("dialog", {
    name: "لغو دسترسی ابزار",
    exact: true,
  });
  await revoke.getByRole("checkbox").check();
  await revoke
    .getByRole("button", { name: "تأیید لغو دسترسی", exact: true })
    .click();
  await expect(revoke).not.toBeVisible();
  const attempt = await safeGetWithToken(
    request,
    token.accessToken,
    "/api/v1/query?operation=task_search&input=%7B%7D",
  );
  expect([401, 403]).toContain(attempt.status());
});

async function safeGetWithToken(
  request: APIRequestContext,
  token: string,
  url: string,
): Promise<APIResponse> {
  try {
    return await request.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(
      "Revoked synthetic OAuth probe transport failed; credential headers omitted.",
    );
  }
}

test("all_day_drag_keeps_calendar_days_across_dst_and_timed_drag_keeps_seconds", async ({
  page,
  request,
}) => {
  const original = {
    starts_at: zonedLocalToInstant("2027-03-21T00:00"),
    ends_at: zonedLocalToInstant("2027-03-22T00:00"),
    timezone: "Europe/Berlin",
    all_day: true,
  };
  const moved = moveLocalEventToDate(original, "2027-03-28");
  expect(moved.starts_at).toBe("2027-03-27T23:00:00.000Z");
  expect(moved.ends_at).toBe("2027-03-28T22:00:00.000Z");
  const autumn = moveLocalEventToDate(original, "2027-10-31");
  expect(autumn.ends_at).toBe("2027-10-31T23:00:00.000Z");
  const timed = moveLocalEventToDate(
    {
      ...original,
      all_day: false,
      starts_at: "2027-03-21T08:07:23.123Z",
      ends_at: "2027-03-21T09:37:23.123Z",
    },
    "2027-03-28",
  );
  expect(timed.starts_at).toBe("2027-03-28T07:07:23.123Z");
  expect(Date.parse(timed.ends_at) - Date.parse(timed.starts_at)).toBe(
    90 * 60000,
  );
  const title = `E2E-${crypto.randomUUID().slice(0, 8)} all-day DST`;
  const created = await mutate(request, "calendar_create_local_event", {
    title,
    ...original,
  });
  await page.goto("/calendar");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور");
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill("2027-03-21");
  const source = page.getByRole("button", { name: title, exact: true });
  await expect(source).toBeVisible();
  const target = page.locator('[data-calendar-date="2027-03-28"]');
  await target.scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const events: {
      type: string;
      day: string | null;
      types: string[];
      prevented: boolean;
    }[] = [];
    Reflect.set(window, "__syntheticDragEvents", events);
    for (const name of [
      "dragstart",
      "dragenter",
      "dragover",
      "drop",
      "dragend",
    ]) {
      document.addEventListener(name, (event) => {
        if (events.length < 100)
          events.push({
            type: name,
            day:
              (event.target as HTMLElement)
                .closest("[data-calendar-date]")
                ?.getAttribute("data-calendar-date") ?? null,
            types: [...((event as DragEvent).dataTransfer?.types ?? [])],
            prevented: event.defaultPrevented,
          });
      });
    }
  });
  const movementResponse = page.waitForResponse((response) => {
    if (
      response.request().method() !== "POST" ||
      !response.url().endsWith("/api/v1/commands")
    )
      return false;
    const body = response.request().postDataJSON();
    return (
      body.command === "calendar_update_local_event" &&
      body.input.event_id === created.entity_id
    );
  });
  await source.dragTo(target);
  await test.info().attach("native-calendar-drag-events", {
    body: JSON.stringify(
      await page.evaluate(() => Reflect.get(window, "__syntheticDragEvents")),
    ),
    contentType: "application/json",
  });
  const movement = await movementResponse;
  expect(
    movement.ok(),
    `Calendar drag must acknowledge success: HTTP ${movement.status()}`,
  ).toBeTruthy();
  const input = {
    from: "2027-03-01T00:00:00Z",
    to: "2027-04-01T00:00:00Z",
    limit: 200,
  };
  await expect
    .poll(
      async () =>
        (
          await readQuery<PageDTO<EventDTO>>(
            request,
            "calendar_events_query",
            input,
          )
        ).items.find((event) => event.event_id === created.entity_id)
          ?.starts_at,
    )
    .toBe(moved.starts_at);
  const actual = (
    await readQuery<PageDTO<EventDTO>>(request, "calendar_events_query", input)
  ).items.find((event) => event.event_id === created.entity_id);
  expect(actual?.ends_at).toBe(moved.ends_at);
  await expect(
    page
      .locator('[data-calendar-date="2027-03-28"]')
      .getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
  await expect(
    page
      .locator('[data-calendar-date="2027-03-29"]')
      .getByRole("button", { name: title, exact: true }),
  ).toHaveCount(0);
});

test("project_task_views_and_manual_order_persist_without_resequencing_other_tasks", async ({
  page,
  request,
}) => {
  const prefix = `E2E-${crypto.randomUUID().slice(0, 8)} project views`;
  const project = await mutate(request, "project_create", {
    title: prefix,
    area: "Research",
  });
  const values: TaskDTO[] = [];
  for (const [suffix, order] of [
    ["first", 10],
    ["second", 20],
  ] as const) {
    const result = await mutate(request, "task_create", {
      title: `${prefix} ${suffix}`,
      project_id: project.entity_id,
      sort_key: order,
      start_date: "2058-04-02",
      due_date: "2058-04-05",
      estimated_minutes: 30,
    });
    values.push(await readTask(request, result.entity_id));
  }
  const outsideResult = await mutate(request, "task_create", {
    title: `${prefix} outside`,
    sort_key: 15,
  });
  const outside = await readTask(request, outsideResult.entity_id);
  const preview = await readQuery<{ preview_id: string }>(
    request,
    "task_dependency_add_preview",
    {
      task_id: values[0].task_id,
      prerequisites: [{ task_id: outside.task_id, mode: "hard" }],
      operator: "ALL",
    },
  );
  await mutate(request, "task_dependency_add_commit", {
    preview_id: preview.preview_id,
  });
  await page.goto(`/projects?project=${encodeURIComponent(project.entity_id)}`);
  await expect(page.getByRole("dialog").first()).toContainText(prefix);
  await page.getByRole("link", { name: "درخت پروژه", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "فیلتر پروژه", exact: true }),
  ).toHaveValue(project.entity_id);
  await expect(page.locator(".tree-row")).toHaveCount(2);
  await expect(page.locator(".task-title")).toHaveText(
    values.map((task) => task.title),
  );
  await expect(
    page
      .locator(".main-content .task-title")
      .filter({ hasText: outside.title }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "board", exact: true }).click();
  await expect(page.locator(".board-card")).toHaveCount(2);
  await page.getByRole("button", { name: "timeline", exact: true }).click();
  await expect(page.locator(".gantt-row")).toHaveCount(2);
  await page.getByRole("button", { name: "graph", exact: true }).click();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(page.locator(".graph-boundary")).toContainText(
    "این نما همهٔ روابط را نشان نمی‌دهد",
  );
  await page
    .getByRole("combobox", { name: "کار محوری گراف", exact: true })
    .selectOption(values[0].task_id);
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
  await expect(
    page.locator(".react-flow__node").filter({ hasText: outside.title }),
  ).toBeVisible();
  await page.getByRole("button", { name: "list", exact: true }).click();
  await page
    .getByRole("button", { name: values[0].title, exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .first()
    .getByLabel("ترتیب نمایش (عدد کمتر جلوتر)", { exact: true })
    .fill("25");
  await page
    .getByRole("button", { name: "ذخیرهٔ تغییرات", exact: true })
    .click();
  await expect
    .poll(async () => (await readTask(request, values[0].task_id)).sort_key)
    .toBe(25);
  expect((await readTask(request, values[1].task_id)).sort_key).toBe(20);
  expect((await readTask(request, outside.task_id)).sort_key).toBe(15);
  await page.goto(
    `/tasks?project_id=${encodeURIComponent(project.entity_id)}&view=list`,
  );
  await expect(page.locator(".task-title")).toHaveText([
    values[1].title,
    values[0].title,
  ]);
  const canonical = await readQuery<PageDTO<TaskDTO>>(request, "task_search", {
    project_id: project.entity_id,
    limit: 100,
  });
  expect(canonical.items.map((task) => task.task_id)).toEqual([
    values[1].task_id,
    values[0].task_id,
  ]);
});
