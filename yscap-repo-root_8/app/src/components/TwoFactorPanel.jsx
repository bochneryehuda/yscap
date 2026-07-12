import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// Self-service two-factor (2FA). Optional and off by default: a borrower (or
// staffer) can turn it on with an authenticator app, save one-time backup codes
// for when they lose their phone, regenerate those codes, or turn 2FA back off.
// The endpoints are shared (the token identifies who) so this panel works on both
// the borrower Security screen and the staff console.
export default function TwoFactorPanel() {
  const [status, setStatus] = useState(null);   // { mfaEnabled, backupRemaining }
  const [phase, setPhase] = useState('idle');   // idle | setup | disabling | regen
  const [secret, setSecret] = useState('');
  const [code, setCode] = useState('');
  const [backupCodes, setBackupCodes] = useState(null);   // shown exactly once
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');

  async function load() { try { setStatus(await api.mfaStatus()); } catch (_) { /* leave hidden */ } }
  useEffect(() => { load(); }, []);

  const reset = () => { setErr(''); setOk(''); setCode(''); };

  async function startSetup() {
    reset(); setBusy(true);
    try { const r = await api.mfaSetup(); setSecret(r.secret); setPhase('setup'); }
    catch (e) { setErr(e.message || 'Could not start setup.'); }
    finally { setBusy(false); }
  }
  async function confirmEnable() {
    setErr(''); setBusy(true);
    try { const r = await api.mfaEnable(code.trim()); setBackupCodes(r.backupCodes || []); setPhase('idle'); setCode(''); await load(); }
    catch (e) { setErr(e.message || 'That code did not match — try again.'); }
    finally { setBusy(false); }
  }
  async function doDisable() {
    setErr(''); setBusy(true);
    try { await api.mfaDisable(code.trim()); setPhase('idle'); setCode(''); setBackupCodes(null); setOk('Two-factor is now off.'); await load(); }
    catch (e) { setErr(e.message || 'That code did not match.'); }
    finally { setBusy(false); }
  }
  async function doRegen() {
    setErr(''); setBusy(true);
    try { const r = await api.mfaRegenBackup(code.trim()); setBackupCodes(r.backupCodes || []); setPhase('idle'); setCode(''); await load(); }
    catch (e) { setErr(e.message || 'That code did not match.'); }
    finally { setBusy(false); }
  }

  if (!status) return null;
  const on = !!status.mfaEnabled;

  return (
    <div className="panel" style={{ marginBottom: 16 }}>
      <div className="row" style={{ marginBottom: 8, alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Two-factor authentication</h3>
        <span className={`pill ${on ? 'done' : ''}`} style={{ marginLeft: 8 }}>{on ? 'On' : 'Off'}</span>
      </div>
      <p className="muted small" style={{ marginBottom: 10 }}>
        Add a second step at sign-in using an authenticator app (Google Authenticator,
        Authy, 1Password…). It's optional — turn it on or off whenever you like.
      </p>
      {err && <div role="alert" className="notice err" style={{ marginBottom: 8 }}>{err}</div>}
      {ok && <div className="notice ok" style={{ marginBottom: 8 }}>{ok}</div>}

      {/* Backup codes are shown exactly once, right after enabling or regenerating. */}
      {backupCodes && (
        <div className="notice" style={{ marginBottom: 10 }}>
          <strong>Save your backup codes.</strong>
          <p className="muted small" style={{ margin: '4px 0 8px' }}>
            Each one works once if you ever lose your authenticator. Keep them somewhere safe —
            you won't be able to see them again.
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 4, fontFamily: 'monospace' }}>
            {backupCodes.map((c) => <div key={c}>{c}</div>)}
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <button className="btn" onClick={() => setBackupCodes(null)}>I've saved them</button>
          </div>
        </div>
      )}

      {/* Enabling: show the key to add to the app, then confirm a code. */}
      {phase === 'setup' && (
        <div style={{ marginBottom: 8 }}>
          <p className="small" style={{ marginBottom: 6 }}>
            1. In your authenticator app, add a new account and enter this key:
          </p>
          <div style={{ fontFamily: 'monospace', fontSize: 16, letterSpacing: 1, padding: '6px 10px',
            background: 'rgba(127,127,127,.10)', borderRadius: 6, wordBreak: 'break-all', marginBottom: 8 }}>{secret}</div>
          <p className="small" style={{ marginBottom: 6 }}>2. Enter the 6-digit code it shows:</p>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <input className="input" style={{ maxWidth: 160 }} inputMode="numeric" autoComplete="one-time-code"
              placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} />
            <button className="btn primary" disabled={busy || !code.trim()} onClick={confirmEnable}>Turn on 2FA</button>
            <button className="btn ghost" onClick={() => { setPhase('idle'); reset(); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Confirming a code to disable or regenerate. */}
      {(phase === 'disabling' || phase === 'regen') && (
        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
          <input className="input" style={{ maxWidth: 200 }} autoComplete="one-time-code"
            placeholder="Authenticator or backup code" value={code} onChange={(e) => setCode(e.target.value)} />
          {phase === 'disabling'
            ? <button className="btn danger" disabled={busy || !code.trim()} onClick={doDisable}>Turn off 2FA</button>
            : <button className="btn primary" disabled={busy || !code.trim()} onClick={doRegen}>Get new backup codes</button>}
          <button className="btn ghost" onClick={() => { setPhase('idle'); reset(); }}>Cancel</button>
        </div>
      )}

      {/* Idle controls. */}
      {phase === 'idle' && !on && (
        <button className="btn primary" disabled={busy} onClick={startSetup}>Turn on two-factor</button>
      )}
      {phase === 'idle' && on && (
        <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="muted small">Backup codes left: {status.backupRemaining}</span>
          <div className="spacer" />
          <button className="btn" onClick={() => { setPhase('regen'); reset(); }}>Regenerate backup codes</button>
          <button className="btn ghost" onClick={() => { setPhase('disabling'); reset(); }}>Turn off 2FA</button>
        </div>
      )}
    </div>
  );
}
