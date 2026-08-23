'use strict';
/**
 * PROOF of the 1003's DEBT side — §2c liabilities and §2d obligations.
 *
 * Fifth thread from the coverage sweep. `readLiabilities` is the reader that turns
 * Encompass's tradelines into what the file screen shows a borrower owes, 7–38
 * rows on a real loan of this tenant's, and NO SUITE REFERENCED IT AT ALL. Every
 * figure on the debts panel came from code nothing had ever run.
 *
 * THE FIXTURE IS THE REAL RECORDED SHAPE, not an invented one: the `vols[0]` row
 * in docs/longterm/ENCOMPASS-LIVE-API-PROBE.md §5.4, copied field for field off a
 * live loan. A fixture somebody made up proves the reader agrees with the person
 * who wrote it.
 *
 * WHAT IS WORTH PINNING:
 *
 *   · BOTH ARRAYS ARE READ. `vols[]` is where this tenant's tradelines actually
 *     live; the modern `liabilities[]` was empty on every loan sampled. Reading
 *     only the workhorse would silently halve somebody's debts the day the tenant
 *     starts populating the modern one — and a debt that vanishes makes a file
 *     look better than it is.
 *
 *   · ONLY AN EXPLICIT TRUE IS A PAYOFF. A liability marked as being paid off
 *     comes OUT of the borrower's monthly obligations, so a truthy-looking value
 *     read as a yes moves the ratio the loan is decided on. `1`, `'true'` and a
 *     missing flag are each NOT a payoff, and that is the assertion here.
 *
 *   · THE FULL ACCOUNT NUMBER NEVER LEAVES. The reader keeps four digits and
 *     drops the rest, and this suite checks the WHOLE mapped row for the original
 *     — not just the field that was supposed to hold it.
 *
 *   · WHICH RENTAL A MORTGAGE IS AGAINST TRAVELS. On a DSCR file the difference
 *     between a mortgage covered by that property's own rent and one that is not
 *     is two different underwriting answers, and the link is a single id hung on
 *     the debt.
 *
 *   · A DEBT WITH NO TYPE IS DROPPED, not carried as a blank row. An unlabelled
 *     line on a debts panel is a number a human cannot act on.
 *
 * PURE: no database, no network.
 */

const assert = require('assert');
const path = require('path');

const mapper = require(path.join(__dirname, '..', 'src', 'longterm', 'application', 'mapper'));

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ── The real recorded row (ENCOMPASS-LIVE-API-PROBE §5.4, applications[0].vols[0])
// with the redacted account number filled in so the PII rule below has something
// to be proven against.
const ACCOUNT = '4147202299887766';
const REAL_VOL = {
  id: '93503757-0000-4000-8000-000000000001',
  altId: 'dd287936-0000-4000-8000-000000000001',
  accountIdentifier: ACCOUNT,
  nameInAccount: 'A BORROWER',
  holderName: 'OCEANFIR/DMI',
  holderAddressStreetLine1: '1 CORPORATE DR',
  holderAddressCity: 'LAKE ZURICH',
  holderAddressState: 'IL',
  holderAddressPostalCode: '60047',
  liabilityType: 'MortgageLoan',
  monthlyPaymentAmount: 6529,
  unpaidBalanceAmount: 750451,
  remainingTermMonths: 339,
  creditLimit: 0,
  payoffIncludedIndicator: false,
  owner: 'Borrower',
  reoProperty: { entityId: 'f77a3e50-0000-4000-8000-000000000001', entityType: 'ReoProperty' },
};

