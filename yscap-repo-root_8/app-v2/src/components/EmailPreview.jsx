import React, { useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * THE EDITABLE EMAIL PREVIEW (owner-directed 2026-08-26: "instead of it automatically
 * sending an email, it should populate a full preview … it should be fully editable …
 * Don't remove any option to add recipients or anything. Design it nicely").
 *
 * ONE modal for every manual send — title/insurance orders + their follow-ups, the
 * attorney closing-prep request, the investor tape, the draw investor delivery. The
 * caller fetches the send's OWN preview (each preview endpoint runs the send's own
 * pure builder, so what this shows and what goes out can never be two different
 * emails), mounts this with it, and sends with the override the person actually made:
 * `onSend({ subject?, text? })` carries ONLY the fields that were CHANGED — an
 * untouched preview sends the rich built email byte-identical to before.
 *
 * `children` is where the caller keeps its EXISTING options (extra recipients,
 * cc-borrower checkbox, notes) — nothing is removed, per the owner's words.
 * `subjectLocked` is for a send that must THREAD on an existing conversation (an
 * order follow-up rides "Re: <the order>"): the subject shows read-only with the
 * reason, and only the body is editable.
 *
 * Colours are explicit darks on white (the --ink* tokens are LIGHT paper colours in
 * this palette and must never colour text).
 */
export default function EmailPreview({
  title, subject, text, to = [], cc = [], subjectLocked = false, lockNote = '',
  busy = false, sendLabel = 'Send', onSend, onClose, children, warning = null,
}) {
  const [subj, setSubj] = useState(subject || '');
  const [body, setBody] = useState(text || '');
  const changed = {
    ...(subj.trim() !== String(subject || '').trim() && !subjectLocked ? { subject: subj.trim() } : {}),
    ...(body.trim() !== String(text || '').trim() ? { text: body } : {}),
  };
  const edited = Object.keys(changed).length > 0;
  const addrLine = (label, list) => (list && list.length ? (
    <div className="small" style={{ color: '#3A4550', marginTop: 2 }}>
      <b style={{ color: '#141B22' }}>{label}:</b> {list.join(', ')}
    </div>
  ) : null);

  const node = (
    <div className="cv-modal-back" onClick={onClose}>
      <div className="cv-modal" style={{ maxWidth: 780, width: '96%', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <h3 style={{ margin: 0, color: '#141B22' }}>{title || 'Review this email before it goes out'}</h3>
          <button className="btn ghost small" onClick={onClose}>Close ✕</button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
          {(to.length || cc.length) ? (
            <div style={{ background: '#F6F3EC', border: '1px solid #E7E1D3', borderRadius: 10, padding: '8px 12px', marginBottom: 10 }}>
              {addrLine('To', to)}
              {addrLine('Cc', cc)}
            </div>
          ) : null}
          {warning && (
            <div className="small" style={{ background: '#FBF4E4', border: '1px solid #E7E1D3', borderRadius: 10, padding: '8px 12px', marginBottom: 10, color: '#141B22' }}>{warning}</div>
          )}
          <label className="small" style={{ display: 'block', fontWeight: 600, color: '#141B22' }}>Subject</label>
          {subjectLocked ? (
            <div>
              <div className="input" style={{ background: '#F6F3EC', color: '#3A4550', cursor: 'default' }}>{subject}</div>
              <div className="small" style={{ color: '#4B585C', marginTop: 2 }}>{lockNote || 'This send stays on the existing email conversation, so its subject is kept.'}</div>
            </div>
          ) : (
            <input className="input" style={{ width: '100%' }} value={subj} maxLength={300}
              onChange={(e) => setSubj(e.target.value)} />
          )}
          <label className="small" style={{ display: 'block', fontWeight: 600, color: '#141B22', marginTop: 10 }}>Message</label>
          <textarea className="input" style={{ width: '100%', minHeight: 260, fontSize: 13, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}
            value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="small" style={{ color: '#4B585C', marginTop: 4 }}>
            {edited
              ? 'Your edited wording will be sent in the standard PILOT email design.'
              : 'This is exactly what will be sent. Edit anything above, or send it as is.'}
          </div>
          {children}
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button className="btn ghost" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn primary" disabled={busy || !body.trim() || (!subjectLocked && !subj.trim())}
            onClick={() => onSend(edited ? changed : null)}>
            {busy ? 'Sending…' : sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
  return typeof document !== 'undefined' && document.body ? createPortal(node, document.body) : node;
}
