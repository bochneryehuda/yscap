/* =====================================================================
   test-tpo-pricing-layer-pure.js — the TPO (wholesale) pricing layer.

   Proves the NEW layer behaves exactly as designed, WITHOUT a DB:

     A. mergeSettings (PURE) — retail defaults fall through; a TPO channel value
        overrides that ONE field; a firm value overrides the channel; the broker
        fee comes only from the firm row and only when positive; markup_tiers is a
        whole-object override; retail is never mutated.
     B. RETAIL IS BYTE-IDENTICAL — threading opts through pricing.js changes
        nothing: quoteAll(no opts) deep-equals quoteAll({settings: current()}), and
        a retail quote carries no brokerFee/brokerFeePct keys.
     C. A TPO-channel ORIGINATION cut lowers origination by exactly that, and moves
        no loan amount / rate.
     D. A TPO-channel MARKUP raise moves the note rate by exactly that (no-reserve
        scenario, so it cannot feed back into sizing), and moves no origination.
     E. A BROKER FEE adds exactly totalLoan × pct to origination-side closing costs,
        cash-to-close and the liquidity to show — and nothing else (loan, rate,
        origination unchanged).
     F. effectiveSettingsFor gates on is_tpo (retail file → retail settings, no
        broker fee).

   The frozen engines' byte-identical-when-unset property is proven separately over
   hundreds of thousands of scenarios; this pins the FEATURE end-to-end through the
   real pricing.js.
   ===================================================================== */
'use strict';
const assert = require('assert');
const pricing = require('../src/lib/pricing');
const settings = require('../src/lib/pricing-settings');
const tpo = require('../src/lib/tpo-pricing');
const minOrig = require('../src/lib/min-origination');

if (!pricing.enginesReady || !pricing.enginesReady()) {
  console.error('engines not loadable:', pricing.loadErr && pricing.loadErr());
  process.exit(1);
}

// ---- stub the retail company defaults (no DB) ------------------------------
const RETAIL = Object.freeze(Object.assign({}, settings.SYSTEM_DEFAULTS));  // markupTiers: null
let CURRENT = Object.assign({}, RETAIL);
settings.current = () => CURRENT;   // pricing.js AND tpo-pricing.js call this dynamically

const EPS = 1e-6;
const near = (a, b) => Math.abs(a - b) < EPS;
let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

// ── A. mergeSettings (pure) ─────────────────────────────────────────────────
{
  // retail-only: channel {} + firm null → every field is retail, no broker fee.
  const r0 = tpo.mergeSettings(RETAIL, {}, null);
  ok(r0.markupStdPct === RETAIL.markupStdPct && r0.origStdPct === RETAIL.origStdPct, 'merge: retail-only keeps retail markup/orig');
  ok(r0.brokerFeePct === null, 'merge: retail-only has no broker fee');

  // a channel value overrides just that one field.
  const rc = tpo.mergeSettings(RETAIL, { orig_gold_pct: 0.75 }, null);
  ok(rc.origGoldPct === 0.75, 'merge: channel orig_gold_pct wins');
  ok(rc.origStdPct === RETAIL.origStdPct && rc.markupGoldPct === RETAIL.markupGoldPct, 'merge: other fields still retail');

  // a firm value overrides the channel value.
  const rf = tpo.mergeSettings(RETAIL, { orig_gold_pct: 0.75 }, { orig_gold_pct: 0.25 });
  ok(rf.origGoldPct === 0.25, 'merge: firm override beats channel');

  // NULL / '' fall through to the layer above.
  const rn = tpo.mergeSettings(RETAIL, { orig_gold_pct: null, orig_std_pct: '' }, null);
  ok(rn.origGoldPct === RETAIL.origGoldPct && rn.origStdPct === RETAIL.origStdPct, 'merge: null/blank fall through to retail');

  // broker fee: only from the firm row, only when a positive number.
  ok(tpo.mergeSettings(RETAIL, {}, { broker_orig_pct: 1.0 }).brokerFeePct === 1.0, 'merge: firm broker fee set');
  ok(tpo.mergeSettings(RETAIL, {}, { broker_orig_pct: 0 }).brokerFeePct === null, 'merge: broker fee 0 → null (inert)');
  ok(tpo.mergeSettings(RETAIL, {}, { broker_orig_pct: null }).brokerFeePct === null, 'merge: broker fee null → null');
  ok(tpo.mergeSettings(RETAIL, { broker_orig_pct: 5 }, null).brokerFeePct === null, 'merge: a broker fee on the CHANNEL row is ignored (firm-only)');

  // markup_tiers is a whole-object override, cleaned to fractions-of-percent map.
  const rt = tpo.mergeSettings(RETAIL, { markup_tiers: { gold: { 1: 0.5 } } }, null);
  ok(rt.markupTiers && rt.markupTiers.gold && Number(rt.markupTiers.gold['1']) === 0.5, 'merge: channel markup_tiers applied');

  // DEFENSE IN DEPTH: a hostile / hand-edited DB row can never price a loan.
  ok(tpo.mergeSettings(RETAIL, {}, { broker_orig_pct: 999 }).brokerFeePct === tpo.MAX_BROKER_FEE_PCT, 'merge: an absurd broker fee is clamped to the max');
  ok(tpo.mergeSettings(RETAIL, { orig_gold_pct: 999 }, null).origGoldPct === tpo.MAX_MARKUP_ORIG_PCT, 'merge: an absurd origination is clamped to 100');
  ok(tpo.mergeSettings(RETAIL, { markup_std_pct: -5 }, null).markupStdPct === 0, 'merge: a negative markup is clamped to 0');

  // retail object is never mutated.
  ok(RETAIL.origGoldPct === settings.SYSTEM_DEFAULTS.origGoldPct, 'merge: retail defaults not mutated');
}

