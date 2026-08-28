'use strict';
/**
 * LT test — WHAT DISCOVERY READS OFF A PIPELINE ROW, and what it refuses to guess.
 *
 * `sync/discover.js` is the first thing that touches a long-term loan: it pages the
 * Encompass pipeline and turns each row into the record the mirror is built from.
 * A coverage sweep of the long-term suites found it never executed — and the loan
 * sync's own suite stubs it out, correctly, because it is testing the sync.
 *
 * Two of its readers are the kind that go wrong quietly:
 *
 *   · THE DATE. `"8/14/2026 10:48:18 AM"` is not something `new Date()` parses the
 *     same way everywhere, and this is the FRESHNESS STAMP the sync pages on — a
 *     wrong one silently skips loans, which looks exactly like a quiet pipeline.
 *     So it is taken apart explicitly, and the boundaries that trip every hand-
 *     written 12-hour parser (12 AM is midnight, 12 PM is noon) are asked here.
 *     It also carries NO OFFSET: it is a wall clock in the tenant's own timezone,
 *     so the instant is four hours later than the digits in summer, five in winter.
 *     Reading it as UTC is the defect `test-lt-tenant-time-pure.js` reproduces.
 *   · THE AMOUNT. Absent, empty and unreadable all answer null and never 0,
 *     because a zero loan amount is a FACT and "we could not read it" is not.
 *     `Number('')` is 0, which is how the two get confused.
 *
 * And the pager itself: a cap that is REACHED must be reported, so a caller says
 * "partial sweep" rather than showing a pipeline that appears to have shrunk.
 *
 * Pure — the Encompass client is stubbed; no database, no network.
 */

const path = require('path');

const CLIENT = require.resolve('../src/longterm/encompass/client');
const stub = { pages: [], calls: [] };
require.cache[CLIENT] = {
  id: CLIENT, filename: CLIENT, loaded: true,
  exports: {
    configured: () => true,
    pipelineSearch: async (request, opts) => {
      stub.calls.push({ request, opts });
      return stub.pages.length ? stub.pages.shift() : [];
    },
  },
};

const discover = require('../src/longterm/sync/discover');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

// ── THE FRESHNESS STAMP ────────────────────────────────────────────────────
console.log('the pipeline date is taken apart rather than handed to new Date()');

const d = discover.parsePipelineDate;

// THE DIGITS ARE FOUR HOURS APART FROM THE READING, ON PURPOSE. Encompass states
// this stamp as a bare WALL CLOCK in the tenant's own timezone with no offset on it,
// so 10:48 AM in New York is 14:48Z in August (15:48Z in winter). These assertions
// USED to expect the digits back verbatim, which is exactly the defect
// `scripts/test-lt-tenant-time-pure.js` reproduces: every stamp landed four hours
// early, so a loan edited shortly after PILOT read it compared as edited BEFORE and
// was never read again. They still ask what they always asked — the 12-hour
// boundaries every hand-written parser trips over — only now against the instant the
// tenant actually meant.
check(d('8/14/2026 10:48:18 AM') === '2026-08-14T14:48:18.000Z',
  'THE ONE THAT MATTERS: the tenant\'s own format reads exactly — 10:48 in New York, which is 14:48Z; this is the stamp the sync pages on, and a wrong one silently skips loans');
check(d('8/14/2026 12:00:00 AM') === '2026-08-14T04:00:00.000Z',
  '12 AM is MIDNIGHT — the boundary every hand-written 12-hour parser gets wrong in one direction');
check(d('8/14/2026 12:00:00 PM') === '2026-08-14T16:00:00.000Z',
  '…and 12 PM is NOON, which is the other direction');
check(d('8/14/2026 1:05 PM') === '2026-08-14T17:05:00.000Z', 'an afternoon time with no seconds');
check(d('8/14/2026') === '2026-08-14T04:00:00.000Z',
  'a date with no time at all is midnight IN THE TENANT`S ZONE, not midnight UTC and not today');
check(d('2026-08-14T10:48:18.000Z') === '2026-08-14T10:48:18.000Z',
  'and an ISO stamp from a differently-configured tenant is read too, rather than refused');

for (const junk of ['', '   ', null, undefined, 'yesterday', '13/45/2026 99:99 XM', {}, [], true]) {
  check(d(junk) === null,
    `${JSON.stringify(junk === undefined ? '(undefined)' : junk)} reads as ABSENT — a freshness stamp we cannot trust must be missing, never a guess`);
}

// ── THE AMOUNT ─────────────────────────────────────────────────────────────
console.log('\nan amount we cannot read is absent, and zero is a real answer');

const a = discover.parseAmount;
check(a('$1,234.56') === 1234.56, 'a formatted amount is a number');
check(a('250000') === 250000, '…and a plain one');
check(a(250000) === 250000, '…and one that already is a number');
check(a('0') === 0 && a(0) === 0,
  'THE ONE THAT MATTERS: a ZERO is kept as zero — it is a fact about the loan, and `Number(\'\')` is also 0, which is how the two get confused');
for (const junk of ['', '   ', null, undefined, 'lots', {}, true]) {
  check(a(junk) === null,
    `${JSON.stringify(junk === undefined ? '(undefined)' : junk)} reads as absent rather than as a loan of nothing`);
}

