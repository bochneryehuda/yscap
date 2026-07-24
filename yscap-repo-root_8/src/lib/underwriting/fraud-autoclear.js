'use strict';
/**
 * Background/OFAC condition auto-clear (IG-W12, owner-directed 2026-07-24).
 *
 * The owner's wiring for the "Background check / OFAC" condition (cond 2005 /
 * rtl_cond_fraud): link it to the fraud/background desk and auto-clear it once
 * PILOT has READ the background report on this file and it comes back clean.
 * Never a false-clear.
 *
 * "Clean on THIS file" is proven, not guessed — it reuses the fully-built
 * background-report finding engine (doc-checks.computeBackgroundFindings, wired as
 * the registry check for background_report), which already enumerates EVERY
 * false-clear path: a confirmed/potential OFAC match, a criminal record, a screen
 * run on the WRONG subject name, an unscreened/mismatched borrowing entity, open
 * fraud alerts, a PEP hit, and an unreadable report. So "clean" is simply:
 *   - a CURRENT analyzed background_report `document_extractions` row for THIS
 *     application (status='analyzed', not superseded), AND
 *   - ZERO open `background_report` findings on this file.
 * Because a null/unreadable OFAC result routes to an OPEN verify finding, a clean
 * state already implies the OFAC result was read and returned clear.
 *
 * Mirrors the sign-off gate exactly so auto can never be looser than a human
 * (staff.js isFraud): a Gold-registered file ALSO requires the criminal-report
 * slot document to be on file.
 *
 * `maybeAutoSatisfyFraud` is SYMMETRIC (clear when clean / reopen a prior [auto]
 * clear that has gone dirty), a SYSTEM sign-off (signed_off_by NULL, [auto] note),
 * gated on FRAUD_AUTOCLEAR_ENABLED (default OFF), never throws. Compliance-
 * sensitive (BSA/AML), so it stays opt-in.
 */
const cfg = require('../../config');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');

// The fraud condition's checklist item on the file (rtl_cond_fraud template).
async function fraudItemId(client, appId) {
  const r = await client.query(
    `SELECT ci.id FROM checklist_items ci
       JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND t.code='rtl_cond_fraud'
      ORDER BY ci.created_at LIMIT 1`, [appId]);
  return r.rows[0] ? r.rows[0].id : null;
}

/**
 * Is the file's background/OFAC screen AI-read clean on THIS file (and, for a Gold
 * file, is the criminal-report slot present)?
 * @returns {Promise<{complete:boolean, reason?:string}>}
 */
async function fraudCompleteness(client, appId, itemId) {
  // A current analyzed background report for this file whose OFAC result was
  // AFFIRMATIVELY read as clear — NOT merely the absence of a finding. A report
  // whose OFAC section was never captured comes back with ofacResult=null and
  // raises no finding, so "no open finding" alone would clear a file whose
  // sanctions screen was never actually confirmed clear. The enum is
  // clear|potential_match|confirmed_match (schemas.js BACKGROUND_REPORT); requiring
  // ='clear' means a null/absent OFAC result defers to a human. A potential/confirmed
  // match also raises an OPEN finding (blocked below) and never equals 'clear'.
  const readClean = (await client.query(
    `SELECT 1
       FROM document_extractions ex
      WHERE ex.application_id=$1 AND ex.doc_type='background_report'
        AND ex.is_current = true AND ex.superseded = false AND ex.status='analyzed'
        AND lower(btrim(COALESCE(ex.fields->>'ofacResult',''))) = 'clear'
        AND NOT EXISTS (
          SELECT 1 FROM document_findings f
           WHERE f.application_id=$1 AND f.source='background_report' AND f.status='open'
        )
      LIMIT 1`, [appId])).rows[0];
  if (!readClean) return { complete: false, reason: 'no_clean_read' };

  // Mirror signOffGate isFraud: a Gold file also needs the criminal-report slot.
  const gp = (await client.query(
    `SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [appId])).rows[0];
  if (gp && /gold/i.test(String(gp.program || '')) && itemId) {
    const crim = (await client.query(
      `SELECT 1 FROM documents
        WHERE checklist_item_id=$1 AND is_current AND COALESCE(review_status,'') <> 'rejected'
          AND lower(coalesce(slot_label,'')) LIKE '%criminal%' LIMIT 1`, [itemId])).rows[0];
    if (!crim) return { complete: false, reason: 'gold_criminal_missing' };
  }
  return { complete: true };
}

/**
 * Auto-clear (or self-correct) the fraud/OFAC condition. Gated on
 * FRAUD_AUTOCLEAR_ENABLED (default OFF). Never throws.
 * @returns {Promise<{enabled:boolean, satisfied:boolean, reopened:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfyFraud(client, appId, itemId) {
  const out = { enabled: !!cfg.fraudAutoclearEnabled, satisfied: false, reopened: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.notes, COALESCE(t.code,'') AS code
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2 AND t.code='rtl_cond_fraud'
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_fraud_condition'; return out; }

    const autoCleared = item.status === 'satisfied' && item.signed_off_by == null
      && String(item.notes || '').startsWith('[auto]');
    if (item.status === 'satisfied' && item.signed_off_by != null) { out.reason = 'human_signed_off'; return out; }

    const c = await fraudCompleteness(client, appId, itemId);
    out.complete = c.complete;

    if (c.complete) {
      if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }
      const note = '[auto] PILOT read the background / OFAC report on this file and it came back clean — condition cleared.';
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

    if (autoCleared) {
      const note = '[auto] The background / OFAC report on this file needs another look before it can be cleared — re-check it.';
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
    console.error('[fraud] maybeAutoSatisfyFraud', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

/**
 * Run the auto-clear pass over the file's fraud/OFAC condition. Best-effort; never
 * throws. Call after a background_report document has been AI-read.
 */
async function autoClearFraudCondition(client, appId) {
  try {
    if (!cfg.fraudAutoclearEnabled || !appId) return;
    const itemId = await fraudItemId(client, appId);
    if (itemId) await maybeAutoSatisfyFraud(client, appId, itemId);
  } catch (e) {
    console.error('[fraud] autoClearFraudCondition', appId, e && e.message);
  }
}

module.exports = { fraudItemId, fraudCompleteness, maybeAutoSatisfyFraud, autoClearFraudCondition };
