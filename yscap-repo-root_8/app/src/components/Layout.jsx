import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate, Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import InstallButton from './InstallButton.jsx';

const BRAND = import.meta.env.BASE_URL + 'brand/';

export function Brand({ console: consoleLabel = 'Borrower console', to = '/dashboard' }) {
  return (
    <Link to={to} className="brand" aria-label="YS Capital Group" style={{ textDecoration: 'none' }}>
      <img className="brand-mark" src={BRAND + 'mark-dark.png'} alt="" />
      <span className="brand-word">YS&nbsp;CAPITAL&nbsp;<em className="brand-group">GROUP</em></span>
      {consoleLabel && <span className="sub">{consoleLabel}</span>}
    </Link>
  );
}

/* Centered full lockup for the public auth cards (login / register / verify …). */
export function BrandLockup() {
  return (
    <div className="brand-lockup">
      <img src={BRAND + 'lockup-dark.png'} alt="YS Capital Group — the answer is yes" />
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
            <NavLink to="/track-record" title="Your investment experience — one record, linked to every file">Track record</NavLink>
            <NavLink to="/settings/notifications" title="Notification settings">Alerts</NavLink>
            <Link to="/dashboard" className="bell" title="Notifications">
              🔔{unread > 0 && <span className="badge">{unread}</span>}
            </Link>
            <InstallButton />
            <button className="btn link" onClick={() => { signOut(); nav('/login'); }}>Sign out</button>
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
