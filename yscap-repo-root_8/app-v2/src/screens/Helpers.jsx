import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

/* HELPERS (borrower assistant logins) — a borrower gives someone their own login
   to help with the loan. A helper can do everything in the portal EXCEPT see
   personal details (SSN, date of birth, credit score) or sign documents.
   Borrower self-service only — a helper session never reaches this screen. */
export default function Helpers() {
  const { isAssistant } = useAuth();
  const [list, setList] = useState(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try { const r = await api.assistantsList(); setList(r.assistants || []); }
    catch { setList([]); }
  }, []);
  useEffect(() => { if (!isAssistant) load(); }, [load, isAssistant]);

  async function invite() {
    setErr(''); setNote('');
    const e = email.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return setErr('Enter a valid email address.');
    setBusy(true);
    try {
      const r = await api.assistantInvite(e, name.trim());
      setEmail(''); setName('');
      setNote(r && r.emailed ? 'Invitation sent — they’ll get an email to set up their login.'
        : 'Helper added. We couldn’t email the invitation just now — you can press “Resend invite”.');
      await load();
    } catch (ex) { setErr(ex.message || 'Could not add that helper.'); }
    finally { setBusy(false); }
  }
  async function resend(id) {
    setErr(''); setNote('');
    try { const r = await api.assistantResend(id); setNote(r && r.emailed ? 'Invitation re-sent.' : 'Couldn’t email just now — try again shortly.'); }
    catch (ex) { setErr(ex.message || 'Could not resend.'); }
  }
  async function remove(id) {
    if (!window.confirm('Remove this helper? Their login will stop working right away.')) return;
    setErr(''); setNote('');
    try { await api.assistantDisable(id); await load(); }
    catch (ex) { setErr(ex.message || 'Could not remove that helper.'); }
  }

  if (isAssistant)
    return <div className="notice">Only the borrower can manage helpers.</div>;

  return (
    <>
      <div className="row" style={{ marginBottom: 14 }}>
        <div>
          <h1>Helpers</h1>
          <p className="muted small">
            Give someone their own login to help with your loan — an assistant, a family member, whoever you trust.
            They can upload documents, track what’s needed and message your loan team. They <b>can’t</b> see your personal
            details (Social Security number, date of birth, credit score) and <b>can’t</b> sign documents — those stay with you.
          </p>
        </div>
      </div>

      {err && <div role="alert" className="notice err" style={{ marginBottom: 12 }}>{err}</div>}
      {note && <div className="notice" style={{ marginBottom: 12 }}>{note}</div>}

      <div className="panel" style={{ marginBottom: 16 }}>
        <h3 style={{ marginTop: 0 }}>Invite a helper</h3>
        <div className="field"><label>Their email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="helper@example.com" /></div>
        <div className="field"><label>Their name (optional)</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Sarah Cohen" maxLength={120} /></div>
        <button className="btn primary" onClick={invite} disabled={busy || !email}>
          {busy ? 'Sending…' : 'Send invitation'}
        </button>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Your helpers</h3>
        {list == null && <p className="muted small">Loading…</p>}
        {list && list.length === 0 && <p className="muted small">You haven’t added any helpers yet.</p>}
        {list && list.map((a) => (
          <div key={a.id} className="row" style={{ alignItems: 'baseline', gap: 8, flexWrap: 'wrap', padding: '10px 0', borderTop: '1px solid var(--line,#E7E1D3)' }}>
            <div style={{ minWidth: 0 }}>
              <strong>{a.name || a.email}</strong>
              {a.name && <span className="muted small" style={{ marginLeft: 8 }}>{a.email}</span>}
              <div className="muted small">
                {a.status === 'active'
                  ? (a.lastLoginAt ? 'Active' : 'Active — hasn’t signed in yet')
                  : 'Invited — waiting for them to set up their login'}
              </div>
            </div>
            <div className="spacer" />
            {a.status === 'invited' && (
              <button className="btn soft" onClick={() => resend(a.id)}>Resend invite</button>
            )}
            <button className="btn ghost" onClick={() => remove(a.id)}>Remove</button>
          </div>
        ))}
      </div>
    </>
  );
}
