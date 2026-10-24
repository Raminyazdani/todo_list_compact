"use client";

import { useState } from "react";
import type {
  TimeContractReportDTO,
  WorkContractPolicyDTO,
} from "@/shared/contracts";
import { addCalendarDays } from "@/shared/datetime";
import { QueryState } from "@/components/ui";
import { useQuery } from "./api";
import { useLocale } from "./locale";

function hours(minutes: number | null | undefined) {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  const whole = Math.round(Math.abs(minutes));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function weekEnd(start: string) {
  return addCalendarDays(start, 6);
}

function mondayOf(date: string) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addCalendarDays(date, -((day + 6) % 7));
}

function RuleSummary({
  policy,
  monthReference,
}: {
  policy: WorkContractPolicyDTO;
  monthReference: number | null;
}) {
  const { t } = useLocale();
  const days = [
    t("دوشنبه", "Monday"),
    t("سه‌شنبه", "Tuesday"),
    t("چهارشنبه", "Wednesday"),
    t("پنجشنبه", "Thursday"),
    t("جمعه", "Friday"),
    t("شنبه", "Saturday"),
    t("یکشنبه", "Sunday"),
  ];
  return (
    <div className="contract-rule-summary">
      <strong>{policy.employer}</strong>
      <span>
        {t("دوره", "Period")}:{" "}
        <bdi>
          {policy.effective_from} – {policy.effective_to ?? "…"}
        </bdi>
      </span>
      {policy.allowed_weekdays.length > 0 && (
        <span>
          {t("روزها", "Days")}:{" "}
          {policy.allowed_weekdays
            .map((day) => days[day - 1] ?? day)
            .join("، ")}
        </span>
      )}
      {policy.local_window_start && policy.local_window_end && (
        <span>
          {t("بازهٔ ساعت", "Time window")}:{" "}
          <bdi>
            {policy.local_window_start}–{policy.local_window_end}
          </bdi>
        </span>
      )}
      {policy.weekly_average_target_minutes != null && (
        <span>
          {t("هدف میانگین؛ اطلاعاتی", "Average target; informational")}:{" "}
          {hours(policy.weekly_average_target_minutes)}
        </span>
      )}
      {monthReference != null && (
        <span>
          {t("مرجع ماهانه؛ اطلاعاتی", "Monthly reference; informational")}:{" "}
          {hours(monthReference)}
        </span>
      )}
      {policy.timesheet_due && (
        <span>
          {t(
            "مهلت تایم‌شیت؛ ارسال بررسی نشده",
            "Timesheet due; submission unverified",
          )}
          : {policy.timesheet_due.day}{" "}
          {policy.timesheet_due.kind === "business_day"
            ? t("روز کاری ماه بعد", "business day of next month")
            : t("روز ماه بعد", "day of next month")}
        </span>
      )}
      {policy.source_label && (
        <span>
          {t("منبع", "Source")}: {policy.source_label}
        </span>
      )}
    </div>
  );
}

