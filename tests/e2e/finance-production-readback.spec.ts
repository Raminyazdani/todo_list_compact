import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { boundedSignIn } from "../../scripts/ops/bounded-signin.mjs";
import { withPrivateFile } from "../../scripts/ops/private-paths.mjs";
import { financeToday } from "../../features/finance-model";
import type {
  FinancePlanDTO,
  FinanceSummaryDTO,
  PageDTO,
} from "../../shared/contracts";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const canonical = "https://ramin-life-os.vercel.app";
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("production finance rendered values match authenticated REST without financial mutations", async ({
  page,
  context,
}, testInfo) => {
  test.skip(
    process.env.RUN_FINANCE_PRODUCTION_READBACK !== "1",
    "Explicit production finance readback is required.",
  );
  test.setTimeout(120_000);
  const target = new URL(origin);
  if (
    target.origin !== canonical ||
    target.pathname !== "/" ||
    target.search ||
    target.hash
  )
    throw new Error("CANONICAL_FINANCE_PRODUCTION_ORIGIN_REQUIRED");
  if (!process.env.E2E_CREDENTIALS_PATH)
    throw new Error("PRIVATE_OWNER_CREDENTIALS_REQUIRED");
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
  const login = await boundedSignIn(canonical, credentials);
  if (!login.ok) throw new Error("FINANCE_OWNER_LOGIN_FAILED");
  const cookies = login.headers.getSetCookie().map((line) => {
    const pair = line.split(";")[0],
      split = pair.indexOf("=");
    if (split <= 0) throw new Error("OWNER_COOKIE_INVALID");
    return {
      name: pair.slice(0, split),
      value: pair.slice(split + 1),
      domain: target.hostname,
      path: "/",
      httpOnly: /;\s*HttpOnly/i.test(line),
      secure: true,
      sameSite: "Lax" as const,
    };
  });
  if (!cookies.length) throw new Error("OWNER_COOKIE_REQUIRED");
  await context.addCookies(cookies);
  page.setDefaultTimeout(30_000);
  let blockedWrites = 0;
  await page.route("**/api/v1/commands", async (route) => {
    blockedWrites++;
    await route.abort();
  });
  const month = process.env.E2E_FINANCE_MONTH ?? financeToday().slice(0, 7);
  async function read<T>(operation: string, input: Record<string, unknown>) {
    const response = await page.request.get(
      `${canonical}/api/v1/query?${new URLSearchParams({ operation, input: JSON.stringify(input) })}`,
    );
    if (!response.ok())
      throw new Error(`FINANCE_READ_FAILED_${response.status()}`);
    return (await response.json()).data as T;
  }
  const summary = await read<FinanceSummaryDTO>("finance_summary", {
    month,
    horizon_months: 3,
  });
  const plansById = new Map<string, FinancePlanDTO>();
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const data: PageDTO<FinancePlanDTO> = await read("finance_plan_list", {
        month,
        archived,
        limit: 200,
        cursor,
      });
      for (const item of data.items) {
        const previous = plansById.get(item.plan_id);
        if (!previous || item.revision >= previous.revision)
          plansById.set(item.plan_id, item);
      }
      cursor = data.next_cursor;
      if (cursor && seen.has(cursor))
        throw new Error("FINANCE_REPEATED_CURSOR");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  const plans = [...plansById.values()];
  await page.goto(`${canonical}/finances`);
  await page.getByLabel(/ماه گزارش|Report month/).fill(month);
  await expect(page.locator(".finance-metrics .metric-card")).toHaveCount(4);
  const language = await page.locator("html").getAttribute("lang");
  async function displayedMoney(cents: number) {
    return page.evaluate(
      ({ value, locale }) =>
        new Intl.NumberFormat(locale === "fa" ? "fa-IR" : "en-IE", {
          style: "currency",
          currency: "EUR",
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }).format(value / 100),
      { value: cents, locale: language },
    );
  }
  const values = [
    summary.recurring_monthly_cents,
    summary.budget_monthly_cents,
    summary.reserve_monthly_cents,
    summary.monthly_allocation_cents,
  ];
  for (let index = 0; index < values.length; index++)
    await expect(
      page
        .locator(".finance-metrics .metric-card")
        .nth(index)
        .locator("strong .finance-money"),
    ).toHaveText(await displayedMoney(values[index]));
  const itemized = page.locator(".finance-itemized");
  const itemizedHeading = itemized.getByRole("heading", {
    name: /ریز هزینه‌های این ماه|Itemized costs this month/,
  });
  await expect(itemizedHeading).toBeVisible();
  const applicablePlans = plans.filter(
    (plan) => plan.applicable && (!plan.archived_at || plan.state === "active"),
  );
  await expect(itemized.locator(".finance-itemized-row")).toHaveCount(
    applicablePlans.length,
  );
  let itemizedNotesChecked = 0;
  for (const plan of applicablePlans) {
    const row = itemized.locator(
      `.finance-itemized-row[data-plan-id="${plan.plan_id}"]`,
    );
    await expect(
      row.getByRole("heading", { name: plan.title, exact: true }),
    ).toBeVisible();
    const amount = row.locator(".finance-itemized-amount .finance-money");
    if (plan.amount_cents === null)
      await expect(amount).toHaveText(/نامشخص|Unknown/);
    else
      await expect(amount).toHaveText(await displayedMoney(plan.amount_cents));
    const monthly = row.locator(".finance-itemized-monthly");
    if (plan.monthly_equivalent_cents !== null)
      await expect(monthly.locator(".finance-money")).toHaveText(
        await displayedMoney(plan.monthly_equivalent_cents),
      );
    else if (["recurring", "budget", "reserve"].includes(plan.kind))
      await expect(monthly).toContainText(/نامشخص|Unknown/);
    else await expect(monthly.locator(".finance-money")).toHaveCount(0);
    const counting = row.locator(".finance-itemized-counting");
    if (plan.archived_at) {
      await expect(row.locator(".finance-itemized-archived")).toHaveText(
        /بایگانی‌شده؛ نسخهٔ این ماه|Archived; this month's version/,
      );
      await expect(
        row.getByRole("button", { name: /^(ویرایش|Edit) / }),
      ).toHaveCount(0);
    }
    if (plan.state !== "active" || !plan.included)
      await expect(counting).toHaveText(
        /خارج از جمع ماهانه|Excluded from monthly totals/,
      );
    else if (["recurring", "budget", "reserve"].includes(plan.kind)) {
      if (plan.monthly_equivalent_cents === null)
        await expect(counting).toHaveText(
          /معادل ماهانه نامشخص؛ در جمع عددی نیامده|Monthly equivalent unknown; not included in numeric totals/,
        );
      else if (plan.kind === "reserve")
        await expect(counting).toHaveText(
          /کنارگذاری؛ جدا از جمع هزینه‌ها|Reserve; separate from cost totals/,
        );
      else
        await expect(counting).toHaveText(
          /در جمع هزینه‌های ماه|Included in monthly costs/,
        );
    }
    if (plan.notes) {
      await row.locator("details > summary").click();
      await expect(row.locator(".finance-notes")).toHaveText(plan.notes);
      if (plan.notes.includes("\n"))
        expect(await row.locator(".finance-notes").innerText()).toContain("\n");
      itemizedNotesChecked++;
    }
  }
  const selected = applicablePlans.filter(
    (plan) =>
      plan.state === "active" &&
      plan.included &&
      plan.monthly_equivalent_cents !== null,
  );
  const displayedCostCents = selected
    .filter((plan) => plan.kind === "recurring" || plan.kind === "budget")
    .reduce((total, plan) => total + plan.monthly_equivalent_cents!, 0);
  const displayedReserveCents = selected
    .filter((plan) => plan.kind === "reserve")
    .reduce((total, plan) => total + plan.monthly_equivalent_cents!, 0);
  expect(displayedCostCents).toBe(summary.monthly_cost_cents);
  expect(displayedReserveCents).toBe(summary.reserve_monthly_cents);
  expect(displayedCostCents + displayedReserveCents).toBe(
    summary.monthly_allocation_cents,
  );
  const categoryPanel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: /هزینه‌ها بر اساس دسته|Costs by category/,
    }),
  });
  expect(
    await categoryPanel.evaluate((element) => {
      const details = document.querySelector(".finance-itemized");
      return (
        !!details &&
        !!(
          details.compareDocumentPosition(element) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      );
    }),
  ).toBeTruthy();
  const accountPanel = page.locator("section.panel").filter({
    has: page.getByRole("heading", {
      name: /حساب‌ها و ثبت‌های آن‌ها|Accounts and recorded activity/,
    }),
  });
  for (const account of summary.by_account.filter(
    (item) => item.balance_cents === null,
  ))
    await expect(
      accountPanel
        .locator("tbody tr")
        .filter({ hasText: account.title })
        .last()
        .locator("td")
        .last(),
    ).toHaveText(/نامشخص|Unknown/);
  await itemizedHeading.scrollIntoViewIfNeeded();
  if (process.env.FINANCE_READBACK_SCREENSHOTS === "1")
    await page.screenshot({ path: testInfo.outputPath("finance-desktop.png") });
  await page
    .getByRole("tab", { name: /هزینه‌ها و بودجه‌ها|Costs & budgets/ })
    .click();
  const unknown = plans.find(
    (item) =>
      !item.archived_at &&
      (item.amount_cents === null ||
        (item.kind === "recurring" && item.interval_months === null)),
  );
  if (unknown) {
    await page
      .getByLabel(/جست‌وجوی برنامه‌ها|Search plans/)
      .fill(unknown.title);
    const row = page
      .locator(".finance-record")
      .filter({
        has: page.getByRole("heading", { name: unknown.title, exact: true }),
      })
      .first();
    await expect(row).toBeVisible();
    await expect(row.locator(".finance-record-amount")).toContainText(
      /نامشخص|Unknown|unknown/,
    );
    await page.getByLabel(/جست‌وجوی برنامه‌ها|Search plans/).fill("");
  }
  await page
    .getByRole("tab", { name: /پرداخت‌های ثبت‌شده|Registered payments/ })
    .click();
  if (summary.actual.transaction_count === 0)
    await expect(
      page.getByRole("heading", {
        name: /پرداختی در این نما ثبت نشده است|No payments recorded in this view/,
      }),
    ).toBeVisible();
  else await expect(page.locator(".finance-record").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  if (language === "fa")
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.getByRole("tab", { name: /نمای ماه|Month overview/ }).click();
  await expect(page.locator(".finance-metrics .metric-card")).toHaveCount(4);
  await expect(itemized.locator(".finance-itemized-row")).toHaveCount(
    applicablePlans.length,
  );
  await itemizedHeading.scrollIntoViewIfNeeded();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  if (process.env.FINANCE_READBACK_SCREENSHOTS === "1")
    await page.screenshot({ path: testInfo.outputPath("finance-mobile.png") });
  expect(blockedWrites).toBe(0);
  await writeFile(
    testInfo.outputPath("finance-readback.json"),
    JSON.stringify(
      {
        status: "passed",
        origin: canonical,
        month,
        summary,
        plan_count: plans.length,
        itemized_plan_count: applicablePlans.length,
        itemized_notes_checked: itemizedNotesChecked,
        unknown_plan_count: applicablePlans.filter(
          (item) =>
            item.amount_cents === null ||
            (item.kind === "recurring" && item.interval_months === null),
        ).length,
        blocked_writes: blockedWrites,
        checked_at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
});
