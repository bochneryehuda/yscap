'use strict';
/**
 * WHAT DOES THIS FILE VEST IN — in words, in ONE place (owner-directed
 * 2026-08-03: "on the tabs everywhere else where the vesting is coming up, on
 * the Tape Export and everywhere else, it should come up as closing as an
 * individual").
 *
 * Every surface that shows vesting used to print `llc_name || ''`. On a file
 * bought in a personal name there IS no entity by definition, so all of them —
 * the data tapes' Borrowing Entity column, the closing-prep request to counsel,
 * the file screen — showed a BLANK where the answer to "who takes title?" should
 * be. Blank reads as "nobody filled this in yet", which is the opposite of the
 * truth: somebody answered the question, and the answer was "the borrower, in
 * their own name".
 *
 * PURE — no database, no requires — so it can be shared by anything and can
 * never throw into an export.
 *
 * TWO WORDINGS, deliberately:
 *   · `vestingLabel`  — a SENTENCE for a human reading a screen or an email
 *                       ("Closing as an individual — no entity").
 *   · `vestingCell`   — a CELL VALUE for an investor spreadsheet, where the
 *                       column is "Borrowing Entity" and a sentence would be
 *                       wrong next to sixty real company names.
 * The dropdown value pushed to ClickUp stays where it already lives
 * (clickup/mapper.js, the *Vesting dropdown) — it is an enum, not prose.
 */

/** The one phrase, so no two screens describe the same file differently. */
const INDIVIDUAL_SENTENCE = 'Closing as an individual — no entity';
/** The short form, for a spreadsheet cell / a chip / a column header. */
const INDIVIDUAL_SHORT = 'Individual';

/* A LINKED ENTITY ALWAYS WINS — the same precedence the conditions engine, the
   vesting route and vesting-program-rule.vestsInIndividual already use, so a
   stale personal-name flag can never make a file that plainly vests in an LLC
   describe itself as an individual purchase. */
function isIndividual(v) {
  const x = v || {};
  const name = String(x.llcName == null ? (x.llc == null ? '' : x.llc) : x.llcName).trim();
  if (name) return false;
  if (x.llcId) return false;
  return x.individual === true || x.personalNamePurchase === true;
}

/**
 * The human sentence. Returns the entity name when there is one, the individual
 * wording when the file is a personal-name purchase, and '' when nobody has
 * answered yet — which stays blank on purpose: an unanswered question must not
 * read as an answer.
 *
 * @param v.llcName / v.llc          the vesting entity's name
 * @param v.llcId                    the linked entity id (name may not be loaded)
 * @param v.individual               explicit flag
 * @param v.personalNamePurchase     applications.personal_name_purchase
 */
function vestingLabel(v) {
  const x = v || {};
  const name = String(x.llcName == null ? (x.llc == null ? '' : x.llc) : x.llcName).trim();
  if (name) return name;
  if (isIndividual(x)) return INDIVIDUAL_SENTENCE;
  return '';
}

/** The spreadsheet form: the entity name, else "Individual", else blank. */
function vestingCell(v) {
  const x = v || {};
  const name = String(x.llcName == null ? (x.llc == null ? '' : x.llc) : x.llcName).trim();
  if (name) return name;
  if (isIndividual(x)) return INDIVIDUAL_SHORT;
  return '';
}

module.exports = { isIndividual, vestingLabel, vestingCell, INDIVIDUAL_SENTENCE, INDIVIDUAL_SHORT };
