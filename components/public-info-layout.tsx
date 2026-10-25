import Link from "next/link";
import type { ReactNode } from "react";

export function PublicInfoLayout({
  children,
  title,
  eyebrow,
}: {
  children: ReactNode;
  title: string;
  eyebrow: string;
}) {
  return (
    <main className="public-info-page">
      <div className="public-info-wrap">
        <header className="public-info-header">
          <Link
            className="brand"
            href="/about"
            aria-label="Ramin Life OS — دربارهٔ برنامه"
          >
            <span className="brand-symbol" aria-hidden="true">
              r<span>o</span>
            </span>
            <span>
              <strong>Ramin Life OS</strong>
              <small>فضا برای چیزهای مهم</small>
            </span>
          </Link>
          <Link className="public-info-sign-in" href="/login">
            ورود به برنامه
          </Link>
        </header>

        <article className="public-info-card">
          <p className="public-info-eyebrow">{eyebrow}</p>
          <h1>{title}</h1>
          {children}
        </article>

        <footer className="public-info-footer">
          <nav aria-label="صفحه‌های عمومی">
            <Link href="/about">دربارهٔ برنامه</Link>
            <Link href="/privacy">حریم خصوصی</Link>
            <Link href="/terms">شرایط استفاده</Link>
          </nav>
          <span>Ramin Life OS</span>
        </footer>
      </div>
    </main>
  );
}
