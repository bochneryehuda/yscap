import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth, useAuthNotice } from '../lib/auth.jsx';
import { BrandLockup } from '../components/Layout.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

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
  // Guard on `busy` so Enter can't re-fire while a request is already in flight.
  const onKey = (fn) => (e) => { if (e.key === 'Enter' && !busy) fn(); };

  const submit = mode === 'login' ? submitLogin : submitMfa;

  return (
    <div className="authbg">
      <div className="authcard panel">
        <BrandLockup />
        <div className="gold-rule" />
        <h1>{mode === 'mfa' ? 'Enter your code' : 'Staff sign in'}</h1>
        <p className="muted small" style={{ marginTop: 6 }}>
          {mode === 'mfa'
            ? 'Open your authenticator app and enter the 6-digit code.'
            : 'For loan officers, processors, underwriters and administrators.'}
        </p>

        {notice && !err && <div className="notice info" style={{ marginTop: 16 }}>{notice}</div>}
        {err && <div role="alert" className="notice err" style={{ marginTop: 16 }}>{err}</div>}

        <div style={{ marginTop: 18 }}>
          {mode === 'login' && (
            <>
              <div className="field"><label>Work email</label>
                <input className="input" type="email" autoComplete="username" value={email}
                  onChange={e => setEmail(e.target.value)} onKeyDown={onKey(submitLogin)} autoFocus /></div>
              <div className="field">
                <div className="field-row">
                  <label>Password</label>
                  <button className="btn link small pw-forgot" onClick={() => nav('/forgot')}>Forgot password?</button>
                </div>
                <PasswordInput
                  value={password}
                  autoComplete="current-password"
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={onKey(submitLogin)} />
              </div>
            </>
          )}
          {mode === 'mfa' && (
            <div className="field"><label>6-digit code</label>
              <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={onKey(submitMfa)} autoFocus /></div>
          )}
        </div>

        <button className="btn primary btn-block" style={{ marginTop: 8 }} disabled={busy} onClick={submit}>
          {mode === 'login' ? 'Sign in' : 'Verify'}
        </button>

        {mode === 'mfa' && (
          <div className="auth-alt">
            <button className="btn link" onClick={() => { setErr(''); setMode('login'); }}>← Back</button>
          </div>
        )}

        <div className="auth-foot">
          <button className="btn link small muted" onClick={() => nav('/login')}>← Borrower sign in</button>
        </div>
      </div>
    </div>
  );
}
