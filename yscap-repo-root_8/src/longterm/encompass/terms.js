'use strict';
/**
 * LONG-TERM (LT) — the loan TERM structures, and the PITI the DSCR is measured against.
 *
 * The owner named the shapes he expects to see: "10 years interest only and 40 year …
 * 30 year term 10 year interest only … 20 year term … regular 30 year fix". This module
 * is the answer measured against the live tenant rather than remembered — every count
 * below was recomputed from all 772 loans (490 long-term) on 2026-08-14.
 *
 * READ-ONLY reference knowledge. Nothing here writes to Encompass.
 *
 * WHY IT MATTERS BEYOND DOCUMENTATION: the term structure decides the P&I, the P&I is
 * the biggest part of the PITI, and the PITI is the denominator of the DSCR. Get the
 * structure wrong and every downstream number on a long-term file is wrong.
 */

// ── Which fields carry the structure ─────────────────────────────────────────
const TERM_FIELDS = {
  termMonths: {
    fieldId: '4',
    path: 'loan.loanAmortizationTermMonths',
    label: 'Trans Details Term (Mos)',
    type: 'Int',
    unit: 'months',
    filled: '100% of long-term files',
    note: 'The AMORTIZATION term — how long the payment is stretched over. Always months.',
  },
  amortizationType: {
    fieldId: '608',
    path: 'loan.loanAmortizationType',
    label: 'Trans Details Amort Type',
    filled: '100% of long-term files',
    observed: { Fixed: 490 },
    defect: 'DEFECT-AMORT-ARM — see KNOWN_TERM_DEFECTS. Both ARM files say "Fixed".',
  },
  interestOnlyIndicator: {
    fieldId: '2982',
    path: 'loan.regulationZ.interestOnlyIndicator',
    label: 'Trans Details Interest Only Indicator',
    type: 'Boolean',
    filled: '8.8% of long-term files (43 of 490) — it is only set when there IS an I/O period',
    note: 'A BLANK here means "not interest-only". Do not read a blank as unknown.',
  },
  interestOnlyMonths: {
    fieldId: '1177',
    path: 'loan.regulationZ.interestOnlyMonths',
    label: 'Trans Details Interest Only Mos',
    type: 'Int',
    unit: 'months',
    filled: '8.8% of long-term files (43 of 490)',
    note:
      'THIS is the number that tells the programs apart, and it is in MONTHS, not years. '
      + '120 = the ten-year interest-only period the owner describes. Always moves together '
      + 'with field 2982 — measured on all 490 files, the two are filled on exactly the same 43.',
  },
  noteRate: {
    fieldId: '3',
    path: 'loan.requestedInterestRatePercent',
    label: 'Trans Details Interest Rate',
    format: 'DECIMAL_3',
    filled: '86.9% of long-term files',
    observed: { min: 5.49, p25: 6.75, median: 7.0, p75: 7.5, max: 12.375 },
  },
  loanAmount: {
    fieldId: '1109',
    alsoAt: '2',
    path: 'loan.borrowerRequestedLoanAmount',
    label: 'Trans Details Loan Amt',
    filled: '91.8% of long-term files',
    note: 'Fields 1109 and 2 (base loan amount) carry the same value on every file measured.',
  },
  lienPosition: {
    fieldId: '420',
    path: 'loan.loanProductData.lienPriorityType',
    filled: '100% of long-term files',
  },
  loanPurpose: {
    fieldId: '19',
    path: 'loan.property.loanPurposeType',
    filled: '93.9% of long-term files',
    observed: {
      'Cash-Out Refinance': 284,
      Purchase: 110,
      'NoCash-Out Refinance': 66,
      '(blank)': 30,
    },
    note:
      'Long-term is a REFINANCE book first — 350 of the 460 that state a purpose are refinances. '
      + 'That is the opposite of the short-term side, which is 96% purchase.',
  },
};

