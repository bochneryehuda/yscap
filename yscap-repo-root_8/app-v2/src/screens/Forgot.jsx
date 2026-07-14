import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

// The borrower portal and the staff console each get their OWN reset screen
// (owner-directed 2026-07-14): a dual account — someone who is both a borrower
// AND a staffer — must never receive two different reset emails. The screen's
// `scope` ('borrower' | 'staff') is hard-wired by its route (`/forgot` vs
// `/internal/login`'s `/internal/forgot`), so the reset request is always
// unambiguous and the backend sends exactly one email to the right login.
// A legacy `?for=` query param is honored as a fallback for old bookmarks.
export default function Forgot({ scope: scopeProp }) {
  const nav = useNavigate();
  const loc = useLocation();
  const scope = scopeProp || new URLSearchParams(loc.search).get('for') || 'borrower';
  const staff = scope === 'staff';
  const loginPath = staff ? '/internal/login' : '/login';
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setBusy(true);
    try { await api.forgotPassword(email.trim(), scope); setSent(true); }
    catch (e) { setErr(e.message || 'Could not process the request.'); }
    finally { setBusy(false); }
  }

  if (sent)
    return (
      <AuthShell title="Check your email"
        subtitle={staff ? 'Staff console password reset requested.' : 'Password reset requested.'}>
        <div className="notice ok">If {staff ? 'a staff' : 'an'} account exists for that address, a reset link is on its way. The link expires in 60 minutes.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav(loginPath)}>Back to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title={staff ? 'Reset your staff password' : 'Reset your password'}
      subtitle={staff
        ? 'Enter your staff console email and we’ll send you a secure reset link.'
        : 'Enter your account email and we’ll send you a secure reset link.'}>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Email</label>
        <input className="input" type="email" autoComplete="username" value={email} autoFocus
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && email && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !email} onClick={submit}>Send reset link</button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav(loginPath)}>Back to sign in</button>
      </div>
    </AuthShell>
  );
}
