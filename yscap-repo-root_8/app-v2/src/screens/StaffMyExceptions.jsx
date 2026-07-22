import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import ExceptionCard from '../components/ExceptionCard.jsx';

/* "My exceptions" — a staffer's OWN exception requests across ALL their files
   (owner-directed 2026-07-22). A loan officer tracks, opens, comments on, or
   withdraws a pending exception here without digging into each file. Read-only on
   the decision itself (only a super-admin decides, in /internal/exceptions), but
   the requester can withdraw an open one and clear a handled one. */

export default function StaffMyExceptions() {
  const [rows, setRows] = useState([]);
  const [reasonCodes, setReasonCodes] = useState({});
  const [statusFilter, setStatusFilter] = useState('all-active');
  const [openCount, setOpenCount] = useState(0);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const flash = (ok, text) => { setMsg({ ok, text }); setTimeout(() => setMsg(null), 7000); };

  const load = () => api.myExceptions(statusFilter)
    .then((d) => { setRows(d.exceptions || []); setOpenCount(d.openCount || 0); setReasonCodes(d.reasonCodes || {}); })
    .catch((e) => flash(false, (e && e.message) || 'could not load your exceptions'));

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [statusFilter]);

  async function withdraw(row) {
    setBusy(row.id);
    try { await api.withdrawException(row.application_id, row.id); flash(true, 'Request withdrawn.'); await load(); }
    catch (e) { flash(false, (e && e.message) || 'could not withdraw the request'); }
    finally { setBusy(''); }
  }
  async function clear(row) {
    setBusy(row.id);
    try { await api.clearLoanException(row.id, ''); flash(true, 'Exception cleared.'); await load(); }
    catch (e) { flash(false, (e && e.message) || 'could not clear the exception'); }
    finally { setBusy(''); }
  }

  const filters = ['all-active', 'open', 'approved', 'denied', 'cleared', 'all'];
  const filterLabel = { 'all-active': 'Active', open: 'Awaiting review', approved: 'Approved', denied: 'Denied', cleared: 'Cleared', all: 'All' };

  return (
    <div className="wrap" style={{ maxWidth: 940 }}>
      <div className="row" style={{ alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <h1 style={{ margin: 0 }}>My exceptions</h1>
        {openCount > 0 && <span className="ts-badge warn">{openCount} awaiting review</span>}
      </div>
      <p className="muted" style={{ marginTop: 6 }}>
        Exception requests you’ve raised, across all your files. A super-admin approves or denies each one; you can
        withdraw a request that’s still open, or clear one once it’s handled.
      </p>

      {msg && <div className={`notice ${msg.ok ? 'ok' : 'err'}`} style={{ marginTop: 8 }}>{msg.text}</div>}

      <div className="row" style={{ gap: 6, flexWrap: 'wrap', margin: '12px 0' }}>
        {filters.map((f) => (
          <button key={f} className={`btn small ${statusFilter === f ? 'primary' : 'ghost'}`} onClick={() => setStatusFilter(f)}>
            {filterLabel[f]}
          </button>
        ))}
      </div>

      {rows.length === 0 && <div className="notice">You have no exception requests {statusFilter === 'all' ? '' : `(${filterLabel[statusFilter].toLowerCase()})`}.</div>}

      {rows.map((r) => {
        const open = r.status === 'requested';
        const canClear = r.status !== 'cleared';
        return (
          <ExceptionCard key={r.id} r={r} reasonCodes={reasonCodes}>
            {(open || canClear) && (
              <div className="row" style={{ gap: 8, marginTop: 10, borderTop: '1px solid var(--hair,#e7e2d6)', paddingTop: 10, alignItems: 'center' }}>
                {open && <button className="btn ghost small" disabled={busy === r.id} onClick={() => withdraw(r)}>Withdraw request</button>}
                {canClear && <button className="btn ghost small" disabled={busy === r.id} onClick={() => clear(r)}>Clear (archive)</button>}
              </div>
            )}
          </ExceptionCard>
        );
      })}
    </div>
  );
}
