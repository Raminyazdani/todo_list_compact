"use client";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Clock3 } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import {
  dayFlags,
  HOLIDAY_REGIONS,
  type HolidayRegion,
} from "@/server/integrations/holidays";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalTime,
  zonedLocalToInstant,
  findOverlaps,
} from "@/shared/datetime";
import type {
  CommandName,
  EventDTO,
  MutationResult,
  PageDTO,
  TimeEntryDTO,
  TaskDTO,
  PreviewDTO,
  CalendarSourceDTO,
} from "@/shared/contracts";
import { query, useQuery, usePagedQuery } from "./api";
import { useLocale } from "./locale";
import { EventReminders } from "./event-reminders";
import { moveLocalEventToDate, upcomingCalendarEnd } from "./calendar-dates";
import { GoogleEventEditor } from "./google-event-editor";
import {
  AddButton,
  Button,
  Empty,
  Field,
  Modal,
  QueryState,
} from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
const ZONE = "Europe/Berlin";
function today() {
  return instantToLocalDate(new Date().toISOString(), ZONE);
}
function add(date: string, days: number) {
  return addCalendarDays(date, days);
}

export function CalendarView({
  action,
  onOpen,
  shared,
}: {
  action: Action;
  onOpen: (id: string) => void;
  shared?: {
    date: string;
    onDate: (date: string) => void;
    region: HolidayRegion | null;
    onRegion: (region: HolidayRegion) => void;
    calendarId: string;
    onCalendar: (id: string) => void;
    showExternal: boolean;
    onExternal: (show: boolean) => void;
  };
}) {
  const { t, language } = useLocale();
  const [ownDate, ownSetDate] = useState(today);
  const date = shared?.date ?? ownDate;
  const setDate = shared?.onDate ?? ownSetDate;
  const [view, setView] = useState("month");
  const [showTasks, setShowTasks] = useState(true);
  const [showWork, setShowWork] = useState(false);
  const [ownExternal, ownSetExternal] = useState(true);
  const showExternal = shared?.showExternal ?? ownExternal;
  const setShowExternal = shared?.onExternal ?? ownSetExternal;
  const [ownCalendarId, ownSetCalendarId] = useState("");
  const calendarId = shared?.calendarId ?? ownCalendarId;
  const setCalendarId = shared?.onCalendar ?? ownSetCalendarId;
  const [calendarSearch, setCalendarSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [draft, setDraft] = useState<{ starts: string; ends: string } | null>(
    null,
  );
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible")
        setNow(new Date().toISOString());
    };
    const timer = window.setInterval(tick, 60000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const creation = useRef<{ day: string; minute: number } | null>(null);
  const resizing = useRef<{ event: EventDTO; y: number } | null>(null);
  const [editing, setEditing] = useState<EventDTO | null>(null);
  const [create, setCreate] = useState(false);
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const [ownRegion, ownSetRegion] = useState<HolidayRegion | null>(null);
  const localRegion = shared?.region ?? ownRegion;
  const setRegion = shared?.onRegion ?? ownSetRegion;
  const region: HolidayRegion =
    localRegion ??
    (HOLIDAY_REGIONS.includes(
      String(preferences.data?.settings.holiday_region) as HolidayRegion,
    )
      ? (preferences.data!.settings.holiday_region as HolidayRegion)
      : "BOTH");
  const monthStart = `${date.slice(0, 7)}-01`;
  const mondayOffset =
    (new Date(`${monthStart}T12:00:00Z`).getUTCDay() + 6) % 7;
  const weekStart = add(
    date,
    -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7),
  );
  const start =
    view === "day"
      ? date
      : view === "week"
        ? weekStart
        : add(monthStart, -mondayOffset);
  const end = add(start, view === "day" ? 1 : view === "week" ? 7 : 42);
  const events = usePagedQuery<EventDTO>("calendar_events_query", {
    from: zonedLocalToInstant(`${start}T00:00`, ZONE),
    to: zonedLocalToInstant(`${end}T00:00`, ZONE),
    limit: 200,
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...(calendarSearch ? { search: calendarSearch } : {}),
    ...(categoryFilter ? { category: categoryFilter } : {}),
  });
  const tasks = usePagedQuery<TaskDTO>(
    "task_search",
    {
      limit: 200,
      due_from: start,
      due_to: end,
      ...(calendarSearch ? { search: calendarSearch } : {}),
    },
    showTasks,
  );
  const work = usePagedQuery<TimeEntryDTO>(
    "time_entry_list",
    {
      from: zonedLocalToInstant(`${start}T00:00`, ZONE),
      to: zonedLocalToInstant(`${end}T00:00`, ZONE),
    },
    showWork,
  );
  const deadline = (task: TaskDTO) =>
    task.due_date ??
    (task.due_at ? instantToLocalDate(task.due_at, ZONE) : null);
  function occursOn(event: EventDTO, day: string) {
    return (
      Date.parse(event.starts_at) <
        Date.parse(zonedLocalToInstant(`${add(day, 1)}T00:00`, ZONE)) &&
      Date.parse(event.ends_at) >
        Date.parse(zonedLocalToInstant(`${day}T00:00`, ZONE))
    );
  }
  async function moveEvent(event: React.DragEvent<HTMLElement>, date: string) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/lifeos-event");
    const record = events.data?.items.find((value) => value.event_id === id);
    if (!record || record.provider !== "local" || record.recurrence_rule)
      return;
    try {
      const { starts_at, ends_at } = moveLocalEventToDate(record, date);
      await action(
        "calendar_update_local_event",
        { event_id: id, starts_at, ends_at },
        record.revision,
      );
    } catch (error) {
      window.dispatchEvent(
        new CustomEvent("lifeos:error", { detail: String(error) }),
      );
    }
  }
  const calendars = useQuery<PageDTO<Record<string, unknown>>>("calendar_list");
  const upcoming = useQuery<PageDTO<EventDTO>>("calendar_events_query", {
    from: now,
    to: upcomingCalendarEnd(now, ZONE),
    limit: 5,
    ...(calendarId ? { calendar_id: calendarId } : {}),
    ...(calendarSearch ? { search: calendarSearch } : {}),
    ...(categoryFilter ? { category: categoryFilter } : {}),
  });
  const visible = [
    ...(events.data?.items ?? []),
    ...(showWork
      ? (work.data?.items ?? []).map((entry): EventDTO => ({
          event_id: `work:${entry.entry_id}`,
          title: entry.employer,
          starts_at: entry.starts_at,
          ends_at: entry.ends_at,
          timezone: ZONE,
          all_day: false,
          provider: "work",
          category: "Work",
          task_id: entry.task_id,
          notes: entry.description,
          recurrence_rule: null,
          revision: entry.revision,
        }))
      : []),
  ].filter(
    (event) =>
      showExternal || event.provider === "local" || event.provider === "work",
  );
  const overlaps = findOverlaps(
    visible.filter(
      (event) => !event.all_day && event.busy !== false && !event.self_declined,
    ),
  );
  const monday = (new Date(`${monthStart}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) =>
    add(monthStart, index - monday),
  );
  function move(direction: number) {
    setEventCursor(null);
    if (view === "month") {
      const value = new Date(`${monthStart}T12:00:00Z`);
      value.setUTCMonth(value.getUTCMonth() + direction);
      setDate(value.toISOString().slice(0, 10));
    } else setDate(add(date, direction * (view === "week" ? 7 : 1)));
  }
  function finishSwipe(event: React.TouchEvent<HTMLElement>) {
    const first = touchStart.current;
    touchStart.current = null;
    if (!first) return;
    const last = event.changedTouches[0];
    const dx = last.clientX - first.x,
      dy = last.clientY - first.y;
    if (Math.abs(dx) > 70 && Math.abs(dy) < 35) move(dx < 0 ? 1 : -1);
  }
  function openDraft(day: string, minute: number, endMinute: number) {
    const point = (value: number) =>
      value >= 1440
        ? `${add(day, 1)}T00:00`
        : `${day}T${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
    setDraft({
      starts: point(Math.min(minute, endMinute)),
      ends: point(
        Math.min(
          1440,
          minute === endMinute ? endMinute + 15 : Math.max(minute, endMinute),
        ),
      ),
    });
    setEditing(null);
    setCreate(true);
  }
  async function finishResize(pointer: React.PointerEvent<HTMLButtonElement>) {
    const current = resizing.current;
    resizing.current = null;
    if (!current) return;
    const delta =
      Math.round((((pointer.clientY - current.y) / 52) * 60) / 15) * 15;
    if (!delta) return;
    const ends_at = new Date(
      Date.parse(current.event.ends_at) + delta * 60000,
    ).toISOString();
    if (Date.parse(ends_at) <= Date.parse(current.event.starts_at)) {
      window.dispatchEvent(
        new CustomEvent("lifeos:error", {
          detail: t("پایان باید بعد از شروع باشد", "End must follow start"),
        }),
      );
      return;
    }
    await action(
      "calendar_update_local_event",
      { event_id: current.event.event_id, ends_at },
      current.event.revision,
    );
  }
  const monthLabel = new Intl.DateTimeFormat(
    language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
    { month: "long", year: "numeric", timeZone: ZONE },
  ).format(new Date(`${date}T12:00:00Z`));
  const days =
    view === "day"
      ? [date]
      : Array.from({ length: 7 }, (_, index) => add(weekStart, index));
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("به زمانت فضا بده", "MAKE SPACE FOR YOUR TIME")}
          </div>
          <h1>{t("تقویم", "Calendar")}</h1>
          <p>
            {t(
              "برنامه‌ها، مهلت‌ها و زمان کار؛ هرکدام در جای خودش.",
              "Appointments, deadlines and work time, each in its own layer.",
            )}
          </p>
        </div>
        <AddButton
          onClick={() => {
            setDraft(null);
            setCreate(true);
          }}
        >
          {t("رویداد تازه", "New event")}
        </AddButton>
      </div>
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <Button onClick={() => move(-1)} aria-label={t("قبلی", "Previous")}>
            <ChevronRight size={17} />
          </Button>
          <h2>{monthLabel}</h2>
          <input
            type="date"
            aria-label={t("تاریخ تقویم", "Calendar date")}
            value={date}
            onChange={(e) => {
              if (e.target.value) {
                setDate(e.target.value);
                setEventCursor(null);
              }
            }}
          />
          <Button onClick={() => move(1)} aria-label={t("بعدی", "Next")}>
            <ChevronLeft size={17} />
          </Button>
          <Button
            onClick={() => {
              setDate(today());
              setEventCursor(null);
            }}
          >
            {t("امروز", "Today")}
          </Button>
        </div>
        <div className="tabs">
          {[
            ["month", t("ماه", "Month")],
            ["week", t("هفته", "Week")],
            ["day", t("روز", "Day")],
            ["agenda", t("فهرست", "Agenda")],
          ].map(([value, label]) => (
            <button
              key={value}
              className={view === value ? "active" : ""}
              onClick={() => {
                setView(value);
                setEventCursor(null);
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-layers">
        <Field label={t("منبع تقویم", "Calendar source")}>
          <select
            value={calendarId}
            onChange={(event) => {
              setCalendarId(event.target.value);
              setEventCursor(null);
            }}
          >
            <option value="">
              {t("همهٔ منابع مجاز", "All authorized sources")}
            </option>
            {calendars.data?.items.map((calendar) => (
              <option
                key={String(calendar.calendar_id)}
                value={String(calendar.calendar_id)}
              >
                {String(calendar.title)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("جست‌وجوی تقویم", "Calendar search")}>
          <input
            value={calendarSearch}
            onChange={(event) => {
              setCalendarSearch(event.target.value);
              setEventCursor(null);
            }}
            placeholder={t("عنوان یا یادداشت…", "Title or notes…")}
          />
        </Field>
        <Field label={t("کار یا شخصی", "Work or personal")}>
          <select
            value={categoryFilter}
            onChange={(event) => {
              setCategoryFilter(event.target.value);
              setEventCursor(null);
            }}
          >
            <option value="">{t("همهٔ دسته‌ها", "All categories")}</option>
            <option value="Work">{t("کار", "Work")}</option>
            <option value="Personal">{t("شخصی", "Personal")}</option>
            <option value="Other">{t("سایر", "Other")}</option>
            <option value="Unclassified">
              {t("بدون دسته‌بندی", "Unclassified")}
            </option>
          </select>
        </Field>
        <label>
          {t("تعطیلات", "Holidays")}
          <select
            disabled={
              !preferences.data || !!preferences.error || preferences.fetching
            }
            value={region}
            onChange={(event) => {
              const value = event.target.value as HolidayRegion;
              setRegion(value);
              void action(
                "preferences_update",
                {
                  settings: {
                    holiday_region: value,
                  },
                },
                preferences.data?.revision,
              );
            }}
          >
            {HOLIDAY_REGIONS.map((value) => (
              <option key={value} value={value}>
                {value === "BOTH" ? "Jena + Seewiesen" : value}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={showTasks}
            onChange={(event) => setShowTasks(event.target.checked)}
          />
          {t("مهلت کارها", "Task deadlines")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={showWork}
            onChange={(event) => setShowWork(event.target.checked)}
          />
          {t("ساعات کار", "Worked time")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={showExternal}
            onChange={(event) => setShowExternal(event.target.checked)}
          />
          {t("تقویم‌های متصل", "Connected calendars")}
        </label>
        <span className="muted small">
          <Clock3 size={13} /> Europe/Berlin
        </span>
        <span className="muted small">
          {calendars.data?.total
            ? `${calendars.data.total} ${t("منبع", "sources")}`
            : t(
                "تقویم محلی · اتصال خارجی از تنظیمات",
                "Local calendar · Connect providers in Settings",
              )}
        </span>
      </div>
      <QueryState {...events} retry={events.refresh} />
      <details className="calendar-upcoming">
        <summary>
          {t("رویدادهای هفت روز آینده", "Events in the next seven days")}
        </summary>
        <QueryState {...upcoming} retry={upcoming.refresh} />
        {upcoming.data?.items
          .filter((event) => showExternal || event.provider === "local")
          .map((event) => (
            <div
              className="dependency-row"
              key={event.occurrence_key ?? event.event_id}
            >
              <Button onClick={() => setEditing(event)}>{event.title}</Button>
              <time>
                {new Date(event.starts_at).toLocaleString(
                  language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
                  { timeZone: ZONE },
                )}
              </time>
            </div>
          ))}
        {upcoming.data && !upcoming.data.items.length && (
          <Empty
            title={t(
              "رویدادی در هفت روز آینده نیست",
              "No events in the next seven days",
            )}
          />
        )}
        <p className="small muted">
          {t(
            "۵ رخداد نخست منابع و دستهٔ انتخابی؛ رویدادهای شخصیِ مجاز Google قابل ویرایش‌اند.",
            "First 5 occurrences for the selected source and category; authorized personal Google events can be edited.",
          )}
        </p>
      </details>
      {!!events.data?.source_warnings?.length && (
        <p role="status" className="warning">
          {t(
            "تازگی، دسترسی یا پوشش بعضی منابع مشکل دارد. رویدادهای نمایش‌داده‌شده از داده‌های موجودند؛ زمان آخرین دریافت و وضعیت هر منبع را در بالای تقویم بررسی کن.",
            "Some sources have a freshness, access, or coverage issue. Displayed events use available data; check each source's last sync and status above the calendar.",
          )}
        </p>
      )}
      {overlaps.length > 0 && (
        <details className="calendar-overlaps">
          <summary>
            {overlaps.length}{" "}
            {t(
              "هم‌پوشانی بین رخدادهای ساعتی این صفحه",
              "overlaps between timed occurrences on this page",
            )}
          </summary>
          <p className="small muted">
            {t(
              "هم‌پوشانی از همین صفحه محاسبه می‌شود؛ رخدادهای تمام‌روز در آن نیستند. در نمای فهرست می‌توانی هر رویداد را جدا باز کنی.",
              "Overlaps use this page only and exclude all-day events. Agenda lets you open each event separately.",
            )}
          </p>
          {overlaps.slice(0, 20).map((overlap, index) => (
            <div className="dependency-row" key={index}>
              <Button onClick={() => setEditing(overlap.first)}>
                {overlap.first.title}
              </Button>
              <span>
                {Math.round(overlap.overlap_minutes * 10) / 10}{" "}
                {t("دقیقه", "minutes")}
              </span>
              <Button onClick={() => setEditing(overlap.second)}>
                {overlap.second.title}
              </Button>
            </div>
          ))}
          {overlaps.length > 20 && (
            <p className="small muted">
              {t(
                "۲۰ جفت نخست نمایش داده می‌شود؛ برای بررسی سایر رویدادها نمای فهرست را باز کن.",
                "The first 20 pairs are displayed. Use Agenda to inspect other events.",
              )}
            </p>
          )}
        </details>
      )}
      <div className="form-actions">
        <span className="small muted">
          {start} — {end} · {events.data?.items.length ?? 0} /{" "}
          {events.data?.total ?? "—"}{" "}
          {t("رخداد در این صفحه", "occurrences on this page")}
        </span>
        {eventCursor && (
          <Button onClick={() => setEventCursor(null)}>
            {t("صفحهٔ اول", "First page")}
          </Button>
        )}
        {events.data?.next_cursor && (
          <Button onClick={() => setEventCursor(events.data!.next_cursor)}>
            {t("رخدادهای بعدی", "Next occurrences")}
          </Button>
        )}
      </div>
      {events.data?.next_cursor && (
        <p className="warning">
          {t(
            "این صفحه ۲۰۰ رخداد دارد؛ برای ادامه صفحهٔ بعد را باز کن. همهٔ رخدادها در همین نما جا نشده‌اند.",
            "This page contains 200 occurrences. Open the next page to continue; this view does not contain every occurrence.",
          )}
        </p>
      )}
      {showTasks && tasks.data?.next_cursor && (
        <p className="warning">
          {t(
            "۲۰۰ مهلت نخست این بازه نمایش داده می‌شود؛ برای بقیه از جست‌وجوی کارها استفاده کن.",
            "The first 200 deadlines in this range are shown. Use task search for the remaining deadlines.",
          )}
        </p>
      )}
      {view === "month" ? (
        <div
          className="month-calendar"
          onTouchStart={(event) => {
            const touch = event.touches[0];
            touchStart.current = { x: touch.clientX, y: touch.clientY };
          }}
          onTouchEnd={finishSwipe}
        >
          <div className="week-labels">
            {Array.from({ length: 7 }, (_, index) =>
              new Intl.DateTimeFormat(language === "fa" ? "fa-IR" : "en-GB", {
                weekday: "short",
                timeZone: ZONE,
              }).format(new Date(`${add("2026-01-05", index)}T12:00:00Z`)),
            ).map((label) => (
              <div key={label}>{label}</div>
            ))}
          </div>
          <div className="month-grid">
            {cells.map((day) => (
              <div
                key={day}
                data-calendar-date={day}
                className={`month-cell ${day.slice(0, 7) !== date.slice(0, 7) ? "outside" : ""} ${day === today() ? "today" : ""} ${dayFlags(day, region).red ? "offday" : ""}`}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => void moveEvent(event, day)}
              >
                <button
                  className="day-number"
                  onClick={() => {
                    setDate(day);
                    setView("day");
                  }}
                >
                  {Number(day.slice(8))}
                </button>
                {dayFlags(day, region).holidays.map((holiday) => (
                  <span
                    className="holiday-label"
                    key={holiday.name}
                    title={holiday.name}
                  >
                    {holiday.name}
                  </span>
                ))}
                {visible
                  .filter((event) => occursOn(event, day))
                  .map((event) => (
                    <button
                      key={event.occurrence_key ?? event.event_id}
                      className={`calendar-event ${event.provider === "local" ? "local" : "external"} ${event.category?.toLowerCase() ?? ""}`}
                      draggable={
                        event.provider === "local" && !event.recurrence_rule
                      }
                      onDragStart={(drag) =>
                        drag.dataTransfer.setData(
                          "text/lifeos-event",
                          event.event_id,
                        )
                      }
                      onClick={() => setEditing(event)}
                    >
                      <span>
                        {!event.all_day &&
                          instantToLocalTime(event.starts_at, ZONE).slice(0, 5)}
                      </span>
                      {event.title}
                    </button>
                  ))}
                {showTasks &&
                  tasks.data?.items
                    .filter((task) => deadline(task) === day)
                    .map((task) => (
                      <button
                        key={task.task_id}
                        className="calendar-event task-deadline"
                        onClick={() => onOpen(task.task_id)}
                      >
                        {t("مهلت:", "Due:")} {task.title}
                      </button>
                    ))}
              </div>
            ))}
          </div>
        </div>
      ) : view === "agenda" ? (
        <div className="agenda-list">
          {visible.length || (showTasks && tasks.data?.items.length) ? (
            <>
              {visible.map((event) => (
                <button
                  key={event.occurrence_key ?? event.event_id}
                  className={`agenda-row ${event.category?.toLowerCase() ?? ""}`}
                  onClick={() => setEditing(event)}
                >
                  <div className="agenda-day">
                    <strong>
                      {formatInTimeZone(event.starts_at, ZONE, "dd")}
                    </strong>
                    <span>
                      {formatInTimeZone(event.starts_at, ZONE, "MMM")}
                    </span>
                  </div>
                  <div>
                    <strong>{event.title}</strong>
                    <small>
                      {event.all_day
                        ? t("تمام روز", "All day")
                        : formatInTimeZone(event.starts_at, ZONE, "HH:mm")}{" "}
                      · {event.provider}
                    </small>
                  </div>
                  <ChevronLeft size={17} />
                </button>
              ))}
              {showTasks &&
                tasks.data?.items.map((task) => {
                  const due = deadline(task);
                  if (!due) return null;
                  return (
                    <button
                      key={task.task_id}
                      className="agenda-row task-deadline"
                      onClick={() => onOpen(task.task_id)}
                    >
                      <div className="agenda-day">
                        <strong>{due.slice(8)}</strong>
                        <span>{due.slice(0, 7)}</span>
                      </div>
                      <div>
                        <strong>{task.title}</strong>
                        <small>
                          {t("مهلت کار", "Task deadline")} ·{" "}
                          {task.due_at
                            ? formatInTimeZone(task.due_at, ZONE, "HH:mm")
                            : t("تمام روز", "All day")}
                        </small>
                      </div>
                      <ChevronLeft size={17} />
                    </button>
                  );
                })}
            </>
          ) : (
            <Empty
              title={t(
                "تقویم جا برای برنامه‌های تو دارد",
                "Your calendar has room to breathe",
              )}
            />
          )}
        </div>
      ) : (
        <>
          <div
            className="calendar-all-day"
            role="region"
            tabIndex={0}
            aria-label={t("رویدادهای تمام‌روز", "All-day events")}
            dir="ltr"
            style={{
              gridTemplateColumns: `54px repeat(${days.length}, minmax(90px,1fr))`,
            }}
          >
            <span>{t("تمام روز", "All day")}</span>
            {days.map((day) => (
              <div key={day}>
                {visible
                  .filter((event) => event.all_day && occursOn(event, day))
                  .map((event) => (
                    <button
                      key={event.occurrence_key ?? event.event_id}
                      className={`calendar-event ${event.category?.toLowerCase() ?? ""}`}
                      onClick={() => setEditing(event)}
                    >
                      {event.title}
                    </button>
                  ))}
                {showTasks &&
                  tasks.data?.items
                    .filter((task) => deadline(task) === day)
                    .map((task) => (
                      <button
                        key={task.task_id}
                        className="calendar-event task-deadline"
                        onClick={() => onOpen(task.task_id)}
                      >
                        {t("مهلت:", "Due:")} {task.title}
                      </button>
                    ))}
              </div>
            ))}
          </div>
          <div
            className="week-calendar"
            onTouchStart={(event) => {
              if (view !== "day") return;
              const touch = event.touches[0];
              touchStart.current = { x: touch.clientX, y: touch.clientY };
            }}
            onTouchEnd={finishSwipe}
            role="region"
            aria-label={t("جدول ساعت‌های تقویم", "Calendar hourly timeline")}
            tabIndex={0}
            style={{
              gridTemplateColumns: `54px repeat(${days.length},minmax(90px,1fr))`,
            }}
            dir="ltr"
          >
            <div className="hour-ruler">
              <div className="week-day-head" />
              {Array.from({ length: 24 }, (_, hour) => (
                <div key={hour}>{String(hour).padStart(2, "0")}:00</div>
              ))}
            </div>
            {days.map((day) => (
              <div className="week-day" key={day}>
                <button
                  className="week-day-head"
                  onClick={() => {
                    setDate(day);
                    setDraft(null);
                    setCreate(true);
                  }}
                >
                  {new Intl.DateTimeFormat(
                    language === "fa" ? "fa-IR" : "en-GB",
                    { weekday: "short", day: "numeric" },
                  ).format(new Date(`${day}T12:00:00Z`))}
                </button>
                <div className="day-hours">
                  {Array.from({ length: 24 }, (_, hour) => (
                    <button
                      className="hour-slot hour-create"
                      key={hour}
                      aria-label={`${t("ساخت رویداد در", "Create event on")} ${day} ${String(hour).padStart(2, "0")}:00`}
                      onPointerDown={() => {
                        creation.current = { day, minute: hour * 60 };
                      }}
                      onPointerUp={() => {
                        const first = creation.current;
                        creation.current = null;
                        if (first && first.day === day)
                          openDraft(day, first.minute, hour * 60);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          openDraft(day, hour * 60, hour * 60);
                        }
                      }}
                    />
                  ))}
                  {visible
                    .filter((event) => !event.all_day && occursOn(event, day))
                    .map((event) => {
                      const dayStart = zonedLocalToInstant(
                        `${day}T00:00`,
                        ZONE,
                      );
                      const dayEnd = zonedLocalToInstant(
                        `${add(day, 1)}T00:00`,
                        ZONE,
                      );
                      const clippedStart = new Date(
                        Math.max(
                          Date.parse(event.starts_at),
                          Date.parse(dayStart),
                        ),
                      ).toISOString();
                      const clippedEnd = new Date(
                        Math.min(Date.parse(event.ends_at), Date.parse(dayEnd)),
                      ).toISOString();
                      const clock = instantToLocalTime(
                        clippedStart,
                        ZONE,
                      ).split(":");
                      const minute = Number(clock[0]) * 60 + Number(clock[1]);
                      const endClock = instantToLocalTime(
                        clippedEnd,
                        ZONE,
                      ).split(":");
                      const endMinute =
                        clippedEnd === dayEnd
                          ? 1440
                          : Number(endClock[0]) * 60 + Number(endClock[1]);
                      const duration = Math.max(0, endMinute - minute);
                      return (
                        <div
                          key={event.occurrence_key ?? event.event_id}
                          className={`time-block ${event.category?.toLowerCase() ?? ""}`}
                          style={{
                            top: `${(minute / 60) * 52}px`,
                            height: `${Math.max(26, (duration / 60) * 52)}px`,
                          }}
                        >
                          <button
                            className="time-block-open"
                            onClick={() => setEditing(event)}
                          >
                            {event.title}
                            <small>
                              {instantToLocalTime(event.starts_at, ZONE).slice(
                                0,
                                5,
                              )}
                            </small>
                          </button>
                          {event.provider === "local" &&
                            !event.recurrence_rule && (
                              <button
                                className="event-resize-handle"
                                aria-label={`${t("تغییر طول رویداد", "Resize event")} ${event.title}`}
                                onKeyDown={(key) => {
                                  if (key.key === "Enter" || key.key === " ") {
                                    key.preventDefault();
                                    setEditing(event);
                                  }
                                }}
                                onPointerDown={(pointer) => {
                                  pointer.preventDefault();
                                  pointer.stopPropagation();
                                  resizing.current = {
                                    event,
                                    y: pointer.clientY,
                                  };
                                  pointer.currentTarget.setPointerCapture(
                                    pointer.pointerId,
                                  );
                                }}
                                onPointerUp={(pointer) =>
                                  void finishResize(pointer)
                                }
                                onPointerCancel={() => {
                                  resizing.current = null;
                                }}
                              >
                                <span aria-hidden="true">⋯</span>
                              </button>
                            )}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
      {(create || !!editing) && (
        <EventEditor
          key={`${editing?.event_id ?? "new"}:${editing?.starts_at ?? date}`}
          open={create || !!editing}
          event={editing}
          date={date}
          close={() => {
            setCreate(false);
            setEditing(null);
          }}
          action={action}
          draft={draft}
          defaultSource={String(
            calendars.data?.items
              .filter(
                (source) => source.writable === true && source.enabled === true,
              )
              .sort(
                (a, b) =>
                  Number(b.primary === true) - Number(a.primary === true),
              )[0]?.source_id ?? "local",
          )}
        />
      )}
    </>
  );
}

function EventEditor({
  open,
  event,
  date,
  close,
  action,
  draft,
  defaultSource,
}: {
  open: boolean;
  event: EventDTO | null;
  date: string;
  close: () => void;
  action: Action;
  draft?: { starts: string; ends: string } | null;
  defaultSource: string;
}) {
  const { t } = useLocale();
  const [error, setError] = useState("");
  const [zone, setZone] = useState(event?.timezone ?? ZONE);
  const [occurrenceOpen, setOccurrenceOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [destination, setDestination] = useState(
    event?.provider === "google_calendar"
      ? (event.source_id ?? "local")
      : event
        ? "local"
        : defaultSource,
  );
  const connected = useQuery<{ items: CalendarSourceDTO[] }>(
    "calendar_sync_status",
    {},
    open,
  );
  const originalStart = event?.series_starts_at ?? event?.starts_at;
  const originalEnd = event?.series_ends_at ?? event?.ends_at;
  const startValue = originalStart
    ? formatInTimeZone(
        originalStart,
        event?.timezone ?? ZONE,
        "yyyy-MM-dd'T'HH:mm",
      )
    : (draft?.starts ?? `${date}T09:00`);
  const endValue = originalEnd
    ? formatInTimeZone(
        originalEnd,
        event?.timezone ?? ZONE,
        "yyyy-MM-dd'T'HH:mm",
      )
    : (draft?.ends ?? `${date}T10:00`);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      const disambiguation = String(data.get("disambiguation")) as
        "reject" | "earlier" | "later";
      const allDay = data.get("all_day") === "on";
      const enteredStart = String(data.get("starts"));
      const enteredEnd = String(data.get("ends"));
      const allDayStart = `${enteredStart.slice(0, 10)}T00:00`;
      const allDayEndDate =
        enteredEnd.slice(0, 10) <= enteredStart.slice(0, 10)
          ? add(enteredStart.slice(0, 10), 1)
          : enteredEnd.slice(0, 10);
      const normalizeAllDay =
        allDay &&
        (!event?.all_day ||
          enteredStart !== startValue ||
          enteredEnd !== endValue ||
          zone !== event.timezone);
      const actualStart = normalizeAllDay ? allDayStart : enteredStart;
      const actualEnd = normalizeAllDay ? `${allDayEndDate}T00:00` : enteredEnd;
      const result = await action(
        event ? "calendar_update_local_event" : "calendar_create_local_event",
        {
          ...(event ? { event_id: event.event_id } : {}),
          title: data.get("title"),
          ...(event &&
          !normalizeAllDay &&
          enteredStart === startValue &&
          zone === event.timezone
            ? {}
            : {
                starts_at: zonedLocalToInstant(
                  actualStart,
                  zone,
                  disambiguation,
                ),
              }),
          ...(event &&
          !normalizeAllDay &&
          enteredEnd === endValue &&
          zone === event.timezone
            ? {}
            : {
                ends_at: zonedLocalToInstant(actualEnd, zone, disambiguation),
              }),
          timezone: zone,
          all_day: allDay,
          notes: data.get("notes"),
          ...(data.get("category") ? { category: data.get("category") } : {}),
          apply_to_series: data.get("confirm_series") === "on",
          ...(event?.recurrence_rule
            ? {
                recurrence_exceptions: String(data.get("exceptions") ?? "")
                  .split(/\r?\n/)
                  .map((value) => value.trim())
                  .filter(Boolean),
              }
            : {}),
          recurrence_rule:
            data.get("recurrence") === "keep"
              ? (event?.recurrence_rule ?? null)
              : data.get("recurrence") === "weekly"
                ? "FREQ=WEEKLY"
                : data.get("recurrence") === "daily"
                  ? "FREQ=DAILY"
                  : data.get("recurrence") === "monthly"
                    ? "FREQ=MONTHLY"
                    : null,
        },
        event?.revision,
      );
      if (result) close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const external = event && event.provider !== "local";
  if (destination !== "local")
    return (
      <GoogleEventEditor
        open={open}
        close={close}
        event={event}
        date={date}
        draft={draft}
        sourceId={destination}
        sources={connected.data?.items ?? []}
        onSource={setDestination}
        action={action}
      />
    );
  return (
    <Modal
      title={
        event
          ? t("جزئیات رویداد", "Event details")
          : t("یک زمان برای برنامه‌ات", "Schedule an event")
      }
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <form className="form-grid" onSubmit={submit}>
        {!event && (
          <Field label={t("مقصد رویداد", "Event destination")}>
            <select
              value={destination}
              onChange={(change) => setDestination(change.target.value)}
            >
              <option value="local">
                {t("تقویم محلی Life OS", "Life OS local calendar")}
              </option>
              {connected.data?.items
                .filter((source) => source.writable && source.enabled)
                .map((source) => (
                  <option key={source.source_id} value={source.source_id}>
                    {source.title} · Google
                  </option>
                ))}
            </select>
          </Field>
        )}
        {event?.recurrence_rule && !external && (
          <div className="connection-notice">
            <div>
              <p>
                {t(
                  "این پنجره کل سری را ویرایش می‌کند. برای جابه‌جایی یا تغییر طول فقط نوبت انتخاب‌شده، از گزینه زیر استفاده کن.",
                  "This form edits the entire series. Use the option below to move or resize only the selected occurrence.",
                )}
              </p>
              <Button type="button" onClick={() => setOccurrenceOpen(true)}>
                {t("تغییر فقط این نوبت", "Change only this occurrence")}
              </Button>
            </div>
          </div>
        )}
        <Field label={t("عنوان", "Title")}>
          <input
            required
            name="title"
            defaultValue={event?.title ?? ""}
            readOnly={!!external}
          />
        </Field>
        <Field label={t("دستهٔ رویداد", "Event category")}>
          <select
            name="category"
            defaultValue={event?.category ?? ""}
            disabled={!!external}
          >
            {!event?.category && (
              <option value="">
                {t("بدون دستهٔ ثبت‌شده", "No recorded category")}
              </option>
            )}
            <option value="Work">{t("کار", "Work")}</option>
            <option value="Personal">{t("شخصی", "Personal")}</option>
            <option value="Other">{t("سایر", "Other")}</option>
          </select>
        </Field>
        <Field label={t("منطقهٔ زمانی", "Time zone")}>
          <select
            value={zone}
            onChange={(e) => setZone(e.target.value)}
            disabled={!!external}
          >
            <option>Europe/Berlin</option>
            <option>Asia/Tehran</option>
            <option>UTC</option>
            {event &&
              ![ZONE, "Asia/Tehran", "UTC"].includes(event.timezone) && (
                <option>{event.timezone}</option>
              )}
          </select>
        </Field>
        <div className="form-columns">
          <Field label={t("شروع", "Start")}>
            <input
              required
              name="starts"
              type="datetime-local"
              step={60}
              defaultValue={startValue}
              readOnly={!!external}
            />
          </Field>
          <Field label={t("پایان", "End")}>
            <input
              required
              name="ends"
              type="datetime-local"
              step={60}
              defaultValue={endValue}
              readOnly={!!external}
            />
          </Field>
        </div>
        <label className="check-label">
          <input
            name="all_day"
            type="checkbox"
            defaultChecked={event?.all_day}
            disabled={!!external}
          />
          {t(
            "تمام روز؛ پایان در نیمه‌شب و خارج از بازه است",
            "All day; end is midnight and exclusive",
          )}
        </label>
        <Field label={t("تکرار", "Repeat")}>
          <select
            name="recurrence"
            defaultValue={event?.recurrence_rule ? "keep" : "none"}
            disabled={!!external}
          >
            <option value="none">{t("بدون تکرار", "Does not repeat")}</option>
            {event?.recurrence_rule && (
              <option value="keep">
                {t("حفظ قاعدهٔ فعلی", "Keep the existing rule")} ·{" "}
                {event.recurrence_rule}
              </option>
            )}
            <option value="daily">{t("هر روز", "Every day")}</option>
            <option value="weekly">{t("هر هفته", "Every week")}</option>
            <option value="monthly">{t("هر ماه", "Every month")}</option>
          </select>
        </Field>
        {event?.recurrence_rule && !external && (
          <label className="check-label">
            <input type="checkbox" required name="confirm_series" />
            {t(
              "تأیید می‌کنم این ویرایش روی کل سری تکرارشونده اعمال شود؛ زمان‌ها مربوط به شروع سری هستند.",
              "I confirm this edit applies to the entire recurring series. Times refer to the series start.",
            )}
          </label>
        )}
        {event?.recurrence_rule && (
          <Field
            label={t(
              "نوبت‌های مستثنا؛ هر تاریخ در یک خط",
              "Excluded occurrences; one date per line",
            )}
          >
            <textarea
              name="exceptions"
              rows={3}
              defaultValue={(event.recurrence_exceptions ?? []).join("\n")}
              placeholder="2026-10-20"
              readOnly={!!external}
            />
            <small>
              {t(
                "YYYY-MM-DD برای کل روز یا YYYY-MM-DDTHH:mm:ss برای زمان محلی. استثنای معمولی با حذف خط و تأیید سری بازمی‌گردد. برای نوبت جابه‌جاشده، رویداد مرتبط را ویرایش کن؛ حذف استثنای آن مجاز نیست.",
                "Use YYYY-MM-DD for a day, or YYYY-MM-DDTHH:mm:ss for a local time. Removing an ordinary exception restores it after series confirmation. For a moved occurrence, edit its linked event; its exclusion cannot be removed.",
              )}
            </small>
          </Field>
        )}
        <Field
          label={t(
            "تغییر ساعت پاییزی (اگر ساعت دوبار رخ دهد)",
            "Autumn clock change (if this time occurs twice)",
          )}
        >
          <select name="disambiguation" disabled={!!external}>
            <option value="reject">
              {t("از من بخواه مشخص کنم", "Require a choice")}
            </option>
            <option value="earlier">{t("بار اول", "First occurrence")}</option>
            <option value="later">{t("بار دوم", "Second occurrence")}</option>
          </select>
        </Field>
        <Field label={t("یادداشت", "Notes")}>
          <textarea
            name="notes"
            defaultValue={event?.notes ?? ""}
            readOnly={!!external}
          />
        </Field>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {external ? (
          <p className="muted">
            {t(
              "این منبع فقط خواندنی است؛ تغییر تقویم خارجی نیازمند اتصال و مجوز جداگانه است.",
              "This source is read-only. External changes need a separate connection and authorization.",
            )}
          </p>
        ) : (
          <Button variant="primary" type="submit">
            {t("ذخیرهٔ رویداد", "Save event")}
          </Button>
        )}
      </form>
      {event && !external && <EventReminders event={event} action={action} />}
      {event?.series_event_id && (
        <p className="muted small">
          {t(
            "این رخداد، نوبت جابه‌جاشدهٔ یک سری است؛ ویرایش آن فقط همین نوبت را تغییر می‌دهد.",
            "This is a moved series occurrence; editing it changes only this occurrence.",
          )}
        </p>
      )}
      {event && !external && (
        <Button onClick={() => setDeleteOpen(true)}>
          {event.recurrence_rule
            ? t("حذف کل سری", "Delete entire series")
            : t("حذف این رویداد", "Delete this event")}
        </Button>
      )}
      <Modal
        title={
          event?.recurrence_rule
            ? t("حذف کل سری", "Delete entire series")
            : t("حذف این رویداد", "Delete this event")
        }
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
      >
        <p>
          {event?.recurrence_rule
            ? t(
                "کل سری و نوبت‌های محلی جابه‌جاشدهٔ آن از تقویم حذف می‌شوند. حذف نیاز به تأیید صریح دارد.",
                "This removes the entire series and its linked local moved occurrences from the calendar. Explicit confirmation is required.",
              )
            : t(
                "این رخداد از تقویم محلی حذف می‌شود.",
                "This occurrence is removed from the local calendar.",
              )}
        </p>
        <Button
          variant="primary"
          onClick={async () => {
            if (
              event &&
              (await action(
                "calendar_delete_local_event",
                { event_id: event.event_id },
                event.revision,
              ))
            ) {
              setDeleteOpen(false);
              close();
            }
          }}
        >
          {t("تأیید حذف رویداد", "Confirm event deletion")}
        </Button>
      </Modal>
      {event && (
        <OccurrenceEditor
          event={event}
          open={occurrenceOpen}
          setOpen={setOccurrenceOpen}
          action={action}
          onSaved={close}
        />
      )}
    </Modal>
  );
}

function OccurrenceEditor({
  event,
  open,
  setOpen,
  action,
  onSaved,
}: {
  event: EventDTO;
  open: boolean;
  setOpen: (open: boolean) => void;
  action: Action;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const [error, setError] = useState("");
  type Times = {
    starts_at: string;
    ends_at: string;
    timezone: string;
    all_day: boolean;
  };
  const changes = preview?.changes as
    { original: Times; override: Times } | undefined;
  return (
    <Modal
      title={t(
        "جابه‌جایی یا تغییر طول فقط این نوبت",
        "Move or resize only this occurrence",
      )}
      open={open}
      onOpenChange={(value) => {
        setOpen(value);
        if (!value) {
          setPreview(null);
          setError("");
        }
      }}
    >
      {changes ? (
        <>
          <p>
            {t(
              "شروع سری و قاعدهٔ تکرار حفظ می‌شوند. نوبت اصلی مستثنا و یک رویداد مرتبط جایگزین آن می‌شود.",
              "The series start and recurrence rule are preserved. The original occurrence is excluded and replaced by a linked local event.",
            )}
          </p>
          <dl className="metadata-list">
            <dt>{t("زمان فعلی", "Original time")}</dt>
            <dd dir="ltr">
              {formatInTimeZone(
                changes.original.starts_at,
                changes.original.timezone,
                "yyyy-MM-dd HH:mm:ss",
              )}{" "}
              →{" "}
              {formatInTimeZone(
                changes.original.ends_at,
                changes.original.timezone,
                "yyyy-MM-dd HH:mm:ss",
              )}
            </dd>
            <dt>{t("زمان پیشنهادی", "Proposed time")}</dt>
            <dd dir="ltr">
              {formatInTimeZone(
                changes.override.starts_at,
                changes.override.timezone,
                "yyyy-MM-dd HH:mm:ss",
              )}{" "}
              →{" "}
              {formatInTimeZone(
                changes.override.ends_at,
                changes.override.timezone,
                "yyyy-MM-dd HH:mm:ss",
              )}{" "}
              · {changes.override.timezone}
            </dd>
          </dl>
          <div className="form-actions">
            <Button onClick={() => setPreview(null)}>
              {t("ویرایش پیشنهاد", "Edit proposal")}
            </Button>
            <Button
              variant="primary"
              onClick={async () => {
                if (
                  preview &&
                  (await action("calendar_occurrence_reschedule_commit", {
                    preview_id: preview.preview_id,
                  }))
                ) {
                  setOpen(false);
                  setPreview(null);
                  onSaved();
                }
              }}
            >
              {t("تأیید تغییر فقط این نوبت", "Confirm this occurrence only")}
            </Button>
          </div>
        </>
      ) : (
        <form
          className="form-grid"
          onSubmit={async (submit) => {
            submit.preventDefault();
            setError("");
            const values = new FormData(submit.currentTarget);
            try {
              const timezone = String(values.get("timezone"));
              const choice = String(values.get("disambiguation")) as
                "reject" | "earlier" | "later";
              const all_day = values.get("all_day") === "on";
              let starts = String(values.get("starts")),
                ends = String(values.get("ends"));
              if (all_day) {
                const startDate = starts.slice(0, 10);
                const endDate = ends.slice(0, 10);
                starts = `${startDate}T00:00`;
                ends = `${endDate > startDate ? endDate : add(startDate, 1)}T00:00`;
              }
              const starts_at =
                starts ===
                  formatInTimeZone(
                    event.starts_at,
                    event.timezone,
                    "yyyy-MM-dd'T'HH:mm",
                  ) &&
                timezone === event.timezone &&
                !all_day
                  ? event.starts_at
                  : zonedLocalToInstant(starts, timezone, choice);
              const ends_at =
                ends ===
                  formatInTimeZone(
                    event.ends_at,
                    event.timezone,
                    "yyyy-MM-dd'T'HH:mm",
                  ) &&
                timezone === event.timezone &&
                !all_day
                  ? event.ends_at
                  : zonedLocalToInstant(ends, timezone, choice);
              setPreview(
                await query<PreviewDTO>(
                  "calendar_occurrence_reschedule_preview",
                  {
                    event_id: event.event_id,
                    occurrence_starts_at: event.starts_at,
                    starts_at,
                    ends_at,
                    timezone,
                    all_day,
                  },
                ),
              );
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          <p className="small muted">
            {t(
              "زمان پایان را برای تغییر طول و زمان شروع را برای جابه‌جایی تغییر بده؛ تا تأیید پیش‌نمایش ذخیره‌ای انجام نمی‌شود.",
              "Change the end time to resize, or the start time to move. Nothing is saved until you confirm the preview.",
            )}
          </p>
          <Field label={t("شروع این نوبت", "Occurrence start")}>
            <input
              type="datetime-local"
              name="starts"
              required
              step={60}
              defaultValue={formatInTimeZone(
                event.starts_at,
                event.timezone,
                "yyyy-MM-dd'T'HH:mm",
              )}
            />
          </Field>
          <Field label={t("پایان این نوبت", "Occurrence end")}>
            <input
              type="datetime-local"
              name="ends"
              required
              step={60}
              defaultValue={formatInTimeZone(
                event.ends_at,
                event.timezone,
                "yyyy-MM-dd'T'HH:mm",
              )}
            />
          </Field>
          <Field label={t("منطقهٔ زمانی نوبت", "Occurrence time zone")}>
            <input name="timezone" required defaultValue={event.timezone} />
          </Field>
          <label className="check-label">
            <input
              name="all_day"
              type="checkbox"
              defaultChecked={event.all_day}
            />
            {t(
              "تمام روز؛ پایان به‌صورت غیرشامل روز بعد است",
              "All day; the end is exclusive, at least the next day",
            )}
          </label>
          <Field
            label={t(
              "اگر ساعت محلی دوبار رخ داد",
              "If this local time occurs twice",
            )}
          >
            <select name="disambiguation">
              <option value="reject">
                {t("نیاز به انتخاب", "Require a choice")}
              </option>
              <option value="earlier">
                {t("بار اول", "First occurrence")}
              </option>
              <option value="later">{t("بار دوم", "Second occurrence")}</option>
            </select>
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button type="submit">
            {t("پیش‌نمایش تغییر نوبت", "Preview occurrence change")}
          </Button>
        </form>
      )}
    </Modal>
  );
}
