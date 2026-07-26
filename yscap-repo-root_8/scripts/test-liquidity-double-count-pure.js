'use strict';
/**
 * THE SAME ACCOUNT MUST NEVER BE COUNTED TWICE (owner-reported 2026-07-26, live file).
 *
 * The assets table listed:
 *   MOSES WEIL / Vanderbilt ••0120   $88,454
 *   MOSES WEIL / Vanderbilt          $89,474    ← the same account; the number just wasn't read
 * and summed both. The owner: *"You're counting the same assets twice, which is a major major major
 * major issue."*
 *
 * The per-account collapse was working — these were two different KEYS, because one statement's
 * account number came through and the other's did not. So an unreadable account number on ONE month
 * silently inflated the borrower's liquidity by a whole month's balance, which can clear a shortfall
 * that is real. Inflating is the one direction this must never fail in.
 *
 * The DANGEROUS half of the fix is over-folding: collapsing two genuinely different accounts would
 * UNDER-state assets and invent a shortfall. That direction is safe (a human clears it) but still
 * wrong, so a good share of these assertions are about what must stay separate.
 *
 * Pure: no DB, no AI.
 */
const R = require('path').resolve(__dirname, '..');
const BL = require(R + '/src/lib/underwriting/bank-liquidity');
const { sameBank, sameHolder, bankStem } = BL._internals;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

const CTX = { borrower: { first_name: 'Moses', last_name: 'Weil' }, entityNames: [] };
const stmt = (id, f) => ({ doc_type: 'bank_statement', document_id: id, fields: f });
const run = (list, opts) => BL.assessBankLiquidity(CTX, list, opts || {});

// ---------- the owner's exact file ----------
const weil = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'June 1 - June 30, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 89474, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(weil.accountsCount === 1,
  `the two Vanderbilt statements are ONE account (got ${weil.accountsCount})`);
ok(weil.qualifyingTotal === 89474,
  `only the LATEST month's balance counts (got ${weil.qualifyingTotal}, must be 89474 — not 177928)`);
ok(weil.qualifyingTotal !== 88454 + 89474, 'the two balances are never summed');
ok(weil.notCountedTwice.length === 1, 'the fold is recorded so the arithmetic can be shown');
ok(((weil.notCountedTwice[0] || {}).matchedAccounts || []).includes('••0120'),
  `it names the account it was folded into (got ${JSON.stringify((weil.notCountedTwice[0] || {}).matchedAccounts)})`);

// The number-less statement being the OLDER month must not drag the total down either.
const olderNumberless = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 89474, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88454, statementPeriod: 'June 1 - June 30, 2026' }),
]);
ok(olderNumberless.qualifyingTotal === 89474,
  `the latest month still wins when the number-less one is older (got ${olderNumberless.qualifyingTotal})`);

// ---------- bank-name drift must not defeat the fold ----------
for (const [a, b] of [['Chase', 'JPMorgan Chase Bank, N.A.'], ['Chase Bank', 'Chase'],
  ['Vanderbilt', 'Vanderbilt Financial'], ['TD Bank N.A.', 'TD']]) {
  ok(sameBank(a, b) === true, `"${a}" and "${b}" are the same bank`);
}
// …and genuinely different banks must NOT match.
for (const [a, b] of [['Chase', 'Citibank'], ['Wells Fargo', 'Wachovia'], ['TD', 'PNC'], ['M&T', 'Chase']]) {
  ok(sameBank(a, b) === false, `"${a}" and "${b}" are different banks`);
}
// A missing bank name proves nothing and must never license a fold.
ok(sameBank(null, 'Chase') === false && sameBank('', 'Chase') === false, 'a blank bank name never folds');
// A name that is ALL legal-form noise leaves an empty stem, which must not match everything.
// A name made ENTIRELY of generic words ("Bank, N.A.", "US Bank", "Credit Union") is still a name —
// it compares as itself rather than as nothing, so two statements from the same US Bank account DO
// fold, while it still never matches a differently-named bank.
ok(bankStem('Bank, N.A.') === 'bank n a', 'an all-generic name keeps its own text as the stem');
ok(sameBank('Bank, N.A.', 'Chase') === false, 'and it still does not match a different bank');
ok(sameBank('US Bank', 'US Bank') === true, '"US Bank" matches itself — every word of it is generic');
ok(sameBank('US Bank', 'Trust Bank') === false, 'two different all-generic names still do not match');
// The trap a substring or prefix test falls into: these are two different banks.
ok(sameBank('Citibank', 'Citizens Bank') === false, '"Citi" is not "Citizens" — whole words, not substrings');

// ---------- holder-name formatting must not defeat it either ----------
ok(sameHolder('MOSES WEIL', 'Moses Weil') === true, 'case does not matter');
ok(sameHolder('WEIL MOSES', 'Moses Weil') === true, 'surname-first bank formatting is the same person');
ok(sameHolder('MOSES A WEIL', 'Moses Weil') === true, 'a middle initial does not split an account');
ok(sameHolder('MOSES WEIL', 'SARAH WEIL') === false, 'a different first name is a different person');
ok(sameHolder('MOSES WEIL', 'MW TRADING LLC') === false, 'a person and an entity are never the same holder');
ok(sameHolder('', 'Moses Weil') === false, 'a blank holder never folds');

