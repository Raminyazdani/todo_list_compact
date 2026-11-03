import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import type {
  FinanceAccountDTO,
  FinanceCategoryDTO,
  FinanceImportDTO,
  FinancePlanDTO,
  FinanceSummaryDTO,
  FinanceTransactionDTO,
  PageDTO,
} from "../../shared/contracts";
import { financeToday } from "../../features/finance-model";

const origin = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const credentialsPath = process.env.E2E_CREDENTIALS_PATH;
const local = ["localhost", "127.0.0.1", "[::1]"].includes(
  new URL(origin).hostname,
);
let credentials: { email: string; password: string };
const month = "2032-02";
test.setTimeout(180_000);

test.beforeAll(async () => {
  test.skip(
    !local,
    "Finance mutation scenarios require isolated local staging.",
  );
  test.skip(!credentialsPath, "Isolated staging credentials are required.");
  credentials = JSON.parse(await readFile(credentialsPath!, "utf8"));
});

async function read<T>(
  request: APIRequestContext,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const response = await request.get(
    `/api/v1/query?operation=${operation}&input=${encodeURIComponent(JSON.stringify(input))}`,
  );
  expect(response.ok(), `${operation}: ${response.status()}`).toBeTruthy();
  return (await response.json()).data as T;
}

async function all<T>(
  request: APIRequestContext,
  operation: string,
  input: Record<string, unknown> = {},
) {
  const rows: T[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: PageDTO<T> = await read(request, operation, {
      ...input,
      limit: 200,
      cursor,
    });
    rows.push(...page.items);
    cursor = page.next_cursor;
    if (cursor && seen.has(cursor))
      throw new Error("Repeated test pagination cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return rows;
}

async function mutate(
  request: APIRequestContext,
  command: string,
  input: Record<string, unknown>,
  revision = 0,
) {
  const response = await request.post("/api/v1/commands", {
    headers: {
      Origin: origin,
      "Idempotency-Key": crypto.randomUUID(),
      "If-Match": String(revision),
    },
    data: { command, input },
  });
  expect(response.ok(), `${command}: ${response.status()}`).toBeTruthy();
  return (await response.json()).data;
}

async function login(request: APIRequestContext, page: Page) {
  const response = await request.post("/api/auth/sign-in/email", {
    headers: { Origin: origin },
    data: credentials,
  });
  expect(response.ok()).toBeTruthy();
  await page.context().addCookies((await request.storageState()).cookies);
}

async function cleanup(request: APIRequestContext, prefix: string) {
  for (const kind of ["transaction", "plan", "account", "category"] as const) {
    const rows = await all<
      { title: string; revision: number; archived_at: string | null } & Record<
        string,
        unknown
      >
    >(request, `finance_${kind}_list`, {
      ...(kind === "plan" ? { month } : {}),
    });
    for (const row of rows.filter(
      (item) => item.title.startsWith(prefix) && !item.archived_at,
    )) {
      await mutate(
        request,
        `finance_${kind}_archive`,
        {
          [`${kind}_id`]: row[`${kind}_id`],
          ...(kind === "plan" ? { effective_month: month } : {}),
        },
        row.revision,
      );
    }
  }
}

async function saveDialog(page: Page) {
  const dialog = page.getByRole("dialog");
  const acknowledgement = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/v1/commands",
    { timeout: 30_000 },
  );
  await dialog.getByRole("button", { name: /^ذخیره$|^Save$/ }).click();
  const response = await acknowledgement;
  expect(
    response.ok(),
    `Finance save acknowledgement: ${response.status()}`,
  ).toBeTruthy();
  const receipt = (await response.json()).data;
  expect(receipt.audit_event_id).toEqual(expect.any(String));
  await expect(dialog).toBeHidden();
}

async function createAccount(page: Page, title: string, opening: string) {
  await page.getByRole("button", { name: /^حساب‌ها$|^Accounts$/ }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /حساب تازه|New account/ })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^عنوان$|^Title$/).fill(title);
  await dialog
    .getByLabel(/ماندهٔ آغازین.*خالی|Opening balance.*blank/)
    .fill(opening);
  await dialog
    .getByLabel(/تاریخ ماندهٔ آغازین|Opening balance date/)
    .fill(`${month}-01`);
  await saveDialog(page);
}

