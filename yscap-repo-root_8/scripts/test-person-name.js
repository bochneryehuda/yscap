/* Unit tests for src/lib/person-name.js — the ONE name splitter/joiner/comparer.
 * Run: node scripts/test-person-name.js   (no DB / network needed)
 *
 * These pin the OWNER'S RULE ("any name that has two words — split that in
 * half"), the three-field shape Encompass and MISMO need, and the middle-name
 * tolerance that stops a correctly-split Encompass copy from reading as a name
 * MISMATCH against a ClickUp one-liner.
 */
const N = require('../src/lib/person-name');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}\n  got      ${g}\n  expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
// Compare only the four name parts — confidence/reason are asserted separately.
const parts = (r) => ({ first: r.first, middle: r.middle, last: r.last, suffix: r.suffix });

// ── The owner's rule: two words split in half ───────────────────────────────
eq('two words split in half', parts(N.splitFullName('Dov Steiner')),
  { first: 'Dov', middle: '', last: 'Steiner', suffix: '' });
ok('two words is high confidence', N.splitFullName('Dov Steiner').confidence === 'high');
ok('two words never asks for review', N.splitFullName('Dov Steiner').needsReview === false);
eq('two words, messy spacing', parts(N.splitFullName('  Dov    Steiner  ')),
  { first: 'Dov', middle: '', last: 'Steiner', suffix: '' });

// ── Three words → a middle name ────────────────────────────────────────────
eq('three words', parts(N.splitFullName('Issac Michael Grunzweig')),
  { first: 'Issac', middle: 'Michael', last: 'Grunzweig', suffix: '' });
ok('a full-word middle asks for review', N.splitFullName('Issac Michael Grunzweig').needsReview === true);
eq('middle initial with a dot', parts(N.splitFullName('John A. Smith')),
  { first: 'John', middle: 'A.', last: 'Smith', suffix: '' });
ok('a middle initial is safe, no review', N.splitFullName('John A. Smith').needsReview === false);
ok('a middle initial is high confidence', N.splitFullName('John A. Smith').confidence === 'high');
eq('middle initial without a dot', parts(N.splitFullName('John A Smith')),
  { first: 'John', middle: 'A', last: 'Smith', suffix: '' });

// ── Four or more words ─────────────────────────────────────────────────────
eq('four words', parts(N.splitFullName('Maria Elena Sofia Rodriguez')),
  { first: 'Maria', middle: 'Elena Sofia', last: 'Rodriguez', suffix: '' });
ok('four words always asks for review', N.splitFullName('Maria Elena Sofia Rodriguez').needsReview === true);
ok('four words is low confidence', N.splitFullName('Maria Elena Sofia Rodriguez').confidence === 'low');

// ── One word ───────────────────────────────────────────────────────────────
eq('one word stays the first name', parts(N.splitFullName('Stauber')),
  { first: 'Stauber', middle: '', last: '', suffix: '' });
ok('one word asks for review', N.splitFullName('Stauber').needsReview === true);

// ── Blanks and our own placeholders never produce a review prompt ───────────
for (const v of ['', '   ', null, undefined, 'Unknown', 'unknown', 'Co-Borrower', 'N/A', 'TBD', 'Unknown Unknown']) {
  const r = N.splitFullName(v);
  ok(`placeholder ${JSON.stringify(v)} → blank, no review`,
    r.first === '' && r.last === '' && r.needsReview === false);
}

// ── Suffixes come OUT of the last name (the bug the old splitter created) ───
eq('Jr. is a suffix, not a surname', parts(N.splitFullName('John Michael Smith Jr.')),
  { first: 'John', middle: 'Michael', last: 'Smith', suffix: 'Jr.' });
eq('bare Jr', parts(N.splitFullName('John Smith Jr')),
  { first: 'John', middle: '', last: 'Smith', suffix: 'Jr.' });
eq('roman numeral', parts(N.splitFullName('Robert Downey III')),
  { first: 'Robert', middle: '', last: 'Downey', suffix: 'III' });
eq('two suffixes', parts(N.splitFullName('Jane Q Doe Jr MD')),
  { first: 'Jane', middle: 'Q', last: 'Doe', suffix: 'Jr. MD' });
