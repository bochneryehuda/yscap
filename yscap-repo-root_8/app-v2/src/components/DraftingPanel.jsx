import React, { useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { showMessage } from '../lib/dialog.js';

/* THE DRAFTING DESK (owner-directed 2026-08-18): Pilot AI drafts a
   human-sounding email FROM this file, for COPY-PASTE — there is no Send
   button here and no send behind it; you edit the draft and copy it into your
   own email program.

   UPGRADED same day (owner: "much more options … a little bit more thought"):
     · DETAILED FIGURES toggle (off by default, exactly as the owner chose) —
       the draft breaks the bank-statement item into cash to close, reserves
       and the closing-cost cushion (with the "send a little extra" advice),
       and states the registered-vs-verified experience gap, from the same
       modules the Condition Center reads.
     · Tone (professional / friendly / firm / plain) and length.
     · Pick exactly which conditions the email lists.
     · Sign-off name, and a "tell Pilot what to change" revise box that
       regenerates the draft on the same file facts.
   Settings + the last draft persist per file in localStorage, so navigating
   away no longer loses the work.                                          */

const LS_KEY = (appId) => `pilot.drafting.${appId}`;
const OPEN_STATUSES = ['outstanding', 'requested', 'issue', 'received'];
const DARK = '#141B22';
const MUTED = '#4B585C';

function loadSaved(appId) {
  try { return JSON.parse(localStorage.getItem(LS_KEY(appId)) || 'null') || {}; } catch (_) { return {}; }
}

export default function DraftingPanel({ appId }) {
  const saved = loadSaved(appId);
  const [preset, setPreset] = useState(saved.preset || 'outstanding_conditions');
  const [scope, setScope] = useState(saved.scope || 'open');
  const [includePendingReview, setIncludePendingReview] = useState(saved.includePendingReview === true);
  const [layout, setLayout] = useState(saved.layout || 'bullets');
  const [detail, setDetail] = useState(saved.detail === true);
  const [tone, setTone] = useState(saved.tone || 'friendly');
  const [length, setLength] = useState(saved.length || 'standard');
  const [signAs, setSignAs] = useState(saved.signAs || '');
  const [instruction, setInstruction] = useState(saved.instruction || '');
  const [pickOpen, setPickOpen] = useState(false);
  const [pickable, setPickable] = useState(null);   // null = not fetched yet
  const [picked, setPicked] = useState(saved.picked || []); // ids; empty = all in scope
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [subject, setSubject] = useState(saved.subject || '');
  const [body, setBody] = useState(saved.body || '');
  const [feedback, setFeedback] = useState('');
  const [copied, setCopied] = useState('');

  // Persist the settings + the last draft per file (localStorage only — the
  // server never stores a draft; nothing sends from here).
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY(appId), JSON.stringify({
        preset, scope, includePendingReview, layout, detail, tone, length, signAs, instruction, picked, subject, body,
      }));
    } catch (_) { /* private mode etc. — persistence is best-effort */ }
  }, [appId, preset, scope, includePendingReview, layout, detail, tone, length, signAs, instruction, picked, subject, body]);

  // The item picker: the file's own borrower-facing open items, fetched once
  // when the picker is first opened.
  const openPicker = async () => {
    setPickOpen((v) => !v);
    if (pickable != null) return;
    try {
      const c = await api.staffChecklist(appId);
      const items = (Array.isArray(c) ? c : (c && c.items) || [])
        .filter((it) => (it.audience === 'borrower' || it.audience === 'both') && !it.waived_at
          && OPEN_STATUSES.includes(it.status))
        .map((it) => ({ id: it.id, label: it.borrower_label || it.label || 'An item your loan team needs', status: it.status }));
      setPickable(items);
    } catch (_) { setPickable([]); }
  };
  const togglePick = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const generate = async (revise = false) => {
    setBusy(true); setErr(''); setCopied('');
    try {
      const out = await api.staffDraftEmail(appId, {
        preset, scope, layout, includePendingReview,
        detail, tone, length,
        signAs: signAs.trim() || undefined,
        itemIds: preset === 'outstanding_conditions' && picked.length ? picked : undefined,
        instruction: preset === 'custom' ? instruction : undefined,
        ...(revise && feedback.trim() ? { feedback: feedback.trim(), previousSubject: subject, previousBody: body } : {}),
      });
      if (out && out.ok) { setSubject(out.subject || ''); setBody(out.body || ''); if (revise) setFeedback(''); }
      else setErr((out && out.reason) || 'Could not draft just now — try again.');
    } catch (e) {
      setErr((e.data && (e.data.reason || e.data.error)) || e.message || 'Could not draft just now — try again.');
    } finally { setBusy(false); }
  };

  const copy = async (what, text) => {
    try { await navigator.clipboard.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 2500); }
    catch (_) { await showMessage('Copying was blocked by the browser — select the text and copy it yourself.'); }
  };

  const sel = (v, set, opts, title) => (
    <label className="small" style={{ display: 'grid', gap: 3, color: DARK }}>
      <span style={{ fontWeight: 600, color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>{title}</span>
      <select className="input" style={{ width: 'auto' }} value={v} onChange={(e) => set(e.target.value)}>
        {opts.map(([val, label]) => <option key={val} value={val}>{label}</option>)}
      </select>
    </label>
  );

  return (
    <div className="panel" style={{ marginTop: 4 }}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Pilot AI drafts the email from this file’s own facts — you edit it here and <strong>copy it into your
        email program</strong>. Nothing is ever sent from this screen.
      </p>

      {/* ---- what to draft + how ---- */}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {sel(preset, setPreset, [
          ['outstanding_conditions', 'Email the borrower — outstanding conditions'],
          ['deal_overview', 'Deal overview email'],
          ['custom', 'Free form…'],
        ], 'What to draft')}
        {sel(tone, setTone, [
          ['friendly', 'Warm & friendly'], ['professional', 'Professional'],
          ['firm', 'Firm follow-up'], ['plain', 'Very plain & simple'],
        ], 'Tone')}
        {sel(length, setLength, [
          ['short', 'Short'], ['standard', 'Standard'], ['thorough', 'Thorough'],
        ], 'Length')}
        <label className="small" style={{ display: 'grid', gap: 3, color: DARK }}>
          <span style={{ fontWeight: 600, color: MUTED, fontSize: 11, textTransform: 'uppercase', letterSpacing: '.05em' }}>Sign as</span>
          <input className="input" style={{ width: 150 }} value={signAs} placeholder="Your name (optional)"
            onChange={(e) => setSignAs(e.target.value)} maxLength={120} />
        </label>
      </div>

      {/* ---- the DETAILED FIGURES option (off by default — the owner's call) ---- */}
      <label className="row" style={{ gap: 8, alignItems: 'flex-start', marginTop: 10, cursor: 'pointer',
        padding: '8px 10px', border: `1px solid ${detail ? '#AE8746' : '#E4DFD3'}`, borderRadius: 10,
        background: detail ? '#FBF7EE' : '#FFFFFF', maxWidth: 640 }}>
        <input type="checkbox" checked={detail} onChange={(e) => setDetail(e.target.checked)} style={{ marginTop: 2 }} />
        <span className="small" style={{ color: DARK }}>
          <b>Detailed figures</b> — weave the file’s real numbers into the email: the liquidity requirement broken
          into cash to close, reserves and the closing-cost cushion (with a nudge to send a little extra so cash to
          close is never tight), the registered-vs-verified experience gap, budget figures, and each item’s own guidance.
        </span>
      </label>

      {/* ---- scope / layout / item picking (outstanding-conditions only) ---- */}
      {preset === 'outstanding_conditions' && (
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center', marginTop: 10 }}>
          <select className="input" style={{ width: 'auto' }} value={scope} onChange={(e) => setScope(e.target.value)}
            title="Which items the email lists">
            <option value="open">Completely open items</option>
            <option value="not_signed_off">Everything not signed off yet</option>
          </select>
          {scope === 'open' && (
            <label className="row small" style={{ gap: 6, alignItems: 'center', color: DARK }}>
              <input type="checkbox" checked={includePendingReview} onChange={(e) => setIncludePendingReview(e.target.checked)} />
              include items already in review
            </label>
          )}
          <select className="input" style={{ width: 'auto' }} value={layout} onChange={(e) => setLayout(e.target.value)}>
            <option value="bullets">Bullet list</option>
            <option value="numbered">Numbered list</option>
          </select>
          <button type="button" className="btn ghost small" onClick={openPicker} aria-expanded={pickOpen}>
            {picked.length ? `Only ${picked.length} picked item${picked.length === 1 ? '' : 's'}` : 'Pick specific items…'}
          </button>
          {picked.length > 0 && (
            <button type="button" className="btn ghost small" onClick={() => setPicked([])}>All items in scope</button>
          )}
        </div>
      )}
      {preset === 'outstanding_conditions' && pickOpen && (
        <div style={{ marginTop: 8, border: '1px solid #E4DFD3', borderRadius: 10, padding: '8px 10px', maxWidth: 640 }}>
          {pickable == null ? <span className="small" style={{ color: MUTED }}>Loading the file’s items…</span>
            : pickable.length === 0 ? <span className="small" style={{ color: MUTED }}>No open borrower-facing items to pick from.</span>
            : pickable.map((it) => (
              <label key={it.id} className="row small" style={{ gap: 6, alignItems: 'center', color: DARK, padding: '2px 0', cursor: 'pointer' }}>
                <input type="checkbox" checked={picked.includes(it.id)} onChange={() => togglePick(it.id)} />
                <span>{it.label}{it.status === 'received' ? <em style={{ color: MUTED }}> (in review)</em> : null}</span>
              </label>
            ))}
          {pickable && pickable.length > 0 && (
            <div className="small" style={{ color: MUTED, marginTop: 4 }}>Nothing ticked = every item in the chosen scope.</div>
          )}
        </div>
      )}

      {preset === 'custom' && (
        <textarea className="input" rows={2} style={{ marginTop: 10 }} value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder='What should the email do? e.g. "Update the borrower that the appraisal was ordered and what happens next."' />
      )}

      <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
        <button className="btn primary small" disabled={busy || (preset === 'custom' && !instruction.trim())} onClick={() => generate(false)}>
          {busy ? 'Drafting…' : (body ? 'Regenerate' : 'Draft it')}
        </button>
        {err && <span className="small" role="alert" style={{ color: 'var(--danger)' }}>{err}</span>}
      </div>

      {/* ---- the draft ---- */}
      {(subject || body) && (
        <div style={{ marginTop: 12 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="small" style={{ fontWeight: 600, color: DARK }}>Subject</span>
            <div className="row" style={{ gap: 6, alignItems: 'center' }}>
              <input className="input" style={{ flex: 1 }} value={subject} onChange={(e) => setSubject(e.target.value)} />
              <button className="btn ghost small" onClick={() => copy('subject', subject)}>{copied === 'subject' ? 'Copied ✓' : 'Copy'}</button>
            </div>
          </label>
          <label style={{ display: 'grid', gap: 4, marginTop: 8 }}>
            <span className="small" style={{ fontWeight: 600, color: DARK }}>The email — edit it, then copy</span>
            <textarea className="input" rows={14} value={body} spellCheck onChange={(e) => setBody(e.target.value)}
              style={{ fontSize: 14, lineHeight: 1.5 }} />
          </label>
          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
            <button className="btn primary small" onClick={() => copy('body', body)}>{copied === 'body' ? 'Copied ✓' : 'Copy the email'}</button>
            <span className="muted small">Paste it into your own email program — nothing sends from here.</span>
          </div>
          {/* revise-with-feedback: regenerates on the SAME file facts */}
          <div className="row" style={{ gap: 6, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="input" style={{ flex: '1 1 260px' }} value={feedback} maxLength={1000}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder='Tell Pilot what to change — e.g. "shorter, and lead with the appraisal"' />
            <button className="btn ghost small" disabled={busy || !feedback.trim()} onClick={() => generate(true)}>
              {busy ? 'Working…' : 'Revise the draft'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
