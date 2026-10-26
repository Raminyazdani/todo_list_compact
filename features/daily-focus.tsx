"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Search, X } from "lucide-react";
import type {
  CommandName,
  DailyCapacityPreviewDTO,
  DailyFocusDTO,
  MutationResult,
  PageDTO,
  TaskDTO,
} from "@/shared/contracts";
import { clearQueryCache, useQuery } from "./api";
import { useLocale } from "./locale";
import { Button, QueryState } from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

export function DailyFocus({
  date,
  action,
  onOpen,
}: {
  date: string;
  action: Action;
  onOpen: (taskId: string) => void;
}) {
  const { t, language } = useLocale();
  const focus = useQuery<DailyFocusDTO>("daily_focus_get", { date });
  const inbox = useQuery<PageDTO<TaskDTO>>("task_search", {
    status: "Inbox",
    limit: 1,
  });
  const urgent = useQuery<PageDTO<TaskDTO>>("task_search", {
    priority: "Urgent",
    limit: 1,
  });
  const [search, setSearch] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [pendingSelection, setPendingSelection] = useState<{
    date: string;
    taskIds: string[];
    titles: string[];
  } | null>(null);
  const [capacityPeriod, setCapacityPeriod] = useState<"day" | "week">("day");
  const capacity = useQuery<DailyCapacityPreviewDTO>("daily_capacity_preview", {
    date,
    period: capacityPeriod,
  });
  const syncInFlight = useRef(false);
  const lastSyncAttempt = useRef(0);
  const [syncingCalendar, setSyncingCalendar] = useState(false);
  const [calendarSyncError, setCalendarSyncError] = useState("");
  const reconnectOnly =
    !!capacity.data?.calendar.source_issues.length &&
    capacity.data.calendar.source_issues.every(
      (issue) => issue.action === "reconnect",
    );
  async function syncCalendar(force: boolean) {
    if (document.visibilityState !== "visible" || syncInFlight.current) return;
    if (!force && Date.now() - lastSyncAttempt.current < 5 * 60_000) return;
    syncInFlight.current = true;
    lastSyncAttempt.current = Date.now();
    setSyncingCalendar(true);
    setCalendarSyncError("");
    try {
      const result = await action("calendar_sync_request", { force });
      if (!result) {
        setCalendarSyncError(
          t(
            "تازه‌سازی تقویم تأیید نشد. رویدادهای قبلی نمایش داده می‌شوند؛ دوباره تلاش کن یا وضعیت منابع را در تقویم ببین.",
            "Calendar refresh was not confirmed. Previously cached events remain visible; retry or check sources in Calendar.",
          ),
        );
      }
    } catch (cause) {
      setCalendarSyncError(
        cause instanceof Error
          ? cause.message
          : t("تازه‌سازی تقویم ناموفق بود.", "Calendar refresh failed."),
      );
    } finally {
      syncInFlight.current = false;
      setSyncingCalendar(false);
      capacity.refresh();
    }
  }
  const foregroundSync = useEffectEvent(() => {
    void syncCalendar(false);
  });
  useEffect(() => {
    if (
      capacity.data?.calendar.access !== "granted" ||
      !capacity.data.calendar.source_count ||
      reconnectOnly
    )
      return;
    const refresh = () => foregroundSync();
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 5 * 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, [
    capacity.data?.calendar.access,
    capacity.data?.calendar.source_count,
    reconnectOnly,
  ]);
  useEffect(() => {
    const timer = window.setTimeout(() => setSearchTerm(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const candidates = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    { search: searchTerm, limit: 12 },
    editing && searchTerm.length >= 2,
  );
  const selected = focus.data?.task_ids ?? [];
  const selectedTasks = new Map(
    focus.data?.items.map((task) => [task.task_id, task]),
  );
  async function save(taskIds: string[], preservedTitles?: string[]) {
    if (!focus.data || focus.fetching || saving) return;
    const titles =
      preservedTitles ??
      taskIds.map(
        (id) =>
          selectedTasks.get(id)?.title ??
          candidates.data?.items.find((task) => task.task_id === id)?.title ??
          t("کار انتخابی", "Selected task"),
      );
    setSaveError("");
    setSaving(true);
    try {
      const result = await action(
        "daily_focus_set",
        { date: focus.data.date, task_ids: taskIds },
        focus.data.revision,
      );
      if (result) {
        setPendingSelection(null);
        focus.refresh();
        return;
      }
      setPendingSelection({ date: focus.data.date, taskIds, titles });
      setSaveError(
        t(
          "تغییر تأیید نشد. انتخاب ذخیره‌نشدهٔ تو حفظ شده است؛ پس از دیدن فهرست تازه دربارهٔ اعمال دوباره تصمیم بگیر.",
          "The change was not confirmed. Your unsaved selection is preserved; review the latest list before applying it again.",
        ),
      );
      clearQueryCache();
      focus.refresh();
    } finally {
      setSaving(false);
    }
  }
  function move(index: number, delta: number) {
    const next = [...selected];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    void save(next);
  }
  const canEdit =
    !!focus.data && !focus.fetching && !saving && !pendingSelection;
  return (
    <section
      className="panel daily-focus"
      aria-label={t("تمرکز امروز", "Today's focus")}
    >
      <div className="daily-focus-heading">
        <div>
          <span className="eyebrow">{date} · Europe/Berlin</span>
          <h2>{t("تمرکز امروز", "Today's focus")}</h2>
          <p className="muted small">
            {t(
              "تا پنج کار را خودت انتخاب و مرتب کن؛ موعد و وضعیتشان تغییر نمی‌کند.",
              "Choose and order up to five tasks; their dates and status stay as they are.",
            )}
          </p>
        </div>
        <div className="form-actions">
          <span className="chip">{selected.length}/5</span>
          <Button
            disabled={!canEdit}
            onClick={() => setEditing((value) => !value)}
          >
            {editing
              ? t("بستن انتخاب", "Close picker")
              : t("انتخاب کار", "Choose tasks")}
          </Button>
        </div>
      </div>
      <QueryState {...focus} retry={focus.refresh} />
      {saveError && (
        <div className="warning daily-focus-conflict" role="alert">
          <p>{saveError}</p>
          {pendingSelection && (
            <>
              <p className="small">
                {t("انتخاب ذخیره‌نشده برای", "Unsaved selection for")}{" "}
                {pendingSelection.date}:{" "}
                {pendingSelection.titles.join(" · ") ||
                  t("بدون کار", "No tasks")}
              </p>
              {pendingSelection.date !== date && (
                <p className="small">
                  {t(
                    "روز برلین عوض شده است؛ انتخاب روز قبل به امروز اعمال نمی‌شود.",
                    "The Berlin day has changed; yesterday's selection cannot be applied to today.",
                  )}
                </p>
              )}
              <p className="small">
                {t("فهرست فعلی سرور", "Current server list")}:{" "}
                {focus.fetching
                  ? t(
                      "در حال دریافت نسخهٔ تازه…",
                      "Loading the latest version…",
                    )
                  : focus.data?.items.map((task) => task.title).join(" · ") ||
                    t("بدون کار", "No tasks")}
              </p>
              <div className="form-actions">
                <Button
                  disabled={
                    !focus.data ||
                    focus.fetching ||
                    saving ||
                    pendingSelection.date !== focus.data.date
                  }
                  onClick={() =>
                    void save(pendingSelection.taskIds, pendingSelection.titles)
                  }
                >
                  {t("اعمال دوباره پس از بررسی", "Apply again after review")}
                </Button>
                <Button
                  onClick={() => {
                    setPendingSelection(null);
                    setSaveError("");
                  }}
                >
                  {t(
                    "کنار گذاشتن انتخاب ذخیره‌نشده",
                    "Discard unsaved selection",
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      )}
      {focus.data && selected.length === 0 && (
        <p className="daily-focus-empty muted small">
          {t(
            "هنوز کاری برای امروز انتخاب نشده. از «انتخاب کار» شروع کن.",
            "No tasks chosen for today. Start with Choose tasks.",
          )}
        </p>
      )}
      {focus.data && selected.length > 0 && (
        <ol className="daily-focus-list">
          {selected.map((taskId, index) => {
            const task = selectedTasks.get(taskId);
            return (
              <li key={taskId}>
                <span className="daily-focus-number">{index + 1}</span>
                <button
                  className="daily-focus-task"
                  onClick={() => onOpen(taskId)}
                >
                  <strong>
                    {task?.title ?? t("کار در دسترس نیست", "Task unavailable")}
                  </strong>
                  {task && (
                    <small>
                      {task.status} · {task.priority}
                    </small>
                  )}
                </button>
                <div className="daily-focus-actions">
                  <button
                    className="icon-button"
                    disabled={!canEdit || index === 0}
                    aria-label={t(
                      `بالابردن ${task?.title ?? "کار"}`,
                      `Move ${task?.title ?? "task"} up`,
                    )}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={15} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={!canEdit || index === selected.length - 1}
                    aria-label={t(
                      `پایین‌بردن ${task?.title ?? "کار"}`,
                      `Move ${task?.title ?? "task"} down`,
                    )}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={15} />
                  </button>
                  <button
                    className="icon-button"
                    disabled={!canEdit}
                    aria-label={t(
                      `برداشتن ${task?.title ?? "کار"} از تمرکز امروز`,
                      `Remove ${task?.title ?? "task"} from today's focus`,
                    )}
                    onClick={() =>
                      void save(selected.filter((id) => id !== taskId))
                    }
                  >
                    <X size={15} />
                  </button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
      {editing && (
        <div className="daily-focus-picker">
          <label className="daily-focus-search">
            <Search size={16} />
            <span className="sr-only">
              {t("جست‌وجوی کار برای امروز", "Search tasks for today")}
            </span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("نام کار را بنویس…", "Type a task name…")}
            />
          </label>
          {searchTerm.length >= 2 && (
            <QueryState {...candidates} retry={candidates.refresh} />
          )}
          {searchTerm.length >= 2 &&
            candidates.data?.items
              .filter(
                (task) => !task.archived_at && task.status !== "Cancelled",
              )
              .map((task) => (
                <button
                  className="daily-focus-candidate"
                  key={task.task_id}
                  disabled={
                    !canEdit ||
                    selected.includes(task.task_id) ||
                    selected.length >= 5
                  }
                  onClick={() => void save([...selected, task.task_id])}
                >
                  <span>{task.title}</span>
                  <small>
                    {selected.includes(task.task_id)
                      ? t("انتخاب شده", "Selected")
                      : task.readiness}
                  </small>
                </button>
              ))}
          {searchTerm.length >= 2 && candidates.data?.items.length === 0 && (
            <p className="muted small">
              {t("کاری پیدا نشد.", "No tasks found.")}
            </p>
          )}
          <Link className="text-link" href="/tasks">
            {t("مرور همهٔ کارها", "Browse all tasks")}
          </Link>
        </div>
      )}
      <div className="daily-focus-triage">
        <Link href="/tasks?filter=Inbox">
          <strong>
            {t("صندوق ورودی", "Inbox")} · {inbox.data?.total ?? "—"}
          </strong>
          <small>
            {inbox.data?.items[0]?.next_action ||
              t("کارهای ثبت‌شده را مرور کن", "Review captured tasks")}
          </small>
        </Link>
        <Link href="/tasks?priority=Urgent">
          <strong>
            {t("اولویت فوری", "Urgent priority")} · {urgent.data?.total ?? "—"}
          </strong>
          <small>
            {urgent.data?.items[0]?.next_action ||
              t("اقدام بعدی را مشخص کن", "Clarify the next action")}
          </small>
        </Link>
      </div>
      <div className="daily-capacity">
        <div className="daily-capacity-heading">
          <strong>{t("تصویر فشار زمانی", "Time load preview")}</strong>
          <div
            className="tabs"
            role="group"
            aria-label={t("بازهٔ فشار زمانی", "Time load period")}
          >
            <button
              className={capacityPeriod === "day" ? "active" : ""}
              onClick={() => setCapacityPeriod("day")}
            >
              {t("روز", "Day")}
            </button>
            <button
              className={capacityPeriod === "week" ? "active" : ""}
              onClick={() => setCapacityPeriod("week")}
            >
              {t("هفته", "Week")}
            </button>
          </div>
        </div>
        <QueryState {...capacity} retry={capacity.refresh} />
        {capacity.data && (
          <>
            <div className="daily-capacity-values">
              <span>
                {t(
                  "برآورد ثبت‌شدهٔ کارهای انتخابی",
                  "Recorded estimates for selected tasks",
                )}{" "}
                <strong>
                  {formatMinutes(
                    capacity.data.focus.registered_estimate_minutes,
                  )}
                </strong>
              </span>
              <span>
                {t("بازه‌های مشغول ثبت‌شده", "Recorded busy intervals")}{" "}
                <strong>
                  {capacity.data.known_busy_minutes === null
                    ? "—"
                    : formatMinutes(capacity.data.known_busy_minutes)}
                </strong>
              </span>
            </div>
            <p className="small muted">
              {capacity.data.calendar.access === "granted" &&
              capacity.data.calendar.source_count === 0
                ? capacity.data.work.access === "granted"
                  ? t(
                      "هیچ منبع تقویم خارجی فعالی نیست؛ عدد مشغولی فقط از رویدادهای محلی و ساعات کار ثبت‌شده محاسبه شده است.",
                      "No external calendar source is active; busy time uses only local events and recorded work intervals.",
                    )
                  : t(
                      "هیچ منبع تقویم خارجی فعالی نیست؛ عدد مشغولی فقط از رویدادهای محلیِ در دسترس محاسبه شده است.",
                      "No external calendar source is active; busy time uses only available local events.",
                    )
                : capacity.data.busy_coverage === "complete"
                  ? t(
                      "پوشش منابع متصل کامل است.",
                      "Connected sources have complete coverage.",
                    )
                  : capacity.data.busy_coverage === "partial"
                    ? t(
                        "پوشش منابع ناقص است؛ عدد مشغولی فقط بخش شناخته‌شده را نشان می‌دهد.",
                        "Source coverage is partial; busy time shows known intervals only.",
                      )
                    : t(
                        "پوشش مشغولی نامشخص است؛ از این عدد برای تصمیم قطعی استفاده نکن.",
                        "Busy coverage is unknown; do not treat this as a complete load.",
                      )}
              {capacity.data.focus.unknown_estimate_task_ids.length > 0 && (
                <>
                  {" "}
                  · {capacity.data.focus.unknown_estimate_task_ids.length}{" "}
                  {t(
                    "کارِ انتخابی بدون برآورد",
                    "selected tasks without estimates",
                  )}
                </>
              )}
              {capacity.data.focus.archived_selected_task_count > 0 && (
                <>
                  {" "}
                  · {capacity.data.focus.archived_selected_task_count}{" "}
                  {t(
                    "کار بایگانی‌شدهٔ انتخابی در برآورد نیست",
                    "selected archived tasks excluded from estimates",
                  )}
                </>
              )}
              {capacity.data.focus.repeated_task_ids.length > 0 && (
                <>
                  {" "}
                  · {capacity.data.focus.repeated_task_ids.length}{" "}
                  {t(
                    "کار تکراری در انتخاب‌های هفته",
                    "task repeated across the week",
                  )}
                </>
              )}
            </p>
            {capacity.data.calendar.access === "granted" &&
              capacity.data.calendar.source_count === 0 && (
                <p className="small muted">
                  <Link href="/calendar" className="text-link">
                    {t("مدیریت منابع تقویم", "Manage calendar sources")}
                  </Link>{" "}
                  ·{" "}
                  <Link href="/settings" className="text-link">
                    {t("تنظیم اتصال Google", "Google connection settings")}
                  </Link>
                </p>
              )}
            {capacity.data.calendar.source_issues.length > 0 && (
              <div className="warning small" role="status">
                <ul>
                  {capacity.data.calendar.source_issues
                    .slice(0, 2)
                    .map((issue, index) => (
                      <li key={`${issue.source_title}-${issue.code}-${index}`}>
                        {capacityIssueLabel(issue, t)}{" "}
                        {capacityIssueDetail(issue, t, language)}
                      </li>
                    ))}
                </ul>
                {capacity.data.calendar.source_issues.length > 2 && (
                  <details>
                    <summary>
                      {t(
                        `${capacity.data.calendar.source_issues.length - 2} مشکل دیگر منابع`,
                        `${capacity.data.calendar.source_issues.length - 2} more source issues`,
                      )}
                    </summary>
                    <ul>
                      {capacity.data.calendar.source_issues
                        .slice(2)
                        .map((issue, index) => (
                          <li
                            key={`${issue.source_title}-${issue.code}-${index}`}
                          >
                            {capacityIssueLabel(issue, t)}{" "}
                            {capacityIssueDetail(issue, t, language)}
                          </li>
                        ))}
                    </ul>
                  </details>
                )}
                <div className="form-actions">
                  <Button
                    disabled={syncingCalendar}
                    onClick={() => void syncCalendar(true)}
                  >
                    {syncingCalendar
                      ? t("در حال تازه‌سازی…", "Refreshing…")
                      : t("تازه‌سازی تقویم‌ها", "Refresh calendars")}
                  </Button>
                  <Link
                    href={
                      capacity.data.calendar.source_issues.some(
                        (issue) => issue.code === "SOURCE_CONFIG_UNREADABLE",
                      )
                        ? "/calendar?manage_sources=1"
                        : "/calendar"
                    }
                    className="text-link"
                  >
                    {capacity.data.calendar.source_issues.some(
                      (issue) => issue.code === "SOURCE_CONFIG_UNREADABLE",
                    )
                      ? t("مدیریت منابع", "Manage sources")
                      : t("جزئیات منابع", "Source details")}
                  </Link>
                  {capacity.data.calendar.source_issues.some(
                    (issue) => issue.action === "reconnect",
                  ) && (
                    <Link href="/settings" className="text-link">
                      {t("تنظیمات اتصال", "Connection settings")}
                    </Link>
                  )}
                </div>
              </div>
            )}
            {calendarSyncError && (
              <p className="error small" role="alert">
                {calendarSyncError}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function formatMinutes(minutes: number): string {
  const rounded = Math.max(0, Math.round(minutes));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
}

type CapacityIssue =
  DailyCapacityPreviewDTO["calendar"]["source_issues"][number];

function capacityIssueLabel(
  issue: CapacityIssue,
  t: (fa: string, en: string) => string,
): string {
  const source =
    issue.source_title || t("یکی از منابع تقویم", "a calendar source");
  switch (issue.code) {
    case "SOURCE_COVERAGE_INCOMPLETE":
      return t(
        `پوشش رویدادهای «${source}» ناقص است.`,
        `${source} has incomplete event coverage.`,
      );
    case "SOURCE_NOT_SYNCED":
      return t(
        `«${source}» هنوز همگام‌سازی نشده است.`,
        `${source} has not synced yet.`,
      );
    case "SOURCE_SYNC_IN_PROGRESS":
      return t(
        `همگام‌سازی «${source}» هنوز کامل نشده است.`,
        `${source} is still syncing.`,
      );
    case "SOURCE_STALE":
      return t(
        `رویدادهای «${source}» پس از آخرین دریافت موفق تازه نشده‌اند؛ رویدادهای جدید ممکن است در تداخل‌ها نباشند.`,
        `Events from ${source} have not refreshed since the last successful sync; newer events may be missing from conflicts.`,
      );
    case "SOURCE_RATE_LIMITED":
    case "SOURCE_RETRY_AFTER":
      return t(
        `سرویس «${source}» موقتاً درخواست تازه را محدود کرده است.`,
        `The provider for ${source} is temporarily rate limiting refreshes.`,
      );
    case "GOOGLE_GRANT_REQUIRED":
    case "GOOGLE_GRANT_REVOKED":
    case "GOOGLE_REFRESH_TOKEN_EXPIRED":
    case "GOOGLE_CALENDAR_PERMISSION_MISSING":
    case "ACCESS_REVOKED":
      return t(
        `مجوز «${source}» در دسترس نیست؛ اتصال را در تنظیمات دوباره برقرار کن.`,
        `Permission for ${source} is unavailable; reconnect it in Settings.`,
      );
    case "GOOGLE_SOURCE_ACCESS_REMOVED":
      return t(
        `«${source}» دیگر در حساب Google متصل در دسترس نیست.`,
        `${source} is no longer accessible in the connected Google account.`,
      );
    case "GOOGLE_TOKEN_UNAVAILABLE":
      return t(
        `دریافت مجوز موقت Google برای «${source}» ناموفق بود؛ دوباره تلاش کن.`,
        `The temporary Google token for ${source} could not be obtained; retry.`,
      );
    case "GOOGLE_CALENDAR_API_NOT_ENABLED":
      return t(
        `Google Calendar API برای «${source}» فعال نیست؛ تنظیمات Google Cloud را بررسی کن.`,
        `Google Calendar API is not enabled for ${source}; check Google Cloud settings.`,
      );
    case "ICAL_TIMEOUT":
      return t(
        `فید «${source}» به‌موقع پاسخ نداد.`,
        `The feed for ${source} timed out.`,
      );
    case "ICAL_HTTP_ERROR":
      return t(
        `سرور فید «${source}» پاسخ موفق نداد؛ نشانی و دسترسی فید را بررسی کن.`,
        `The feed for ${source} returned an error; check its address and access.`,
      );
    case "ICAL_TRANSPORT_ERROR":
      return t(
        `ارتباط شبکه با فید «${source}» برقرار نشد.`,
        `The network connection to ${source} failed.`,
      );
    case "ICAL_FEED_TOO_LARGE":
      return t(
        `فید «${source}» از حد مجاز بزرگ‌تر است.`,
        `The feed for ${source} exceeds the supported size.`,
      );
    case "SOURCE_CONFIG_UNREADABLE":
      return t(
        `تنظیمات «${source}» قابل خواندن نیست؛ آن را در مدیریت منابع دوباره تنظیم کن.`,
        `Settings for ${source} cannot be read; reconfigure it in Manage sources.`,
      );
    case "SOURCE_READ_FAILED":
      return t(
        `خواندن «${source}» ناموفق بود؛ رویدادهای سالم قبلی حفظ شده‌اند.`,
        `Reading ${source} failed; previously cached events remain available.`,
      );
    case "CACHE_EXPANSION_FAILED":
      return t(
        `خواندن داده‌های «${source}» ناموفق بود.`,
        `Stored events from ${source} could not be read.`,
      );
    case "SELECTED_SOURCE_UNAVAILABLE":
      return t(
        "یکی از منابع انتخاب‌شدهٔ تقویم در دسترس نیست.",
        "A selected calendar source is unavailable.",
      );
    default:
      return t(
        `وضعیت «${source}» نیاز به بررسی دارد.`,
        `${source} needs a connection check.`,
      );
  }
}

function capacityIssueDetail(
  issue: CapacityIssue,
  t: (fa: string, en: string) => string,
  language: string,
): string {
  const details: string[] = [];
  const format = (value: string) =>
    new Date(value).toLocaleString(
      language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
      { timeZone: "Europe/Berlin" },
    );
  if (issue.last_success_at && !Number.isNaN(Date.parse(issue.last_success_at)))
    details.push(
      t("آخرین دریافت موفق:", "Last successful sync:") +
        " " +
        format(issue.last_success_at),
    );
  else
    details.push(
      t(
        "هنوز دریافت موفقی ثبت نشده است.",
        "No successful sync has been recorded yet.",
      ),
    );
  if (issue.next_attempt_at && !Number.isNaN(Date.parse(issue.next_attempt_at)))
    details.push(
      t(
        "امکان تلاش دوباره از این زمان، هنگام استفاده از برنامه:",
        "Retry allowed after this time while the app is open:",
      ) +
        " " +
        format(issue.next_attempt_at),
    );
  else if (issue.action === "wait")
    details.push(
      t(
        "وضعیت هنگام استفاده از برنامه دوباره بررسی می‌شود.",
        "The status will be checked again while the app is open.",
      ),
    );
  return details.join(" · ");
}
