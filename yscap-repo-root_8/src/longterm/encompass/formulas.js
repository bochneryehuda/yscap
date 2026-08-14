'use strict';
/**
 * LONG-TERM (LT) — the tenant's own CALCULATED fields, decoded.
 *
 * Encompass lets a lender define custom fields whose value is COMPUTED from other
 * fields. 52 of this tenant's 856 custom fields are calculated, and the formulas are
 * readable through GET /encompass/v3/settings/loan/customFields (`calculation`).
 * They are the closest thing to written-down underwriting logic in the system, so
 * they are decoded here rather than left as raw strings.
 *
 * Formula syntax: `[1005]` reads field 1005; `[#1005]` reads it as a NUMBER;
 * `[67#2]` reads field 67 on borrower pair 2; `VAL()` coerces to numeric;
 * `IIF(cond, a, b)` is an if; `LMedian` / `UMedian` are lower/upper median.
 *
 * Every formula below was verified against live loan values on 2026-08-14.
 * READ-ONLY reference knowledge.
 */

// ── The DSCR ratio — the defining number of the long-term product ────────────
const DSCR_RATIO = {
  fieldId: 'CUST01FV',
  label: 'DSCR',
  format: 'DECIMAL_2',
  calculation: 'Round([1005] / [912], 2)',
  plainEnglish:
    'Gross monthly market rent on the subject property (field 1005) divided by the '
    + 'proposed TOTAL monthly housing expense (field 912) — principal + interest + taxes '
    + '+ insurance + association dues, i.e. the true PITIA — rounded to two decimals.',
  numerator: { fieldId: '1005', label: 'Subject Property Gross Rent',
    path: 'loan.subjectPropertyGrossRentalIncomeAmount' },
  denominator: { fieldId: '912', label: 'Expenses Proposed Total Housing',
    path: 'loan.proposedHousingExpenseTotal' },
  verification:
    'Recomputed 1005/912 independently on every DSCR loan that carries both fields and '
    + 'compared with the stored CUST01FV: it matched on every single one. Example rows — '
    + '2450/1700.81 = 1.44; 6000/4949.12 = 1.21; 2850/4549.20 = 0.63; 4575/1983.47 = 2.31.',
  filled: '66.1% of DSCR files (it only exists once rent and the expense block are entered)',
  reading: {
    'below 1.00': 'the property does not cover its own debt service',
    '1.00 – 1.20': 'thin coverage; most investor guidelines price this up or decline it',
    '1.20 and above': 'the conventional DSCR comfort zone',
  },
  note:
    'Field 1005 is monthly gross rent, NOT annual and NOT net of vacancy. Field 912 is the '
    + 'PROPOSED (post-close) housing expense, not the current one — so the ratio only becomes '
    + 'meaningful once the new payment has been built on the file.',
};

