import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api.js';
import { passwordProblem, PASSWORD_HINT } from '../lib/password.js';

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
    try { await api.staffBorrowerInvite(b.id); flash(`PILOT invite sent to ${b.email}.`); await load(); }
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
    { const w = passwordProblem(pwVal); if (w) { fail(w); return; } }
    setBusy('setpw:' + b.id);
    try {
      await api.staffBorrowerSetPassword(b.id, pwVal);
      flash(`Password set for ${b.first_name || 'the borrower'}. Any open sessions were signed out.`);
      setPwFor(null); setPwVal('');
      await load();
    } catch (e) { fail(e.message || 'Could not set password'); }
    finally { setBusy(''); }
  }

  const [sortKey, setSortKey] = useState('recent');   // recent | name | officer | files | portal | created
  const [officer, setOfficer] = useState('all');       // filter: '' = unassigned, else officer name
  // Distinct loan officers present in the list, for the "whose clients" filter.
  const officers = useMemo(() => rows
    ? [...new Set(rows.map(b => b.loan_officer_name).filter(Boolean))].sort((a, b) => a.localeCompare(b))
    : [], [rows]);
  const hasUnassigned = useMemo(() => !!(rows && rows.some(b => !b.loan_officer_name)), [rows]);
  const byName = (a, b) => `${a.last_name || ''} ${a.first_name || ''}`.trim().localeCompare(`${b.last_name || ''} ${b.first_name || ''}`.trim());
  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    let list = !needle ? rows.slice() : rows.filter(b =>
      `${b.first_name || ''} ${b.last_name || ''} ${b.email || ''} ${b.cell_phone || ''} ${b.loan_officer_name || ''}`.toLowerCase().includes(needle));
    // Filter to a single loan officer's clients (or the unassigned bucket).
    if (officer !== 'all') list = list.filter(b => (b.loan_officer_name || '') === (officer === '__none__' ? '' : officer));
    const cmp = {
      name: byName,
      // Group by officer, then by borrower name within each officer.
      officer: (a, b) => String(a.loan_officer_name || '~~~zzz').localeCompare(String(b.loan_officer_name || '~~~zzz')) || byName(a, b),
      files: (a, b) => (b.files || 0) - (a.files || 0) || byName(a, b),
      recent: (a, b) => new Date(b.last_login_at || b.last_seen_at || 0) - new Date(a.last_login_at || a.last_seen_at || 0),
      // Portal-active first, then by name — surfaces who still needs an invite.
      portal: (a, b) => (Number(!!b.has_account) - Number(!!a.has_account)) || byName(a, b),
      created: (a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0),
    }[sortKey];
    return cmp ? list.sort(cmp) : list;
  }, [rows, q, sortKey, officer]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Borrowers</h1>
          <div className="sub">Your borrowers across the book — open one for their full CRM profile, or invite to PILOT, email a reset, or set a password.</div>
        </div>
        <div className="page-head-actions">
          <select className="input" value={officer} onChange={e => setOfficer(e.target.value)} style={{ maxWidth: 200 }} title="Show only this loan officer's clients">
            <option value="all">All loan officers</option>
            {officers.map(o => <option key={o} value={o}>{o}</option>)}
            {hasUnassigned && <option value="__none__">(Unassigned)</option>}
          </select>
          <select className="input" value={sortKey} onChange={e => setSortKey(e.target.value)} style={{ maxWidth: 180 }} title="Sort borrowers">
            <option value="recent">Most recent login</option>
            <option value="name">Name (A–Z)</option>
            <option value="officer">Loan officer</option>
            <option value="files"># of files</option>
            <option value="portal">PILOT status</option>
            <option value="created">Newest added</option>
          </select>
          <input className="input" placeholder="Search name, email, phone, officer…" value={q} onChange={e => setQ(e.target.value)} style={{ maxWidth: 280 }} />
        </div>
      </div>
      {msg && <div className="notice ok">{msg}</div>}
      {err && <div role="alert" className="notice err">{err}</div>}

      {filtered == null ? <p className="muted">Loading…</p>
        : filtered.length === 0 ? <div className="empty-state"><h3>No borrowers</h3><p>{q ? 'No borrowers match your search.' : 'No borrowers on your files yet.'}</p></div>
        : (
        <div className="panel">
          <div className="panel-h">
            <h3>Directory</h3>
            <span className="pill mut">{filtered.length} of {rows.length}</span>
          </div>
          <div className="tbl-scroll">
          <table className="tbl">
            <thead>
              <tr>
                <th>Borrower</th>
                <th>Contact</th>
                <th>Loan officer</th>
                <th className="num">Files</th>
                <th>PILOT</th>
                <th>Last login</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(b => {
                const name = `${b.first_name || ''} ${b.last_name || ''}`.trim() || '(no name)';
                const ini = `${(b.first_name || ' ')[0] || ''}${(b.last_name || ' ')[0] || ''}`.trim().toUpperCase() || '—';
                const last = ago(b.last_login_at);
                return (
                  <React.Fragment key={b.id}>
                    <tr>
                      <td>
                        <span className="off">
                          <span className="mono">{ini}</span>
                          <Link className="lead" to={`/internal/borrowers/${b.id}`}>{name}</Link>
                        </span>
                      </td>
                      <td>
                        <div className="small">{b.email || '—'}</div>
                        <div className="muted small">{b.cell_phone || ''}</div>
                      </td>
                      <td className="mut">{b.loan_officer_name || <span className="muted">—</span>}</td>
                      <td className="num">
                        {b.latest_file_id
                          ? <Link to={`/internal/app/${b.latest_file_id}`} title="Open the most recent file">{b.files}</Link>
                          : b.files}
                      </td>
                      <td>
                        {b.has_account
                          ? <span className="pill ok">Active</span>
                          : <span className="pill mut">No account</span>}
                      </td>
                      <td className="mut">
                        {b.has_account ? (last || <span className="muted">never</span>) : <span className="muted">—</span>}
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
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
                      <tr style={{ background: 'var(--surface-soft)' }}>
                        <td colSpan={7} style={{ padding: '10px 12px' }}>
                          <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                            <span className="small">Set a new password for <strong>{name}</strong>:</span>
                            <input className="input" type="text" autoComplete="off" placeholder="New password"
                              value={pwVal} onChange={e => setPwVal(e.target.value)} style={{ maxWidth: 260 }} />
                            <button className="btn primary small" disabled={busy === 'setpw:' + b.id} onClick={() => setPassword(b)}>
                              {busy === 'setpw:' + b.id ? 'Saving…' : 'Set password'}</button>
                            <span className="muted small">The borrower can sign in with this immediately; open sessions are signed out.</span>
                          </div>
                          <div className="hint" style={{ marginTop: 6 }}>{PASSWORD_HINT}</div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </>
  );
}
