'use strict';
/**
 * Government-ID condition auto-clear (IG-W3, owner-directed 2026-07-24).
 *
 * The owner's wiring instruction for the "Government-issued ID" condition (cond
 * 1017 / rtl_p1_id): link it to the borrower's gov-ID document and auto-clear it
 * AFTER PILOT's AI has read the ID and everything checks out. Never a false-clear.
 *
 * "AI-verified on THIS file" is a strict, provable state, not a guess:
 *   - the borrower's on-file photo ID (`borrowers.photo_id_document_id`) is a
 *     CURRENT, non-rejected `documents` row, AND
 *   - that document has a CURRENT `document_extractions` row for THIS application
 *     (doc_type='government_id', status='analyzed', not superseded, confidence not
 *     'unreadable') — i.e. the AI actually read the ID on this file, AND
 *   - there are ZERO open `government_id` findings on this file for that document
 *     (any severity — a name/DOB mismatch is fatal, but an expired ID, an
 *     unreadable read, an underage DOB, or an address that matches neither the
 *     current nor prior address on file all block the auto-clear too).
 *
 * Because the extraction is scoped to `application_id`, a REUSED ID that was never
 * AI-read on this particular file has no qualifying extraction here — so it is
 * left for a human (link-only), never blindly cleared off the profile pointer.
 *
 * `govIdCompleteness(client, appId, fieldKey)` replicates the sign-off gate's
 * borrower coverage (staff.js: the `cob_gov_id` condition covers the co-borrower;
 * the file-level `rtl_p1_id` covers the primary plus any co-borrower without their
 * own `cob_gov_id` condition) and requires every covered borrower to be verified.
 *
 * `maybeAutoSatisfyGovId(client, appId, itemId, fieldKey)` is SYMMETRIC and only
 * ever touches a SYSTEM auto-clear (an `[auto]` note with `signed_off_by` NULL — a
 * human sign-off is never touched):
 *   - complete + not-yet-cleared  → clear it (system sign-off, `[auto]` note);
 *   - a prior auto-clear that is NO LONGER complete (e.g. the borrower swapped in a
 *     different ID that the re-read flagged) → REOPEN it to 'received'.
 * So a dirty re-read of a previously auto-cleared ID self-corrects — it can never
 * leave a stale clear standing. Gated on `GOVID_AUTOCLEAR_ENABLED` (default OFF),
 * best-effort, never throws.
 */
const cfg = require('../../config');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');

const CO_GOV_ID_MARKER = 'cob_gov_id';

/**
 * Is this borrower's government ID AI-verified clean ON THIS FILE?
 * @returns {Promise<boolean>}
 */
async function govIdVerifiedForBorrower(client, appId, borrowerId) {
  if (!appId || !borrowerId) return false;
  const r = await client.query(
    `SELECT 1
       FROM borrowers b
       JOIN documents d ON d.id = b.photo_id_document_id
        AND d.is_current = true AND COALESCE(d.review_status,'') <> 'rejected'
       JOIN document_extractions ex ON ex.document_id = d.id
        AND ex.application_id = $2 AND ex.doc_type = 'government_id'
        AND ex.is_current = true AND ex.superseded = false
        AND ex.status = 'analyzed' AND COALESCE(ex.confidence,'') <> 'unreadable'
      WHERE b.id = $1
        AND NOT EXISTS (
          SELECT 1 FROM document_findings f
           WHERE f.document_id = d.id AND f.application_id = $2
             AND f.source = 'government_id' AND f.status = 'open'
        )
      LIMIT 1`, [borrowerId, appId]);
  return !!r.rows[0];
}

/**
 * Which borrowers a gov-ID condition covers, and whether each is AI-verified.
 * Mirrors the credit auto-clear's need[] shape (co-borrower.js MARKER='cob_gov_id').
 * @returns {Promise<{need:string[], unverified:string[], complete:boolean}>}
 */
