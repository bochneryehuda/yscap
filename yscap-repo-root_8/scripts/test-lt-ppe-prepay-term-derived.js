#!/usr/bin/env node
'use strict';
/**
 * LT — A STEP-DOWN PREPAY STRUCTURE CARRIES ITS OWN TERM (§2.85).
 *
 * THE OWNER'S SECOND NAMED EXAMPLE, in their own words:
 *   "If you put in a three-year prepayment penalty, you want the pricing for a 3 [year] penalty, just
 *    to make sure that the mirror is working correctly … that the system understands your scenario
 *    exactly and it doesn't get any of your fields wrong."
 *
 * MEASURED BEFORE THE FIX. The structure and the term are two different fields on the wire, and the
 * term came from `prepayMonths` alone — which defaults to 60. So EVERY structure went out at five years:
 *
 *     prepayStructure '3,2,1'      -> PrepayTerm "60 Months"  Plan "321"    SMO "5 Yr PPP"
 *     prepayStructure '2,1'        -> PrepayTerm "60 Months"  Plan "21"     SMO "5 Yr PPP"
 *     prepayStructure '5,4,3,2,1'  -> PrepayTerm "60 Months"  Plan "54321"  SMO "5 Yr PPP"
 *
 * The first of those asks Lender Price for "a three-year step-down, over five years", which is not a
 * product anybody sells. The repo's own live measurement puts the 5-year prepay line at +0.625 and
 * No-Prepay at −2.000, so a term error is worth roughly 0.5 to 2.6 points.
 *
 * ⛔ ONLY SOME PLAN TYPES CAN BE DERIVED, AND THAT IS ASSERTED, NOT ASSUMED. `6MosInt` ships at 24, 36,
 * 48 AND 60 months and `Fixed3` at 12, 24 and open-ended — for those the plan type genuinely does not
 * determine a term, so the five-year profile default still applies and the caller must say. Inventing
 * a term for those would be the same silent mispricing in a new place. Section C pins BOTH halves.
 *
 * ⛔ THE DERIVED TABLE IS RE-DERIVED HERE, NOT TRUSTED. `PREPAY_PLAN_TERM_MONTHS` lives in
 * `lenderprice/field-registry.js` because `search-model` cannot require `ppe/ppp-structures` (that
 * module requires field-registry — the import would be a cycle). So this suite recomputes the
 * unambiguous subset FROM `ppp-structures` on every run and fails if the two ever drift. A copy that
 * is mechanically re-derived is a cache; a copy nobody checks is a second answer.
 *
 *   node scripts/test-lt-ppe-prepay-term-derived.js
 *
 * PURE — no DB, no network, no vendor call. LT-only.
 */
const { buildSearch, validateScenario } = require('../src/longterm/lenderprice/search-model');
const registry = require('../src/longterm/lenderprice/field-registry');
const { PPP_STRUCTURES } = require('../src/longterm/ppe/ppp-structures');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

const BASE = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25,
  state: 'NY', zip: '11211', countyFps: '36047', county: 'Kings', city: 'Brooklyn',
  propertyType: 'SingleFamily', units: 1, borrowerType: 'LLC' };
const wire = (sc) => {
  const b = buildSearch(sc);
  const d = b.dynamicPropertiesMap || {};
  const smo = (b.criteria.specialMortgageOptions || [])[0] || {};
  return { term: d.PrepayTerm && d.PrepayTerm.value, plan: d.PrePayment_Plan_Type && d.PrePayment_Plan_Type.value, smo: smo.name };
};

// ---- A: the table is RE-DERIVED from ppp-structures, never trusted -------------------------------
console.log('-- A: one source of truth, mechanically re-derived --');
const byPlan = new Map();
for (const s of PPP_STRUCTURES) {
  const pt = s.lp && s.lp.planType;
  if (pt == null) continue;
  if (!byPlan.has(pt)) byPlan.set(pt, new Set());
  byPlan.get(pt).add(s.lp.prepayTermMonths);
}
const derived = {};
for (const [pt, terms] of byPlan) {
  const t = [...terms];
  // A single term, and a REAL one — `Fixed5` carries only `null` (open-ended), which is not a term
  // to derive. One distinct value that happens to be null is still nothing to send.
  if (t.length === 1 && t[0] != null) derived[pt] = t[0];
}
const table = registry.PREPAY_PLAN_TERM_MONTHS;
ok(JSON.stringify(derived) === JSON.stringify(table),
  `field-registry's table equals the subset derived from ppp-structures — ${JSON.stringify(table)}`);
