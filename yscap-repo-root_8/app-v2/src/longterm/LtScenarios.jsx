import React, { useCallback, useEffect, useState } from 'react';
import { askConfirm } from '../lib/dialog.js';
import { ltApi } from './api.js';
import { useScenarioForm, ScenarioFields } from './LtScenarioFields.jsx';
import { toScenario, searchProblem } from './scenarioFields.js';
/* ⛔ ONE FLATTENER AND ONE HEADLINE, BORROWED — never rebuilt here. `buildRateStack` turns the
   vendor's programmes into rates (a rate lives at `options[].priceBuild.noteRate`, which is exactly
   the shape a second reading gets wrong quietly), and `boardHeadline` is what the SAVE wrote. If
   this page computed either one differently, "what moved since you saved it" would be reporting the
   difference between two readings of the same board as though the market had moved. */
import { buildRateStack } from './LtPricer.jsx';
import { GENERAL_ENGINE } from './pricerEngine.js';
import { boardHeadline } from './LtScenarioSave.jsx';
import { noteRate, price, dayOf, ago, plain } from './format.js';
import {
  INK, MUTED, SLATE, GOLD, GOLD_TEXT, DANGER, CAUTION,
  card, eyebrow, sub, band, bandHead, control, fieldLabel, LINE, WASH,
} from './ppeStyles.js';

/* ═══════════════════════════════════════════════════════════════════════════
   SAVED SCENARIOS (db/658, owner-directed 2026-08-31;
   `docs/longterm/SAVED-SCENARIOS-RESEARCH.md` D1/D4 and §7 steps 4–5).

   The owner chose BOTH surfaces and drew the line themselves: the pricing engine
   SAVES, and this page owns the LIST, the RE-RUN and the CREATE-FROM-SCRATCH.

   ⛔ A SAVED SCENARIO IS INPUTS, NOT A PRICE. Rates move daily, so re-running one
   tomorrow is a DIFFERENT board — the same question, a new answer. The saved
   headline is never shown as a current figure: it always carries the day it was
   true, and the comparison is worded as a change over that period rather than as
   a quote. PILOT's honest saved price is a term sheet — stamped, expiring, coded.

   ⛔ THE FORM IS THE PRICING ENGINE'S OWN COMPONENT (D1/§5). `ScenarioFields` +
   `useScenarioForm` are mounted here exactly as they are mounted there. A second
   copy of twenty-one pricing fields is a second answer to what a deal is, and the
   one that drifts is the one that gets priced.

   ⛔ AND THE RE-RUN IS THE SAME DOOR. `toScenario` → `/api/lt/dscr/price`, the
   call the pricing engine makes. This page holds no pricing rule and asks the
   vendor nothing the engine would not ask.

   WHAT THIS PAGE DELIBERATELY IS NOT: the board. The full answer — every build,
   the ineligible side, the comparison cart, the compensation overlay — is the
   pricing engine's, and rebuilding it here would be a second board to keep in
   step. A re-run answers the question this page exists for (what moved) and says
   where the whole answer lives.
   ══════════════════════════════════════════════════════════════════════════ */

const rowStyle = {
  display: 'flex', gap: 12, alignItems: 'baseline', justifyContent: 'space-between',
  padding: '10px 12px', borderBottom: `1px solid ${LINE}`,
};

/** The saved headline, always with the day beside it. Never a bare figure. */
function SavedHeadline({ b }) {
  if (!b) {
    return <span style={{ fontSize: 12, color: MUTED }}>saved without pricing it</span>;
  }
  return (
    <span style={{ fontSize: 12, color: MUTED }}>
      best rate <strong style={{ color: SLATE }}>{noteRate(b.bestRate)}</strong>
      {' '}on {dayOf(b.at)}
    </span>
  );
}

/**
 * WHAT MOVED (D4 — the owner asked to be told). Two dated readings of the same
 * question, and the wording is careful in both directions:
 *
 *   • it names the DAY the old figure was true, so nothing here reads as a quote;
 *   • it says which way and by how much, in basis points, because "the rate
 *     changed" is not an answer anybody can act on;
 *   • and with nothing to compare against it says exactly that, rather than
 *     showing a zero that would read as "nothing has moved".
 */
