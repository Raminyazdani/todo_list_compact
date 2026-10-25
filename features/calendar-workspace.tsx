"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw } from "lucide-react";
import type {
  CalendarSourceDTO,
  CommandName,
  MutationResult,
} from "@/shared/contracts";
import { instantToLocalDate } from "@/shared/datetime";
import type { HolidayRegion } from "@/server/integrations/holidays";
import { Button, Field, Modal, QueryState } from "@/components/ui";
import { CalendarView } from "./calendar";
import { WorkPlanner } from "./work-planner";
import { useQuery } from "./api";
import { useLocale } from "./locale";

export type CalendarAction = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

export function CalendarWorkspace({
  action,
  onOpen,
  initialWork = false,
}: {
  action: CalendarAction;
  onOpen: (id: string) => void;
  initialWork?: boolean;
}) {
  const { t } = useLocale();
  const router = useRouter();
  const params = useSearchParams();
  const work = initialWork || params.get("tab") === "work";
  const [date, setDate] = useState(() =>
    /^\d{4}-\d{2}-\d{2}$/.test(params.get("date") ?? "")
      ? params.get("date")!
      : instantToLocalDate(new Date().toISOString(), "Europe/Berlin"),
  );
  const [region, setRegion] = useState<HolidayRegion | null>(null);
  const [calendarId, setCalendarId] = useState(params.get("source") ?? "");
  const [external, setExternal] = useState(params.get("external") !== "0");
  function switchTab(tab: string) {
    const next = new URLSearchParams({
      tab,
      date,
      ...(calendarId ? { source: calendarId } : {}),
      ...(external ? {} : { external: "0" }),
    });
    router.push(`/calendar?${next}`);
  }
  return (
    <>
      <div
        className="tabs calendar-workspace-tabs"
        role="tablist"
        aria-label={t("فضای تقویم", "Calendar workspace")}
      >
        <button
          role="tab"
          aria-selected={!work}
          className={!work ? "active" : ""}
          onClick={() => switchTab("calendar")}
        >
          {t("تقویم", "Calendar")}
        </button>
        <button
          role="tab"
          aria-selected={work}
          className={work ? "active" : ""}
          onClick={() => switchTab("work")}
        >
          {t("ساعات کار", "Work time")}
        </button>
      </div>
      <CalendarSources action={action} />
      {work ? (
        <WorkPlanner
          action={action}
          date={date}
          onDate={setDate}
          region={region}
          onRegion={setRegion}
          calendarId={calendarId}
          onCalendar={setCalendarId}
          showExternal={external}
          onExternal={setExternal}
        />
      ) : (
        <CalendarView
          action={action}
          onOpen={onOpen}
          shared={{
            date,
            onDate: setDate,
            region,
            onRegion: setRegion,
            calendarId,
            onCalendar: setCalendarId,
            showExternal: external,
            onExternal: setExternal,
          }}
        />
      )}
    </>
  );
}

