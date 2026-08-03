/**
 * READING A WORDED CONDITION OR QUALITY RATING — and refusing most of them.
 *
 * UAD was mandated for exactly four forms (1004, 1073, 1075, 2055) and the 1025
 * (2-4 unit) was left out, so its grid condition is the appraiser's own words.
 * `properties.condition_rank` is GENERATED from the digits of `condition_uad`,
 * so a property whose only rating is a word ranks NULL and is invisible to every
 * condition filter, to the facets and to the valuation's per-grade rate.
 * Measured on the real 152-report corpus: 234 of 955 properties. For a lender
 * whose book is 2-4 units that is not an edge case.
 *
 * EVERY STRING BELOW IS A REAL VALUE COUNTED IN THAT CORPUS, and what the module
 * REFUSES is the point:
 *   · a RELATIVE word is about that report's subject, not about the house;
 *   · `Updated` is work, not condition;
 *   · a `Q` code in the condition slot is a quality grade, not a condition;
 *   · a MATERIAL (`BRICK`, `FRAME`) is not a grade at all.
 *
 * Pure — no DB, no browser. Run: node scripts/test-condition-scale-pure.js
 */
'use strict';
const CS = require('../src/lib/research/condition-scale');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

// ---------------------------------------------------------------------------
// A LITERAL CODE IS THE ONLY THING THAT EVER SETS `code`
// ---------------------------------------------------------------------------
for (const n of [1, 2, 3, 4, 5, 6]) {
  const r = CS.readCondition(`C${n}`);
  ok(r.code === `C${n}` && r.rank === n && r.rankLow === n && r.rankHigh === n
    && r.source === 'code' && r.confidence === 'definite',
  `C${n} is read exactly, with no span`);
}
ok(CS.readCondition('C4 / average').code === 'C4',
  'a mixed "C4 / average" is read as the CODE — that is what the appraiser graded');
ok(CS.readCondition('C3 / updated').code === 'C3',
  'and "C3 / updated" too — the work word is corroboration, never a veto');
ok(CS.readCondition('Average').code === null,
  'NO WORD EVER PRODUCES A CODE — a screen can never show a grade we were not given');
ok(CS.readCondition('C7').rank == null && CS.readCondition('C0').rank == null,
  'a code off the scale is not read');

// ---------------------------------------------------------------------------
// THE WORDS, AND THEIR SPANS
// ---------------------------------------------------------------------------
const W = (t) => CS.readCondition(t);
ok(W('Average').rank === 4 && W('Average').rankLow === 3 && W('Average').rankHigh === 4,
  '"Average" is not C4 — it is C3-or-C4 and we lean C4, and it says so');
ok(W('AVERAGE').rank === 4 && W('average').rank === 4,
  'and case never changes the reading — the corpus writes it three ways');
ok(W('Good').rank === 3 && W('Good').rankLow === 2,
  '"Good" reads C2–C3');
ok(W('Fair').rank === 5 && W('FAIR').rankHigh === 5, '"Fair" reads C4–C5');
ok(W('BELOW AVERAGE').rank === 5, '"Below average" is fair, not average');
ok(W('Excellent').rank === 1, '"Excellent" reads C1–C2');
ok(W('Poor').rank === 6, '"Poor" reads C5–C6');

// THE SAME RATING SPELLED FOUR WAYS MUST READ IDENTICALLY. The first cut spelled
// the pattern `avg?`, which matches "av"/"avg" and NOT "average" — so
// "Average-Good" fell through to plain "good" and the two forms of one word read
// a whole grade apart on real data.
const AVG_GOOD = ['Average-Good', 'Avg-Good', 'Avg/Good', 'average good'];
for (const t of AVG_GOOD) {
  ok(W(t).rank === 3 && W(t).rankLow === 3 && W(t).rankHigh === 4,
    `"${t}" reads C3–C4 — every spelling of one rating reads the same`);
}

// A MODIFIER IS A NUDGE WITHIN THE BAND, NOT A NEW GRADE. Moving the whole
// reading a full grade made "Average-" come out as FAIR (rank 5, C3–C5) — a
// building the appraiser called average graded as one with obvious deferred
// maintenance.
ok(W('Average+').rank === 3 && W('Average+').rankLow === 3 && W('Average+').rankHigh === 4,
  '"Average+" reads at the better end of average — the same reading as "Avg-Good"');
ok(W('Average-').rank === 4 && W('Average-').rankLow === 4 && W('Average-').rankHigh === 5,
  '"Average-" is still an average building at its worse edge, reaching toward fair');
ok(W('AVERAGE+').confidence === 'weak' && W('Average').confidence === 'likely',
  'a modified reading is offered with LESS confidence — we know the direction, not the size');

// TWO CODES ARE A SPAN THE APPRAISER DID NOT RESOLVE. `C3/C4` and `C4-C5` are in
// the real corpus, and reading the first as DEFINITE filed 622 Winchester Ave as
// a C3 — the flattering end — so a "C3 or better" search returned it and the
// screen printed a grade nobody chose. This is the one shape where a real span
// exists, and collapsing it is the opposite of what the words get.
for (const [t, lo, hi] of [['C3/C4', 3, 4], ['C4-C5', 4, 5], ['C2 to C4', 2, 4]]) {
  const r = W(t);
  ok(r.rankLow === lo && r.rankHigh === hi && r.code === null && r.source === 'code_span',
    `"${t}" keeps its span and states no single code`);
  ok(r.rank === hi, `and leans the WORSE end — we do not take the flattering reading of "${t}"`);
  ok(CS.describe(r) === t, `and it is shown exactly as the appraiser wrote it, not as one end`);
}
ok(W('C4 / average').code === 'C4' && W('C4 / average').source === 'code',
  'one code beside a word is still ONE code — a span needs two codes, not a code and a synonym');

