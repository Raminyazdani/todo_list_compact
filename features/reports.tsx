"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type {
  ReportsDTO,
  AnalyticsTrendsDTO,
  ActivityDTO,
  PageDTO,
  ReportRangeDTO,
} from "@/shared/contracts";
import {
  addCalendarDays,
  instantToLocalDate,
  zonedLocalToInstant,
} from "@/shared/datetime";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import { Trends } from "./trends";
import { activityLabel } from "./activity-labels";
import {
  Button,
  Empty,
  Field,
  Progress,
  QueryState,
  SectionHeading,
} from "@/components/ui";

type Analytics = {
  tasks: { total: number; done: number };
  time: { minutes: number };
  files: { total: number };
  projects: unknown[];
  trends?: AnalyticsTrendsDTO;
  range?: ReportRangeDTO;
};

export function FullReports() {
  const { t, language } = useLocale();
  const [day, setDay] = useState(() => instantToLocalDate(Date.now()));
  useEffect(() => {
    const timer = window.setInterval(
      () => setDay(instantToLocalDate(Date.now())),
      60000,
    );
    return () => window.clearInterval(timer);
  }, []);
  const defaultRange = {
    from_date: addCalendarDays(day, -84),
    to_date: addCalendarDays(day, 1),
    timezone: "Europe/Berlin",
  };
  const [customRange, setCustomRange] = useState<typeof defaultRange | null>(
    null,
  );
  const range = customRange ?? defaultRange;
  const [draftRange, setDraftRange] = useState<typeof defaultRange | null>(
    null,
  );
  const displayedRange = draftRange ?? range;
  const [cursor, setCursor] = useState<string | null>(null);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [error, setError] = useState("");
  const data = useQuery<Analytics>("analytics_summary", { ...range });
  const reports = useQuery<ReportsDTO>("reports_summary", {
    ...range,
    limit: 50,
    cursor,
  });
  const activity = useQuery<PageDTO<ActivityDTO>>("get_activity", {
    limit: 50,
    cursor: activityCursor,
  });
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("از قدم‌هایت یاد بگیر", "LEARN FROM YOUR MOMENTUM")}
          </div>
          <h1>{t("گزارش و مرور", "Reports & review")}</h1>
          <p>
            {t(
              "اعداد واقعی برای انتخاب قدم بعدی",
              "Real numbers to guide your next step",
            )}
          </p>
        </div>
      </div>
      <form
        className="filter-bar"
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          const form = new FormData(event.currentTarget);
          const next = {
            from_date: String(form.get("from_date")),
            to_date: String(form.get("to_date")),
            timezone: String(form.get("timezone")),
          };
          try {
            const from = Date.parse(
                zonedLocalToInstant(`${next.from_date}T00:00`, next.timezone),
              ),
              to = Date.parse(
                zonedLocalToInstant(`${next.to_date}T00:00`, next.timezone),
              );
            if (to <= from || to - from > 366 * 86400000)
              throw new Error(
                t(
                  "بازه باید مثبت و حداکثر یک سال باشد",
                  "Range must be ordered and at most one year",
                ),
              );
            setCustomRange(next);
            setDraftRange(null);
            setCursor(null);
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <Field label={t("شروع بازهٔ گزارش", "Report range starts")}>
          <input
            type="date"
            name="from_date"
            value={displayedRange.from_date}
            onChange={(event) =>
              setDraftRange({
                ...displayedRange,
                from_date: event.target.value,
              })
            }
            required
          />
        </Field>
        <Field
          label={t(
            "پایان بازهٔ گزارش (شامل نمی‌شود)",
            "Report range ends (exclusive)",
          )}
        >
          <input
            type="date"
            name="to_date"
            value={displayedRange.to_date}
            onChange={(event) =>
              setDraftRange({ ...displayedRange, to_date: event.target.value })
            }
            required
          />
        </Field>
        <Field label={t("منطقهٔ زمانی گزارش", "Report timezone")}>
          <input
            name="timezone"
            value={displayedRange.timezone}
            onChange={(event) =>
              setDraftRange({ ...displayedRange, timezone: event.target.value })
            }
            required
            list="report-zones"
          />
          <datalist id="report-zones">
            <option value="Europe/Berlin" />
            <option value="Asia/Tehran" />
            <option value="UTC" />
          </datalist>
        </Field>
        <Button type="submit">{t("نمایش این بازه", "Show this range")}</Button>
      </form>
      {error && (
        <p className="warning" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        {t(
          "روند فعالیت و زمان انجام‌شده مربوط به بازهٔ انتخابی‌اند؛ شمار کارها و فایل‌ها تصویر فعلی فضای شماست.",
          "Activity and worked time use the selected range; task and file counts describe the current workspace.",
        )}{" "}
        {range.timezone}
      </p>
      <QueryState {...data} retry={data.refresh} />
      <div className="metric-grid">
        <div className="metric-card">
          <span>{t("کار تکمیل‌شده", "Completed tasks")}</span>
          <strong>{data.data?.tasks.done ?? "—"}</strong>
          <Progress
            label={t("نسبت کارهای تکمیل‌شده", "Completed task progress")}
            value={data.data?.tasks.done ?? 0}
            max={data.data?.tasks.total ?? 0}
          />
        </div>
        <div className="metric-card">
          <span>{t("ساعت ثبت‌شدهٔ بازه", "Recorded hours in range")}</span>
          <strong>
            {data.data ? Math.round(data.data.time.minutes / 6) / 10 : "—"}
          </strong>
        </div>
        <div className="metric-card">
          <span>{t("منابع ثبت‌شده", "Registered files")}</span>
          <strong>{data.data?.files.total ?? "—"}</strong>
        </div>
        <div className="metric-card">
          <span>{t("پروژه‌ها", "Projects")}</span>
          <strong>{data.data?.projects.length ?? "—"}</strong>
        </div>
      </div>
      {data.data?.trends && <Trends trends={data.data.trends} />}
      <QueryState {...reports} retry={reports.refresh} />
      {reports.data && (
        <>
          <section className="panel">
            <SectionHeading
              title={t("سن مهلت‌های عقب‌افتاده", "Overdue ageing")}
            />
            <p className="small muted">
              {t("تا تاریخ", "As of")} {reports.data.overdue_ageing.as_of_date}{" "}
              · {reports.data.overdue_ageing.total} {t("کار باز", "open tasks")}
            </p>
            <div className="metric-grid">
              {reports.data.overdue_ageing.buckets.map((bucket) => (
                <div className="metric-card" key={bucket.key}>
                  <span>
                    {bucket.min_days}–{bucket.max_days ?? "∞"}{" "}
                    {t("روز", "days")}
                  </span>
                  <strong>{bucket.count}</strong>
                </div>
              ))}
            </div>
            {reports.data.overdue_ageing.items.items.map((task) => (
              <div className="dependency-row" key={task.task_id}>
                <Link
                  className="text-link"
                  href={`/tasks?search=${encodeURIComponent(task.title)}`}
                >
                  {task.title}
                </Link>
                <time>{task.due_local_date}</time>
                <span>
                  {task.overdue_days} {t("روز گذشته", "days overdue")}
                </span>
              </div>
            ))}
            <div className="form-actions">
              {cursor && (
                <Button onClick={() => setCursor(null)}>
                  {t("ابتدای مهلت‌ها", "First deadlines")}
                </Button>
              )}
              {reports.data.overdue_ageing.items.next_cursor && (
                <Button
                  onClick={() =>
                    setCursor(reports.data!.overdue_ageing.items.next_cursor)
                  }
                >
                  {t("مهلت‌های بیشتر", "More deadlines")}
                </Button>
              )}
            </div>
          </section>
          <section className="panel">
            <SectionHeading
              title={t("حجم فایل‌های ثبت‌شده", "Registered file sizes")}
            />
            {reports.data.registered_files ? (
              <>
                <p>
                  {reports.data.registered_files.total} {t("فایل", "files")} ·{" "}
                  <span dir="ltr">
                    {BigInt(
                      reports.data.registered_files.known_size_bytes,
                    ).toLocaleString(
                      language === "fa" ? "fa-IR" : "en-GB",
                    )}{" "}
                    bytes
                  </span>
                </p>
                <p className="muted small">
                  {reports.data.registered_files.unknown_size_count}{" "}
                  {t(
                    "فایل اندازهٔ مشخص ندارد. این عدد فقط رکوردهای همین برنامه است؛ سهمیهٔ حساب ذخیره‌ساز را نشان نمی‌دهد.",
                    "files have unknown size. These values cover this app's records; provider account quota is unavailable.",
                  )}
                </p>
                {reports.data.registered_files.by_source.map((source) => (
                  <div className="dependency-row" key={source.source}>
                    <strong>{source.source}</strong>
                    <span>
                      {source.total} {t("فایل", "files")}
                    </span>
                    <span dir="ltr">
                      {BigInt(source.known_size_bytes).toLocaleString()} bytes
                    </span>
                    <span>
                      {source.unknown_size_count}{" "}
                      {t("اندازهٔ نامشخص", "unknown sizes")}
                    </span>
                  </div>
                ))}
              </>
            ) : (
              <Empty
                title={t(
                  "مجوز آمار فایل‌ها موجود نیست",
                  "File statistics scope unavailable",
                )}
              />
            )}
          </section>
          <section className="panel">
            <SectionHeading
              title={t(
                "نامزدهای تکراری با هش تأییدشده",
                "Verified checksum duplicate candidates",
              )}
            />
            {reports.data.duplicate_candidates ? (
              <>
                <p className="small muted">
                  {reports.data.duplicate_candidates.total_groups}{" "}
                  {t(
                    "گروه با بایت‌های همسان",
                    "groups with matching verified bytes",
                  )}{" "}
                  ·{" "}
                  {reports.data.duplicate_candidates.excluded_unverified_count}{" "}
                  {t(
                    "مرجع بدون هش تأییدشده وارد مقایسه نشده است.",
                    "unverified references are excluded.",
                  )}
                </p>
                {reports.data.duplicate_candidates.groups.map((group) => (
                  <div className="comment-card" key={group.sha256}>
                    <strong>
                      {group.file_count} {t("فایل", "files")} ·{" "}
                      {group.size_bytes} bytes
                    </strong>
                    <code
                      className="small"
                      style={{ overflowWrap: "anywhere" }}
                    >
                      {group.sha256}
                    </code>
                    <div className="form-actions">
                      {group.files.map((file) => (
                        <Link
                          className="button"
                          key={file.file_id}
                          href={`/files?file=${encodeURIComponent(file.file_id)}`}
                        >
                          {file.title}
                        </Link>
                      ))}
                    </div>
                    {group.truncated && (
                      <p className="warning">
                        {t(
                          "۲۰ رکورد نخست گروه نمایش داده شده است.",
                          "The first 20 records of this group are displayed.",
                        )}
                      </p>
                    )}
                  </div>
                ))}
                {!reports.data.duplicate_candidates.total_groups && (
                  <Empty
                    title={t(
                      "گروه تکراری تأییدشده‌ای نیست",
                      "No verified duplicate group",
                    )}
                  />
                )}{" "}
                {reports.data.duplicate_candidates.truncated && (
                  <p className="warning">
                    {t(
                      "فهرست گروه‌ها محدود شده است.",
                      "The group list is bounded.",
                    )}
                  </p>
                )}
              </>
            ) : (
              <Empty
                title={t(
                  "مجوز مقایسهٔ فایل‌ها موجود نیست",
                  "File comparison scope unavailable",
                )}
              />
            )}
          </section>
        </>
      )}
      <section className="panel">
        <SectionHeading title={t("تاریخچهٔ تغییرها", "Activity history")} />
        <QueryState {...activity} retry={activity.refresh} />
        {activity.data?.items.map((event) => (
          <div className="dependency-row" key={event.event_id}>
            <strong>{activityLabel(event.event_type, language)}</strong>
            <span className="chip">{event.channel}</span>
            <time>
              {new Date(event.occurred_at).toLocaleString(
                language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                { timeZone: range.timezone },
              )}
            </time>
          </div>
        ))}
        <div className="form-actions">
          {activityCursor && (
            <Button onClick={() => setActivityCursor(null)}>
              {t("ابتدای تاریخچه", "First activity")}
            </Button>
          )}
          {activity.data?.next_cursor && (
            <Button
              onClick={() => setActivityCursor(activity.data!.next_cursor)}
            >
              {t("تاریخچهٔ بیشتر", "More activity")}
            </Button>
          )}
        </div>
      </section>
    </>
  );
}
