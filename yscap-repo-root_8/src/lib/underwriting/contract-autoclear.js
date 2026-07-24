'use strict';
/**
 * Purchase-contract (+ assignment) condition auto-clear (IG-W7, owner-directed 2026-07-24).
 *
 * The owner's wiring instruction for the "Executed purchase contract" condition
 * (cond 1089 / rtl_p1_contract): link it to the contract document, read it with
 * PILOT's AI, and auto-clear it once the contract has been read AND its economics
 * reconcile to the file — never a false-clear.
 *
 * "The contract is read and it ties out" is a strict, provable state, not a guess:
 *   - a CURRENT, analyzed `purchase_contract` extraction exists for THIS application
 *     (status='analyzed', not superseded, confidence not 'unreadable') — i.e. PILOT
 *     actually read the contract on this file; AND
 *   - if the file is an ASSIGNMENT (applications.is_assignment), a CURRENT analyzed
 *     `assignment` extraction exists too (both legs of a wholesale deal must be read);
 *     AND
 *   - there are ZERO open FATAL findings on this file from the contract review
 *     (source 'purchase_contract' or 'assignment') — that is the reconciliation
 *     tie-out: the fatal codes are exactly the economic mismatches (price, address,
 *     buyer entity, assignment fee, underlying/seller price, an unsigned assignment).
 *     A price that doesn't match the file, or a buyer that isn't the borrowing
 *     entity, leaves a fatal open and blocks the clear.
 *
 * Advisory WARNINGS (assignment math that doesn't add up, a fee over the 15% cap, an
 * unreadable seller name, a price increase that doesn't equal the fee) do NOT block —
 * they are things for a human to note, not reasons the contract itself isn't verified.
 *
 * `maybeAutoSatisfyContract(client, appId, itemId)` is SYMMETRIC and only ever touches
 * a SYSTEM auto-clear (an `[auto]` note with `signed_off_by` NULL — a human sign-off is
 * never touched):
 *   - complete + not-yet-cleared  → clear it (system sign-off, `[auto]` note);
 *   - a prior auto-clear that is NO LONGER complete (e.g. the borrower swapped in a
 *     different contract that the re-read flagged, or the price on file changed and no
 *     longer reconciles) → REOPEN it to 'received'.
 * So a dirty re-read (or an economics change) of a previously auto-cleared contract
 * self-corrects — it can never leave a stale clear standing. Gated on
 * `CONTRACT_AUTOCLEAR_ENABLED` (default OFF), best-effort, never throws.
 */
const cfg = require('../../config');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');

const CONTRACT_CODE = 'rtl_p1_contract';
// The contract review's finding sources — a fatal from either blocks the clear.
const CONTRACT_FINDING_SOURCES = ['purchase_contract', 'assignment'];

/**
 * Has PILOT read the contract (and, on an assignment, the assignment doc) on THIS
 * file, and does the economics reconcile (no open fatal contract/assignment finding)?
 * @returns {Promise<{contractRead:boolean, needsAssignment:boolean, assignmentRead:boolean, openFatal:number, complete:boolean}>}
 */
async function contractCompleteness(client, appId) {
  const out = { contractRead: false, needsAssignment: false, assignmentRead: false, openFatal: 0, complete: false };
  if (!appId) return out;

  const app = (await client.query(
    'SELECT is_assignment FROM applications WHERE id=$1', [appId])).rows[0] || {};
  out.needsAssignment = !!app.is_assignment;

  // A current, analyzed, readable extraction for a given doc_type on THIS file.
  const readOk = async (docType) => {
    const r = await client.query(
      `SELECT 1 FROM document_extractions ex
        WHERE ex.application_id = $1 AND ex.doc_type = $2
          AND ex.is_current = true AND ex.superseded = false
          AND ex.status = 'analyzed' AND COALESCE(ex.confidence,'') <> 'unreadable'
        LIMIT 1`, [appId, docType]);
    return !!r.rows[0];
  };

  out.contractRead = await readOk('purchase_contract');
  out.assignmentRead = out.needsAssignment ? await readOk('assignment') : true;

  // Reconciliation tie-out: no open FATAL finding from the contract/assignment review.
  const fr = await client.query(
    `SELECT count(*)::int AS n FROM document_findings f
      WHERE f.application_id = $1 AND f.status = 'open'
        AND f.severity = 'fatal' AND f.source = ANY($2)`, [appId, CONTRACT_FINDING_SOURCES]);
  out.openFatal = (fr.rows[0] && fr.rows[0].n) || 0;

  out.complete = out.contractRead && out.assignmentRead && out.openFatal === 0;
  return out;
}

/**
 * Auto-clear (or self-correct) the purchase-contract condition. Gated on
 * CONTRACT_AUTOCLEAR_ENABLED (default OFF). Never throws.
 * @returns {Promise<{enabled:boolean, satisfied:boolean, reopened:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfyContract(client, appId, itemId) {
  const out = { enabled: !!cfg.contractAutoclearEnabled, satisfied: false, reopened: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    // Only act on an actual purchase-contract condition (the rtl_p1_contract template).
    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.notes,
              COALESCE(t.code,'') AS code
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_found'; return out; }
    if (item.code !== CONTRACT_CODE) { out.reason = 'not_contract_condition'; return out; }

    const autoCleared = item.status === 'satisfied' && item.signed_off_by == null
      && String(item.notes || '').startsWith('[auto]');
    const humanSignedOff = item.status === 'satisfied' && item.signed_off_by != null;
    if (humanSignedOff) { out.reason = 'human_signed_off'; return out; }

    const c = await contractCompleteness(client, appId);
    out.complete = c.complete;

    if (c.complete) {
      if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }
      const note = '[auto] PILOT read the purchase contract on this file and its price, address, and buyer line up with the loan — condition cleared.';
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
    // (a different contract was read, or the economics on file changed and no longer
    // reconcile), reopen so a stale auto-clear can never stand. Never touches a human
    // sign-off.
    if (autoCleared) {
      const note = '[auto] The purchase contract on this file needs another look before it can be cleared — please re-check it against the loan.';
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
    console.error('[contract] maybeAutoSatisfyContract', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

/**
 * Run the auto-clear pass over the file's purchase-contract condition(s). Best-effort;
 * never throws. Call this after a purchase_contract OR assignment document has been
 * AI-read (its findings persisted) so the contract condition re-evaluates against the
 * fresh read + the current file economics.
 */
async function autoClearContractCondition(client, appId) {
  try {
    if (!cfg.contractAutoclearEnabled || !appId) return;
    const conds = await client.query(
      `SELECT ci.id
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1 AND t.code=$2`, [appId, CONTRACT_CODE]);
    for (const row of conds.rows) {
      // eslint-disable-next-line no-await-in-loop
      await maybeAutoSatisfyContract(client, appId, row.id);
    }
  } catch (e) {
    console.error('[contract] autoClearContractCondition', appId, e && e.message);
  }
}

module.exports = {
  contractCompleteness,
  maybeAutoSatisfyContract,
  autoClearContractCondition,
  CONTRACT_CODE,
  CONTRACT_FINDING_SOURCES,
};
