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

/* Sidebar nav line-icons (18px, currentColor stroke). One per nav item — the
   blueprint's ds.css `.ic` is an 18px icon slot; the preview HTML used colour
   swatches as placeholders. These are the real icons that slot fills. Purely
   presentational — inherit .sb-link colour (muted → ink on hover, gold when
   active). */
const NAV_ICON = {
  pipeline: <><rect x="3" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="m8.5 12 2.2 2.2 4.8-4.7" /></>,
  chat: <path d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 15h-7l-4 4v-4H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4Z" />,
  leads: <><circle cx="9" cy="8" r="3.5" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M18.5 7.5v5M21 10h-5" /></>,
  borrowers: <><circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  conditions: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6H9V4.5Z" /><path d="m9 13 2 2 4-4" /></>,
  pricing: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M14.5 9.2c-.6-.7-1.6-1-2.6-1-1.4 0-2.4.8-2.4 1.9 0 2.6 5.2 1.4 5.2 4 0 1.2-1.1 2-2.6 2-1.1 0-2.1-.4-2.7-1.1" /></>,
  vendors: <><rect x="3" y="7.5" width="18" height="12.5" rx="2" /><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" /><path d="M3 12.5h18" /></>,
  archived: <><rect x="3.5" y="4" width="17" height="4.5" rx="1" /><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" /><path d="M10 12.5h4" /></>,
  team: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3 19a6 6 0 0 1 12 0" /><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17 14.2A6 6 0 0 1 21 19" /></>,
  clickup: <><path d="M20.5 11a8.5 8.5 0 0 0-14.4-5L3 9" /><path d="M3.5 13a8.5 8.5 0 0 0 14.4 5L21 15" /><path d="M3 4v5h5M21 20v-5h-5" /></>,
  audit: <><path d="M12 3.5 5.5 6v5.2c0 4.1 2.8 6.9 6.5 8.3 3.7-1.4 6.5-4.2 6.5-8.3V6L12 3.5Z" /><path d="m9.2 11.8 2 2 3.6-3.6" /></>,
};
function NavIcon({ name }) {
  return (
    <span className="ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round">{NAV_ICON[name]}</svg>
    </span>
  );
}

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
  const roleLabel = ROLE_LABEL[role] || role || 'Internal';
  return (
    <div className="app">
      <aside className={`app-sidebar ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <div className="app-brandrow">
          <Brand to="/internal" ariaLabel="PILOT by YS Capital — Internal" console={consoleLabel} />
        </div>
        <div className="sb-sec">Main</div>
        <NavLink className="sb-link" to="/internal" end><NavIcon name="pipeline" />Pipeline</NavLink>
        <NavLink className="sb-link" to="/internal/tasks"><NavIcon name="tasks" />My tasks</NavLink>
        <NavLink className="sb-link" to="/internal/chat">
          <NavIcon name="chat" />Chat
          {unread > 0 && <span className="sb-badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink className="sb-link" to="/internal/leads"><NavIcon name="leads" />Leads</NavLink>

        <div className="sb-sec">Files</div>
        <NavLink className="sb-link" to="/internal/borrowers" title="Your borrowers — invite to PILOT, reset or set a password, see last login"><NavIcon name="borrowers" />Borrowers</NavLink>
        {canManageConditions && <NavLink className="sb-link" to="/internal/conditions" title="Condition Center — the global condition library & rules"><NavIcon name="conditions" />Conditions</NavLink>}
        {canManageVendors && <NavLink className="sb-link" to="/internal/vendors" title="Title & insurance vendor directory"><NavIcon name="vendors" />Vendors</NavLink>}
        {canDeleteFiles && <NavLink className="sb-link" to="/internal/archived" title="Archived files — restore or delete permanently"><NavIcon name="archived" />Archived</NavLink>}

        {(canManageTeam || canManagePricing || canPlatformSetup || canViewAudit) && <div className="sb-sec">Admin</div>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/team"><NavIcon name="team" />Team</NavLink>}
        {canManagePricing && <NavLink className="sb-link" to="/internal/pricing" title="Pricing Admin Center — company-wide markup, origination & fee defaults"><NavIcon name="pricing" />Pricing</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/clickup" title="ClickUp Control Center — sync health, dry-run, backfill"><NavIcon name="clickup" />ClickUp</NavLink>}
        {canViewAudit && <NavLink className="sb-link" to="/internal/audit" title="System audit log — every action across every file & borrower"><NavIcon name="audit" />Audit log</NavLink>}

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
        <div className="app-search" aria-hidden="true">
          <svg className="app-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.4-3.4" />
          </svg>
          <span>Search loans, borrowers, LLCs…</span>
        </div>
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
