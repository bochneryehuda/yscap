'use strict';
/**
 * R5.47 — pure tests for shadow-decision capture + disagreement review.
 * Proves it (1) normalizes many verdict spellings to a canonical bucket,
 * (2) classifies a FALSE CLEAR (AI cleared what the human declined) as the
 * dangerous, always-review-worthy case, (3) classifies a FALSE FLAG (AI declined
 * what the human cleared) as cautious/lower severity, (4) never invents a
 * disagreement from an unreadable verdict, (5) rolls a batch up into an agreement
 * rate + false-clear count (unknowns excluded from the rate), and (6) never throws.
 */
const assert = require('assert');
const sd = require('../src/lib/underwriting/shadow-decision');
const { CLASS, SEVERITY, VERDICT } = sd;

let passed = 0;
const ok = (n) => { console.log(`  ok  ${n}`); passed++; };

// --- verdict normalization ---
assert.strictEqual(sd.canonicalVerdict('Approved'), VERDICT.CLEAR);
assert.strictEqual(sd.canonicalVerdict('clear to close'), VERDICT.CLEAR);
assert.strictEqual(sd.canonicalVerdict(true), VERDICT.CLEAR);
assert.strictEqual(sd.canonicalVerdict('DENIED'), VERDICT.DECLINE);
assert.strictEqual(sd.canonicalVerdict(false), VERDICT.DECLINE);
assert.strictEqual(sd.canonicalVerdict('manual-review'), VERDICT.REFER);
assert.strictEqual(sd.canonicalVerdict('conditions'), VERDICT.REFER);
assert.strictEqual(sd.canonicalVerdict('banana'), VERDICT.UNKNOWN);
assert.strictEqual(sd.canonicalVerdict(''), VERDICT.UNKNOWN);
ok('verdict normalization maps many spellings (and booleans) to canonical clear/decline/refer/unknown');

// --- captureShadow normalizes + clamps confidence ---
let cap = sd.captureShadow({ component: 'liquidity', verdict: 'Approved', confidence: 1.4, evidenceSpanIds: ['s1'], runId: 'r9' });
assert.strictEqual(cap.verdict, VERDICT.CLEAR);
assert.strictEqual(cap.confidence, 1, 'confidence is clamped to [0,1]');
assert.deepStrictEqual(cap.evidenceSpanIds, ['s1']);
assert.strictEqual(cap.rawVerdict, 'Approved', 'the raw verdict is preserved');
ok('captureShadow normalizes the verdict, clamps confidence, preserves evidence + raw verdict');

// --- FALSE CLEAR: AI cleared, human DECLINED → high severity, always review-worthy ---
let r = sd.compareToHuman({ component: 'title', verdict: 'clear', confidence: 0.4 }, { verdict: 'declined' });
assert.strictEqual(r.class, CLASS.FALSE_CLEAR);
assert.strictEqual(r.severity, SEVERITY.HIGH);
assert.strictEqual(r.reviewWorthy, true, 'a false clear is ALWAYS review-worthy, even at low AI confidence');
assert.ok(/cleared what the underwriter declined/.test(r.reason));
ok('a FALSE CLEAR (AI cleared, human declined) is high-severity and always review-worthy');

// AI cleared, human REFERRED → still a false clear, medium severity
r = sd.compareToHuman({ component: 'title', verdict: 'clear' }, { verdict: 'refer' });
assert.strictEqual(r.class, CLASS.FALSE_CLEAR);
assert.strictEqual(r.severity, SEVERITY.MEDIUM);
assert.strictEqual(r.reviewWorthy, true, 'a false clear is review-worthy regardless of confidence');
ok('AI cleared what the human referred is a medium-severity false clear, still review-worthy');

// --- FALSE FLAG: AI declined, human cleared → medium severity, review-worthy only if confident ---
r = sd.compareToHuman({ component: 'income', verdict: 'declined', confidence: 0.4 }, { verdict: 'approved' });
assert.strictEqual(r.class, CLASS.FALSE_FLAG);
assert.strictEqual(r.severity, SEVERITY.MEDIUM);
assert.strictEqual(r.reviewWorthy, false, 'a low-confidence false flag is not forced into review');
r = sd.compareToHuman({ component: 'income', verdict: 'declined', confidence: 0.9 }, { verdict: 'approved' });
assert.strictEqual(r.reviewWorthy, true, 'a high-confidence disagreement IS review-worthy');
ok('a FALSE FLAG (AI declined, human cleared) is cautious/medium and review-worthy only when the AI was confident');