// ── A defect found in the live tenant ────────────────────────────────────────
const KNOWN_DEFECTS = [
  {
    fieldId: 'CX.PITIA',
    label: 'Total PITIA (P&I + Taxes + Ins…)',
    severity: 'high',
    filled: '99.6% of DSCR files — it is on almost every long-term loan',
    calculation: 'Sum([#228], [#140], [#136], [#142], [#144])',
    whatThoseFieldsActuallyAre: {
      228: 'Expenses Proposed Mtg Pymt — P&I. Correct ingredient.',
      140: 'Trans Details SUBORDINATE FINANCING — not a housing expense.',
      136: 'Trans Details PURCHASE PRICE — not a housing expense.',
      142: 'Trans Details CASH FROM BORROWER — not a housing expense, and usually NEGATIVE.',
      144: 'Income Other Income 1 — a STRING income field, not a housing expense.',
    },
    // ── The proof, re-run 2026-08-14 after the owner asked how this could be
    // wrong. Field LABELS alone are not evidence, so this was settled three ways
    // and every number below is reproducible from the harvested loans.
    proof: {
      1: 'THE FORMULA REALLY IS THAT SUM. Computed Sum(228,140,136,142,144) from the '
        + 'live loan values and compared it with the STORED CX.PITIA: 760 of 761 '
        + 'reproduce it to the cent. So the field ids in the calculation are the ones '
        + 'read here, and Encompass is doing exactly what the formula says.',
      2: 'THE FIELD IDS ARE ICE\'S, NOT OUR READING. The labels come from the tenant\'s '
        + 'own GET /encompass/v3/schemas/loan/standardFields — 23,704 fields. And the '
        + 'SAME tenant confirms 136 independently: its own CX.RTLDOWNPAYMENT formula '
        + 'uses VAL([136]) as the PURCHASE PRICE to work out a down payment.',
      3: 'THE RESULT IS NOT A MONTHLY PAYMENT. Of 451 long-term loans carrying both '
        + 'CX.PITIA and field 912, ZERO land within 2% of the real housing expense; '
        + 'the median gap is $166,197.97. 297 are negative (a payment cannot be) and '
        + '120 are over $50,000 a month. Only 34 of 451 are even in a plausible range.',
      4: 'THE GAP POINTS THE WRONG WAY. If CX.PITIA were merely MISSING taxes and '
        + 'insurance, 912 minus CX.PITIA would be positive and look like a monthly tax '
        + 'bill. It is NEGATIVE, median -$2,963 — the signature of one-time amounts '
        + '(a purchase price, cash to close) being added into a monthly figure.',
    },
    workedExample:
      'A real long-term file: P&I 3,048.46 + purchase price 689,000.00 + cash from '
      + 'borrower 219,940.44 = CX.PITIA 911,988.90. The same file\'s actual total '
      + 'monthly housing expense (field 912) is 3,478.46.',
    consequence:
      'CX.PITIA does not hold a PITIA. Because field 142 (cash from borrower) is on '
      + '760 of 770 files and is often a large negative, the result is usually a large '
      + 'negative number; where the purchase price (136, on 328 files) also lands it is '
      + 'a large positive one. Either way it is wrong by orders of magnitude, and often '
      + 'by sign. Note it is never merely P&I: on all 662 files carrying a P&I, '
      + 'something else was added.',
    correctSource: 'Field 912 (loan.proposedHousingExpenseTotal) is the real total PITIA, '
      + 'and it is what the DSCR ratio itself uses.',
    ourRule: 'LT never reads CX.PITIA. It reads 912.',
    // ── The fix, verified rather than suggested ────────────────────────────
    theFix: {
      calculation: 'Sum([#228], [#1405], [#230], [#232], [#233])',
      why:
        'Those are the five fields the label already names, taken from the "Expenses '
        + 'Proposed" block where the real monthly housing expense lives: 228 Mtg Pymt '
        + '(P&I), 1405 Taxes, 230 Haz Ins, 232 Mtg Ins (MI), 233 HOA. Only the FIRST '
        + 'id in the current formula is from that block; the other four are not.',
      verified:
        'Computed on the same 451 long-term loans and compared with field 912: 88% land '
        + 'within 2%, median gap $0.00 — exact. Against 0% and $166,197.97 for the '
        + 'formula as it stands today.',
      note:
        'The remaining 12% are the files where field 912 legitimately carries something '
        + 'the label does not name (other housing 234, other financing 229) or where the '
        + 'tax line is blank — the same 38-file case documented in terms.js.',
    },
    ownerAction:
      'One line, in Encompass → Settings → Loan Custom Fields → CX.PITIA: replace the '
      + 'calculation with Sum([#228],[#1405],[#230],[#232],[#233]). Or retire the field '
      + 'and use 912. Not something we can change from here — Encompass is read-only to '
      + 'us — and nothing we build depends on it either way.',
  },
];

// ── Credit-score selection: how the tenant picks a qualifying FICO ───────────
const CREDIT_SCORE_LOGIC = {
  bureauFields: {
    borrower: { experian: '67', transUnion: '1450', equifax: '1414' },
    coborrower: { experian: '60', transUnion: '1452', equifax: '1415' },
  },
  middleScore: {
    fieldId: 'CX.MIDDLESCORE',
    calculation: 'LMedian([#67], [#1450], [#1414])',
    plainEnglish: 'The lower median of the three bureau scores — the classic "middle score".',
  },
  perPair: {
    fieldId: 'CX.PAIR1.BORROWER.FICO … CX.PAIR6.BORROWER.FICO',
    calculation: 'Pick(Match("", [67#N], [1450#N], [1414#N]) + 1, Median(...), Min(...), Min(...), Min(...))',
    plainEnglish:
      'For borrower pair N: if all three bureaus reported, take the median. If one is blank, '
      + 'take the MINIMUM of the two that did report. This is the industry-standard '
      + '"middle of three, lower of two" rule, expressed as a Pick/Match table.',
  },
  qualifying: {
    fieldId: 'CX.PAIRS16',
    calculation: 'Min(CX.PAIR1.BORROWER.FICO … CX.PAIR6.COBORROWER.FICO)',
    plainEnglish:
      'The LOWEST qualifying score across every borrower on every pair — the file qualifies on '
      + 'its weakest borrower. Note this reads all SIX configured pairs.',
  },
  higherOfPair: {
    fieldId: 'CX.HIGHERSCOREBORRCOBORR / CX.MIDHIGHERSCOREBORRCOBORR',
    calculation: 'UMedian([#CX.MIDDLESCORE], [#CX.MIDDLESCORECOB])',
  },
};

