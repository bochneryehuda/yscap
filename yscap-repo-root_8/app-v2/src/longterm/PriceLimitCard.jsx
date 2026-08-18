// LT PPE — the sheet's PRICE LIMITS: what is in force now, who moved it last, and the control.
//
// THE DEFECT THIS CLOSES, MEASURED. `PUT /api/lt/ppe/rate-sheets/:id/price-limit` has existed since
// the rate-sheet console routes landed, and `ltApi.ppeSetPriceLimit` has existed beside it — and
// `scripts/check-lt-http-reachability.js` reported it as the ONE client entry that NO SCREEN CALLS.
// A route, a client method, and no button: the five values that bound every quote this sheet answers
// could only be set with curl. That is the same dead end this workstream keeps finding, one step
// nearer the user.
//
// A PRICE LIMIT IS A MONEY RULE, and this screen treats it as one:
//
//   1. WHAT IS IN FORCE NOW IS SHOWN FIRST, before any input. A person about to move a price floor
//      must be able to read the floor they are moving without hunting for it.
//   2. WHO MOVED IT LAST, WHEN, AND WHY is shown beside it. The write is an upsert — the previous
//      floor is overwritten in place — so the recorded history is the only thing that can answer
//      "why is this 95 and not 98?" a year from now.
//   3. THE REASON IS REQUIRED, and the button says so. The server refuses without one; the screen
//      refuses first so nobody types a whole form to be told at the end.
//   4. THE CHANGE IS CONFIRMED, and the confirmation QUOTES BOTH SIDES — from what, to what. One
//      that only says "are you sure?" adds a click and no information.
//
//      IT IS AN INLINE STEP, NOT A DIALOG, and that is structural rather than taste. The browser's
//      `confirm()` is banned outright here (it stamps the hosting origin on our own wording and
//      cannot be styled), and the app's shared dialog helper lives in RTL's folders
//      (`app-v2/src/lib/dialog.js`) which Long-Term may not import without the owner's written
//      authorization — the separation gate refuses it, which is the gate doing its job, and
//      `LtPpe.jsx` records the same decision for the same reason. A second Long-Term copy of a
//      dialog would duplicate a solved problem, so the better answer is not to need one. It is also
//      simply better here: the before-and-after belongs beside the form somebody just filled in,
//      not in a box painted over it.
//   5. NOTHING IS HIDDEN. A published sheet cannot take a new limit (the server is draft-only), and
//      that refusal is SHOWN with the way forward rather than the control being quietly removed — a
//      hidden button is indistinguishable from a broken one.
//
// Dark text on the white PILOT canvas throughout — never a `--ink*` token, which is a LIGHT paper
// colour in this palette and renders white-on-white.

import React, { useState } from 'react';
import { ltApi } from './api.js';
import { points } from './ratesheetPaste.js';
import { INK, MUTED, SLATE, DANGER, CAUTION, eyebrow, input, label } from './ppeStyles.js';

// The rounding vocabulary the ENGINE reads (`ratesheet.resolveRounding`). Offering a token the engine
// does not know would store a mode that silently falls back to a default at pricing time, which is a
// money rule that reads one way on the screen and behaves another.
export const ROUNDING_MODES = [
  { value: 'none', label: 'None — leave the price exactly as computed' },
  { value: 'nearest_eighth', label: 'Nearest eighth (0.125)' },
  { value: 'nearest', label: 'Nearest increment' },
  { value: 'down', label: 'Down to the increment' },
  { value: 'up', label: 'Up to the increment' },
];

export const ON_EXCEED = [
  { value: 'cap_and_keep_eligible', label: 'Cap the price and keep the loan eligible' },
  { value: 'ineligible', label: 'Make the loan ineligible' },
];

/** A stored price-limit row as the sentence a person reads. Never invents a value it was not given. */
export function describeLimit(pl) {
  if (!pl) return null;
  const floor = pl.min_price_milli == null ? null : points(pl.min_price_milli);
  const inc = pl.rounding_increment_milli == null ? null : points(pl.rounding_increment_milli);
  return {
    floor,
    // A NULL floor is a real answer and a different one from a floor of zero: it means this sheet
    // states no minimum price at all, not that it will sell at nothing.
    floorText: floor == null ? 'no minimum price' : `minimum price ${floor}`,
    roundingMode: pl.rounding_mode || null,
    increment: inc,
    onExceed: pl.on_exceed || null,
    capTiers: Array.isArray(pl.cap_tiers) ? pl.cap_tiers : [],
  };
}

