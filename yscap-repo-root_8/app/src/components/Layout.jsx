import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const BRAND = import.meta.env.BASE_URL + 'brand/';

export function Brand({ console: consoleLabel = 'Borrower console', to = '/dashboard', ariaLabel = 'YS Capital Group' }) {
  return (
    <Link to={to} className="brand" aria-label={ariaLabel} style={{ textDecoration: 'none' }}>
      {/* OWNER DECISION (2026-07-07): header uses the real full logo image too
          (matching the redesigned login), not the small mark + typed wordmark.
          WHITE-FIRST REDESIGN (2026-07-08): the header is now white, so use the
          light-background lockup (dark mark) — lockup-dark (light mark) would be
          invisible on white. */}
      <img className="brand-logo" src={BRAND + 'lockup-light.png'} alt="YS Capital Group" />
      {consoleLabel && <span className="sub">{consoleLabel}</span>}
    </Link>
  );
}

/* Centered lockup for the public auth cards (login / register / verify …).
   OWNER DECISION (2026-07-07): use the real full logo image here instead of a
   typed wordmark — the small mark + typed name read as unprofessional.
   WHITE-FIRST REDESIGN (2026-07-08): the auth card is now white, so use the
   light-background lockup (dark mark + tagline). The dark-optimised lockup
   (light mark on transparent) would nearly disappear on the white card. */
export function BrandLockup() {
  return (
    <div className="brand-lockup" aria-label="YS Capital Group">
      <img className="brand-lockup-img" src={BRAND + 'lockup-light.png'} alt="YS Capital Group" />
    </div>
  );
}

export default function Layout({ children }) {
  const { signOut } = useAuth();
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);

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
          <nav className="nav">
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
