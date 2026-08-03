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
 * noise everyone learns to ignore. Re-measured over the 152 real reports, seeded
 * through the real import: 954 distinct properties, 195 carrying more than one
 * OBSERVATION, 143 seen by more than one REPORT — and the raw differences include
 * 1909-vs-1910 (rounding) beside 1906-vs-1930 (a different building era).
 *
 * THE TWO POPULATIONS ARE NOT THE SAME, and confusing them was a real defect: one
 * report describes the same address more than once often enough that 52 of those
 * 195 properties hold two or more observations from a SINGLE report, which the
 * module used to read as two reports disagreeing.
 *
 * Pure — no database. Run: node scripts/test-property-conflicts-pure.js
 */
const { findConflicts, COMPARED } = require('../src/lib/research/conflicts');

let failures = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const O = (id, facts) => ({ id, observed_on: `2026-0${id}-01`, role: 'comparable', ...facts });
/** An observation stamped with the REPORT it came from. */
const R = (id, appraisalId, facts) => ({ ...O(id, facts), appraisal_id: appraisalId });

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

// ---- ONE REPORT IS ONE OPINION --------------------------------------------
// The unit of disagreement is the REPORT, not the row. One appraisal routinely
// describes the same address twice — as its comparable #3 and again as its
// comparable #4, or in the sales grid and again in the rent schedule, or as the
// subject and again in its own rent schedule. Every case below was taken from
// the real corpus, where this produced 3 of 21 conflicts, each captioned "Two
// reports describe this property differently."
// NOT SILENCE — the right answer is "this is one report, and here is what it
// said twice", never "two reports disagree". Asserting silence was the first
// cut's mistake and is checked against below.
const soleWithin = (rows) => {
  const c = findConflicts(rows);
  return c.length === 1 && c[0].within_report === true && !/Two reports/.test(c[0].note);
};
ok(soleWithin([R(1, 'A', { beds: 4 }), R(2, 'A', { beds: 3 })]),
  'ONE report listing the same house twice with different bedrooms is not TWO reports disagreeing');
ok(soleWithin([R(1, 'A', { gla: 2247 }), R(2, 'A', { gla: 2747 })]),
  'the sales grid and the rent schedule of ONE report are one opinion, not two');
ok(soleWithin([{ ...R(1, 'A', { property_type: 'sfr' }), role: 'subject' },
  { ...R(2, 'A', { property_type: 'Multi 2–4' }), role: 'rental_comparable' }]),
'a report describing a house as its subject and again as a rental comp is still one report');
{
  // …and the disagreement between two GENUINE reports still lands, even when one
  // of them stated its side twice.
  const c = findConflicts([R(1, 'A', { beds: 4 }), R(2, 'A', { beds: 4 }), R(3, 'B', { beds: 3 })]);
  ok(c.length === 1 && c[0].field === 'beds', 'two real reports still disagree when one of them said it twice');
  ok(c[0].values.length === 2 && c[0].values[0].said_by.length === 2,
    'and EVERY place a report said it is still listed, so the screen can show all of them');
}
{
  // A report that contradicts itself takes no part — and is COUNTED, never
  // dropped in silence.
  const c = findConflicts([R(1, 'A', { beds: 4 }), R(2, 'A', { beds: 9 }),
    R(3, 'B', { beds: 3 }), R(4, 'C', { beds: 6 })]);
  ok(c.length === 1 && c[0].values.length === 2,
    'a report that contradicts ITSELF is left out of the comparison between the others');
  ok(c[0].reports_inconsistent === 1, 'and it is counted, so nothing is silently discarded');
}
ok(findConflicts([R(1, 'A', { units: 2 }), R(2, 'B', { units: 3 })])[0].severity === 'high',
  'two different reports disagreeing on the unit count is untouched by any of this');

