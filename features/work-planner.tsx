"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { Download, Undo2, ChevronLeft, ChevronRight } from "lucide-react";
import type { EventDTO, PageDTO, TimeEntryDTO } from "@/shared/contracts";
import {
  HOLIDAY_REGIONS,
  dayFlags,
  type HolidayRegion,
} from "@/server/integrations/holidays";
import {
  addCalendarDays,
  instantToLocalDate,
  instantToLocalTime,
  zonedLocalToInstant,
} from "@/shared/datetime";
import { Button, Empty, Field, Modal, QueryState } from "@/components/ui";
import { useLocale } from "./locale";
import { usePagedQuery, useQuery } from "./api";
import type { CalendarAction } from "./calendar-workspace";
import { TimeTransfer } from "./time-transfer";
import {
  entryLocal,
  localPoint,
  minuteClock,
  monthDays,
  snappedMinute,
  workConflicts,
  workSegments,
  WORK_ZONE,
} from "./work-planner-model";

type DraftFields = {
  employer: string;
  date: string;
  start: string;
  end: string;
  end_next_day: boolean;
  description: string;
  timezone: string;
};
type WorkDraft = DraftFields & { draft_id: string; revision: number };
type ExtendedEntry = TimeEntryDTO & {
  reporting_policy?: string;
  reported_minutes?: number | null;
};
function hours(minutes: number) {
  const seconds = Math.round(minutes * 60);
  return `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}${seconds % 60 ? `:${String(seconds % 60).padStart(2, "0")}` : ""}`;
}
function entryRevision(result: { version?: number } | null, fallback: number) {
  return result?.version ?? fallback;
}

