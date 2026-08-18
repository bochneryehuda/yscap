'use strict';
/**
 * LT PPE — the LOAN OFFICER COMPENSATION STACK (D18 / E9). PURE: no DB, no network, no config reads.
 * A resolved plan (the company's numbers plus the officer's own), a loan amount and a mode go in; who
 * makes what on this file comes out — together with a list of the things nobody has decided yet, which
 * this module refuses to invent.
 *
 * THE OWNER'S WORDS THIS IS BUILT FROM.
 *   2026-08-17: "the 0.25 company holdback is non-overridable… the LO's default margin is 2.00, made
 *   two ways — price at par plus a 2-point origination, or zero origination and price at 102 — and
 *   every LO sets his own front/back split… a minimum and a maximum in dollars per loan… the split is
 *   on the origination."
 *   2026-08-18, answering the two questions that were holding the build: *"Company default: the
 *   minimum is not enforced. It's not a hard rule. It's a movable default, and every loan officer can
 *   set this movable default differently. The split does not apply for the margin. The entire margin
 *   hold back goes for the company."*
 *
 * WHAT THOSE TWO SENTENCES SETTLE, AND THEREFORE WHAT IS ENFORCED HERE.
 *   1. THE COMPANY MINIMUM IS A DEFAULT, NOT A FLOOR. An officer's own minimum simply REPLACES the
 *      company's — it may be lower, and nothing here refuses it. There is deliberately no "the
 *      officer's minimum must be at least the company's" check anywhere in this file: writing one
 *      would be exactly the hard rule the owner said this is not.
 *   2. THE HOLDBACK IS THE COMPANY'S, WHOLE. It is never split, never clamped by the officer's
 *      minimum or maximum, and never counted as part of what the officer earned. Those are three
 *      separate places it could have leaked into his side of the ledger, and each is asserted.
 *
 * WHAT IT WILL NOT DO, BECAUSE NOBODY HAS SAID (and a money rule is never guessed — CLAUDE.md):
 *   · IT DOES NOT TOUCH THE PRICE. Whether the 0.25 holdback is the SAME cut the pipeline already
 *     subtracts as `pricing.correspondent_margin_milli` or a SECOND 0.25 on top of it is open
 *     (COMPENSATION-MARGIN-MODEL.md question 5), and the two answers differ by a quarter point on
 *     every loan. `holdbackMilli` stays carried-not-applied exactly as `quote.js` carries it today.
 *   · WHEN A CLAMP BINDS ON A SPLIT PLAN IT REFUSES TO SAY WHERE THE MONEY MOVED. If the officer
 *     earns on ONE side only, arithmetic decides it — all of his comp is that side, so the whole
 *     adjustment lands there and there is nothing to choose. If he earns on BOTH sides, whether the
 *     bump comes out of the origination or the rebate is a decision (question 3), so the TOTAL is
 *     reported and the front/back split comes back null with the reason. A number invented here would
 *     be printed on a loan officer's own pay figure.
 *
 * EVERYTHING IS INTEGER. Milli-points for points (250 = 0.250 point, the unit the whole PPE speaks)
 * and integer CENTS for money. No floats anywhere in the stack.
 *
 * LT-only. No RTL imports.
 */

// The two ways an officer's compensation can be paid, in Lender Price's own vocabulary.
const MODES = ['borrower_paid', 'lender_paid'];

// What the company's share of the split is taken from. `front_only` is the recorded reading of the
// owner's "the split does not apply for the margin" plus the standing "comp on origination only" —
// the company takes its share of the ORIGINATION and nothing else. It is a stated policy rather than
// a constant precisely so that, if the owner meant something else, ONE value moves.
const SPLIT_BASES = ['front_only', 'front_and_back'];

function int(v) {
  return (typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)) ? v : null;
}
function nonNegInt(v) { const n = int(v); return n == null || n < 0 ? null : n; }

/** Milli-points → cents at a loan size. 1000 milli = 1 point = 1% of the loan. */
function centsOfMilli(milli, loanCents) {
  const m = int(milli); const l = nonNegInt(loanCents);
  if (m == null || l == null || l === 0) return null;
  return Math.round((m * l) / 100000);
}

/** Cents → milli-points at a loan size. The inverse of the above, and the min/max conversion. */
function milliOfCents(cents, loanCents) {
  const c = nonNegInt(cents); const l = nonNegInt(loanCents);
  if (c == null || l == null || l === 0) return null;
  return Math.round((c * 100000) / l);
}

/**
 * Work out this file's compensation.
 *
 *   plan — the resolved numbers (see `store.resolveCompPlanForOfficer`, which layers officer over
 *          company over the coded default):
 *          { companyHoldbackMilli, officerMarginMilli, officerFrontMilli, officerBackMilli,
 *            minCents, maxCents, splitPct, splitBasis, mode }
 *   opts — { loanAmountCents }
 *
 * Returns { ok, mode, loanAmountCents, holdback, officer, company, clamp, unsettled[], refusals[] }.
 * NEVER throws: an unusable plan comes back `ok:false` with the reason, because a compensation figure
 * that quietly resolves to zero is worse than one that says it could not be worked out.
 */
