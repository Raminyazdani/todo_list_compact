import type { Metadata } from "next";
import { PublicInfoLayout } from "@/components/public-info-layout";

export const metadata: Metadata = {
  title: "حریم خصوصی Ramin Life OS | Privacy",
  description: "How Ramin Life OS uses and stores Google Calendar data.",
  robots: { index: true, follow: true },
};

export default function PrivacyPage() {
  return (
    <PublicInfoLayout title="حریم خصوصی" eyebrow="Privacy policy">
      <p className="public-info-lead">
        Life OS فضای خصوصی صاحب حساب است. اتصال Google Calendar اختیاری است و
        فقط پس از موافقت شما فعال می‌شود.
      </p>
      <section>
        <h2>دسترسی به Google Calendar</h2>
        <p>
          برنامه برای نمایش تقویم‌ها و رویدادها مجوز خواندن تقویم را درخواست
          می‌کند. نام تقویم، منطقهٔ زمانی، سطح دسترسی و اطلاعات رویدادها، از
          جمله توضیحات آن‌ها، ممکن است خوانده شوند. مجوز نوشتن به رویدادهای
          تقویم‌های متعلق به حساب محدود است؛ Life OS فقط هنگام اقدام شما برای
          ایجاد، ویرایش یا حذف رویداد شخصیِ مجاز، تغییر را به Google می‌فرستد.
        </p>
        <p lang="en" dir="ltr">
          With your consent, Life OS requests Google Calendar read access and
          permission to manage events on calendars you own. It reads calendar
          names, time zones, access rights, and event details, including
          descriptions. It sends changes to Google when you create, edit, or
          delete an eligible personal event in Life OS.
        </p>
      </section>
      <section>
        <h2>استفاده و نگهداری داده</h2>
        <p>
          رویدادها برای نمایش، همگام‌سازی و محاسبهٔ تداخل در کش PostgreSQL
          برنامه نگهداری می‌شوند. اطلاعات اتصال Google در پایگاه داده ذخیره
          می‌شود و توکن‌های OAuth در سطح برنامه رمزگذاری می‌شوند. قابلیت هوش
          مصنوعی داخل برنامه فعلاً غیرفعال است.
        </p>
        <p lang="en" dir="ltr">
          Life OS stores the received event data in its PostgreSQL cache for
          display, synchronization, and overlap checks. It stores the Google
          connection in its database and encrypts OAuth tokens at the
          application level. The in-app AI feature is currently disabled.
        </p>
      </section>
      <section>
        <h2>اتصال‌های دیگر و کنترل شما</h2>
        <p>
          دسترسی یک ابزار بیرونی از طریق MCP به دادهٔ تقویم، مجوز جداگانهٔ
          <span dir="ltr"> calendar:read </span> یا
          <span dir="ltr"> calendar:write </span> می‌خواهد. با قطع منبع در Life
          OS، نمایش و همگام‌سازی فعال آن متوقف و تغییرات معلق لغو می‌شوند؛ دادهٔ
          کش‌شده و رکورد اتصال به‌طور خودکار حذف نمی‌شوند. برای درخواست حذف
          دادهٔ ذخیره‌شده، از ایمیل پشتیبانی درج‌شده در صفحهٔ رضایت Google
          استفاده کنید.
        </p>
        <p lang="en" dir="ltr">
          External MCP access to calendar data requires a separate calendar:read
          or calendar:write grant. Disconnecting a source in Life OS stops its
          active display and sync and cancels pending changes; it does not
          automatically erase cached data or the stored connection. To request
          deletion of stored data, contact the support email shown on the Google
          consent screen.
        </p>
      </section>
    </PublicInfoLayout>
  );
}
