"use client";

import { useState } from "react";
import { ArrowDown, ArrowUp, SlidersHorizontal } from "lucide-react";
import {
  DEFAULT_TASK_ROW_LAYOUTS,
  TASK_ROW_FIELDS,
  getTaskRowField,
  parseTaskRowLayout,
  type TaskRowFieldMode,
  type TaskRowLayout,
  type TaskRowView,
} from "@/shared/task-row-fields";
import type { PageDTO } from "@/shared/contracts";
import { Button, Field, Modal } from "@/components/ui";
import { ApiError, clearQueryCache, query } from "./api";
import { useLocale } from "./locale";
import type { TaskRowMutation } from "./task-row-controller";

export interface RowSavedView {
  view_id: string;
  title: string;
  revision: number;
  configuration: Record<string, unknown> & {
    filters?: Record<string, unknown>;
    layout?: string;
    row_fields?: unknown;
  };
}
export interface RowPreferences {
  settings: Record<string, unknown>;
  revision: number;
}
type Baseline = { preferences: RowPreferences; saved?: RowSavedView };
function pickerLayout(layout: TaskRowLayout): TaskRowLayout {
  return {
    schema_version: 1,
    fields: [
      ...layout.fields,
      ...TASK_ROW_FIELDS.filter(
        (field) => !layout.fields.some((entry) => entry.id === field.id),
      ).map((field) => ({ id: field.id, mode: "hidden" as const })),
    ],
  };
}

