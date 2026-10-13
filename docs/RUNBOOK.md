# راهنمای عملیات

ابتدا `BUILD_PROGRESS.json` و acceptance checklist را بخوانید. کد، schema و گزارش تست باید یک SHA داشته باشند. credentials و snapshotهای خصوصی بیرون مخزن هستند. خطاها را با request/operation ID بررسی کنید و متن خصوصی را در GitHub issue قرار ندهید.

| علامت                 | بررسی                                              | اقدام                                                      |
| --------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| health unavailable    | اتصال PostgreSQL، وضعیت provider و محیط deployment | اصلاح همان اتصال؛ هیچ reset یا نمونه‌داده‌ای نسازید        |
| API 401               | session/token expiry، issuer/audience و owner      | ورود دوباره یا OAuth دوباره؛ cookie را به MCP نفرستید      |
| API 403               | scope یا Origin/owner                              | درخواست مجوز مناسب از مالک؛ guard را دور نزنید             |
| 409 revision conflict | نسخهٔ موجودیت تغییر کرده                           | دوباره بخوانید، diff و preview تازه بگیرید                 |
| retry timeout         | operation key و journal                            | همان کلید/ورودی را retry کنید؛ قصد جدید کلید تازه می‌خواهد |
| Google disconnected   | client config و grant مستقل owner                  | اتصال فقط‌خواندنی را در Settings کامل کنید                 |
| iCal unavailable      | allowlist، HTTPS، DNS عمومی، expiry URL            | خوراک خصوصی را بیرون Git اصلاح کنید                        |
| upload unavailable    | private Blob quota/provider                        | وضعیت حساب را رفع کنید؛ فایل اصلی Drive را جابه‌جا نکنید   |
| AI unavailable        | config، قیمت تأییدشده، اعتبار و بودجه              | تا اتصال واقعی UI معمول و MCP را استفاده کنید              |
| job عقب‌افتاده        | cron/status/notifications                          | اجرای دستی owner؛ idempotency از تکرار جلوگیری می‌کند      |

پشتیبان portable شامل graph/checklist/hierarchy/source mappings/audit/idempotency است. قبل از restore، hash و schema را بررسی کنید؛ روی staging خالیِ همان owner بازیابی و reconcile انجام دهید. فایل‌های object storage باید جدا با checksum نگه‌داری شوند؛ JSON پایگاه داده جای bytes را نمی‌گیرد. جزئیات در `BACKUP_AND_RECOVERY.md` است.

وضعیت Google Sheet پس از import مرجع read-only است. سیستم قدیمی را هم‌زمان نویسندهٔ همین دفتر نگذارید؛ هر تغییر تنظیمات یا مجوز Google باید با دستور مستقیم مالک انجام شود. این ساخت هیچ source write انجام نمی‌دهد.

بازیابی دسترسی از مسیر پشتیبانی‌شدهٔ Better Auth یا passkey ثبت‌شده انجام می‌شود. owner bootstrap روی حساب موجود متوقف می‌شود. لغو session در سرور، توکن‌های وابسته به آن را از دسترسی خارج می‌کند. tokenها در خروجی ابزار، log و screenshot درج نشوند.