eq('a two-word name never loses its surname to a suffix lookalike',
  parts(N.splitFullName('Sarah Do')), { first: 'Sarah', middle: '', last: 'Do', suffix: '' });
ok('a bare trailing V is treated as a name, never a regnal number',
  N.splitFullName('Ashok Kumar V').last === 'V');

// ── Titles are stripped, never stored as a first name ──────────────────────
eq('rabbi title stripped', parts(N.splitFullName('Rabbi Moshe Klein')),
  { first: 'Moshe', middle: '', last: 'Klein', suffix: '' });
eq('dr title stripped', parts(N.splitFullName('Dr. Jane A. Doe')),
  { first: 'Jane', middle: 'A.', last: 'Doe', suffix: '' });

// ── Surname particles belong to the LAST name ──────────────────────────────
eq('strong particle', parts(N.splitFullName('Ludwig van Beethoven')),
  { first: 'Ludwig', middle: '', last: 'van Beethoven', suffix: '' });
ok('a strong particle is confident, no review', N.splitFullName('Ludwig van Beethoven').needsReview === false);
eq('weak particles, lowercase', parts(N.splitFullName('Juan de la Cruz')),
  { first: 'Juan', middle: '', last: 'de la Cruz', suffix: '' });
ok('a weak particle asks for review', N.splitFullName('Juan de la Cruz').needsReview === true);
eq('a CAPITALISED weak particle is treated as a middle name, not a particle',
  parts(N.splitFullName('John De Smith')),
  { first: 'John', middle: 'De', last: 'Smith', suffix: '' });
ok('the first token is never swallowed by the surname',
  N.splitFullName('van Der Berg').first !== '' || N.splitFullName('van Der Berg').last === 'van Der Berg');

// ── Hyphens and apostrophes are ONE token ──────────────────────────────────
eq('hyphenated surname', parts(N.splitFullName('Anna Maria Lopez-Garcia')),
  { first: 'Anna', middle: 'Maria', last: 'Lopez-Garcia', suffix: '' });
eq('apostrophe surname', parts(N.splitFullName("Sean O'Brien")),
  { first: 'Sean', middle: '', last: "O'Brien", suffix: '' });

// ── "Last, First Middle" ───────────────────────────────────────────────────
eq('comma form', parts(N.splitFullName('Klein, Avrohom Yitzchok')),
  { first: 'Avrohom', middle: 'Yitzchok', last: 'Klein', suffix: '' });
ok('a comma form always asks for review', N.splitFullName('Klein, Avrohom Yitzchok').needsReview === true);
eq('a comma before a suffix is NOT an inversion', parts(N.splitFullName('John Smith, Jr.')),
  { first: 'John', middle: '', last: 'Smith', suffix: 'Jr.' });

// ── splitStoredName — healing what the old splitter already wrote ──────────
eq('middle name recovered from the stored first name',
  parts(N.splitStoredName({ first: 'Issac Michael', last: 'Grunzweig' })),
  { first: 'Issac', middle: 'Michael', last: 'Grunzweig', suffix: '' });
ok('and that heal is marked as a change',
  N.splitStoredName({ first: 'Issac Michael', last: 'Grunzweig' }).changed === true);
eq('an already-clean row is left alone',
  parts(N.splitStoredName({ first: 'Dov', last: 'Steiner' })),
  { first: 'Dov', middle: '', last: 'Steiner', suffix: '' });
ok('and is reported unchanged', N.splitStoredName({ first: 'Dov', last: 'Steiner' }).changed === false);
ok('a row that already has a middle name is never touched',
  N.splitStoredName({ first: 'Issac Michael', middle: 'Michael', last: 'Grunzweig' }).changed === false);
eq('a suffix stored as the surname is recovered',
  parts(N.splitStoredName({ first: 'John Michael Smith', last: 'Jr' })),
  { first: 'John', middle: 'Michael', last: 'Smith', suffix: 'Jr.' });
eq('stranded surname particles rejoin the surname',
  parts(N.splitStoredName({ first: 'Ludwig van', last: 'Beethoven' })),
  { first: 'Ludwig', middle: '', last: 'van Beethoven', suffix: '' });
ok('a placeholder row is never split',
  N.splitStoredName({ first: 'Unknown', last: 'Unknown' }).changed === false);
