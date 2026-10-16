"use client";
import { useState } from "react";
import { formatInTimeZone } from "date-fns-tz";
import type {
  CalendarSourceDTO,
  EventDTO,
  PreviewDTO,
  PageDTO,
} from "@/shared/contracts";
import { zonedLocalToInstant, addCalendarDays } from "@/shared/datetime";
import { Button, Field, Modal, QueryState } from "@/components/ui";
import { query, useQuery } from "./api";
import { useLocale } from "./locale";
import type { CalendarAction } from "./calendar-workspace";

export function GoogleEventEditor({
  open,
  close,
  event: initialEvent,
  date,
  draft,
  sourceId,
  sources,
  onSource,
  action,
}: {
  open: boolean;
  close: () => void;
  event: EventDTO | null;
  date: string;
  draft?: { starts: string; ends: string } | null;
  sourceId: string;
  sources: CalendarSourceDTO[];
  onSource: (source: string) => void;
  action: CalendarAction;
}) {
  const { t } = useLocale();
  const [event, setEvent] = useState(initialEvent);
  const [proposal, setProposal] = useState<Record<string, unknown> | null>(
    null,
  );
  const [remote, setRemote] = useState<EventDTO | null>(null);
  const [zone, setZone] = useState(event?.timezone ?? "Europe/Berlin");
  const [scope, setScope] = useState<"instance" | "series">("instance");
  const [preview, setPreview] = useState<PreviewDTO | null>(null),
    [error, setError] = useState("");
  const [operation, setOperation] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const status = useQuery<{
    items: { state: string; last_error: string | null }[];
  }>(
    "calendar_operation_status",
    operation ? { operation_id: operation } : {},
    !!operation,
  );
  const readonly = !!event && !event.can_edit;
  const startInstant =
    scope === "series"
      ? (event?.series_starts_at ?? event?.starts_at)
      : event?.starts_at;
  const endInstant =
    scope === "series"
      ? (event?.series_ends_at ?? event?.ends_at)
      : event?.ends_at;
  const proposedStart =
    typeof proposal?.starts_at === "string" ? proposal.starts_at : null;
  const proposedEnd =
    typeof proposal?.ends_at === "string" ? proposal.ends_at : null;
  const starts = proposedStart
    ? formatInTimeZone(proposedStart, zone, "yyyy-MM-dd'T'HH:mm")
    : startInstant
      ? formatInTimeZone(startInstant, zone, "yyyy-MM-dd'T'HH:mm")
      : (draft?.starts ?? `${date}T09:00`);
  const ends = proposedEnd
    ? formatInTimeZone(proposedEnd, zone, "yyyy-MM-dd'T'HH:mm")
    : endInstant
      ? formatInTimeZone(endInstant, zone, "yyyy-MM-dd'T'HH:mm")
      : (draft?.ends ?? `${date}T10:00`);
  const providerId = event?.external_id;
  const preservedStart = proposedStart ?? startInstant;
  const preservedEnd = proposedEnd ?? endInstant;
  async function makePreview(
    actionType: "create" | "update" | "delete",
    payload?: Record<string, unknown>,
  ) {
    setBusy(true);
    setError("");
    try {
      if (payload) setProposal(payload);
      setPreview(
        await query<PreviewDTO>("calendar_event_change_preview", {
          source_id: sourceId,
          action: actionType,
          ...(event
            ? {
                event_id: providerId,
                etag:
                  scope === "series"
                    ? (event.series_etag ?? event.etag)
                    : event.etag,
              }
            : {}),
          recurrence_scope: scope,
          payload: payload ?? {},
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  const changes = preview?.changes as
    | {
        action?: string;
        payload?: {
          title?: string;
          starts_at?: string;
          ends_at?: string;
          timezone?: string;
          notes?: string;
        };
        original?: {
          title?: string;
          starts_at?: string;
          ends_at?: string;
          timezone?: string;
          notes?: string;
        } | null;
        recurrence_scope?: string;
      }
    | undefined;
  return (
    <Modal
      title={
        event
          ? t("رویداد Google", "Google event")
          : t("رویداد شخصی تازه در Google", "New personal Google event")
      }
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      {operation ? (
        <div>
          <p role="status">
            {t(
              "تغییر به‌صورت پایدار ثبت شد؛ وضعیت تأیید Google:",
              "The change is durably queued; Google acknowledgement:",
            )}{" "}
            <strong>
              {status.data?.items[0]?.state ?? t("در انتظار", "Pending")}
            </strong>
          </p>
          <QueryState {...status} retry={status.refresh} />
          {status.data?.items[0]?.last_error && (
            <p className="warning">{status.data.items[0].last_error}</p>
          )}
          <p className="small muted">
            {t(
              "در نتیجهٔ نامعلوم، همین عملیات بررسی می‌شود و رویداد دوباره ساخته نمی‌شود. تعارض نیازمند تازه‌سازی و بازبینی تغییر است.",
              "Uncertain outcomes reconcile this same operation without creating a duplicate. Conflicts require refreshing and reviewing a new change.",
            )}
          </p>
          <Button
            onClick={async () => {
              await action("calendar_sync_request", {
                source_ids: [sourceId],
                force: true,
              });
              status.refresh();
            }}
          >
            {t("بررسی نتیجهٔ همین عملیات", "Check this operation")}
          </Button>
          <Button onClick={close}>{t("بستن", "Close")}</Button>
          {status.data?.items[0]?.state === "conflict" && event && (
            <section className="connection-notice">
              <div>
                <p>
                  {t(
                    "تعارض Google؛ متن پیشنهادی تو حفظ شده است. ابتدا نسخهٔ تازه را دریافت و مقایسه کن.",
                    "Google conflict; your proposed edits are retained. Retrieve and compare the current version first.",
                  )}
                </p>
                <Button
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    setError("");
                    try {
                      await action("calendar_sync_request", {
                        source_ids: [sourceId],
                        force: true,
                      });
                      let cursor: string | null = null,
                        found: EventDTO | undefined;
                      const seen = new Set<string>();
                      do {
                        const page: PageDTO<EventDTO> = await query(
                          "calendar_events_query",
                          {
                            calendar_id: sourceId,
                            from: event.starts_at,
                            to: new Date(
                              Date.parse(event.ends_at) + 86400000,
                            ).toISOString(),
                            limit: 200,
                            cursor,
                          },
                        );
                        found = page.items.find(
                          (item) =>
                            item.external_id === event.external_id &&
                            (!event.recurrence_id ||
                              item.recurrence_id === event.recurrence_id),
                        );
                        cursor = page.next_cursor;
                        if (cursor && seen.has(cursor))
                          throw new Error("Repeated calendar pagination");
                        if (cursor) seen.add(cursor);
                      } while (!found && cursor);
                      if (!found)
                        throw new Error(
                          t(
                            "این نوبت دیگر در بازهٔ فعلی نیست؛ تقویم را برای مکان تازه یا حذف آن بررسی کن. متن پیشنهادی حفظ شد.",
                            "This occurrence is no longer in the current range. Check the calendar for its new position or deletion. Your proposal is retained.",
                          ),
                        );
                      setRemote(found);
                    } catch (cause) {
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      );
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {t(
                    "دریافت نسخهٔ تازه برای مقایسه",
                    "Retrieve current version to compare",
                  )}
                </Button>
                {remote && (
                  <>
                    <dl className="metadata-list">
                      <dt>{t("نسخهٔ Google", "Google version")}</dt>
                      <dd>
                        {remote.title}
                        <br />
                        {remote.starts_at} → {remote.ends_at}
                        <br />
                        {remote.notes}
                      </dd>
                      <dt>{t("پیشنهاد من", "My proposal")}</dt>
                      <dd>
                        {String(proposal?.title ?? event.title)}
                        <br />
                        {String(proposal?.starts_at ?? event.starts_at)} →{" "}
                        {String(proposal?.ends_at ?? event.ends_at)}
                        <br />
                        {String(proposal?.notes ?? event.notes)}
                      </dd>
                    </dl>
                    <Button
                      onClick={() => {
                        setProposal(null);
                        close();
                      }}
                    >
                      {t("استفاده از نسخهٔ Google", "Use Google version")}
                    </Button>
                    <Button
                      disabled={!remote.can_edit}
                      onClick={() => {
                        setEvent(remote);
                        setOperation(null);
                      }}
                    >
                      {t(
                        "بازبینی متن من روی نسخهٔ تازه",
                        "Review my edits against the current version",
                      )}
                    </Button>
                  </>
                )}
              </div>
            </section>
          )}
        </div>
      ) : (
        <>
          <form
            className="form-grid"
            key={`${scope}:${zone}`}
            onSubmit={async (submit) => {
              submit.preventDefault();
              const values = new FormData(submit.currentTarget);
              setError("");
              try {
                const allDay = values.get("all_day") === "on",
                  startChoice = String(values.get("start_disambiguation")) as
                    "reject" | "earlier" | "later",
                  endChoice = String(values.get("end_disambiguation")) as
                    "reject" | "earlier" | "later";
                let start = String(values.get("starts")),
                  end = String(values.get("ends"));
                if (allDay) {
                  const a = start.slice(0, 10),
                    b = end.slice(0, 10);
                  start = `${a}T00:00`;
                  end = `${b > a ? b : addCalendarDays(a, 1)}T00:00`;
                }
                await makePreview(event ? "update" : "create", {
                  title: String(values.get("title")),
                  starts_at:
                    !allDay && start === starts && preservedStart
                      ? preservedStart
                      : zonedLocalToInstant(start, zone, startChoice),
                  ends_at:
                    !allDay && end === ends && preservedEnd
                      ? preservedEnd
                      : zonedLocalToInstant(end, zone, endChoice),
                  timezone: zone,
                  all_day: allDay,
                  notes: String(values.get("notes")),
                  ...(!event || scope === "series"
                    ? {
                        recurrence_rule:
                          String(values.get("recurrence")) || null,
                      }
                    : {}),
                });
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
          >
            {!event && (
              <Field label={t("مقصد رویداد", "Event destination")}>
                <select
                  value={sourceId}
                  onChange={(change) => onSource(change.target.value)}
                >
                  <option value="local">
                    {t("تقویم محلی Life OS", "Life OS local calendar")}
                  </option>
                  {sources
                    .filter((source) => source.writable && source.enabled)
                    .map((source) => (
                      <option key={source.source_id} value={source.source_id}>
                        {source.title} · Google
                      </option>
                    ))}
                </select>
              </Field>
            )}
            {event && (
              <p className="small muted">
                {event.source_title ??
                  sources.find((source) => source.source_id === sourceId)
                    ?.title}{" "}
                · {event.sync_state ?? "synced"}
              </p>
            )}
            {event?.recurrence_rule && !readonly && (
              <Field label={t("دامنهٔ تغییر", "Change scope")}>
                <select
                  value={scope}
                  onChange={(change) =>
                    setScope(change.target.value as typeof scope)
                  }
                >
                  <option value="instance">
                    {t("فقط این نوبت", "This occurrence only")}
                  </option>
                  <option value="series">{t("کل سری", "Entire series")}</option>
                </select>
              </Field>
            )}
            <Field label={t("عنوان", "Title")}>
              <input
                name="title"
                required
                defaultValue={String(proposal?.title ?? event?.title ?? "")}
                readOnly={readonly}
              />
            </Field>
            <Field label={t("منطقهٔ زمانی", "Time zone")}>
              <select
                value={zone}
                disabled={readonly}
                onChange={(change) => setZone(change.target.value)}
              >
                {[
                  ...new Set(["Europe/Berlin", "Asia/Tehran", "UTC", zone]),
                ].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </Field>
            <Field label={t("شروع", "Start")}>
              <input
                type="datetime-local"
                name="starts"
                required
                step={60}
                defaultValue={starts}
                readOnly={readonly}
              />
            </Field>
            <Field label={t("پایان", "End")}>
              <input
                type="datetime-local"
                name="ends"
                required
                step={60}
                defaultValue={ends}
                readOnly={readonly}
              />
            </Field>
            <label className="check-label">
              <input
                name="all_day"
                type="checkbox"
                defaultChecked={
                  proposal ? proposal.all_day === true : event?.all_day
                }
                disabled={readonly}
              />
              {t("تمام روز؛ پایان غیرشامل است", "All day; end is exclusive")}
            </label>
            {(!event || scope === "series") && (
              <Field label={t("قاعدهٔ تکرار", "Recurrence rule")}>
                <input
                  name="recurrence"
                  defaultValue={String(
                    proposal?.recurrence_rule ?? event?.recurrence_rule ?? "",
                  )}
                  readOnly={readonly}
                  placeholder="FREQ=WEEKLY"
                />
              </Field>
            )}
            {(["start", "end"] as const).map((endpoint) => (
              <Field
                key={endpoint}
                label={
                  endpoint === "start"
                    ? t("ساعت پاییزیِ شروع", "Repeated start time")
                    : t("ساعت پاییزیِ پایان", "Repeated end time")
                }
              >
                <select name={`${endpoint}_disambiguation`} disabled={readonly}>
                  <option value="reject">
                    {t("نیاز به انتخاب", "Require a choice")}
                  </option>
                  <option value="earlier">
                    {t("بار اول", "First occurrence")}
                  </option>
                  <option value="later">
                    {t("بار دوم", "Second occurrence")}
                  </option>
                </select>
              </Field>
            ))}
            <Field label={t("یادداشت", "Notes")}>
              <textarea
                name="notes"
                rows={4}
                defaultValue={String(proposal?.notes ?? event?.notes ?? "")}
                readOnly={readonly}
              />
            </Field>
            {readonly ? (
              <p className="muted">
                {t(
                  "این رویداد فقط خواندنی است؛ دعوت‌ها، مهمان‌ها و رویدادهای ویژه را در Google مدیریت کن.",
                  "This event is read-only. Manage invitations, guests and special events in Google.",
                )}
              </p>
            ) : (
              <Button type="submit" disabled={busy}>
                {t("پیش‌نمایش تغییر Google", "Preview Google change")}
              </Button>
            )}
          </form>
          {event?.external_url &&
            /^https:\/\/(calendar\.google\.com|www\.google\.com)\//.test(
              event.external_url,
            ) && (
              <a
                className="button"
                href={event.external_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("بازکردن در Google", "Open in Google")}
              </a>
            )}
          {event && !readonly && (
            <Button disabled={busy} onClick={() => void makePreview("delete")}>
              {scope === "series"
                ? t("پیش‌نمایش حذف کل سری", "Preview deleting entire series")
                : t("پیش‌نمایش حذف این رویداد", "Preview deleting this event")}
            </Button>
          )}
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Modal
        title={t("تأیید تغییر شخصی Google", "Confirm personal Google change")}
        open={!!preview}
        onOpenChange={(value) => {
          if (!value) setPreview(null);
        }}
      >
        <dl className="metadata-list">
          {changes?.original && (
            <>
              <dt>
                {t(
                  "نسخهٔ فعلی Google که همین حالا بررسی شد",
                  "Current Google version checked just now",
                )}
              </dt>
              <dd>
                <strong>{changes.original.title}</strong>
                <p dir="ltr">
                  {changes.original.starts_at} → {changes.original.ends_at}
                </p>
                <small>{changes.original.timezone}</small>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {changes.original.notes}
                </p>
              </dd>
            </>
          )}
          <dt>
            {changes?.action === "delete"
              ? t(
                  "نتیجهٔ پیشنهادی: حذف رویداد",
                  "Proposed result: delete event",
                )
              : t(
                  "نسخهٔ پیشنهادی پس از تغییر",
                  "Proposed version after change",
                )}
          </dt>
          <dd>
            {changes?.action === "delete" ? (
              t(
                "رویداد نمایش‌داده‌شدهٔ بالا از Google حذف می‌شود.",
                "The Google event shown above will be deleted.",
              )
            ) : (
              <>
                <strong>{changes?.payload?.title}</strong>
                <p dir="ltr">
                  {changes?.payload?.starts_at} → {changes?.payload?.ends_at}
                </p>
                <small>{changes?.payload?.timezone}</small>
                <p style={{ whiteSpace: "pre-wrap" }}>
                  {changes?.payload?.notes}
                </p>
              </>
            )}
          </dd>
        </dl>
        <p>
          {changes?.payload?.timezone} ·{" "}
          {changes?.recurrence_scope === "series"
            ? t("کل سری", "Entire series")
            : t("این نوبت", "This occurrence")}
        </p>
        <p>
          {t(
            "این عملیات برای رویداد شخصی است و دعوت یا ایمیل ارسال نمی‌کند. تأیید نهایی پس از پاسخ Google مشخص می‌شود.",
            "This personal-event operation sends no invitations or emails. Final confirmation follows Google's acknowledgement.",
          )}
        </p>
        <Button
          disabled={busy}
          variant="primary"
          onClick={async () => {
            if (!preview) return;
            setBusy(true);
            try {
              const result = await action("calendar_event_change_commit", {
                preview_id: preview.preview_id,
              });
              if (result) {
                setOperation(result.entity_id);
                setPreview(null);
              }
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("تأیید و ارسال تغییر", "Confirm and send change")}
        </Button>
      </Modal>
    </Modal>
  );
}
