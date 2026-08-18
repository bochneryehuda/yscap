import React, { useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage } from '../lib/dialog.js';

/* THE DRAFTING DESK (owner-directed 2026-08-18): Pilot AI drafts a
   human-sounding email FROM this file, for COPY-PASTE — there is no Send
   button here and no send behind it; you edit the draft and copy it into your
   own email program.

   Presets:
     · Email the borrower their outstanding conditions — scope selector
       (completely open / everything not signed off yet) with an optional
       "include items already in review" add-on, bullet or numbered layout.
     · A deal-overview email — the same borrower-safe figures the file
       overview shows.
     · Free form — say what the email should do; the draft is grounded on the
       file's own facts and never invents a number.                        */

export default function DraftingPanel({ appId }) {
  const [preset, setPreset] = useState('outstanding_conditions');
  const [scope, setScope] = useState('open');
  const [includePendingReview, setIncludePendingReview] = useState(false);
  const [layout, setLayout] = useState('bullets');
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [copied, setCopied] = useState('');

  const generate = async () => {
    setBusy(true); setErr(''); setCopied('');
    try {
      const out = await api.staffDraftEmail(appId, {
        preset, scope, layout, includePendingReview,
        instruction: preset === 'custom' ? instruction : undefined,
      });
      if (out && out.ok) { setSubject(out.subject || ''); setBody(out.body || ''); }
      else setErr((out && out.reason) || 'Could not draft just now — try again.');
    } catch (e) {
      setErr((e.data && (e.data.reason || e.data.error)) || e.message || 'Could not draft just now — try again.');
    } finally { setBusy(false); }
  };

  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 2500); }
    catch (_) { await showMessage('Copying was blocked by the browser — select the text and copy it yourself.'); }
  };

  return (
    <div className="panel" style={{ marginTop: 4 }}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Pilot AI drafts the email from this file’s own facts — you edit it here and <strong>copy it into your
        email program</strong>. Nothing is ever sent from this screen.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="input" style={{ width: 'auto' }} value={preset} onChange={(e) => setPreset(e.target.value)}>
          <option value="outstanding_conditions">Email the borrower — outstanding conditions</option>
          <option value="deal_overview">Deal overview email</option>
          <option value="custom">Free form…</option>
        </select>
        {preset === 'outstanding_conditions' && (
          <>
            <select className="input" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value)}
              title="Which items the email lists">
              <option value="open">Completely open items</option>
              <option value="not_signed_off">Everything not signed off yet</option>
            </select>
            {scope === 'open' && (
              <label className="row small" style={{ gap: 6, alignItems: 'center', color: '#141B22' }}>
                <input type="checkbox" checked={includePendingReview} onChange={(e) => setIncludePendingReview(e.target.checked)} />
                include items already in review
              </label>
            )}
            <select className="input" style={{ width: 'auto' }} value={layout} onChange={(e) => setLayout(e.target.value)}>
              <option value="bullets">Bullet list</option>
              <option value="numbered">Numbered list</option>
            </select>
          </>
        )}
        <button className="btn primary small" disabled={busy || (preset === 'custom' && !instruction.trim())} onClick={generate}>
          {busy ? 'Drafting…' : (body ? 'Regenerate' : 'Draft it')}
        </button>
      </div>
      {preset === 'custom' && (
        <textarea className="input" rows={2} style={{ marginTop: 8 }} value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='What should the email do? e.g. "Update the borrower that the appraisal was ordered and what happens next."' />
      )}
      {err && <p className="small" role="alert" style={{ color: 'var(--danger)', marginTop: 8 }}>{err}</p>}
      {(subject || body) && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="small" style={{ fontWeight: 600, color: '#141B22' }}>Subject</span>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input className="input" style={{ flex: 1 }} value={subject} onChange={(e) => setSubject(e.target.value)} />
              <button className="btn ghost small" onClick={() => copy('subject', subject)}>{copied === 'subject' ? 'Copied ✓' : 'Copy'}</button>
            </div>
          </label>
          <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>
            <span className="small" style={{ fontWeight: 600, color: '#141B22' }}>The email — edit it, then copy</span>
            <textarea className="input" rows={14} value={body} spellCheck onChange={(e) => setBody(e.target.value)}
              style={{ fontSize: 14, lineHeight: 1.5 }} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8 }}>
            <button className="btn primary small" onClick={() => copy('body', body)}>{copied === 'body' ? 'Copied ✓' : 'Copy the email'}</button>
            <span className="muted small">Paste it into your own email program — nothing sends from here.</span>
          </div>
        </div>
      )}
    </div>
  );
}
