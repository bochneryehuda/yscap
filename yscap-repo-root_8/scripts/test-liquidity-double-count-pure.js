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
const { sameBank, sameHolder, bankStem, periodEndDay } = BL._internals;

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
ok(bankStem('Bank, N.A.') === 'bank na', 'an all-generic name keeps its own text as the stem');
ok(bankStem('U.S. Bank') === bankStem('US Bank'), '"U.S. Bank" and "US Bank" are one name — run-together initials are one word');
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
    closingBalance: 20000, statementPeriod: 'June 1 - June 30, 2026' }),
  // A month neither numbered account has on file, so nothing can tell it apart from either of
  // them — it really could be either account.
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 75000, statementPeriod: 'August 1 - August 31, 2026' }),
]);
ok(ambiguous.qualifyingTotal === 108454,
  `an unattributable statement adds NOTHING rather than inflating (got ${ambiguous.qualifyingTotal}, must be 108454)`);
ok(ambiguous.notCountedTwice.some((n) => n.ambiguous === true),
  'and it is flagged as ambiguous so a human can attribute it by hand');
const ambEntry = ambiguous.notCountedTwice.find((n) => n.ambiguous);
ok(ambEntry && ambEntry.matchedAccounts.includes('••0120') && ambEntry.matchedAccounts.includes('••4477'),
  `it names both accounts it might belong to (got ${JSON.stringify(ambEntry && ambEntry.matchedAccounts)})`);

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

// ---------- AUDIT 2026-07-26, SECOND ROUND ----------
// The same-period proof above is the ONE thing that keeps a real second account from being folded
// away. Both of these were found in re-audit, and BOTH fail in the fatal direction — they hand the
// owner back the double-count they called "a major major major major issue".

// (a) A PENNY IS NOT A SECOND ACCOUNT. A statement whose account number would not scan is a poorly
// scanned statement, and the same scan read twice drifts. Treating that drift as proof of a second
// account re-inflates the total by a whole month's balance.
const centDrift = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454.00, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88454.01, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(centDrift.accountsCount === 1,
  `two reads of one month a PENNY apart are one account (got ${centDrift.accountsCount} accounts, $${centDrift.qualifyingTotal})`);
ok(centDrift.qualifyingTotal < 90000, 'and the balance is never counted twice');

// A few dollars apart on a large balance is the same story — a misread digit, not a second account.
const dollarDrift = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88458, statementPeriod: 'July 1 - July 31, 2026' }),
]);
ok(dollarDrift.accountsCount === 1,
  `$4 apart on an $88k balance is scan drift, not a second account (got ${dollarDrift.accountsCount})`);

// A misread or transposed DIGIT is the characteristic OCR failure — and it lands hundreds of
// dollars out, not cents. $88,454 read back as $88,545 is the SAME statement, not a second account.
const transposed = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 92000, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88545, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(transposed.qualifyingTotal === 92000,
  `a transposed digit on a re-scan of January is not a second account (got ${transposed.qualifyingTotal}, must be 92000)`);
// Same story when an "available" balance was picked up instead of the "ending" one.
ok(run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88900, statementPeriod: 'July 1 - July 31, 2026' }),
]).accountsCount === 1, 'half a percent apart on one month is a re-read, not a second account');

// …and the other half stays intact: a MATERIAL difference still proves two accounts.
ok(run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 88454, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 120000, statementPeriod: 'July 1 - July 31, 2026' }),
]).accountsCount === 2, 'a real difference on the same month is still two accounts');

// A BALANCE OF ZERO PROVES NOTHING. A failed extraction yields 0 far more often than an account is
// genuinely empty, and 0-against-$88,454 looks like the widest gap there is — which manufactured
// the owner's exact $177,928 back out of a file holding ONE account.
const zeroRead = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 0, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 89474, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 88454, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(zeroRead.qualifyingTotal === 89474,
  `a zero balance never proves a second account (got ${zeroRead.qualifyingTotal}, must be 89474 — NOT 177928)`);