// ── ONE ROW ────────────────────────────────────────────────────────────────
console.log('\none pipeline row becomes what the mirror is built from');

const row = (over = {}) => ({
  loanId: 'guid-1',
  fields: {
    'Loan.LoanNumber': ' 12345 ',
    'Loan.LoanFolder': 'DSCR',
    'Loan.LoanAmount': '$310,000.00',
    'Loan.BorrowerName': 'Ada  Lovelace',
    'Loan.CurrentMilestoneName': 'Started',
    'Fields.LOID': 'alovelace',
    'Loan.LastModified': '8/14/2026 10:48:18 AM',
    ...over,
  },
});
const one = discover.rowToLoan(row());
check(one.encompassLoanGuid === 'guid-1', 'the loan is identified by its guid');
check(one.loanNumber === '12345', '…its number is trimmed');
check(one.borrowerName === 'Ada Lovelace',
  '…the borrower name has its runs of spaces collapsed, because it is drawn on a screen beside other names');
check(one.loanAmount === 310000, '…the amount is a number');
check(one.lastModified === '2026-08-14T14:48:18.000Z',
  '…and the stamp is an instant, read in the tenant`s own zone');
check(one.loanOfficerLoginId === 'alovelace', '…and it carries the login the file is attributed through');

check(discover.rowToLoan({ loanGuid: 'older-shape', fields: {} }).encompassLoanGuid === 'older-shape',
  'a tenant answering the OLDER v1 shape is read rather than silently skipped');
check(discover.rowToLoan({ fields: {} }) === null,
  'while a row with no id at all is dropped — there is nothing to mirror it against');
check(discover.rowToLoan(null) === null, 'and so is nothing at all');

const fallback = discover.rowToLoan(row({ 'Loan.CurrentMilestoneName': '', 'Fields.CoreMilestone': 'Processing' }));
check(fallback.milestoneName === 'Processing',
  'and when the current-milestone field is empty the core one answers, so a loan does not lose its stage to a blank');

// ── THE PAGER ──────────────────────────────────────────────────────────────
console.log('\nthe pager reads the whole book, and says so when it stops early');

const page = (n, from) => Array.from({ length: n }, (_, i) => ({ loanId: `g${from + i}`, fields: {} }));

(async () => {
  stub.pages = [page(discover.PAGE, 0), page(3, discover.PAGE)];
  stub.calls = [];
  const two = await discover.discoverLoans();
  check(two.loans.length === discover.PAGE + 3, `a full page is followed by the next (${two.loans.length} loans over ${two.pages} pages)`);
  check(two.truncated === false, '…and a book that ends is not reported as truncated');
  check(stub.calls.length === 2, '…having asked exactly twice');

  // A short page ends the walk: asking again would be a wasted call against a
  // tenant budget of 500,000 a day.
  stub.pages = [page(5, 0), page(5, 100)];
  stub.calls = [];
  const short = await discover.discoverLoans();
  check(short.loans.length === 5 && stub.calls.length === 1,
    'a page shorter than the page size ends the walk rather than asking again');

  // The runaway guard is a guard, not a limit — reaching it must be REPORTED.
  stub.pages = Array.from({ length: discover.MAX_PAGES + 2 }, () => page(discover.PAGE, 0));
  stub.calls = [];
  const capped = await discover.discoverLoans();
  check(capped.truncated === true,
    'THE ONE THAT MATTERS: hitting the page cap is REPORTED — a silent short read looks exactly like a pipeline that has shrunk, which is what the empty-read guard downstream exists to refuse');
  check(stub.calls.length === discover.MAX_PAGES, `…after exactly the cap (${stub.calls.length} pages), never one more`);

  // The filter: one term needs no operator, two do — and the folder is what a
  // caller narrows by.
  console.log('\nand the filter is the broadest thing the tenant accepts');
  const broad = discover.buildFilter();
  check(broad.terms.length === 1 && broad.terms[0].canonicalName === 'Loan.LoanAmount',
    'with no folder it is a single term — an amount over zero, which is the broadest v3 will take');
  const narrow = discover.buildFilter({ loanFolder: 'DSCR' });
  check(narrow.terms.length === 2 && narrow.terms[1].value === 'DSCR',
    '…and a folder narrows it, which is when a second term appears');

  // ── ARCHIVED LOANS ARE STILL OUR LOANS ───────────────────────────────────
  // This is the one that lets a withdrawn file vanish. The upsert only runs for
  // loans a sweep DISCOVERS, so a loan that drops out of the result set is not
  // marked withdrawn and is not removed — it FREEZES at the folder it was last
  // seen in and reads as a working file forever. Our own research calls the flag
  // essential: archived loans are "otherwise invisible to the query".
  console.log('\narchived loans are asked for, not left to the default');
  {
    stub.calls.length = 0;
    stub.pages = [[]];
    await discover.discoverLoans({});
    const first = stub.calls[0] && stub.calls[0].request;
    check(!!first, 'discovery made a request');
    check(String(first.includeArchivedLoans) === 'true',
      'and asked for archived loans, so a withdrawn file stays visible');
    // The escape hatch has to actually work, or the flag is not a setting.
    stub.calls.length = 0;
    stub.pages = [[]];
    await discover.discoverLoans({ includeArchived: false });
    check(stub.calls[0].request.includeArchivedLoans === undefined,
      'and it can still be asked the old way, for comparing the two');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})();
