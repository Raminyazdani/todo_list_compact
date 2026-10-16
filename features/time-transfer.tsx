"use client";

import { useState } from "react";
import type {
  PageDTO,
  PreviewDTO,
  TimeDraftDTO,
  TimeImportEntryDTO,
} from "@/shared/contracts";
import { ApiError, query } from "./api";
import { useLocale } from "./locale";
import { Button, Field, Modal } from "@/components/ui";
import type { CalendarAction } from "./calendar-workspace";
import { splitTimeImport } from "./time-transfer-model";

type ImportChanges = {
  timezone: string;
  counts: {
    provided: number;
    new: number;
    skipped: number;
    drafts_new?: number;
    drafts_skipped?: number;
  };
  entries_to_create: TimeImportEntryDTO[];
  drafts_to_create?: Omit<TimeDraftDTO, "revision">[];
  minutes_to_create: number;
};
type ImportBatch = {
  data: Record<string, unknown>;
  preview: PreviewDTO;
  committed: boolean;
  prepared?: boolean;
};
type LegacyIssue = { source_id: string; code: string; message?: string };

export function TimeTransfer({
  from,
  to,
  month,
  action,
}: {
  from: string;
  to: string;
  month: string;
  action: CalendarAction;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [original, setOriginal] = useState<Record<string, unknown> | null>(
    null,
  );
  const [issues, setIssues] = useState<LegacyIssue[]>([]);
  const [resolutions, setResolutions] = useState<
    Record<string, { start?: string; end?: string }>
  >({});
  async function allPages<T>(
    operation: "time_entry_export" | "time_draft_list",
    input: Record<string, unknown> = {},
  ) {
    const items: T[] = [],
      seen = new Set<string>();
    let cursor: string | null = null;
    do {
      const page: PageDTO<T> = await query(operation, {
        ...input,
        cursor,
        limit: 200,
      });
      items.push(...page.items);
      cursor = page.next_cursor;
      if (cursor && seen.has(cursor))
        throw new Error(
          t(
            "صفحه‌بندی تکرار شد؛ خروجی ذخیره نشد.",
            "Pagination repeated; no export was saved.",
          ),
        );
      if (cursor) seen.add(cursor);
    } while (cursor);
    return items;
  }
  async function exportJson(all: boolean) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const entries = await allPages<TimeImportEntryDTO>(
        "time_entry_export",
        all ? {} : { from, to },
      );
      const drafts = (await allPages<TimeDraftDTO>("time_draft_list"))
        .filter((draft) => all || draft.date.startsWith(month))
        .map((draft) => ({
          draft_id: draft.draft_id,
          employer: draft.employer,
          date: draft.date,
          start: draft.start,
          end: draft.end,
          end_next_day: draft.end_next_day,
          description: draft.description,
          timezone: draft.timezone,
          ...(draft.legacy_metadata
            ? { legacy_metadata: draft.legacy_metadata }
            : {}),
        }));
      const blob = new Blob(
        [
          JSON.stringify(
            {
              format: "ramin-life-os-time/1",
              timezone: "Europe/Berlin",
              entries,
              drafts,
            },
            null,
            2,
          ),
        ],
        { type: "application/json" },
      );
      const url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = `life-os-time-${all ? "all-history" : month}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(
        t(
          `${entries.length} بازه و ${drafts.length} پیش‌نویس صادر شد؛ واردسازی مجدد خودکار دسته‌بندی می‌شود.`,
          `Exported ${entries.length} intervals and ${drafts.length} drafts. Restoration is automatically batched.`,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function previewImport(
    data: Record<string, unknown>,
    choices = resolutions,
  ) {
    setBusy(true);
    setError("");
    setBatches([]);
    setIssues([]);
    try {
      const parts = splitTimeImport(data),
        previews: ImportBatch[] = [];
      for (let index = 0; index < parts.length; index++) {
        setMessage(
          t(
            `بررسی دستهٔ ${index + 1} از ${parts.length}…`,
            `Checking batch ${index + 1} of ${parts.length}…`,
          ),
        );
        const preview = await query<PreviewDTO>("time_entry_import_preview", {
          data: parts[index],
          timezone: String(data.timezone ?? "Europe/Berlin"),
          resolutions: choices,
        });
        previews.push({ data: parts[index], preview, committed: false });
      }
      setBatches(previews);
      setMessage("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ApiError && Array.isArray(cause.details.errors))
        setIssues(cause.details.errors as LegacyIssue[]);
    } finally {
      setBusy(false);
    }
  }
  async function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError("");
    setMessage("");
    setResolutions({});
    try {
      if (file.size > 50_000_000)
        throw new Error(
          t("حداکثر حجم فایل ۵۰ مگابایت است.", "The file limit is 50 MB."),
        );
      const data: unknown = JSON.parse(await file.text());
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error(
          t("ساختار فایل JSON معتبر نیست.", "Invalid JSON object."),
        );
      setOriginal(data as Record<string, unknown>);
      await previewImport(data as Record<string, unknown>, {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  const changes = batches.map(
    (batch) => batch.preview.changes as unknown as ImportChanges,
  );
  return (
    <div className="time-transfer">
      <div className="form-actions">
        <Button disabled={busy} onClick={() => void exportJson(true)}>
          {t(
            "خروجی JSON تمام تاریخچه و پیش‌نویس‌ها",
            "Export all history and drafts as JSON",
          )}
        </Button>
        <Button disabled={busy} onClick={() => void exportJson(false)}>
          {t(
            "خروجی JSON همهٔ بازه‌های ماه",
            "Export all monthly entries as JSON",
          )}
        </Button>
        <label className={`button ${busy ? "disabled" : ""}`}>
          {t("اعتبارسنجی و پیش‌نمایش JSON", "Validate and preview JSON import")}
          <input
            type="file"
            accept=".json,application/json"
            hidden
            disabled={busy}
            onChange={(event) => void importJson(event)}
          />
        </label>
      </div>
      <p className="small muted">
        {t(
          "قالب Life OS و نسخهٔ ۱ Work Planner پذیرفته می‌شود. فایل بزرگ خودکار به درخواست‌های محدود تقسیم می‌شود؛ شناسه، شرح، پیش‌نویس و روش محاسبه حفظ می‌شوند. تداخل هشدار دارد و از ساعات کم نمی‌شود.",
          "Accepts Life OS and Work Planner version 1. Large files are automatically split into bounded requests; IDs, descriptions, drafts and reporting policy are preserved. Overlaps warn without deducting hours.",
        )}
      </p>
      {busy && (
        <p role="status">
          {t("در حال بررسی یا ذخیره…", "Checking or saving…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {!!issues.length && (
        <section className="panel">
          <h3>
            {t("تعیین تکلیف زمان‌های مرجع", "Resolve imported local times")}
          </h3>
          <p>
            {t(
              "هیچ ردیفی کنار گذاشته نشده است. ساعت تکراری را مشخص کن؛ زمان ناموجود یا خراب نیازمند اصلاح فایل اصلی است.",
              "No rows were discarded. Resolve repeated local times; nonexistent or malformed times require correcting the source file.",
            )}
          </p>
          {issues.map((issue, index) => (
            <div key={`${issue.source_id}:${index}`}>
              <strong>
                {issue.source_id} · {issue.code}
              </strong>
              {issue.code === "DST_RESOLUTION_REQUIRED" && (
                <div className="form-columns">
                  {(["start", "end"] as const).map((endpoint) => (
                    <Field
                      key={endpoint}
                      label={
                        endpoint === "start"
                          ? t("شروع", "Start")
                          : t("پایان", "End")
                      }
                    >
                      <select
                        value={resolutions[issue.source_id]?.[endpoint] ?? ""}
                        onChange={(event) =>
                          setResolutions((old) => ({
                            ...old,
                            [issue.source_id]: {
                              ...old[issue.source_id],
                              [endpoint]: event.target.value,
                            },
                          }))
                        }
                      >
                        <option value="">{t("انتخاب کن", "Choose")}</option>
                        <option value="earlier">
                          {t("بار اول", "First occurrence")}
                        </option>
                        <option value="later">
                          {t("بار دوم", "Second occurrence")}
                        </option>
                      </select>
                    </Field>
                  ))}
                </div>
              )}
            </div>
          ))}
          <Button
            disabled={busy}
            onClick={() => {
              if (original) void previewImport(original);
            }}
          >
            {t("بررسی دوباره با انتخاب‌ها", "Recheck using these choices")}
          </Button>
        </section>
      )}
      <Modal
        title={t("بررسی واردسازی بازه‌های کار", "Review work-time import")}
        open={!!batches.length}
        onOpenChange={(open) => {
          if (!open && !busy) setBatches([]);
        }}
        wide
      >
        <p>
          {t(
            `${changes.reduce((sum, value) => sum + value.counts.provided, 0)} ردیف در ${batches.length} دسته؛ ${changes.reduce((sum, value) => sum + value.counts.new, 0)} بازهٔ تازه و ${changes.reduce((sum, value) => sum + value.counts.skipped, 0)} تکراری.`,
            `${changes.reduce((sum, value) => sum + value.counts.provided, 0)} rows in ${batches.length} batches; ${changes.reduce((sum, value) => sum + value.counts.new, 0)} new intervals and ${changes.reduce((sum, value) => sum + value.counts.skipped, 0)} duplicates.`,
          )}
        </p>
        <p className="muted small">
          {t(
            "تا تأیید، هیچ بازه‌ای ذخیره نمی‌شود. هر دسته تراکنش مستقل دارد؛ در قطع ارتباط، دسته‌های تأییدشده حفظ و ادامهٔ همان عملیات بازیابی می‌شود.",
            "Nothing is saved before confirmation. Each batch is transactional; acknowledged batches survive interruptions and the same remaining intents can be recovered.",
          )}
        </p>
        <div className="data-table-wrap">
          <table>
            <thead>
              <tr>
                <th>{t("محل کار", "Workplace")}</th>
                <th>{t("شروع دقیق", "Exact start")}</th>
                <th>{t("پایان دقیق", "Exact end")}</th>
                <th>{t("شرح", "Description")}</th>
              </tr>
            </thead>
            <tbody>
              {changes
                .flatMap((change) => change.entries_to_create ?? [])
                .map((entry) => (
                  <tr key={entry.entry_id}>
                    <td>{entry.employer}</td>
                    <td dir="ltr">{entry.starts_at}</td>
                    <td dir="ltr">{entry.ends_at}</td>
                    <td>{entry.description}</td>
                  </tr>
                ))}
              {changes
                .flatMap((change) => change.drafts_to_create ?? [])
                .map((draft) => (
                  <tr key={draft.draft_id}>
                    <td>
                      {draft.employer} · {t("پیش‌نویس", "Draft")}
                    </td>
                    <td dir="ltr">
                      {draft.date} {draft.start || "—"}
                    </td>
                    <td dir="ltr">{draft.end || "—"}</td>
                    <td>{draft.description}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {batches
          .flatMap((batch) => batch.preview.warnings)
          .map((warning, index) => (
            <p className="warning" key={index}>
              {warning}
            </p>
          ))}
        {batches.map((batch, index) => (
          <p key={batch.preview.preview_id} className="small muted">
            {t("دسته", "Batch")} {index + 1}:{" "}
            {batch.committed
              ? t("تأیید و ذخیره شد", "Acknowledged and saved")
              : t("در انتظار تأیید", "Awaiting confirmation")}
          </p>
        ))}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button disabled={busy} onClick={() => setBatches([])}>
            {t("لغو واردسازی", "Cancel import")}
          </Button>
          <Button
            disabled={busy}
            variant="primary"
            onClick={async () => {
              setBusy(true);
              setError("");
              try {
                for (let index = 0; index < batches.length; index++) {
                  let batch = batches[index];
                  if (batch.committed) continue;
                  if (index > 0 && !batch.prepared) {
                    // A prior ACK changes the ledger revision. Revalidate the
                    // approved payload, then retain this exact preview on retry.
                    const fresh = await query<PreviewDTO>(
                      "time_entry_import_preview",
                      {
                        data: batch.data,
                        timezone: String(original?.timezone ?? "Europe/Berlin"),
                        resolutions,
                      },
                    );
                    const accepted = batch.preview
                      .changes as unknown as ImportChanges;
                    const latest = fresh.changes as unknown as ImportChanges;
                    const comparable = (value: ImportChanges) =>
                      JSON.stringify({
                        counts: value.counts,
                        entries: value.entries_to_create,
                        drafts: value.drafts_to_create ?? [],
                      });
                    batch = { ...batch, preview: fresh, prepared: true };
                    setBatches((current) =>
                      current.map((value, batchIndex) =>
                        batchIndex === index ? batch : value,
                      ),
                    );
                    if (comparable(accepted) !== comparable(latest))
                      throw new Error(
                        t(
                          "وضعیت این دسته پس از بازبینی تغییر کرده؛ پیش‌نمایش تازه را بررسی و دوباره تأیید کن. دسته‌های قبلی حفظ شده‌اند.",
                          "This batch changed since review. Inspect its refreshed preview and confirm again. Earlier acknowledged batches are preserved.",
                        ),
                      );
                  }
                  const result = await action("time_entry_import_commit", {
                    preview_id: batch.preview.preview_id,
                  });
                  if (!result)
                    throw new Error(
                      t(
                        `دستهٔ ${index + 1} تأیید نشد؛ برای ادامه همان دکمه را دوباره بزن.`,
                        `Batch ${index + 1} was not acknowledged. Retry the same confirmation to recover it.`,
                      ),
                    );
                  setBatches((current) =>
                    current.map((value, batchIndex) =>
                      batchIndex === index
                        ? { ...value, committed: true }
                        : value,
                    ),
                  );
                }
                setBatches([]);
                setOriginal(null);
                setMessage(
                  t(
                    "واردسازی تأیید و ذخیره شد.",
                    "Import was confirmed and saved.",
                  ),
                );
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
              "تأیید صریح و واردسازی بازه‌ها",
              "Confirm and import these entries",
            )}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
