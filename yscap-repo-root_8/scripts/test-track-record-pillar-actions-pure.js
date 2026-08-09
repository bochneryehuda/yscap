'use strict';
/**
 * WHICH BUTTON DO I PRESS — the ladder, offline.
 *
 * Two assertions carry this file:
 *   §2  CONFIRM is primary ONLY when the records already proved it. Everywhere
 *       else the primary button is "Ask for a document". A reviewer working at
 *       speed presses the primary button, so the primary button must never be
 *       the one that CREDITS a borrower on evidence nobody has.
 *   §5  "Nothing found" is NEUTRAL and the copy says whose limitation it is.
 *       Painted as a failure it reads — to a reviewer, and through them to a
 *       borrower — as "we could not verify you", when the truth is usually that
 *       the county does not publish deeds online.
 */

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

const PA = require('../src/lib/track-record/pillar-actions');

const pillar = (over = {}) => ({ id: 'p1', pillar: 'ownership', auto_verdict: null, human_verdict: null, ...over });
const SIGNER = { role: 'processor' };
const CLERK = { role: 'loan_officer' };

// ═══════════════════ 1. It always answers, and always with one step
console.log('\n1. There is always exactly one next step');
{
  for (const auto of [null, ...PA.AUTO_VERDICTS]) {
    for (const human of [null, ...PA.HUMAN_VERDICTS]) {
      for (const opts of [SIGNER, CLERK]) {
        const s = PA.pillarNextStep(pillar({ auto_verdict: auto, human_verdict: human }), opts);
        if (!s || !s.key || !s.label || !s.hint) { fail++; console.error(`  FAIL ${auto}/${human}/${opts.role} produced ${JSON.stringify(s)}`); }
      }
    }
  }
  ok(true, 'every combination of machine answer, human answer and role produces a labelled step with a hint');
  ok(PA.pillarNextStep(null, {}).key && PA.pillarNextStep(undefined, {}).key,
    'and junk in still answers rather than throwing');
}

// ═══════════════════ 2. THE HIERARCHY
console.log('\n2. Confirm leads ONLY when the records proved it');
{
  const proved = PA.pillarNextStep(pillar({ auto_verdict: 'proved' }), SIGNER);
  ok(proved.key === 'confirm' && proved.tone === 'primary', 'machine-proved → Confirm is the primary button');

  for (const auto of [null, 'contradicted', 'no_data', 'too_recent']) {
    const s = PA.pillarNextStep(pillar({ auto_verdict: auto }), SIGNER);
    if (s.key !== 'ask_doc' || s.tone !== 'primary') {
      fail++; console.error(`  FAIL auto=${auto} led with ${s.key}/${s.tone}`);
    }
  }
  ok(true, 'every other state → "Ask for a document" is the primary button, contradiction included');

  ok(!PA.pillarNextStep(pillar({ auto_verdict: 'contradicted' }), SIGNER).verdict,
    'a contradiction never offers a one-click REJECT as its primary step — a disagreement goes to the borrower first');
  ok(/rejecting outright takes the project out of the count/.test(
    PA.pillarNextStep(pillar({ auto_verdict: 'contradicted' }), SIGNER).hint),
  '…and the hint says what rejecting would cost');

  const others = PA.pillarOtherSteps(pillar({ auto_verdict: 'contradicted' }), SIGNER);
  ok(others.some((o) => o.key === 'reject') && others.every((o) => o.tone === 'ghost'),
    'reject is still one click away — just never the loud one');
}