ok(run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '001234',
    closingBalance: 900, statementPeriod: 'July 1 - July 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 1500, statementPeriod: 'July 1 - July 31, 2026' }),
]).accountsCount === 2, 'and the dollar floor does not swallow small real accounts either');

// (b) EVERY PAIR OF MONTHS, NOT JUST THE LATEST TWO. A group's representative is only its newest
// month. A checking account with two months on file, next to a savings with one, compared newest-to-
// newest is February against January — no overlap, no proof, and $50,000 of real savings is folded
// away and reported as "the same account".
const twoMonthsVsOne = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 25000, statementPeriod: 'February 1 - February 28, 2026' }),
  // The savings account — same bank, same name, only January on file, number unreadable.
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(twoMonthsVsOne.accountsCount === 2,
  `the savings account survives even though the checking has a newer month (got ${twoMonthsVsOne.accountsCount} accounts)`);
ok(twoMonthsVsOne.qualifyingTotal === 75000,
  `and its $50,000 is still counted (got ${twoMonthsVsOne.qualifyingTotal}, must be 75000 — 25000 + 50000)`);

// The same shape where the statements really ARE one account (matching January) still folds.
const twoMonthsSameAccount = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 25000, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(twoMonthsSameAccount.accountsCount === 1 && twoMonthsSameAccount.qualifyingTotal === 25000,
  `a re-uploaded January of the SAME account still folds (got ${twoMonthsSameAccount.accountsCount} / ${twoMonthsSameAccount.qualifyingTotal})`);

// (c) THE SAME MONTH PRINTED TWO WAYS IS THE SAME MONTH. Statements print a period end as
// "2026-01-31", "01/31/2026" or "January 31, 2026"; read as clock times those are three different
// instants outside UTC, which silently disarms the proof above and folds a real account away.
ok(periodEndDay('2026-01-01 to 2026-01-31') === '2026-01-31', 'an ISO period ends on the 31st');
ok(periodEndDay('01/01/2026 - 01/31/2026') === '2026-01-31', 'so does a US-format one');
ok(periodEndDay('January 1 - January 31, 2026') === '2026-01-31', 'so does a written-out one');
ok(periodEndDay('Jan. 1 - Jan. 31, 26') === '2026-01-31', 'an abbreviated month and 2-digit year too');
ok(periodEndDay('') === null && periodEndDay('statement period') === null,
  'and nothing parseable is left null, never guessed');
const mixedFormat = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 50000, statementPeriod: '2026-01-01 to 2026-01-31' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 75000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(mixedFormat.qualifyingTotal === 125000,
  `two accounts whose statements print the month differently stay two (got ${mixedFormat.qualifyingTotal}, must be 125000)`);
// Proven in a real non-UTC clock, not argued: the container runs UTC, which hides this entirely.
const { execFileSync } = require('child_process');
const tzTotal = (tz) => execFileSync(process.execPath, ['-e', `
  const BL = require(${JSON.stringify(R + '/src/lib/underwriting/bank-liquidity')});
  const s = (f) => ({ doc_type: 'bank_statement', fields: f });
  const r = BL.assessBankLiquidity({ borrower: { first_name: 'Moses', last_name: 'Weil' } }, [
    s({ accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
        closingBalance: 50000, statementPeriod: '2026-01-01 to 2026-01-31' }),
    s({ accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
        closingBalance: 75000, statementPeriod: 'January 1 - January 31, 2026' }),
  ], {});
  process.stdout.write(String(r.qualifyingTotal));`],
{ env: Object.assign({}, process.env, { TZ: tz }), encoding: 'utf8' });
for (const tz of ['UTC', 'America/New_York', 'Pacific/Kiritimati']) {
  ok(tzTotal(tz) === '125000', `the accounts stay separate on a ${tz} clock (got ${tzTotal(tz)})`);
}

