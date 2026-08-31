'use strict';

/**
 * WHICH LONG-TERM LOANS BELONG TO THE SIGNED-IN BORROWER — one definition.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE. `my-loans.js` answered this inside its list
 * query, which was fine while the list was the only borrower-facing door. It is
 * not any more: the borrower's conditions and their uploads are scoped by the
 * SAME question, and a copied scope is how a branch of it goes missing. This
 * repo has already paid for that lesson on the staff side — `visibleOfficersSql`
 * is five branches, seven routers copied ONE of them, and the same person could
 * open a file's conditions and get 404 from its appraisal tab. The failure is
 * silent, and the person who hits it is never the person who wrote the code.
 *
 * THERE ARE THREE TERMS AND ALL THREE MATTER:
 *
 *   1. THE SWITCH. `borrower.longTermVisible` decides whether the borrower-facing
 *      long-term side exists at all. It gates the LIST today; it must gate every
 *      other borrower door too, or switching the side off would hide the loans
 *      while leaving their documents reachable by anybody who kept a link. Off is
 *      one setting, not a deploy, and it has to mean off everywhere.
 *
 *   2. THE LINK. `lt_loans.borrower_id` is written ONLY by an admin confirming a
 *      match (`borrower-links.js`) — never guessed from a name or an email. An
 *      unmatched loan belongs to nobody and is visible to nobody, which is the
 *      safe direction and the reason the mapping is confirm-and-not-guess.
 *
 *   3. THE TRASH. A loan deleted in Encompass is not one of their files. The
 *      archive is internal.
 *
 * FAILS CLOSED throughout: an unreadable settings row answers "off", and an
 * unreadable loan answers "not yours". Neither is permission to show a client
 * anything.
 */

const db = require('./db');
const trash = require('./trash');
const settingsStore = require('./settings/store');

/**
 * Is the borrower-facing long-term side switched on?
 *
 * `=== true` is load-bearing: a settings object that came back empty, or a value
 * that is the STRING "true", reads as OFF. The shipped default is on, so this is
 * a genuine fail-closed rather than a coincidence of the two agreeing.
 */
async function longTermVisible() {
  try {
    const { settings } = await settingsStore.load();
    return settings['borrower.longTermVisible'] === true;
  } catch (e) {
    console.error('[lt] borrower long-term visibility check failed:', (e && e.message) || e);
    return false;
  }
}

/**
 * The WHERE terms that make a long-term loan this borrower's own.
 *
 * A FUNCTION OF ITS PLACEHOLDER, never a hard-coded `$1`. A caller that binds the
 * borrower second would otherwise leave `$1` unreferenced, and Postgres refuses a
 * statement with a parameter nothing mentions (42P18) — which is exactly how the
 * borrower-view scope broke for every admin once.
 */
function ownLoanSql(alias = 'l', p = '$1') {
  return `${alias}.borrower_id = ${p}::uuid AND ${trash.notTrashSql(alias)}`;
}

/**
 * Resolve ONE long-term loan the borrower may see, or null.
 *
 * Returns null for every reason a client is not entitled to it — the side is
 * switched off, the id is not a uuid, the loan is somebody else's, it is in the
 * trash — deliberately WITHOUT saying which. A door that distinguishes "not
 * yours" from "does not exist" tells an outsider which loan numbers are real.
 */
async function loadOwnLoan(borrowerId, loanId, client = db) {
  if (!borrowerId || !loanId) return null;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(loanId))) return null;
  if (!(await longTermVisible())) return null;
  try {
    const { rows } = await client.query(
      `SELECT l.id, l.loan_number, l.program_name, l.term_months, l.loan_amount
         FROM lt_loans l
        WHERE l.id = $2::uuid AND ${ownLoanSql('l', '$1')}
        LIMIT 1`,
      [borrowerId, loanId],
    );
    return rows[0] || null;
  } catch (e) {
    // An unreadable loan is not permission. Say nothing, show nothing.
    console.error('[lt] borrower own-loan lookup failed:', (e && e.message) || e);
    return null;
  }
}

module.exports = { longTermVisible, ownLoanSql, loadOwnLoan };
