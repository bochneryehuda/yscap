import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { fullNameOf } from '../lib/personName.js';

/* THE CLOSING QUEUE (owner-directed 2026-07-26). Every file in the closing
   workflow, for the closer + the file's officer. Closers land here on login. */

const STAGE_LABEL = {
  estimated: 'Submitted', ready_for_docs: 'Ready for docs', wire_sent: 'Wire sent',
  fully_closed: 'Closed (funded)', fully_reconciled: 'Reconciled', in_purchasing: 'In purchasing',
};
const day = (v) => (v ? String(v).slice(0, 10) : '—');
function fmtAddr(a) {
  if (!a) return '—';
  if (typeof a === 'string') return a;
  const parts = [a.line1 || a.street, a.city, a.state].filter(Boolean);
  return parts.length ? parts.join(', ') : '—';
}
const yn = (v) => (v ? <span className="pill ok">Yes</span> : <span className="pill warn">No</span>);

export default function StaffClosing() {
  const { can } = useAuth();
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('active');

  useEffect(() => {
    let dead = false;
    api.closingQueue().then((d) => { if (!dead) setRows(Array.isArray(d) ? d : []); }).catch((e) => { if (!dead) setErr((e && e.message) || 'Could not load the closing queue.'); });
    return () => { dead = true; };
  }, []);

  const shown = useMemo(() => {
    const all = rows || [];
    if (filter === 'purchasing') return all.filter((r) => r.closing_stage === 'in_purchasing');
    if (filter === 'all') return all;
    return all.filter((r) => r.closing_stage !== 'in_purchasing');
  }, [rows, filter]);

  const canManage = can('manage_closings');

  return (
    <div className="screen">
      <div className="screen-head">
        <div>
          <h1 style={{ margin: 0 }}>Closing</h1>
          <p className="muted small" style={{ margin: '4px 0 0' }}>Files that have been submitted to closing. {canManage ? 'Open a file to run its closing.' : 'Open a file to update its closing details.'}</p>
        </div>
        <div className="row" style={{ gap: 6 }}>
          {['active', 'purchasing', 'all'].map((f) => (
            <button key={f} className={`btn small ${filter === f ? 'primary' : 'ghost'}`} onClick={() => setFilter(f)}>
              {f === 'active' ? 'In closing' : f === 'purchasing' ? 'In purchasing' : 'All'}
            </button>
          ))}
        </div>
      </div>

      {err && <div className="notice err">{err}</div>}
      {!rows && !err && <div className="muted small">Loading…</div>}
      {rows && shown.length === 0 && <div className="panel"><div className="panel-b muted">No files here yet.</div></div>}

      {shown.length > 0 && (
        <div className="cl-table-wrap">
          <table className="cl-table">
            <thead>
              <tr>
                <th>Borrower / property</th><th>Loan #</th><th>Investor</th><th>Est. closing</th>
                <th>Stage</th><th>CTC</th><th>Confirmed</th><th>Warehouse</th><th>Funds</th><th>Reconciled</th><th>Closer</th><th></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td><b>{fullNameOf(r) || '—'}</b><div className="muted small">{fmtAddr(r.property_address)}</div></td>
                  <td>{r.ys_loan_number || '—'}</td>
                  <td>{r.lender || '—'}</td>
                  <td>{day(r.est_closing_date || r.expected_closing)}</td>
                  <td><span className="pill">{STAGE_LABEL[r.closing_stage] || '—'}</span></td>
                  <td>{yn(r.investor_ctc)}</td>
                  <td>{yn(r.closing_date_confirmed)}</td>
                  <td>{r.warehouse || '—'}</td>
                  <td>{r.actual_cash_to_close == null ? <span className="muted small">—</span> : (r.liquidity_ok ? <span className="pill ok">OK</span> : <span className="pill err">Short</span>)}</td>
                  <td>{r.reconciled_ok ? <span className="pill ok">Yes</span> : yn(false)}</td>
                  <td>{r.closer_name || '—'}</td>
                  <td><Link className="btn ghost small" to={`/internal/app/${r.id}#sec-closing`}>Open</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