// ── The structures that actually exist in the book ───────────────────────────
// Counted across all 490 long-term loans. `loans` is the exact number carrying that
// exact (program, term, interest-only) combination.
const TERM_STRUCTURES = [
  {
    key: 'fixed_30',
    label: '30-year fixed',
    program: 'Investor DSCR 30 YEAR FRM',
    termMonths: 360,
    interestOnlyMonths: null,
    amortizingMonths: 360,
    loans: 444,
    shareOfLongTerm: '90.6%',
    plainEnglish:
      'The ordinary one. Principal and interest from the first payment, level for thirty years. '
      + 'This is the owner\'s "regular 30 year fix" and it is nine out of every ten long-term files.',
  },
  {
    key: 'io_10_then_30',
    label: '30-year term, first 10 years interest-only',
    program: 'DSCR I/O 30 Year FRM',
    termMonths: 360,
    interestOnlyMonths: 120,
    amortizingMonths: 240,
    loans: 26,
    plainEnglish:
      'Interest only for ten years, then the balance amortizes over the REMAINING twenty. '
      + 'The payment steps UP at month 121 because the same principal now has 240 payments '
      + 'instead of 360 — this is the owner\'s "30 year term 10 year interest only".',
    // OWNER VOCABULARY, confirmed 2026-08-14. When the owner says "20-year term" he
    // means THIS structure's amortizing tail, not a 240-month loan: "usually 30-year
    // term, 10-year interest-only, and then a 20-year mortgage." There is no separate
    // 20-year product — hearing one would be a misunderstanding, not a gap.
    alsoCalled: '"a 20-year mortgage" — meaning the 240 amortizing months after the I/O period',
    ownerConfirmed: '2026-08-14',
    watchOut:
      'The DSCR is normally struck on the interest-only payment, which is the lower one. A file '
      + 'that qualifies at 1.25 today can fall under 1.00 the day it starts amortizing.',
  },
  {
    key: 'io_10_then_40',
    label: '40-year term, first 10 years interest-only',
    program: 'DSCR I/O 40 Year FRM',
    termMonths: 480,
    interestOnlyMonths: 120,
    amortizingMonths: 360,
    loans: 3,
    plainEnglish:
      'The owner\'s "10 years interest only and 40 year". Ten years of interest only, then thirty '
      + 'years of amortization. The longest structure in the book and the lowest payment.',
  },
  {
    key: 'fixed_40',
    label: '40-year fixed',
    program: 'Investor DSCR 40 YEAR FRM',
    termMonths: 480,
    interestOnlyMonths: null,
    amortizingMonths: 480,
    loans: 2,
    plainEnglish: 'Forty years of level principal and interest, no interest-only period.',
  },
  {
    key: 'arm',
    label: 'DSCR ARM',
    program: 'DSCR ARM',
    termMonths: 360,
    interestOnlyMonths: 'either — 1 file carries 120, 1 carries none',
    loans: 2,
    plainEnglish: 'An adjustable-rate long-term loan. Two files in the whole book.',
    watchOut:
      'DEFECT-AMORT-ARM: both ARM files record amortization type "Fixed" (field 608). The ARM '
      + 'index / margin / first-adjustment fields are NOT in the field census at all, so this '
      + 'tenant has no recorded place to put the terms that make an ARM an ARM.',
  },
  {
    key: 'short_io_on_30',
    label: '30-year fixed carrying a 12- or 24-month interest-only period',
    program: 'Investor DSCR 30 YEAR FRM',
    termMonths: 360,
    interestOnlyMonths: '12 (7 files) or 24 (3 files)',
    loans: 10,
    plainEnglish:
      'Ten files on the plain 30-year program carry a one- or two-year interest-only period.',
    watchOut:
      'NEEDS AN OWNER ANSWER. A 12- or 24-month interest-only period is the SHORT-TERM (bridge) '
      + 'pattern — on the short-term side field 1177 carries the whole term because a bridge loan '
      + 'is interest-only end to end. These ten may be real short interest-only long-term deals, '
      + 'or they may be values left behind from a file that started life as a bridge. Until that '
      + 'is answered, do not treat them as a product.',
  },
];

