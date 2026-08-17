'use strict';
/**
 * Pure offline test for LT PPE daily Lender-Price DRIFT classification (src/longterm/ppe/lp-drift.js).
 *   node scripts/test-lt-lp-drift-pure.js
 *
 * Proves the two guarantees the owner's policy split demands:
 *   1. BASE_RATE vs RULE_CHANGE — a base-rate cell is auto-applyable; a rule/LLPA/eligibility/PPP cell
 *      goes to human review ALWAYS, even when the rule change is a plain NUMBER (this is what makes it
 *      different from the generic numeric classifier), and the two channels are NEVER mixed.
 *   2. ESCALATE, NEVER DROP — every touched base-rate cell is either applied or escalated; none vanish.
 * Mutation-proven: see the report for the exact production lines broken to turn each assertion red.
 */

const assert = require('assert');
const D = require('../src/longterm/ppe/lp-drift');
const RQ = require('../src/longterm/ppe/review-queue');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const snap = (baseRates, fingerprint) => ({ baseRates: baseRates || {}, fingerprint: fingerprint || {} });

// ---- 1. a small base-rate move auto-applies; a base-rate move is NEVER a rule item ----------------
(() => {
  const prev = snap({ 'base/30yr/7.0': 102850, 'base/30yr/7.25': 101500 });
  const next = snap({ 'base/30yr/7.0': 102900, 'base/30yr/7.25': 101500 });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1000 }, { maxDeltaMilli: 250, maxPct: 0.05 });
  eq(r.applied.length, 1, 'the small base-rate refresh is auto-applied');
  eq(r.applied[0].key, 'base/30yr/7.0', 'the right base-rate cell');
  eq(r.applied[0].delta, 50, 'delta carried');
  eq(r.review.length, 0, 'a safe base-rate refresh produces NO review item');
})();

// ---- 2. THE POLICY SPLIT: a NUMERIC LLPA change goes to review, never auto-applied -----------------
(() => {
  // The LLPA move is small and numeric — the generic classifier would auto-apply it. The policy split
  // must NOT: an LLPA is a rule change, human review always.
  const prev = snap({}, { 'llpa/ca/fico_720/ltv_75': 500 });
  const next = snap({}, { 'llpa/ca/fico_720/ltv_75': 525 });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1 }, { maxDeltaMilli: 100000, maxPct: 1 });
  eq(r.applied.length, 0, 'an LLPA change is NEVER auto-applied, even a tiny numeric one');
  eq(r.review.length, 1, 'the LLPA change goes to review');
  eq(r.review[0].dimension, D.DIMENSION.LLPA, 'classified as an LLPA change');
  eq(r.review[0].kind, 'llpa_change', 'LLPA finding kind');
  eq(r.review[0].channel, 'rule', 'lives in the rule channel, never the base-rate channel');
})();

// ---- 3. eligibility + PPP changes are rule reviews, dimension-labelled -----------------------------
(() => {
  const prev = snap({}, { 'elig/ny': { allowed: true }, 'ppp/5yr': { allowed: true } });
  const next = snap({}, { 'elig/ny': { allowed: false }, 'ppp/5yr': { allowed: false } });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1 });
  eq(r.review.length, 2, 'both rule changes go to review');
  const dims = r.review.map((x) => x.dimension).sort();
  assert.deepStrictEqual(dims, ['eligibility', 'ppp'], 'eligibility + PPP dimensions'); n += 1;
  ok(r.review.every((x) => x.channel === 'rule'), 'both in the rule channel');
})();

// ---- 4. an unknown fingerprint dimension FAILS CLOSED to a rule review (never auto-anything) -------
(() => {
  const prev = snap({}, { 'mystery/thing': 1 });
  const next = snap({}, { 'mystery/thing': 2 });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1 });
  eq(r.review.length, 1, 'an unrecognised rule cell still surfaces');
  eq(r.review[0].dimension, D.DIMENSION.RULE, 'unknown dimension -> RULE (fail closed)');
})();

// ---- 5. ESCALATE-DON'T-DROP: a base-rate cell over the guardrail is escalated, not applied, not lost
(() => {
  const prev = snap({ 'base/30yr/7.0': 102850, 'base/30yr/7.25': 101500, 'base/30yr/7.5': 100000 });
  const next = snap({ 'base/30yr/7.0': 102900, 'base/30yr/7.25': 108000, 'base/30yr/7.5': 100000 });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1 }, { maxDeltaMilli: 250, maxPct: 0.05 });
  eq(r.applied.length, 1, 'only the in-bounds base-rate cell auto-applies');
  eq(r.applied[0].key, 'base/30yr/7.0', 'the safe cell');
  eq(r.review.length, 1, 'the out-of-bounds base-rate cell is ESCALATED to review');
  eq(r.review[0].dimension, D.DIMENSION.BASE_RATE, 'escalated item keeps the base_rate dimension');
  eq(r.review[0].kind, 'base_rate_escalated', 'escalated kind — surfaced, never silently low');
  ok(r.summary.coverageOk, 'coverage balanced: nothing dropped');
})();

