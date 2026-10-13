"use client";
import { createContext, useCallback, useContext } from "react";
export type Language = "fa" | "en";
export const LocaleContext = createContext<Language>("fa");
export function useLocale() {
  const language = useContext(LocaleContext);
  const t = useCallback(
    (fa: string, en: string) => (language === "fa" ? fa : en),
    [language],
  );
  return { language, t };
}
export function useLabels() {
  const { t } = useLocale();
  return {
    statuses: {
      Inbox: t("ورودی", "Inbox"),
      Next: t("بعدی", "Next"),
      "In progress": t("در حال انجام", "In progress"),
      Waiting: t("منتظر", "Waiting"),
      Done: t("انجام شده", "Done"),
      Cancelled: t("لغو شده", "Cancelled"),
    },
    readiness: {
      ready: t("آمادهٔ شروع", "Ready"),
      blocked: t("پیش‌نیاز ناتمام", "Blocked"),
      scheduled: t("زمان‌بندی شده", "Scheduled"),
      closed: t("بسته", "Closed"),
    },
    priority: {
      Low: t("کم", "Low"),
      Normal: t("عادی", "Normal"),
      High: t("بالا", "High"),
      Urgent: t("فوری", "Urgent"),
    },
  };
}
