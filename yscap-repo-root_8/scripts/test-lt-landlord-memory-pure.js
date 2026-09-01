#!/usr/bin/env node
'use strict';
/**
 * LT — THE LANDLORD IS REMEMBERED AGAINST THE HOME, AND THE KEY REFUSES RATHER
 * THAN GUESSES.
 *
 * Owner-directed 2026-08-31: *"the landlord contact information also saved
 * directly to the borrower's profile for next time to pre-fill. As long as he is
 * still living at the same primary address — if his primary address has been
 * updated in Encompass, then you should not automatically populate his landlord,
 * because probably the landlord changed."*
 *
 * THE OWNER'S RULE IS THE KEY, so this is where it is proven. There is no "has
 * the address changed?" test anywhere in the feature: the memory is keyed on
 * (borrower, home), so a borrower who moved produces a different key and matches
 * nothing. What has to hold, then, is exactly two things — that the same home
 * written two ordinary ways gives ONE key, and that two different homes never do.
 *
 * The second one is the expensive direction: a missed pre-fill costs somebody
 * picking the landlord by hand, which is what they do today; a wrong one posts a
 * stranger a form asking about somebody's tenancy and files the answer as
 * evidence on a loan.
 *
 * PROVEN TO FAIL: keying the memory on the person alone — the owner's whole rule
 * undone — fails four of section B here and both of section C in the database
 * suite, filling a moved borrower's old landlord in under their new address.
 *
 * PURE. No database.
 */
const M = require('../src/longterm/landlord-memory.js');

let pass = 0;
const fails = [];
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); return; }
  fails.push(detail ? `${name} — ${detail}` : name);
  console.log('  ✗ ' + name + (detail ? ` — ${detail}` : ''));
};

const HOME = { street: '3 Home St', city: 'Anytown', state: 'NJ', zip: '07001' };
const key = (o) => M.addressKey(o);

console.log('\nA. THE SAME HOME, WRITTEN THE WAYS PEOPLE ACTUALLY WRITE IT');
{
  const base = key(HOME);
  ok(!!base, 'a complete address has a key', String(base));
  const same = [
    ['casing', { street: '3 HOME ST', city: 'ANYTOWN', state: 'nj', zip: '07001' }],
    ['the long form of the street type', { ...HOME, street: '3 Home Street' }],
    ['punctuation', { ...HOME, street: '3 Home St.', city: 'Anytown,' }],
    ['stray spacing', { ...HOME, street: '  3   Home   St ' }],
    ['a ZIP+4, which is the same place', { ...HOME, zip: '07001-1234' }],
    ['a spelled-out direction', { ...HOME, street: '3 South Home Street' }],
  ];
  // The direction case needs its own base — "S Home St" is a different street
  // from "Home St", and that is correct.
  ok(key({ ...HOME, street: '3 S Home St' }) === key({ ...HOME, street: '3 South Home Street' }),
    'a spelled-out direction and its letter are one street');
  for (const [what, row] of same.slice(0, 5)) {
    ok(key(row) === base, `${what} does not make it a different home`, `${key(row)} vs ${base}`);
  }
  ok(key({ ...HOME, street: '3 Home St Apartment 4B' }) === key({ ...HOME, street: '3 Home St Apt 4B' })
    && key({ ...HOME, street: '3 Home St Unit 4B' }) === key({ ...HOME, street: '3 Home St #4B' }),
    'apartment, unit and a hash are one way of saying which door');
}

console.log('\nB. TWO DIFFERENT HOMES NEVER SHARE A KEY — the expensive direction');
{
  const base = key(HOME);
  const different = [
    ['a different house number', { ...HOME, street: '5 Home St' }],
    ['a different street', { ...HOME, street: '3 Oak St' }],
    ['a different town', { ...HOME, city: 'Othertown' }],
    ['a different state', { ...HOME, state: 'NY' }],
    ['a different ZIP', { ...HOME, zip: '07002' }],
    ['a different apartment in the same building', { ...HOME, street: '3 Home St Apt 4B' }],
    ['the same street name in the other direction', { ...HOME, street: '3 N Home St' }],
  ];
  for (const [what, row] of different) {
    ok(key(row) && key(row) !== base, `${what} is a different home`, `${key(row)} vs ${base}`);
  }
  // THE OWNER'S OWN CASE, said in their words: the borrower moved.
  ok(key({ street: '9 New Rd', city: 'Anytown', state: 'NJ', zip: '07001' }) !== base,
    'THE OWNER\'S RULE: a borrower who moved has a different key, so their old landlord matches nothing');
}

console.log('\nC. NOT ENOUGH ADDRESS IS NO KEY AT ALL — never a partial match');
{
  const none = [
    ['nothing', null],
    ['a string instead of a row', '3 Home St'],
    ['no street', { city: 'Anytown', state: 'NJ', zip: '07001' }],
    ['no state', { street: '3 Home St', city: 'Anytown', zip: '07001' }],
    ['neither a town nor a ZIP — a street name repeats across a state', { street: '3 Home St', state: 'NJ' }],
    ['punctuation only', { street: '...', state: 'NJ', city: 'Anytown' }],
  ];
  for (const [what, row] of none) ok(key(row) === null, `${what} has no key`, String(key(row)));
  // A town OR a ZIP is enough — either one says which town, and refusing both
  // would throw away a perfectly ordinary Encompass address.
  ok(!!key({ street: '3 Home St', state: 'NJ', city: 'Anytown' }), 'a town with no ZIP still keys');
  ok(!!key({ street: '3 Home St', state: 'NJ', zip: '07001' }), 'a ZIP with no town still keys');
}

console.log('\nD. THE SCREEN CAN NAME THE HOME, NOT SHOW A KEY');
{
  ok(M.addressText(HOME) === '3 Home St, Anytown, NJ 07001', 'the readable form', String(M.addressText(HOME)));
  ok(M.addressText({ street: '3 Home St', state: 'NJ' }) === '3 Home St, NJ',
    'a part we do not have is left out rather than printed empty', String(M.addressText({ street: '3 Home St', state: 'NJ' })));
  ok(M.addressText(null) === null && M.addressText({}) === null, 'and nothing at all reads as nothing');
}

console.log('\nE. THE READERS ARE THE THIN HALF — the rules above need no database');
{
  ok(typeof M.rememberForLoan === 'function' && typeof M.suggestForLoan === 'function'
    && typeof M.applyForLoan === 'function' && typeof M.backfillOnce === 'function',
    'remember / suggest / fill in / sweep are all exported');
  const fs = require('fs');
  const src = fs.readFileSync(require.resolve('../src/longterm/landlord-memory.js'), 'utf8');
  // The whole point of the split: this file loaded with no DATABASE_URL set, and
  // computed every key above, because the pool is only reached inside a reader.
  ok(!/^const db = require/m.test(src) && /lazyDb = \(\) => require\('\.\/db'\)/.test(src),
    'the pool is reached lazily, so the rules load and run with no database in sight');
  ok(!/sameAddress|require\('\.\.\/\.\.\/lib\/address/.test(src),
    'and it does not reach src/lib/address — the ledger names that as a crossing, and it is not authorized');
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
