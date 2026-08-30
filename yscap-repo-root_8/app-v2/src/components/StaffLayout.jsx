import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import { api } from '../lib/api.js';
import { subscribeChat } from '../lib/chatEvents.js';
import { arena as arenaApi } from '../lib/arena.js';
import { Brand } from './Layout.jsx';
// LONG-TERM — the product switch. This is the mount seam the owner authorized on
// 2026-08-14 ("rtl-import app-v2/src/components/StaffLayout.jsx" in the ledger);
// the component itself lives in Long-Term's own folder and imports nothing from
// RTL. It renders nothing at all when the long-term side is unreachable, so an
// officer who has never heard of it is never shown a broken control.
import ProductSwitch from '../longterm/ProductSwitch.jsx';
import ChatBubble from './ChatBubble.jsx';
import { useStaleBuild } from '../lib/useStaleBuild.jsx';
import { RESEARCH_PAGES, inResearch as isResearchPath } from './ResearchNav.jsx';

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
  dashboards: <><path d="M3.6 16.5a9 9 0 1 1 16.8 0" /><path d="m12 13 4.2-3.6" /><circle cx="12" cy="13" r="1.4" /></>,
  pipeline: <><rect x="3" y="4" width="4" height="16" rx="1" /><rect x="10" y="4" width="4" height="11" rx="1" /><rect x="17" y="4" width="4" height="7" rx="1" /></>,
  tasks: <><rect x="4" y="4" width="16" height="16" rx="2.5" /><path d="m8.5 12 2.2 2.2 4.8-4.7" /></>,
  // An open ledger — the long-term census. Its own glyph rather than a borrowed
  // one: `NavIcon` renders `NAV_ICON[name]` straight into the <svg>, so a name
  // with no entry draws an EMPTY icon and leaves a nav item looking broken.
  book: <><path d="M12 6.5v13" /><path d="M12 6.5C10.4 5.2 8.4 4.6 5.5 4.6a1 1 0 0 0-1 1v11.3a1 1 0 0 0 1 1c2.9 0 4.9.6 6.5 1.9" /><path d="M12 6.5c1.6-1.3 3.6-1.9 6.5-1.9a1 1 0 0 1 1 1v11.3a1 1 0 0 1-1 1c-2.9 0-4.9.6-6.5 1.9" /></>,
  workflow: <><circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="7" r="2.2" /><circle cx="12" cy="17" r="2.2" /><path d="M8.2 7h7.6M6.6 9.1 11 14.8M17.4 9.1 13 14.8" /></>,
  chat: <path d="M5 4h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 15h-7l-4 4v-4H5a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 5 4Z" />,
  leads: <><circle cx="9" cy="8" r="3.5" /><path d="M3.5 19a5.5 5.5 0 0 1 11 0" /><path d="M18.5 7.5v5M21 10h-5" /></>,
  borrowers: <><circle cx="12" cy="8" r="4" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  // Borrower view — an eye over a person: "look through their eyes".
  borrowerView: <><path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" /><circle cx="12" cy="12" r="2.6" /></>,
  conditions: <><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6H9V4.5Z" /><path d="m9 13 2 2 4-4" /></>,
  pricing: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10" /><path d="M14.5 9.2c-.6-.7-1.6-1-2.6-1-1.4 0-2.4.8-2.4 1.9 0 2.6 5.2 1.4 5.2 4 0 1.2-1.1 2-2.6 2-1.1 0-2.1-.4-2.7-1.1" /></>,
  vendors: <><rect x="3" y="7.5" width="18" height="12.5" rx="2" /><path d="M8.5 7.5V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v1.5" /><path d="M3 12.5h18" /></>,
  archived: <><rect x="3.5" y="4" width="17" height="4.5" rx="1" /><path d="M5 8.5V19a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8.5" /><path d="M10 12.5h4" /></>,
  team: <><circle cx="9" cy="8.5" r="3.2" /><path d="M3 19a6 6 0 0 1 12 0" /><path d="M16 5.6a3.2 3.2 0 0 1 0 5.8" /><path d="M17 14.2A6 6 0 0 1 21 19" /></>,
  clickup: <><path d="M20.5 11a8.5 8.5 0 0 0-14.4-5L3 9" /><path d="M3.5 13a8.5 8.5 0 0 0 14.4 5L21 15" /><path d="M3 4v5h5M21 20v-5h-5" /></>,
  audit: <><path d="M12 3.5 5.5 6v5.2c0 4.1 2.8 6.9 6.5 8.3 3.7-1.4 6.5-4.2 6.5-8.3V6L12 3.5Z" /><path d="m9.2 11.8 2 2 3.6-3.6" /></>,
  esign: <><path d="M4 17.5c1.8-.4 2.6-2.2 3.4-4.3.7-2 1.3-4.2 2.3-4.2.8 0 .9 1.2.7 2.8-.3 2-.8 3.9 0 4.4.9.6 2-.7 2.8-1.6" /><path d="M14 20h6" /></>,
  emails: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  health: <><path d="M3 12h3.5l2-5.5 3.5 11 2.5-6 1.5 3H21" /></>,
  // A gear. An unknown icon name renders an EMPTY svg rather than failing, so a
  // missing entry is invisible until somebody notices a blank square in the nav.
  settings: <><circle cx="12" cy="12" r="3.2" /><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" /></>,
};
function NavIcon({ name }) {
  return (
    <span className="ic" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round">{NAV_ICON[name]}</svg>
    </span>
  );
}

