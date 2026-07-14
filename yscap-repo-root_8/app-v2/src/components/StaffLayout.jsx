import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { subscribeChat } from '../lib/chatEvents.js';
import { Brand } from './Layout.jsx';

const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin', underwriter: 'Underwriter',
  loan_officer: 'Loan Officer', loan_coordinator: 'Loan Coordinator',
  processor: 'Loan Processor', software_setup: 'Software Setup',
};

export default function StaffLayout({ children }) {
  const { signOut, role, can } = useAuth();
  const nav = useNavigate();
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = () => api.staffConversations()
      .then(r => alive && setUnread((r.conversations || []).reduce((n, c) => n + (c.unread || 0), 0)))
      .catch(() => {});
    poll();
    // Live: every unread:update carries the fresh account-wide total, so the
    // badge moves the instant a message lands or is read on ANY device. The
    // slow poll stays as a safety net for missed events.
    const unsub = subscribeChat((event, data) => {
      if (!alive) return;
      if (event === 'unread:update' && data && typeof data.totalUnread === 'number') setUnread(data.totalUnread);
      else if (event === 'message:new' || event === 'reconnect') poll();
      else if (event === 'notify' && data && data.urgent) {
        // Urgent re-ping: surface a lightweight toast even outside the chat.
        try {
          const el = document.createElement('div');
          el.className = 'cv-toast';
          el.textContent = `${data.title} — ${data.body || ''}`;
          el.onclick = () => { window.location.hash = '#' + (data.link || '/internal/chat'); el.remove(); };
          document.body.appendChild(el);
          setTimeout(() => el.remove(), 6000);
        } catch { /* cosmetic only */ }
      }
    });
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); unsub(); };
  }, []);
  const consoleLabel = (role === 'admin' || role === 'super_admin')
    ? 'Admin console' : `${ROLE_LABEL[role] || 'Internal'} console`;
  const canManageTeam = can('manage_team');
  const canManageConditions = can('manage_conditions');
  const canManageVendors = can('manage_vendors');
  const canDeleteFiles = can('delete_files');
  const canPlatformSetup = can('platform_setup');
  const canViewAudit = can('view_audit_log');
  const roleLabel = ROLE_LABEL[role] || role || 'Internal';
  return (
    <div className="app">
      <aside className={`app-sidebar ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <div className="app-brandrow">
          <Brand to="/internal" ariaLabel="PILOT by YS Capital — Internal" console={consoleLabel} />
        </div>
        <div className="sb-sec">Main</div>
        <NavLink className="sb-link" to="/internal" end><span className="ic" aria-hidden="true" />Pipeline</NavLink>
        <NavLink className="sb-link" to="/internal/tasks"><span className="ic" aria-hidden="true" />My tasks</NavLink>
        <NavLink className="sb-link" to="/internal/chat">
          <span className="ic" aria-hidden="true" />Chat
          {unread > 0 && <span className="sb-badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink className="sb-link" to="/internal/leads"><span className="ic" aria-hidden="true" />Leads</NavLink>

        <div className="sb-sec">Files</div>
        <NavLink className="sb-link" to="/internal/borrowers" title="Your borrowers — invite to PILOT, reset or set a password, see last login"><span className="ic" aria-hidden="true" />Borrowers</NavLink>
        {canManageConditions && <NavLink className="sb-link" to="/internal/conditions" title="Condition Center — the global condition library & rules"><span className="ic" aria-hidden="true" />Conditions</NavLink>}
        {canManageVendors && <NavLink className="sb-link" to="/internal/vendors" title="Title & insurance vendor directory"><span className="ic" aria-hidden="true" />Vendors</NavLink>}
        {canDeleteFiles && <NavLink className="sb-link" to="/internal/archived" title="Archived files — restore or delete permanently"><span className="ic" aria-hidden="true" />Archived</NavLink>}

        {(canManageTeam || canPlatformSetup || canViewAudit) && <div className="sb-sec">Admin</div>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/team"><span className="ic" aria-hidden="true" />Team</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/clickup" title="ClickUp Control Center — sync health, dry-run, backfill"><span className="ic" aria-hidden="true" />ClickUp</NavLink>}
        {canViewAudit && <NavLink className="sb-link" to="/internal/audit" title="System audit log — every action across every file & borrower"><span className="ic" aria-hidden="true" />Audit log</NavLink>}

        <div className="sb-spacer" />
        <div className="sb-foot">
          <span className="pill" title="Your role">{roleLabel}</span>
          <button className="btn ghost small" onClick={() => { signOut(); nav('/internal/login'); }}>Sign out</button>
        </div>
      </aside>
      {menuOpen && <div className="app-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}

      <header className="app-topbar">
        <button className="app-navtoggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
          aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
        <div className="app-search" aria-hidden="true">Search loans, borrowers, LLCs…</div>
        <div className="user-pill">
          <NavLink className="btn btn-gold btn-sm" to="/internal/new">+ New file</NavLink>
          <span className="chip" title="Your role">{roleLabel}</span>
        </div>
      </header>

      <main className="app-main">
        <div className="wrap">{children}</div>
        <footer className="wrap app-foot small muted">
          YS Capital Group · NMLS #2609746 · Internal console · Business-purpose lending only.
        </footer>
      </main>
    </div>
  );
}