ok('a blank row is never split', N.splitStoredName({ first: '', last: '' }).changed === false);
eq('a title stored in the first name is dropped',
  parts(N.splitStoredName({ first: 'Rabbi Moshe', last: 'Klein' })),
  { first: 'Moshe', middle: '', last: 'Klein', suffix: '' });
// A two-token surname a human typed on the form is NEVER re-guessed.
eq('a human-typed multi-word surname is preserved',
  parts(N.splitStoredName({ first: 'Juan', last: 'de la Cruz' })),
  { first: 'Juan', middle: '', last: 'de la Cruz', suffix: '' });

// The SAME name, arriving from ClickUp or healed out of storage, must be judged
// identically — otherwise a borrower flips in and out of "please check this".
for (const full of ['Issac Michael Grunzweig', 'John A. Smith', 'Maria Elena Sofia Rodriguez', 'Ludwig van Beethoven']) {
  const live = N.splitFullName(full);
  const healed = N.splitStoredName({ first: full.slice(0, full.lastIndexOf(' ')), last: full.slice(full.lastIndexOf(' ') + 1) });
  eq(`same verdict live vs healed — ${full}`,
    { p: parts(live), r: live.needsReview }, { p: parts(healed), r: healed.needsReview });
}

// ── Joining ────────────────────────────────────────────────────────────────
eq('join three parts', N.joinFullName({ first: 'Avrohom', middle: 'Yitzchok', last: 'Klein' }), 'Avrohom Yitzchok Klein');
eq('join with a suffix', N.joinFullName({ first: 'John', middle: '', last: 'Smith', suffix: 'Jr.' }), 'John Smith Jr.');
eq('join positional', N.joinFullName('Dov', null, 'Steiner'), 'Dov Steiner');
eq('join snake_case row', N.joinFullName({ first_name: 'Dov', middle_name: 'A', last_name: 'Steiner' }), 'Dov A Steiner');
eq('join drops placeholders', N.joinFullName({ first: 'Unknown', last: 'Unknown' }), '');
eq('join blank', N.joinFullName({}), '');
eq('join last-first', N.joinLastFirst({ first: 'Avrohom', middle: 'Yitzchok', last: 'Klein' }), 'Klein, Avrohom Yitzchok');
// Round trip: split → join must give the same line back.
for (const full of ['Dov Steiner', 'Issac Michael Grunzweig', 'John A. Smith', 'John Smith Jr.', 'Ludwig van Beethoven']) {
  eq(`round trip — ${full}`, N.joinFullName(N.splitFullName(full)), full);
}

// ── displayName — THE ONE BIG NAME FIELD every screen reads ────────────────
eq('displayName prefers the generated full_name column',
  N.displayName({ full_name: 'Issac Michael Grunzweig', first_name: 'Issac', last_name: 'Grunzweig' }),
  'Issac Michael Grunzweig');
eq('displayName falls back to the parts when full_name was not selected',
  N.displayName({ first_name: 'Issac', middle_name: 'Michael', last_name: 'Grunzweig' }),
  'Issac Michael Grunzweig');
eq('displayName still works on a row with only first + last (nothing breaks)',
  N.displayName({ first_name: 'Dov', last_name: 'Steiner' }), 'Dov Steiner');
eq('displayName reads a prefixed co-borrower off a file row',
  N.displayName({ co_first_name: 'Rivka', co_middle_name: 'Leah', co_last_name: 'Klein' }, 'co_'),
  'Rivka Leah Klein');
eq('displayName prefers a prefixed full name too',
  N.displayName({ co_full_name: 'Rivka Leah Klein', co_first_name: 'Rivka' }, 'co_'), 'Rivka Leah Klein');
eq('displayName handles camelCase rows', N.displayName({ firstName: 'Dov', lastName: 'Steiner' }), 'Dov Steiner');
eq('displayName ignores a placeholder full name and rebuilds from the parts',
  N.displayName({ full_name: 'Unknown', first_name: 'Dov', last_name: 'Steiner' }), 'Dov Steiner');
eq('displayName on junk is a blank string, never a crash', N.displayName(null), '');

