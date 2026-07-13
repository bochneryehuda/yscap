import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

export function Brand({ console: consoleLabel = 'Borrower console', to = '/dashboard', ariaLabel = 'PILOT by YS Capital' }) {
  return (
    <Link to={to} className="brand" aria-label={ariaLabel} style={{ textDecoration: 'none' }}>
      {/* PILOT co-brand lockup: gold navigation-chevron mark (CSS clip-path) +
          "PILOT" wordmark (Fraunces, tracked, ink) + quiet "by YS Capital"
          endorsement (muted, Hanken). White-first header, so ink-on-white. */}
      <span className="pilot-lockup" aria-hidden="true">
        <span className="pilot-mark" />
        <span className="pilot-stack">
          <span className="pilot-word">PILOT</span>
          <span className="pilot-by">by YS Capital</span>
        </span>
      </span>
      {consoleLabel && <span className="sub">{consoleLabel}</span>}
    </Link>
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
  const { signOut } = useAuth();
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    let live = true;
    api.notifications().then(r => {
      if (live) setUnread((r || []).filter(n => !n.read_at).length);
    }).catch(() => {});
    return () => { live = false; };
  }, []);

  return (
    <div className="shell">
      <header className="header">
        <div className="wrap">
          <Brand />
          <button className="nav-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
          {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
            <NavLink to="/dashboard">Dashboard</NavLink>
            <NavLink to="/apply">New application</NavLink>
            <NavLink to="/profile">Profile</NavLink>
            <NavLink to="/entities" title="Your LLCs — set up once, verified, reused on every loan">Entities</NavLink>
            <NavLink to="/track-record" title="Your investment experience — one record, linked to every file">Track record</NavLink>
            <NavLink to="/settings/notifications" title="Notification settings">Alerts</NavLink>
            <Link to="/dashboard" className="bell" title="Notifications"
              aria-label={unread > 0 ? `Notifications — ${unread} unread` : 'Notifications'}>
              🔔{unread > 0 && <span className="badge" aria-hidden="true">{unread}</span>}
            </Link>
            <button className="btn ghost small" onClick={() => { signOut(); nav('/login'); }}>Sign out</button>
          </nav>
        </div>
      </header>
      <main className="content"><div className="wrap">{children}</div></main>
      <footer className="wrap small muted" style={{ padding: '20px', borderTop: '1px solid var(--line)' }}>
        YS Capital Group · NMLS #2609746 · Brooklyn, NY · Business-purpose lending only.
      </footer>
    </div>
  );
}
