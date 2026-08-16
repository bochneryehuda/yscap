#!/usr/bin/env node
'use strict';
/**
 * Pure unit tests for the cure engine (src/lib/underwriting/cure.js). No DB.
 * Exercises the analyze() reasoning across every result state.
 */
const assert = require('assert');
const cure = require('../src/lib/underwriting/cure');

// A minimal intent used across the tests.
const idIntent = {
  primary_goal: 'Verify borrower identity',
  satisfaction_requirements: [
    { id: 'name_matches_file', label: 'Name matches', assertion: 'equals_file', fact_key: 'borrower.name' },
    { id: 'dob_matches_file',  label: 'DOB matches',  assertion: 'equals_file', fact_key: 'borrower.date_of_birth' },
    { id: 'photo_present',     label: 'Photo present', assertion: 'present',    fact_key: 'borrower.name' /* proxy */ },
  ],
};

// ---- All satisfied ----
{
  const twinFacts = {
    'borrower.name': { value_normalized: 'noach mendelovits', status: 'observed' },
    'borrower.date_of_birth': { value_normalized: '1985-05-12', status: 'observed' },
  };
  const r = cure.analyze({
    intent: idIntent,
    extractionFields: { name: 'Noach Mendelovits', dateOfBirth: '05/12/1985' },
    twinFacts,
  });
  assert.strictEqual(r.result, 'satisfied');
  assert.strictEqual(r.recommended_action, 'clear');
  assert.strictEqual(r.requirements.filter((x) => x.status === 'satisfied').length, 3);
}

// ---- Name mismatch → not_satisfied ----
{
  const twinFacts = { 'borrower.name': { value_normalized: 'noach mendelovits' } };
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'name_matches_file', label: 'Name matches', assertion: 'equals_file', fact_key: 'borrower.name' },
      ],
    },
    extractionFields: { name: 'Mutty Kaufman' },
    twinFacts,
  });
  assert.strictEqual(r.result, 'not_satisfied');
  // reason quotes normalized forms
  assert.ok(r.requirements[0].reason.toLowerCase().includes('mutty'), `reason mentions the observed name: ${r.requirements[0].reason}`);
}

// ---- Partial ----
{
  const twinFacts = {
    'borrower.name': { value_normalized: 'noach mendelovits' },
    'borrower.date_of_birth': { value_normalized: '1985-05-12' },
  };
  const r = cure.analyze({
    intent: idIntent,
    extractionFields: { name: 'Noach Mendelovits' /* dob missing */ },
    twinFacts,
  });
  assert.strictEqual(r.result, 'partially_satisfied');
}

// ---- Unable to determine (no fact + no extraction) ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'ein_present', label: 'EIN', assertion: 'present', fact_key: 'entity.ein' },
      ],
    },
    extractionFields: {},
    twinFacts: {},
  });
  assert.strictEqual(r.result, 'unable_to_determine');
}

// ---- OFAC clear ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'ofac_clear', label: 'OFAC clear', assertion: 'is_clear', fact_key: 'compliance.ofac_result' },
      ],
    },
    extractionFields: { ofacResult: 'clear' },
    twinFacts: {},
  });
  assert.strictEqual(r.result, 'satisfied');
}

// ---- OFAC confirmed match → not_satisfied ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'ofac_clear', label: 'OFAC clear', assertion: 'is_clear', fact_key: 'compliance.ofac_result' },
      ],
    },
    extractionFields: { ofacResult: 'Confirmed match — SDN' },
    twinFacts: {},
  });
  assert.strictEqual(r.result, 'not_satisfied');
  assert.ok(/confirmed/i.test(r.requirements[0].reason));
}

// ---- Flood zone triggers new finding ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'flood_policy_if_zone_a_or_v', label: 'Flood policy when in zone',
          assertion: 'flood_policy_when_in_zone', fact_key: 'property.flood_zone' },
      ],
    },
    extractionFields: { floodZone: 'AE' /* no floodPolicyNumber */ },
    twinFacts: {},
  });
  assert.strictEqual(r.result, 'creates_new_finding');
  assert.strictEqual(r.newFindings.length, 1);
  assert.strictEqual(r.newFindings[0].code, 'flood_policy_missing');
  assert.strictEqual(r.recommended_action, 'post_condition');
}

// ---- Insurance coverage < loan → not_satisfied ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'coverage_gte_loan', label: 'Coverage >= loan', assertion: 'gte_loan_amount', fact_key: 'insurance.coverage_amount' },
      ],
    },
    extractionFields: { coverageAmount: 400000 },
    twinFacts: {},
    expected: { loanAmount: 712500 },
  });
  assert.strictEqual(r.result, 'not_satisfied');
  assert.ok(r.requirements[0].reason.includes('400000') || r.requirements[0].reason.includes('712500'));
}

