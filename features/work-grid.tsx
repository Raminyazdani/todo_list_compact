"use client";

import { useState } from "react";
import type { PageDTO, TimeEntryDTO } from "@/shared/contracts";
import {
  addCalendarDays,
  instantToLocalTime,
  splitIntervalByLocalDate,
  zonedLocalToInstant,
} from "@/shared/datetime";
import { useQuery } from "./api";
import { useLocale } from "./locale";
import { Button, QueryState, SectionHeading } from "@/components/ui";

export function WeeklyWorkGrid({
  week,
  onEdit,
  onNew,
}: {
  week: string;
  onEdit: (entry: TimeEntryDTO) => void;
  onNew: (starts: string, ends: string) => void;
}) {
  const { t } = useLocale();
  const [cursor, setCursor] = useState<string | null>(null);
  const entries = useQuery<PageDTO<TimeEntryDTO>>("time_entry_list", {
    from: zonedLocalToInstant(`${week}T00:00`),
    to: zonedLocalToInstant(`${addCalendarDays(week, 7)}T00:00`),
    limit: 200,
    cursor,
  });
  const days = Array.from({ length: 7 }, (_, index) =>
    addCalendarDays(week, index),
  );
  const segments = (entries.data?.items ?? []).flatMap((entry) =>
    splitIntervalByLocalDate(entry).map((segment) => ({
      ...entry,
      ...segment,
    })),
  );
  return (
    <section className="panel work-timeline">
      <SectionHeading
        title={t("جدول هفتگی ۲۴ ساعتهٔ کار", "Weekly 24-hour work grid")}
      />
      <p className="small muted">
        {week} — {addCalendarDays(week, 7)} · Europe/Berlin.{" "}
        {t(
          "برای ویرایش، بازهٔ واقعی را باز کن؛ خانهٔ خالی یک پیش‌نویس قابل بررسی می‌سازد.",
          "Open a worked interval to edit it; an empty hour opens a draft for review.",
        )}
      </p>
      <QueryState {...entries} retry={entries.refresh} />
      <div
        className="week-calendar"
        role="region"
        aria-label={t("ساعت‌های هفتهٔ کار", "Work week hours")}
        tabIndex={0}
        dir="ltr"
        style={{ gridTemplateColumns: "54px repeat(7,minmax(115px,1fr))" }}
      >
        <div className="hour-ruler">
          <div className="week-day-head" />
          {Array.from({ length: 24 }, (_, hour) => (
            <div key={hour}>{String(hour).padStart(2, "0")}:00</div>
          ))}
        </div>
        {days.map((day) => (
          <div className="week-day" key={day}>
            <div className="week-day-head">{day}</div>
            <div className="day-hours">
              {Array.from({ length: 24 }, (_, hour) => (
                <button
                  key={hour}
                  className="hour-slot hour-create"
                  aria-label={`${t("ثبت زمان در", "Record time on")} ${day} ${String(hour).padStart(2, "0")}:00`}
                  onClick={() =>
                    onNew(
                      `${day}T${String(hour).padStart(2, "0")}:00`,
                      hour === 23
                        ? `${addCalendarDays(day, 1)}T00:00`
                        : `${day}T${String(hour + 1).padStart(2, "0")}:00`,
                    )
                  }
                />
              ))}
              {segments
                .filter((entry) => entry.date === day)
                .map((entry) => {
                  const [hour, minute] = instantToLocalTime(entry.starts_at)
                    .split(":")
                    .map(Number);
                  const original = entries.data!.items.find(
                    (item) => item.entry_id === entry.entry_id,
                  )!;
                  return (
                    <button
                      key={entry.entry_id}
                      className={`time-block ${entry.employer === "Seewiesen" ? "seewiesen" : ""}`}
                      style={{
                        top: `${(hour + minute / 60) * 52}px`,
                        height: `${Math.max(26, (entry.minutes / 60) * 52)}px`,
                      }}
                      onClick={() => onEdit(original)}
                      aria-label={`${t("ویرایش زمان هفته", "Edit weekly time")} ${entry.employer} ${entry.description}`}
                    >
                      <strong>{entry.employer}</strong>
                      <small>
                        {Math.round(entry.minutes * 100) / 100}{" "}
                        {t("دقیقه", "minutes")}
                      </small>
                      <span>{entry.description}</span>
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
      <div className="form-actions">
        <span className="small muted">
          {entries.data?.items.length ?? 0}/{entries.data?.total ?? "—"}{" "}
          {t(
            "بازه در این صفحه؛ جمع هفتگی همهٔ رکوردها را حساب می‌کند.",
            "entries on this page; weekly totals include all records.",
          )}
        </span>
        {cursor && (
          <Button onClick={() => setCursor(null)}>
            {t("ابتدای جدول هفته", "First week page")}
          </Button>
        )}
        {entries.data?.next_cursor && (
          <Button onClick={() => setCursor(entries.data!.next_cursor)}>
            {t("بازه‌های بعدی هفته", "Next week entries")}
          </Button>
        )}
      </div>
    </section>
  );
}
