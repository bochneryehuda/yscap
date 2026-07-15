import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

/* Email confirmation is ONE-CLICK (owner-directed #94): the emailed link carries
   a token that auto-verifies on load — no 6-digit code to type, no tight 24h
   window (the link is valid for 7 days). If someone lands here without a token
   (e.g. the link finally expired), they request a fresh activation link. */
export default function Verify() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [phase, setPhase] = useState(token ? 'checking' : 'request'); // checking|request|sent|ok
  const [email, setEmail] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try { await api.verifyEmail({ token }); setPhase('ok'); }
      catch (e) { setErr('That activation link is invalid or has expired — request a new one below.'); setPhase('request'); }
    })();
  }, [token]);

  async function sendLink() {
    setErr(''); setBusy(true);
    try { await api.resendVerification(email.trim()); setPhase('sent'); }
    catch (e) { setErr(e.message || 'Could not send the link. Please try again.'); }
    finally { setBusy(false); }
  }
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (phase === 'checking')
    return (
      <AuthShell title="Confirming your email" subtitle="One moment…">
        <div className="muted small">Activating your account…</div>
      </AuthShell>
    );

  if (phase === 'ok')
    return (
      <AuthShell title="Email confirmed" subtitle="Your access is active.">
        <div className="notice ok">You're all set. You can now sign in to PILOT.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Continue to sign in</button>
        </div>
      </AuthShell>
    );

  if (phase === 'sent')
    return (
      <AuthShell title="Check your email" subtitle="A fresh activation link is on its way.">
        <div className="notice ok">If an unverified account exists for that email, a one-click activation link is on its way. It's valid for 7 days.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn link small muted" onClick={() => nav('/login')}>Back to sign in</button>
        </div>
      </AuthShell>
    );

  // Request a fresh activation link (no code — activation is one-click).
  return (
    <AuthShell title="Confirm your email"
      subtitle="Enter your email and we'll send you a one-click activation link.">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Email</label>
        <input className="input" type="email" autoComplete="email" value={email} autoFocus
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && validEmail && sendLink()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !validEmail} onClick={sendLink}>
          {busy ? 'Sending…' : 'Email me a link'}
        </button>
        <div className="spacer" />
        <button className="btn link small muted" onClick={() => nav('/login')}>Back to sign in</button>
      </div>
    </AuthShell>
  );
}
