#!/usr/bin/env node
'use strict';
/**
 * §31.8 — "NO MORTGAGE HISTORY" AND A MORTGAGE LATE CANNOT BOTH BE TRUE (pure, offline).
 *
 * A borrower who has never held a mortgage cannot have been late on one, so a scenario asserting
 * both describes no real borrower. Upstream this does NOT error: each field is applied
 * independently and the engine prices on whichever its rules happen to read — the silent-mis-pricing
 * class this connector exists to refuse, and the worst shape of it, because the two readings ("no
 * history, nothing derogatory" and "a 90-day mortgage late") sit at opposite ends of the credit grid.
 * It is also the ORDINARY way the contradiction arises rather than an exotic one: `noMortgageHistory`
 * is a sticky checkbox, so leaving it ticked while typing in the lates that were just pulled is one
 * click.
 *
 * THE HALF OF THIS SUITE THAT MATTERS MOST IS THE OVER-REFUSAL HALF. A validation rule that is too
 * eager is not "safely strict" — it refuses real business, and it is invisible until someone cannot
 * price a deal. So the scope is exactly what the audit established (the eight `MORT*LATESLAST*`
 * buckets and their documented parent toggle, which are the same fact stated twice by the same UI)
 * and the NOT-INCLUDED cases are asserted to still price: a count of 0, the flag absent or false,
 * lates with no flag, and every derogatory MORTGAGE event (foreclosure / short sale / deed-in-lieu /
 * mortgage charge-off / forbearance). Those last five each imply a mortgage existed at some point,
 * so extending the rule to them is tempting — and would be a GUESS about what the vendor's flag
 * means ("no CURRENT mortgage" and "never held one" are different claims). That question is recorded
 * for the vendor, not answered here.
 *
 * PROVEN TO FAIL: drop the `mortgageHistoryConflict` call from validateInputs and every CONFLICT
 * assertion goes red; widen the rule to the derogatory events and the OPEN-* assertions go red;
 * treat "0" as a conflict and ZERO-1 goes red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const route = require('../src/longterm/routes/dscr-pricer');
const { mortgageHistoryConflict } = sm._internals;
const { unsupportedFields } = route._internals;

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } };
// A complete, ordinary, priceable scenario — so anything that fails below fails for the ONE reason
// under test and never because the fixture was incomplete.
const S = { purpose: 'Purchase', value: 500000, loan: 400000, dscr: 1.25, fico: 760, zip: '11211' };
const v = (over) => sm.validateScenario({ ...S, ...over });

console.log('§31.8 no-mortgage-history vs mortgage lates — a self-contradicting scenario is refused');

// ---- the predicate itself, over every bucket -------------------------------
{
  for (const window of ['last12', 'months13To24']) {
    for (const sev of ['30', '60', '90', '120']) {
      const c = mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { [window]: { [sev]: '1' } } });
      ok(c && c.conflicts.length === 1 && c.conflicts[0].includes(`mortgageLates.${window}.${sev}`),
        `BUCKET-${window}.${sev} a late in this bucket contradicts "no mortgage history"`);
    }
  }
  ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { last12: { 30: 2 } } }) != null,
    'NUM-1 a NUMERIC count conflicts exactly as the string form does (applyRegistry String()-normalises, so this must too)');
  ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { last12: { 120: '4+' } } }) != null,
    'NUM-2 the top "4+" bucket conflicts');
  const both = mortgageHistoryConflict({ noMortgageHistory: true, lateInLast12Months: true, mortgageLates: { last12: { 30: '1', 60: '2' } } });
  ok(both && both.conflicts.length === 3,
    'LIST-1 every contradicting fact is listed, not just the first — a caller fixing one should not be sent round again for the next');
  ok(both.field === 'noMortgageHistory' && /90|60|30/.test(both.message) && /noMortgageHistory/.test(both.message),
    'LIST-2 …and the message names BOTH sides, so it is actionable without reading the code');
}

// ---- the PARENT toggle is the same fact, so it counts -----------------------
{
  const c = mortgageHistoryConflict({ noMortgageHistory: true, lateInLast12Months: true });
  ok(c && c.conflicts.length === 1 && /lateInLast12Months/.test(c.conflicts[0]),
    'PARENT-1 the parent "late in the last 12 months" toggle contradicts it on its own (the live UI sends it alongside the buckets)');
}

// ---- NOT a conflict — the over-refusal half --------------------------------
{
  ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: { last12: { 30: '0', 60: 0 } } }) === null,
    'ZERO-1 a count of ZERO is consistent with no history and must still price (a form pre-filled with zeros sends exactly this)');
  ok(mortgageHistoryConflict({ mortgageLates: { last12: { 90: '3' } } }) === null,
    'OPEN-1 lates with the flag ABSENT are an ordinary impaired-credit scenario');
  ok(mortgageHistoryConflict({ noMortgageHistory: false, mortgageLates: { last12: { 90: '3' } } }) === null,
    'OPEN-2 …and with the flag explicitly FALSE');
  ok(mortgageHistoryConflict({ noMortgageHistory: true }) === null,
    'OPEN-3 the flag alone is the ordinary first-time-investor case');
  ok(mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: null }) === null &&
     mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: 'nope' }) === null &&
     mortgageHistoryConflict({ noMortgageHistory: true, mortgageLates: [] }) === null,
    'OPEN-4 a malformed mortgageLates raises NO contradiction here — its own shape refusal owns that, so one bad value is never reported as two problems');
  ok(mortgageHistoryConflict({}) === null && mortgageHistoryConflict() === null,
    'OPEN-5 an empty scenario is not a contradiction (and does not throw)');
}

// ---- the DELIBERATE non-inclusions must still PRICE ------------------------
// Each of these implies a mortgage existed at some point, so folding them in is tempting — and is a
// business judgement about what the vendor's flag MEANS, which only the vendor can settle. Refusing
// them on a guess would block real deals. These assertions are what make that decision durable.
{
  for (const [field, value] of [['foreclosure', 'Foreclosure_24_36'], ['shortSale', 'ShortSale_24_36'],
    ['deedInLieu', 'DeedinLieu_24_36'], ['chargeOff', 'ChargeOffs_24_36'], ['forbearance', 'Forbearances_24_36']]) {
    ok(mortgageHistoryConflict({ noMortgageHistory: true, [field]: value }) === null,
      `OPEN-EVENT ${field} alongside "no mortgage history" is NOT refused here — widening to it is a vendor question, not an inference`);
  }
}

// ---- through the real 422 path ---------------------------------------------
{
  const r = v({ noMortgageHistory: true, mortgageLates: { last12: { 90: '2' } } });
  ok(r.ok === false && r.status === 422 && r.error === 'contradictory_mortgage_history',
    'ROUTE-1 validateScenario refuses it 422 with a machine-readable code');
  ok(r.field === 'noMortgageHistory', 'ROUTE-2 …naming a field the caller can act on');
  ok(/cannot have been late/i.test(r.message), 'ROUTE-3 …and saying WHY in a sentence a human can act on');
  ok(v({ noMortgageHistory: true, lateInLast12Months: true }).error === 'contradictory_mortgage_history',
    'ROUTE-4 the parent toggle is refused through the same path');
  // The whole point: the same scenario WITHOUT the contradiction prices normally.
  ok(v({ mortgageLates: { last12: { 90: '2' } } }).ok === true,
    'ROUTE-5 the identical scenario without the flag prices — the rule refuses the contradiction, not the lates');
  ok(v({ noMortgageHistory: true }).ok === true, 'ROUTE-6 …and the flag alone prices');
  ok(v({ noMortgageHistory: true, mortgageLates: { last12: { 30: '0' } } }).ok === true,
    'ROUTE-7 …as does a zero count beside it');
}

// ---- ORDER — a wrong TYPE is reported as a wrong type, not as a contradiction --
{
  const t = v({ noMortgageHistory: 'true', mortgageLates: { last12: { 90: '2' } } });
  ok(t.ok === false && t.error === 'non_boolean_value',
    'ORDER-1 a string "true" flag is reported as the type error it is (the contradiction check reads a real boolean only)');
  const j = v({ noMortgageHistory: true, mortgageLates: { last12: { 90: '7' } } });
  ok(j.ok === false && j.error === 'invalid_field_value',
    'ORDER-2 an UNRECOGNISED late count keeps its own refusal — one wrong value is never reported as two different problems');
  // A MALFORMED payload is a client bug and is reported as one, even when the values it does carry
  // also contradict each other. Without this the contradiction masks the type error and the caller
  // fixes their data twice: once for the contradiction, then again for the field they mistyped.
  // (This case is why the check sits AFTER the boolean loop rather than before it — the mutation
  // that moves it up is caught here and nowhere else.)
  const m = v({ noMortgageHistory: true, mortgageLates: { last12: { 90: '2' } }, io: 'yes' });
  ok(m.ok === false && m.error === 'non_boolean_value' && m.field === 'io',
    'ORDER-3 a mistyped OTHER field is reported as the type error, not masked by the contradiction');
}

// ---- still reachable over HTTP ---------------------------------------------
{
  ok(unsupportedFields({ purpose: 'Purchase', noMortgageHistory: true, mortgageLates: { last12: { 30: '1' } }, lateInLast12Months: true }).length === 0,
    'SUPPORTED all three fields are supported route fields, so the refusal is reachable rather than shadowed by unsupported_field');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
