"use client";

import { useState } from "react";
import type {
  CommandName,
  MutationResult,
  PageDTO,
  PreviewDTO,
  TimeEntryDTO,
} from "@/shared/contracts";
import { query } from "./api";
import { useLocale } from "./locale";
import { Button, Modal } from "@/components/ui";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
type ImportChanges = {
  format: string;
  timezone: string;
  counts: { provided: number; new: number; skipped: number };
  entries_to_create: {
    entry_id: string;
    employer: string;
    starts_at: string;
    ends_at: string;
    description: string;
    task_id: string | null;
  }[];
  skipped_entry_ids: string[];
  minutes_to_create: number;
};

export function TimeTransfer({
  from,
  to,
  month,
  action,
}: {
  from: string;
  to: string;
  month: string;
  action: Action;
}) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PreviewDTO | null>(null);
  const changes = preview?.changes as ImportChanges | undefined;
  async function exportJson() {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const entries: ImportChanges["entries_to_create"] = [];
      let cursor: string | null = null;
      const seen = new Set<string>();
      do {
        const page: PageDTO<TimeEntryDTO> = await query("time_entry_list", {
          from,
          to,
          limit: 200,
          cursor,
        });
        entries.push(
          ...page.items.map(
            ({
              entry_id,
              employer,
              starts_at,
              ends_at,
              description,
              task_id,
            }) => ({
              entry_id,
              employer,
              starts_at,
              ends_at,
              description,
              task_id,
            }),
          ),
        );
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
      const data = {
        format: "ramin-life-os-time/1",
        timezone: "Europe/Berlin",
        entries,
      };
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `life-os-time-${month}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setMessage(
        t(
          `${entries.length} بازه از همهٔ صفحه‌های ماه صادر شد.`,
          `Exported ${entries.length} entries from every page of this month.`,
        ) +
          (entries.length > 1000 || blob.size > 2_000_000
            ? t(
                " برای واردکردن دوباره، فایل را به بخش‌های حداکثر ۱۰۰۰ بازه و ۲ مگابایت تقسیم کن.",
                " To import again, split this export into batches of at most 1,000 entries and 2 MB.",
              )
            : ""),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (file.size > 2_000_000)
        throw new Error(
          t("حداکثر حجم واردسازی ۲ مگابایت است.", "The import limit is 2 MB."),
        );
      const data: unknown = JSON.parse(await file.text());
      const response = await fetch("/api/v1/query", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          operation: "time_entry_import_preview",
          input: { data },
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? `Import preview failed (${response.status})`,
        );
      setPreview(body.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="time-transfer">
      <div className="form-actions">
        <Button disabled={busy} onClick={() => void exportJson()}>
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
          "واردسازی حداکثر ۱۰۰۰ بازه و ۲ مگابایت دارد. شناسه‌ها و زمان‌های دقیق حفظ می‌شوند؛ رکورد یکسان ردگیری و کنار گذاشته می‌شود، تعارض یا هم‌پوشانی کل واردسازی را متوقف می‌کند.",
          "Imports support at most 1,000 entries and 2 MB. Exact IDs and timestamps are preserved. Identical entries are skipped; conflicts or overlaps stop the whole import.",
        )}
      </p>
      {busy && (
        <p role="status">
          {t("در حال بررسی زمان‌ها…", "Checking time entries…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      <Modal
        title={t("بررسی واردسازی بازه‌های کار", "Review work-time import")}
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        wide
      >
        {changes && (
          <>
            <p>
              {t(
                `${changes.counts.provided} بازه: ${changes.counts.new} تازه، ${changes.counts.skipped} تکراری. ${changes.minutes_to_create} دقیقهٔ تازه.`,
                `${changes.counts.provided} entries: ${changes.counts.new} new, ${changes.counts.skipped} duplicates. ${changes.minutes_to_create} new minutes.`,
              )}
            </p>
            <p className="muted small">
              {changes.timezone} ·{" "}
              {t(
                "هنوز چیزی ذخیره نشده. تأیید همهٔ بازه‌های تازه را یکجا ذخیره می‌کند.",
                "Nothing is saved yet. Confirmation saves all new entries together.",
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
                  {changes.entries_to_create.map((entry) => (
                    <tr key={entry.entry_id}>
                      <td>{entry.employer}</td>
                      <td dir="ltr">{entry.starts_at}</td>
                      <td dir="ltr">{entry.ends_at}</td>
                      <td>{entry.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview?.warnings.map((warning) => (
              <p key={warning} className="warning">
                {warning}
              </p>
            ))}
            <div className="form-actions">
              <Button onClick={() => setPreview(null)}>
                {t("لغو واردسازی", "Cancel import")}
              </Button>
              <Button
                variant="primary"
                onClick={async () => {
                  if (
                    preview &&
                    (await action("time_entry_import_commit", {
                      preview_id: preview.preview_id,
                    }))
                  ) {
                    setPreview(null);
                    setMessage(
                      t(
                        "واردسازی تأیید و ذخیره شد.",
                        "Import was confirmed and saved.",
                      ),
                    );
                  }
                }}
              >
                {t(
                  "تأیید صریح و واردسازی بازه‌ها",
                  "Confirm and import these entries",
                )}
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