/** The five values as one line, for a confirmation that quotes both sides. */
export function limitLine(d) {
  if (!d) return 'no price limits at all';
  const bits = [d.floorText];
  if (d.roundingMode) bits.push(`rounding ${d.roundingMode}${d.increment != null ? ` by ${d.increment}` : ''}`);
  if (d.onExceed) bits.push(`over a cap: ${d.onExceed}`);
  if (d.capTiers.length) bits.push(`${d.capTiers.length} loan-size cap tier${d.capTiers.length === 1 ? '' : 's'}`);
  return bits.join(', ');
}

function whenOf(ms) {
  if (!ms || !Number.isFinite(Number(ms))) return 'an unrecorded time';
  try { return new Date(Number(ms)).toLocaleString(); } catch (_) { return 'an unrecorded time'; }
}

/** One recorded change, in words. */
export function changeLine(h) {
  if (!h) return '';
  const who = h.changedBy || 'somebody whose name was not recorded';
  const fields = Array.isArray(h.changedFields) && h.changedFields.length
    ? h.changedFields.join(', ')
    : 'nothing (the values were re-saved unchanged)';
  return `${who} · ${whenOf(h.changedAt)} · changed ${fields}`;
}

// ---------------------------------------------------------------------------
// The PRESENTATIONAL half — exported so the loaded states can be rendered and
// asserted on. `renderToString` never runs an effect, and every state worth
// guarding here (limits in force, the history, the published refusal) is one
// this component is HANDED rather than one it fetches.
// ---------------------------------------------------------------------------
export function PriceLimitCardView({
  priceLimit, history, editable, status, busy, error, note,
  form, onField, pending, onReview, onConfirm, onCancel,
}) {
  const inForce = describeLimit(priceLimit);
  const last = Array.isArray(history) && history.length ? history[0] : null;
  const rest = Array.isArray(history) ? history.slice(1) : [];
  const reasonOk = (form.reason || '').trim().length >= 8;

  return (
    <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(20,27,34,.03)', border: '1px solid rgba(20,27,34,.10)' }}>
      <div style={{ ...eyebrow, marginBottom: 6 }}>Price limits</div>
      <p style={{ margin: '0 0 10px', fontSize: 13, color: SLATE }}>
        These are the MONEY RULES of this sheet: the lowest price a loan may be sold at, the increment
        every price is snapped to, the loan-size ceilings, and what happens when a price exceeds one.
        Every quote this sheet answers is bounded by them, so a change is recorded with your name and
        your reason on it.
      </p>

      {/* 1 — WHAT IS IN FORCE NOW, before any input. */}
      <div style={{ padding: '10px 12px', borderRadius: 8, background: '#fff', border: '1px solid rgba(20,27,34,.12)', marginBottom: 10 }}>
        <div style={{ ...eyebrow, marginBottom: 4 }}>In force now</div>
        {inForce ? (
          <div style={{ fontSize: 13.5, color: INK }}>{limitLine(inForce)}</div>
        ) : (
          // Said out loud rather than left as an empty box: no limit row means this sheet prices with
          // the engine's coded defaults, which is a real state and not the same as a floor of zero.
          <div style={{ fontSize: 13.5, color: CAUTION }}>
            No price limits are set on this version — it prices with the engine&apos;s coded defaults.
          </div>
        )}
        {/* 2 — WHO MOVED IT LAST, AND WHY. */}
        {last ? (
          <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED }}>
            Last changed by {changeLine(last)}
            {last.reason ? <> — &ldquo;{last.reason}&rdquo;</> : ' — no reason was recorded'}
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 12.5, color: MUTED }}>
            No recorded change to these limits yet.
          </div>
        )}
      </div>

      {rest.length > 0 && (
        <details style={{ marginBottom: 10 }}>
          <summary style={{ fontSize: 13, color: SLATE, cursor: 'pointer' }}>
            {rest.length} earlier change{rest.length === 1 ? '' : 's'} to these limits
          </summary>
          <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: SLATE }}>
            {rest.map((h) => (
              <li key={h.id} style={{ marginBottom: 4 }}>
                {changeLine(h)}
                {h.reason ? <> — &ldquo;{h.reason}&rdquo;</> : ' — no reason was recorded'}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* 5 — a published sheet cannot take a new limit; the refusal is SHOWN, with the way forward. */}
      {!editable && (
        <p style={{ margin: '0 0 6px', fontSize: 13, color: CAUTION }}>
          This version is {status}, so its price limits can no longer be changed — live quotes price
          from them. Open a NEW draft on the same program and set the limits there; a published sheet
          is superseded by a new version, never rewritten underneath the quotes using it.
        </p>
      )}

      {editable && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 10 }}>
            <div style={{ flex: '1 1 160px', minWidth: 0 }}>
              <label style={label} htmlFor="pl-min">Minimum price (points)</label>
              <input id="pl-min" style={input} value={form.minPrice} inputMode="decimal"
                onChange={(e) => onField('minPrice', e.target.value)} placeholder="98.000" />
            </div>
            <div style={{ flex: '2 1 220px', minWidth: 0 }}>
              <label style={label} htmlFor="pl-mode">Rounding</label>
              <select id="pl-mode" style={input} value={form.roundingMode}
                onChange={(e) => onField('roundingMode', e.target.value)}>
                {ROUNDING_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ flex: '1 1 150px', minWidth: 0 }}>
              <label style={label} htmlFor="pl-inc">Rounding increment (points)</label>
              <input id="pl-inc" style={input} value={form.increment} inputMode="decimal"
                onChange={(e) => onField('increment', e.target.value)} placeholder="0.125" />
            </div>
            <div style={{ flex: '2 1 240px', minWidth: 0 }}>
              <label style={label} htmlFor="pl-exceed">When a price exceeds a cap</label>
              <select id="pl-exceed" style={input} value={form.onExceed}
                onChange={(e) => onField('onExceed', e.target.value)}>
                {ON_EXCEED.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </div>
          </div>

          {/* 3 — the reason, required, and said so before anyone types the form. */}
          <label style={label} htmlFor="pl-reason">Why are these limits being set?</label>
          <input id="pl-reason" style={input} value={form.reason}
            onChange={(e) => onField('reason', e.target.value)}
            placeholder="e.g. investor floor stated on the executed term sheet" />

          {/* 4 — the INLINE confirmation, quoting BOTH sides. Nothing is sent on the first press. */}
          {!pending && (
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn" type="button" disabled={busy || !reasonOk} onClick={onReview}>
                Review this change
              </button>
              {!reasonOk && (
                <span style={{ fontSize: 12, color: MUTED }}>
                  A reason of at least 8 characters is required — a money rule may not move unexplained.
                </span>
              )}
            </div>
          )}

          {pending && (
            <div style={{
              marginTop: 10, padding: '10px 12px', borderRadius: 8,
              background: 'rgba(174,135,70,.08)', border: '1px solid rgba(174,135,70,.40)',
            }}>
              <div style={{ ...eyebrow, color: CAUTION, marginBottom: 6 }}>Confirm this change</div>
              <p style={{ margin: '0 0 8px', fontSize: 13, color: INK, lineHeight: 1.6 }}>
                This changes the money rules every quote on this sheet is bounded by.
              </p>
              {/* BOTH SIDES, quoted. A confirmation that only asks "are you sure?" costs a click and
                  tells a person nothing they did not already know. */}
              <div style={{ fontSize: 13, color: SLATE, lineHeight: 1.7 }}>
                <div><strong style={{ color: INK }}>Now:</strong> {pending.before}</div>
                <div><strong style={{ color: INK }}>After:</strong> {pending.after}</div>
                <div style={{ marginTop: 4 }}><strong style={{ color: INK }}>Reason:</strong> {pending.reason}</div>
              </div>
              <div style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
                <button className="btn" type="button" disabled={busy} onClick={onConfirm}>
                  {busy ? 'Changing…' : 'Change them, and record why'}
                </button>
                <button className="btn ghost" type="button" disabled={busy} onClick={onCancel}>
                  Go back
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {error && <p style={{ margin: '10px 0 0', fontSize: 13, color: DANGER }}>{error}</p>}
      {note && <p style={{ margin: '10px 0 0', fontSize: 13, color: '#256168' }}>{note}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The container: the ONE caller of `ltApi.ppeSetPriceLimit`.
// ---------------------------------------------------------------------------
export default function PriceLimitCard({ version, priceLimit, history, editable, status, onSaved }) {
  const [form, setForm] = useState(() => ({
    minPrice: priceLimit && priceLimit.min_price_milli != null ? points(priceLimit.min_price_milli) : '',
    roundingMode: (priceLimit && priceLimit.rounding_mode) || 'nearest_eighth',
    increment: priceLimit && priceLimit.rounding_increment_milli != null ? points(priceLimit.rounding_increment_milli) : '0.125',
    onExceed: (priceLimit && priceLimit.on_exceed) || 'cap_and_keep_eligible',
    reason: '',
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  // The armed change: what would be SENT, plus the before/after sentences the confirmation quotes.
  // Nothing reaches the server until this has been confirmed.
  const [pending, setPending] = useState(null);

  // Editing anything CLEARS the armed change. Without this, a person could arm a change, edit a
  // number, and confirm the OLD one — the confirmation would be quoting a change nobody is making.
  const onField = (k, v) => { setPending(null); setForm((f) => ({ ...f, [k]: v })); };

  const review = () => {
    setError(''); setNote(''); setPending(null);
    const minPrice = form.minPrice.trim();
    const increment = form.increment.trim();
    // Refused HERE rather than sent: a blank minimum price is a deliberate "no floor", but text that
    // is not a number is a typo, and storing a NaN as a price floor is the failure worth a refusal.
    if (minPrice !== '' && !Number.isFinite(Number(minPrice))) {
      setError('The minimum price must be a number in points (for example 98.000), or left blank for no floor.');
      return;
    }
    if (increment !== '' && !Number.isFinite(Number(increment))) {
      setError('The rounding increment must be a number in points (for example 0.125).');
      return;
    }

    const body = {
      minPriceMilli: minPrice === '' ? null : Math.round(Number(minPrice) * 1000),
      roundingMode: form.roundingMode,
      onExceed: form.onExceed,
      reason: form.reason.trim(),
    };
    if (increment !== '') body.roundingIncrementMilli = Math.round(Number(increment) * 1000);
    // Existing cap tiers are carried through rather than dropped: this control does not edit them,
    // and sending nothing would silently DELETE loan-size ceilings somebody set elsewhere.
    if (priceLimit && Array.isArray(priceLimit.cap_tiers)) body.capTiers = priceLimit.cap_tiers;

    setPending({
      body,
      before: limitLine(describeLimit(priceLimit)),
      after: limitLine({
        floorText: minPrice === '' ? 'no minimum price' : `minimum price ${minPrice}`,
        roundingMode: form.roundingMode,
        increment: increment === '' ? null : increment,
        onExceed: form.onExceed,
        capTiers: (priceLimit && Array.isArray(priceLimit.cap_tiers)) ? priceLimit.cap_tiers : [],
      }),
      reason: body.reason,
    });
  };

  const confirm = async () => {
    if (!pending) return;
    setBusy(true); setError(''); setNote('');
    try {
      // The body SENT is the one that was REVIEWED, never re-read off the form — otherwise a change
      // typed between the review and the press would be sent under a confirmation of something else.
      const r = await ltApi.ppeSetPriceLimit(version.id, pending.body);
      setPending(null);
      setForm((f) => ({ ...f, reason: '' }));
      setNote('The price limits were changed, and the change is on the record.');
      if (onSaved) await onSaved(r);
    } catch (e) {
      // The server names WHICH rule was broken — a missing reason, a published sheet, not an
      // administrator. A generic failure would leave a person unable to tell them apart.
      setError(e.message || 'That change was refused.');
      setPending(null);
    } finally { setBusy(false); }
  };

  return (
    <PriceLimitCardView
      priceLimit={priceLimit} history={history} editable={editable} status={status}
      busy={busy} error={error} note={note}
      form={form} onField={onField}
      pending={pending} onReview={review} onConfirm={confirm} onCancel={() => setPending(null)}
    />
  );
}
