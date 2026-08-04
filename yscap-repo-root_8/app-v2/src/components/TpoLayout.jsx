import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Brand } from './Layout.jsx';
import { useStaleBuild, StaleBuildBanner } from '../lib/useStaleBuild.jsx';

/* Shell for the broker (TPO) portal — the lightweight external surface. Modeled
   on the borrower Layout (header + brand + nav + sign out + footer), NOT the
   heavy internal StaffLayout: a broker gets a small, curated set of screens.
   The firm name is shown in the header sub, and the "Team" link appears only for
   a firm admin (who can invite their own processors). No borrower notifications
   or chat bubble here — those are borrower endpoints a tpo token cannot reach. */
export default function TpoLayout({ children }) {
  const { signOut } = useAuth();
  const nav = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [me, setMe] = useState(null);   // { firm:{name,status}, is_firm_admin, full_name }
  const staleBuild = useStaleBuild();   // stale-build watchdog (CLAUDE.md rule — every shell mounts it)

  useEffect(() => {
    let live = true;
    api.tpoMe().then(r => { if (live) setMe(r || null); }).catch(() => {});
    return () => { live = false; };
  }, []);

  const firmName = me?.firm?.name || 'Broker portal';
  const isFirmAdmin = !!me?.is_firm_admin;

  return (
    <div className="shell">
      <StaleBuildBanner stale={staleBuild} />
      <header className="header">
        <div className="wrap">
          <Brand to="/tpo" console={firmName} ariaLabel="PILOT by YS Capital — Broker portal" />
          <button className="nav-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
          {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
            <NavLink to="/tpo" end>Pipeline</NavLink>
            {isFirmAdmin && <NavLink to="/tpo/team" title="Your firm's users — invite your processors">Team</NavLink>}
            <button className="btn ghost small" onClick={() => { signOut(); nav('/tpo/login'); }}>Sign out</button>
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
