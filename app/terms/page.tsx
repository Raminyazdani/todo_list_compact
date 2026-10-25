import type { Metadata } from "next";
import { PublicInfoLayout } from "@/components/public-info-layout";

export const metadata: Metadata = {
  title: "شرایط استفاده Ramin Life OS | Terms",
  description: "Terms for using the private Ramin Life OS workspace.",
  robots: { index: true, follow: true },
};

export default function TermsPage() {
  return (
    <PublicInfoLayout title="شرایط استفاده" eyebrow="Terms of service">
      <p className="public-info-lead">
        Life OS برای استفادهٔ شخصی صاحب حساب ساخته شده است. دسترسی به فضای کار
        به ورود صاحب حساب نیاز دارد و ثبت‌نام عمومی فعال نیست.
      </p>
      <section>
        <h2>داده‌ها و اتصال‌ها</h2>
        <p>
          شما تصمیم می‌گیرید Google Calendar یا فیدهای تقویم دیگر را وصل کنید.
          هنگام استفاده از اتصال Google، شرایط خود Google نیز بر حساب و تقویم
          شما اعمال می‌شود. تغییر رویداد فقط با اقدام شما و در محدودهٔ مجوزهای
          داده‌شده انجام می‌شود.
        </p>
        <p lang="en" dir="ltr">
          Ramin Life OS is an owner-only personal workspace. You choose whether
          to connect Google Calendar or other calendar feeds. Google&apos;s own
          terms also govern your Google account and calendar. Life OS changes
          eligible Google events only when you initiate a change within the
          granted permissions.
        </p>
      </section>
      <section>
        <h2>بررسی اطلاعات</h2>
        <p>
          پیش از اتکا به رویدادهای همگام‌شده، محاسبهٔ تداخل‌ها یا گزارش ساعات
          کار، آن‌ها را بررسی کنید؛ دسترسی به سرویس‌های بیرونی ممکن است موقتاً
          قطع شود یا دادهٔ تازه هنوز دریافت نشده باشد.
        </p>
        <p lang="en" dir="ltr">
          Review synced events, overlap indicators, and work-hour reports before
          relying on them. External services can be temporarily unavailable, and
          newly changed data may not yet have synchronized.
        </p>
      </section>
    </PublicInfoLayout>
  );
}
