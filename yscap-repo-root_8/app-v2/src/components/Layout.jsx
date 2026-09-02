import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth, takeReturnTo } from '../lib/auth.jsx';
import ChatBubble from './ChatBubble.jsx';
import BorrowerViewBanner from './BorrowerViewBanner.jsx';
import AssistantBanner from './AssistantBanner.jsx';
import { useStaleBuild, StaleBuildBanner } from '../lib/useStaleBuild.jsx';

export function Brand({ console: consoleLabel = 'Borrower console', to = '/dashboard', ariaLabel = 'PILOT by YS Capital', external = false }) {
  // PILOT co-brand lockup: gold navigation-chevron mark (CSS clip-path) +
  // "PILOT" wordmark (Fraunces, tracked, ink) + quiet "by YS Capital"
  // endorsement (muted, Hanken). White-first header, so ink-on-white.
  const inner = (
    <>
      <span className="pilot-lockup" aria-hidden="true">
        <span className="pilot-mark" />
        <span className="pilot-stack">
          <span className="pilot-word">PILOT</span>
          <span className="pilot-by">by YS Capital</span>
        </span>
      </span>
      {consoleLabel && <span className="sub">{consoleLabel}</span>}
    </>
  );
  // external=true renders a plain <a> so the browser leaves the /portal/
  // HashRouter and lands on the marketing site (root "/").
  if (external) {
    return (
      <a href={to} className="brand" aria-label={ariaLabel} style={{ textDecoration: 'none' }}>{inner}</a>
    );
  }
  return (
    <Link to={to} className="brand" aria-label={ariaLabel} style={{ textDecoration: 'none' }}>{inner}</Link>
  );
}

/* Centered PILOT lockup for the public auth cards (login / register / verify …).
   The doorway shows the full "PILOT by YS Capital" endorsement. White-first
   auth card, so the ink wordmark reads on the white panel. */
export function BrandLockup() {
  return (
    <div className="brand-lockup" aria-label="PILOT by YS Capital">
      <span className="pilot-lockup pilot-lockup-lg" aria-hidden="true">
        <span className="pilot-mark" />
        <span className="pilot-stack">
          <span className="pilot-word">PILOT</span>
          <span className="pilot-by">by YS Capital</span>
        </span>
      </span>
    </div>
  );
}

export default function Layout({ children }) {
  const { signOut, isBorrowerView, exitBorrowerView, isAssistant } = useAuth();
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [taskCount, setTaskCount] = useState(0);   // outstanding to-dos → Tasks nav badge
  const [menuOpen, setMenuOpen] = useState(false);
  // Stale-build watchdog — EVERY layout shell mounts it (CLAUDE.md rule; the
  // borrower shell was missed when the staff shell got it — mega-audit #2).
  const staleBuild = useStaleBuild();

  useEffect(() => {
    let live = true;
    api.notifications().then(r => {
      if (live) setUnread((r || []).filter(n => !n.read_at).length);
    }).catch(() => {});
    // The Tasks nav carries a live count of what's waiting on the borrower
    // (owner-directed: the task list moved off the home page into its own Tasks
    // section, so the nav is now the at-a-glance signal). Fails quiet — a bad
    // load just hides the badge, never blanks the shell.
    api.actionItems().then(d => {
      if (live) setTaskCount(d && Array.isArray(d.items) ? d.items.length : 0);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <div className={`shell${isBorrowerView ? ' shell-bview' : ''}`}>
      {/* Pinned above everything: whose portal am I in, and the way out. */}
      <BorrowerViewBanner />
      <AssistantBanner />
      <StaleBuildBanner stale={staleBuild} />
      <header className="header">
        <div className="wrap">
          <Brand to="/" external />
          <button className="nav-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
          {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
            <NavLink to="/dashboard">Dashboard</NavLink>
            <NavLink to="/tasks" title="Everything waiting on you, across all your loans">
              Tasks{taskCount > 0 && <span className="nav-count" aria-hidden="true">{taskCount}</span>}
            </NavLink>
            <NavLink to="/apply">New application</NavLink>
            <NavLink to="/pricing" title="Price a loan and save scenarios — build a term sheet from your own numbers">Price a loan</NavLink>
            <NavLink to="/profile">Profile</NavLink>
            {!isAssistant && <NavLink to="/helpers" title="Give someone their own login to help with your loan">Helpers</NavLink>}
            <NavLink to="/entities" title="Your entities — set up once, verified, reused on every loan">Entities</NavLink>
            <NavLink to="/track-record" title="Your investment experience — one record, linked to every file">Track record</NavLink>
            <NavLink to="/settings/notifications" title="Notification settings">Alerts</NavLink>
            <Link to="/dashboard" className="bell" title="Notifications"
              aria-label={unread > 0 ? `Notifications — ${unread} unread` : 'Notifications'}>
              🔔{unread > 0 && <span className="badge" aria-hidden="true">{unread}</span>}
            </Link>
            {/* In a borrower view "Sign out" would revoke the REAL borrower's
                sessions (it bumps their token_version — it would knock them off
                their own phone mid-upload). The server refuses that call
                outright; here the button simply becomes the way back. */}
            {isBorrowerView
              ? <button className="btn ghost small" data-cobrowse-nodrive="view-as" onClick={async () => { const ok = await exitBorrowerView(); nav(ok ? (takeReturnTo() || '/internal/borrower-view') : '/internal/login'); }}>Leave borrower view</button>
              : <button className="btn ghost small" data-cobrowse-nodrive="sign-out" onClick={() => { signOut(); nav('/login'); }}>Sign out</button>}
          </nav>
        </div>
      </header>
      <main className="content"><div className="wrap">{children}</div></main>
      <footer className="wrap small muted" style={{ padding: '20px', borderTop: '1px solid var(--line)' }}>
        YS Capital Group · NMLS #2609746 · Brooklyn, NY · Business-purpose lending only.
      </footer>
      <ChatBubble mode="borrower" />
    </div>
  );
}
