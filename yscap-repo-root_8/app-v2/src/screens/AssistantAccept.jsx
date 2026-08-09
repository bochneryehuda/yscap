import React, { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { passwordProblem } from '../lib/password.js';

/* A borrower's HELPER (assistant) sets their password from the emailed invite
   link and lands straight in the borrower's portal — restricted to helper
   access (no personal details, no signing).

   This is a one-time SET-YOUR-PASSWORD page, not a second sign-in page: from
   here on the helper signs in on the ONE client login screen with the email and
   password they just chose (owner-directed 2026-08-09), which is why every way
   off this screen goes to /login. */
export default function AssistantAccept() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { signIn } = useAuth();
  const token = params.get('token') || '';

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
      const r = await api.assistantAccept(token, pw);
      if (r && r.token) { signIn(r.token); nav('/dashboard'); }
      else nav('/login');
    } catch (e) { setErr(e.message || 'This invitation is invalid or has expired.'); }
    finally { setBusy(false); }
  }

  if (!token)
    return (
      <AuthShell title="Invitation missing" subtitle="This page needs a valid helper invitation link.">
        <div role="alert" className="notice err">Open the invitation link from your email.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Go to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title="Set up your helper login"
      subtitle="Choose a password to finish setting up. As a helper you can work the loan in the portal, but you won’t see personal details or sign documents.">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Password</label>
        <PasswordInput autoComplete="new-password" rules value={pw} onChange={e => setPw(e.target.value)} /></div>
      <div className="field"><label>Confirm password</label>
        <PasswordInput autoComplete="new-password" value={pw2} onChange={e => setPw2(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <button className="btn primary btn-block" style={{ marginTop: 8 }}
        disabled={busy || !pw || !pw2} onClick={submit}>
        {busy ? 'Setting up…' : 'Activate helper login'}
      </button>
      <div className="auth-alt">
        Next time, sign in on the usual{' '}
        <button className="btn link" onClick={() => nav('/login')}>sign-in page</button>{' '}
        with this email and password.
      </div>
    </AuthShell>
  );
}