// A SIGN ATTACHED TO A NUMBER IS AN ADJUSTMENT, NOT A GRADE. The corpus fills
// this very slot with "Inferior 5%" and "Superior 10%", so a percentage next to
// a rating is ordinary — and reading its sign made "+5%" a better building and
// "-5%" a worse one, off the same string.
ok(W('Average +5%').rank === 4 && W('Average -5%').rank === 4,
  'an appended percentage never moves the grade, in either direction');
ok(W('Average +5%').confidence === 'likely',
  'and it is not even treated as a modified reading — there was no modifier');
// …and the two signs are detected SYMMETRICALLY. `+` used to match anywhere and
// `-` only at the end, so "+Average" was a plus and "-Average" was nothing.
ok(W('+Average').rank === 3 && W('-Average').rank === 4,
  'a leading sign reads the same way a trailing one does');

// ---------------------------------------------------------------------------
// WHAT MUST STAY NULL — most of the corpus
// ---------------------------------------------------------------------------
const RELATIVE = ['similar', 'INFERIOR', 'inferior', 'superior', 'SUPERIOR', 'Superior',
  'Inferior 5%', 'Inferior 10%', 'Superior 5%', 'Superior 10%', '+', '-', '=', '+5%'];
for (const t of RELATIVE) {
  const r = W(t);
  ok(r.rank == null && /compared/.test(r.why || ''),
    `"${t}" is a comparison with that report's subject, not a grade — refused, and it says why`);
}
for (const t of ['Q2', 'Q3', 'Q4']) {
  const r = W(t);
  ok(r.rank == null && /quality/.test(r.why || ''),
    `"${t}" in the condition slot is a QUALITY grade — reading it as C${t[1]} would claim a nearly-new building`);
}
for (const t of ['Updated', 'Renovated', 'REMODELED', 'rehabbed']) {
  ok(W(t).rank == null, `"${t}" is work that was done, not the condition it is in`);
}
for (const t of ['BRICK', 'FRAME', 'VINYL', '2 Family', '', null, undefined, '   ']) {
  ok(W(t).rank == null, `${JSON.stringify(t)} is not a rating and is not guessed at`);
}
ok(W('Average').original === 'Average' && W('BRICK').original === 'BRICK',
  'the appraiser\'s own word is ALWAYS kept — our reading is laid beside it, never in place of it');

// ---------------------------------------------------------------------------
// QUALITY IS STRICTER, BECAUSE THE SLOT CARRIES MATERIALS
// ---------------------------------------------------------------------------
ok(CS.readQuality('Q3').code === 'Q3' && CS.readQuality('Q3').rank === 3, 'a Q code is read exactly');
ok(CS.readQuality('Average').rank === 4, 'and the same absolute words are read');
for (const t of ['BRICK', 'FRAME', 'VINYL', 'ALUMINUM']) {
  ok(CS.readQuality(t).rank == null, `"${t}" is a MATERIAL — there can be no default and no fuzzy match`);
}
ok(CS.readQuality('C3').rank == null && /condition/.test(CS.readQuality('C3').why || ''),
  'a CONDITION code in the quality slot is refused too — the mirror of the same rule');
ok(CS.readQuality('Q4 / average').code === 'Q4', 'a mixed quality string reads as the code');

// ---------------------------------------------------------------------------
// THE ONE ANSWER, AND HOW IT IS SAID
// ---------------------------------------------------------------------------
ok(CS.resolveCondition({ condition_uad: 'C3', condition_text: 'Average' }).code === 'C3',
  'with both, the CODE wins — it is what the appraiser actually graded');
ok(CS.resolveCondition({ condition_uad: null, condition_text: 'Average' }).rank === 4,
  'with only words, the words are read');
ok(CS.resolveCondition({ condition_uad: null, condition_text: 'similar' }).rank == null,
  'and with only a relative word, nothing is read');
ok(CS.resolveCondition({}).rank == null, 'an empty row is not an error');

ok(CS.describe(CS.readCondition('C3')) === 'C3', 'a code is shown as itself');
ok(CS.describe(CS.readCondition('Average')) === 'Average (reads as C3–C4)',
  'a word is shown as the appraiser wrote it, with our reading beside it');
ok(CS.describe(CS.readQuality('Average')) === 'Average (reads as Q3–Q4)',
  'and a QUALITY reading says Q — printing C beside a construction grade would state a condition we never got');
ok(CS.describe(CS.readCondition('BRICK')) === null, 'nothing readable is described as nothing');

// THE BASIS TRAVELS. A renovation report's condition describes a house that does
// not exist yet, and the reading must not quietly launder that.
ok(CS.readCondition('Average', { basis: 'as_repaired' }).basis === 'as_repaired',
  'the as-repaired basis is carried through untouched');

console.log(fail
  ? `\ntest-condition-scale-pure: ${pass} passed, ${fail} FAILED`
  : `\ntest-condition-scale-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
