import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* The broker's firm pipeline — every TPO file their firm has brought to YS
   Capital, and ONLY those (firm-scoped server-side). The landing screen of the
   broker portal. Read-only for now; per-file feature screens (pricing,
   conditions, documents, orders, draws) arrive in later phases. */

const STATUS_LABEL = {
  file_intake: 'Intake', new: 'New', in_review: 'In review', processing: 'Processing',
  underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close',
  funded: 'Funded', on_hold: 'On hold', declined: 'Declined', withdrawn: 'Withdrawn',
};

function addr(a) {
  if (!a) return '';
  if (typeof a === 'string') return a;
  return a.oneLine || [a.street || a.line1, a.city, a.state].filter(Boolean).join(', ') || '';
}

export default function TpoPipeline() {
  const [rows, setRows] = useState(null);   // null = loading
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.tpoApplications()
      .then(r => { if (live) setRows(Array.isArray(r?.applications) ? r.applications : []); })
      .catch(e => { if (live) { setErr(e.message || 'Could not load your pipeline'); setRows([]); } });
    return () => { live = false; };
  }, []);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Your pipeline</h1>
        <p className="muted small" style={{ marginTop: 6 }}>
          Every loan your firm has brought to YS Capital.
        </p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}

      {rows === null && <div className="muted">Loading…</div>}

      {rows !== null && rows.length === 0 && !err && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No loans yet</div>
          <div className="muted small">Loans you register with YS Capital will appear here.</div>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Loan #</th>
                <th style={{ textAlign: 'left' }}>Borrower</th>
                <th style={{ textAlign: 'left' }}>Property</th>
                <th style={{ textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.ys_loan_number || <span className="muted">—</span>}</td>
                  <td>{r.borrower_name || <span className="muted">—</span>}</td>
                  <td>{addr(r.property_address) || <span className="muted">—</span>}</td>
                  <td><span className="pill">{STATUS_LABEL[r.status] || r.status || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
