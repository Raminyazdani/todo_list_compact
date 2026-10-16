import { test, expect, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import type {
  MutationResult,
  PageDTO,
  TimeEntryDTO,
  TimeDraftDTO,
} from "../../shared/contracts";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
test.describe.configure({ mode: "serial" });
test.setTimeout(120000);
async function read<T>(
  request: APIRequestContext,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const response = await request.get(
    `/api/v1/query?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  const body = await response.json();
  expect(
    response.ok(),
    `${operation}: ${body.error?.code ?? response.status()}`,
  ).toBeTruthy();
  return body.data as T;
}
async function write(
  request: APIRequestContext,
  command: string,
  input: Record<string, unknown>,
  revision?: number,
) {
  const response = await request.post("/api/v1/commands", {
    headers: {
      Origin: origin,
      "Idempotency-Key": crypto.randomUUID(),
      ...(revision === undefined ? {} : { "If-Match": String(revision) }),
    },
    data: { command, input },
  });
  const body = await response.json();
  expect(
    response.ok(),
    `${command}: ${body.error?.code ?? response.status()}`,
  ).toBeTruthy();
  return body.data as MutationResult;
}

test.beforeEach(async ({ request, context }) => {
  test.skip(
    !credentialsPath,
    "Isolated synthetic staging credentials are required.",
  );
  test.skip(
    !["localhost", "127.0.0.1"].includes(new URL(origin).hostname),
    "These synthetic mutation tests run on the isolated local application only.",
  );
  const credentials = JSON.parse(await readFile(credentialsPath!, "utf8"));
  const response = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: { email: credentials.email, password: credentials.password },
  });
  expect(response.ok(), "Synthetic staging sign-in").toBeTruthy();
  const preferences = await read<{ revision: number }>(
    request,
    "preferences_get",
  );
  await write(
    request,
    "preferences_update",
    { settings: { language: "fa", theme: "dark" } },
    preferences.revision,
  );
  await context.addCookies((await request.storageState()).cookies);
});

test("native_calendar_work_tabs_keep_date_and_drafts_autosave_promote_and_undo", async ({
  page,
  request,
}) => {
  const month = "2081-02",
    description = `Synthetic draft ${crypto.randomUUID()}`;
  await page.goto("/calendar");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill(`${month}-12`);
  await page.getByRole("tab", { name: "ساعات کار", exact: true }).click();
  await expect(page.getByLabel("ماه", { exact: true })).toHaveValue(month);
  await expect(page.locator(".work-month-day")).toHaveCount(28);
  await page.getByRole("button", { name: "ردیف تازه", exact: true }).click();
  const draftPage = await expect
    .poll(
      async () =>
        (
          await read<PageDTO<TimeDraftDTO>>(request, "time_draft_list")
        ).items.find((draft) => draft.date === `${month}-12`)?.draft_id,
    )
    .not.toBeUndefined();
  void draftPage;
  const draft = (
    await read<PageDTO<TimeDraftDTO>>(request, "time_draft_list")
  ).items.find((draft) => draft.date === `${month}-12`)!;
  const row = page.locator(`[data-work-entry="${draft.draft_id}"]`),
    descriptionRow = row.locator("xpath=following-sibling::tr[1]");
  await descriptionRow
    .getByLabel("شرح فعالیت ردیف", { exact: true })
    .fill(description);
  await page
    .getByRole("heading", { name: "جدول ساعات و توضیحات", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await read<PageDTO<TimeDraftDTO>>(request, "time_draft_list")
        ).items.find((value) => value.draft_id === draft.draft_id)?.description,
    )
    .toBe(description);
  await page.reload();
  await page.getByLabel("ماه", { exact: true }).fill(month);
  await expect(
    descriptionRow.getByLabel("شرح فعالیت ردیف", { exact: true }),
  ).toHaveValue(description);
  await row.getByLabel("شروع ردیف", { exact: true }).fill("09:00");
  await row.getByLabel("پایان ردیف", { exact: true }).fill("10:00");
  await row
    .getByRole("button", { name: "تکمیل و ثبت بازه", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
            from: "2081-02-01T00:00:00Z",
            to: "2081-03-01T00:00:00Z",
          })
        ).items.find((value) => value.description === description)?.minutes,
    )
    .toBe(60);
  await expect(row).toHaveCount(0);
  await page
    .getByRole("button", { name: "بازگردانی آخرین تغییر", exact: true })
    .click();
  await expect
    .poll(async () =>
      (
        await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
          from: "2081-02-01T00:00:00Z",
          to: "2081-03-01T00:00:00Z",
        })
      ).items.some((value) => value.description === description),
    )
    .toBe(false);
});

test("horizontal_month_keyboard_moves_and_resizes_saved_actual_intervals", async ({
  page,
  request,
}) => {
  const description = `Synthetic keyboard interval ${crypto.randomUUID()}`;
  const created = await write(request, "time_entry_create", {
    employer: "Seewiesen",
    starts_at: "2082-05-12T07:00:00Z",
    ends_at: "2082-05-12T08:00:00Z",
    description,
  });
  await page.goto("/time");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByLabel("ماه", { exact: true }).fill("2082-05");
  await expect(page.locator(".work-month-day")).toHaveCount(31);
  const track = page.locator('[aria-label="ثبت زمان در 2082-05-01"]');
  await track.scrollIntoViewIfNeeded();
  const box = await track.boundingBox();
  expect(box).toBeTruthy();
  await page.mouse.move(box!.x + box!.width * (10 / 24), box!.y + 30);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * (9 / 24), box!.y + 30, {
    steps: 8,
  });
  await page.mouse.up();
  const exact = page.getByRole("dialog").last();
  await expect(exact.getByLabel("شروع", { exact: true })).toHaveValue(
    "2082-05-01T09:00",
  );
  await expect(exact.getByLabel("پایان", { exact: true })).toHaveValue(
    "2082-05-01T10:00",
  );
  await exact
    .getByRole("button", { name: "Close / بستن", exact: true })
    .click();
  const move = page
    .getByRole("button", {
      name: "جابه‌جایی Seewiesen 2082-05-12",
      exact: true,
    })
    .and(page.getByTitle(`Seewiesen · ${description}`, { exact: true }));
  await move.focus();
  await move.press("ArrowRight");
  await expect
    .poll(
      async () =>
        (
          await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
            from: "2082-05-01T00:00:00Z",
            to: "2082-06-01T00:00:00Z",
          })
        ).items.find((value) => value.entry_id === created.entity_id)
          ?.starts_at,
    )
    .toBe("2082-05-12T07:15:00.000Z");
  const end = page
    .getByRole("button", {
      name: "تغییر پایان Seewiesen 2082-05-12",
      exact: true,
    })
    .and(page.getByTitle(`Seewiesen · ${description}`, { exact: true }));
  await end.focus();
  await end.press("ArrowRight");
  await expect
    .poll(
      async () =>
        (
          await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
            from: "2082-05-01T00:00:00Z",
            to: "2082-06-01T00:00:00Z",
          })
        ).items.find((value) => value.entry_id === created.entity_id)?.minutes,
    )
    .toBe(75);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth + 1,
        ),
        `${theme}/${width} stays inside the page`,
      ).toBe(true);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(
        result.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          targets: violation.nodes.map((node) => node.target),
        })),
        `${theme}/${width} native calendar accessibility`,
      ).toEqual([]);
    }
  }
  const current = (
    await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
      from: "2082-05-01T00:00:00Z",
      to: "2082-06-01T00:00:00Z",
    })
  ).items.find((value) => value.entry_id === created.entity_id)!;
  await write(
    request,
    "time_entry_archive",
    { entry_id: current.entry_id },
    current.revision,
  );
});

test("agenda_contains_date_and_precise_deadlines_when_no_events_exist", async ({
  page,
  request,
}) => {
  const prefix = `Synthetic agenda ${crypto.randomUUID()}`;
  const date = await write(request, "task_create", {
    title: `${prefix} date`,
    due_date: "2083-06-10",
  });
  const instant = await write(request, "task_create", {
    title: `${prefix} instant`,
    due_at: "2083-06-11T09:30:00Z",
    timezone: "Europe/Berlin",
  });
  await page.goto("/calendar");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill("2083-06-01");
  await page.getByRole("button", { name: "فهرست", exact: true }).click();
  await expect(page.locator(".agenda-list")).toContainText(`${prefix} date`);
  await expect(page.locator(".agenda-list")).toContainText(`${prefix} instant`);
  await page.getByLabel("مهلت کارها", { exact: true }).uncheck();
  await expect(page.locator(".agenda-list")).not.toContainText(prefix);
  await write(
    request,
    "task_archive",
    { task_id: date.entity_id },
    date.version,
  );
  await write(
    request,
    "task_archive",
    { task_id: instant.entity_id },
    instant.version,
  );
});

test("legacy_backup_preview_preserves_wall_policy_and_incomplete_drafts", async ({
  page,
  request,
}) => {
  const sourceId = crypto.randomUUID(),
    description = `Synthetic legacy ${sourceId}`;
  const data = {
    version: 1,
    entries: [
      {
        id: sourceId,
        jobId: "jena",
        date: "2084-10-29",
        start: "01:30",
        end: "03:30",
        endNextDay: false,
        tasks: description,
      },
      {
        id: `${sourceId}-draft`,
        jobId: "seewiesen",
        date: "2084-10-29",
        start: "09:00",
        end: "",
        tasks: `${description} draft`,
      },
    ],
  };
  await page.goto("/calendar?tab=work");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByLabel("ماه", { exact: true }).fill("2084-10");
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-work-planner.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const dialog = page.getByRole("dialog").last();
  await expect(dialog).toContainText(description);
  await dialog
    .getByRole("button", { name: "تأیید صریح و واردسازی بازه‌ها", exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  const entry = (
    await read<PageDTO<TimeEntryDTO>>(request, "time_entry_list", {
      from: "2084-10-01T00:00:00Z",
      to: "2084-11-01T00:00:00Z",
    })
  ).items.find((value) => value.description === description)!;
  expect(entry.reporting_policy).toBe("legacy_wall");
  expect(entry.minutes).toBe(120);
  const draft = (
    await read<PageDTO<TimeDraftDTO>>(request, "time_draft_list")
  ).items.find((value) => value.description === `${description} draft`)!;
  expect(draft.end).toBe("");
  const downloadEvent = page.waitForEvent("download");
  await page
    .getByRole("button", {
      name: "خروجی JSON تمام تاریخچه و پیش‌نویس‌ها",
      exact: true,
    })
    .click();
  const download = await downloadEvent,
    exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  const exportedDraft = exported.drafts.find(
    (value: { draft_id: string }) => value.draft_id === draft.draft_id,
  );
  expect(exportedDraft).toMatchObject({
    description: `${description} draft`,
    end: "",
  });
  expect(Object.keys(exportedDraft).sort()).toEqual(
    [
      "date",
      "description",
      "draft_id",
      "employer",
      "end",
      "end_next_day",
      "legacy_metadata",
      "start",
      "timezone",
    ].sort(),
  );
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-own-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(exported)),
  });
  await expect(dialog).toContainText("0 بازهٔ تازه");
  await dialog
    .getByRole("button", { name: "لغو واردسازی", exact: true })
    .click();
  await write(
    request,
    "time_entry_archive",
    { entry_id: entry.entry_id },
    entry.revision,
  );
  await write(
    request,
    "time_draft_archive",
    { draft_id: draft.draft_id },
    draft.revision,
  );
});

test("calendar_reads_every_page_and_upcoming_range_advances_after_focus", async ({
  page,
}) => {
  const upcoming: string[] = [],
    pages: string[] = [];
  await page.clock.install({ time: new Date("2090-01-02T10:00:00Z") });
  await page.route("**/api/v1/query*", async (route) => {
    const url = new URL(route.request().url()),
      posted =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
    const operation = posted?.operation ?? url.searchParams.get("operation");
    if (operation !== "calendar_events_query") return route.continue();
    const input =
      posted?.input ?? JSON.parse(url.searchParams.get("input") ?? "{}");
    if (input.limit === 5) {
      upcoming.push(input.from);
      return route.fulfill({
        json: { data: { items: [], total: 0, next_cursor: null } },
      });
    }
    pages.push(input.cursor ?? "first");
    const indices =
      input.cursor === "second"
        ? [200]
        : Array.from({ length: 200 }, (_, index) => index);
    const items = indices.map((index) => ({
      event_id: `synthetic-page-${index}`,
      title: `Synthetic paged occurrence ${index}`,
      starts_at: `2090-01-15T10:00:00Z`,
      ends_at: `2090-01-15T11:00:00Z`,
      timezone: "Europe/Berlin",
      all_day: false,
      provider: "ical",
      category: undefined,
      task_id: null,
      notes: "Synthetic",
      recurrence_rule: null,
      revision: 1,
    }));
    return route.fulfill({
      json: {
        data: {
          items,
          total: 201,
          next_cursor: input.cursor === "second" ? null : "second",
        },
      },
    });
  });
  await page.goto("/calendar");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByRole("button", { name: "فهرست", exact: true }).click();
  await expect(page.locator(".agenda-row")).toHaveCount(201);
  expect(pages).toContain("second");
  await expect.poll(() => upcoming.length).toBeGreaterThan(0);
  const before = upcoming.at(-1)!;
  await page.clock.setSystemTime(new Date("2090-01-03T10:00:00Z"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect.poll(() => upcoming.at(-1)).not.toBe(before);
  expect(upcoming.at(-1)).toContain("2090-01-03");
});

test("large_backup_refreshes_later_batch_preview_and_retries_uncertain_ACK_with_same_intent", async ({
  page,
}) => {
  const previews = new Map<
      string,
      { generation: number; entries: unknown[] }
    >(),
    commitKeys: string[] = [],
    committed = new Set<string>();
  let generation = 0,
    previewCounter = 0,
    lostAcknowledgement = false;
  await page.route("**/api/v1/query*", async (route) => {
    const url = new URL(route.request().url()),
      posted =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null;
    if (
      (posted?.operation ?? url.searchParams.get("operation")) !==
      "time_entry_import_preview"
    )
      return route.continue();
    const input =
      posted?.input ?? JSON.parse(url.searchParams.get("input") ?? "{}");
    const id = `synthetic-batch-preview-${++previewCounter}`;
    previews.set(id, { generation, entries: input.data.entries });
    return route.fulfill({
      json: {
        data: {
          preview_id: id,
          command: "time_entry_import_commit",
          input: {},
          expires_at: "2099-01-01T00:00:00Z",
          revisions: {},
          affected_task_ids: [],
          warnings: [],
          changes: {
            timezone: "Europe/Berlin",
            counts: {
              provided: input.data.entries.length,
              new: input.data.entries.length,
              skipped: 0,
            },
            entries_to_create: input.data.entries,
            drafts_to_create: [],
            minutes_to_create: input.data.entries.length,
          },
        },
      },
    });
  });
  await page.route("**/api/v1/commands", async (route) => {
    const body = route.request().postDataJSON();
    if (body.command !== "time_entry_import_commit") return route.continue();
    const id = body.input.preview_id,
      key = route.request().headers()["idempotency-key"],
      preview = previews.get(id)!;
    commitKeys.push(key);
    if (!committed.has(key) && preview.generation !== generation)
      return route.fulfill({
        status: 409,
        json: {
          error: {
            code: "REVISION_CONFLICT",
            message: "Synthetic ledger changed after preview",
          },
        },
      });
    if (!committed.has(key)) {
      committed.add(key);
      generation++;
    }
    if (generation === 2 && !lostAcknowledgement) {
      lostAcknowledgement = true;
      return route.abort("connectionreset");
    }
    return route.fulfill({
      json: {
        data: {
          operation_id: id,
          audit_event_id: `audit-${id}`,
          entity_id: id,
          version: 1,
          affected_task_ids: [],
          readiness_changes: [],
          changed_fields: [],
          data: {},
        },
      },
    });
  });
  const data = {
    format: "ramin-life-os-time/1",
    timezone: "Europe/Berlin",
    entries: Array.from({ length: 70 }, (_, index) => ({
      entry_id: `synthetic-large-${index}`,
      employer: "Jena",
      starts_at: "2085-01-01T09:00:00Z",
      ends_at: "2085-01-01T09:01:00Z",
      description: "س".repeat(10000),
      task_id: null,
      reporting_policy: "elapsed",
      reported_minutes: null,
      legacy_metadata: { synthetic: "س".repeat(10000) },
    })),
  };
  await page.goto("/calendar?tab=work");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-large-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data)),
  });
  const dialog = page.getByRole("dialog").last(),
    confirm = dialog.getByRole("button", {
      name: "تأیید صریح و واردسازی بازه‌ها",
      exact: true,
    });
  await expect(confirm).toBeVisible();
  expect(previewCounter).toBe(2);
  await confirm.click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: "دستهٔ" }),
  ).toContainText("تأیید نشد");
  expect(previewCounter).toBe(3);
  expect(generation).toBe(2);
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  expect(generation).toBe(2);
  expect(commitKeys).toHaveLength(3);
  expect(commitKeys[1]).toBe(commitKeys[2]);
  expect(previewCounter).toBe(3);
});

test("Google_change_confirmation_shows_fresh_remote_before_and_personal_proposal_after", async ({
  page,
}) => {
  const source = {
    source_id: "synthetic-google-source",
    calendar_id: "synthetic-google-source",
    provider: "google_calendar",
    title: "Synthetic owned calendar",
    timezone: "Europe/Berlin",
    writable: true,
    enabled: true,
    primary: true,
    revision: 1,
    status: "connected",
    last_success_at: "2086-05-15T08:00:00Z",
    last_error: null,
    coverage: { complete: true },
  };
  const event = {
    event_id: "synthetic-event",
    external_id: "synthetic-remote-id",
    source_id: source.source_id,
    source_title: source.title,
    title: "Stale cached title",
    starts_at: "2086-05-15T10:00:00Z",
    ends_at: "2086-05-15T11:00:00Z",
    timezone: "Europe/Berlin",
    all_day: false,
    provider: "google_calendar",
    can_edit: true,
    etag: "stale-etag",
    task_id: null,
    notes: "Stale cached notes",
    recurrence_rule: null,
    revision: 1,
  };
  await page.route("**/api/v1/query*", async (route) => {
    const url = new URL(route.request().url()),
      posted =
        route.request().method() === "POST"
          ? route.request().postDataJSON()
          : null,
      operation = posted?.operation ?? url.searchParams.get("operation"),
      input =
        posted?.input ?? JSON.parse(url.searchParams.get("input") ?? "{}");
    let data: unknown;
    if (operation === "calendar_sync_status")
      data = { items: [source], complete: true, status: "idle" };
    else if (operation === "calendar_list")
      data = { items: [source], total: 1, next_cursor: null };
    else if (operation === "calendar_events_query")
      data = {
        items: input.limit === 5 ? [] : [event],
        total: input.limit === 5 ? 0 : 1,
        next_cursor: null,
      };
    else if (operation === "calendar_event_change_preview")
      data = {
        preview_id: "synthetic-fresh-preview",
        command: "calendar_event_change_commit",
        input,
        revisions: {},
        expires_at: "2099-01-01T00:00:00Z",
        affected_task_ids: [],
        warnings: [],
        changes: {
          action: "update",
          recurrence_scope: "instance",
          payload: input.payload,
          original: {
            title: "Remote title changed before preview",
            starts_at: "2086-05-15T11:00:00Z",
            ends_at: "2086-05-15T12:00:00Z",
            timezone: "Europe/Berlin",
            notes: "Remote notes changed before preview",
            etag: "fresh-etag",
          },
        },
      };
    else return route.continue();
    return route.fulfill({ json: { data } });
  });
  await page.goto("/calendar");
  await expect(page.locator(".save-status")).toContainText("متصل به سرور", {
    timeout: 30000,
  });
  await page.getByLabel("تاریخ تقویم", { exact: true }).fill("2086-05-15");
  await page.getByRole("button", { name: "فهرست", exact: true }).click();
  await page
    .locator(".agenda-row")
    .filter({ hasText: "Stale cached title" })
    .click();
  const editor = page.getByRole("dialog").last();
  await editor
    .getByLabel("یادداشت", { exact: true })
    .fill("Personal proposed notes");
  await editor
    .getByRole("button", { name: "پیش‌نمایش تغییر Google", exact: true })
    .click();
  const confirmation = page.getByRole("dialog").last();
  await expect(confirmation).toContainText(
    "Remote title changed before preview",
  );
  await expect(confirmation).toContainText(
    "Remote notes changed before preview",
  );
  await expect(confirmation).toContainText("Stale cached title");
  await expect(confirmation).toContainText("Personal proposed notes");
  await expect(confirmation).toContainText("2086-05-15T11:00:00Z");
  await expect(confirmation).toContainText("2086-05-15T10:00:00Z");
});
