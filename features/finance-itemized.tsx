import type { ReactNode } from "react";
import { Pencil } from "lucide-react";
import { Button, QueryState, SectionHeading } from "@/components/ui";
import type {
  FinanceAmountBasis,
  FinanceDuePrecision,
  FinancePlanDTO,
  FinancePlanKind,
  FinancePlanState,
} from "@/shared/contracts";
import { useLocale } from "./locale";

type Props = {
  plans: readonly FinancePlanDTO[];
  loading: boolean;
  error: string | null;
  retry: () => void;
  labels: {
    plan: Record<FinancePlanKind, string>;
    state: Record<FinancePlanState, string>;
    basis: Record<FinanceAmountBasis, string>;
    precision: Record<FinanceDuePrecision, string>;
  };
  accountName: (id: string | null) => string;
  categoryName: (id: string | null) => string;
  renderMoney: (cents: number | null) => ReactNode;
  cadence: (plan: FinancePlanDTO) => string;
  onEdit: (plan: FinancePlanDTO) => void;
  onManage: () => void;
};

const monthlyKinds = new Set<FinancePlanKind>([
  "recurring",
  "budget",
  "reserve",
]);

/** Itemize selected-month versions without recalculating financial totals. */
export function FinanceItemizedPlans({
  plans,
  loading,
  error,
  retry,
  labels,
  accountName,
  categoryName,
  renderMoney,
  cadence,
  onEdit,
  onManage,
}: Props) {
  const { t } = useLocale();
  const isSelectedMonthly = (plan: FinancePlanDTO) =>
    plan.state === "active" && plan.included && monthlyKinds.has(plan.kind);
  const rows = plans
    .filter(
      (plan) =>
        plan.applicable && (!plan.archived_at || plan.state === "active"),
    )
    .sort(
      (left, right) =>
        Number(isSelectedMonthly(right)) - Number(isSelectedMonthly(left)),
    );

  function countingStatus(plan: FinancePlanDTO) {
    if (plan.state !== "active" || !plan.included)
      return t("خارج از جمع ماهانه", "Excluded from monthly totals");
    if (plan.kind === "liability")
      return t(
        "اصل بدهی؛ خارج از جمع ماهانه",
        "Principal; excluded from monthly totals",
      );
    if (plan.kind === "one_off")
      return t(
        "هزینهٔ موردی؛ خارج از جمع ماهانه",
        "One-off; excluded from monthly totals",
      );
    if (plan.monthly_equivalent_cents === null)
      return t(
        "معادل ماهانه نامشخص؛ در جمع عددی نیامده",
        "Monthly equivalent unknown; not included in numeric totals",
      );
    if (plan.kind === "reserve")
      return t(
        "کنارگذاری؛ جدا از جمع هزینه‌ها",
        "Reserve; separate from cost totals",
      );
    return t("در جمع هزینه‌های ماه", "Included in monthly costs");
  }

  function due(plan: FinancePlanDTO) {
    if (plan.due_precision === "unknown")
      return t("موعد نامشخص", "Due date unknown");
    const date = plan.next_due_on ?? plan.due_on;
    if (date)
      return (
        <>
          <time dateTime={date}>{date}</time> ·{" "}
          {labels.precision[plan.due_precision]}
        </>
      );
    if (plan.due_day !== null)
      return t(
        `روز ${plan.due_day} دورهٔ پرداخت · ${labels.precision[plan.due_precision]}`,
        `Day ${plan.due_day} of the payment period · ${labels.precision[plan.due_precision]}`,
      );
    return t("موعد نامشخص", "Due date unknown");
  }

  return (
    <section
      className="panel finance-itemized"
      aria-label={t("ریز هزینه‌های این ماه", "Itemized costs this month")}
      aria-busy={loading}
    >
      <SectionHeading
        title={t("ریز هزینه‌های این ماه", "Itemized costs this month")}
        subtitle={t(
          "هر مورد با مبلغ و توضیح خودش؛ بودجه، کنارگذاری و سابقه جدا مشخص شده‌اند.",
          "Each item has its own amount and details; budgets, reserves and references are identified separately.",
        )}
        action={
          <Button onClick={onManage}>
            {t("مدیریت همهٔ موارد", "Manage all items")}
          </Button>
        }
      />
      <QueryState loading={loading} error={error} retry={retry} />
      {!loading && !error && !rows.length && (
        <p className="muted small">
          {t(
            "هنوز موردی برای این ماه ثبت نشده است.",
            "No items have been recorded for this month.",
          )}
        </p>
      )}
      <div className="finance-itemized-list">
        {rows.map((plan) => (
          <article
            key={plan.plan_id}
            data-plan-id={plan.plan_id}
            className="finance-itemized-row"
          >
            <div className="finance-itemized-heading">
              <div>
                <h3>{plan.title}</h3>
                <div className="finance-itemized-tags">
                  <span className="finance-pill">{labels.plan[plan.kind]}</span>
                  <span className="finance-pill">
                    {labels.state[plan.state]}
                  </span>
                  {plan.archived_at && (
                    <span className="finance-pill finance-itemized-archived">
                      {t(
                        "بایگانی‌شده؛ نسخهٔ این ماه",
                        "Archived; this month's version",
                      )}
                    </span>
                  )}
                  <span>{categoryName(plan.category_id)}</span>
                </div>
              </div>
              {!plan.archived_at && (
                <Button
                  aria-label={`${t("ویرایش", "Edit")} ${plan.title}`}
                  onClick={() => onEdit(plan)}
                >
                  <Pencil size={14} /> {t("ویرایش", "Edit")}
                </Button>
              )}
            </div>
            <dl className="finance-itemized-facts">
              <div>
                <dt>{t("مبلغ هر دوره / مورد", "Per interval / item")}</dt>
                <dd className="finance-itemized-amount">
                  {renderMoney(plan.amount_cents)}
                </dd>
                <dd className="finance-itemized-meta">{cadence(plan)}</dd>
              </div>
              <div>
                <dt>{t("معادل ماهانه", "Monthly equivalent")}</dt>
                <dd className="finance-itemized-monthly">
                  {monthlyKinds.has(plan.kind)
                    ? renderMoney(plan.monthly_equivalent_cents)
                    : t("ماهانه نیست", "Not monthly")}
                </dd>
                <dd className="finance-itemized-counting">
                  {countingStatus(plan)}
                </dd>
              </div>
              <div>
                <dt>{t("حساب پرداخت", "Payment account")}</dt>
                <dd>{accountName(plan.account_id)}</dd>
              </div>
              <div>
                <dt>{t("زمان پرداخت", "Payment timing")}</dt>
                <dd className="finance-itemized-due">{due(plan)}</dd>
              </div>
            </dl>
            <details className="finance-itemized-details">
              <summary>{t("جزئیات و مبنا", "Details & source")}</summary>
              <div>
                <p className="small muted">
                  {labels.basis[plan.amount_basis]} ·{" "}
                  {t("اثر از ماه", "Effective from")} {plan.effective_month}
                </p>
                {plan.notes ? (
                  <p className="finance-notes">{plan.notes}</p>
                ) : (
                  <p className="small muted">
                    {t("توضیح بیشتری ثبت نشده است.", "No additional notes.")}
                  </p>
                )}
                {plan.source_label && (
                  <p className="small muted">
                    {t("مبنا:", "Source:")} {plan.source_label}
                  </p>
                )}
              </div>
            </details>
          </article>
        ))}
      </div>
    </section>
  );
}
