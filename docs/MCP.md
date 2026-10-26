# API و MCP

سرور `life_os` در تولید با OAuth مالک به Codex و ChatGPT Web متصل شده است؛ شواهد هر اتصال و نسخه در [پیشرفت ساخت](BUILD_PROGRESS.json) ثبت می‌شود. شمار ۱۳۰ ابزار و ۴۵ کار در پاراگراف‌های تاریخی پایین مربوط به آزمون ۱۴ اکتبر است و شمار فعلی نیست. AI داخل برنامه طبق تصمیم مالک خاموش می‌ماند.

Endpoint برنامه `/api/mcp` از SDK رسمی MCP و Streamable HTTP استفاده می‌کند. POST درخواست‌های پروتکل را می‌پذیرد؛ احراز هویت Bearer OAuth لازم است. discovery در `/.well-known/oauth-protected-resource/api/mcp` و `/.well-known/oauth-authorization-server/api/auth` است. نشانی کامل باید از deployment واقعی مشاهده‌شده گرفته شود.

REST با `GET /api/v1/query` برای ورودی کوتاه و `POST /api/v1/query` برای JSON بزرگ، از جمله preview واردسازی ساعات کاری، روی همان دامنه اجرا می‌شود. client رسمی طول URL کدگذاری‌شده را برای انتخاب POST بررسی می‌کند تا متن فارسی به سقف URI برخورد نکند.

OAuth Authorization Code + PKCE S256، DCR، consent، resource audience و scope روی سرور اجرا می‌شوند. access token پنج دقیقه عمر دارد و session مالک دوباره از DB بررسی می‌شود. اجازهٔ خواندن، اجازهٔ نوشتن نیست. فایل‌ها و سایر ابزارها scope مرتبط می‌خواهند. cookie مرورگر برای MCP پذیرفته نیست.

همهٔ ابزارهای منتشرشده schema صریح با ورودی محدود، توضیح عملیات و scope واقعی دارند. wrapper خروجی `{data}` یا `{error}` و schema آن در SDK اعلام می‌شود؛ metadata scopeها و annotationها برای client راهنما هستند، کنترل نهایی در دامنه اجرا می‌شود. درخواست MCP سقف۲MiB دارد. برنامه فعلاً Bearer را پشتیبانی می‌کند و الگوریتم فعال DPoP تبلیغ نمی‌کند. UserInfo و ID-token هویتی فقط پس از grant صریح OIDC صادر می‌شوند؛ resource همان MCP برنامه است و تغییر scope مجوزهای جدید را به توکن قبلی اضافه نمی‌کند.

شاهد آزمون واقعی محلی، ثبت‌شده در ۱۳ اکتبر۲۲:۴۷:۵۸ UTC: DCR/PKCE، UserInfo مالک، ID token امضاشده با JWKS و issuer/audience/subject/nonce صحیح موفق بود؛ لغو همان client توسط مالک، توکنِ هنوز منقضی‌نشده را فوراً در UserInfo و MCP رد کرد. این شاهد مستقل از نصب ChatGPT است. سیاست resource seed از API رسمی provider با merge فقط فیلدهای مشخص همین resource را به‌روز می‌کند و سایر تنظیمات مدیر را حفظ می‌کند.

ابزارهای query و command از قرارداد مشترک ساخته می‌شوند. `operation_id` پایدار برای هر قصد و `expected_revision` برای ویرایش موجودیت لازم است. ورودی snake_case و شناسهٔ پایدار دارد. commitهای حساس فقط preview معتبر، owner-bound، منقضی‌نشده و revisionهای ثابت را می‌پذیرند. waiver به تأیید صریح مرورگر مالک هم نیاز دارد و مدل AI آن را نمی‌تواند ایجاد کند.

`daily_focus_get` انتخاب‌های یک روز محلی برلین را می‌خواند و `daily_focus_set` حداکثر پنج شناسهٔ مرتب را با `expected_revision`، `operation_id` و scope نوشتن کارها جایگزین می‌کند؛ خود کار، موعد و وضعیتش تغییر نمی‌کند. `daily_capacity_preview` فقط برآوردهای ثبت‌شده و بازه‌های مشغول شناخته‌شده را گزارش می‌کند؛ دادهٔ تقویم و ساعت کار تنها با scope مستقل همان منبع برمی‌گردد. `search_all` صفحه‌های مستقل کار، پروژه و فایل را فقط در scopeهای مجاز ارائه می‌کند.

فهرست واقعی ابزارها با `tools/list` گرفته می‌شود؛ شمارش ثابت در مستندات منبع حقیقت نیست. `legacy_import`، restore، ثبت مستقیم upload و job سیستمی ابزار عمومی MCP نیستند. هر تغییر موفق audit مشترک و read-back UI دارد.

