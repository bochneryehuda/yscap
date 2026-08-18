'use strict';
/**
 * LT test — the read-only file, the pure half.
 *
 * Two properties, and the first is the reason this suite exists:
 *
 *   1. THE SOCIAL SECURITY NUMBER IS NEVER SELECTED. Not to be decrypted, not to be
 *      counted, not to be tested for emptiness. A `SELECT *` that fetches the
 *      encrypted bytes and deletes the key before responding is one careless spread
 *      away from shipping them — and it puts them in a log the moment anything
 *      upstream prints the row. So this is asserted against the SOURCE of the query,
 *      not against the JSON, because the JSON being clean today proves nothing about
 *      the row that was fetched to build it.
 *
 *   2. A MISSING FIGURE IS NULL, NEVER ZERO. "No rent on file" and "a rent of $0"
 *      are different loans, and a total of columns that are all empty is unknown
 *      rather than nothing.
 */

const fs = require('fs');
const path = require('path');
const file = require('../src/longterm/file');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const { describeParty, describeEmployment, sumOrNull, personName } = file._internals;
const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/file.js'), 'utf8');

// ── The number that never leaves ────────────────────────────────────────────
console.log('the Social Security number never leaves the server');

// Comments are stripped first: the header EXPLAINS the rule and names both columns,
// so a guard that read comments would fail on the sentence documenting it — and
// would then be "fixed" by deleting the explanation.
const code = src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

check(!/ssn_encrypted/.test(code),
  'THE ONE THAT MATTERS: `ssn_encrypted` appears nowhere in the code — it is never selected, so it can never be spread into a response or printed by a caller');
check(!/entity_ein_encrypted/.test(code),
  'nor `entity_ein_encrypted` — an entity\'s tax id is the same kind of secret');
check(!/SELECT\s+\*\s+FROM\s+lt_parties/i.test(code),
  'and lt_parties is never read with SELECT * — the columns are named, so a secret added to that table later is not picked up by accident');
check(/ssn_last4/.test(code),
  'the LAST FOUR are read, because that is the identifier a person reads back on a phone call');

// NOTE the party_type is `individual` — the value db/549's `lt_party_type` enum
// actually holds. A fixture saying 'person' would state something the database cannot,
// and would pass while proving nothing about a real row.
const party = describeParty({
  id: 'p1', party_type: 'individual', role: 'borrower',
  first_name: 'Dov', middle_name: 'A', last_name: 'Weiss', name_suffix: 'Jr.',
  ssn_last4: '4321', fico_experian: 712, fico_transunion: 705, fico_equifax: 718,
  fico_representative: 712,
});
check(party.ssnLast4 === '4321' && !('ssn' in party) && !('ssnEncrypted' in party),
  'a described party carries the last four and nothing else of the number');
check(party.name === 'Dov A Weiss Jr.', 'a name is its four parts in order');
check(party.credit.representative === 712,
  'the qualifying score is READ, not recomputed — which score qualifies is a credit-policy setting, and two answers on two screens is worse than one we did not derive');

// ── Person or entity ────────────────────────────────────────────────────────
console.log('\na party is a person or an entity, decided by what it IS');

const blankEntity = describeParty({ id: 'e1', party_type: 'entity', role: 'borrower' });
check(blankEntity.partyType === 'entity' && blankEntity.name === null && blankEntity.entity !== null,
  'an entity whose legal name has not been read yet is still an ENTITY with no name — rendering it as a person would invent a human');
check(!('ein' in (blankEntity.entity || {})) && !JSON.stringify(blankEntity).includes('ein_'),
  'and its tax id is absent from the entity block for the same reason as the SSN');
check(describeParty({ id: 'x', party_type: 'person' }).entity === null,
  'a person carries no entity block at all, rather than an empty one that reads as missing data');

// ── Missing is not zero ─────────────────────────────────────────────────────
console.log('\na missing figure is null, never zero');

check(sumOrNull([]) === null, 'a total of nothing is unknown, not $0');
check(sumOrNull([null, undefined, '']) === null,
  'THE ONE THAT MATTERS: columns that are ALL empty total to NULL — printing "$0" where nothing has been read is the confident wrong answer');
check(sumOrNull([100, null, 50]) === 150,
  'one real figure among blanks DOES total: there the blanks mean "none of this kind"');
check(sumOrNull([0]) === 0, 'and a real zero is still zero');
check(sumOrNull(['not a number']) === null, 'junk is not counted as a figure');

const emp = describeEmployment({ id: 'e', party_id: 'p', monthly_base_income: null, is_self_employed: false });
check(emp.income.base === null && emp.selfEmployed === false,
  'an income column nobody filled reads as null, while a boolean answered FALSE reads as false');

// ── The ARM block ───────────────────────────────────────────────────────────
console.log('\nthe ARM terms exist only on an adjustable loan');

// This used to assert only that SOME `=== 'arm'` appeared in the source, which passed
// while the code was wrong: the column is the enum ('fixed','adjustable'), so the word
// 'arm' can never be in it and the block was null on every adjustable loan. A guard
// that reads the source has to name the value the SCHEMA can hold.
check(!/'arm'/.test(code),
  "THE ONE THAT MATTERS: the block is not gated on the word 'arm' — `lt_amortization_type` is exactly ('fixed','adjustable'), so that test is false on every row ever written and the ARM terms would never appear");
check(/=== 'adjustable'/.test(code),
  'it is gated on the enum value the column really holds, so an adjustable loan shows its ARM terms and a fixed one shows no empty ARM row');

// ── Names ───────────────────────────────────────────────────────────────────
console.log('\nnames, and the blanks in them');

check(personName({ first_name: 'Sara', last_name: 'Klein' }) === 'Sara Klein', 'two parts join');
check(personName({ first_name: '  ', last_name: 'Klein' }) === 'Klein',
  'a blank part is dropped rather than leaving a double space');
check(personName({}) === null, 'and a party with no name at all answers null, never an empty string');

// ── Separation, and the investor ────────────────────────────────────────────
console.log('\nwhat this module may read');

const tables = [...code.matchAll(/\b(?:FROM|JOIN)\s+([a-zA-Z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());
check(tables.length > 0 && tables.every((t) => /^lt_/.test(t)),
  `every table it reads is an lt_ one (${[...new Set(tables)].join(', ')})`);
// This module DOES now read `lt_loan_investors` — who bought the loan — and that is
// safe for exactly one reason: nothing a client can reach ever loads it. `loadFile`
// is built for the staff file screen, where everything it returns is internal, so the
// property worth guarding is no longer "the investor table is absent" but "no client
// route pulls this module in". `test-lt-investor-block.js` holds the rest of rule 10.
for (const rel of ['src/longterm/routes/my-loans.js', 'src/longterm/routes/me.js']) {
  const routeSrc = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
  check(!/require\((['"])[^'"]*\/file\1\)/.test(routeSrc),
    `THE INVESTOR NEVER REACHES A CLIENT: ${rel} does not load this module — a borrower's screen is BUILT for the borrower, and this one carries the investor block`);
}
const writes = [...code.matchAll(/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-zA-Z_][\w.]*)/gi)];
check(writes.length === 0, 'and it writes nothing at all — this is the READ-ONLY file');

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
