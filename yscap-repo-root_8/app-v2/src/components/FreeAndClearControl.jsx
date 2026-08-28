import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api.js';
import { askConfirm } from '../lib/dialog.js';

/* "THE PROPERTY IS FREE AND CLEAR" — one control, one wording, wherever it is offered.
 *
 * Owner-directed 2026-08-24: *"There are a few conditions: asking for a payoff, asking to verify
 * the payoff, asking maybe for a VOM. Those payoff conditions are about the old mortgage. If you
 * mark over there in that condition, there is already logic to mark the property free and clear.
 * In that condition, you should be able to attach that logic and mark over there that the property
 * is free and clear, and that should waive the payoff condition, the verified payoff condition…"*
 *
 * THE LOGIC EXISTED AND THE PLACE DID NOT. The confirmation, the waiver of both payoff conditions
 * and the $0 payoff of record have all worked since db/575 — but the only way to reach them was
 * the Payoff section, or the STAFF "Payoff verified" condition. The condition a processor is
 * actually looking at when they discover there is no mortgage is the BORROWER-facing "Current
 * mortgage / payoff statement (existing loan)", and that row offered nothing at all. So this is the
 * action lifted out of PayoffCard into its own component, so a second surface is a mount rather
 * than a copy — a second copy of a confirm dialog is how one surface ends up promising something
 * the other does not do.
 *
 * NOTHING IS RE-DERIVED HERE. What is waived, whether the file is frozen, and whether this is even
 * a refinance are all the SERVER's answers (`POST …/payoff/free-and-clear` → src/lib/payoff.js
 * FREE_AND_CLEAR_WAIVES). This asks, confirms, and reports what came back.
 *
 * STAFF-ONLY. Text colors are explicit dark hex per the white-first rule (an --ink* token resolves
 * LIGHT and would render white-on-white).
 */

const INK = '#141B22';
const MUTED = '#4B585C';

/* ONE wording for the two directions, so the question a person is asked is the same question
   whichever screen they are standing on. It names BOTH consequences — the conditions and the $0 —
   because turning this on is how a payoff step disappears from a file. */
export const CONFIRM_ON =
  'Yes — this property is owned FREE AND CLEAR: there is NO existing loan to pay off. '
  + 'Both payoff conditions will be waived and the payoff of record becomes $0. Confirm?';
export const CONFIRM_OFF =
  'Turn OFF free and clear? The payoff conditions reopen and the payoff details will be needed again.';

/**
 * @param appId       the file
 * @param state       the payoff state from the server, when the caller already has it (PayoffCard
 *                    does). Omit it and this fetches its own — that is what lets a condition row
 *                    mount the control without hosting the whole payoff section.
 * @param compact     render the one-line form for a condition row rather than the section notice
 * @param onChanged   reload the caller after a successful flip
 */
export default function FreeAndClearControl({ appId, state = null, compact = false, onChanged = null }) {
  const [own, setOwn] = useState(null);      // our own copy, when the caller passed none
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const fetchOwn = useCallback(() => {
    if (state) return;
    api.get(`/api/staff/applications/${appId}/payoff`).then(setOwn).catch(() => setOwn(null));
  }, [appId, state]);
  useEffect(() => { fetchOwn(); }, [fetchOwn]);

  const s = state || own;

  async function flip(on) {
    if (!(await askConfirm(on ? CONFIRM_ON : CONFIRM_OFF))) return;
    setBusy(true); setErr('');
    try {
      await api.payoffFreeAndClear(appId, on);
      fetchOwn();
      if (onChanged) await onChanged();
    } catch (ex) {
      /* The server's own words, never a generic one. It refuses a purchase, a frozen file and a
         missing confirmation with three different sentences, and each of them tells the reader
         something they can act on. */
      setErr((ex && ex.message) || 'Could not update the free-and-clear flag.');
    } finally { setBusy(false); }
  }

  // Nothing is known yet, or this is not a refinance — the server says so by not applying.
  if (!s || s.applies === false) return null;

  const on = s.freeAndClear === true;

  if (compact) {
    return (
      <div style={{ marginTop: 8 }}>
        {on ? (
          <div className="small" style={{ color: INK }}>
            <b>Property is free and clear</b> — there is no existing loan to pay off, so this
            condition is waived and the payoff of record is $0.{' '}
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => flip(false)}>
              Turn off — there IS a loan to pay off
            </button>
          </div>
        ) : (
          <div className="small" style={{ color: MUTED }}>
            No existing loan on this property?{' '}
            <button type="button" className="btn ghost small" disabled={busy} onClick={() => flip(true)}>
              Property is free and clear…
            </button>
          </div>
        )}
        {err && <div role="alert" className="notice err" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
      </div>
    );
  }

  return on ? (
    <div className="notice ok" style={{ marginTop: 12, marginBottom: 0 }}>
      <b>Property is free and clear.</b> There is no existing loan to pay off — the payoff of
      record is $0 and both payoff conditions are waived.
      <div style={{ marginTop: 8 }}>
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => flip(false)}>
          Turn off — there IS a loan to pay off
        </button>
      </div>
      {err && <div role="alert" className="notice err" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
    </div>
  ) : (
    <>
      <button type="button" className="btn ghost" disabled={busy} onClick={() => flip(true)}>
        Property is free and clear…
      </button>
      {err && <div role="alert" className="notice err" style={{ marginTop: 8, marginBottom: 0 }}>{err}</div>}
    </>
  );
}
