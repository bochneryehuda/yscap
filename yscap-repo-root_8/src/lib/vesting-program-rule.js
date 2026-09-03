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
 * number, not one formula, not one input. This module touches NO database and no
 * IO — its only dependency is the note-buyer normalizer in the (equally
 * dependency-free) conditions field registry — so it can be unit-tested exactly
 * and can never throw into a registration.
 *
 * SCOPE, deliberately narrow: GOLD only. Standard, Silver, Speed and a Manual
 * product are unaffected — the owner named Gold, and refusing more than was asked
 * for would block deals that are perfectly fine today. (The Speed Program,
 * 2026-09-03, composes Standard and Silver — neither parent carries this rule, so
 * neither does the composition.)
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
   already carry — the requested program, an override, or the engine's own label.
   THE ONE NORMALIZER: every register door, program-availability and
   manual-program.resolveProgram key off this, so a new program is added HERE and
   nowhere else. `speed` (the Speed Program, 2026-09-03) is tested before the
   `standard` fallback like the others, and its label never contains another
   program's word, so order among the named programs does not matter. */
function programKey(program) {
  const s = String(program || '').trim().toLowerCase();
  if (!s) return null;
  if (/gold/.test(s)) return 'gold';
  if (/silver/.test(s)) return 'silver';
  if (/speed/.test(s)) return 'speed';
  if (/manual|custom/.test(s)) return 'manual';
  if (/standard/.test(s)) return 'standard';
  return s;
}

/** The owner's own words, so every door says the same thing. */
const GOLD_INDIVIDUAL_REFUSAL =
  'The Gold Standard program does not allow a loan in an individual\'s name. '
  + 'Switch this file to an entity and enter the entity name to register it into Gold, '
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

/* ===========================================================================
   THE SAME RULE, THE OTHER WAY ROUND (owner-directed 2026-08-03: "we should
   have the Blue Lake gate because Blue Lake does not allow this").

   `registrationRefusal` above only ever fires when somebody registers an
   ALREADY-individual file into Gold. Marking a file individual is the mirror
   move and was never gated at all, so the same forbidden state was one click
   away from the other side: register into Gold first, mark individual second,
   and the file ends up exactly where the rule says it may not be.

   TWO SIGNALS, NOT ONE. Gold is our name for the product; BLUE LAKE is the
   capital partner who buys it (tapes/program-provider.js: gold ↔ bluelake), and
   the two arrive on a file independently — the note buyer is pulled from ClickUp
   and can be set long before anything is registered. Either one alone is enough
   to refuse: it is Blue Lake's money either way.

   The note buyer is matched with the PREFIX helper `isBlueLakeNoteBuyer` rather
   than the exact key, because the real ClickUp label is routinely "Blue Lake
   Capital". That helper's blast radius is deliberately this refusal only — the
   tape export gate still keys on its own enumerated aliases, so nothing here can
   ship a data tape to the wrong buyer.

   NOT A REFUSAL, deliberately: a file with no note buyer and no registration.
   Most files sit there for a while, and refusing the choice on every one of them
   would make individual vesting unusable at exactly the doors the owner asked
   for it. A later Gold registration is still refused by `registrationRefusal`. */
const BLUELAKE_INDIVIDUAL_REFUSAL =
  'Blue Lake (the Gold Standard program) does not buy a loan taken in an individual\'s name. '
  + 'This file can\'t be marked individual while it is on Blue Lake / Gold — keep it in an LLC, '
  + 'or move it to a different program and capital partner first.';

/**
 * May this file be marked as vesting in an individual's name?
 * PURE. Returns a plain reason string, or null when there is nothing to refuse.
 *
 * @param file.registeredProgram  the CURRENTLY registered PRICING program, if any
 *                               (product_registrations.program — never
 *                               `applications.program`, which is the loan
 *                               product: Bridge / Fix & Flip / Ground-Up)
 * @param file.noteBuyer         applications.lender — the capital partner
 */
function markIndividualRefusal(file) {
  const f = file || {};
  if (programKey(f.registeredProgram) === 'gold') {
    return BLUELAKE_INDIVIDUAL_REFUSAL;
  }
  if (require('./conditions/field-registry').isBlueLakeNoteBuyer(f.noteBuyer)) {
    return BLUELAKE_INDIVIDUAL_REFUSAL;
  }
  return null;
}

module.exports = {
  registrationRefusal, markIndividualRefusal, vestsInIndividual, programKey,
  GOLD_INDIVIDUAL_REFUSAL, BLUELAKE_INDIVIDUAL_REFUSAL,
};
