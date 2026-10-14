"use client";

import { useState } from "react";
import { authClient } from "@/server/auth/client";
import { useLocale } from "./locale";
import { Button, Field, SectionHeading } from "@/components/ui";

export function PasswordSettings() {
  const { t } = useLocale();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section className="panel">
      <SectionHeading
        title={t("تغییر رمز صاحب حساب", "Change owner password")}
      />
      <form
        className="form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          const form = event.currentTarget;
          const data = new FormData(form);
          setMessage("");
          if (data.get("new_password") !== data.get("confirm_password")) {
            setMessage(
              t(
                "تکرار رمز با رمز تازه یکسان نیست",
                "Password confirmation does not match",
              ),
            );
            return;
          }
          setBusy(true);
          try {
            const result = await authClient.changePassword({
              currentPassword: String(data.get("current_password")),
              newPassword: String(data.get("new_password")),
              revokeOtherSessions: true,
            });
            if (result.error)
              throw new Error(
                result.error.message ??
                  t("تغییر رمز انجام نشد", "Password change failed"),
              );
            form.reset();
            setMessage(
              t(
                "رمز تغییر کرد و نشست‌های دیگر لغو شدند.",
                "Password changed; other sessions were revoked.",
              ),
            );
          } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label={t("رمز فعلی", "Current password")}>
          <input
            type="password"
            name="current_password"
            autoComplete="current-password"
            required
          />
        </Field>
        <Field label={t("رمز تازه", "New password")}>
          <input
            type="password"
            name="new_password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
        </Field>
        <Field label={t("تکرار رمز تازه", "Confirm new password")}>
          <input
            type="password"
            name="confirm_password"
            autoComplete="new-password"
            minLength={8}
            maxLength={128}
            required
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy
            ? t("در حال تغییر…", "Changing…")
            : t(
                "ثبت رمز تازه و لغو نشست‌های دیگر",
                "Change password and revoke other sessions",
              )}
        </Button>
        {message && (
          <p role="status" className="small">
            {message}
          </p>
        )}
      </form>
    </section>
  );
}
