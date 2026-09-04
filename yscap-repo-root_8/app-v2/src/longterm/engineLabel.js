/**
 * WHICH ENGINE PRICED A ROW — the browser's copy of `src/longterm/pricing/engine-label.js`.
 *
 * The portal cannot require server code (the `lib/payoff.js` arrangement), so the
 * registry is mirrored here — and `scripts/test-lt-engine-stamp-pure.js` reads BOTH
 * files and fails the moment they disagree, because a screen naming an engine the
 * server does not carry, or missing one it does, is exactly the wrong-attribution
 * this exists to prevent.
 *
 * ⛔ AN UNKNOWN KEY IS NEVER GUESSED — `labelFor` answers null and the caller draws
 * nothing. Adding an engine is one entry HERE and one in the server's registry.
 */
export const ENGINES = {
  lenderprice: { key: 'lenderprice', label: 'Lender Price' },
  loannex: { key: 'loannex', label: 'LoanNEX' },
};

export const UNKNOWN_SUBJECT = 'the rate sheet that quoted this loan';

export function engineKey(v) {
  const k = String(v == null ? '' : v).trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(ENGINES, k) ? k : null;
}

export function labelFor(v) {
  const k = engineKey(v);
  return k ? ENGINES[k].label : null;
}

/** The label, or the vendor-neutral phrase — for a sentence that must have a subject. */
export function subjectFor(v) {
  return labelFor(v) || UNKNOWN_SUBJECT;
}
