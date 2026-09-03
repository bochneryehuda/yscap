'use strict';
/**
 * THE BORROWER IS TOLD THEIR TERMS ONCE PER CHANGE (owner-reported 2026-09-03:
 * an experience edit re-registered a file and the borrower got a "product
 * registered" email although nothing they could see had moved).
 *
 * The rule lives at the ONE door every terms email goes through
 * (terms-notify.js): a key of the borrower-visible numbers, compared with the
 * key of what was LAST SENT (db/692). This file pins the key and the decision;
 * test-borrower-terms-once-db.js proves the door against a real database.
 *
 * Proven to fail: (1) experience added to the key — case A2 went red; (2)
 * `decideSend` returning send:true on an equal key — A4 went red; (3) a caller
 * of sendBorrowerTerms bypassing the door (calling _internals.sendBorrowerTermsNow)
 * — the source guard went red.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { borrowerSentTermsKey, decideSend } = require('../src/lib/terms-notify');

let n = 0;
const eq = (a, b, w) => { assert.strictEqual(a, b, w); console.log('  ok  ', w); n++; };
const ne = (a, b, w) => { assert.notStrictEqual(a, b, w); console.log('  ok  ', w); n++; };
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); n++; };

const quote = (over = {}, sizing = {}) => ({
  program: 'standard', productLabel: 'Experienced (4+)', noteRate: 10.99, cashToClose: 61234.4, origination: 3750,
  sizing: { totalLoan: 187500, rehabHoldback: 40000, financedReserve: 0, initialAdvance: 147500, ...sizing },
  ...over,
});

console.log('\nA. the key reads the numbers the borrower sees, and nothing else');
const base = borrowerSentTermsKey(quote(), 12);
eq(borrowerSentTermsKey(quote(), 12), base, 'A1 the same quote twice → the same key');
eq(borrowerSentTermsKey(quote({ productLabel: 'Experienced (3)' }), 12), base,
  'A2 THE ONE THAT MATTERS: an experience-tier relabel with the same numbers → the SAME key (no email)');
eq(borrowerSentTermsKey(quote({ program: 'silver' }), 12), base, 'A3 a program-only switch with the same numbers → the same key');
eq(borrowerSentTermsKey(quote({ cashToClose: 61234.44 }), 12), base, 'A3b cents of rounding noise → the same key');
ne(borrowerSentTermsKey(quote({ noteRate: 11.25 }), 12), base, 'A5 the rate moved → a different key');
ne(borrowerSentTermsKey(quote({}, { totalLoan: 190000 }), 12), base, 'A6 the loan amount moved → different');
ne(borrowerSentTermsKey(quote({}, { rehabHoldback: 45000, initialAdvance: 142500 }), 12), base, 'A7 the advance / holdback split moved → different');
ne(borrowerSentTermsKey(quote({ cashToClose: 70000 }), 12), base, 'A8 cash to close moved → different');
ne(borrowerSentTermsKey(quote(), 18), base, 'A9 the term moved → different');
ok(typeof borrowerSentTermsKey(null, null) === 'string', 'A10 an empty quote still yields a string (no crash)');

console.log('\nB. the decision');
eq(decideSend({ lastKey: null, key: base }).send, true, 'B1 never told → send ("first")');
eq(decideSend({ lastKey: null, key: base }).reason, 'first', '…and says so');
eq(decideSend({ lastKey: base, key: base }).send, false, 'B2 told these exact terms already → NOT sent');
eq(decideSend({ lastKey: base, key: base }).reason, 'unchanged', '…reason: unchanged');
eq(decideSend({ lastKey: 'other', key: base }).send, true, 'B3 told different terms before → send ("changed")');
eq(decideSend({ lastKey: base, key: base, force: true }).send, true, 'B4 a person asking for a re-send always sends ("forced")');
eq(decideSend({ lastKey: base, key: base, force: true }).reason, 'forced', '…and says so');

console.log('\nC. every door goes through the memory');
const src = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const callers = ['src/routes/staff.js', 'src/routes/borrower.js', 'src/routes/admin-manual-programs.js'];
for (const f of callers) {
  const t = src(f);
  ok(/sendBorrowerTerms\(/.test(t), `${f} sends borrower terms through terms-notify`);
  ok(!/sendBorrowerTermsNow/.test(t), `${f} never bypasses the memory (sendBorrowerTermsNow is internal)`);
}
const tn = src('src/lib/terms-notify.js');
ok(/FROM borrower_terms_sent/.test(tn) && /INSERT INTO borrower_terms_sent/.test(tn), 'the door reads and writes db/692');
ok(/finalNumbersKey/.test(tn), 'the key is composed from the file\'s own five-numbers key, not a third hand-typed list');

console.log(`\ntest-borrower-terms-once-pure: ${n} assertions passed — the borrower is told their terms when a number they see moves, never because an input was edited.`);
