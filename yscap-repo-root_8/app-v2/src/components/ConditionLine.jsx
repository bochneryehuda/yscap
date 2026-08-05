import React from 'react';
import { audienceStamp, conditionDisplayState } from '../lib/conditions-vocab.js';
import { nextStep } from '../lib/condition-actions.js';

/* THE COMPACT CONDITION LINE — one line you scan, click to open.
 *
 * Owner-directed 2026-07-28, after reading a live file: "so many options, too
 * big, messed up… simplify the actual condition setup itself", and then
 * "one compact line each, click to open the one you're working".
 *
 * MEASURED FIRST, not guessed. On a real file, 24 conditions came to 8,116px —
 * over seven screens — because every condition rendered fully expanded whether
 * or not anyone was working it. Each averaged 338px and ~330 DOM elements. So
 * the fix is not smaller type, it is that a list should be a LIST: a line per
 * condition, opened when you get to it.
 *
 * WHAT SURVIVES ON THE LINE is only what decides whether to open it:
 *   • the status dot and the name
 *   • ONE stamp — "Internal + external" / "Internal only" — replacing the
 *     four raw-database chips (Staff, Processor, Document, Condition) that were
 *     on every row. The owner's words: "a nice modern stamp saying if it's
 *     external… or if it's internal only… externals would be the borrower can
 *     also see it on their end." Two answers, not three, since 2026-08-02 —
 *     staff see everything, so "External" alone was a claim nothing satisfies
 *     (see conditions-vocab.js §4).
 *   • what is waiting: documents to review, the status, "sent back", overridden
 *   • the ONE next action, so a list of forty can be worked without opening
 *     every one of them
 *
 * Everything else — the instructions, the documents, the tool panels, the note,
 * every secondary action — is one click away, unchanged. Nothing is removed.
 *
 * Text colours are explicit dark hex: `var(--ink*)` is a LIGHT token here.
 */
export default function ConditionLine({
  it, role, docs, open, onToggle, onPatch,
  // A row that is finished reads quieter — it is still here, it just is not work.
  done,
}) {
  const stamp = audienceStamp(it.audience);
  const step = nextStep(it, { role, docs });

  // THE DISPLAY STATE — the dot colour, the small status word, and the next step
  // (owner-directed 2026-08-05). Richer than the raw status: it folds in whether a
  // document is waiting to be reviewed, was accepted but not yet signed off, or was
  // rejected — so the row says from the OUTSIDE exactly where the condition is up to.
  const st = conditionDisplayState(it, docs);

  return (
    <div className={`cnd${done ? ' cnd-done' : ''}`} role="button" tabIndex={0}
      aria-expanded={!!open}
      onClick={onToggle}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
      title={open ? 'Close this condition' : 'Open this condition'}>
      <span className={`cnd-chev${open ? ' open' : ''}`} aria-hidden="true">▶</span>
      <span className={`dot ${st.cls}`} title={st.next} />
      <span className="cnd-name">{it.label}</span>
      <span className={`aud ${stamp.cls}`} title={stamp.title}>{stamp.label}</span>
      <NoteBuyerMark it={it} />
      <EsignAutoStamp it={it} />
      {it.is_gate && <span className="pill" style={{ borderColor: 'var(--gold)', color: '#8A6D3B', flex: 'none' }}>gate</span>}
      {it.override_at && <span className="pill" style={{ borderColor: 'var(--gold)', color: '#8A6D3B', flex: 'none' }}>override</span>}
      {/* The small status wording under/beside the dot — says the status, and the
          next step on hover (the whole material-design ask on a compact line). */}
      <span className="cnd-meta" title={st.next}>{st.label}</span>
      {/* The next step, without opening the row. stopPropagation so pressing it
          acts on the condition instead of toggling it open underneath you. */}
      {!done && (
        <span className="cnd-do" onClick={(e) => e.stopPropagation()}>
          <button className={`btn ${step.tone === 'primary' ? 'primary' : 'ghost'} small`}
            title={step.title} onClick={() => onPatch(it.id, step.patch)}>{step.label}</button>
        </span>
      )}
    </div>
  );
}

