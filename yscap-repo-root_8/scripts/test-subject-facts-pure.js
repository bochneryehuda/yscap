/**
 * THE FACTS A VALUE LEANS ON — and what silently stops happening without them.
 *
 * A build-your-own valuation reads its subject out of the warehouse, and the
 * warehouse read it out of somebody's appraisal. Usually right, never confirmed.
 * This module is the step that turns "the system says" into "I checked", and the
 * assertions below are about the two things that make it worth having:
 *
 *  1. A MISSING FACT IS THE DANGEROUS ONE, NOT A WRONG ONE. A wrong living area
 *     produces a wrong number somebody can argue with. A MISSING one removes four
 *     adjustments from the grid — `suggestAdjustments` multiplies the bedroom,
 *     bathroom AND condition rates by the subject's own square footage and skips
 *     the size line entirely — so the value quietly becomes a plain average of the
 *     raw sale prices and still prints confidently. The wording therefore names
 *     the CONSEQUENCE, not the gap.
 *
 *  2. A CONFIRMATION HAS TO BE ABLE TO GO STALE. A "checked" stamp that survives
 *     the fact being changed afterwards is worse than no stamp: it launders an
 *     unchecked number as a checked one.
 *
 * Pure. Run: node scripts/test-subject-facts-pure.js
 */
'use strict';
const SF = require('../src/lib/research/subject-facts');
const V = require('../src/lib/research/valuation');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };

// ---------------------------------------------------------------------------
// A. THE LIST, AND ITS ORDER
// ---------------------------------------------------------------------------
{
  const keys = SF.FACTS.map((f) => f.key);
  ok(keys.indexOf('units') < keys.indexOf('gla'),
    'the unit count comes before the living area — it decides which sales are ELIGIBLE, '
    + 'and getting it wrong does not adjust a number, it values the property against the wrong kind of building');
  ok(keys.indexOf('gla') < keys.indexOf('condition_uad'),
    'and the living area comes before condition — four adjustments hang off it, condition moves one line');
  for (const f of SF.FACTS) {
    ok(typeof f.drives === 'string' && f.drives.length > 10, `${f.key} says what it drives`);
    ok(typeof f.without === 'string' && f.without.length > 10, `${f.key} says what stops happening without it`);
    // The wording is the whole point: "GLA is missing" is not something an
    // officer can act on. It must describe the consequence.
    ok(!/^is missing|^not stated|^blank/i.test(f.without), `${f.key}'s wording is a consequence, not a restatement`);
  }
  ok(SF.FACTS.filter((f) => f.critical).map((f) => f.key).join(',') === 'units,property_type,gla',
    'exactly three facts are critical: what kind of building, how many units, and how big');
}

// ---------------------------------------------------------------------------
// B. A BLANK OPTIONAL FACT IS NOT A GAP
// ---------------------------------------------------------------------------
{
  const full = { units: 1, property_type: 'Single Family', gla: 1800, condition_uad: 'C3',
    beds: 3, baths_full: 2, baths_half: 0, year_built: 1962 };
  const r = SF.reviewSubject(full);
  ok(r.gaps.length === 0, 'a fully stated subject has no gaps');
  ok(r.blindSpots.length === 0, 'and no blind spots');
  ok(/nobody has confirmed/i.test(r.headline), 'but it still says nobody has confirmed them: ' + r.headline);

  const noHalfBath = Object.assign({}, full); delete noHalfBath.baths_half;
  const r2 = SF.reviewSubject(noHalfBath);
  ok(r2.gaps.length === 0,
    'a property with no half bathroom is not a gap — badging that trains people to click past the badges that matter');

  const noYear = Object.assign({}, full); delete noYear.year_built;
  ok(SF.reviewSubject(noYear).gaps.length === 0, 'and neither is a missing year built, which adjusts nothing today');
}

// ---------------------------------------------------------------------------
// C. THE BLIND SPOTS, AND THAT THE GRID REALLY DOES GO QUIET
// ---------------------------------------------------------------------------
{
  const noGla = { units: 1, property_type: 'Single Family', condition_uad: 'C3', beds: 3, baths_full: 2 };
  const r = SF.reviewSubject(noGla);
  ok(r.blindSpots.includes('gla'), 'a subject with no living area has that as a blind spot');
  ok(/not being made|plain average/i.test(r.headline) || /depends on/i.test(r.headline),
    'and the headline says the adjustments are not being made: ' + r.headline);
  const glaFact = r.facts.find((f) => f.key === 'gla');
  ok(/average of the sale prices/i.test(glaFact.without),
    'naming what the value actually becomes without it');

  // THE CLAIM IS TRUE, AND THIS IS WHERE IT IS PROVEN — the wording above is only
  // worth printing if the grid really does fall silent. Same subject and comp
  // twice, once with a living area and once without.
  const RATES = {
    glaAdjustmentPerSqft: { value: 45, basis: 'peer adjustments' },
    perBedroom: { valuePerSqft: 20 },
    perBath: { valuePerSqft: 12 },
    perConditionGrade: { valuePerSqft: 8, basis: 'condition spread' },
  };
  const comp = { gla: 1200, beds: 2, baths_full: 1, condition_uad: 'C4', sale_price: 300000, sale_date: '2026-05-01' };
  const withGla = V.suggestAdjustments(
    { units: 1, gla: 1800, beds: 3, baths_full: 2, condition_uad: 'C3' }, comp, RATES, { today: '2026-08-01' });
  const withoutGla = V.suggestAdjustments(
    { units: 1, beds: 3, baths_full: 2, condition_uad: 'C3' }, comp, RATES, { today: '2026-08-01' });
  const keysOf = (ls) => (ls || []).map((l) => l.key).sort().join(',');
  ok(/gla/.test(keysOf(withGla)), `with a living area the grid suggests a size adjustment (${keysOf(withGla)})`);
  ok(/room_count/.test(keysOf(withGla)), 'and a room-count adjustment');
  ok(/condition/.test(keysOf(withGla)), 'and a condition adjustment');
  ok(!/gla/.test(keysOf(withoutGla)) && !/room_count/.test(keysOf(withoutGla))
    && !/condition/.test(keysOf(withoutGla)),
    `WITHOUT it all three vanish at once — the wording is not a scare, it is what happens (${keysOf(withoutGla) || 'nothing suggested'})`);

  const noUnits = { property_type: 'Single Family', gla: 1800 };
  ok(SF.reviewSubject(noUnits).blindSpots.includes('units'),
    "a missing unit count is a blind spot — the owner's own first rule is that a 2-4 is only ever compared with 2-4s");
}

