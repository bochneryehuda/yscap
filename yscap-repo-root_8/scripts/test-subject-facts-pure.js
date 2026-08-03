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

// ---------------------------------------------------------------------------
// F. A BLANK IS BLANK HOWEVER IT IS SPELLED — and zero is not "stated"
// ---------------------------------------------------------------------------
{
  // `Number('')` is 0, so stripping punctuation and handing the rest to Number
  // turned a box cleared with a SPACE into a living area of zero — filed with a
  // 200 and a "checked by a person" badge, on a grid with no size, room or
  // condition adjustment behind it. Reachable from the panel by clearing the box
  // with a space instead of a backspace.
  //
  // WHAT COUNTS AS BLANK IS WHAT THE PERSON SEES AS BLANK. Whitespace, yes —
  // including the zero-width space a paste out of a web page or a PDF carries,
  // which `.trim()` does NOT remove (U+200B is category Cf, not Zs) and which
  // would otherwise refuse with `"" is not a number`: a complaint about nothing
  // at all, quoting a character that renders as empty.
  for (const blank of ['   ', '\t', '\n', ' ', '​', ' ​ ', '﻿']) {
    const r = SF.cleanCorrections({ gla: blank });
    ok(r.problems.length === 0 && r.values.gla === null,
      `${JSON.stringify(blank)} is a BLANK, not a living area of zero`);
  }
  // PUNCTUATION IS NOT BLANK, AND CLEARING A FACT IS NOT A TYPO'S DECISION TO
  // MAKE. A "$" or a "," is something the person can SEE in the box. Reading it
  // as "we do not know" would DELETE a fact they never asked to delete — and on
  // `units` that is not cosmetic: with no unit count the comparable search stops
  // filtering by units at all, which is the one thing the owner asked can never
  // happen. So it is refused, and the refusal says how to clear it on purpose.
  for (const punct of ['$', ',', ' , ', '  $  ', '$ ,']) {
    const r = SF.cleanCorrections({ gla: punct });
    ok(r.values.gla === undefined && r.problems.length === 1,
      `${JSON.stringify(punct)} is REFUSED — it never silently clears the living area`);
    ok(/only punctuation/i.test(r.problems[0].why) && /clear it completely/i.test(r.problems[0].why),
      `and the refusal says what to do instead: ${r.problems[0].why}`);
  }
  // A TEXT fact gets the SAME answer — the first cut guarded only numbers, and
  // the text branch then STORED the punctuation. A property type of "$" is not
  // blank and not refused, it is a STATED fact: the panel stops printing "what
  // kind of property is not stated", and every comparable scores zero on a type
  // match against a dollar sign. That is the one fact the owner said may never
  // be unknown, quietly filled with a typo.
  for (const punct of ['$', ',', ' , ', '$ ,']) {
    const r = SF.cleanCorrections({ property_type: punct });
    ok(r.values.property_type === undefined && r.problems.length === 1,
      `${JSON.stringify(punct)} is REFUSED on a TEXT fact too — never stored as the property type`);
  }
  // A refusal is CAPPED. Uncapped, this came back twice in one 400 — once joined
  // into `error` and again in `problems` — so a pasted run of punctuation turned
  // a large request into a far larger response.
  {
    const r = SF.cleanCorrections({ gla: '$'.repeat(100000) });
    ok(r.problems.length === 1 && r.problems[0].why.length < 200,
      `a huge punctuation paste is refused with a SHORT message (${r.problems[0].why.length} chars)`);
  }
  // The invisible characters a real paste carries. The SOFT HYPHEN is the one a
  // PDF copy produces, and the first cut missed it — so it refused with
  // `"" is not a number`: a complaint quoting a character that renders as empty.
  // EVERY code point the class covers, not a sample of the ones it started with:
  // the class was widened to the bidi controls (U+061C, U+202A-E, U+2066-9), and every
  // character the original loop tested was ALREADY matched by the narrower version —
  // so reverting the widening left the suite fully green, which is no guard at all.
  for (const inv of [
    '\u00AD', '\u200E', '\u200F', '\u2062', '\u180E', '\u00AD\u200E',
    '\u061C', '\u202A', '\u202D', '\u202E', '\u2060', '\u2066', '\u2069', '\uFEFF',
    '\u202A\u200B\u2069',
  ]) {
    const r = SF.cleanCorrections({ gla: inv });
    ok(r.problems.length === 0 && r.values.gla === null,
      `${JSON.stringify(inv)} renders as nothing, so it is a BLANK — never a refusal about nothing`);
  }
  // …and the class sweeps ONLY invisibles. A character that RENDERS must survive, or
  // widening the pattern would start silently eating real text — far worse than the
  // defect it was widened to fix. U+2065 sits between two covered ranges and is
  // deliberately NOT in the class.
  for (const [visible, label] of [
    ['A\u2065B', 'an unassigned code point between the covered ranges'],
    ['A\u00B1B', 'a plus-minus sign'],
    ['A\u3000B', 'an ideographic space'],
  ]) {
    const r = SF.cleanCorrections({ property_type: visible });
    ok(typeof r.values.property_type === 'string' && r.values.property_type.length === 3,
      `${label} is NOT swept away as invisible (${JSON.stringify(r.values.property_type)})`);
  }
  // And an invisible character is never STORED into a text value: it would make
  // the confirmed value differ from the same words typed cleanly, so the
  // confirmation reads stale the instant it is made.
  {
    const r = SF.cleanCorrections({ property_type: '\u200BSingle Family' });
    ok(r.values.property_type === 'Single Family',
      `a pasted zero-width space is stripped from a stored value (${JSON.stringify(r.values.property_type)})`);
    // The DESCRIPTOR, not the key — every other caller passes the FACTS object, and
    // a string has no `.kind`, so the comparison silently takes the text path and
    // the assertion would hold for any two equal strings.
    const PT = SF.FACTS.find((x) => x.key === 'property_type');
    ok(SF.sameFactValue(PT, r.values.property_type, 'Single Family'),
      'so it compares equal to the same words typed by hand — the confirmation is not born stale');
    // …and it is a real comparison, not a function that says yes. Without this the
    // line above holds for any two equal strings and asserts nothing about the
    // comparison at all.
    ok(SF.sameFactValue(PT, 'Single Family', 'Condo') === false,
      'and two genuinely different property types still compare as CHANGED');
  }

  // PUNCTUATION MEANS PUNCTUATION, not the two marks the number reader strips. A
  // full stop is a likelier stray keystroke than a dollar sign, and it was still
  // being STORED as the property type — which reads as a stated fact and hides the
  // "not stated" warning on the one fact the owner said may never be unknown.
  for (const junk of ['.', '-', '--', '?', '/', '()', '*', '&', '#', '%', '_', ':', ';', "'"]) {
    const r = SF.cleanCorrections({ property_type: junk });
    ok(r.values.property_type === undefined && r.problems.length === 1,
      `${JSON.stringify(junk)} alone is never stored as the property type`);
  }
  // …and every real value still stores untouched.
  for (const real of ['Single Family', 'Multi 2-4', 'Condo', '2-4', 'Co-op', 'PUD', 'Mixed Use']) {
    ok(SF.cleanCorrections({ property_type: real }).values.property_type === real,
      `${JSON.stringify(real)} still stores unchanged`);
  }
  // THE ADDRESS IS COMPARED BOTH WAYS THROUGH THE SAME CLEANER. Once one side
  // stripped invisibles and the other did not, a confirmation written earlier
  // mismatched its own unchanged self forever — printing "was X, is now X", a
  // warning nobody can act on and only re-confirming can clear.
  {
    const addr = '12 Elm St\u200B';
    /* THE THIRD ARGUMENT IS THE WHOLE TEST. `confirmationStale` returns
       `{stale:false, changed:[]}` immediately when `confirmedAt` is falsy \u2014 BEFORE
       it looks at a single fact \u2014 so a two-argument call passes identically on the
       broken code, on the fixed code, and on two completely unrelated addresses.
       Proven: with the address fix reverted, this now FAILS with
       `was "12 Elm St\u200B", is now "12 Elm St"`. */
    const AT = '2026-08-03T00:00:00Z';
    const st = SF.confirmationStale({ display_address: addr }, { __address: addr }, AT);
    ok(st.stale === false && st.changed.length === 0,
      `an address carrying an invisible character does not report itself as changed (${
        JSON.stringify(st.changed)})`);
    // And the same call DOES notice a real move, so the line above is a result and
    // not an early return wearing one.
    const moved = SF.confirmationStale(
      { display_address: '99 Oak Ave' }, { __address: addr }, AT);
    ok(moved.stale === true && moved.changed.length === 1,
      'while re-pointing the subject at a different address IS reported as stale');
  }

  // The same, on the fact the owner cares about most.
  {
    const r = SF.cleanCorrections({ units: '$' });
    ok(r.values.units === undefined && r.problems.length === 1,
      'a stray character can never clear how many units a property has');
  }
  // A fat-fingered space becoming a plausible wrong number is worse than a
  // refusal, because nobody looks twice at a plausible number.
  ok(SF.cleanCorrections({ gla: ' 12 34 ' }).problems.length === 1,
    "' 12 34 ' is refused rather than silently read as 1234");
  for (const junk of ['0x10', '1e5', 'Infinity', 'NaN', '--5']) {
    ok(SF.cleanCorrections({ gla: junk }).problems.length === 1,
      `${JSON.stringify(junk)} is refused — a living area is typed in digits`);
  }
  ok(SF.cleanCorrections({ gla: '2,400' }).values.gla === 2400, 'and a comma-separated number still works');
  ok(SF.cleanCorrections({ gla: ' 2400 ' }).values.gla === 2400, 'as does an outer-trimmed one');

  // A CEILING, because there was none: a pasted phone number reaches a
  // numeric(8,2) adjustment percentage as an overflow three layers down.
  ok(SF.cleanCorrections({ gla: '9900000000' }).problems.length === 1, 'an absurd living area is refused');
  ok(SF.cleanCorrections({ beds: 400 }).problems.length === 1, 'and an absurd bedroom count');

  // A NON-STRING IS NOT AN ANSWER. `String({})` is "[object Object]".
  for (const junk of [{}, ['a', 'b'], true]) {
    ok(SF.cleanCorrections({ property_type: junk }).problems.length === 1,
      `${JSON.stringify(junk)} is refused rather than coerced into the property type`);
  }

  // ZERO IS NOT AN ANSWER FOR THE FACTS THE GRID GATES ON TRUTHINESS.
  // `suggestAdjustments` reads `sg = num(subject.gla)` and gates the size, room
  // and condition lines on `sg` being truthy — so gla:0 produces exactly the
  // silent grid a missing one does, while a plain `!= null` reported it stated.
  const zero = SF.reviewSubject({ units: 0, property_type: 'Single Family', gla: 0 });
  ok(zero.blindSpots.includes('gla'), 'a living area of ZERO is a blind spot, not a stated fact');
  ok(zero.blindSpots.includes('units'), 'and so is a unit count of zero');
  const zeroFact = zero.facts.find((f) => f.key === 'gla');
  ok(zeroFact.stated === false && zeroFact.gap === true, 'reported as not stated');
  // …but zero IS an answer where it is one.
  const halfBath = SF.reviewSubject({ units: 1, property_type: 'Single Family', gla: 1800, baths_half: 0 });
  ok(halfBath.facts.find((f) => f.key === 'baths_half').stated === true,
    'a house with no half bathroom has stated that it has none');

  // And the grid really does fall silent on zero, exactly as on missing.
  const RATES = { glaAdjustmentPerSqft: { value: 45, basis: 'x' }, perBedroom: { valuePerSqft: 20 },
    perConditionGrade: { valuePerSqft: 8, basis: 'y' } };
  const comp = { gla: 1200, beds: 2, condition_uad: 'C4', sale_price: 300000, sale_date: '2026-05-01' };
  const lines = V.suggestAdjustments({ units: 1, gla: 0, beds: 3, condition_uad: 'C3' }, comp, RATES,
    { today: '2026-08-01' }).map((l) => l.key);
  ok(!lines.includes('gla') && !lines.includes('room_count') && !lines.includes('condition'),
    `a living area of zero silences the same three adjustments a missing one does (${lines.join(',') || 'nothing'})`);
}