// What the owner listed that the live book does NOT contain. Recorded so nobody
// implements a product the tenant has never written.
const TERM_STRUCTURES_NOT_PRESENT = [
  {
    label: '20-year term',
    termMonths: 240,
    loans: 0,
    answered: '2026-08-14',
    note:
      'ANSWERED BY THE OWNER — there is no 20-year product, and there never was. In his own '
      + 'words: "when I say 20-year term, it means usually 30-year term, 10-year interest-only, '
      + 'and then a 20-year mortgage. It was a typo." So "20-year" is his name for the '
      + 'AMORTIZING TAIL of the io_10_then_30 structure (amortizingMonths = 240), which the '
      + 'measurement had offered as the likely reading. The data was right: there is NOT ONE '
      + 'long-term loan at 240 months in the tenant, and none is expected. Do not build a '
      + '20-year product; when someone says it, they mean 30-year with ten years interest-only.',
  },
  {
    label: '10-year term',
    termMonths: 120,
    loans: 0,
    note:
      'Likewise nothing at 120 months. The 120 in this book is always the interest-only PERIOD '
      + '(field 1177), never the loan term (field 4). Reading one as the other would size the '
      + 'payment on ten years instead of thirty.',
  },
];

// ── The PITI — the denominator of the DSCR ───────────────────────────────────
const PITI = {
  totalFieldId: '912',
  totalPath: 'loan.proposedHousingExpenseTotal',
  label: 'Expenses Proposed Total Housing',
  filled: '92.2% of long-term files',
  plainEnglish:
    'The whole monthly cost of owning the property AFTER this loan closes — the payment plus '
    + 'taxes plus insurance plus any association dues. "Proposed" means post-close, not what the '
    + 'borrower pays today.',
  components: [
    { fieldId: '228', path: 'loan.proposedFirstMortgageAmount',
      label: 'First mortgage P&I', filledOn: 449, of: 490,
      note: 'The payment on THIS loan. Always the largest part.' },
    { fieldId: '230', path: 'loan.proposedHazardInsuranceAmount',
      label: 'Hazard insurance', filledOn: 401, of: 490 },
    { fieldId: '1405', path: 'loan.proposedRealEstateTaxesAmount',
      label: 'Real-estate taxes', filledOn: 371, of: 490 },
    { fieldId: '234', path: 'loan.proposedOtherAmount',
      label: 'Other housing expense', filledOn: 18, of: 490 },
    { fieldId: '233', path: 'loan.proposedDuesAmount',
      label: 'Association (HOA) dues', filledOn: 17, of: 490 },
    { fieldId: 'URLA.X144', path: 'loan.supplementalPropertyInsuranceAmount',
      label: 'Supplemental property insurance', filledOn: 12, of: 490,
      note: 'Flood, wind or hurricane cover carried separately from the hazard policy.' },
    { fieldId: '229', path: 'loan.proposedOtherMortgagesAmount',
      label: 'Other financing P&I', filledOn: 1, of: 490,
      note: 'Subordinate financing. Essentially unused on the long-term book.' },
  ],
  verification:
    'The seven components were summed independently on every long-term file and compared with '
    + 'field 912: they match to the cent on 414 of the 453 files that carry a total (91.4%).',
  theOtherThirtyNine: {
    finding: 'On 38 of the 39 that do not match, the TAX LINE (field 1405) is blank.',
    shortfall: 'The total exceeds the parts by $1,000 to $5,410 a month, median $1,328.',
    reading:
      'That shortfall is a monthly property-tax figure, every time, and it is always POSITIVE — '
      + 'so field 912 is RIGHT and the tax line is simply empty. Whoever built the payment knew '
      + 'the taxes and never wrote them on their own line.',
    consequence:
      'Read the TOTAL from field 912. Never rebuild it by adding the components up — on 8% of '
      + 'files you would understate the housing expense by about $1,300 a month, which inflates '
      + 'the DSCR and makes a deal look better than it is.',
  },
};

// ── The DSCR itself, re-verified in this pass ────────────────────────────────
const DSCR_MEASURED = {
  formula: 'CUST01FV = Round([1005] / [912], 2)',
  verification:
    'Recomputed on every long-term file carrying rent, housing expense and a stored ratio: '
    + '323 matched, 0 did not. The formula is exact.',
  distribution: {
    n: 324,
    min: 0.51, p25: 1.10, median: 1.29, p75: 1.53,
    bands: {
      'under 1.00': 8,
      '1.00 – 1.09': 70,
      '1.10 – 1.24': 49,
      '1.25 – 1.49': 103,
      '1.50 – 1.99': 73,
      '2.00 and above': 21,
    },
    reading:
      'The book sits at 1.29 in the middle. Eight files are under 1.00 — the rent does not cover '
      + 'the payment — which is a real underwriting decision, not an error.',
  },
  outlier: {
    stored: 300000,
    rent: 6000,
    piti: 0.02,
    reading:
      'One file stores a DSCR of 300,000. The formula is right; the INPUT is not — the housing '
      + 'expense block was never built, so field 912 holds two cents. This is why our own '
      + 'computeDscr refuses a near-zero PITI rather than returning a number nobody can use.',
  },
};

