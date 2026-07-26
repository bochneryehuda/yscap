'use strict';
/**
 * SEASONING — the "current state" of a loan for a data-tape export.
 *
 * A capital-provider tape shows a loan's numbers. For a BRAND-NEW loan those are
 * the origination numbers (day-1 advance, full holdback, full interest reserve,
 * first payment date). But when we sell a SEASONED loan — one already funded and
 * partway through its rehab — the tape must show the CURRENT picture:
 *
 *   • Current balance   = day-1 advance + rehab draws released so far
 *                                        + interest reserve used so far
 *   • Current rehab     = original holdback − draws released      (original stays)
 *   • Current reserve   = financed reserve − reserve used         (original stays)
 *   • Next payment due  = the next scheduled monthly payment on/after the as-of date
 *
 * The rehab-draw part is EXACT (we sum the released draws from our own money
 * ledger). How much interest reserve has been "used" is NOT stored anywhere, so we
 * ESTIMATE it as the interest paid to date, which depends on the accrual method
 * (owner-directed):
 *   • Dutch / Full-Boat  → interest accrues on the WHOLE note from closing.
 *   • Non-Dutch / As-Drawn → interest accrues only on funds actually advanced:
 *     the day-1 advance from closing, then a step up on each draw's release date.
 * Reserve is only drawn down once payments begin, so nothing is consumed before
 * the first payment date. Because the reserve figure is an estimate, a seasoned
 * export ALSO asks a human to confirm the current balance, next due date and
 * interest reserve before the file leaves.
 *
 * This module is PURE (no database). assemble.js gathers the released draws;
 * index.js attaches the computed snapshot to the loan before a tape's column
 * getters read it.
 */
const { parseYMD, fmtYMD } = require('../term-options');

function num(v) { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; }
function num0(v) { const x = num(v); return x == null ? 0 : x; }

// Calendar month arithmetic on a {y,mo,d} object (mirrors term-options' internal
// helper, which isn't exported). Clamps the day to the target month's length so
// adding a month to Jan 31 lands on Feb 28/29, never a rolled-over Mar date.
function daysInMonth(y, mo) { return new Date(Date.UTC(y, mo, 0)).getUTCDate(); } // mo is 1-12
function addMonths(o, add) {
  if (!o) return o;
  const t = (o.y * 12 + (o.mo - 1)) + add;
  const ny = Math.floor(t / 12), nm = (t % 12) + 1;
  return { y: ny, mo: nm, d: Math.min(o.d, daysInMonth(ny, nm)) };
}