// ── Other long-term-relevant calculations, decoded ───────────────────────────
const OTHER_FORMULAS = [
  { fieldId: 'CX.DSCRLOANAMOUNT', label: 'DSCR LOAN AMOUNT', dscrFill: '62.4%',
    calculation: 'IIF(VAL([CX.DSCRLTV]) <= 0, 0, IIF([19] = "Purchase", VAL([136]) * (VAL([CX.DSCRLTV])/100), VAL([356]) * (VAL([CX.DSCRLTV])/100)))',
    plainEnglish:
      'Max loan by LTV: on a PURCHASE apply the DSCR LTV to the purchase price (136); on a '
      + 'REFINANCE apply it to the appraised value (356). Zero when no LTV is set. This is the '
      + 'purchase-vs-refinance value basis rule, written down.' },
  { fieldId: 'CX.YEARS.AT.RESIDENCE', label: 'Years at Residence', dscrFill: '81.2%',
    calculation: 'IIF(([#FR0112] + ([#FR0124] / 12)) >= 2 or ([#BR0112] + … ) …)',
    plainEnglish:
      'Years + months at the CURRENT address (FR0112 / FR0124), falling back to the sum of the '
      + 'PRIOR address durations (BR01xx…) — the standard "two-year housing history" test.' },
  { fieldId: 'CX.TODAYS.DATE', label: "Today's Current Date", dscrFill: '100%',
    calculation: 'DateAdd("d", 0, Today)',
    plainEnglish: 'Just today. Used by other rules for date maths; carries no loan meaning.' },
  { fieldId: 'CX.UC.CHANGES', label: 'UW Comparison - Changes', dscrFill: '100%',
    calculation: 'IIF([#CX.UC.LOAN.AMT] <> [#2] or [#CX.UC.RATE] <> [#3] or [#CX.UC.LOAN.TERM] <> [#4] or …)',
    plainEnglish:
      'A change detector: compares a snapshot of loan amount / rate / term / type / purpose taken '
      + 'at underwriting against the live values, and flags any drift. The model for how our own '
      + 're-underwrite trigger should work.' },
  { fieldId: 'CX.CDC.CHANGES', label: 'CD changes', dscrFill: '99.8%',
    calculation: 'IIF([#CX.CDC.CTC] <> [#CD3.X23] or [#CX.CDC.LA] <> [#2] or [#CX.CDC.PITI] <> [#CD1.X14] or …)',
    plainEnglish: 'The same idea for the Closing Disclosure — did cash-to-close, loan amount or PITI move after the CD.' },
  { fieldId: 'CX.TOTALLIQUIDITY', label: 'Total liquidity requirement', dscrFill: '67.6%',
    calculation: 'VAL([CX.RTLCASHTOCLOSEESTIMAT]) + VAL([CX.RTLRESERVEDOLLAR]) + VAL([CX.RTLRESERVEOFLOAN]) + VAL([CX.OUTOFPOCKETREHAB]) + VAL([CX.EXTRALIQUIDITY])',
    plainEnglish: 'Cash to close + reserves + out-of-pocket rehab + extra liquidity.',
    caution: 'Built out of RTL (fix & flip) inputs. It is filled on long-term files too, but its '
      + 'rehab/reserve components are bridge concepts — treat with care on DSCR.' },
];

/**
 * Recompute the DSCR ratio the way the tenant does. Returns null when either input is
 * missing — a blank field must never silently become a zero and produce a 0.00 ratio.
 */
function computeDscr(grossMonthlyRent, proposedTotalHousingExpense) {
  const blank = (v) => v === null || v === undefined || v === '' || typeof v === 'boolean';
  if (blank(grossMonthlyRent) || blank(proposedTotalHousingExpense)) return null;
  const rent = Number(grossMonthlyRent);
  const piti = Number(proposedTotalHousingExpense);
  if (!Number.isFinite(rent) || !Number.isFinite(piti) || piti === 0) return null;
  return Math.round((rent / piti) * 100) / 100;
}

module.exports = {
  DSCR_RATIO, KNOWN_DEFECTS, CREDIT_SCORE_LOGIC, OTHER_FORMULAS, computeDscr,
};
