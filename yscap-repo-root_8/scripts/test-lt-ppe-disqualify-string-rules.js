#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT A DISQUALIFY RULE IS READ FROM WHERE LENDER PRICE PUTS IT.
 *
 * ⛔ THE DEFECT, and it is one expression. `client.disqualifyRulesOf` reads each element of
 * `groupAdjustmentProperties[].disqualifyAdjustments` as an OBJECT (`a.key || a.name`). MEASURED on a
 * captured 173 MB live Deephaven disqualify payload (2026-08-18, 9,540 items / 136,084 reasons):
 * **those elements are plain STRINGS**. So `a.key` was `undefined` on every one, nothing was stored,
 * and ALL 56 Deephaven DSCR leaves reported "no structured rules" — dropping every leaf into the
 * defensive string sweep, which harvests any string it meets.
 *
 * THE CONSEQUENCE was the whole eligibility half of the ≥200-scenario gate. The two genuine refusals
 * arrived with no group and no adjType, buried under ~500x noise from the leaf's DESCRIPTIVE blocks —
 * `rateGrid.qmTypes` (NONQM), `rateGrid.mortgageTypes` (Conventional), `rateGrid.mortgageLimits`
 * (Conforming/Jumbo/HighBalance), `rateGrid.loanPurposes` (Purchase/Refinance/CashoutRefinance),
 * `rateGrid.affordableHousingTypes` (None) and `borrowerPaidDetails[].description` (the origination
 * ladder). Every scenario came back `decline_reasons_unreadable`.
 *
 * Against the same captured payload, after the fix: 56 leaves → 84 reasons, exactly TWO distinct
 * texts, both real refusals, and not one noise row.
 *
 * ⛔ WHY THIS FIXTURE IS A REAL VENDOR LEAF, not one written from memory. The previous attempt at this
 * (parity doc §2.102) was guarded by a fixture built from SCALAR strings; the mutation that reverts the
 * fix stayed GREEN because the fixture did not reproduce the shape. `scripts/fixtures/
 * lp-disqualify-leaf.json` is lifted verbatim from the live capture — the real refusal, the real group
 * name, and the real descriptive blocks that used to drown it.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const client = require('../src/longterm/lenderprice/client');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const LEAF = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lp-disqualify-leaf.json'), 'utf8'));

function reasonsFor(leaf) {
  const raw = { results: { disqualifiedData: { childs: [{ type: 'LenderKey', keyLabel: 'Deephaven Mortgage', leafs: [leaf] }] } }, disqualifiedCount: 1 };
  const out = client.parseDisqualified(raw);
  const g = (out.lenders || [])[0];
  return ((g && g.items && g.items[0] && g.items[0].reasons) || []);
}

// ---- A. THE REAL LEAF, AS CAPTURED ---------------------------------------------------------------
// The fixture must keep being the thing under test: a string-shaped disqualify list plus the noise.
const grp = (LEAF.groupAdjustmentProperties || [])[0] || {};
ok(Array.isArray(grp.disqualifyAdjustments) && grp.disqualifyAdjustments.length > 0,
  'A0 the captured leaf carries a disqualify list');
ok(grp.disqualifyAdjustments.every((x) => typeof x === 'string'),
  'A1 …and its elements are STRINGS, which is the whole finding');
ok(Array.isArray(LEAF.rateGrid && LEAF.rateGrid.qmTypes) && LEAF.rateGrid.qmTypes.includes('NONQM'),
  'A2 …and the descriptive blocks that used to drown it are still in the fixture');

const got = reasonsFor(LEAF);
const texts = got.map((r) => r.rule);
ok(got.length === 1, `A3 the leaf yields exactly its one stated rule (got ${got.length}: ${JSON.stringify(texts)})`);
ok(/Maximum LTV\/CLTV 70%/.test(texts[0] || ''), `A4 and it is the real refusal, verbatim — got ${JSON.stringify(texts[0])}`);
ok(got[0] && got[0].group === grp.name, `A5 carrying the vendor's own group name — got ${JSON.stringify(got[0] && got[0].group)}`);

// The noise must be entirely absent — named individually, because each came from a different block.
const NOISE = ['NONQM', 'Conventional', 'Conforming', 'Jumbo', 'HighBalance', 'Purchase', 'Refinance', 'CashoutRefinance', 'None'];
const leaked = NOISE.filter((n) => texts.includes(n));
ok(leaked.length === 0, `A6 no product-classification token appears — leaked: ${leaked.join(', ')}`);
ok(!texts.some((t) => /^Origination\s*:/.test(t)), `A7 no origination ladder rung appears — got ${JSON.stringify(texts)}`);