export function movementLine(saved, now) {
  if (!now) return null;
  if (!saved || !Number.isFinite(Number(saved.bestRate))) {
    return { tone: 'none', text: 'This scenario was saved without a priced board, so there is nothing to compare today’s answer against.' };
  }
  const bps = Math.round((Number(now.bestRate) - Number(saved.bestRate)) * 1000) / 10;
  if (bps === 0) {
    return { tone: 'flat', text: `The best rate is unchanged at ${noteRate(now.bestRate)} since ${dayOf(saved.at)}.` };
  }
  const dir = bps < 0 ? 'down' : 'up';
  return {
    tone: bps < 0 ? 'better' : 'worse',
    text: `The best rate is ${dir} ${Math.abs(bps).toFixed(1)} bps since ${dayOf(saved.at)} — ${noteRate(saved.bestRate)} then, ${noteRate(now.bestRate)} today.`,
  };
}

function Ledger({ stack }) {
  if (!stack || !stack.rates.length) return null;
  const shown = stack.rates.slice(0, 5);
  const more = stack.rates.length - shown.length;
  return (
    <section style={{ ...band, marginTop: 12 }}>
      <div style={bandHead}>Today&rsquo;s board, in short</div>
      <div>
        {shown.map((r) => (
          <div key={r.key} style={rowStyle}>
            <span style={{ fontSize: 14, fontWeight: 700, color: INK }}>{noteRate(r.rate)}</span>
            <span style={{ fontSize: 12.5, color: MUTED }}>
              {r.lenderCount} {r.lenderCount === 1 ? 'lender' : 'lenders'}
            </span>
            <span style={{ fontSize: 13, color: SLATE, fontWeight: 600 }}>{price(r.bestPrice)}</span>
          </div>
        ))}
        <div style={{ padding: '9px 12px', fontSize: 11.5, color: MUTED, lineHeight: 1.5 }}>
          {more > 0 ? `${more} more ${more === 1 ? 'rate' : 'rates'} on the full board. ` : ''}
          The whole answer — every build, every investor, the ineligible side — is on the
          Pricing&nbsp;Engine.
        </div>
      </div>
    </section>
  );
}

