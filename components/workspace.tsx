"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  BrainCircuit,
  Bell,
  CalendarDays,
  Check,
  ChevronDown,
  Command,
  FileText,
  Folder,
  LayoutDashboard,
  ListTodo,
  Menu,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Timer,
  TrendingUp,
  X,
} from "lucide-react";
import type { CommandName, MutationResult, PageDTO } from "@/shared/contracts";
import { IN_APP_AI_ENABLED } from "@/shared/product-features";
import { command, useQuery, ApiError } from "@/features/api";
import { LocaleContext, type Language, useLocale } from "@/features/locale";
import { CreateTask, TaskDetail, TaskExplorer } from "@/features/tasks";
import { CalendarView, WorkLog } from "@/features/calendar";
import {
  Assistant,
  Dashboard,
  Files,
  Projects,
  Reports,
  Settings,
} from "@/features/modules";
import { Button, Field, Modal, ToastPortal } from "./ui";

const navigation = [
  { path: "/", fa: "امروز", en: "Today", icon: LayoutDashboard },
  { path: "/tasks", fa: "کارهای من", en: "My tasks", icon: ListTodo },
  { path: "/projects", fa: "پروژه‌ها", en: "Projects", icon: Folder },
  { path: "/calendar", fa: "تقویم", en: "Calendar", icon: CalendarDays },
  { path: "/time", fa: "ثبت ساعت کار", en: "Work log", icon: Timer },
  {
    path: "/files",
    fa: "فایل‌ها و منابع",
    en: "Files & knowledge",
    icon: FileText,
  },
  {
    path: "/assistant",
    fa: "همراه هوشمند",
    en: "Assistant",
    icon: BrainCircuit,
  },
  {
    path: "/reports",
    fa: "گزارش و مرور",
    en: "Reports & review",
    icon: TrendingUp,
  },
  { path: "/settings", fa: "تنظیمات", en: "Settings", icon: Settings2 },
].filter((item) => IN_APP_AI_ENABLED || item.path !== "/assistant");

export default function Workspace() {
  const [localLanguage, setLanguage] = useState<Language | null>(null);
  const [localTheme, setTheme] = useState<string | null>(null);
  const preferences = useQuery<{
    settings: Record<string, unknown>;
    revision: number;
  }>("preferences_get");
  const savedLanguage = preferences.data?.settings.language;
  const language: Language =
    localLanguage ?? (savedLanguage === "en" ? "en" : "fa");
  const theme =
    localTheme ??
    (typeof preferences.data?.settings.theme === "string"
      ? preferences.data.settings.theme
      : "dark");
  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === "fa" ? "rtl" : "ltr";
  }, [language]);
  useEffect(() => {
    const settings = preferences.data?.settings ?? {};
    const accessibility = settings.accessibility as
      Record<string, unknown> | undefined;
    document.documentElement.dataset.density =
      settings.display_density === "compact" ? "compact" : "comfortable";
    document.documentElement.dataset.largeText = String(
      accessibility?.large_text === true,
    );
    document.documentElement.dataset.highContrast = String(
      accessibility?.high_contrast === true,
    );
    document.documentElement.dataset.reduceMotion = String(
      accessibility?.reduced_motion === true,
    );
  }, [preferences.data?.settings]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [theme]);
  return (
    <LocaleContext.Provider value={language}>
      <WorkspaceContent
        language={language}
        setLanguage={setLanguage}
        theme={theme}
        setTheme={setTheme}
        connected={!!preferences.data && !preferences.error}
      />
    </LocaleContext.Provider>
  );
}

