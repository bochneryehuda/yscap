/**
 * LONG-TERM PRICING ENGINE — the DSCR calculator.
 *
 * PURE, AND DELIBERATELY NOT JSX, for the reason priceBuild.js records: a `.jsx` module can only
 * be loaded in a test by bundling it through esbuild, which is installed under `app-v2/` and is NOT
 * present on CI — so every render-through-esbuild suite SKIPS on the build server. Money rules that
 * live inside a screen are therefore checked on a developer's machine and nowhere else. These are
 * money rules, so they live here, where CI can run them.
 *
 * ⛔ THE RATIO IS THE TENANT'S OWN, AND IT IS SETTLED KNOWLEDGE — NOT SOMETHING TO RE-DERIVE.
 * `src/longterm/encompass/formulas.js` records it as owner-confirmed on 2026-08-14, in the owner's
 * own words, and verified by recomputing it on every live DSCR loan that carries both fields:
 *
 *     DSCR = Round( [1005] / [912] , 2 )
 *
 *   [1005] = the subject property's MONTHLY qualifying rent — monthly, not annual, not net of
 *            vacancy.
 *   [912]  = the PROPOSED total monthly housing expense — principal + interest + taxes +
 *            insurance + association dues. The true PITIA.
 *
 * This module is the BROWSER MIRROR of that rule (a screen cannot require server code — the
 * `lib/payoff.js` arrangement this repo uses throughout). A mirror that is allowed to drift is
 * worse than no mirror, so `scripts/test-lt-dscr-calc.mjs` runs the SERVER's own `computeDscr`
 * beside this one over a battery and fails the moment they disagree.
 */

const nn = (v) => typeof v === 'number' && Number.isFinite(v);

/** Cents, so a sum of money behaves like the currency field it is standing in for. */
const cents = (v) => Math.round(v * 100) / 100;

/**
 * A figure the user typed as either a MONTHLY or a YEARLY amount, as a monthly amount.
 *
 * The owner's ask: *"Next to the property tax and the insurance you should be able to switch it to
 * yearly to put in the yearly amount. Instead of monthly your system should divide it by twelve."*
 *
 * A basis this does not recognise is treated as MONTHLY, deliberately: monthly is what the field
 * says on its face, so an unreadable toggle shows the number the user typed rather than silently
 * dividing it by twelve behind their back.
 */
export function perMonth(amount, basis) {
  if (!nn(amount)) return null;
  return basis === 'yearly' ? cents(amount / 12) : cents(amount);
}

/**
 * The monthly principal-and-interest payment.
 *
 * TWO SHAPES, AND THE SCREEN PICKS BY WHAT THE SCENARIO SAYS — the owner's *"your system should
 * figure out how he's entering the scenario, so if he's doing the interest-only check your system
 * should know that the monthly payment is gonna be interest-only and depends on the term"*.
 *
 *   INTEREST ONLY → loan x monthly rate. The term does not enter it, because during an
 *     interest-only period nothing is being repaid. Real interest-only DSCR loans are usually ten
 *     years interest-only and then amortising over the remainder (`encompass/terms.js` records the
 *     shapes), but the payment a DSCR ratio QUALIFIES on is the interest-only one — which is what
 *     the owner described, and what the screen says on its face.
 *
 *   FULLY AMORTISING → the standard level-payment formula over the term:
 *     pmt = P x r / (1 - (1 + r)^-n)
 *
 * A ZERO RATE is not a division by zero here but it would be in that formula, so it is answered
 * directly: with no interest, the payment is simply the principal spread over the term. Returns
 * null rather than a guess when anything needed is missing or absurd.
 */
export function monthlyPI({ loanAmount, ratePct, termYears, interestOnly }) {
  if (!nn(loanAmount) || loanAmount <= 0) return null;
  if (!nn(ratePct) || ratePct < 0) return null;
  const r = ratePct / 100 / 12;
  if (interestOnly) return cents(loanAmount * r);
  if (!nn(termYears) || termYears <= 0) return null;
  const n = Math.round(termYears * 12);
  if (n <= 0) return null;
  if (r === 0) return cents(loanAmount / n);
  return cents((loanAmount * r) / (1 - Math.pow(1 + r, -n)));
}

/**
 * The whole calculation, in one answer: what each part costs a month, what they come to, and the
 * ratio that falls out of them.
 *
 * ⛔ NOTHING IS GUESSED, AND A MISSING PIECE IS NOT A ZERO. The server's own note says it: "a blank
 * field must never silently become a zero and produce a 0.00 ratio". Rent or a payment we cannot
 * work out means NO RATIO — the screen shows what is still needed instead of a confident number.
 * HOA is the one exception and only because the owner set it: it defaults to zero, because most
 * properties genuinely have none, and a blank there means none rather than unknown.
 *
 * Returns { pi, tax, insurance, hoa, pitia, dscr, missing[] } — `missing` names what is stopping
 * it, so the screen never has to guess why it is empty.
 */
export function dscrFrom(input) {
  const i = input || {};
  const hoa = nn(i.hoaMonthly) ? cents(i.hoaMonthly) : 0;   // owner-set default: zero
  const tax = nn(i.taxMonthly) ? cents(i.taxMonthly) : null;
  const insurance = nn(i.insuranceMonthly) ? cents(i.insuranceMonthly) : null;
  const rent = nn(i.rentMonthly) && i.rentMonthly > 0 ? cents(i.rentMonthly) : null;
  const pi = monthlyPI({
    loanAmount: i.loanAmount, ratePct: i.ratePct,
    termYears: i.termYears, interestOnly: !!i.interestOnly,
  });

  const missing = [];
  if (rent == null) missing.push('rent');
  if (pi == null) {
    // Name the piece that is ACTUALLY missing, in the order the payment needs them. Reporting
    // "rate" because the loan amount happens to be present would send somebody to a box that is
    // already filled in.
    if (!nn(i.loanAmount) || i.loanAmount <= 0) missing.push('loan amount');
    else if (!nn(i.ratePct) || i.ratePct < 0) missing.push('rate');
    else missing.push('loan term');
  }
  if (tax == null) missing.push('property tax');
  if (insurance == null) missing.push('insurance');

  if (missing.length) return { pi, tax, insurance, hoa, pitia: null, dscr: null, missing };

  // The denominator is rounded to cents FIRST, because on the loan file it is a currency field
  // (912) holding a settled amount, and the tenant's formula divides by that stored figure.
  const pitia = cents(pi + tax + insurance + hoa);
  if (pitia <= 0) return { pi, tax, insurance, hoa, pitia, dscr: null, missing: ['a payment above zero'] };
  return { pi, tax, insurance, hoa, pitia, dscr: Math.round((rent / pitia) * 100) / 100, missing: [] };
}
