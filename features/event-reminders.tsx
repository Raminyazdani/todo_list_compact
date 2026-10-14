"use client";

import { useState } from "react";
import type {
  EventDTO,
  CalendarReminderDTO,
  CommandName,
  MutationResult,
  PageDTO,
} from "@/shared/contracts";
import { zonedLocalToInstant } from "@/shared/datetime";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import {
  Button,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";

type Action = (
  command: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
export function EventReminders({
  event,
  action,
}: {
  event: EventDTO;
  action: Action;
}) {
  const { t, language } = useLocale();
  const [cursor, setCursor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{
    item: CalendarReminderDTO;
    command: "calendar_reminder_resume" | "calendar_reminder_cancel";
  } | null>(null);
  const [error, setError] = useState("");
  const list = useQuery<PageDTO<CalendarReminderDTO>>(
    "calendar_reminder_list",
    { event_id: event.event_id, limit: 50, cursor },
  );
  return (
    <section className="event-reminders">
      <SectionHeading
        title={t("یادآور همین رویداد", "This event's reminders")}
      />
      <p className="muted small">
        {t(
          "اعلان داخل برنامه با زمان‌بند روزانه یا اجرای دستی بررسی می‌شود. زمان ثبت‌شده حفظ می‌شود.",
          "In-app delivery is checked by the daily scheduler or manual run. The recorded reminder time is preserved.",
        )}
      </p>
      <QueryState {...list} retry={list.refresh} />
      {list.data?.items.map((item) => (
        <div
          className="grant-row"
          key={item.reminder_id}
          data-event-reminder-id={item.reminder_id}
        >
          <time>
            {new Date(item.remind_at).toLocaleString(
              language === "fa" ? "fa-IR-u-ca-gregory" : "en-GB",
              { timeZone: event.timezone },
            )}
          </time>
          <span className="chip">{item.state}</span>
          {item.state === "Pending" && (
            <Button
              onClick={() =>
                void action(
                  "calendar_reminder_pause",
                  { reminder_id: item.reminder_id },
                  item.revision,
                )
              }
            >
              {t("توقف یادآور رویداد", "Pause event reminder")}
            </Button>
          )}
          {item.state === "Paused" && (
            <Button
              onClick={() =>
                setConfirm({ item, command: "calendar_reminder_resume" })
              }
            >
              {t("ازسرگیری یادآور رویداد", "Resume event reminder")}
            </Button>
          )}
          {(item.state === "Pending" || item.state === "Paused") && (
            <Button
              onClick={() =>
                setConfirm({ item, command: "calendar_reminder_cancel" })
              }
            >
              {t("لغو یادآور رویداد", "Cancel event reminder")}
            </Button>
          )}
        </div>
      ))}
      <div className="form-actions">
        {cursor && (
          <Button onClick={() => setCursor(null)}>
            {t("ابتدای یادآورهای رویداد", "First event reminders")}
          </Button>
        )}
        {list.data?.next_cursor && (
          <Button onClick={() => setCursor(list.data!.next_cursor)}>
            {t("یادآورهای بیشتر رویداد", "More event reminders")}
          </Button>
        )}
      </div>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setError("");
          const form = e.currentTarget;
          const data = new FormData(form);
          try {
            const remind_at = zonedLocalToInstant(
              String(data.get("remind_at")),
              event.timezone,
              String(data.get("disambiguation")) as
                "reject" | "earlier" | "later",
            );
            const result = await action("calendar_reminder_create", {
              event_id: event.event_id,
              remind_at,
              ...(event.recurrence_rule
                ? { occurrence_starts_at: event.starts_at }
                : {}),
            });
            if (result) form.reset();
          } catch (error) {
            setError(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        <Field label={t("زمان یادآور رویداد", "Event reminder time")}>
          <input name="remind_at" type="datetime-local" step="1" required />
        </Field>
        <Field label={t("ساعت تکراری یادآور", "Repeated reminder time")}>
          <select name="disambiguation">
            <option value="reject">
              {t(
                "انتخاب در زمان مبهم لازم است",
                "Require choice when ambiguous",
              )}
            </option>
            <option value="earlier">{t("بار اول", "First occurrence")}</option>
            <option value="later">{t("بار دوم", "Second occurrence")}</option>
          </select>
        </Field>
        {event.recurrence_rule && (
          <p className="muted small">
            {t(
              "این یادآور برای نوبت انتخاب‌شده ثبت می‌شود:",
              "This reminder applies to the selected occurrence:",
            )}{" "}
            {event.starts_at}
          </p>
        )}
        {error && (
          <p role="alert" className="warning">
            {error}
          </p>
        )}
        <Button type="submit">
          {t("ثبت یادآور رویداد", "Save event reminder")}
        </Button>
      </form>
      <Modal
        title={t("تأیید تغییر یادآور رویداد", "Confirm event reminder change")}
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
      >
        <p>
          {confirm?.command === "calendar_reminder_cancel"
            ? t(
                "یادآور لغو می‌شود و دوباره ارسال نمی‌شود.",
                "The reminder is cancelled and cannot be resent.",
              )
            : t(
                "یادآور با زمان اصلی از سر گرفته می‌شود؛ زمان گذشته ممکن است در اجرای بعدی تحویل شود.",
                "The reminder resumes at its original time; an overdue reminder may be delivered on the next run.",
              )}
        </p>
        <Button
          variant="primary"
          onClick={async () => {
            if (
              confirm &&
              (await action(
                confirm.command,
                { reminder_id: confirm.item.reminder_id },
                confirm.item.revision,
              ))
            )
              setConfirm(null);
          }}
        >
          {t("تأیید تغییر یادآور رویداد", "Confirm event reminder change")}
        </Button>
      </Modal>
    </section>
  );
}