export function WorkPlanner({
  action,
  date,
  onDate,
  region: selectedRegion,
  onRegion,
  calendarId,
  onCalendar,
  showExternal,
  onExternal,
}: {
  action: CalendarAction;
  date: string;
  onDate: (date: string) => void;
  region: HolidayRegion | null;
  onRegion: (region: HolidayRegion) => void;
  calendarId: string;
  onCalendar: (id: string) => void;
  showExternal: boolean;
  onExternal: (show: boolean) => void;
}) {
  const { t } = useLocale();
  const month = date.slice(0, 7),
    days = monthDays(month);
  const from = zonedLocalToInstant(`${days[0]}T00:00`, WORK_ZONE),
    to = zonedLocalToInstant(
      `${addCalendarDays(days.at(-1)!, 1)}T00:00`,
      WORK_ZONE,
    );
  const entries = usePagedQuery<TimeEntryDTO>("time_entry_list", { from, to });
  const drafts = usePagedQuery<WorkDraft>("time_draft_list");
  const events = usePagedQuery<EventDTO>("calendar_events_query", {
    from,
    to,
    ...(calendarId ? { calendar_id: calendarId } : {}),
  });
  const sources = useQuery<PageDTO<Record<string, unknown>>>("calendar_list");
  const summary = useQuery<{
    minutes: number;
    employers: Record<string, number>;
    entries: number;
  }>("time_summary", { from, to });
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const region =
    selectedRegion ??
    (HOLIDAY_REGIONS.includes(
      preferences.data?.settings.holiday_region as HolidayRegion,
    )
      ? (preferences.data!.settings.holiday_region as HolidayRegion)
      : "BOTH");
  const [error, setError] = useState("");
  const [selectedEvent, setSelectedEvent] = useState<EventDTO | null>(null);
  const [editor, setEditor] = useState<{
    row?: TimeEntryDTO;
    starts: string;
    ends: string;
  } | null>(null);
  const [undo, setUndo] = useState<{
    entry_id: string;
    revision: number;
  } | null>(null);
  const [creating, setCreating] = useState(false);
  const [showWorkLayer, setShowWorkLayer] = useState(true);
  const [showEventLayer, setShowEventLayer] = useState(true);
  const rows = entries.data?.items ?? [];
  const eventRows = (events.data?.items ?? []).filter(
    (event) => showExternal || event.provider === "local",
  );
  const conflicts = workConflicts(rows, eventRows, from, to);
  async function tracked(
    name: Parameters<CalendarAction>[0],
    input: Record<string, unknown>,
    revision?: number,
  ) {
    const result = await action(name, input, revision);
    if (
      result &&
      (name === "time_entry_create" ||
        name === "time_entry_update" ||
        name === "time_entry_archive")
    )
      setUndo({
        entry_id: String(input.entry_id ?? result.entity_id),
        revision: entryRevision(result, (revision ?? 0) + 1),
      });
    return result;
  }
  async function newDraft() {
    setCreating(true);
    try {
      await action("time_draft_save", {
        employer: "Jena",
        date,
        start: "",
        end: "",
        end_next_day: false,
        description: "",
        timezone: WORK_ZONE,
      });
    } finally {
      setCreating(false);
    }
  }
  function moveMonth(direction: number) {
    const value = new Date(`${month}-01T12:00:00Z`);
    value.setUTCMonth(value.getUTCMonth() + direction);
    onDate(value.toISOString().slice(0, 10));
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("زمان انجام‌شده، دقیق و روشن", "TIME WORKED, CLEARLY RECORDED")}
          </div>
          <h1>{t("ساعات کار", "Work time")}</h1>
          <p>
            {t(
              "بازه‌ها، توضیحات و تقویم‌ها در یک فضای مشترک؛ با حفظ مجموع ساعات ثبت‌شده.",
              "Intervals, descriptions and calendars in one workspace, preserving recorded hours.",
            )}
          </p>
        </div>
        <Button
          variant="primary"
          disabled={creating}
          onClick={() => void newDraft()}
        >
          {t("ردیف تازه", "New draft row")}
        </Button>
      </div>
      <div className="calendar-toolbar">
        <div className="calendar-navigation">
          <Button
            onClick={() => moveMonth(-1)}
            aria-label={t("ماه قبل", "Previous month")}
          >
            <ChevronRight size={17} />
          </Button>
          <input
            type="month"
            aria-label={t("ماه", "Month")}
            value={month}
            onChange={(event) => {
              if (event.target.value) onDate(`${event.target.value}-01`);
            }}
          />
          <Button
            onClick={() => moveMonth(1)}
            aria-label={t("ماه بعد", "Next month")}
          >
            <ChevronLeft size={17} />
          </Button>
          <Button
            onClick={() =>
              onDate(instantToLocalDate(new Date().toISOString(), WORK_ZONE))
            }
          >
            {t("امروز", "Today")}
          </Button>
        </div>
        <div className="form-actions">
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
          <Button
            disabled={!undo}
            onClick={async () => {
              if (
                undo &&
                (await action(
                  "time_entry_undo",
                  { entry_id: undo.entry_id },
                  undo.revision,
                ))
              )
                setUndo(null);
            }}
          >
            <Undo2 size={15} />
            {t("بازگردانی آخرین تغییر", "Undo last interval change")}
          </Button>
        </div>
      </div>
      <div className="calendar-layers">
        <Field label={t("منبع تقویم", "Calendar source")}>
          <select
            value={calendarId}
            onChange={(event) => onCalendar(event.target.value)}
          >
            <option value="">
              {t("همهٔ منابع مجاز", "All authorized sources")}
            </option>
            {sources.data?.items.map((source) => (
              <option
                key={String(source.calendar_id)}
                value={String(source.calendar_id)}
              >
                {String(source.title)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("تعطیلات", "Holidays")}>
          <select
            value={region}
            onChange={(event) => {
              const value = event.target.value as HolidayRegion;
              onRegion(value);
              if (preferences.data && !preferences.fetching)
                void action(
                  "preferences_update",
                  { settings: { holiday_region: value } },
                  preferences.data.revision,
                );
            }}
          >
            {HOLIDAY_REGIONS.map((value) => (
              <option key={value} value={value}>
                {value === "BOTH" ? "Jena + Seewiesen" : value}
              </option>
            ))}
          </select>
        </Field>
        <label>
          <input
            type="checkbox"
            checked={showExternal}
            onChange={(event) => onExternal(event.target.checked)}
          />
          {t("تقویم‌های متصل", "Connected calendars")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={showWorkLayer}
            onChange={(event) => setShowWorkLayer(event.target.checked)}
          />
          {t("لایهٔ ساعات کار", "Work layer")}
        </label>
        <label>
          <input
            type="checkbox"
            checked={showEventLayer}
            onChange={(event) => setShowEventLayer(event.target.checked)}
          />
          {t("لایهٔ تقویم", "Calendar overlay")}
        </label>
      </div>
      <div className="metric-grid">
        {["Jena", "Seewiesen"].map((employer) => (
          <div className="metric-card" key={employer}>
            <span>{employer}</span>
            <strong>
              {summary.data
                ? hours(summary.data.employers[employer] ?? 0)
                : "—"}
            </strong>
            <small>{t("ساعت این ماه", "hours this month")}</small>
          </div>
        ))}
        <div className="metric-card">
          <span>{t("مجموع ساعت ماه", "Total monthly hours")}</span>
          <strong>{summary.data ? hours(summary.data.minutes) : "—"}</strong>
          <small>
            {summary.data?.entries ?? "—"} {t("بازه", "entries")}
          </small>
        </div>
        <div className="metric-card">
          <span>{t("دقایق تداخلِ یکتا", "Union of conflict minutes")}</span>
          <strong>{Math.round(conflicts.minutes * 100) / 100}</strong>
          <small>
            {t("از مجموع ساعات کم نمی‌شود", "Not deducted from recorded hours")}
          </small>
        </div>
      </div>
      <QueryState {...summary} retry={summary.refresh} />
      <TimeTransfer from={from} to={to} month={month} action={action} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <QueryState {...entries} retry={entries.refresh} />
      <QueryState {...drafts} retry={drafts.refresh} />
      <QueryState {...events} retry={events.refresh} />
      {events.data?.source_warnings?.length ? (
        <p className="warning" role="status">
          {t(
            "بخشی از منابع قدیمی یا ناقص است؛ تداخل‌های تقویم برای پوشش موجود محاسبه شده‌اند.",
            "Some sources are stale or incomplete; calendar conflicts reflect available coverage.",
          )}
        </p>
      ) : null}
      <MonthlyWorkTimeline
        days={days}
        entries={showWorkLayer ? rows : []}
        events={showEventLayer ? eventRows : []}
        region={region}
        onEvent={setSelectedEvent}
        onNew={(starts, ends) => setEditor({ starts, ends })}
        onEdit={(row) =>
          setEditor({
            row,
            starts: `${instantToLocalDate(row.starts_at)}T${instantToLocalTime(row.starts_at)}`,
            ends: `${instantToLocalDate(row.ends_at)}T${instantToLocalTime(row.ends_at)}`,
          })
        }
        onMove={async (row, starts, ends) => {
          try {
            const result = await tracked(
              "time_entry_update",
              { entry_id: row.entry_id, starts_at: starts, ends_at: ends },
              row.revision,
            );
            return result
              ? {
                  ...row,
                  ...(result.data as Partial<TimeEntryDTO>),
                  revision: result.version,
                  starts_at: starts,
                  ends_at: ends,
                }
              : null;
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : String(cause));
            return null;
          }
        }}
      />
      {!!conflicts.intersections.length && (
        <details className="calendar-overlaps">
          <summary>
            {conflicts.intersections.length}{" "}
            {t(
              "تداخل؛ ذخیرهٔ همهٔ بازه‌ها مجاز است",
              "conflicts; all intervals can be saved",
            )}
          </summary>
          <p className="small muted">
            {t("هم‌پوشانی کار با کار", "Work/work")}:{" "}
            {Math.round(conflicts.workMinutes)} ·{" "}
            {t("کار با تقویم", "Work/calendar")}:{" "}
            {Math.round(conflicts.eventMinutes)}{" "}
            {t("دقیقهٔ یکتا", "union minutes")}
          </p>
          {conflicts.intersections.map((value, index) => (
            <div
              className="dependency-row"
              key={`${value.first}:${value.second}:${index}`}
            >
              <span>{value.label}</span>
              <time dir="ltr">
                {instantToLocalDate(value.starts_at)}{" "}
                {instantToLocalTime(value.starts_at)}–
                {instantToLocalTime(value.ends_at)}
              </time>
            </div>
          ))}
        </details>
      )}
      <section className="panel">
        <h2>{t("جدول ساعات و توضیحات", "Work intervals and descriptions")}</h2>
        <p className="small muted">
          {t(
            "با خروج از هر فیلد، تغییر ذخیره می‌شود. پیش‌نویس‌های ناقص تا تکمیل از مجموع و Excel کنار می‌مانند. در تعارض چند دستگاه، متن محلی حفظ می‌شود.",
            "Changes save when you leave a field. Incomplete drafts stay outside totals and Excel. Local edits are retained during device conflicts.",
          )}
        </p>
        <div className="data-table-wrap">
          <table className="work-inline-table">
            <thead>
              <tr>
                <th>{t("تاریخ", "Date")}</th>
                <th>{t("محل کار", "Workplace")}</th>
                <th>{t("شروع", "Start")}</th>
                <th>{t("پایان", "End")}</th>
                <th>{t("روز بعد", "Next day")}</th>
                <th>{t("مدت و وضعیت", "Duration and status")}</th>
                <th>{t("عملیات", "Actions")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <InlineWorkRow key={row.entry_id} row={row} action={tracked} />
              ))}
              {drafts.data?.items
                .filter((draft) => !draft.date || draft.date.startsWith(month))
                .map((draft) => (
                  <InlineWorkRow
                    key={draft.draft_id}
                    draft={draft}
                    action={tracked}
                  />
                ))}
            </tbody>
          </table>
        </div>
        {!entries.loading && !rows.length && !drafts.data?.items.length && (
          <Empty
            title={t(
              "اولین بازهٔ کارت را ثبت کن",
              "Record your first work session",
            )}
            detail={t(
              "رویدادهای تقویم خودکار به ساعات کار تبدیل نمی‌شوند.",
              "Calendar events do not automatically become worked hours.",
            )}
          />
        )}
      </section>
      <Modal
        title={
          editor?.row
            ? t("ویرایش بازهٔ کار", "Edit work interval")
            : t("ثبت بازهٔ کار", "Record work interval")
        }
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        {editor && (
          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              const values = new FormData(event.currentTarget);
              setError("");
              try {
                const startChoice = String(
                  values.get("start_disambiguation"),
                ) as "reject" | "earlier" | "later";
                const endChoice = String(values.get("end_disambiguation")) as
                  "reject" | "earlier" | "later";
                const startLocal = String(values.get("starts")),
                  endLocal = String(values.get("ends"));
                const result = await tracked(
                  editor.row ? "time_entry_update" : "time_entry_create",
                  {
                    ...(editor.row ? { entry_id: editor.row.entry_id } : {}),
                    employer: String(values.get("employer")),
                    starts_at:
                      editor.row && startLocal === editor.starts
                        ? editor.row.starts_at
                        : zonedLocalToInstant(
                            startLocal,
                            WORK_ZONE,
                            startChoice,
                          ),
                    ends_at:
                      editor.row && endLocal === editor.ends
                        ? editor.row.ends_at
                        : zonedLocalToInstant(endLocal, WORK_ZONE, endChoice),
                    description: String(values.get("description")),
                  },
                  editor.row?.revision,
                );
                if (result) setEditor(null);
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
          >
            <Field label={t("محل کار", "Workplace")}>
              <select
                name="employer"
                defaultValue={editor.row?.employer ?? "Jena"}
              >
                <option>Jena</option>
                <option>Seewiesen</option>
              </select>
            </Field>
            <Field label={t("شروع", "Start")}>
              <input
                required
                name="starts"
                type="datetime-local"
                step={60}
                defaultValue={editor.starts}
              />
            </Field>
            <Field label={t("پایان", "End")}>
              <input
                required
                name="ends"
                type="datetime-local"
                step={60}
                defaultValue={editor.ends}
              />
            </Field>
            <Field label={t("شرح فعالیت", "Activity description")}>
              <textarea
                name="description"
                rows={4}
                defaultValue={editor.row?.description ?? ""}
              />
            </Field>
            <FoldChoice />
            <p className="small muted">
              {t(
                "بازهٔ جدید با زمان واقعی سپری‌شده محاسبه می‌شود؛ تداخل با هشدار قابل‌ذخیره است.",
                "New intervals use elapsed time; overlaps can be saved with warnings.",
              )}
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <Button type="submit" variant="primary">
              {t("ثبت ساعت", "Save time")}
            </Button>
          </form>
        )}
      </Modal>
      <Modal
        title={selectedEvent?.title ?? ""}
        open={!!selectedEvent}
        onOpenChange={(open) => {
          if (!open) setSelectedEvent(null);
        }}
      >
        {selectedEvent && (
          <>
            <p>{selectedEvent.notes}</p>
            <p dir="ltr">
              {selectedEvent.starts_at} → {selectedEvent.ends_at}
            </p>
            <p>
              {selectedEvent.all_day
                ? t("تمام روز", "All day")
                : selectedEvent.timezone}{" "}
              · {selectedEvent.source_title ?? selectedEvent.provider}
            </p>
            {selectedEvent.external_url &&
              /^https:\/\/(calendar\.google\.com|www\.google\.com)\//.test(
                selectedEvent.external_url,
              ) && (
                <a
                  className="button"
                  target="_blank"
                  rel="noopener noreferrer"
                  href={selectedEvent.external_url}
                >
                  {t("بازکردن در Google", "Open in Google")}
                </a>
              )}
          </>
        )}
      </Modal>
    </>
  );
}

