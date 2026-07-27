import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';

/* THE NOTE-BUYER SLOT on a loan file — one obvious place to see who is buying the
   loan, to change it, and to understand what changing it does (owner-directed
   2026-07-27: "we need a better slot … right now I don't believe it's a clear path").

   Before this, the note buyer had no home. Once it was set it vanished from the
   completeness panel (that panel only lists what's MISSING), and the only way to
   change it was a pencil icon on a muted line inside the ClickUp sync panel — a panel
   about a different subject, hidden behind the "Pipeline details" toggle. Nothing
   anywhere said what the note buyer actually controls, even though it attaches and
   retracts conditions, turns the 5% Scope-of-Work contingency on, can raise the
   bank-statement count, and decides which data tape the file exports.

   So this card does three things the old path didn't:
     1. it is ALWAYS on the file overview, whether or not a note buyer is set;
     2. it says what the CURRENT note buyer requires of this file, in plain language;
     3. before you switch, it shows what that switch would DO to this file — which
        conditions attach, which drop, what the new note buyer requires — and after
        you switch it reports what actually changed.

   Everything shown is computed server-side from the live rules and the modules that
   enforce them (GET .../note-buyer), so it can never drift from what really happens.
   The change itself posts to the SAME endpoint it always did (complete-fields with
   `lender`), which re-runs the condition engine, re-enforces the SOW contingency and
   re-derives liquidity — one write path, unchanged.

   STAFF-ONLY. The note-buyer name is never shown to a borrower, and this card is only
   rendered on the staff file view. Text colors are explicit dark hex per the
   white-first rule (never a --ink* token, which resolves LIGHT). */

const INK = '#141B22';
const MUTED = '#4B585C';

// The "Other…" sentinel in the picker — a note buyer ClickUp doesn't know about yet.
const OTHER = '__other__';

function EffectList({ title, items, tone }) {
  if (!items || !items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: tone === 'add' ? '#0F6A4C' : MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>
        {title}
      </div>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: INK, fontSize: 13.5, lineHeight: 1.5 }}>
        {items.map((x, i) => <li key={(x.code || x.label || '') + i}>{x.label}</li>)}
      </ul>
    </div>
  );
}

function Requirements({ items, heading }) {
  if (!items || !items.length) return null;
  return (
    <div style={{ marginTop: 8 }}>
      {heading && <div style={{ fontSize: 12, fontWeight: 800, color: MUTED, textTransform: 'uppercase', letterSpacing: '.04em' }}>{heading}</div>}
      <ul style={{ margin: '4px 0 0', paddingLeft: 18, color: INK, fontSize: 13.5, lineHeight: 1.5 }}>
        {items.map((r) => <li key={r.key}>{r.text}</li>)}
      </ul>
    </div>
  );
}

