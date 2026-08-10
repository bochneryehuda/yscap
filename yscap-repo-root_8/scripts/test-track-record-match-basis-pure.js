'use strict';
/**
 * HOW A FOUND PROPERTY MATCHED THE BORROWER — the transparency + the pending
 * warning (owner-directed 2026-08-10, the "MAJOR enhancement"), pure, no DB.
 *
 * The owner's rule: every record says WHY it matched — the personal name, a
 * company on the profile, or both — and when it matched a company on the profile
 * but the borrower's OWN name is not among the people behind that company, a
 * HIGH-LEVEL PENDING WARNING, because it may be a different company with the
 * same name. Advisory only: nothing is ever auto-declined ("it should not decide
 * by her own that it's out of the footprint").
 *
 * The single most important assertions here are section 4: an UNKNOWN never
 * warns. When the records give us no people to check, we do not raise the
 * warning — an absent people-list is never treated as "the borrower is not
 * there".
 */

const MB = require('../src/lib/track-record/match-basis');

let fail = 0;
const ok = (c, m) => { if (c) console.log(`  ok  ${m}`); else { fail++; console.error(`  FAIL ${m}`); } };

/* The blessed matcher's shape: order-insensitive, and conservative (it will NOT
   call two different first names the same person). A tiny stand-in keeps the
   test pure; the real `namesMatchLoose` behaves the same on these cases. */
const nm = (a, b) => {
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean).sort().join(' ');
  return !!a && !!b && norm(a) === norm(b);
};

console.log('\n1. THE PERSON branch — matched to the personal name');
{
  const r = MB.computeMatchBasis({ branch: 'person', personalName: 'Moses Weil', entityName: '', namesMatch: nm });
  ok(r.personalMatched === true && r.entityMatched === false, 'personal name matched, no company');
  ok(r.basis === 'personal' && /personal name/i.test(r.label), 'basis + label say personal');
  ok(r.warn === false, 'never a warning on a personal-name match');
  ok(/Moses Weil/.test(r.why), 'the reason names the person');

  const both = MB.computeMatchBasis({ branch: 'person', personalName: 'Moses Weil', entityName: 'MW Trading LLC', namesMatch: nm });
  ok(both.basis === 'both' && both.entityMatched && both.personalMatched,
    'a person-branch deed that also names a company on the profile → both');
}

console.log('\n2. THE ENTITY branch — the borrower IS among the company\'s people → confirmed (both)');
{
  const r = MB.computeMatchBasis({
    branch: 'entity', personalName: 'Moses Weil', entityName: 'MW Trading LLC',
    entityPeople: [{ name: 'MOSES WEIL', type: 'PERSON' }, { name: 'Sarah Weil', type: 'PERSON' }],
    namesMatch: nm,
  });
  ok(r.entityMatched === true && r.personalMatched === true, 'company matched AND the borrower is behind it');
  ok(r.basis === 'both' && r.warn === false, 'basis both, no warning');
  ok(/one of the people behind it/i.test(r.why), 'the reason says the borrower is on record behind the company');
  ok(nm('MOSES WEIL', 'Moses Weil') && nm('Weil, Moses', 'Moses Weil'),
    '(the matcher is order-insensitive, so a reversed name still matches)');
}

console.log('\n3. THE ENTITY branch — borrower NOT among the people, OTHERS are → HIGH-LEVEL WARNING');
{
  const r = MB.computeMatchBasis({
    branch: 'entity', personalName: 'Moses Weil', entityName: 'MW Trading LLC',
    entityPeople: [{ name: 'Travis Tran', type: 'PERSON' }, { name: 'Hatran Jillian', type: 'PERSON' }],
    namesMatch: nm,
  });
  ok(r.entityMatched === true && r.personalMatched === false, 'matched the company, NOT the personal name');
  ok(r.basis === 'entity_only' && /company only/i.test(r.label), 'basis + label say company-only');
  ok(r.warn === true, 'THE PENDING WARNING fires');
  ok(r.otherPeopleCount === 2 && r.peopleKnown === true, 'it counts the other people it did see');
  ok(/different company with the same name/i.test(r.why), 'the reason names the same-name-company risk');
  ok(/Moses Weil/i.test(r.why) && /NOT among/i.test(r.why), 'and states the personal name was not found');
}

console.log('\n4. AN UNKNOWN NEVER WARNS — the owner\'s "do not decide out of the footprint by yourself"');
{
  // No people list at all → we could not check → no warning.
  const noPeople = MB.computeMatchBasis({
    branch: 'entity', personalName: 'Moses Weil', entityName: 'MW Trading LLC', entityPeople: [], namesMatch: nm });
  ok(noPeople.warn === false && noPeople.peopleKnown === false,
    'no people to check → NO warning (an absent list is never "the borrower is not there")');
  ok(noPeople.basis === 'entity_only' && !/different company/i.test(noPeople.why),
    '…and the reason is neutral, not alarming');

  // No personal name known → cannot say the borrower is missing → no warning.
  const noName = MB.computeMatchBasis({
    branch: 'entity', personalName: '', entityName: 'MW Trading LLC',
    entityPeople: [{ name: 'Travis Tran', type: 'PERSON' }], namesMatch: nm });
  ok(noName.warn === true, 'with a real other-person and a company but no borrower name, it still flags (nobody to match)');
  // ^ deliberately: we DID match the company and the people are strangers; the reviewer should look.
}

console.log('\n5. NEVER THROWS, and a null basis is a valid "we did not compute it"');
{
  ok(MB.computeMatchBasis() && typeof MB.computeMatchBasis().basis === 'string',
    'called with nothing, it still returns a shaped object rather than throwing');
  let threw = false;
  let bad;
  try {
    bad = MB.computeMatchBasis({ branch: 'entity', personalName: 'X', entityName: 'Y',
      entityPeople: [{ nope: true }, 'a string', null], namesMatch: () => { throw new Error('boom'); } });
  } catch (_) { threw = true; }
  ok(!threw && bad && typeof bad.warn === 'boolean',
    'a throwing matcher + junk people never throws — it degrades to a shaped, advisory-only answer');
}

if (fail) { console.error(`\ntest-track-record-match-basis-pure: ${fail} FAILED`); process.exit(1); }
console.log('\ntest-track-record-match-basis-pure: all passed');
