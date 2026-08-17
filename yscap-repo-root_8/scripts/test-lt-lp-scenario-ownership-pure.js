#!/usr/bin/env node
'use strict';
/**
 * §31.6/§31.8 — SCENARIO-OWNERSHIP CLEARING LAYER (pure, offline).
 *
 * Proves that buildSearch clears every scenario-owned field to a documented neutral state BEFORE the
 * DSCR profile + caller overlay, so a stale value carried by a LIVE /pricing/defaultSearch foundation
 * (which is a snapshot of the model as an earlier session left it) can never leak into a NEW scenario.
 * The fixture is a MUTATED base carrying prior-session scenario values; the assertions confirm the
 * leak is cleared while every field OUTSIDE the ownership registry inherits unchanged (the audit's
 * "not a broad deletion" rule).
 *
 * PROVEN TO FAIL: with the `clearScenarioOwnedFields(m)` call removed from buildSearch, the LEAK-*
 * assertions below fail (the stale foundation values ride through into the built search), while the
 * INHERIT-* controls stay green — so the suite is not decoration.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const sm = require('../src/longterm/lenderprice/search-model');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }

// A live foundation that a PRIOR session left dirty: every scenario-owned field carries a stale value,
// plus two fields that MUST inherit (a structural default + an explicitly-inherited flag) so we can
// prove the clear is targeted, not a wipe.
function dirtyBase() {
  const b = JSON.parse(JSON.stringify(sm.BASE));
  b.criteria.purchasePrice = 999999;          // stale core economics
  b.criteria.loanAmount = 888888;
  b.criteria.ltv = 0.95;
  b.criteria.fico = 550;
  b.criteria.dscr = 0.5;
  b.criteria.subordinateLoanAmount = 50000;   // audit §31.6 second-lien example
  b.criteria.lineAmount = 99999;
  b.criteria.rehabBudget = 88888;
  b.criteria.drawAmount = 77777;
  b.criteria.downPaymentAmount = 66666;
  b.criteria.cashoutAmount = 55555;           // stale cash-in-hand
  b.criteria.pmiType = 'STALE_STRUCTURAL';    // NOT scenario-owned → must inherit
  b.criteria.interestOnly = true;             // flag default → inherits when io omitted
  b.brokerCriteria.overrideExistingComplan = true; // audit §31.6 compPlan example
  // A stale prepay the audit says must INHERIT when the caller omits prepayMonths (§29.12.3).
  b.dynamicPropertiesMap = b.dynamicPropertiesMap || {};
  b.dynamicPropertiesMap.PrepayTerm = { fieldId: 'PrepayTerm', value: '36 Months' };
  return b;
}

console.log('§31.6 scenario-ownership clearing layer');

// ---- 1) the registry itself is well-formed --------------------------------
ok(Array.isArray(sm._internals.SCENARIO_OWNED) && sm._internals.SCENARIO_OWNED.length > 0,
  'SCENARIO_OWNED registry is a non-empty array');
ok(sm._internals.SCENARIO_OWNED.every((e) => typeof e.path === 'string' && e.path && 'neutral' in e && typeof e.why === 'string' && e.why),
  'every registry entry documents a path, a neutral, and WHY it is scenario-owned');
ok(typeof sm.clearScenarioOwnedFields === 'function' && typeof sm._internals.clearScenarioOwnedFields === 'function',
  'clearScenarioOwnedFields is exported (public + _internals)');

// ---- 2) a scenario that OMITS every scenario-owned field: no leak ----------
const omitted = sm.buildSearch({ purpose: 'Refinance', propertyType: 'SingleFamily' }, { base: dirtyBase() });
ok(omitted.criteria.purchasePrice === null, 'LEAK-1 stale purchasePrice cleared to neutral on omission');
ok(omitted.criteria.loanAmount === null, 'LEAK-2 stale loanAmount cleared to neutral on omission');
ok(omitted.criteria.ltv === null, 'LEAK-3 stale ltv cleared to neutral on omission');
ok(omitted.criteria.fico === null, 'LEAK-4 stale fico cleared to neutral on omission');
ok(omitted.criteria.dscr === 1.5, 'LEAK-5 stale dscr 0.5 cleared and replaced by the profile default 1.5 — never leaks (§32.6)');
ok(omitted.criteria.subordinateLoanAmount === 0, 'LEAK-6 stale subordinateLoanAmount cleared to 0 (audit §31.6)');
ok(omitted.criteria.lineAmount === 0, 'LEAK-7 stale lineAmount cleared to 0');
ok(omitted.criteria.rehabBudget === 0, 'LEAK-8 stale rehabBudget cleared to 0');
ok(omitted.criteria.drawAmount === 0, 'LEAK-9 stale drawAmount cleared to 0');
ok(omitted.criteria.downPaymentAmount === 0, 'LEAK-10 stale downPaymentAmount cleared to 0');
ok(!('cashoutAmount' in omitted.criteria), 'LEAK-11 stale cashoutAmount removed entirely (neutral = absent)');
ok(omitted.brokerCriteria.overrideExistingComplan === false, 'LEAK-12 stale comp override cleared to false (audit §31.6)');

// ---- 3) fields OUTSIDE the registry inherit unchanged (not a broad wipe) ---
ok(omitted.criteria.pmiType === 'STALE_STRUCTURAL', 'INHERIT-1 a structural default (pmiType) survives — clearing is targeted, not a wipe');
ok(omitted.criteria.interestOnly === true, 'INHERIT-2 the io flag inherits the foundation default when io is omitted');
// PREPAY IS NOT AN INHERITED FIELD — it is a PROFILE field, and this assertion used to say the
// opposite. Inheriting was measurably wrong: against this very foundation an omitted prepay produced
// "36 Months" with no 5 Yr PPP option, i.e. a THREE-year prepay on a book the owner quotes at five,
// on the ordinary quote that mentions no prepay at all. The 2026-08-16 audit reversed it (§35.3/§36.6
// list five-year Standard among the profile's automatic values). What INHERIT-1/-2 guard — that
// clearing is targeted rather than a wipe — is untouched and still asserted above.
ok(omitted.dynamicPropertiesMap.PrepayTerm && omitted.dynamicPropertiesMap.PrepayTerm.value === '60 Months',
  'INHERIT-3 an omitted prepay takes the PROFILE default (60 Months), never the foundation\'s stale 36');
ok(omitted.dynamicPropertiesMap.PrePayment_Plan_Type
  && omitted.dynamicPropertiesMap.PrePayment_Plan_Type.value === 'Standard',
  'INHERIT-3b …with the Standard structure that goes with it');

// ---- 4) a SUPPLIED value is re-applied on top of the neutral ---------------
const supplied = sm.buildSearch(
  { purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.25, propertyType: 'SingleFamily' },
  { base: dirtyBase() });
ok(supplied.criteria.purchasePrice === 500000, 'REAPPLY-1 supplied value wins over the neutral (never the stale 999999)');
ok(supplied.criteria.loanAmount === 400000, 'REAPPLY-2 supplied loan wins (never the stale 888888)');
ok(supplied.criteria.ltv === 0.8, 'REAPPLY-3 ltv recomputed from value/loan (never the stale 0.95)');
ok(supplied.criteria.fico === 760, 'REAPPLY-4 supplied fico wins (never the stale 550)');
ok(supplied.criteria.dscr === 1.25, 'REAPPLY-5 supplied dscr wins (never the stale 0.5)');
// the non-reapplied per-deal amounts stay neutral even on a full scenario (no caller field wired)
ok(supplied.criteria.subordinateLoanAmount === 0 && supplied.criteria.rehabBudget === 0,
  'REAPPLY-6 unwired per-deal amounts stay neutral even on a full scenario');

// ---- 5) a supplied cash-out amount clears the stale foundation value and is retained INTERNALLY ----
// The cash-out amount is now TRANSMITTED as criteria.cashoutAmount, which makes it an ordinary
// clear-then-re-apply field — and therefore subject to the footgun this whole section exists for: the
// stale foundation value (55555) must be gone AND the caller's 47321 present. Getting only the first
// half right is what "cleared to neutral and then forgotten" looks like from the outside.
const cashout = sm.buildSearch({ purpose: 'CashOut', value: 500000, loan: 300000, cashoutAmount: 47321 }, { base: dirtyBase() });
ok(cashout.criteria.cashoutAmount === 47321,
  'REAPPLY-7 the stale 55555 is cleared and the SUPPLIED 47321 is re-applied on top');

// ---- 6) the clear runs on a CLONE — the caller's base object is never mutated ----
const base = dirtyBase();
sm.buildSearch({ purpose: 'Refinance' }, { base });
ok(base.criteria.subordinateLoanAmount === 50000 && base.criteria.purchasePrice === 999999,
  'CLONE-1 the passed-in base object is untouched (clear operates on buildSearch\'s clone)');

// ---- 7) clearScenarioOwnedFields directly, on a bare object ----------------
const bare = { criteria: { subordinateLoanAmount: 12345, fico: 600 }, brokerCriteria: { overrideExistingComplan: true } };
sm.clearScenarioOwnedFields(bare);
ok(bare.criteria.subordinateLoanAmount === 0 && bare.criteria.fico === null && bare.brokerCriteria.overrideExistingComplan === false,
  'DIRECT-1 clearScenarioOwnedFields neutralizes present fields');
// a DELETE-neutral field whose parent is absent is a safe no-op (no thrown error, nothing created)
const noBroker = { criteria: {} };
sm.clearScenarioOwnedFields(noBroker);
ok(!('cashoutAmount' in noBroker.criteria) && noBroker.criteria.subordinateLoanAmount === 0,
  'DIRECT-2 a DELETE neutral on an absent key is a safe no-op; value neutrals still set');

// ---- 8) the static-BASE path (no live foundation) is unaffected ------------
const staticBuilt = sm.buildSearch({ purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 1.25 });
ok(staticBuilt.criteria.purchasePrice === 500000 && staticBuilt.criteria.loanAmount === 400000,
  'STATIC-1 the captured-base path builds correctly with the clear applied');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