function computeComp(planIn = {}, optsIn = {}) {
  // A default parameter only fires on `undefined`, so an explicit null would reach every read below
  // and throw — the one way this module could break the promise in its own header.
  const plan = (planIn && typeof planIn === 'object') ? planIn : {};
  const opts = (optsIn && typeof optsIn === 'object') ? optsIn : {};
  const refusals = [];
  const unsettled = [];
  const loanCents = nonNegInt(opts.loanAmountCents);
  const mode = MODES.includes(plan.mode) ? plan.mode : null;

  if (loanCents == null || loanCents === 0) {
    refusals.push({ code: 'no_loan_amount', message: 'There is no loan amount, so nobody can be told what they earn on it.' });
  }
  if (!mode) {
    refusals.push({ code: 'no_mode', message: 'Nobody has said whether this is paid by the borrower or by the lender, and the two pay the officer differently.' });
  }

  // THE HOLDBACK IS THE COMPANY'S AND IT IS NOT AN OFFICER'S TO MOVE. The resolver simply never passes
  // the officer layer for it; this is the second lock, and it REFUSES rather than silently ignoring —
  // a plan that carries an officer-set holdback is a plan built by code that misunderstands the rule,
  // and quietly using the company value would hide that.
  if (plan.holdbackSource === 'officer') {
    refusals.push({
      code: 'holdback_not_the_officers',
      message: 'The margin holdback is the company\'s and a loan officer cannot set it. This plan carries one that an officer set.',
    });
  }

  const holdbackMilli = nonNegInt(plan.companyHoldbackMilli);
  if (holdbackMilli == null) {
    refusals.push({ code: 'no_holdback', message: 'The company holdback could not be read, and it is never assumed to be zero.' });
  }

  const baseMarginMilli = nonNegInt(plan.officerMarginMilli);
  if (baseMarginMilli == null) {
    refusals.push({ code: 'no_officer_margin', message: 'The officer\'s own margin could not be read.' });
  }

  const splitPct = int(plan.splitPct);
  if (splitPct == null || splitPct < 0 || splitPct > 100) {
    refusals.push({ code: 'no_split', message: 'The officer\'s share of the compensation could not be read as a percentage between 0 and 100.' });
  }
  const splitBasis = SPLIT_BASES.includes(plan.splitBasis) ? plan.splitBasis : null;
  if (!splitBasis) {
    refusals.push({
      code: 'no_split_basis',
      message: 'Nobody has said what the company\'s share is taken from, and the holdback is never part of it.',
    });
  }

  if (refusals.length) return { ok: false, refusals, unsettled, mode, loanAmountCents: loanCents };

  // ---- the officer's own front / back, as they stand before any clamp ------------------------
  //
  // In a single-sided mode the arithmetic already answers it: borrower-paid means the officer is paid
  // by an origination charge (front), lender-paid means he is paid out of the rebate (back). A plan
  // that states both is a deliberate mixed split ("0.25 in the back and 2 points origination") and is
  // honoured as given.
  let frontMilli = nonNegInt(plan.officerFrontMilli);
  let backMilli = nonNegInt(plan.officerBackMilli);
  if (frontMilli == null || backMilli == null) {
    frontMilli = mode === 'borrower_paid' ? baseMarginMilli : 0;
    backMilli = mode === 'borrower_paid' ? 0 : baseMarginMilli;
  }
  // FRONT + BACK MUST RECONCILE TO THE MARGIN. Two figures that do not add up are a mis-configuration,
  // and the safe reading of "he earns 2.000, of which 1.000 front and 0.250 back" is not obvious — so
  // it is refused rather than repaired.
  if (frontMilli + backMilli !== baseMarginMilli) {
    return {
      ok: false, mode, loanAmountCents: loanCents, unsettled,
      refusals: [{
        code: 'front_back_mismatch',
        message: `The officer's front (${frontMilli}) and back (${backMilli}) do not add up to his margin (${baseMarginMilli}).`,
      }],
    };
  }

  // ---- the minimum and the maximum, which are DOLLARS and are DEFAULTS ------------------------
  //
  // The owner's own worked examples: a $3,000 minimum on a $100,000 loan is 3 points, not the standard
  // 2; a $50,000 maximum on a $5,000,000 loan is 1 point. Neither is a company rule an officer cannot
  // move — "it's a movable default, and every loan officer can set this movable default differently"
  // — so whatever reached this plan is simply used, and there is no floor check anywhere below.
  //
  // AND NEITHER TOUCHES THE HOLDBACK. The question they answer is what the OFFICER earns; the
  // company's quarter point is not his and is not counted toward his floor or his ceiling.
  const minCents = nonNegInt(plan.minCents);
  const maxCents = nonNegInt(plan.maxCents);
  const minMilli = minCents == null ? null : milliOfCents(minCents, loanCents);
  const maxMilli = maxCents == null ? null : milliOfCents(maxCents, loanCents);

  let marginMilli = baseMarginMilli;
  let clampKind = null;
  if (minMilli != null && marginMilli < minMilli) { marginMilli = minMilli; clampKind = 'minimum'; }
  if (maxMilli != null && marginMilli > maxMilli) { marginMilli = maxMilli; clampKind = 'maximum'; }
  const clampDeltaMilli = marginMilli - baseMarginMilli;

  // ---- where a clamp lands, and where it is refused ------------------------------------------
  let outFront = frontMilli;
  let outBack = backMilli;
  let allocation = 'unchanged';
  if (clampDeltaMilli !== 0) {
    const bothSides = frontMilli > 0 && backMilli > 0;
    if (bothSides) {
      // A DECISION NOBODY HAS MADE. The total is still exact and is reported; the two halves are not
      // invented. See the header and COMPENSATION-MARGIN-MODEL.md question 3.
      outFront = null; outBack = null; allocation = 'unsettled';
      unsettled.push({
        code: 'clamp_allocation',
        message: 'This officer earns on both sides, and nobody has said whether the adjustment comes out of the origination or the rebate. The total is exact; the split between the two is not shown.',
      });
    } else if (backMilli > 0 || (frontMilli === 0 && mode === 'lender_paid')) {
      outFront = 0; outBack = marginMilli; allocation = 'back';
    } else {
      outFront = marginMilli; outBack = 0; allocation = 'front';
    }
  }

  // ---- the money ------------------------------------------------------------------------------
  const holdbackCents = centsOfMilli(holdbackMilli, loanCents);
  const officerGrossCents = centsOfMilli(marginMilli, loanCents);
  const frontCents = outFront == null ? null : centsOfMilli(outFront, loanCents);
  const backCents = outBack == null ? null : centsOfMilli(outBack, loanCents);

  // THE SPLIT IS TAKEN FROM THE STATED BASIS AND NEVER FROM THE HOLDBACK. On `front_only` the officer
  // keeps every cent of anything he earned in the back — which is the recorded reading of the owner's
  // instruction that the split is on the origination — and on a plan whose front figure is unknown
  // (the clamp case above) the split cannot be computed at all rather than being computed off the
  // wrong base.
  let splitBaseCents = null;
  if (splitBasis === 'front_and_back') splitBaseCents = officerGrossCents;
  else splitBaseCents = frontCents;

  let officerNetCents = null;
  let companyShareOfCompCents = null;
  if (splitBaseCents == null) {
    unsettled.push({
      code: 'split_not_computable',
      message: 'The origination figure is not settled on this file, so the officer\'s share of it cannot be worked out either.',
    });
  } else {
    companyShareOfCompCents = Math.round((splitBaseCents * (100 - splitPct)) / 100);
    const officerShareOfBase = splitBaseCents - companyShareOfCompCents;
    const keptWhole = officerGrossCents - splitBaseCents;   // anything outside the split basis is his
    officerNetCents = officerShareOfBase + keptWhole;
  }

  return {
    ok: true,
    mode,
    loanAmountCents: loanCents,
    // THE COMPANY'S QUARTER POINT, ON ITS OWN LINE AND NEVER FOLDED INTO ANYTHING ELSE.
    holdback: {
      milli: holdbackMilli,
      cents: holdbackCents,
      split: false,
      clamped: false,
      note: 'The margin holdback is the company\'s in full — it is never split with the officer and never counted toward his minimum or maximum.',
    },
    officer: {
      baseMarginMilli,
      marginMilli,
      frontMilli: outFront,
      backMilli: outBack,
      grossCents: officerGrossCents,
      frontCents,
      backCents,
      splitPct,
      splitBasis,
      netCents: officerNetCents,
    },
    company: {
      holdbackCents,
      shareOfCompCents: companyShareOfCompCents,
      // Null rather than a partial total: "the company made X" with half the arithmetic missing is
      // the confident wrong answer this module exists to avoid.
      totalCents: companyShareOfCompCents == null ? null : holdbackCents + companyShareOfCompCents,
    },
    clamp: {
      applied: clampKind,
      minCents, maxCents, minMilli, maxMilli,
      deltaMilli: clampDeltaMilli,
      allocation,
      // Said out loud on every answer: the clamp is about the officer's own earnings.
      touchesHoldback: false,
    },
    unsettled,
    // WHAT THIS DELIBERATELY DOES NOT DO, carried on the answer so a caller cannot mistake the
    // absence for zero: it never moves the price.
    priceEffect: {
      applied: false,
      reason: 'Whether the company holdback is the same quarter point the pipeline already subtracts, or a second one on top of it, is not settled — so nothing here changes a price.',
    },
  };
}

module.exports = {
  computeComp,
  MODES,
  SPLIT_BASES,
  _internals: { centsOfMilli, milliOfCents },
};
