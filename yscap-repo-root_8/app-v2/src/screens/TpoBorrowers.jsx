import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

/* The firm's borrower book — everyone the firm has a loan for, with full PII on
   each profile. Firm-scoped server-side. */
export default function TpoBorrowers() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  useEffect(() => {
    let live = true;
    api.tpoBorrowers()
      .then((r) => { if (live) setRows(Array.isArray(r?.borrowers) ? r.borrowers : []); })
      .catch((e) => { if (live) { setErr(e.message || 'Could not load your borrowers'); setRows([]); } });
    return () => { live = false; };
  }, []);

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Your borrowers</h1>
        <p className="muted small" style={{ marginTop: 6 }}>Everyone you have a loan for with YS Capital.</p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      {rows === null && <div className="muted">Loading…</div>}

      {rows !== null && rows.length === 0 && !err && (
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>No borrowers yet</div>
          <div className="muted small">Enter a loan and the borrower will appear here.</div>
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Name</th>
                <th style={{ textAlign: 'left' }}>Email</th>
                <th style={{ textAlign: 'left' }}>Phone</th>
                <th style={{ textAlign: 'left' }}>SSN</th>
                <th style={{ textAlign: 'left' }}>Files</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td><Link to={`/tpo/borrower/${b.id}`}>{b.full_name || <span className="muted">(no name)</span>}</Link></td>
                  <td>{b.email}</td>
                  <td>{b.cell_phone || <span className="muted">—</span>}</td>
                  <td>{b.has_ssn ? `•••-••-${b.ssn_last4 || '····'}` : <span className="muted">—</span>}</td>
                  <td>{b.file_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
