# ادامهٔ ساخت

از مخزن موجود و `BUILD_PROGRESS.json` ادامه بده؛ شروع مجدد یا تکرار مهاجرت بدون شناسهٔ عملیات ممنوع است. فایل‌های private handoff/source/credentials بیرون از Git هستند؛ مسیر را از فضای خصوصی کاربر پیدا کن و هیچ مقدار خصوصی را چاپ نکن.

یک پروژهٔ جدید Vercel و دو دیتابیس PostgreSQL رایگان و جدا ساخته شده‌اند. اپ هنوز production verified نیست. منطق مشترک، گراف و چک‌لیست‌ها، صفحات واقعی، OAuth/MCP، مهاجرت و آزمون‌ها در مرحلهٔ ادغام‌اند. root تنها نویسندهٔ production است.

شواهد مستقل: MCP واقعی با Authorization Code+PKCE و خواندن پس از نوشتن وب؛ کنترل رقابت روی Neon واقعی؛ توکن فقط‌خواندنی، جعلی و انقضای واقعی؛ منبع زندهٔ دو بار خوانده‌شده؛ staging import/replay/restore بدون رابطهٔ ساختگی. فایل‌های اصلی Google Drive تغییر نکرده‌اند.

مانع‌های خارجی تأییدشده: تمام مخازن خصوصی Blob حساب معلق‌اند و ایجاد مخزن تازه به سقف مصرف رد شد؛ اعتبار AI Gateway صفر است. هیچ هزینهٔ تازه یا دسترسیِ جبرانی ایجاد نشده. UI حساب ChatGPT طرح Pro و گزینهٔ Add custom MCP server دارد؛ ثبت و OAuth آن هنوز انجام نشده، محدودیت قدیمی بسته را به‌عنوان وضعیت امروز فرض نکن.

کارهای باز: تکمیل آخرین featureهای مالک‌ها، آزمون UI/axe/screenshot، سبزشدن build/coverage/CI، اصلاح هر ایراد بازیابی، bootstrap production owner، fresh source checkpoint و تنها سپس import/reconcile production، push/PR و deploy واقعی، production MCP/UI/redeploy persistence و ثبت دقیق AC-01..28.

روی Windows build و dev را با یک `.next` هم‌زمان اجرا نکن. ابتدا READY همهٔ نویسنده‌ها، سپس توقف dev، build و راه‌اندازی مجدد. تست‌ها دادهٔ ساختگی staging دارند؛ تصویر خصوصی production را در Git/CI ذخیره نکن.