ok(Object.keys(table).length >= 6, `${Object.keys(table).length} plan types name their own term`);
// The exclusions are the point, so they are named rather than left implied by an equality.
ok(!('6MosInt' in table), "'6MosInt' is EXCLUDED — it ships at 24/36/48/60, so its plan type names no term");
ok(!('Fixed3' in table), "'Fixed3' is EXCLUDED — it ships at 12/24/open-ended");
ok(!('Fixed5' in table), "'Fixed5' is EXCLUDED — its only term is open-ended, which is not a term to send");
ok(byPlan.get('6MosInt') && byPlan.get('6MosInt').size > 1,
  '…and that exclusion is a FACT about the data, re-measured here, not a hand-kept opinion');

// ---- B: a structure alone now carries its own term ----------------------------------------------
console.log('\n-- B: the structure names the term --');
const CASES = [
  ['3,2,1', '36 Months', '321', '3 Yr PPP'],
  ['2,1', '24 Months', '21', '2 Yr PPP'],
  ['4,3,2,1', '48 Months', '4321', '4 Yr PPP'],
  ['5,4,3,2,1', '60 Months', '54321', '5 Yr PPP'],
  ['5,4,3,2', '48 Months', '5432', '4 Yr PPP'],
  ['5,4,3', '36 Months', '543', '3 Yr PPP'],
  ['Fixed 2%', '12 Months', 'Fixed2', '1 Yr PPP'],
];
for (const [structure, term, plan, smo] of CASES) {
  const w = wire({ ...BASE, prepayStructure: structure });
  ok(w.term === term, `${structure} -> PrepayTerm ${term} (was "60 Months" for every one of these)`);
  ok(w.plan === plan, `${structure} -> plan ${plan}`);
  ok(w.smo === smo, `${structure} -> SMO ${smo} — the term rides the SMO name too, so both halves agree`);
}
// The owner's example, stated as its own assertion so it cannot be lost in a table.
ok(wire({ ...BASE, prepayStructure: '3,2,1' }).term === '36 Months',
  "THE OWNER'S EXAMPLE: a three-year prepayment penalty is sent as a three-year penalty");

// ---- C: what must NOT change --------------------------------------------------------------------
console.log('\n-- C: the un-derivable cases keep the profile default --');
for (const structure of ['6 Months Interest', 'Fixed 3%', 'Fixed 5%', 'Standard', 'Step Down', 'Other']) {
  const w = wire({ ...BASE, prepayStructure: structure });
  ok(w.term === '60 Months',
    `${structure} keeps the five-year profile default — its plan type names no single term, and guessing would be the same bug`);
}
ok(wire(BASE).term === '60 Months', 'no structure at all still defaults to five years — unchanged');
ok(wire({ ...BASE, prepayMonths: 0 }).term === 'None', 'an explicit no-prepay is still "None", not a derived term');
// An explicit term still wins where the structure names none.
ok(wire({ ...BASE, prepayStructure: '6 Months Interest', prepayMonths: 48 }).term === '48 Months',
  'an explicit term is honoured beside an un-derivable structure');
// And where the structure DOES name one, a matching term is simply agreement, not a conflict.
ok(wire({ ...BASE, prepayStructure: '3,2,1', prepayMonths: 36 }).term === '36 Months',
  'a term that MATCHES its structure is accepted and produces the same wire');
// ⛔ PRECEDENCE, PINNED SEPARATELY. `validateScenario` refuses a contradicting pair, so in production
// the builder never sees one — which means the builder's own precedence would be untested, and a
// silent flip to "the structure overrides the caller" would pass every other assertion here.
// `buildSearch` is exported and called directly (the agreement battery does), so it is asserted
// directly: an EXPLICIT term wins. The refusal above is the policy; this is the mechanism under it.
ok(wire({ ...BASE, prepayStructure: '3,2,1', prepayMonths: 24 }).term === '24 Months',
  'buildSearch: an explicit term OVERRIDES the structure-derived one (the refusal is validation\'s job, not the builder\'s)');

