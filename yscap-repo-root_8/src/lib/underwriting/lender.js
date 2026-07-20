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

module.exports = { LENDER_NAME, LENDER_MORTGAGEE_CLAUSE, clauseNamesLender, clauseHasAddress, _norm: norm };
