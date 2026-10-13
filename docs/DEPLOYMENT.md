# انتشار

مقصد مجاز فقط مخزن `Raminyazdani/todo_list_compact` و پروژهٔ تازهٔ `ramin-life-os` در تیم `ramin-yazdanis-projects` است. پروژه‌های قدیمی تغییر نمی‌کنند. شاخهٔ production مخزن `master` است. نشانی تنظیم‌شدهٔ پروژه `ramin-life-os.vercel.app` است؛ فقط آزمون HTTP بعد از deployment موفق، فعال بودن آن را ثابت می‌کند.

دو PostgreSQL مستقل در fra1 با پلن رایگان ساخته شده‌اند: production برای دادهٔ اصلی، staging برای دادهٔ ساختگی. credentials هرگز در Git، PR، log یا `NEXT_PUBLIC_*` قرار نمی‌گیرند. preview به staging متصل است. secret و owner هر محیط جدا هستند.

ترتیب انتشار: بررسی نوع/lint/format/test/scan، build، commit/PR/CI، بررسی migration، انتشار همان SHA، آزمون HTTPS بدون ورود و با ورود، OAuth/MCP واقعی، import از checkpoint تازه، reconcile، سپس redeploy و بررسی ماندگاری. تمام نتیجه‌ها در `BUILD_PROGRESS.json` و acceptance checklist ثبت می‌شوند.

```sh
vercel project inspect ramin-life-os --scope ramin-yazdanis-projects
vercel deploy --prod --scope ramin-yazdanis-projects
vercel inspect <observed-deployment-url> --scope ramin-yazdanis-projects
```

مرز امنیتی alias اصلی، ورود owner و OAuth برنامه است. Standard Deployment Protection برای preview و URL یکتای deployment حفظ می‌شود؛ alias production باید برای discovery عمومی MCP قابل دسترس باشد. discovery فقط metadata است و دادهٔ مالک بدون توکن قابل دسترس نیست.

`/api/health` صرفاً دسترسی دیتابیس را اعلام می‌کند. cron با `CRON_SECRET` احراز می‌شود. اطلاعات تکمیلی فقط از `system_health`، `system_capabilities` و `sync_status` خصوصی خوانده می‌شوند. پروژه Hobby فقط cron روزانه دارد.

محدودیت‌های مشاهده‌شدهٔ حساب: ایجاد private Blob جدید به علت سقف مصرف رد شد و storeهای خصوصی موجود معلق‌اند؛ AI Gateway اعتبار صفر داشت. هیچ خرید، ارتقای پلن یا استفاده از token پروژهٔ دیگری انجام نشده است. رفع این محدودیت‌ها برای آزمون زندهٔ upload/AI لازم است؛ کد و آزمون شبیه‌سازی provider جای آن را نمی‌گیرد.

Rollback کد با deployment قبلی انجام می‌شود. rollback داده فقط از backup معتبر در staging تمرین‌شده، با مالک یکسان و عملیات صریح انجام شود. حذف جدول یا reset production روش rollback نیست.
