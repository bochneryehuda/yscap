import React, { useEffect, useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

export default function Verify() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const token = params.get('token') || '';

  const [state, setState] = useState(token ? 'checking' : 'idle'); // checking|ok|idle|sent
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try { await api.verifyEmail({ token }); setState('ok'); }
      catch (e) { setErr(e.message || 'This verification link is invalid or has expired.'); setState('idle'); }
    })();
  }, [token]);

  async function verifyByCode() {
    setErr(''); setBusy(true);
    try { await api.verifyEmail({ email: email.trim(), code: code.trim() }); setState('ok'); }
    catch (e) { setErr(e.message || 'Invalid code.'); }
    finally { setBusy(false); }
  }
  async function resend() {
    setErr(''); setBusy(true);
    try { await api.resendVerification(email.trim()); setState('sent'); }
    catch (e) { setErr(e.message || 'Could not send.'); }
    finally { setBusy(false); }
  }

  if (state === 'checking')
    return <AuthShell title="Confirming your email" subtitle="One moment…" ><div className="muted small">Checking your verification link…</div></AuthShell>;

  if (state === 'ok')
    return (
      <AuthShell title="Email confirmed" subtitle="Your borrower portal access is active.">
        <div className="notice ok">You're all set. You can now sign in to YS Capital Group.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Continue to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title="Verify your email"
      subtitle="Enter the 6-digit code from your email, or request a new verification link.">
      {err && <div className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      {state === 'sent' && <div className="notice ok" style={{ marginBottom: 14 }}>
        If an unverified account exists for that address, a new verification email is on its way.</div>}

      <div className="field"><label>Email</label>
        <input className="input" type="email" value={email} onChange={e => setEmail(e.target.value)} /></div>
      <div className="field"><label>6-digit code</label>
        <input className="input" inputMode="numeric" maxLength={6} value={code}
          onChange={e => setCode(e.target.value.replace(/\D/g, ''))} /></div>

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !email || code.length < 6} onClick={verifyByCode}>Verify</button>
        <div className="spacer" />
        <button className="btn link" disabled={busy || !email} onClick={resend}>Resend link</button>
      </div>
      <div className="row" style={{ marginTop: 4 }}>
        <button className="btn link small" onClick={() => nav('/login')}>Back to sign in</button>
      </div>
    </AuthShell>
  );
}
