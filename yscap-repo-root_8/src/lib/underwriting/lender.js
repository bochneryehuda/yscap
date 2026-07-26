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
// actually happened is that the wording differs. That nag is what the owner asked us to stop.
//
// But "an address is printed" is NOT the same as "our address is printed" (audit 2026-07-26). A
// clause can name us and carry the borrower's address, or the previous lender's — and then loss
// notices go somewhere we never see, which is the exact harm the check exists to prevent. So this
// stays a THREE-way answer and the caller must handle all three: 'ours' is silent, 'none' asks for
// an address, and 'present' gets a quiet confirm-this line rather than nothing at all.
//
// Returns 'ours' | 'present' | 'none', or null when nothing was captured (never an accusation off a
// document we could not read).
function clauseAddressState(text) {
  const n = norm(text);
  if (!n) return null;
  if (clauseHasAddress(text)) return 'ours';
  // What counts as an address being PRINTED. Both patterns are deliberately anchored: a bare
  // "number followed by a word" matches "loan 12345 mortgagee", and a bare 5-digit run matches a
  // loan or policy number — either would have read a clause with NO address as having one and
  // silenced the very finding the owner wants.
  const hasStreet = /\b\d+\s+[a-z][a-z ]*?\b(ave|avenue|st|street|rd|road|blvd|boulevard|ln|lane|dr|drive|way|pl|place|ct|court|ter|terrace|pkwy|parkway|hwy|highway|box)\b/.test(n);
  // A ZIP only counts in "<city> <ST> <5 digits>" shape. "policy no ny 84213" would satisfy
  // anything looser, and reading a policy number as an address silences the finding on the very
  // clause that most needs it. A clause carrying a full state NAME and no street is not matched
  // here — in practice such a clause prints a street too, which the rule above catches.
  const hasZip = /\b[a-z]{3,}\s+[a-z]{2}\s+\d{5}\b/.test(n);
  return (hasStreet || hasZip) ? 'present' : 'none';
}

module.exports = { LENDER_NAME, LENDER_MORTGAGEE_CLAUSE, clauseNamesLender, clauseHasAddress, clauseAddressState, _norm: norm };