async function govIdCompleteness(client, appId, fieldKey) {
  const af = (await client.query(
    'SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1', [appId])).rows[0] || {};

  const need = [];
  if (fieldKey === CO_GOV_ID_MARKER) {
    if (af.co_borrower_id) need.push(af.co_borrower_id);
  } else {
    if (af.borrower_id) need.push(af.borrower_id);
    if (af.co_borrower_id) {
      const coOwn = await client.query(
        `SELECT 1 FROM checklist_items WHERE application_id=$1 AND field_key=$2 LIMIT 1`,
        [appId, CO_GOV_ID_MARKER]);
      if (!coOwn.rows[0]) need.push(af.co_borrower_id);
    }
  }

  const unverified = [];
  for (const bid of need) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await govIdVerifiedForBorrower(client, appId, bid);
    if (!ok) unverified.push(String(bid));
  }
  const complete = need.length > 0 && unverified.length === 0;
  return { need: need.map(String), unverified, complete };
}

/**
 * Auto-clear (or self-correct) a gov-ID condition. Gated on GOVID_AUTOCLEAR_ENABLED
 * (default OFF). Never throws.
 * @returns {Promise<{enabled:boolean, satisfied:boolean, reopened:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfyGovId(client, appId, itemId, fieldKey) {
  const out = { enabled: !!cfg.govIdAutoclearEnabled, satisfied: false, reopened: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    // Only act on an actual gov-ID condition (the file-level rtl_p1_id template or
    // the co-borrower cob_gov_id marker item).
    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.notes, ci.field_key,
              COALESCE(t.code,'') AS code
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_found'; return out; }
    const isGovId = item.code === 'rtl_p1_id' || item.field_key === CO_GOV_ID_MARKER;
    if (!isGovId) { out.reason = 'not_gov_id_condition'; return out; }

    const autoCleared = item.status === 'satisfied' && item.signed_off_by == null
      && String(item.notes || '').startsWith('[auto]');
    const humanSignedOff = item.status === 'satisfied' && item.signed_off_by != null;
    if (humanSignedOff) { out.reason = 'human_signed_off'; return out; }

    const c = await govIdCompleteness(client, appId, item.field_key || fieldKey);
    out.complete = c.complete;

    if (c.complete) {
      if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }
      const note = '[auto] PILOT read the government ID on this file and the name, date of birth, and address line up — condition cleared.';
      await client.query(
        `UPDATE checklist_items
            SET status='satisfied', signed_off_at=now(), signed_off_by=NULL,
                notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
                updated_at=now()
          WHERE id=$1`, [itemId, note]);
      out.satisfied = true;
      enqueueChecklistStatusPush(itemId).catch(() => {});
      return out;
    }

    // Not complete. If WE had auto-cleared it earlier and it has since gone dirty
    // (e.g. a different ID was uploaded and the re-read flagged it), reopen so a
    // stale auto-clear can never stand. Never touches a human sign-off.
    if (autoCleared) {
      const note = '[auto] The government ID on this file needs another look before it can be cleared — re-check the ID.';
      await client.query(
        `UPDATE checklist_items
            SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                reviewed_at=NULL, reviewed_by=NULL,
                notes = CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END,
                updated_at=now()
          WHERE id=$1`, [itemId, note]);
      out.reopened = true;
      enqueueChecklistStatusPush(itemId).catch(() => {});
      return out;
    }

    out.reason = 'incomplete';
    return out;
  } catch (e) {
    console.error('[gov-id] maybeAutoSatisfyGovId', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

/**
 * Run the auto-clear pass over the file's gov-ID condition(s) — the file-level
 * rtl_p1_id and any co-borrower cob_gov_id. Best-effort; never throws. Call this
 * after a government_id document has been AI-read (its findings persisted).
 */
async function autoClearGovIdConditions(client, appId) {
  try {
    if (!cfg.govIdAutoclearEnabled || !appId) return;
    const conds = await client.query(
      `SELECT ci.id, ci.field_key
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1
          AND (COALESCE(t.code,'')='rtl_p1_id' OR ci.field_key=$2)`, [appId, CO_GOV_ID_MARKER]);
    for (const row of conds.rows) {
      // eslint-disable-next-line no-await-in-loop
      await maybeAutoSatisfyGovId(client, appId, row.id, row.field_key);
    }
  } catch (e) {
    console.error('[gov-id] autoClearGovIdConditions', appId, e && e.message);
  }
}

module.exports = { govIdVerifiedForBorrower, govIdCompleteness, maybeAutoSatisfyGovId, autoClearGovIdConditions, CO_GOV_ID_MARKER };
