import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import AuthShell from '../components/AuthShell.jsx';

export default function Forgot() {
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit() {
    setErr(''); setBusy(true);
    try { await api.forgotPassword(email.trim()); setSent(true); }
    catch (e) { setErr(e.message || 'Could not process the request.'); }
    finally { setBusy(false); }
  }

  if (sent)
    return (
      <AuthShell title="Check your email" subtitle="Password reset requested.">
        <div className="notice ok">If an account exists for that address, a reset link is on its way. The link expires in 60 minutes.</div>
        <div className="row" style={{ marginTop: 16 }}>
          <button className="btn primary" onClick={() => nav('/login')}>Back to sign in</button>
        </div>
      </AuthShell>
    );

  return (
    <AuthShell title="Reset your password"
      subtitle="Enter your account email and we'll send you a secure reset link.">
      {err && <div className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Email</label>
        <input className="input" type="email" value={email} autoFocus
          onChange={e => setEmail(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && email && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !email} onClick={submit}>Send reset link</button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav('/login')}>Back to sign in</button>
      </div>
    </AuthShell>
  );
}