// (d) THE ACCOUNT NUMBER COMES FROM THE ACCOUNT, WHICHEVER MONTH CARRIES IT. Once a fold has made a
// number-less statement the representative, the NEXT statement folded into that same account must
// still be told the account number — otherwise the underwriter is asked to check a balance by hand
// with the identifier removed.
const numberAfterFold = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 10000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 30000, statementPeriod: 'February 1 - February 28, 2026' }),
  // A second number-less statement for the same February at a materially different balance, so it
  // is NOT reunited with d2 — it arrives at the fold separately, by which time ••0120's counted
  // month is d2, which carries no number of its own.
  stmt('d3', { accountHolderName: 'MOSES A WEIL', bankName: 'Vanderbilt Bank', accountNumber: null,
    closingBalance: 40000, statementPeriod: 'February 1 - February 28, 2026' }),
]);
const second = numberAfterFold.notCountedTwice.find((n) => n.ending === 40000);
ok(second && second.matchedAccounts.includes('••0120'),
  `the account number still shows after an earlier fold replaced the counted month (got ${JSON.stringify(second && second.matchedAccounts)})`);
ok(numberAfterFold.accounts[0].accountNumber === '••0120', 'and the assets table keeps it too');

// (e) THE EXPLANATION MUST MATCH THE FINAL TABLE, WHATEVER ORDER THE STATEMENTS ARRIVED IN. When two
// number-less statements fold into one account, only the month that ends up counted may be described
// as having become the representative — otherwise the same file explains itself two different ways.
const foldPair = [
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 10000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'February 1 - February 28, 2026' }),
  // A different un-numbered account: same February, a materially different balance, so it stays
  // separate from d2 all the way to the fold.
  stmt('d3', { accountHolderName: 'MOSES A WEIL', bankName: 'Vanderbilt Bank', accountNumber: null,
    closingBalance: 60000, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d4', { accountHolderName: 'MOSES A WEIL', bankName: 'Vanderbilt Bank', accountNumber: null,
    closingBalance: 70000, statementPeriod: 'March 1 - March 31, 2026' }),
];
for (const [label, list] of [['as uploaded', foldPair], ['in reverse', foldPair.slice().reverse()]]) {
  const r = run(list);
  const feb = r.notCountedTwice.find((n) => n.ending === 20000);
  const mar = r.notCountedTwice.find((n) => n.ending === 70000);
  ok(r.qualifyingTotal === 70000, `${label}: the March balance is the one counted (got ${r.qualifyingTotal})`);
  ok(mar && mar.becameRepresentative === true, `${label}: March is described as the month that was counted`);
  ok(feb && feb.becameRepresentative === false,
    `${label}: February is NOT — its balance is not in the total, so it must be listed as not counted again`);
}

// ---------- AUDIT 2026-07-26, THIRD ROUND ----------
// Comparing every month of one account against every month of another is only sound if a group
// really holds ONE account. It did not: a statement with no readable account number is grouped on
// its bank and holder VERBATIM, while the matching is deliberately tolerant of the drift those
// strings carry month to month. So one un-numbered account split into fragments, no fragment could
// be reunited with another, and each one was added to the total as its own account.

// (f) The minimal case — four statements, perfectly clean, the only oddity being the bank printing
// its own name two ways across two months. Truth: a checking account (latest $52,500) and ONE
// savings account (latest $21,000) = $73,500.
const fragmented = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '001234',
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '001234',
    closingBalance: 52500, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d4', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: null,
    closingBalance: 21000, statementPeriod: 'February 1 - February 28, 2026' }),
]);
ok(fragmented.qualifyingTotal === 73500,
  `two months of one un-numbered account are ONE account (got ${fragmented.qualifyingTotal}, must be 73500 — not 93500)`);
ok(fragmented.accountsCount === 2, `and the file holds two accounts, not three (got ${fragmented.accountsCount})`);
// The control: the same file with no name drift was always right, which is what pins the cause.
ok(run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '001234',
    closingBalance: 50000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: '001234',
    closingBalance: 52500, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d4', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 21000, statementPeriod: 'February 1 - February 28, 2026' }),
]).qualifyingTotal === 73500, 'the same file without the drift is unchanged');

