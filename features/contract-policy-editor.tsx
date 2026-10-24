"use client";

import { useRef, useState } from "react";
import { Plus, Save } from "lucide-react";
import type { PageDTO, WorkContractPolicyDTO } from "@/shared/contracts";
import { Button, Field, QueryState } from "@/components/ui";
import { ApiError, useQuery } from "./api";
import { useLocale } from "./locale";
import type { CalendarAction } from "./calendar-workspace";

type OverrideRow = { month: string; hours: string };
type PolicyFields = {
  effective_from: string;
  effective_to: string;
  weekly_contract_max: string;
  weekly_personal_alert: string;
  weekly_average_target: string;
  average_window_months: string;
  monthly_reference: string;
  monthly_overrides: OverrideRow[];
  allowed_weekdays: number[];
  local_window_start: string;
  local_window_end: string;
  timesheet_due_kind: "" | "calendar_day" | "business_day";
  timesheet_due_day: string;
  source_label: string;
};

const WEEKDAYS = [
  { value: 1, fa: "دوشنبه", en: "Monday" },
  { value: 2, fa: "سه‌شنبه", en: "Tuesday" },
  { value: 3, fa: "چهارشنبه", en: "Wednesday" },
  { value: 4, fa: "پنجشنبه", en: "Thursday" },
  { value: 5, fa: "جمعه", en: "Friday" },
  { value: 6, fa: "شنبه", en: "Saturday" },
  { value: 7, fa: "یکشنبه", en: "Sunday" },
] as const;