function FoldChoice() {
  const { t } = useLocale();
  return (
    <div className="form-columns">
      {(["start", "end"] as const).map((endpoint) => (
        <Field
          key={endpoint}
          label={
            endpoint === "start"
              ? t("ساعت پاییزیِ شروع", "Repeated start time")
              : t("ساعت پاییزیِ پایان", "Repeated end time")
          }
        >
          <select name={`${endpoint}_disambiguation`}>
            <option value="reject">
              {t("نیاز به انتخاب", "Require a choice")}
            </option>
            <option value="earlier">{t("بار اول", "First occurrence")}</option>
            <option value="later">{t("بار دوم", "Second occurrence")}</option>
          </select>
        </Field>
      ))}
    </div>
  );
}

function InlineWorkRow({
  row,
  draft,
  action,
}: {
  row?: ExtendedEntry;
  draft?: WorkDraft;
  action: CalendarAction;
}) {
  const { t } = useLocale();
  const initial = row ? { ...entryLocal(row), timezone: WORK_ZONE } : draft!;
  const [fields, setFields] = useState<DraftFields>(initial);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [choices, setChoices] = useState<{
    start: "reject" | "earlier" | "later";
    end: "reject" | "earlier" | "later";
  }>({ start: "reject", end: "reject" });
  const current = useRef(fields),
    saved = useRef(JSON.stringify(initial)),
    revision = useRef(row?.revision ?? draft!.revision),
    busy = useRef(false);
  const conflictRef = useRef(false);
  useEffect(() => {
    conflictRef.current = conflict;
  }, [conflict]);
  const sourceRevision = row?.revision ?? draft!.revision;
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active || sourceRevision === revision.current || busy.current)
        return;
      if (JSON.stringify(current.current) !== saved.current) {
        setConflict(true);
        return;
      }
      const next = row ? { ...entryLocal(row), timezone: WORK_ZONE } : draft!;
      revision.current = sourceRevision;
      saved.current = JSON.stringify(next);
      current.current = next;
      setFields(next);
    });
    return () => {
      active = false;
    };
  }, [sourceRevision, row, draft]);
  async function save(force = false) {
    if (busy.current || (conflictRef.current && !force)) return;
    const snapshot = { ...current.current },
      fingerprint = JSON.stringify(snapshot);
    if (fingerprint === saved.current && !force) return;
    busy.current = true;
    let acknowledged = false;
    setStatus(t("در حال ذخیره…", "Saving…"));
    setError("");
    try {
      const expected = force ? sourceRevision : revision.current;
      const starts =
        snapshot.date && snapshot.start
          ? `${snapshot.date}T${snapshot.start}`
          : "";
      const ends =
        snapshot.date && snapshot.end
          ? `${snapshot.end_next_day ? addCalendarDays(snapshot.date, 1) : snapshot.date}T${snapshot.end}`
          : "";
      let input: Record<string, unknown>;
      if (row) {
        if (!starts || !ends)
          throw new Error(
            t(
              "بازهٔ ثبت‌شده باید شروع و پایان داشته باشد؛ برای ردیف ناقص پیش‌نویس تازه بساز.",
              "A recorded interval needs both endpoints. Use a new draft for incomplete work.",
            ),
          );
        const original = entryLocal(row);
        input = {
          entry_id: row.entry_id,
          employer: snapshot.employer,
          description: snapshot.description,
          starts_at:
            snapshot.date === original.date && snapshot.start === original.start
              ? row.starts_at
              : zonedLocalToInstant(starts, WORK_ZONE, choices.start),
          ends_at:
            snapshot.date === original.date &&
            snapshot.end === original.end &&
            snapshot.end_next_day === original.end_next_day
              ? row.ends_at
              : zonedLocalToInstant(ends, WORK_ZONE, choices.end),
        };
      } else input = { ...snapshot, draft_id: draft!.draft_id };
      const result = await action(
        row ? "time_entry_update" : "time_draft_save",
        input,
        expected,
      );
      if (!result) {
        setConflict(true);
        setStatus(
          t(
            "تأیید ذخیره دریافت نشد؛ متن حفظ شد",
            "Save not acknowledged; edits retained",
          ),
        );
        return;
      }
      revision.current = entryRevision(result, expected + 1);
      saved.current = fingerprint;
      acknowledged = true;
      conflictRef.current = false;
      setConflict(false);
      setStatus(
        JSON.stringify(current.current) === fingerprint
          ? t("ذخیره شد", "Saved")
          : t("تغییر تازه هنوز ذخیره نشده", "Newer edits not saved yet"),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStatus(t("ذخیره تأیید نشده", "Save unconfirmed"));
    } finally {
      busy.current = false;
      // A blur can arrive while the preceding write is awaiting its ACK. Drain
      // that newer snapshot only after success, preserving the focused editor.
      if (acknowledged && JSON.stringify(current.current) !== saved.current)
        void save();
    }
  }
  const update = <K extends keyof DraftFields>(
    key: K,
    value: DraftFields[K],
  ) => {
    const next = { ...current.current, [key]: value };
    current.current = next;
    setFields(next);
  };
  const blur = (event: React.FocusEvent<HTMLElement>) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    void save();
  };
  return (
    <Fragment>
      <tr onBlur={blur} data-work-entry={row?.entry_id ?? draft?.draft_id}>
        <td>
          <input
            aria-label={t("تاریخ ردیف", "Row date")}
            type="date"
            value={fields.date}
            onChange={(event) => update("date", event.target.value)}
          />
        </td>
        <td>
          <select
            aria-label={t("محل کار ردیف", "Row workplace")}
            value={fields.employer}
            onChange={(event) => update("employer", event.target.value)}
          >
            <option>Jena</option>
            <option>Seewiesen</option>
            {!["Jena", "Seewiesen"].includes(fields.employer) && (
              <option>{fields.employer}</option>
            )}
          </select>
        </td>
        <td>
          <input
            type="time"
            step={60}
            aria-label={t("شروع ردیف", "Row start")}
            value={fields.start}
            onChange={(event) => update("start", event.target.value)}
          />
        </td>
        <td>
          <input
            type="time"
            step={60}
            aria-label={t("پایان ردیف", "Row end")}
            value={fields.end}
            onChange={(event) => update("end", event.target.value)}
          />
        </td>
        <td>
          <input
            type="checkbox"
            aria-label={t("پایان در روز بعد", "Ends next day")}
            checked={fields.end_next_day}
            onChange={(event) => update("end_next_day", event.target.checked)}
          />
        </td>
        <td>
          <strong>{row ? hours(row.minutes) : t("پیش‌نویس", "Draft")}</strong>
          <small>
            {row?.reporting_policy === "legacy_wall"
              ? t("ساعت دیواری مرجع", "Imported wall clock")
              : row
                ? t("زمان واقعی", "Elapsed time")
                : t("خارج از مجموع", "Excluded from totals")}
          </small>
          <span role="status" className="small muted">
            {status}
          </span>
        </td>
        <td>
          <Button onClick={() => void save()}>{t("ذخیره", "Save")}</Button>
          {draft && (
            <Button
              onClick={async () => {
                await save();
                if (
                  conflictRef.current ||
                  busy.current ||
                  JSON.stringify(current.current) !== saved.current
                )
                  return;
                try {
                  const value = current.current;
                  const result = await action("time_entry_create", {
                    draft_id: draft.draft_id,
                    draft_revision: revision.current,
                    employer: value.employer,
                    starts_at: zonedLocalToInstant(
                      `${value.date}T${value.start}`,
                      value.timezone,
                      choices.start,
                    ),
                    ends_at: zonedLocalToInstant(
                      `${value.end_next_day ? addCalendarDays(value.date, 1) : value.date}T${value.end}`,
                      value.timezone,
                      choices.end,
                    ),
                    description: value.description,
                  });
                  if (!result)
                    setError(
                      t(
                        "تکمیل تأیید نشد؛ پیش‌نویس حفظ شد",
                        "Completion unconfirmed; draft retained",
                      ),
                    );
                } catch (cause) {
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  );
                }
              }}
            >
              {t("تکمیل و ثبت بازه", "Complete and record")}
            </Button>
          )}
          <Button
            onClick={async () => {
              const result = await action(
                row ? "time_entry_archive" : "time_draft_archive",
                row
                  ? { entry_id: row.entry_id }
                  : { draft_id: draft!.draft_id },
                revision.current,
              );
              if (!result)
                setError(t("بایگانی تأیید نشد", "Archive not acknowledged"));
            }}
          >
            {t("بایگانی", "Archive")}
          </Button>
        </td>
      </tr>
      <tr className="work-description-row">
        <td colSpan={7} onBlur={blur}>
          <Field label={t("شرح فعالیت ردیف", "Row activity description")}>
            <textarea
              rows={2}
              maxLength={20000}
              value={fields.description}
              onChange={(event) => update("description", event.target.value)}
            />
          </Field>
          <div className="work-row-status">
            {(["start", "end"] as const).map((endpoint) => (
              <label className="small muted" key={endpoint}>
                {endpoint === "start"
                  ? t("ساعت پاییزیِ شروع", "Repeated start time")
                  : t("ساعت پاییزیِ پایان", "Repeated end time")}
                <select
                  value={choices[endpoint]}
                  onChange={(event) =>
                    setChoices((old) => ({
                      ...old,
                      [endpoint]: event.target.value as
                        "reject" | "earlier" | "later",
                    }))
                  }
                >
                  <option value="reject">
                    {t("نیاز به انتخاب", "Require choice")}
                  </option>
                  <option value="earlier">{t("بار اول", "First")}</option>
                  <option value="later">{t("بار دوم", "Second")}</option>
                </select>
              </label>
            ))}
            {conflict && (
              <div className="warning" role="alert">
                <span>
                  {t(
                    "نسخهٔ دیگری تغییر کرده یا تأیید ذخیره نرسیده؛ متن تو حفظ شده است.",
                    "Another version changed or the save was not acknowledged; your edits are retained.",
                  )}
                </span>
                <Button onClick={() => void save(true)}>
                  {t(
                    "ذخیرهٔ متن من روی نسخهٔ تازه",
                    "Save my edits against the latest version",
                  )}
                </Button>
                <Button
                  onClick={() => {
                    const next = row
                      ? { ...entryLocal(row), timezone: WORK_ZONE }
                      : draft!;
                    current.current = next;
                    saved.current = JSON.stringify(next);
                    revision.current = sourceRevision;
                    setFields(next);
                    setConflict(false);
                    setStatus("");
                  }}
                >
                  {t("استفاده از نسخهٔ سرور", "Use server version")}
                </Button>
              </div>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
          </div>
        </td>
      </tr>
    </Fragment>
  );
}

