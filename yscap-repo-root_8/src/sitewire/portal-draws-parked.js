'use strict';
/**
 * IS THE PORTAL DRAW COMPOSER PARKED? — the ONE definition, asked by every
 * compose surface (owner-directed 2026-08-26: "According to our compliance, we
 * are parking the option for portal draw requests … We're not deleting it,
 * we're parking it. Physical inspections will also need to go through Sitewire.
 * … we shouldn't be able to order it on our portal, and the borrower shouldn't
 * be able to submit it on their portal. The only way that draw requests can
 * come in should be through Sitewire for now.").
 *
 * WHY PARKED RATHER THAN DELETED — the owner's own word, and the same
 * treatment TrustPoint got on 2026-08-24 (src/trustpoint/parked.js is the house
 * pattern this file copies): kept, never deleted, reachable again by one
 * setting. WHY IT DEFAULTS TO PARKED AND IS UNCONDITIONAL: a park is a
 * statement about the feature, not a per-run toggle, so it must beat both an
 * environment switch and any stored `integration_flags` override an admin set
 * months ago — one thing to check, and it cannot be half-on.
 *
 * UN-PARKING IS ONE VARIABLE: PORTAL_DRAW_COMPOSER_PARKED=0. Read at CALL
 * time, never captured at load.
 *
 * WHAT PARKING DELIBERATELY DOES **NOT** TOUCH — and this is the requirement:
 *   · THE SITEWIRE INTAKE — the whole point. A draw the borrower submits in
 *     Sitewire's own app still mirrors in (sitewire/reconcile.js), still raises
 *     the TrustPoint hand-entry task on a Blue Lake file, and still auto-orders
 *     the Trinity physical inspection (trinity/intake.maybeOrderFromSitewire)
 *     once that connection is on.
 *   · IN-FLIGHT portal requests: the desk levers — record the decision, cancel,
 *     close out into Sitewire, approve-trinity — stay live, or the open
 *     `portal_draw_requests` rows (one open per file, db/299) would wedge their
 *     files forever.
 *   · The borrower Dashboard "Request a draw" SETUP button (borrower.js
 *     request-draw): it creates no draw request — it opens the Sitewire
 *     integration for the file, i.e. it IS the door into the only intake left.
 *
 * PURE: no database, no config, no requires — a parked check can never throw.
 */

// Spelled out rather than `!== '0'` so an operator typing "false" or "off" is
// not surprised into an un-park. Anything unrecognised leaves it PARKED.
const UNPARK = new Set(['0', 'false', 'no', 'off']);

/**
 * @param {object} [env] injectable for tests; defaults to the live environment.
 * @returns {boolean} true when the portal draw composer (staff + borrower) is parked.
 */
function isParked(env) {
  const src = env || process.env;
  const raw = src.PORTAL_DRAW_COMPOSER_PARKED;
  if (raw == null) return true;                       // unset → PARKED
  return !UNPARK.has(String(raw).trim().toLowerCase());
}

// What every refusing surface says, so the screen, the API and the logs word it
// identically. Borrower-safe: Sitewire is the construction portal the borrower
// already signs into, so naming it is the instruction, not a leak.
const PARKED_REASON =
  'Draw requests are submitted through the Sitewire construction portal for now — '
  + 'the request composer here is parked (compliance). Requests already in progress '
  + 'continue as normal.';

module.exports = { isParked, PARKED_REASON, _internals: { UNPARK } };
