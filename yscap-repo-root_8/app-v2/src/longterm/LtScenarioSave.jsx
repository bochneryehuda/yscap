import React, { useState } from 'react';
import { ltApi } from './api.js';
import { toScenario } from './scenarioFields.js';
import {
  INK, MUTED, GOLD_TEXT, DANGER, CAUTION,
  band, bandHead, control, fieldLabel, fieldHint,
} from './ppeStyles.js';

/* ═══════════════════════════════════════════════════════════════════════════
   SAVE THIS SCENARIO — the pricing engine's half of the feature (db/658,
   owner-directed 2026-08-31; SAVED-SCENARIOS-RESEARCH.md D1 and §7 step 3).

   ⛔ THE PRICING ENGINE SAVES. IT NEVER LOADS. The owner drew that line
   themselves when they chose "both": this screen gets the button and the
   dialog, and the Scenarios page owns the list, the re-run and the
   create-from-scratch. A saved scenario never reloads into the pricing engine —
   so there is no "open" here, and adding one would put two answers on the same
   screen to "which deal am I looking at".

   ⛔ SAVING TAKES YOU NOWHERE. It confirms, in place, and says where the
   scenario went. Navigating away from a board somebody just priced — a live
   answer that costs a vendor call to get back — to a list they did not ask for
   is the kind of helpfulness that loses work.

   ⛔ A SCENARIO IS INPUTS, NOT A PRICE. What is sent is what was typed (`form`,
   which restores the boxes), what was sent (`scenario`, through the SAME
   `toScenario` the search uses — never a second reading of the form), and the
   calculator's own boxes. The one figure is a DATED HEADLINE, and the date is
   the server's clock, never this page's.
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * THE HEADLINE, TAKEN OFF THE WHOLE ANSWER — deliberately NOT off the board as
 * the investor filter has left it.
 *
 * The filter is a DISPLAY overlay: Lender Price is always asked for everybody,
 * and one press brings the rest back. A headline taken from a narrowed board
 * would move when the FILTER moved, so "the best rate has come down since you
 * saved this" would be reporting a change to somebody's own view as though it
 * were a change in the market — which is the one thing D4 exists to answer
 * honestly. The panel says which it is, so nobody has to guess.
 *
 * ⛔ IT TAKES THE FLATTENED STACK, NEVER THE VENDOR PAYLOAD. A rate lives at
 * `program.options[].priceBuild.noteRate` and a second reading of that shape
 * here would be a second flattener — and the one that drifts is the one nobody
 * is watching, because a wrong field reads as an empty board rather than as an
 * error. `buildRateStack` is the one flattener; this only summarises it.
 *
 * Every figure is optional and NOTHING is invented: a board with nothing priced
 * on it saves NO headline rather than a zero pretending to be one.
 */
export function boardHeadline(stack) {
  if (!stack || !Array.isArray(stack.rates) || !stack.rates.length) return null;
  const best = stack.rates[0];               // buildRateStack sorts by rate, ascending
  if (!Number.isFinite(Number(best.rate))) return null;
  let programs = 0;
  const lenders = new Set();
  for (const r of stack.rates) {
    for (const q of (r.quotes || [])) { programs += 1; lenders.add(q.lender || ''); }
  }
  if (!programs) return null;
  const out = { bestRate: Number(best.rate), programs, lenders: lenders.size };
  // The price that goes with the best RATE, not the best price anywhere on the
  // board: the two belong to different quotes, and printing them side by side
  // would describe a product nobody can buy.
  if (Number.isFinite(Number(best.bestPrice))) out.bestPrice = Number(best.bestPrice);
  return out;
}

const boxStyle = { ...control, height: 38 };