export function TaskRowSettings({
  view,
  enabled,
  layout,
  source,
  invalid,
  preferences,
  savedView,
  mutate,
}: {
  view: TaskRowView;
  enabled: boolean;
  layout: TaskRowLayout;
  source: "default" | "preferences" | "saved_view";
  invalid: boolean;
  preferences: RowPreferences | null;
  savedView?: RowSavedView;
  mutate: TaskRowMutation;
}) {
  const { t, language } = useLocale();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => pickerLayout(layout));
  const [target, setTarget] = useState<"default" | "saved_view">("default");
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [confirmed, setConfirmed] = useState("");
  const [intent, setIntent] = useState<{
    target: "default" | "saved_view";
    view: TaskRowView;
    layout: TaskRowLayout | null;
    baseline: Baseline;
  } | null>(null);
  const [unconfirmed, setUnconfirmed] = useState(false);
  function begin() {
    if (!preferences) return;
    setDraft(pickerLayout(layout));
    setTarget(savedView ? "saved_view" : "default");
    setBaseline({ preferences, saved: savedView });
    setError("");
    setConflict(false);
    setConfirmed("");
    setIntent(null);
    setUnconfirmed(false);
    setOpen(true);
  }
  function mode(index: number, value: TaskRowFieldMode) {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field, at) =>
        at === index ? { ...field, mode: value } : field,
      ),
    }));
  }
  function move(index: number, direction: number) {
    setDraft((current) => {
      const fields = [...current.fields];
      if (index + direction < 1 || index + direction >= fields.length)
        return current;
      [fields[index], fields[index + direction]] = [
        fields[index + direction],
        fields[index],
      ];
      return { ...current, fields };
    });
  }
  async function persist(reset = false, recover = false) {
    if (pending || !baseline) return;
    let proposed: NonNullable<typeof intent>;
    try {
      proposed =
        recover && intent
          ? intent
          : {
              target,
              view,
              layout: reset ? null : parseTaskRowLayout(draft),
              baseline,
            };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return;
    }
    setIntent(proposed);
    setPending(true);
    setError("");
    setConflict(false);
    try {
      if (proposed.target === "saved_view") {
        const saved = proposed.baseline.saved;
        if (!saved)
          throw new Error(
            t("نمای ذخیره‌شده انتخاب نشده است.", "Choose a saved view first."),
          );
        await mutate(
          "saved_view_update",
          {
            view_id: saved.view_id,
            configuration: {
              ...saved.configuration,
              row_fields: proposed.layout,
            },
          },
          saved.revision,
        );
      } else {
        await mutate(
          "preferences_update",
          {
            settings: {
              task_row_layouts: { [proposed.view]: proposed.layout },
            },
          },
          proposed.baseline.preferences.revision,
        );
      }
      setUnconfirmed(false);
      setIntent(null);
      setConfirmed(
        proposed.layout === null
          ? t(
              "تنظیم اختصاصی حذف شد؛ پیش‌فرض اعمال می‌شود.",
              "Override removed; the inherited default applies.",
            )
          : t(
              "تنظیم مشترک همهٔ ردیف‌های این نما ذخیره شد.",
              "Shared settings saved for every row in this view.",
            ),
      );
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConflict(
        cause instanceof ApiError && cause.code === "REVISION_CONFLICT",
      );
      setUnconfirmed(
        cause instanceof ApiError && cause.code === "WRITE_UNCONFIRMED",
      );
    } finally {
      setPending(false);
    }
  }
  async function reviewLatest() {
    try {
      clearQueryCache();
      const readActiveView = async () => {
        const id = baseline?.saved?.view_id;
        if (!id) return undefined;
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const page: PageDTO<RowSavedView> = await query("saved_view_list", {
            limit: 200,
            ...(cursor ? { cursor } : {}),
          });
          const found = page.items.find((item) => item.view_id === id);
          if (found) return found;
          cursor = page.next_cursor;
          if (cursor && seen.has(cursor))
            throw new Error(
              t(
                "صفحه‌بندی نماها کامل نشد؛ دوباره تلاش کن.",
                "Saved-view pagination did not complete. Retry.",
              ),
            );
          if (cursor) seen.add(cursor);
        } while (cursor);
        return undefined;
      };
      const [freshPreferences, freshSaved] = await Promise.all([
        query<RowPreferences>("preferences_get"),
        readActiveView(),
      ]);
      if (baseline?.saved && !freshSaved)
        throw new Error(
          t(
            "نمای فعال در این صفحهٔ نتایج پیدا نشد؛ دوباره انتخابش کن.",
            "The active saved view was not found. Select it again.",
          ),
        );
      setBaseline({ preferences: freshPreferences, saved: freshSaved });
      setConflict(false);
      setIntent(null);
      setError(
        t(
          "نسخهٔ تازه دریافت شد. پیش‌نویس تنظیماتت حفظ شده؛ برای اعمال آگاهانه دوباره ثبت کن. فیلتر و چیدمان تازهٔ نما حفظ می‌شوند.",
          "Latest version loaded. Your proposed fields are kept; save again to apply them explicitly. The latest view filters and layout are preserved.",
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }
  return (
    <>
      <Button
        data-testid="row-settings-button"
        disabled={!enabled || !preferences}
        title={
          !enabled
            ? t(
                "تنظیم ردیف‌ها در فهرست و درخت در دسترس است",
                "Row settings are available in list and tree views",
              )
            : undefined
        }
        onClick={begin}
      >
        <SlidersHorizontal size={15} />
        {t("تنظیم ردیف‌ها", "Configure rows")}
      </Button>
      {invalid && (
        <p className="warning" role="status">
          {t(
            "تنظیم ذخیره‌شدهٔ ردیف معتبر نیست؛ پیش‌فرض امن نمایش داده می‌شود.",
            "Stored row settings are invalid; a safe default is displayed.",
          )}
        </p>
      )}
      {confirmed && (
        <span className="small muted" role="status">
          {confirmed}
        </span>
      )}
      <Modal
        title={t("تنظیم ردیف‌ها", "Row settings")}
        open={open}
        wide
        onOpenChange={(value) => {
          if (!pending && !unconfirmed) setOpen(value);
        }}
      >
        <p>
          {t(
            "یک تنظیم برای تمام ردیف‌های این نما، شامل والد و فرزند. این تنظیم مقدار هیچ کاری را تغییر نمی‌دهد.",
            "One layout for every row in this view, including parents and children. These settings do not change task values.",
          )}
        </p>
        <p className="small muted">
          {t("منبع فعلی", "Current source")}:{" "}
          {source === "saved_view"
            ? t("نمای ذخیره‌شده", "Saved view")
            : source === "preferences"
              ? t("پیش‌فرض شخصی نما", "Personal view default")
              : t("پیش‌فرض برنامه", "Application default")}{" "}
          · {view === "tree" ? t("درخت", "Tree") : t("فهرست", "List")}
        </p>
        <Field label={t("مقصد ذخیرهٔ تنظیمات", "Save row settings to")}>
          <select
            aria-label={t("مقصد ذخیرهٔ تنظیمات", "Save row settings to")}
            value={target}
            disabled={pending || unconfirmed}
            onChange={(event) => setTarget(event.target.value as typeof target)}
          >
            <option value="default">
              {t("پیش‌فرض این نوع نما", "Default for this view type")}
            </option>
            {savedView && (
              <option value="saved_view">
                {t("همین نمای ذخیره‌شده", "This saved view")}: {savedView.title}
              </option>
            )}
          </select>
        </Field>
        {target === "default" && source === "saved_view" && (
          <p className="warning">
            {t(
              "نمای فعال تنظیم اختصاصی دارد؛ تغییر پیش‌فرض تا بازگردانی تنظیم همین نمای ذخیره‌شده روی آن دیده نمی‌شود.",
              "This saved view has an override. Its fields keep taking precedence until that override is reset.",
            )}
          </p>
        )}
        <div
          className="row-settings-preview"
          aria-label={t("پیش‌نمایش مصنوعی تنظیم ردیف", "Synthetic row preview")}
        >
          <strong>{t("کار نمونه", "Example task")}</strong>
          <div>
            {draft.fields
              .filter(
                (field) => field.id !== "title" && field.mode !== "hidden",
              )
              .map((field) => (
                <span key={field.id}>
                  {getTaskRowField(field.id).label[language]}
                  {field.mode === "edit" ? " ✎" : ""}
                </span>
              ))}
          </div>
        </div>
        <div
          className="row-settings-fields"
          role="region"
          aria-label={t(
            "فیلدهای ردیف و ترتیب آن‌ها",
            "Row fields and their order",
          )}
          tabIndex={0}
        >
          {draft.fields.map((entry, index) => {
            const field = getTaskRowField(entry.id);
            const label = field.label[language];
            return (
              <div
                className="row-setting"
                data-testid={`row-setting-${entry.id}`}
                key={entry.id}
              >
                <div>
                  <strong>{label}</strong>
                  {!field.editable && (
                    <small>{field.readonlyReason?.[language]}</small>
                  )}
                  {field.fixed && (
                    <small>
                      {t(
                        "عنوان و دکمهٔ جزئیات همیشه باقی می‌مانند",
                        "The task title and details control stay available",
                      )}
                    </small>
                  )}
                </div>
                <select
                  aria-label={`${t("حالت", "Mode")} ${label}`}
                  value={entry.mode}
                  disabled={pending || unconfirmed}
                  onChange={(event) =>
                    mode(index, event.target.value as TaskRowFieldMode)
                  }
                >
                  <option value="hidden" disabled={field.fixed}>
                    {t("پنهان", "Hidden")}
                  </option>
                  <option value="display">{t("نمایش", "Display")}</option>
                  <option value="edit" disabled={!field.editable}>
                    {t("ویرایش در ردیف", "Edit inline")}
                  </option>
                </select>
                <div className="row-setting-order">
                  <Button
                    aria-label={`${t("بالابردن", "Move up")} ${label}`}
                    disabled={pending || unconfirmed || index <= 1}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={14} />
                  </Button>
                  <Button
                    aria-label={`${t("پایین‌بردن", "Move down")} ${label}`}
                    disabled={
                      pending ||
                      unconfirmed ||
                      index === 0 ||
                      index === draft.fields.length - 1
                    }
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={14} />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
        {error && (
          <p role="alert" className="row-editor-error">
            {error}
          </p>
        )}
        <div className="form-actions row-settings-actions">
          {unconfirmed ? (
            <Button
              disabled={pending}
              onClick={() => void persist(false, true)}
            >
              {t("بررسی دوبارهٔ همین ذخیره", "Recover this save")}
            </Button>
          ) : (
            <>
              <Button
                variant="primary"
                disabled={pending || conflict}
                onClick={() => void persist()}
              >
                {pending
                  ? t("در حال ذخیره…", "Saving…")
                  : t("ذخیرهٔ تنظیم ردیف‌ها", "Save row settings")}
              </Button>
              <Button
                disabled={pending || conflict}
                onClick={() => void persist(true)}
              >
                {target === "saved_view"
                  ? t("بازگردانی تنظیم همین نما", "Reset this saved view")
                  : t(
                      "بازگردانی پیش‌فرض این نوع نما",
                      "Reset this view default",
                    )}
              </Button>
              <Button
                disabled={pending}
                onClick={() =>
                  setDraft(pickerLayout(DEFAULT_TASK_ROW_LAYOUTS[view]))
                }
              >
                {t("پیش‌نمایش تنظیم اولیه", "Preview initial fields")}
              </Button>
            </>
          )}
          {conflict && (
            <Button disabled={pending} onClick={() => void reviewLatest()}>
              {t(
                "بررسی نسخهٔ تازه با حفظ پیش‌نویس",
                "Review latest and keep my draft",
              )}
            </Button>
          )}
        </div>
      </Modal>
    </>
  );
}
