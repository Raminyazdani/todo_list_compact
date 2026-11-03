"use client";

import { useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import {
  Archive,
  ArrowDownLeft,
  ArrowLeftRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderOpen,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Upload,
  WalletCards,
} from "lucide-react";
import type {
  CommandName,
  FinanceAccountDTO,
  FinanceAmountBasis,
  FinanceCategoryDTO,
  FinanceDuePrecision,
  FinanceImportDTO,
  FinanceImportPreviewDTO,
  FinancePlanDTO,
  FinancePlanKind,
  FinancePlanState,
  FinanceSummaryDTO,
  FinanceTransactionDTO,
  FinanceTransactionKind,
  MutationResult,
  PageDTO,
  QueryName,
} from "@/shared/contracts";
import {
  Button,
  Empty,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";
import {
  ApiError,
  clearQueryCache,
  query,
  usePagedQuery,
  useQuery,
} from "./api";
import {
  euroInput,
  FINANCE_JSON_MAX_BYTES,
  financeEditInput,
  financeToday,
  parseEuroCents,
  serializeFinanceExport,
  shiftFinanceMonth,
} from "./finance-model";
import { useLocale } from "./locale";
import { FinanceItemizedPlans } from "./finance-itemized";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
type Entity =
  | FinancePlanDTO
  | FinanceTransactionDTO
  | FinanceAccountDTO
  | FinanceCategoryDTO;
type Editor =
  | { kind: "plan"; entity?: FinancePlanDTO }
  | {
      kind: "transaction";
      entity?: FinanceTransactionDTO;
      plan?: FinancePlanDTO;
    }
  | { kind: "account"; entity?: FinanceAccountDTO }
  | { kind: "category"; entity?: FinanceCategoryDTO };
type Labels = ReturnType<typeof useFinanceLabels>;

function useFinanceLabels() {
  const { t } = useLocale();
  return {
    plan: {
      recurring: t("هزینهٔ تکرارشونده", "Recurring cost"),
      one_off: t("هزینهٔ موردی", "One-off cost"),
      budget: t("بودجهٔ انتخابی", "Budget"),
      reserve: t("کنارگذاری", "Reserve"),
      liability: t("بدهی یا مطالبه", "Liability"),
    },
    state: {
      active: t("فعال", "Active"),
      paused: t("متوقف", "Paused"),
      reference: t("فقط سابقه", "Reference only"),
    },
    basis: {
      confirmed: t("مستند / تأییدشده", "Documented / confirmed"),
      reported: t("اعلام‌شده", "Reported"),
      estimate: t("برآوردی", "Estimated"),
      unknown: t("نامشخص", "Unknown"),
    },
    transaction: {
      expense: t("پرداخت هزینه", "Expense"),
      income: t("دریافت درآمد", "Income"),
      refund: t("بازگشت وجه هزینه", "Expense refund"),
      transfer: t("انتقال بین حساب‌ها", "Account transfer"),
    },
    precision: {
      exact: t("قطعی", "Exact"),
      approximate: t("تقریبی", "Approximate"),
      unknown: t("نامشخص", "Unknown"),
    },
  };
}

function Money({
  cents,
  className = "",
}: {
  cents: number | null;
  className?: string;
}) {
  const { t, language } = useLocale();
  return (
    <bdi className={`finance-money ${className}`} dir="ltr">
      {cents === null
        ? t("نامشخص", "Unknown")
        : new Intl.NumberFormat(language === "fa" ? "fa-IR" : "en-IE", {
            style: "currency",
            currency: "EUR",
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          }).format(cents / 100)}
    </bdi>
  );
}

function KindPill({
  children,
  tone = "",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={`finance-pill ${tone}`}>{children}</span>;
}

function cadence(
  plan: FinancePlanDTO,
  labels: Labels,
  t: (fa: string, en: string) => string,
) {
  if (plan.kind === "one_off" || plan.kind === "liability")
    return labels.plan[plan.kind];
  if (plan.interval_months === null)
    return t("دورهٔ پرداخت نامشخص", "Payment interval unknown");
  if (plan.interval_months === 1) return t("هر ماه", "Monthly");
  return t(
    `هر ${plan.interval_months} ماه`,
    `Every ${plan.interval_months} months`,
  );
}

function downloadJson(data: unknown, name: string) {
  const url = URL.createObjectURL(
    new Blob([serializeFinanceExport(data)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function entityId(editor: Editor) {
  if (!editor.entity) return null;
  if (editor.kind === "plan") return editor.entity.plan_id;
  if (editor.kind === "transaction") return editor.entity.transaction_id;
  if (editor.kind === "account") return editor.entity.account_id;
  return editor.entity.category_id;
}

async function latestEntity(
  editor: Editor,
  month: string,
): Promise<Entity | null> {
  const id = entityId(editor);
  if (!id) return null;
  clearQueryCache();
  const operation = `finance_${editor.kind}_list` as QueryName;
  for (const archived of [false, true]) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: PageDTO<Entity> = await query(operation, {
        ...(editor.kind === "plan" ? { month } : {}),
        archived,
        cursor,
        limit: 200,
      });
      const found = page.items.find((item) =>
        Object.entries(item).some(
          ([key, value]) => key === `${editor.kind}_id` && value === id,
        ),
      );
      if (found) return found;
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor))
        throw new Error("صفحه‌بندی تکراری / Repeated pagination");
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  return null;
}

export function FinanceWorkspace({ action }: { action: Action }) {
  const { t, language } = useLocale();
  const labels = useFinanceLabels();
  const [month, setMonth] = useState(() => financeToday().slice(0, 7));
  const [tab, setTab] = useState<"overview" | "plans" | "payments">("overview");
  const [projection, setProjection] = useState<3 | 6 | 12>(3);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<FinancePlanKind | "">("");
  const [planState, setPlanState] = useState<FinancePlanState | "">("");
  const [paymentKind, setPaymentKind] = useState<FinanceTransactionKind | "">(
    "",
  );
  const [filterAccount, setFilterAccount] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [archived, setArchived] = useState(false);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [manager, setManager] = useState<"account" | "category" | null>(null);
  const [managerArchived, setManagerArchived] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const summary = useQuery<FinanceSummaryDTO>("finance_summary", {
    month,
    horizon_months: projection,
  });
  const plans = usePagedQuery<FinancePlanDTO>("finance_plan_list", { month });
  const archivedPlans = usePagedQuery<FinancePlanDTO>(
    "finance_plan_list",
    { month, archived: true },
    tab === "overview" || (tab === "plans" && archived),
  );
  const itemizedPlans = useMemo(() => {
    const latest = new Map<string, FinancePlanDTO>();
    for (const plan of [
      ...(plans.data?.items ?? []),
      ...(archivedPlans.data?.items ?? []),
    ]) {
      const previous = latest.get(plan.plan_id);
      if (!previous || plan.revision > previous.revision)
        latest.set(plan.plan_id, plan);
    }
    return [...latest.values()];
  }, [plans.data, archivedPlans.data]);
  const itemizedError =
    [
      plans.error &&
        t(
          "دریافت موارد جاری کامل نشد: ",
          "Current items could not be fully loaded: ",
        ) + plans.error,
      archivedPlans.error &&
        t(
          "دریافت سوابق بایگانی‌شده کامل نشد: ",
          "Archived history could not be fully loaded: ",
        ) + archivedPlans.error,
    ]
      .filter(Boolean)
      .join(" · ") || null;
  const transactions = usePagedQuery<FinanceTransactionDTO>(
    "finance_transaction_list",
    { month, archived },
    tab === "payments",
  );
  const accounts = usePagedQuery<FinanceAccountDTO>("finance_account_list");
  const categories = usePagedQuery<FinanceCategoryDTO>("finance_category_list");
  const archivedAccounts = usePagedQuery<FinanceAccountDTO>(
    "finance_account_list",
    { archived: true },
    manager === "account" && managerArchived,
  );
  const archivedCategories = usePagedQuery<FinanceCategoryDTO>(
    "finance_category_list",
    { archived: true },
    manager === "category" && managerArchived,
  );
  const accountNames = useMemo(
    () =>
      new Map([
        ...(summary.data?.by_account
          .filter((item) => item.account_id)
          .map((item) => [item.account_id!, item.title] as const) ?? []),
        ...(accounts.data?.items.map(
          (item) => [item.account_id, item.title] as const,
        ) ?? []),
      ]),
    [accounts.data, summary.data],
  );
  const categoryNames = useMemo(
    () =>
      new Map([
        ...(summary.data?.by_category
          .filter((item) => item.category_id)
          .map((item) => [item.category_id!, item.title] as const) ?? []),
        ...(categories.data?.items.map(
          (item) => [item.category_id, item.title] as const,
        ) ?? []),
      ]),
    [categories.data, summary.data],
  );
  const accountName = (id: string | null) =>
    id
      ? (accountNames.get(id) ?? t("حساب بایگانی‌شده", "Archived account"))
      : t("حساب نامشخص", "Account unknown");
  const categoryName = (id: string | null) =>
    id
      ? (categoryNames.get(id) ?? t("دستهٔ بایگانی‌شده", "Archived category"))
      : t("بدون دسته", "Uncategorized");
  const shownPlansQuery = archived ? archivedPlans : plans;
  const matchesReference = (selected: string, id: string | null) =>
    !selected || (selected === "__unknown" ? id === null : id === selected);
  const shownPlans = (shownPlansQuery.data?.items ?? []).filter(
    (item) =>
      (!kind || item.kind === kind) &&
      (!planState || item.state === planState) &&
      matchesReference(filterAccount, item.account_id) &&
      matchesReference(filterCategory, item.category_id) &&
      `${item.title} ${item.notes} ${item.source_label}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const shownTransactions = (transactions.data?.items ?? []).filter(
    (item) =>
      (!paymentKind || item.kind === paymentKind) &&
      (!filterAccount ||
        matchesReference(filterAccount, item.account_id) ||
        (item.kind === "transfer" &&
          filterAccount !== "__unknown" &&
          item.transfer_account_id === filterAccount)) &&
      matchesReference(filterCategory, item.category_id) &&
      `${item.title} ${item.notes} ${item.source_label}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  async function changeArchived(type: Editor["kind"], entity: Entity) {
    if (pending) return;
    const id = Object.entries(entity).find(
      ([key]) => key === `${type}_id`,
    )?.[1];
    if (typeof id !== "string") return;
    setPending(id);
    try {
      await action(
        `finance_${type}_${entity.archived_at ? "restore" : "archive"}` as CommandName,
        {
          [`${type}_id`]: id,
          ...(type === "plan" ? { effective_month: month } : {}),
        },
        entity.revision,
      );
    } catch {
      // The shared action displays the server error; current rows stay visible.
    } finally {
      setPending(null);
    }
  }
  function recordPlan(plan: FinancePlanDTO) {
    setEditor({ kind: "transaction", plan });
  }
  function referenceFilters() {
    return (
      <>
        <select
          aria-label={t("فیلتر حساب", "Filter account")}
          value={filterAccount}
          onChange={(event) => setFilterAccount(event.target.value)}
        >
          <option value="">{t("همهٔ حساب‌ها", "All accounts")}</option>
          <option value="__unknown">
            {t("حساب نامشخص", "Account unknown")}
          </option>
          {[...accountNames].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
        <select
          aria-label={t("فیلتر دسته", "Filter category")}
          value={filterCategory}
          onChange={(event) => setFilterCategory(event.target.value)}
        >
          <option value="">{t("همهٔ دسته‌ها", "All categories")}</option>
          <option value="__unknown">{t("بدون دسته", "Uncategorized")}</option>
          {[...categoryNames].map(([id, title]) => (
            <option key={id} value={id}>
              {title}
            </option>
          ))}
        </select>
      </>
    );
  }
  return (
    <div className="lifeos-section-screen lifeos-finances">
      <div className="page-heading finance-heading">
        <div>
          <div className="eyebrow">
            {t("هزینه‌هایت را روشن ببین", "KNOW YOUR COSTS")}
          </div>
          <h1>{t("مدیریت مالی", "Finances")}</h1>
          <p>
            {t(
              "برنامهٔ هزینه‌ها، کنارگذاری‌ها و پرداخت‌های ثبت‌شده در یک جا",
              "Plans, reserves and registered payments in one place",
            )}
          </p>
        </div>
        <div className="form-actions">
          <Button onClick={() => setTransferOpen(true)}>
            <ArrowLeftRight size={15} />
            {t("ورود و خروج JSON", "Import / export JSON")}
          </Button>
          <Button
            variant="primary"
            onClick={() => setEditor({ kind: "transaction" })}
          >
            <Plus size={16} />
            {t("ثبت پرداخت یا دریافت", "Record payment or income")}
          </Button>
        </div>
      </div>
      <div className="finance-toolbar">
        <div className="finance-month-control">
          <Button
            aria-label={t("ماه قبل", "Previous month")}
            disabled={month === "0001-01"}
            onClick={() => setMonth(shiftFinanceMonth(month, -1))}
          >
            <ChevronRight size={16} />
          </Button>
          <Field label={t("ماه گزارش", "Report month")}>
            <input
              type="month"
              min="0001-01"
              max="9999-12"
              value={month}
              onChange={(event) => {
                if (event.target.value) setMonth(event.target.value);
              }}
            />
          </Field>
          <Button
            aria-label={t("ماه بعد", "Next month")}
            disabled={month === "9999-12"}
            onClick={() => setMonth(shiftFinanceMonth(month, 1))}
          >
            <ChevronLeft size={16} />
          </Button>
        </div>
        <div className="form-actions">
          <Button
            onClick={() => {
              setManager("account");
              setManagerArchived(false);
            }}
          >
            <WalletCards size={15} />
            {t("حساب‌ها", "Accounts")}
          </Button>
          <Button
            onClick={() => {
              setManager("category");
              setManagerArchived(false);
            }}
          >
            <FolderOpen size={15} />
            {t("دسته‌بندی‌ها", "Categories")}
          </Button>
        </div>
      </div>
      <div
        className="tabs finance-tabs"
        role="tablist"
        aria-label={t("نماهای مالی", "Finance views")}
      >
        {(
          [
            ["overview", t("نمای ماه", "Month overview")],
            ["plans", t("هزینه‌ها و بودجه‌ها", "Costs & budgets")],
            ["payments", t("پرداخت‌های ثبت‌شده", "Registered payments")],
          ] as const
        ).map(([value, title]) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`finance-tab-${value}`}
            tabIndex={tab === value ? 0 : -1}
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              const buttons = [
                ...(event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                  '[role="tab"]',
                ) ?? []),
              ];
              const current = buttons.indexOf(event.currentTarget);
              const increment =
                event.key === "ArrowRight"
                  ? language === "fa"
                    ? -1
                    : 1
                  : language === "fa"
                    ? 1
                    : -1;
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? buttons.length - 1
                    : (current + increment + buttons.length) % buttons.length;
              event.preventDefault();
              buttons[next]?.focus();
              buttons[next]?.click();
            }}
            onClick={() => {
              setTab(value);
              setSearch("");
              setArchived(false);
              setFilterAccount("");
              setFilterCategory("");
            }}
          >
            {title}
          </button>
        ))}
      </div>
      {tab === "overview" && (
        <div
          role="tabpanel"
          id="finance-overview"
          aria-labelledby="finance-tab-overview"
          className="finance-overview"
        >
          <QueryState {...summary} retry={summary.refresh} />
          <FinanceItemizedPlans
            plans={itemizedPlans}
            loading={plans.loading || archivedPlans.loading}
            error={itemizedError}
            retry={() => {
              plans.refresh();
              archivedPlans.refresh();
            }}
            labels={labels}
            accountName={accountName}
            categoryName={categoryName}
            renderMoney={(cents) => <Money cents={cents} />}
            cadence={(plan) => cadence(plan, labels, t)}
            onEdit={(plan) => setEditor({ kind: "plan", entity: plan })}
            onManage={() => {
              setTab("plans");
              setSearch("");
              setKind("");
              setPlanState("");
              setArchived(false);
              setFilterAccount("");
              setFilterCategory("");
            }}
          />
          {summary.data && (
            <>
              <div className="metric-grid finance-metrics">
                <article className="metric-card">
                  <span>
                    {t(
                      "هزینه‌های تکرارشونده؛ معادل ماهانه",
                      "Recurring costs · monthly equivalent",
                    )}
                  </span>
                  <strong>
                    <Money cents={summary.data.recurring_monthly_cents} />
                  </strong>
                  <small>
                    {t(
                      "مبلغ قبض با دورهٔ پرداخت خودش ثبت می‌شود.",
                      "Bills retain their actual payment interval.",
                    )}
                  </small>
                </article>
                <article className="metric-card">
                  <span>
                    {t("بودجه‌های انتخابی ماهانه", "Monthly budgets")}
                  </span>
                  <strong>
                    <Money cents={summary.data.budget_monthly_cents} />
                  </strong>
                  <small>
                    {t(
                      "بودجه، پرداخت انجام‌شده نیست.",
                      "A budget is not a completed payment.",
                    )}
                  </small>
                </article>
                <article className="metric-card">
                  <span>{t("کنارگذاری ماهانه", "Monthly reserves")}</span>
                  <strong>
                    <Money cents={summary.data.reserve_monthly_cents} />
                  </strong>
                  <small>
                    {t(
                      "جدا از هزینه‌ها؛ شامل کنارگذاری‌های انتخاب‌شده",
                      "Separate from costs; included reserves only",
                    )}
                  </small>
                </article>
                <article className="metric-card">
                  <span>
                    {t("کل تخصیص برنامه‌ریزی‌شده", "Total planned allocation")}
                  </span>
                  <strong>
                    <Money cents={summary.data.monthly_allocation_cents} />
                  </strong>
                  <small>
                    {summary.data.included_unknown_amount_count
                      ? t(
                          `${summary.data.included_unknown_amount_count} مورد بدون معادل ماهانهٔ معلوم در جمع نیست.`,
                          `${summary.data.included_unknown_amount_count} unquantified items are excluded.`,
                        )
                      : t(
                          "بر اساس برنامه‌های فعال و انتخاب‌شده",
                          "Based on included active plans",
                        )}
                  </small>
                </article>
              </div>
              {!!summary.data.included_unknown_amount_count && (
                <p className="finance-notice" role="status">
                  {t(
                    "مبلغ یا دورهٔ نامشخص صفر نیست؛ تا روشن‌شدن آن‌ها، جمع هزینه‌ها کامل نیست.",
                    "Unknown amounts or intervals do not mean zero. Totals remain incomplete until they are known.",
                  )}
                </p>
              )}

              <div className="finance-columns">
                <section className="panel">
                  <SectionHeading
                    title={t(
                      "پرداخت‌های ثبت‌شدهٔ این ماه",
                      "Registered payments this month",
                    )}
                    subtitle={t(
                      "این اعداد فقط از ثبت‌های موجود محاسبه می‌شوند؛ پوشش کامل بانک نیستند.",
                      "These figures cover recorded entries, not a complete bank statement.",
                    )}
                  />
                  <dl className="finance-totals">
                    <div>
                      <dt>{t("هزینه", "Expenses")}</dt>
                      <dd>
                        <Money cents={summary.data.actual.expense_cents} />
                      </dd>
                    </div>
                    <div>
                      <dt>{t("بازگشت وجه", "Refunds")}</dt>
                      <dd>
                        <Money cents={summary.data.actual.refund_cents} />
                      </dd>
                    </div>
                    <div>
                      <dt>
                        {t("هزینهٔ خالص ثبت‌شده", "Registered net expense")}
                      </dt>
                      <dd>
                        <Money cents={summary.data.actual.net_expense_cents} />
                      </dd>
                    </div>
                    <div>
                      <dt>{t("درآمد ثبت‌شده", "Registered income")}</dt>
                      <dd>
                        <Money cents={summary.data.actual.income_cents} />
                      </dd>
                    </div>
                    <div>
                      <dt>{t("انتقال بین حساب‌ها", "Account transfers")}</dt>
                      <dd>
                        <Money cents={summary.data.actual.transfer_cents} />
                      </dd>
                    </div>
                  </dl>
                  <p className="muted small">
                    {t(
                      "انتقال بین حساب‌ها هزینهٔ تازه نیست. ذخیرهٔ برنامه، پرداخت ایجاد نمی‌کند.",
                      "Transfers are not new expenses. Saving a plan does not create a payment.",
                    )}
                  </p>
                </section>
                <section className="panel">
                  <SectionHeading
                    title={t("برآورد تخصیص چندماهه", "Allocation estimate")}
                  />
                  <Field label={t("بازهٔ برآورد", "Estimate horizon")}>
                    <select
                      value={projection}
                      onChange={(event) =>
                        setProjection(Number(event.target.value) as 3 | 6 | 12)
                      }
                    >
                      {[3, 6, 12].map((value) => (
                        <option key={value} value={value}>
                          {t(`${value} ماه`, `${value} months`)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <p className="finance-projection">
                    <Money
                      cents={
                        summary.data.projection.total_known_allocation_cents
                      }
                    />
                  </p>
                  <p className="muted small">
                    {t(
                      "جمع معادل ماهانه بر اساس نسخه‌های برنامه در این بازه است؛ زمان واقعی قبض‌ها یا تغییرات ثبت‌نشده را پیش‌بینی نمی‌کند.",
                      "Sums monthly equivalents using plan versions in this horizon; it does not predict actual bill timing or unrecorded changes.",
                    )}
                  </p>
                  {summary.data.projection.unknown_month_count > 0 && (
                    <p className="small">
                      {t(
                        `${summary.data.projection.unknown_month_count} ماه دارای مبلغ یا دورهٔ نامشخص است؛ برآورد کامل نیست.`,
                        `${summary.data.projection.unknown_month_count} months contain unquantified items; the estimate is incomplete.`,
                      )}
                    </p>
                  )}
                  {summary.data.optional_reserve_monthly_cents > 0 && (
                    <p className="small">
                      {t(
                        "کنارگذاری اختیاری خارج از جمع:",
                        "Optional reserve outside the total:",
                      )}{" "}
                      <Money
                        cents={summary.data.optional_reserve_monthly_cents}
                      />{" "}
                      {t("در ماه", "/ month")}
                    </p>
                  )}
                </section>
              </div>
              <div className="finance-columns">
                <section className="panel">
                  <SectionHeading
                    title={t(
                      "زمان پرداخت‌های برنامه",
                      "Planned payment timing",
                    )}
                    subtitle={t(
                      "زمان تقریبی، موعد قطعی یا تأیید برداشت بانکی نیست.",
                      "Approximate timing is not an exact due date or payment confirmation.",
                    )}
                  />
                  {!summary.data.upcoming.length && (
                    <p className="muted small">
                      {t(
                        "زمان پرداختی برای این ماه ثبت نشده است.",
                        "No payment timing recorded for this month.",
                      )}
                    </p>
                  )}
                  <ul className="finance-upcoming">
                    {summary.data.upcoming.map((item) => (
                      <li key={item.plan_id}>
                        <div>
                          <strong>{item.title}</strong>
                          <small>
                            {item.date ??
                              (item.day
                                ? t(
                                    `روز ${item.day} ماه`,
                                    `Day ${item.day} of month`,
                                  )
                                : t("تاریخ نامشخص", "Date unknown"))}{" "}
                            · {labels.precision[item.precision]}
                          </small>
                          <small>{accountName(item.account_id)}</small>
                        </div>
                        <Money cents={item.amount_cents} />
                        <Button
                          onClick={() => {
                            const plan = plans.data?.items.find(
                              (entry) => entry.plan_id === item.plan_id,
                            );
                            if (plan) recordPlan(plan);
                          }}
                          disabled={
                            !plans.data?.items.some(
                              (entry) => entry.plan_id === item.plan_id,
                            )
                          }
                        >
                          {t("ثبت پرداخت", "Record payment")}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="panel">
                  <SectionHeading
                    title={t(
                      "کنارگذاری در مقایسه با هدف",
                      "Reserves against a target",
                    )}
                    subtitle={t(
                      "هدف می‌تواند آخرین مبلغ شناخته‌شده باشد؛ مبلغ مطالبهٔ بعدی را تضمین نمی‌کند.",
                      "A target may be a last-known amount; it does not guarantee a future bill.",
                    )}
                  />
                  {!summary.data.reserve_benchmarks.length && (
                    <p className="muted small">
                      {t(
                        "هنوز هدفی برای کنارگذاری ثبت نشده است.",
                        "No reserve targets recorded yet.",
                      )}
                    </p>
                  )}
                  <ul className="finance-reserves">
                    {summary.data.reserve_benchmarks.map((item) => (
                      <li key={item.plan_id}>
                        <div>
                          <strong>{item.title}</strong>
                          {!item.included && (
                            <KindPill>{t("خارج از جمع", "Excluded")}</KindPill>
                          )}
                        </div>
                        <dl className="finance-totals">
                          <div>
                            <dt>
                              {t("کنارگذاری ماهانه", "Monthly allocation")}
                            </dt>
                            <dd>
                              <Money cents={item.monthly_cents} />
                            </dd>
                          </div>
                          <div>
                            <dt>{t("مبلغ هدف", "Target amount")}</dt>
                            <dd>
                              <Money cents={item.target_cents} />
                            </dd>
                          </div>
                          <div>
                            <dt>
                              {item.horizon_months
                                ? t(
                                    `پس از ${item.horizon_months} ماه`,
                                    `After ${item.horizon_months} months`,
                                  )
                                : t("بازه نامشخص", "Horizon unknown")}
                            </dt>
                            <dd>
                              <Money cents={item.projected_cents} />
                            </dd>
                          </div>
                          {item.shortfall_cents !== null && (
                            <div>
                              <dt>
                                {item.shortfall_cents > 0
                                  ? t(
                                      "کسری نسبت به هدف",
                                      "Shortfall against target",
                                    )
                                  : t(
                                      "باقی‌مانده نسبت به هدف",
                                      "Difference against target",
                                    )}
                              </dt>
                              <dd>
                                <Money cents={Math.abs(item.shortfall_cents)} />
                              </dd>
                            </div>
                          )}
                        </dl>
                      </li>
                    ))}
                  </ul>
                </section>
              </div>
              <section className="panel">
                <SectionHeading
                  title={t("هزینه‌ها بر اساس دسته", "Costs by category")}
                />
                {!summary.data.by_category.length ? (
                  <p className="muted small">
                    {t(
                      "هنوز برنامه یا پرداختی ثبت نشده است.",
                      "No plans or payments recorded yet.",
                    )}
                  </p>
                ) : (
                  <div className="data-table-wrap">
                    <table className="finance-table">
                      <thead>
                        <tr>
                          <th>{t("دسته", "Category")}</th>
                          <th>{t("برنامهٔ ماهانه", "Monthly plan")}</th>
                          <th>{t("هزینهٔ ثبت‌شده", "Recorded expense")}</th>
                          <th>{t("بازگشت وجه", "Refund")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.data.by_category.map((item) => (
                          <tr key={item.category_id ?? "uncategorized"}>
                            <td>{item.title}</td>
                            <td>
                              <Money cents={item.planned_cents} />
                            </td>
                            <td>
                              <Money cents={item.expense_cents} />
                            </td>
                            <td>
                              <Money cents={item.refund_cents} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
              <section className="panel">
                <SectionHeading
                  title={t(
                    "حساب‌ها و ثبت‌های آن‌ها",
                    "Accounts and recorded activity",
                  )}
                  subtitle={t(
                    "بدون ماندهٔ آغازین و تاریخ آن، ماندهٔ حساب نامشخص می‌ماند.",
                    "Balances remain unknown without a dated opening balance.",
                  )}
                />
                {!summary.data.by_account.length ? (
                  <p className="muted small">
                    {t(
                      "حساب یا پرداختی ثبت نشده است.",
                      "No accounts or payments recorded yet.",
                    )}
                  </p>
                ) : (
                  <div className="data-table-wrap">
                    <table className="finance-table">
                      <thead>
                        <tr>
                          <th>{t("حساب", "Account")}</th>
                          <th>{t("هزینهٔ ثبت‌شده", "Recorded expense")}</th>
                          <th>{t("درآمد ثبت‌شده", "Recorded income")}</th>
                          <th>
                            {t("مانده بر اساس ثبت‌ها", "Balance from records")}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {summary.data.by_account.map((item) => (
                          <tr key={item.account_id ?? "unknown"}>
                            <td>{item.title}</td>
                            <td>
                              <Money
                                cents={item.expense_cents - item.refund_cents}
                              />
                            </td>
                            <td>
                              <Money cents={item.income_cents} />
                            </td>
                            <td>
                              <Money cents={item.balance_cents} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
      )}
      {tab === "plans" && (
        <section
          role="tabpanel"
          id="finance-plans"
          aria-labelledby="finance-tab-plans"
          className="panel finance-record-panel"
        >
          <SectionHeading
            title={t(
              "هزینه‌ها، بودجه‌ها و کنارگذاری‌ها",
              "Costs, budgets and reserves",
            )}
            subtitle={t(
              "ویرایش مبلغ از ماه انتخاب‌شده اعمال می‌شود؛ پرداخت‌های قبلی جدا حفظ می‌شوند.",
              "Amount edits take effect from the selected month; prior payments stay separate.",
            )}
            action={
              <Button
                variant="primary"
                onClick={() => setEditor({ kind: "plan" })}
              >
                <Plus size={15} />
                {t("برنامهٔ تازه", "New plan")}
              </Button>
            }
          />
          <div className="filter-bar finance-filters">
            <label className="search-box">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t(
                  "جست‌وجوی عنوان و توضیح",
                  "Search title and notes",
                )}
                aria-label={t("جست‌وجوی برنامه‌ها", "Search plans")}
              />
            </label>
            <select
              aria-label={t("نوع برنامه", "Plan kind")}
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as FinancePlanKind | "")
              }
            >
              <option value="">{t("همهٔ انواع", "All kinds")}</option>
              {Object.entries(labels.plan).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label={t("وضعیت برنامه", "Plan state")}
              value={planState}
              onChange={(event) =>
                setPlanState(event.target.value as FinancePlanState | "")
              }
            >
              <option value="">{t("همهٔ وضعیت‌ها", "All states")}</option>
              {Object.entries(labels.state).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            {referenceFilters()}
            <label className="check-label">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              {t("بایگانی‌شده‌ها", "Archived")}
            </label>
          </div>
          <QueryState {...shownPlansQuery} retry={shownPlansQuery.refresh} />
          {!shownPlansQuery.loading &&
            !shownPlansQuery.error &&
            !shownPlans.length && (
              <Empty
                title={t("برنامه‌ای در این نما نیست", "No plans in this view")}
                detail={t(
                  "یک برنامه بساز یا فیلترها را تغییر بده.",
                  "Create a plan or change the filters.",
                )}
              />
            )}
          <div className="finance-records">
            {shownPlans.map((item) => (
              <article className="finance-record" key={item.plan_id}>
                <div className="finance-record-copy">
                  <div className="finance-record-title">
                    <h3>{item.title}</h3>
                    <KindPill>{labels.plan[item.kind]}</KindPill>
                    <KindPill tone={item.state === "active" ? "" : "muted"}>
                      {labels.state[item.state]}
                    </KindPill>
                    {!item.included && (
                      <KindPill>{t("خارج از جمع", "Excluded")}</KindPill>
                    )}
                    {!item.applicable && (
                      <KindPill tone="warning">
                        {t(
                          "در این ماه هنوز اثر ندارد",
                          "Not effective this month",
                        )}
                      </KindPill>
                    )}
                  </div>
                  <p>
                    {categoryName(item.category_id)} ·{" "}
                    {accountName(item.account_id)} · {cadence(item, labels, t)}
                  </p>
                  <small>
                    {labels.basis[item.amount_basis]} ·{" "}
                    {t("اثر از ماه", "Effective from")} {item.effective_month}
                  </small>
                  {item.notes && <p className="finance-notes">{item.notes}</p>}
                  {item.source_label && (
                    <small>
                      {t("مبنا:", "Source:")} {item.source_label}
                    </small>
                  )}
                </div>
                <div className="finance-record-amount">
                  <strong>
                    <Money cents={item.amount_cents} />
                  </strong>
                  <small>
                    {t("مبلغ هر دوره / مورد", "Per interval / item")}
                  </small>
                  {item.monthly_equivalent_cents !== null ? (
                    <small>
                      <Money cents={item.monthly_equivalent_cents} />{" "}
                      {t("معادل ماهانه", "monthly equivalent")}
                    </small>
                  ) : item.kind === "recurring" ||
                    item.kind === "budget" ||
                    item.kind === "reserve" ? (
                    <small>
                      {t("معادل ماهانه نامشخص", "Monthly equivalent unknown")}
                    </small>
                  ) : null}
                </div>
                <div className="finance-record-actions">
                  {!item.archived_at && (
                    <>
                      <Button
                        onClick={() =>
                          setEditor({ kind: "plan", entity: item })
                        }
                      >
                        <Pencil size={14} />
                        {t("ویرایش", "Edit")}
                      </Button>
                      <Button
                        onClick={() => recordPlan(item)}
                        disabled={
                          !item.applicable ||
                          item.kind === "budget" ||
                          item.kind === "reserve"
                        }
                      >
                        {t("ثبت پرداخت", "Record payment")}
                      </Button>
                    </>
                  )}
                  <Button
                    onClick={() => void changeArchived("plan", item)}
                    disabled={pending === item.plan_id}
                  >
                    {item.archived_at ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Archive size={14} />
                    )}
                    {item.archived_at
                      ? t("بازگردانی", "Restore")
                      : t("بایگانی", "Archive")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {tab === "payments" && (
        <section
          role="tabpanel"
          id="finance-payments"
          aria-labelledby="finance-tab-payments"
          className="panel finance-record-panel"
        >
          <SectionHeading
            title={t(
              "پرداخت‌ها و دریافت‌های ثبت‌شده",
              "Registered payments and income",
            )}
            subtitle={t(
              "فقط مبالغی را که واقعاً پرداخت یا دریافت شده‌اند ثبت کن.",
              "Record amounts that were actually paid or received.",
            )}
            action={
              <Button
                variant="primary"
                onClick={() => setEditor({ kind: "transaction" })}
              >
                <Plus size={15} />
                {t("ثبت تازه", "New record")}
              </Button>
            }
          />
          <div className="filter-bar finance-filters">
            <label className="search-box">
              <Search size={15} />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                aria-label={t("جست‌وجوی پرداخت‌ها", "Search payments")}
                placeholder={t(
                  "جست‌وجوی عنوان و توضیح",
                  "Search title and notes",
                )}
              />
            </label>
            <select
              aria-label={t("نوع پرداخت", "Payment kind")}
              value={paymentKind}
              onChange={(event) =>
                setPaymentKind(
                  event.target.value as FinanceTransactionKind | "",
                )
              }
            >
              <option value="">{t("همهٔ انواع", "All kinds")}</option>
              {Object.entries(labels.transaction).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            {referenceFilters()}
            <label className="check-label">
              <input
                type="checkbox"
                checked={archived}
                onChange={(event) => setArchived(event.target.checked)}
              />
              {t("بایگانی‌شده‌ها", "Archived")}
            </label>
          </div>
          <QueryState {...transactions} retry={transactions.refresh} />
          {!transactions.loading &&
            !transactions.error &&
            !shownTransactions.length && (
              <Empty
                title={t(
                  "پرداختی در این نما ثبت نشده است",
                  "No payments recorded in this view",
                )}
                detail={t(
                  "نبود ثبت به معنی صفر بودن هزینهٔ واقعی این ماه نیست.",
                  "No entries does not mean this month's actual spending was zero.",
                )}
              />
            )}
          <div className="finance-records">
            {shownTransactions.map((item) => (
              <article className="finance-record" key={item.transaction_id}>
                <div className="finance-record-copy">
                  <div className="finance-record-title">
                    {item.kind === "transfer" ? (
                      <ArrowLeftRight size={17} />
                    ) : item.kind === "expense" ? (
                      <ArrowUpRight size={17} />
                    ) : (
                      <ArrowDownLeft size={17} />
                    )}
                    <h3>{item.title}</h3>
                    <KindPill>{labels.transaction[item.kind]}</KindPill>
                  </div>
                  <p>
                    <time dateTime={item.date} dir="ltr">
                      {item.date}
                    </time>{" "}
                    · {accountName(item.account_id)}
                    {item.transfer_account_id
                      ? t(
                          ` به ${accountName(item.transfer_account_id)}`,
                          ` to ${accountName(item.transfer_account_id)}`,
                        )
                      : ""}{" "}
                    · {categoryName(item.category_id)}
                  </p>
                  {item.notes && <p className="finance-notes">{item.notes}</p>}
                  {item.source_label && (
                    <small>
                      {t("مبنا:", "Source:")} {item.source_label}
                    </small>
                  )}
                </div>
                <div className="finance-record-amount">
                  <strong>
                    <Money cents={item.amount_cents} />
                  </strong>
                </div>
                <div className="finance-record-actions">
                  {!item.archived_at && (
                    <Button
                      onClick={() =>
                        setEditor({ kind: "transaction", entity: item })
                      }
                    >
                      <Pencil size={14} />
                      {t("ویرایش", "Edit")}
                    </Button>
                  )}
                  <Button
                    disabled={pending === item.transaction_id}
                    onClick={() => void changeArchived("transaction", item)}
                  >
                    {item.archived_at ? (
                      <RotateCcw size={14} />
                    ) : (
                      <Archive size={14} />
                    )}
                    {item.archived_at
                      ? t("بازگردانی", "Restore")
                      : t("بایگانی", "Archive")}
                  </Button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
      {editor && (
        <FinanceEditor
          key={`${editor.kind}-${entityId(editor) ?? "create"}`}
          editor={editor}
          month={month}
          accounts={accounts.data?.items ?? []}
          categories={categories.data?.items ?? []}
          plans={plans.data?.items ?? []}
          action={action}
          close={() => setEditor(null)}
        />
      )}
      <Modal
        title={
          manager === "account"
            ? t("مدیریت حساب‌ها", "Manage accounts")
            : t("مدیریت دسته‌ها", "Manage categories")
        }
        open={manager !== null}
        onOpenChange={(open) => {
          if (!open) setManager(null);
        }}
      >
        <div className="form-actions">
          <Button
            variant="primary"
            onClick={() => {
              if (manager) setEditor({ kind: manager });
              setManager(null);
            }}
          >
            <Plus size={15} />
            {manager === "account"
              ? t("حساب تازه", "New account")
              : t("دستهٔ تازه", "New category")}
          </Button>
          <label className="check-label">
            <input
              type="checkbox"
              checked={managerArchived}
              onChange={(event) => setManagerArchived(event.target.checked)}
            />
            {t("بایگانی‌شده‌ها", "Archived")}
          </label>
        </div>
        {manager === "account" ? (
          <>
            <QueryState
              {...(managerArchived ? archivedAccounts : accounts)}
              retry={(managerArchived ? archivedAccounts : accounts).refresh}
            />
            <div className="finance-manager-list">
              {(managerArchived ? archivedAccounts : accounts).data?.items.map(
                (item) => (
                  <article key={item.account_id}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>
                        {item.opening_balance_cents === null ? (
                          t("ماندهٔ آغازین نامشخص", "Opening balance unknown")
                        ) : (
                          <>
                            <Money cents={item.opening_balance_cents} /> ·{" "}
                            {item.opening_balance_date}
                          </>
                        )}
                      </small>
                    </div>
                    <div className="form-actions">
                      {!item.archived_at && (
                        <Button
                          onClick={() => {
                            setManager(null);
                            setEditor({ kind: "account", entity: item });
                          }}
                        >
                          {t("ویرایش", "Edit")}
                        </Button>
                      )}
                      <Button
                        disabled={pending === item.account_id}
                        onClick={() => void changeArchived("account", item)}
                      >
                        {item.archived_at
                          ? t("بازگردانی", "Restore")
                          : t("بایگانی", "Archive")}
                      </Button>
                    </div>
                  </article>
                ),
              )}
            </div>
          </>
        ) : (
          <>
            <QueryState
              {...(managerArchived ? archivedCategories : categories)}
              retry={
                (managerArchived ? archivedCategories : categories).refresh
              }
            />
            <div className="finance-manager-list">
              {(managerArchived
                ? archivedCategories
                : categories
              ).data?.items.map((item) => (
                <article key={item.category_id}>
                  <strong>{item.title}</strong>
                  <div className="form-actions">
                    {!item.archived_at && (
                      <Button
                        onClick={() => {
                          setManager(null);
                          setEditor({ kind: "category", entity: item });
                        }}
                      >
                        {t("ویرایش", "Edit")}
                      </Button>
                    )}
                    <Button
                      disabled={pending === item.category_id}
                      onClick={() => void changeArchived("category", item)}
                    >
                      {item.archived_at
                        ? t("بازگردانی", "Restore")
                        : t("بایگانی", "Archive")}
                    </Button>
                  </div>
                </article>
              ))}
            </div>
          </>
        )}
      </Modal>
      <FinanceTransfer
        open={transferOpen}
        setOpen={setTransferOpen}
        action={action}
      />
    </div>
  );
}

type FormState = {
  title: string;
  amount: string;
  amountBasis: FinanceAmountBasis;
  planKind: FinancePlanKind;
  state: FinancePlanState;
  included: boolean;
  interval: string;
  accountId: string;
  categoryId: string;
  duePrecision: FinanceDuePrecision;
  dueDay: string;
  dueOn: string;
  nextDueOn: string;
  target: string;
  horizon: string;
  notes: string;
  source: string;
  effectiveMonth: string;
  transactionKind: FinanceTransactionKind;
  date: string;
  transferAccountId: string;
  planId: string;
  openingBalance: string;
  openingDate: string;
};

function initialForm(editor: Editor, month: string): FormState {
  const entity = editor.entity;
  const plan =
    editor.kind === "plan"
      ? editor.entity
      : editor.kind === "transaction"
        ? editor.plan
        : undefined;
  const transaction = editor.kind === "transaction" ? editor.entity : undefined;
  const account = editor.kind === "account" ? editor.entity : undefined;
  return {
    title: entity?.title ?? plan?.title ?? "",
    amount: euroInput(transaction?.amount_cents ?? plan?.amount_cents),
    amountBasis: plan?.amount_basis ?? "reported",
    planKind: plan?.kind ?? "recurring",
    state: plan?.state ?? "active",
    included: plan?.included ?? true,
    interval: plan
      ? plan.interval_months === null
        ? ""
        : String(plan.interval_months)
      : "1",
    accountId: transaction?.account_id ?? plan?.account_id ?? "",
    categoryId: transaction?.category_id ?? plan?.category_id ?? "",
    duePrecision: plan?.due_precision ?? "unknown",
    dueDay: plan?.due_day ? String(plan.due_day) : "",
    dueOn: plan?.due_on ?? "",
    nextDueOn: plan?.next_due_on ?? "",
    target: euroInput(plan?.target_cents),
    horizon: plan?.horizon_months ? String(plan.horizon_months) : "",
    notes: (entity && "notes" in entity ? entity.notes : "") ?? "",
    source:
      (entity && "source_label" in entity ? entity.source_label : "") ?? "",
    effectiveMonth: month,
    transactionKind: transaction?.kind ?? "expense",
    date: transaction?.date ?? financeToday(),
    transferAccountId: transaction?.transfer_account_id ?? "",
    planId: transaction?.plan_id ?? plan?.plan_id ?? "",
    openingBalance: euroInput(account?.opening_balance_cents),
    openingDate: account?.opening_balance_date ?? "",
  };
}

function FinanceEditor({
  editor,
  month,
  accounts,
  categories,
  plans,
  action,
  close,
}: {
  editor: Editor;
  month: string;
  accounts: FinanceAccountDTO[];
  categories: FinanceCategoryDTO[];
  plans: FinancePlanDTO[];
  action: Action;
  close: () => void;
}) {
  const { t } = useLocale();
  const labels = useFinanceLabels();
  const [form, setForm] = useState(() => initialForm(editor, month));
  const [revision, setRevision] = useState(editor.entity?.revision ?? 0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const [latest, setLatest] = useState<Entity | null>(null);
  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const integer = (value: string) => {
    if (!value.trim()) return null;
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(
        t("عدد صحیح معتبر وارد کن.", "Enter a valid whole number."),
      );
    return Number(value);
  };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    try {
      const title = form.title.trim();
      if (!title) throw new Error(t("عنوان لازم است.", "A title is required."));
      let input: Record<string, unknown> = { title };
      if (editor.kind === "plan") {
        input = {
          ...input,
          kind: form.planKind,
          amount_cents:
            form.amountBasis === "unknown" ? null : parseEuroCents(form.amount),
          amount_basis: form.amountBasis,
          interval_months:
            form.planKind === "one_off" || form.planKind === "liability"
              ? null
              : form.planKind === "budget" || form.planKind === "reserve"
                ? 1
                : integer(form.interval),
          state: form.state,
          included: form.included,
          account_id: form.accountId || null,
          category_id: form.categoryId || null,
          due_precision: form.duePrecision,
          due_day:
            form.duePrecision === "unknown" ? null : integer(form.dueDay),
          due_on: form.dueOn || null,
          next_due_on: form.nextDueOn || null,
          target_cents:
            form.planKind === "reserve"
              ? parseEuroCents(form.target, { nullable: true })
              : null,
          horizon_months:
            form.planKind === "reserve" ? integer(form.horizon) : null,
          notes: form.notes.trim(),
          source_label: form.source.trim(),
          effective_month: form.effectiveMonth,
        };
      } else if (editor.kind === "transaction") {
        const amount = parseEuroCents(form.amount);
        if (amount === null || amount <= 0)
          throw new Error(
            t(
              "مبلغ پرداخت باید بیشتر از صفر باشد.",
              "Payment amount must be greater than zero.",
            ),
          );
        if (
          form.transactionKind === "transfer" &&
          (!form.accountId ||
            !form.transferAccountId ||
            form.accountId === form.transferAccountId)
        )
          throw new Error(
            t(
              "برای انتقال، دو حساب متفاوت انتخاب کن.",
              "Choose two different accounts for a transfer.",
            ),
          );
        input = {
          ...input,
          kind: form.transactionKind,
          amount_cents: amount,
          date: form.date,
          account_id: form.accountId || null,
          transfer_account_id:
            form.transactionKind === "transfer"
              ? form.transferAccountId || null
              : null,
          category_id:
            form.transactionKind === "transfer"
              ? null
              : form.categoryId || null,
          plan_id:
            form.transactionKind === "transfer" ? null : form.planId || null,
          notes: form.notes.trim(),
          source_label: form.source.trim(),
        };
      } else if (editor.kind === "account") {
        const opening = parseEuroCents(form.openingBalance, {
          nullable: true,
          signed: true,
        });
        if ((opening === null) !== !form.openingDate)
          throw new Error(
            t(
              "ماندهٔ آغازین و تاریخ آن را با هم وارد کن، یا هر دو را خالی بگذار.",
              "Enter opening balance and its date together, or leave both blank.",
            ),
          );
        input = {
          ...input,
          opening_balance_cents: opening,
          opening_balance_date: form.openingDate || null,
        };
      }
      const id = entityId(editor);
      if (id) input[`${editor.kind}_id`] = id;
      if (editor.entity) {
        input = financeEditInput(
          input,
          editor.entity as unknown as Record<string, unknown>,
          [
            `${editor.kind}_id`,
            ...(editor.kind === "plan" ? ["effective_month"] : []),
          ],
        );
      }
      const result = await action(
        `finance_${editor.kind}_${id ? "update" : "create"}` as CommandName,
        input,
        revision,
      );
      if (!result)
        throw new Error(
          t(
            "ذخیره تأیید نشد؛ پیش‌نویس فرم حفظ شده است.",
            "Save was not confirmed; your form draft is preserved.",
          ),
        );
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setUnconfirmed(
        cause instanceof ApiError && cause.code === "WRITE_UNCONFIRMED",
      );
      if (cause instanceof ApiError && cause.code === "REVISION_CONFLICT") {
        try {
          setLatest(
            await latestEntity(
              editor,
              editor.kind === "plan" ? form.effectiveMonth : month,
            ),
          );
        } catch {
          /* Keep the user's draft even if the latest read fails. */
        }
      }
    } finally {
      setBusy(false);
    }
  }
  const title =
    editor.kind === "plan"
      ? t("برنامهٔ هزینه یا بودجه", "Cost or budget plan")
      : editor.kind === "transaction"
        ? t("ثبت پرداخت یا دریافت", "Payment or income record")
        : editor.kind === "account"
          ? t("حساب پرداخت", "Payment account")
          : t("دسته‌بندی", "Category");
  const accountSelect = (
    key: "accountId" | "transferAccountId",
    label: string,
  ) => (
    <Field label={label}>
      <select
        value={form[key]}
        onChange={(event) => update(key, event.target.value)}
      >
        <option value="">
          {t("نامشخص / انتخاب نشده", "Unknown / not selected")}
        </option>
        {form[key] &&
          !accounts.some((item) => item.account_id === form[key]) && (
            <option value={form[key]}>
              {t(
                "حساب قبلیِ بایگانی‌شده",
                "Previously selected archived account",
              )}
            </option>
          )}
        {accounts.map((item) => (
          <option key={item.account_id} value={item.account_id}>
            {item.title}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <Modal
      title={title}
      open
      onOpenChange={(open) => {
        if (!open && !busy && !unconfirmed) close();
      }}
      wide={editor.kind === "plan"}
    >
      <form
        className="form-grid finance-form"
        onSubmit={(event) => void save(event)}
      >
        <fieldset className="finance-fields" disabled={busy || unconfirmed}>
          <Field label={t("عنوان", "Title")}>
            <input
              name="title"
              required
              maxLength={200}
              value={form.title}
              onChange={(event) => update("title", event.target.value)}
              autoFocus
            />
          </Field>
          {editor.kind === "plan" && (
            <>
              <div className="form-columns">
                <Field label={t("نوع برنامه", "Plan kind")}>
                  <select
                    value={form.planKind}
                    disabled={!!editor.entity}
                    onChange={(event) => {
                      const value = event.target.value as FinancePlanKind;
                      setForm((current) => ({
                        ...current,
                        planKind: value,
                        interval:
                          value === "recurring"
                            ? current.planKind === "recurring"
                              ? current.interval
                              : "1"
                            : value === "budget" || value === "reserve"
                              ? "1"
                              : "",
                      }));
                    }}
                  >
                    {Object.entries(labels.plan).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("اثر ویرایش از ماه", "Edit effective from month")}
                >
                  <input
                    type="month"
                    required
                    value={form.effectiveMonth}
                    onChange={(event) =>
                      update("effectiveMonth", event.target.value)
                    }
                  />
                </Field>
                <Field label={t("وضعیت", "State")}>
                  <select
                    value={form.state}
                    onChange={(event) =>
                      update("state", event.target.value as FinancePlanState)
                    }
                  >
                    {Object.entries(labels.state).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="form-columns">
                <Field
                  label={t(
                    "مبلغ کامل هر دوره یا مورد (€)",
                    "Full bill / item amount (€)",
                  )}
                >
                  <input
                    inputMode="decimal"
                    disabled={form.amountBasis === "unknown"}
                    value={form.amount}
                    onChange={(event) => update("amount", event.target.value)}
                    placeholder={
                      form.amountBasis === "unknown"
                        ? t("نامشخص", "Unknown")
                        : "0.00"
                    }
                  />
                </Field>
                <Field label={t("مبنای مبلغ", "Amount basis")}>
                  <select
                    value={form.amountBasis}
                    onChange={(event) =>
                      update(
                        "amountBasis",
                        event.target.value as FinanceAmountBasis,
                      )
                    }
                  >
                    {Object.entries(labels.basis).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("دورهٔ پرداخت", "Payment interval")}>
                  <select
                    disabled={form.planKind !== "recurring"}
                    value={form.interval}
                    onChange={(event) => update("interval", event.target.value)}
                  >
                    <option value="">
                      {t("نامشخص / بدون دوره", "Unknown / no interval")}
                    </option>
                    {Array.from({ length: 12 }, (_, index) => index + 1).map(
                      (value) => (
                        <option key={value} value={value}>
                          {value === 1
                            ? t("هر ماه", "Monthly")
                            : t(`هر ${value} ماه`, `Every ${value} months`)}
                        </option>
                      ),
                    )}
                  </select>
                </Field>
              </div>
              <p className="muted small">
                {t(
                  "مبلغ قبض چندماهه را کامل وارد کن. معادل ماهانه جدا محاسبه می‌شود؛ بودجه و کنارگذاری پرداخت واقعی نیستند.",
                  "Enter the full multi-month bill. Its monthly equivalent is separate; budgets and reserves are not actual payments.",
                )}
              </p>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={form.included}
                  onChange={(event) => update("included", event.target.checked)}
                />
                {t(
                  "در جمع برنامه‌ریزی‌شده حساب شود",
                  "Include in planned totals",
                )}
              </label>
            </>
          )}
          {editor.kind === "transaction" && (
            <>
              <div className="form-columns">
                <Field label={t("نوع ثبت", "Record kind")}>
                  <select
                    value={form.transactionKind}
                    onChange={(event) =>
                      update(
                        "transactionKind",
                        event.target.value as FinanceTransactionKind,
                      )
                    }
                  >
                    {Object.entries(labels.transaction).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t(
                    "تاریخ واقعی پرداخت یا دریافت",
                    "Actual payment / receipt date",
                  )}
                >
                  <input
                    type="date"
                    required
                    value={form.date}
                    onChange={(event) => update("date", event.target.value)}
                  />
                </Field>
                <Field label={t("مبلغ واقعی (€)", "Actual amount (€)")}>
                  <input
                    inputMode="decimal"
                    required
                    value={form.amount}
                    onChange={(event) => update("amount", event.target.value)}
                  />
                </Field>
              </div>
              {editor.plan && (
                <p className="finance-notice">
                  {t(
                    "عنوان و مبلغ از برنامه پیشنهاد شده‌اند؛ تاریخ و مبلغ واقعی پرداخت را بررسی کن. برنامه خودکار پرداخت‌شده محسوب نمی‌شود.",
                    "Title and amount were suggested from the plan. Check the actual date and amount; plans are not marked paid automatically.",
                  )}
                </p>
              )}
            </>
          )}
          {(editor.kind === "plan" || editor.kind === "transaction") && (
            <>
              <div className="form-columns">
                {accountSelect(
                  "accountId",
                  form.transactionKind === "transfer" &&
                    editor.kind === "transaction"
                    ? t("حساب مبدأ", "Source account")
                    : t("حساب پرداخت", "Payment account"),
                )}
                {editor.kind === "transaction" &&
                form.transactionKind === "transfer" ? (
                  accountSelect(
                    "transferAccountId",
                    t("حساب مقصد", "Destination account"),
                  )
                ) : (
                  <Field label={t("دسته‌بندی", "Category")}>
                    <select
                      value={form.categoryId}
                      onChange={(event) =>
                        update("categoryId", event.target.value)
                      }
                    >
                      <option value="">
                        {t("بدون دسته", "Uncategorized")}
                      </option>
                      {form.categoryId &&
                        !categories.some(
                          (item) => item.category_id === form.categoryId,
                        ) && (
                          <option value={form.categoryId}>
                            {t(
                              "دستهٔ قبلیِ بایگانی‌شده",
                              "Previously selected archived category",
                            )}
                          </option>
                        )}
                      {categories.map((item) => (
                        <option key={item.category_id} value={item.category_id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
              </div>
              {editor.kind === "transaction" &&
                form.transactionKind !== "transfer" && (
                  <Field
                    label={t(
                      "برنامهٔ مرتبط؛ اختیاری",
                      "Related plan; optional",
                    )}
                  >
                    <select
                      value={form.planId}
                      onChange={(event) => update("planId", event.target.value)}
                    >
                      <option value="">
                        {t("بدون ارتباط", "No linked plan")}
                      </option>
                      {form.planId &&
                        !plans.some((item) => item.plan_id === form.planId) && (
                          <option value={form.planId}>
                            {t(
                              "برنامهٔ قبلیِ بایگانی‌شده",
                              "Previously selected archived plan",
                            )}
                          </option>
                        )}
                      {plans.map((item) => (
                        <option key={item.plan_id} value={item.plan_id}>
                          {item.title}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
            </>
          )}
          {editor.kind === "plan" && (
            <>
              <div className="form-columns">
                <Field label={t("دقت زمان پرداخت", "Payment timing precision")}>
                  <select
                    value={form.duePrecision}
                    onChange={(event) => {
                      const value = event.target.value as FinanceDuePrecision;
                      setForm((current) => ({
                        ...current,
                        duePrecision: value,
                        ...(value === "unknown"
                          ? { dueDay: "", dueOn: "", nextDueOn: "" }
                          : value === "approximate"
                            ? { dueOn: "", nextDueOn: "" }
                            : {}),
                      }));
                    }}
                  >
                    {Object.entries(labels.precision).map(([key, value]) => (
                      <option key={key} value={key}>
                        {value}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t(
                    "روز معمول ماه؛ اگر معلوم است",
                    "Usual day of month, if known",
                  )}
                >
                  <input
                    type="number"
                    min="1"
                    max="31"
                    step="1"
                    disabled={form.duePrecision === "unknown"}
                    value={form.dueDay}
                    onChange={(event) => update("dueDay", event.target.value)}
                  />
                </Field>
                <Field
                  label={t(
                    "تاریخ مشخص این مطالبه؛ اختیاری",
                    "Specific due date; optional",
                  )}
                >
                  <input
                    type="date"
                    disabled={form.duePrecision !== "exact"}
                    value={form.dueOn}
                    onChange={(event) => update("dueOn", event.target.value)}
                  />
                </Field>
                <Field
                  label={t(
                    "پرداخت بعدیِ شناخته‌شده؛ اختیاری",
                    "Known next payment date; optional",
                  )}
                >
                  <input
                    type="date"
                    disabled={form.duePrecision !== "exact"}
                    value={form.nextDueOn}
                    onChange={(event) =>
                      update("nextDueOn", event.target.value)
                    }
                  />
                </Field>
              </div>
              {form.planKind === "reserve" && (
                <div className="form-columns">
                  <Field
                    label={t(
                      "مبلغ هدف یا آخرین مبلغ مرجع (€)",
                      "Target / last-known benchmark (€)",
                    )}
                  >
                    <input
                      inputMode="decimal"
                      value={form.target}
                      onChange={(event) => update("target", event.target.value)}
                    />
                  </Field>
                  <Field
                    label={t(
                      "تعداد ماه برای مقایسه با هدف",
                      "Months for target comparison",
                    )}
                  >
                    <input
                      type="number"
                      min="1"
                      max="120"
                      step="1"
                      value={form.horizon}
                      onChange={(event) =>
                        update("horizon", event.target.value)
                      }
                    />
                  </Field>
                </div>
              )}
            </>
          )}
          {editor.kind === "account" && (
            <>
              <div className="form-columns">
                <Field
                  label={t(
                    "ماندهٔ آغازین (€)؛ خالی = نامشخص",
                    "Opening balance (€); blank = unknown",
                  )}
                >
                  <input
                    inputMode="decimal"
                    value={form.openingBalance}
                    onChange={(event) =>
                      update("openingBalance", event.target.value)
                    }
                  />
                </Field>
                <Field label={t("تاریخ ماندهٔ آغازین", "Opening balance date")}>
                  <input
                    type="date"
                    value={form.openingDate}
                    onChange={(event) =>
                      update("openingDate", event.target.value)
                    }
                  />
                </Field>
              </div>
              <p className="muted small">
                {t(
                  "موجودی بانک را حدس نزن. بدون هر دو ورودی، مانده‌ای محاسبه نمی‌شود.",
                  "Do not guess a bank balance. A balance requires both inputs.",
                )}
              </p>
            </>
          )}
          {(editor.kind === "plan" || editor.kind === "transaction") && (
            <>
              <Field label={t("توضیحات", "Notes")}>
                <textarea
                  rows={3}
                  value={form.notes}
                  onChange={(event) => update("notes", event.target.value)}
                />
              </Field>
              <Field
                label={t("مبنای اطلاعات؛ اختیاری", "Source label; optional")}
              >
                <input
                  value={form.source}
                  onChange={(event) => update("source", event.target.value)}
                  placeholder={t(
                    "مثلاً قرارداد، گفتهٔ خودم، قبض یا سابقهٔ پرداخت",
                    "For example: contract, own report, bill or payment record",
                  )}
                />
              </Field>
            </>
          )}
        </fieldset>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {latest && (
          <section className="finance-conflict">
            <strong>
              {t(
                "نسخهٔ تازه‌ای وجود دارد؛ پیش‌نویس تو حفظ شده است.",
                "A newer version exists; your draft is preserved.",
              )}
            </strong>
            <p>
              {t("عنوان نسخهٔ تازه:", "Latest title:")} {latest.title}
            </p>
            {"amount_cents" in latest && (
              <p>
                {t("مبلغ نسخهٔ تازه:", "Latest amount:")}{" "}
                <Money cents={latest.amount_cents} />
              </p>
            )}
            {"notes" in latest && latest.notes && (
              <p className="finance-notes">{latest.notes}</p>
            )}
            <Button
              type="button"
              disabled={!!latest.archived_at}
              onClick={() => {
                setRevision(latest.revision);
                setLatest(null);
                setError("");
              }}
            >
              {t(
                "تفاوت‌ها را دیدم؛ فقط تغییرهای من را روی نسخهٔ تازه اعمال کن",
                "I reviewed the differences; apply only my changes to the new version",
              )}
            </Button>
          </section>
        )}
        <div className="form-actions">
          <Button type="submit" variant="primary" disabled={busy || !!latest}>
            {busy
              ? t("در حال ذخیره…", "Saving…")
              : unconfirmed
                ? t("بررسی نتیجهٔ همین ذخیره", "Check this save result")
                : t("ذخیره", "Save")}
          </Button>
          <Button type="button" onClick={close} disabled={busy || unconfirmed}>
            {t("انصراف", "Cancel")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function FinanceTransfer({
  open,
  setOpen,
  action,
}: {
  open: boolean;
  setOpen: (value: boolean) => void;
  action: Action;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [data, setData] = useState<FinanceImportDTO | null>(null);
  const [preview, setPreview] = useState<FinanceImportPreviewDTO | null>(null);
  async function exportAll() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await query<FinanceImportDTO>("finance_export");
      downloadJson(result, `life-os-finance-all-${financeToday()}.json`);
      setMessage(
        t(
          "همهٔ حساب‌ها، دسته‌ها، نسخه‌های برنامه‌ها و پرداخت‌ها صادر شدند.",
          "Exported all accounts, categories, plan versions and payments.",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function inspectImport(next: FinanceImportDTO) {
    setBusy(true);
    setError("");
    setPreview(null);
    setMessage("");
    try {
      setPreview(
        await query<FinanceImportPreviewDTO>("finance_import_preview", {
          data: next,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function fileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setPreview(null);
    setData(null);
    try {
      if (file.size > FINANCE_JSON_MAX_BYTES)
        throw new Error(
          t("حداکثر حجم فایل JSON دو مگابایت است.", "The JSON limit is 2 MB."),
        );
      const value: unknown = JSON.parse(await file.text());
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        !("format" in value) ||
        value.format !== "ramin-life-os/finance/1"
      )
        throw new Error(
          t(
            "فایل باید خروجی مالی Life OS با قالب نسخهٔ ۱ باشد.",
            "Use a Life OS finance version 1 export.",
          ),
        );
      const next = value as FinanceImportDTO;
      setData(next);
      await inspectImport(next);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  async function commit() {
    if (!preview?.can_commit || busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await action(
        "finance_import_commit",
        { preview_id: preview.preview_id },
        0,
      );
      if (!result)
        throw new Error(
          t(
            "نتیجهٔ واردسازی تأیید نشد؛ همین عملیات را دوباره بررسی کن.",
            "Import was not confirmed; check this same operation again.",
          ),
        );
      setPreview(null);
      setData(null);
      setMessage(
        t(
          "واردسازی ذخیره شد؛ نماهای مالی به‌روز شدند.",
          "Import saved; finance views refreshed.",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t("ورود و خروج داده‌های مالی", "Finance import / export")}
      open={open}
      onOpenChange={(value) => {
        if (!busy) setOpen(value);
      }}
    >
      <p className="muted small">
        {t(
          "خروجی شامل تاریخچه و نسخه‌های برنامه‌هاست و تا ۱۰۰۰ مورد / دو مگابایت مستقیماً قابل ورود است. اگر حجم بیشتر بود، از خروجی کامل پشتیبان در تنظیمات استفاده کن. فایل مالی را خصوصی نگه دار.",
          "Exports include history and plan versions, with direct import up to 1,000 records / 2 MB. For larger data, use the full backup export in Settings. Keep financial files private.",
        )}
      </p>
      <p className="small">
        <Link href="/settings" className="text-link">
          {t("تنظیمات و پشتیبان کامل حساب", "Settings and full account backup")}
        </Link>
      </p>
      <div className="form-actions">
        <Button disabled={busy} onClick={() => void exportAll()}>
          <Download size={15} />
          {t("خروجی کامل JSON", "Export all JSON")}
        </Button>
        <label className={`button ${busy ? "disabled" : ""}`}>
          <Upload size={15} />
          {t("انتخاب JSON برای پیش‌نمایش", "Choose JSON to preview")}
          <input
            hidden
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(event) => void fileChange(event)}
          />
        </label>
      </div>
      {busy && (
        <p role="status">
          {t("در حال بررسی یا ذخیره…", "Checking or saving…")}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {preview && (
        <div className="finance-import-preview">
          <h3>{t("پیش‌نمایش واردسازی", "Import preview")}</h3>
          <dl className="finance-totals">
            <div>
              <dt>{t("حساب‌ها", "Accounts")}</dt>
              <dd>{preview.counts.accounts}</dd>
            </div>
            <div>
              <dt>{t("دسته‌ها", "Categories")}</dt>
              <dd>{preview.counts.categories}</dd>
            </div>
            <div>
              <dt>{t("برنامه‌ها", "Plans")}</dt>
              <dd>{preview.counts.plans}</dd>
            </div>
            <div>
              <dt>{t("پرداخت‌ها", "Payments")}</dt>
              <dd>{preview.counts.transactions}</dd>
            </div>
            <div>
              <dt>{t("بدون تغییر", "Unchanged")}</dt>
              <dd>{preview.counts.unchanged}</dd>
            </div>
          </dl>
          {preview.conflicts.length > 0 && (
            <div role="alert">
              <strong>
                {t(
                  "تعارض‌ها باید پیش از ثبت رفع شوند.",
                  "Resolve conflicts before committing.",
                )}
              </strong>
              <ul>
                {preview.conflicts.map((item, index) => (
                  <li key={index}>
                    {item.kind} · {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <p className="muted small">
            {t(
              "این پیش‌نمایش تغییری ذخیره نکرده است.",
              "This preview has not saved any changes.",
            )}
          </p>
          <div className="form-actions">
            <Button
              variant="primary"
              disabled={busy || !preview.can_commit}
              onClick={() => void commit()}
            >
              {t("ثبت همین پیش‌نمایش", "Commit this preview")}
            </Button>
            {data && (
              <Button disabled={busy} onClick={() => void inspectImport(data)}>
                {t("بررسی دوبارهٔ فایل", "Recheck file")}
              </Button>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}
