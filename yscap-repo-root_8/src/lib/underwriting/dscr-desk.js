'use strict';
/**
 * #204 — the advisory DSCR DESK (rent vs PITIA).
 *
 * DSCR — Debt Service Coverage Ratio — is the rental-underwriting yardstick: how
 * far the property's rent covers the monthly loan payment plus taxes, insurance
 * and association dues (PITIA). A DSCR of 1.00 is exact break-even; above 1.00 the
 * rent more than covers the payment; below 1.00 there is a shortfall the borrower
 * must cover out of pocket. YS Capital is RTL-first, but rented / hold-to-rent /
 * DSCR-note deals need this analysis, and a note buyer often carries a DSCR floor.
 *
 * This module turns rent + payment components into ONE readable DSCR report:
 *   • PITIA — Principal & Interest + Taxes + Insurance + Association (HOA) dues
 *     (+ optional flood / other), all normalized to a MONTHLY figure. The P&I can
 *     be supplied directly, or derived interest-only (loan × rate ÷ 12), or fully
 *     amortized over a term.
 *   • RENT — a single monthly rent, or a RENT ROLL (per-unit lines) summed; an
 *     optional vacancy factor yields an effective (collected) rent too.
 *   • DSCR = rent ÷ PITIA, classified ONLY against a caller-supplied advisory floor
 *     (a program / note-buyer minimum). With no floor it stays purely informational.
 *
 * ADVISORY ONLY — it INFORMS underwriting; it NEVER hard-blocks a loan (governing
 * rule #217). Even a DSCR below the floor is a super-admin-overridable observation:
 * `overridable` is always true, and there is no `block` field. This introduces NO
 * pricing/guideline number — the floor is an input, and 1.00 is the arithmetic
 * definition of break-even, not a proprietary threshold.
 *
 * PURE: no DB, no clock, no Math.random, no I/O. NEVER THROWS — every export
 * degrades to a safe default on hostile input.
 */

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function nonNeg(v) { const n = num(v); return n == null ? null : (n < 0 ? 0 : n); }
function arr(v) { return Array.isArray(v) ? v : []; }
function round2(n) { return Math.round(n * 100) / 100; }
function round0(n) { return Math.round(n); }

/**
 * monthly(value, {annual}) — normalize a taxes/insurance/HOA figure to MONTHLY.
 * A caller may pass a monthly amount directly, or an annual amount to divide by 12.
 * A negative or non-finite value degrades to 0 (never a negative PITIA component).
 */
function toMonthly(value, annual) {
  const v = nonNeg(value);
  if (v == null) return 0;
  return annual === true ? round2(v / 12) : round2(v);
}

/**
 * monthlyPI(pi) — resolve the monthly Principal & Interest.
 *   pi: {
 *     monthly | amount          — a directly supplied monthly P&I, OR
 *     loanAmount, rate,         — rate as a DECIMAL (0.1025) or a percent (10.25);
 *     interestOnly? (default true when no term),
 *     termMonths?               — if given (and not interest-only) → amortized P&I
 *   }
 * Returns a non-negative monthly figure, or 0 when nothing usable is supplied.
 * PURE, never throws.
 */
function monthlyPI(pi) {
  try {
    const p = pi && typeof pi === 'object' ? pi : {};
    const direct = nonNeg(p.monthly != null ? p.monthly : p.amount);
    if (direct != null && (p.monthly != null || p.amount != null)) return round2(direct);

    const loan = nonNeg(p.loanAmount != null ? p.loanAmount : p.loan);
    let rate = num(p.rate != null ? p.rate : p.noteRate);
    if (loan == null || rate == null) return 0;
    if (rate < 0) rate = 0;
    // accept a percent (10.25) or a decimal (0.1025): anything > 1 is treated as a percent.
    if (rate > 1) rate = rate / 100;
    const monthlyRate = rate / 12;

    const termMonths = num(p.termMonths);
    const interestOnly = p.interestOnly === true || !(termMonths != null && termMonths > 0);
    if (interestOnly) return round2(loan * monthlyRate);

    // fully-amortizing payment; a 0% rate degrades to straight-line principal.
    if (monthlyRate === 0) return round2(loan / termMonths);
    const factor = Math.pow(1 + monthlyRate, termMonths);
    const pmt = loan * (monthlyRate * factor) / (factor - 1);
    return Number.isFinite(pmt) ? round2(pmt) : 0;
  } catch (_e) { return 0; }
}

