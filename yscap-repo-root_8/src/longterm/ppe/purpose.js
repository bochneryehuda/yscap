'use strict';
/**
 * LT PPE — THE ONE PLACE A LOAN PURPOSE BECOMES AN ENGINE FACT (§2.84).
 *
 * ⛔ THE DEFECT THIS EXISTS FOR, MEASURED. Our rate sheet and our eligibility matrix both test the
 * purpose fact for the EXACT lowercase token `'cashout'` — `deephaven-dscr-sheet.js:200` compiles
 * `{fact:'purpose', op:'eq', value:'cashout'}`, and `deephaven-matrix.js:66` does
 * `String(purpose).toLowerCase() === 'cashout'`. Nothing normalized the fact on the way in, so every
 * other spelling of the same word priced as a PURCHASE, silently. Measured on the Deephaven DSCR
 * sheet at FICO 720 / 70% LTV / DSCR 1.10, coupon 6.125:
 *
 *     'cashout'           -> 99.000   dhvn_cashout_ge720_4 applied
 *     'Cash out'          -> 99.500   NO cash-out LLPA
 *     'Cash-Out'          -> 99.500   NO cash-out LLPA
 *     'CASHOUT'           -> 99.500   NO cash-out LLPA
 *     'CashoutRefinance'  -> 99.500   NO cash-out LLPA   <-- LENDER PRICE'S OWN TOKEN
 *
 * Half a point, every time, in the borrower's favour and against us. And it is not only price: at
 * 78% LTV / FICO 705 the cash-out cap is 75%, so `'cashout'` is correctly DECLINED while
 * `'CashoutRefinance'` comes back ELIGIBLE.
 *
 * ⛔ WHY A PRESENT-BUT-UNKNOWN VALUE IS THE DANGEROUS ONE. The engine already refuses to price when a
 * price-bearing fact is MISSING — measured: `purpose: null` and an absent purpose both yield
 * `unknownFacts: ['purpose']` and NO priced ladder. But `rules.js` evaluates a fact that is PRESENT as
 * knowable, so `purpose: 'zzz'` resolves `eq 'cashout'` to a determinate FALSE and prices happily.
 * The safety net catches the null and misses the typo. So an unrecognized purpose is normalized to
 * `null` HERE — converting a silent wrong answer into the refusal the engine already knows how to
 * give. That is the whole trick: this module does not add a guard, it makes the existing one reachable.
 *
 * ONE VOCABULARY, NOT TWO. The accepted spellings are the Lender Price connector's own
 * `PURPOSE_ALIASES` table (`lenderprice/search-model.js`), read live rather than copied, so a spelling
 * the vendor door accepts can never be one the engine silently mis-prices. The engine's own canonical
 * tokens (`purchase` / `refinance` / `cashout`) are added on top, because facts that have already been
 * normalized must round-trip unchanged.
 *
 * PURE: no I/O, no DB, no network. LT-only.
 */

const { _internals: lpModel } = require('../lenderprice/search-model');

// The engine's canonical vocabulary — what every rule predicate and every matrix comparison expects.
const PURCHASE = 'purchase';
const REFINANCE = 'refinance';
const CASHOUT = 'cashout';
const CANONICAL = [PURCHASE, REFINANCE, CASHOUT];

// Lender Price's normalized output -> our engine fact. `mapPurpose` answers one of exactly three
// strings, so this is total over its range and needs no fallback arm.
const FROM_LP = {
  Purchase: PURCHASE,
  Refinance: REFINANCE,
  CashoutRefinance: CASHOUT,
};

/**
 * Normalize ANY spelling of a loan purpose to the engine's canonical fact.
 *
 * Returns 'purchase' | 'refinance' | 'cashout', or **null** when the value is absent, empty, or a
 * spelling nobody has taught us. Null is deliberate and load-bearing: the engine reads a null
 * price-bearing fact as UNKNOWN and refuses to price, which is the correct answer to "I do not know
 * what kind of loan this is". It must never fall back to a purpose — that is the defect.
 */
function normalizePurpose(v) {
  if (v == null) return null;
  const key = lpModel.purposeKey(v);           // lowercase, letters only — the vendor door's own key
  if (!key) return null;                        // '' / '   ' / '---' are absent, not a purpose
  if (CANONICAL.includes(key)) return key;      // an already-normalized fact round-trips unchanged
  const lp = lpModel.PURPOSE_ALIASES[key];      // every spelling the vendor door accepts
  return lp ? FROM_LP[lp] : null;
}

/**
 * Return a COPY of `facts` whose `purpose` is canonical. Used at the engine doors so every caller —
 * the /quote route, /breakdown, the canary, the agreement run — is covered without any of them
 * needing to know this exists.
 *
 * The key is written back only when the facts actually carry one, so a scenario that never mentioned
 * a purpose is not handed an explicit `purpose: null` it did not have. Both read as unknown to the
 * engine, but only one of them is a claim.
 */
function withCanonicalPurpose(facts) {
  if (!facts || typeof facts !== 'object') return facts;
  if (!Object.prototype.hasOwnProperty.call(facts, 'purpose')) return facts;
  const norm = normalizePurpose(facts.purpose);
  if (norm === facts.purpose) return facts;     // already canonical — no copy, no churn
  return { ...facts, purpose: norm };
}

/** Did this value name a purpose we understand? Useful for reporting, never for control flow. */
function isKnownPurpose(v) { return normalizePurpose(v) !== null; }

module.exports = { normalizePurpose, withCanonicalPurpose, isKnownPurpose, CANONICAL, PURCHASE, REFINANCE, CASHOUT };