// ── A. THE REAL ROW, END TO END ──────────────────────────────────────────
{
  const [row] = mapper.readLiabilities({ vols: [REAL_VOL] });
  ok(row, 'the recorded live row maps to something at all');
  eq(row.section, 'debts', 'a vols row is §2c — a debt, not an obligation');
  eq(row.liabilityType, 'MortgageLoan', 'the type Encompass gave it');
  eq(row.creditorName, 'OCEANFIR/DMI', 'the creditor as it appears on the tradeline');
  eq(row.unpaidBalance, 750451, 'the balance');
  eq(row.monthlyPayment, 6529, 'the monthly payment — the figure the ratio is built from');
  eq(row.monthsRemaining, 339, 'and how much longer it runs');
  eq(row.role, 'borrower', 'whose debt it is');
  eq(row.encompassId, REAL_VOL.id, 'carrying its own id, so a later pass can recognise the same row');
  eq(row.reoEncompassId, 'f77a3e50-0000-4000-8000-000000000001',
    'THE ONE THAT MATTERS on a DSCR file: which rental this mortgage is against travels with it — a mortgage covered by that property\'s own rent and one that is not are two different underwriting answers');
  eq(row.toBePaidOff, false, 'and an explicit false is not a payoff');

  // THE FULL ACCOUNT NUMBER NEVER LEAVES. Checked across the WHOLE row rather
  // than the one field that was meant to hold it, because the failure worth
  // catching is the copy somebody adds later, not the field already reviewed.
  eq(row.accountLast4, '7766', 'four digits of the account are kept, so a human can tell two cards apart');
  ok(!JSON.stringify(row).includes(ACCOUNT),
    'THE ONE THAT MATTERS: and the full account number appears NOWHERE on the mapped row — not merely nowhere in the field that was supposed to hold it');
  ok(!JSON.stringify(row).includes('A BORROWER'),
    '…nor the name on the account, which is not ours to mirror either');
}

// ── B. BOTH ARRAYS ARE READ ──────────────────────────────────────────────
{
  const rows = mapper.readLiabilities({
    vols: [REAL_VOL],
    liabilities: [{ id: 'modern-1', liabilityType: 'Revolving', holderName: 'A BANK', monthlyPaymentAmount: 45 }],
  });
  eq(rows.length, 2,
    'THE ONE THAT MATTERS: the modern liabilities[] array is read BESIDE vols[], not instead of it — reading only the workhorse would silently halve somebody\'s debts the day this tenant starts populating the other, and a debt that vanishes makes a file look better than it is');
  ok(rows.some((r) => r.encompassId === 'modern-1'), '…so the modern row is really there');
  ok(rows.some((r) => r.encompassId === REAL_VOL.id), '…and so is the vols row');
  ok(rows.every((r) => r.section === 'debts'), 'and both count as §2c debts');
}

// ── C. ONLY AN EXPLICIT TRUE IS A PAYOFF ─────────────────────────────────
// A liability marked as being paid off comes OUT of the borrower's monthly
// obligations. Every value below LOOKS like a yes to `Boolean`.
{
  const cases = [
    ['a missing flag', {}],
    ['an explicit false', { payoffIncludedIndicator: false }],
    ['the number 1', { payoffIncludedIndicator: 1 }],
    ['the string "true"', { payoffIncludedIndicator: 'true' }],
    ['the string "Y"', { payoffIncludedIndicator: 'Y' }],
    ['an object', { payoffIncludedIndicator: { value: true } }],
  ];
  for (const [what, extra] of cases) {
    const [row] = mapper.readLiabilities({ vols: [{ ...REAL_VOL, ...extra }] });
    eq(row.toBePaidOff, false,
      `THE ONE THAT MATTERS: ${what} is NOT a payoff — a debt wrongly dropped from the monthly obligations moves the very ratio the loan is decided on`);
  }
  const [yes] = mapper.readLiabilities({ vols: [{ ...REAL_VOL, payoffIncludedIndicator: true }] });
  eq(yes.toBePaidOff, true, 'while a real true is honoured — the rule is strictness, not refusal');
  const [alt] = mapper.readLiabilities({ vols: [{ ...REAL_VOL, payoffStatusIndicator: true }] });
  eq(alt.toBePaidOff, true, '…on either of the two flags Encompass uses for it');
}

