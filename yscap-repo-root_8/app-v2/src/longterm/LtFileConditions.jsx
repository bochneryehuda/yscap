import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ltApi } from './api.js';
import { stamp } from './format.js';
import LtConditionAnswer from './LtConditionAnswer.jsx';

/**
 * THE GENERAL CONDITION CENTER, on one loan.
 *
 * OUR OWN conditions — what this file needs to get submitted, cleared to close,
 * docked, funded and sold. The section above it on the file screen is the
 * ENCOMPASS MIRROR: what the investor's underwriter raised after buying the
 * loan. Two centres, on purpose.
 *
 * ── FIVE THINGS ON THIS SCREEN ARE DELIBERATE ───────────────────────────────
 *
 * 1. GROUPED BY THE GATE IT BLOCKS, in the buckets' own order, because that is
 *    the order the work happens in. The server owns the order, so this file
 *    holds no rule about it and the two cannot drift.
 *
 * 2. A REFUSAL IS THE ANSWER, AND IT IS SHOWN. Signing off a condition with a
 *    document nobody has looked at is refused BY THE SERVER, in words; this
 *    screen prints those words rather than a generic "that did not work".
 *
 * 3. "DONE" IS THREE DIFFERENT FACTS. Satisfied, waived and did-not-apply are
 *    shown differently and a waiver always shows its reason — that reason is the
 *    thing somebody reads a year later.
 *
 * 4. A CONDITION WHOSE TEMPLATE IS SWITCHED OFF IS GREYED WITH ITS REASON, not
 *    hidden. A feature that
 *    silently disappears is worse than one that says it is off.
 *
 * 5. EVERY COLOUR IS AN EXPLICIT DARK ON WHITE. `--ink*` is a LIGHT paper colour
 *    in this palette — the names are legacy and they lie.
 *
 * ── NO MESSAGE BOX, AND THAT IS BOTH RULES AT ONCE ──────────────────────────
 *
 * The short-term side has a shared `showMessage` / `askConfirm` / `askPrompt`
 * host. Long-Term may not import it — that is a crossing and the owner has not
 * authorized it — and the separation gate refused it when this file first tried.
 * Building a SECOND dialog host inside Long-Term would put two overlays in one
 * app, which is worse than either.
 *
 * So a refusal is rendered ON THE ROW it belongs to and a waiver is typed in a
 * field ON THE ROW, which is what this repo's own rule asks for anyway: a
 * refusal shown at the top of a long screen, away from the button that caused
 * it, reads as "nothing happened".
 */

const INK = '#141B22';
const MUTED = '#4B585C';
const LINE = '#E6E1D6';
const GOLD = '#AE8746';
const GREEN = '#2F6B4F';
const AMBER = '#8A6A17';
const RED = '#8A2D2D';

const STATUS = {
  outstanding: { label: 'Outstanding', colour: INK, tone: '#FFFFFF' },
  in_progress: { label: 'Being worked', colour: AMBER, tone: '#FDF8EC' },
  received: { label: 'Received — not checked yet', colour: AMBER, tone: '#FDF8EC' },
  satisfied: { label: 'Satisfied', colour: GREEN, tone: '#F1F7F3' },
  waived: { label: 'Waived', colour: MUTED, tone: '#F6F5F2' },
  not_applicable: { label: 'Does not apply', colour: MUTED, tone: '#F6F5F2' },
};

const KIND = {
  informational: 'Information',
  form: 'Form',
  order: 'Order',
  esign: 'Signature',
  document: 'Document',
};

