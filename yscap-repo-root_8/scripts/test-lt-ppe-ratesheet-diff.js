'use strict';
/**
 * Pure offline test for the LT PPE rate-sheet change detection (src/longterm/ppe/ratesheet-diff.js).
 *   node scripts/test-lt-ppe-ratesheet-diff.js
 */

const assert = require('assert');
const D = require('../src/longterm/ppe/ratesheet-diff');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

// ---- canonicalize: key order + volatile strip ------------------------------
(() => {
  const a = D.hashCell({ b: 1, a: 2, requestId: 'x1', ts: 111 });
  const b = D.hashCell({ a: 2, b: 1, requestId: 'x2', ts: 999 });
  eq(a, b, 'canonical hash ignores key order and volatile fields');
  ok(a !== D.hashCell({ a: 2, b: 3 }), 'a real value change changes the hash');
})();

// ---- canonicalize: number rounding -----------------------------------------
(() => {
  eq(D.hashCell(102.4, { roundTo: 1 }), D.hashCell(102, { roundTo: 1 }), 'rounds to integer with roundTo 1');
  ok(D.hashCell(102.4, { roundTo: 0.1 }) !== D.hashCell(102, { roundTo: 0.1 }), 'finer rounding keeps the difference');
})();

// ---- diff: added / removed / changed / unchanged ---------------------------
(() => {
  const prev = { 'llpa/ca/fico_720/ltv_75': 500, 'llpa/ca/fico_700/ltv_80': 250, 'base/30yr/7.0': 102850, gone: 1 };
  const next = { 'llpa/ca/fico_720/ltv_75': 500, 'llpa/ca/fico_700/ltv_80': 375, 'base/30yr/7.0': 102850, fresh: 9 };
  const d = D.diffRulesets(prev, next);
  eq(d.rebaselined, false, 'not a rebaseline');
  assert.deepStrictEqual(d.added, ['fresh'], 'added detected'); n += 1;
  assert.deepStrictEqual(d.removed, ['gone'], 'removed detected'); n += 1;
  eq(d.changed.length, 1, 'one changed cell');
  eq(d.changed[0].key, 'llpa/ca/fico_700/ltv_80', 'the right cell changed');
  eq(d.changed[0].before, 250, 'before carried');
  eq(d.changed[0].after, 375, 'after carried');
  eq(d.unchanged, 2, 'two unchanged cells');
})();

// ---- diff: canonicalizer version bump -> rebaseline ------------------------
(() => {
  const d = D.diffRulesets({ a: 1 }, { a: 2 }, { canonicalizerVersion: 2, prevCanonicalizerVersion: 1 });
  eq(d.rebaselined, true, 'a canonicalizer bump is a rebaseline, not a data change');
  eq(d.changed.length, 0, 'no per-cell changes emitted on rebaseline');
})();

// ---- classify: numeric within bounds -> auto-apply -------------------------
(() => {
  const diff = { changed: [{ key: 'base/30yr/7.0', before: 102850, after: 102900 }], added: [], removed: [] };
  const c = D.classifyDiff(diff, { maxDeltaMilli: 250, maxPct: 0.05 });
  eq(c.autoApply.length, 1, 'a small numeric refresh auto-applies');
  eq(c.review.length, 0, 'nothing to review');
  eq(c.autoApply[0].delta, 50, 'delta computed');
})();

// ---- classify: delta over the absolute bound -> review ---------------------
(() => {
  const diff = { changed: [{ key: 'base/30yr/7.0', before: 102850, after: 103500 }], added: [], removed: [] };
  const c = D.classifyDiff(diff, { maxDeltaMilli: 250, maxPct: 1 });
  eq(c.autoApply.length, 0, 'over the absolute delta -> not auto');
  eq(c.review.length, 1, 'routed to review');
  ok(c.review[0].reason.includes('exceeds'), 'review reason names the bound');
})();

// ---- classify: delta over the percent bound -> review ----------------------
(() => {
  const diff = { changed: [{ key: 'base/30yr/7.0', before: 1000, after: 1200 }], added: [], removed: [] };
  const c = D.classifyDiff(diff, { maxDeltaMilli: 100000, maxPct: 0.05 });
  eq(c.review.length, 1, '20% change exceeds 5% -> review');
  ok(c.review[0].reason.includes('%'), 'percent reason');
})();

// ---- classify: a rule (non-numeric) change -> review -----------------------
(() => {
  const diff = { changed: [{ key: 'elig/ca/max_ltv', before: { max: 80 }, after: { max: 75 } }], added: [], removed: [] };
  const c = D.classifyDiff(diff);
  eq(c.autoApply.length, 0, 'a structured rule change never auto-applies');
  eq(c.review[0].kind, 'rule', 'classified as a rule change');
})();

// ---- classify: added/removed always review ---------------------------------
(() => {
  const c = D.classifyDiff({ changed: [], added: ['new/cell'], removed: ['old/cell'] });
  eq(c.review.length, 2, 'add + remove both reviewed');
})();

// ---- classify: bulk change escalates everything ----------------------------
(() => {
  const changed = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, before: 100, after: 101 }));
  const c = D.classifyDiff({ changed, added: [], removed: [] }, { maxCellsChanged: 5, maxDeltaMilli: 250 });
  eq(c.bulkEscalated, true, 'too many cells -> bulk escalated');
  eq(c.autoApply.length, 0, 'nothing auto-applies on a suspected bad fetch');
  eq(c.review.length, 10, 'all changes routed to review');
  ok(c.review[0].reason.includes('bulk'), 'reason names the bulk escalation');
})();

// ---- monotonicity guardrail -------------------------------------------------
(() => {
  const ok1 = D.priceMonotonicityViolations([{ rate: 7000, price: 100000 }, { rate: 7250, price: 101000 }, { rate: 7500, price: 102000 }]);
  eq(ok1.length, 0, 'price rising with rate is monotonic');
  const bad = D.priceMonotonicityViolations([{ rate: 7000, price: 100000 }, { rate: 7250, price: 99000 }]);
  eq(bad.length, 1, 'a price that falls as rate rises is a violation');
  eq(bad[0].higherRate, 7250, 'violation names the higher rate');
  const tol = D.priceMonotonicityViolations([{ rate: 7000, price: 100000 }, { rate: 7250, price: 99990 }], { tolerance: 20 });
  eq(tol.length, 0, 'a tiny inversion within tolerance is allowed');
})();

// ---- end-to-end: two sheets -> diff -> classify ----------------------------
(() => {
  const y = { 'base/30/7.0': 102850, 'base/30/7.25': 101500, 'llpa/cashout/ca': 500, 'elig/ny': { allowed: false } };
  const t = { 'base/30/7.0': 102900, 'base/30/7.25': 101500, 'llpa/cashout/ca': 500, 'elig/ny': { allowed: true } };
  const diff = D.diffRulesets(y, t);
  eq(diff.changed.length, 2, 'two cells changed (a base price + an eligibility rule)');
  const c = D.classifyDiff(diff, { maxDeltaMilli: 250, maxPct: 0.05, maxCellsChanged: 100 });
  eq(c.autoApply.length, 1, 'the small base-price move auto-applies');
  eq(c.review.length, 1, 'the eligibility flip goes to review');
  eq(c.review[0].kind, 'rule', 'the NY eligibility change is a rule change');
})();

console.log(`ok - lt ppe ratesheet-diff (${n} assertions)`);
