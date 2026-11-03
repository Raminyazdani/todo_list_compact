# کاتالوگ مهارت‌های طراحی Life OS

نصب پروژه‌ای در ۲۰۲۶-۱۱-۰۳ انجام شد. ورودی‌های واقعی در `.agents/skills/` و متن
اصلی با چیدمان و مجوز خودش در `.agents/design-sources/` نگهداری می‌شود؛ هر دو مسیر
از Git عمومی خارج‌اند. مهارت‌های جدید در نوبت بعدی قابل‌شناسایی‌اند و همین اجرا
متن‌های مرتبط را مستقیماً خوانده است. نصب، اثبات وجود حساب Figma/سرویس ویدئو یا
اجراشدن ابزار خارجی نیست.

## پوشش هر ۱۳ لینک

| لینک کاربر                                                                                                                                              | نتیجهٔ بررسی و نصب                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| [Agentic Skills / animate](https://agenticskills.io/skills/animate)                                                                                     | نسخهٔ معرفی‌شده به منبع اصلی Emil برگردانده شد؛ نصب یک‌باره، بدون نسخهٔ فعال تکراری                                       |
| [OpenDesign](https://github.com/nexu-io/open-design)                                                                                                    | ۱۶۹ ورودی اصلی، نسخه‌های مستقلِ مثال/قالب در آرشیو؛ ۸۵ ورودی فقط اشاره‌گر کاتالوگ‌اند                                     |
| [Claude Design Skills](https://github.com/freshtechbro/claudedesignskills)                                                                              | ۲۳ مهارت اصلی، شامل ۲۲ طراحی و یک skill-creator؛ کپی‌های بسته‌بندی تکراری ثبت شدند                                        |
| [OpenCodesign](https://github.com/opencoworkai/open-codesign)                                                                                           | ۱۷ دستور دارای metadata با wrapper استاندارد؛ ۱۲ الگوی JSX و DESIGN.md مرجع، بدون نصب برنامهٔ دسکتاپ آن                   |
| [Reddit](https://www.reddit.com/r/codex/comments/1sxufax/extracted_claude_design_system_prompt_so_you_can/)                                             | پست خوانده شد؛ به مخزن Trystan اشاره می‌کند و مهارت مستقل دیگری ندارد؛ ادعای استخراج، منبع رسمی Anthropic نیست            |
| [Trystan design prompt](https://github.com/Trystan-SA/claude-design-system-prompt)                                                                      | ۱۴ دستور Codex؛ نسخه‌های متفاوت Claude و دو prompt/AGENTS مرجع حفظ شدند؛ قرارداد پروژه جایگزین نشد                        |
| [iart motion-skills](https://github.com/iart-ai/motion-skills)                                                                                          | فهرست واقعی ۱۹ بسته/۵۶ مهارت بررسی شد؛ عدد قدیمی About مبنا قرار نگرفت                                                    |
| [AIUX animate](https://aiuxplayground.com/skills/animate)                                                                                               | به همان منبع اصلی animate برمی‌گردد؛ alias ثبت شد                                                                         |
| [AnimateAI](https://animateai.pro/)                                                                                                                     | محصول تجاری ساخت ویدئو است؛ SKILL مستقل در صفحه ارائه نشده؛ خرید/حساب/ویدئو ساخته نشد                                     |
| [مقالهٔ Medium](https://medium.com/coding-nexus/stop-adding-random-animations-this-new-ai-skill-finds-exactly-what-your-ui-should-animate-f5c3c21ab6b7) | پیش‌نمایش عمومی خوانده شد؛ مهارت عمومی find-animation-opportunities از منبع اصلی گرفته شد؛ محتوای پشت محدودیت دور زده نشد |
| [animations.dev/skills](https://animations.dev/skills)                                                                                                  | صفحهٔ خبرنامه؛ مهارت‌های عمومی Emil نصب شدند، بدون ثبت‌نام یا ادعای دسترسی به محتوای دوره                                 |
| [UI Skills / motion](https://www.ui-skills.com/skills/motion)                                                                                           | ۱۱۴ کارت motion از ۳۷ مخزن با متن عمومی منبع تطبیق داده شد؛ دادهٔ registry بدون اجرای کدش خوانده شد                       |
| [Emil skill](https://emilkowal.ski/skill)                                                                                                               | ۱۶ مهارت عمومی مخزن اصلی و مجوزشان؛ محتوای خصوصی/پولی خریداری نشد                                                         |

## شمارش و محدودیت دقیق

۴۰۲ wrapper اصلی/جاری و دو انتخاب‌گر آرشیو نصب شدند. این عدد شامل اشاره‌گرهای
کاتالوگ نیز هست؛ به معنی ۴۰۲ قابلیت اجرایی کامل نیست. کاتالوگ جزئیات ۷۳۵ بدنهٔ
اصلی/مرجع را پوشش می‌دهد؛ نسخه‌های همسان و aliasها جدا ثبت شده‌اند.

۱۱ اشاره‌گر اولویت‌دار OpenDesign با منبع اصلی عمومی تکمیل شدند: ۲۵ wrapper تازه
از شش خانواده، و یک مورد یکسان از مجموعهٔ motion دوباره نصب نشد. ۷۴ اشاره‌گر دیگر
با محدودیت صریح باقی‌اند؛ ادعای دریافت بستهٔ کامل خارجیِ آن‌ها نمی‌شود. سه راهنمای
واقعاً مفقود در upstream و دو ایراد ارجاع نسبی motion در قفل ثبت شده‌اند.

همهٔ فایل‌های کپی‌شده پیش و پس از نصب با Git blob/SHA256 بررسی شدند؛ اسکریپت منبع
اجرا نشد. مجوزها شامل MIT، Apache-2.0، OFL و برخی مجوزهای شرطی/بدون اعلام‌اند؛
دانش نصب‌شده به معنی اجازهٔ بازنشر رسانه یا افزودن آن به محصول نیست. نسخه‌های
بازنشسته با جایگزینشان در آرشیو نگهداری شدند، نه به‌عنوان دستور فعال رقیب.

## هر مهارت کجا کاربرد دارد؟

دو کاتالوگ زیر برای تک‌تک ورودی‌ها هدف، مورد استفاده در Life OS، وضعیت، منبع
نسخه‌دار، مجوز و محدودیت می‌دهند:

- [کاتالوگ کامل طراحی و منابع اصلی تکمیلی](design-skills/GITHUB_CATALOG.md)
- [کاتالوگ کامل حرکت، انیمیشن و رسانه](design-skills/MOTION_CATALOG.md)
- [قرارداد اجرایی motion و حل اختلاف دستورها](design-skills/MOTION_CONTRACT.md)
- [قفل نسخه‌ها، هش‌ها و نگاشت aliasها](DESIGN_SKILLS_LOCK.json)

## انتخاب عملی برای این بازطراحی

| نیاز                          | مهارت و کاربرد مستقیم                                                                                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| هویت و تایپوگرافی             | frontend-design، reference-design-contract، design-system-baton و design-system-extract؛ حفظ بنفش Life OS، تعریف سطح و ریتم و فونت فارسی در DESIGN.md                        |
| رنگ و کنتراست                 | color-expert اصلی، accessibility-audit و fixing-accessibility؛ نقش رنگ معنایی و خوانایی در دو تم                                                                             |
| پوسته و موبایل                | app-shell-navigation، responsive-layout، platform-design و mobile-native؛ ناوبری قابل‌فهم، safe area، کنترل لمسی و RTL                                                       |
| تسک و اطلاعات متراکم          | hierarchy-rhythm-review، artifact-composition، craft-polish؛ عنوان خوانا، پرنت/فرزند واضح، toolbar منظم و متادیتای قابل‌اسکن                                                 |
| مالی و گزارش                  | chart-rendering، الگوهای data-table/dashboard؛ حفظ ریز اقلام، برچسب واقعی/برآورد/نامعلوم، نمودار با داده و واحد واقعی                                                        |
| فرم و دیالوگ                  | form-layout، accessibility-states، interaction-states-pass، empty-states و loading-skeleton؛ برچسب، فوکوس، درفت، خطای دقیق و حالت‌های کامل                                   |
| انتخاب حرکت                   | find-animation-opportunities، animation-vocabulary، animate، remove-animations و review-animations؛ انتخاب حرکت‌های کم‌تعداد با هدف مشخص                                     |
| اجرای حرکت                    | animation-systems، emil-design-eng، accessible-animation، animation-performance و fixing-motion-performance؛ مدت و easing واحد، CSS ساده و Motion برای رابطهٔ فضایی قابل‌قطع |
| نقد مستقل                     | design-review اصلی، polish-pass، ai-slop-check، hierarchy-rhythm و accessibility-audit؛ بررسی نتیجهٔ واقعی و اصلاح نقص قابل‌بازتولید                                         |
| رسانه، ۳بعدی و ابزارهای تخصصی | نصب و مستندسازی برای موقعیت مرتبط؛ مرجع شرطی هستند و موتورهای سنگین یا سرویس پولی به هستهٔ برنامه اضافه نمی‌کنند                                                             |

سیاست انتخاب: متن اصلی مهارت مرتبط کامل خوانده می‌شود؛ کپی مثال ناسازگار با SSR یا
Next فعلی اجرا نمی‌شود. منابع دربارهٔ stagger، blur، easing، router خصوصی و پرسیدن
تأیید اختلاف دارند؛ قرارداد پروژه و `../DESIGN.md` تصمیم نهایی را تعیین می‌کنند.
استفاده از دانش همهٔ خانواده‌ها به معنی اجرای هم‌زمان همهٔ سبک‌ها و موتورهایشان نیست.
