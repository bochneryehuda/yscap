import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import AuthShell from '../components/AuthShell.jsx';
import PasswordInput from '../components/PasswordInput.jsx';

/* Sign-in for a borrower's HELPER (assistant) — its own email + password. A
   helper works the loan in the borrower's portal but never sees personal details
   or signs documents. */
export default function AssistantLogin() {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    setErr(''); setBusy(true);
    try {
      const r = await api.assistantLogin(email.trim(), password);
      if (r && r.token) { signIn(r.token); nav('/dashboard'); }
      else setErr('Sign-in failed.');
    } catch (e) { setErr(e.message || 'Sign-in failed'); }
    finally { setBusy(false); }
  }

  return (
    <AuthShell title="Helper sign in"
      subtitle="Sign in to help with a loan. You can upload documents and track what’s needed, but you won’t see personal details or sign documents.">
      {err && <div role="alert" className="notice err" style={{ marginBottom: 14 }}>{err}</div>}
      <div className="field"><label>Email</label>
        <input type="email" autoComplete="username" value={email}
          onChange={e => setEmail(e.target.value)} placeholder="you@example.com" /></div>
      <div className="field"><label>Password</label>
        <PasswordInput autoComplete="current-password" value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && submit()} /></div>
      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn primary" disabled={busy || !email || !password} onClick={submit}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <div className="spacer" />
        <button className="btn link" onClick={() => nav('/login')}>Borrower sign in</button>
      </div>
    </AuthShell>
  );
}
