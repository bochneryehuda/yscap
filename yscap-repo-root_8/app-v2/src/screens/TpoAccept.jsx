import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { passwordProblem } from '../lib/password.js';

/* Where a broker (or a broker's processor) lands from their invitation email —
   `/tpo/accept?token=...`. It reuses the shared /auth/accept endpoint (the
   invite's stored kind='tpo' routes the server to create an is_external
   staff_users row and mint a kind='tpo' token). On success the broker is signed
   in and dropped straight onto their firm pipeline. Mirrors the borrower Accept
   screen, but branded for the broker portal and landing at /tpo. */
export default function TpoAccept() {
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
    { const w = passwordProblem(pw); if (w) return setErr(w); }
    if (pw !== pw2) return setErr('Passwords do not match.');
    setBusy(true);
    try {
      const r = await api.acceptInvite({ token, password: pw, fullName: fullName.trim() || undefined });
      if (r && r.token) { signIn(r.token); nav('/tpo'); }
      else nav('/tpo/login');
    } catch (e) { setErr(e.message || 'This invitation is invalid or has expired.'); }
    finally { setBusy(false); }
  }

  if (!token)
    return (
      <AuthShell variant="tpo" title="Invitation missing" subtitle="This page needs a valid invitation link.">
        <div role="alert" className="notice err">Open the invitation link from your email.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/tpo/login')}>Go to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell variant="tpo" title="Set up your broker access"
      subtitle="Choose a password to finish setting up your account with YS Capital.">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Your full name</label>
        <input className="input" autoComplete="name" value={fullName}
          onChange={e => setFullName(e.target.value)} placeholder="First and last name" /></div>
      <div className="field"><label>Password</label>
        <PasswordInput autoComplete="new-password" rules value={pw} onChange={e => setPw(e.target.value)} /></div>
      <div className="field"><label>Confirm password</label>
        <PasswordInput autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !pw || !pw2} onClick={submit}>Activate account</button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav('/tpo/login')}>Sign in instead</button>
      </div>
    </AuthShell>
  );
}
