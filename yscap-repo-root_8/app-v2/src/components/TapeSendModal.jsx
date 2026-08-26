import React, { useState } from 'react';
import { ScheduleButton } from './ScheduleSend.jsx';

/* SEND THE DATA TAPE TO THE INVESTOR — the compose screen (owner-directed
   2026-08-18). Strictly MANUAL: this modal is the only way the tape ever
   emails, and nothing here fires without the human pressing Send.

   What the person sees before sending is exactly what goes out: the subject
   ("New file for review - {loan} - {address}"), the deal figures the body
   carries (no origination fee — the server composes the body), who is on the
   To line (the investor's SAVED contacts for this note buyer, pre-listed, plus
   any address typed here — which is then saved for the next file), and who
   rides along (the loan officer + processor as a visible Cc, and the file's
   own reply inbox as the Reply-To so the investor's answer threads into the
   file). ONLY the Excel tape is attached.

   Send stays disabled until at least ONE investor email is chosen — the
   server enforces the same rule.

   TWO ADDITIONS, owner-directed 2026-08-21:
   • COPY MORE PEOPLE. The file's own team already rides as a visible Cc; this
     adds anyone else — an attorney, a second desk at the buyer. A Cc address is
     deliberately NOT saved to the investor's contact book: it is a one-off for
     this file, and quietly adding it to the book would put them on every future
     tape for that buyer.
   • SEND IT LATER. The SAME ScheduleButton the four order emails use, never a
     second copy. Nothing about the tape is built now — the server stores only
     the intent and rebuilds the tape at the due moment, so it carries the file
     as it stands then. */
