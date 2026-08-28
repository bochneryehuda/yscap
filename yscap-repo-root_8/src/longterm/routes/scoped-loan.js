'use strict';
/**
 * ONE LONG-TERM LOAN, IF THIS PERSON MAY OPEN IT — the loader every per-file route
 * shares.
 *
 * The ACCESS RULE itself has always had one definition (`access.mayOpenLoan`, whose
 * own header records that writing it three times would guarantee a file you can see
 * in the list and cannot open). What did not was the PLUMBING around it — reading
 * the row, reading the loan's contacts, deciding what a database outage means — and
 * a second copy of that is how two per-file screens come to answer differently about
 * the same loan. This is that plumbing, once, so a route added later inherits every
 * decision below rather than re-making them.
 *
 * FOUR THINGS HERE ARE DELIBERATE:
 *
 *   · A MALFORMED ID IS "no such loan", refused BEFORE the query. A garbage URL is an
 *     answer about the loan; it must never reach Postgres and come back as an outage.
 *   · A DATABASE FAILURE IS A 503, NEVER THE 404 DISGUISE. "No such loan" is a
 *     statement about the loan and an outage is not one — telling somebody their file
 *     does not exist because a connection blipped is the confident wrong answer.
 *   · A LOAN THIS PERSON MAY NOT OPEN IS ALSO A 404, not a 403. A 403 confirms the
 *     loan exists, which is itself something they are not entitled to know.
 *   · IT ANSWERS THE RESPONSE ITSELF and returns null. The caller's whole obligation
 *     is `if (!scoped) return;` — so a handler cannot forget to refuse.
 */

const db = require('../db');
const access = require('../access');
const settingsStore = require('../settings/store');
const trash = require('../trash');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @returns {Promise<{loan: object, settings: object, viewer: object}|null>}
 *   null when the response has already been sent (refused or unavailable).
 */
async function loadScopedLoan(req, res, tag = 'lt') {
  if (!UUID_RE.test(String(req.params.loanId || ''))) {
    res.status(404).json({ error: 'No such long-term loan.' });
    return null;
  }
  let rows;
  try {
    ({ rows } = await db.query(
      `SELECT l.*, ${trash.notTrashSql('l')} AS not_trash FROM lt_loans l WHERE l.id = $1::uuid`,
      [String(req.params.loanId)],
    ));
  } catch (e) {
    console.error(`[${tag}] loan read failed:`, (e && e.message) || e);
    res.status(503).json({ error: 'Could not read this loan just now. Try again in a moment.' });
    return null;
  }
  if (!rows.length) { res.status(404).json({ error: 'No such long-term loan.' }); return null; }
  const loan = rows[0];
  const { settings } = await settingsStore.load();
  const viewer = access.accessFor(req.actor, settings);
  const { rows: team } = await db.query(
    'SELECT * FROM lt_loan_contacts WHERE loan_id = $1::uuid', [loan.id],
  );
  if (!access.mayOpenLoan(viewer, req.actor && req.actor.id, team)) {
    res.status(404).json({ error: 'No such long-term loan.' });
    return null;
  }
  return { loan, settings, viewer };
}

module.exports = { loadScopedLoan, UUID_RE };
