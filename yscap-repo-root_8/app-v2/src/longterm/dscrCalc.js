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
 * THE TOTAL MONTHLY HOUSING PAYMENT — principal, interest, taxes, insurance and association dues.
 *
 * This is the SAME figure the DSCR divides into (field 912, the "proposed total monthly housing
 * expense"), and `dscrFrom` below is built on it rather than repeating the sum — so the payment a
 * board column shows and the payment the ratio qualifies on are ONE number by construction. Two
 * copies would be two answers to "what does this cost a month" on one screen, and the one that
 * drifts is the one somebody quotes.
 *
 * It takes the P&I RATHER THAN COMPUTING IT, which is the whole reason it is separate: the pricing
 * board prints the VENDOR's own monthly P&I per quote, so a column built on a locally-recomputed
 * payment could differ from the P&I sitting one column to its left and the row would not add up.
 * Handed that vendor figure, the arithmetic on screen reconciles exactly.
 *
 * ⛔ NOTHING IS GUESSED. No P&I, no tax or no insurance means NO ANSWER — never a total that
 * silently treats a blank as zero and reads as a cheaper property than it is. HOA is the one
 * exception, and only because the owner set it that way for the ratio: blank means none.
 */
export function housingPayment({ pi, taxMonthly, insuranceMonthly, hoaMonthly }) {
  if (!nn(pi) || pi < 0) return null;
  if (!nn(taxMonthly) || taxMonthly < 0) return null;
  if (!nn(insuranceMonthly) || insuranceMonthly < 0) return null;
  const hoa = nn(hoaMonthly) && hoaMonthly > 0 ? hoaMonthly : 0;
  return cents(cents(pi) + cents(taxMonthly) + cents(insuranceMonthly) + cents(hoa));
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
/**
 * THE RATE TO WORK A PAYMENT OUT AT WHEN NOBODY HAS NAMED ONE (owner-directed 2026-09-01:
 * *"we shouldn't need to put in a target rate… If you don't have a targeted rate, go by the
 * average, which is how it's usually coming up."*).
 *
 * ⛔ A MIRROR OF THE SERVER'S OWN SEED, and it must stay one. The server picks the first DSCR
 * band to search from the same figure (`bracket-board.TYPICAL_RATE_PCT`), and a screen that
 * assumed a different rate from the one the search starts at would show a ratio the board then
 * disagreed with. `test-lt-target-rate-optional-pure.mjs` fails the moment the two defaults
 * differ. HONEST NOTE: the server's copy can be moved by `LP_BRACKET_SEED_RATE_PCT` and this one
 * cannot — the browser has no env. Setting that variable moves which band is searched FIRST and
 * not this assumed rate, which is safe (the frontier re-prices every band on its own true ratio)
 * but is a real asymmetry rather than a claim that the two can never differ.
 */
export const TYPICAL_RATE_PCT = 7.5;

export function dscrFrom(input) {
  const i = input || {};
  const hoa = nn(i.hoaMonthly) ? cents(i.hoaMonthly) : 0;   // owner-set default: zero
  const tax = nn(i.taxMonthly) ? cents(i.taxMonthly) : null;
  const insurance = nn(i.insuranceMonthly) ? cents(i.insuranceMonthly) : null;
  const rent = nn(i.rentMonthly) && i.rentMonthly > 0 ? cents(i.rentMonthly) : null;
  /* ⛔ A BLANK RATE IS ANSWERED, A BAD ONE IS STILL REFUSED, and the difference is the whole
     rule. NOTHING TYPED (blank, or nothing but spaces) is somebody who has not got a rate in
     mind — the owner's case — so the payment is worked out at the typical coupon and the answer
     SAYS it was assumed. A rate that IS typed but is junk or negative is not a missing rate, it
     is a wrong one: assuming past it would replace what they typed with a number they never
     chose and hide their mistake behind a confident ratio. So `rateAssumed` is only ever true
     where the box is genuinely empty. A typed rate ALWAYS wins, including a deliberate 0. */
  const rateTyped = nn(i.ratePct);
  const rateBlank = i.ratePct == null || i.ratePct === '' || (typeof i.ratePct === 'string' && i.ratePct.trim() === '');
  const rateAssumed = !rateTyped && rateBlank;
  const ratePctUsed = rateTyped ? i.ratePct : (rateAssumed ? TYPICAL_RATE_PCT : i.ratePct);
  const pi = monthlyPI({
    loanAmount: i.loanAmount, ratePct: ratePctUsed,
    termYears: i.termYears, interestOnly: !!i.interestOnly,
  });

  const missing = [];
  if (rent == null) missing.push('rent');
  if (pi == null) {
    // Name the piece that is ACTUALLY missing, in the order the payment needs them. Reporting
    // "rate" because the loan amount happens to be present would send somebody to a box that is
    // already filled in.
    if (!nn(i.loanAmount) || i.loanAmount <= 0) missing.push('loan amount');
    else if (!nn(ratePctUsed) || ratePctUsed < 0) missing.push('rate');
    else missing.push('loan term');
  }
  if (tax == null) missing.push('property tax');
  if (insurance == null) missing.push('insurance');

  if (missing.length) return { pi, tax, insurance, hoa, pitia: null, dscr: null, missing, rateAssumed: false, ratePctUsed: null };

  // The denominator is rounded to cents FIRST, because on the loan file it is a currency field
  // (912) holding a settled amount, and the tenant's formula divides by that stored figure.
  const pitia = housingPayment({ pi, taxMonthly: tax, insuranceMonthly: insurance, hoaMonthly: hoa });
  if (pitia <= 0) return { pi, tax, insurance, hoa, pitia, dscr: null, missing: ['a payment above zero'], rateAssumed: false, ratePctUsed: null };
  return { pi, tax, insurance, hoa, pitia, dscr: Math.round((rent / pitia) * 100) / 100, missing: [], rateAssumed, ratePctUsed };
}

/* ── DOES THIS FILE STILL QUALIFY FOR THE PRICE IT WAS QUOTED? ────────────────
   Owner-reported 2026-08-30: *"You allow the system to issue the term sheet even if the DSCR
   disagrees. If the scenario was 1.25 but the details that I'm entering to issue the term sheet
   are 1.2, it allows the system to issue the term sheet. This means we are giving him better
   pricing than we should have given him."*

   ⛔ THE TEST IS THE BRACKET, NOT THE NUMBER. The owner supplied the ladder himself on
   2026-08-31: *"So if anything is changing from one bracket to the next one, then it needs a
   reprice, but make sure it's very easy."* A DSCR bracket is a PRICE BAND, so two ratios inside
   one band buy the same price and must not send anybody back to re-price — an earlier cut
   compared the raw numbers and nagged on a 1.45 sheet issued at 1.42, which is the same money.

   ⛔ THE REFUSAL IS THE SERVER'S (`termsheet/snapshot.ratioProblem`), not this. This is the
   BROWSER'S COPY, and it exists only so the screen can say so before the button is pressed and
   offer the re-price. Two copies of one money rule is exactly the shape that drifts, so
   `test-lt-comparison-ux-pure` runs BOTH over every ratio from 0 to 2.00 in hundredths and fails
   the moment they disagree about any of them. Change one, change the other.

   ⛔ DIRECTION-AGNOSTIC, which is the owner's own rule. Downward is the money case. Upward means
   the borrower qualifies for BETTER pricing than the paper shows, which is also wrong to issue —
   so both re-price, and the wording says which way it went. */
export const DSCR_TIERS = [
  { tier: 1,  from: null, to: 0.50 },   // < 0.50 — very low
  { tier: 2,  from: 0.50, to: 0.75 },
  { tier: 3,  from: 0.75, to: 0.85 },
  { tier: 4,  from: 0.85, to: 1.00 },
  { tier: 5,  from: 1.00, to: 1.10 },
  { tier: 6,  from: 1.10, to: 1.15 },   // owner-added 2026-08-31: *"I missed one band up to 1.1"*
  { tier: 7,  from: 1.15, to: 1.25 },
  { tier: 8,  from: 1.25, to: 1.30 },
  { tier: 9,  from: 1.30, to: 1.40 },
  { tier: 10, from: 1.40, to: 1.50 },
  { tier: 11, from: 1.50, to: null },   // >= 1.50 — strongest
];

/* ⛔ THE LADDER MUST BE CONTIGUOUS AND MUST NOT OVERLAP, AND THAT IS CHECKED RATHER THAN TRUSTED.
   `dscrTier` returns the FIRST band a ratio falls in, so two bands that overlap are resolved
   silently by array order — a real hazard, found when a deliberate mutation of one boundary
   changed no behaviour at all because its neighbour still claimed the ratio. A ladder with a hole
   is worse still: a ratio in the gap gets no tier and the rule quietly stands down on a live loan.
   Verified once at load, so a bad edit fails loudly here instead of mispricing quietly. */
function assertLadder(tiers) {
  for (let i = 0; i < tiers.length; i += 1) {
    const t = tiers[i];
    const prev = tiers[i - 1];
    if (i === 0 && t.from !== null) throw new Error('DSCR ladder: the first band must be open below');
    if (i === tiers.length - 1 && t.to !== null) throw new Error('DSCR ladder: the last band must be open above');
    if (prev && prev.to !== t.from) {
      throw new Error(`DSCR ladder: tier ${prev.tier} ends at ${prev.to} but tier ${t.tier} starts at ${t.from}`);
    }
  }
  return tiers;
}
assertLadder(DSCR_TIERS);


/** Which tier a ratio sits in, or null when it is not a usable ratio. */
export function dscrTier(ratio) {
  const n = Number(ratio);
  if (!nn(n) || n <= 0) return null;
  const r = Math.round(n * 100) / 100;
  for (const t of DSCR_TIERS) {
    if ((t.from == null || r >= t.from) && (t.to == null || r < t.to)) return t.tier;
  }
  return null;
}

/**
 * @returns 'unknown' when either side is unusable, 'below' when the figures have dropped into a
 *          lower band than the price was bought in, 'above' when they have risen into a higher
 *          one, and 'ok' when they are still in the same band.
 */
export function ratioVerdict(computed, priced) {
  const c = dscrTier(computed);
  const p = dscrTier(priced);
  if (c == null || p == null) return 'unknown';
  if (c === p) return 'ok';
  return c < p ? 'below' : 'above';
}