function WorkspaceContent({
  language,
  setLanguage,
  theme,
  setTheme,
  connected,
}: {
  language: Language;
  setLanguage: (value: Language) => void;
  theme: string;
  setTheme: (value: string) => void;
  connected: boolean;
}) {
  const { t } = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const routeParams = useSearchParams();
  const [mobile, setMobile] = useState(false);
  const [capture, setCapture] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(() =>
    routeParams.get("task"),
  );
  const [toast, setToast] = useState("");
  const [toastError, setToastError] = useState(false);
  const [preview, setPreview] = useState<unknown>(null);
  const [commandOpen, setCommandOpen] = useState(false);
  const [globalSearch, setGlobalSearch] = useState("");
  const [blocked, setBlocked] = useState<{
    name: CommandName;
    input: Record<string, unknown>;
    revision?: number;
    message: string;
  } | null>(null);
  const [saving, setSaving] = useState(0);
  const [showNotifications, setShowNotifications] = useState(false);
  const notifications = useQuery<
    PageDTO<{
      notification_id: string;
      title: string;
      body: string;
      read_at: string | null;
      revision: number;
    }>
  >("notifications_list", { limit: 50 });
  const showToast = useCallback((text: string, error = false) => {
    setToast(text);
    setToastError(error);
  }, []);
  const action = useCallback(
    async (
      name: CommandName,
      input: Record<string, unknown>,
      revision?: number,
    ): Promise<MutationResult | null> => {
      setSaving((count) => count + 1);
      try {
        const result = await command(name, input, revision);
        showToast(t("تغییر ذخیره شد", "Change saved"));
        return result;
      } catch (error) {
        if (error instanceof ApiError && error.code === "TASK_BLOCKED")
          setBlocked({ name, input, revision, message: error.message });
        else
          showToast(
            error instanceof Error ? error.message : String(error),
            true,
          );
        return null;
      } finally {
        setSaving((count) => count - 1);
      }
    },
    [showToast, t],
  );
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 6500);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    const error = (event: Event) =>
      showToast(String((event as CustomEvent).detail), true);
    const inspect = (event: Event) => setPreview((event as CustomEvent).detail);
    const captureHandler = () => setCapture(true);
    window.addEventListener("lifeos:error", error);
    window.addEventListener("lifeos:preview", inspect);
    window.addEventListener("lifeos:capture", captureHandler);
    return () => {
      window.removeEventListener("lifeos:error", error);
      window.removeEventListener("lifeos:preview", inspect);
      window.removeEventListener("lifeos:capture", captureHandler);
    };
  }, [showToast]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const editing =
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
        target.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((value) => !value);
      } else if (!editing && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setCapture(true);
      } else if (!editing && event.key === "/") {
        event.preventDefault();
        setCommandOpen(true);
      } else if (event.key === "Escape") setMobile(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const current =
    navigation.find((item) => item.path === pathname) ??
    (pathname === "/assistant"
      ? { fa: "دستیار داخل برنامه", en: "In-app assistant" }
      : navigation[0]);
  return (
    <div className="workspace">
      <a href="#workspace-main" className="skip-link">
        {t("رفتن به محتوا", "Skip to content")}
      </a>
      {mobile && (
        <button
          className="mobile-backdrop"
          aria-label={t("بستن منو", "Close menu")}
          onClick={() => setMobile(false)}
        />
      )}
      <aside className={`sidebar ${mobile ? "mobile-open" : ""}`}>
        <Link href="/" className="brand">
          <span className="brand-symbol">
            r<span>o</span>
          </span>
          <div>
            <strong>Ramin Life OS</strong>
            <small>{t("فضا برای چیزهای مهم", "Room for what matters")}</small>
          </div>
        </Link>
        <button
          className="workspace-switcher"
          onClick={() => setCommandOpen(true)}
        >
          <span className="workspace-avatar">R</span>
          <div>
            <strong>{t("فضای شخصی", "Personal workspace")}</strong>
            <small>{t("خصوصی · فقط تو", "Private · only you")}</small>
          </div>
          <ChevronDown size={15} />
        </button>
        <button className="sidebar-search" onClick={() => setCommandOpen(true)}>
          <Search size={16} />
          {t("جست‌وجو در فضا", "Search workspace")}
          <kbd>⌘ K</kbd>
        </button>
        <div className="nav-label">{t("فضای من", "WORKSPACE")}</div>
        <nav aria-label={t("منوی اصلی", "Main navigation")}>
          {navigation.slice(0, 6).map((item) => (
            <Link
              href={item.path}
              key={item.path}
              className={pathname === item.path ? "active" : ""}
              onClick={() => setMobile(false)}
            >
              <item.icon size={18} />
              <span>{language === "fa" ? item.fa : item.en}</span>
              {pathname === item.path && <i className="nav-active-dot" />}
            </Link>
          ))}
        </nav>
        <div className="nav-label second">
          {t("بینش و ابزار", "INSIGHT & TOOLS")}
        </div>
        <nav>
          {navigation.slice(6).map((item) => (
            <Link
              href={item.path}
              key={item.path}
              className={pathname === item.path ? "active" : ""}
              onClick={() => setMobile(false)}
            >
              <item.icon size={18} />
              <span>{language === "fa" ? item.fa : item.en}</span>
              {item.path === "/assistant" && (
                <span className="ai-label">AI</span>
              )}
            </Link>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="private-note">
            <ShieldCheck size={17} />
            <div>
              <strong>
                {t("برای خودت، با اطمینان", "Your space, kept private")}
              </strong>
              <small>
                {t(
                  "داده‌ها تنها با مجوز حساب در دسترس‌اند.",
                  "Account permission protects your records.",
                )}
              </small>
            </div>
          </div>
          <Link href="/settings" className="owner-profile">
            <span className="owner-avatar">R</span>
            <div>
              <strong>Ramin</strong>
              <small>{t("تنظیمات حساب", "Account settings")}</small>
            </div>
            <Settings2 size={16} />
          </Link>
        </div>
      </aside>
      <div className="workspace-body">
        <header className="topbar">
          <div className="topbar-breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setMobile(true)}
              aria-label={t("بازکردن منو", "Open menu")}
            >
              <Menu size={20} />
            </button>
            <span className="breadcrumb-logo">◈</span>
            <span className="muted">{t("فضای من", "My workspace")}</span>
            <span className="breadcrumb-separator">/</span>
            <span>{language === "fa" ? current.fa : current.en}</span>
          </div>
          <div className="topbar-actions">
            <button
              className="icon-button notification-button"
              onClick={() => setShowNotifications(true)}
              aria-label={t("اعلان‌های داخل برنامه", "In-app notifications")}
            >
              <Bell size={17} />
              {notifications.data?.items.some((item) => !item.read_at) && <i />}
            </button>
            <span
              className={`save-status ${saving ? "pending" : ""}`}
              role="status"
            >
              {saving ? (
                <>
                  <span className="status-dot" />
                  {t("در حال ذخیره", "Saving")}
                </>
              ) : connected ? (
                <>
                  <Check size={12} />
                  {t("متصل به سرور", "Server connected")}
                </>
              ) : (
                <>{t("در حال بررسی اتصال", "Checking connection")}</>
              )}
            </span>
            <Button onClick={() => setCapture(true)} variant="quiet">
              <Plus size={16} />
              {t("ثبت سریع", "Quick capture")}
            </Button>
            <span className="topbar-avatar">R</span>
          </div>
        </header>
        <main id="workspace-main" className="main-content">
          {pathname === "/tasks" ? (
            <TaskExplorer
              key={routeParams.toString()}
              onOpen={setTaskId}
              action={action}
            />
          ) : pathname === "/projects" ? (
            <Projects onOpen={setTaskId} action={action} />
          ) : pathname === "/calendar" ? (
            <CalendarView action={action} onOpen={setTaskId} />
          ) : pathname === "/time" ? (
            <WorkLog action={action} />
          ) : pathname === "/files" ? (
            <Files action={action} onOpen={setTaskId} />
          ) : pathname === "/assistant" ? (
            <Assistant />
          ) : pathname === "/reports" ? (
            <Reports />
          ) : pathname === "/settings" ? (
            <Settings
              action={action}
              language={language}
              setLanguage={setLanguage}
              theme={theme}
              setTheme={setTheme}
            />
          ) : (
            <Dashboard action={action} onOpen={setTaskId} />
          )}
        </main>
        <footer className="workspace-footer">
          <span>Ramin Life OS</span>
          <span>
            {t("یک قدم روشن، در هر لحظه.", "One clear step at a time.")}
          </span>
          <span>Europe/Berlin</span>
        </footer>
      </div>
      <nav
        className="mobile-bottom-nav"
        aria-label={t("پیمایش موبایل", "Mobile navigation")}
      >
        {navigation.slice(0, 4).map((item) => (
          <Link
            key={item.path}
            href={item.path}
            className={pathname === item.path ? "active" : ""}
          >
            <item.icon size={19} />
            <span>{language === "fa" ? item.fa : item.en}</span>
          </Link>
        ))}
        <button onClick={() => setCapture(true)}>
          <Plus size={20} />
          <span>{t("ثبت", "Capture")}</span>
        </button>
      </nav>
      <CreateTask open={capture} setOpen={setCapture} action={action} />
      <Modal
        title={t("اعلان‌های داخل برنامه", "In-app notifications")}
        open={showNotifications}
        onOpenChange={setShowNotifications}
      >
        {notifications.data?.items.map((item) => (
          <article className="comment-card" key={item.notification_id}>
            <h3>{item.title}</h3>
            <p>{item.body}</p>
            {!item.read_at && (
              <Button
                onClick={() =>
                  void action(
                    "notification_mark_read",
                    { notification_id: item.notification_id },
                    item.revision,
                  )
                }
              >
                {t("خوانده شد", "Mark read")}
              </Button>
            )}
          </article>
        ))}
        {!notifications.data?.items.length && (
          <p className="muted small">
            {t(
              "اعلان ثبت‌شده‌ای وجود ندارد. تحویل یادآورها به اجرای واقعی زمان‌بند وابسته است.",
              "No notifications recorded. Reminder delivery depends on the actual scheduler.",
            )}
          </p>
        )}
      </Modal>
      <TaskDetail
        taskId={taskId}
        onClose={() => setTaskId(null)}
        onOpen={setTaskId}
        action={action}
      />
      <Modal
        title={t("جست‌وجو و فرمان‌ها", "Search & commands")}
        open={commandOpen}
        onOpenChange={setCommandOpen}
      >
        <form
          className="inline-form"
          onSubmit={(event) => {
            event.preventDefault();
            router.push(`/tasks?search=${encodeURIComponent(globalSearch)}`);
          }}
        >
          <Search size={17} />
          <input
            autoFocus
            value={globalSearch}
            onChange={(event) => setGlobalSearch(event.target.value)}
            placeholder={t("بین کارها جست‌وجو کن…", "Search tasks…")}
          />
          <Button type="submit">
            <ArrowUpRight size={16} />
          </Button>
        </form>
        <div className="command-links">
          {navigation.map((item) => (
            <Link
              key={item.path}
              href={item.path}
              onClick={() => setCommandOpen(false)}
            >
              <item.icon size={17} />
              {language === "fa" ? item.fa : item.en}
            </Link>
          ))}
          <button
            onClick={() => {
              setCommandOpen(false);
              setCapture(true);
            }}
          >
            <Plus size={17} />
            {t("کار تازه", "New task")}
            <kbd>N</kbd>
          </button>
        </div>
        <p className="muted small">
          <Command size={13} /> Ctrl/Cmd+K · /
        </p>
      </Modal>
      <Modal
        title={t("پیش‌نمایش اثر", "Impact preview")}
        open={preview !== null}
        onOpenChange={(value) => {
          if (!value) setPreview(null);
        }}
      >
        <pre className="preview-json">{JSON.stringify(preview, null, 2)}</pre>
      </Modal>
      <Modal
        title={t("پیش‌نیازهای ناتمام", "Unfinished prerequisites")}
        open={!!blocked}
        onOpenChange={(value) => {
          if (!value) setBlocked(null);
        }}
      >
        {blocked && (
          <>
            <p>{blocked.message}</p>
            <p className="warning">
              {t(
                "ادامه دادن با پیش‌نیاز ناتمام فقط با تصمیم صریح شما و ثبت دلیل ممکن است.",
                "Proceeding with unfinished prerequisites requires your explicit decision and a recorded reason.",
              )}
            </p>
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                const reason = new FormData(event.currentTarget).get("reason");
                const result = await action(
                  blocked.name,
                  { ...blocked.input, override_reason: reason },
                  blocked.revision,
                );
                if (result) setBlocked(null);
              }}
            >
              <Field label={t("دلیل تصمیم شما", "Your reason")}>
                <textarea required name="reason" minLength={3} />
              </Field>
              <Button variant="danger" type="submit">
                {t(
                  "تأیید استثنا و ثبت در تاریخچه",
                  "Confirm override and record in history",
                )}
              </Button>
            </form>
          </>
        )}
      </Modal>
      {toast && (
        <ToastPortal>
          <div
            className={`toast ${toastError ? "error-toast" : ""}`}
            role={toastError ? "alert" : "status"}
          >
            <span>{toast}</span>
            <button
              className="icon-button"
              onClick={() => setToast("")}
              aria-label={t("بستن", "Dismiss")}
            >
              <X size={15} />
            </button>
          </div>
        </ToastPortal>
      )}
    </div>
  );
}