// --- AGREE ---
r = sd.compareToHuman({ component: 'x', verdict: 'approved' }, { verdict: 'clear to close' });
assert.strictEqual(r.class, CLASS.AGREE);
assert.strictEqual(r.reviewWorthy, false);
assert.strictEqual(r.severity, SEVERITY.NONE);
ok('two verdicts that canonicalize the same are AGREE (not review-worthy)');

// --- PARTIAL: neither cleared but differ ---
r = sd.compareToHuman({ component: 'x', verdict: 'declined' }, { verdict: 'refer' });
assert.strictEqual(r.class, CLASS.PARTIAL);
assert.strictEqual(r.severity, SEVERITY.LOW);
ok('AI declined vs human referred (neither a clear) is a low-severity PARTIAL disagreement');

// --- UNKNOWN: never invent a disagreement from an unreadable verdict ---
r = sd.compareToHuman({ component: 'x', verdict: 'gobbledygook' }, { verdict: 'declined' });
assert.strictEqual(r.class, CLASS.UNKNOWN);
assert.strictEqual(r.reviewWorthy, false, 'an unreadable AI verdict is not a false clear/flag');
r = sd.compareToHuman({ component: 'x', verdict: 'clear' }, { verdict: null });
assert.strictEqual(r.class, CLASS.UNKNOWN, 'a missing human verdict yields unknown, not a false clear');
ok('an unreadable/missing verdict on either side is UNKNOWN — never a fabricated disagreement');

// --- aggregate: agreement rate excludes unknowns; false-clear count surfaced ---
const agg = sd.aggregateShadows([
  { shadow: { component: 'title', verdict: 'clear', confidence: 0.5 }, human: { verdict: 'declined' } }, // false clear (high)
  { shadow: { component: 'income', verdict: 'clear' }, human: { verdict: 'clear' } },                    // agree
  { shadow: { component: 'assets', verdict: 'declined', confidence: 0.9 }, human: { verdict: 'clear' } }, // false flag (review)
  { shadow: { component: 'x', verdict: 'clear' }, human: { verdict: 'clear' } },                          // agree
  { shadow: { component: 'y', verdict: 'gibberish' }, human: { verdict: 'clear' } },                      // unknown (excluded)
]);
assert.strictEqual(agg.total, 5);
assert.strictEqual(agg.compared, 4, 'the unknown is excluded from the comparison denominator');
assert.strictEqual(agg.agree, 2);
assert.strictEqual(agg.falseClears, 1);
assert.strictEqual(agg.falseFlags, 1);
assert.strictEqual(agg.unknown, 1);
assert.strictEqual(agg.agreementRate, 0.5, '2 agree / 4 compared');
assert.strictEqual(agg.reviewQueue.length, 2, 'the false clear + the confident false flag are review-worthy');
assert.strictEqual(agg.reviewQueue[0].severity, SEVERITY.HIGH, 'the queue is sorted worst-severity first');
assert.strictEqual(agg.byComponent.title.falseClears, 1, 'per-component rollup counts the false clear');
ok('aggregateShadows rolls up agreement rate (unknowns excluded), false-clear count, and a severity-sorted review queue');

// --- a hand-built object with a NON-canonical verdict is still canonicalized ---
// (guards the "already captured" fast path from bypassing normalization)
r = sd.compareToHuman({ component: 'title', verdict: 'Approved', rawVerdict: 'Approved' }, { verdict: 'declined' });
assert.strictEqual(r.class, CLASS.FALSE_CLEAR, 'a non-canonical verdict is normalized, not compared raw — still a false clear');
assert.strictEqual(r.reviewWorthy, true);
// a genuinely canonical captured shadow still takes the fast path correctly
r = sd.compareToHuman(sd.captureShadow({ component: 'title', verdict: 'clear' }), { verdict: 'declined' });
assert.strictEqual(r.class, CLASS.FALSE_CLEAR, 'a properly captured shadow classifies correctly');
ok('a hand-built non-canonical verdict is canonicalized (the captured fast-path cannot bypass normalization)');

// --- empty / junk input is safe ---
assert.doesNotThrow(() => sd.captureShadow(null));
assert.strictEqual(sd.captureShadow(null).verdict, VERDICT.UNKNOWN);
assert.doesNotThrow(() => sd.compareToHuman(null, null));
assert.strictEqual(sd.compareToHuman(null, null).class, CLASS.UNKNOWN, 'two nulls compare to unknown, not a crash');
assert.doesNotThrow(() => sd.aggregateShadows(null));
assert.strictEqual(sd.aggregateShadows(null).compared, 0);
assert.doesNotThrow(() => sd.aggregateShadows([null, 'junk', {}]));
assert.strictEqual(sd.canonicalVerdict(undefined), VERDICT.UNKNOWN);
ok('empty / null / junk input is safe (never throws)');

console.log(`\nR5.47 shadow-decision pure — ${passed} checks passed`);
