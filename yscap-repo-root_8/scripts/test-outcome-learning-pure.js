'use strict';
/**
 * P5 — pure tests for outcome-based learning + causal postmortems.
 * Proves the module (1) classifies a realized loan outcome as good/bad/neutral,
 * (2) names the FIRST bad decision in an ordered decision chain (and the
 * downstream decisions it poisoned) without guessing on an ungraded chain,
 * (3) aggregates a portfolio into a defect rate + first-bad-component histogram,
 * and (4) turns recurring first-bad components into sample-gated ADVISORY
 * learning signals. Nothing here changes a decision.
 */
const assert = require('assert');
const ol = require('../src/lib/underwriting/outcome-learning');

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- classifyOutcome: good / bad / neutral + severity weight ---
let c = ol.classifyOutcome({ outcome: 'funded_performing' });
assert.strictEqual(c.good, true); assert.strictEqual(c.bad, false); assert.strictEqual(c.weight, 0);
c = ol.classifyOutcome('repurchase');
assert.strictEqual(c.bad, true); assert.strictEqual(c.weight, 5, 'a repurchase is the costliest bad outcome');
c = ol.classifyOutcome('Investor Rejected'); // normalization: spaces/case
assert.strictEqual(c.code, 'investor_rejected'); assert.strictEqual(c.bad, true); assert.strictEqual(c.weight, 2);
c = ol.classifyOutcome('declined');
assert.strictEqual(c.quality, 'neutral', 'a decline carries no outcome-quality signal on its own');
assert.strictEqual(c.bad, false); assert.strictEqual(c.good, false);
c = ol.classifyOutcome('something_we_never_heard_of');
assert.strictEqual(c.known, false); assert.strictEqual(c.bad, false, 'an unknown outcome is never guessed into a defect');
ok('classifyOutcome maps good/bad/neutral + severity weight and never guesses an unknown into a defect');

// --- firstBadDecision: the first domino + what it poisoned ---
let fb = ol.firstBadDecision([
  { component: 'ocr', decision: 'read balance', correct: true },
  { component: 'field_extraction', decision: 'ending balance $42k', correct: false }, // <-- first bad
  { component: 'deterministic_rule', decision: 'liquidity ok', correct: false },       // poisoned by the above
  { component: 'ai_reasoning', decision: 'approve', correct: false },                  // poisoned
]);
assert.strictEqual(fb.component, 'field_extraction', 'the first wrong decision is the first bad decision');
assert.strictEqual(fb.index, 1);
assert.strictEqual(fb.artifact, 'schema', 'field_extraction maps to the schema artifact');
assert.strictEqual(fb.poisonedDownstream.length, 2, 'the two later wrong decisions are downstream of the first');
assert.strictEqual(fb.poisonedDownstream[0].component, 'deterministic_rule');
ok('firstBadDecision names the earliest wrong decision, its artifact, and the downstream it poisoned');

// an ungraded / all-correct chain returns null — never invent a culprit
assert.strictEqual(ol.firstBadDecision([{ component: 'ocr', correct: true }, { component: 'ai_reasoning' }]), null,
  'nothing graded wrong → no first bad decision (request instrumentation, do not guess)');
assert.strictEqual(ol.firstBadDecision([]), null);
assert.strictEqual(ol.firstBadDecision(null), null);
ok('firstBadDecision returns null on an all-correct or ungraded chain (never guesses)');

// a component with no taxonomy mapping still names the component, artifact null
fb = ol.firstBadDecision([{ component: 'some_custom_step', correct: false }]);
assert.strictEqual(fb.component, 'some_custom_step');
assert.strictEqual(fb.artifact, null, 'an unknown component maps to no artifact (do not fabricate a target)');
ok('an unmapped first-bad component names the component but fabricates no artifact');

