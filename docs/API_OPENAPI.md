# قرارداد API

OpenAPI 3.1 به‌صورت زنده از `GET /api/v1/openapi` تولید می‌شود. فایل منبع `server/openapi.ts` و enumهای `shared/contracts.ts` یک نسخهٔ مشترک دارند. metadata عمومی است؛ هیچ رکورد خصوصی در این پاسخ قرار نمی‌گیرد.

| مسیر                                                     | کاربرد                              | مجوز                                            |
| -------------------------------------------------------- | ----------------------------------- | ----------------------------------------------- |
| `GET /api/v1/query`                                      | query با نام operation و JSON input | owner session یا OAuth scope مرتبط              |
| `POST /api/v1/commands`                                  | command مشترک دامنه                 | scope نوشتن، کلید عملیات، revision در صورت لزوم |
| `/api/v1/tasks`، `/projects`، `/events`، `/time-entries` | نمای resource روی همان دامنه        | همان سیاست query/command                        |
| `POST /api/v1/files/upload`                              | bytes خصوصی و ثبت پس از checksum    | owner فایل، provider فعال، کلید پایدار          |
| `GET /api/v1/files/{id}/download`                        | bytes خصوصی یا ارجاع اصل Drive      | owner و scope فایل                              |
| `GET /api/v1/time/export`                                | XLSX ماه/کارفرمای واقعی             | scope زمان                                      |
| `GET /api/v1/backup/export`                              | portable backup خصوصی               | backup:export یا admin:manage                   |
| `POST /api/v1/ai/plan`، `/ai/execute`                    | پیشنهاد و اجرای پس از تأیید         | owner، مجوز inference، بودجهٔ معتبر             |
| `POST /api/v1/approvals`                                 | تأیید waiver bound به preview       | فقط جلسهٔ مرورگر مالک و Origin معتبر            |
| `POST /api/mcp`                                          | پروتکل MCP                          | OAuth resource/scope معتبر                      |

JSON موفق `{data,request_id}` دارد. خطا `{error:{code,message,details},request_id}` است. query pagination حداکثر ۲۰۰ رکورد دارد؛ cursor را تا پایان دنبال کنید. `Idempotency-Key` بین ۸ تا ۲۰۰ نویسه است و قصد یکسان باید در retry همان کلید و ورودی را حفظ کند. `If-Match` revision مثبت نسخهٔ خوانده‌شده است.

برای تغییر حساس ابتدا query preview، سپس نمایش اثر و commit با `preview_id` اجرا کنید. تغییر نسخه بین preview و commit خطای conflict می‌دهد. MCP و REST Bearer نمی‌توانند برای waiver یا override خودشان مجوز انسانی بسازند. commandهای import/restore/job داخلی سیاست جدا دارند و در catalog عمومی MCP منتشر نمی‌شوند.
