# انتشار

**Current scope, 2026-10-14:** [actual Neon verification](NEON_LIVE_VERIFICATION.md) supersedes the earlier Blob/AI/ChatGPT limits as current delivery conditions. Neon files and both manual metadata/original-byte cloud recovery proofs pass; native Codex OAuth and actual current-chat tool loading/read now pass (130 tools, five calls, 45 active tasks and three original active files; zero business writes). In-app AI is deferred. Scheduled cron execution and product-specific calendar grants remain separate. The milestones below retain their original times, counts and scope.

مقصد مجاز فقط مخزن `Raminyazdani/todo_list_compact` و پروژهٔ تازهٔ `ramin-life-os` در تیم `ramin-yazdanis-projects` است. پروژه‌های قدیمی تغییر نمی‌کنند. شاخهٔ production مخزن `master` است. نشانی واقعی HTTPS تولید [ramin-life-os.vercel.app](https://ramin-life-os.vercel.app) است؛ در نقطهٔ عطف ۱۴ اکتبر۲۰۲۶ نسخهٔ `334ee291d9fcea0024e120423860111eaa5120c5` روی آن مشاهده شد.

دو PostgreSQL مستقل در fra1 با پلن رایگان ساخته شده‌اند: production برای دادهٔ اصلی، staging برای دادهٔ ساختگی. credentials هرگز در Git، PR، log یا `NEXT_PUBLIC_*` قرار نمی‌گیرند. preview به staging متصل است. secret و owner هر محیط جدا هستند.

ترتیب انتشار: بررسی نوع/lint/format/test/scan، build، commit/PR/CI، بررسی migration، انتشار همان SHA، آزمون HTTPS بدون ورود و با ورود، OAuth/MCP واقعی، import از checkpoint تازه، reconcile، سپس redeploy و بررسی ماندگاری. تمام نتیجه‌ها در `BUILD_PROGRESS.json` و acceptance checklist ثبت می‌شوند.

CI همین نسخه در [run 38519881381](https://github.com/Raminyazdani/todo_list_compact/actions/runs/38519881381) موفق شد:۳۹۳ آزمون coverage با۲۸ skip صریح،۱۲ native PostgreSQL،۲۴ مرورگر با۲ skip،SDK با۱۳۰ ابزار،۱۶ HTTP امنیتی،۱ OIDC،۶ rate و۱ انقضای واقعی. commit نهایی اصلاحات اپراتور/آزمون/مستندات و CI کامل پس از آن هنوز باید توسط root مشاهده و ثبت شوند؛ runtime و catalog۱۳۰ ابزاری در این اصلاحات تغییر نکردند.

DDL تولید، import/replay و تطبیق native/API تأیید شدند:۴۵ task و۳ فایل اصلی و۲۱ task ساختگی گراف پیش از cleanup دقیقاً بررسی شدند؛ Links منبع همچنان۳ است. نمایش گراف تولید و UI مالک، restore hosted در پایگاه مستقل و بازیابی مستقل bytes اصلی موفق بودند. cleanup نهایی تأیید شد:۷۲ task کل،۴۵ task منبع غیرآرشیوی،۲۷ آرشیوی،۱۰۴ mapping و صفر template/rule/instance/member ساختگی. سه درخواست بدون ورود برای download اصلی،۴۰۱ و بدون redirect بودند. export رمزگذاری‌شدهٔ نهایی persisted و با decrypt/manifest تأیید شد؛ این نقطهٔ جدید export با نقطهٔ قبلی تمرین hosted restore متفاوت است.

انتشار forced از CLI در همان SHA به READY رسید، اما invocation اولیهٔ DG-36 پس از پذیرش provider نتیجهٔ غیرصفر داد و علت دقیق آن از خروجی حفظ‌شده قابل اثبات نبود. recovery فقط با GET انجام شد و همان۴ task و رابطه‌های موجود حفظ شدند؛ ورود تازهٔ مالک و read-back API/UI در۱ آزمون۳۸٫۴ثانیه‌ای موفق بود. factory یا deploy را تکرار نکنید. هویت‌های واقعی deployment/fixture و گزارش مفصل خصوصی باقی می‌مانند. اصلاح helper با۱۲ آزمون شامل child process واقعی و cleanup template با۸ آزمون متمرکز تأیید شدند؛ CI نهایی بعدی هنوز شاهد مستقل می‌خواهد.

پاکسازی مجاز تولید،۲۵ task ساختگی و پروژهٔ آنها را آرشیو کرد و یک template/rule/instance و۵ member ساختگی را از مسیر داخلی canonical برداشت؛۴ client ثبت‌شدهٔ QA لغو شدند. Stage نیز۲۱ fixture و۱۰ client ثبت‌شدهٔ QA را پاکسازی کرد. دادهٔ منبع و تاریخچهٔ پذیرفته‌شده حفظ شدند. snapshot نهایی خصوصی شامل۷۲ task،۲۹ project،۱۰۴ mapping،۸۴ عملیات پذیرفته‌شده،۱۵۰ activity و۳ file/version/link است؛ template/rule/instance ساختگی صفر است.

```sh
vercel project inspect ramin-life-os --scope ramin-yazdanis-projects
vercel deploy --prod --scope ramin-yazdanis-projects
vercel inspect <observed-deployment-url> --scope ramin-yazdanis-projects
```

مرز امنیتی alias اصلی، ورود owner و OAuth برنامه است. Standard Deployment Protection برای preview و URL یکتای deployment حفظ می‌شود؛ alias production باید برای discovery عمومی MCP قابل دسترس باشد. discovery فقط metadata است و دادهٔ مالک بدون توکن قابل دسترس نیست.

`/api/health` صرفاً دسترسی دیتابیس را اعلام می‌کند. cron با `CRON_SECRET` احراز می‌شود. اطلاعات تکمیلی فقط از `system_health`، `system_capabilities` و `sync_status` خصوصی خوانده می‌شوند. پروژه Hobby فقط cron روزانه دارد.

محدودیت‌های مشاهده‌شدهٔ حساب: ایجاد private Blob جدید به علت سقف مصرف رد شد و storeهای خصوصی موجود معلق‌اند؛ AI Gateway اعتبار صفر داشت. هیچ خرید، ارتقای پلن یا استفاده از token پروژهٔ دیگری انجام نشده است. رفع این محدودیت‌ها برای آزمون زندهٔ upload/AI لازم است؛ کد و آزمون شبیه‌سازی provider جای آن را نمی‌گیرد.

Rollback کد با deployment قبلی انجام می‌شود. rollback داده فقط از backup معتبر در staging تمرین‌شده، با مالک یکسان و عملیات صریح انجام شود. حذف جدول یا reset production روش rollback نیست.

## Frozen final source batch and receipt update

Source/test batch **9ebbe815558c86d6865044daae4741ed802d3304** completed [CI38527496681](https://github.com/Raminyazdani/todo_list_compact/actions/runs/38527496681) successfully: coverage410 PASS/28 opt-in SKIP,53/9 files; native PostgreSQL12; browser24 PASS/3 explicit production opt-in SKIP; SDK130; HTTP16,OIDC1,rate6,realexpiry1. Domain statement94.70%/branch91.13%. Format/lint/type/public-safety/audit/schema/build and all configured security steps passed. Final production dpl_3kaY1N3FrWU5FY8Cr169HtotNjbC is READY on that exact source SHA; independent native reconciliation and fresh owner API45Tasks/3Files passed07:26:48UTC. Two earlier read-only operator failures are retained privately; their exact internal cause is unproven. No source/domain writes were performed by verification.

The following receipt commit updates documentation only. Application code, test sources, schema, dependencies and configuration remain the fully checked batch above; repeated heavy suites are unnecessary for these status/wording changes. Historical334/DG36 receipts below retain their original SHA and counts. Full release remains open for actual private storage/AI/product-calendar grants and the ChatGPT client grant. Browser control still fails loading request-header policy after a bounded reset recovery; no installation/grant was submitted.