export function ContractHoursDashboard({
  month,
  date,
}: {
  month: string;
  date: string;
}) {
  const { t } = useLocale();
  const report = useQuery<TimeContractReportDTO>("time_contract_report", {
    month,
  });
  const [selectedWeek, setSelectedWeek] = useState("");
  const weeks = report.data?.combined_weeks ?? [];
  const dateWeek = mondayOf(date);
  const activeWeek = weeks.some((week) => week.week_start === selectedWeek)
    ? selectedWeek
    : (weeks.find((week) => week.week_start === dateWeek)?.week_start ??
      weeks[0]?.week_start ??
      "");
  const combined = weeks.find((week) => week.week_start === activeWeek);

  return (
    <section
      className="panel contract-hours-panel"
      aria-label={t("محدودیت ساعات کار", "Work-hour limits")}
    >
      <div className="contract-hours-heading">
        <div>
          <h2>{t("محدودیت ساعات کار", "Work-hour limits")}</h2>
          <p className="small muted">
            {t(
              "هفتهٔ کامل، دوشنبه تا یکشنبه به وقت برلین؛ ساعت‌های پیش‌نویس در جمع نیستند.",
              "Full Monday–Sunday weeks in Berlin time; drafts are excluded.",
            )}
          </p>
        </div>
        {weeks.length > 0 && (
          <label className="contract-week-select">
            {t("هفته", "Week")}
            <select
              aria-label={t("هفتهٔ کاری", "Work week")}
              value={activeWeek}
              onChange={(event) => setSelectedWeek(event.target.value)}
            >
              {weeks.map((week) => (
                <option key={week.week_start} value={week.week_start}>
                  {week.week_start} – {weekEnd(week.week_start)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <QueryState {...report} retry={report.refresh} />
      {!report.error && report.data && (
        <>
          <div className="contract-limit-grid">
            {report.data.employers.map((employer) => {
              const week = employer.weeks.find(
                (item) => item.week_start === activeWeek,
              );
              const contractLimit = week?.contract_limit_minutes ?? null;
              const personalLimit = week?.personal_alert_minutes ?? null;
              const primaryLimit = contractLimit ?? personalLimit;
              const personal = contractLimit === null && personalLimit !== null;
              const state = personal
                ? week?.personal_state
                : week?.contract_state;
              const policyIssue = employer.policy_status !== "configured";
              const reviewReasons = week
                ? [
                    week.weekday_review_count
                      ? t("روز خارج از قاعده", "weekday outside rule")
                      : null,
                    week.window_review_count
                      ? t("ساعت خارج از بازه", "outside time window")
                      : null,
                    week.out_of_term_review_count
                      ? t("خارج از دورهٔ قرارداد", "outside contract term")
                      : null,
                    week.issues.some(
                      (issue) => issue.code === "LEGACY_DURATION_REVIEW",
                    ) || Math.abs(week.minutes - week.elapsed_minutes) > 0.001
                      ? t(
                          "اختلاف ساعت تسویه و زمان واقعی",
                          "settlement and elapsed time differ",
                        )
                      : null,
                  ].filter(Boolean)
                : [];
              const needsReview =
                !!week &&
                (reviewReasons.length > 0 ||
                  policyIssue ||
                  state === "review" ||
                  Math.abs(week.minutes - week.elapsed_minutes) > 0.001);
              const contractOver =
                contractLimit !== null && week?.contract_state === "over";
              const personalOver =
                personalLimit !== null && week?.personal_state === "over";
              const tone = contractOver
                ? "over"
                : personalOver
                  ? "personal-over"
                  : needsReview
                    ? "review"
                    : state === "within"
                      ? "within"
                      : "unknown";
              return (
                <div
                  className="contract-limit-card"
                  data-tone={tone}
                  key={employer.employer}
                >
                  <strong>{employer.employer}</strong>
                  <span className="contract-limit-value" dir="ltr">
                    {hours(week?.minutes)} / {hours(primaryLimit)}
                  </span>
                  <span className="small muted">
                    {personal
                      ? t(
                          "هشدار شخصی هفتگی؛ قاعدهٔ قرارداد نیست",
                          "Weekly personal alert; not a contract rule",
                        )
                      : contractLimit !== null
                        ? t("سقف قراردادی هفتگی", "Weekly contractual cap")
                        : t(
                            "آستانهٔ هفتگی ثبت نشده",
                            "No weekly threshold recorded",
                          )}
                  </span>
                  <span className="contract-limit-result">
                    {contractOver
                      ? t("از سقف قرارداد گذشت", "Above contractual cap")
                      : personalOver
                        ? t("از هشدار شخصی گذشت", "Above personal alert")
                        : needsReview
                          ? t("نیازمند بررسی", "Needs review")
                          : state === "within"
                            ? t("در محدودهٔ ثبت‌شده", "Within recorded limit")
                            : t("وضعیت نامشخص", "Status unknown")}
                  </span>
                  {reviewReasons.length > 0 && (
                    <small className="contract-limit-review">
                      {t("بررسی", "Review")}: {reviewReasons.join(" · ")}
                    </small>
                  )}
                  {policyIssue && (
                    <small className="contract-limit-review">
                      {employer.policy_status === "mixed"
                        ? t(
                            "چند قاعده در این ماه؛ بررسی لازم است",
                            "Multiple rules this month; review needed",
                          )
                        : t(
                            "قاعدهٔ قرارداد ثبت نشده است",
                            "Contract rule is not recorded",
                          )}
                    </small>
                  )}
                  {contractLimit !== null && personalLimit !== null && (
                    <small>
                      {t("هشدار شخصی", "Personal alert")}:{" "}
                      {hours(week?.minutes)} / {hours(personalLimit)}
                    </small>
                  )}
                </div>
              );
            })}
          </div>
          {combined?.review_over_20h && (
            <p className="contract-limit-review" role="status">
              {t(
                "زمان واقعیِ مجموع کار این هفته از ۲۰ ساعت گذشت؛ وضعیت اشتغال دانشجویی را جداگانه بررسی کن.",
                "Total elapsed work this week exceeds 20 hours; review student employment status separately.",
              )}
            </p>
          )}
          {report.data.employers.length === 0 && (
            <p className="small muted">
              {t(
                "برای این ماه قراردادی ثبت نشده است.",
                "No contract is recorded for this month.",
              )}
            </p>
          )}
          {report.data.employers.some((item) => item.policy) && (
            <details className="contract-rules-disclosure">
              <summary>
                {t("دیگر قواعد ثبت‌شده", "Other recorded rules")}
              </summary>
              <div className="contract-rules-grid">
                {report.data.employers.map((item) =>
                  item.policy ? (
                    <RuleSummary
                      key={item.employer}
                      policy={item.policy}
                      monthReference={item.monthly.reference_minutes}
                    />
                  ) : null,
                )}
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
