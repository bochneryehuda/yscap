import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

export default function Reset() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (pw.length < 8) return setErr('Password must be at least 8 characters.');
    if (pw !== pw2) return setErr('Passwords do not match.');
    setBusy(true);
    try { await api.resetPassword(token, pw); setDone(true); }
    catch (e) { setErr(e.message || 'This reset link is invalid or has expired.'); }
    finally { setBusy(false); }
  }

  if (!token)
    return (
      <AuthShell title="Reset link missing" subtitle="This page needs a valid reset link.">
        <div className="notice err">Open the reset link from your email, or request a new one.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/forgot')}>Request a new link</button>
        </div>
      </AuthShell>
    );

  if (done)
    return (
      <AuthShell title="Password updated" subtitle="Your password has been changed.">
        <div className="notice ok">You can now sign in with your new password.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Continue to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title="Choose a new password" subtitle="Enter and confirm your new password below.">
      {err && <div className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>New password</label>
        <input className="input" type="password" value={pw} autoFocus onChange={e => setPw(e.target.value)} /></div>
      <div className="field"><label>Confirm password</label>
        <input className="input" type="password" value={pw2} onChange={e => setPw2(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !pw || !pw2} onClick={submit}>Update password</button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav('/login')}>Cancel</button>
      </div>
    </AuthShell>
  );
}