// ── D. THE FIGURES ARE READ AS FIGURES, AND A NON-FIGURE IS NOT A ZERO ───
// This tenant does send numbers as strings (the probe records
// `maintenanceExpenseAmount: "591"` on a live REO row), so both have to work —
// and `Number(null)`, `Number('')` and `Number([])` are all a finite, innocent 0.
{
  const [typed] = mapper.readLiabilities({
    vols: [{ ...REAL_VOL, unpaidBalanceAmount: '750451', monthlyPaymentAmount: '6529.50' }],
  });
  eq(typed.unpaidBalance, 750451, 'a balance the tenant sent as a string still reads as the number it is');
  eq(typed.monthlyPayment, 6529.5, '…cents included');

  for (const bad of [null, '', [], {}, false, 'n/a']) {
    const [row] = mapper.readLiabilities({ vols: [{ ...REAL_VOL, unpaidBalanceAmount: bad }] });
    eq(row.unpaidBalance, null,
      `an unpaid balance of ${JSON.stringify(bad)} reads as UNKNOWN rather than as $0 — a debt shown as zero is a debt a human stops asking about`);
  }

  const [frac] = mapper.readLiabilities({ vols: [{ ...REAL_VOL, remainingTermMonths: 339.5 }] });
  eq(frac.monthsRemaining, null, 'and half a month left is a misread, not half a month');
}

// ── E. A DEBT WITH NO TYPE IS DROPPED ────────────────────────────────────
{
  const rows = mapper.readLiabilities({
    vols: [
      { ...REAL_VOL, liabilityType: null },
      { ...REAL_VOL, id: 'blank', liabilityType: '   ' },
      null,
      'not an object',
      REAL_VOL,
    ],
  });
  eq(rows.length, 1,
    'a tradeline with no type is DROPPED rather than carried as a blank row — an unlabelled line on a debts panel is a number a human cannot act on');
  eq(rows[0].encompassId, REAL_VOL.id, '…and the one that survives is the one that had a type');
}

// ── F. §2d OBLIGATIONS — THE HALF THAT HAD NEVER RUN AT ALL ──────────────
// Alimony, child support, a job-related expense. Not a debt secured on a
// property, which is why there is nothing for it to point at.
{
  const rows = mapper.readLiabilities({
    otherLiabilities: [
      { id: 'ob-1', liabilityType: 'Alimony', holderName: 'COUNTY OF ESSEX', monthlyPaymentAmount: 1200, remainingTermMonths: 48 },
      { id: 'ob-2', otherLiabilityType: 'JobRelatedExpenses', monthlyPaymentAmount: 300 },
      { id: 'ob-3' },
      null,
    ],
  });
  eq(rows.length, 2, 'the §2d obligations are read, and an untyped one is dropped like any other');
  eq(rows[0].section, 'obligations', 'they are marked as obligations rather than debts, because the screen shows them apart');
  eq(rows[0].liabilityType, 'Alimony', 'with the type given');
  eq(rows[0].monthlyPayment, 1200, 'and the monthly figure, which counts against the borrower exactly like a debt does');
  eq(rows[1].liabilityType, 'JobRelatedExpenses',
    'an obligation typed only in `otherLiabilityType` falls back to it rather than being dropped — Encompass uses both spellings');
  eq(rows[0].reoEncompassId, null,
    'an obligation points at no rental, deliberately: there is nothing for alimony to be secured on');
  eq(rows[0].accountLast4, null, '…and carries no account number, because §2d has none to carry');
  eq(rows[0].toBePaidOff, false, '…and is never a payoff');
}

// ── G. NOTHING IN, NOTHING OUT ───────────────────────────────────────────
{
  for (const empty of [null, undefined, {}, 'nonsense', 42]) {
    const rows = mapper.readLiabilities(empty);
    ok(Array.isArray(rows) && rows.length === 0,
      `${JSON.stringify(empty) || String(empty)} maps to an empty list rather than throwing — a loan whose 1003 has not arrived yet must still open`);
  }
}

console.log(`\n✓ lt application liabilities (pure): ${checks} assertions passed`);
