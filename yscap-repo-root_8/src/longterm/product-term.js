'use strict';
/**
 * LONG-TERM — IS THIS FILE LONG-TERM OR SHORT-TERM?
 *
 * The owner's rule, in their own words (2026-08-16):
 *
 *   "any file that has, in the loan program, the word FLIP means that it's RTL,
 *    short term. You can also go by the term. Any term that is less than 36
 *    months is short term. Give me a list of all the files that have a term of
 *    more than 36 months."
 *
 * WHY THIS EXISTS AT ALL. The long-term pipeline discovers loans with the filter
 * `Loan.LoanAmount > 0` — i.e. THE WHOLE ENCOMPASS BOOK — because there is no
 * folder that separates the two products at the source. So the long-term side
 * currently mirrors RTL loans as well, and nothing anywhere tells them apart.
 * This module is that missing line, and it is the ONE place it is drawn: every
 * screen, report and query asks here, so two surfaces can never disagree about
 * which product a file belongs to.
 *
 * THE TWO SIGNALS, AND WHY THE PROGRAM WINS
 * ------------------------------------------------------------------------
 * The owner gave the program rule first and flatly ("FLIP MEANS it's RTL"), and
 * the term second as a second way in ("you can ALSO go by the term"). So a
 * program naming Flip is DECISIVE and a term is what answers everything else.
 * That ordering is not a preference — it is what the live book looks like:
 * `dictionary/program-taxonomy.json` (772 real loans, 2026-08-14) shows the one
 * Flip program carrying terms of 11, 12, 18 and 24 months, and every DSCR
 * program carrying 360 or 480. The two signals agree on all 772; the precedence
 * only matters on a file where somebody has typed something odd, and there the
 * owner's sentence decides it.
 *
 * WHEN THEY DISAGREE, WE SAY SO. A Flip program with a 360-month term is not a
 * long-term loan and is not silently either: it is classified short-term, per
 * the rule, and carries `disagrees: true` so the report can show it to a human.
 * A rule that quietly swallows a contradiction is how a mis-keyed file hides.
 *
 * WHAT WE REFUSE TO ANSWER — and this is the important half
 * ------------------------------------------------------------------------
 *   · EXACTLY 36 MONTHS. The owner said "less than 36 is short" and "more than
 *     36" for the list. They did not say which side 36 itself falls on, and a
 *     three-year term is a real product. Guessing would put a file on the wrong
 *     product with nothing on any screen to say it was a guess, so 36 comes back
 *     as `boundary` and is REPORTED SEPARATELY for the owner to rule on once.
 *     (Never guess a business rule — ask the owner and wait.)
 *   · NO PROGRAM AND NO TERM. `unknown`, listed as such. In the taxonomy that is
 *     12 loans of 772 — small, real, and not something to invent an answer for.
 *
 * PURE. No database, no network, no config. Every input is passed in, so the
 * whole policy is unit-testable without a Postgres and without Encompass.
 */

/** The owner's boundary, in months. Both comparisons are strict, deliberately. */
const LONG_TERM_MIN_MONTHS = 36;

/**
 * The word that makes a program short-term.
 *
 * Matched case-insensitively ANYWHERE in the program name, with no word-boundary
 * requirement, because the owner said "has, in the loan program, the word FLIP"
 * and the real program is spelled "Fix & Flip Purchase + reno" — the word sits
 * mid-string beside an ampersand and a plus sign, where a `\b`-anchored regex is
 * easy to get subtly wrong. There is no English word in a loan-program name that
 * contains "flip" and does not mean a flip, so the loose match costs nothing.
 */
const SHORT_TERM_PROGRAM_WORD = 'flip';

const PRODUCT = {
  LONG: 'long_term',
  SHORT: 'short_term',
  BOUNDARY: 'boundary',
  UNKNOWN: 'unknown',
};

/** Trim to a string; anything unusable becomes ''. */
function text(v) {
  return String(v == null ? '' : v).trim();
}

/**
 * Read a term in MONTHS, or null.
 *
 * Encompass field 4 (`loanAmortizationTermMonths`) is months — that is the
 * field's own name and it is a live-probe-VERIFIED row in the long-term
 * reconciliation map, which is why this does no unit-sniffing. A value of "30"
 * is thirty MONTHS here, not thirty years, and quietly "correcting" it would
 * silently move a real 30-month bridge loan onto the long-term side.
 *
 * Refuses anything that is not a positive whole number of months: 0, a negative,
 * a fraction and junk all mean "we do not have a term", never a term of nothing.
 */
