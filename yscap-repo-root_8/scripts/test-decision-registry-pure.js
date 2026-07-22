'use strict';
/**
 * R6.9 + R6.14 — pure tests for the finding registry + final-decision resolver.
 * Guarantees: duplicate findings merge to one at MAX severity with all sources;
 * and the decision gates every action correctly — MANUAL_PENDING / stale /
 * data-conflict / fatal-finding each block the right actions.
 */
const assert = require('assert');
const reg = require('../src/lib/underwriting/finding-registry');
const dec = require('../src/lib/underwriting/decision');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- finding registry ---
const findings = [
  { code: 'entity_name_mismatch', subject: 'ABC LLC', severity: 'warning', source: 'entity_chain', title: 'Entity name differs' },
  { code: 'entity_name_mismatch', subject: 'ABC LLC', severity: 'fatal', source: 'appraisal', blocks_ctc: true }, // same issue, higher severity, another desk
  { code: 'price_mismatch', subject: 'purchase', severity: 'warning', source: 'tieout' },
];
const consolidated = reg.consolidate(findings);
assert.strictEqual(consolidated.length, 2, 'the two entity_name_mismatch rows merge to one');
const merged = consolidated.find((f) => f.code === 'entity_name_mismatch');
assert.strictEqual(merged.severity, 'fatal', 'merged to MAX severity');
assert.deepStrictEqual(merged.sources.sort(), ['appraisal', 'entity_chain'], 'both sources kept');
assert.strictEqual(merged.blocks_ctc, true, 'blocks_ctc ORs to true');
assert.strictEqual(consolidated[0].severity, 'fatal', 'ordered fatal-first');
ok('duplicate findings merge to one at MAX severity with every source (blocks OR together)');

const sum = reg.summarize(consolidated);
assert.strictEqual(sum.fatal, 1);
assert.strictEqual(sum.hasFatal, true);
assert.strictEqual(sum.blocksCtc, true, 'a fatal finding blocks CTC');
ok('summarize counts severities + rolls up blocking');

// --- decision resolver ---
// ELIGIBLE + no findings → everything eligible.
let d = dec.decide({ engineStatus: 'ELIGIBLE', findings: [] });
assert.strictEqual(d.status, 'ELIGIBLE');
assert.strictEqual(d.termSheetEligible, true);
assert.strictEqual(d.ctcEligible, true);
assert.strictEqual(d.fundingEligible, true);
ok('ELIGIBLE + clean → term sheet + CTC + funding all eligible');

// MANUAL pending → nothing issuable.
d = dec.decide({ engineStatus: 'MANUAL', manualApproved: false, findings: [] });
assert.strictEqual(d.status, 'MANUAL_PENDING');
assert.strictEqual(d.termSheetEligible, false, 'MANUAL_PENDING cannot issue a term sheet');
assert.strictEqual(d.ctcEligible, false);
assert.strictEqual(d.fundingEligible, false);
assert.ok(d.reasons.some((r) => /super-admin/.test(r)));
ok('MANUAL pending → no term sheet / CTC / funding (the critical rule)');

// MANUAL approved → issuable.
d = dec.decide({ engineStatus: 'MANUAL', manualApproved: true, findings: [] });
assert.strictEqual(d.status, 'MANUAL_APPROVED');
assert.strictEqual(d.termSheetEligible, true);
ok('MANUAL approved → issuable');

// a data conflict (source disagreement) → DATA_CONFLICT, blocks CTC + funding.
d = dec.decide({ engineStatus: 'ELIGIBLE', discrepancies: [{ field: 'loan_amount' }], findings: [] });
assert.strictEqual(d.status, 'DATA_CONFLICT');
assert.strictEqual(d.ctcEligible, false);
assert.strictEqual(d.fundingEligible, false);
ok('a source-of-truth disagreement → DATA_CONFLICT, blocks CTC + funding');

// a fatal finding blocks CTC + funding even when ELIGIBLE.
d = dec.decide({ engineStatus: 'ELIGIBLE', findings: [{ code: 'x', severity: 'fatal', source: 'appraisal' }] });
assert.strictEqual(d.status, 'ELIGIBLE', 'status still eligible…');
assert.strictEqual(d.ctcEligible, false, '…but a fatal finding blocks CTC');
assert.strictEqual(d.fundingEligible, false);
assert.strictEqual(d.termSheetEligible, true, 'a fatal finding that does not block the term sheet still lets it issue');
assert.ok(d.blockingFindings.length >= 1);
ok('a fatal finding blocks CTC + funding even under ELIGIBLE');

// funding from a stale RUN is blocked.
d = dec.decide({ engineStatus: 'ELIGIBLE', staleRun: true, findings: [] });
assert.strictEqual(d.fundingEligible, false, 'funding from a stale run is blocked');
assert.strictEqual(d.termSheetEligible, true);
ok('funding from a stale run is blocked');

// stale REGISTRATION → STALE status, nothing issuable.
d = dec.decide({ engineStatus: 'ELIGIBLE', staleRegistration: true, findings: [] });
assert.strictEqual(d.status, 'STALE');
assert.strictEqual(d.termSheetEligible, false);
ok('a stale registration → STALE, not issuable');

console.log(`\nR6.9 + R6.14 decision + registry pure — ${passed} checks passed`);
