/**
 * WHAT OUR OWN COMPARABLES SAY ABOUT AN APPRAISER'S VALUE — and the refusals.
 *
 * This is the module most able to do harm in the whole research build. "The
 * appraisal is 14% high" is an accusation about a licensed professional's work,
 * and produced from four sales in the wrong town it is a FALSE accusation that
 * reads exactly like a true one. So nearly every assertion here is about it
 * declining to speak.
 *
 * THE ONE THAT IS EASIEST TO MISS, and the reason the module exists in this
 * shape: the comparables nearest a subject in our warehouse are very often the
 * ones the report under review put there itself. Checked against those, an
 * appraisal agrees with itself perfectly — and it agrees most closely on exactly
 * the reports where a reviewer most needs a second opinion. Independence is
 * therefore taken FIRST, before coverage is counted, so a set can never pass the
 * gate on rows that are about to be dropped.
 *
 * Pure. Run: node scripts/test-research-variance-pure.js
 */
'use strict';
const { assessVariance, describeVariance, GATES, DISCLAIMER } = require('../src/lib/research/variance');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

const SUBJ = { gla: 2000, beds: 3 };
const comp = (price, report, appraiser, extra = {}) => Object.assign(
  { sale_price: price, gla: 2000, sale_date: '2026-05-01', sale_status: 'closed',
    source_appraisal_id: report, appraiser_id: appraiser }, extra);
/** Three comparables that agree, from three different reports by three appraisers. */
const CLEAN = [comp(400000, 'r1', 'a1'), comp(402000, 'r2', 'a2'), comp(398000, 'r3', 'a3')];
const A = (o) => assessVariance(Object.assign({ subject: SUBJ }, o));

// ---------------------------------------------------------------------------
// IT ANSWERS WHEN IT HONESTLY CAN
// ---------------------------------------------------------------------------
{
  const v = A({ appraisedValue: 400000, comps: CLEAN });
  ok(v.available, 'three agreeing comparables from three reports by three appraisers produce an answer');
  ok(v.direction === 'in line' && Math.abs(v.variancePct) < GATES.NOISE_PCT,
    'a value that matches ours reads as in line, not as a 0.0% verdict');
  ok(v.coverage.comps === 3 && v.coverage.reports === 3 && v.coverage.appraisers === 3,
    'and the coverage behind it is stated, so nobody has to take the number on trust');
}
{
  const v = A({ appraisedValue: 460000, comps: CLEAN });
  ok(v.available && v.variancePct > 0 && v.direction === 'above ours',
    'an appraisal above our own files says so');
  ok(v.notable === true, 'and 15% is flagged as worth a human\'s time');
  ok(/Worth a look, not a conclusion/.test(describeVariance(v) || ''),
    'in words that are a prompt, never a verdict');
  ok(v.disclaimer === DISCLAIMER && /not an appraisal review/.test(v.disclaimer),
    'and the disclaimer travels with the number, every time');
}
{
  const v = A({ appraisedValue: 340000, comps: CLEAN });
  ok(v.available && v.variancePct < 0 && v.direction === 'below ours',
    'and an appraisal BELOW our files says that too — a review that only ever looks up is half a review');
}
{
  // 6% — past the noise floor, short of notable. It answers, and does not shout.
  const v = A({ appraisedValue: 424000, comps: CLEAN });
  ok(v.available && v.direction === 'above ours' && v.notable === false,
    'a small real difference is reported without being flagged — the two methods differ by a few '
    + 'percent on identical data, and treating that as a finding would cry wolf on every file');
}

// ---------------------------------------------------------------------------
// INDEPENDENCE — the gate that has to run FIRST
// ---------------------------------------------------------------------------
{
  // Every comparable is one the report under review put in our warehouse itself.
  const own = [comp(400000, 'rX', 'a1'), comp(402000, 'rX', 'a1'), comp(398000, 'rX', 'a1')];
  const v = A({ appraisedValue: 400000, appraisalId: 'rX', comps: own });
  ok(!v.available, 'a report is never checked against its own comparables — it would agree perfectly '
    + 'and mean nothing');
  ok(v.coverage.fromThisReport === 3 && v.coverage.comps === 0,
    'and the count that was set aside is REPORTED, so the refusal is not a mystery');
  ok(/did not come from this report itself/.test(v.why || ''),
    'and the reason says exactly that, in words a reviewer can act on');
}
{
  // THE ORDER MATTERS AND THIS IS THE PROOF. Five comparables — four of them the
  // report's own. Counting coverage first sees 5, clears MIN_COMPS, and only then
  // discovers there is 1 left. Independence first sees 1 and refuses.
  const mixed = [comp(400000, 'rX', 'a1'), comp(401000, 'rX', 'a1'), comp(402000, 'rX', 'a1'),
    comp(403000, 'rX', 'a1'), comp(399000, 'r2', 'a2')];
  const v = A({ appraisedValue: 400000, appraisalId: 'rX', comps: mixed });
  ok(!v.available && v.gate === 'too_few_comps',
    'a set that only clears the coverage gate BECAUSE of the report\'s own comparables is refused');
  ok(v.coverage.comps === 1 && v.coverage.fromThisReport === 4,
    'because independence is taken before anything is counted, never after');
}
{
  // …and the same five, when the report under review is a different one, ARE a
  // usable set. The rows have not changed; only which report is being checked.
  const mixed = [comp(400000, 'rX', 'a1'), comp(401000, 'rX', 'a1'), comp(402000, 'rX', 'a1'),
    comp(403000, 'rX', 'a1'), comp(399000, 'r2', 'a2')];
  const v = A({ appraisedValue: 400000, appraisalId: 'rOther', comps: mixed });
  ok(v.available, 'the identical rows ARE evidence about a different report');
}

