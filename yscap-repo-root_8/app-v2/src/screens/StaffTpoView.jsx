import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useUrlState } from '../lib/useUrlState.js';

/* TPO VIEW — the staff-side picker (owner-directed 2026-08-04; TPO blueprint
   decision 6). The exact mirror of the Borrower view picker, for the broker
   portal: pick one of your firms' brokers, land inside their login, see exactly
   what they see, walk them through it, come back. Who appears here is decided by
   the SERVER (src/lib/tpo-view.js): an account executive / manager sees the
   brokers of firms they handle; an admin sees every active broker. */

const ROLE_LABEL = { tpo_officer: 'Loan officer (broker)', tpo_processor: 'Processor' };

const fmtDate = (v) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  catch { return '—'; }
};
const fmtWhen = (v) => {
  if (!v) return '—';
  try { return new Date(v).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  catch { return '—'; }
};

export default function StaffTpoView() {
  const nav = useNavigate();
  const { startTpoView, can } = useAuth();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [scope, setScope] = useUrlState('scope', 'assigned');
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback((term) => {
    setErr('');
    api.tpoViewEligible(term)
      .then((r) => { setRows(r.brokers || []); setScope(r.scope || 'assigned'); })
      .catch((e) => { setRows([]); setErr(e.message); });
  }, []);

  // Debounced search — same cadence as the console's global search.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim().length >= 2 ? q.trim() : ''), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  useEffect(() => {
    api.tpoViewHistory(25).then((r) => setHistory(r.sessions || [])).catch(() => {});
  }, []);

  const go = async (b) => {
    if (starting) return;
    setStarting(b.id); setErr('');
    try {
      const r = await startTpoView(b.id);
      nav(r.landing || '/tpo', { replace: true });
    } catch (e) {
      setErr(e.message);
      setStarting('');
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Broker view</h1>
        <p className="muted" style={{ maxWidth: 760, color: '#4B585C' }}>
          Step into a broker’s login and see PILOT exactly the way they see it — their firm’s
          pipeline, their files, the borrower-safe screens. Useful when a broker is on the phone
          asking “where do I click?”: you’re looking at their screen, not a copy of it. A bar
          across the top always shows whose view you’re in and brings you straight back.
        </p>
        <p className="small" style={{ color: '#3A4550' }}>
          {scope === 'all'
            ? 'You can open a broker view for any active broker at any active firm.'
            : 'You can open a broker view for the brokers of the firms you handle.'}
          {' '}Everything you do inside a broker view is recorded under your name. Ordering
          credit, changing their sign-in security, and sending a term sheet stay with the lender.
        </p>

        <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <input
            style={{ minWidth: 280, flex: '1 1 280px' }}
            type="search"
            value={q}
            placeholder="Search brokers by name, email, or firm…"
            aria-label="Search brokers"
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="button" className="btn ghost small" onClick={() => setShowHistory((s) => !s)}>
            {showHistory ? 'Hide recent views' : 'Recent views'}
          </button>
        </div>
        {err && <p className="err" role="alert" style={{ marginTop: 10 }}>{err}</p>}
      </div>

      {showHistory && (
        <div className="card">
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Recent broker views</h2>
          <p className="small" style={{ color: '#3A4550' }}>
            {can('view_audit_log')
              ? 'Every broker view opened by anyone on the team.'
              : 'The broker views you have opened.'}
          </p>
          {history.length === 0
            ? <p className="muted small" style={{ color: '#4B585C' }}>No broker views yet.</p>
            : (
              <div className="tbl-wrap" style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Who looked</th><th>As</th><th>Firm</th><th>Started</th><th>Ended</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td style={{ color: '#141B22' }}>{h.staff.name}</td>
                        <td style={{ color: '#141B22' }}>{h.broker.name}</td>
                        <td style={{ color: '#3A4550' }}>{h.firmName || '—'}</td>
                        <td style={{ color: '#3A4550' }}>{fmtWhen(h.startedAt)}</td>
                        <td style={{ color: '#3A4550' }}>
                          {h.endedAt ? `${fmtWhen(h.endedAt)}${h.endReason ? ` (${h.endReason})` : ''}` : 'still open'}
                        </td>
                        <td style={{ color: '#3A4550' }}>{h.requestCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
        </div>
      )}

      <div className="card">
        {rows === null && <p className="muted" style={{ color: '#4B585C' }}>Loading brokers…</p>}
        {rows !== null && rows.length === 0 && (
          <p className="muted" style={{ color: '#4B585C' }}>
            {q.trim().length >= 2
              ? 'No broker matched that search.'
              : 'No brokers yet — a broker shows up here once you’re on one of their firm’s files.'}
          </p>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="bview-list">
            {rows.map((b) => (
              <div className="bview-row" key={b.id}>
                <div className="bview-who">
                  <div className="bview-name">
                    {b.name}
                    {b.isFirmAdmin && <span className="small" style={{ color: '#8A5A00', marginLeft: 8 }}>· Firm admin</span>}
                  </div>
                  <div className="bview-meta">
                    <strong style={{ color: '#141B22' }}>{b.firmName || 'Firm'}</strong>
                    <span aria-hidden="true"> · </span>
                    {ROLE_LABEL[b.role] || b.role}
                    <span aria-hidden="true"> · </span>
                    {b.email || 'no email on file'}
                    <span aria-hidden="true"> · </span>
                    {b.firmFileCount} {b.firmFileCount === 1 ? 'firm file' : 'firm files'}
                    <span aria-hidden="true"> · </span>
                    {b.hasLogin
                      ? <>last signed in {fmtDate(b.lastLoginAt)}</>
                      : <span className="bview-nologin">hasn’t set up their login yet</span>}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-gold btn-sm"
                  disabled={!b.hasLogin || !!starting}
                  title={b.hasLogin
                    ? `See PILOT as ${b.name}`
                    : `${b.name} hasn’t created their login yet, so there is no broker view to open.`}
                  onClick={() => go(b)}
                >
                  {starting === b.id ? 'Opening…' : 'View as this broker'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
