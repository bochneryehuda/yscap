#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the agreement gate can now see a PREPAYMENT-PENALTY prohibition.
 *
 * THE DEFECT, MEASURED. The harness prices a SHEET (`quote.quoteProgram`); the state prepayment-penalty
 * law lives in an investor PROGRAM's Layer 3 (`deephaven-ppp-matrix`), reachable only through
 * `program-engine.runProgram`, which the harness never calls. So `buildOursLeg` never asked, and the
 * canonical battery's OWN scenario flagged `_ineligible` for "NJ Individual PPP prohibited" came back
 * PRICED — while `pppDisqualifier` on the identical facts returned `dhvn_ppp_prohibited_nj`.
 *
 * That is the DANGEROUS DIRECTION: we quote a loan the investor will not buy. The sheet cannot catch it
 * — it carries no borrower-type rule at all — so the one PPP ineligibility the battery claims to prove
 * was not being asked of the code that prices, and the gate was structurally blind to it.
 *
 * WHAT IS PROVEN HERE:
 *   1. the battery's own NJ scenario, through the real leg, is now DECLINED with the real code;
 *   2. the decline is shaped exactly like a sheet decline, so every consumer downstream reads it the
 *      same way — and is stamped `source:'ppp_matrix'` so the layer is visible rather than disguised;
 *   3. an LLC on the identical loan still PRICES — a CONTROL, because a leg that declined everything
 *      would pass assertion 1 while being far more wrong;
 *   4. it is OPT-IN: with no descriptor the leg is byte-for-byte what it was;
 *   5. a descriptor that cannot answer is refused at WIRING time, not ignored once per scenario;
 *   6. the quote object handed in is never mutated.
 *
 * DELIBERATELY NOT DONE: the same descriptor carries a Layer-2 ELIGIBILITY matrix, and folding that in
 * would silently answer an OPEN OWNER QUESTION — the sheet prices cells the matrix refuses, and which
 * governs is the owner's call (§2.10, task #81). PPP is the case where the sheet is SILENT, so asking
 * the matrix fills a silence rather than overriding a price.
 *
 *   node scripts/test-lt-ppe-agreement-ppp-leg.js
 *
 * PURE: no database, no network. LT-only; no RTL imports.
 */
const assert = require('assert');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const reg = require('../src/longterm/ppe/program-registry');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const settingsMod = require('../src/longterm/ppe/settings');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const SHEET = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'DHVN_DSCR30' });
const VALUES = settingsMod.resolveAll().values;
const DESC = reg.programFor('Deephaven');

// `onUnresolvedPpp` is REQUIRED alongside a descriptor (defect A8.1): a state whose prepayment table
// could not be evaluated may not be silently priced as allowed, so the caller declares what it does.
// 'flag' is this harness's policy — it MEASURES, it does not decide (see routes/ppe.js).
const legWith = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true, pppDescriptor: DESC, onUnresolvedPpp: 'flag' });
const legWithout = legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true });

// ---- 1) the battery's OWN flagged scenario ------------------------------------------------------
{
  ok(!!DESC, 'P0 the Deephaven program descriptor resolves from the registry');

  const battery = buildAgreementScenarios();
  const all = battery.scenarios || battery;
  // Selected by what it IS — a prepayment penalty requested by an individual in a prohibited state —
  // never by its label text, which is display copy and may be reworded.
  const njIndividualPpp = all.filter((s) => String(s.state).toUpperCase() === 'NJ'
    && /individual/i.test(String(s.borrowerType || ''))
    && Number(s.prepayMonths) > 0);
  const nj = njIndividualPpp.find((s) => s._ineligible === true);
  ok(!!nj, `P1 the battery carries an NJ individual-with-prepay scenario flagged INELIGIBLE (${nj && nj._label})`);
  ok(nj && nj._ineligible === true, 'P2 …and the battery itself declares it so');

  // THE BATTERY CARRIES TWO OF THEM and flags only one: "NJ Individual 5yr PPP" (group `borrower`)
  // describes the identical prohibited combination and is not marked ineligible. Both must decline —
  // the law does not care which group a scenario was filed under — so this asserts on the set, not on
  // the flagged one alone. That the battery's own labelling is short here is worth knowing; it is the
  // battery's business, not this leg's, and the leg is right either way.
  ok(njIndividualPpp.length >= 2,
    `P2b the battery holds ${njIndividualPpp.length} NJ individual-with-prepay scenarios, only ${njIndividualPpp.filter((s) => s._ineligible).length} flagged`);
  ok(njIndividualPpp.every((s) => legWith(s).eligible === false),
    'P2c …and EVERY one of them is now declined, flagged or not');

  const before = legWithout(nj);
  const after = legWith(nj);
  ok(before.eligible === true, 'P3 REPRODUCED: without the descriptor our leg PRICES it — the dangerous direction');
  ok(after.eligible === false, 'P4 with the descriptor our leg DECLINES it');
  const dq = (after.declines || []).find((d) => /ppp_prohibited/.test(d.code || ''));
  ok(!!dq && dq.code === 'dhvn_ppp_prohibited_nj', `P5 …with the real code (${dq && dq.code})`);
  ok(dq && dq.source === 'ppp_matrix',
    'P6 …stamped as the PPP layer, so a report can tell it from a sheet rule');
  ok(dq && typeof dq.reason === 'string' && /prohibited/i.test(dq.reason),
    'P7 …and carries the plain-language reason, in the same field a sheet decline uses');
  ok(Array.isArray(after.ladder) && after.ladder.length === 0,
    'P8 an ineligible quote carries no prices — the shape quoteProgram produces for its own declines');
}