/** Provider traffic is explicitly foreground only. Cache reads have no provider side effects. */
function CalendarSources({ action }: { action: CalendarAction }) {
  const { t, language } = useLocale();
  const sources = useQuery<{
    items: CalendarSourceDTO[];
    complete?: boolean;
    status?: string;
  }>("calendar_sync_status");
  const operations = useQuery<{
    items: {
      operation_id: string;
      source_id: string;
      action: string;
      state: string;
      last_error: string | null;
      payload?: {
        title?: string;
        starts_at?: string;
        ends_at?: string;
        notes?: string;
      };
    }[];
  }>("calendar_operation_status");
  const unresolved = (operations.data?.items ?? []).filter(
    (operation) => !["confirmed", "succeeded"].includes(operation.state),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configure, setConfigure] = useState(false);
  const inFlight = useRef(false);
  async function sync(force: boolean) {
    if (inFlight.current || document.visibilityState !== "visible") return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await action("calendar_sync_request", { force });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
      sources.refresh();
    }
  }
  const foregroundSync = useEffectEvent(() => {
    void sync(false);
  });
  useEffect(() => {
    const refresh = () => {
      foregroundSync();
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 5 * 60 * 1000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, []);
  return (
    <section
      className="calendar-source-status"
      aria-label={t("همگام‌سازی تقویم", "Calendar synchronization")}
    >
      <div className="form-actions">
        <Button disabled={busy} onClick={() => void sync(true)}>
          <RefreshCw size={15} className={busy ? "spin" : ""} />
          {t("تازه‌سازی تقویم‌ها", "Refresh calendars")}
        </Button>
        <Button onClick={() => setConfigure(true)}>
          {t("مدیریت منابع", "Manage sources")}
        </Button>
        <span className="small muted">
          {t(
            "هنگام استفاده، هر ۵ دقیقه و هنگام بازگشت",
            "While active, every 5 minutes and on return",
          )}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <QueryState {...sources} retry={sources.refresh} />
      {sources.data &&
        !sources.data.items.some(
          (source) => source.enabled && source.provider === "google_calendar",
        ) && (
          <p className="small muted">
            {t(
              "تقویم Google فعالی در برنامه دیده نمی‌شود. اتصال و مجوز همین برنامه را در تنظیمات بررسی کن، سپس تازه‌سازی را بزن.",
              "No active Google calendar is available in this app. Check this app's connection and permission in Settings, then refresh.",
            )}{" "}
            <Link href="/settings">
              {t("تنظیمات اتصال", "Connection settings")}
            </Link>
          </p>
        )}
      <div className="calendar-source-chips">
        {sources.data?.items
          .filter((source) => source.enabled)
          .map((source) => (
            <span
              className={`chip ${source.status === "error" || source.last_error ? "orange" : ""}`}
              key={source.source_id}
            >
              {source.title} · {source.status ?? t("در انتظار", "Pending")} ·{" "}
              {source.last_success_at
                ? new Date(source.last_success_at).toLocaleString(
                    language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                    { timeZone: "Europe/Berlin" },
                  )
                : t("هنوز همگام نشده", "Not synced yet")}
              {source.enabled &&
                source.coverage.complete !== true &&
                ` · ${t("پوشش ناقص", "Incomplete coverage")}`}
            </span>
          ))}
      </div>
      {!!unresolved.length && (
        <details className="calendar-pending-operations">
          <summary>
            {unresolved.length}{" "}
            {t(
              "تغییر تقویم در انتظار بررسی یا تأیید",
              "calendar changes awaiting review or confirmation",
            )}
          </summary>
          {unresolved.map((operation) => (
            <details key={operation.operation_id}>
              <summary>
                {sources.data?.items.find(
                  (source) => source.source_id === operation.source_id,
                )?.title ?? t("تقویم متصل", "Connected calendar")}{" "}
                ·{" "}
                {operation.action === "create"
                  ? t("ایجاد", "Create")
                  : operation.action === "delete"
                    ? t("حذف", "Delete")
                    : t("ویرایش", "Update")}{" "}
                · {operation.state}
              </summary>
              {operation.payload && (
                <>
                  <strong>{operation.payload.title}</strong>
                  <p dir="ltr">
                    {operation.payload.starts_at} → {operation.payload.ends_at}
                  </p>
                  <p className="preserve-lines">{operation.payload.notes}</p>
                </>
              )}
              {operation.last_error && (
                <p className="warning">
                  {t(
                    "تغییر هنوز از Google تأیید نشده؛ در تعارض، نسخهٔ تازه را با پیشنهاد ذخیره‌شده مقایسه کن.",
                    "Google has not confirmed this change. For a conflict, compare the current event with the saved proposal.",
                  )}
                </p>
              )}
              <Button disabled={busy} onClick={() => void sync(true)}>
                {t(
                  "بررسی دوبارهٔ همین عملیات",
                  "Check the same operation again",
                )}
              </Button>
            </details>
          ))}
        </details>
      )}
      <Modal
        title={t("منابع تقویم", "Calendar sources")}
        open={configure}
        onOpenChange={setConfigure}
        wide
      >
        <p className="muted small">
          {t(
            "اتصال Google از تنظیمات انجام می‌شود. منابع iCal فقط خواندنی‌اند؛ نشانی خصوصی آن‌ها در سرور نگه‌داری می‌شود.",
            "Connect Google in Settings. iCal sources are read-only; private feed addresses remain on the server.",
          )}
        </p>
        <Link className="button" href="/settings">
          {t("تنظیم اتصال Google", "Google connection settings")}
        </Link>
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const values = new FormData(form);
            setError("");
            try {
              const result = await action("calendar_source_configure", {
                provider: "ical",
                title: String(values.get("title")),
                timezone: String(values.get("timezone")),
                url: String(values.get("url")),
              });
              if (result) {
                form.reset();
                await sync(true);
              }
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          <Field label={t("نام منبع", "Source name")}>
            <input required name="title" maxLength={200} />
          </Field>
          <Field label={t("نشانی خصوصی iCal", "Private iCal address")}>
            <input
              name="url"
              required
              type="password"
              autoComplete="off"
              placeholder="https://…"
            />
          </Field>
          <Field label={t("منطقهٔ زمانی", "Time zone")}>
            <input required name="timezone" defaultValue="Europe/Berlin" />
          </Field>
          <Button type="submit">
            {t("افزودن منبع و همگام‌سازی", "Add source and synchronize")}
          </Button>
        </form>
        <div className="calendar-source-list">
          {sources.data?.items.map((source) => (
            <div className="dependency-row" key={source.source_id}>
              <span>
                {source.title} · {source.status}
              </span>
              <Button
                onClick={async () => {
                  await action(
                    source.enabled
                      ? "calendar_source_disconnect"
                      : "calendar_source_configure",
                    source.enabled
                      ? { source_id: source.source_id }
                      : {
                          source_id: source.source_id,
                          provider: source.provider,
                          title: source.title,
                          timezone: source.timezone,
                        },
                    source.revision,
                  );
                  sources.refresh();
                }}
              >
                {source.enabled
                  ? t("قطع اتصال این منبع", "Disconnect this source")
                  : t("اتصال دوبارهٔ این منبع", "Reconnect this source")}
              </Button>
            </div>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </Modal>
    </section>
  );
}
