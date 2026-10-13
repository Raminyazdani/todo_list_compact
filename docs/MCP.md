# API و MCP

Endpoint برنامه `/api/mcp` از SDK رسمی MCP و Streamable HTTP استفاده می‌کند. POST درخواست‌های پروتکل را می‌پذیرد؛ احراز هویت Bearer OAuth لازم است. discovery در `/.well-known/oauth-protected-resource/api/mcp` و `/.well-known/oauth-authorization-server/api/auth` است. نشانی کامل باید از deployment واقعی مشاهده‌شده گرفته شود.

REST با `GET /api/v1/query` برای ورودی کوتاه و `POST /api/v1/query` برای JSON بزرگ، از جمله preview واردسازی ساعات کاری، روی همان دامنه اجرا می‌شود. client رسمی طول URL کدگذاری‌شده را برای انتخاب POST بررسی می‌کند تا متن فارسی به سقف URI برخورد نکند.

OAuth Authorization Code + PKCE S256، DCR، consent، resource audience و scope روی سرور اجرا می‌شوند. access token پنج دقیقه عمر دارد و session مالک دوباره از DB بررسی می‌شود. اجازهٔ خواندن، اجازهٔ نوشتن نیست. فایل‌ها و سایر ابزارها scope مرتبط می‌خواهند. cookie مرورگر برای MCP پذیرفته نیست.

همهٔ ابزارهای منتشرشده schema صریح با ورودی محدود، توضیح عملیات و scope واقعی دارند. wrapper خروجی `{data}` یا `{error}` و schema آن در SDK اعلام می‌شود؛ metadata scopeها و annotationها برای client راهنما هستند، کنترل نهایی در دامنه اجرا می‌شود. درخواست MCP سقف۲MiB دارد. برنامه فعلاً Bearer را پشتیبانی می‌کند و الگوریتم فعال DPoP تبلیغ نمی‌کند. UserInfo و ID-token هویتی فقط پس از grant صریح OIDC صادر می‌شوند؛ resource همان MCP برنامه است و تغییر scope مجوزهای جدید را به توکن قبلی اضافه نمی‌کند.

شاهد آزمون واقعی محلی، ثبت‌شده در ۱۳ اکتبر۲۲:۴۷:۵۸ UTC: DCR/PKCE، UserInfo مالک، ID token امضاشده با JWKS و issuer/audience/subject/nonce صحیح موفق بود؛ لغو همان client توسط مالک، توکنِ هنوز منقضی‌نشده را فوراً در UserInfo و MCP رد کرد. این شاهد مستقل از نصب ChatGPT است. سیاست resource seed از API رسمی provider با merge فقط فیلدهای مشخص همین resource را به‌روز می‌کند و سایر تنظیمات مدیر را حفظ می‌کند.

ابزارهای query و command از قرارداد مشترک ساخته می‌شوند. `operation_id` پایدار برای هر قصد و `expected_revision` برای ویرایش موجودیت لازم است. ورودی snake_case و شناسهٔ پایدار دارد. commitهای حساس فقط preview معتبر، owner-bound، منقضی‌نشده و revisionهای ثابت را می‌پذیرند. waiver به تأیید صریح مرورگر مالک هم نیاز دارد و مدل AI آن را نمی‌تواند ایجاد کند.

فهرست واقعی ابزارها با `tools/list` گرفته می‌شود؛ شمارش ثابت در مستندات منبع حقیقت نیست. `legacy_import`، restore، ثبت مستقیم upload و job سیستمی ابزار عمومی MCP نیستند. هر تغییر موفق audit مشترک و read-back UI دارد.

REST شامل `/api/v1/query?operation=...&input=...` و `POST /api/v1/commands` است. commands به `Idempotency-Key` و در صورت لزوم `If-Match` نیاز دارند. مسیرهای resource برای tasks/projects/events/time-entries/files همان دامنه را استفاده می‌کنند. `/api/v1/openapi` schema عمومی را بدون محتوای مالک برمی‌گرداند.

خطاها شامل کد پایدار، پیام، جزئیات کنترل‌شده و request ID هستند. retry با کلید یکسان duplicate نمی‌سازد. conflict نیازمند بازخوانی و تصمیم تازه است. لاگ یا پیام ابزار شامل credential نیست.

تنظیم نمونهٔ generic client و skill در `integrations/mcp` و `integrations/agent-skill` است. `scripts/ops/runtime-smoke.mjs` OAuth و SDK واقعی را روی دادهٔ ساختگی اجرا می‌کند؛ موفقیت آن با نصب واقعی ChatGPT متفاوت است.
