"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUpRight, Fingerprint, LockKeyhole } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { Button, Field } from "@/components/ui";

export default function Login() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <div className="login-decoration" />
      <section className="login-card">
        <div className="brand">
          <span className="brand-symbol">
            r<span>o</span>
          </span>
          <div>
            <strong>Ramin Life OS</strong>
            <small>فضا برای چیزهای مهم</small>
          </div>
        </div>
        <span className="private-label">
          <LockKeyhole size={14} />
          فضای شخصی و خصوصی
        </span>
        <h1>خوش آمدی، رامین.</h1>
        <p>کارها، پروژه‌ها و زمانت، همه در یک فضای آرام.</p>
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            const data = new FormData(event.currentTarget);
            try {
              const result = await authClient.signIn.email({
                email: String(data.get("email")),
                password: String(data.get("password")),
                callbackURL: "/",
              });
              if (result.error)
                setError(result.error.message ?? "ورود ناموفق بود.");
              else {
                const returned = result.data as { url?: string } | null;
                window.location.assign(returned?.url ?? "/");
              }
            } catch {
              setError("ارتباط با سرویس ورود برقرار نشد. دوباره تلاش کن.");
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="ایمیل / Email">
            <input
              name="email"
              required
              type="email"
              dir="ltr"
              autoComplete="username"
            />
          </Field>
          <Field label="رمز عبور / Password">
            <input
              name="password"
              required
              type="password"
              dir="ltr"
              autoComplete="current-password"
            />
          </Field>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "در حال ورود…" : "ورود به فضای من"}
            <ArrowUpRight size={17} />
          </Button>
        </form>
        <div className="login-divider">
          <span>یا با Passkey دستگاه</span>
        </div>
        <Button
          className="full-width"
          onClick={async () => {
            setError("");
            try {
              const result = await authClient.signIn.passkey();
              if (result.error)
                setError(result.error.message ?? "Passkey پیدا نشد.");
              else {
                router.replace("/");
                router.refresh();
              }
            } catch {
              setError("دستگاه یا مرورگر از این Passkey پشتیبانی نمی‌کند.");
            }
          }}
        >
          <Fingerprint size={19} />
          ورود با Passkey
        </Button>
        <p className="login-note">
          این فضا فقط برای صاحب حساب است. ثبت‌نام عمومی فعال نیست.
        </p>
      </section>
    </main>
  );
}
