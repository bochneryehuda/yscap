import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';

// #83 — the loan officer's book of borrowers. Everyone on a file they run (or,
// for staff who see all files, everyone), with portal-account state and last
// login, plus the three actions an LO needs day to day: invite the borrower to
// the portal, email them a reset link, or set a password for them directly.

function ago(iso) {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!isFinite(then)) return null;
  const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24); if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

export default function StaffBorrowers() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState('');         // `${action}:${id}`
  const [pwFor, setPwFor] = useState(null);     // borrower id whose set-password form is open
  const [pwVal, setPwVal] = useState('');

  const load = () => api.staffBorrowers().then(setRows).catch(e => setErr(e.message || 'Failed to load'));
  useEffect(() => { load(); }, []);

  function flash(t) { setMsg(t); setErr(''); setTimeout(() => setMsg(''), 3500); }
  function fail(t) { setErr(t); setTimeout(() => setErr(''), 5000); }

  async function invite(b) {
    setBusy('invite:' + b.id);
    try { await api.staffBorrowerInvite(b.id); flash(`Portal invite sent to ${b.email}.`); await load(); }
    catch (e) { fail(e.message || 'Invite failed'); }
    finally { setBusy(''); }
  }
  async function reset(b) {
    setBusy('reset:' + b.id);
    try { await api.staffBorrowerResetPassword(b.id); flash(`Reset link emailed to ${b.email}.`); }
    catch (e) { fail(e.message || 'Reset failed'); }
    finally { setBusy(''); }
  }
  async function setPassword(b) {
    if (pwVal.length < 8) { fail('Password must be at least 8 characters.'); return; }
    setBusy('setpw:' + b.id);
    try {
      await api.staffBorrowerSetPassword(b.id, pwVal);
      flash(`Password set for ${b.first_name || 'the borrower'}. Any open sessions were signed out.`);
      setPwFor(null); setPwVal('');
      await load();
    } catch (e) { fail(e.message || 'Could not set password'); }
    finally { setBusy(''); }
  }

  const [sortKey, setSortKey] = useState('recent');   // recent | name | officer | files
  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    let list = !needle ? rows.slice() : rows.filter(b =>
      `${b.first_name || ''} ${b.last_name || ''} ${b.email || ''} ${b.cell_phone || ''} ${b.loan_officer_name || ''}`.toLowerCase().includes(needle));
    const cmp = {
      name: (a, b) => `${a.last_name || ''} ${a.first_name || ''}`.trim().localeCompare(`${b.last_name || ''} ${b.first_name || ''}`.trim()),
      officer: (a, b) => String(a.loan_officer_name || '~~~').localeCompare(String(b.loan_officer_name || '~~~')),
      files: (a, b) => (b.files || 0) - (a.files || 0),
      recent: (a, b) => new Date(b.last_login_at || b.last_seen_at || 0) - new Date(a.last_login_at || a.last_seen_at || 0),
    }[sortKey];
    return cmp ? list.sort(cmp) : list;
  }, [rows, q, sortKey]);

  return (
    <div className="wrap">
      <div className="row" style={{ alignItems: 'center', marginBottom: 12 }}>
        <h1 style={{ margin: 0 }}>Borrowers</h1>
        <div className="spacer" />
        <select className="input" value={sortKey} onChange={e => setSortKey(e.target.value)} style={{ maxWidth: 170 }} title="Sort borrowers">
          <option value="recent">Most recent</option>
          <option value="name">Name (A–Z)</option>
          <option value="officer">Loan officer</option>
          <option value="files"># of files</option>
        </select>
        <input className="input" placeholder="Search name, email, phone, officer…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 280, marginLeft: 8 }} />
      </div>
      <p className="muted small" style={{ marginTop: 0 }}>
        Your borrowers — open a borrower to see their full CRM profile, or invite them to the portal, email a password reset, or set a password. Last login shows their most recent portal sign-in.
      </p>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {filtered == null ? <p className="muted">Loading…</p>
        : filtered.length === 0 ? <p className="muted">{q ? 'No borrowers match your search.' : 'No borrowers on your files yet.'}</p>
        : (
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ padding: '10px 12px' }}>Borrower</th>
                <th style={{ padding: '10px 12px' }}>Contact</th>
                <th style={{ padding: '10px 12px' }}>Loan officer</th>
                <th style={{ padding: '10px 12px' }}>Files</th>
                <th style={{ padding: '10px 12px' }}>Portal</th>
                <th style={{ padding: '10px 12px' }}>Last login</th>
                <th style={{ padding: '10px 12px', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(b => {
                const name = `${b.first_name || ''} ${b.last_name || ''}`.trim() || '(no name)';
                const last = ago(b.last_login_at);
                return (
                  <React.Fragment key={b.id}>
                    <tr style={{ borderTop: '1px solid var(--line, rgba(127,169,176,.2))' }}>
                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                        <Link to={`/internal/borrowers/${b.id}`}>{name}</Link>
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <div className="small">{b.email || '—'}</div>
                        <div className="muted small">{b.cell_phone || ''}</div>
                      </td>
                      <td style={{ padding: '10px 12px' }} className="small">{b.loan_officer_name || <span className="muted">—</span>}</td>
                      <td style={{ padding: '10px 12px' }}>
                        {b.latest_file_id
                          ? <Link to={`/internal/app/${b.latest_file_id}`} title="Open the most recent file">{b.files}</Link>
                          : b.files}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {b.has_account
                          ? <span className="pill" style={{ borderColor: 'var(--ok)', color: 'var(--ok)' }}>Active</span>
                          : <span className="pill">No account</span>}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        {b.has_account ? (last || <span className="muted">never</span>) : <span className="muted">—</span>}
                      </td>
                      <td style={{ padding: '10px 12px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        {!b.has_account && (
                          <button className="btn primary small" disabled={busy === 'invite:' + b.id || !b.email}
                            title={b.email ? 'Email a set-password invite for their latest file' : 'No email on file'}
                            onClick={() => invite(b)}>{busy === 'invite:' + b.id ? '…' : 'Invite'}</button>
                        )}
                        {b.has_account && (
                          <button className="btn ghost small" disabled={busy === 'reset:' + b.id || !b.email}
                            title="Email the borrower a password-reset link" onClick={() => reset(b)}>
                            {busy === 'reset:' + b.id ? '…' : 'Reset password'}</button>
                        )}
                        <button className="btn ghost small" style={{ marginLeft: 6 }}
                          onClick={() => { setPwFor(pwFor === b.id ? null : b.id); setPwVal(''); }}
                          title="Set a password for this borrower directly">
                          {pwFor === b.id ? 'Cancel' : 'Set password'}</button>
                      </td>
                    </tr>
                    {pwFor === b.id && (
                      <tr style={{ background: 'rgba(127,169,176,.06)' }}>
                        <td colSpan={7} style={{ padding: '10px 12px' }}>
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="small">Set a new password for <strong>{name}</strong>:</span>
                            <input className="input" type="text" autoComplete="off" placeholder="At least 8 characters"
                              value={pwVal} onChange={e => setPwVal(e.target.value)} style={{ maxWidth: 260 }} />
                            <button className="btn primary small" disabled={busy === 'setpw:' + b.id} onClick={() => setPassword(b)}>
                              {busy === 'setpw:' + b.id ? 'Saving…' : 'Set password'}</button>
                            <span className="muted small">The borrower can sign in with this immediately; open sessions are signed out.</span>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
