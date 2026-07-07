import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, setToken } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

export default function Accept() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { signIn } = useAuth();
  const token = params.get('token') || '';

  const [fullName, setFullName] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr('');
    if (pw.length < 8) return setErr('Password must be at least 8 characters.');
    if (pw !== pw2) return setErr('Passwords do not match.');
    setBusy(true);
    try {
      const r = await api.acceptInvite({ token, password: pw, fullName: fullName.trim() || undefined });
      if (r && r.token) { signIn(r.token); nav('/dashboard'); }
      else nav('/login');
    } catch (e) { setErr(e.message || 'This invitation is invalid or has expired.'); }
    finally { setBusy(false); }
  }

  if (!token)
    return (
      <AuthShell title="Invitation missing" subtitle="This page needs a valid invitation link.">
        <div role="alert" className="notice err">Open the invitation link from your email.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Go to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title="Activate your account" subtitle="Set a password to finish setting up your access.">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Full name</label>
        <input className="input" autoComplete="name" value={fullName} onChange={e => setFullName(e.target.value)} /></div>
      <div className="field"><label>Password</label>
        <PasswordInput autoComplete="new-password" value={pw} onChange={e => setPw(e.target.value)} /></div>
      <div className="field"><label>Confirm password</label>
        <PasswordInput autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !pw || !pw2} onClick={submit}>Activate account</button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav('/login')}>Sign in instead</button>
      </div>
    </AuthShell>
  );
}
