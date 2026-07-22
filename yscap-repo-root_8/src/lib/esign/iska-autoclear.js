'use strict';

/**
 * AUTO-CLEAR the Heter Iska (ISKA) DocuSign package when the loan amount changed
 * (owner-directed 2026-07-22).
 *
 * The Heter Iska is an interest-permissibility document tied to the LOAN AMOUNT.
 * If the loan amount changes after the ISKA was signed, the signed ISKA is stale
 * and a fresh one must be collected. This runs from the register after-commit
 * path when the loan amount actually moved: it VOIDS the live heter_iska
 * envelope + SUPERSEDES its signed document via the shared clearPackage() — the
 * DocuSign-side clear a DB trigger can't do.
 *
 * The condition itself is reopened by the db/280 trigger (from ANY loan-amount
 * writer, with the "reopened because the loan amount changed" note), so this
 * layer is specifically the package clear; clearPackage's own condition reopen
 * is a harmless no-op once the trigger has already reopened it.
 *
 * No-op when there is no live (sent/delivered/completed) heter_iska package on
 * the file. Best-effort by contract — the caller wraps it so it can never break
 * a registration.
 *
 * @param {object} p
 * @param {string} p.appId       the application id
 * @param {string|null} [p.actorId] staff id doing the register (null on the borrower path)
 * @param {object} [p.db]        db handle (defaults to the pool)
 * @param {object} [p.docusign]  the DocuSign client (needed to void a still-out ISKA)
 * @returns {Promise<{cleared:boolean, count?:number, results?:object[], reason?:string}>}
 */
const { clearPackage, CLEARABLE_STATUSES } = require('./clear');
const dbDefault = require('../../db');

async function autoClearIskaOnLoanChange({ appId, actorId = null, db = dbDefault, docusign } = {}) {
  if (!appId) return { cleared: false, reason: 'no-app' };
  // Every live Heter Iska package on the file (normally at most one — the
  // send-once guard prevents a second in-flight, and a completed one blocks a
  // re-send until cleared — but clear ALL live ones defensively).
  const envs = (await db.query(
    `SELECT id FROM esign_envelopes
      WHERE application_id=$1 AND purpose='heter_iska' AND status = ANY($2)
      ORDER BY created_at DESC`, [appId, CLEARABLE_STATUSES])).rows;
  if (!envs.length) return { cleared: false, reason: 'no-live-iska' };
  const results = [];
  for (const e of envs) {
    results.push(await clearPackage({
      rowId: e.id,
      actorId,
      reason: 'Auto-cleared — the loan amount changed after the Heter Iska was signed, so a fresh one is needed.',
      db,
      docusign,
    }));
  }
  return { cleared: true, count: results.length, results };
}

module.exports = { autoClearIskaOnLoanChange };
