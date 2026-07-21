'use strict';

/**
 * YS loan-number uniqueness (owner-directed 2026-07-20).
 *
 * "Make sure he's not using a duplicate loan number that is already in another
 *  file. It should not be a loan number from another file in our system and
 *  should not be a loan number that is in a different file in ClickUp even if
 *  that file is not in our system … We need to build strong logic for this and
 *  we need manual review of anything is bumping."
 *
 * A YS loan number must be unique to ONE file across TWO universes:
 *   1. our own files (`applications`, non-deleted) — the db/048 partial-unique
 *      index is the hard backstop; this is the friendly front-door check;
 *   2. EVERY ClickUp task the sync has ever seen (`clickup_task_index`) —
 *      including `data_only` DSCR / long-term tasks we pull for data but never
 *      turn into a loan file. The number lives in the masked snapshot at
 *      snapshot->'app'->>'ys_loan_number'; db/209 indexes it for a fast lookup.
 *
 * Comparison is case/space-insensitive (upper(btrim(...))), matching the
 * applications unique index (db/048) and the uppercase backfill (db/199).
 *
 * findLoanNumberCollision returns the FIRST collision found (our file wins over a
 * ClickUp-only file for the clearer message) or null when the number is free.
 * Everything is best-effort/guarded — a cache-table hiccup must never crash the
 * loan-number entry, but our-file uniqueness (universe 1) always runs.
 */

const db = require('../db');

/**
 * @param {string} number  the loan number being entered (any casing)
 * @param {object} [opts]
 * @param {string} [opts.excludeAppId]  the file this number is being set ON (so it
 *        doesn't collide with itself, nor with its own linked ClickUp task)
 * @returns {Promise<null|{where:'our_file'|'clickup_file', value?:string,
 *          applicationId?:string, taskId?:string, kind?:string, taskName?:string}>}
 */
async function findLoanNumberCollision(number, opts = {}) {
  const up = String(number == null ? '' : number).trim().toUpperCase();
  if (!up) return null;
  const excludeAppId = opts.excludeAppId || null;

  // Universe 1 — our own non-deleted files. Always runs (the source of truth).
  const ours = await db.query(
    `SELECT id, ys_loan_number
       FROM applications
      WHERE upper(btrim(ys_loan_number)) = $1
        AND deleted_at IS NULL
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1`,
    [up, excludeAppId]);
  if (ours.rows[0]) {
    return { where: 'our_file', applicationId: ours.rows[0].id, value: ours.rows[0].ys_loan_number };
  }

  // Universe 2 — any ClickUp task the sync has cached, incl. data_only (DSCR /
  // long-term) tasks we never materialized. A task linked to THIS file is
  // excluded (its number legitimately equals this file's). Best-effort: a
  // missing/half-migrated cache table just means "no ClickUp collision known".
  try {
    const cu = await db.query(
      `SELECT task_id, kind, application_id, task_name,
              btrim(snapshot->'app'->>'ys_loan_number') AS ln
         FROM clickup_task_index
        WHERE upper(btrim(snapshot->'app'->>'ys_loan_number')) = $1
          AND ($2::uuid IS NULL OR application_id IS DISTINCT FROM $2::uuid)
        LIMIT 1`,
      [up, excludeAppId]);
    if (cu.rows[0]) {
      return {
        where: 'clickup_file', value: cu.rows[0].ln || up, taskId: cu.rows[0].task_id,
        kind: cu.rows[0].kind, applicationId: cu.rows[0].application_id || null,
        taskName: cu.rows[0].task_name || null,
      };
    }
  } catch (e) {
    console.warn('[loan-number] ClickUp cache uniqueness check skipped:', db.describeError ? db.describeError(e) : e.message);
  }
  return null;
}

/** A plain-language rejection sentence for a collision (staff-facing). */
function collisionMessage(collision, number) {
  const n = String(number || '').trim().toUpperCase();
  if (!collision) return null;
  if (collision.where === 'our_file') {
    return `Loan number ${collision.value || n} is already used on another file here — loan numbers must be unique.`;
  }
  // ClickUp-only (possibly a DSCR/data-only file we don't create loans from).
  // NOTE: the "flagged for manual review" sentence is appended by the caller ONLY
  // when the review row was actually queued — never asserted here (a queue hiccup
  // must not make us claim a review that does not exist).
  const where = collision.taskName ? ` ("${collision.taskName}")` : '';
  return `Loan number ${n} is already used on a different file in ClickUp${where} — even a data-only (e.g. DSCR) file. It must be unique to this file.`;
}

module.exports = { findLoanNumberCollision, collisionMessage };
