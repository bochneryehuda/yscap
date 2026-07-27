#!/usr/bin/env node
'use strict';
/** Pure tests for src/lib/underwriting/identity-chain.js — no DB. */
const assert = require('assert');
const idc = require('../src/lib/underwriting/identity-chain');

// Clean identity — nothing should fire.
const clean = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerName: 'John Q Doe', borrowerDOB: '1980-05-01', borrowerSSN: '123-45-6789' } },
  { doc_type: 'credit_report', fields: { borrowerName: 'John Doe', borrowerDOB: '1980-05-01', borrowerSSN: '000-00-6789' } },
]);
assert.strictEqual(clean.issues.length, 0, 'same last-4 + initials-compat name → no fires');

// SSN last-4 disagreement → fatal.
const ssnMis = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerSSN: '123-45-6789' } },
  { doc_type: 'credit_report', fields: { borrowerSSN: '000-00-1111' } },
]);
assert.strictEqual(ssnMis.issues.length, 1);
assert.strictEqual(ssnMis.issues[0].code, 'identity_ssn_mismatch');
assert.strictEqual(ssnMis.issues[0].severity, 'fatal');

// DOB disagreement → warning.
const dobMis = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerDOB: '1980-05-01' } },
  { doc_type: 'tax_return', fields: { borrowerDOB: '1980-05-02' } },
]);
assert.strictEqual(dobMis.issues.length, 1);
assert.strictEqual(dobMis.issues[0].code, 'identity_dob_mismatch');

// Name variation — 'John Doe' vs 'Michael Smith' → info.
const nameMis = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerName: 'John Doe' } },
  { doc_type: 'insurance', fields: { borrowerName: 'Michael Smith' } },
]);
assert.strictEqual(nameMis.issues.length, 1);
assert.strictEqual(nameMis.issues[0].code, 'identity_name_variation');

// Initials tolerated — 'John Q Doe' vs 'J Q Doe' → no fire.
const initials = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerName: 'John Q Doe' } },
  { doc_type: 'insurance', fields: { borrowerName: 'J Q Doe' } },
]);
assert.strictEqual(initials.issues.filter(i => i.code === 'identity_name_variation').length, 0);

// Suffix tolerated — 'John Doe Jr' vs 'John Doe' → no fire.
const suffix = idc.analyze([
  { doc_type: 'drivers_license', fields: { borrowerName: 'John Doe Jr' } },
  { doc_type: 'insurance', fields: { borrowerName: 'John Doe' } },
]);
assert.strictEqual(suffix.issues.filter(i => i.code === 'identity_name_variation').length, 0);

// --- CO-BORROWER AWARENESS (owner-directed 2026-07-27) ---
// Two government IDs on a file with a primary + a co-borrower. Without `people`, the two names
// look like a variation of ONE borrower (the old garbage). WITH the known people, they are
// recognized as two different people and nothing fires.
const twoIds = [
  { doc_type: 'drivers_license', fields: { fullName: 'John Smith' } },
  { doc_type: 'drivers_license', fields: { fullName: 'Jane Doe' } },
];
assert.strictEqual(idc.analyze(twoIds).issues.length, 1, 'without known people → two IDs look like a name variation (unchanged)');
assert.strictEqual(idc.analyze(twoIds, { people: ['John Smith', 'Jane Doe'] }).issues.length, 0,
  'a co-borrower ID is NOT a variation of the primary once both people are known');
// Two SSNs on docs that resolve to DIFFERENT known people → each has their own SSN, no fraud flag.
const coSsn = [
  { doc_type: 'drivers_license', fields: { fullName: 'John Smith', borrowerSSN: '123-45-6789' } },
  { doc_type: 'tax_return', fields: { fullName: 'Jane Doe', borrowerSSN: '000-00-1111' } },
];
assert.strictEqual(idc.analyze(coSsn).issues.filter(i => i.code === 'identity_ssn_mismatch').length, 1, 'without people → two SSNs flag (unchanged)');
assert.strictEqual(idc.analyze(coSsn, { people: ['John Smith', 'Jane Doe'] }).issues.filter(i => i.code === 'identity_ssn_mismatch').length, 0,
  'two different known people each carrying their own SSN → no mismatch');
// A genuinely conflicting SSN on the SAME person (both docs name John) still fires even with people known.
const samePersonSsn = [
  { doc_type: 'drivers_license', fields: { fullName: 'John Smith', borrowerSSN: '123-45-6789' } },
  { doc_type: 'credit_report', fields: { borrowerName: 'John Smith', borrowerSSN: '000-00-1111' } },
];
assert.strictEqual(idc.analyze(samePersonSsn, { people: ['John Smith', 'Jane Doe'] }).issues.filter(i => i.code === 'identity_ssn_mismatch').length, 1,
  'one person with two different SSNs still flags (real fraud signal preserved)');

// Bridge shape.
let recorded = [];
require.cache[require.resolve('../src/lib/underwriting/ai-suggestions')] = { exports: {
  recordMany: async (_c, arr) => { recorded = arr; return { recorded: arr.length, deduped: 0, failed: 0 }; },
} };
delete require.cache[require.resolve('../src/lib/underwriting/identity-chain')];
const idc2 = require('../src/lib/underwriting/identity-chain');
(async () => {
  const r = await idc2.analyzeAndRecord({}, {
    applicationId: 'app-1',
    extractions: [
      { doc_type: 'drivers_license', fields: { borrowerSSN: '123-45-6789' } },
      { doc_type: 'credit_report', fields: { borrowerSSN: '000-00-1111' } },
    ],
  });
  assert.strictEqual(r.recorded, 1);
  assert.strictEqual(recorded[0].source, 'entity_chain');
  assert.strictEqual(recorded[0].evidence.layer, 'identity_chain');
  assert.ok(recorded[0].dedupeKey.startsWith('identity:identity_ssn_mismatch:'));
  console.log('test-identity-chain-pure: clean + ssn/dob/name + initials/suffix tolerance + bridge all pass');
})().catch(e => { console.error(e); process.exit(1); });
