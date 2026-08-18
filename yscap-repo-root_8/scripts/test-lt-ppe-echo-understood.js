#!/usr/bin/env node
'use strict';
/**
 * LT — DID LENDER PRICE UNDERSTAND US? (§2.86)
 *
 * THE OWNER'S REQUIREMENT, verbatim:
 *   "…make sure that the mirror is working correctly, that the scenario that they're entering is
 *    actually the system is reading it for the correct scenario, that the system understands your
 *    scenario exactly and it doesn't get any of your fields wrong. This is the main key right now."
 *
 * THE VENDOR ALREADY ANSWERS THIS and we never read the answer. Measured live 2026-08-18: every
 * priced response carries `results.baseSearch` — the search the vendor says it RAN — and **all 41
 * `criteria` keys plus all 17 `dynamicPropertiesMap` entries come back**. Nothing in the repo compared
 * a single one against what was sent.
 *
 * THE FIXTURE IS A REAL LIVE ECHO. `test/fixtures/lenderprice/base-search-echo.json` is the
 * `baseSearch` block from an actual priced cash-out search (36-month prepay, FICO 720, DSCR 1.15,
 * 65% LTV, 45-day lock), with the property ADDRESS removed — a fixture is a file anybody can read, and
 * a captured address belongs to a real property. Testing against a hand-written echo would prove the
 * comparator agrees with my own idea of the vendor's shape, which is exactly the trap this module is
 * meant to close.
 *
 * ⛔ THE HARD PART IS NOT FINDING MISMATCHES, IT IS NOT INVENTING THEM. A check that cries wolf gets
 * ignored, and an ignored check is worse than none. So sections C and D pin the two ways this could go
 * wrong quietly: a vendor-computed field must never be reported as a disagreement, and an empty check
 * must never be reported as agreement.
 *
 *   node scripts/test-lt-ppe-echo-understood.js
 *
 * PURE — no network, no DB. LT-only.
 */
const fs = require('fs');
const path = require('path');
const ec = require('../src/longterm/lenderprice/echo-check');
const { buildSearch } = require('../src/longterm/lenderprice/search-model');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, '../test/fixtures/lenderprice/base-search-echo.json'), 'utf8'));
// The scenario that produced the fixture, exactly.
const SC = { purpose: 'CashoutRefinance', value: 500000, loan: 325000, fico: 720, dscr: 1.15,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn',
  propertyType: 'SingleFamily', units: 1, prepayMonths: 36, borrowerType: 'LLC', cashoutAmount: 50000, lockDays: 45 };
const respWith = (base) => ({ results: { baseSearch: base } });
const SENT = buildSearch(SC);

// ---- A: against a REAL echo, the scenario is confirmed field by field ---------------------------
console.log('-- A: a real live echo confirms the scenario --');
const r = ec.compareEcho(SENT, respWith(FIXTURE));
ok(r.available === true, 'the echo is available');
ok(r.checked >= 40, `${r.checked} fields were actually compared (the vendor echoes all 41 criteria + the dynamics)`);
ok(r.notEchoed.length === 0, 'every field we set came back — nothing went unconfirmed');
ok(r.vendorComputed.length === 4, `${r.vendorComputed.length} fields are vendor-computed and excluded BY NAME, each with a reason`);
ok(r.vendorComputed.every((v) => typeof v.reason === 'string' && v.reason.length > 20),
  'every exclusion states WHY — an exclusion without a reason is a bug swept under the rug');