// ---- D: a contradiction is refused, not resolved -------------------------------------------------
console.log('\n-- D: two answers to one question is a refusal --');
const conflict = validateScenario({ ...BASE, prepayStructure: '3,2,1', prepayMonths: 60 });
ok(conflict && conflict.ok === false, 'a 3-year structure with a 60-month term is REFUSED');
ok(conflict.error === 'prepay_term_conflicts_with_structure', `…with its own named error (${conflict.error})`);
ok(conflict.status === 422, '…as a 422, not a 500');
ok(/36/.test(conflict.message) && /60/.test(conflict.message),
  '…and the message names BOTH numbers, so the caller can see which two loans they described');
ok(/structure alone|matches it/.test(conflict.message), '…and says what to do about it');
// Refusing is only correct where the structure actually determines a term.
ok(validateScenario({ ...BASE, prepayStructure: '6 Months Interest', prepayMonths: 48 }).ok !== false,
  'a term beside an UN-derivable structure is information, not a conflict — not refused');
ok(validateScenario({ ...BASE, prepayStructure: '3,2,1', prepayMonths: 36 }).ok !== false,
  'an agreeing term is not a conflict');
ok(validateScenario({ ...BASE, prepayStructure: '3,2,1' }).ok !== false, 'a structure alone is fine');
ok(validateScenario({ ...BASE, prepayMonths: 60 }).ok !== false, 'a term alone is fine');

// ---- E: BOTH LEGS derive the same term, or neither (§2.94) ---------------------------------------
console.log('\n-- E: the vendor request and our own engine must agree --');
// ⛔ THIS BROKE THE MOMENT THE BATTERY GAINED REAL STRUCTURE SCENARIOS. The section above fixed the
// VENDOR request; `lp-agreement-legs.lpScenarioToFacts` still dropped `prepayStructure`, so
// `prepay_months` was unknown and our engine correctly refused to price on a missing price-bearing
// fact. Measured: the LP leg priced all seven structure scenarios and our leg priced ZERO of them.
// Two individually-correct halves, and the defect in the join — so both legs are asserted together.
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const wireTerm = (sc) => {
  const d = buildSearch(sc).dynamicPropertiesMap || {};
  const v = d.PrepayTerm && d.PrepayTerm.value;
  return v === 'None' ? 0 : (typeof v === 'string' ? Number(v.replace(/[^0-9]/g, '')) : null);
};
for (const [structure, term] of CASES.map(([st, t]) => [st, Number(t.replace(/[^0-9]/g, ''))])) {
  const sc = { ...BASE, prepayStructure: structure };
  const sent = wireTerm(sc);
  const ours = legs.lpScenarioToFacts(sc).prepay_months;
  ok(sent === term && ours === term,
    `${structure}: the vendor request says ${sent} months and OUR facts say ${ours} — both ${term}`);
}
// Neither leg may invent a term for a plan type that names none.
{
  const sc = { ...BASE, prepayStructure: '6 Months Interest' };
  ok(legs.lpScenarioToFacts(sc).prepay_months == null,
    'an un-derivable structure yields NO prepay_months on our leg — it does not invent one');
  ok(wireTerm(sc) === 60, '…while the vendor request falls back to the profile default, as documented');
}
ok(legs.lpScenarioToFacts({ ...BASE, prepayStructure: '3,2,1', prepayMonths: 24 }).prepay_months === 24,
  'an explicit term wins on our leg too');
// One table, not two: the fact derivation must read the connector's own map rather than a copy.
{
  const fs2 = require('fs');
  const src = fs2.readFileSync(require('path').join(__dirname, '../src/longterm/ppe/lp-agreement-legs.js'), 'utf8');
  ok(/PREPAY_PLAN_TERM_MONTHS/.test(src), 'our leg reads the SAME table the request builder uses');
  ok(!/'321':\s*36|321: 36/.test(src), '…and does not carry its own copy of it');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