// …AND A REPORT THAT SAYS TWO THINGS IS STILL REPORTED — under its own sentence.
// Excluding it from the comparison was right; going SILENT about it was not, and
// the first cut did exactly that whenever the exclusion left fewer than two
// opinions. Both cases below are real corpus properties that the page stopped
// mentioning at all.
{
  const c = findConflicts([R(1, 'A', { year_built: 1950 }), R(2, 'A', { year_built: 1926 })]);
  ok(c.length === 1 && c[0].within_report === true,
    'ONE report reading 1950 and 1926 is still surfaced — as a question about that report');
  ok(!/Two reports/.test(c[0].note) && /One report describes/.test(c[0].note),
    'and it never claims two reports disagreed');
  ok(c[0].severity === 'low' && c[0].reports_inconsistent === 1,
    'it sits one step quieter than a real dispute, and says how many reports are in that state');
  ok(Array.isArray(c[0].values[0].said) && c[0].values[0].said.length === 2,
    'it states BOTH things the report said, rather than claiming a pair exists');
}
ok(findConflicts([R(1, 'A', { beds: 4 }), R(2, 'A', { beds: 5 }),
  R(3, 'B', { beds: 4 }), R(4, 'B', { beds: 5 })])[0].reports_inconsistent === 2,
'two reports each saying two things counts both of them');

// THE ANSWER MUST NOT DEPEND ON ROW ORDER. Two rows of one report can differ and
// still be inside tolerance, so whichever spoke for the report decided the
// result — and the query orders only by `observed_on`, which one report's rows
// routinely share, so the tie-break was arbitrary Postgres row order and the same
// property could flip between two page loads.
{
  const rows = [R(1, 'A', { year_built: 1909 }), R(2, 'A', { year_built: 1911 }), R(3, 'B', { year_built: 1913 })];
  const fwd = findConflicts(rows).length;
  const rev = findConflicts([rows[1], rows[0], rows[2]]).length;
  ok(fwd === rev, 'the same observations in a different order give the same answer');
}

// A COMPARISON KEY MAY NEVER BREAK THE PAGE. `findConflicts` is pure and its
// callers do not guard it, so a key that throws would take the property screen
// down over a review signal.
{
  const boom = { units: { label: 'U', kind: 'exact', severity: 'high', why: 'w',
    compareKey: () => { throw new Error('boom'); } } };
  let threw = false; let got = [];
  try { got = findConflicts([R(1, 'A', { units: '2' }), R(2, 'B', { units: '3' })], { compared: boom }); }
  catch (_) { threw = true; }
  ok(!threw && got.length === 1,
    'a compareKey that throws falls back to the plain text instead of taking the page with it');
}
ok(findConflicts([O(1, { beds: 4 }), O(2, { beds: 3 })]).length === 0 === false,
  'a row with no report id cannot be proven to share one, so it still stands alone');

// ---- COMPARED BY MEANING, NEVER BY SPELLING -------------------------------
// The warehouse stores two vocabularies for the property type, both written by
// the ingest: a SUBJECT observation carries the canonical key, a COMPARABLE the
// display label. On the real corpus BOTH property-type hits were this artifact,
// at HIGH severity — 2 of the 3 high-severity conflicts in the whole warehouse.
ok(findConflicts([R(1, 'A', { property_type: 'multi_2_4' }), R(2, 'B', { property_type: 'Multi 2–4' })]).length === 0,
  '`multi_2_4` and `Multi 2–4` are the same property type spelled two ways, not a conflict');
ok(findConflicts([R(1, 'A', { property_type: 'sfr' }), R(2, 'B', { property_type: 'SFR (1 unit)' })]).length === 0,
  'and so are `sfr` and `SFR (1 unit)`');
ok(findConflicts([R(1, 'A', { property_type: 'condo' }), R(2, 'B', { property_type: 'Condo' })]).length === 0,
  'and `condo` and `Condo`');
{
  const c = findConflicts([R(1, 'A', { property_type: 'sfr' }), R(2, 'B', { property_type: 'Multi 2–4' })]);
  ok(c.length === 1 && c[0].severity === 'high',
    'a REAL property-type disagreement — a house against a duplex — still fires at high severity');
}
ok(findConflicts([R(1, 'A', { property_type: 'Warehouse' }), R(2, 'B', { property_type: 'Duplex Cottage' })]).length === 1,
  'a type the repo does not recognize keys to ITSELF — never collapsed with every other unknown');
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
