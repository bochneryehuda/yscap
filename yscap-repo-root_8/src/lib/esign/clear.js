'use strict';

/**
 * CLEAR a DocuSign package (owner-directed 2026-07-22).
 *
 * "Clear" is the deliberate, warned action that undoes a sent/signed package so a
 * fresh one can go out with updated details:
 *   1. VOID it at DocuSign if it's still out for signature (sent/delivered). A
 *      COMPLETED (fully-signed) envelope can't be voided at DocuSign — we clear
 *      it on our side only (the signed copy stays in DocuSign's vault; it's
 *      detached from the file).
 *   2. SUPERSEDE the signed document(s) — is_current=false / review_status
 *      'superseded'. NEVER hard-deleted: it stays in the audit trail + the
 *      SharePoint mirror (no-delete policy) but drops off the current Documents
 *      list and off the condition it cleared. "Removed from the file" without
 *      destroying the record.
 *   3. REOPEN exactly the condition(s) THIS package satisfied — via its own
 *      esign_envelope_docs.checklist_item_id rows, so packages stay independent
 *      (clearing the Term Sheet reopens the term-sheet + application conditions;
 *      clearing the Heter Iska reopens only the ISKA).
 *
 * Voiding frees the send-once guard, so a fresh package can be re-issued right
 * after; and because the structural freeze keys on a live-sent term-sheet
 * envelope, clearing the Term Sheet package LIFTS the freeze automatically.
 *
 * All DB work runs in ONE transaction so a partial clear can never happen. The
 * (external) DocuSign void is done BEFORE the transaction opens so a network
 * call never holds a write lock.
 */

const dbDefault = require('../../db');

// purpose → the plain-language package name, for the reopen note + summary.
const PACKAGE_LABEL = {
  term_sheet_package: 'Term Sheet',
  heter_iska: 'Heter Iska',
  draw_request: 'Draw request',
  test: 'Test',
};

// A package can be CLEARED while it is live: out for signature or already signed.
const CLEARABLE_STATUSES = ['sent', 'delivered', 'completed'];

function httpError(status, message) { const e = new Error(message); e.status = status; e.expose = true; return e; }

async function clearPackage({ rowId, actorId, reason, db = dbDefault, docusign } = {}) {
  const env = (await db.query(`SELECT * FROM esign_envelopes WHERE id=$1`, [rowId])).rows[0];
  if (!env) throw httpError(404, 'That package no longer exists.');
  if (!CLEARABLE_STATUSES.includes(env.status)) {
    throw httpError(409, `This package is ${env.status} — there's nothing sent to clear.`);
  }
  const label = PACKAGE_LABEL[env.purpose] || 'package';
  const cleanReason = String(reason || '').trim() || 'Cleared to re-issue with updated details';

  // 1) Void at DocuSign FIRST (outside the transaction) if it's still open. A
  //    completed envelope can't be voided there — skip and clear on our side.
  let voided = false;
  if (['sent', 'delivered'].includes(env.status) && env.envelope_id && docusign) {
    try {
      await docusign.voidEnvelope(env.envelope_id, cleanReason);
      voided = true;
    } catch (e) {
      // If DocuSign says it's already terminal, that's fine — proceed to clear
      // our side. Any other error is a real failure — surface it, change nothing.
      const msg = String((e && e.message) || '').toLowerCase();
      if (!/(voided|completed|declined|already|terminal)/.test(msg)) {
        throw httpError(502, 'DocuSign could not void the package right now — nothing was changed. Try again shortly.');
      }
    }
  }

  // 2+3) Everything on our side, atomically.
  const client = await db.getClient();
  const reopened = [];
  let docsCleared = 0;
  try {
    await client.query('BEGIN');
    const docs = (await client.query(
      `SELECT id, doc_kind, checklist_item_id, completed_document_id
         FROM esign_envelope_docs WHERE envelope_row_id=$1`, [env.id])).rows;

    // Supersede each stored signed document (soft — never hard-delete).
    for (const d of docs) {
      if (d.completed_document_id) {
        const r = await client.query(
          `UPDATE documents SET is_current=false, review_status='superseded'
            WHERE id=$1 AND is_current=true`, [d.completed_document_id]);
        docsCleared += r.rowCount || 0;
      }
    }
    // Detach the signed artifacts from the envelope-doc map so the file no longer
    // points at them (the superseded documents row stays for history). cleared_at
    // keeps its original meaning — when the condition was first auto-cleared — so
    // it's left untouched here.
    await client.query(
      `UPDATE esign_envelope_docs SET completed_document_id=NULL WHERE envelope_row_id=$1`, [env.id]);

    // Reopen exactly this package's conditions — clear the signed/received state
    // and every sign-off / review stamp, with an [auto] note explaining why. The
    // WHERE is fully parenthesised so the id guard applies to BOTH OR branches (a
    // bare `id=$1 AND a OR b` would let branch b match every row).
    const note = `[auto] Reopened — the ${label} DocuSign package was cleared.`;
    const itemIds = [...new Set(docs.map((d) => d.checklist_item_id).filter(Boolean))];
    for (const itemId of itemIds) {
      const r = await client.query(
        `UPDATE checklist_items
            SET status='outstanding', signed_off_at=NULL, signed_off_by=NULL,
                reviewed_at=NULL, reviewed_by=NULL,
                notes = CASE WHEN COALESCE(notes,'') = '' THEN $2 ELSE notes || E'\n' || $2 END,
                updated_at=now()
          WHERE id=$1 AND (status IN ('received','satisfied') OR signed_off_at IS NOT NULL)`,
        [itemId, note]);
      if (r.rowCount) reopened.push(itemId);
    }

    // Mark the envelope CLEARED. status→'voided' (terminal, frees the send-once
    // guard + lifts the term-sheet freeze); cleared_* records it was a clear, not
    // an ordinary void, for the history / UI.
    await client.query(
      `UPDATE esign_envelopes
          SET status='voided', voided_at=COALESCE(voided_at, now()),
              void_reason=COALESCE(void_reason, $2),
              cleared_at=now(), cleared_by=$3, clear_reason=$2, updated_at=now()
        WHERE id=$1`, [env.id, cleanReason, actorId || null]);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  // Best-effort: push the reopened condition statuses to ClickUp (mirrors the
  // completion path which pushes the received status).
  try {
    const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');
    for (const itemId of reopened) enqueueChecklistStatusPush(itemId).catch(() => {});
  } catch (_) { /* enqueue is best-effort */ }

  return { ok: true, purpose: env.purpose, label, voided, docsCleared, conditionsReopened: reopened, applicationId: env.application_id };
}

module.exports = { clearPackage, CLEARABLE_STATUSES, PACKAGE_LABEL };
