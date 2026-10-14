"use client";
import { useState } from "react";
import type { CommandName, MutationResult } from "@/shared/contracts";
import { useLocale } from "./locale";
import { Button, Field, SectionHeading } from "@/components/ui";
type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;
interface Draft {
  baseRevision: number;
  display_density: string;
  large_text: boolean;
  high_contrast: boolean;
  reduced_motion: boolean;
  retention_days: number | string;
}
export function ExperienceSettings({
  settings,
  revision,
  pending = false,
  action,
}: {
  settings: Record<string, unknown>;
  revision?: number;
  pending?: boolean;
  action: Action;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<Draft | null>(null);
  const accessibility = settings.accessibility as
    Record<string, unknown> | undefined;
  const baseline: Draft = {
    baseRevision: revision ?? 0,
    display_density:
      settings.display_density === "compact" ? "compact" : "comfortable",
    large_text: accessibility?.large_text === true,
    high_contrast: accessibility?.high_contrast === true,
    reduced_motion: accessibility?.reduced_motion === true,
    retention_days:
      typeof settings.retention_days === "number" ? settings.retention_days : 0,
  };
  const values = draft ?? baseline;
  const disabled = pending || revision === undefined;
  function change(partial: Partial<Draft>) {
    setDraft({ ...values, ...partial });
  }
  return (
    <section className="panel">
      <SectionHeading
        title={t(
          "خوانایی، دسترس‌پذیری و نگهداری",
          "Readability, accessibility & retention",
        )}
      />
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled) return;
          const result = await action(
            "preferences_update",
            {
              settings: {
                display_density: values.display_density,
                accessibility: {
                  large_text: values.large_text,
                  high_contrast: values.high_contrast,
                  reduced_motion: values.reduced_motion,
                },
                retention_days: Number(values.retention_days),
              },
            },
            values.baseRevision,
          );
          if (result) setDraft(null);
        }}
      >
        <Field label={t("تراکم نمایش", "Display density")}>
          <select
            name="density"
            disabled={disabled}
            value={values.display_density}
            onChange={(event) =>
              change({ display_density: event.target.value })
            }
          >
            <option value="comfortable">{t("راحت", "Comfortable")}</option>
            <option value="compact">{t("فشرده", "Compact")}</option>
          </select>
        </Field>
        <label className="check-label">
          <input
            type="checkbox"
            name="large_text"
            disabled={disabled}
            checked={values.large_text}
            onChange={(event) => change({ large_text: event.target.checked })}
          />
          {t("نوشته‌های کوچک درشت‌تر", "Larger small text")}
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            name="high_contrast"
            disabled={disabled}
            checked={values.high_contrast}
            onChange={(event) =>
              change({ high_contrast: event.target.checked })
            }
          />
          {t("کنتراست بیشتر", "Higher contrast")}
        </label>
        <label className="check-label">
          <input
            type="checkbox"
            name="reduce_motion"
            disabled={disabled}
            checked={values.reduced_motion}
            onChange={(event) =>
              change({ reduced_motion: event.target.checked })
            }
          />
          {t("کاهش حرکت‌های رابط", "Reduce interface motion")}
        </label>
        <Field
          label={t(
            "فاصلهٔ پیشنهادی بازبینی بایگانی (روز)",
            "Suggested archive review interval (days)",
          )}
        >
          <input
            type="number"
            name="retention_review_days"
            disabled={disabled}
            min="0"
            max="36500"
            step="1"
            required
            value={values.retention_days}
            onChange={(event) => change({ retention_days: event.target.value })}
          />
        </Field>
        <p className="muted small">
          {t(
            "صفر یعنی نگهداری بدون موعد بازبینی. این ترجیح برای تصمیم صاحب حساب ذخیره می‌شود؛ بایگانی‌ها و نسخه‌ها حفظ می‌شوند و حذف خودکار فعال نیست.",
            "Zero keeps records without a review deadline. This preference is stored for owner review; archived records and versions remain retained with automatic deletion disabled.",
          )}
        </p>
        {draft && revision !== draft.baseRevision && (
          <p className="warning">
            {t(
              "تنظیمات در جای دیگری تغییر کرده است. پیش‌نویس شما حفظ شده؛ برای بازبینی دادهٔ تازه آن را کنار بگذار.",
              "Settings changed elsewhere. Your draft is retained; discard it to review the latest settings.",
            )}
          </p>
        )}
        <div className="form-actions">
          <Button disabled={disabled} type="submit">
            {t(
              "ثبت تنظیمات خوانایی و نگهداری",
              "Save accessibility & retention settings",
            )}
          </Button>
          {draft && (
            <Button type="button" onClick={() => setDraft(null)}>
              {t(
                "کنارگذاشتن پیش‌نویس و خواندن تنظیمات تازه",
                "Discard draft and read latest settings",
              )}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}