// The fields the owner named, confirmed individually so a table change cannot quietly drop one.
const echoC = FIXTURE.criteria; const echoD = FIXTURE.dynamicPropertiesMap;
ok(echoC.loanPurpose === 'CashoutRefinance', 'THE VENDOR CONFIRMS: cash-out — asked for cash-out, ran cash-out');
ok(echoD.PrepayTerm.value === '36 Months', 'THE VENDOR CONFIRMS: a 36-month prepay — the owner\'s three-year penalty, priced as three years');
ok(echoC.cashoutAmount === 50000, 'the vendor confirms the cash-out AMOUNT, not merely the purpose');
ok(echoC.fico === 720 && echoC.dscr === 1.15 && echoC.ltv === 0.65, 'FICO, DSCR and LTV all confirmed');
ok(echoC.loanAmount === 325000 && echoC.purchasePrice === 500000, 'the amount triangle is confirmed');
ok(echoD.GLOBAL_BorrowerType.value === 'LLC', 'the borrower type is confirmed');
// ⛔ AND THE CONFIRMATION MUST GO THROUGH THE COMPARATOR, not only through the fixture. Reading the
// fixture directly proves what the vendor said; it does not prove that `compareEcho` LOOKED. A
// mutation that drops the dynamic properties from the checked set leaves every assertion above
// passing, because they all read the fixture. These read the comparator's own accounting.
{
  const checkedDyn = ec.CHECKED_DYNAMICS.filter((k) => {
    const bad = ec.compareEcho(SENT, respWith((() => {
      const c = JSON.parse(JSON.stringify(FIXTURE));
      if (c.dynamicPropertiesMap[k]) c.dynamicPropertiesMap[k].value = '__NOT_WHAT_WE_SENT__';
      return c;
    })()));
    return bad.mismatched.some((m) => m.field === `dynamic.${k}`);
  });
  ok(checkedDyn.includes('PrepayTerm'),
    'compareEcho ITSELF confirms the prepay term — corrupting it in the echo produces a mismatch');
  ok(checkedDyn.includes('GLOBAL_BorrowerType') && checkedDyn.includes('Citizenship'),
    '…and the borrower type and citizenship too');
  ok(checkedDyn.length >= 4, `${checkedDyn.length} dynamic properties are genuinely compared, not merely listed`);
}

// ⛔ THE ONE REAL MISMATCH THIS FOUND ON ITS FIRST RUN, pinned rather than tidied away. We send four
// special mortgage options and the vendor ran three: it did not take `Prepay Buyout`. Whether that is
// the vendor declining an option that does not apply, or us sending one it does not know, is an open
// question recorded in the parity doc — but the check surfacing it immediately is the point, and a
// test that quietly asserted `understood === true` here would have buried the first thing it caught.
ok(r.understood === false, 'the real echo does NOT come back fully understood — there is a genuine mismatch');
ok(r.mismatched.length === 1, `exactly one mismatch (${r.mismatched.length})`);
ok(r.mismatched[0].field === 'criteria.specialMortgageOptions[].name', `…and it is the SMO list: ${r.mismatched[0].field}`);
ok(r.mismatched[0].sent.includes('Prepay Buyout') && !r.mismatched[0].ran.includes('Prepay Buyout'),
  'we send "Prepay Buyout" and the vendor did not run it — found by this check on its first execution');
ok(r.mismatched[0].ran.includes('3 Yr PPP'),
  '…while the 3 Yr PPP option WAS run, so this is one option declined, not the whole list ignored');

// ---- B: a real disagreement is caught ------------------------------------------------------------
console.log('\n-- B: a substituted value is caught --');
function tamper(mut) {
  const copy = JSON.parse(JSON.stringify(FIXTURE));
  mut(copy);
  return ec.compareEcho(SENT, respWith(copy));
}
const purposeSwap = tamper((f) => { f.criteria.loanPurpose = 'Purchase'; });
ok(purposeSwap.mismatched.some((m) => m.field === 'criteria.loanPurpose'),
  'THE OWNER\'S CASE: asked cash-out, the vendor says it ran a PURCHASE -> caught');
ok(purposeSwap.mismatched.find((m) => m.field === 'criteria.loanPurpose').ran === 'Purchase',
  '…and the report names what they actually ran, not only that something differed');
const termSwap = tamper((f) => { f.dynamicPropertiesMap.PrepayTerm.value = '60 Months'; });
ok(termSwap.mismatched.some((m) => m.field === 'dynamic.PrepayTerm'),
  'THE OWNER\'S OTHER CASE: asked 36 months, the vendor says 60 -> caught');
for (const [field, mut] of [
  ['criteria.fico', (f) => { f.criteria.fico = 640; }],
  ['criteria.dscr', (f) => { f.criteria.dscr = 1.0; }],
  ['criteria.ltv', (f) => { f.criteria.ltv = 0.8; }],
  ['criteria.loanAmount', (f) => { f.criteria.loanAmount = 400000; }],
  ['criteria.cashoutAmount', (f) => { f.criteria.cashoutAmount = 0; }],
  ['criteria.interestOnly', (f) => { f.criteria.interestOnly = true; }],
  ['criteria.escrowWaiver', (f) => { f.criteria.escrowWaiver = true; }],
  ['dynamic.GLOBAL_BorrowerType', (f) => { f.dynamicPropertiesMap.GLOBAL_BorrowerType.value = 'Individual'; }],
  ['dynamic.Citizenship', (f) => { f.dynamicPropertiesMap.Citizenship.value = 'Foreign National'; }],
]) {
  ok(tamper(mut).mismatched.some((m) => m.field === field), `a substituted ${field} is caught`);
}

