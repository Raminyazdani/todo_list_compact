# Ramin Life OS

سامانهٔ شخصی فارسی/انگلیسی برای کارها، پروژه‌ها، وابستگی‌ها، چک‌لیست‌ها، تقویم، ساعت کار و فایل‌ها. [گزارش نهایی فارسی](docs/FINAL_REPORT_FA.md) نتیجهٔ اجرا و محدودیت‌های باقی‌مانده را توضیح می‌دهد. وضعیت انتشار و نتیجهٔ واقعی آزمون‌ها در [گزارش کیفیت](docs/QUALITY_REPORT.md)، [چک‌لیست پذیرش](docs/ACCEPTANCE_CHECKLIST.md) و [پیشرفت ساخت](docs/BUILD_PROGRESS.json) ثبت می‌شود. وجود کد به معنی تأیید انتشار نیست.

طبق [درخواست فعلی مالک](docs/CURRENT_SCOPE_FA.md)، فایل‌های تازه روی Neon خصوصی ذخیره می‌شوند و AI داخل برنامه فعلاً خاموش است. [بارگذاری و نسخه‌بندی واقعی و پشتیبان ابری](docs/NEON_LIVE_VERIFICATION.md) تأیید شدند. ورود OAuth بومی Codex و خواندن واقعی MCP در همین چت موفق‌اند؛ ۱۳۰ ابزار، حساب موجود، ۴۵ کار فعال و سه فایل اصلی تأیید شدند.

The application uses Next.js, Neon PostgreSQL, Better Auth and the official MCP TypeScript SDK. Browser, REST and MCP call one transactional domain service. Task workflow status and derived readiness are separate. Hard dependencies form a directed acyclic graph with ALL/ANY groups; only Done satisfies a prerequisite.

## اجرای محلی

Node.js 24 و pnpm 12 لازم است. از `.env.example` یک `.env.local` خصوصی بسازید، PostgreSQL آزمایشی و owner email/UUID/secret را تنظیم کنید. production و staging باید پایگاه داده و مالک جدا داشته باشند.

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm exec tsx --env-file=.env.local scripts/ops/auth-migrate.ts
pnpm exec tsx --env-file=.env.local scripts/ops/bootstrap-owner.ts /absolute/private/owner-credentials.json
pnpm dev
```

ثبت‌نام عمومی غیرفعال است. bootstrap فقط برای اولین حساب مالک است و حساب موجود را بازنویسی نمی‌کند. فایل ورود باید بیرون مخزن بماند. بعد از اولین ورود، passkey ثبت کنید و رمز اولیه را تغییر دهید.

## بررسی

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm security:scan
pnpm test:coverage
pnpm build
```

برای آزمون واقعی PostgreSQL، `TEST_POSTGRES=1` را فقط روی دیتابیس آزمایشی فعال کنید. برای Playwright، مسیر credentials ساختگی را در `E2E_CREDENTIALS_PATH` بدهید و سرور آزمایشی را اجرا کنید. روی Windows، `next dev` و `next build` را هم‌زمان با یک پوشهٔ `.next` اجرا نکنید.

## اتصال‌ها و راهنما

- [معماری و مدل داده](docs/ARCHITECTURE.md)، [مدل دامنه](docs/DATA_MODEL.md)
- [راهنمای فارسی مالک](docs/OWNER_GUIDE_FA.md)، [راهنمای عملیات](docs/RUNBOOK.md)
- [انتشار](docs/DEPLOYMENT.md)، [API و MCP](docs/MCP.md)
- [راهنمای اختیاری ChatGPT](docs/CHATGPT_CONNECTION_FA.md)، [Google](docs/GOOGLE_INTEGRATIONS.md)
- [مهاجرت](docs/MIGRATION_PLAN.md)، [پشتیبان و بازیابی](docs/BACKUP_AND_RECOVERY.md)

Google originals remain read-only references. App Google OAuth is a separate owner grant; access by a connector in the build chat does not grant the deployed server access. External calendar writes and mail sending are disabled. New private uploads use verified Neon Object Storage; existing Drive/Blob records retain their own provider. In-app AI is deferred at the owner's request. The manual daily encrypted metadata backup and independent original-byte cloud recovery passed; a scheduled cron execution has not yet been observed.

Private source snapshots, IDs, credentials, real calendar feeds and backups must never enter this public repository. Tests and screenshots use synthetic data only. The Work Planner-derived calendar/time behavior retains its MIT notice in `server/integrations/WORK_PLANNER_LICENSE.txt`.
