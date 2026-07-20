'use strict';
/** Unit tests for the document classifier (classify.js). Pure — no DB/AI. */
const assert = require('assert');
const { classify } = require('../src/lib/underwriting/classify');

const cases = [
  ['operating_agreement', 'This LIMITED LIABILITY COMPANY AGREEMENT of the members. The Managing Member shall... membership interest', 'oa.pdf'],
  ['ein_letter', 'INTERNAL REVENUE SERVICE. We assigned you an Employer Identification Number (EIN). CP 575 G', 'ein.pdf'],
  ['good_standing', 'CERTIFICATE OF GOOD STANDING. The Secretary of State certifies the entity is in good standing and active.', 'gs.pdf'],
  ['llc_formation', 'ARTICLES OF ORGANIZATION. Registered Agent: ... Organizer: ...', 'articles.pdf'],
  ['title', 'COMMITMENT FOR TITLE INSURANCE. Schedule A. Proposed Insured. Schedule B exceptions. Legal description.', 't.pdf'],
  ['insurance', 'ACORD EVIDENCE OF PROPERTY INSURANCE. Named Insured. Mortgagee clause ISAOA/ATIMA. Dwelling coverage.', 'acord.pdf'],
  ['flood', 'STANDARD FLOOD HAZARD DETERMINATION. Special Flood Hazard Area. FIRM panel. Flood zone AE.', 'flood.pdf'],
  ['settlement', 'ALTA SETTLEMENT STATEMENT. Cash to close. Disbursement date. Seller credit. Payoff.', 'alta.pdf'],
  ['bank_statement', 'Beginning balance ... Ending balance ... Statement period ... Deposits Withdrawals', 'stmt.pdf'],
  ['credit_report', 'CREDIT REPORT. FICO score 712. Tradeline. Experian Equifax TransUnion. Inquiries.', 'credit.pdf'],
  ['background_report', 'OFAC SANCTIONS SCREENING. Specially Designated Nationals (SDN) list. No watchlist hits. PEP.', 'ofac.pdf'],
  ['assignment', 'ASSIGNMENT OF CONTRACT. Assignor hereby assigns to Assignee. Assignment fee.', 'assign.pdf'],
  ['government_id', "DRIVER'S LICENSE. Department of Motor Vehicles. Date of birth. Class C. Expires.", 'dl.jpg'],
  ['purchase_contract', 'PURCHASE AND SALE AGREEMENT. Earnest money. Closing date. Seller and Buyer. Contingency.', 'psa.pdf'],
];

for (const [expected, text, filename] of cases) {
  const r = classify({ text, filename });
  assert.strictEqual(r.docType, expected, `expected ${expected}, got ${r.docType} (conf ${r.confidence}) for "${text.slice(0, 30)}…"`);
  assert.ok(r.confidence === 'high' || r.confidence === 'medium', `${expected} should classify with confidence, got ${r.confidence}`);
}

// Filename-only nudge when text is thin.
assert.strictEqual(classify({ text: 'signed and dated', filename: 'Operating Agreement - Maple Grove.pdf' }).docType, 'operating_agreement');

// Ambiguous/empty → no guess (docType null).
assert.strictEqual(classify({ text: 'hello world this is a random page', filename: 'doc.pdf' }).docType, null);
assert.strictEqual(classify({ text: '', filename: '' }).confidence, 'none');

// A strong signal beats generic noise from another type.
assert.strictEqual(classify({ text: 'ARTICLES OF ORGANIZATION for the LLC. seller buyer closing date earnest money', filename: '' }).docType, 'llc_formation');

// A scope of work / rehab budget is recognized (and not confused with the purchase contract).
assert.strictEqual(classify({ text: 'SCOPE OF WORK — rehab budget. Line item budget by contractor. Total renovation budget $60,000.', filename: 'SOW.pdf' }).docType, 'scope_of_work');

console.log('✓ test-underwriting-classify: document auto-classification cases pass');