// ---------------------------------------------------------------------------
// G. A CONFIRMATION IS ABOUT A PROPERTY, NOT ONLY ABOUT ITS FACTS
// ---------------------------------------------------------------------------
{
  const at = '2026-08-01T10:00:00Z';
  const subject = { display_address: '12 Elm St', units: 1, property_type: 'Single Family',
    gla: 1800, condition_uad: 'C3', beds: 3, baths_full: 2 };
  const snap = SF.confirmedSnapshotOf(subject);
  ok(SF.reviewSubject(subject, { confirmedAt: at, confirmedSnapshot: snap }).confirmed === true,
    'the same property with the same facts stays confirmed');

  // Re-point the valuation at a DIFFERENT house with identical facts. No FACT has
  // moved, so without the identity the stamp stood and the screen said "a person
  // has checked these facts against the property" — about another property.
  const elsewhere = Object.assign({}, subject, { display_address: '900 Ocean Ave' });
  const moved = SF.reviewSubject(elsewhere, { confirmedAt: at, confirmedSnapshot: snap });
  ok(moved.stale.stale === true, 'changing the ADDRESS makes the confirmation stale');
  ok(moved.confirmed === false, 'and it stops reading as checked — it is a different property');
  ok(moved.stale.changed.some((c) => c.key === 'display_address'), 'naming the property itself as what moved');

  // Case and spacing are not a move.
  ok(SF.reviewSubject(Object.assign({}, subject, { display_address: '  12 ELM ST ' }),
    { confirmedAt: at, confirmedSnapshot: snap }).stale.stale === false,
    'and a re-cased address is the same house');

  // A confirmation recorded before the identity was stored must not be claimed
  // stale on the strength of an address it never captured.
  const legacy = Object.assign({}, snap); delete legacy.__address;
  ok(SF.reviewSubject(elsewhere, { confirmedAt: at, confirmedSnapshot: legacy }).stale.stale === false,
    'a confirmation from before the address was recorded is not retro-flagged on one');
}

// ---------------------------------------------------------------------------
// H. ONE DEFINITION OF "THE SAME ANSWER"
// ---------------------------------------------------------------------------
{
  const f = SF.FACTS.find((x) => x.key === 'property_type');
  ok(SF.sameFactValue(f, 'Single Family', 'single family') === true,
    'text is compared case-insensitively — and the confirm route uses THIS, so the door and the '
    + 'staleness check can no longer disagree about the same edit');
  const i = SF.FACTS.find((x) => x.key === 'gla');
  ok(SF.sameFactValue(i, 2400, '2400') === true, 'and a number is a number however it arrived');
  ok(SF.sameFactValue(i, null, null) === true && SF.sameFactValue(i, null, 0) === false,
    'while nothing and zero are different answers');
}

console.log(`\ntest-subject-facts-pure: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
