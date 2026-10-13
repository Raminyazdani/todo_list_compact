"use client";
import { useState } from "react";
import { ChevronLeft, ChevronRight, Clock3, Download } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { dayFlags, type HolidayRegion } from "@/server/integrations/holidays";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalTime,
  zonedLocalToInstant,
  splitIntervalByLocalDate,
} from "@/shared/datetime";
import type {
  CommandName,
  EventDTO,
  MutationResult,
  PageDTO,
  TimeEntryDTO,
  TaskDTO,
} from "@/shared/contracts";
import { useQuery } from "./api";
import { useLocale } from "./locale";
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
}: {
  action: Action;
  onOpen: (id: string) => void;
}) {
  const { t, language } = useLocale();
  const [date, setDate] = useState(today);
  const [view, setView] = useState("month");
  const [showTasks, setShowTasks] = useState(true);
  const [showExternal, setShowExternal] = useState(true);
  const [editing, setEditing] = useState<EventDTO | null>(null);
  const [create, setCreate] = useState(false);
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const [localRegion, setRegion] = useState<HolidayRegion | null>(null);
  const region: HolidayRegion =
    localRegion ??
    (["BOTH", "SL", "TH", "BY"].includes(
      String(preferences.data?.settings.holiday_region),
    )
      ? (preferences.data!.settings.holiday_region as HolidayRegion)
      : "BOTH");
  const monthStart = `${date.slice(0, 7)}-01`;
  const start = add(monthStart, -7);
  const end = add(monthStart, 42);
  const events = useQuery<PageDTO<EventDTO>>("calendar_events_query", {
    from: zonedLocalToInstant(`${start}T00:00`, ZONE),
    to: zonedLocalToInstant(`${end}T00:00`, ZONE),
    limit: 200,
  });
  const tasks = useQuery<PageDTO<TaskDTO>>("task_search", { limit: 200 });
  async function moveEvent(event: React.DragEvent<HTMLElement>, date: string) {
    event.preventDefault();
    const id = event.dataTransfer.getData("text/lifeos-event");
    const record = events.data?.items.find((value) => value.event_id === id);
    if (!record || record.provider !== "local" || record.recurrence_rule)
      return;
    try {
      const starts_at = zonedLocalToInstant(
        `${date}T${instantToLocalTime(record.starts_at, record.timezone).slice(0, 5)}`,
        record.timezone,
      );
      const ends_at = new Date(
        Date.parse(starts_at) +
          Date.parse(record.ends_at) -
          Date.parse(record.starts_at),
      ).toISOString();
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
  const visible = (events.data?.items ?? []).filter(
    (event) => showExternal || event.provider === "local",
  );
  const monday = (new Date(`${monthStart}T12:00:00Z`).getUTCDay() + 6) % 7;
  const cells = Array.from({ length: 42 }, (_, index) =>
    add(monthStart, index - monday),
  );
  function move(direction: number) {
    if (view === "month") {
      const value = new Date(`${monthStart}T12:00:00Z`);
      value.setUTCMonth(value.getUTCMonth() + direction);
      setDate(value.toISOString().slice(0, 10));
    } else setDate(add(date, direction * (view === "week" ? 7 : 1)));
  }
  const monthLabel = new Intl.DateTimeFormat(
    language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
    { month: "long", year: "numeric", timeZone: ZONE },
  ).format(new Date(`${date}T12:00:00Z`));
  const days =
    view === "day"
      ? [date]
      : Array.from({ length: 7 }, (_, index) => add(date, index));
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
        <AddButton onClick={() => setCreate(true)}>
          {t("رویداد تازه", "New event")}
        </AddButton>
      </div>
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <Button onClick={() => move(-1)} aria-label={t("قبلی", "Previous")}>
            <ChevronRight size={17} />
          </Button>
          <h2>{monthLabel}</h2>
          <Button onClick={() => move(1)} aria-label={t("بعدی", "Next")}>
            <ChevronLeft size={17} />
          </Button>
          <Button onClick={() => setDate(today())}>
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
              onClick={() => setView(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="calendar-layers">
        <label>
          {t("تعطیلات", "Holidays")}
          <select
            value={region}
            onChange={(event) => {
              const value = event.target.value as HolidayRegion;
              setRegion(value);
              void action(
                "preferences_update",
                {
                  settings: {
                    ...preferences.data?.settings,
                    holiday_region: value,
                  },
                },
                preferences.data?.revision,
              );
            }}
          >
            <option value="BOTH">Jena + Seewiesen</option>
            <option value="SL">Saarland</option>
            <option value="TH">Thüringen</option>
            <option value="BY">Bayern</option>
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
      {view === "month" ? (
        <div className="month-calendar">
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
                  .filter(
                    (event) =>
                      instantToLocalDate(event.starts_at, ZONE) === day,
                  )
                  .map((event) => (
                    <button
                      key={event.occurrence_key ?? event.event_id}
                      className={`calendar-event ${event.provider === "local" ? "local" : "external"}`}
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
                    .filter((task) => task.due_date === day)
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
          {visible.length ? (
            visible.map((event) => (
              <button
                key={event.occurrence_key ?? event.event_id}
                className="agenda-row"
                onClick={() => setEditing(event)}
              >
                <div className="agenda-day">
                  <strong>
                    {formatInTimeZone(event.starts_at, ZONE, "dd")}
                  </strong>
                  <span>{formatInTimeZone(event.starts_at, ZONE, "MMM")}</span>
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
            ))
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
        <div
          className="week-calendar"
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
                  <div className="hour-slot" key={hour} />
                ))}
                {visible
                  .filter(
                    (event) =>
                      instantToLocalDate(event.starts_at, ZONE) === day,
                  )
                  .map((event) => {
                    const clock = instantToLocalTime(
                      event.starts_at,
                      ZONE,
                    ).split(":");
                    const minute = Number(clock[0]) * 60 + Number(clock[1]);
                    const duration =
                      (new Date(event.ends_at).getTime() -
                        new Date(event.starts_at).getTime()) /
                      60000;
                    return (
                      <button
                        key={event.occurrence_key ?? event.event_id}
                        className="time-block"
                        style={{
                          top: `${(minute / 60) * 52}px`,
                          height: `${Math.max(26, (duration / 60) * 52)}px`,
                        }}
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
                    );
                  })}
              </div>
            </div>
          ))}
        </div>
      )}
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
      />
    </>
  );
}

function EventEditor({
  open,
  event,
  date,
  close,
  action,
}: {
  open: boolean;
  event: EventDTO | null;
  date: string;
  close: () => void;
  action: Action;
}) {
  const { t } = useLocale();
  const [error, setError] = useState("");
  const [zone, setZone] = useState(event?.timezone ?? ZONE);
  const originalStart = event?.series_starts_at ?? event?.starts_at;
  const originalEnd = event?.series_ends_at ?? event?.ends_at;
  const startValue = originalStart
    ? formatInTimeZone(
        originalStart,
        event?.timezone ?? ZONE,
        "yyyy-MM-dd'T'HH:mm",
      )
    : `${date}T09:00`;
  const endValue = originalEnd
    ? formatInTimeZone(
        originalEnd,
        event?.timezone ?? ZONE,
        "yyyy-MM-dd'T'HH:mm",
      )
    : `${date}T10:00`;
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError("");
    const data = new FormData(e.currentTarget);
    try {
      const disambiguation = String(data.get("disambiguation")) as
        "reject" | "earlier" | "later";
      const result = await action(
        event ? "calendar_update_local_event" : "calendar_create_local_event",
        {
          ...(event ? { event_id: event.event_id } : {}),
          title: data.get("title"),
          ...(event &&
          String(data.get("starts")) === startValue &&
          zone === event.timezone
            ? {}
            : {
                starts_at: zonedLocalToInstant(
                  String(data.get("starts")),
                  zone,
                  disambiguation,
                ),
              }),
          ...(event &&
          String(data.get("ends")) === endValue &&
          zone === event.timezone
            ? {}
            : {
                ends_at: zonedLocalToInstant(
                  String(data.get("ends")),
                  zone,
                  disambiguation,
                ),
              }),
          timezone: zone,
          all_day: data.get("all_day") === "on",
          notes: data.get("notes"),
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
        <Field label={t("عنوان", "Title")}>
          <input
            required
            name="title"
            defaultValue={event?.title ?? ""}
            readOnly={!!external}
          />
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
          {t("تمام روز", "All day")}
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
    </Modal>
  );
}

export function WorkLog({ action }: { action: Action }) {
  const { t } = useLocale();
  const [month, setMonth] = useState(today().slice(0, 7));
  const [open, setOpen] = useState(false);
  const [selectedDay, setSelectedDay] = useState(today);
  const [error, setError] = useState("");
  const from = zonedLocalToInstant(`${month}-01T00:00`, ZONE);
  const next = new Date(`${month}-01T12:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const entries = useQuery<PageDTO<TimeEntryDTO>>("time_entry_list", {
    from,
    to: zonedLocalToInstant(`${next.toISOString().slice(0, 10)}T00:00`, ZONE),
    limit: 200,
  });
  const rows = entries.data?.items ?? [];
  const totals = (employer: string) =>
    rows
      .filter((row) => row.employer === employer)
      .reduce((sum, row) => sum + row.minutes, 0);
  const hours = (minutes: number) =>
    `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("زمان انجام‌شده، دقیق و روشن", "TIME WORKED, CLEARLY RECORDED")}
          </div>
          <h1>{t("ثبت ساعت کار", "Work log")}</h1>
          <p>
            {t(
              "ساعت‌ها و شرح فعالیت را برای هر محل کار نگه دار.",
              "Keep hours and activity descriptions together for each workplace.",
            )}
          </p>
        </div>
        <AddButton onClick={() => setOpen(true)}>
          {t("بازهٔ تازه", "New time entry")}
        </AddButton>
      </div>
      <div className="filter-bar">
        <input
          type="month"
          aria-label={t("ماه", "Month")}
          value={month}
          onChange={(e) => {
            setMonth(e.target.value);
            setSelectedDay(`${e.target.value}-01`);
          }}
        />
        {["Jena", "Seewiesen"].map((employer) => (
          <a
            className="button"
            key={employer}
            href={`/api/v1/time/export?month=${month}&employer=${employer}`}
          >
            <Download size={15} />
            Excel · {employer}
          </a>
        ))}
      </div>
      <div className="metric-grid">
        <div className="metric-card">
          <span>Jena</span>
          <strong>{hours(totals("Jena"))}</strong>
          <small>{t("ساعت این ماه", "hours this month")}</small>
        </div>
        <div className="metric-card">
          <span>Seewiesen</span>
          <strong>{hours(totals("Seewiesen"))}</strong>
          <small>{t("ساعت این ماه", "hours this month")}</small>
        </div>
        <div className="metric-card">
          <span>{t("مجموع بازه‌ها", "Time entries")}</span>
          <strong>{rows.length}</strong>
          <small>Europe/Berlin</small>
        </div>
      </div>
      <QueryState {...entries} retry={entries.refresh} />
      {!entries.loading && !rows.length ? (
        <Empty
          title={t(
            "اولین بازهٔ کارت را ثبت کن",
            "Record your first work session",
          )}
          detail={t(
            "رویدادهای تقویم به ساعت کار تبدیل نمی‌شوند.",
            "Calendar events are separate from worked hours.",
          )}
        />
      ) : (
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("تاریخ", "Date")}</th>
                <th>{t("محل کار", "Workplace")}</th>
                <th>{t("بازه", "Time")}</th>
                <th>{t("مدت", "Duration")}</th>
                <th>{t("شرح فعالیت", "Description")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.entry_id}>
                  <td>{instantToLocalDate(row.starts_at, ZONE)}</td>
                  <td>
                    <span
                      className={`chip ${row.employer === "Jena" ? "indigo" : "green"}`}
                    >
                      {row.employer}
                    </span>
                  </td>
                  <td dir="ltr">
                    {instantToLocalTime(row.starts_at, ZONE).slice(0, 5)}–
                    {instantToLocalTime(row.ends_at, ZONE).slice(0, 5)}
                  </td>
                  <td>{hours(row.minutes)}</td>
                  <td className="description-cell">{row.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <section className="panel work-timeline">
        <div className="section-heading">
          <h2>{t("نمای ۲۴ ساعتهٔ کار", "24-hour work timeline")}</h2>
          <input
            type="date"
            value={selectedDay}
            onChange={(event) => setSelectedDay(event.target.value)}
            aria-label={t("روز نمایش ساعت‌ها", "Timeline day")}
          />
        </div>
        <div
          className="week-calendar"
          style={{ gridTemplateColumns: "54px 1fr" }}
          dir="ltr"
        >
          <div className="hour-ruler">
            <div className="week-day-head" />
            {Array.from({ length: 24 }, (_, hour) => (
              <div key={hour}>{String(hour).padStart(2, "0")}:00</div>
            ))}
          </div>
          <div className="week-day">
            <div className="week-day-head">{selectedDay} · Europe/Berlin</div>
            <div className="day-hours">
              {Array.from({ length: 24 }, (_, hour) => (
                <div className="hour-slot" key={hour} />
              ))}
              {rows
                .flatMap((row) =>
                  splitIntervalByLocalDate(row, ZONE).map((segment) => ({
                    ...row,
                    ...segment,
                  })),
                )
                .filter((row) => row.date === selectedDay)
                .map((row) => {
                  const clock = instantToLocalTime(row.starts_at, ZONE).split(
                    ":",
                  );
                  const minute = Number(clock[0]) * 60 + Number(clock[1]);
                  return (
                    <div
                      key={row.entry_id}
                      className={`time-block ${row.employer === "Seewiesen" ? "seewiesen" : ""}`}
                      style={{
                        top: `${(minute / 60) * 52}px`,
                        height: `${Math.max(26, (row.minutes / 60) * 52)}px`,
                      }}
                    >
                      <strong>{row.employer}</strong>
                      <small>
                        {instantToLocalTime(row.starts_at, ZONE).slice(0, 5)} ·{" "}
                        {hours(row.minutes)}
                      </small>
                      <span>{row.description}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      </section>
      <Modal
        title={t("ثبت بازهٔ کار", "Record work time")}
        open={open}
        onOpenChange={setOpen}
      >
        <form
          className="form-grid"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            const form = new FormData(e.currentTarget);
            try {
              const result = await action("time_entry_create", {
                employer: form.get("employer"),
                starts_at: zonedLocalToInstant(
                  String(form.get("starts")),
                  ZONE,
                  String(form.get("disambiguation")) as
                    "reject" | "earlier" | "later",
                ),
                ends_at: zonedLocalToInstant(
                  String(form.get("ends")),
                  ZONE,
                  String(form.get("disambiguation")) as
                    "reject" | "earlier" | "later",
                ),
                description: form.get("description"),
              });
              if (result) setOpen(false);
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
          }}
        >
          <Field label={t("محل کار", "Workplace")}>
            <select name="employer">
              <option>Jena</option>
              <option>Seewiesen</option>
            </select>
          </Field>
          <div className="form-columns">
            <Field label={t("شروع", "Start")}>
              <input name="starts" required type="datetime-local" step={900} />
            </Field>
            <Field label={t("پایان", "End")}>
              <input name="ends" required type="datetime-local" step={900} />
            </Field>
          </div>
          <Field label={t("شرح فعالیت", "Activity description")}>
            <textarea name="description" maxLength={2000} rows={4} />
          </Field>
          <Field
            label={t("در ساعت پاییزی تکراری", "For ambiguous autumn times")}
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
          <Button variant="primary" type="submit">
            {t("ثبت ساعت", "Save time")}
          </Button>
        </form>
      </Modal>
    </>
  );
}