// ── Comparing — the Encompass ↔ ClickUp middle-name tolerance ──────────────
eq('identical names match', N.compareNames('Dov Steiner', 'Dov Steiner').status, 'match');
eq('case and punctuation are not a difference',
  N.compareNames('dov steiner', 'Dov  Steiner').status, 'match');
eq("Encompass's split copy vs our merged one-liner",
  N.compareNames({ first: 'Issac', middle: 'Michael', last: 'Grunzweig' },
    { first: 'Issac', middle: '', last: 'Grunzweig' }).status, 'match_detail_only');
eq('a middle INITIAL matches the full middle name',
  N.compareNames({ first: 'John', middle: 'A.', last: 'Smith' },
    { first: 'John', middle: 'Andrew', last: 'Smith' }).status, 'match_detail_only');
eq('a first INITIAL matches the full first name',
  N.compareNames({ first: 'J', last: 'Smith' }, { first: 'John', last: 'Smith' }).status, 'match_detail_only');
eq('a different surname is a real mismatch',
  N.compareNames('John Smith', 'John Jones').status, 'mismatch');
eq('a different first name is a real mismatch',
  N.compareNames('John Smith', 'Peter Smith').status, 'mismatch');
eq('a different middle name is a real mismatch',
  N.compareNames({ first: 'John', middle: 'Andrew', last: 'Smith' },
    { first: 'John', middle: 'Bernard', last: 'Smith' }).status, 'mismatch');
eq('a father and his son are different people',
  N.compareNames({ first: 'John', last: 'Smith', suffix: 'Jr.' },
    { first: 'John', last: 'Smith', suffix: 'Sr.' }).status, 'mismatch');
eq('one side missing a suffix is still the same person',
  N.compareNames({ first: 'John', last: 'Smith', suffix: 'Jr.' },
    { first: 'John', last: 'Smith' }).status, 'match_detail_only');
eq('a missing side is not comparable', N.compareNames('', 'John Smith').status, 'incomparable');
eq('a one-word side is not comparable rather than a false mismatch',
  N.compareNames('Stauber', 'John Stauber').status, 'incomparable');
ok('sameName is true for the middle-name-only difference',
  N.sameName('Issac Michael Grunzweig', 'Issac Grunzweig') === true);
ok('sameName is false for two different people',
  N.sameName('Issac Grunzweig', 'Peter Grunzweig') === false);
// The full-line form and the parts form must compare identically.
eq('string side ≡ parts side',
  N.compareNames('Issac Michael Grunzweig', { first: 'Issac', middle: 'Michael', last: 'Grunzweig' }).status, 'match');
// LEGACY SHAPE: a row the backfill has not reached yet still carries the middle
// name inside first_name. It must compare as the same person against a properly
// split Encompass copy — the comparison can never depend on the backfill.
eq('a legacy merged first name still matches a split copy',
  N.compareNames({ first: 'Issac Michael', last: 'Grunzweig' },
    { first: 'Issac', middle: 'Michael', last: 'Grunzweig' }).status, 'match');
eq('a legacy merged name against a copy with NO middle name',
  N.compareNames({ first: 'Issac Michael', last: 'Grunzweig' },
    { first: 'Issac', last: 'Grunzweig' }).status, 'match_detail_only');
eq('and a legacy row for a genuinely different person still mismatches',
  N.compareNames({ first: 'Peter Michael', last: 'Grunzweig' },
    { first: 'Issac', middle: 'Michael', last: 'Grunzweig' }).status, 'mismatch');

// ── Review copy is plain language, never a machine key ─────────────────────
for (const reason of Object.keys(N.REASON_TEXT)) {
  ok(`review copy for ${reason} reads like a sentence`,
    /^[A-Z].*[.]$/.test(N.reviewText(reason)) && !/_/.test(N.reviewText(reason)));
}
ok('an unknown reason still gets friendly copy', /check/i.test(N.reviewText('something_new')));

// ── Never throws, whatever it is handed ────────────────────────────────────
for (const junk of [null, undefined, 0, 1, {}, [], true, NaN, '   ,,,  ', '???']) {
  try { N.splitFullName(junk); N.splitStoredName(junk); N.joinFullName(junk); N.compareNames(junk, junk); pass++; }
  catch (e) { fail++; console.log(`FAIL never throws on ${JSON.stringify(junk)}: ${e.message}`); }
}

console.log(`\nperson-name: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