// ---------------------------------------------------------------------------
// D. THE CONFIRMATION GOES STALE WHEN A CONFIRMED FACT MOVES
// ---------------------------------------------------------------------------
{
  const subject = { units: 1, property_type: 'Single Family', gla: 1800, condition_uad: 'C3', beds: 3, baths_full: 2 };
  const snap = SF.confirmedSnapshotOf(subject);
  const at = '2026-08-01T10:00:00Z';

  const fresh = SF.reviewSubject(subject, { confirmedAt: at, confirmedSnapshot: snap });
  ok(fresh.confirmed === true, 'a confirmation whose facts have not moved reads as confirmed');
  ok(fresh.stale.stale === false && fresh.stale.changed.length === 0, 'and nothing is flagged as changed');
  ok(/a person has checked/i.test(fresh.headline), 'the headline says a person checked it: ' + fresh.headline);

  const moved = Object.assign({}, subject, { gla: 2400 });
  const st = SF.reviewSubject(moved, { confirmedAt: at, confirmedSnapshot: snap });
  ok(st.stale.stale === true, 'changing a confirmed fact makes the confirmation STALE');
  ok(st.confirmed === false,
    'and it stops reading as confirmed — a stamp that survives the fact changing launders an unchecked number');
  ok(st.stale.changed.length === 1 && st.stale.changed[0].key === 'gla', 'naming exactly which fact moved');
  ok(st.stale.changed[0].was === 1800 && st.stale.changed[0].now === 2400, 'with both values');
  ok(/changed since/i.test(st.headline), 'and the headline leads with it: ' + st.headline);

  // COMPARED BY MEANING. Re-badging a valuation stale because a number arrived as
  // a string would train people to ignore the badge.
  const asText = Object.assign({}, subject, { gla: '1800', beds: '3' });
  ok(SF.reviewSubject(asText, { confirmedAt: at, confirmedSnapshot: snap }).stale.stale === false,
    '1800 and "1800" are the same living area — a confirmation is compared by meaning, not by spelling');
  const casing = Object.assign({}, subject, { property_type: 'SINGLE FAMILY', condition_uad: 'c3' });
  ok(SF.reviewSubject(casing, { confirmedAt: at, confirmedSnapshot: snap }).stale.stale === false,
    'and casing is not a change either');

  // CLEARING a confirmed fact IS a change — "we no longer know" is different from
  // "we knew and it is the same".
  const cleared = Object.assign({}, subject); delete cleared.gla;
  ok(SF.reviewSubject(cleared, { confirmedAt: at, confirmedSnapshot: snap }).stale.stale === true,
    'clearing a confirmed fact is a change, not a no-op');

  ok(SF.reviewSubject(subject, {}).confirmed === false, 'an unconfirmed valuation never reads as confirmed');
  ok(SF.confirmationStale(subject, null, at).stale === false,
    'and a stamp with no snapshot behind it is not claimed to be stale — it is simply unproven');
}

// ---------------------------------------------------------------------------
// E. CORRECTIONS ARE CHECKED, NOT COERCED
// ---------------------------------------------------------------------------
{
  const good = SF.cleanCorrections({ gla: '2,400', beds: 4, condition_uad: '  C2  ' });
  ok(good.problems.length === 0, 'ordinary corrections are accepted');
  ok(good.values.gla === 2400, 'a living area typed with a comma is read as the number');
  ok(good.values.condition_uad === 'C2', 'and text is trimmed');

  // THE WHOLE REQUEST IS REFUSED, NAMING THE FIELD. Filing the good ones and
  // losing the bad one silently is the "returned 200 but did not save" class.
  const bad = SF.cleanCorrections({ gla: 'about 2400', beds: 3 });
  ok(bad.problems.length === 1 && bad.problems[0].key === 'gla', 'a living area that is not a number is a problem');
  ok(/not a number/i.test(bad.problems[0].why), 'said in words: ' + bad.problems[0].why);
  ok(!('gla' in bad.values), 'and the unreadable value is never quietly stored');

  ok(SF.cleanCorrections({ gla: -50 }).problems.length === 1, 'a negative living area is refused');
  ok(SF.cleanCorrections({ condition_uad: 'x'.repeat(200) }).problems.length === 1, 'and text longer than the field holds');

  // A BLANK IS AN ANSWER. "We do not actually know" is a legitimate thing for a
  // person to say, and the fact then shows up as a blind spot — which is right.
  const blanked = SF.cleanCorrections({ gla: '' });
  ok(blanked.problems.length === 0 && blanked.values.gla === null,
    'clearing a fact is allowed and is recorded as cleared, not as a refusal');

  ok(Object.keys(SF.cleanCorrections({ nonsense: 1, indicated_value: 999999 }).values).length === 0,
    'a key that is not one of the facts is ignored — this door cannot be used to write a value');
}

console.log(`\ntest-subject-facts-pure: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