/* THE NOTE-BUYER MARK — "this one is here because of THIS capital partner."
 *
 * Owner-directed 2026-08-02: "it should have a mark that this condition is for
 * this particular note buyer." Some conditions exist only because of who is buying
 * the note (CorrFirst's EMD and SSN verification, Blue Lake's 5% contingency), and
 * on a list of forty rows there was nothing to tell them apart from the ones every
 * file carries — so a processor could not see which requirement would disappear if
 * the file moved to another buyer.
 *
 * The value is DERIVED SERVER-SIDE from the condition's own rule (staff.js →
 * note-buyer-effects.noteBuyerMark), so it can never disagree with the rule that
 * attached the condition. STAFF-ONLY: the borrower checklist route does not send
 * this field, and a note buyer's name must never reach a borrower surface — so this
 * component renders nothing at all unless the server put a mark on the row.
 *
 * Gold, like every other "PILOT decided this" chip on the line. Text is explicit
 * dark hex — `var(--ink*)` is a LIGHT token in this palette.
 */
export function NoteBuyerMark({ it }) {
  const mark = it && it.note_buyer_mark;
  if (!mark) return null;
  return (
    <span className="pill" style={{ borderColor: 'var(--gold)', color: '#8A6D3B', flex: 'none', fontWeight: 700 }}
      title={`This condition is on the file because the note buyer is ${mark}. It applies to ${mark} files only.`}>
      {mark}
    </span>
  );
}

/* THE DOCUSIGN AUTO-CLEAR STAMP — "this one takes care of itself."
 *
 * Owner-directed 2026-08-05: a few conditions (the term sheet, the application &
 * business-purpose disclosure, the Heter Iska, and — on an individual-vested file —
 * the non-owner-occupied certification) are cleared AUTOMATICALLY when their
 * DocuSign package is fully signed. The borrower signs them in DocuSign when we send
 * the package, so nobody should chase them by hand. The row carries a stamp saying
 * so, DERIVED server-side (staff.js → esign/auto-clear.isAutoClearedByEsign) from the
 * e-sign package definitions, so it can never disagree with what actually clears
 * them. The stamp disappears once the condition is signed off (its own status takes
 * over). Teal, like the other "the system handles this" marks. Text is explicit dark
 * hex — var(--ink*) is a LIGHT token in this palette. */
export function EsignAutoStamp({ it }) {
  if (!it || !it.esign_auto || it.signed_off_at || it.waived_at) return null;
  return (
    <span className="pill" style={{ borderColor: 'var(--teal)', color: '#256168', flex: 'none', fontWeight: 600 }}
      title="This condition clears itself automatically when the DocuSign package is fully signed — no one needs to work it by hand.">
      DocuSign — auto-clears
    </span>
  );
}

/* THE INTERNAL NOTE — shown when there IS one, a quiet link when there is not.
 * It used to render an empty box and a Save button on every single condition:
 * about a full screen of blank boxes down a 24-condition list, for something
 * only a small fraction of conditions ever carries. */
export function ConditionNote({ it, onPatch }) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(it.notes || '');
  React.useEffect(() => { setDraft(it.notes || ''); }, [it.notes]);
  const has = !!(it.notes && it.notes.trim());

  if (!editing) {
    return has ? (
      <div className="row" style={{ width: '100%', gap: 8, alignItems: 'flex-start' }}>
        <div className="cnd-note" style={{ flex: 1, minWidth: 0 }}>{it.notes}</div>
        <button className="btn link small" style={{ flex: 'none' }} onClick={() => setEditing(true)}>Edit note</button>
      </div>
    ) : (
      <button className="btn link small cnd-note-add" onClick={() => setEditing(true)}>+ Add an internal note</button>
    );
  }
  return (
    <div className="row" style={{ width: '100%', gap: 8 }}>
      <input className="input" autoFocus placeholder="Internal note (staff-only)…" value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { onPatch(it.id, { notes: draft }); setEditing(false); } }} />
      <button className="btn ghost" onClick={() => { onPatch(it.id, { notes: draft }); setEditing(false); }}>Save note</button>
      <button className="btn link small" onClick={() => { setDraft(it.notes || ''); setEditing(false); }}>Cancel</button>
    </div>
  );
}