// ---- entity_screened_when_present — the whole truth table ----
//
// The four branches answer four DIFFERENT questions, and the distinction that
// matters is "the report says who it screened and our entity is not on the
// list" (a real gap, a finding) versus "the report does not say who it screened
// at all" (we could not tell, a human looks). Asserting the first while feeding
// a fixture that exercises the second is what this block used to do, and it had
// never passed: cure.js and this suite were added in the SAME commit (cc78975,
// #1127), so the two halves have disagreed from birth and the suite has never
// been in `npm test`. The rule is the half that is right — its no-data branch is
// deliberate and carries its own written reasoning ("that is unreadable, not
// unscreened"), which is the standing never-guess doctrine. So the fixtures move
// to the branch each one is actually asking about.
const screenIntent = {
  satisfaction_requirements: [
    { id: 'screened_entity', label: 'Entity screened', assertion: 'entity_screened_when_present' },
  ],
};

// (a) The report LISTS who it screened and the borrowing entity is not among
//     them. This is the real gap — and the only shape that raises the finding.
{
  const r = cure.analyze({
    intent: screenIntent,
    extractionFields: {
      subjectName: 'Noach Mendelovits',
      screenedParties: ['Noach Mendelovits', 'Mutty Kaufman Holdings LLC'],
    },
    twinFacts: {},
    subject: { entity_name: 'Yehuda Bochner LLC' },
  });
  assert.strictEqual(r.result, 'creates_new_finding');
  assert.strictEqual(r.newFindings[0].code, 'entity_not_screened');
  assert.strictEqual(r.recommended_action, 'post_condition');
}

// (b) Nothing anywhere says WHO was screened. Unreadable is not unscreened, so
//     this must NOT assert a gap and must NOT raise a finding — a human reads
//     the report. This is the fixture the old (a) actually supplied.
{
  const r = cure.analyze({
    intent: screenIntent,
    extractionFields: { subjectName: 'Noach Mendelovits' /* nothing about screening */ },
    twinFacts: {},
    subject: { entity_name: 'Yehuda Bochner LLC' },
  });
  assert.strictEqual(r.result, 'unable_to_determine');
  assert.strictEqual(r.newFindings.length, 0);
}

// (c) The report names ONE screened party in its header and it is not the
//     vesting entity — a plain mismatch a reviewer can read off the page, so it
//     is not_satisfied without minting a separate finding.
{
  const r = cure.analyze({
    intent: screenIntent,
    extractionFields: { entityName: 'Mutty Kaufman Holdings LLC' },
    twinFacts: {},
    subject: { entity_name: 'Yehuda Bochner LLC' },
  });
  assert.strictEqual(r.result, 'not_satisfied');
  assert.strictEqual(r.newFindings.length, 0);
  assert.ok(/Yehuda Bochner LLC/.test(r.requirements[0].reason), `reason names the vesting entity: ${r.requirements[0].reason}`);
}

// (d) The entity IS on the list — satisfied, however the name is spelled.
{
  const r = cure.analyze({
    intent: screenIntent,
    extractionFields: { screenedParties: ['Noach Mendelovits', 'Yehuda Bochner LLC'] },
    twinFacts: {},
    subject: { entity_name: 'Yehuda Bochner LLC' },
  });
  assert.strictEqual(r.result, 'satisfied');
  assert.strictEqual(r.newFindings.length, 0);
}

// (e) No borrowing entity on the file at all — nothing to screen.
{
  const r = cure.analyze({
    intent: screenIntent,
    extractionFields: {},
    twinFacts: {},
    subject: {},
  });
  assert.strictEqual(r.result, 'satisfied');
}

// ---- Undocumented deposits ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'no_undisclosed_large_deposits', label: 'No undocumented deposits',
          assertion: 'no_undocumented_deposits' },
      ],
    },
    extractionFields: { largeDeposits: [{ amount: 175000, source: '' }, { amount: 20000, source: 'W-2 employer' }] },
    twinFacts: {},
  });
  assert.strictEqual(r.result, 'creates_new_finding');
  assert.strictEqual(r.newFindings[0].code, 'undocumented_large_deposit');
}

// ---- Statement period covers required months ----
{
  const r = cure.analyze({
    intent: {
      satisfaction_requirements: [
        { id: 'period', label: 'Period covers months', assertion: 'statement_period_covers_months' },
      ],
    },
    extractionFields: { periodStart: '2026-05-01', periodEnd: '2026-07-01' },
    twinFacts: {},
    expected: { requiredMonths: 2 },
  });
  assert.strictEqual(r.result, 'satisfied');
}

console.log('test-cure-pure: analyze reasoning across all result states pass');
