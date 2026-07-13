import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

/* Guided email confirmation:
   1) clicking the emailed link auto-verifies (token in the URL); otherwise
   2) enter email -> we send a 6-digit code -> enter the code -> confirmed.
   The two steps are explicit so there's never a code field with no way to get
   a code. */
export default function Verify() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [phase, setPhase] = useState(token ? 'checking' : 'request'); // checking|request|enter|ok
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try { await api.verifyEmail({ token }); setPhase('ok'); }
      catch (e) { setErr('That confirmation link is invalid or has expired — request a new code below.'); setPhase('request'); }
    })();
  }, [token]);

  async function sendCode() {
    setErr(''); setBusy(true);
    try { await api.resendVerification(email.trim()); setPhase('enter'); }
    catch (e) { setErr(e.message || 'Could not send the code. Please try again.'); }
    finally { setBusy(false); }
  }
  async function verifyByCode() {
    setErr(''); setBusy(true);
    try { await api.verifyEmail({ email: email.trim(), code: code.trim() }); setPhase('ok'); }
    catch (e) { setErr(e.message || 'That code is incorrect or has expired.'); }
    finally { setBusy(false); }
  }
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  if (phase === 'checking')
    return (
      <AuthShell title="Confirming your email" subtitle="One moment…">
        <div className="muted small">Checking your confirmation link…</div>
      </AuthShell>
    );

  if (phase === 'ok')
    return (
      <AuthShell title="Email confirmed" subtitle="Your PILOT access is active.">
        <div className="notice ok">You're all set. You can now sign in to PILOT.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Continue to sign in</button>
        </div>
      </AuthShell>
    );

  // Step 1 — request a code.
  if (phase === 'request')
    return (
      <AuthShell title="Confirm your email"
        subtitle="Enter your email and we'll send you a 6-digit confirmation code.">
        {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
        <div className="field"><label>Email</label>
          <input className="input" type="email" autoComplete="email" value={email} autoFocus
            onChange={e => setEmail(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && validEmail && sendCode()} /></div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn primary" disabled={busy || !validEmail} onClick={sendCode}>
            {busy ? 'Sending…' : 'Send me a code'}
          </button>
          <div className="spacer" />
          <button className="btn link small" disabled={!validEmail} onClick={() => { setErr(''); setPhase('enter'); }}>
            I already have a code
          </button>
        </div>
        <div className="row" style={{ marginTop: 4 }}>
          <button className="btn link small muted" onClick={() => nav('/login')}>Back to sign in</button>
        </div>
      </AuthShell>
    );

  // Step 2 — enter the code.
  return (
    <AuthShell title="Enter your code"
      subtitle={`Enter the 6-digit code we emailed to ${email || 'your address'}.`}>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="notice ok" style={{ marginBottom: 14 }}>
        If an unverified account exists for that email, a code is on its way. It expires in 24 hours.
      </div>
      <div className="field"><label>Email</label>
        <input className="input" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div className="field"><label>6-digit code</label>
        <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} autoFocus
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
          onKeyDown={e => e.key === 'Enter' && validEmail && code.length === 6 && verifyByCode()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !validEmail || code.length < 6} onClick={verifyByCode}>
          {busy ? 'Verifying…' : 'Verify email'}
        </button>
        <div className="spacer" />
        <button className="btn link" disabled={busy || !validEmail} onClick={sendCode}>Resend code</button>
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn link small muted" onClick={() => { setErr(''); setPhase('request'); }}>Use a different email</button>
      </div>
    </AuthShell>
  );
}
