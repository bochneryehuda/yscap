'use strict';
/**
 * GOLD DOES NOT LEND TO AN INDIVIDUAL — the one definition, OUTSIDE the frozen
 * engines (owner-directed 2026-08-02, in their own words: registration into Gold
 * must be REFUSED when vesting is individual, "because the gold program does not
 * allow individual", with the message that you must switch to an LLC and enter an
 * LLC name).
 *
 * WHY THIS IS NOT A CHANGE TO gold-standard.js. The rule is ALREADY WRITTEN there
 * and has always been dark:
 *
 *     var vest = String(input.vesting || input.borrowerType || input.borrowerEntity || "").toLowerCase();
 *     if (vest && /individual|person|natural|sole propriet/.test(vest))
 *       add("INELIGIBLE", "Loans must be originated to a legally formed entity …");
 *
 * Nothing has ever populated `input.vesting`, so the branch has never fired. The
 * tempting fix — start feeding it — is exactly the fix that is not allowed: the
 * frozen engines may not have their behaviour altered without written
 * authorization for that specific change, and switching a dormant INELIGIBLE
 * branch on would change the status of live files priced under today's rules. The
 * owner authorized the REFUSAL, not a rewrite of the engine.
 *
 * So the refusal lives here, on top, and the engines are untouched: not one
 * number, not one formula, not one input. This module is pure — no database, no
 * requires — so it can be unit-tested exactly and can never throw into a
 * registration.
 *
 * SCOPE, deliberately narrow: GOLD only. Standard, Silver and a Manual product
 * are unaffected — the owner named Gold, and refusing more than was asked for
 * would block deals that are perfectly fine today.
 */

/* Is the file vesting in an individual's name? A LINKED ENTITY ALWAYS WINS —
   an LLC on the file means it vests in that LLC whatever a stale flag says, which
   is the same precedence the conditions engine and the vesting route already use.
   Anything unreadable is NOT individual: this gates a registration, and refusing
   a deal on a value we could not read would be the expensive mistake. */
function vestsInIndividual(app) {
  const a = app || {};
  if (a.llc_id) return false;
  return a.personal_name_purchase === true;
}

/* Which program is being registered. Reads the same shapes the register doors
   already carry — the requested program, an override, or the engine's own label. */
function programKey(program) {
  const s = String(program || '').trim().toLowerCase();
  if (!s) return null;
  if (/gold/.test(s)) return 'gold';
  if (/silver/.test(s)) return 'silver';
  if (/manual|custom/.test(s)) return 'manual';
  if (/standard/.test(s)) return 'standard';
  return s;
}

/** The owner's own words, so every door says the same thing. */
const GOLD_INDIVIDUAL_REFUSAL =
  'The Gold Standard program does not allow a loan in an individual\'s name. '
  + 'Switch this file to an LLC and enter the LLC name to register it into Gold, '
  + 'or register it into a different program.';

/**
 * Should this registration be refused?
 * PURE. Returns a plain reason string, or null when there is nothing to refuse.
 *
 * @param app      the application row (needs personal_name_purchase + llc_id)
 * @param program  the program being registered
 */
function registrationRefusal(app, program) {
  if (programKey(program) !== 'gold') return null;
  if (!vestsInIndividual(app)) return null;
  return GOLD_INDIVIDUAL_REFUSAL;
}

module.exports = {
  registrationRefusal, vestsInIndividual, programKey, GOLD_INDIVIDUAL_REFUSAL,
};