function MonthlyWorkTimeline({
  days,
  entries,
  events,
  region,
  onNew,
  onEdit,
  onMove,
  onEvent,
}: {
  days: string[];
  entries: TimeEntryDTO[];
  events: EventDTO[];
  region: HolidayRegion;
  onNew: (starts: string, ends: string) => void;
  onEdit: (entry: TimeEntryDTO) => void;
  onMove: (
    entry: TimeEntryDTO,
    starts: string,
    ends: string,
  ) => Promise<TimeEntryDTO | null>;
  onEvent: (event: EventDTO) => void;
}) {
  const { t } = useLocale();
  const monthSegments = useMemo(
    () =>
      entries.flatMap((entry) =>
        workSegments(entry).map((segment) => ({ row: entry, ...segment })),
      ),
    [entries],
  );
  const gesture = useRef<{
    day: string;
    start: number;
    end: number;
    left: number;
    width: number;
    pointer: number;
  } | null>(null);
  const [drawing, setDrawing] = useState<{
    day: string;
    start: number;
    end: number;
  } | null>(null);
  const [error, setError] = useState("");
  const editing = useRef<{
    row: TimeEntryDTO;
    mode: "move" | "start" | "end";
    x: number;
    width: number;
    moved: boolean;
  } | null>(null);
  const pending = useRef(new Map<string, Promise<TimeEntryDTO | null>>());
  const acknowledged = useRef(new Map<string, TimeEntryDTO>());
  function change(
    row: TimeEntryDTO,
    mode: "move" | "start" | "end",
    delta: number,
  ) {
    const previous =
      pending.current.get(row.entry_id) ??
      Promise.resolve(
        (acknowledged.current.get(row.entry_id)?.revision ?? 0) > row.revision
          ? acknowledged.current.get(row.entry_id)!
          : row,
      );
    const next = previous.then(async (latest) => {
      if (!latest) return null;
      const row = latest;
      const original = entryLocal(row);
      const endDayOffset = Math.round(
        (Date.parse(`${instantToLocalDate(row.ends_at, WORK_ZONE)}T12:00:00Z`) -
          Date.parse(`${original.date}T12:00:00Z`)) /
          86400000,
      );
      const startMinute =
          Number(original.start.slice(0, 2)) * 60 +
          Number(original.start.slice(3)),
        endMinute =
          Number(original.end.slice(0, 2)) * 60 +
          Number(original.end.slice(3)) +
          endDayOffset * 1440;
      const start = mode === "end" ? startMinute : startMinute + delta,
        end = mode === "start" ? endMinute : endMinute + delta;
      if (end <= start) {
        onEdit(row);
        return row;
      }
      const point = (value: number) => {
        const offset = Math.floor(value / 1440),
          minute = ((value % 1440) + 1440) % 1440;
        return `${addCalendarDays(original.date, offset)}T${minuteClock(minute)}`;
      };
      try {
        const starts =
            mode === "end"
              ? row.starts_at
              : zonedLocalToInstant(point(start), WORK_ZONE),
          ends =
            mode === "start"
              ? row.ends_at
              : mode === "move"
                ? new Date(
                    Date.parse(starts) +
                      Date.parse(row.ends_at) -
                      Date.parse(row.starts_at),
                  ).toISOString()
                : zonedLocalToInstant(point(end), WORK_ZONE);
        const result = await onMove(row, starts, ends);
        if (result) acknowledged.current.set(row.entry_id, result);
        return result;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        onEdit(row);
        return null;
      }
    });
    pending.current.set(row.entry_id, next);
    void next.finally(() => {
      if (pending.current.get(row.entry_id) === next)
        pending.current.delete(row.entry_id);
    });
  }
  return (
    <section className="panel work-month-panel">
      <h2>{t("خط زمانی ماهانهٔ ۲۴ ساعته", "Monthly 24-hour timeline")}</h2>
      <p className="small muted">
        {t(
          "در فضای خالی بکش؛ بازه را جابه‌جا کن یا دستگیرهٔ ابتدا و انتها را بکش. با صفحه‌کلید، فلش‌ها ۱۵ دقیقه جابه‌جا می‌کنند؛ روی دستگیره طول را تغییر می‌دهند. Enter ویرایش دقیق را باز می‌کند.",
          "Draw in empty space; move intervals or drag either endpoint. Arrow keys move by 15 minutes, or resize on an endpoint handle. Enter opens the exact editor.",
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div
        className="work-month-scroll"
        role="region"
        tabIndex={0}
        aria-label={t(
          "خط زمانی تمام روزهای ماه",
          "Timeline of every day in the month",
        )}
      >
        <div className="work-month-grid" dir="ltr">
          <div className="work-month-ruler">
            <span>{t("روز", "Day")}</span>
            <div>
              {Array.from({ length: 25 }, (_, hour) => (
                <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>
                  {String(hour).padStart(2, "0")}
                </span>
              ))}
            </div>
          </div>
          {days.map((day) => {
            const flags = dayFlags(day, region);
            const start = zonedLocalToInstant(`${day}T00:00`, WORK_ZONE),
              end = zonedLocalToInstant(
                `${addCalendarDays(day, 1)}T00:00`,
                WORK_ZONE,
              );
            const dayEvents = events.filter(
              (event) => event.starts_at < end && event.ends_at > start,
            );
            const segments = monthSegments.filter(
              (segment) => segment.date === day,
            );
            return (
              <div
                className={`work-month-day ${flags.isHoliday ? "holiday" : ""}`}
                key={day}
              >
                <div className="work-month-date">
                  <strong>{day.slice(8)}</strong>
                  <small>{day.slice(5, 7)}</small>
                  <span>
                    {flags.holidays.map((holiday) => holiday.name).join(" · ")}
                  </span>
                </div>
                <div
                  className="work-month-track"
                  tabIndex={0}
                  role="group"
                  aria-label={`${t("ثبت زمان در", "Record time on")} ${day}`}
                  style={{
                    minHeight: `${Math.max(68, 14 + dayEvents.length * 20 + segments.length * 30)}px`,
                  }}
                  onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onNew(`${day}T09:00`, `${day}T10:00`);
                    }
                  }}
                  onPointerDown={(event) => {
                    if (
                      event.target !== event.currentTarget ||
                      event.button !== 0
                    )
                      return;
                    const bounds = event.currentTarget.getBoundingClientRect(),
                      minute = snappedMinute(
                        event.clientX,
                        bounds.left,
                        bounds.width,
                      );
                    gesture.current = {
                      day,
                      start: Math.min(minute, 1425),
                      end: minute,
                      left: bounds.left,
                      width: bounds.width,
                      pointer: event.pointerId,
                    };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    setDrawing({ day, start: minute, end: minute });
                  }}
                  onPointerMove={(event) => {
                    const value = gesture.current;
                    if (!value || value.day !== day) return;
                    value.end = snappedMinute(
                      event.clientX,
                      value.left,
                      value.width,
                    );
                    setDrawing({ day, start: value.start, end: value.end });
                  }}
                  onPointerCancel={() => {
                    gesture.current = null;
                    setDrawing(null);
                  }}
                  onPointerUp={(event) => {
                    const value = gesture.current;
                    if (!value || value.day !== day) return;
                    gesture.current = null;
                    setDrawing(null);
                    if (event.currentTarget.hasPointerCapture(event.pointerId))
                      event.currentTarget.releasePointerCapture(
                        event.pointerId,
                      );
                    const lower = Math.min(value.start, value.end),
                      upper =
                        value.start === value.end
                          ? value.start + 15
                          : Math.max(value.start, value.end);
                    onNew(
                      localPoint(day, lower),
                      localPoint(day, Math.min(1440, upper)),
                    );
                  }}
                >
                  {drawing?.day === day && (
                    <span
                      className="work-drawing"
                      style={{
                        left: `${(Math.min(drawing.start, drawing.end) / 1440) * 100}%`,
                        width: `${(Math.max(15, Math.abs(drawing.end - drawing.start)) / 1440) * 100}%`,
                      }}
                    />
                  )}
                  {dayEvents.map((event, index) => {
                    const clipStart = new Date(
                        Math.max(
                          Date.parse(start),
                          Date.parse(event.starts_at),
                        ),
                      ).toISOString(),
                      clipEnd = new Date(
                        Math.min(Date.parse(end), Date.parse(event.ends_at)),
                      ).toISOString();
                    const clock = instantToLocalTime(clipStart)
                        .split(":")
                        .map(Number),
                      endClock = instantToLocalTime(clipEnd)
                        .split(":")
                        .map(Number),
                      a = event.all_day ? 0 : clock[0] * 60 + clock[1],
                      b =
                        event.all_day || clipEnd === end
                          ? 1440
                          : endClock[0] * 60 + endClock[1];
                    return (
                      <button
                        key={event.occurrence_key ?? event.event_id}
                        className="work-calendar-overlay"
                        style={{
                          left: `${(a / 1440) * 100}%`,
                          width: `${(Math.max(15, b - a) / 1440) * 100}%`,
                          top: `${3 + index * 20}px`,
                        }}
                        onClick={() => onEvent(event)}
                        title={event.title}
                      >
                        {event.title}
                      </button>
                    );
                  })}
                  {segments.map(
                    (
                      {
                        row,
                        startMinute,
                        endMinute,
                        starts_at,
                        offset_label,
                        clock_change,
                      },
                      index,
                    ) => (
                      <div
                        key={`${row.entry_id}:${starts_at}`}
                        className={`work-month-block ${row.employer === "Seewiesen" ? "seewiesen" : ""}`}
                        style={{
                          left: `${(startMinute / 1440) * 100}%`,
                          width: `${((endMinute - startMinute) / 1440) * 100}%`,
                          top: `${9 + dayEvents.length * 20 + index * 30}px`,
                        }}
                      >
                        {(["start", "move", "end"] as const).map((mode) => (
                          <button
                            key={mode}
                            className={`work-interval-${mode}`}
                            aria-label={`${mode === "move" ? t("جابه‌جایی", "Move") : mode === "start" ? t("تغییر شروع", "Resize start") : t("تغییر پایان", "Resize end")} ${row.employer} ${day}`}
                            onPointerDown={(event) => {
                              event.stopPropagation();
                              const track =
                                event.currentTarget.closest(
                                  ".work-month-track",
                                )!;
                              editing.current = {
                                row,
                                mode,
                                x: event.clientX,
                                width: track.getBoundingClientRect().width,
                                moved: false,
                              };
                              event.currentTarget.setPointerCapture(
                                event.pointerId,
                              );
                            }}
                            onPointerMove={(event) => {
                              if (
                                editing.current &&
                                Math.abs(event.clientX - editing.current.x) > 4
                              )
                                editing.current.moved = true;
                            }}
                            onPointerCancel={() => {
                              editing.current = null;
                            }}
                            onPointerUp={(event) => {
                              event.stopPropagation();
                              const current = editing.current;
                              editing.current = null;
                              if (!current) return;
                              const delta =
                                Math.round(
                                  ((event.clientX - current.x) /
                                    current.width) *
                                    96,
                                ) * 15;
                              if (current.moved && delta)
                                change(row, mode, delta);
                              else if (mode === "move") onEdit(row);
                            }}
                            onKeyDown={(event) => {
                              if (
                                ["ArrowLeft", "ArrowRight"].includes(event.key)
                              ) {
                                event.preventDefault();
                                event.stopPropagation();
                                change(
                                  row,
                                  mode,
                                  event.key === "ArrowLeft" ? -15 : 15,
                                );
                              }
                            }}
                            onClick={(event) => {
                              if (event.detail === 0) onEdit(row);
                            }}
                            title={`${row.employer} · ${row.description}`}
                          >
                            {mode === "move" ? (
                              <>
                                {row.employer} ·{" "}
                                {instantToLocalTime(row.starts_at)}–
                                {instantToLocalTime(row.ends_at)}
                                {clock_change && ` · UTC${offset_label}`}
                              </>
                            ) : (
                              "⋮"
                            )}
                          </button>
                        ))}
                      </div>
                    ),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
