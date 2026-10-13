# ادامهٔ ساخت

از مخزن موجود و `BUILD_PROGRESS.json` ادامه بده؛ شروع مجدد یا تکرار مهاجرت بدون شناسهٔ عملیات ممنوع است. فایل‌های private handoff/source/credentials بیرون از Git هستند؛ مسیر را از فضای خصوصی کاربر پیدا کن و هیچ مقدار خصوصی را چاپ نکن.

یک پروژهٔ جدید Vercel و دو دیتابیس PostgreSQL رایگان و جدا ساخته شده‌اند. اپ هنوز production verified نیست. منطق مشترک، گراف و چک‌لیست‌ها، صفحات واقعی، OAuth/MCP، مهاجرت و آزمون‌ها در مرحلهٔ ادغام‌اند. root تنها نویسندهٔ production است.

شواهد مستقل: MCP واقعی با Authorization Code+PKCE و خواندن پس از نوشتن وب؛ کنترل رقابت روی Neon واقعی؛ توکن فقط‌خواندنی، جعلی و انقضای واقعی؛ منبع زندهٔ دو بار خوانده‌شده؛ staging import/replay/restore بدون رابطهٔ ساختگی. فایل‌های اصلی Google Drive تغییر نکرده‌اند.

مانع‌های خارجی تأییدشده: تمام مخازن خصوصی Blob حساب معلق‌اند و ایجاد مخزن تازه به سقف مصرف رد شد؛ اعتبار AI Gateway صفر است. هیچ هزینهٔ تازه یا دسترسیِ جبرانی ایجاد نشده. UI حساب ChatGPT طرح Pro و گزینهٔ Add custom MCP server دارد؛ ثبت و OAuth آن هنوز انجام نشده، محدودیت قدیمی بسته را به‌عنوان وضعیت امروز فرض نکن.

کارهای باز: تکمیل آخرین featureهای مالک‌ها، آزمون UI/axe/screenshot، سبزشدن build/coverage/CI، اصلاح هر ایراد بازیابی، bootstrap production owner، fresh source checkpoint و تنها سپس import/reconcile production، push/PR و deploy واقعی، production MCP/UI/redeploy persistence و ثبت دقیق AC-01..28.

آخرین نقطهٔ واقعی ۱۳ اکتبر ۲۰۲۶ ساعت ۲۲:۱۹ UTC: شاخهٔ `feat/life-os` با commitهای ثبت‌شده و PR شمارهٔ ۱ در GitHub موجود است. پروژهٔ جدید Vercel به همان repo و production branch=`master` متصل شد. اولین deploy خودکار Vercel از commit `0ff748b` به نشانی واقعی `https://ramin-life-os.vercel.app` رسید؛ health=200 و public data=401 است. آزمون SDK واقعی تولید، PKCE، ۱۱۳ ابزار، نوشتن/بازخوانی، retry بدون تکرار و آرشیو صرفاً fixture موفق بود. این انتشار ابتدایی جای نسخهٔ نهاییِ بازبینی‌شده یا مهاجرت نیست. حساب مالک production قبلاً ساخته و فایل ورود خصوصی محفوظ است؛ bootstrap را تکرار نکن.

چهارمین build محلی و ۱۸۷ unit/integration، ۹ سناریوی مرورگر در rerunهای مشخص و چهار بررسی axe داشبورد/گراف موفق‌اند. بازیابی رمزگذاری‌شدهٔ پیش از import فقط جدول‌های خالی business را تأیید کرد. Backend جابه‌جایی یک وقوع با EXDATE/override اتمی، lifecycle/history، archive/restore پروژه و فیلتر مهلت/آرشیو آماده است؛ ۵۹ آزمون مرتبط و ۳ race واقعی PostgreSQL موفق‌اند. schema version هنوز۱ و ALTERها additive/idempotent هستند؛ staging این ALTERها را دریافت کرده، production هنوز باید root آن‌ها را اعمال کند.

CI مستقل Linux دو ایراد واقعی یافت: helperهای private-path ابتدا از Git جا افتاده بودند (اصلاح و ثبت شد)، و نرخ بالای signin در محیط سریع پاسخ429 با زمان انتظار غیرواقعی می‌گرفت. root روی staging بازتولید کرد: سه200 سپس429 با X-Retry-After بسیار بزرگ؛ PG BIGINT رشته است و provider آن را در جمع عددی استفاده می‌کند. domain_engine روی parser عددِ امنِ تنها authPool و آزمون HTTP واقعی کار می‌کند؛ محدودیت۳/۱۰ثانیه را ضعیف نکن. source_audit اسکیماهای دقیق MCP و آزمون سازگاری OIDC/DCR را تکمیل می‌کند. requirements مشغول امکانات مستقل باقی‌ماندهٔ UI، سپس visual همهٔ صفحات است. تا READY همه، build تازه و CI سبز، source import نکن.

فرم ChatGPT واقعی با endpoint تولید پر شد، OAuth discovery موفق و DCR شناخته شد؛ هیچ plugin/grant ثبت نشده. مرورگر Edge فعلی ID4 و همان tab Plugins است. ثبت/تأیید دسترسی مطابق سیاست browser نیازمند تأیید لحظه‌ای مالک در پایان کار مستقل است. پیش از ادامهٔ browser پس از compaction راهنما را با rewriteDocumentation بخوان.

روی Windows build و dev را با یک `.next` هم‌زمان اجرا نکن. ابتدا READY همهٔ نویسنده‌ها، سپس توقف dev، build و راه‌اندازی مجدد. تست‌ها دادهٔ ساختگی staging دارند؛ تصویر خصوصی production را در Git/CI ذخیره نکن.