/**
 * computePitia(parts) → { monthly, breakdown:{pi,taxes,insurance,association,flood,other} }
 *   parts: {
 *     pi | monthlyPI              — a monthly P&I number, OR pass `pi` as the object
 *                                   monthlyPI() accepts (loanAmount/rate/term/...),
 *     monthly | total             — a pre-summed monthly PITIA total (used only when no
 *                                   P&I/components are itemized; lands under breakdown.pi),
 *     taxes, taxesAnnual?,        — taxes (monthly, or annual with the *Annual flag),
 *     insurance, insuranceAnnual?,
 *     hoa | association, hoaAnnual?,
 *     flood, floodAnnual?,
 *     other, otherAnnual?
 *   }
 * Every component is normalized to MONTHLY and floored at 0. PURE, never throws.
 */
function computePitia(parts) {
  try {
    const p = parts && typeof parts === 'object' ? parts : {};
    // P&I: a bare number, or an object monthlyPI() can resolve.
    let pi;
    if (p.pi != null && typeof p.pi === 'object') pi = monthlyPI(p.pi);
    else if (p.monthlyPI != null && typeof p.monthlyPI === 'object') pi = monthlyPI(p.monthlyPI);
    else {
      // a bare P&I number, or a pre-summed monthly PITIA total (monthly|total).
      const direct = nonNeg(
        p.pi != null ? p.pi
          : p.monthlyPI != null ? p.monthlyPI
            : p.monthly != null ? p.monthly
              : p.total,
      );
      pi = direct == null ? 0 : round2(direct);
    }

    const taxes = toMonthly(p.taxes, p.taxesAnnual);
    const insurance = toMonthly(p.insurance, p.insuranceAnnual);
    const association = toMonthly(p.hoa != null ? p.hoa : p.association, p.hoaAnnual != null ? p.hoaAnnual : p.associationAnnual);
    const flood = toMonthly(p.flood, p.floodAnnual);
    const other = toMonthly(p.other, p.otherAnnual);

    const monthly = round2(pi + taxes + insurance + association + flood + other);
    return { monthly, breakdown: { pi, taxes, insurance, association, flood, other } };
  } catch (_e) {
    return { monthly: 0, breakdown: { pi: 0, taxes: 0, insurance: 0, association: 0, flood: 0, other: 0 } };
  }
}

/**
 * grossRent(rent) → { monthly, units, lines:[{unit,monthly}] }
 *   rent: a monthly number, OR
 *         { monthly } | { monthlyRent } | { annual } (÷12), OR
 *         a RENT ROLL array of lines: [{ unit?, monthlyRent | monthly | rent | annualRent }].
 * A rent roll sums every line's monthly rent (annual lines ÷ 12). PURE, never throws.
 */
function grossRent(rent) {
  try {
    if (Array.isArray(rent)) {
      const lines = [];
      let sum = 0;
      for (let i = 0; i < rent.length; i++) {
        const r = rent[i] && typeof rent[i] === 'object' ? rent[i] : { monthly: rent[i] };
        let m = nonNeg(r.monthlyRent != null ? r.monthlyRent : (r.monthly != null ? r.monthly : r.rent));
        if (m == null) { const a = nonNeg(r.annualRent != null ? r.annualRent : r.annual); m = a == null ? null : round2(a / 12); }
        if (m == null) m = 0;
        const unit = r.unit != null ? String(r.unit) : String(i + 1);
        lines.push({ unit, monthly: m });
        sum += m;
      }
      return { monthly: round2(sum), units: lines.length, lines };
    }
    if (rent && typeof rent === 'object') {
      let m = nonNeg(rent.monthly != null ? rent.monthly : rent.monthlyRent);
      if (m == null) { const a = nonNeg(rent.annual != null ? rent.annual : rent.annualRent); m = a == null ? 0 : round2(a / 12); }
      return { monthly: m == null ? 0 : m, units: 1, lines: [{ unit: '1', monthly: m == null ? 0 : m }] };
    }
    const m = nonNeg(rent);
    return { monthly: m == null ? 0 : round2(m), units: m == null ? 0 : 1, lines: m == null ? [] : [{ unit: '1', monthly: round2(m) }] };
  } catch (_e) { return { monthly: 0, units: 0, lines: [] }; }
}

/**
 * classify(dscr, floor, opts) → { status, meetsFloor, breakEven }
 * Advisory classification, computed ONLY against a caller-supplied floor:
 *   • no usable floor            → status 'informational' (a DSCR with no bar to clear)
 *   • dscr null (can't divide)   → status 'unknown'
 *   • dscr >= floor              → 'pass'
 *   • within opts.marginalBand   → 'marginal'  (default band 0 → never triggers)
 *   • else                       → 'short'
 * `breakEven` is the definitional dscr >= 1.00 flag (arithmetic, not a guideline).
 */
