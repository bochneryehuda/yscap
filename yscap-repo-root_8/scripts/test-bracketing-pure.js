/**
 * BRACKETING — does the set surround the subject, or only sit near it?
 *
 * The three assertions that matter most are the ones about NOT crying wolf: a
 * dimension nobody stated is a gap in our records and not a failing set; an
 * exact match brackets on both sides; and condition runs BACKWARDS, so comparing
 * the codes as text reports the opposite of the truth.
 *
 * Pure. Run: node scripts/test-bracketing-pure.js
 */
'use strict';
const { assessBracketing, DIMENSIONS, _internals } = require('../src/lib/research/bracketing');
const V = require('../src/lib/research/valuation');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const dim = (r, k) => r.dimensions.find((d) => d.key === k);

const SUBJ = { gla: 1800, beds: 3, baths_full: 2, baths_half: 0, year_built: 1970,
  condition_uad: 'C3', quality_uad: 'Q4' };
const comp = (over = {}) => Object.assign({ gla: 1800, beds: 3, baths_full: 2, baths_half: 0,
  year_built: 1970, condition_uad: 'C3', quality_uad: 'Q4', adjustedPrice: 400000 }, over);

// ---------------------------------------------------------------------------
// IT SURROUNDS THE SUBJECT, OR IT SAYS WHICH WAY IT DOES NOT
// ---------------------------------------------------------------------------
{
  const r = assessBracketing(SUBJ, [comp({ gla: 1600 }), comp({ gla: 2000 })]);
  const g = dim(r, 'gla');
  ok(g.brackets, 'one comparable smaller and one bigger brackets the living area');
  ok(g.above === 1 && g.below === 1, 'and both sides are counted');
  ok(g.why === null, 'a bracketed dimension needs no explanation');
}
{
  const r = assessBracketing(SUBJ, [comp({ gla: 2000 }), comp({ gla: 2400 })]);
  const g = dim(r, 'gla');
  ok(!g.brackets, 'two bigger comparables do NOT bracket');
  ok(/every comparable .* is larger than the subject/.test(g.why),
    `and the finding names the direction (${g.why})`);
  ok(/adjusting downward from all of them/.test(g.why),
    'and says what that means — the adjustment is doing the work, not a sale');
  ok(r.misses.some((m) => m.key === 'gla'), 'and it lands in the misses list');
  ok(/Not bracketed: living area/.test(r.summary), `the summary names it (${r.summary})`);
}
{
  const r = assessBracketing(SUBJ, [comp({ gla: 1400 }), comp({ gla: 1500 })]);
  ok(/every comparable .* is smaller than the subject/.test(dim(r, 'gla').why),
    'and the other direction is named the other way round');
  ok(/adjusting upward/.test(dim(r, 'gla').why), 'with the matching consequence');
}

// ---------------------------------------------------------------------------
// AN EXACT MATCH BRACKETS ON BOTH SIDES
// ---------------------------------------------------------------------------
{
  // A comparable identical to the subject needs no extrapolation in EITHER
  // direction. Counting it as neither would report the strongest possible
  // support as the weakest — a set of three identical twins would read as
  // "unbracketed on everything".
  const r = assessBracketing(SUBJ, [comp(), comp(), comp()]);
  ok(r.misses.length === 0, 'three comparables identical to the subject bracket everything');
  ok(dim(r, 'gla').equal === 3, 'and the exact matches are counted as such');
  ok(/brackets the subject on all/.test(r.summary), `the summary says so (${r.summary})`);
}
{
  const r = assessBracketing(SUBJ, [comp({ gla: 1800 }), comp({ gla: 2200 })]);
  ok(dim(r, 'gla').brackets, 'one exact match plus one bigger still brackets');
}

// ---------------------------------------------------------------------------
// CONDITION RUNS BACKWARDS — C1 IS THE BEST
// ---------------------------------------------------------------------------
ok(V.CONDITION_SCALE.indexOf('C1') < V.CONDITION_SCALE.indexOf('C5'),
  'the scale itself is best-first, which is what makes a text comparison wrong');
{
  // Both comparables are in WORSE condition than a C3 subject (C4, C5). A text
  // comparison would say "C4 > C3" and call them better; the rank says worse.
  const r = assessBracketing(SUBJ, [comp({ condition_uad: 'C4' }), comp({ condition_uad: 'C5' })]);
  const c = dim(r, 'condition');
  ok(!c.brackets, 'two comparables in worse condition do not bracket a C3 subject');
  ok(/every comparable .* is worse than the subject/.test(c.why),
    `and the wording says WORSE, not larger (${c.why})`);
}
{
  const r = assessBracketing(SUBJ, [comp({ condition_uad: 'C2' }), comp({ condition_uad: 'C5' })]);
  ok(dim(r, 'condition').brackets, 'one better and one worse brackets the condition');
}
{
  const r = assessBracketing(SUBJ, [comp({ condition_uad: 'C1' }), comp({ condition_uad: 'C2' })]);
  ok(/every comparable .* is better than the subject/.test(dim(r, 'condition').why),
    'and two better ones say BETTER');
}

