#!/usr/bin/env node
'use strict';
/**
 * §32.2 — CASH-OUT AMOUNT FAIL-CLOSED (pure, offline).
 *
 * A clean live cash-out capture (2026-08-16) sent `criteria.loanPurpose="CashoutRefinance"` but its
 * JSON contained NEITHER the numeric value NOR `criteria.cashoutAmount` — only a frontend BUG,
 * `dynamicPropertiesMap.undefined = { value: null }`. This SUPERSEDES the earlier "the vendor fixed
 * the field" finding (§31.4): in the live path the field is NOT fixed. So the backend must:
 *   • NOT transmit `criteria.cashoutAmount`;
 *   • NOT invent a vendor key (never replicate the `undefined` bug);
 *   • RETAIN the amount internally (a Symbol-keyed prop, skipped by JSON.stringify) for diagnostics;
 *   • only transmit it as a real dynamic field when an operator DELIBERATELY configures a confirmed
 *     field via LP_CASHOUT_AMOUNT_FIELD (the escape hatch for when a new capture confirms one).
 *
 * PROVEN TO FAIL: re-add `c.cashoutAmount = cashoutAmt` in buildSearch and WIRE-* / TRANSMIT-* go red;
 * drop the Symbol retention and INTERNAL-* / effectiveScenario go red.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');
const route = require('../src/longterm/routes/dscr-pricer');
const { effectiveOf, unsupportedFields } = route._internals;

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
// A distinctive cash-out value that is NOT a substring of any other number in the payload, so a
// substring search for it in the serialized body is a true "is it transmitted?" test.
const CASH = 43217;
const S = { purpose: 'Cash out', value: 8.2e5, loan: 6.1e5, dscr: 1.3, state: 'NJ', countyFps: '34039' };

console.log('§32.2 cash-out amount fail-closed');

// ---- supplied cash-out → NOT transmitted, retained internally --------------
const m = sm.buildSearch({ ...S, cashoutAmount: CASH });
const wire = JSON.stringify(m);
ok(m.criteria.cashoutAmount === undefined, 'TRANSMIT-1 criteria.cashoutAmount is NOT set (absent from the payload)');
ok(wire.includes(String(CASH)) === false, 'WIRE-1 the cash-out amount does NOT appear anywhere in the serialized body');
ok(wire.includes('cashoutAmount') === false, 'WIRE-2 no "cashoutAmount" key is serialized');
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
// even WITH a supplied cash-out, it is still not transmitted as a criteria field over a stale base.
const cleared2 = sm.buildSearch({ ...S, cashoutAmount: CASH }, { base });
ok(cleared2.criteria.cashoutAmount === undefined && cleared2[sm.CASHOUT_INTERNAL] === CASH,
  'FAILCLOSED-2 a supplied cash-out over a stale base is retained internally, never transmitted');

// ---- operator escape hatch: LP_CASHOUT_AMOUNT_FIELD transmits a CONFIRMED field
const prev = process.env.LP_CASHOUT_AMOUNT_FIELD;
process.env.LP_CASHOUT_AMOUNT_FIELD = 'CONFIRMED_CASHOUT_FIELD';
try {
  const me = sm.buildSearch({ ...S, cashoutAmount: CASH });
  const d = me.dynamicPropertiesMap.CONFIRMED_CASHOUT_FIELD;
  ok(d && d.value === CASH, 'ESCAPE-1 with LP_CASHOUT_AMOUNT_FIELD set, the amount IS transmitted as that confirmed dynamic field');
  ok(me.criteria.cashoutAmount === undefined, 'ESCAPE-2 even with the escape hatch, criteria.cashoutAmount is still never set');
} finally {
  if (prev === undefined) delete process.env.LP_CASHOUT_AMOUNT_FIELD; else process.env.LP_CASHOUT_AMOUNT_FIELD = prev;
}
// with the env unset (default), nothing is transmitted — the fail-closed default.
ok(sm.buildSearch({ ...S, cashoutAmount: CASH }).dynamicPropertiesMap.CONFIRMED_CASHOUT_FIELD === undefined,
  'ESCAPE-3 with the env unset (default), no confirmed field is transmitted (fail-closed)');

// ---- effectiveScenario surfaces the internal value, NOT a transmitted one --
const eff = effectiveOf(m);
ok(eff.cashoutAmount === undefined, 'EFF-1 effectiveScenario.cashoutAmount (transmitted) is absent');
ok(eff.cashoutAmountInternal === CASH, 'EFF-2 effectiveScenario.cashoutAmountInternal surfaces the received-but-not-priced value');

// ---- still a supported, validated route field ------------------------------
ok(unsupportedFields({ cashoutAmount: CASH, purpose: 'Cash out' }).length === 0, 'ROUTE-1 cashoutAmount is still a supported route field');
const neg = sm.validateScenario({ ...S, cashoutAmount: -5 });
ok(neg.ok === false && neg.status === 422, 'ROUTE-2 a negative cash-out amount is still rejected 422 (validation unchanged)');
const good = sm.validateScenario({ ...S, cashoutAmount: CASH });
ok(good.ok === true, 'ROUTE-3 a valid cash-out amount passes validation (accepted, retained, not transmitted)');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
