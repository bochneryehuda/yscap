#!/usr/bin/env node
'use strict';
/**
 * LT PPE — LAYER 3 prepayment-penalty state engine (deephaven-ppp-matrix.js), validated OFFLINE against
 * the official Deephaven Operational PPP Matrix (eff March 2026). Heavy qualify/disqualify battery over
 * every restriction state — a PPP requested where the state/borrower combo is prohibited is a
 * disqualifier; a No-PPP loan never is. Owner example: NJ individual borrower → prohibited.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { pppResult, pppDisqualifier, normBorrowerType, STATE_RULES } = require('../src/longterm/ppe/deephaven-ppp-matrix');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const res = (o) => pppResult(o).result;
const prohibited = (o) => pppDisqualifier({ ...o, prepayRequested: true }) != null;

console.log('LT PPE — Layer 3 (Deephaven PPP state matrix)\n');

// ---- the owner's New Jersey example ------------------------------------------------------------
ok(prohibited({ state: 'NJ', borrowerType: 'Individual', units: 1, loanAmount: 400000 }), 'OWNER CASE: NJ individual borrower, 1 unit, PPP requested → PROHIBITED (disqualifier)');
ok(!prohibited({ state: 'NJ', borrowerType: 'LLC', units: 1, loanAmount: 400000 }), 'NJ LLC (business entity), PPP requested → allowed (not disqualified)');
ok(pppDisqualifier({ state: 'NJ', borrowerType: 'Individual', units: 1, loanAmount: 400000, prepayRequested: false }) == null, 'NJ individual borrower with NO PPP → never disqualified (a No-PPP loan is always fine)');
ok(prohibited({ state: 'NJ', borrowerType: 'LLC', units: 5, loanAmount: 900000 }), 'NJ 5+ units (any borrower) → PPP prohibited');

// ---- standard states (no restriction) ----------------------------------------------------------
for (const st of ['NY', 'CA', 'TX', 'FL', 'GA', 'AZ']) ok(res({ state: st, borrowerType: 'LLC', units: 1, loanAmount: 400000 }) === 'standard' && !prohibited({ state: st, borrowerType: 'Individual', units: 1, loanAmount: 50000 }), `${st}: PPP allowed for any borrower (standard)`);

// ---- Alaska: 1-4 prohibited, 5+ standard --------------------------------------------------------
ok(prohibited({ state: 'AK', units: 3, loanAmount: 400000 }) && !prohibited({ state: 'AK', units: 5, loanAmount: 400000 }), 'AK: 1-4 units prohibited; 5+ allowed');

// ---- Illinois: PPP allowed (NOT APR/high-cost gated) ------------------------------------------
// PPP for a business-purpose DSCR loan is not APR-driven (owner-directed 2026-08-17). An `apr` input,
// even a high one, must NOT cause a prohibition — IL allows a PPP for both borrower types.
ok(!prohibited({ state: 'IL', borrowerType: 'Individual', units: 2, loanAmount: 400000, apr: 9 }), 'IL: individual, high apr → still allowed (PPP not APR-driven)');
ok(!prohibited({ state: 'IL', borrowerType: 'Individual', units: 2, loanAmount: 400000 }), 'IL: individual, no apr → allowed');
ok(!prohibited({ state: 'IL', borrowerType: 'LLC', units: 2, loanAmount: 400000 }), 'IL: business entity → allowed');

// ---- Louisiana: rural prohibited ---------------------------------------------------------------
ok(prohibited({ state: 'LA', units: 1, loanAmount: 400000, ruralProperty: true }) && !prohibited({ state: 'LA', units: 1, loanAmount: 400000 }), 'LA: rural property prohibited; non-rural allowed');

// ---- Minnesota: <=$832,750 (1-4) prohibited; above standard; 5+ standard ------------------------
ok(prohibited({ state: 'MN', units: 3, loanAmount: 832750 }) && !prohibited({ state: 'MN', units: 3, loanAmount: 832751 }), 'MN: 1-4 units <=$832,750 prohibited; >$832,750 allowed (2026 threshold)');
ok(!prohibited({ state: 'MN', units: 5, loanAmount: 400000 }), 'MN: 5+ units allowed regardless of amount');

// ---- New Mexico: 1-4 prohibited, 5+ standard ---------------------------------------------------
ok(prohibited({ state: 'NM', units: 4, loanAmount: 400000 }) && !prohibited({ state: 'NM', units: 5, loanAmount: 400000 }), 'NM: 1-4 units prohibited; 5+ allowed');

// ---- Ohio: 1-2 first-lien <$116,356 prohibited; >=threshold restricted; 3+ standard ------------
ok(prohibited({ state: 'OH', units: 1, lien: 'first', loanAmount: 116355 }), 'OH: 1-2 first lien <$116,356 → prohibited');
ok(res({ state: 'OH', units: 1, lien: 'first', loanAmount: 116356 }) === 'restricted', 'OH: 1-2 >=$116,356 → restricted (5yr max 1%), not a disqualifier');
ok(!prohibited({ state: 'OH', units: 3, loanAmount: 50000 }), 'OH: 3+ units → standard');

// ---- Pennsylvania: 1-2 <=$329,411 prohibited; above standard; 3+ standard ----------------------
ok(prohibited({ state: 'PA', units: 2, loanAmount: 329411 }) && !prohibited({ state: 'PA', units: 2, loanAmount: 329412 }), 'PA: 1-2 units <=$329,411 prohibited; above allowed (2026 threshold)');
ok(!prohibited({ state: 'PA', units: 3, loanAmount: 100000 }), 'PA: 3+ units → standard');

// ---- Vermont: <$1M prohibited; >=$1M standard --------------------------------------------------
ok(prohibited({ state: 'VT', loanAmount: 999999, units: 1 }) && !prohibited({ state: 'VT', loanAmount: 1000000, units: 1 }), 'VT: <$1M prohibited; >=$1M allowed');

// ---- Virginia: 1-4 first >=$75k standard; first <$75k prohibited; junior prohibited; 5+ standard -
ok(!prohibited({ state: 'VA', units: 1, lien: 'first', loanAmount: 75000 }), 'VA: 1-4 first lien >=$75k → allowed');
ok(prohibited({ state: 'VA', units: 1, lien: 'first', loanAmount: 74999 }), 'VA: 1-4 first lien <$75k → prohibited');
ok(prohibited({ state: 'VA', units: 1, lien: 'junior', loanAmount: 400000 }), 'VA: junior lien → prohibited');
ok(!prohibited({ state: 'VA', units: 5, loanAmount: 50000 }), 'VA: 5+ units → standard');

// ---- restricted states are NOT disqualifiers (a cap is not a prohibition) ----------------------
ok(!prohibited({ state: 'MD', units: 1, loanAmount: 400000 }) && res({ state: 'MD', units: 1, loanAmount: 400000 }) === 'restricted', 'MD: restricted (3yr max) → not a disqualifier');
ok(!prohibited({ state: 'RI', units: 2, loanAmount: 400000 }) && res({ state: 'RI', units: 2, loanAmount: 400000 }) === 'restricted', 'RI: restricted (1yr max) → not a disqualifier');
ok(res({ state: 'MI', units: 1, lien: 'first', loanAmount: 400000 }) === 'restricted' && res({ state: 'MI', units: 1, lien: 'junior', loanAmount: 400000 }) === 'standard', 'MI: 1-unit first lien restricted; junior standard');

// ---- borrower-type normalization ---------------------------------------------------------------
ok(normBorrowerType('LLC') === 'business_entity' && normBorrowerType('Corporation') === 'business_entity' && normBorrowerType('Trust') === 'business_entity', 'normBorrowerType: LLC/Corp/Trust → business_entity');
ok(normBorrowerType('Individual') === 'natural_person' && normBorrowerType('Natural Person') === 'natural_person', 'normBorrowerType: Individual/Natural Person → natural_person');
ok(normBorrowerType('') === null && normBorrowerType(undefined) === null, 'normBorrowerType: blank/unknown → null (wildcard)');

// ---- fail-open: a restriction state whose rule needs a missing fact treats as allowed, matched:false --
const missing = pppResult({ state: 'NJ', units: 1, loanAmount: 400000 }); // borrowerType absent
ok(missing.result === 'standard' && missing.matched === false, 'NJ with borrowerType absent → fail-open to standard, matched:false (never invents a prohibition)');

// ---- cross-check the engine rules against the decoded PPP JSON ---------------------------------
const jsonPath = path.join(__dirname, '..', 'docs', 'longterm', 'ppe-research', 'matrices', 'deephaven-ppp-matrix.json');
const J = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let ruleDrift = 0; const driftMsg = [];
for (const [st, spec] of Object.entries(J.states)) {
  if (typeof spec === 'string') { if (STATE_RULES[st]) { ruleDrift += 1; driftMsg.push(`${st} standard in JSON but has engine rules`); } continue; }
  const eng = STATE_RULES[st];
  if (!eng || eng.length !== spec.rules.length) { ruleDrift += 1; driftMsg.push(`${st} rule count ${eng ? eng.length : 'none'} vs JSON ${spec.rules.length}`); continue; }
  spec.rules.forEach((jr, i) => { if (eng[i].result !== jr.result) { ruleDrift += 1; driftMsg.push(`${st}[${i}] result ${eng[i].result} vs ${jr.result}`); } });
}
ok(ruleDrift === 0, `every restriction state's engine rules match the decoded PPP JSON (${ruleDrift} drifts${driftMsg.length ? ': ' + driftMsg.slice(0, 3).join('; ') : ''})`);

// ---- disqualifier carries a real citation + code ----------------------------------------------
const dq = pppDisqualifier({ state: 'NJ', borrowerType: 'Individual', units: 1, loanAmount: 400000, prepayRequested: true });
ok(dq && dq.code === 'dhvn_ppp_prohibited_nj' && dq.dimension === 'prepay_state' && /New Jersey|NJ/.test(dq.declineReason) && /PPP/.test(dq.citation), 'the NJ disqualifier carries a state-coded id, dimension, plain reason and a matrix citation');

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