// ---------------------------------------------------------------------------
// A DIMENSION NOBODY STATED IS A GAP IN OUR RECORDS, NOT A FAILING SET
// ---------------------------------------------------------------------------
{
  const noLot = assessBracketing(SUBJ, [comp({ gla: 1600 }), comp({ gla: 2000 })]);
  const l = dim(noLot, 'lot');
  ok(!l.known, 'a dimension the subject does not state is not judged');
  ok(/we hold no lot size for the subject/.test(l.why), 'and says why in words about OUR records');
  ok(!noLot.misses.some((m) => m.key === 'lot'), 'and it is never counted as a miss');
}
{
  const subj = Object.assign({}, SUBJ, { lot_size_sqft: 5000 });
  const r = assessBracketing(subj, [comp(), comp()]);
  const l = dim(r, 'lot');
  ok(!l.known && /none of the comparables states a lot size/.test(l.why),
    'a dimension the COMPARABLES do not state is also a gap, worded from their side');
  ok(!r.misses.some((m) => m.key === 'lot'), 'and still never a miss');
}
{
  const r = assessBracketing({}, [comp(), comp()]);
  ok(r.judged === 0 && r.misses.length === 0, 'a subject we know nothing about fails nothing');
  ok(/gap in our records, not a fault in the set/.test(r.summary),
    `and the summary says exactly that (${r.summary})`);
}

// ---------------------------------------------------------------------------
// THE CONCLUSION ITSELF HAS TO SIT INSIDE THE EVIDENCE
// ---------------------------------------------------------------------------
{
  const comps = [comp({ adjustedPrice: 380000 }), comp({ adjustedPrice: 420000 })];
  const inside = assessBracketing(SUBJ, comps, { indicatedValue: 400000 });
  ok(inside.value.inside && inside.value.why === null, 'a value inside the adjusted prices is fine');
  const over = assessBracketing(SUBJ, comps, { indicatedValue: 460000 });
  ok(!over.value.inside && /above EVERY adjusted comparable/.test(over.value.why),
    'a value above every adjusted comparable is called out — no sale in the set supports it');
  const under = assessBracketing(SUBJ, comps, { indicatedValue: 300000 });
  ok(/below EVERY adjusted comparable/.test(under.value.why), 'and so is one below every comparable');
  ok(over.value.low === 380000 && over.value.high === 420000,
    'with the range it should have sat in, so the finding is checkable');
}
{
  const r = assessBracketing(SUBJ, [comp({ adjustedPrice: null })], { indicatedValue: 400000 });
  ok(r.value === null, 'no adjusted prices means no claim about the value at all');
}

// ---------------------------------------------------------------------------
// IT IS ADVISORY, AND IT NEVER THROWS
// ---------------------------------------------------------------------------
ok(assessBracketing(SUBJ, [comp()]).advisory === true, 'the result says outright that it is advisory');
for (const junk of [undefined, null, 'x', 5, {}, []]) {
  let r = null, threw = null;
  try { r = assessBracketing(junk, junk); } catch (e) { threw = e; }
  ok(!threw, `${JSON.stringify(junk)} does not throw`);
  ok(r && Array.isArray(r.dimensions) && typeof r.summary === 'string',
    `${JSON.stringify(junk)} still produces a shaped, readable result`);
}
{
  const r = assessBracketing(SUBJ, [null, undefined, 5, comp({ gla: 1600 }), comp({ gla: 2000 })]);
  ok(dim(r, 'gla').stated === 2, 'junk rows are skipped rather than counted');
}
{
  const r = assessBracketing(SUBJ, []);
  ok(/No comparables are in use/.test(r.summary), 'an empty set says there is nothing to bracket');
}
ok(DIMENSIONS.every((d) => d.key && d.label && typeof d.of === 'function'),
  'every dimension is fully described');
{
  const b = _internals.bathsOf;
  ok(b({ baths_full: 2, baths_half: 1 }) === 2.5, 'a half bath counts as a half');
  ok(b({ baths: 3 }) === 3, 'and a single stated figure is taken as it is');
  ok(b({}) === null, 'with nothing stated reading as unknown, never zero');
}

console.log(fail
  ? `\ntest-bracketing-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-bracketing-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