// Three months, three spellings — the assets table was printing one savings account three times.
const fragmented3 = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: '001234',
    closingBalance: 55125, statementPeriod: 'March 1 - March 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES A WEIL', bankName: 'Chase Bank', accountNumber: null,
    closingBalance: 21000, statementPeriod: 'February 1 - February 28, 2026' }),
  stmt('d4', { accountHolderName: 'WEIL MOSES', bankName: 'Chase, N.A.', accountNumber: null,
    closingBalance: 22050, statementPeriod: 'March 1 - March 31, 2026' }),
]);
ok(fragmented3.accountsCount === 2,
  `three spellings of one account are still one account (got ${fragmented3.accountsCount} accounts)`);
ok(fragmented3.qualifyingTotal === 77175,
  `and the total counts each account once (got ${fragmented3.qualifyingTotal}, must be 77175)`);

// The reunion must not swallow two genuinely different un-numbered accounts: same bank, same name,
// same month, materially different balances proves them apart just as it does against a numbered one.
const twoLooseAccounts = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Chase', accountNumber: null,
    closingBalance: 20000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Chase Bank', accountNumber: null,
    closingBalance: 90000, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(twoLooseAccounts.accountsCount === 2 && twoLooseAccounts.qualifyingTotal === 110000,
  `two un-numbered accounts proven apart stay apart (got ${twoLooseAccounts.accountsCount} / ${twoLooseAccounts.qualifyingTotal})`);

// (g) A STATEMENT THAT WAS FOLDED IN ON A GUESS MAY NOT THEN BE USED AS PROOF. Once a number-less
// statement sits in a numbered account, it is there because we decided it belonged — the document
// never said so. Letting it testify against the NEXT fold turns a fact into a guess built on a
// guess, and a second month of the same account gets refused and counted twice.
const poisoned = run([
  stmt('d1', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: '000120',
    closingBalance: 30000, statementPeriod: 'March 1 - March 31, 2026' }),
  stmt('d2', { accountHolderName: 'MOSES WEIL', bankName: 'Vanderbilt', accountNumber: null,
    closingBalance: 10000, statementPeriod: 'January 1 - January 31, 2026' }),
  stmt('d3', { accountHolderName: 'MOSES A WEIL', bankName: 'Vanderbilt Bank', accountNumber: null,
    closingBalance: 10900, statementPeriod: 'January 1 - January 31, 2026' }),
]);
ok(poisoned.qualifyingTotal === 30000,
  `a folded-in statement never becomes evidence against the next one (got ${poisoned.qualifyingTotal}, must be 30000)`);

// (h) DATES MUST BE REAL DAYS AND REAL MONTHS. A token that resolves to a date it is not lets two
// unrelated statements compare as the same month — which is the direction that ADDS money.
ok(periodEndDay('February 1 - February 31, 2026') === null, '"February 31" is not a date and is dropped');
ok(periodEndDay('February 1 - February 28, 2026') === '2026-02-28', 'February 28 is a date');
ok(periodEndDay('February 1 - February 29, 2024') === '2024-02-29', 'and February 29 in a leap year is');
ok(periodEndDay('February 1 - February 29, 2026') === null, 'but not in a common year');
ok(periodEndDay('2026-02-01 to 2026-02-30') === '2026-02-01', 'an impossible ISO day is dropped, the real one kept');
ok(periodEndDay('Marcus 1 - Marcus 15, 2026') === null, '"Marcus" is not March — a whole word must be a month');
ok(periodEndDay('Junior 9, 2026') === null, 'nor is "Junior" June');
ok(periodEndDay('September 1 - September 30, 2026') === '2026-09-30', 'full month names still parse');
ok(periodEndDay('Sept 30, 2026') === '2026-09-30', 'and so does "Sept"');
// A 2-digit year is the current century, matching the repo-wide rule (fields.js normalizeTypedDate).
ok(periodEndDay('01/01/26 - 01/31/26') === '2026-01-31', 'a 2-digit year is 20xx');
ok(periodEndDay('Jan 31, 98') === '2098-01-31', 'always 20xx — never a guess back into the 1900s');

