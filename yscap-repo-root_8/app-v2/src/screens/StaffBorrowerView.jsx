import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* BORROWER VIEW — the staff-side picker (owner-directed 2026-07-26).

   "Maybe we should do a separate section on the left side for them to view
   borrower view and they can choose one of their borrowers and see their view."

   This is that section. Pick a borrower, land inside their portal, see exactly
   what they see, walk them through it on the phone, come back. Who appears here
   is decided by the SERVER (src/lib/borrower-view.js): a loan officer or
   processor sees only borrowers on files they can already open; an admin sees
   everyone. */

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

export default function StaffBorrowerView() {
  const nav = useNavigate();
  const { startBorrowerView, can } = useAuth();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState(null);
  const [scope, setScope] = useState('assigned');
  const [err, setErr] = useState('');
  const [starting, setStarting] = useState('');
  const [history, setHistory] = useState([]);
  const [showHistory, setShowHistory] = useState(false);

  const load = useCallback((term) => {
    setErr('');
    api.borrowerViewEligible(term)
      .then((r) => { setRows(r.borrowers || []); setScope(r.scope || 'assigned'); })
      .catch((e) => { setRows([]); setErr(e.message); });
  }, []);

  // Debounced search — same cadence as the console's global search.
  useEffect(() => {
    const t = setTimeout(() => load(q.trim().length >= 2 ? q.trim() : ''), q ? 250 : 0);
    return () => clearTimeout(t);
  }, [q, load]);

  useEffect(() => {
    api.borrowerViewHistory(25).then((r) => setHistory(r.sessions || [])).catch(() => {});
  }, []);

  const go = async (b) => {
    if (starting) return;
    setStarting(b.id); setErr('');
    try {
      const r = await startBorrowerView(b.id);
      nav(r.landing || '/dashboard', { replace: true });
    } catch (e) {
      setErr(e.message);
      setStarting('');
    }
  };

  return (
    <div className="stack">
      <div className="card">
        <h1 style={{ marginTop: 0 }}>Borrower view</h1>
        <p className="muted" style={{ maxWidth: 760, color: '#4B585C' }}>
          Step into a borrower’s portal and see PILOT exactly the way they see it — their
          dashboard, their loans, their conditions, their documents. Useful when they’re on
          the phone asking “where do I click?”: you’re looking at their screen, not a copy of it.
          A bar across the top always shows whose view you’re in and brings you straight back.
        </p>
        <p className="small" style={{ color: '#3A4550' }}>
          {scope === 'all'
            ? 'You can open a borrower view for any borrower in the system.'
            : 'You can open a borrower view for the borrowers on your own files.'}
          {' '}Everything you do inside a borrower view is recorded under your name.
          Signing documents and changing their sign-in security stay with the borrower.
        </p>

        <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: 'wrap' }}>
          <input
            style={{ minWidth: 280, flex: '1 1 280px' }}
            type="search"
            value={q}
            placeholder="Search your borrowers by name or email…"
            aria-label="Search borrowers"
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
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Recent borrower views</h2>
          <p className="small" style={{ color: '#3A4550' }}>
            {can('view_audit_log')
              ? 'Every borrower view opened by anyone on the team.'
              : 'The borrower views you have opened.'}
          </p>
          {history.length === 0
            ? <p className="muted small" style={{ color: '#4B585C' }}>No borrower views yet.</p>
            : (
              <div className="tbl-wrap" style={{ overflowX: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Who looked</th><th>As</th><th>Started</th><th>Ended</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((h) => (
                      <tr key={h.id}>
                        <td style={{ color: '#141B22' }}>{h.staff.name}</td>
                        <td style={{ color: '#141B22' }}>{h.borrower.name}</td>
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
        {rows === null && <p className="muted" style={{ color: '#4B585C' }}>Loading your borrowers…</p>}
        {rows !== null && rows.length === 0 && (
          <p className="muted" style={{ color: '#4B585C' }}>
            {q.trim().length >= 2
              ? 'No borrower matched that search.'
              : 'No borrowers yet — a borrower shows up here once they’re on one of your files.'}
          </p>
        )}
        {rows !== null && rows.length > 0 && (
          <div className="bview-list">
            {rows.map((b) => (
              <div className="bview-row" key={b.id}>
                <div className="bview-who">
                  <div className="bview-name">{b.name}</div>
                  <div className="bview-meta">
                    {b.email || 'no email on file'}
                    <span aria-hidden="true"> · </span>
                    {b.fileCount} {b.fileCount === 1 ? 'loan' : 'loans'}
                    {b.openItems > 0 && (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="bview-open">{b.openItems} waiting on them</span>
                      </>
                    )}
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
                    : `${b.name} hasn’t created their PILOT login, so there is no borrower view to open yet.`}
                  onClick={() => go(b)}
                >
                  {starting === b.id ? 'Opening…' : 'View as this borrower'}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
