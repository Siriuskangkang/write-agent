'use client';

import Link from 'next/link';

export default function AuthShell({
  title,
  subtitle,
  footerPrompt,
  footerHref,
  footerLabel,
  children,
}: {
  title: string;
  subtitle: string;
  footerPrompt: string;
  footerHref: string;
  footerLabel: string;
  children: React.ReactNode;
}) {
  return (
    <div className="auth-shell-page">
      <div className="auth-shell-glow auth-shell-glow-left" />
      <div className="auth-shell-glow auth-shell-glow-right" />

      <div className="auth-shell-card">
        <div className="auth-shell-card-bar" />

        <div className="auth-shell-card-body">
          <div className="auth-shell-brand">
            <div className="auth-shell-brand-mark">
              <span />
              <span />
              <span />
            </div>
            <div className="auth-shell-brand-title">{title}</div>
            <div className="auth-shell-brand-subtitle">{subtitle}</div>
          </div>

          {children}

          <div className="auth-shell-footer-separator">
            <div />
            <span>{footerPrompt}</span>
            <div />
          </div>

          <Link href={footerHref} className="auth-shell-footer-link">
            {footerLabel}
          </Link>
        </div>
      </div>
    </div>
  );
}