async function createPayment(
  page: Page,
  input: {
    title: string;
    kind: string;
    amount: string;
    date: string;
    accountId?: string;
    destinationId?: string;
    categoryId?: string;
  },
) {
  await page
    .getByRole("button", {
      name: /ثبت پرداخت یا دریافت|Record payment or income/,
    })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel(/^عنوان$|^Title$/).fill(input.title);
  await dialog.getByLabel(/نوع ثبت|Record kind/).selectOption(input.kind);
  await dialog.getByLabel(/مبلغ واقعی|Actual amount/).fill(input.amount);
  await dialog.getByLabel(/تاریخ واقعی پرداخت|Actual payment/).fill(input.date);
  if (input.accountId)
    await dialog
      .getByLabel(
        input.kind === "transfer"
          ? /حساب مبدأ|Source account/
          : /حساب پرداخت|Payment account/,
      )
      .selectOption(input.accountId);
  if (input.destinationId)
    await dialog
      .getByLabel(/حساب مقصد|Destination account/)
      .selectOption(input.destinationId);
  if (input.categoryId)
    await dialog
      .getByLabel(/^دسته‌بندی$|^Category$/)
      .selectOption(input.categoryId);
  await saveDialog(page);
}

test("finance workspace separates plans from registered payments and preserves history and conflicting drafts", async ({
  page,
  request,
}) => {
  await login(request, page);
  const prefix = `E2E finance ${crypto.randomUUID().slice(0, 8)}`;
  const breakdownNotes =
    "بخش آزمایشی اول: ۲۰۰ یورو\nبخش آزمایشی دوم: ۱۰۰ یورو\nاین دو جزء داخل همان قبض سه‌ماهه‌اند.";
  const base = await read<FinanceSummaryDTO>(request, "finance_summary", {
    month,
  });
  try {
    await page.goto("/finances");
    await expect(
      page.getByRole("heading", { name: /مدیریت مالی|Finances/ }).first(),
    ).toBeVisible();
    await page.getByLabel(/ماه گزارش|Report month/).fill(month);
    await createAccount(page, `${prefix} Source`, "1000.00");
    await createAccount(page, `${prefix} Destination`, "0.00");
    const accounts = await all<FinanceAccountDTO>(
      request,
      "finance_account_list",
    );
    const source = accounts.find((item) => item.title === `${prefix} Source`)!;
    const destination = accounts.find(
      (item) => item.title === `${prefix} Destination`,
    )!;
    expect(source).toBeTruthy();
    expect(destination).toBeTruthy();
    await page.getByRole("button", { name: /دسته‌بندی‌ها|Categories/ }).click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /دستهٔ تازه|New category/ })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel(/^عنوان$|^Title$/)
      .fill(`${prefix} Category`);
    await saveDialog(page);
    const category = (
      await all<FinanceCategoryDTO>(request, "finance_category_list")
    ).find((item) => item.title === `${prefix} Category`)!;
    await page
      .getByRole("tab", { name: /هزینه‌ها و بودجه‌ها|Costs & budgets/ })
      .click();
    await page.getByRole("button", { name: /برنامهٔ تازه|New plan/ }).click();
    let dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^عنوان$|^Title$/).fill(`${prefix} Quarterly`);
    await dialog.getByLabel(/مبلغ کامل هر دوره|Full bill/).fill("۳۰۰٫۰۰");
    await dialog
      .getByLabel(/^دورهٔ پرداخت$|^Payment interval$/)
      .selectOption("3");
    await dialog
      .getByLabel(/^حساب پرداخت$|^Payment account$/)
      .selectOption(source.account_id);
    await dialog
      .getByLabel(/^دسته‌بندی$|^Category$/)
      .selectOption(category.category_id);
    await dialog
      .getByLabel(/دقت زمان پرداخت|Payment timing precision/)
      .selectOption("approximate");
    await dialog.getByLabel(/روز معمول ماه|Usual day of month/).fill("15");
    await dialog.getByLabel(/^توضیحات$|^Notes$/).fill(breakdownNotes);
    await saveDialog(page);
    let plans = await all<FinancePlanDTO>(request, "finance_plan_list", {
      month,
    });
    const planId = plans.find(
      (item) => item.title === `${prefix} Quarterly`,
    )!.plan_id;
    expect(
      plans.find((item) => item.plan_id === planId)?.monthly_equivalent_cents,
    ).toBe(10000);
    await page.getByRole("button", { name: /برنامهٔ تازه|New plan/ }).click();
    dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^عنوان$|^Title$/).fill(`${prefix} Unknown`);
    await dialog.getByLabel(/مبنای مبلغ|Amount basis/).selectOption("unknown");
    await dialog
      .getByLabel(/^دورهٔ پرداخت$|^Payment interval$/)
      .selectOption("");
    await saveDialog(page);
    const beforePayment = await read<FinanceSummaryDTO>(
      request,
      "finance_summary",
      { month },
    );
    expect(
      beforePayment.recurring_monthly_cents - base.recurring_monthly_cents,
    ).toBe(10000);
    expect(
      beforePayment.included_unknown_amount_count -
        base.included_unknown_amount_count,
    ).toBe(1);
    expect(beforePayment.actual.expense_cents).toBe(base.actual.expense_cents);
    // The default view must expose individual costs, not just category sums.
    await page.getByRole("tab", { name: /نمای ماه|Month overview/ }).click();
    const itemized = page.locator(".finance-itemized");
    await expect(
      itemized.getByRole("heading", {
        name: /ریز هزینه‌های این ماه|Itemized costs this month/,
      }),
    ).toBeVisible();
    const quarterlyRow = itemized.locator(
      `.finance-itemized-row[data-plan-id="${planId}"]`,
    );
    const unknownRow = itemized.locator(".finance-itemized-row").filter({
      has: page.getByRole("heading", {
        name: `${prefix} Unknown`,
        exact: true,
      }),
    });
    await expect(quarterlyRow).toBeVisible();
    await expect(unknownRow).toBeVisible();
    const language = await page.locator("html").getAttribute("lang");
    const money = (cents: number) =>
      new Intl.NumberFormat(language === "fa" ? "fa-IR" : "en-IE", {
        style: "currency",
        currency: "EUR",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(cents / 100);
    await expect(
      quarterlyRow.locator(".finance-itemized-amount .finance-money"),
    ).toHaveText(money(30000));
    await expect(
      quarterlyRow.locator(".finance-itemized-monthly .finance-money"),
    ).toHaveText(money(10000));
    await expect(quarterlyRow.locator(".finance-itemized-counting")).toHaveText(
      /در جمع هزینه‌های ماه|Included in monthly costs/,
    );
    await expect(quarterlyRow.locator(".finance-itemized-due")).toContainText(
      /تقریبی|Approximate/,
    );
    await expect(unknownRow.locator(".finance-itemized-amount")).toContainText(
      /نامشخص|Unknown/,
    );
    await expect(unknownRow.locator(".finance-itemized-monthly")).toContainText(
      /نامشخص|Unknown/,
    );
    await expect(unknownRow.locator(".finance-itemized-counting")).toHaveText(
      /معادل ماهانه نامشخص؛ در جمع عددی نیامده|Monthly equivalent unknown; not included in numeric totals/,
    );
    await quarterlyRow.locator("details > summary").click();
    await expect(quarterlyRow.locator(".finance-notes")).toHaveText(
      breakdownNotes,
    );
    expect(await quarterlyRow.locator(".finance-notes").innerText()).toContain(
      "\n",
    );
    await quarterlyRow
      .getByRole("button", {
        name: new RegExp(`^(ویرایش|Edit) ${prefix} Quarterly$`),
      })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^توضیحات$|^Notes$/)).toHaveValue(
      breakdownNotes,
    );
    await dialog
      .getByRole("button", { name: "Close / بستن", exact: true })
      .click();
    await itemized
      .getByRole("button", { name: /مدیریت همهٔ موارد|Manage all items/ })
      .click();
    const planCard = page.locator(".finance-record").filter({
      has: page.getByRole("heading", {
        name: `${prefix} Quarterly`,
        exact: true,
      }),
    });
    await planCard
      .getByRole("button", { name: /^ثبت پرداخت$|^Record payment$/ })
      .click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/مبلغ واقعی|Actual amount/)).toHaveValue(
      "300.00",
    );
    await dialog.getByLabel(/^عنوان$|^Title$/).fill(`${prefix} Expense`);
    await dialog.getByLabel(/مبلغ واقعی|Actual amount/).fill("120.00");
    await dialog
      .getByLabel(/تاریخ واقعی پرداخت|Actual payment/)
      .fill(`${month}-06`);
    await saveDialog(page);
    await createPayment(page, {
      title: `${prefix} Refund`,
      kind: "refund",
      amount: "20.00",
      date: `${month}-07`,
      accountId: source.account_id,
      categoryId: category.category_id,
    });
    await createPayment(page, {
      title: `${prefix} Transfer`,
      kind: "transfer",
      amount: "30.00",
      date: `${month}-08`,
      accountId: source.account_id,
      destinationId: destination.account_id,
    });
    const paid = await read<FinanceSummaryDTO>(request, "finance_summary", {
      month,
    });
    expect(paid.actual.expense_cents - base.actual.expense_cents).toBe(12000);
    expect(paid.actual.refund_cents - base.actual.refund_cents).toBe(2000);
    expect(paid.actual.net_expense_cents - base.actual.net_expense_cents).toBe(
      10000,
    );
    expect(paid.actual.transfer_cents - base.actual.transfer_cents).toBe(3000);
    expect(
      paid.by_account.find((item) => item.account_id === source.account_id)
        ?.balance_cents,
    ).toBe(87000);
    expect(
      paid.by_account.find((item) => item.account_id === destination.account_id)
        ?.balance_cents,
    ).toBe(3000);

    await planCard.getByRole("button", { name: /^ویرایش$|^Edit$/ }).click();
    dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel(/^نوع برنامه$|^Plan kind$/)).toBeDisabled();
    await dialog
      .getByLabel(/اثر ویرایش از ماه|Edit effective from month/)
      .fill("2032-03");
    await dialog.getByLabel(/مبلغ کامل هر دوره|Full bill/).fill("600.00");
    await saveDialog(page);
    plans = await all<FinancePlanDTO>(request, "finance_plan_list", { month });
    expect(plans.find((item) => item.plan_id === planId)?.amount_cents).toBe(
      30000,
    );
    await page.getByLabel(/ماه گزارش|Report month/).fill("2032-03");
    const march = (
      await all<FinancePlanDTO>(request, "finance_plan_list", {
        month: "2032-03",
      })
    ).find((item) => item.plan_id === planId)!;
    expect(march.amount_cents).toBe(60000);
    await planCard.getByRole("button", { name: /^ویرایش$|^Edit$/ }).click();
    dialog = page.getByRole("dialog");
    await dialog
      .getByLabel(/اثر ویرایش از ماه|Edit effective from month/)
      .fill("2032-04");
    await mutate(
      request,
      "finance_plan_update",
      {
        plan_id: planId,
        effective_month: "2032-04",
        title: `${prefix} Remote`,
        notes: "Synthetic remote note",
        amount_cents: 90000,
        interval_months: 6,
      },
      march.revision,
    );
    await dialog.getByLabel(/مبلغ کامل هر دوره|Full bill/).fill("650.00");
    await dialog.getByRole("button", { name: /^ذخیره$|^Save$/ }).click();
    await expect(dialog.locator(".finance-conflict")).toBeVisible();
    await expect(dialog.getByLabel(/مبلغ کامل هر دوره|Full bill/)).toHaveValue(
      "650.00",
    );
    await expect(dialog.locator(".finance-conflict")).toContainText(
      `${prefix} Remote`,
    );
    await dialog
      .getByRole("button", {
        name: /تفاوت‌ها را دیدم|I reviewed the differences/,
      })
      .click();
    await saveDialog(page);
    const merged = (
      await all<FinancePlanDTO>(request, "finance_plan_list", {
        month: "2032-04",
      })
    ).find((item) => item.plan_id === planId)!;
    expect(merged.amount_cents).toBe(65000);
    expect(merged.interval_months).toBe(6);
    expect(merged.title).toBe(`${prefix} Remote`);
    expect(merged.notes).toBe("Synthetic remote note");
    const unchangedMarch = (
      await all<FinancePlanDTO>(request, "finance_plan_list", {
        month: "2032-03",
      })
    ).find((item) => item.plan_id === planId)!;
    expect(unchangedMarch.amount_cents).toBe(60000);
    expect(unchangedMarch.interval_months).toBe(3);

    await page
      .getByRole("button", { name: /ورود و خروج JSON|Import \/ export JSON/ })
      .click();
    dialog = page.getByRole("dialog");
    const downloadPromise = page.waitForEvent("download");
    await dialog
      .getByRole("button", { name: /خروجی کامل JSON|Export all JSON/ })
      .click();
    const download = await downloadPromise;
    const exported: FinanceImportDTO = JSON.parse(
      await readFile((await download.path())!, "utf8"),
    );
    expect(exported.format).toBe("ramin-life-os/finance/1");
    expect(
      exported.plans.find((item) => item.title === `${prefix} Remote`)?.versions
        .length,
    ).toBeGreaterThanOrEqual(2);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: "synthetic-finance.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(dialog.locator(".finance-import-preview")).toBeVisible();
    await dialog
      .getByRole("button", { name: /ثبت همین پیش‌نمایش|Commit this preview/ })
      .click();
    await expect(
      dialog
        .getByRole("status")
        .filter({ hasText: /واردسازی ذخیره شد|Import saved/ }),
    ).toBeVisible();
    await dialog
      .getByRole("button", { name: "Close / بستن", exact: true })
      .click();
    await page.reload();
    await page.getByLabel(/ماه گزارش|Report month/).fill(month);
    await page
      .getByRole("tab", { name: /پرداخت‌های ثبت‌شده|Registered payments/ })
      .click();
    await page.getByLabel(/جست‌وجوی پرداخت‌ها|Search payments/).fill(prefix);
    await expect(page.locator(".finance-record")).toHaveCount(3);
    const savedPayments = await all<FinanceTransactionDTO>(
      request,
      "finance_transaction_list",
      { month },
    );
    expect(
      savedPayments.filter((item) => item.title.startsWith(prefix)),
    ).toHaveLength(3);

    // A future archive must not hide a line that still contributes to history.
    const archiveMonth = "2032-05";
    const historicalBefore = await read<FinanceSummaryDTO>(
      request,
      "finance_summary",
      { month },
    );
    const futureBefore = await read<FinanceSummaryDTO>(
      request,
      "finance_summary",
      { month: archiveMonth },
    );
    const futurePlan = (
      await all<FinancePlanDTO>(request, "finance_plan_list", {
        month: archiveMonth,
      })
    ).find((item) => item.plan_id === planId)!;
    await mutate(
      request,
      "finance_plan_archive",
      { plan_id: planId, effective_month: archiveMonth },
      futurePlan.revision,
    );
    try {
      await page.reload();
      await page.getByLabel(/ماه گزارش|Report month/).fill(month);
      const historicalRow = page.locator(
        `.finance-itemized-row[data-plan-id="${planId}"]`,
      );
      await expect(historicalRow).toBeVisible();
      await expect(
        historicalRow.locator(".finance-itemized-archived"),
      ).toHaveText(/بایگانی‌شده؛ نسخهٔ این ماه|Archived; this month's version/);
      await expect(
        historicalRow.locator(".finance-itemized-monthly .finance-money"),
      ).toHaveText(money(10000));
      await expect(
        historicalRow.getByRole("button", { name: /^(ویرایش|Edit) / }),
      ).toHaveCount(0);
      const historicalAfter = await read<FinanceSummaryDTO>(
        request,
        "finance_summary",
        { month },
      );
      expect(historicalAfter.monthly_cost_cents).toBe(
        historicalBefore.monthly_cost_cents,
      );
      await expect(
        page
          .locator(".finance-metrics .metric-card")
          .nth(0)
          .locator("strong .finance-money"),
      ).toHaveText(money(historicalAfter.recurring_monthly_cents));
      await page.getByLabel(/ماه گزارش|Report month/).fill(archiveMonth);
      await expect(historicalRow).toHaveCount(0);
      const futureAfter = await read<FinanceSummaryDTO>(
        request,
        "finance_summary",
        { month: archiveMonth },
      );
      expect(futureAfter.monthly_cost_cents).toBe(
        futureBefore.monthly_cost_cents - futurePlan.monthly_equivalent_cents!,
      );
      await expect(
        page
          .locator(".finance-metrics .metric-card")
          .nth(0)
          .locator("strong .finance-money"),
      ).toHaveText(money(futureAfter.recurring_monthly_cents));
    } finally {
      const archivedPlan = (
        await all<FinancePlanDTO>(request, "finance_plan_list", {
          month: archiveMonth,
          archived: true,
        })
      ).find((item) => item.plan_id === planId);
      if (archivedPlan)
        await mutate(
          request,
          "finance_plan_restore",
          { plan_id: planId, effective_month: archiveMonth },
          archivedPlan.revision,
        );
    }
  } finally {
    await cleanup(request, prefix);
  }
});

