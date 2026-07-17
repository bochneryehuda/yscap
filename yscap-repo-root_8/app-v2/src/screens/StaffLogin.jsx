import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth, useAuthNotice } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { returnDest } from './Login.jsx';

export default function StaffLogin() {
  const { signIn } = useAuth();
  const notice = useAuthNotice();
  const nav = useNavigate();
  const loc = useLocation();
  const [mode, setMode] = useState('login');   // login | mfa
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [useBackup, setUseBackup] = useState(false);   // 2FA: type a backup code instead
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const done = (t) => { signIn(t); nav(returnDest(loc, '/internal')); };

  async function submitLogin() {
    setErr(''); setBusy(true);
    try {
      const r = await api.staffLogin(email.trim(), password);
      if (r.mfaRequired) { setChallenge(r.challenge); setMode('mfa'); }
      // Cross-surface routing can return a BORROWER outcome here (someone with a
      // borrower account typed into staff sign-in): an unconfirmed borrower gets
      // verifyRequired — show a clear message instead of a blank dead-end.
      else if (r.verifyRequired) { setErr('This is a borrower account that still needs email confirmation. Check your email for the activation link, then sign in on the client login.'); }
      else if (!r.token) { setErr('Sign-in failed'); }
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
    <AuthShell
      variant="staff"
      title={mode === 'mfa' ? 'Enter your code' : 'Staff sign in'}
      subtitle={mode === 'mfa'
        ? 'Open your authenticator app and enter the 6-digit code.'
        : 'For loan officers, processors, underwriters and administrators.'}>
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
                  <button className="btn link small pw-forgot" onClick={() => nav('/internal/forgot')}>Forgot password?</button>
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
            <div className="field">
              <label>{useBackup ? 'Backup code' : '6-digit code'}</label>
              {useBackup
                ? <input className="input" autoComplete="one-time-code" placeholder="xxxxx-xxxxx" value={code}
                    onChange={e => setCode(e.target.value)} onKeyDown={onKey(submitMfa)} autoFocus />
                : <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                    onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={onKey(submitMfa)} autoFocus />}
              <button type="button" className="btn link small" style={{ marginTop: 4 }}
                onClick={() => { setUseBackup(v => !v); setCode(''); setErr(''); }}>
                {useBackup ? 'Use your authenticator code instead' : 'Lost your device? Use a backup code'}
              </button>
            </div>
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
    </AuthShell>
  );
}
