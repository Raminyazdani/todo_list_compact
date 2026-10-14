"use client";

import { useState } from "react";
import Link from "next/link";
import type {
  CommandName,
  MutationResult,
  TaskDTO,
  EventDTO,
  TimeEntryDTO,
  PageDTO,
} from "@/shared/contracts";
import {
  addCalendarDays,
  instantToLocalDate,
  zonedLocalToInstant,
} from "@/shared/datetime";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import {
  Button,
  Empty,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

export function TaskSchedule({
  task,
  action,
}: {
  task: TaskDTO;
  action: Action;
}) {
  const { t, language } = useLocale();
  const zone = task.timezone || "Europe/Berlin";
  const [date, setDate] = useState(() =>
    instantToLocalDate(new Date().toISOString(), zone),
  );
  const [eventCursor, setEventCursor] = useState<string | null>(null);
  const [timeCursor, setTimeCursor] = useState<string | null>(null);
  const [capture, setCapture] = useState<"event" | "time" | null>(null);
  const [error, setError] = useState("");
  const events = useQuery<PageDTO<EventDTO>>("calendar_events_query", {
    task_id: task.task_id,
    from: zonedLocalToInstant(`${date}T00:00`, zone),
    to: zonedLocalToInstant(`${addCalendarDays(date, 90)}T00:00`, zone),
    limit: 50,
    cursor: eventCursor,
  });
  const times = useQuery<PageDTO<TimeEntryDTO>>("time_entry_list", {
    task_id: task.task_id,
    limit: 50,
    cursor: timeCursor,
  });
  const summary = useQuery<{ minutes: number; entries: number }>(
    "time_summary",
    { task_id: task.task_id },
  );
  const timestamp = (instant: string) =>
    new Date(instant).toLocaleString(
      language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
      { timeZone: zone },
    );
  return (
    <section className="task-schedule">
      <div className="metric-grid">
        <div className="metric-card">
          <span>{t("زمان واقعی همین کار", "Actual time for this task")}</span>
          <strong>
            {summary.data ? Math.round(summary.data.minutes * 100) / 100 : "—"}
          </strong>
          <small>
            {t(
              "دقیقه از همهٔ رکوردهای مرتبط",
              "minutes across all linked records",
            )}{" "}
            · {summary.data?.entries ?? "—"} {t("بازه", "entries")}
          </small>
        </div>
        <div className="metric-card">
          <span>{t("برآورد مستقل", "Independent estimate")}</span>
          <strong>{task.estimated_minutes ?? "—"}</strong>
          <small>{t("دقیقه", "minutes")}</small>
        </div>
      </div>
      <QueryState {...summary} retry={summary.refresh} />
      <SectionHeading title={t("رویدادهای مرتبط", "Linked events")} />
      <Field
        label={t("شروع بازهٔ تقویم این کار", "Task calendar range starts")}
      >
        <input
          type="date"
          value={date}
          onChange={(event) => {
            if (event.target.value) {
              setDate(event.target.value);
              setEventCursor(null);
            }
          }}
        />
      </Field>
      <p className="muted small">
        {date} — {addCalendarDays(date, 90)} · {zone}.{" "}
        {t(
          "تاریخ مهلت، رویداد و زمان انجام‌شده مستقل‌اند. ثبت رویداد به انتخاب صریح شما انجام می‌شود.",
          "Deadlines, events and worked time remain independent. Events are recorded only by your explicit action.",
        )}
      </p>
      <QueryState {...events} retry={events.refresh} />
      {events.data?.items.map((event) => (
        <div
          className="dependency-row"
          key={event.occurrence_key ?? event.event_id}
        >
          <strong>{event.title}</strong>
          <time>
            {timestamp(event.starts_at)} — {timestamp(event.ends_at)}
          </time>
          <span className="chip">{event.provider}</span>
        </div>
      ))}
      {events.data && !events.data.items.length && (
        <Empty
          title={t(
            "رویداد مرتبطی در این بازه نیست",
            "No linked events in this range",
          )}
        />
      )}
      <div className="form-actions">
        <Button
          onClick={() => {
            setCapture("event");
            setError("");
          }}
        >
          {t("ثبت رویداد محلی مرتبط", "Create a linked local event")}
        </Button>
        <Link className="button" href="/calendar">
          {t("بازکردن تقویم", "Open calendar")}
        </Link>
        {eventCursor && (
          <Button onClick={() => setEventCursor(null)}>
            {t("ابتدای رویدادها", "First events")}
          </Button>
        )}
        {events.data?.next_cursor && (
          <Button onClick={() => setEventCursor(events.data!.next_cursor)}>
            {t("رویدادهای بیشتر", "More events")}
          </Button>
        )}
      </div>
      <SectionHeading title={t("بازه‌های انجام‌شده", "Worked time entries")} />
      <QueryState {...times} retry={times.refresh} />
      {times.data?.items.map((entry) => (
        <div className="dependency-row" key={entry.entry_id}>
          <strong>{entry.employer}</strong>
          <span>{entry.description}</span>
          <time>
            {timestamp(entry.starts_at)} — {timestamp(entry.ends_at)}
          </time>
          <span>
            {Math.round(entry.minutes * 100) / 100} {t("دقیقه", "minutes")}
          </span>
        </div>
      ))}
      {times.data && !times.data.items.length && (
        <Empty
          title={t(
            "زمان انجام‌شده‌ای به این کار وصل نشده",
            "No worked time linked to this task",
          )}
        />
      )}
      <div className="form-actions">
        <Button
          onClick={() => {
            setCapture("time");
            setError("");
          }}
        >
          {t("ثبت زمان واقعی برای این کار", "Record worked time for this task")}
        </Button>
        {timeCursor && (
          <Button onClick={() => setTimeCursor(null)}>
            {t("ابتدای زمان‌ها", "First entries")}
          </Button>
        )}
        {times.data?.next_cursor && (
          <Button onClick={() => setTimeCursor(times.data!.next_cursor)}>
            {t("بازه‌های بیشتر", "More entries")}
          </Button>
        )}
      </div>
      <Modal
        title={
          capture === "event"
            ? t("رویداد محلی مرتبط", "Linked local event")
            : t("زمان واقعی مرتبط", "Linked worked time")
        }
        open={!!capture}
        onOpenChange={(open) => {
          if (!open) setCapture(null);
        }}
      >
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            setError("");
            const data = new FormData(event.currentTarget);
            try {
              const timezone = String(data.get("timezone"));
              const choice = String(data.get("disambiguation")) as
                "reject" | "earlier" | "later";
              const starts_at = zonedLocalToInstant(
                String(data.get("starts")),
                timezone,
                choice,
              );
              const ends_at = zonedLocalToInstant(
                String(data.get("ends")),
                timezone,
                choice,
              );
              if (Date.parse(ends_at) <= Date.parse(starts_at))
                throw new Error(
                  t("پایان باید بعد از شروع باشد", "End must follow start"),
                );
              const result = await action(
                capture === "event"
                  ? "calendar_create_local_event"
                  : "time_entry_create",
                {
                  task_id: task.task_id,
                  starts_at,
                  ends_at,
                  ...(capture === "event"
                    ? {
                        title: data.get("title"),
                        notes: data.get("notes"),
                        timezone,
                      }
                    : {
                        employer: data.get("employer"),
                        description: data.get("notes"),
                      }),
                },
              );
              if (result) setCapture(null);
            } catch (error) {
              setError(error instanceof Error ? error.message : String(error));
            }
          }}
        >
          {capture === "event" ? (
            <Field label={t("عنوان رویداد مرتبط", "Linked event title")}>
              <input name="title" required defaultValue={task.title} />
            </Field>
          ) : (
            <Field label={t("محل کار مرتبط", "Linked workplace")}>
              <input
                name="employer"
                list="task-employers"
                required
                defaultValue="Jena"
              />
              <datalist id="task-employers">
                <option value="Jena" />
                <option value="Seewiesen" />
              </datalist>
            </Field>
          )}
          <div className="form-columns">
            <Field label={t("شروع بازهٔ مرتبط", "Linked interval start")}>
              <input name="starts" type="datetime-local" step="1" required />
            </Field>
            <Field label={t("پایان بازهٔ مرتبط", "Linked interval end")}>
              <input name="ends" type="datetime-local" step="1" required />
            </Field>
          </div>
          <Field label={t("منطقهٔ زمانی بازه", "Interval timezone")}>
            <input name="timezone" required defaultValue={zone} />
          </Field>
          <Field label={t("انتخاب ساعت تکراری", "Repeated time choice")}>
            <select name="disambiguation" defaultValue="reject">
              <option value="reject">
                {t(
                  "نیازمند انتخاب در زمان مبهم",
                  "Require choice when ambiguous",
                )}
              </option>
              <option value="earlier">
                {t("بار اول", "First occurrence")}
              </option>
              <option value="later">{t("بار دوم", "Second occurrence")}</option>
            </select>
          </Field>
          <Field label={t("شرح بازهٔ مرتبط", "Linked interval description")}>
            <textarea name="notes" maxLength={10000} />
          </Field>
          {error && (
            <p role="alert" className="warning">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit">
            {t("تأیید ثبت بازهٔ مرتبط", "Confirm linked interval")}
          </Button>
        </form>
      </Modal>
    </section>
  );
}
