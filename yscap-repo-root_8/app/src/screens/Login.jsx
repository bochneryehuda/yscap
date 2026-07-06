import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { BrandLockup } from '../components/Layout.jsx';

export default function Login() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState('login');       // login | mfa | register
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState('');
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
    setErr(''); setBusy(true);
    try {
      const r = await api.register({ email: email.trim(), password, firstName: first.trim(), lastName: last.trim() });
      done(r.token);
    } catch (e) { setErr(e.message || 'Could not create account'); }
    finally { setBusy(false); }
  }
  const onKey = (fn) => (e) => { if (e.key === 'Enter') fn(); };

  return (
    <div className="authbg">
      <div className="authcard panel">
        <BrandLockup />
        <div className="gold-rule" />
        {mode === 'login' && <h1>Borrower sign in</h1>}
        {mode === 'mfa' && <h1>Enter your code</h1>}
        {mode === 'register' && <h1>Create your account</h1>}
        <p className="muted small" style={{ marginTop: 6 }}>
          {mode === 'mfa'
            ? 'Open your authenticator app and enter the 6-digit code.'
            : 'Access your loan files, documents and status with YS Capital Group.'}
        </p>

        {err && <div className="notice err" style={{ marginTop: 16 }}>{err}</div>}

        <div style={{ marginTop: 18 }}>
          {mode === 'register' && (
            <div className="grid cols-2">
              <div className="field"><label>First name</label>
                <input className="input" value={first} onChange={e => setFirst(e.target.value)} /></div>
              <div className="field"><label>Last name</label>
                <input className="input" value={last} onChange={e => setLast(e.target.value)} /></div>
            </div>
          )}
          {mode !== 'mfa' && (
            <>
              <div className="field"><label>Email</label>
                <input className="input" type="email" value={email}
                  onChange={e => setEmail(e.target.value)} onKeyDown={onKey(mode === 'login' ? submitLogin : submitRegister)} /></div>
              <div className="field"><label>Password</label>
                <input className="input" type="password" value={password}
                  onChange={e => setPassword(e.target.value)} onKeyDown={onKey(mode === 'login' ? submitLogin : submitRegister)} /></div>
            </>
          )}
          {mode === 'mfa' && (
            <div className="field"><label>6-digit code</label>
              <input className="input" inputMode="numeric" maxLength={6} value={code}
                onChange={e => setCode(e.target.value.replace(/\D/g, ''))} onKeyDown={onKey(submitMfa)} autoFocus /></div>
          )}
        </div>

        <div className="row" style={{ marginTop: 8 }}>
          {mode === 'login' && <button className="btn primary" disabled={busy} onClick={submitLogin}>Sign in</button>}
          {mode === 'mfa' && <button className="btn primary" disabled={busy} onClick={submitMfa}>Verify</button>}
          {mode === 'register' && <button className="btn primary" disabled={busy} onClick={submitRegister}>Create account</button>}
          <div className="spacer" />
          {mode === 'login' && <button className="btn link" onClick={() => { setErr(''); setMode('register'); }}>Create account</button>}
          {mode !== 'login' && <button className="btn link" onClick={() => { setErr(''); setMode('login'); }}>Back to sign in</button>}
        </div>

        {mode === 'login' && (
          <div className="row" style={{ marginTop: 4 }}>
            <button className="btn link small" onClick={() => nav('/forgot')}>Forgot password?</button>
            <div className="spacer" />
            <button className="btn link small" onClick={() => nav('/verify')}>Verify / resend email</button>
          </div>
        )}
        {mode === 'login' && (
          <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}>
            <button className="btn link small muted" onClick={() => nav('/internal/login')}>Internal sign in →</button>
          </div>
        )}
      </div>
    </div>
  );
}
