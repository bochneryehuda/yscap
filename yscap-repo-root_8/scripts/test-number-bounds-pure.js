'use strict';
/* =====================================================================
   WHAT A COLUMN CAN HOLD — the shared ceilings, and the two guards built on
   them (post-merge audit 2026-07-31).

   This exists because the "a number too big for its column comes back as a
   500" rule was fixed FOUR times, one column at a time, and each fix left a
   different column wrong — while three doors each carried their own inline copy
   of the money ceiling, so a correction to one never reached the others. The
   limits now live in ONE module and every door delegates. These assertions pin
   the limits themselves, the two edges that were genuinely wrong before
   (the negative tie, and int4 vs money), and the two guards that consume them.

   PURE — no DB, no server, no network.
   Run: node scripts/test-number-bounds-pure.js
   ===================================================================== */

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (a, b, m) => assert(String(a) === String(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

const nb = require('../src/lib/number-bounds');
const F = require('../src/lib/fields');
const NUL = String.fromCharCode(0);

/* ---------------------------------------------------------------- *
 * 1. numeric(14,2) — the money ceiling, and the SIGN edge.
 * ---------------------------------------------------------------- */
console.log('--- numeric(14,2): the money ceiling ---');
assert(!nb.moneyOverflows(999999999999.98), '999,999,999,999.98 fits');
assert(!nb.moneyOverflows(-999999999999.98), 'and so does its negative');
assert(nb.moneyOverflows(1e12), '10^12 does not fit');
assert(nb.moneyOverflows(-1e12), 'nor does its negative');
/* THE TIE. Postgres rounds to two decimals BEFORE checking for overflow and
   rounds HALF AWAY FROM ZERO; JavaScript's Math.round breaks ties toward +∞.
   So the SIGNED round said -999999999999.995 was inside the ceiling, and it
   went on to overflow in Postgres — a 500 an earlier round believed it had
   closed for both signs. Rounding the MAGNITUDE is what makes these agree. */
assert(nb.moneyOverflows(999999999999.995), 'a value that ROUNDS UP to 10^12 is refused (+)');
assert(nb.moneyOverflows(-999999999999.995), '…and so is the same value negative (the tie bug)');
assert(!nb.moneyOverflows(NaN) && !nb.moneyOverflows(Infinity),
  '"not a number" is a different refusal, not an overflow');

console.log('\n--- int4 and the note rate ---');
assert(!nb.intOverflows(2147483647) && nb.intOverflows(2147483648), 'int4 stops at 2,147,483,647');
assert(!nb.intOverflows(-2147483648) && nb.intOverflows(-2147483649), '…and at -2,147,483,648');
assert(!nb.rateOverflows(0.1199), 'a note rate held as a fraction fits numeric(7,5)');
assert(nb.rateOverflows(100), 'a rate of 100 (as a fraction) does not');
assert(nb.rateOverflows(1e6), 'nor does the rate an oversized markup produces');

/* ---------------------------------------------------------------- *
 * 2. columnProblem — the message names the FIELD and quotes the right limit.
 *    Quoting a MONEY limit for a unit COUNT is the "follow the advice, get
 *    another 500" trap two earlier rounds each shipped.
 * ---------------------------------------------------------------- */
console.log('\n--- the refusal quotes the ceiling that actually applies ---');
eq(nb.columnProblem('purchasePrice', 5000, 'money'), '', 'an ordinary price is fine');
eq(nb.columnProblem('purchasePrice', null, 'money'), '', 'a missing value is not a problem');
assert(/999,999,999,999\.99/.test(nb.columnProblem('purchasePrice', 1e15, 'money')),
  'an oversized money field quotes the MONEY limit');
assert(/2,147,483,647/.test(nb.columnProblem('units', 1e15, 'int')),
  'an oversized COUNT quotes the int4 limit, not the money one');
assert(!/999,999,999,999/.test(nb.columnProblem('units', 1e15, 'int')),
  '…and never quotes a money limit for a count');
assert(/whole number/.test(nb.columnProblem('units', 2.5, 'int')), 'a fractional count is refused as such');
assert(/between 0 and 24/.test(nb.columnProblem('requestedIrMonths', 99, { min: 0, max: 24, what: 'months of interest reserve' })),
  'a column whose CHECK is narrower than its type quotes the CHECK');
assert(/Purchase price/.test(nb.columnProblem('purchasePrice', 1e15, 'money', 'Purchase price')),
  'and the message can speak the form’s language rather than the column’s');

/* ---------------------------------------------------------------- *
 * 3. textColumn — trimmed, blank is NULL, ONE cap per column, NUL removed.
 * ---------------------------------------------------------------- */
console.log('\n--- a free-text column: trimmed, blank means NULL, capped by the COLUMN ---');
eq(F.textColumn('   ', 'payoff_lender'), null, 'A BOX OF SPACES IS AN EMPTY BOX');
eq(F.textColumn('', 'payoff_lender'), null, 'an empty string is not stated');
eq(F.textColumn(null, 'payoff_lender'), null, 'an explicit null is not stated');
eq(F.textColumn(undefined, 'payoff_lender'), null, 'and neither is undefined');
eq(F.textColumn('  Chase Home Finance  ', 'payoff_lender'), 'Chase Home Finance', 'a real value is trimmed');
/* The string "null" is what `String(b[k])` produced from an explicit JSON null
   — non-blank to every reader, so the file reported itself complete and the
   borrower's screen read "Lender being paid off: null". textColumn's callers
   pass the real null; this pins that a real null never becomes text. */
assert(F.textColumn(null, 'payoff_lender') !== 'null', 'an explicit null NEVER becomes the string "null"');
eq(F.textColumn('AB' + NUL + 'C', 'payoff_loan_number'), 'ABC',
  'a NUL byte is removed (Postgres cannot store one in a text column at all)');
eq(F.textColumn(NUL + '  ' + NUL, 'payoff_lender'), null, 'a value that is ONLY NULs and spaces is not stated');
/* ONE cap per COLUMN, not per door. These two were capped 200 / 200 / 500 by
   three different doors, so what a value became depended on the screen. */
eq(F.textColumn('x'.repeat(900), 'payoff_lender', 500).length, 200, 'payoff_lender caps at 200 whatever the door asks for');
eq(F.textColumn('x'.repeat(900), 'payoff_loan_number', 500).length, 100, 'payoff_loan_number caps at 100, likewise');
eq(F.textColumn('x'.repeat(900), null, 500).length, 500, 'a value with NO column of its own keeps its caller’s cap');
eq(F.textColumn('x'.repeat(900), null).length, 200, '…and falls back to the shared default when none is given');

/* ---------------------------------------------------------------- *
 * 4. applicationNumberProblem — the guard the five CREATE doors were missing.
 * ---------------------------------------------------------------- */
console.log('\n--- an application’s numbers, checked before anything is written ---');
eq(F.applicationNumberProblem({}), '', 'an empty body has nothing to refuse');
eq(F.applicationNumberProblem({ purchasePrice: '450000', arv: 900000, units: 4 }), '',
  'an ordinary application passes');
eq(F.applicationNumberProblem({ purchasePrice: '450,000' }), '',
  'a FORMATTED money string is judged on its parsed value, not its text');
assert(/Payoff amount/.test(F.applicationNumberProblem({ payoffAmount: '99999999999999999' })),
  'an oversized payoff amount is named — this is the field the audit reproduced');
assert(/Purchase price/.test(F.applicationNumberProblem({ purchasePrice: 1e15 })),
  'and so is an oversized purchase price');
assert(/Number of units/.test(F.applicationNumberProblem({ units: 5e15 })),
  'an oversized unit COUNT is named as a count');
assert(/2,147,483,647/.test(F.applicationNumberProblem({ units: 5e15 })),
  '…and quotes int4’s limit, the one that actually applies to it');
eq(F.applicationNumberProblem({ units: 4.7 }), '',
  'a fractional count is NOT refused — every create door truncates it, and always has');
eq(F.applicationNumberProblem({ purchasePrice: 'abc', units: 'xyz' }), '',
  'unreadable input is "not provided" on these doors, exactly as before — never a refusal');
eq(F.applicationNumberProblem({ asIsValue: '0', arv: '0' }), '',
  'a typed ZERO is a real value and is never refused');
eq(F.applicationNumberProblem(null), '', 'a missing body never throws');
/* One message, one box. Stopping at the first problem is deliberate: a list of
   every bad field is harder to act on than the first one to fix. */
assert(F.applicationNumberProblem({ purchasePrice: 1e15, arv: 1e15 }).indexOf(';') < 0,
  'the refusal names ONE field to fix, not a list');

/* ---------------------------------------------------------------- *
 * 5. quoteStorageProblem — a register whose numbers the file cannot record.
 * ---------------------------------------------------------------- */
console.log('\n--- a quote the file cannot record is refused before the transaction opens ---');
const pr = require('../src/lib/product-registration');
eq(pr.quoteStorageProblem({ noteRate: 0.1199, sizing: { totalLoan: 450000 } }, { targetLTC: 0.85 }), '',
  'an ordinary quote records fine');
assert(/note rate/i.test(pr.quoteStorageProblem({ noteRate: 1e6, sizing: { totalLoan: 450000 } }, {})),
  'a rate an oversized markup produced is refused, naming the rate');
assert(/admin pricing zone/i.test(pr.quoteStorageProblem({ noteRate: 1e6, sizing: {} }, {})),
  '…and points at the box that caused it');
assert(/loan amount/i.test(pr.quoteStorageProblem({ noteRate: 0.11, sizing: { totalLoan: 1e15 } }, {})),
  'an unstorable loan amount is refused, naming the amount');
assert(/loan-to-cost/i.test(pr.quoteStorageProblem({ noteRate: 0.11, sizing: { totalLoan: 1 } }, { targetLTC: 1e6 })),
  'an unstorable target LTC is refused, naming the LTC');
eq(pr.quoteStorageProblem({}, {}), '', 'a quote with nothing to check is not refused');
eq(pr.quoteStorageProblem(null, null), '', 'and a missing quote never throws');

console.log(failures ? `\n${failures} assertion(s) failed` : '\nALL number-bounds assertions passed');
process.exit(failures ? 1 : 0);