export default function TapeSendModal({ name, preview, busy, onCancel, onSend, onSchedule }) {
  const contacts = (preview && preview.contacts) || [];
  const [sel, setSel] = useState(() => new Set(contacts.map((c) => c.email)));
  const [extras, setExtras] = useState([]);
  const [typed, setTyped] = useState('');
  const [ccList, setCcList] = useState([]);
  const [ccTyped, setCcTyped] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  /* THE EDITABLE PREVIEW (owner-directed 2026-08-26): the exact subject + body the send
     renders (preview.email — built by the SAME buildTapeEmail the send runs), editable in
     place. Only what was CHANGED rides as an override; untouched, the send is
     byte-identical — and a typed note below still folds into the built body. */
  const baseSubject = (preview && preview.email && preview.email.subject) || (preview && preview.subject) || 'New file for review';
  const baseBody = (preview && preview.email && preview.email.text) || '';
  const [subj, setSubj] = useState(baseSubject);
  const [body, setBody] = useState(baseBody);

  const toggle = (email) => setSel((s) => {
    const n = new Set(s);
    if (n.has(email)) n.delete(email); else n.add(email);
    return n;
  });
  const addTyped = () => {
    const addr = typed.trim().toLowerCase();
    setErr('');
    if (!addr) return;
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(addr)) { setErr(`"${addr}" doesn't look like an email address.`); return; }
    if (!extras.includes(addr) && !sel.has(addr)) setExtras((x) => [...x, addr]);
    setTyped('');
  };
  const addCc = () => {
    const addr = ccTyped.trim().toLowerCase();
    setErr('');
    if (!addr) return;
    if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(addr)) { setErr(`"${addr}" doesn't look like an email address.`); return; }
    if (!ccList.includes(addr)) setCcList((x) => [...x, addr]);
    setCcTyped('');
  };
  const to = [...sel, ...extras.filter((e) => !sel.has(e))];
  // Never copy somebody who is already a recipient — one person, one email.
  const cc = ccList.filter((e) => !to.includes(e));

  function payload() {
    const override = {
      ...(subj.trim() && subj.trim() !== baseSubject.trim() ? { subject: subj.trim() } : {}),
      ...(body.trim() && baseBody && body.trim() !== baseBody.trim() ? { text: body } : {}),
    };
    return { to, cc, note: note.trim() || undefined, ...(Object.keys(override).length ? { override } : {}) };
  }
  function submit(e) {
    e.preventDefault();
    if (!to.length) { setErr('Pick or add at least one investor email address.'); return; }
    onSend(payload());
  }

  return (
    <div onClick={busy ? undefined : onCancel}
      style={{ position: 'fixed', inset: 0, background: 'rgba(20,27,34,.55)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <form onClick={(e) => e.stopPropagation()} onSubmit={submit}
        className="panel" style={{ width: 'min(560px, 96vw)', maxHeight: '90vh', overflowY: 'auto', background: 'var(--paper, #fff)' }}>
        <h3 style={{ marginTop: 0, color: '#141B22' }}>Send the {name} tape to the investor</h3>
        <p className="small" style={{ marginTop: -4, color: '#4B585C' }}>
          One email, one attachment — the Excel tape. Nothing sends until you press Send.
        </p>

        <div className="small" style={{ padding: '8px 10px', border: '1px solid #E2DCCB', borderRadius: 8, background: '#FBFAF6', color: '#141B22' }}>
          <label style={{ display: 'grid', gap: 2 }}>
            <span style={{ color: '#4B585C' }}>Subject — editable</span>
            <input className="input" value={subj} maxLength={300} onChange={(e) => setSubj(e.target.value)} />
          </label>
          {baseBody ? (
            <label style={{ display: 'grid', gap: 2, marginTop: 8 }}>
              <span style={{ color: '#4B585C' }}>Message — exactly what will be sent, editable</span>
              <textarea className="input" rows={8} style={{ fontSize: 12.5, lineHeight: 1.45 }}
                value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
          ) : (preview && preview.figures || []).length > 0 && (
            <div style={{ marginTop: 6, display: 'grid', gap: 2 }}>
              {(preview.figures || []).map((f) => (
                <div key={f.label}><span style={{ color: '#4B585C' }}>{f.label}:</span> {f.value}</div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 6, color: '#4B585C' }}>
            Cc: {((preview && preview.cc) || []).join(', ') || 'the file team'}
            {preview && preview.replyTo ? ` · replies go to the file’s inbox (${preview.replyTo})` : ''}
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="small" style={{ fontWeight: 700, color: '#141B22' }}>
            To — {preview && preview.investor && preview.investor.label ? `${preview.investor.label} contacts` : 'investor contacts'}
          </div>
          {contacts.length === 0 && (
            <p className="small" style={{ color: '#4B585C', margin: '4px 0' }}>
              No saved contacts for this investor yet — add an email below. It is saved for the next file.
            </p>
          )}
          <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
            {contacts.map((c) => (
              <label key={c.email} className="row small" style={{ gap: 8, alignItems: 'center', color: '#141B22' }}>
                <input type="checkbox" checked={sel.has(c.email)} onChange={() => toggle(c.email)} />
                <span>{c.email}{c.name ? ` — ${c.name}` : ''}{c.role ? ` (${c.role})` : ''}</span>
              </label>
            ))}
            {extras.map((addr) => (
              <label key={addr} className="row small" style={{ gap: 8, alignItems: 'center', color: '#141B22' }}>
                <input type="checkbox" checked onChange={() => setExtras((x) => x.filter((e) => e !== addr))} />
                <span>{addr} <em style={{ color: '#4B585C' }}>(new — will be saved for this investor)</em></span>
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" type="text" value={typed} placeholder="add another email…"
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } }}
              style={{ minWidth: 220 }} />
            <button type="button" className="btn ghost small" onClick={addTyped}>Add</button>
          </div>
        </div>

        <div style={{ marginTop: 12 }}>
          <div className="small" style={{ fontWeight: 700, color: '#141B22' }}>Copy more people (optional)</div>
          <p className="small" style={{ color: '#4B585C', margin: '2px 0 4px' }}>
            The loan officer and processor on this file are copied automatically. Anyone added here is
            copied on this email only — they are not added to {(preview && preview.investor && preview.investor.label) || 'the investor'}’s saved contacts.
          </p>
          {cc.length > 0 && (
            <div style={{ display: 'grid', gap: 4, marginTop: 4 }}>
              {cc.map((addr) => (
                <label key={addr} className="row small" style={{ gap: 8, alignItems: 'center', color: '#141B22' }}>
                  <input type="checkbox" checked onChange={() => setCcList((x) => x.filter((e) => e !== addr))} />
                  <span>{addr}</span>
                </label>
              ))}
            </div>
          )}
          <div className="row" style={{ gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" type="text" value={ccTyped} placeholder="copy another email…"
              onChange={(e) => setCcTyped(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCc(); } }}
              style={{ minWidth: 220 }} />
            <button type="button" className="btn ghost small" onClick={addCc}>Copy</button>
          </div>
        </div>

        <label style={{ display: 'grid', gap: 4, marginTop: 12 }}>
          <span className="small" style={{ fontWeight: 600, color: '#141B22' }}>Add a short message (optional)</span>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. Ground-up in Paterson NJ — appraisal and budget attached to the file." />
        </label>

        {err && <div className="small" role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</div>}
        <div className="row" style={{ gap: 8, marginTop: 12, justifyContent: 'flex-end', flexWrap: 'wrap', alignItems: 'flex-start' }}>
          <button type="button" className="btn ghost small" disabled={busy} onClick={onCancel}>Cancel</button>
          {onSchedule && (
            <ScheduleButton what="the data tape" busy={busy} disabled={to.length === 0}
              onSchedule={({ day, time }) => onSchedule({ ...payload(), day, time })} />
          )}
          <button type="submit" className="btn primary small" disabled={busy || to.length === 0}
            title={to.length === 0 ? 'Pick or add at least one investor email first' : undefined}>
            {busy ? 'Sending…' : `Send to ${to.length || 'the'} recipient${to.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </form>
    </div>
  );
}
