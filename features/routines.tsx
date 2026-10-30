"use client";

import Link from "next/link";
import {
  Archive,
  Check,
  Clock3,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  Repeat2,
  RotateCcw,
} from "lucide-react";
import {
  useEffect,
  useState,
  type FormEvent,
  type HTMLAttributes,
} from "react";
import type {
  CommandName,
  MutationResult,
  RoutineCheckinDTO,
  RoutineDayItemDTO,
  RoutineDTO,
} from "@/shared/contracts";
import { addCalendarDays, instantToLocalDate } from "@/shared/datetime";
import {
  Button,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";
import { clearQueryCache, usePagedQuery, useQuery } from "./api";
import { useLocale } from "./locale";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

type RoutineDayDTO = {
  date: string;
  items: RoutineDayItemDTO[];
  total: number;
  completed: number;
};

const weekdays = [
  { value: 1, fa: "دوشنبه", en: "Mon" },
  { value: 2, fa: "سه‌شنبه", en: "Tue" },
  { value: 3, fa: "چهارشنبه", en: "Wed" },
  { value: 4, fa: "پنجشنبه", en: "Thu" },
  { value: 5, fa: "جمعه", en: "Fri" },
  { value: 6, fa: "شنبه", en: "Sat" },
  { value: 7, fa: "یکشنبه", en: "Sun" },
] as const;

function berlinToday() {
  return instantToLocalDate(new Date().toISOString(), "Europe/Berlin");
}

function useBerlinDate() {
  const [dates, setDates] = useState(() => {
    const today = berlinToday();
    return { today, selected: today };
  });
  useEffect(() => {
    const refresh = () => {
      const next = berlinToday();
      setDates((previous) =>
        previous.today === next
          ? previous
          : {
              today: next,
              selected:
                previous.selected === previous.today ? next : previous.selected,
            },
      );
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 60_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
    };
  }, []);
  return {
    ...dates,
    setSelected: (selected: string) =>
      setDates((previous) => ({ ...previous, selected })),
  };
}

function scheduleLabel(
  routine: Pick<RoutineDTO, "weekdays" | "time_of_day">,
  language: "fa" | "en",
) {
  const days = routine.weekdays.length
    ? weekdays
        .filter((day) => routine.weekdays.includes(day.value))
        .map((day) => (language === "fa" ? day.fa : day.en))
        .join(language === "fa" ? "، " : ", ")
    : language === "fa"
      ? "هر روز"
      : "Every day";
  return routine.time_of_day ? `${days} · ${routine.time_of_day}` : days;
}

function RoutineDayCard({
  action,
  date,
  onCreate,
  widgetProps,
}: {
  action: Action;
  date?: string;
  onCreate?: () => void;
  widgetProps?: HTMLAttributes<HTMLElement>;
}) {
  const { t, language } = useLocale();
  const day = useQuery<RoutineDayDTO>(
    "routine_day",
    date ? { date } : {},
    !widgetProps?.hidden,
  );
  const [busyId, setBusyId] = useState<string | null>(null);
  const isToday = !date || date === berlinToday();
  async function toggle(item: RoutineDayItemDTO) {
    if (!day.data || busyId) return;
    setBusyId(item.routine_id);
    try {
      const result = await action(
        "routine_checkin_set",
        {
          routine_id: item.routine_id,
          date: day.data.date,
          done: !item.done,
        },
        item.checkin_revision,
      );
      if (!result) clearQueryCache();
    } finally {
      setBusyId(null);
      day.refresh();
    }
  }
  return (
    <section className="panel routine-day-panel" {...widgetProps}>
      <SectionHeading
        title={
          isToday
            ? t("روتین‌های امروز", "Today's routines")
            : t("روتین‌های این روز", "Routines for this day")
        }
        subtitle={
          day.data
            ? `${day.data.completed} / ${day.data.total} · ${day.data.date}`
            : date
        }
        action={
          onCreate ? (
            <Button onClick={onCreate}>
              <Plus size={15} />
              {t("روتین تازه", "New routine")}
            </Button>
          ) : (
            <Link className="text-link" href="/routines">
              {t("مدیریت روتین‌ها", "Manage routines")}
            </Link>
          )
        }
      />
      <QueryState {...day} retry={day.refresh} />
      {!day.loading && !day.error && !day.data?.items.length && (
        <p className="muted routine-empty">
          {isToday
            ? t(
                "برای امروز روتین فعالی برنامه‌ریزی نشده است.",
                "No active routine is scheduled for today.",
              )
            : t(
                "برای این تاریخ روتینی برنامه‌ریزی نشده است.",
                "No routine is scheduled for this date.",
              )}
        </p>
      )}
      {!!day.data?.items.length && (
        <ul className="routine-day-list">
          {day.data.items.map((item) => (
            <li key={item.routine_id} className={item.done ? "done" : ""}>
              <button
                type="button"
                className="routine-check"
                aria-label={
                  item.done
                    ? t(`برگرداندن انجام ${item.title}`, `Undo ${item.title}`)
                    : t(`ثبت انجام ${item.title}`, `Complete ${item.title}`)
                }
                aria-pressed={item.done}
                aria-busy={busyId === item.routine_id}
                disabled={busyId !== null && busyId !== item.routine_id}
                onClick={() => void toggle(item)}
              >
                {item.done && <Check size={17} />}
              </button>
              <div className="routine-day-copy">
                <strong>{item.title}</strong>
                <small>{scheduleLabel(item, language)}</small>
              </div>
              <span className="routine-day-state">
                {item.done
                  ? t("انجام شد", "Done")
                  : t("در انتظار انجام", "To do")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RoutineTodayCard({
  action,
  widgetProps,
}: {
  action: Action;
  widgetProps?: HTMLAttributes<HTMLElement>;
}) {
  return <RoutineDayCard action={action} widgetProps={widgetProps} />;
}

function RoutineHistory({ routineId }: { routineId: string }) {
  const { t } = useLocale();
  const history = useQuery<{
    items: RoutineCheckinDTO[];
    total: number;
    next_cursor: null;
  }>("routine_history", { routine_id: routineId, limit: 14 });
  return (
    <div className="routine-history" id={`routine-history-${routineId}`}>
      <QueryState {...history} retry={history.refresh} />
      {!history.loading && !history.error && !history.data?.items.length && (
        <p className="muted small">
          {t("هنوز انجامی ثبت نشده است.", "No check-ins recorded yet.")}
        </p>
      )}
      {!!history.data?.items.length && (
        <ul>
          {history.data.items.map((entry) => (
            <li key={entry.date}>
              <time dateTime={entry.date}>{entry.date}</time>
              <span>
                {entry.done
                  ? t("انجام شد", "Done")
                  : t("برگردانده شد", "Undone")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function RoutineWorkspace({ action }: { action: Action }) {
  const { t, language } = useLocale();
  const { today, selected, setSelected } = useBerlinDate();
  const routines = usePagedQuery<RoutineDTO>("routine_list", {
    include_archived: true,
  });
  const [editor, setEditor] = useState<RoutineDTO | "create" | null>(null);
  const [repeat, setRepeat] = useState<"daily" | "weekdays">("daily");
  const [selectedWeekdays, setSelectedWeekdays] = useState<number[]>([]);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const active = (routines.data?.items ?? []).filter(
    (routine) => !routine.archived_at,
  );
  const archived = (routines.data?.items ?? []).filter(
    (routine) => !!routine.archived_at,
  );
  function openEditor(routine: RoutineDTO | "create") {
    setEditor(routine);
    setRepeat(
      routine === "create" || routine.weekdays.length === 0
        ? "daily"
        : "weekdays",
    );
    setSelectedWeekdays(routine === "create" ? [] : [...routine.weekdays]);
    setFormError("");
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editor || saving) return;
    if (repeat === "weekdays" && selectedWeekdays.length === 0) {
      setFormError(
        t("حداقل یک روز هفته را انتخاب کن.", "Choose at least one weekday."),
      );
      return;
    }
    const form = new FormData(event.currentTarget);
    const title = String(form.get("title") ?? "").trim();
    if (!title) return;
    const input = {
      title,
      notes: String(form.get("notes") ?? "").trim(),
      start_date: String(form.get("start_date") ?? ""),
      time_of_day: String(form.get("time_of_day") ?? "") || null,
      weekdays:
        repeat === "daily" ? [] : [...selectedWeekdays].sort((a, b) => a - b),
    };
    setSaving(true);
    try {
      const result =
        editor === "create"
          ? await action("routine_create", input, 0)
          : await action(
              "routine_update",
              { routine_id: editor.routine_id, ...input },
              editor.revision,
            );
      if (result) {
        setEditor(null);
        routines.refresh();
      } else {
        setFormError(
          t(
            "ذخیره تأیید نشد. پیام خطای بالای صفحه را بررسی کن؛ اگر تغییر هم‌زمان رخ داده، فرم را ببند و دوباره باز کن.",
            "Save was not confirmed. Check the error above; if another edit conflicted, close and reopen this form.",
          ),
        );
        clearQueryCache();
        routines.refresh();
      }
    } finally {
      setSaving(false);
    }
  }
  async function changeState(
    routine: RoutineDTO,
    command:
      | "routine_pause"
      | "routine_resume"
      | "routine_archive"
      | "routine_restore",
  ) {
    if (busyId) return;
    setBusyId(routine.routine_id);
    try {
      const result = await action(
        command,
        { routine_id: routine.routine_id },
        routine.revision,
      );
      if (!result) clearQueryCache();
    } finally {
      setBusyId(null);
      routines.refresh();
    }
  }
  function routineCard(routine: RoutineDTO) {
    const busy = busyId === routine.routine_id;
    return (
      <article className="routine-card" key={routine.routine_id}>
        <div className="routine-card-main">
          <span className="routine-card-icon">
            <Repeat2 size={18} />
          </span>
          <div>
            <strong>{routine.title}</strong>
            <p>{scheduleLabel(routine, language)}</p>
            {routine.notes && <p className="routine-note">{routine.notes}</p>}
            <small className="muted">
              {t("از", "From")} {routine.start_date}
              {routine.archived_at
                ? ` · ${t("بایگانی‌شده", "Archived")}`
                : !routine.enabled
                  ? ` · ${t("متوقف", "Paused")}`
                  : ""}
            </small>
          </div>
        </div>
        <div className="routine-card-actions">
          {!routine.archived_at && (
            <>
              <Button onClick={() => openEditor(routine)} disabled={busy}>
                <Pencil size={14} />
                {t("ویرایش", "Edit")}
              </Button>
              <Button
                onClick={() =>
                  void changeState(
                    routine,
                    routine.enabled ? "routine_pause" : "routine_resume",
                  )
                }
                disabled={busy}
              >
                {routine.enabled ? <Pause size={14} /> : <Play size={14} />}
                {routine.enabled ? t("توقف", "Pause") : t("ادامه", "Resume")}
              </Button>
              <Button
                onClick={() => void changeState(routine, "routine_archive")}
                disabled={busy}
              >
                <Archive size={14} />
                {t("بایگانی", "Archive")}
              </Button>
            </>
          )}
          {routine.archived_at && (
            <Button
              onClick={() => void changeState(routine, "routine_restore")}
              disabled={busy}
            >
              <RotateCcw size={14} />
              {t("بازگردانی", "Restore")}
            </Button>
          )}
          <Button
            onClick={() =>
              setHistoryId((current) =>
                current === routine.routine_id ? null : routine.routine_id,
              )
            }
            aria-expanded={historyId === routine.routine_id}
            aria-controls={
              historyId === routine.routine_id
                ? `routine-history-${routine.routine_id}`
                : undefined
            }
          >
            <History size={14} />
            {t("تاریخچه", "History")}
          </Button>
        </div>
        {historyId === routine.routine_id && (
          <RoutineHistory routineId={routine.routine_id} />
        )}
      </article>
    );
  }
  return (
    <>
      <div className="page-heading routine-heading">
        <div>
          <div className="eyebrow">
            {t("ریتم زندگی روزانه", "DAILY RHYTHM")}
          </div>
          <h1>{t("روتین‌ها", "Routines")}</h1>
          <p>
            {t(
              "کارهای تکراری را بدون شلوغ‌کردن فهرست تسک‌ها پیگیری کن.",
              "Track recurring practices without filling your task list.",
            )}
          </p>
        </div>
        <Button variant="primary" onClick={() => openEditor("create")}>
          <Plus size={16} />
          {t("روتین تازه", "New routine")}
        </Button>
      </div>
      <div className="routine-date-bar">
        <Field label={t("روز نمایش", "Shown date")}>
          <input
            type="date"
            value={selected}
            min={addCalendarDays(today, -30)}
            max={today}
            onChange={(event) => setSelected(event.target.value)}
          />
        </Field>
        {selected !== today && (
          <Button onClick={() => setSelected(today)}>
            {t("بازگشت به امروز", "Back to today")}
          </Button>
        )}
        <span className="muted small">
          {t(
            "ثبت یا برگرداندن انجام برای امروز و ۳۰ روز گذشته ممکن است.",
            "Check or undo today and the past 30 days.",
          )}
        </span>
      </div>
      <RoutineDayCard
        action={action}
        date={selected}
        onCreate={() => openEditor("create")}
      />
      <section className="panel routine-list-panel">
        <SectionHeading
          title={t("روتین‌های من", "My routines")}
          subtitle={t(
            "تغییر برنامه از فردای برلین اعمال می‌شود؛ انجام‌های قبلی حفظ می‌شوند. توقف و بایگانی فوری است.",
            "Schedule changes take effect tomorrow in Berlin; past check-ins stay saved. Pause and archive take effect now.",
          )}
        />
        <QueryState {...routines} retry={routines.refresh} />
        {!routines.loading && !routines.error && !active.length && (
          <p className="muted routine-empty">
            {archived.length
              ? t(
                  "روتین فعالی نداری. بایگانی‌شده‌ها را باز کن یا روتین تازه بساز.",
                  "No active routines. Open the archive or create a new routine.",
                )
              : t(
                  "هنوز روتینی نساخته‌ای. با «روتین تازه» شروع کن.",
                  "No routines yet. Start with New routine.",
                )}
          </p>
        )}
        <div className="routine-list">{active.map(routineCard)}</div>
        {!!archived.length && (
          <details className="routine-archived">
            <summary>
              {t("بایگانی‌شده‌ها", "Archived routines")} ({archived.length})
            </summary>
            <div className="routine-list">{archived.map(routineCard)}</div>
          </details>
        )}
      </section>
      <Modal
        title={
          editor === "create"
            ? t("ساخت روتین", "Create routine")
            : t("ویرایش روتین", "Edit routine")
        }
        open={!!editor}
        onOpenChange={(open) => {
          if (!open) setEditor(null);
        }}
      >
        {editor && (
          <form
            key={editor === "create" ? "create" : editor.routine_id}
            className="form-grid routine-form"
            onSubmit={(event) => void save(event)}
          >
            <Field label={t("نام روتین", "Routine name")}>
              <input
                name="title"
                defaultValue={editor === "create" ? "" : editor.title}
                required
                maxLength={200}
                autoFocus
              />
            </Field>
            <Field label={t("توضیح (اختیاری)", "Notes (optional)")}>
              <textarea
                name="notes"
                rows={3}
                defaultValue={editor === "create" ? "" : editor.notes}
              />
            </Field>
            <div className="form-columns">
              <Field label={t("تاریخ شروع", "Start date")}>
                <input
                  name="start_date"
                  type="date"
                  required
                  defaultValue={
                    editor === "create" ? berlinToday() : editor.start_date
                  }
                />
              </Field>
              <Field
                label={t(
                  "ساعت پیشنهادی (اختیاری)",
                  "Suggested time (optional)",
                )}
              >
                <input
                  name="time_of_day"
                  type="time"
                  defaultValue={
                    editor === "create" ? "" : (editor.time_of_day ?? "")
                  }
                />
              </Field>
            </div>
            <Field label={t("تکرار", "Repeat")}>
              <select
                value={repeat}
                onChange={(event) => {
                  setRepeat(event.target.value as "daily" | "weekdays");
                  setFormError("");
                }}
              >
                <option value="daily">{t("هر روز", "Every day")}</option>
                <option value="weekdays">
                  {t("روزهای منتخب هفته", "Selected weekdays")}
                </option>
              </select>
            </Field>
            {repeat === "weekdays" && (
              <fieldset className="routine-weekdays">
                <legend>{t("روزهای تکرار", "Repeat on")}</legend>
                <div>
                  {weekdays.map((day) => (
                    <button
                      key={day.value}
                      type="button"
                      className={
                        selectedWeekdays.includes(day.value) ? "selected" : ""
                      }
                      aria-pressed={selectedWeekdays.includes(day.value)}
                      onClick={() => {
                        setSelectedWeekdays((current) =>
                          current.includes(day.value)
                            ? current.filter((value) => value !== day.value)
                            : [...current, day.value],
                        );
                        setFormError("");
                      }}
                    >
                      {language === "fa" ? day.fa : day.en}
                    </button>
                  ))}
                </div>
              </fieldset>
            )}
            {editor !== "create" && (
              <p className="muted small">
                {t(
                  "تغییر روزها، تاریخ شروع و ساعت از فردای برلین اعمال می‌شود.",
                  "Changes to weekdays, start date and time take effect tomorrow in Berlin.",
                )}
              </p>
            )}
            <p className="muted small">
              <Clock3 size={14} />
              {t(
                "ساعت پیشنهادی فقط برای نمایش است و اعلان ایجاد نمی‌کند.",
                "Suggested time is for display only; it does not create a reminder.",
              )}
            </p>
            {formError && (
              <p className="error" role="alert">
                {formError}
              </p>
            )}
            <Button variant="primary" type="submit" disabled={saving}>
              {saving
                ? t("در حال ذخیره…", "Saving…")
                : t("ذخیرهٔ روتین", "Save routine")}
            </Button>
          </form>
        )}
      </Modal>
    </>
  );
}