// ---- B. AN OBJECT ELEMENT STILL WORKS, unchanged -------------------------------------------------
// The vendor ships strings today; the object shape is the one the parser was written for and must keep
// working, adjType and value included — otherwise this fix trades one silent loss for another.
const objLeaf = {
  companyName: 'X', programName: 'DSCR 30 Yr Fixed',
  groupAdjustmentProperties: [{ name: 'G', disqualifyAdjustments: [{ key: 'Minimum Loan Amount $200,000', adjType: 'LoanAmountAdjustment', llpa: -1.5 }] }],
};
const objGot = reasonsFor(objLeaf);
ok(objGot.length === 1 && objGot[0].rule === 'Minimum Loan Amount $200,000', `B1 an object element still reads its key — got ${JSON.stringify(objGot)}`);
ok(objGot[0] && objGot[0].adjType === 'LoanAmountAdjustment', 'B2 …and keeps its adjType');
// ⛔ B3 RECORDS A DEFECT RATHER THAN ASSERTING CORRECTNESS, and it is deliberately written to go RED
// the day the defect is fixed. `client.num` strips every character that is not a digit or a dot —
// the MINUS SIGN included — so a vendor value of -1.5 arrives as 1.5. That is not this item's bug and
// is not fixed here: `num` feeds twelve call sites including the priced itemized-LLPA path, and
// MEASURED on a captured live search 1,988 of 3,627 vendor adjustment values are negative while the
// parsed set contains ZERO negatives. Recorded as its own item in the parity doc. On the DISQUALIFY
// side it is inert — `lp-normalize-full.normalizeLpDisqualified` carries only `rule` and `adjType`,
// so this `value` is read by nothing — which is why landing this item ahead of it is safe.
ok(objGot[0] && objGot[0].value === 1.5,
  `B3 …and its value's MAGNITUDE (the sign is stripped by client.num — a recorded defect, see the parity doc; fix that and update this assertion) — got ${JSON.stringify(objGot[0] && objGot[0].value)}`);
// A STRING element has no adjType and no value to read; it must report null rather than invent one.
ok(got[0] && got[0].adjType === null && got[0].value === null,
  `B4 a string element reports no adjType and no value rather than a guessed one — got ${JSON.stringify({ adjType: got[0] && got[0].adjType, value: got[0] && got[0].value })}`);

// Mixed shapes in one list — a vendor mid-migration must not lose either half.
const mixedGot = reasonsFor({
  companyName: 'X', programName: 'DSCR 30 Yr Fixed',
  groupAdjustmentProperties: [{ name: 'G', disqualifyAdjustments: ['Min FICO 680', { key: 'Max LTV 75%', adjType: 'CapAdjustment' }] }],
});
ok(mixedGot.length === 2 && mixedGot.map((r) => r.rule).join('|') === 'Min FICO 680|Max LTV 75%',
  `B5 a list mixing both shapes keeps both — got ${JSON.stringify(mixedGot.map((r) => r.rule))}`);

// ---- C. THE FALLBACK SWEEP IS PRESERVED, not deleted ---------------------------------------------
// It is the only thing standing between us and a leaf that states a refusal somewhere we do not know
// about yet. It must still fire when there is genuinely nothing structured.
const bareGot = reasonsFor({ companyName: 'X', programName: 'p', conditionActions: [{ message: 'Foreign National requires 70% max LTV' }] });
ok(bareGot.some((r) => r.rule === 'Foreign National requires 70% max LTV'), 'C1 a condition action still reports its message');
const sweptGot = reasonsFor({ companyName: 'X', programName: 'p', someBlock: { disqualifyReason: 'Property type ineligible' } });
ok(sweptGot.some((r) => r.rule === 'Property type ineligible'), `C2 a leaf with nothing structured still falls back to the sweep — got ${JSON.stringify(sweptGot.map((r) => r.rule))}`);

// ---- D. THE PROPERTY THAT MATTERS: noise only ever arrives when nothing was stated ----------------
// The sweep runs only on an empty result, so a leaf that states a rule can never also report the noise.
// Proven on the REAL leaf by stripping its stated rule: the noise comes flooding back, which is what
// the live runs saw. If this ever passes with the rule present, the ordering has been broken.
const stripped = JSON.parse(JSON.stringify(LEAF));
stripped.groupAdjustmentProperties = [{ name: 'G', disqualifyAdjustments: [] }];
const strippedTexts = reasonsFor(stripped).map((r) => r.rule);
ok(strippedTexts.length > 5 && NOISE.some((n) => strippedTexts.includes(n)),
  `D1 with nothing stated, the SAME leaf floods with descriptive noise (${strippedTexts.length} rows) — this is what the fix avoids`);
ok(texts.length === 1, 'D2 …and with its rule stated, that same leaf reports one row and no noise');

console.log(`${fails.length ? 'FAIL' : 'PASS'} — disqualify string rules guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);