// --- aggregateOutcomes: portfolio rollup ---
const records = [
  { fileId: 'A', outcome: 'funded_performing' },                                                                 // good
  { fileId: 'B', outcome: 'paid_off' },                                                                          // good
  { fileId: 'C', outcome: 'declined' },                                                                          // neutral
  { fileId: 'D', outcome: 'withdrawn' },                                                                         // neutral
  { fileId: 'E', outcome: 'post_closing_defect', defectType: 'missing_page',
    decisions: [{ component: 'ocr', correct: true }, { component: 'field_extraction', correct: false }] },       // bad, first=field_extraction
  { fileId: 'F', outcome: 'investor_rejected', investorRejectReason: 'ltv_too_high',
    decisions: [{ component: 'field_extraction', correct: false }] },                                            // bad, first=field_extraction
  { fileId: 'G', outcome: 'early_default',
    decisions: [{ component: 'guideline_selection', correct: false }] },                                         // bad, first=guideline_selection
  { fileId: 'H', outcome: 'repurchase', decisions: [{ component: 'ocr', correct: true }] },                      // bad but NOT isolated (nothing wrong tagged)
];
const agg = ol.aggregateOutcomes(records);
assert.strictEqual(agg.total, 8);
assert.strictEqual(agg.good, 2);
assert.strictEqual(agg.bad, 4);
assert.strictEqual(agg.neutral, 2);
assert.strictEqual(agg.graded, 6, 'graded = good + bad (neutrals excluded)');
assert.strictEqual(agg.defectRate, +(4 / 6).toFixed(4), 'defect rate is bad over graded');
assert.strictEqual(agg.isolatedBad, 3, 'three bad loans had a first bad decision we could isolate');
assert.strictEqual(agg.unisolatedBad, 1, 'the repurchase had no wrong decision tagged — uncounted, not guessed');
assert.strictEqual(agg.firstBadByComponent.field_extraction, 2);
assert.strictEqual(agg.firstBadByComponent.guideline_selection, 1);
assert.strictEqual(agg.investorRejectReasons.ltv_too_high, 1);
assert.strictEqual(agg.defectTypes.missing_page, 1);
// weighted defect score = Σ weight of bad / graded = (3 + 2 + 4 + 5) / 6
assert.strictEqual(agg.weightedDefectScore, +((3 + 2 + 4 + 5) / 6).toFixed(4), 'weighted score is severity-aware');
ok('aggregateOutcomes rolls up good/bad/neutral, defect rate, weighted score, and the first-bad histogram');

// --- learningSignals: sample-gated advisory proposals ---
// With the tiny corpus above, minSample 3 surfaces nothing (never learn from 1-2).
assert.strictEqual(ol.learningSignals(agg, { minSample: 3 }).length, 0, 'below the sample floor, no signal is surfaced');
// Lower the floor to prove the ranking + recommendation shape.
let sig = ol.learningSignals(agg, { minSample: 2 });
assert.strictEqual(sig.length, 1, 'only field_extraction (2 defects) clears a floor of 2');
assert.strictEqual(sig[0].component, 'field_extraction');
assert.strictEqual(sig[0].count, 2);
assert.strictEqual(sig[0].artifact, 'schema');
assert.strictEqual(sig[0].share, +(2 / 3).toFixed(4), 'share of isolated defects');
assert.ok(/schema artifact/.test(sig[0].recommendation) && /Advisory only/.test(sig[0].recommendation));
ok('learningSignals is sample-gated, ranked, artifact-targeted, and explicitly advisory');

// ranking: a bigger corpus ranks the most-recurring component first
const big = ol.aggregateOutcomes([
  ...Array.from({ length: 5 }, (_, i) => ({ fileId: `x${i}`, outcome: 'post_closing_defect', decisions: [{ component: 'classification', correct: false }] })),
  ...Array.from({ length: 3 }, (_, i) => ({ fileId: `y${i}`, outcome: 'investor_rejected', decisions: [{ component: 'ocr', correct: false }] })),
]);
sig = ol.learningSignals(big, { minSample: 3 });
assert.strictEqual(sig.length, 2);
assert.strictEqual(sig[0].component, 'classification', 'the most-recurring first-bad component ranks first');
assert.strictEqual(sig[0].severity, 'high', '5 of 8 isolated defects (>50%) is high severity');
ok('learningSignals ranks the most-recurring first-bad component first and grades severity by share');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => ol.aggregateOutcomes(null));
assert.strictEqual(ol.aggregateOutcomes([]).total, 0);
assert.strictEqual(ol.aggregateOutcomes([]).defectRate, 0);
assert.deepStrictEqual(ol.learningSignals(null), []);
assert.deepStrictEqual(ol.learningSignals({}), []);
ok('empty / null input is safe (never throws)');

console.log(`\nP5 outcome-learning pure — ${passed} checks passed`);
