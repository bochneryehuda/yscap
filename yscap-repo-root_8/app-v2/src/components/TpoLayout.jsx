import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { Brand } from './Layout.jsx';
import TpoViewBanner from './TpoViewBanner.jsx';
import { useStaleBuild, StaleBuildBanner } from '../lib/useStaleBuild.jsx';

/* Shell for the broker (TPO) portal — the lightweight external surface. Modeled
   on the borrower Layout (header + brand + nav + sign out + footer), NOT the
   heavy internal StaffLayout: a broker gets a small, curated set of screens.
   The firm name is shown in the header sub, and the "Team" link appears only for
   a firm admin (who can invite their own processors). No borrower notifications
   or chat bubble here — those are borrower endpoints a tpo token cannot reach. */
export default function TpoLayout({ children }) {
  const { signOut, isTpoView, exitTpoView } = useAuth();
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

  // While an internal staffer is inside a broker view, the whole shell gets the
  // gold hairline (so even a screenshot reads as "this is a view") and the way
  // out is "Back to my console", not "Sign out" (which would try to log the real
  // broker out — the guard blocks it, but locally it would strand the staffer).
  const leaveView = async () => { const ok = await exitTpoView(); nav(ok ? '/internal/tpo-view' : '/internal/login', { replace: true }); };

  return (
    <div className={`shell${isTpoView ? ' shell-bview' : ''}`}>
      <StaleBuildBanner stale={staleBuild} />
      <TpoViewBanner />
      <header className="header">
        <div className="wrap">
          <Brand to="/tpo" console={firmName} ariaLabel="PILOT by YS Capital — Broker portal" />
          <button className="nav-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
          {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
            <NavLink to="/tpo" end>Pipeline</NavLink>
            <NavLink to="/tpo/borrowers">Borrowers</NavLink>
            <NavLink to="/tpo/new">Enter a loan</NavLink>
            {isFirmAdmin && <NavLink to="/tpo/team" title="Your firm's users — invite your processors">Team</NavLink>}
            {isTpoView
              ? <button className="btn ghost small" onClick={leaveView}>← Back to my console</button>
              : <button className="btn ghost small" onClick={() => { signOut(); nav('/tpo/login'); }}>Sign out</button>}
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