// ── a clean purchase with NO interest reserve (a markup change can't feed back
//    into sizing → the note-rate/origination deltas are exact) ───────────────
function app(state, exp) {
  return {
    property_address: { state }, fico: 740,
    requested_exp_flips: exp.flips || 0, requested_exp_holds: exp.holds || 0, requested_exp_ground: exp.ground || 0,
    property_type: 'Single Family', units: 1,
    loan_type: 'Purchase', program: 'Fix and Flip',
    purchase_price: 300000, as_is_value: 300000, arv: 450000, rehab_budget: 90000, term: 12,
  };
}
function quote(prog, state, exp, opts) {
  return pricing.quoteProgram(prog, pricing.buildInputs(app(state, exp), exp, {}), opts);
}
// find an eligible, real-note-rate STANDARD scenario
const STATES = ['NJ', 'TX', 'FL', 'PA'];
const LADDER = [{ flips: 2 }, { flips: 1 }, { flips: 5, holds: 2 }, { flips: 0 }];
let scen = null;
for (const state of STATES) {
  for (const exp of LADDER) {
    let q; try { q = quote('standard', state, exp); } catch (_) { continue; }
    if (q && q.eligible && q.noteRate != null && q.sizing && q.sizing.totalLoan > 0) { scen = { state, exp }; break; }
  }
  if (scen) break;
}
ok(scen, 'found an eligible Standard scenario for the integration checks');

// ── B. retail is byte-identical ─────────────────────────────────────────────
{
  const a = app(scen.state, scen.exp);
  const noOpts = pricing.quoteAll(a, scen.exp, {});
  const withCurrent = pricing.quoteAll(a, scen.exp, {}, { settings: settings.current() });
  assert.deepStrictEqual(withCurrent, noOpts);
  ok(true, 'threading is inert: quoteAll(no opts) === quoteAll({settings: current()})');
  ok(noOpts.standard.brokerFee === undefined && noOpts.standard.closingCosts.brokerFee === undefined,
    'retail quote carries NO brokerFee keys');
}

const base = quote('standard', scen.state, scen.exp);   // retail baseline

