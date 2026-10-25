import type { Metadata } from "next";
import Link from "next/link";
import { PublicInfoLayout } from "@/components/public-info-layout";

export const metadata: Metadata = {
  title: "دربارهٔ Ramin Life OS | About",
  description:
    "Ramin Life OS is a private workspace for tasks, projects, calendar events, and work hours.",
  robots: { index: true, follow: true },
};

export default function AboutPage() {
  return (
    <PublicInfoLayout
      title="برنامه‌ریزی زندگی، در یک فضای آرام"
      eyebrow="دربارهٔ برنامه · About"
    >
      <p className="public-info-lead">
        Life OS فضای شخصی صاحب حساب برای مدیریت کارها، پروژه‌ها، تقویم و ساعات
        کار است. این بخش‌ها در یک نمای هماهنگ کنار هم قرار می‌گیرند تا برنامهٔ
        روز و پیشرفت کارها روشن بماند.
      </p>
      <p lang="en" dir="ltr">
        Ramin Life OS is a private planning workspace for its account owner. It
        brings tasks, projects, calendar events, and work-hour entries together
        in one place.
      </p>
      <div className="public-info-features">
        <section>
          <h2>کارها و پروژه‌ها</h2>
          <p>ثبت، مرتب‌سازی و پیگیری کارهای شخصی و پروژه‌ها.</p>
        </section>
        <section>
          <h2>تقویم</h2>
          <p>
            نمایش رویدادها و اتصال اختیاری Google Calendar برای همگام‌سازی.
            رویدادهای شخصیِ مجاز را می‌توان از برنامه ویرایش کرد.
          </p>
        </section>
        <section>
          <h2>ساعات کار</h2>
          <p>ثبت بازه‌های کار و بررسی مجموع ساعت‌ها در کنار برنامهٔ تقویم.</p>
        </section>
      </div>
      <p lang="en" dir="ltr">
        Google Calendar connection is optional. With your permission, Life OS
        displays calendar events and can sync eligible personal events on
        calendars you own. The workspace requires owner sign-in; public sign-up
        is disabled.
      </p>
      <div className="public-info-actions">
        <Link className="public-info-primary" href="/login">
          ورود به Life OS
        </Link>
        <Link href="/privacy">روش استفاده از داده‌ها</Link>
      </div>
    </PublicInfoLayout>
  );
}