function classify(dscr, floor, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const band = nonNeg(o.marginalBand) || 0;
  const breakEven = dscr != null ? dscr >= 1 : null;
  const f = num(floor);
  if (dscr == null) return { status: 'unknown', meetsFloor: null, breakEven };
  if (f == null || f <= 0) return { status: 'informational', meetsFloor: null, breakEven };
  if (dscr >= f) return { status: 'pass', meetsFloor: true, breakEven };
  if (band > 0 && dscr >= f - band) return { status: 'marginal', meetsFloor: false, breakEven };
  return { status: 'short', meetsFloor: false, breakEven };
}

/**
 * dscrDesk(input) → the full advisory DSCR report  (PURE, NEVER THROWS)
 *   input: {
 *     rent,            — number | {monthly|annual} | rent-roll array (see grossRent)
 *     pitia,           — the object computePitia() accepts (or {monthly} directly),
 *     vacancy?,        — a 0..1 (or 0..100 percent) vacancy factor for effective rent,
 *     floor?,          — an advisory DSCR minimum (program / note-buyer); no verdict without it,
 *     marginalBand?,   — a display band just under the floor (default 0),
 *     program?, noteBuyer?  — passed through for the caller's context (not used in math)
 *   }
 * Returns {
 *   rent:{ monthly, effectiveMonthly, units, lines, vacancy },
 *   pitia:{ monthly, breakdown },
 *   dscr, effectiveDscr, floor, status, meetsFloor, breakEven, shortfallMonthly,
 *   program, noteBuyer, overridable:true, note
 * }.
 */
function dscrDesk(input) {
  try {
    const inp = input && typeof input === 'object' ? input : {};
    const rent = grossRent(inp.rent);
    const pitia = computePitia(inp.pitia != null ? inp.pitia : inp);

    // vacancy: accept 0..1 or a 0..100 percent; clamp to [0,1).
    let vac = num(inp.vacancy);
    if (vac == null) vac = 0;
    if (vac > 1) vac = vac / 100;
    if (vac < 0) vac = 0;
    if (vac >= 1) vac = 0.99;
    const effectiveMonthly = round2(rent.monthly * (1 - vac));

    const canDivide = pitia.monthly > 0;
    const dscr = canDivide ? round2(rent.monthly / pitia.monthly) : null;
    const effectiveDscr = canDivide ? round2(effectiveMonthly / pitia.monthly) : null;

    const floor = num(inp.floor);
    const cls = classify(dscr, floor, { marginalBand: inp.marginalBand });

    // the monthly out-of-pocket gap when rent does not cover PITIA (0 when it does).
    const shortfallMonthly = canDivide ? round2(Math.max(0, pitia.monthly - rent.monthly)) : null;

    let note;
    if (dscr == null) note = 'PITIA is zero or unknown, so a coverage ratio cannot be computed.';
    else if (cls.status === 'informational') note = `Rent covers ${(dscr).toFixed(2)}× the monthly payment (no program floor supplied).`;
    else if (cls.status === 'pass') note = `Rent covers ${(dscr).toFixed(2)}× the payment — at or above the ${Number(floor).toFixed(2)} floor.`;
    else if (cls.status === 'marginal') note = `Rent covers ${(dscr).toFixed(2)}× — just under the ${Number(floor).toFixed(2)} floor.`;
    else note = `Rent covers only ${(dscr).toFixed(2)}× — below the ${Number(floor).toFixed(2)} floor; the gap is about $${round0(shortfallMonthly)}/mo.`;

    return {
      rent: { monthly: rent.monthly, effectiveMonthly, units: rent.units, lines: rent.lines, vacancy: round2(vac) },
      pitia: { monthly: pitia.monthly, breakdown: pitia.breakdown },
      dscr,
      effectiveDscr,
      floor: floor != null && floor > 0 ? floor : null,
      status: cls.status,
      meetsFloor: cls.meetsFloor,
      breakEven: cls.breakEven,
      shortfallMonthly,
      program: inp.program != null ? String(inp.program) : null,
      noteBuyer: inp.noteBuyer != null ? String(inp.noteBuyer) : null,
      overridable: true, // #217 — advisory; a super-admin decision always wins
      note,
    };
  } catch (_e) {
    return {
      rent: { monthly: 0, effectiveMonthly: 0, units: 0, lines: [], vacancy: 0 },
      pitia: { monthly: 0, breakdown: { pi: 0, taxes: 0, insurance: 0, association: 0, flood: 0, other: 0 } },
      dscr: null, effectiveDscr: null, floor: null, status: 'unknown', meetsFloor: null,
      breakEven: null, shortfallMonthly: null, program: null, noteBuyer: null,
      overridable: true, note: 'DSCR could not be computed.',
    };
  }
}

module.exports = { dscrDesk, computePitia, grossRent, monthlyPI, classify, toMonthly };