function duration(minutes: number | null) {
  if (minutes === null) return "";
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

function fieldsFromPolicy(
  policy: WorkContractPolicyDTO | undefined,
): PolicyFields {
  return {
    effective_from: policy?.effective_from ?? "",
    effective_to: policy?.effective_to ?? "",
    weekly_contract_max: duration(policy?.weekly_contract_max_minutes ?? null),
    weekly_personal_alert: duration(
      policy?.weekly_personal_alert_minutes ?? null,
    ),
    weekly_average_target: duration(
      policy?.weekly_average_target_minutes ?? null,
    ),
    average_window_months: String(policy?.average_window_months ?? ""),
    monthly_reference: duration(policy?.monthly_reference_minutes ?? null),
    monthly_overrides: Object.entries(policy?.monthly_overrides ?? {}).map(
      ([month, minutes]) => ({ month, hours: duration(minutes) }),
    ),
    allowed_weekdays: policy?.allowed_weekdays ?? [],
    local_window_start: policy?.local_window_start ?? "",
    local_window_end: policy?.local_window_end ?? "",
    timesheet_due_kind: policy?.timesheet_due?.kind ?? "",
    timesheet_due_day: String(policy?.timesheet_due?.day ?? ""),
    source_label: policy?.source_label ?? "",
  };
}

function parseDuration(value: string, name: string) {
  if (!value.trim()) return null;
  const match = /^(\d{1,4}):([0-5]\d)$/.exec(value.trim());
  if (!match) throw new Error(`${name}: HH:MM`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function policyInput(employer: string, fields: PolicyFields, id?: string) {
  if (!fields.effective_from)
    throw new Error(
      "تاریخ شروع اعتبار قاعده لازم است / Effective date required",
    );
  if (!fields.source_label.trim())
    throw new Error("منبع قاعده لازم است / Rule source required");
  if (Boolean(fields.local_window_start) !== Boolean(fields.local_window_end))
    throw new Error(
      "شروع و پایان بازهٔ ساعت باید با هم وارد شوند / Enter both window endpoints",
    );
  const overrides: Record<string, number> = {};
  for (const row of fields.monthly_overrides) {
    if (!row.month && !row.hours) continue;
    if (!row.month)
      throw new Error("ماه مرجع را وارد کن / Enter reference month");
    const minutes = parseDuration(row.hours, row.month);
    if (minutes === null)
      throw new Error("مقدار مرجع ماهانه را وارد کن / Enter monthly reference");
    if (Object.hasOwn(overrides, row.month))
      throw new Error("ماه تکراری است / Duplicate month");
    overrides[row.month] = minutes;
  }
  const day = Number(fields.timesheet_due_day);
  if (
    fields.timesheet_due_kind &&
    (!Number.isInteger(day) ||
      day < 1 ||
      day > (fields.timesheet_due_kind === "business_day" ? 23 : 31))
  )
    throw new Error("شمارهٔ روز مهلت معتبر نیست / Invalid due day number");
  return {
    ...(id ? { id } : {}),
    employer,
    effective_from: fields.effective_from,
    effective_to: fields.effective_to || null,
    weekly_contract_max_minutes: parseDuration(
      fields.weekly_contract_max,
      "Weekly contractual cap",
    ),
    weekly_personal_alert_minutes: parseDuration(
      fields.weekly_personal_alert,
      "Personal weekly alert",
    ),
    weekly_average_target_minutes: parseDuration(
      fields.weekly_average_target,
      "Average target",
    ),
    average_window_months: fields.average_window_months
      ? Number(fields.average_window_months)
      : null,
    monthly_reference_minutes: parseDuration(
      fields.monthly_reference,
      "Monthly reference",
    ),
    monthly_overrides: overrides,
    ...(fields.allowed_weekdays.length
      ? { allowed_weekdays: fields.allowed_weekdays }
      : {}),
    local_window_start: fields.local_window_start || null,
    local_window_end: fields.local_window_end || null,
    timesheet_due: fields.timesheet_due_kind
      ? { kind: fields.timesheet_due_kind, day }
      : null,
    source_label: fields.source_label.trim(),
  };
}

function PolicyForm({
  employer,
  policy,
  action,
  onSaved,
}: {
  employer: string;
  policy?: WorkContractPolicyDTO;
  action: CalendarAction;
  onSaved: (id: string) => void;
}) {
  const { t } = useLocale();
  const [fields, setFields] = useState(() => fieldsFromPolicy(policy));
  const [baseRevision, setBaseRevision] = useState(policy?.revision ?? 0);
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const editGeneration = useRef(0);
  const needsResolution = conflict || (policy?.revision ?? 0) > baseRevision;
  function change<K extends keyof PolicyFields>(
    key: K,
    value: PolicyFields[K],
  ) {
    editGeneration.current += 1;
    setFields((previous) => ({ ...previous, [key]: value }));
    setDirty(true);
    setStatus("");
  }
  async function save(againstLatest = false) {
    if (saving || (needsResolution && !againstLatest)) return;
    setSaving(true);
    setError("");
    setStatus("");
    const submittedGeneration = editGeneration.current;
    try {
      const input = policyInput(employer, fields, policy?.id);
      const expected = againstLatest ? (policy?.revision ?? 0) : baseRevision;
      const result = await action(
        "time_contract_policy_upsert",
        input,
        expected,
      );
      if (!result) {
        setStatus(
          t(
            "تأیید ذخیره دریافت نشد؛ متن حفظ شد",
            "Save not acknowledged; edits retained",
          ),
        );
        return;
      }
      setBaseRevision(result.version ?? expected + 1);
      const hasLaterEdits = editGeneration.current !== submittedGeneration;
      setDirty(hasLaterEdits);
      setConflict(false);
      setStatus(
        hasLaterEdits
          ? t(
              "نسخهٔ ارسالی ذخیره شد؛ تغییرات تازه هنوز ذخیره نشده‌اند.",
              "Submitted version saved; newer edits remain unsaved.",
            )
          : t("قاعده ذخیره شد", "Rule saved"),
      );
      onSaved(result.entity_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      if (cause instanceof ApiError && cause.code === "REVISION_CONFLICT") {
        setConflict(true);
        onSaved(policy?.id ?? "");
      }
    } finally {
      setSaving(false);
    }
  }
  return (
    <form
      className="contract-policy-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="small muted">
        {policy
          ? t("ویرایش نسخهٔ ثبت‌شده", "Edit recorded version")
          : t(
              "قاعدهٔ تازه؛ هیچ مقدار قراردادی از پیش فرض نشده است.",
              "New rule; no contract values are assumed.",
            )}
      </p>
      <div className="contract-policy-fields">
        <Field label={t("اعتبار از", "Effective from")}>
          <input
            required
            type="date"
            value={fields.effective_from}
            onChange={(event) => change("effective_from", event.target.value)}
          />
        </Field>
        <Field label={t("اعتبار تا (اختیاری)", "Effective to (optional)")}>
          <input
            type="date"
            value={fields.effective_to}
            onChange={(event) => change("effective_to", event.target.value)}
          />
        </Field>
        <Field
          label={t(
            "سقف قراردادی هفتگی (ساعت:دقیقه)",
            "Contractual weekly cap (h:mm)",
          )}
        >
          <input
            dir="ltr"
            inputMode="numeric"
            placeholder="hh:mm"
            value={fields.weekly_contract_max}
            onChange={(event) =>
              change("weekly_contract_max", event.target.value)
            }
          />
        </Field>
        <Field
          label={t(
            "هشدار شخصی هفتگی (ساعت:دقیقه)",
            "Personal weekly alert (h:mm)",
          )}
        >
          <input
            dir="ltr"
            inputMode="numeric"
            placeholder="hh:mm"
            value={fields.weekly_personal_alert}
            onChange={(event) =>
              change("weekly_personal_alert", event.target.value)
            }
          />
        </Field>
        <Field
          label={t(
            "هدف میانگین هفتگی؛ اطلاعاتی",
            "Weekly average target; informational",
          )}
        >
          <input
            dir="ltr"
            inputMode="numeric"
            placeholder="hh:mm"
            value={fields.weekly_average_target}
            onChange={(event) =>
              change("weekly_average_target", event.target.value)
            }
          />
        </Field>
        <Field label={t("دورهٔ میانگین (ماه)", "Averaging period (months)")}>
          <input
            type="number"
            min={1}
            max={12}
            value={fields.average_window_months}
            onChange={(event) =>
              change("average_window_months", event.target.value)
            }
          />
        </Field>
        <Field
          label={t("مرجع ماهانه؛ اطلاعاتی", "Monthly reference; informational")}
        >
          <input
            dir="ltr"
            inputMode="numeric"
            placeholder="hh:mm"
            value={fields.monthly_reference}
            onChange={(event) =>
              change("monthly_reference", event.target.value)
            }
          />
        </Field>
        <Field label={t("شروع بازهٔ مجاز روز", "Local work window start")}>
          <input
            type="time"
            value={fields.local_window_start}
            onChange={(event) =>
              change("local_window_start", event.target.value)
            }
          />
        </Field>
        <Field label={t("پایان بازهٔ مجاز روز", "Local work window end")}>
          <input
            type="time"
            value={fields.local_window_end}
            onChange={(event) => change("local_window_end", event.target.value)}
          />
        </Field>
        <Field label={t("نوع مهلت تایم‌شیت", "Timesheet due rule")}>
          <select
            value={fields.timesheet_due_kind}
            onChange={(event) =>
              change(
                "timesheet_due_kind",
                event.target.value as PolicyFields["timesheet_due_kind"],
              )
            }
          >
            <option value="">{t("ثبت نشده", "Not recorded")}</option>
            <option value="calendar_day">
              {t("روز تقویمی ماه بعد", "Calendar day of next month")}
            </option>
            <option value="business_day">
              {t("روز کاری ماه بعد", "Business day of next month")}
            </option>
          </select>
        </Field>
        {fields.timesheet_due_kind && (
          <Field label={t("شمارهٔ روز مهلت", "Due day number")}>
            <input
              type="number"
              min={1}
              max={fields.timesheet_due_kind === "business_day" ? 23 : 31}
              required
              value={fields.timesheet_due_day}
              onChange={(event) =>
                change("timesheet_due_day", event.target.value)
              }
            />
          </Field>
        )}
      </div>
      <fieldset className="contract-weekday-fields">
        <legend>
          {t(
            "روزهای مجاز ثبت‌شده؛ خالی یعنی نامشخص",
            "Recorded allowed days; empty means unknown",
          )}
        </legend>
        {WEEKDAYS.map((day) => (
          <label key={day.value}>
            <input
              type="checkbox"
              checked={fields.allowed_weekdays.includes(day.value)}
              onChange={(event) =>
                change(
                  "allowed_weekdays",
                  event.target.checked
                    ? [...fields.allowed_weekdays, day.value].sort()
                    : fields.allowed_weekdays.filter(
                        (value) => value !== day.value,
                      ),
                )
              }
            />
            {t(day.fa, day.en)}
          </label>
        ))}
      </fieldset>
      <div className="contract-overrides">
        <strong>
          {t("استثناهای مرجع ماهانه", "Monthly reference overrides")}
        </strong>
        {fields.monthly_overrides.map((row, index) => (
          <div className="contract-override-row" key={index}>
            <Field label={t("ماه", "Month")}>
              <input
                type="month"
                value={row.month}
                onChange={(event) => {
                  const next = [...fields.monthly_overrides];
                  next[index] = { ...row, month: event.target.value };
                  change("monthly_overrides", next);
                }}
              />
            </Field>
            <Field label={t("ساعت:دقیقه", "Hours:minutes")}>
              <input
                dir="ltr"
                inputMode="numeric"
                placeholder="hh:mm"
                value={row.hours}
                onChange={(event) => {
                  const next = [...fields.monthly_overrides];
                  next[index] = { ...row, hours: event.target.value };
                  change("monthly_overrides", next);
                }}
              />
            </Field>
            <Button
              type="button"
              onClick={() =>
                change(
                  "monthly_overrides",
                  fields.monthly_overrides.filter((_, i) => i !== index),
                )
              }
            >
              {t("حذف ردیف", "Remove row")}
            </Button>
          </div>
        ))}
        <Button
          type="button"
          onClick={() =>
            change("monthly_overrides", [
              ...fields.monthly_overrides,
              { month: "", hours: "" },
            ])
          }
        >
          <Plus size={15} /> {t("ماه دیگر", "Add month")}
        </Button>
      </div>
      <Field
        label={t("منبع قاعده یا بند قرارداد", "Rule source or contract clause")}
      >
        <textarea
          required
          rows={2}
          maxLength={200}
          value={fields.source_label}
          onChange={(event) => change("source_label", event.target.value)}
        />
      </Field>
      <p className="small muted">
        {t(
          "مرجع ماهانه، میانگین و مهلت تایم‌شیت به‌تنهایی حکم تخلف نیستند؛ ثبت یا امضای تایم‌شیت باید جداگانه بررسی شود.",
          "Monthly references, averages and due dates do not by themselves establish a breach; timesheet submission and signatures need separate review.",
        )}
      </p>
      {needsResolution && (
        <div className="warning" role="alert">
          <span>
            {t(
              "قاعده در جای دیگری تغییر کرده است. تغییرات این فرم حفظ شده‌اند.",
              "Rule changed elsewhere. Your edits are retained.",
            )}
          </span>
          <Button
            type="button"
            onClick={() => {
              setFields(fieldsFromPolicy(policy));
              setBaseRevision(policy?.revision ?? 0);
              setDirty(false);
              setConflict(false);
              setError("");
            }}
          >
            {t("استفاده از نسخهٔ سرور", "Use server version")}
          </Button>
          <Button type="button" onClick={() => void save(true)}>
            {t("ذخیره روی نسخهٔ تازه", "Save against latest")}
          </Button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {dirty && (
        <p className="small contract-dirty" role="status">
          {t("تغییرات هنوز ذخیره نشده‌اند", "Changes are not saved yet")}
        </p>
      )}
      {status && (
        <p className="small muted" role="status">
          {status}
        </p>
      )}
      <Button
        type="submit"
        variant="primary"
        disabled={saving || needsResolution}
      >
        <Save size={15} />{" "}
        {saving
          ? t("در حال ذخیره…", "Saving…")
          : t("ذخیرهٔ قاعده", "Save rule")}
      </Button>
    </form>
  );
}

export function ContractPolicyEditor({
  employer,
  month,
  action,
  onSaved,
}: {
  employer: string;
  month: string;
  action: CalendarAction;
  onSaved: () => void;
}) {
  const { t } = useLocale();
  const policies = useQuery<PageDTO<WorkContractPolicyDTO>>(
    "time_contract_policy_list",
  );
  const [selectedId, setSelectedId] = useState("");
  const [newFormVersion, setNewFormVersion] = useState(0);
  const options = (policies.data?.items ?? [])
    .filter((policy) => policy.employer === employer)
    .sort((a, b) => b.effective_from.localeCompare(a.effective_from));
  const activeId =
    selectedId === "new"
      ? "new"
      : options.some((policy) => policy.id === selectedId)
        ? selectedId
        : (options[0]?.id ?? "new");
  return (
    <details className="contract-policy-editor">
      <summary>
        {t("تنظیم قواعد خصوصی قرارداد", "Edit private contract rules")} ·{" "}
        {employer}
      </summary>
      <p className="small muted">
        {t(
          "فقط قواعدی را ثبت کن که از قرارداد یا منبع قابل‌استناد می‌دانی. وضعیت‌ها از همین قواعد و ساعت‌های ذخیره‌شده محاسبه می‌شوند.",
          "Record only rules supported by a contract or reliable source. Status is calculated from those rules and saved hours.",
        )}
      </p>
      <QueryState {...policies} retry={policies.refresh} />
      {!policies.error && policies.data && (
        <>
          <div className="contract-policy-select">
            <Field label={t("نسخهٔ قاعده", "Rule version")}>
              <select
                value={activeId}
                onChange={(event) => setSelectedId(event.target.value)}
              >
                {options.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.employer} · {item.effective_from} –{" "}
                    {item.effective_to ?? "…"}
                  </option>
                ))}
                <option value="new">{t("قاعدهٔ تازه", "New rule")}</option>
              </select>
            </Field>
            <span className="small muted">
              {t("ماه نمایش", "Viewing month")}: <b dir="ltr">{month}</b>
            </span>
          </div>
          {options.map((item) => (
            <div key={item.id} hidden={activeId !== item.id}>
              <PolicyForm
                employer={employer}
                policy={item}
                action={action}
                onSaved={() => {
                  policies.refresh();
                  onSaved();
                }}
              />
            </div>
          ))}
          <div hidden={activeId !== "new"}>
            <PolicyForm
              key={`${employer}:new:${newFormVersion}`}
              employer={employer}
              action={action}
              onSaved={(savedId) => {
                policies.refresh();
                onSaved();
                if (savedId) {
                  setSelectedId(savedId);
                  setNewFormVersion((version) => version + 1);
                }
              }}
            />
          </div>
        </>
      )}
    </details>
  );
}