// Compare two 'YYYY-MM-DD' strings as calendar days: <0, 0, >0. A null sorts last.
function cmpYMD(a, b) {
  const pa = parseYMD(a), pb = parseYMD(b);
  if (!pa && !pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return (pa.y - pb.y) || (pa.mo - pb.mo) || (pa.d - pb.d);
}

// The next scheduled monthly payment (payments fall on the same day-of-month as
// the first payment) on OR AFTER `asOf`. Before the first payment, the next due
// is simply the first payment. Returns a 'YYYY-MM-DD' string (or the input first
// payment unchanged when either date is unparseable).
function nextDueDate(firstPayment, asOf) {
  const fp = parseYMD(firstPayment);
  const a = parseYMD(asOf);
  if (!fp || !a) return firstPayment || null;
  let cur = fp;
  let guard = 0; // bounded well past any real loan term
  while (cmpYMD(fmtYMD(cur), asOf) < 0 && guard < 600) { cur = addMonths(cur, 1); guard++; }
  return fmtYMD(cur);
}

// Whole days between two calendar days under the US 30/360 convention (the RTL
// market default; Blue Lake's tape uses 30/360). Never negative.
function days360(fromYMD, toYMD) {
  const a = parseYMD(fromYMD), b = parseYMD(toYMD);
  if (!a || !b) return 0;
  let d1 = a.d, d2 = b.d;
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  const days = 360 * (b.y - a.y) + 30 * (b.mo - a.mo) + (d2 - d1);
  return days > 0 ? days : 0;
}

// Interest accrued over the window [from, to].
//   dutch    → totalLoan × rate × time (whole note bears interest).
//   non-dutch→ the balance stepping UP by each release on its date; the balance
//              at `from` already includes any draw released on/before `from`.
// rate is a fraction (0.105). Returns dollars (never negative).
function accruedInterest({ from, to, rate, accrual, day1, totalLoan, releases }) {
  const r = num(rate);
  if (r == null || r <= 0 || !from || !to || cmpYMD(from, to) >= 0) return 0;
  if (String(accrual).toLowerCase() === 'dutch') {
    return num0(totalLoan) * r * (days360(from, to) / 360);
  }
  // As-drawn: starting balance = day-1 advance + every draw released on/before
  // `from`; then step up at each release inside the window.
  const rel = (releases || [])
    .map((x) => ({ date: x.date, amount: num0(x.amount) }))
    .filter((x) => x.date && x.amount > 0);
  let bal = num0(day1) + rel.filter((x) => cmpYMD(x.date, from) <= 0).reduce((s, x) => s + x.amount, 0);
  const steps = rel
    .filter((x) => cmpYMD(x.date, from) > 0 && cmpYMD(x.date, to) < 0)
    .sort((a, b) => cmpYMD(a.date, b.date));
  let cursor = from;
  let total = 0;
  for (const s of steps) {
    total += bal * r * (days360(cursor, s.date) / 360);
    bal += s.amount;
    cursor = s.date;
  }
  total += bal * r * (days360(cursor, to) / 360);
  return total > 0 ? total : 0;
}

/**
 * computeSeasoning(input) → the current-state snapshot.
 *
 * input = {
 *   day1, holdback, financedReserve, totalLoan,   // origination economics ($)
 *   rate,                                          // note rate, fraction (0.105)
 *   accrual,                                        // 'dutch' | 'non_dutch'
 *   fundingDate, firstPaymentDate,                  // 'YYYY-MM-DD'
 *   asOf,                                           // 'YYYY-MM-DD' (export date)
 *   releases: [{ date:'YYYY-MM-DD', amount:Number }] // rehab draws released
 * }
 *
 * Every dollar field is clamped to sane ranges (a draw total can't exceed the
 * holdback; used reserve can't exceed the financed reserve). isSeasoned is true
 * only when the current picture actually differs from origination, so a fresh
 * loan's tape is byte-for-byte what it was before.
 */
function computeSeasoning(input) {
  const i = input || {};
  const day1raw = num(i.day1);
  const holdback = num0(i.holdback);
  const financedReserve = num0(i.financedReserve);
  const totalLoan = num(i.totalLoan);
  const accrual = String(i.accrual || 'non_dutch').toLowerCase() === 'dutch' ? 'dutch' : 'non_dutch';
  const asOf = i.asOf || null;
  const fundingDate = i.fundingDate || null;
  const firstPaymentDate = i.firstPaymentDate || null;
  const day1 = day1raw != null ? day1raw : (totalLoan != null ? totalLoan - holdback - financedReserve : 0);

  // Rehab draws released so far (never more than the holdback). EXACT.
  const releases = (i.releases || [])
    .map((x) => ({ date: x.date || null, amount: num0(x.amount) }))
    .filter((x) => x.amount > 0);
  const releasedRaw = releases.reduce((s, x) => s + x.amount, 0);
  const disbursedHoldback = Math.min(holdback, releasedRaw);

  // Interest reserve used so far ≈ interest paid to date, capped at what was
  // financed. Payments (and therefore reserve draw-down) begin at the first
  // payment date; the covered periods run from the first FULL period (one month
  // before the first payment) up to the as-of date. Nothing is consumed before
  // then, and only a FINANCED reserve is disbursed (owner-directed).
  let disbursedReserve = 0;
  if (financedReserve > 0 && firstPaymentDate && asOf && cmpYMD(asOf, firstPaymentDate) >= 0) {
    const firstPeriodStart = fmtYMD(addMonths(parseYMD(firstPaymentDate), -1));
    const accrued = accruedInterest({ from: firstPeriodStart, to: asOf, rate: i.rate, accrual, day1, totalLoan, releases });
    disbursedReserve = Math.min(financedReserve, accrued);
  }

  const currentBalance = day1 + disbursedHoldback + disbursedReserve;
  const currentRehab = Math.max(0, holdback - disbursedHoldback);
  const currentReserve = Math.max(0, financedReserve - disbursedReserve);
  const nextDue = nextDueDate(firstPaymentDate, asOf);

  // Seasoned = the current picture differs from origination: money has been
  // released, reserve has been used, or the as-of date is past the first payment.
  const pastFirstPayment = firstPaymentDate && asOf ? cmpYMD(asOf, firstPaymentDate) > 0 : false;
  const isSeasoned = disbursedHoldback > 0 || disbursedReserve > 0 || pastFirstPayment;

  return {
    isSeasoned,
    asOf,
    fundingDate,
    accrual,
    day1,
    holdback,
    financedReserve,
    totalLoan,
    disbursedHoldback,
    undisbursedHoldback: currentRehab,
    disbursedReserve,
    undisbursedReserve: currentReserve,
    currentBalance,
    currentRehab,           // alias: the rehab holdback still available
    currentReserve,         // alias: the interest reserve still available
    nextDue,
    firstPaymentDate,
    // Interest-bearing balance: the whole note under Dutch; only the advanced /
    // capitalized balance under as-drawn.
    interestBearing: accrual === 'dutch' ? (totalLoan != null ? totalLoan : currentBalance) : currentBalance,
    releaseCount: releases.length,
    releasedTotal: disbursedHoldback,
  };
}

// Extract the origination economics + dates a seasoning snapshot needs from an
// assembled loan (assemble.js output). Reads the SAME registered-quote keys the
// tape economics() functions use (sizing.totalLoan / initialAdvance /
// rehabHoldback / financedReserve, quote.noteRate, accrual_type), so the current
// snapshot and the origination columns always agree.
function seasoningInputs(loan, asOf) {
  const q = (loan && loan.quote) || {};
  const sz = q.sizing || {};
  const a = (loan && loan.app) || {};
  const toFraction = (v) => { const x = num(v); if (x == null) return null; return x > 1 ? x / 100 : x; };
  const totalLoan = num(sz.totalLoan) != null ? num(sz.totalLoan)
    : (loan && loan.registration && num(loan.registration.total_loan) != null ? num(loan.registration.total_loan) : num(a.loan_amount));
  const holdback = num(sz.rehabHoldback) != null ? num(sz.rehabHoldback) : num(a.rehab_budget);
  const financedReserve = num(sz.financedReserve) != null ? num(sz.financedReserve)
    : (num(a.requested_ir_amount) != null ? num(a.requested_ir_amount) : 0);
  let day1 = num(sz.initialAdvance);
  if (day1 == null && totalLoan != null) day1 = totalLoan - num0(holdback) - num0(financedReserve);
  return {
    day1,
    holdback: num0(holdback),
    financedReserve: num0(financedReserve),
    totalLoan,
    rate: q.noteRate != null ? toFraction(q.noteRate) : toFraction(a.rate_pct),
    accrual: String(a.accrual_type || '').toLowerCase() === 'dutch' ? 'dutch' : 'non_dutch',
    fundingDate: (loan && loan.fundingDate) || a.actual_closing || null,
    firstPaymentDate: a.first_payment_date || null,
    asOf: asOf || null,
    releases: (loan && loan.releases) || [],
  };
}

// Apply a human's confirmed overrides to a computed snapshot. Each override is an
// ABSOLUTE confirmed value (the numbers a staffer verified before export). Only
// finite / valid values are applied; a blank/invalid override leaves the computed
// value in place. Dependent fields are kept consistent.
function applySeasonedOverrides(snap, overrides) {
  const o = overrides || {};
  const out = Object.assign({}, snap);
  const financed = num0(out.financedReserve);
  const balOv = num(o.current_balance);
  const resOv = num(o.current_reserve);
  const haveBal = balOv != null && balOv >= 0;
  const haveRes = resOv != null && resOv >= 0;

  if (haveRes) {
    const rem = Math.min(resOv, financed);
    out.currentReserve = rem;
    out.undisbursedReserve = rem;
    out.disbursedReserve = Math.max(0, financed - rem);
    out.overriddenReserve = true;
    // Keep the disbursement columns tying (day1 + draws + reserve-used ==
    // current balance): if the balance wasn't ALSO confirmed, derive it here.
    if (!haveBal) {
      out.currentBalance = num0(out.day1) + num0(out.disbursedHoldback) + out.disbursedReserve;
      if (out.accrual !== 'dutch') out.interestBearing = out.currentBalance;
    }
  }
  if (haveBal) {
    out.currentBalance = balOv;
    // For as-drawn the whole current balance bears interest; for Dutch the
    // interest-bearing balance stays the whole note.
    if (out.accrual !== 'dutch') out.interestBearing = balOv;
    out.overriddenBalance = true;
    // Back-solve the reserve split from the confirmed balance so the columns
    // still tie — unless the reserve was separately confirmed (then honor both).
    if (!haveRes) {
      const disb = Math.max(0, Math.min(financed, balOv - num0(out.day1) - num0(out.disbursedHoldback)));
      out.disbursedReserve = disb;
      out.undisbursedReserve = financed - disb;
      out.currentReserve = out.undisbursedReserve;
    }
  }
  const due = o.next_due;
  if (due && parseYMD(due)) { out.nextDue = fmtYMD(parseYMD(due)); out.overriddenNextDue = true; }
  return out;
}

module.exports = {
  computeSeasoning,
  seasoningInputs,
  applySeasonedOverrides,
  nextDueDate,
  days360,
  accruedInterest,
  cmpYMD,
};
