'use strict';
/**
 * LONG-TERM — which ClickUp folder is each officer's, for the card creation that
 * comes next. The owner, 2026-08-23: *"our systems automatically ... create in
 * that Loan Officer's Workspace ID a new file"* and *"pull ClickUp and get the
 * folder ID the same way you have for all the officers to get the thing for
 * Chaim and for Ezra."*
 *
 * THE CONVENTION, VERIFIED ON THE LIVE WORKSPACE (2026-08-23) rather than
 * assumed: an officer's "<Name> Files" folder in the Loan Pipeline space IS the
 * id RTL routing calls their `pipeline` folder — measured by reading a task in
 * "Yehuda Bochner Files" and finding its folder id byte-identical to routing.js's
 * entry (90115017377). So the existing officers come straight from RTL's routing
 * table — imported as DATA, which docs/LONG-TERM-AUTHORIZED-COPIES.md authorizes
 * by name — and the two officers that table does not know were read the same
 * way, off a live task in each folder:
 *
 *     Ezra Green Files      -> 90118271998   (task 868kur80x / FILLE-2081)
 *     Chaim Lebowitz Files  -> 90118110153   (task 868kqpntt / FILLE-2057)
 *
 * NAME-KEYED, like the table it extends, and for the same reason: the SITE's
 * officer list decides who is selectable, and a map keyed by name stays correct
 * whatever order a dropdown puts them in. The IDENTITY of an officer — which
 * PILOT person they are — is never decided here: that is the people map
 * (src/longterm/people/links.js), email-proposed and admin-confirmed. This file
 * only answers "where do this officer's cards live".
 *
 * A LOOKUP THAT FINDS NOBODY RETURNS NULL, and the caller must treat null as
 * "do not create" — a card created into a guessed folder is a file the office
 * cannot find, which is worse than no card and a reported refusal.
 */

const rtlRouting = require('../../clickup/routing');   // DATA import — see the ledger

/** The two folders RTL's table does not carry, measured as described above. */
const LT_ONLY = {
  'Ezra Green': { pipeline: '90118271998' },
  'Chaim Lebowitz': { pipeline: '90118110153' },
};

/** Officer name -> { pipeline } folder, or null for a name nobody recorded. */
function folderForOfficer(name) {
  const key = String(name || '').trim();
  if (!key) return null;
  const own = LT_ONLY[key];
  if (own) return { pipeline: own.pipeline };
  const rtl = rtlRouting.LOAN_OFFICERS && rtlRouting.LOAN_OFFICERS[key];
  return rtl && rtl.pipeline ? { pipeline: rtl.pipeline } : null;
}

/** Every officer this map knows, for a screen or a test to enumerate. */
function knownOfficers() {
  const names = new Set([
    ...Object.keys((rtlRouting.LOAN_OFFICERS) || {}),
    ...Object.keys(LT_ONLY),
  ]);
  return [...names].sort();
}

module.exports = { folderForOfficer, knownOfficers, LT_ONLY };
