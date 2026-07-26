'use strict';
/**
 * The lender's required mortgagee / loss-payee clause — the exact wording that must appear on BOTH
 * the title policy (Schedule A lender vesting) and the hazard-insurance evidence so our lien and
 * loss-payee rights are perfected and we get notice. Owner-provided 2026-07-20.
 *
 * Kept in ONE place so the title check and the insurance check verify the SAME clause and it can be
 * updated once if the entity's notice address ever changes.
 */
const LENDER_NAME = 'YS CAPITAL GROUP';
const LENDER_MORTGAGEE_CLAUSE =
  'YS CAPITAL GROUP ISAOA/ATIMA\n5 NEW MONROSE AVE #BSMT BROOKLYN NY 11211';

const norm = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

// Does the captured clause text name OUR lender with the ISAOA/ATIMA (successors-and-assigns)
// language? Returns true / false / null(unknown — nothing captured, so never a false accusation).
function clauseNamesLender(text) {
  const n = norm(text);
  if (!n) return null;
  const namesUs = /ys capital group/.test(n);
  const successorLang = /\bisaoa\b|\batima\b|(?:its )?successors? and ?\/? ?or assigns|(?:its )?successors and assigns/.test(n);
  return namesUs && successorLang;
}

// Does the clause also carry the correct notice address? (Only meaningful once it names the lender.)
function clauseHasAddress(text) {
  const n = norm(text);
  if (!n) return null;
  return /5 new monrose ave/.test(n) && /brooklyn/.test(n) && /11211/.test(n);
}

// IS THERE A NOTICE ADDRESS AT ALL? (owner-directed 2026-07-26: the address notice "should auto-clear
// when an address is present".)
//
// `clauseHasAddress` above answers a much narrower question — does the clause carry OUR address,
// spelled our way. A binder that reads "5 New Monrose Avenue, Basement, Brooklyn, New York 11211"
// answers false to that and used to raise a notice claiming the address "doesn't match", when what
// actually happened is that the wording differs. The clause already names US, so an address sitting
// next to our name IS our notice address as the agent typed it; the only thing genuinely worth a
// nudge is a clause with no address on it whatsoever.
//
// Returns 'ours' | 'present' | 'none', or null when nothing was captured (never an accusation off a
// document we could not read).
function clauseAddressState(text) {
  const n = norm(text);
  if (!n) return null;
  if (clauseHasAddress(text)) return 'ours';
  // Any street line (a number followed by a word) or any 5-digit ZIP counts as an address being
  // printed. Deliberately generous: this decides whether to STAY QUIET, and the clause has already
  // been confirmed to name the lender.
  const hasStreet = /\b\d+\s+[a-z]/.test(n);
  const hasZip = /\b\d{5}\b/.test(n);
  return (hasStreet || hasZip) ? 'present' : 'none';
}

module.exports = { LENDER_NAME, LENDER_MORTGAGEE_CLAUSE, clauseNamesLender, clauseHasAddress, clauseAddressState, _norm: norm };
