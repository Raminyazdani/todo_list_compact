"use client";

import { useEffect, useState } from "react";
import { Button, Empty, Modal, SectionHeading } from "@/components/ui";
import { useLocale } from "./locale";

interface Grant {
  client_id: string;
  name: string;
  revoked: boolean;
  granted_scopes: string[];
  granted_at: string | null;
  updated_at: string | null;
}

export function Connections() {
  const { t } = useLocale();
  const [items, setItems] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  function refresh() {
    setLoading(true);
    setVersion((value) => value + 1);
  }
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch("/api/v1/connections", {
          credentials: "same-origin",
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw new Error(
            body.error?.message ??
              `Connection request failed (${response.status})`,
          );
        setItems(body.data.items);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => controller.abort();
  }, [version]);
  async function revoke() {
    if (!selected || busy) return;
    setBusy(true);
    try {
      const response = await fetch("/api/v1/connections", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: selected.client_id,
          explicit_confirmation: true,
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(
          body.error?.message ?? `Revocation failed (${response.status})`,
        );
      setSelected(null);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel">
      <SectionHeading
        title={t("مجوزهای ابزارهای متصل", "Connected tool grants")}
        action={
          <Button onClick={() => void refresh()} disabled={loading}>
            {t("تازه‌سازی اتصال‌ها", "Refresh connections")}
          </Button>
        }
      />
      <p className="muted small">
        {t(
          "نام ابزار، محدودهٔ دسترسی و زمان مجوز نمایش داده می‌شود. لغو مجوز دسترسی همان ابزار را فوراً متوقف می‌کند؛ هیچ توکنی نمایش داده نمی‌شود.",
          "Review each tool's name, scopes and grant time. Revocation immediately stops that tool's access. Tokens are never displayed.",
        )}
      </p>
      {loading && (
        <p role="status">
          {t("در حال خواندن اتصال‌ها…", "Loading connections…")}
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!loading && !error && !items.length && (
        <Empty
          title={t("ابزار مجاز متصلی ثبت نشده", "No authorized tools recorded")}
        />
      )}
      {items.map((item) => (
        <div
          className="grant-row"
          key={item.client_id}
          data-client-id={item.client_id}
        >
          <div>
            <strong>{item.name || t("ابزار بدون نام", "Unnamed tool")}</strong>
            <p className="small muted">{item.granted_scopes.join(" · ")}</p>
            <time className="small muted">
              {item.granted_at ?? item.updated_at ?? "—"}
            </time>
          </div>
          <span className="chip">
            {item.revoked ? t("لغوشده", "Revoked") : t("فعال", "Active")}
          </span>
          <Button disabled={item.revoked} onClick={() => setSelected(item)}>
            {t("لغو دسترسی", "Revoke access")}
          </Button>
        </div>
      ))}
      {items.length >= 200 && (
        <p className="warning">
          {t(
            "۲۰۰ اتصال نخست نمایش داده می‌شود.",
            "The first 200 connections are displayed.",
          )}
        </p>
      )}
      <Modal
        title={t("لغو دسترسی ابزار", "Revoke tool access")}
        open={!!selected}
        onOpenChange={(open) => {
          if (!open && !busy) setSelected(null);
        }}
      >
        <p>{selected?.name}</p>
        <p>
          {t(
            "دسترسی این ابزار با تأیید شما فوراً قطع می‌شود. برای اتصال دوباره باید مجوز تازه بدهی.",
            "Confirmation immediately ends this tool's access. Reconnecting requires a new authorization.",
          )}
        </p>
        <label className="check-label">
          <input type="checkbox" required form="revoke-grant" />
          {t(
            "لغو دسترسی همین ابزار را تأیید می‌کنم",
            "I confirm revocation of this tool",
          )}
        </label>
        <form
          id="revoke-grant"
          onSubmit={(event) => {
            event.preventDefault();
            void revoke();
          }}
        >
          <Button type="submit" variant="primary" disabled={busy}>
            {t("تأیید لغو دسترسی", "Confirm revocation")}
          </Button>
        </form>
      </Modal>
    </section>
  );
}
