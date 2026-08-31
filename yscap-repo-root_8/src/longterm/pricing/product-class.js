'use strict';
/**
 * LONG-TERM — the PRODUCT CLASS: the only basis on which two vendors' quotes
 * may be compared.
 *
 * WHY THIS FILE EXISTS. A 30-year fixed and a 5/6 ARM are not the same loan, and
 * an interest-only 30-year fixed is not the plain one. Comparing a price across
 * those is not a comparison, it is a category error that produces a confident
 * wrong answer — the single most dangerous output a pricing engine has. So no
 * price is ever compared to another until BOTH have been reduced to the same
 * class, and a quote whose class cannot be determined is EXCLUDED from the
 * comparison rather than assumed to be a fixed 30.
 *
 * TWO INPUTS, ONE CLASS. LoanNEX hands us structured facts (`amortizationType`,
 * `termInMonths`, `isInterestOnly`, `armMonths`) straight off its
 * `mortgageProducts` table — those are used verbatim when present. Lender Price
 * hands us a product STRING, so it is parsed. Structured always wins over
 * parsed; parsing is the fallback, never the primary.
 *
 * PURE: no network, no database, no RTL import.
 */

/** "30 Yr. Fixed IO (10 Yr. IO)" / "5/6 ARM (30 Yr. Term)" → the facts inside. */
function parseProductString(s) {
  const t = String(s == null ? '' : s);
  if (!t.trim()) return null;
  const io = /\bI\/?O\b|interest[\s-]*only/i.test(t);
  const ioTerm = (t.match(/\((\d+)\s*Yr\.?\s*I\/?O\)/i) || [])[1];

  const arm = t.match(/(\d+)\s*\/\s*(\d+)\s*ARM/i);
  if (arm) {
    const termYrs = (t.match(/\((\d+)\s*Yr\.?\s*Term/i) || [])[1];
    return {
      amortization: 'ARM',
      termInMonths: termYrs ? Number(termYrs) * 12 : 360,
      armMonths: Number(arm[1]) * 12,
      adjustmentPeriodMonths: Number(arm[2]) <= 12 ? Number(arm[2]) : Number(arm[2]),
      isInterestOnly: io,
      interestOnlyTerm: ioTerm ? Number(ioTerm) * 12 : null,
    };
  }
  const fixed = t.match(/(\d+)\s*Yr\.?\s*Fixed/i) || t.match(/Fixed\s*(\d+)/i);
  if (fixed) {
    return {
      amortization: 'Fixed', termInMonths: Number(fixed[1]) * 12, armMonths: null,
      adjustmentPeriodMonths: null, isInterestOnly: io, interestOnlyTerm: ioTerm ? Number(ioTerm) * 12 : null,
    };
  }
  return null;
}

/**
 * The class of one program row from either vendor.
 * @returns { key, amortization, termInMonths, armMonths, isInterestOnly } or null
 *          when the product cannot be determined — the caller must then EXCLUDE it.
 */
function classify(row) {
  const r = row || {};
  let facts = null;
  if (r.amortizationType) {
    facts = {
      amortization: String(r.amortizationType),
      termInMonths: r.termInMonths == null ? null : Number(r.termInMonths),
      armMonths: r.armMonths == null ? null : Number(r.armMonths),
      adjustmentPeriodMonths: r.adjustmentPeriodMonths == null ? null : Number(r.adjustmentPeriodMonths),
      isInterestOnly: !!r.isInterestOnly,
      interestOnlyTerm: r.interestOnlyTerm == null ? null : Number(r.interestOnlyTerm),
    };
  } else {
    facts = parseProductString(r.product);
  }
  if (!facts || !facts.amortization || facts.termInMonths == null) return null;

  // The key is deliberately COARSE on the interest-only TERM (a 5-year and a
  // 10-year I/O both class as "IO") but never on I/O itself. Vendors describe the
  // I/O period inconsistently, and refusing to compare an I/O 30-fixed to an I/O
  // 30-fixed over that would leave most investors with no comparable basis at all.
  const parts = [facts.amortization, facts.termInMonths];
  if (facts.amortization === 'ARM' && facts.armMonths != null) parts.push(`arm${facts.armMonths}`);
  if (facts.isInterestOnly) parts.push('IO');
  return { key: parts.join('-'), ...facts };
}

module.exports = { classify, parseProductString };
