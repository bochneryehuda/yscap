/**
 * A JUDICIAL-STATE PURCHASE UNDER $100,000 IS AN EXCEPTION PRODUCT THAT NEEDS
 * $20,000 DOWN — STANDARD PROGRAM ONLY (owner-directed 2026-08-20).
 * PURE — no DB, no network.
 *
 *   "for any property that is in any jurisdictional state … This is only for the
 *    standard. It's not for the gold, and it's not for the silver, and it's not
 *    for the manual. Even if the loan amount is more than $100,000, if the
 *    property is in the jurisdictional state and the purchase price is less than
 *    $100,000, they don't want to do it … it should come up as an exception
 *    product … he needs to put down at least a $20,000 down payment. No matter
 *    what the purchase price is … They want to see skin in the game … but
 *    leverage doesn't change. The loan amount gets maybe lower … but then you can
 *    offer the entire budgets with all the same cap according to the experience."
 *
 * THE CLAIMS THIS FILE PROVES:
 *   A. IT REACHES NOTHING ELSE. Gold, Silver, every manual product, every
 *      non-judicial state, every purchase at or over $100,000 and every
 *      refinance are byte-identical to the engine without the rule.
 *   B. THE SKIN IS REAL. On a deal it reaches, the borrower's own money at the
 *      purchase is at least $20,000 — or the whole price when the price is
 *      itself under $20,000, which is all the equity that exists.
 *   C. LEVERAGE DOES NOT CHANGE. Every cap the tier grants — acquisition LTV,
 *      ARV LTV, loan-to-cost, the tier's dollar maximum — is untouched, and the
 *      construction budget is never financed any less than it was.
 *   D. IT CAN ONLY REDUCE. The initial advance and the total loan never grow.
 *   E. IT IS AN EXCEPTION, AND IT SAYS SO. Status MANUAL — which is what routes
 *      it to the super-admin escalation — with the $20,000 requirement stated in
 *      words for the term sheet, and the same requirement published as data.
 */
'use strict';

const { baselineEngines, liveEngines, shape, assertStripBit } = require('./lib/engine-baseline');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* NEUTRALIZED, NOT DELETED: the whole rule hangs off one price ceiling, and a
   ceiling of 0 is a test no purchase price can satisfy — so the guarded block
   never runs, `minDownPayment` is never set on the caps row, and no reason is
   raised. One line, one file, countable. `assertStripBit` proves it bit. */
const PRICE_MAX_LINE = /^ {2}var JUD_SMALL_PRICE_MAX = 100000;.*$/gm;
const ENGINES = ['standard-program', 'gold-standard', 'silver-program'];
const BASE = baselineEngines([
  { re: PRICE_MAX_LINE, expect: { 'standard-program': 1 }, with: '  var JUD_SMALL_PRICE_MAX = 0;' },
]);
const LIVE = liveEngines();

const MIN_DOWN = 20000;
const PRICE_MAX = 100000;
// The 22 judicial-foreclosure states this program already keeps, minus the two
// it refuses outright (IN / LA are on INELIGIBLE_STATES, so they never price).
const JUDICIAL = ['CT', 'DE', 'FL', 'IL', 'IA', 'KS', 'KY', 'ME', 'MD', 'MA', 'NE', 'NJ', 'NM', 'NY', 'ND', 'OH', 'PA', 'SC', 'VT', 'WI'];
const NON_JUDICIAL = ['TX', 'GA', 'AZ', 'NC', 'MI', 'TN', 'VA', 'CA'];

const ENGAGING = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ',
  propertyType: 'SFR (1 unit)', units: 1,
  purchasePrice: 80000, asIsValue: 80000, arv: 400000, rehabBudget: 150000,
  fico: 760, term: 12, irMonths: 0, expFlips: 10, expHolds: 10, expGround: 10,
};

console.log('0. the baseline is real');
assertStripBit(assert, BASE, LIVE, ENGAGING, ['standard-program'], 'JUD_SMALL_PRICE_MAX');

