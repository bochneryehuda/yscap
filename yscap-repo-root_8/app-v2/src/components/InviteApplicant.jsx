import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { EmailInput } from './FormattedInputs.jsx';

/* "Invite for a new application" (owner-directed): a staffer starts a loan file
   from JUST an email address, and the borrower takes it from there — they get an
   invite, sign in, and fill in the rest of their application themselves. The file
   is opened immediately (it shows on the pipeline as awaiting the borrower), so
   nobody has to key in the property, program, or numbers before sending it.

   This is the ONLY thing the staffer needs; every other origination step
   (borrower match-or-create, checklist, ClickUp task, officer assignment, the
   invite email) runs server-side through the normal new-file path in
   invite-only mode. */
export default function InviteApplicant({ className = 'btn btn-ghost btn-sm', label = 'Invite for a new application' }) {
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  function close() { if (!busy) { setOpen(false); setErr(''); } }

  async function submit(e) {
    if (e) e.preventDefault();
    setErr('');
    if (!validEmail) { setErr('Enter a valid email address.'); return; }
    if (busy) return;
    setBusy(true);
    try {
      const body = { inviteOnly: true, borrower: { email: email.trim(), firstName: firstName.trim(), lastName: lastName.trim() } };
      let r;
      try {
        r = await api.staffCreateFile(body);
      } catch (e1) {
        // Shared-mailbox case (husband and wife on one email): confirm and keep
        // BOTH profiles on that address — nothing is merged (mirrors New file).
        if (e1.data && e1.data.sharedEmail && e1.data.sharedEmail.canShare
            && window.confirm(`${e1.message}\n\nAre these two different people who share one email address?`)) {
          r = await api.staffCreateFile({ ...body, allowSharedEmail: true });
        } else throw e1;
      }
      setOpen(false); setEmail(''); setFirstName(''); setLastName('');
      nav(`/internal/app/${r.applicationId}`);
    } catch (e2) {
      setErr(e2.message || 'Could not send the invite.');
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className={className} onClick={() => { setOpen(true); setErr(''); }}
        title="Start a file from just an email — the borrower fills in the rest">{label}</button>
      {open && (
        <div className="cv-modal-back" onClick={close}>
          <form className="cv-modal" onClick={e => e.stopPropagation()} onSubmit={submit}
            role="dialog" aria-label="Invite for a new application">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <h3 style={{ margin: 0 }}>Invite for a new application</h3>
              <button type="button" className="btn ghost small" onClick={close} disabled={busy} aria-label="Close">Close ✕</button>
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>
              Just enter their email. We open a new loan file and email them an invite to join it and
              fill in the rest — you don't need the property, program, or numbers yet.
            </p>
            {err && <div role="alert" className="notice err" style={{ marginBottom: 10 }}>{err}</div>}
            <label className="field"><span>Borrower email *</span>
              <EmailInput value={email} onChange={setEmail} placeholder="borrower@email.com" /></label>
            <div className="grid cols-2">
              <label className="field"><span>First name (optional)</span>
                <input className="input" value={firstName} onChange={e => setFirstName(e.target.value)} placeholder="If you know it" /></label>
              <label className="field"><span>Last name (optional)</span>
                <input className="input" value={lastName} onChange={e => setLastName(e.target.value)} /></label>
            </div>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
              <button type="button" className="btn btn-ghost" onClick={close} disabled={busy}>Cancel</button>
              <button type="submit" className="btn btn-gold" disabled={busy || !validEmail}>
                {busy ? 'Sending invite…' : 'Create file & send invite'}</button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}
