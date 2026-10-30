import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { PageDTO, RoutineDTO } from "../../shared/contracts";
import { instantToLocalDate } from "../../shared/datetime";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
let credentials: { email: string; password: string };

async function listRoutines(request: APIRequestContext) {
  const response = await request.get(
    `/api/v1/query?operation=routine_list&input=${encodeURIComponent(JSON.stringify({ include_archived: true, limit: 200 }))}`,
  );
  expect(response.ok()).toBeTruthy();
  return ((await response.json()).data as PageDTO<RoutineDTO>).items;
}

async function changeRoutine(
  request: APIRequestContext,
  command: string,
  routineId: string,
  revision: number,
  fields: Record<string, unknown> = {},
) {
  return request.post("/api/v1/commands", {
    headers: {
      Origin: origin,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": String(revision),
    },
    data: { command, input: { routine_id: routineId, ...fields } },
  });
}

test.beforeAll(async () => {
  test.skip(!credentialsPath, "Isolated staging credentials are required.");
  credentials = JSON.parse(await readFile(credentialsPath!, "utf8"));
});

test("routine UI keeps Today, keyboard check-in, state changes and conflict visible", async ({
  page,
  request,
  context,
}) => {
  const login = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: credentials,
  });
  expect(login.ok()).toBeTruthy();
  await context.addCookies((await request.storageState()).cookies);
  const title = `E2E routine ${crypto.randomUUID().slice(0, 8)}`;
  let routineId: string | null = null;
  try {
    const emptyDay = async (route: import("@playwright/test").Route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          data: {
            date: instantToLocalDate(new Date().toISOString(), "Europe/Berlin"),
            items: [],
            total: 0,
            completed: 0,
          },
        }),
      });
    };
    await page.route("**/api/v1/query?operation=routine_day*", emptyDay);
    await page.goto("/");
    await expect(
      page.getByRole("link", { name: /مدیریت روتین‌ها|Manage routines/ }),
    ).toBeVisible();
    await expect(
      page.getByText(/برای امروز روتین فعالی|No active routine is scheduled/),
    ).toBeVisible();
    await page.unroute("**/api/v1/query?operation=routine_day*", emptyDay);

    await page.goto("/routines");
    await expect(
      page.getByRole("heading", { name: /روتین‌ها|Routines/ }).first(),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /روتین تازه|New routine/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/نام روتین|Routine name/).fill(title);
    await dialog.getByLabel(/توضیح|Notes/).fill("Synthetic daily practice");
    await dialog
      .getByRole("button", { name: /ذخیرهٔ روتین|Save routine/ })
      .click();
    await expect(dialog).toBeHidden();

    const created = (await listRoutines(request)).find(
      (routine) => routine.title === title,
    );
    expect(created).toBeTruthy();
    routineId = created!.routine_id;
    const dayItem = page
      .locator(".routine-day-list li")
      .filter({ hasText: title });
    await expect(dayItem).toBeVisible();
    const check = dayItem.locator(".routine-check");
    await check.focus();
    await expect(check).toBeFocused();
    await page.keyboard.press("Space");
    await expect(check).toHaveAttribute("aria-pressed", "true");
    await expect(check).toBeFocused();
    await page.keyboard.press("Space");
    await expect(check).toHaveAttribute("aria-pressed", "false");

    const card = page.locator(".routine-card").filter({ hasText: title });
    await card.getByRole("button", { name: /توقف|Pause/ }).click();
    await expect(dayItem).toHaveCount(0);
    await card.getByRole("button", { name: /ادامه|Resume/ }).click();
    await expect(dayItem).toBeVisible();
    await card.getByRole("button", { name: /بایگانی|Archive/ }).click();
    await expect(dayItem).toHaveCount(0);
    await page.locator(".routine-archived summary").click();
    await card.getByRole("button", { name: /بازگردانی|Restore/ }).click();
    await expect(dayItem).toBeVisible();
    await card.getByRole("button", { name: /تاریخچه|History/ }).click();
    await expect(card.locator(".routine-history")).toBeVisible();

    await card.getByRole("button", { name: /ویرایش|Edit/ }).click();
    const current = (await listRoutines(request)).find(
      (routine) => routine.routine_id === routineId,
    )!;
    const external = await changeRoutine(
      request,
      "routine_update",
      routineId,
      current.revision,
      { title: `${title} external` },
    );
    expect(external.ok()).toBeTruthy();
    await dialog.getByLabel(/نام روتین|Routine name/).fill(`${title} local`);
    await dialog
      .getByRole("button", { name: /ذخیرهٔ روتین|Save routine/ })
      .click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.locator(".routine-form .error[role='alert']"),
    ).toContainText(/ذخیره تأیید نشد|Save was not confirmed/);

    await dialog
      .getByRole("button", { name: "Close / بستن", exact: true })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("heading", { name: /روتین‌ها|Routines/ }).first(),
    ).toBeVisible();
    await expect(
      page.locator(".routine-card").filter({ hasText: `${title} external` }),
    ).toBeVisible();
  } finally {
    if (routineId) {
      const current = (await listRoutines(request)).find(
        (routine) => routine.routine_id === routineId,
      );
      if (current && !current.archived_at) {
        const cleanup = await changeRoutine(
          request,
          "routine_archive",
          routineId,
          current.revision,
        );
        expect(cleanup.ok()).toBeTruthy();
      }
    }
  }
});
