'use strict';
/**
 * P2 (bridges P1) — pure tests for the EXPANDED RTL classifier taxonomy added
 * 2026-07-22. Proves each newly-covered family classifies from realistic text +
 * a filename, that a REVISED appraisal beats a plain appraisal, that a mortgage
 * statement is not confused with a bank statement or a payoff, and that each new
 * family has a routing profile so P1 knows how to read it.
 */
const assert = require('assert');
const { classify } = require('../src/lib/underwriting/classify');
const rm = require('../src/lib/ai/routing-matrix');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

const cases = [
  ['cpl', 'This Closing Protection Letter is issued by the title underwriter to the insured closing agent.', 'CPL.pdf'],
  ['appraisal_revision', 'Reconsideration of Value — revised appraisal report updating the opinion of value.', 'appraisal_ROV.pdf'],
  ['lease', 'Residential Lease Agreement between landlord and tenant, monthly rent due on the first.', 'lease agreement.pdf'],
  ['mortgage_statement', 'Monthly Mortgage Statement — escrow account summary and amount due to your servicer.', 'mortgage statement.pdf'],
  ['entity_resolution', 'Borrowing Resolution — unanimous written consent of the members authorizing the loan and the authorized signer.', 'resolution.pdf'],
  ['draw_request', 'Draw Request number 3 — request for disbursement, percent complete per the inspection.', 'draw request.pdf'],
  ['experience_docs', 'Schedule of Real Estate Owned — track record of prior projects completed by the borrower.', 'REO schedule.pdf'],
];

for (const [want, text, filename] of cases) {
  const r = classify({ text, filename });
  assert.strictEqual(r.docType, want, `"${filename}" → ${want} (got ${r.docType})`);
  ok(`classifies ${want} from realistic text + filename`);
}

// --- a REVISED appraisal must NOT classify as a plain appraisal ---
let r = classify({ text: 'Reconsideration of value — this revised appraisal updates the sales comparison approach and after repair value.', filename: 'revised appraisal.pdf' });
assert.strictEqual(r.docType, 'appraisal_revision', 'a revised appraisal beats plain appraisal');
ok('a revised appraisal classifies as appraisal_revision, not appraisal');

// --- a mortgage statement is NOT a bank statement or a payoff ---
r = classify({ text: 'Monthly mortgage statement from your loan servicer — escrow account summary, principal balance, amount due.', filename: 'mortgage statement.pdf' });
assert.strictEqual(r.docType, 'mortgage_statement');
assert.notStrictEqual(r.docType, 'bank_statement');
assert.notStrictEqual(r.docType, 'payoff_statement');
ok('a mortgage statement is distinct from a bank statement and a payoff statement');

// --- every new family has a routing profile (so P1 can read it) ---
for (const fam of ['cpl', 'appraisal_revision', 'lease', 'mortgage_statement', 'entity_resolution', 'draw_request', 'experience_docs']) {
  const prof = rm.profileFor(fam);
  assert.ok(prof && ['low', 'medium', 'high'].includes(prof.materiality), `${fam} has a materiality`);
}
// numeric-critical new families get the mandatory challenger in a full plan
const p = rm.planRoute({ docType: 'mortgage_statement', pageCount: 3, availability: { azure: true, google: true, mistral: true } });
assert.ok(p.specialHandling.includes('mandatory_challenger'), 'mortgage_statement is numeric-critical → mandatory challenger');
ok('every new family has a routing profile; numeric ones get the mandatory challenger');

console.log(`\nP2 classify-taxonomy pure — ${passed} checks passed`);