// ═══════════════════ 3. Authority
console.log('\n3. Confirming needs sign-off; withholding does not');
{
  const clerk = PA.pillarNextStep(pillar({ auto_verdict: 'proved' }), CLERK);
  ok(clerk.key !== 'confirm', 'somebody without sign-off is not offered Confirm on a proved check');
  ok(/sign-off/.test(clerk.hint), '…and the hint says why, rather than showing a button that would 403');
  ok(PA.pillarOtherSteps(pillar({ auto_verdict: 'proved' }), CLERK).some((o) => o.key === 'reject'),
    'they can still REJECT — withholding credit never needs authority');
  ok(!PA.pillarOtherSteps(pillar({ auto_verdict: 'no_data' }), CLERK).some((o) => o.key === 'confirm'),
    '…and they are never offered Confirm as a secondary either');
  ok(PA.pillarOtherSteps(pillar({ auto_verdict: 'no_data' }), SIGNER).some((o) => o.key === 'confirm'),
    'while a signer can confirm off-system evidence, as a quiet secondary');

  const locked = PA.pillarNextStep(pillar({ auto_verdict: 'proved', human_verdict: 'confirmed' }), CLERK);
  ok(locked.key === 'confirmed_locked', 'a check somebody with sign-off confirmed cannot be undone by somebody without it');
  ok(PA.pillarNextStep(pillar({ human_verdict: 'confirmed' }), SIGNER).key === 'undo',
    '…while a signer can take it back');
}

// ═══════════════════ 4. Already asked
console.log('\n4. Once a document is asked for, the card stops asking again');
{
  const asked = PA.pillarNextStep(pillar({ auto_verdict: 'no_data' }), { ...SIGNER, hasOpenRequest: true });
  ok(asked.key === 'awaiting_doc' && asked.tone === 'ghost', 'it reads "waiting on the borrower" instead of offering the same ask twice');
  ok(/conditions list/.test(asked.hint), '…and says where the answer will show up');
}

// ═══════════════════ 5. NEUTRAL IS NOT FAILURE
console.log('\n5. "Nothing found" is neutral, and the copy says whose limitation it is');
{
  for (const p of PA.PILLARS) {
    const card = PA.evidenceCard(pillar({ pillar: p, auto_verdict: 'no_data' }), SIGNER);
    if (card.tone !== 'neutral' || card.neutral !== true) { fail++; console.error(`  FAIL ${p} no_data was painted ${card.tone}`); }
  }
  ok(true, 'no_data is its own neutral tone on every pillar — never the same as contradicted');
  ok(PA.evidenceCard(pillar({ auto_verdict: 'too_recent' }), SIGNER).neutral === true, 'and so is too_recent');
  ok(PA.evidenceCard(pillar({ auto_verdict: 'contradicted' }), SIGNER).tone === 'bad',
    'while a real contradiction IS painted as bad — the distinction is the whole point');

  ok(/not a problem with the borrower/.test(PA.AUTO_MEANING.no_data.ownership),
    'the ownership copy says plainly that a records gap is not the borrower\'s fault');
  ok(/lease is never public/.test(PA.AUTO_MEANING.no_data.exit),
    'and the exit copy explains that a lease is never in the public record at all');
}

// ═══════════════════ 6. The evidence card's four parts
console.log('\n6. The evidence card: claim, source, snippet, actions — every time');
{
  const rich = PA.evidenceCard(pillar({
    auto_verdict: 'proved', auto_source: 'elementix', auto_confidence: 'certain', auto_grade: 'strong',
    auto_evidence: { snippet: 'GRANTOR MW TRADING LLC → J&R HOLDINGS, $612,000', recordingDate: '2026-03-14' },
    satisfied_by_llc_id: 'llc-1',
  }), SIGNER);
  ok(rich.claim && rich.source === 'elementix' && rich.confidence === 'certain' && rich.grade === 'strong',
    'a full card carries the claim, the source, the confidence and the grade');
  ok(rich.snippet === 'GRANTOR MW TRADING LLC → J&R HOLDINGS, $612,000' && rich.when === '2026-03-14',
    '…the VERBATIM snippet and its date');
  ok(rich.snippetNote === null, '…and no "nothing quoted" note when there is something to read');
  ok(rich.carriedFromEntity === true && rich.satisfiedByLlcId === 'llc-1',
    '…and says when the answer was carried from the company, so one click reaches the operating agreement');
  ok(rich.next && Array.isArray(rich.other), '…with the actions attached');
  ok(rich.pillarId === 'p1', '…and the ROW id, so a decision is posted to the right check');

  /* THE SNIPPET IS MANDATORY. A card saying only "verified by Elementix" asks a
     reviewer to trust a vendor name, which is not review. */
  const bare = PA.evidenceCard(pillar({ auto_verdict: 'proved', auto_source: 'elementix', auto_evidence: {} }), SIGNER);
  ok(bare.snippet === null && /nothing yet for a reviewer to read/.test(bare.snippetNote),
    'a card with nothing to quote SAYS SO — an empty card can never be mistaken for a checked one');
}