// ---- 6. an ADDED / REMOVED base-rate cell is escalated (a structural change is never auto-applied) -
(() => {
  const prev = snap({ 'base/30yr/7.0': 102850, 'base/30yr/gone': 99000 });
  const next = snap({ 'base/30yr/7.0': 102850, 'base/30yr/fresh': 98000 });
  const auto = D.autoApplyBaseRates(D.detectDrift(prev, next).baseRate, { maxDeltaMilli: 250, maxPct: 0.05 });
  eq(auto.applied.length, 0, 'no numeric refresh here — nothing auto-applies');
  eq(auto.escalated.length, 2, 'both the added and the removed cell are escalated');
  ok(auto.coverage.ok, 'coverage ok: 2 touched = 0 applied + 2 escalated');
  eq(auto.coverage.touched, 2, 'two cells touched');
})();

// ---- 7. the coverage invariant HOLDS on a mixed batch (applied + escalated === touched) ------------
(() => {
  const prev = snap({ a: 100, b: 100, c: 100, d: 100 });
  const next = snap({ a: 102, b: 100000, c: 'oops', /* d removed */ e: 5 });
  const auto = D.autoApplyBaseRates(D.detectDrift(prev, next).baseRate, { maxDeltaMilli: 250, maxPct: 0.05, maxCellsChanged: 100 });
  eq(auto.coverage.applied + auto.coverage.escalated, auto.coverage.touched, 'every touched base-rate cell is accounted for');
  ok(auto.coverage.ok, 'coverage flag true');
  // a=+2 (2%) applies; b over bound, c non-numeric, d removed, e added -> 4 escalate.
  eq(auto.applied.length, 1, 'only a applies');
  eq(auto.escalated.length, 4, 'b/c/d/e all escalate');
})();

// ---- 8. a bulk base-rate change (bad-fetch guard) escalates EVERYTHING, applies nothing ------------
(() => {
  const prevMap = {}; const nextMap = {};
  for (let i = 0; i < 10; i += 1) { prevMap[`base/k${i}`] = 100; nextMap[`base/k${i}`] = 101; }
  const r = D.detectAndClassify(snap(prevMap), snap(nextMap), { investor: 'X', nowMs: 1 }, { maxCellsChanged: 5, maxDeltaMilli: 250 });
  eq(r.applied.length, 0, 'a suspected bad fetch auto-applies nothing');
  eq(r.review.length, 10, 'all 10 base-rate cells are escalated for review');
  ok(r.summary.coverageOk, 'coverage still balanced under bulk escalation');
})();

// ---- 9. NEVER MIX: base rates + rules moving together stay in their own channels -------------------
(() => {
  const prev = snap({ 'base/30/7.0': 102850 }, { 'llpa/cashout/ca': 500 });
  const next = snap({ 'base/30/7.0': 102900 }, { 'llpa/cashout/ca': 600 });
  const r = D.detectAndClassify(prev, next, { investor: 'X', nowMs: 1 }, { maxDeltaMilli: 250, maxPct: 0.05, maxCellsChanged: 100 });
  eq(r.applied.length, 1, 'the base-rate move auto-applies');
  eq(r.applied[0].key, 'base/30/7.0', 'a base-rate key');
  eq(r.review.length, 1, 'the LLPA move is reviewed');
  eq(r.review[0].dimension, D.DIMENSION.LLPA, 'the review item is the LLPA, not the base rate');
  ok(!r.applied.some((a) => a.key.startsWith('llpa/')), 'no rule cell ever appears in the auto-apply set');
  ok(!r.review.some((x) => x.dimension === D.DIMENSION.BASE_RATE), 'no base-rate cell in the rule reviews here');
})();

// ---- 10. no change at all -> nothing applied, nothing to review ------------------------------------
(() => {
  const same = snap({ 'base/30/7.0': 102850 }, { 'llpa/ca': 500 });
  const r = D.detectAndClassify(same, JSON.parse(JSON.stringify(same)), { investor: 'X', nowMs: 1 });
  eq(r.applied.length, 0, 'nothing to apply');
  eq(r.review.length, 0, 'nothing to review');
})();

// ---- 11. the review items flow through the EXISTING review-queue ranker (no second queue) ---------
(() => {
  const prev = snap({}, { 'elig/ny': { allowed: true } });
  const next = snap({}, { 'elig/ny': { allowed: false } });
  const r = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1000 });
  const q = RQ.buildQueue(r.review, { nowMs: 2000 });
  eq(q.items.length, 1, 'the drift review item lands in the existing review queue');
  eq(q.items[0].severity, 'high', 'an unknown drift kind is surfaced at HIGH, never silently low');
  eq(q.summary.byInvestor.AcmeCap, 1, 'the queue rolls it up by investor');
})();

// ---- 12. a stable identity: the same drift on the next day is the SAME key (merges, not duplicates)
(() => {
  const prev = snap({}, { 'llpa/ca': 500 });
  const next = snap({}, { 'llpa/ca': 600 });
  const a = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 1 }).review[0].key;
  const b = D.detectAndClassify(prev, next, { investor: 'AcmeCap', nowMs: 999 }).review[0].key;
  eq(a, b, 'the same drift produces the same finding key regardless of when it was seen');
  ok(a.startsWith('lpdrift|acmecap|llpa|'), 'the key names investor + dimension + cell');
})();

console.log(`ok - lt lp drift (${n} assertions)`);