REST شامل `/api/v1/query?operation=...&input=...` و `POST /api/v1/commands` است. commands به `Idempotency-Key` و در صورت لزوم `If-Match` نیاز دارند. مسیرهای resource برای tasks/projects/events/time-entries/files همان دامنه را استفاده می‌کنند. `/api/v1/openapi` schema عمومی را بدون محتوای مالک برمی‌گرداند.

خطاها شامل کد پایدار، پیام، جزئیات کنترل‌شده و request ID هستند. retry با کلید یکسان duplicate نمی‌سازد. conflict نیازمند بازخوانی و تصمیم تازه است. لاگ یا پیام ابزار شامل credential نیست.

تنظیم نمونهٔ generic client و skill در `integrations/mcp` و `integrations/agent-skill` است. `scripts/ops/runtime-smoke.mjs` OAuth و SDK واقعی را روی دادهٔ ساختگی اجرا می‌کند؛ موفقیت آن با نصب واقعی ChatGPT متفاوت است.

نقطهٔ عطف واقعی ۱۴ اکتبر۲۰۲۶: endpoint تولید [ramin-life-os.vercel.app/api/mcp](https://ramin-life-os.vercel.app/api/mcp) در نسخهٔ master=`334ee291d9fcea0024e120423860111eaa5120c5` مشاهده شد. [CI 38519881381](https://github.com/Raminyazdani/todo_list_compact/actions/runs/38519881381) موفق بود و SDK واقعی۱۳۰ ابزار، OAuth، نوشتن/بازخوانی، retry و cleanup را تأیید کرد؛۱۶ آزمون HTTP،۱ OIDC،۶ rate و۱ انقضای واقعی نیز موفق بودند. این شمارش، شاهد همین نسخه است؛ `tools/list` همچنان منبع حقیقت client است. اصلاحات بعدی اپراتور/آزمون/مستندات runtime یا catalog را تغییر ندادند و CI کاملِ commit نهاییِ آنها هنوز باید مشاهده شود.

تطبیق تولید native/API،۴۵ task و۳ فایل اصلی و۲۱ task دقیق گراف ساختگی را پیش از cleanup تأیید کرد. نمودار و UI مالک روی همان DB مشاهده شدند. پس از یک deploy forced پذیرفته‌شده و READY در همان SHA، invocation اولیهٔ DG-36 غیرصفر بود؛ recovery با GET و همان۴ fixture، سپس ورود تازهٔ مالک و UI/API در۱ آزمون۳۸٫۴ثانیه‌ای موفق شد. علت دقیق شکست اولیه محفوظ نبود؛ از این نتیجه مجوز تکرار factory یا deploy نسازید. هویت‌ها و receiptهای واقعی خصوصی هستند.

چهار client ثبت‌شدهٔ QA تولید و۱۰ client ثبت‌شدهٔ QA Stage پس از اثبات و cleanup لغو شدند. client یا grant کاربر پاکسازی نشده است. proof نهایی،۴۵ task منبع غیرآرشیوی و رد۴۰۱ بدون redirect برای هر سه download بدون ورود را تأیید کرد. اتصال واقعی ChatGPT و grant آن هنوز منتظر تأیید لحظهٔ اقدام مالک طبق راهنمای ابزار browser است؛ موفقیت MCP عمومی به معنی نصب ChatGPT نیست. Blob با پاسخ۴۰۰ threshold، اعتبار AI صفر و grant محصول Google غایب، همچنان محدودیت‌های جدا هستند.

## Frozen final source batch and receipt update

Source/test batch **9ebbe815558c86d6865044daae4741ed802d3304** completed [CI38527496681](https://github.com/Raminyazdani/todo_list_compact/actions/runs/38527496681) successfully: coverage410 PASS/28 opt-in SKIP,53/9 files; native PostgreSQL12; browser24 PASS/3 explicit production opt-in SKIP; SDK130; HTTP16,OIDC1,rate6,realexpiry1. Domain statement94.70%/branch91.13%. Format/lint/type/public-safety/audit/schema/build and all configured security steps passed. Final production dpl_3kaY1N3FrWU5FY8Cr169HtotNjbC is READY on that exact source SHA; independent native reconciliation and fresh owner API45Tasks/3Files passed07:26:48UTC. Two earlier read-only operator failures are retained privately; their exact internal cause is unproven. No source/domain writes were performed by verification.

The following receipt commit updates documentation only. Application code, test sources, schema, dependencies and configuration remain the fully checked batch above; repeated heavy suites are unnecessary for these status/wording changes. Historical334/DG36 receipts below retain their original SHA and counts. Full release remains open for actual private storage/AI/product-calendar grants and the ChatGPT client grant. Browser control still fails loading request-header policy after a bounded reset recovery; no installation/grant was submitted.