// ---------- and the half that must NOT be lost: genuinely separate accounts ----------
const twoRealAccounts = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '009988',
    closingBalance: 50000, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(twoRealAccounts.accountsCount === 2 && twoRealAccounts.qualifyingTotal === 138454,
  `two accounts at DIFFERENT banks stay two and both count (got ${twoRealAccounts.accountsCount} / ${twoRealAccounts.qualifyingTotal})`);

const differentPeople = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '004477',
    closingBalance: 20000, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(differentPeople.accountsCount === 2 && differentPeople.qualifyingTotal === 108454,
  `two NUMBERED accounts at the same bank stay two — the fold only ever touches number-less statements (got ${differentPeople.accountsCount})`);

// A number-less statement that matches NOTHING is a real separate account and must still count.
const lonelyNumberless = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 50000, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(lonelyNumberless.accountsCount === 2 && lonelyNumberless.qualifyingTotal === 138454,
  `a number-less account at a bank with no numbered match still counts (got ${lonelyNumberless.qualifyingTotal})`);

// ---------- the ambiguous case: resolve DOWNWARD ----------
// Two numbered accounts at the same bank under the same name, plus one statement with no number.
// It IS one of them — we cannot tell which — so adding it again could only inflate.
const ambiguous = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '004477',
    closingBalance: 20000, statementPeriod: 'July 1 - July 31, 2026' }),
  // A DIFFERENT month, so the same-period proof below cannot separate it — it really could be
  // either account.
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 75000, statementPeriod: 'August 1 - August 31, 2026' }),
]);
ok(ambiguous.qualifyingTotal === 108454,
  `an unattributable statement adds NOTHING rather than inflating (got ${ambiguous.qualifyingTotal}, must be 108454)`);
ok(ambiguous.notCountedTwice.some((n) => n.ambiguous === true),
  'and it is flagged as ambiguous so a human can attribute it by hand');

// ---------- the shortfall must be computed off the corrected total ----------
// The whole point: an inflated total can clear a shortfall that is real.
const short = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'June 1 - June 30, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 89474, statementPeriod: 'July 1 - July 31, 2026' }),
], { requiredLiquidity: 120000 });
ok(short.qualifyingTotal === 89474, 'the counted total is the single latest balance');
ok(short.findings.some((f) => f.code === 'bank_liquidity_short'),
  'a REAL shortfall is now reported — the double-count had been hiding it');

// ---------- AUDIT 2026-07-26 ----------

// TWO BALANCES FOR ONE PERIOD PROVE TWO ACCOUNTS. The riskiest over-fold needs no name fuzziness:
// a checking and a savings at the same bank under the same name, only the savings' number
// unreadable. One account cannot end the same month at two different balances.
const checkingAndSavings = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 75000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(checkingAndSavings.qualifyingTotal === 125000,
  `a checking and a savings at one bank stay TWO accounts (got ${checkingAndSavings.qualifyingTotal}, must be 125000) — same month, different balances proves it`);
ok(checkingAndSavings.accountsCount === 2, 'and both appear on the assets table');

// …but the SAME month at the SAME balance is a duplicate of one statement, and still folds.
const sameMonthSameBalance = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(sameMonthSameBalance.qualifyingTotal === 50000,
  `the same month at the same balance is one account (got ${sameMonthSameBalance.qualifyingTotal})`);

// THE ACCOUNT NUMBER BELONGS TO THE ACCOUNT, NOT TO A MONTH. When the number-less statement is the
// latest month it becomes the counted one — and the table must still show ••0120.
const numberSurvives = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'June 1 - June 30, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 89474, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(numberSurvives.accounts[0].accountNumber === '••0120',
  `the account number survives the fold (got ${JSON.stringify(numberSurvives.accounts[0].accountNumber)}) — the owner's own "missing account numbers" fix must not be undone`);

// MULTI-FOLD MUST USE LIVE STATE. Two number-less statements folding into one numbered account:
// the second fold has to compare against the group as it stands AFTER the first, or it can keep an
// older month than the file actually holds.
const multiFold = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt Bank', accountNumber: '000120',
    closingBalance: 10000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 30000, statementPeriod: 'March 1 - March 31, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES A WEIL', bankName: 'Vanderbilt Bank', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'February 1 - February 28, 2026' }),
]);
ok(multiFold.accountsCount === 1, `all three statements are one account (got ${multiFold.accountsCount})`);
ok(multiFold.qualifyingTotal === 30000,
  `the LATEST month wins across multiple folds (got ${multiFold.qualifyingTotal}, must be 30000 — March, not February)`);
ok(multiFold.accounts[0].statementCount === 3, `and all three months are counted as on file (got ${multiFold.accounts[0].statementCount})`);
ok(multiFold.accounts[0].accountNumber === '••0120', 'the number still shows');

// "US BANK" — every word of it is generic, so stripping used to leave nothing and the fold bailed,
// putting the owner's double-count straight back.
const usBank = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'US Bank', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'June 1 - June 30, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'US Bank', accountNumber: null,
    closingBalance: 89474, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(usBank.qualifyingTotal === 89474,
  `two US Bank statements of one account fold (got ${usBank.qualifyingTotal}, must be 89474 — not 177928)`);

console.log(`test-liquidity-double-count-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