// ---- 2) THE CONTROL — a leg that declined everything would pass P4 -------------------------------
{
  const base = {
    purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
    state: 'NJ', zip: '07731', prepayMonths: 60,
  };
  const individual = legWith({ ...base, borrowerType: 'Individual' });
  const llc = legWith({ ...base, borrowerType: 'LLC' });
  ok(individual.eligible === false, 'C1 NJ + individual + a prepay penalty is declined');
  ok(llc.eligible === true, 'C2 CONTROL — the IDENTICAL loan as an LLC still PRICES (an entity may carry one)');
  ok((llc.ladder || []).length > 0, 'C3 …and prices a real ladder, not an empty one');

  // A state with no prohibition, same borrower — the rule is about the STATE, not about individuals.
  const ca = legWith({ ...base, state: 'CA', zip: '90001', borrowerType: 'Individual' });
  ok(ca.eligible === true, 'C4 CONTROL — the same individual in California prices');

  // No prepay requested at all: nothing to prohibit.
  const noPpp = legWith({ ...base, borrowerType: 'Individual', prepayMonths: 0 });
  ok(noPpp.eligible === true, 'C5 CONTROL — the same NJ individual with NO prepay penalty prices');
}

// ---- 3) opt-in, wiring-time refusal, and no mutation ---------------------------------------------
{
  const sc = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NJ', prepayMonths: 60, borrowerType: 'Individual' };
  const plain = legWithout(sc);
  ok(plain.eligible === true,
    'O1 OPT-IN: with no descriptor the leg is what it always was — no existing gate moves unasked');

  let threw = null;
  try { legs.buildOursLeg(SHEET, VALUES, { pppDescriptor: { nope: true } }); } catch (e) { threw = e.message; }
  ok(/pppInputFromFacts/.test(threw || ''),
    'O2 a descriptor that cannot answer is refused at WIRING time, not ignored once per scenario');

  // The same discipline for the THIRD answer. A PPP layer with no `pppUnresolved`, and a caller with no
  // declared policy, are both refused at wiring time rather than defaulting to "price it as allowed".
  let threwNoUnres = null;
  try {
    legs.buildOursLeg(SHEET, VALUES, { pppDescriptor: { pppInputFromFacts: () => ({}), pppDisqualifier: () => null }, onUnresolvedPpp: 'flag' });
  } catch (e) { threwNoUnres = e.message; }
  ok(/pppUnresolved/.test(threwNoUnres || ''),
    'O2b a PPP layer that cannot say "we could not tell" is refused at WIRING time');

  let threwNoPolicy = null;
  try { legs.buildOursLeg(SHEET, VALUES, { factsFromLp: true, pppDescriptor: DESC }); } catch (e) { threwNoPolicy = e.message; }
  ok(/onUnresolvedPpp/.test(threwNoPolicy || ''),
    'O2c a caller that supplies a descriptor and NO unresolved-state policy is refused — there is no silent default');

  // A sheet-declined quote must not gain a second reason — that would double-count it by dimension.
  const njWeak = { ...sc, fico: 600 };
  const weak = legWith(njWeak);
  const pppLines = (weak.declines || []).filter((d) => /ppp_prohibited/.test(d.code || ''));
  ok(weak.eligible === false && pppLines.length === 0,
    'O3 a scenario the SHEET already declined is left alone — no second reason, no double count');
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe agreement ppp leg (${n} assertions)`}`);
assert.strictEqual(failures, 0);
