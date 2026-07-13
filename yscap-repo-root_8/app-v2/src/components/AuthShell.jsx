import React from 'react';
import { BrandLockup } from './Layout.jsx';

/* Split-screen shell for the public (pre-auth) screens — a deep-ink editorial
   left panel beside a white right panel that holds the actual form. Mirrors the
   approved blueprints (web/preview/pilot-login.html, pilot-staff-login.html,
   pilot-auth.html). Presentation only: the left panel is entirely static markup
   and the form is passed in as children unchanged.

   Used by Login, StaffLogin (variant="staff"), Verify, Forgot, Reset, Accept. */

const Check = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M1.5 6.2 4.4 9 10.5 2.6" stroke="#C9A86A" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export default function AuthShell({ title, subtitle, children, variant = 'borrower' }) {
  const staff = variant === 'staff';
  const ticks = staff
    ? ['Full pipeline & production', 'Condition Center', 'Audited PII access']
    : ['Live loan status', 'Secure document vault', 'Message your team'];

  return (
    <div className="auth-split">
      {/* LEFT · deep ink editorial brand panel (static) */}
      <section className="auth-brand">
        <div className="auth-brand-top">
          <BrandLockup />
          {staff && <span className="auth-brand-badge">Internal console</span>}
        </div>

        <div className="auth-brand-core">
          <div className="auth-eyebrow">
            {staff ? 'Staff & loan officers' : 'The borrower & staff platform'}
          </div>
          {staff
            ? <div className="auth-headline">The desk that keeps every deal <em>on course</em>.</div>
            : <div className="auth-headline">Navigate <em>every</em> deal.</div>}
          <p className="auth-support">
            {staff
              ? 'Sign in to the internal console — pipeline, conditions, documents and closing.'
              : 'Price, submit, and manage your financing in one place — with a clear line of sight from term sheet to funding.'}
          </p>
          <ul className="auth-ticks">
            {ticks.map((t) => (
              <li key={t}><span className="auth-tick-ic"><Check /></span>{t}</li>
            ))}
          </ul>
        </div>

        <div className="auth-brand-foot">
          <span className="auth-tag">“Navigate every deal.”</span>
          <div className="auth-legal">
            <b>{staff ? 'by YS Capital' : 'YS Capital'}</b>
            Equal Housing Lender · NMLS #2609746
          </div>
        </div>
      </section>

      {/* RIGHT · white form panel (holds the actual form) */}
      <section className="auth-form-panel">
        <div className="auth-form-top">
          <BrandLockup />
          <span className="auth-help">Need help?</span>
        </div>
        <div className="auth-form-mid">
          <div className="auth-card">
            {title && <h1>{title}</h1>}
            {subtitle && <p className="muted small" style={{ marginTop: 6 }}>{subtitle}</p>}
            <div style={{ marginTop: 18 }}>{children}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
