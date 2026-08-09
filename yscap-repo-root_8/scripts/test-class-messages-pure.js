'use strict';
/**
 * Class Valuation revision / ROV reason codes. PURE (no DB, no network).
 *
 * THE THING THIS FILE EXISTS TO PROVE: Class has no "reconsideration of value"
 * endpoint. An ROV is a REVISION filed with value-related reason codes — so the
 * codes are the only thing that makes it one, and they come from Class's own closed
 * list. A code we invented because it reads better in English would be rejected; a
 * vaguely-related code picked so the call succeeds would reach the appraiser as a
 * different request entirely.
 */
const R = require('../src/class/revision-reasons');

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log('PASS ' + l); } else { fail++; console.error('FAIL ' + l); } };

// ---------------------------------------------------------------------------
console.log('\n--- their closed list, transcribed verbatim ---');
ok(R.REASON_TYPES.length > 80, `their reason list is carried in full (${R.REASON_TYPES.length} codes)`);
ok(R.REASON_TYPES[0] === 'Other', 'starting with Other, in their order');
ok(new Set(R.REASON_TYPES).size === R.REASON_TYPES.length, 'with no duplicates');
// Spot-checks against the guide's own spellings, including the two it misspells.
// These are transcribed EXACTLY: "correcting" one would send a code they reject.
for (const c of ['ReconciliationConcernsValueRelatedConcerns', 'SiteDetailConcernsYearBuiltConcerns',
                 'FHAAirportFreewayRailroadCommercialBuidlingsETC', 'HardstopConcernsSSRsEADBeingRejected',
                 'MissingDatafromreportandMissingAMCSignaturePage', 'ClientRequestedCancellation']) {
  ok(R.isValid(c), `their code "${c}" is accepted exactly as they spell it`);
}
ok(!R.isValid('ValueDispute') && !R.isValid('ROV') && !R.isValid('ReconsiderationOfValue'),
   'and a sensible-sounding code we made up is NOT valid — there is no inventing here');

// ---------------------------------------------------------------------------
console.log('\n--- every ROV code is one of THEIRS, not a vocabulary of ours ---');
for (const c of R.ROV) ok(R.isValid(c), `the ROV reason "${c}" is on Class's own list`);
ok(R.ROV.includes('ReconciliationConcernsValueRelatedConcerns'),
   'and the plain "we disagree with the value" code is among them');

// ---------------------------------------------------------------------------
console.log('\n--- a revision is not offered cancellation reasons, and vice versa ---');
const rev = R.forKind('revision'), can = R.forKind('cancel'), rov = R.forKind('rov');
ok(!rev.common.includes('BorrowerWithdrewLoanApplication'),
   '"the borrower withdrew" is not offered as a reason to REVISE a report');
ok(can.common.includes('BorrowerWithdrewLoanApplication'), 'but it is offered as a reason to cancel');
ok(rov.common.every((c) => R.ROV.includes(c)), 'an ROV is offered only value-related reasons');
ok(rev.all.length === R.REASON_TYPES.length && can.all.length === R.REASON_TYPES.length,
   'and the FULL list is still available on both — the shortlist is a convenience, never a restriction');

// ---------------------------------------------------------------------------
console.log('\n--- validation reports, and never silently repairs ---');
const bad = R.normalizeReasons([{ reasonType: 'MadeUpCode', reason: 'x' }]);
ok(bad.reasons.length === 0 && bad.problems.length === 1, 'an unknown code is refused');
ok(/not a reason Class accepts/.test(bad.problems[0]), 'and named, so a person can pick a real one');
ok(R.normalizeReasons([]).problems.length === 1, 'no reason at all is refused');
const other = R.normalizeReasons([{ reasonType: 'Other' }]);
ok(other.problems.length === 1 && /explanation/.test(other.problems[0]),
   '"something else" with no words is refused — their Other means nothing on its own');
const otherOk = R.normalizeReasons([{ reasonType: 'Other', reason: 'The sketch is upside down' }]);
ok(otherOk.reasons.length === 1 && otherOk.reasons[0].reason === 'The sketch is upside down',
   'with words it goes through, and the words are what travels');
const noText = R.normalizeReasons([{ reasonType: 'OrderDetailsPropertyAddress' }]);
ok(noText.reasons[0].reason === 'The property address is wrong',
   'a code with no note carries its plain-English meaning rather than an empty string');

// ---------------------------------------------------------------------------
console.log('\n--- an ROV must actually BE about the value ---');
const fakeRov = R.normalizeReasons([{ reasonType: 'PhotosandMLSphotosgeneric', reason: 'blurry' }], { kind: 'rov' });
ok(fakeRov.problems.length === 1 && /value-related/.test(fakeRov.problems[0]),
   'filing a photo complaint as an ROV is refused — it would read to the appraiser as an ordinary correction');
const realRov = R.normalizeReasons(
  [{ reasonType: 'ReconciliationConcernsValueRelatedConcerns', reason: 'Three closer sales support $410k' }], { kind: 'rov' });
ok(realRov.problems.length === 0, 'a value-related reason goes through');
ok(R.looksLikeRov(realRov.reasons) === true, 'and is recognised as an ROV afterwards');
ok(R.looksLikeRov([{ reasonType: 'PhotosandMLSphotosgeneric' }]) === false, 'while a photo fix is not');
// The same code filed as an ordinary "revision" is STILL an ROV — which is the point
// of recognising it by its reasons rather than by which button was pressed.
const sneaky = R.normalizeReasons([{ reasonType: 'AdjustmentsWrongDirection', reason: 'up not down' }], { kind: 'revision' });
ok(sneaky.problems.length === 0 && R.looksLikeRov(sneaky.reasons) === true,
   'a value reason filed as a plain revision is still recognised as a value dispute');

// ---------------------------------------------------------------------------
console.log('\n--- labels are readable, and never claim to be their words ---');
ok(R.labelFor('ReconciliationConcernsValueRelatedConcerns') === 'We disagree with the value', 'a curated label reads plainly');
ok(R.labelFor('HOAPrivateRoadsCommentary') === 'HOA Private Roads Commentary',
   'an uncurated code is split on capitals rather than shown as one long word');
ok(R.labelFor('') === '' && R.labelFor(null) === '', 'and nothing in, nothing out');

console.log(`\ntest-class-messages-pure: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
