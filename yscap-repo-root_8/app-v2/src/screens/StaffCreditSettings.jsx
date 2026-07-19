import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import PasswordInput from '../components/PasswordInput.jsx';

/* Each loan officer's OWN credit-vendor login (Xactus). The password is
   write-only: it can be set here but never read back — the screen only ever
   shows the login identifier and a verification status. Every officer manages
   only their own credential; there is no path to see anyone else's. */

const STATUS_LABEL = {
  ok: { text: 'Verified', cls: 'ok' },
  unverified: { text: 'Saved — will verify on first use', cls: '' },
  invalid: { text: 'Login was rejected — re-enter it', cls: 'err' },
  none: { text: 'Not set up yet', cls: '' },
};

const dayFmt = (v) => {
  if (!v) return null;
  try { return new Date(v).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }); } catch (_) { return null; }
};
const daysSince = (v) => {
  if (!v) return null;
  const ms = Date.now() - new Date(v).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 86400000) : null;
};

function ProviderCard({ p, onSaved }) {
  const [ident, setIdent] = useState(p.operatorIdentifier || '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  async function save() {
    setErr(''); setMsg('');
    if (!ident.trim()) { setErr('Enter your login identifier.'); return; }
    if (!password) { setErr('Enter your password.'); return; }
    setBusy(true);
    try {
      const r = await api.creditSetCredential({ providerId: p.providerId, operatorIdentifier: ident.trim(), password });
      setPassword('');
      setMsg(r.message || 'Saved.');
      await onSaved();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }
  async function test() {
    setErr(''); setMsg(''); setTesting(true);
    try {
      const r = await api.creditTestCredential({ providerId: p.providerId });
      setMsg(r.message || (r.ok ? 'Login verified.' : 'Login could not be verified.'));
      await onSaved();
    } catch (e) { setErr(e.message); }
    finally { setTesting(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove your ${p.displayName} login?`)) return;
    setBusy(true); setErr(''); setMsg('');
    try { await api.creditDelCredential(p.providerId); setIdent(''); setPassword(''); await onSaved(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  const st = STATUS_LABEL[p.status] || STATUS_LABEL.none;
  const verifiedOn = dayFmt(p.lastVerifiedAt);
  const ageDays = daysSince(p.updatedAt);
  // A gentle rotation nudge: a login not updated/verified in 6 months is worth
  // re-entering (passwords rotate, and a stale one fails a pull mid-file).
  const stale = p.hasCredential && ageDays != null && ageDays >= 180;
  return (
    <div className="panel" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <strong>{p.displayName}</strong>
        <span className={`notice ${st.cls}`} style={{ padding: '2px 8px', fontSize: 12 }}>{st.text}</span>
      </div>
      <div className="grid cols-2" style={{ marginTop: 8 }}>
        <div className="field">
          <label>Login identifier</label>
          <input className="input" value={ident} autoComplete="username"
            onChange={e => setIdent(e.target.value)} placeholder="Your Xactus LoginAccountIdentifier" />
        </div>
        <div className="field">
          <label>Password {p.hasCredential && <span className="muted small">(re-enter to update)</span>}</label>
          <PasswordInput value={password} autoComplete="new-password"
            onChange={e => setPassword(e.target.value)} placeholder={p.hasCredential ? '••••••••' : 'Your Xactus password'} />
        </div>
      </div>
      {p.hasCredential && (
        <div className="muted small" style={{ marginTop: 8 }}>
          {verifiedOn ? `Last verified ${verifiedOn}.` : 'Not verified yet.'}
          {stale && <span style={{ color: 'var(--gold)' }}> · This login is over 6 months old — consider re-entering it.</span>}
        </div>
      )}
      {err && <div className="notice err" role="alert" style={{ marginTop: 8 }}>{err}</div>}
      {msg && <div className="notice ok" style={{ marginTop: 8 }}>{msg}</div>}
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <button className="btn primary" disabled={busy || testing} onClick={save}>{busy ? 'Saving…' : 'Save login'}</button>
        {p.hasCredential && <button className="btn ghost" disabled={busy || testing} onClick={test}>{testing ? 'Testing…' : 'Test my login'}</button>}
        {p.hasCredential && <button className="btn ghost" disabled={busy || testing} onClick={remove}>Remove</button>}
      </div>
    </div>
  );
}

export default function StaffCreditSettings() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState('');

  const load = () => api.creditCredentials().then(r => setRows(r.credentials || [])).catch(e => setErr(e.message));
  useEffect(() => { load(); }, []);

  return (
    <div className="screen" style={{ maxWidth: 720, margin: '0 auto' }}>
      <h1>Credit provider login</h1>
      <p className="muted small">
        Your personal login for pulling and reissuing credit reports. It is encrypted and
        write-only — we never show it again. Each loan officer uses their own login.
      </p>
      {err && <div className="notice err" role="alert">{err}</div>}
      {rows === null && !err && <p className="muted">Loading…</p>}
      {rows && rows.length === 0 && <p className="muted">No credit providers are enabled yet.</p>}
      {rows && rows.map(p => <ProviderCard key={p.providerId} p={p} onSaved={load} />)}
    </div>
  );
}