test("finance lost acknowledgement retries once, and mobile RTL retains both themes", async ({
  page,
  request,
}) => {
  await login(request, page);
  const prefix = `E2E finance retry ${crypto.randomUUID().slice(0, 8)}`;
  const preferences = await read<{
    settings: Record<string, unknown>;
    revision: number;
  }>(request, "preferences_get");
  let committed = false;
  const keys: string[] = [];
  try {
    await mutate(
      request,
      "preferences_update",
      { settings: { language: "fa", theme: "dark" } },
      preferences.revision,
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/finances");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkCanvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas"),
    );
    await page.route("**/api/v1/commands", async (route) => {
      const body = route.request().postDataJSON();
      if (
        body.command === "finance_transaction_create" &&
        body.input.title === prefix
      ) {
        keys.push(route.request().headers()["idempotency-key"]);
        if (!committed) {
          const response = await route.fetch();
          expect(response.ok()).toBeTruthy();
          committed = true;
          await route.abort("failed");
          return;
        }
      }
      await route.continue();
    });
    await page
      .getByRole("button", { name: /ثبت پرداخت یا دریافت/ })
      .first()
      .click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^عنوان$/).fill(prefix);
    await dialog.getByLabel(/مبلغ واقعی/).fill("۱۲٫۳۴");
    await dialog.getByRole("button", { name: /^ذخیره$/ }).click();
    await expect(dialog.getByLabel(/^عنوان$/)).toBeDisabled();
    await expect(
      dialog.getByRole("button", { name: /بررسی نتیجهٔ همین ذخیره/ }),
    ).toBeEnabled();
    await dialog
      .getByRole("button", { name: /بررسی نتیجهٔ همین ذخیره/ })
      .click();
    await expect(dialog).toBeHidden();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    const rows = await all<FinanceTransactionDTO>(
      request,
      "finance_transaction_list",
      { month: financeToday().slice(0, 7) },
    );
    expect(rows.filter((item) => item.title === prefix)).toHaveLength(1);

    const overviewTab = page.getByRole("tab", {
      name: "نمای ماه",
      exact: true,
    });
    await overviewTab.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.getByRole("tab", { name: "هزینه‌ها و بودجه‌ها", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("tab", { name: "پرداخت‌های ثبت‌شده", exact: true })
      .click();
    await page.getByLabel("جست‌وجوی پرداخت‌ها", { exact: true }).fill(prefix);
    const card = page.locator(".finance-record").filter({ hasText: prefix });
    await card.getByRole("button", { name: "بایگانی", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel("بایگانی‌شده‌ها", { exact: true }).check();
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "بازگردانی", exact: true }).click();
    await expect(card).toHaveCount(0);
    await page.getByLabel("بایگانی‌شده‌ها", { exact: true }).uncheck();
    await expect(card).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBeTruthy();
    const current = await read<{
      settings: Record<string, unknown>;
      revision: number;
    }>(request, "preferences_get");
    await mutate(
      request,
      "preferences_update",
      { settings: { theme: "light" } },
      current.revision,
    );
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--canvas"),
      ),
    ).not.toBe(darkCanvas);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth + 1,
      ),
    ).toBeTruthy();
  } finally {
    await cleanup(request, prefix);
    const current = await read<{
      settings: Record<string, unknown>;
      revision: number;
    }>(request, "preferences_get");
    await mutate(
      request,
      "preferences_update",
      {
        settings: {
          ...preferences.settings,
          language: preferences.settings.language ?? "fa",
          theme: preferences.settings.theme ?? "dark",
        },
      },
      current.revision,
    );
  }
});
