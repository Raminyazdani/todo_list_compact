"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import type {
  EmployerContractReportDTO,
  TimeContractReportDTO,
  TimeContractWeekDTO,
  WorkContractPolicyDTO,
} from "@/shared/contracts";
import { addCalendarDays, instantToLocalTime } from "@/shared/datetime";
import { Button, QueryState } from "@/components/ui";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import type { CalendarAction } from "./calendar-workspace";
import { ContractPolicyEditor } from "./contract-policy-editor";

function clock(minutes: number | null | undefined) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes))
    return "—";
  const amount = Math.round(Math.abs(minutes));
  return `${Math.floor(amount / 60)}:${String(amount % 60).padStart(2, "0")}`;
}

function weekEnd(start: string) {
  return addCalendarDays(start, 6);
}

function mondayOf(date: string) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addCalendarDays(date, -((weekday + 6) % 7));
}

function dateRange(from: string, to: string) {
  return `${from} – ${to}`;
}

function contractTone(
  week: TimeContractWeekDTO | undefined,
  configured: boolean,
) {
  if (!configured || !week || week.contract_state === "unknown")
    return "unknown";
  if (week.contract_state === "over") return "over";
  if (
    week.contract_state === "review" ||
    week.weekday_review_count ||
    week.window_review_count ||
    week.out_of_term_review_count
  )
    return "review";
  return week.contract_state === "within" ? "within" : "unknown";
}

function WeekProgress({
  used,
  threshold,
  label,
  tone,
}: {
  used: number;
  threshold: number;
  label: string;
  tone: string;
}) {
  const ratio = threshold > 0 ? Math.max(0, (used / threshold) * 100) : 0;
  return (
    <div className="contract-progress" data-tone={tone}>
      <div
        className="contract-progress-track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, threshold)}
        aria-valuenow={Math.min(Math.max(0, used), Math.max(1, threshold))}
        aria-valuetext={`${clock(used)} / ${clock(threshold)}`}
      >
        <span style={{ width: `${Math.min(100, ratio)}%` }} />
      </div>
    </div>
  );
}

