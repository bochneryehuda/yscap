import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth, useAuthNotice } from '../lib/auth.jsx';
import { BrandLockup } from '../components/Layout.jsx';

export default function StaffLogin() {
  const { signIn } = useAuth();
  const notice = useAuthNotice();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');   // login | mfa
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const done = (t) => { signIn(t); nav('/internal'); };

  async function submitLogin() {
    setErr(''); setBusy(true);
    try {
      const r = await api.staffLogin(email.trim(), password);
      if (r.mfaRequired) { setChallenge(r.challenge); setMode('mfa'); }
      else done(r.token);
    } catch (e) { setErr(e.message || 'Sign-in failed'); }
    finally { setBusy(false); }
  }
  async function submitMfa() {
    setErr(''); setBusy(true);
    try { const r = await api.staffMfaVerify(challenge, code.trim()); done(r.token); }
    catch (e) { setErr(e.message || 'Invalid code'); }
    finally { setBusy(false); }
  }
  const onKey = (fn) => (e) => { if (e.key === 'Enter') fn(); };

  return (
    <div className="authbg">
      <div className="authcard panel">
        <BrandLockup />
        <div className="gold-rule" />
        <h1>{mode === 'mfa' ? 'Enter your code' : 'Internal sign in'}</h1>
        <p className="muted small" style={{ marginTop: 6 }}>
          {mode === 'mfa'
            ? 'Open your authenticator app and enter the 6-digit code.'
            : 'Loan officers, processors, underwriters and administrators.'}
        </p>

        {notice && !err && <div className="notice info" style={{ marginTop: 16 }}>{notice}</div>}
        {err && <div className="notice err" style={{ marginTop: 16 }}>{err}</div>}

        <div style={{ marginTop: 18 }}>
          {mode === 'login' && (
            <>
              <div className="field"><label>Work email</label>
                <input className="input" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} onKeyDown={onKey(submitLogin)} autoFocus /></div>
              <div className="field"><label>Password</label>
                <input className="input" type="password" value={password}
                  onChange={e => setPassword(e.target.value)} onKeyDown={onKey(submitLogin)} /></div>
            </>
          )}
          {mode === 'mfa' && (
            <div className="field"><label>6-digit code</label>
              <input className="input" inputMode="numeric" maxLength={6} value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={onKey(submitMfa)} autoFocus /></div>
          )}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          {mode === 'login'
            ? <button className="btn primary" disabled={busy} onClick={submitLogin}>Sign in</button>
            : <button className="btn primary" disabled={busy} onClick={submitMfa}>Verify</button>}
          <div className="spacer" />
          {mode === 'login'
            ? <button className="btn link small" onClick={() => nav('/forgot')}>Forgot password?</button>
            : <button className="btn link" onClick={() => { setErr(''); setMode('login'); }}>Back</button>}
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn link small" onClick={() => nav('/login')}>← Borrower sign in</button>
        </div>
      </div>
    </div>
  );
}