function termMonthsOf(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Does this program name make the file short-term? */
function programSaysShortTerm(programName) {
  return text(programName).toLowerCase().includes(SHORT_TERM_PROGRAM_WORD);
}

/**
 * Classify one file.
 *
 * @param {{programName?: string, termMonths?: number|string|null}} loan
 * @returns {{product: string, reason: string, why: string,
 *            programName: string|null, termMonths: number|null,
 *            disagrees: boolean}}
 *
 * `reason` is a stable machine key (so a report can group on it and a future
 * program that credits something can select on it); `why` is the plain sentence
 * a person reads on the screen. Both are always present, including for the two
 * answers we decline to give.
 */
function classifyProduct(loan) {
  const programName = text(loan && loan.programName) || null;
  const termMonths = termMonthsOf(loan && loan.termMonths);
  const flip = programSaysShortTerm(programName);

  // THE PROGRAM DECIDES FIRST — the owner's rule, stated flatly.
  if (flip) {
    // A Flip program with a long term is a contradiction we surface rather than
    // resolve. It stays SHORT-TERM (the owner's word is the rule); `disagrees`
    // is what puts it in front of a human.
    const disagrees = termMonths != null && termMonths > LONG_TERM_MIN_MONTHS;
    return {
      product: PRODUCT.SHORT,
      reason: 'program_says_flip',
      why: disagrees
        ? `The loan program says Flip, so this is a short-term (RTL) file — but its term is ${termMonths} months, which does not match a flip. Worth a look.`
        : 'The loan program says Flip, so this is a short-term (RTL) file.',
      programName,
      termMonths,
      disagrees,
    };
  }

  if (termMonths == null) {
    return {
      product: PRODUCT.UNKNOWN,
      reason: 'no_program_signal_and_no_term',
      why: programName
        ? `The loan program (${programName}) does not say Flip and there is no term on the file, so we cannot tell which product this is.`
        : 'There is no loan program and no term on the file, so we cannot tell which product this is.',
      programName,
      termMonths,
      disagrees: false,
    };
  }

  if (termMonths === LONG_TERM_MIN_MONTHS) {
    return {
      product: PRODUCT.BOUNDARY,
      reason: 'term_exactly_at_boundary',
      why: `The term is exactly ${LONG_TERM_MIN_MONTHS} months. The rule covers under 36 and over 36 but not 36 itself, so this one needs a decision.`,
      programName,
      termMonths,
      disagrees: false,
    };
  }

  const long = termMonths > LONG_TERM_MIN_MONTHS;
  return {
    product: long ? PRODUCT.LONG : PRODUCT.SHORT,
    reason: long ? 'term_over_boundary' : 'term_under_boundary',
    why: long
      ? `The term is ${termMonths} months, which is more than ${LONG_TERM_MIN_MONTHS}, so this is a long-term file.`
      : `The term is ${termMonths} months, which is less than ${LONG_TERM_MIN_MONTHS}, so this is a short-term (RTL) file.`,
    programName,
    termMonths,
    disagrees: false,
  };
}

/** Is this file on the long-term side? Only a definite yes counts. */
function isLongTerm(loan) {
  return classifyProduct(loan).product === PRODUCT.LONG;
}

/**
 * Split a list of files the way the owner asked for it.
 *
 * The long-term list is the answer to the question; the other three buckets
 * exist so nothing is ever silently dropped out of a total — a file is in
 * exactly one of them, and `boundary` + `unknown` are the two the owner has to
 * rule on rather than the two we quietly decided.
 */
function splitByProduct(loans) {
  const out = { longTerm: [], shortTerm: [], boundary: [], unknown: [], disagreements: [] };
  for (const loan of Array.isArray(loans) ? loans : []) {
    const verdict = classifyProduct(loan);
    const row = { ...loan, ...verdict };
    if (verdict.disagrees) out.disagreements.push(row);
    if (verdict.product === PRODUCT.LONG) out.longTerm.push(row);
    else if (verdict.product === PRODUCT.SHORT) out.shortTerm.push(row);
    else if (verdict.product === PRODUCT.BOUNDARY) out.boundary.push(row);
    else out.unknown.push(row);
  }
  return out;
}

/**
 * The SQL form of the same rule, for a report that must not drag the whole book
 * through Node to filter it.
 *
 * It is written to agree with `classifyProduct` case for case, and
 * `test-lt-product-term-db.js` runs BOTH over the same rows and fails the moment
 * they disagree — the JS/SQL twin discipline this repo already applies to the
 * term, property-type and address comparisons, because a hand-kept second copy
 * is how the two drift and the one that drifts is the one that leaks.
 *
 * @param {string} p program-name expression   @param {string} t term expression
 */
function productSql(p = 'program_name', t = 'term_months') {
  return `CASE
      WHEN position('${SHORT_TERM_PROGRAM_WORD}' in lower(coalesce(${p}, ''))) > 0 THEN '${PRODUCT.SHORT}'
      WHEN ${t} IS NULL OR ${t} <= 0 THEN '${PRODUCT.UNKNOWN}'
      WHEN ${t} = ${LONG_TERM_MIN_MONTHS} THEN '${PRODUCT.BOUNDARY}'
      WHEN ${t} > ${LONG_TERM_MIN_MONTHS} THEN '${PRODUCT.LONG}'
      ELSE '${PRODUCT.SHORT}'
    END`;
}

module.exports = {
  LONG_TERM_MIN_MONTHS,
  SHORT_TERM_PROGRAM_WORD,
  PRODUCT,
  classifyProduct,
  isLongTerm,
  splitByProduct,
  productSql,
  termMonthsOf,
  programSaysShortTerm,
};