export default function LtScenarios() {
  const [list, setList] = useState(null);
  const [listErr, setListErr] = useState(null);
  const [openId, setOpenId] = useState(null);      // null = the create-from-scratch form
  const [openRow, setOpenRow] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(null);
  const [err, setErr] = useState(null);
  const [res, setRes] = useState(null);
  const [gate, setGate] = useState(null);

  // The party boxes live beside the form because they are not pricing inputs and
  // are never sent to Lender Price — they are what makes a row recognisable.
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [borrower, setBorrower] = useState('');
  const [entity, setEntity] = useState('');

  const form = useScenarioForm();
  const { f, setF, setCalc, zip } = form;

  const load = useCallback(async () => {
    setListErr(null);
    try {
      const r = await ltApi.dscrScenarios();
      setList((r && r.scenarios) || []);
    } catch (e) {
      // A failed load is not an empty list. Saying "you have no scenarios" about
      // a read that never answered is the confident wrong answer.
      setList(null);
      setListErr((e && e.message) || 'Could not load your scenarios.');
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const startBlank = () => {
    setOpenId(null); setOpenRow(null); setRes(null); setNote(null); setErr(null); setGate(null);
    form.reset();
    setName(''); setAddress(''); setBorrower(''); setEntity('');
  };

  const open = (row) => {
    setOpenId(row.id); setOpenRow(row); setRes(null); setNote(null); setErr(null); setGate(null);
    /* ⛔ THE BOXES ARE RESTORED FROM `form`, NOT FROM `scenario`. `toScenario`
       drops what was not typed — that is what keeps the server the one authority
       on the third figure when somebody types an LTV instead of a loan amount —
       so restoring from it would silently move a person out of LTV mode and
       re-price a different deal. This is the single easiest thing to get wrong. */
    setF((prev) => ({ ...prev, ...(row.form || {}) }));
    setCalc((prev) => ({ ...prev, ...(row.calc || {}) }));
    setName(row.name || '');
    setAddress(row.propertyAddress || '');
    setBorrower(row.borrowerName || '');
    setEntity(row.entityName || '');
  };

  const rerun = async () => {
    if (busy) return;
    // The SAME pre-flight the pricing engine runs, ZIP status included — a scenario this
    // form can already see cannot price must never cost a vendor call to find out.
    const problem = searchProblem(f, zip.status);
    if (problem) { setGate(problem); return; }
    setGate(null); setBusy(true); setErr(null); setRes(null);
    try {
      /* ⛔ THE GENERAL ENGINE PRICES THIS, THROUGH ITS OWN ONE DEFINITION — never a
         hand-built `dscrPrice` call (owner-reported 2026-09-04: *"in the scenario
         screen, when you click price, it doesn't actually price. It needs to price
         with all the same general pricing engine … This is a general issue."*).

         WHAT WAS HERE AND WHY IT PAINTED NOTHING. This asked `dscrPrice(scenario, {})`
         — deliberately without `full: true`, reasoning that a short ledger did not
         need every price build. But that flag is not a verbosity setting: it selects
         the DOOR. Without it the route takes its SUMMARY branch (`routes/dscr-pricer.js`,
         "the SUMMARY door (a saved scenario re-run) stays Lender Price only"), which
         answers through `trimPrograms` — a shape carrying NO `options`. `buildRateStack`
         reads exactly that key, so the stack came back EMPTY and every consumer of it
         returned null in silence: the ledger, the headline, the movement line, and the
         save, which then stored `savedBoard: null`. The press made a real vendor call,
         waited, and drew nothing at all — no board, no error. `LtScenarioSave`'s own
         comment had predicted this shape of failure: "a wrong field reads as an empty
         board rather than as an error."

         AND THE SUMMARY DOOR IS NOT THIS COMPANY'S ENGINE, which is the owner's real
         point: it is Lender Price alone — no LoanNEX, no margin holdback, no investor
         routing, no house-rules overlay, no near-tier, no ineligibility. An investor
         routed to LoanNEX could never appear on a re-run, so the movement line compared
         today's half-board against a full one saved earlier.

         Calling `GENERAL_ENGINE.price` fixes both at once and cannot drift from the
         pricing engine again, because it IS the pricing engine's own call. */
      const r = await GENERAL_ENGINE.price(toScenario(f), {});
      setRes(r);
    } catch (e) {
      setErr((e && e.message) || 'Could not price that scenario.');
    } finally {
      setBusy(false);
    }
  };

  const stack = res ? buildRateStack(res.programs) : null;
  const nowHeadline = boardHeadline(stack);
  const savedHeadline = openRow ? openRow.savedBoard : null;
  const moved = movementLine(savedHeadline, nowHeadline);

  const saveNew = async () => {
    if (busy) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      const r = await ltApi.dscrSaveScenario({
        name, propertyAddress: address, borrowerName: borrower, entityName: entity,
        form: f, scenario: toScenario(f), calc: form.calc, savedBoard: nowHeadline,
      });
      const saved = r && r.scenario;
      setNote(`Saved as ${saved && saved.name ? saved.name : 'a new scenario'}.`);
      if (saved) { setOpenId(saved.id); setOpenRow(saved); }
      await load();
    } catch (e) {
      setErr((e && e.message) || 'Could not save that scenario.');
    } finally { setBusy(false); }
  };

  const saveChanges = async () => {
    if (busy || !openId) return;
    setBusy(true); setErr(null); setNote(null);
    try {
      /* ONLY WHAT THIS SCREEN IS SHOWING. A headline is sent only when a re-run
         actually produced one: sending null would blank the saved one and take
         the comparison with it, which is not what "save my changes" means. */
      const patch = {
        name, propertyAddress: address, borrowerName: borrower, entityName: entity,
        form: f, scenario: toScenario(f), calc: form.calc,
      };
      if (nowHeadline) patch.savedBoard = nowHeadline;
      const r = await ltApi.dscrUpdateScenario(openId, patch);
      const saved = r && r.scenario;
      setNote(`Saved${saved && saved.name ? ` as ${saved.name}` : ''}.`);
      if (saved) setOpenRow(saved);
      await load();
    } catch (e) {
      setErr((e && e.message) || 'Could not save that change.');
    } finally { setBusy(false); }
  };

  const remove = async (row) => {
    const yes = await askConfirm(
      `Remove “${row.name}”? The scenario goes off your list — the loans and term sheets it was ever used to price are untouched.`,
      { title: 'Remove this scenario', confirmLabel: 'Remove it' },
    );
    if (!yes) return;
    setBusy(true); setErr(null);
    try {
      await ltApi.dscrDeleteScenario(row.id);
      if (openId === row.id) startBlank();
      await load();
    } catch (e) {
      setErr((e && e.message) || 'Could not remove that scenario.');
    } finally { setBusy(false); }
  };

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div style={card}>
        <div style={eyebrow}>Saved scenarios</div>
        <div style={{ ...sub, marginTop: 6 }}>
          Your own saved pricing <strong>questions</strong> — what you typed, so tomorrow is one
          press instead of twenty-one boxes. A scenario is not a saved price: rates move, so
          re-running one gives you <strong>today&rsquo;s</strong> answer and tells you what has
          changed since. Only you can see these, and they stay until you remove them.
        </div>
      </div>

      {/* ── the list ───────────────────────────────────────────────────────── */}
      <section style={band}>
        <div style={bandHead}>Your scenarios</div>
        {listErr && (
          <div style={{ padding: '10px 12px', fontSize: 12.5, color: DANGER }}>
            {listErr}{' '}
            <button type="button" className="btn ghost" onClick={load}>Try again</button>
          </div>
        )}
        {!listErr && list === null && (
          <div style={{ padding: '10px 12px', fontSize: 12.5, color: MUTED }}>Loading…</div>
        )}
        {!listErr && list && list.length === 0 && (
          <div style={{ padding: '10px 12px', fontSize: 12.5, color: MUTED, lineHeight: 1.55 }}>
            Nothing saved yet. Price a scenario on the Pricing Engine and press
            {' '}<strong>Save this scenario</strong>, or build one here from scratch.
          </div>
        )}
        {!listErr && list && list.map((row) => (
          <div key={row.id} style={{ ...rowStyle, background: openId === row.id ? WASH : undefined }}>
            <div style={{ minWidth: 0, flex: '1 1 260px' }}>
              <div style={{ fontSize: 13.5, fontWeight: 700, color: INK }}>{plain(row.name)}</div>
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 2 }}>
                {row.propertyAddress ? <>{row.propertyAddress} · </> : null}
                {row.borrowerName || row.entityName ? <>{plain(row.borrowerName || row.entityName)} · </> : null}
                saved {ago(row.createdAt) || `on ${dayOf(row.createdAt)}`}
              </div>
              <div style={{ marginTop: 2 }}><SavedHeadline b={row.savedBoard} /></div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => open(row)}>
                {openId === row.id ? 'Open' : 'Open'}
              </button>
              <button type="button" className="btn ghost" disabled={busy} onClick={() => remove(row)}>
                Remove
              </button>
            </div>
          </div>
        ))}
        <div style={{ padding: '10px 12px' }}>
          <button type="button" className="btn ghost" disabled={busy} onClick={startBlank}>
            Build a new scenario from scratch
          </button>
        </div>
      </section>

      {/* ── the working area ───────────────────────────────────────────────── */}
      <div style={card}>
        <div style={eyebrow}>{openId ? 'This scenario' : 'A new scenario'}</div>
        <div style={{ ...sub, marginTop: 6 }}>
          These are the <strong>same fields</strong> the Pricing Engine prices from — one form, so
          a scenario cannot mean one thing here and another there.
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 12 }}>
          {[
            ['scn-name', 'Scenario name', name, setName],
            ['scn-address', 'Property address', address, setAddress],
            ['scn-borrower', 'Borrower name', borrower, setBorrower],
            ['scn-entity', 'Entity name', entity, setEntity],
          ].map(([id, lbl, val, set]) => (
            <div key={id} style={{ flex: '1 1 220px', minWidth: 180 }}>
              <label htmlFor={id} style={fieldLabel}>{lbl}</label>
              <input id={id} className="input" style={{ ...control, height: 38 }} value={val}
                onChange={(e) => set(e.target.value)} />
            </div>
          ))}
        </div>

        <ScenarioFields form={form} />

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn primary" disabled={busy} onClick={rerun}>
            {busy ? 'Pricing…' : 'Price it today'}
          </button>
          {openId
            ? <button type="button" className="btn ghost" disabled={busy} onClick={saveChanges}>Save changes</button>
            : <button type="button" className="btn ghost" disabled={busy} onClick={saveNew}>Save this scenario</button>}
          {openId && (
            <button type="button" className="btn ghost" disabled={busy} onClick={saveNew}>
              Save as a new scenario
            </button>
          )}
        </div>

        {gate && <div style={{ marginTop: 8, fontSize: 13, color: DANGER }}>{gate}</div>}
        {err && <div style={{ marginTop: 8, fontSize: 13, color: DANGER }}>{err}</div>}
        {note && <div style={{ marginTop: 8, fontSize: 13, color: GOLD_TEXT }}>{note}</div>}

        {/* ── what moved (D4) ─────────────────────────────────────────────── */}
        {moved && (
          <div style={{
            marginTop: 12, padding: '10px 12px', borderRadius: 8,
            border: `1px solid ${moved.tone === 'none' ? LINE : GOLD}55`,
            background: moved.tone === 'none' ? WASH : '#FCF9F2',
            fontSize: 12.5, lineHeight: 1.55,
            color: moved.tone === 'worse' ? CAUTION : moved.tone === 'none' ? MUTED : SLATE,
          }}>
            {moved.text}
          </div>
        )}

        <Ledger stack={stack} />
      </div>
    </div>
  );
}