function RuleDetails({
  policy,
  week,
}: {
  policy: WorkContractPolicyDTO | null;
  week: TimeContractWeekDTO | undefined;
}) {
  const { t } = useLocale();
  if (!policy) return null;
  const issues = week?.issues ?? [];
  return (
    <details className="contract-rule-details">
      <summary>
        {t("قواعد ثبت‌شده و موارد بررسی", "Recorded rules and review items")}
      </summary>
      <dl className="contract-rule-list">
        <div>
          <dt>{t("منبع قاعده", "Rule source")}</dt>
          <dd>{policy.source_label || t("ثبت نشده", "Not recorded")}</dd>
        </div>
        {(policy.effective_from || policy.effective_to) && (
          <div>
            <dt>{t("دورهٔ قرارداد", "Contract period")}</dt>
            <dd dir="ltr">
              {dateRange(
                policy.effective_from ?? "?",
                policy.effective_to ?? "?",
              )}
            </dd>
          </div>
        )}
        {policy.weekly_average_target_minutes != null && (
          <div>
            <dt>
              {t(
                "هدف میانگین هفتگی؛ اطلاعاتی",
                "Weekly average target; informational",
              )}
            </dt>
            <dd>
              {clock(policy.weekly_average_target_minutes)} ·{" "}
              {policy.average_window_months ?? "?"} {t("ماه", "months")}
            </dd>
          </div>
        )}
        {policy.allowed_weekdays.length ? (
          <div>
            <dt>{t("روزهای ثبت‌شده در قاعده", "Days in recorded rule")}</dt>
            <dd>
              {policy.allowed_weekdays
                .map((day) =>
                  t(
                    [
                      "دوشنبه",
                      "سه‌شنبه",
                      "چهارشنبه",
                      "پنجشنبه",
                      "جمعه",
                      "شنبه",
                      "یکشنبه",
                    ][day - 1] ?? String(day),
                    [
                      "Monday",
                      "Tuesday",
                      "Wednesday",
                      "Thursday",
                      "Friday",
                      "Saturday",
                      "Sunday",
                    ][day - 1] ?? String(day),
                  ),
                )
                .join("، ")}
            </dd>
          </div>
        ) : null}
        {policy.local_window_start && policy.local_window_end && (
          <div>
            <dt>{t("بازهٔ محلی ثبت‌شده", "Recorded local window")}</dt>
            <dd dir="ltr">
              {policy.local_window_start} – {policy.local_window_end}
            </dd>
          </div>
        )}
        {policy.timesheet_due && (
          <div>
            <dt>
              {t(
                "مهلت تایم‌شیت؛ ارسال قابل‌تشخیص نیست",
                "Timesheet due; submission unverified",
              )}
            </dt>
            <dd>
              {policy.timesheet_due.kind === "calendar_day"
                ? t("روز تقویمی", "Calendar day")
                : t("روز کاری", "Business day")}{" "}
              {policy.timesheet_due.day} {t("ماه بعد", "of next month")}
            </dd>
          </div>
        )}
      </dl>
      {week?.weekday_review_count ||
      week?.window_review_count ||
      week?.out_of_term_review_count ? (
        <p className="small contract-review-note">
          {t("نیازمند بررسی", "Needs review")}: {week.weekday_review_count}{" "}
          {t("روز نامعمول", "weekday")}, {week.window_review_count}{" "}
          {t("خارج از بازهٔ ساعت", "outside time window")},{" "}
          {week.out_of_term_review_count}{" "}
          {t("خارج از دورهٔ قرارداد", "outside contract period")}
        </p>
      ) : null}
      {issues.length > 0 && (
        <ul className="contract-issue-list">
          {issues.map((issue) => (
            <li key={`${issue.entry_id}:${issue.code}:${issue.local_date}`}>
              <span>
                {issue.code === "WEEKDAY_REVIEW"
                  ? t("روز نیازمند بررسی", "Day needs review")
                  : issue.code === "LOCAL_WINDOW_REVIEW"
                    ? t(
                        "ساعت خارج از بازهٔ ثبت‌شده",
                        "Outside recorded time window",
                      )
                    : issue.code === "LEGACY_DURATION_REVIEW"
                      ? t(
                          "اختلاف ساعت تسویهٔ واردشده با زمان واقعی؛ نیازمند بررسی",
                          "Imported settlement time differs from elapsed time; review needed",
                        )
                      : t(
                          "خارج از دورهٔ ثبت‌شدهٔ قرارداد",
                          "Outside recorded contract period",
                        )}
              </span>
              <time dir="ltr">
                {issue.local_date}{" "}
                {instantToLocalTime(issue.starts_at, "Europe/Berlin")}–
                {instantToLocalTime(issue.ends_at, "Europe/Berlin")}
              </time>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function PeriodInsights({ employer }: { employer: EmployerContractReportDTO }) {
  const { t } = useLocale();
  const cumulative = employer.cumulative;
  const average = employer.average;
  return (
    <div
      className="contract-period-insights"
      aria-label={t(
        `روند دوره‌ای ${employer.employer}`,
        `${employer.employer} period trends`,
      )}
    >
      <div className="contract-period-card" data-status={cumulative.status}>
        <div className="contract-period-heading">
          <strong>{t("جمع از شروع قرارداد", "Since contract start")}</strong>
          <span>
            {cumulative.status === "informational"
              ? t("اطلاعاتی", "Informational")
              : t("نیازمند دادهٔ کامل", "Incomplete data")}
          </span>
        </div>
        <p className="small muted" dir="ltr">
          {cumulative.from ?? "?"} – {cumulative.through_month}
        </p>
        <div className="contract-period-values">
          <b dir="ltr">{clock(cumulative.reported_minutes)}</b>
          <span>{t("ثبت‌شده", "recorded")}</span>
          <span aria-hidden="true">/</span>
          <b dir="ltr">{clock(cumulative.reference_minutes)}</b>
          <span>{t("مرجع تجمعی", "cumulative reference")}</span>
        </div>
        {cumulative.reported_minutes !== null &&
          cumulative.reference_minutes !== null &&
          cumulative.reference_minutes > 0 && (
            <WeekProgress
              used={cumulative.reported_minutes}
              threshold={cumulative.reference_minutes}
              label={t(
                `پیشرفت تجمعی ${employer.employer}`,
                `${employer.employer} cumulative progress`,
              )}
              tone={cumulative.status}
            />
          )}
        {cumulative.delta_minutes !== null && (
          <p className="small muted">
            {t(
              "فاصله از مرجع؛ حکم تخلف نیست",
              "Difference from reference; not a breach verdict",
            )}
            :{" "}
            <b dir="ltr">
              {cumulative.delta_minutes < 0 ? "−" : "+"}
              {clock(cumulative.delta_minutes)}
            </b>
          </p>
        )}
        {cumulative.status === "unknown" && (
          <p className="small contract-unknown-note">
            {t(
              "ماه یا مرجع دوره کامل نیست؛ این جمع مبنای نتیجه‌گیری قراردادی نیست.",
              "The month or period reference is incomplete; this total cannot establish contract status.",
            )}
          </p>
        )}
      </div>
      {average.window_months !== null && (
        <div className="contract-period-card" data-status={average.status}>
          <div className="contract-period-heading">
            <strong>{t("روند میانگین دوره", "Period average trend")}</strong>
            <span>
              {average.status === "informational"
                ? t("اطلاعاتی", "Informational")
                : t("نیازمند دادهٔ کامل", "Incomplete data")}
            </span>
          </div>
          <p className="small muted">
            {average.window_months} {t("ماه", "months")} ·{" "}
            <span dir="ltr">
              {average.window_start ?? "?"} – {average.window_end_exclusive}
            </span>
          </p>
          <div className="contract-period-values">
            <b dir="ltr">{clock(average.recorded_average_minutes_per_week)}</b>
            <span>
              {t("میانگین ثبت‌شده در هفته", "recorded weekly average")}
            </span>
            <span aria-hidden="true">/</span>
            <b dir="ltr">{clock(average.target_minutes_per_week)}</b>
            <span>{t("هدف", "target")}</span>
          </div>
          {average.recorded_average_minutes_per_week !== null &&
            average.target_minutes_per_week !== null &&
            average.target_minutes_per_week > 0 && (
              <WeekProgress
                used={average.recorded_average_minutes_per_week}
                threshold={average.target_minutes_per_week}
                label={t(
                  `روند میانگین ${employer.employer}`,
                  `${employer.employer} average trend`,
                )}
                tone={average.status}
              />
            )}
          <p className="small muted">
            {t(
              "فقط روند ساعت‌های ثبت‌شده است؛ نتیجهٔ قانونی یا تأیید تایم‌شیت نیست.",
              "This reflects recorded hours only, not a legal conclusion or approved timesheet.",
            )}
          </p>
        </div>
      )}
    </div>
  );
}

export function ContractHoursDashboard({
  month,
  date,
  action,
}: {
  month: string;
  date: string;
  action: CalendarAction;
}) {
  const { t } = useLocale();
  const report = useQuery<TimeContractReportDTO>("time_contract_report", {
    month,
  });
  const [selectedWeekStart, setSelectedWeekStart] = useState("");
  const [selectedEmployer, setSelectedEmployer] = useState("");
  const weeks = report.data?.combined_weeks ?? [];
  const selectedDateWeek = mondayOf(date);
  const activeStart = weeks.some(
    (week) => week.week_start === selectedWeekStart,
  )
    ? selectedWeekStart
    : (weeks.find((week) => week.week_start === selectedDateWeek)?.week_start ??
      weeks[0]?.week_start ??
      "");
  const activeEmployer = report.data?.employers.some(
    (employer) => employer.employer === selectedEmployer,
  )
    ? selectedEmployer
    : (report.data?.employers[0]?.employer ?? "");
  const combined = weeks.find((week) => week.week_start === activeStart);
  return (
    <section
      className="panel contract-hours-panel"
      aria-labelledby="contract-hours-heading"
    >
      <div className="contract-hours-heading">
        <div>
          <div className="eyebrow">
            {t("دید قراردادیِ ساعات ثبت‌شده", "RECORDED HOURS BY CONTRACT")}
          </div>
          <h2 id="contract-hours-heading">
            {t("وضعیت هفته‌ها و قراردادها", "Weeks and contract rules")}
          </h2>
          <p className="small muted">
            {t(
              "هفته از دوشنبه تا یکشنبه، به وقت برلین محاسبه می‌شود. هشدارها مانع ثبت بازه نیستند.",
              "Weeks run Monday to Sunday in Berlin time. Warnings do not prevent recording time.",
            )}
          </p>
        </div>
        <Button
          onClick={report.refresh}
          aria-label={t("تازه‌سازی وضعیت قراردادها", "Refresh contract status")}
        >
          <RefreshCw size={15} /> {t("تازه‌سازی", "Refresh")}
        </Button>
      </div>
      <QueryState {...report} retry={report.refresh} />
      {report.fetching && report.data && !report.error && (
        <p className="small muted" role="status">
          {t("در حال بررسی دوبارهٔ ثبت‌ها…", "Rechecking entries…")}
        </p>
      )}
      {!report.error && report.data && (
        <>
          {report.data.employers.length === 0 && (
            <p className="contract-unknown-note">
              {t(
                "هنوز ساعت یا قاعده‌ای برای این ماه ثبت نشده است. قاعدهٔ هر کارفرما را از بخش تنظیمات پایین اضافه کن.",
                "No hours or rules are recorded for this month yet. Add each employer's rule in the settings below.",
              )}
            </p>
          )}
          <div
            className="contract-month-cards"
            role="group"
            aria-label={t("قراردادهای این ماه", "Contracts this month")}
          >
            {report.data.employers.map((employer) => {
              const week = employer.weeks.find(
                (row) => row.week_start === activeStart,
              );
              const tone = contractTone(
                week,
                employer.policy_status === "configured",
              );
              const personalOver = week?.personal_state === "over";
              const cardTone =
                tone === "unknown" && personalOver ? "review" : tone;
              return (
                <button
                  type="button"
                  className="contract-month-card"
                  data-tone={cardTone}
                  aria-pressed={activeEmployer === employer.employer}
                  onClick={() => setSelectedEmployer(employer.employer)}
                  key={employer.employer}
                >
                  <span className="contract-month-card-heading">
                    <strong>{employer.employer}</strong>
                    <span className="contract-state-chip" data-tone={cardTone}>
                      {employer.policy_status === "missing"
                        ? t("قاعده تنظیم نشده", "Rule needs setup")
                        : employer.policy_status === "mixed"
                          ? t("چند قاعده؛ بررسی", "Multiple rules; review")
                          : tone === "over"
                            ? t("عبور از سقف این هفته", "Above this week's cap")
                            : personalOver
                              ? t(
                                  "هشدار شخصی این هفته",
                                  "Personal alert this week",
                                )
                              : tone === "review"
                                ? t("نیازمند بررسی", "Needs review")
                                : tone === "within"
                                  ? t(
                                      "زیر آستانهٔ ثبت‌شده",
                                      "Below recorded threshold",
                                    )
                                  : t("نامشخص", "Unknown")}
                    </span>
                  </span>
                  <span className="contract-month-amount" dir="ltr">
                    {clock(employer.monthly.minutes)}
                  </span>
                  <span className="small muted">
                    {t("ساعت گزارش‌شده در این ماه", "Reported time this month")}
                  </span>
                  {employer.monthly.reference_minutes !== null && (
                    <span className="contract-month-reference">
                      {t(
                        "مرجع ماهانه؛ اطلاعاتی",
                        "Monthly reference; informational",
                      )}
                      : {clock(employer.monthly.reference_minutes)}
                      {employer.monthly.delta_minutes !== null && (
                        <>
                          {" "}
                          · {employer.monthly.delta_minutes < 0 ? "−" : "+"}
                          {clock(employer.monthly.delta_minutes)}
                        </>
                      )}
                    </span>
                  )}
                  {week?.personal_alert_minutes !== null &&
                    week?.personal_alert_minutes !== undefined && (
                      <span
                        className="contract-personal-chip"
                        data-tone={week.personal_state}
                      >
                        {t("هشدار شخصی", "Personal alert")}:{" "}
                        <span dir="ltr">
                          {clock(week.minutes)} /{" "}
                          {clock(week.personal_alert_minutes)}
                        </span>
                      </span>
                    )}
                </button>
              );
            })}
          </div>
          {report.data.employers
            .filter((employer) => employer.employer === activeEmployer)
            .map((employer) => (
              <PeriodInsights employer={employer} key={employer.employer} />
            ))}
          <div
            className="contract-week-picker"
            role="group"
            aria-label={t("انتخاب هفتهٔ کامل", "Select full week")}
          >
            {weeks.map((week) => (
              <button
                key={week.week_start}
                type="button"
                aria-pressed={activeStart === week.week_start}
                onClick={() => setSelectedWeekStart(week.week_start)}
              >
                <span>{t("هفته", "Week")}</span>
                <span dir="ltr">
                  {dateRange(week.week_start, weekEnd(week.week_start))}
                </span>
              </button>
            ))}
          </div>
          {combined && (
            <div className="contract-selected-week">
              <div className="contract-selected-week-heading">
                <h3>
                  {t("هفتهٔ انتخاب‌شده", "Selected week")} ·{" "}
                  <time dir="ltr">
                    {dateRange(activeStart, weekEnd(activeStart))}
                  </time>
                </h3>
                <span>
                  {t(
                    "جمع ساعت تسویهٔ ثبت‌شده",
                    "Combined recorded settlement time",
                  )}
                  : <b dir="ltr">{clock(combined.minutes)}</b>
                </span>
              </div>
              {combined.review_over_20h && (
                <p className="contract-review-note" role="status">
                  <AlertTriangle size={16} />{" "}
                  {t(
                    "زمان واقعی کار این هفته از ۲۰ ساعت گذشت؛ وضعیت اشتغال دانشجویی نیازمند بررسی است و این برچسب حکم تخلف نیست.",
                    "Actual elapsed work time this week exceeds 20 hours; review student employment status. This is not a breach verdict.",
                  )}
                </p>
              )}
              {report.data.employers
                .filter((employer) => employer.employer === activeEmployer)
                .map((employer) => {
                  const week = employer.weeks.find(
                    (row) => row.week_start === activeStart,
                  );
                  const tone = contractTone(
                    week,
                    employer.policy_status === "configured",
                  );
                  return (
                    <div
                      className="contract-week-detail"
                      data-tone={tone}
                      key={employer.employer}
                    >
                      <h4>{employer.employer}</h4>
                      {week ? (
                        <>
                          <p className="contract-week-amount">
                            <strong dir="ltr">{clock(week.minutes)}</strong>{" "}
                            <span>
                              {t(
                                "ساعت در هفتهٔ کامل",
                                "hours in the full week",
                              )}{" "}
                              · {week.entry_count} {t("بازه", "entries")}
                            </span>
                          </p>
                          {Math.abs(week.minutes - week.elapsed_minutes) >
                            0.001 && (
                            <p className="contract-review-note" role="status">
                              <AlertTriangle size={16} />{" "}
                              {t(
                                "ساعت تسویهٔ واردشده با زمان واقعی سپری‌شده فرق دارد؛ وضعیت آستانه‌ها نیازمند بررسی است.",
                                "Imported settlement time differs from actual elapsed time; threshold status needs review.",
                              )}{" "}
                              {t("زمان واقعی", "Actual elapsed")}:{" "}
                              <b dir="ltr">{clock(week.elapsed_minutes)}</b>
                            </p>
                          )}
                          {week.contract_limit_minutes !== null ? (
                            <div className="contract-threshold">
                              <div className="contract-threshold-line">
                                <strong>
                                  {t(
                                    "سقف قراردادی هفتگی",
                                    "Weekly contractual cap",
                                  )}
                                </strong>
                                <span dir="ltr">
                                  {clock(week.minutes)} /{" "}
                                  {clock(week.contract_limit_minutes)}
                                </span>
                              </div>
                              <WeekProgress
                                used={week.minutes}
                                threshold={week.contract_limit_minutes}
                                label={t(
                                  `سقف قراردادی ${employer.employer}`,
                                  `${employer.employer} contractual cap`,
                                )}
                                tone={week.contract_state}
                              />
                              <small
                                className="contract-threshold-result"
                                data-tone={week.contract_state}
                              >
                                {week.contract_state === "over"
                                  ? t(
                                      `بیش از سقف: ${clock(week.contract_over_minutes)}`,
                                      `Above cap: ${clock(week.contract_over_minutes)}`,
                                    )
                                  : week.contract_state === "within"
                                    ? t(
                                        `مانده تا سقف: ${clock(week.contract_remaining_minutes)}`,
                                        `Remaining: ${clock(week.contract_remaining_minutes)}`,
                                      )
                                    : t(
                                        "این قاعده نیازمند بررسی است",
                                        "This rule needs review",
                                      )}
                              </small>
                            </div>
                          ) : (
                            <p className="contract-unknown-note">
                              {t(
                                "سقف قراردادی هفتگی برای این قرارداد ثبت نشده یا قابل‌داوری نیست.",
                                "The weekly contractual cap is not recorded or cannot be evaluated.",
                              )}
                            </p>
                          )}
                          {week.personal_alert_minutes !== null && (
                            <div
                              className="contract-threshold personal"
                              data-tone={week.personal_state}
                            >
                              <div className="contract-threshold-line">
                                <strong>
                                  {t(
                                    "هشدار شخصی؛ قاعدهٔ قرارداد نیست",
                                    "Personal alert; not a contract rule",
                                  )}
                                </strong>
                                <span dir="ltr">
                                  {clock(week.minutes)} /{" "}
                                  {clock(week.personal_alert_minutes)}
                                </span>
                              </div>
                              <WeekProgress
                                used={week.minutes}
                                threshold={week.personal_alert_minutes}
                                label={t(
                                  `هشدار شخصی ${employer.employer}`,
                                  `${employer.employer} personal alert`,
                                )}
                                tone={week.personal_state}
                              />
                              <small
                                className="contract-threshold-result"
                                data-tone={week.personal_state}
                              >
                                {week.personal_state === "over"
                                  ? t(
                                      `بیش از هشدار شخصی: ${clock(week.personal_over_minutes)}`,
                                      `Above personal alert: ${clock(week.personal_over_minutes)}`,
                                    )
                                  : week.personal_state === "within"
                                    ? t(
                                        `مانده تا هشدار: ${clock(week.personal_remaining_minutes)}`,
                                        `Until alert: ${clock(week.personal_remaining_minutes)}`,
                                      )
                                    : t("نیازمند بررسی", "Needs review")}
                              </small>
                            </div>
                          )}
                          {week.average_target_minutes !== null && (
                            <p className="contract-information-note">
                              {t(
                                "هدف میانگین هفتگی، اطلاعاتی است؛ وضعیت دورهٔ میانگین از یک هفته به‌تنهایی معلوم نمی‌شود.",
                                "Weekly average target is informational; one week cannot establish the averaging-period result.",
                              )}{" "}
                              <b dir="ltr">
                                {clock(week.average_target_minutes)}
                              </b>
                            </p>
                          )}
                          <RuleDetails policy={employer.policy} week={week} />
                        </>
                      ) : (
                        <p className="contract-unknown-note">
                          {t(
                            "پوشش این هفته کامل نیست؛ نتیجهٔ قرارداد نامشخص است.",
                            "Week coverage is incomplete; contract status is unknown.",
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
            </div>
          )}
          <p className="small muted contract-not-computable">
            {t(
              "این گزارش ارسال تایم‌شیت، امضای سرپرست، وقفه و استراحت، و تأیید کار دوم را از ثبت ساعت تشخیص نمی‌دهد؛ آن‌ها جداگانه نیازمند بررسی‌اند.",
              "Time entries do not verify timesheet submission, supervisor signatures, breaks and rest, or second-job approval; review those separately.",
            )}
          </p>
          {[
            ...new Set([
              "Jena",
              "Seewiesen",
              ...report.data.employers.map((item) => item.employer),
            ]),
          ].map((employer) => (
            <div key={employer}>
              <ContractPolicyEditor
                employer={employer}
                month={month}
                action={action}
                onSaved={report.refresh}
              />
            </div>
          ))}
        </>
      )}
    </section>
  );
}