export default function LtFileConditions({ loanId }) {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(() => new Set());
  const [rowErr, setRowErr] = useState({});
  const [showDone, setShowDone] = useState(false);

  const load = useCallback(() => {
    setErr(null);
    ltApi.fileConditions(loanId)
      .then(setData)
      .catch((e) => setErr(e.message || 'Could not read this file’s conditions.'));
  }, [loanId]);
  useEffect(load, [load]);

  // A REFUSAL BELONGS TO THE ROW THAT CAUSED IT. Keyed on the condition id, so
  // two rows can never show each other's message and the server's own words are
  // what a person reads — its refusals name what is missing and what to do about
  // it, and replacing them with "that did not work" is what makes a condition
  // feel like a dead end.
  const act = async (id, fn, okNote) => {
    setBusy(true); setNote('');
    setRowErr((prev) => ({ ...prev, [id]: null }));
    try {
      await fn();
      if (okNote) setNote(okNote);
      load();
      return true;
    } catch (e) {
      setRowErr((prev) => ({ ...prev, [id]: e.message || 'That did not work.' }));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const satisfy = (c) => act(
    c.id,
    () => ltApi.conditionSatisfy(loanId, c.id),
    `Marked “${c.label}” satisfied.`,
  );

  const waive = async (c, reason) => {
    const ok = await act(c.id, () => ltApi.conditionWaive(loanId, c.id, reason), `Waived “${c.label}”.`);
    return ok;
  };

  const reopen = (c) => act(c.id, () => ltApi.conditionReopen(loanId, c.id), `Reopened “${c.label}”.`);

  const evaluate = () => act('__file', async () => {
    const out = await ltApi.fileConditionsEvaluate(loanId);
    const bits = [];
    if (out.added && out.added.length) bits.push(`${out.added.length} added`);
    if (out.removed && out.removed.length) bits.push(`${out.removed.length} taken off`);
    // NOTHING IS SILENT. A rule PILOT could not decide is reported, because it
    // means the file was left as it was found — which is not the same as
    // "nothing needed doing".
    if (out.skipped && out.skipped.length) bits.push(`${out.skipped.length} PILOT could not decide`);
    if (!bits.length) bits.push('nothing changed');
    setNote(`Re-checked the rules: ${bits.join(', ')}.${out.degraded ? ` Some of the file could not be read (${out.degraded}), so this is not the whole picture.` : ''}`);
  });

  const remove = (c) => act(c.id, () => ltApi.conditionRemove(loanId, c.id), `Removed “${c.label}”.`);

  const toggle = (id) => setOpen((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const summary = (data && data.summary) || null;

  const groups = useMemo(() => {
    const list = (data && data.buckets) || [];
    if (showDone) return list;
    // The default view is THE WORK. A finished condition is still on the file
    // and one click away — but a list of forty rows where thirty are done is a
    // list nobody reads.
    return list.map((b) => ({
      ...b,
      conditions: b.conditions.filter((c) => !['satisfied', 'waived', 'not_applicable'].includes(c.status)),
    }));
  }, [data, showDone]);

  if (err) return <p style={{ margin: 0, color: RED, fontSize: 13 }}>{err}</p>;
  if (!data) return <p style={{ margin: 0, color: MUTED, fontSize: 13 }}>Reading the conditions…</p>;

  return (
    <>
      {/* A DEGRADED READ IS NOT AN EMPTY FILE. */}
      {data.degraded && (
        <p style={{ margin: '0 0 10px', color: RED, fontSize: 13, lineHeight: 1.55 }}>
          Some of this could not be read just now, so what is below is not the whole picture.
        </p>
      )}

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        {summary && (
          <div style={{ fontSize: 13, color: MUTED }}>
            <strong style={{ color: INK, fontSize: 16 }}>{summary.outstanding}</strong> outstanding
            {summary.received > 0 && <> · <strong style={{ color: AMBER }}>{summary.received}</strong> received, not checked</>}
            {' '}· {summary.satisfied} satisfied
            {summary.waived > 0 && <> · {summary.waived} waived</>}
            {summary.notApplicable > 0 && <> · {summary.notApplicable} did not apply</>}
          </div>
        )}
        <div style={{ flex: 1 }} />
        <label style={{ fontSize: 13, color: INK, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} />
          Show finished
        </label>
        <button className="btn soft" onClick={evaluate} disabled={busy}
          title="Run the rules against this file again and bring its conditions into line.">
          Re-check the rules
        </button>
      </div>

      {note && (
        <div style={{ marginBottom: 12, padding: '9px 12px', border: `1px solid ${LINE}`,
          borderRadius: 8, background: '#FBF9F4', color: INK, fontSize: 13, lineHeight: 1.5 }}>
          {note}
        </div>
      )}

      {groups.map((b) => (
        <div key={b.key} style={{ marginBottom: 16 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: INK }}>{b.label}</div>
            <div style={{ fontSize: 12, color: MUTED }}>
              {b.summary.outstanding} of {b.summary.total} still open
            </div>
            {b.retired && (
              <div style={{ fontSize: 12, color: AMBER }}>
                this gate was retired — these conditions are still here
              </div>
            )}
          </div>
          {b.blurb && <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>{b.blurb}</div>}

          <div style={{ marginTop: 8, display: 'grid', gap: 6 }}>
            {b.conditions.map((c) => (
              <ConditionRow key={c.id} c={c} open={open.has(c.id)} onToggle={() => toggle(c.id)}
                busy={busy} problem={rowErr[c.id] || null} loanId={loanId} onChanged={load}
                onSatisfy={() => satisfy(c)} onWaive={(reason) => waive(c, reason)}
                onReopen={() => reopen(c)} onRemove={() => remove(c)} />
            ))}
            {b.conditions.length === 0 && (
              <div style={{ fontSize: 13, color: MUTED }}>
                {showDone ? 'Nothing here yet.' : 'Nothing outstanding here.'}
              </div>
            )}
          </div>
        </div>
      ))}

      {groups.length === 0 && (
        <p style={{ margin: 0, color: MUTED, fontSize: 13, lineHeight: 1.55 }}>
          No conditions have been worked out for this file yet. Press <strong>Re-check the rules</strong>{' '}
          to run the library against it.
        </p>
      )}
    </>
  );
}

function ConditionRow({ c, open, onToggle, busy, problem, loanId, onChanged, onSatisfy, onWaive, onReopen, onRemove }) {
  const s = STATUS[c.status] || STATUS.outstanding;
  const done = ['satisfied', 'waived', 'not_applicable'].includes(c.status);
  const [waiving, setWaiving] = useState(false);
  const [reason, setReason] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 10, background: s.tone, overflow: 'hidden' }}>
      <button type="button" onClick={onToggle}
        style={{
          display: 'flex', gap: 10, alignItems: 'center', width: '100%', textAlign: 'left',
          background: 'transparent', border: 0, cursor: 'pointer', padding: '10px 14px', font: 'inherit',
        }}>
        <span aria-hidden="true" style={{
          width: 8, height: 8, flex: '0 0 8px', borderRadius: 8,
          background: done ? GREEN : (c.status === 'outstanding' ? GOLD : AMBER),
        }} />
        <span style={{ minWidth: 0, flex: 1 }}>
          <span style={{ display: 'block', fontSize: 14, fontWeight: 600, color: INK }}>{c.label}</span>
          <span style={{ display: 'block', fontSize: 12, color: MUTED, marginTop: 2 }}>
            {KIND[c.kind] || c.kind}
            {!c.isRequired && ' · optional'}
            {c.origin === 'manual' && ' · added by hand'}
            {c.audience !== 'internal' && ' · the borrower sees this'}
            {' · '}{s.label}
          </span>
        </span>
        {/* A condition whose TEMPLATE is switched off is greyed WITH its reason
            rather than hidden — a feature that vanishes reads as one that broke. */}
        {c.enabled === false && (
          <span style={{ fontSize: 11, color: AMBER, whiteSpace: 'nowrap' }}>switched off</span>
        )}
      </button>

      {open && (
        <div style={{ padding: '0 14px 12px', borderTop: `1px solid ${LINE}` }}>
          {c.enabled === false && c.disabledReason && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: AMBER, lineHeight: 1.55 }}>{c.disabledReason}</p>
          )}
          {c.hint && <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>{c.hint}</p>}

          {/* THE THREE CONDITIONS THAT ARE A CHOICE draw their own ways here —
              the mortgages on the credit report, the mortgage on the property
              being refinanced, and the vesting entity reading the borrower's
              profile. It self-hides on every other condition (the workspace
              door answers `null`), so nothing is added to an ordinary row. */}
          {open && (
            <LtConditionAnswer loanId={loanId} conditionId={c.id} onSaved={onChanged} />
          )}

          {c.slots && c.slots.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase',
                color: MUTED, fontWeight: 700 }}>What goes here</div>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13, color: INK }}>
                {c.slots.map((sl) => (
                  <li key={sl.key} style={{ marginTop: 2 }}>
                    {sl.label}{sl.required === false ? ' (optional)' : ''}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ marginTop: 10, fontSize: 12, color: MUTED }}>
            {c.documents.total > 0
              ? `${c.documents.accepted} of ${c.documents.total} document${c.documents.total === 1 ? '' : 's'} accepted`
              : 'No documents on this condition yet'}
          </div>

          {c.status === 'waived' && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, lineHeight: 1.55 }}>
              Waived{c.waivedBy ? ` by ${c.waivedBy}` : ''}{c.waivedAt ? ` on ${stamp(c.waivedAt)}` : ''}
              {c.waivedReason ? ` — ${c.waivedReason}` : ''}
            </p>
          )}
          {c.status === 'satisfied' && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: MUTED }}>
              Satisfied{c.satisfiedBy ? ` by ${c.satisfiedBy}` : ''}{c.satisfiedAt ? ` on ${stamp(c.satisfiedAt)}` : ''}
            </p>
          )}
          {c.notes && (
            <p style={{ margin: '10px 0 0', fontSize: 13, color: INK, whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
              {c.notes}
            </p>
          )}

          {/* THE REFUSAL, WHERE THE BUTTON IS. The server names what is missing
              and what to do about it; this prints those words verbatim. */}
          {problem && (
            <p style={{ margin: '10px 0 0', padding: '8px 10px', borderRadius: 8,
              background: '#FBF1F1', color: RED, fontSize: 13, lineHeight: 1.5 }}>
              {problem}
            </p>
          )}

          {waiving ? (
            <div style={{ marginTop: 12 }}>
              <label style={{ fontSize: 12, color: MUTED, display: 'block', marginBottom: 4 }}>
                Why is this being waived? This is what somebody reads a year from now.
              </label>
              <textarea className="input" rows={2} style={{ width: '100%', fontSize: 14 }}
                value={reason} onChange={(e) => setReason(e.target.value)} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <button className="btn" disabled={busy || reason.trim().length < 4}
                  onClick={async () => { if (await onWaive(reason)) { setWaiving(false); setReason(''); } }}>
                  Waive it
                </button>
                <button className="btn ghost" onClick={() => { setWaiving(false); setReason(''); }}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="act-bar" style={{ marginTop: 12, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {!done && <button className="btn" onClick={onSatisfy} disabled={busy}>Mark satisfied</button>}
              {!done && <button className="btn soft" onClick={() => setWaiving(true)} disabled={busy}>Waive…</button>}
              {done && <button className="btn soft" onClick={onReopen} disabled={busy}>Reopen</button>}
              {c.origin === 'manual' && (confirmRemove
                ? (
                  <>
                    <button className="btn ghost" style={{ color: RED }} disabled={busy}
                      onClick={() => { setConfirmRemove(false); onRemove(); }}>
                      Yes, remove it
                    </button>
                    <button className="btn ghost" onClick={() => setConfirmRemove(false)}>Keep it</button>
                  </>
                )
                : <button className="btn ghost" onClick={() => setConfirmRemove(true)} disabled={busy}>Remove</button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