// ═══════════════════ 7. THE BULK RULE
console.log('\n7. Bulk confirm is for the boring case, and only the boring case');
{
  const three = (verdicts) => PA.PILLARS.map((p, i) => ({ id: `p${i}`, pillar: p, auto_verdict: verdicts[i], human_verdict: null }));

  const clean = PA.bulkConfirmRefusal(three(['proved', 'proved', 'proved']));
  ok(clean.ok === true && clean.pillars.length === 3, 'all three machine-proved and unanswered → allowed');

  const bad = PA.bulkConfirmRefusal(three(['proved', 'contradicted', 'proved']));
  ok(bad.ok === false && /disagree/.test(bad.reason), 'ONE contradiction refuses the whole line');
  ok(bad.pillars.join() === 'ownership', '…naming which check, so the reason is actionable');

  const thin = PA.bulkConfirmRefusal(three(['proved', 'no_data', 'proved']));
  ok(thin.ok === false && /nothing proving them/.test(thin.reason),
    'and one unproved check refuses it too — bulk only ever covers what the records proved');

  ok(PA.bulkConfirmRefusal([{ pillar: 'exit', auto_verdict: 'proved' }]).ok === false,
    'a line missing checks is refused rather than partly confirmed');
  ok(PA.bulkConfirmRefusal([]).ok === false && PA.bulkConfirmRefusal(null).ok === false,
    'and an empty or junk set is refused');

  const done = three(['proved', 'proved', 'proved']).map((p) => ({ ...p, human_verdict: 'confirmed' }));
  ok(PA.bulkConfirmRefusal(done).ok === false, 'a line a person already answered is not bulk-confirmed again');

  const partly = three(['proved', 'proved', 'proved']);
  partly[0].human_verdict = 'confirmed';
  const p2 = PA.bulkConfirmRefusal(partly);
  ok(p2.ok === true && p2.pillars.length === 2,
    'and a partly-answered line confirms only what is still unanswered — it never re-stamps somebody else\'s decision');
}

// ═══════════════════ 8. Readiness
console.log('\n8. One sentence saying what still stands in the way');
{
  const mk = (verdicts) => PA.PILLARS.map((p, i) => ({ pillar: p, human_verdict: verdicts[i] }));
  const none = PA.lineReadiness(mk([null, null, null]));
  ok(none.ready === false && none.answered === 0 && /recency, ownership, exit/.test(none.message),
    'nothing answered → it names all three');
  const all = PA.lineReadiness(mk(['confirmed', 'confirmed', 'confirmed']));
  ok(all.ready === true && /can be verified/.test(all.message), 'all three confirmed → ready');
  const rej = PA.lineReadiness(mk(['confirmed', 'rejected', 'confirmed']));
  ok(rej.ready === false && /cannot count/.test(rej.message),
    'one rejection → not ready, and it says the project cannot count rather than "keep going"');
  const partial = PA.lineReadiness(mk(['confirmed', null, 'confirmed']));
  ok(partial.ready === false && /ownership/.test(partial.message) && !/recency/.test(partial.message),
    'and a partly-answered line names ONLY what is still missing');
}

// ═══════════════════ 9. Purity
console.log('\n9. Nothing here reaches a database or a clock');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/lib/track-record/pillar-actions.js'), 'utf8');
  ok(!/require\(/.test(src), 'the module requires nothing at all — it is a function of its arguments');
  ok(!/Date\.now|new Date/.test(src), 'and owns no clock');
}

console.log(fail ? `\n${fail} FAILURE(S)` : '\nOK  one primary step, Confirm only on proof, and "nothing found" never painted as failure');
process.exit(fail ? 1 : 0);