// (i) THE REGRESSION BOUND, ON RANDOM FILES. Files are generated from a KNOWN set of accounts, so
// the truth is not a hand-computed expectation derived from the same reasoning as the code.
//
// Zero over-counting is NOT achievable and this test does not pretend otherwise: two statements with
// no readable account number, at one bank, under one name, in different months are genuinely
// indistinguishable — no rule can always place them correctly. What is achievable is that the
// mistakes land overwhelmingly on the safe side. Measured on this corpus, the code as it stood
// before this work over-counted 1,680 of 4,000 files by $260M; it now over-counts 46 by $4.2M, while
// under-counting rose from 389 files to 861 (the direction a human clears).
//
// So the bound is a RATCHET: if a change pushes over-counting back above where it is today,
// something moved in the fatal direction and this fails. Deterministic seed — a failure here is
// reproducible, not a flake.
const OVERCOUNT_BOUND = 46;
let seed = 20260726;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = (a) => a[Math.floor(rnd() * a.length) % a.length];
const MONTHS = [['January 1 - January 31, 2026', 31], ['February 1 - February 28, 2026', 28],
  ['March 1 - March 31, 2026', 31], ['April 1 - April 30, 2026', 30]];
const BANKS = [['Chase', 'Chase Bank', 'JPMorgan Chase Bank, N.A.'], ['Vanderbilt', 'Vanderbilt Financial'],
  ['US Bank', 'U.S. Bank']];
const HOLDERS = ['MOSES WEIL', 'Moses Weil', 'MOSES A WEIL', 'WEIL MOSES'];
let overCounted = 0, worstExcess = 0, worstFile = null;
for (let t = 0; t < 4000; t++) {
  const nAccts = 1 + Math.floor(rnd() * 3);
  const accounts = [];
  for (let a = 0; a < nAccts; a++) {
    accounts.push({ names: pick(BANKS), number: rnd() < 0.6 ? String(1000 + Math.floor(rnd() * 8999)) : null,
      base: 5000 + Math.floor(rnd() * 200000) });
  }
  const rows = [];
  const latest = new Map();
  for (let a = 0; a < accounts.length; a++) {
    const acct = accounts[a];
    const nMonths = 1 + Math.floor(rnd() * 3);
    for (let m = 0; m < nMonths; m++) {
      const bal = Math.round(acct.base * (1 + m * 0.03));
      rows.push({ ix: MONTHS.indexOf(MONTHS[m]), a, f: {
        accountHolderName: pick(HOLDERS),
        // The drift the module exists to tolerate: one account, its bank printed differently by month.
        bankName: pick(acct.names),
        // …and the failure that started all of this: the number legible some months and not others.
        accountNumber: acct.number && rnd() < 0.6 ? acct.number : null,
        closingBalance: bal, statementPeriod: MONTHS[m][0],
      } });
      latest.set(a, bal);   // months ascend, so the last one written is the latest
    }
  }
  let truth = 0; for (const v of latest.values()) truth += v;
  const got = run(rows.map((r, i) => stmt('d' + i, r.f))).qualifyingTotal;
  if (got > truth + 0.5) {
    overCounted++;
    if (got - truth > worstExcess) { worstExcess = got - truth; worstFile = rows.map((r) => r.f); }
  }
}
ok(overCounted <= OVERCOUNT_BOUND,
  `across 4,000 random files, over-counting stays at or below ${OVERCOUNT_BOUND} (got ${overCounted}, worst by $${Math.round(worstExcess).toLocaleString('en-US')})`
  + (worstFile ? `\n     worst: ${JSON.stringify(worstFile, null, 1)}` : ''));

console.log(`test-liquidity-double-count-pure: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
