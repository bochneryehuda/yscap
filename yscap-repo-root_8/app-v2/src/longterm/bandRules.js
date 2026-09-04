/**
 * WHAT THE BAND BOARD NEEDS, AND WHETHER IT IS GOING TO RUN — the three rules the two
 * doors of one press both turn on, in plain JavaScript so CI can RUN them.
 *
 * ⛔ WHY THEY ARE NOT IN THE SCREEN ANY MORE. They decide something with a real cost: the
 * immediate door tells the server `bandsFollow: true` — "do not count this press and do
 * not file its misses, the band door is about to" — and if that answer is wrong, nothing
 * records the press at all and the super admin is never told a rate sheet did not carry
 * a switched investor. While they lived in a `.jsx` module no CI job could load them (no
 * CI job installs the front end's build tools), so every guard on them was a regex over
 * their source — and the re-audit of 2026-09-03 walked straight past that: a
 * `bandsWillFollow` returning TRUE unconditionally, while still calling `bracketMissing`
 * so the regexes matched, was green across the WHOLE chain. This is the same move
 * `priceBuild.js` and `dscrCalc.js` already made, for the same reason.
 *
 * (That sentence used to say "all 204 suites". A count nobody can re-derive is a claim,
 * not a measurement — and the chain has been a different size at every commit since, so
 * the number said nothing while reading like evidence. Seven other files carrying it were
 * corrected on 2026-09-04; the re-audit found this eighth. What matters is that the guard
 * was a REGEX over a module CI could not load, and that is now said without a number.)
 *
 * The screen re-exports all three, so nothing that imported them from there had to move.
 */
import { toNumber } from './scenarioFields.js';
import { perMonth } from './dscrCalc.js';

/**
 * THE FIGURES A DSCR BAND IS WORKED OUT FROM, and what is still missing.
 *
 * ⛔ PURE, AND MODULE-LEVEL ON PURPOSE. The band searches are fired from inside the
 * Search press, where the component's own derived values are the PREVIOUS render's —
 * `loanAmount` in particular is partly derived from the last response. Reading them
 * there would band the new board on the old deal's figures. So everything is passed
 * in, and the loan amount comes from the answer the vendor just gave (its own echo)
 * before anything the form holds.
 *
 * ⛔ TAX AND INSURANCE GO THROUGH `perMonth`, NEVER RAW. Both boxes carry a
 * monthly/yearly switch beside them, so the raw number can be a yearly bill — a
 * payment twelve times too high, and a band wrong on every row.
 */
export function bracketFigures({ f, calc, effectiveScenario }) {
  const eff = effectiveScenario && toNumber(effectiveScenario.loanAmount);
  const typed = toNumber(f && f.loan);
  return {
    loanAmount: eff != null && eff > 0 ? eff : (typed != null && typed > 0 ? typed : null),
    termYears: toNumber(f && f.termYears),
    interestOnly: !!(f && f.io),
    rentMonthly: perMonth(toNumber(calc && calc.rent), 'monthly'),
    taxMonthly: perMonth(toNumber(calc && calc.tax), calc && calc.taxBasis),
    insuranceMonthly: perMonth(toNumber(calc && calc.insurance), calc && calc.insBasis),
    hoaMonthly: calc && calc.hoa === '' ? 0 : perMonth(toNumber(calc && calc.hoa), 'monthly'),
  };
}

/**
 * WHAT THE BAND BOARD IS STILL MISSING, in the words of the boxes it comes from.
 *
 * ⛔ NOT `dscrFrom`'s LIST. That answers "can we show a ratio for THIS rate", so with
 * no rate chosen it reports the RATE as missing — nonsense advice here, because the
 * band board's whole job is to find the rates. This mirrors the server's own
 * `readFigures` rule instead: the property's figures plus the loan, and a term only
 * when the payment amortises (an interest-only payment never uses one).
 */
export function bracketMissing(fig) {
  const need = [];
  if (!(fig.rentMonthly > 0)) need.push('monthly rent');
  if (fig.taxMonthly == null) need.push('property tax');
  if (fig.insuranceMonthly == null) need.push('insurance');
  if (!(fig.loanAmount > 0)) need.push('loan amount');
  if (!fig.interestOnly && !(fig.termYears > 0)) need.push('loan term');
  return need;
}

/**
 * WILL THE BAND DOOR RUN ON THIS PRESS? — asked BEFORE the immediate call, and
 * deliberately conservative.
 *
 * ⛔ ONE PRESS IS ONE SEARCH, AND THE SERVER CANNOT KNOW THAT ON ITS OWN. `run()` fires
 * the immediate board and then the band board, and since #1436 both record what the
 * sheets said. Recorded as two searches, one press files a miss the band door is about to
 * disprove, doubles the reviewer's hit count, and locks a source button out on half the
 * evidence `NEVER_AFTER_SEARCHES` was set to demand. So this screen — the only thing that
 * knows both calls belong to one press — tells the server, and `search-record` records the
 * first door as part of a larger search.
 *
 * ⛔ IT IS ASKED WITHOUT `effectiveScenario`, WHICH IS WHY IT IS SAFE. That value arrives
 * only WITH the answer, and all it can do is supply a loan amount the form left blank —
 * so a `true` here is never wrong (complete before can only stay complete after), while a
 * `false` on a deal whose loan the vendor filled in simply records both doors in full,
 * which is the behaviour today. `runBrackets` refuses the same way on the same rule, so
 * this and the early return there cannot disagree.
 */
export function bandsWillFollow({ f, calc }) {
  return bracketMissing(bracketFigures({ f, calc, effectiveScenario: null })).length === 0;
}
