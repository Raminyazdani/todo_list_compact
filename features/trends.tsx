"use client";

import { useState } from "react";
import type { TrendDTO } from "./modules";
import { useLocale } from "./locale";
import { Button, Field, Modal, SectionHeading } from "@/components/ui";

export function Trends({ trends }: { trends: TrendDTO }) {
  const { t, language } = useLocale();
  const [metric, setMetric] = useState<"created" | "completed" | "minutes">(
    "completed",
  );
  const [selected, setSelected] = useState<TrendDTO["days"][number] | null>(
    null,
  );
  const label =
    metric === "created"
      ? t("کار ساخته‌شده", "Tasks created")
      : metric === "completed"
        ? t("کار تکمیل‌شده", "Tasks completed")
        : t("دقیقهٔ ثبت‌شده", "Recorded minutes");
  const weeklyMax = Math.max(1, ...trends.weeks.map((week) => week[metric]));
  const dailyMax = Math.max(1, ...trends.days.map((day) => day[metric]));
  const format = (date: string) =>
    new Intl.DateTimeFormat(
      language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
      { month: "short", day: "numeric", timeZone: "UTC" },
    ).format(new Date(`${date}T12:00:00Z`));
  return (
    <section className="panel trends-panel">
      <SectionHeading
        title={t("روند واقعی ۱۲ هفته", "Actual 12-week trends")}
        subtitle={`${trends.from_date} — ${trends.to_date} · ${trends.timezone}`}
      />
      <p className="muted small">
        {t(
          "شمارش از تاریخ ثبت و تکمیل کارها و بازه‌های واقعی زمان است. زمان عبوری از نیمه‌شب بین روزها تقسیم می‌شود؛ صفر یعنی هیچ ثبت در آن روز.",
          "Counts use task creation/completion dates and actual work intervals. Overnight work is split between local dates; zero means no recorded activity that day.",
        )}
      </p>
      <Field label={t("معیار نمودار", "Chart measure")}>
        <select
          value={metric}
          onChange={(event) => setMetric(event.target.value as typeof metric)}
        >
          <option value="completed">
            {t("کار تکمیل‌شده", "Tasks completed")}
          </option>
          <option value="created">{t("کار ساخته‌شده", "Tasks created")}</option>
          <option value="minutes" disabled={!trends.time_scope_granted}>
            {t("دقیقهٔ ثبت‌شده", "Recorded minutes")}
          </option>
        </select>
      </Field>
      {!trends.time_scope_granted && (
        <p className="warning">
          {t(
            "این نشست اجازهٔ خواندن زمان کار ندارد؛ مقدار زمان نمایش داده نمی‌شود.",
            "This session cannot read work time; time values are not displayed.",
          )}
        </p>
      )}
      <div
        className="trend-bars"
        aria-label={t("روند هفتگی", "Weekly trend")}
        dir="ltr"
      >
        {trends.weeks.map((week) => (
          <div className="trend-column" key={week.week_start}>
            <strong>{week[metric]}</strong>
            <div className="trend-bar-track">
              <div
                className="trend-bar"
                style={{ height: `${(100 * week[metric]) / weeklyMax}%` }}
              />
            </div>
            <span>{format(week.week_start)}</span>
          </div>
        ))}
      </div>
      <h3>
        {t("نقشهٔ فعالیت روزانه", "Daily activity map")} · {label}
      </h3>
      <div className="activity-heatmap" dir="ltr">
        {trends.days.map((day) => (
          <button
            key={day.date}
            onClick={() => setSelected(day)}
            title={`${day.date} · ${label}: ${day[metric]}`}
            aria-label={`${day.date} · ${label}: ${day[metric]}`}
            style={{
              background:
                day[metric] > 0
                  ? `linear-gradient(to top, color-mix(in srgb, var(--green) ${20 + (65 * day[metric]) / dailyMax}%, var(--surface)) 6px, var(--surface) 6px)`
                  : "var(--surface)",
            }}
          >
            <span>{Number(day.date.slice(8))}</span>
          </button>
        ))}
      </div>
      <p className="muted small">
        {t(
          "رنگ پررنگ‌تر یعنی ثبت بیشتر در همان معیار؛ برای مقدار دقیق یک روز را انتخاب کن.",
          "A stronger color means more recorded activity for the selected measure. Choose a day for exact values.",
        )}
      </p>
      <details>
        <summary>
          {t("جدول قابل خواندن روند هفتگی", "Readable weekly trend table")}
        </summary>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("شروع هفته", "Week starting")}</th>
                <th>{t("ساخته‌شده", "Created")}</th>
                <th>{t("تکمیل‌شده", "Completed")}</th>
                {trends.time_scope_granted && <th>{t("دقیقه", "Minutes")}</th>}
              </tr>
            </thead>
            <tbody>
              {trends.weeks.map((week) => (
                <tr key={week.week_start}>
                  <td>{week.week_start}</td>
                  <td>{week.created}</td>
                  <td>{week.completed}</td>
                  {trends.time_scope_granted && <td>{week.minutes}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <Modal
        title={selected?.date ?? ""}
        open={!!selected}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        {selected && (
          <>
            <dl className="trend-values">
              <dt>{t("کار ساخته‌شده", "Tasks created")}</dt>
              <dd>{selected.created}</dd>
              <dt>{t("کار تکمیل‌شده", "Tasks completed")}</dt>
              <dd>{selected.completed}</dd>
              {trends.time_scope_granted && (
                <>
                  <dt>{t("دقیقهٔ ثبت‌شده", "Recorded minutes")}</dt>
                  <dd>{selected.minutes}</dd>
                </>
              )}
            </dl>
            <Button onClick={() => setSelected(null)}>
              {t("بستن", "Close")}
            </Button>
          </>
        )}
      </Modal>
    </section>
  );
}
