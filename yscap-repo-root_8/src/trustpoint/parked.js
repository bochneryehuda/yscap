'use strict';
/**
 * IS THE TRUSTPOINT INTEGRATION PARKED? — the ONE definition, asked by every surface
 * (owner-directed 2026-08-24: "park and disable, for now, the entire TrustPoint integration
 * and the TrustPoint screen from our Draw section … It's not telling the truth").
 *
 * WHY PARKED RATHER THAN DELETED. The owner's word was "park", and "for now" — the same
 * treatment V1 has: kept, never deleted, reachable again by one setting. Ripping the
 * integration out would violate the standing rule that nothing is removed until nothing
 * depends on it, and would make coming back a rebuild rather than a switch.
 *
 * WHY IT DEFAULTS TO PARKED, which is the unusual half. `TRUSTPOINT_ENABLED` already
 * existed and is now 0 in production — but that switch is resolved through
 * `lib/flags`, where a row in `integration_flags` OVERRIDES the environment:
 *
 *     enabled(key, envDefault) → overrides.has(key) ? overrides.get(key) : envDefault
 *
 * So an override somebody set from the API Health page months ago would silently outrank
 * the environment and keep the integration live. That override cannot be read without a
 * staff login, so "TRUSTPOINT_ENABLED=0" alone is NOT proof the integration is off.
 * Parking therefore defaults ON and is deliberately UNCONDITIONAL — it is a statement
 * about the integration, not a per-run toggle, so it beats both the environment switch
 * and any stored override. That is the whole point of parking: one thing to check, and it
 * cannot be half-on.
 *
 * UN-PARKING IS ONE VARIABLE: TRUSTPOINT_PARKED=0. It is read at CALL time, never captured
 * at load, so a restart applies it and nothing caches a stale answer.
 *
 * WHAT PARKING DELIBERATELY DOES **NOT** TOUCH — and this is the requirement, not a
 * side effect. A Blue Lake draw must still raise the coordinator's "enter it in TrustPoint"
 * task and its email, and the coordinator must still be able to type the approved amounts
 * and record the release by hand. That path is `sitewire/trustpoint-intake.js`, which
 * never loads the TrustPoint client and runs off the SITEWIRE reconcile — so it is
 * untouched by everything here, and a test pins that it stays that way.
 *
 * PURE: no database, no config, no requires — so any gated rule can be unit-tested with
 * nothing else loaded, and a parked check can never itself throw.
 */

// Spelled out rather than `!== '0'` so an operator typing "false" or "off" is not
// surprised into an un-park. Anything unrecognised leaves it PARKED — the safe direction
// while the owner's position is that this integration is not telling the truth.
const UNPARK = new Set(['0', 'false', 'no', 'off']);

/**
 * @param {object} [env] injectable for tests; defaults to the live environment.
 * @returns {boolean} true when the whole TrustPoint integration is mothballed.
 */
function isParked(env) {
  const src = env || process.env;
  const raw = src.TRUSTPOINT_PARKED;
  if (raw == null) return true;                       // unset → PARKED
  return !UNPARK.has(String(raw).trim().toLowerCase());
}

// What every refusing surface says, so the screen, the API and the logs word it identically.
const PARKED_REASON =
  'The TrustPoint integration is parked. Blue Lake draws are entered in TrustPoint by the '
  + 'draw coordinator, and the approved amounts and the release are recorded here by hand.';

module.exports = { isParked, PARKED_REASON, _internals: { UNPARK } };
