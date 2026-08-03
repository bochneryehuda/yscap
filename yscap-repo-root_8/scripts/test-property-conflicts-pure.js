/**
 * WHERE TWO REPORTS DISAGREE ABOUT THE SAME HOUSE.
 *
 * The warehouse keeps one row per report × property and never overwrites, so a
 * property described by four appraisals holds four opinions. The roll-up picks
 * one for the property row — right for "what do we think this house is", and it
 * throws away the fact that the reports did not agree. That disagreement is a
 * review signal nobody else can compute, because nobody else holds several
 * appraisals of one house.
 *
 * THE TOLERANCE IS THE WHOLE DESIGN, and getting it wrong is how this becomes
 * noise everyone learns to ignore. Measured over the 152 real reports: 766
 * distinct properties, 119 seen by more than one report, 13 carrying a real
 * disagreement — and the raw differences include 1909-vs-1910 (rounding) beside
 * 1906-vs-1930 (a different building era).
 *
 * Pure — no database. Run: node scripts/test-property-conflicts-pure.js
 */
const { findConflicts, COMPARED } = require('../src/lib/research/conflicts');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const O = (id, facts) => ({ id, observed_on: `2026-0${id}-01`, role: 'comparable', ...facts });

// ---- the tolerances, one real corpus pair each ----------------------------
ok(findConflicts([O(1, { year_built: 1909 }), O(2, { year_built: 1910 })]).length === 0,
  'a year built ONE apart is not a conflict — records and estimates round');
ok(findConflicts([O(1, { year_built: 1906 }), O(2, { year_built: 1930 })])[0].field === 'year_built',
  '…but 24 years apart is: that is a different building era');
ok(findConflicts([O(1, { gla: 745 }), O(2, { gla: 719 })]).length === 0,
  'a living area 3.5% apart is not — two people with tapes land within a few percent');
ok(findConflicts([O(1, { gla: 1540 }), O(2, { gla: 1632 })])[0].field === 'gla',
  '…but 6% is: one of them counted a room the other did not');

// A DWELLING COUNT HAS NO TOLERANCE, and it ranks first — it is the fact the
// owner named before any other, and everything downstream keys on it.
{
  const c = findConflicts([O(1, { units: 2 }), O(2, { units: 3 })]);
  ok(c.length === 1 && c[0].severity === 'high',
    'a unit count of 2 against 3 is ALWAYS a conflict, and it is a high one');
  ok(/counted, not measured/.test(c[0].why), 'and it says why it has no tolerance');
}
ok(findConflicts([O(1, { units: 2, total_rooms: 6 }), O(2, { units: 3, total_rooms: 9 })])[0].field === 'units',
  'the unit count is reported above the room count');

// ---- never fabricate a disagreement ---------------------------------------
ok(findConflicts([O(1, { units: 2 }), O(2, {})]).length === 0,
  'a report that said NOTHING has not contradicted one that did');
ok(findConflicts([O(1, { units: 2 })]).length === 0, 'one report cannot disagree with itself');
ok(findConflicts([]).length === 0 && findConflicts(null).length === 0, 'no observations, no conflicts');
ok(findConflicts([O(1, { year_built: 1909 }), O(2, { year_built: 1910 }), O(3, { year_built: 1911 })]).length === 0,
  'three readings all inside tolerance are three values and ZERO disagreement — not three conflicts');
// A fact nobody has decided a tolerance for is not compared at all. Silence in
// the table means "we have not decided what a meaningful difference looks like",
// which is honest; a default of zero would flag every rounding difference.
ok(findConflicts([O(1, { condition_uad: 'C3' }), O(2, { condition_uad: 'C5' })]).length === 0,
  'a fact with no declared tolerance is not compared rather than compared at zero');

// ---- what a reviewer is handed --------------------------------------------
{
  const c = findConflicts([O(1, { units: 2 }), O(2, { units: 3 }), O(3, { units: 3 })])[0];
  ok(c.values.length === 2, 'both sides are reported — one entry per VALUE, not per pair');
  ok(c.values[1].said_by.length === 2, 'and each carries who said it, so it can be looked up');
  ok(/Neither is presumed wrong/.test(c.note),
    'and it says plainly that neither appraiser is presumed wrong — this is a question, not a fault');
  ok(c.tolerance === 'none — any difference is a disagreement', 'the tolerance is stated, not implied');
}

// Every compared fact must carry its reason — a tolerance nobody can justify is
// a number somebody will "tidy up" later.
for (const [field, spec] of Object.entries(COMPARED)) {
  ok(!!spec.why && !!spec.label && !!spec.severity, `${field} states its label, severity and WHY`);
}

console.log(failures ? `\ntest-property-conflicts-pure: ${failures} FAILED`
  : '\ntest-property-conflicts-pure: all passed');
process.exit(failures ? 1 : 0);
