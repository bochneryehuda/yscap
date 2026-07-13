import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* The Archived folder — files that were archived (soft-removed) leave the
   pipeline and the dashboard figures but are kept here and can be restored, or
   deleted permanently. Gated by the delete_files capability. */

const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const addrLine = (a) => !a ? '—' : (a.oneLine || [a.line1 || a.street, a.city, a.state].filter(Boolean).join(', ') || '—');

export default function StaffArchived() {
  const { can } = useAuth();
  const allowed = can('delete_files');
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');

  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(''), 4000); };
  const load = () => api.staffArchivedApps().then(setRows).catch((e) => { setErr(e.message || 'Could not load'); setRows([]); });
  useEffect(() => { if (allowed) load(); }, [allowed]);

  async function restore(a) {
    if (busy) return;
    setBusy(a.id); setErr('');
    try { await api.staffRestoreApp(a.id); flash(`${a.ys_loan_number || 'File'} restored to the pipeline ✓`); await load(); }
    catch (e) { setErr(e.message || 'Could not restore'); }
    finally { setBusy(''); }
  }
  async function purge(a) {
    if (busy) return;
    if (!window.confirm(`Delete ${a.ys_loan_number || 'this file'} PERMANENTLY? This removes the loan file and every document, condition and message under it. It cannot be undone.`)) return;
    const typed = window.prompt('This is permanent. Type DELETE to confirm.');
    if (typed !== 'DELETE') { if (typed !== null) setErr('Not deleted — you must type DELETE to confirm.'); return; }
    setBusy(a.id); setErr('');
    try { await api.staffPurgeApp(a.id); flash(`${a.ys_loan_number || 'File'} deleted permanently.`); await load(); }
    catch (e) { setErr(e.message || 'Could not delete'); }
    finally { setBusy(''); }
  }

  if (!allowed) return <div role="alert" className="notice err">You do not have permission to manage archived files.</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 8, alignItems: 'baseline' }}>
        <h1 style={{ margin: 0 }}>Archived files</h1>
        <div className="spacer" />
        <span className="muted small">{rows ? `${rows.length} archived` : ''}</span>
      </div>
      <p className="muted" style={{ marginTop: 2, marginBottom: 14 }}>
        Archived files are out of the pipeline and excluded from every dashboard figure. Restore one to
        bring it back, or delete it permanently — a permanent delete removes the file and everything under
        it and cannot be undone.
      </p>
      {msg && <div className="notice ok" style={{ marginBottom: 12 }}>{msg}</div>}
      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}

      {rows == null ? <div className="panel muted">Loading…</div>
        : rows.length === 0 ? <div className="panel muted">No archived files. Archiving a file from its page moves it here.</div>
        : (
          <div className="panel" style={{ padding: 0 }}>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr><th>Loan #</th><th>Borrower</th><th>Property</th><th>Program</th><th>Loan amount</th><th>Archived</th><th></th></tr>
                </thead>
                <tbody>
                  {rows.map((a) => (
                    <tr key={a.id}>
                      <td><Link to={`/internal/app/${a.id}`}>{a.ys_loan_number || '—'}</Link></td>
                      <td>{[a.first_name, a.last_name].filter(Boolean).join(' ') || a.email || '—'}</td>
                      <td>{addrLine(a.property_address)}</td>
                      <td>{a.program || '—'}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>{money(a.loan_amount)}</td>
                      <td className="muted small">{a.deleted_at ? new Date(a.deleted_at).toLocaleDateString() : '—'}</td>
                      <td>
                        <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
                          <button className="btn ghost small" disabled={busy === a.id} onClick={() => restore(a)}>Restore</button>
                          <button className="btn link small" style={{ color: 'var(--danger,#e06666)' }} disabled={busy === a.id} onClick={() => purge(a)}>Delete permanently</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
    </>
  );
}