// ── C. a TPO-channel ORIGINATION cut ────────────────────────────────────────
{
  const cd = Object.assign({}, RETAIL, { origStdPct: 0.5 });   // 1.25% → 0.5%
  const q = quote('standard', scen.state, scen.exp, { settings: cd });
  /* THE CHANNEL PERCENTAGE IS PINNED ON THE FIGURES THAT CARRY IT, NOT ON THE DOLLARS CHARGED
     (re-pointed 2026-09-04, NOT loosened). The $2,500 program minimum (min-origination.js) is a
     FLOOR on our own origination and applies on a wholesale file exactly as it does on a retail
     one — the owner's D2 exemption is the BROKER's own fee, which is a separate key and is proven
     separately in section E. So on this scenario ($315,000) a channel cut to 0.5% computes $1,575
     and is floored to $2,500, and the old assertion `origination === totalLoan × 0.5%` could no
     longer see its own subject.

     Asserting the dollars through `min-origination` itself would be WEAKER than the original, not
     stronger: below the crossover EVERY sub-minimum percentage charges $2,500, so 0.5% and 0.75%
     would be indistinguishable and a channel cut that never reached the engine at all would still
     pass. The figures that still tell them apart are the ones the rule REPORTS — `pct` and
     `pctAmount` — so the channel percentage is pinned there, and the dollars are pinned against
     the one rule beside it. Together these are strictly stronger than the line they replace. */
  const cut = q.closingCosts.originationMinimum;
  ok(cut && near(cut.pct, 0.005), 'channel orig cut: the CHANNEL percentage (0.5%) is what reached the engine');
  ok(cut && near(cut.pctAmount, Math.round(q.sizing.totalLoan * 0.005 * 100) / 100),
    'channel orig cut: the percentage figure is totalLoan × 0.5%');
  ok(near(q.origination, minOrig.originationFor({ totalLoan: q.sizing.totalLoan, origPct: 0.005, minFee: RETAIL.minOrigFee }).amount),
    'channel orig cut: the fee charged is what the ONE minimum-origination rule says');
  ok(q.origination < base.origination, 'channel orig cut: origination is lower than retail');
  ok(q.sizing.totalLoan === base.sizing.totalLoan && near(q.noteRate, base.noteRate), 'channel orig cut: loan amount + note rate unchanged');
}

// ── D. a TPO-channel MARKUP raise ───────────────────────────────────────────
{
  const cd = Object.assign({}, RETAIL, { markupStdPct: 1.0 });   // 0.5% → 1.0%
  const q = quote('standard', scen.state, scen.exp, { settings: cd });
  ok(near(q.noteRate - base.noteRate, 0.005), `channel markup raise: note rate up by exactly 0.5% (Δ=${(q.noteRate - base.noteRate).toFixed(6)})`);
  ok(q.sizing.totalLoan === base.sizing.totalLoan && near(q.origination, base.origination), 'channel markup raise: loan + origination unchanged');
}

// ── E. a BROKER FEE ─────────────────────────────────────────────────────────
{
  const cd = Object.assign({}, RETAIL, { brokerFeePct: 1.0 });   // 1% broker fee
  const q = quote('standard', scen.state, scen.exp, { settings: cd });
  const expected = Math.round(base.sizing.totalLoan * 0.01 * 100) / 100;
  ok(near(q.brokerFee, expected) && near(q.closingCosts.brokerFee, expected), `broker fee = totalLoan × 1% ($${expected})`);
  ok(near(q.closingCosts.brokerFeePct, 1.0), 'broker fee percent reported');
  ok(near(q.closingCosts.dueAtClosing, Math.round((base.closingCosts.dueAtClosing + expected) * 100) / 100), 'broker fee folded into due-at-closing');
  ok(near(q.cashToClose, Math.round((base.cashToClose + expected) * 100) / 100), 'broker fee added to cash-to-close');
  ok(near(q.liquidityRequired, Math.round((base.liquidityRequired + expected) * 100) / 100), 'broker fee added to liquidity to show');
  ok(near(q.origination, base.origination) && near(q.noteRate, base.noteRate) && q.sizing.totalLoan === base.sizing.totalLoan,
    'broker fee moves NO loan amount / rate / origination');
  // a zero broker fee is inert (no key, byte-identical to retail)
  const q0 = quote('standard', scen.state, scen.exp, { settings: Object.assign({}, RETAIL, { brokerFeePct: 0 }) });
  ok(q0.brokerFee === undefined && near(q0.cashToClose, base.cashToClose), 'broker fee 0 is inert');
}

// ── F. effectiveSettingsFor gates on is_tpo ─────────────────────────────────
{
  ok(tpo.effectiveSettingsFor(null) === settings.current(), 'effectiveSettingsFor(null) → retail settings object');
  ok(tpo.effectiveSettingsFor({ is_tpo: false }) === settings.current(), 'a retail file → retail settings object');
  const t = tpo.effectiveSettingsFor({ is_tpo: true, tpo_firm_id: 'no-such-firm' });
  ok(t.markupStdPct === RETAIL.markupStdPct && t.brokerFeePct === null, 'a TPO file with no config → retail values + no broker fee');
}

console.log(`\nAll TPO pricing-layer checks passed (${passed} assertions).`);
