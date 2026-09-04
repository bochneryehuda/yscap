import React from 'react';
import { BrandLockup } from './Layout.jsx';
import { authVariantFlags } from '../lib/authVariant.js';

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
  /* PILOT ENGINE is the SAME staff sign-in wearing its own name (owner-directed
     2026-09-04: *"the log in page should have a regular pilot design of the
     pilot log in page but some added design for the new name"*). It is a
     VARIANT, never a second login screen — the form, the endpoint, the lockout
     counting and the accounts are all `StaffLogin`'s, untouched.

     The staff-only pieces of this panel — the badge, the "by YS Capital"
     endorsement — must stay true for the engine, or adding a name would quietly
     turn its door into the BORROWER panel and tell a loan officer this is the
     borrower platform. That rule lives in `lib/authVariant.js` so it can be
     PROVEN by calling it rather than pinned by reading this line. */
  const { engine, staff, tpo } = authVariantFlags(variant);
  const ticks = engine
    ? ['Every board, side by side', 'Scenarios, brackets & rate sheets', 'Straight to the pricer — no menus']
    : staff
      ? ['Full pipeline & production', 'Condition Center', 'Audited PII access']
      : tpo
        ? ['Price & register your deals', 'Order title, credit & appraisal', 'Track every file to funding']
        : ['Live loan status', 'Secure document vault', 'Message your team'];

  return (
    <div className="auth-split">
      {/* LEFT · deep ink editorial brand panel (static) */}
      <section className="auth-brand">
        <div className="auth-brand-top">
          <BrandLockup />
          {staff && <span className="auth-brand-badge">{engine ? 'Pilot Engine' : 'Internal console'}</span>}
          {tpo && <span className="auth-brand-badge">Broker portal</span>}
        </div>

        <div className="auth-brand-core">
          <div className="auth-eyebrow">
            {engine ? 'The pricing engine' : staff ? 'Staff & loan officers' : tpo ? 'Broker & wholesale partners' : 'The borrower & staff platform'}
          </div>
          {engine
            ? <div className="auth-headline">Every board, <em>one screen</em>.</div>
            : staff
              ? <div className="auth-headline">The desk that keeps every deal <em>on course</em>.</div>
              : tpo
                ? <div className="auth-headline">Originate <em>every</em> deal with us.</div>
                : <div className="auth-headline">Navigate <em>every</em> deal.</div>}
          <p className="auth-support">
            {engine
              ? 'Sign in with your usual PILOT account — the same one you use for the console. Pilot Engine opens straight onto the pricer.'
              : staff
                ? 'Sign in to the internal console — pipeline, conditions, documents and closing.'
                : tpo
                  ? 'Sign in to the broker portal — price, register, and manage the loans you bring to YS Capital.'
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
            <b>{staff || tpo ? 'by YS Capital' : 'YS Capital'}</b>
            Equal Housing Lender · NMLS #2609746
          </div>
        </div>
      </section>

      {/* RIGHT · white form panel (holds the actual form) */}
      <section className="auth-form-panel">
        <div className="auth-form-top">
          <BrandLockup />
          <span style={{ display: 'inline-flex', gap: '16px', alignItems: 'center' }}>
            {/* Back to the marketing home (leaves the /portal/ SPA) + a working
                Need-help mailto (was a dead <span>) — owner-directed 2026-07-14. */}
            <a className="auth-help" href="/" aria-label="Back to the yscapgroup.com home page">&larr; Back to home</a>
            <a className="auth-help" href="mailto:pilot@yscapgroup.com">Need help?</a>
          </span>
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
