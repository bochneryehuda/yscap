import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* System-wide audit log (#145) — the company-wide compliance trail. Every action
   across every file and borrower in one searchable place, each row linked to the
   file, the borrower profile, and the officer involved. The DEEP per-file and
   per-borrower trails live on those screens (Activity feed / borrower detail);
   this is the global oversight view, gated on the view_audit_log capability. */

// A distinct hue per category for the leading dot + pill. Light-first, readable
// on white; the muted/ink tokens keep it consistent with the rest of the portal.
const CAT_COLOR = {
  pii: '#b91c1c', auth: '#7c3aed', file: '#1d4ed8', pricing: '#0f766e',
  document: '#b45309', condition: '#0369a1', llc: '#4d7c0f', track_record: '#9333ea',
  borrower: '#be185d', vendor: '#0891b2', message: '#4b5563', setup: '#374151',
  sync: '#6b7280', other: '#94a3b8',
};

function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return '';
  const s = Math.round((Date.now() - then) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.round(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.round(mo / 12)}y ago`;
}

const ROLE_LABEL = {
  super_admin: 'Super Admin', admin: 'Admin', underwriter: 'Underwriter',
  loan_officer: 'Loan Officer', loan_coordinator: 'Loan Coordinator',
  processor: 'Processor', software_setup: 'Software Setup',
};

const PAGE = 100;

export default function StaffAuditLog() {
  const { can } = useAuth();
  const allowed = can('view_audit_log');

  const [facets, setFacets] = useState(null);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState(null);

  // Filters
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [action, setAction] = useState('');
  const [actorKind, setActorKind] = useState('');
  const [actorId, setActorId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  // Debounce the free-text box so we don't fire a query per keystroke.
  const debRef = useRef(null);
  useEffect(() => {
    if (debRef.current) clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setQ(qInput.trim()), 350);
    return () => debRef.current && clearTimeout(debRef.current);
  }, [qInput]);

  useEffect(() => {
    if (!allowed) return;
    api.auditLogFacets().then(setFacets).catch(() => setFacets({ actions: [], categories: [], staff: [] }));
  }, [allowed]);

  // Compliance KPIs — aggregated from the global facet action counts the screen
  // already loads (each action carries { category, count }). No extra fetch;
  // these are the same counts shown in the Action dropdown, summed by category.
  const auditStats = useMemo(() => {
    const acts = (facets && facets.actions) || [];
    const sum = (pred) => acts.reduce((n, a) => n + (pred(a) ? (Number(a.count) || 0) : 0), 0);
    return {
      total: sum(() => true),
      pii: sum(a => a.category === 'pii'),
      document: sum(a => a.category === 'document'),
      auth: sum(a => a.category === 'auth'),
    };
  }, [facets]);

  // The action list, optionally narrowed to the chosen category.
  const actionOptions = useMemo(() => {
    const acts = (facets && facets.actions) || [];
    return category ? acts.filter(a => a.category === category) : acts;
  }, [facets, category]);

  const params = useMemo(() => ({
    // When a specific action is chosen it wins; otherwise the category filters
    // server-side (correct pagination across the whole log, not just page 1).
    q, action, category: action ? '' : category, actorKind, actorId, from, to,
    limit: PAGE,
  }), [q, action, category, actorKind, actorId, from, to]);

  // Fetch page 0 whenever a filter changes.
  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    setLoading(true); setErr('');
    api.auditLog({ ...params, offset: 0 })
      .then((r) => { if (!alive) return; setRows(r.rows || []); setHasMore(!!r.hasMore); setOffset((r.rows || []).length); })
      .catch((e) => { if (alive) setErr(e.message || 'Could not load the audit log.'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [allowed, params]);

  async function loadMore() {
    setLoading(true);
    try {
      const r = await api.auditLog({ ...params, offset });
      setRows((prev) => [...(prev || []), ...(r.rows || [])]);
      setHasMore(!!r.hasMore);
      setOffset((o) => o + (r.rows || []).length);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  }

  function reset() {
    setQInput(''); setQ(''); setCategory(''); setAction('');
    setActorKind(''); setActorId(''); setFrom(''); setTo('');
  }

  if (!allowed) {
    return <div className="panel muted">You don’t have access to the system audit log. Ask an admin to grant the “View the system audit log” permission.</div>;
  }

  // Category is filtered server-side now, so the fetched rows are already scoped.
  const shown = rows || [];
  const staffList = (facets && facets.staff) || [];
  const anyFilter = q || category || action || actorKind || actorId || from || to;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit log</h1>
          <div className="sub">Every action across every loan file and borrower — who did it, what changed, and when.</div>
          <span className="lock-note"><span className="shield" aria-hidden="true" />GLBA · PII access trail · append-only</span>
        </div>
        <div className="page-head-actions">
          {anyFilter && <button className="btn btn-ghost btn-sm" onClick={reset}>Clear filters</button>}
        </div>
      </div>
      <p className="muted small" style={{ marginTop: 2, marginBottom: 16, maxWidth: '76ch' }}>
        Search by borrower, property, officer or action; click a name to jump to the file or profile.
      </p>

      {facets && (
        <div className="kpi-grid" style={{ marginBottom: 14 }}>
          <div className="kpi"><div className="v">{auditStats.total}</div><div className="k">Logged events</div><div className="d">Across the whole trail</div></div>
          <div className={`kpi${auditStats.pii ? ' alert' : ''}`}><div className="v">{auditStats.pii}</div><div className="k">SSN / PII access</div><div className="d">Sensitive-data events</div></div>
          <div className="kpi"><div className="v">{auditStats.document}</div><div className="k">Document actions</div><div className="d">Uploads &amp; views</div></div>
          <div className="kpi"><div className="v">{auditStats.auth}</div><div className="k">Auth events</div><div className="d">Sign-in &amp; access</div></div>
        </div>
      )}

      {/* Filter bar */}
      <div className="panel" style={{ marginBottom: 14 }}>
        <div className="panel-b">
        <div className="grid cols-2" style={{ gap: 10 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            <label className="muted small">Search</label>
            <input className="input" placeholder="Borrower, property address, officer, or action…"
              value={qInput} onChange={e => setQInput(e.target.value)} />
          </div>
          <div>
            <label className="muted small">Category</label>
            <select className="input" value={category} onChange={e => { setCategory(e.target.value); setAction(''); }}>
              <option value="">All categories</option>
              {((facets && facets.categories) || []).map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
          </div>
          <div>
            <label className="muted small">Action</label>
            <select className="input" value={action} onChange={e => setAction(e.target.value)}>
              <option value="">All actions</option>
              {actionOptions.map(a => <option key={a.action} value={a.action}>{a.label} ({a.count})</option>)}
            </select>
          </div>
          <div>
            <label className="muted small">Who</label>
            <select className="input" value={actorKind} onChange={e => { setActorKind(e.target.value); if (e.target.value !== 'staff') setActorId(''); }}>
              <option value="">Anyone</option>
              <option value="staff">Staff</option>
              <option value="borrower">Borrowers</option>
              <option value="system">System / sync</option>
            </select>
          </div>
          <div>
            <label className="muted small">Staff member</label>
            <select className="input" value={actorId}
              onChange={e => { setActorId(e.target.value); if (e.target.value) setActorKind('staff'); }}>
              <option value="">Any staff</option>
              {staffList.map(s => <option key={s.id} value={s.id}>{s.full_name}{s.role ? ` — ${ROLE_LABEL[s.role] || s.role}` : ''}</option>)}
            </select>
          </div>
          <div>
            <label className="muted small">From</label>
            <input className="input" type="date" value={from} onChange={e => setFrom(e.target.value)} />
          </div>
          <div>
            <label className="muted small">To</label>
            <input className="input" type="date" value={to} onChange={e => setTo(e.target.value)} />
          </div>
        </div>
        </div>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      {rows == null
        ? <div className="panel pad muted">Loading the audit trail…</div>
        : shown.length === 0
          ? <div className="empty-state"><h3>No activity</h3><div>No activity matches these filters.</div></div>
          : (
            <div className="panel">
              <div className="panel-h">
                <h3>Access events</h3>
                <div className="audit-legend">
                  <span className="lg"><span className="sw" style={{ background: CAT_COLOR.pii }} />SSN / PII</span>
                  <span className="lg"><span className="sw" style={{ background: CAT_COLOR.document }} />Document</span>
                  <span className="lg"><span className="sw" style={{ background: CAT_COLOR.borrower }} />Borrower</span>
                  <span className="lg"><span className="sw" style={{ background: CAT_COLOR.auth }} />Auth</span>
                </div>
              </div>
              <div className="panel-b" style={{ paddingTop: 6, paddingBottom: 6 }}>
                {shown.map(r => <AuditRow key={r.id} r={r} expanded={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
                  onActor={() => { if (r.actor_kind === 'staff' && r.actor_id) { setActorId(r.actor_id); setActorKind('staff'); } }} />)}
              </div>
            </div>
          )}

      {hasMore && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn ghost" disabled={loading} onClick={loadMore}>{loading ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </>
  );
}

function AuditRow({ r, expanded, onToggle, onActor }) {
  const color = CAT_COLOR[r.category] || CAT_COLOR.other;
  const sensitive = r.category === 'pii';   // SSN/PII rows get the emphasis treatment
  const when = new Date(r.at);
  // The target: a loan file, a borrower profile, or a bare entity reference.
  let target = null;
  if (r.app_id) {
    target = (
      <Link to={`/internal/app/${r.app_id}`} className="btn link small" style={{ padding: 0 }}>
        {r.app_address || 'a loan file'}{r.app_borrower_name ? ` · ${r.app_borrower_name}` : ''}
      </Link>
    );
  } else if (r.ent_borrower_id) {
    target = (
      <Link to={`/internal/borrowers/${r.ent_borrower_id}`} className="btn link small" style={{ padding: 0 }}>
        {r.ent_borrower_name || 'a borrower'}
      </Link>
    );
  } else if (r.entity_type) {
    target = <span className="muted small">{r.entity_type.replace(/_/g, ' ')}</span>;
  }

  return (
    <div className={`audit-row${sensitive ? ' sensitive' : ''}`}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 10, flexWrap: 'wrap' }}>
        <span title={r.category} style={{ width: 10, height: 10, borderRadius: '50%', background: color, marginTop: 6, flex: '0 0 auto' }} />
        <div style={{ flex: 1, minWidth: 240 }}>
          <div style={{ fontWeight: 600 }}>
            {r.action_label}
            {sensitive && <span className="pii-tag" title="Sensitive SSN / PII access">SSN / PII</span>}
          </div>
          <div className="muted small" style={{ marginTop: 3, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            <span>
              by{' '}
              {r.actor_kind === 'staff'
                ? <button className="btn link small" style={{ padding: 0 }} onClick={onActor} title="Filter the log to this person">{r.actor_name}</button>
                : r.actor_kind === 'borrower' && r.actor_id
                  ? <Link to={`/internal/borrowers/${r.actor_id}`} className="btn link small" style={{ padding: 0 }}>{r.actor_name}</Link>
                  : <span>{r.actor_name}</span>}
              {r.actor_role ? <span className="pill" style={{ marginLeft: 4 }}>{ROLE_LABEL[r.actor_role] || r.actor_role}</span> : null}
            </span>
            {target && <span>· {target}</span>}
            {r.app_officer_name && !r.app_id ? null : (r.app_officer_name ? <span>· LO {r.app_officer_name}</span> : null)}
          </div>
        </div>
        <div className="muted small" style={{ textAlign: 'right', flex: '0 0 auto' }} title={isNaN(when) ? '' : when.toLocaleString()}>
          {timeAgo(r.at)}
          <div style={{ fontSize: 11, opacity: 0.8 }}>{isNaN(when) ? '' : when.toLocaleDateString()}</div>
        </div>
      </div>
      {(r.detail && Object.keys(r.detail).length > 0) || r.ip_address ? (
        <div style={{ marginTop: 6 }}>
          <button className="btn link small" style={{ padding: 0 }} onClick={onToggle}>{expanded ? 'Hide details' : 'Details'}</button>
          {expanded && (
            <div className="small" style={{ marginTop: 6 }}>
              {r.ip_address && <div className="muted">IP {r.ip_address}</div>}
              {r.detail && Object.keys(r.detail).length > 0 && (
                <pre className="panel small" style={{ whiteSpace: 'pre-wrap', marginTop: 6, maxHeight: 240, overflow: 'auto' }}>
                  {JSON.stringify(r.detail, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
