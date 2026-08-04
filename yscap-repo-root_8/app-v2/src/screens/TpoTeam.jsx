import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* The firm's own team — every user on the broker's firm. A FIRM ADMIN can invite
   their own processors (or additional broker officers) to the SAME firm; the
   firm is always their own (server-enforced), and a firm admin can never mint
   another firm admin (that stays a YS Capital decision). A non-admin broker sees
   the roster read-only. */

const ROLE_LABEL = { tpo_officer: 'Loan Officer (Broker)', tpo_processor: 'Processor' };

export default function TpoTeam() {
  const [team, setTeam] = useState(null);   // null = loading
  const [isFirmAdmin, setIsFirmAdmin] = useState(false);
  const [err, setErr] = useState('');

  // invite form
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('tpo_processor');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);   // { emailed, acceptUrl }

  const load = () => {
    api.tpoTeam()
      .then(r => setTeam(Array.isArray(r?.team) ? r.team : []))
      .catch(e => { setErr(e.message || 'Could not load your team'); setTeam([]); });
  };

  useEffect(() => {
    let live = true;
    api.tpoMe().then(r => { if (live) setIsFirmAdmin(!!r?.is_firm_admin); }).catch(() => {});
    load();
    return () => { live = false; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  async function invite() {
    setErr(''); setResult(null);
    const e = email.trim();
    if (!e) return setErr('Enter an email address.');
    setBusy(true);
    try {
      const r = await api.tpoTeamInvite({ email: e, fullName: fullName.trim() || undefined, role });
      setResult({ emailed: !!r?.emailed, acceptUrl: r?.acceptUrl || '' });
      setEmail(''); setFullName('');
      load();
    } catch (ex) { setErr(ex.message || 'Could not send the invitation'); }
    finally { setBusy(false); }
  }

  return (
    <div>
      <div className="page-head" style={{ marginBottom: 18 }}>
        <h1 style={{ margin: 0 }}>Your team</h1>
        <p className="muted small" style={{ marginTop: 6 }}>Everyone at your firm who can work loans with YS Capital.</p>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}

      {isFirmAdmin && (
        <div className="card" style={{ padding: 20, marginBottom: 18 }}>
          <div style={{ fontWeight: 600, marginBottom: 10 }}>Invite a team member</div>
          {result && (
            <div className="notice info" style={{ marginBottom: 12 }}>
              {result.emailed
                ? 'Invitation sent. They will get an email with a link to set up their account.'
                : 'Invitation created. Email delivery is off, so share this link with them:'}
              {!result.emailed && result.acceptUrl &&
                <div className="small" style={{ marginTop: 6, wordBreak: 'break-all' }}>{result.acceptUrl}</div>}
            </div>
          )}
          <div className="field"><label>Email</label>
            <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)}
              placeholder="name@yourfirm.com" /></div>
          <div className="field"><label>Full name (optional)</label>
            <input className="input" value={fullName} onChange={e => setFullName(e.target.value)}
              placeholder="First and last name" /></div>
          <div className="field"><label>Role</label>
            <select className="input" value={role} onChange={e => setRole(e.target.value)}>
              <option value="tpo_processor">Processor</option>
              <option value="tpo_officer">Loan Officer (Broker)</option>
            </select></div>
          <button className="btn primary" disabled={busy} onClick={invite}>
            {busy ? 'Sending…' : 'Send invitation'}
          </button>
        </div>
      )}

      {team === null && <div className="muted">Loading…</div>}
      {team !== null && (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Name</th>
                <th style={{ textAlign: 'left' }}>Email</th>
                <th style={{ textAlign: 'left' }}>Role</th>
                <th style={{ textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {team.map(m => (
                <tr key={m.id}>
                  <td>{m.full_name || <span className="muted">—</span>}{m.is_firm_admin && <span className="pill" style={{ marginLeft: 8 }}>Admin</span>}</td>
                  <td>{m.email}</td>
                  <td>{ROLE_LABEL[m.role] || m.role}</td>
                  <td>
                    {m.is_active === false
                      ? <span className="pill">Inactive</span>
                      : m.has_login
                        ? <span className="pill">Active</span>
                        : <span className="pill">Invited</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
