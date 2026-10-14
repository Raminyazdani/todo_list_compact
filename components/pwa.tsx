"use client";

import { createContext, useContext, useEffect, useState } from "react";

interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}
const InstallContext = createContext<{
  installed: boolean;
  prompt: InstallPrompt | null;
  requestInstall: () => Promise<void>;
}>({ installed: false, prompt: null, requestInstall: async () => {} });

export function PwaProvider({ children }: { children: React.ReactNode }) {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    const standalone = window.matchMedia("(display-mode: standalone)");
    const update = () => setInstalled(standalone.matches);
    update();
    standalone.addEventListener("change", update);
    const available = (event: Event) => {
      event.preventDefault();
      setPrompt(event as InstallPrompt);
    };
    const complete = () => {
      setInstalled(true);
      setPrompt(null);
    };
    window.addEventListener("beforeinstallprompt", available);
    window.addEventListener("appinstalled", complete);
    // This worker has no fetch handler or cache: owner data requires a live
    // authenticated server request, including when launched as an installed app.
    if ("serviceWorker" in navigator && window.isSecureContext) {
      void navigator.serviceWorker
        .register("/life-os-worker.js", {
          scope: "/",
          updateViaCache: "none",
        })
        .catch(() => {
          // Installation remains a browser capability; no data requests depend
          // on registration and no private content is cached as a fallback.
        });
    }
    return () => {
      standalone.removeEventListener("change", update);
      window.removeEventListener("beforeinstallprompt", available);
      window.removeEventListener("appinstalled", complete);
    };
  }, []);
  async function requestInstall() {
    if (!prompt) return;
    const current = prompt;
    setPrompt(null);
    try {
      await current.prompt();
      await current.userChoice;
    } catch {
      // A dismissed or unavailable native prompt is not an application error.
    }
  }
  return (
    <InstallContext.Provider value={{ installed, prompt, requestInstall }}>
      {children}
    </InstallContext.Provider>
  );
}

export function InstallAppCard({ fa }: { fa: boolean }) {
  const { installed, prompt, requestInstall } = useContext(InstallContext);
  return (
    <section className="card" aria-label={fa ? "نصب برنامه" : "Install app"}>
      <h3>{fa ? "نصب برنامه" : "Install app"}</h3>
      <p>
        {installed
          ? fa
            ? "برنامه در پنجرهٔ مستقل باز شده است."
            : "The app is running in its own window."
          : fa
            ? "برای دسترسی سریع، برنامه را از گزینهٔ نصب یا افزودن به صفحهٔ اصلی مرورگر اضافه کنید. در مرورگرهای پشتیبان، دکمهٔ نصب اینجا فعال می‌شود."
            : "Use your browser’s install or Add to Home Screen option for quick access. The install button appears when supported by your browser."}
      </p>
      <p className="muted">
        {fa
          ? "خواندن و تغییر داده‌ها به اینترنت و ورود مالک نیاز دارد؛ نسخهٔ آفلاین از اطلاعات خصوصی ذخیره نمی‌شود."
          : "Reading and changing data requires an internet connection and owner sign-in. Private data is not stored in an offline cache."}
      </p>
      {prompt && !installed ? (
        <button type="button" onClick={() => void requestInstall()}>
          {fa ? "نصب Ramin Life OS" : "Install Ramin Life OS"}
        </button>
      ) : null}
    </section>
  );
}