const KNOWN_TERM_DEFECTS = [
  {
    key: 'DEFECT-AMORT-ARM',
    severity: 'medium',
    finding: 'Both DSCR ARM files record amortization type (field 608) as "Fixed".',
    consequence:
      'Anything reading field 608 to decide whether a rate can move will conclude it cannot. '
      + 'On this book that is two files, so the damage is small today and structural tomorrow.',
    ourRule: 'Decide fixed-vs-adjustable from the PROGRAM NAME, not from field 608.',
  },
  {
    key: 'DEFECT-NO-ARM-FIELDS',
    severity: 'medium',
    finding:
      'The census has no field carrying an ARM index, margin, first-adjustment cap, periodic cap '
      + 'or lifetime cap with data on it.',
    consequence: 'There is nowhere in this tenant to record the terms that define an ARM.',
    ourRule:
      'Our long-term model carries them, so an ARM can be described properly on our side even '
      + 'while Encompass has no home for them.',
  },
];

/** Months of the term that actually amortize. Null when we cannot say. */
function amortizingMonths(termMonths, interestOnlyMonths) {
  const term = Number(termMonths);
  if (!Number.isFinite(term) || term <= 0) return null;
  const io = interestOnlyMonths === null || interestOnlyMonths === undefined
    || interestOnlyMonths === '' ? 0 : Number(interestOnlyMonths);
  if (!Number.isFinite(io) || io < 0) return null;
  if (io >= term) return 0;
  return term - io;
}

/**
 * Name the structure a file is on, from its own two numbers.
 * Deliberately describes rather than classifies into a fixed list: a combination we have
 * never seen must read as itself, never fall into the nearest known bucket.
 */
function describeStructure(termMonths, interestOnlyMonths) {
  const term = Number(termMonths);
  if (!Number.isFinite(term) || term <= 0) return null;
  const amort = amortizingMonths(term, interestOnlyMonths);
  const io = amort === null ? null : term - amort;
  const years = (m) => (m % 12 === 0 ? `${m / 12}-year` : `${m}-month`);
  return {
    termMonths: term,
    interestOnlyMonths: io || null,
    amortizingMonths: amort,
    label: io
      ? `${years(term)} term, first ${years(io)} interest-only`
      : `${years(term)} fixed`,
    knownStructure: TERM_STRUCTURES.some(
      (s) => s.termMonths === term
        && (io ? s.interestOnlyMonths === io : s.interestOnlyMonths === null),
    ),
  };
}

function summary() {
  return {
    longTermLoansMeasured: 490,
    structuresInTheBook: TERM_STRUCTURES.length,
    structuresTheOwnerNamedThatDoNotExist: TERM_STRUCTURES_NOT_PRESENT.length,
    ownerAnswered: TERM_STRUCTURES_NOT_PRESENT.filter((s) => s.answered).length,
    everyLongTermLoanIsFixedRateExcept: 2,
    termMonthsObserved: { 360: 485, 480: 5 },
    interestOnlyMonthsObserved: { none: 447, 120: 33, 12: 7, 24: 3 },
    pitiComponents: PITI.components.length,
    pitiRebuildMatches: '414 of 453 (91.4%) — read the total, never rebuild it',
    dscrFormulaVerified: '323 of 323',
    defects: KNOWN_TERM_DEFECTS.length,
    source: 'All 772 loans in the live tenant, measured 2026-08-14. Read-only.',
  };
}

module.exports = {
  TERM_FIELDS,
  TERM_STRUCTURES,
  TERM_STRUCTURES_NOT_PRESENT,
  PITI,
  DSCR_MEASURED,
  KNOWN_TERM_DEFECTS,
  amortizingMonths,
  describeStructure,
  summary,
};
