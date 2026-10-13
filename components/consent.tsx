"use client";
import { useState } from "react";
import { ShieldCheck } from "lucide-react";
import { authClient } from "@/server/auth/client";
import { Button } from "./ui";

export default function Consent({
  details,
}: {
  details: {
    client_id: string | null;
    scopes: string[];
    resource: string | null;
  };
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function decide(accept: boolean) {
    setBusy(true);
    setError("");
    try {
      const result = await authClient.oauth2.consent({ accept });
      if (result.error)
        setError(result.error.message ?? "Authorization failed");
      else if (result.data?.url) window.location.assign(result.data.url);
    } catch {
      setError("ارتباط برقرار نشد. دوباره تلاش کن.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="login-page">
      <section className="login-card">
        <ShieldCheck size={35} className="accent" />
        <h1>اجازهٔ اتصال ابزار</h1>
        <p>
          این برنامه می‌خواهد به فضای خصوصی شما دسترسی داشته باشد. مجوزها را
          بررسی کن؛ فقط در صورت شناخت برنامه تأیید کن.
        </p>
        <div className="endpoint-box">{details.client_id}</div>
        <ul>
          {details.scopes.map((scope) => (
            <li key={scope} className="mono">
              {scope}
            </li>
          ))}
        </ul>
        {details.resource && <p className="mono">{details.resource}</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="form-actions">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void decide(true)}
          >
            تأیید اتصال / Allow
          </Button>
          <Button disabled={busy} onClick={() => void decide(false)}>
            رد درخواست / Deny
          </Button>
        </div>
      </section>
    </main>
  );
}