{
  // "CAME FROM THIS REPORT" MEANS *ONLY* FROM IT. A house our warehouse learned
  // about from the report under review AND from somebody else's is independent
  // evidence — a second appraiser described the same sale, which is precisely
  // the corroboration this check is looking for. Dropping it because the report
  // under review also mentioned it would discard the strongest rows we hold.
  const many = (price, reports, appraisers) => ({ sale_price: price, gla: 2000,
    sale_date: '2026-05-01', sale_status: 'closed',
    source_appraisal_ids: reports, appraiser_ids: appraisers });
  const v = A({ appraisedValue: 400000, appraisalId: 'rX', comps: [
    many(400000, ['rX', 'r2'], ['a1', 'a2']),   // ours AND somebody else's — KEPT
    many(402000, ['rX'], ['a1']),               // ours alone — set aside
    many(398000, ['r3'], ['a3']),
    many(401000, ['r4'], ['a4']),
  ] });
  ok(v.available && v.coverage.comps === 3 && v.coverage.fromThisReport === 1,
    'a comparable two reports describe is kept; only one described by this report ALONE is set aside');
}

// ---------------------------------------------------------------------------
// DISTINCT OPINIONS, NOT DISTINCT ROWS
// ---------------------------------------------------------------------------
{
  const v = A({ appraisedValue: 400000,
    comps: [comp(400000, 'r1', 'a1'), comp(402000, 'r1', 'a1'), comp(398000, 'r1', 'a1')] });
  ok(!v.available && v.gate === 'one_report',
    'five comparables lifted from ONE report are one opinion wearing five hats');
}
{
  const v = A({ appraisedValue: 400000,
    comps: [comp(400000, 'r1', 'a1'), comp(402000, 'r2', 'a1'), comp(398000, 'r3', 'a1')] });
  ok(!v.available && v.gate === 'one_appraiser',
    'and three reports by the SAME appraiser share the same habits and the same adjustment rates');
}

// ---------------------------------------------------------------------------
// COVERAGE, AND SAYING SO HONESTLY
// ---------------------------------------------------------------------------
{
  const v = A({ appraisedValue: 400000, comps: [comp(400000, 'r1', 'a1'), comp(402000, 'r2', 'a2')] });
  ok(!v.available && v.gate === 'too_few_comps', 'two comparables are not an opinion');
  ok(/small share of what sold/.test(v.why || ''),
    'and the refusal explains that thin coverage is what our warehouse IS, not a filter to widen — '
    + 'we hold only what our own reports described');
}
{
  const v = A({ appraisedValue: 400000, comps: [] });
  ok(!v.available && v.coverage.comps === 0, 'no comparables at all is a refusal, not a zero variance');
}

// ---------------------------------------------------------------------------
// OUR OWN SALES HAVE TO AGREE BEFORE WE JUDGE SOMEBODY ELSE'S
// ---------------------------------------------------------------------------
{
  const v = A({ appraisedValue: 400000,
    comps: [comp(250000, 'r1', 'a1'), comp(400000, 'r2', 'a2'), comp(700000, 'r3', 'a3')] });
  ok(!v.available && v.gate === 'comps_disagree',
    'comparables that disagree with each other say nothing about anybody else\'s value');
  ok(/disagree with each other/.test(v.why || '') && /%/.test(v.why || ''),
    'and it states by how much, rather than just declining');
}

// ---------------------------------------------------------------------------
// NOTHING IS INVENTED
// ---------------------------------------------------------------------------
{
  const v = A({ appraisedValue: null, comps: CLEAN });
  ok(!v.available && v.gate === 'no_appraised_value',
    'a report with no value stated is not a 100% variance');
}
for (const bad of [0, -5, 'x', NaN]) {
  ok(!A({ appraisedValue: bad, comps: CLEAN }).available,
    `${JSON.stringify(bad)} as a value produces a refusal, never a number`);
}
for (const junk of [undefined, null, {}, { comps: null }, { comps: 'x' }]) {
  const v = assessVariance(junk);
  ok(v && v.available === false && v.ourValue === null,
    `${JSON.stringify(junk)} is refused without inventing a value`);
}
ok(assessVariance({ appraisedValue: 400000, subject: null, comps: CLEAN }).disclaimer === DISCLAIMER,
  'even a refusal carries the disclaimer — a screen must never render one without it');

// EVERY REFUSAL NAMES ITS GATE, so a screen can group them and a human can tell
// "we have nothing to say" from "we have something and it disagrees".
for (const o of [{ appraisedValue: null, comps: CLEAN },
  { appraisedValue: 400000, comps: [] },
  { appraisedValue: 400000, comps: [comp(400000, 'r1', 'a1'), comp(402000, 'r1', 'a1'), comp(398000, 'r1', 'a1')] }]) {
  const v = A(o);
  ok(!v.available && typeof v.gate === 'string' && v.gate.length > 0 && v.why,
    'a refusal carries both a stable gate name and words for a person');
}

console.log(fail
  ? `\ntest-research-variance-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-research-variance-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
