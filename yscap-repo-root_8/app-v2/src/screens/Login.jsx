import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth, useAuthNotice } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';
import { PASSWORD_HINT, passwordProblem } from '../lib/password.js';

export default function Login() {
  const { signIn } = useAuth();
  const notice = useAuthNotice();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');       // login | mfa | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
  const [useBackup, setUseBackup] = useState(false);   // 2FA: type a backup code instead
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const done = (t) => { signIn(t); nav('/dashboard'); };

  async function submitLogin() {
    setErr(''); setBusy(true);
    try {
      const r = await api.login(email.trim(), password);
      if (r.mfaRequired) { setChallenge(r.challenge); setMode('mfa'); }
      else done(r.token);
    } catch (e) { setErr(e.message || 'Sign-in failed'); }
    finally { setBusy(false); }
  }
  async function submitMfa() {
    setErr(''); setBusy(true);
    try { const r = await api.mfaVerify(challenge, code.trim()); done(r.token); }
    catch (e) { setErr(e.message || 'Invalid code'); }
    finally { setBusy(false); }
  }
  async function submitRegister() {
    setErr('');
    { const w = passwordProblem(password); if (w) return setErr(w); }
    setBusy(true);
    try {
      const r = await api.register({ email: email.trim(), password, firstName: first.trim(), lastName: last.trim() });
      done(r.token);
    } catch (e) { setErr(e.message || 'Could not create account'); }
    finally { setBusy(false); }
  }
  // Guard on `busy` so holding/double-tapping Enter can't fire a second auth
  // request while one is already in flight.
  const onKey = (fn) => (e) => { if (e.key === 'Enter' && !busy) fn(); };

  const submit = mode === 'login' ? submitLogin : mode === 'mfa' ? submitMfa : submitRegister;
  const heading = mode === 'mfa' ? 'Enter your code'
    : mode === 'register' ? 'Create your account'
    : 'Sign in';
  const subtitle = mode === 'mfa'
    ? 'Open your authenticator app and enter the 6-digit code.'
    : mode === 'register'
      ? 'Set up your account to track your loan files, documents and status.'
      : 'Access your loan files, documents and status with YS Capital Group.';

  return (
    <AuthShell title={heading} subtitle={subtitle}>
        {notice && !err && <div className="notice info" style={{ marginTop: 16 }}>{notice}</div>}
        {err && <div role="alert" className="notice err" style={{ marginTop: 16 }}>{err}</div>}

        <div style={{ marginTop: 18 }}>
          {mode === 'register' && (
            <div className="grid cols-2">
              <div className="field"><label>First name</label>
                <input className="input" autoComplete="given-name" value={first} onChange={e => setFirst(e.target.value)} /></div>
              <div className="field"><label>Last name</label>
                <input className="input" autoComplete="family-name" value={last} onChange={e => setLast(e.target.value)} /></div>
            </div>
          )}
          {mode !== 'mfa' && (
            <>
              <div className="field"><label>Email</label>
                <input className="input" type="email" autoComplete="username" value={email}
                  onChange={e => setEmail(e.target.value)} onKeyDown={onKey(submit)} /></div>
              <div className="field">
                <div className="field-row">
                  <label>Password</label>
                  {mode === 'login' &&
                    <button className="btn link small pw-forgot" onClick={() => nav('/forgot')}>Forgot password?</button>}
                </div>
                <PasswordInput
                  value={password}
                  autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                  onChange={e => setPassword(e.target.value)}
                  onKeyDown={onKey(submit)} />
                {mode === 'register' &&
                  <div className="hint" style={{ marginTop: 6 }}>{PASSWORD_HINT}</div>}
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
          {mode === 'login' ? 'Sign in' : mode === 'mfa' ? 'Verify' : 'Create account'}
        </button>

        <div className="auth-alt">
          {mode === 'login'
            ? <>New to YS&nbsp;Capital? <button className="btn link" onClick={() => { setErr(''); setMode('register'); }}>Create an account</button></>
            : <button className="btn link" onClick={() => { setErr(''); setMode('login'); }}>← Back to sign in</button>}
        </div>

        {mode === 'login' && (
          <div className="auth-foot">
            <button className="btn link small muted" onClick={() => nav('/verify')}>Verify email</button>
            <span className="auth-foot-sep" aria-hidden="true">·</span>
            <button className="btn link small muted" onClick={() => nav('/internal/login')}>Staff sign in</button>
          </div>
        )}
    </AuthShell>
  );
}
