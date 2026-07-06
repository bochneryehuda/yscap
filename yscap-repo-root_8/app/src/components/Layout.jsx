import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

const BRAND = import.meta.env.BASE_URL + 'brand/';

export function Brand({ console: consoleLabel = 'Borrower console', to = '/dashboard', ariaLabel = 'YS Capital Group' }) {
  return (
    <Link to={to} className="brand" aria-label={ariaLabel} style={{ textDecoration: 'none' }}>
      <img className="brand-mark" src={BRAND + 'mark-dark.png'} alt="" />
      <span className="brand-word">YS&nbsp;CAPITAL&nbsp;<span className="brand-group">GROUP</span></span>
      {consoleLabel && <span className="sub">{consoleLabel}</span>}
    </Link>
  );
}

/* Centered lockup for the public auth cards (login / register / verify …).
   A TEXT wordmark — not the logo image — so "YS CAPITAL GROUP" reads at one
   uniform size (GROUP set apart only by the brand teal), matching the header.
   The old image baked GROUP in as a smaller suffix, which couldn't be sized
   with CSS. */
export function BrandLockup() {
  return (
    <div className="brand-lockup" aria-label="YS Capital Group">
      <img className="brand-lockup-mark" src={BRAND + 'mark-dark.png'} alt="" />
      <div className="brand-lockup-word">YS&nbsp;CAPITAL&nbsp;<span className="brand-group">GROUP</span></div>
      <div className="brand-lockup-tag">The answer is yes.</div>
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
