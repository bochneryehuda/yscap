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
  const canManagePricing = can('manage_pricing');
  const canManageVendors = can('manage_vendors');
  const canDeleteFiles = can('delete_files');
  const canPlatformSetup = can('platform_setup');
  const canViewAudit = can('view_audit_log');
  return (
    <div className="shell">
      <header className="header">
        <div className="wrap">
          <Brand to="/internal" ariaLabel="YS Capital Group — Internal" console={consoleLabel} />
          <button className="nav-toggle" aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>{menuOpen ? '✕' : '☰'}</button>
          {menuOpen && <div className="nav-scrim" onClick={() => setMenuOpen(false)} aria-hidden="true" />}
          <nav className={`nav ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
            <NavLink to="/internal" end>Pipeline</NavLink>
            <NavLink to="/internal/tasks">My tasks</NavLink>
            <NavLink to="/internal/chat" style={{ position: 'relative' }}>
              Chat{unread > 0 && <span className="chat-badge nav">{unread > 99 ? '99+' : unread}</span>}
            </NavLink>
            <NavLink to="/internal/leads">Leads</NavLink>
            <NavLink to="/internal/borrowers" title="Your borrowers — invite to the portal, reset or set a password, see last login">Borrowers</NavLink>
            {canManageConditions && <NavLink to="/internal/conditions" title="Condition Center — the global condition library & rules">Conditions</NavLink>}
            {canManagePricing && <NavLink to="/internal/pricing" title="Pricing Admin Center — company-wide markup, origination & fee defaults">Pricing</NavLink>}
            {canManageTeam && <NavLink to="/internal/team">Team</NavLink>}
            {canManageVendors && <NavLink to="/internal/vendors" title="Title & insurance vendor directory">Vendors</NavLink>}
            {canDeleteFiles && <NavLink to="/internal/archived" title="Archived files — restore or delete permanently">Archived</NavLink>}
            {canPlatformSetup && <NavLink to="/internal/clickup" title="ClickUp Control Center — sync health, dry-run, backfill">ClickUp</NavLink>}
            {canViewAudit && <NavLink to="/internal/audit" title="System audit log — every action across every file & borrower">Audit log</NavLink>}
            <span className="pill" title="Your role">{ROLE_LABEL[role] || role || 'Internal'}</span>
            <button className="btn ghost small" onClick={() => { signOut(); nav('/internal/login'); }}>Sign out</button>
          </nav>
        </div>
      </header>
      <main className="content"><div className="wrap">{children}</div></main>
      <footer className="wrap small muted" style={{ padding: '20px', borderTop: '1px solid var(--line)' }}>
        YS Capital Group · NMLS #2609746 · Internal console · Business-purpose lending only.
      </footer>
    </div>
  );
}
