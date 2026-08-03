'use strict';

/**
 * Recording a file's stage moves — ALL of them, not just the ones made in the portal.
 *
 * THE GAP THIS CLOSES. `application_status_history` has existed since db/027, and until
 * now it had exactly two writers, both portal doors in src/routes/staff.js. A status
 * changed in CLICKUP — which is where a great deal of this team's status changes actually
 * happen — updated `applications.status` and wrote NO history row and did not even move
 * `status_changed_at`.
 *
 * Nothing errored, so nothing surfaced it. The cost is silent and total: "how long does a
 * file sit in underwriting", "where do files get stuck", "how long from application to
 * clear-to-close" all read this table, and every one of those answers was quietly
 * computed over the portal-driven minority of moves. A wrong number nobody can see is
 * worse than a missing one.
 *
 * AND IT IS THE ONE FIX THAT CANNOT BE BACKDATED. History not recorded is gone — there is
 * no later pass that can reconstruct when a file entered processing last March. That is
 * why this shipped ahead of any screen.
 *
 * The rule for callers: record the move you actually made, only when the status really
 * changed, and never let the recording break the thing that moved it. Every function here
 * is best-effort and swallows its own errors.
 */

const db = require('../db');

const SOURCES = new Set(['portal', 'clickup', 'system']);

/**
 * Record one stage move.
 *
 * @param {string}  applicationId
 * @param {string?} fromStatus  the borrower-facing status before the move
 * @param {string}  toStatus    …and after it
 * @param {object}  opts        { changedBy, source, forced, client }
 * @returns {Promise<boolean>}  true when a row was written
 */
async function record(applicationId, fromStatus, toStatus, opts = {}) {
  if (!applicationId || !toStatus) return false;
  // Only a real move is history. Re-recording an unchanged status would turn every
  // re-ingest of a ClickUp card — which happens on every webhook — into a fake stage
  // change, and "days in stage" would read zero for every file in the system.
  if (fromStatus === toStatus) return false;
  const source = SOURCES.has(opts.source) ? opts.source : 'system';
  const q = opts.client || db;
  try {
    await q.query(
      `INSERT INTO application_status_history
         (application_id, from_status, to_status, changed_by, forced, source)
       VALUES ($1,$2,$3,$4,COALESCE($5,false),$6)`,
      [applicationId, fromStatus || null, toStatus, opts.changedBy || null, !!opts.forced, source]);
    return true;
  } catch (e) {
    // Best-effort by design: a history write must never break a status change, a ClickUp
    // pull, or a borrower's file. Logged so a systemic failure is visible.
    console.warn('[stage-history] could not record', applicationId, `${fromStatus || '?'}→${toStatus}:`,
      (e && e.message) || e);
    return false;
  }
}

/**
 * Record a move AND advance `status_changed_at` — the complete inbound sequence, in ONE
 * place, because a caller that does half of it leaves "how long has this file been sitting
 * where it is" measuring the last PORTAL move on a file whose stage has changed in ClickUp
 * many times since.
 *
 * THE STAMP IS PINNED TO THE STATUS IT DESCRIBES (`AND status=$2`). Without that, a
 * concurrent write that moves the file on again between the record and the stamp gets its
 * clock reset to this move's time, so the newer stage looks older than it is. The caller
 * hands us the before and after it actually wrote, so nothing is re-read and nothing can be
 * inferred from a row that has since changed underneath us.
 */
async function recordMove(applicationId, fromStatus, toStatus, opts = {}) {
  const wrote = await record(applicationId, fromStatus, toStatus, opts);
  if (wrote) {
    await db.query(
      `UPDATE applications SET status_changed_at=now() WHERE id=$1 AND status=$2`,
      [applicationId, toStatus]).catch(() => {});
  }
  return wrote;
}

module.exports = { record, recordMove, SOURCES };