function scenarios() {
  const out = [];
  const states = JUDICIAL.concat(NON_JUDICIAL);
  for (const state of states) {
    for (const loanType of ['Purchase', 'Refinance']) {
      for (const strategy of ['Fix & Flip', 'Fix & Hold (BRRRR)', 'Ground-up Construction', 'Bridge / Stabilized']) {
        for (const purchasePrice of [15000, 20000, 45000, 99999, 100000, 100001, 250000, 800000]) {
          for (const rehabBudget of [0, 40000, 150000]) {
            for (const fico of [660, 740]) {
              for (const exp of [0, 5, 11]) {
                out.push({
                  loanType, strategy, state, propertyType: 'SFR (1 unit)', units: 1,
                  purchasePrice, asIsValue: purchasePrice,
                  arv: Math.max(250000, purchasePrice * 2 + rehabBudget * 2), rehabBudget,
                  fico, term: 12, irMonths: 0,
                  expFlips: exp, expHolds: exp, expGround: exp,
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}
const CASES = scenarios();
console.log(`\nscenario matrix: ${CASES.length} cases x 3 programs = ${CASES.length * 3} evaluations\n`);

// Should the rule reach this deal at all? Read straight off the owner's words,
// deliberately NOT off the engine — a test that re-used the engine's own
// predicate would agree with it however wrong it was.
const shouldApply = (c, engine) => engine === 'standard-program'
  && c.loanType === 'Purchase'
  && JUDICIAL.includes(c.state)
  && c.purchasePrice > 0 && c.purchasePrice < PRICE_MAX;

console.log('A. it reaches the Standard judicial sub-$100k purchase and nothing else');
{
  let priced = 0, applied = 0, drift = 0, wrongFire = 0, missedFire = 0;
  let firstDrift = null, firstWrong = null;
  for (const e of ENGINES) {
    for (const c of CASES) {
      const b = BASE[e].evaluate(c);
      const l = LIVE[e].evaluate(c);
      const ls = (l && l.sizing) || {};
      if (ls.totalLoan > 0) priced++;
      const fired = !!(l && l.judicialSmallPurchase);
      const want = shouldApply(c, e);
      // An INELIGIBLE / city-review deal returns before sizing, so the rule can
      // legitimately not fire there; only a deal that reached sizing counts.
      const reachedSizing = !!(l && l.caps);
      if (want && reachedSizing && !fired) { missedFire++; if (!firstWrong) firstWrong = { e, c, why: 'did not fire' }; }
      if (!want && fired) { wrongFire++; if (!firstWrong) firstWrong = { e, c, why: 'fired' }; }
      if (fired) { applied++; continue; }
      if (shape(b) !== shape(l)) { drift++; if (!firstDrift) firstDrift = { e, c, was: shape(b), now: shape(l) }; }
    }
  }
  assert(priced > CASES.length, `A0 the matrix is meaningful — ${priced} of ${CASES.length * 3} evaluations actually price`);
  assert(applied > 500, `A1 the rule is genuinely exercised — it applies on ${applied} evaluations`);
  assert(wrongFire === 0 && missedFire === 0,
    `A2 it fires on exactly the deals the owner described and no others (fired where it should not: ${wrongFire}, silent where it should: ${missedFire})`);
  if (firstWrong) console.log('    first:', firstWrong.why, JSON.stringify(firstWrong.c), firstWrong.e);
  assert(drift === 0,
    `A3 every OTHER deal — Gold, Silver, non-judicial, $100k and over, and every refinance — is byte-identical to the engine without the rule (drift: ${drift})`);
  if (firstDrift) console.log('    first drift:', JSON.stringify(firstDrift.c), '\n    was:', firstDrift.was, '\n    now:', firstDrift.now);
}

console.log('\nB-E. what it does to the deals it reaches');
{
  let n = 0, shortDown = 0, capsMoved = 0, budgetCut = 0, grew = 0, notManual = 0, silent = 0, noData = 0, badgeMute = 0;
  let firstBad = null;
  const REASON_RE = /^Exception product: a purchase under \$100,000 in .+, a judicial-foreclosure state\. It requires a minimum \$20,000 down payment/;
  // The badge on the staff panel shows only the first clause, so it has to say
  // something on its own — `shortReason` cuts at the first ' — ' then the first '. '.
  const badgeOf = (msg) => { let m = String(msg).split(' — ')[0].split('. ')[0].trim(); return m.length > 96 ? m.slice(0, 94).replace(/[\s,;:]+\S*$/, '') + '…' : m; };
  for (const c of CASES) {
    const l = LIVE['standard-program'].evaluate(c);
    if (!l || !l.judicialSmallPurchase) continue;
    const b = BASE['standard-program'].evaluate(c);
    const ls = l.sizing || {}, bs = b.sizing || {};
    n++;
    // B — the borrower's own money at the purchase. When the price is itself at
    // or under the floor, all of it is theirs and there is no initial advance.
    const wantDown = Math.min(MIN_DOWN, c.purchasePrice);
    if (!(ls.downPayment >= wantDown - 0.005)) { shortDown++; if (!firstBad) firstBad = { c, why: `down ${ls.downPayment} < ${wantDown}` }; }
    // C — leverage untouched, budget never financed less.
    if (JSON.stringify(b.caps.maxAcqLTV) !== JSON.stringify(l.caps.maxAcqLTV)
      || JSON.stringify(b.caps.maxARLTV) !== JSON.stringify(l.caps.maxARLTV)
      || JSON.stringify(b.caps.maxLTC) !== JSON.stringify(l.caps.maxLTC)
      || JSON.stringify(b.caps.maxLoan) !== JSON.stringify(l.caps.maxLoan)
      || b.tier !== l.tier) { capsMoved++; if (!firstBad) firstBad = { c, why: 'a cap or the tier moved' }; }
    if (ls.rehabLoan < bs.rehabLoan - 0.005) { budgetCut++; if (!firstBad) firstBad = { c, why: `budget financed fell ${bs.rehabLoan} -> ${ls.rehabLoan}` }; }
    // D — reduce only.
    if (ls.acquisition > bs.acquisition + 0.005 || ls.totalLoan > bs.totalLoan + 0.005) {
      grew++; if (!firstBad) firstBad = { c, why: `grew: initial ${bs.acquisition}->${ls.acquisition}, total ${bs.totalLoan}->${ls.totalLoan}` };
    }
    // E — it is an exception, it says so, and it publishes the requirement.
    if (l.status !== 'MANUAL') notManual++;
    const reason = (l.reasons || []).find((r) => r.level === 'MANUAL' && REASON_RE.test(r.msg));
    if (!reason) silent++;
    else if (!/judicial-foreclosure state/.test(badgeOf(reason.msg))) badgeMute++;
    const j = l.judicialSmallPurchase;
    if (!(j.minDown === MIN_DOWN && j.priceMax === PRICE_MAX && j.state === c.state)) noData++;
    if (!(ls.minDownPayment === MIN_DOWN)) noData++;
  }
  assert(n > 500 && shortDown === 0,
    `B1 all ${n} of them put at least $${MIN_DOWN.toLocaleString()} of the borrower's own money into the purchase — or the whole price when it is under that (short: ${shortDown})`);
  assert(capsMoved === 0,
    `C1 leverage does not change — the acquisition-LTV, ARV, loan-to-cost and dollar caps and the experience tier are identical to the engine without the rule (moved: ${capsMoved})`);
  assert(budgetCut === 0,
    `C2 the construction budget is never financed any less than it would have been (cut: ${budgetCut})`);
  assert(grew === 0,
    `D1 it can only ever REDUCE — no initial advance and no loan amount grew (${grew})`);
  assert(notManual === 0 && silent === 0,
    `E1 every one registers as an EXCEPTION product and states the $${MIN_DOWN.toLocaleString()} requirement in words for the term sheet (not MANUAL: ${notManual}, silent: ${silent})`);
  assert(badgeMute === 0,
    `E1b …and the panel BADGE, which shows only the reason's first clause, still names the reason rather than a bare label (mute: ${badgeMute})`);
  assert(noData === 0,
    `E2 the same requirement is published as data for every surface to read, never re-derived (bad: ${noData})`);
  if (firstBad) console.log('    first:', firstBad.why, JSON.stringify(firstBad.c));
}

console.log('\nF. the exclusions that are not in the matrix');
{
  // A MANUAL product prices on this same Standard engine, so "not for the
  // manual" has to be proven with the manual basis engaged.
  for (const [label, extra] of [
    ['manual LTC basis', { ovrLTC: 0.95 }],
    ['manual acquisition-LTV basis', { ovrAcqLTV: 0.95 }],
    ['manual ARV basis', { ovrARLTV: 0.80 }],
  ]) {
    const c = { ...ENGAGING, ...extra };
    const b = BASE['standard-program'].evaluate(c);
    const l = LIVE['standard-program'].evaluate(c);
    assert(!l.judicialSmallPurchase && shape(b) === shape(l),
      `F1 ${label}: a manual product is untouched — the admin set the basis, so a hidden extra floor must never overrule it`);
  }
  // An ASSIGNMENT is judged on the RECOGNIZED price the loan is actually sized
  // on, which is also the figure the down payment is measured against.
  const asg = {
    ...ENGAGING, isAssignment: true, purchasePrice: 95000, sellerPrice: 80000, asIsValue: 95000,
  };
  const l = LIVE['standard-program'].evaluate(asg);
  assert(!!l.judicialSmallPurchase && l.sizing.downPayment >= MIN_DOWN - 0.005,
    `F2 an assignment is judged on the recognized price ($${l.judicialSmallPurchase && l.judicialSmallPurchase.purchasePrice}) and still puts $${l.sizing.downPayment} down`);
  // The owner's headline case: the LOAN is well over $100,000 and it still applies.
  const big = { ...ENGAGING, purchasePrice: 90000, asIsValue: 90000, rehabBudget: 400000, arv: 900000 };
  const bl = LIVE['standard-program'].evaluate(big);
  assert(!!bl.judicialSmallPurchase && bl.sizing.totalLoan > 100000 && bl.status === 'MANUAL',
    `F3 "even if the loan amount is more than $100,000" — a $${bl.sizing.totalLoan.toLocaleString()} loan on a $90,000 purchase is still the exception product`);
  // And a price at exactly $100,000 is NOT under it.
  const edge = { ...ENGAGING, purchasePrice: PRICE_MAX, asIsValue: PRICE_MAX };
  assert(!LIVE['standard-program'].evaluate(edge).judicialSmallPurchase,
    'F4 a purchase price of exactly $100,000 is not "less than $100,000" — the rule does not apply');
}

console.log('\nG. the floor cannot be undone by another exception');
{
  /* FOUND BY ADVERSARIAL REVIEW, not by the matrix: `pricing.js normalize()`
     lets an approved out-of-pocket-rehab exception RAISE the initial advance
     back toward its acquisition-LTV ceiling, and that ceiling knew nothing about
     this rule — so "raise the initial to its max" would have lifted the initial
     straight over the $20,000 floor and silently undone the requirement the term
     sheet had just printed. normalize() now bounds the raise by EVERY ceiling on
     the initial advance, this one included. This section is a server-side check,
     so it runs the whole pricing wrapper rather than the engine alone. */
  const pricing = require('../src/lib/pricing');
  const exp = { flips: 10, holds: 0, ground: 0 };
  const file = (state) => ({
    fico: 760, term: 12, program: 'Fix and Flip', loan_type: 'Purchase',
    property_type: 'Single Family', units: 1, requested_exp_flips: 10,
    purchase_price: 80000, as_is_value: 80000, arv: 400000, rehab_budget: 150000,
    property_address: { state },
  });
  const price = (state, ov) => pricing.quoteProgram('standard', pricing.buildInputs(file(state), exp, ov)).sizing;
  const jud = price('NJ', {});
  const judMaxed = price('NJ', { oopRehabMax: true });
  const judAsked = price('NJ', { oopRehab: 50000 });
  assert(jud.downPayment === MIN_DOWN && jud.minDownPayment === MIN_DOWN,
    `G1 the server-side quote carries the floor through — $${jud.downPayment} down and the requirement published on the sizing`);
  assert(judMaxed.downPayment === MIN_DOWN && judAsked.downPayment === MIN_DOWN && judMaxed.maxOopRehab === 0,
    'G2 neither "raise the initial to its max" nor a typed out-of-pocket amount can lift the initial back over the floor — there is no headroom to give');
  // The control proves the bound is about THIS rule and did not just disable the
  // out-of-pocket exception for everybody.
  const tx = price('TX', {});
  const txMaxed = price('TX', { oopRehabMax: true });
  assert(txMaxed.maxOopRehab > 0 && txMaxed.initialAdvance > tx.initialAdvance && txMaxed.downPayment < tx.downPayment,
    `G3 CONTROL — the same deal in a non-judicial state still raises its initial with the exception ($${tx.initialAdvance} -> $${txMaxed.initialAdvance}), so the bound is this rule's and not a blanket one`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