// --- Top-bar global search (omnibox) -------------------------------------
// Real, working search across loans, borrowers, and LLCs. Replaces the old
// dead aria-hidden placeholder ("not functioning at all"). Debounced, keyboard
// friendly (↑/↓/Enter/Esc), closes on outside-click, and navigates to the file,
// borrower, or the LLC's owning borrower on select.
const searchAddr = (a) => !a ? '' : (a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', ') || '');
const STATUS_LABEL = {
  file_intake: 'Intake',
  new: 'New', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting',
  approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded',
  on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};
const DEAL_LABEL = {
  flip: 'Fix & Flip', 'fix-and-hold': 'Fix & Hold', 'ground-up': 'Ground-up', rental: 'Rental',
};

function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [res, setRes] = useState(null);   // { loans, borrowers, llcs, trackRecords, officers, tasks, chats } | null
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(-1); // index into the flat results list
  const boxRef = useRef(null);
  const inputRef = useRef(null);

  // Flatten the grouped results into one ordered list for keyboard nav + Enter.
  // Order here == render order below, so ↑/↓ walk the visible list top-to-bottom.
  const flat = [];
  if (res) {
    (res.loans || []).forEach(l => flat.push({ kind: 'loan', to: `/internal/app/${l.id}`, row: l }));
    (res.borrowers || []).forEach(b => flat.push({ kind: 'borrower', to: `/internal/borrowers/${b.id}`, row: b }));
    (res.llcs || []).forEach(l => flat.push({ kind: 'llc', to: `/internal/borrowers/${l.borrower_id}`, row: l }));
    (res.trackRecords || []).forEach(t => flat.push({ kind: 'track', to: `/internal/borrowers/${t.borrower_id}`, row: t }));
    (res.tasks || []).forEach(t => flat.push({ kind: 'task', to: `/internal/app/${t.application_id}`, row: t }));
    (res.chats || []).forEach(c => flat.push({ kind: 'chat', to: `/internal/chat?c=${c.id}`, row: c }));
    (res.officers || []).forEach(o => flat.push({ kind: 'officer', to: `/internal?officerId=${o.id}`, row: o }));
  }

  // Debounced fetch. Min 2 chars; races are guarded by a per-call token.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setRes(null); setBusy(false); return undefined; }
    setBusy(true);
    let alive = true;
    const t = setTimeout(() => {
      api.staffGlobalSearch(term)
        .then(r => { if (alive) { setRes(r); setActive(-1); } })
        .catch(() => { if (alive) setRes({ loans: [], borrowers: [], llcs: [], trackRecords: [], officers: [], tasks: [], chats: [] }); })
        .finally(() => { if (alive) setBusy(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const go = (item) => {
    if (!item) return;
    setOpen(false); setQ(''); setRes(null);
    nav(item.to);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { setOpen(false); inputRef.current && inputRef.current.blur(); return; }
    if (!flat.length) { if (e.key === 'Enter') e.preventDefault(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(flat.length - 1, i + 1)); setOpen(true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); go(flat[active >= 0 ? active : 0]); }
  };

  const hasResults = flat.length > 0;
  const showPanel = open && q.trim().length >= 2;

  return (
    <div className="app-search" ref={boxRef} role="search">
      <svg className="app-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <circle cx="11" cy="11" r="7" /><path d="m20 20-3.4-3.4" />
      </svg>
      <input
        ref={inputRef}
        className="app-search-in"
        type="search"
        value={q}
        placeholder="Search loans, borrowers, entities, REO, tasks, chats, team…"
        aria-label="Search loans, borrowers, entities, track records, officers, tasks, and chats"
        autoComplete="off"
        onChange={e => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKey}
      />
      {showPanel && (
        <div className="app-search-panel" role="listbox">
          {busy && !hasResults && <div className="ass-empty">Searching…</div>}
          {!busy && !hasResults && <div className="ass-empty">No matches for “{q.trim()}”.</div>}
          {(res && res.loans && res.loans.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Loans</div>
              {res.loans.map((l) => {
                const idx = flat.findIndex(f => f.kind === 'loan' && f.row.id === l.id);
                return (
                  <button key={`loan-${l.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{l.first_name} {l.last_name}</span>
                    <span className="ass-s">{searchAddr(l.property_address) || (l.ys_loan_number || 'Loan # pending')}
                      {' · '}{STATUS_LABEL[l.status] || l.status}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.borrowers && res.borrowers.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Borrowers</div>
              {res.borrowers.map((b) => {
                const idx = flat.findIndex(f => f.kind === 'borrower' && f.row.id === b.id);
                return (
                  <button key={`bor-${b.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{b.first_name} {b.last_name}</span>
                    <span className="ass-s">{b.email || b.cell_phone || 'Borrower'}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.llcs && res.llcs.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Entities</div>
              {res.llcs.map((l) => {
                const idx = flat.findIndex(f => f.kind === 'llc' && f.row.id === l.id);
                return (
                  <button key={`llc-${l.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{l.llc_name}</span>
                    <span className="ass-s">Owned by {l.first_name} {l.last_name}{l.ein ? ` · EIN ${l.ein}` : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.trackRecords && res.trackRecords.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Track records (REO)</div>
              {res.trackRecords.map((t) => {
                const idx = flat.findIndex(f => f.kind === 'track' && f.row.id === t.id);
                return (
                  <button key={`tr-${t.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{searchAddr(t.property_address) || 'Property'}</span>
                    <span className="ass-s">{DEAL_LABEL[t.deal_type] || t.deal_type || 'Project'}
                      {' · '}{t.first_name} {t.last_name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.tasks && res.tasks.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Tasks &amp; reminders</div>
              {res.tasks.map((t) => {
                const idx = flat.findIndex(f => f.kind === 'task' && f.row.id === t.id);
                return (
                  <button key={`task-${t.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{t.title}</span>
                    <span className="ass-s">{t.first_name} {t.last_name}
                      {searchAddr(t.property_address) ? ` · ${searchAddr(t.property_address)}` : ''}
                      {t.status ? ` · ${t.status}` : ''}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.chats && res.chats.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Chats</div>
              {res.chats.map((c) => {
                const idx = flat.findIndex(f => f.kind === 'chat' && f.row.id === c.id);
                return (
                  <button key={`chat-${c.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{c.name}</span>
                    <span className="ass-s">{c.first_name} {c.last_name}</span>
                  </button>
                );
              })}
            </div>
          )}
          {(res && res.officers && res.officers.length > 0) && (
            <div className="ass-group">
              <div className="ass-h">Team</div>
              {res.officers.map((o) => {
                const idx = flat.findIndex(f => f.kind === 'officer' && f.row.id === o.id);
                return (
                  <button key={`off-${o.id}`} type="button"
                    className={`ass-item ${active === idx ? 'on' : ''}`}
                    onMouseEnter={() => setActive(idx)} onClick={() => go(flat[idx])}>
                    <span className="ass-t">{o.full_name}</span>
                    <span className="ass-s">{o.title || ROLE_LABEL[o.role] || o.role}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function StaffLayout({ children }) {
  const { signOut, role, can, exitStaffView } = useAuth();
  // THE ARENA. Its nav entry exists ONLY while the master switch is on, and
  // `seesArena` is the server's answer -- never a role check here, or the rule
  // "when it's off, nobody should even see it" would have two definitions and
  // the browser's copy would be the one that goes stale. Declared here, above
  // the effect that fills it, so the hooks read top to bottom.
  const [arenaVis, setArenaVis] = useState(null);
  const nav = useNavigate();
  // The research desk's pages only appear in the sidebar while you are inside it,
  // so seven entries collapse to one without hiding where you can go from here.
  const inResearch = isResearchPath(useLocation().pathname);
  // LONG-TERM: which side is on screen. The owner's switch "swaps the whole nav" —
  // the two products are two systems, so showing RTL's nav beside a long-term
  // pipeline would say the opposite of what the separation means.
  const onLongTerm = useLocation().pathname.startsWith('/internal/lt');
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  // Open sync-review count (scoped server-side: an LO sees THEIR rows' count).
  const [reviewCount, setReviewCount] = useState(0);
  // Pending manual-product escalations (super-admin approval queue).
  const [escCount, setEscCount] = useState(0);
  const [excCount, setExcCount] = useState(0);
  // How many files are in MY personal Workflow right now (everyone has one).
  const [wfCount, setWfCount] = useState(0);
  // My open scheduled tasks/reminders — OVERDUE drives the red badge, open the grey one (2.0).
  const [taskCounts, setTaskCounts] = useState(null);
  // Open finding-escalations routed to me (my role / assigned / raised) — the workload badge.
  const [fescCount, setFescCount] = useState(0);
  // My Notification Center draft queue — how many parked notifications are waiting for me to Send.
  const [notifDraftCount, setNotifDraftCount] = useState(0);
  const [myExcCount, setMyExcCount] = useState(0);
  const [trReviewCount, setTrReviewCount] = useState(0);
  const [closingCount, setClosingCount] = useState(0);
  // Files still OUTSTANDING on the purchasing desk (admins + closers).
  const [purchasingCount, setPurchasingCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const poll = () => {
      api.workflowCount().then(r => { if (alive) setWfCount((r && r.total) || 0); }).catch(() => {});
      api.staffReminderTaskCounts().then(r => { if (alive) setTaskCounts((r && r.counts) || null); }).catch(() => {});
      api.myExceptionsCount().then(r => { if (alive) setMyExcCount((r && r.openCount) || 0); }).catch(() => {});
      api.staffTrackRecordReviewsCount().then(r => { if (alive) setTrReviewCount((r && r.pending) || 0); }).catch(() => {});
      api.closingCount().then(r => { if (alive) setClosingCount((r && r.count) || 0); }).catch(() => {});
      // Gated: unlike /closing/count this endpoint is capability-gated, so polling
      // it for everyone would 403 on load and again every 2 minutes for every LO,
      // processor and underwriter in the company.
      if (can('manage_purchasing')) api.purchasingCount().then(r => { if (alive) setPurchasingCount((r && r.count) || 0); }).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); };
    // `can` is memoized on the permission list, so this re-runs once when perms
    // arrive — without it the capability check would be frozen at its mount-time
    // value (false) and the purchasing badge would never appear.
  }, [can]);
  useEffect(() => {
    let alive = true;
    const poll = () => api.get('/api/staff/sync-reviews/count')
      .then(r => { if (alive) setReviewCount(r.open || 0); }).catch(() => {});
    poll();
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => {
    // Every staffer can have findings escalated to them (their role / assigned / raised),
    // so everyone polls their own scoped count.
    let alive = true;
    const poll = () => api.findingEscalationsCount()
      .then(r => { if (alive) setFescCount((r && r.pendingCount) || 0); }).catch(() => {});
    poll();
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  useEffect(() => {
    let alive = true;
    // Poll the pending-drafts count every 30s + on window focus so the nav
    // badge stays LIVE — matches the Drafts tab's own auto-refresh cadence.
    const poll = () => api.loNotifDraftCount()
      .then((r) => { if (alive) setNotifDraftCount((r && r.pending) || 0); }).catch(() => {});
    poll();
    const t = setInterval(poll, 30_000);
    const onFocus = () => poll();
    window.addEventListener('focus', onFocus);
    return () => { alive = false; clearInterval(t); window.removeEventListener('focus', onFocus); };
  }, []);
  useEffect(() => {
    // Only admins / super-admins see (and can load) the escalation box, so only
    // they poll its count — a file-scoped LO/processor never hits the endpoint.
    if (!(can('manage_pricing') || role === 'super_admin')) return undefined;
    let alive = true;
    const poll = () => {
      api.manualEscalationsCount().then(r => { if (alive) setEscCount(r.pendingCount || 0); }).catch(() => {});
      api.loanExceptionsCount().then(r => { if (alive) setExcCount((r && r.pendingCount) || 0); }).catch(() => {});
    };
    poll();
    const t = setInterval(poll, 120000);
    return () => { alive = false; clearInterval(t); };
  }, [role]);
  // STALE-BUILD WATCHDOG — shared hook (see lib/useStaleBuild.js): compares
  // the deployed bundle hash from /api/health with the one this tab runs.
  const staleBuild = useStaleBuild();
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

  // Ask once on load, and again whenever the switch is flipped -- the server
  // broadcasts that to every open tab, so turning it off really does clear
  // everybody's window rather than waiting for their next refresh.
  useEffect(() => {
    let alive = true;
    const ask = () => { arenaApi.visibility().then((v) => { if (alive) setArenaVis(v); }).catch(() => {}); };
    ask();
    const unsub = subscribeChat((event) => {
      if (event === 'arena:switch' || event === 'arena:session' || event === 'reconnect') ask();
    });
    return () => { alive = false; unsub(); };
  }, []);
  const consoleLabel = (role === 'admin' || role === 'super_admin')
    ? 'Admin console' : `${ROLE_LABEL[role] || 'Internal'} console`;
  const canManageTeam = can('manage_team');
  const canManageConditions = can('manage_conditions');
  const canManagePricing = can('manage_pricing');
  const canManageVendors = can('manage_vendors');
  const canManageDraws = can('manage_draws');
  // A loan officer holds view_draws (not manage_draws): they get their OWN read-only draw section —
  // every one of their active-draw properties, view-only, with accept/dispute on the borrower's
  // behalf inside the file (owner-directed 2026-08-12). Coordinators see "Draw Management" instead.
  const canViewDraws = !canManageDraws && can('view_draws');
  const canManageClosings = can('manage_closings');
  const canManagePurchasing = can('manage_purchasing');
  const canExportTapes = can('export_data_tapes');
  const canDeleteFiles = can('delete_files');
  const canPlatformSetup = can('platform_setup');
  const canViewAudit = can('view_audit_log');
  // ONE Approvals badge = every decision queue this role can see. The pricing-
  // gated counts (escCount/excCount) only ever poll for manage_pricing/super
  // roles, so they stay 0 for everyone else and the sum is naturally scoped.
  const approvalsCount = escCount + excCount + fescCount + reviewCount + myExcCount + trReviewCount;
  const roleLabel = ROLE_LABEL[role] || role || 'Internal';

  // STAFF VIEW BANNER — when this console is somebody ELSE'S, seen through a
  // super-admin's read-only session, it must say so on every screen, both
  // products, unmissably. Probed once per mount: the answer cannot change
  // without the token changing, and a token change remounts the app.
  const [staffViewOf, setStaffViewOf] = useState(null);
  useEffect(() => {
    let alive = true;
    api.staffViewSession().then((s) => {
      if (alive && s && s.active) setStaffViewOf(s.viewing || {});
    }).catch(() => {});
    return () => { alive = false; };
  }, []);
  /* LEAVING A STAFF VIEW GOES THROUGH THE SHARED HANDOFF (auth.jsx), which is the
     same one the borrower and broker views use: ask the server for a fresh token
     for the REAL viewer, fall back to the copy parked in sessionStorage when the
     network is unavailable, and — if NEITHER produces a session — drop the token
     and make them sign in rather than leave them sitting inside somebody else's
     console. This used to be a fourth hand-rolled copy of that dance reading the
     storage keys directly; it now reads none. The navigation stays explicit
     because the token has changed under the running app. */
  const leaveStaffView = async () => {
    const restored = await exitStaffView();
    window.location.assign(restored ? '/portal/#/internal' : '/');
    window.location.reload();
  };

  return (
    <div className="app">
      {staffViewOf && (
        <div role="alert" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1001,
          background: '#1F3864', color: '#fff', padding: '8px 14px', display: 'flex',
          alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14 }}>
          <span>You are seeing <strong>{staffViewOf.name || 'a team member'}</strong>’s screen — read-only.
            Switch Long-term / Short-term above to see everything they see.</span>
          <button className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }}
            onClick={leaveStaffView}>Back to my own screen</button>
        </div>
      )}
      {staleBuild && (
        <div role="alert" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
          background: '#AE8746', color: '#fff', padding: '8px 14px', display: 'flex',
          alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 14 }}>
          <span>PILOT was updated — refresh to get the latest screens and fixes.</span>
          <button className="btn small" style={{ background: '#fff', color: '#141B22', border: 'none' }}
            onClick={() => window.location.reload()}>Refresh now</button>
        </div>
      )}
      <aside className={`app-sidebar ${menuOpen ? 'open' : ''}`} onClick={() => setMenuOpen(false)}>
        <div className="app-brandrow">
          <Brand to="/internal" ariaLabel="PILOT by YS Capital — Internal" console={consoleLabel} />
        </div>
        <div style={{ padding: '6px 12px 10px' }} onClick={(e) => e.stopPropagation()}>
          <ProductSwitch />
        </div>
        {onLongTerm ? (
          /* LONG-TERM's own nav. Deliberately short: this side is a pipeline, the
             people map behind it, and the sync that feeds it. */
          <>
            <div className="sb-sec">Long-term</div>
            <NavLink className="sb-link" to="/internal/lt" end><NavIcon name="pipeline" />Pipeline</NavLink>
            <NavLink className="sb-link" to="/internal/lt/book" title="Every long-term file, with the folder, the status and the milestone it sits in."><NavIcon name="book" />The book</NavLink>
            <NavLink className="sb-link" to="/internal/lt/people"><NavIcon name="team" />Team</NavLink>
            <NavLink className="sb-link" to="/internal/lt/borrowers" title="Which client each long-term file belongs to — what puts it on their own login."><NavIcon name="borrowers" />Borrowers</NavLink>
            <NavLink className="sb-link" to="/internal/lt/statuses" title="Encompass's milestones, our own stage names, and what the borrower is told — side by side."><NavIcon name="conditions" />Statuses</NavLink>
            <NavLink className="sb-link" to="/internal/lt/status-reviews" title="Every file where the ClickUp status and the Encompass milestones disagree — PILOT reports these and never settles them itself."><NavIcon name="health" />Status disagreements</NavLink>
            <NavLink className="sb-link" to="/internal/lt/conditions"><NavIcon name="conditions" />Condition Center</NavLink>
            <NavLink className="sb-link" to="/internal/lt/condition-library" title="Every condition the long-term side can ask for, the gate it blocks, and the rule that decides which files get it. Pre-filled, not hard-wired."><NavIcon name="conditions" />Conditions library</NavLink>
            <NavLink className="sb-link" to="/internal/lt/reports" title="How long every file took between which and which step, who held it, and the same added up per person."><NavIcon name="dashboards" />Reporting</NavLink>
            <NavLink className="sb-link" to="/internal/lt/pricer" title="Price a scenario through Lender Price and see every rate, every investor at each rate, and the whole build behind each price."><NavIcon name="pricing" />Pricing Engine</NavLink>
            {/* The rules/parity console is PARKED FOR REAL now (owner-directed 2026-08-23,
                second pass: "It's just written that it's parked, but it's not really parked.
                Just get that removed from that screen and park it."). Its nav entry is GONE —
                parked means not on anybody's screen, not a link wearing a "(parked)" label.
                The route itself stays behind StaffPrivate, so a deliberate URL still opens the
                console when the parity work resumes; nothing was deleted. Do not re-add a nav
                link here without the owner asking for the console back. */}
            <NavLink className="sb-link" to="/internal/lt/sync"><NavIcon name="health" />Sync</NavLink>
            <NavLink className="sb-link" to="/internal/lt/settings"><NavIcon name="settings" />Settings</NavLink>
          </>
        ) : (<>
        <div className="sb-sec">Main</div>
        {arenaVis && arenaVis.seesArena && (
          <NavLink className="sb-link sb-arena" to="/internal/arena"
            title="The Arena — the live game board. Check in, put your name in the spin, watch the wheel with everybody else.">
            <NavIcon name="dashboards" />
            {(arenaVis.liveSession && arenaVis.liveSession.name) || 'The Arena'}
            {arenaVis.liveSession && <span className="sb-badge sb-badge-live">live</span>}
          </NavLink>
        )}
        <NavLink className="sb-link" to="/internal" end><NavIcon name="pipeline" />Pipeline</NavLink>
        <NavLink className="sb-link" to="/internal/tasks" title={taskCounts && taskCounts.overdue > 0 ? `${taskCounts.overdue} overdue` : undefined}>
          <NavIcon name="tasks" />My tasks
          {/* The badge counts MY open scheduled tasks; red styling when any are overdue. */}
          {taskCounts && taskCounts.open > 0 && (
            <span className="sb-badge" style={taskCounts.overdue > 0 ? { background: '#A83A2F', color: '#fff' } : undefined}>
              {taskCounts.open > 99 ? '99+' : taskCounts.open}
            </span>
          )}</NavLink>
        <NavLink className="sb-link" to="/internal/workflow" title="My Workflow — every file submitted to you, in the order it arrived. Pick it up, do your part, then send it back.">
          <NavIcon name="workflow" />Workflow
          {wfCount > 0 && <span className="sb-badge">{wfCount > 99 ? '99+' : wfCount}</span>}</NavLink>
        {/* Approvals hub (owner-directed 2026-07-31) — replaces the five separate
            nav entries (Manual / Escalations, Exceptions, Findings to review,
            Sync review, My exceptions) with ONE tabbed section. Visible to ALL
            staff; the badge sums every queue this role can see (the escalation/
            exception counts stay 0 for roles that don't poll them). */}
        <NavLink className="sb-link" to="/internal/approvals" title="Approvals — everything waiting on a decision, in one place: manual/escalation approvals, policy exceptions, findings to review, sync reviews, track-record deals waiting to be verified, and the requests you raised.">
          <NavIcon name="conditions" />Approvals
          {approvalsCount > 0 && <span className="sb-badge">{approvalsCount > 99 ? '99+' : approvalsCount}</span>}</NavLink>
        <NavLink className="sb-link" to="/internal/chat">
          <NavIcon name="chat" />Chat
          {unread > 0 && <span className="sb-badge">{unread > 99 ? '99+' : unread}</span>}
        </NavLink>
        <NavLink className="sb-link" to="/internal/leads"><NavIcon name="leads" />Leads</NavLink>
        {/* The Term Sheet Generator gets its OWN nav entry, not just a tile inside
            the suite grid (owner-directed 2026-07-30: "a term sheet generator button
            on the left side of their screen to access the term sheet generator
            directly so they can price out loans even when they logged in"). It is
            the tool staff reach for most, and two clicks behind a grid is two too
            many. Same screen, opened straight onto that tool. */}
        <NavLink className="sb-link" to="/internal/term-sheet" title="Term Sheet Generator — price a loan and build a full term sheet without leaving PILOT. Save what you price as a named scenario and pick it up later."><NavIcon name="pricing" />Term Sheet Generator</NavLink>
        <NavLink className="sb-link" to="/internal/investor-suite" title="Investor Suite — build a term sheet, a scope of work, a track record, or run any deal analyzer, right inside PILOT"><NavIcon name="pricing" />Investor Suite</NavLink>
        {/* The research desk (owner-directed 2026-08-02). Every staff role — it holds
            addresses, property facts and recorded sale prices, and no borrower data.

            ONE ENTRY, NOT SEVEN (owner-directed 2026-08-03: "we now have on our left
            side a few separate sections which all of them should technically be
            combined in one section with different pages in that section, because the
            entire section everything is a property research and Resource Center").
            Seven links sitting next to each other read as seven unrelated tools; this
            is one desk. The pages appear beneath it once you are inside the section,
            and the same strip is on every page of it (`ResearchNav`), so the sidebar
            stays short without hiding where you can go. Every URL is unchanged — the
            pages already lived at nested paths, so nothing anyone bookmarked moved. */}
        <NavLink className="sb-link" to="/internal/dashboards" title="Dashboards — how the business is doing, and the place to build your own. Every card shows exactly which files it counts, and clicking a number opens them."><NavIcon name="dashboards" />Dashboards</NavLink>
        <NavLink className="sb-link" to="/internal/research" title="Property Research & Resource Center — every property and comparable sale our appraisers have ever shown us, plus find comparables, market conditions, what we charge, the quick answer and market areas."
          style={inResearch ? { background: 'var(--surface-soft)', color: 'var(--text)', fontWeight: 600, borderLeftColor: 'var(--gold)' } : undefined}>
          <NavIcon name="pipeline" />Property Research</NavLink>
        {inResearch && RESEARCH_PAGES.map((p) => (
          <NavLink key={p.to} end={p.end} className="sb-link" to={p.to} title={p.blurb}
            style={{ paddingLeft: 41, fontSize: 13 }}>{p.label}</NavLink>
        ))}

        <div className="sb-sec">Files</div>
        <NavLink className="sb-link" to="/internal/borrowers" title="Your borrowers — invite to PILOT, reset or set a password, see last login"><NavIcon name="borrowers" />Borrowers</NavLink>
        <NavLink className="sb-link" to="/internal/borrower-view" title="Borrower view — step into a borrower's portal and see PILOT exactly as they see it, so you can walk them through a screen live. One click brings you back."><NavIcon name="borrowerView" />Borrower view</NavLink>
        <NavLink className="sb-link" to="/internal/tpo-view" title="Broker view — step into a TPO broker's login for a firm you handle and see PILOT exactly as they see it, so you can walk them through a screen live. One click brings you back."><NavIcon name="borrowerView" />Broker view</NavLink>
        <NavLink className="sb-link" to="/internal/emails" title="Email Center — every email & notification sent across your files, to exactly whom, with its full body, delivery status, and replies"><NavIcon name="emails" />Email Center</NavLink>
        <NavLink className="sb-link" to="/internal/notifications" title="Notification Center — the master control for every notification your borrowers receive: turn any single one off, keep it automatic, or park it as a draft to review before it goes out">
          <NavIcon name="emails" />Notifications
          {notifDraftCount > 0 && <span className="sb-badge">{notifDraftCount > 99 ? '99+' : notifDraftCount}</span>}
        </NavLink>
        <NavLink className="sb-link" to="/internal/settings" title="My settings — how you run your business: your own defaults (e.g. whether your borrowers are CC'd on title order emails). Each officer sets their own."><NavIcon name="team" />My settings</NavLink>
        <NavLink className="sb-link" to="/internal/esign" title="E-Signatures — PILOT’s own DocuSign cockpit: every package, every signer, live"><NavIcon name="esign" />E-signatures</NavLink>
        <NavLink className="sb-link" to="/internal/orders" title="Orders — every title & insurance order across your files, and what's waiting to be classified"><NavIcon name="vendors" />Orders</NavLink>
        {canExportTapes && <NavLink className="sb-link" to="/internal/tapes" title="Data Tapes — export each capital provider's loan tape (their Excel workbook, filled with the loan's figures). One loan at a time or in bulk by provider."><NavIcon name="pipeline" />Data tapes</NavLink>}
        {(canManageClosings || role === 'loan_officer' || role === 'processor') && <NavLink className="sb-link" to="/internal/closing" title="Closing — files submitted to closing: cash-to-close checks, warehouse & collateral, closing conditions, reconciliation."><NavIcon name="pipeline" />Closing
          {closingCount > 0 && <span className="sb-badge">{closingCount > 99 ? '99+' : closingCount}</span>}</NavLink>}
        {canManagePurchasing && <NavLink className="sb-link" to="/internal/purchasing" title="Purchasing — every file that moved to purchasing after investor delivery: what's still missing, notes and tasks. A table-funded loan was sold at closing and never lands here."><NavIcon name="pipeline" />Purchasing
          {purchasingCount > 0 && <span className="sb-badge">{purchasingCount > 99 ? '99+' : purchasingCount}</span>}</NavLink>}
        {canManageDraws && <NavLink className="sb-link" to="/internal/draws" title="Draw Management — the post-funding phase: every draw, approvals, inspector photos, releases, and reports"><NavIcon name="pipeline" />Draw Management</NavLink>}
        {canViewDraws && <NavLink className="sb-link" to="/internal/draws" title="My draws — your active-draw properties, view-only: every draw, the inspector's results, photos and reports"><NavIcon name="pipeline" />My draws</NavLink>}
        {canManageConditions && <NavLink className="sb-link" to="/internal/conditions" title="Condition Center — the global condition library & rules"><NavIcon name="conditions" />Conditions</NavLink>}
        {canManageVendors && <NavLink className="sb-link" to="/internal/vendors" title="Title & insurance vendor directory"><NavIcon name="vendors" />Vendors</NavLink>}
        {canDeleteFiles && <NavLink className="sb-link" to="/internal/archived" title="Archived files — restore or delete permanently"><NavIcon name="archived" />Archived</NavLink>}

        {(canManageTeam || canManagePricing || canPlatformSetup || canViewAudit) && <div className="sb-sec">Admin</div>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/team"><NavIcon name="team" />Team</NavLink>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/tpo-firms" title="Broker firms — onboard a brokerage firm, invite its lead broker, and set up a firm's own credit account"><NavIcon name="team" />Broker firms</NavLink>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/crm" title="Company CRM — every loan officer's lead book in one table, and a switcher that opens any one officer's full CRM and walks from one officer to the next"><NavIcon name="leads" />Company CRM</NavLink>}
        {canManageTeam && <NavLink className="sb-link" to="/internal/elementix" title="Elementix — who on the team uses Elementix, which PILOT officer each login belongs to, and bringing in every contact they have already looked up as leads"><NavIcon name="team" />Elementix</NavLink>}
        {canManagePricing && <NavLink className="sb-link" to="/internal/pricing" title="Pricing Admin Center — company-wide markup, origination & fee defaults"><NavIcon name="pricing" />Pricing</NavLink>}
        {/* Manual / Escalations + Exceptions moved into the Approvals hub in the
            Main group (owner-directed 2026-07-31) — their counts still poll here
            and feed the Approvals badge. */}
        {(role === 'admin' || role === 'super_admin') && <NavLink className="sb-link" to="/internal/reports" title="Reports — the reporting database: pick the files, pick the fields, save the report, export to Excel"><NavIcon name="pricing" />Reports</NavLink>}
        {(role === 'admin' || role === 'super_admin') && <NavLink className="sb-link" to="/internal/ai" title="AI Command Center — one place to see everything PILOT flagged, review findings, answer PILOT's questions, and teach it (training, labeling, muted alerts)">
          <NavIcon name="conditions" />AI Command Center
          {fescCount > 0 && <span className="sb-badge">{fescCount > 99 ? '99+' : fescCount}</span>}</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/api-health" title="API Health — every integration & API: live or down, what it needs, and a one-click test"><NavIcon name="health" />API Health</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/pipeline-shadow" title="Pipeline (shadow) — the new document pipeline running quietly beside the current one: vendor connections + V2-vs-V1 comparison"><NavIcon name="pipeline" />Pipeline (shadow)</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/clickup" title="ClickUp Control Center — sync health, dry-run, backfill"><NavIcon name="clickup" />ClickUp</NavLink>}
        {canPlatformSetup && <NavLink className="sb-link" to="/internal/draw-rules" title="Inspection & fee rules — virtual vs on-site and the per-partner fee schedule for draws"><NavIcon name="pipeline" />Draw rules</NavLink>}
        {canViewAudit && <NavLink className="sb-link" to="/internal/audit" title="System audit log — every action across every file & borrower"><NavIcon name="audit" />Audit log</NavLink>}
        </>)}

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
        <GlobalSearch />
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
      <ChatBubble mode="staff" unread={unread} />
    </div>
  );
}