export default function LtScenarioSave({ form, boardStack, disabled }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [borrower, setBorrower] = useState('');
  const [entity, setEntity] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);

  const f = form && form.f ? form.f : {};
  const calc = form && form.calc ? form.calc : {};
  const headline = boardHeadline(boardStack);

  const close = () => {
    setOpen(false); setErr(null);
    setName(''); setAddress(''); setBorrower(''); setEntity('');
  };

  const save = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await ltApi.dscrSaveScenario({
        name, propertyAddress: address, borrowerName: borrower, entityName: entity,
        form: f,
        // THE SAME FUNCTION THE SEARCH USES. A second reading of the form here
        // would be a second answer to what this deal is, and the one that drifts
        // is the one that gets priced.
        scenario: toScenario(f),
        calc,
        savedBoard: headline,
      });
      // ⛔ THE CONFIRMATION QUOTES THE NAME THE SERVER GAVE IT, never a name this
      // page predicted. The auto-naming ladder lives on the server; mirroring it
      // here to show a preview would be a second copy of a rule, and this says
      // what actually happened instead of what was expected to.
      const saved = r && r.scenario ? r.scenario : null;
      setNote(saved && saved.name ? saved.name : 'your scenario');
      close();
    } catch (e) {
      setErr((e && e.message) || 'Could not save that scenario.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button type="button" className="btn ghost" disabled={disabled || busy}
        onClick={() => { setNote(null); setOpen((o) => !o); }}>
        {open ? 'Cancel saving' : 'Save this scenario'}
      </button>

      {/* THE CONFIRMATION STAYS PUT — the board is still on screen behind it,
          which is the whole point of not navigating anywhere. */}
      {note && !open && (
        <span style={{ fontSize: 12.5, color: GOLD_TEXT }}>
          Saved as <strong>{note}</strong> — it is on your Scenarios page.
        </span>
      )}

      {open && (
        <section style={{ ...band, width: '100%', marginTop: 10 }}>
          <div style={bandHead}>Save this scenario</div>
          <div style={{ padding: '10px 12px' }}>
            <div style={{ fontSize: 11.5, color: MUTED, lineHeight: 1.5, marginBottom: 10 }}>
              This saves what you <strong>typed</strong>, so you can re-run it any day and get that
              day&rsquo;s answer. It is not a saved price — rates move, and a term sheet is the
              thing that holds one.
              {' '}Every box below is optional; leave the name blank and it names itself.
            </div>

            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                ['pe-scn-name', 'Scenario name', name, setName, 'Leave blank to name it from the address'],
                ['pe-scn-address', 'Property address', address, setAddress, ''],
                ['pe-scn-borrower', 'Borrower name', borrower, setBorrower, ''],
                ['pe-scn-entity', 'Entity name', entity, setEntity, ''],
              ].map(([id, lbl, val, set, hint]) => (
                <div key={id} style={{ flex: '1 1 220px', minWidth: 180 }}>
                  <label htmlFor={id} style={fieldLabel}>{lbl}</label>
                  <input id={id} className="input" style={boxStyle} value={val}
                    onChange={(e) => set(e.target.value)} />
                  {hint ? <div style={fieldHint}>{hint}</div> : null}
                </div>
              ))}
            </div>

            {/* WHAT THE HEADLINE IS, IN WORDS, BEFORE IT IS SAVED. A figure with
                no "as at" beside it is exactly the saved price this must not
                become, so the panel says both what it is and what it is not. */}
            <div style={{ marginTop: 10, fontSize: 11.5, color: headline ? CAUTION : MUTED, lineHeight: 1.5 }}>
              {headline
                ? <>Today&rsquo;s best rate <strong>{headline.bestRate.toFixed(3)}%</strong>
                  {' '}across {headline.programs} {headline.programs === 1 ? 'product' : 'products'}
                  {' '}is saved <strong>with today&rsquo;s date</strong>, so a re-run can tell you what
                  moved. It is the whole answer, not the investors you have showing.</>
                : <>Nothing has been priced yet, so this saves the scenario on its own — re-run it
                  any time to see the day&rsquo;s board.</>}
            </div>

            {err && <div style={{ marginTop: 8, fontSize: 12.5, color: DANGER }}>{err}</div>}

            <div style={{ display: 'flex', gap: 10, marginTop: 12, alignItems: 'center' }}>
              <button type="button" className="btn primary" disabled={busy} onClick={save}>
                {busy ? 'Saving…' : 'Save scenario'}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={close}>Cancel</button>
              <span style={{ fontSize: 11.5, color: INK, opacity: 0.7 }}>
                Saving keeps you here — the board stays exactly as it is.
              </span>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
