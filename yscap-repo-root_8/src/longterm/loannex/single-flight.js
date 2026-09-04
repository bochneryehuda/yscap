'use strict';
/**
 * ONE CALL FOR THE CALLERS THAT ASK AT THE SAME MOMENT.
 *
 * PURE. No network, no config, no requires — so every rule here is unit-testable
 * and any of the three caches can hold it without a dependency of its own.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS ITS OWN FILE ────────────────────────────
 * It was written for the LOGIN (2026-09-03, the concurrent-login collision that
 * dropped the LoanNEX half of the general board): three bands priced at once,
 * three sign-ins, LoanNEX invalidated the first two and two thirds of the board
 * vanished with the reason swallowed.
 *
 * The SAME shape applies to the two lookups beside it — the field registry and a
 * state's county list — and they had no lock, so the general engine's first
 * search fetched each of them once per concurrent caller. This is one definition
 * rather than three copies, because three copies of a lock are how one of them
 * quietly stops locking.
 *
 * ⛔ THE SLOT IS CLEARED WHEN THE CALL SETTLES, SUCCESS OR FAILURE, and ONLY if
 * it is still ours — a later attempt that replaced it is never deleted. Holding a
 * rejected promise would make one bad minute permanent; deleting somebody else's
 * would let two calls run and defeat the whole thing.
 *
 * ⛔ AND THE CALLER'S OWN ERROR IS THE CALLER'S. Everyone awaiting one flight
 * shares its outcome, including its rejection — the alternative is a caller told
 * "someone else's call failed" about a call it never made.
 */

/**
 * Run `fn` once per `key`, however many callers ask while it is in flight.
 * `map` is the caller's own store, so two unrelated things keyed the same way
 * can never share a slot.
 */
function singleFlight(map, key, fn) {
  const existing = map.get(key);
  if (existing) return existing;
  const promise = Promise.resolve().then(fn);
  map.set(key, promise);
  const clear = () => { if (map.get(key) === promise) map.delete(key); };
  promise.then(clear, clear);
  return promise;
}

module.exports = { singleFlight };
