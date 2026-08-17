#!/usr/bin/env node
'use strict';
/**
 * CASH-OUT AMOUNT — TRANSMITTED as numeric `criteria.cashoutAmount` (pure, offline).
 *
 * THIS FILE ONCE ASSERTED THE OPPOSITE, and the reversal is the point. A 2026-08-16 capture showed a
 * cash-out search whose JSON carried neither the amount nor any key for it — only the frontend BUG
 * `dynamicPropertiesMap.undefined = { value: null }`. Fail-closed was right then: `undefined` is not
 * a field name and never could be one, so there was nothing to send it under that would not have been
 * a guess.
 *
 * What changed is the evidence, not the rule. `criteria.cashoutAmount` is a captured key on the
 * criteria object, recorded twice in that same audit (§30.4 lists it in the criteria table as a
 * confirmed direct field) and named explicitly in its closing instruction. §32.2 reports a later run
 * in which it did not appear; that is evidence about one capture — most consistent with the input not
 * having been committed — not evidence that the key is wrong. The asymmetry settles it: omitting a
 * real amount prices a cash-out as though no cash were taken, while sending a captured criteria key
 * the vendor may ignore costs nothing.
 *
 * So the backend must now:
 *   • transmit `criteria.cashoutAmount` as a JSON NUMBER when supplied;
 *   • still never replicate the `undefined` bug, and never invent any other key;
 *   • still CLEAR a stale amount off the live foundation, then re-apply the caller's (the standing
 *     scenario-owned footgun: clear-then-forget silently loses a supplied value);
 *   • carry no LP_CASHOUT_AMOUNT_FIELD escape hatch — it addressed a field that never existed and was
 *     a guess waiting to be configured.
 *
 * PROVEN TO FAIL: drop `c.cashoutAmount = cashoutAmt` from buildSearch and TRANSMIT, WIRE-1 and EFF
 * go red; move it before clearScenarioOwnedFields and FAILCLOSED-2 goes red; restore the env hatch
 * and ESCAPE-* go red; leave the route's old note wording and NOTE-* go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const route = require('../src/longterm/routes/dscr-pricer');
const { effectiveOf, unsupportedFields, cashoutNote } = route._internals;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
// A distinctive cash-out value that is NOT a substring of any other number in the payload, so a
// substring search for it in the serialized body is a true "is it transmitted?" test.
const CASH = 43217;
// fico is REQUIRED (§37.11): Lender Price answers HTTP 500 with no explanation when the field is
// null OR absent, measured live both ways. It is on the fixture so these suites test their own
// subject rather than re-testing that refusal.
const S = { purpose: 'Cash out', value: 8.2e5, loan: 6.1e5, dscr: 1.3, state: 'NJ', countyFps: '34039', fico: 760 };

console.log('cash-out amount — transmitted as criteria.cashoutAmount');

// ---- supplied cash-out → TRANSMITTED as numeric criteria.cashoutAmount -----
// These three used to assert the OPPOSITE, and the reversal is deliberate. The fail-closed behaviour
// was correct while the only evidence was the frontend bug `dynamicPropertiesMap.undefined`, which is
// not a field name and never could be one. `criteria.cashoutAmount` is a captured key on the criteria
// object, recorded twice in the 2026-08-16 audit and named explicitly in its instruction. Dropping a
// real amount prices a cash-out as though no cash were taken; sending a captured key the vendor may
// ignore costs nothing.
const m = sm.buildSearch({ ...S, cashoutAmount: CASH });
const wire = JSON.stringify(m);
ok(m.criteria.cashoutAmount === CASH, 'TRANSMIT-1 criteria.cashoutAmount carries the amount');
ok(typeof m.criteria.cashoutAmount === 'number',
  'TRANSMIT-2 …as a JSON NUMBER, not a string (the capture shows a bare number)');
ok(JSON.parse(wire).criteria.cashoutAmount === CASH,
  'WIRE-1 …and it survives serialization, so it genuinely reaches the wire');
ok(wire.includes('"undefined"') === false, 'WIRE-3 the frontend "undefined" dynamic-property bug is NEVER replicated');
ok(m[sm.CASHOUT_INTERNAL] === CASH, 'INTERNAL-1 the amount is RETAINED internally (Symbol-keyed)');
ok(m.criteria.loanPurpose === 'CashoutRefinance', 'PURPOSE the cash-out purpose still maps to CashoutRefinance');

// ---- omitted cash-out → nothing retained, nothing transmitted --------------
const m0 = sm.buildSearch({ ...S });
ok(m0[sm.CASHOUT_INTERNAL] === undefined && m0.criteria.cashoutAmount === undefined,
  'OMIT no cash-out supplied → nothing retained, nothing transmitted');

// ---- a live foundation's stale criteria.cashoutAmount is CLEARED (§31.6) ---
const base = JSON.parse(JSON.stringify(sm.BASE));
base.criteria = base.criteria || {};
base.criteria.cashoutAmount = 99999; // a prior session's value on the foundation
const cleared = sm.buildSearch({ ...S }, { base }); // omit cash-out
ok(cleared.criteria.cashoutAmount === undefined,
  'FAILCLOSED-1 a stale foundation criteria.cashoutAmount is cleared (SCENARIO_OWNED DELETE), never leaked');
// …and the CALLER'S value is re-applied after that clear. This is the standing footgun: a
// scenario-owned field is cleared to neutral before the overlay, so a supplied value that is not
// re-applied afterwards is silently lost — the stale 55555 must be gone AND the real 50000 present.
const cleared2 = sm.buildSearch({ ...S, cashoutAmount: CASH }, { base });
ok(cleared2.criteria.cashoutAmount === CASH,
  'FAILCLOSED-2 a supplied cash-out over a STALE base yields the caller\'s amount, not the stale one');

// ---- the operator escape hatch is GONE, and must not come back -------------
// LP_CASHOUT_AMOUNT_FIELD addressed a dynamic property that never existed; it was the shape of a
// guess, waiting for someone to set it to whatever looked plausible. With a real criteria field
// captured there is nothing for it to do, and leaving it would be a second, un-audited way for an
// amount to reach the vendor under a name nobody confirmed.
{
  const prev = process.env.LP_CASHOUT_AMOUNT_FIELD;
  process.env.LP_CASHOUT_AMOUNT_FIELD = 'SOME_GUESSED_FIELD';
  try {
    const me = sm.buildSearch({ ...S, cashoutAmount: CASH });
    ok(me.dynamicPropertiesMap.SOME_GUESSED_FIELD === undefined,
      'ESCAPE-1 setting the retired env var transmits NO dynamic property');
    ok(me.criteria.cashoutAmount === CASH,
      'ESCAPE-2 …and the amount still travels by its one captured path');
  } finally {
    if (prev === undefined) delete process.env.LP_CASHOUT_AMOUNT_FIELD; else process.env.LP_CASHOUT_AMOUNT_FIELD = prev;
  }
  const src = require('fs').readFileSync(require.resolve('../src/longterm/lenderprice/search-model.js'), 'utf8')
    .replace(/^\s*\/\/.*$/gm, '');
  ok(!/LP_CASHOUT_AMOUNT_FIELD/.test(src),
    'ESCAPE-3 the builder no longer reads the retired env var at all');
}

// ---- effectiveScenario surfaces the TRANSMITTED value (and the internal copy) --
const eff = effectiveOf(m);
ok(eff.cashoutAmount === CASH, 'EFF-1 effectiveScenario reports the TRANSMITTED cash-out amount');
ok(eff.cashoutAmountInternal === CASH,
  'EFF-2 …and the internal copy still agrees with it (they can never tell two different stories)');

// ---- still a supported, validated route field ------------------------------
ok(unsupportedFields({ cashoutAmount: CASH, purpose: 'Cash out' }).length === 0, 'ROUTE-1 cashoutAmount is still a supported route field');
const neg = sm.validateScenario({ ...S, cashoutAmount: -5 });
ok(neg.ok === false && neg.status === 422, 'ROUTE-2 a negative cash-out amount is still rejected 422 (validation unchanged)');
const good = sm.validateScenario({ ...S, cashoutAmount: CASH });
ok(good.ok === true, 'ROUTE-3 a valid cash-out amount passes validation');

// ---- the route's cashoutNote transparency annotation tells the truth ----------
// (It is a money-field response annotation — it must never describe a handling other than the one
// that actually happened, in either direction, and must agree with what was built.)
ok(cashoutNote({ purpose: 'Cash out' }) === null, 'NOTE-0 no cash-out supplied → cashoutNote is null');
{
  // The note must describe what ACTUALLY happened. It reported "retained, not transmitted" while the
  // builder withheld the amount; now that the amount is sent, the same wording would be a response
  // that lies about its own request — the one thing a transparency field must never do.
  const n = cashoutNote({ cashoutAmount: CASH });
  ok(n && n.transmitted === true && n.field === 'criteria.cashoutAmount' && n.value === CASH,
    'NOTE-1 cashoutNote reports transmitted:true on the captured criteria path');
  ok(!/not transmitted/i.test(n.note),
    'NOTE-2 …and the prose no longer claims the amount was withheld');
  ok(!/LP_CASHOUT_AMOUNT_FIELD/.test(n.note),
    'NOTE-3 …nor points at the retired env var as a way to turn transmission on');
  // the note and the built request must agree — a caller reads one and prices on the other
  const built = sm.buildSearch({ ...S, cashoutAmount: CASH });
  ok(built.criteria.cashoutAmount === n.value,
    'NOTE-4 the note\'s amount is the amount actually built into the request');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