export default function NoteBuyerCard({ appId, value, onSaved }) {
  const [slot, setSlot] = useState(null);       // { current, options, effects }
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState('');     // an option `value` (normalized key) or OTHER
  const [typed, setTyped] = useState('');       // the free-text name when choice === OTHER
  const [previewing, setPreviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState(null);   // what the save actually changed

  const load = useCallback((candidate) => {
    const q = candidate ? `?candidate=${encodeURIComponent(candidate)}` : '';
    return api.get(`/api/staff/applications/${appId}/note-buyer${q}`)
      .then((r) => { setSlot(r || null); return r; })
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [appId]);

  useEffect(() => { let live = true; load().then(() => { if (!live) setSlot(null); }); return () => { live = false; }; }, [load, value]);

  const current = (slot && slot.current) || { label: value || null, key: null };
  const options = (slot && slot.options) || [];
  const effects = (slot && slot.effects) || {};
  const currentEffect = current.key ? effects[current.key] : null;

  // The note buyer being considered: the picked option, or the typed name once it has
  // been previewed (the server echoes it back as an option keyed on its normalized name).
  const typedKey = typed.trim() ? Object.keys(effects).find((k) => effects[k] && effects[k].label.toLowerCase() === typed.trim().toLowerCase()) : null;
  const candidateKey = choice === OTHER ? typedKey : (choice || null);
  const candidate = candidateKey ? effects[candidateKey] : null;
  const candidateLabel = choice === OTHER ? typed.trim() : (candidate ? candidate.label : '');
  const isSame = !!candidateKey && candidateKey === current.key;

  const startEdit = () => { setEditing(true); setChoice(''); setTyped(''); setErr(''); setResult(null); };
  const cancel = () => { setEditing(false); setChoice(''); setTyped(''); setErr(''); };

  // Preview a typed name: ask the server what THAT name would do to this file, so a
  // note buyer ClickUp has never heard of still explains itself before it is saved.
  async function previewTyped() {
    const name = typed.trim();
    if (!name) return;
    setPreviewing(true); setErr('');
    try { await load(name); } finally { setPreviewing(false); }
  }

  async function save() {
    const name = candidateLabel;
    if (!name) return;
    setBusy(true); setErr(''); setResult(null);
    const before = current.label;
    try {
      const r = await api.post(`/api/staff/applications/${appId}/complete-fields`, { lender: name });
      const changed = (r && r.conditionsChanged) || { added: [], removed: [] };
      // Saving re-checks the WHOLE file, so the engine can also pick up conditions that
      // have nothing to do with the note buyer. The server tags which is which — keep
      // them apart so the switch is never credited with something it didn't cause.
      const split = (list) => {
        const rows = (list || []).map((x) => (typeof x === 'string' ? { label: x, byNoteBuyer: true } : x));
        return { mine: rows.filter((x) => x.byNoteBuyer).map((x) => x.label),
          other: rows.filter((x) => !x.byNoteBuyer).map((x) => x.label) };
      };
      setResult({ before, after: name, added: split(changed.added), removed: split(changed.removed) });
      setEditing(false); setChoice(''); setTyped('');
      await load();
      if (onSaved) await onSaved();
    } catch (e) {
      setErr((e && e.message) || 'Could not save the note buyer.');
    } finally { setBusy(false); }
  }

  return (
    <div className="panel" style={{ marginBottom: 16, borderLeft: '3px solid var(--gold,#AE8746)' }}>
      <div className="row" style={{ gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <b style={{ color: INK }}>Note buyer</b>
        <span className="pill muted" title="The note buyer is internal. It is never shown to the borrower, never in their emails, and never on their documents.">
          Internal only
        </span>
      </div>

      <div style={{ marginTop: 10, fontSize: 24, fontWeight: 700, color: current.label ? INK : MUTED, lineHeight: 1.2 }}>
        {current.label || 'Not set yet'}
      </div>
      <div style={{ marginTop: 4, fontSize: 13, color: MUTED, lineHeight: 1.5 }}>
        {current.label
          ? 'The capital partner buying this loan. It decides some of the conditions on the file and which data tape this file exports.'
          : 'Nobody is buying this loan yet in the system. Until this is set, the conditions and the data tape that depend on it can’t be worked out.'}
      </div>

      {err && <div role="alert" className="notice err" style={{ marginTop: 12, marginBottom: 0 }}>{err}</div>}

      {/* What actually happened on the last save — the honest answer, straight from
          the condition engine, so nobody has to go hunting the conditions list. */}
      {result && (
        <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>
          <div><strong>Note buyer {result.before ? <>changed from <b>{result.before}</b> to <b>{result.after}</b></> : <>set to <b>{result.after}</b></>}.</strong></div>
          <div style={{ marginTop: 4 }}>
            {result.added.mine.length
              ? <>Because of the note buyer, {result.added.mine.length === 1 ? 'this condition was' : 'these conditions were'} added: {result.added.mine.join(', ')}.</>
              : 'No conditions were added because of the note buyer.'}
            {' '}
            {result.removed.mine.length
              ? <>Taken off the file: {result.removed.mine.join(', ')}.</>
              : 'None were taken off.'}
          </div>
          {(result.added.other.length > 0 || result.removed.other.length > 0) && (
            <div style={{ marginTop: 6 }}>
              Saving also re-checked the whole file, which
              {result.added.other.length ? <> added {result.added.other.join(', ')}</> : null}
              {result.added.other.length && result.removed.other.length ? ' and' : null}
              {result.removed.other.length ? <> took off {result.removed.other.join(', ')}</> : null}
              {' '}— those are for other reasons, not the note buyer.
            </div>
          )}
        </div>
      )}

      {/* What the CURRENT note buyer asks of this file. */}
      {!editing && currentEffect && (
        <Requirements heading="What this note buyer requires on this file" items={currentEffect.requirements} />
      )}
      {!editing && current.label && currentEffect && !currentEffect.requirements.length && (
        <div style={{ marginTop: 8, fontSize: 13.5, color: MUTED }}>
          This note buyer adds no extra requirements to this file beyond the normal ones.
        </div>
      )}

      {/* The action sits AFTER the explanation — read who it is and what they want,
          then change it. Never hidden behind a pencil icon again. */}
      {!editing && (
        <div style={{ marginTop: 14 }}>
          <button type="button" className={current.label ? 'btn ghost' : 'btn primary'} onClick={startEdit}>
            {current.label ? 'Change note buyer' : 'Set the note buyer'}
          </button>
        </div>
      )}

      {/* The picker + the "what would change" preview. */}
      {editing && (
        <div style={{ marginTop: 14, borderTop: '1px solid var(--line,#D9D4C8)', paddingTop: 14 }}>
          <div className="field" style={{ marginBottom: 10 }}>
            <label style={{ color: INK }}>Switch this file to</label>
            <select className="input" value={choice} disabled={busy}
              onChange={(e) => { setChoice(e.target.value); setResult(null); }}>
              <option value="">Pick a note buyer…</option>
              {options.map((o) => (
                <option key={o.value} value={o.value}>{o.label}{o.value === current.key ? ' (current)' : ''}</option>
              ))}
              <option value={OTHER}>Other — type a name…</option>
            </select>
            <div className="hint" style={{ marginTop: 6 }}>
              These are the note buyers ClickUp offers, plus any already used on a file.
            </div>
          </div>

          {choice === OTHER && (
            <div className="row" style={{ gap: 6, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
              <input className="input small" style={{ maxWidth: 260 }} autoFocus placeholder="Type the note buyer’s name…"
                value={typed} disabled={busy}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') previewTyped(); }} />
              <button type="button" className="btn ghost small" disabled={busy || previewing || !typed.trim()} onClick={previewTyped}>
                {previewing ? 'Checking…' : 'Check what it changes'}
              </button>
            </div>
          )}

          {isSame && (
            <div className="notice info" style={{ marginBottom: 10 }}>That is already this file’s note buyer — nothing would change.</div>
          )}

          {candidate && !isSame && (
            <div style={{ background: 'var(--ink-2,#F4F1EA)', border: '1px solid var(--line,#D9D4C8)', borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>If you switch to {candidate.label}</div>
              {candidate.previewed ? (
                (candidate.conditions.adds.length || candidate.conditions.drops.length) ? (
                  <>
                    <EffectList title="Conditions it adds to the file" items={candidate.conditions.adds} tone="add" />
                    <EffectList title="Conditions it takes off the file" items={candidate.conditions.drops} tone="drop" />
                  </>
                ) : (
                  <div style={{ marginTop: 6, fontSize: 13.5, color: MUTED }}>No conditions on this file change.</div>
                )
              ) : (
                <div style={{ marginTop: 6, fontSize: 13.5, color: MUTED }}>
                  This file is closed or on hold, so no conditions would be added or removed.
                </div>
              )}
              <Requirements heading={`What ${candidate.label} then requires`} items={candidate.requirements} />
              {!candidate.requirements.length && (
                <div style={{ marginTop: 8, fontSize: 13.5, color: MUTED }}>It adds no extra requirements to this file.</div>
              )}
            </div>
          )}

          {choice === OTHER && typed.trim() && !candidate && !previewing && (
            <div className="notice info" style={{ marginBottom: 10 }}>
              Press “Check what it changes” to see what <b>{typed.trim()}</b> would do to this file before you save it.
            </div>
          )}

          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button type="button" className="btn primary" disabled={busy || !candidateLabel || isSame} onClick={save}>
              {busy ? 'Saving…' : candidateLabel ? `Switch to ${candidateLabel}` : 'Switch'}
            </button>
            <button type="button" className="btn ghost" disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}

      {loading && !slot && <div style={{ marginTop: 8, fontSize: 13, color: MUTED }}>Loading…</div>}
    </div>
  );
}