// ---- C: it must NOT invent mismatches ------------------------------------------------------------
console.log('\n-- C: the vendor normalizing a value is not a misunderstanding --');
// Measured live: we send `ownProperties: "1"` and the vendor echoes `1`. Reporting that as "they
// misunderstood us" is the false-alarm failure that makes a check worthless.
ok(!tamper((f) => { f.criteria.ownProperties = 1; }).mismatched.some((m) => m.field === 'criteria.ownProperties'),
  'a string "1" echoed as the number 1 is NOT a mismatch — the vendor normalizes types');
ok(!tamper((f) => { f.criteria.escrowWaiver = false; }).mismatched.some((m) => m.field === 'criteria.escrowWaiver'),
  'an unchanged boolean is not a mismatch');
// The vendor-computed fields differ on EVERY real response. If they were compared, every single
// search would report four mismatches forever, and nobody would ever read the report again.
for (const key of Object.keys(ec.VENDOR_COMPUTED)) {
  ok(!r.mismatched.some((m) => m.field === `criteria.${key}`),
    `${key} is vendor-computed and is never reported as a disagreement`);
}
ok(r.agreed === r.checked - r.mismatched.length, 'agreed + mismatched accounts for everything checked — no third bucket hides a field');

// ---- D: an absent or empty echo is NOT agreement -------------------------------------------------
console.log('\n-- D: nothing checked is never "understood" --');
for (const [label, resp] of [
  ['a response with no baseSearch', { results: {} }],
  ['a response with no results at all', {}],
  ['null', null],
  ['baseSearch that is not an object', { results: { baseSearch: 'nope' } }],
]) {
  const v = ec.compareEcho(SENT, resp);
  ok(v.available === false && v.understood === false, `${label}: available=false, understood=false`);
  ok(typeof v.why === 'string' && v.why.length > 10, `${label}: …and it SAYS why rather than answering a bare false`);
}
{
  // The subtle one: the vendor echoes a search, but none of OUR fields are in it. Zero checked. That
  // must never read as "everything agreed" — the bug that would make this whole module decorative.
  const v = ec.compareEcho(SENT, respWith({ criteria: { somethingElse: 1 }, dynamicPropertiesMap: {} }));
  ok(v.available === true, 'an echo carrying none of our fields is still "available" — they answered, they just answered about nothing we asked');
  // The SMO list is compared by NAME whenever EITHER side has one, so it still runs here and
  // mismatches (we sent four names, they ran none). That is why `checked` is 1 rather than 0 — and
  // asserting 0 would have been asserting my expectation over the code's actual, correct behaviour.
  ok(v.checked === 1 && v.mismatched.length === 1 && v.mismatched[0].field === 'criteria.specialMortgageOptions[].name',
    'the only thing confirmable is the SMO list, and it mismatches');
  ok(v.understood === false, '…so it is NOT understood — nothing that mattered was confirmed');
  ok(v.notEchoed.length > 30, `…and every other field we set is reported as unconfirmed (${v.notEchoed.length})`);
  // The genuinely-empty case, so the "zero checked is not agreement" rule is pinned on its own terms.
  const empty = ec.compareEcho({ criteria: {}, dynamicPropertiesMap: {} }, respWith({ criteria: {}, dynamicPropertiesMap: {} }));
  ok(empty.checked === 0 && empty.understood === false,
    'zero fields checked is NOT understood — the bug that would make this whole module decorative');
  ok(/nothing was confirmed/.test(empty.why || ''), '…and it says so in words');
}

// ---- E: the per-option purpose check -------------------------------------------------------------
console.log('\n-- E: a priced option on the wrong purpose --');
const full = { programs: [{ lender: 'L1', program: 'P1', options: [
  { terms: { loanPurpose: 'CashoutRefinance' } }, { terms: { loanPurpose: 'Purchase' } }, { terms: {} }] }] };
const op = ec.checkOptionPurposes(full, 'CashoutRefinance');
ok(op.checked === 2, `only options that STATE a purpose are checked (${op.checked}) — a silent leaf is not a pass`);
ok(op.wrongPurpose.length === 1 && op.wrongPurpose[0].priced === 'Purchase',
  'an option priced as a Purchase on a cash-out search is reported, with its lender and program');
ok(ec.checkOptionPurposes(full, 'Purchase').wrongPurpose.length === 1, 'and the check works in the other direction too');
ok(ec.checkOptionPurposes(null, 'Purchase').checked === 0 && ec.checkOptionPurposes(full, null).checked === 0,
  'missing input checks nothing rather than throwing');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
