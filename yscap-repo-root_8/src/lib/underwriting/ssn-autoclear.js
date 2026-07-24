'use strict';
/**
 * SSN-verification condition auto-clear — CorrFirst only (IG-W4, owner-directed 2026-07-24).
 *
 * The owner's wiring instruction for the "SSN verification" condition (CorrFirst
 * cond 1050 → rtl_p1_ssn): when the note buyer is CorrFirst, the borrower's SSN is
 * verified "via the credit report (if no other SSN is listed and the report is
 * verified)". So once PILOT has imported a credit report whose SSN matches the SSN
 * on file for the borrower, the SSN condition can clear on its own. Never a
 * false-clear.
 *
 * SCOPE — CorrFirst ONLY. This is a note-buyer-specific guideline: only a file whose
 * note buyer (applications.lender) normalizes to `corrfirst` is ever auto-cleared.
 * Every other note buyer (or a blank one) is left for a human — the condition still
 * means "SSN collected & saved", and other buyers verify it their own way.
 *
 * "Verified off the credit report on THIS file" is a strict, provable state, not a
 * guess. For each borrower the SSN condition covers:
 *   - the borrower has a `ssn_last4` on file (the collected SSN), AND
 *   - a COMPLETED `credit_reports` row exists for THAT borrower (borrower_id) whose
 *     parsed report SSN last-4 (`parsed->'borrower'->>'ssnLast4'`) EQUALS the file
 *     `ssn_last4` — i.e. the bureau's report names the same person's SSN.
 * A report that names a DIFFERENT last-4 (the FICO-mismatch signal) never verifies;
 * a borrower with no SSN on file, or no credit report, is not verified.
 *
 * The rtl_p1_ssn condition is application-scoped (one task per file), so it covers
 * EVERY borrower on the file — the primary and, when present, the co-borrower. Every
 * covered borrower must be verified before it clears (a co-borrower whose report
 * hasn't been pulled holds it open).
 *
 * `maybeAutoSatisfySsn(client, appId, itemId)` is SYMMETRIC and only ever touches a
 * SYSTEM auto-clear (an `[auto]` note with `signed_off_by` NULL — a human sign-off is
 * never touched):
 *   - complete + not-yet-cleared  → clear it (system sign-off, `[auto]` note);
 *   - a prior auto-clear that is NO LONGER complete (the note buyer changed away from
 *     CorrFirst, the SSN on file changed, or a co-borrower was added without a report)
 *     → REOPEN it to 'received'.
 * So a change that undoes the verification self-corrects — it can never leave a stale
 * clear standing. Gated on `SSN_AUTOCLEAR_ENABLED` (default OFF), best-effort, never
 * throws.
 */
const cfg = require('../../config');
const { normNoteBuyer } = require('../conditions/field-registry');
const { enqueueChecklistStatusPush } = require('../../clickup/enqueue');

const SSN_TEMPLATE_CODE = 'rtl_p1_ssn';
const CORRFIRST_KEY = 'corrfirst';

/**
 * Is the file's note buyer CorrFirst? (The CorrFirst-only gate.)
 * @returns {Promise<boolean>}
 */
async function noteBuyerIsCorrFirst(client, appId) {
  if (!appId) return false;
  const r = await client.query('SELECT lender FROM applications WHERE id=$1', [appId]);
  const row = r.rows[0];
  return !!row && normNoteBuyer(row.lender) === CORRFIRST_KEY;
}

/**
 * Is this borrower's SSN verified off the credit report ON THIS FILE?
 * A completed credit report for this borrower whose parsed SSN last-4 equals the
 * borrower's on-file ssn_last4. Both must be present and equal.
 * @returns {Promise<boolean>}
 */
async function ssnVerifiedForBorrower(client, appId, borrowerId) {
  if (!appId || !borrowerId) return false;
  const r = await client.query(
    `SELECT 1
       FROM borrowers b
       JOIN credit_reports cr ON cr.borrower_id = b.id AND cr.application_id = $2
        AND cr.status = 'completed'
      WHERE b.id = $1
        AND b.ssn_last4 IS NOT NULL
        AND (cr.parsed -> 'borrower' ->> 'ssnLast4') IS NOT NULL
        AND (cr.parsed -> 'borrower' ->> 'ssnLast4') = b.ssn_last4
      LIMIT 1`, [borrowerId, appId]);
  return !!r.rows[0];
}

/**
 * Which borrowers the SSN condition covers, and whether each is verified off the
 * credit report. Gated on the note buyer being CorrFirst.
 * @returns {Promise<{corrfirst:boolean, need:string[], unverified:string[], complete:boolean}>}
 */
async function ssnCompleteness(client, appId) {
  const corrfirst = await noteBuyerIsCorrFirst(client, appId);
  if (!corrfirst) return { corrfirst: false, need: [], unverified: [], complete: false };

  const af = (await client.query(
    'SELECT borrower_id, co_borrower_id FROM applications WHERE id=$1', [appId])).rows[0] || {};
  const need = [];
  if (af.borrower_id) need.push(af.borrower_id);
  if (af.co_borrower_id) need.push(af.co_borrower_id);

  const unverified = [];
  for (const bid of need) {
    // eslint-disable-next-line no-await-in-loop
    const okv = await ssnVerifiedForBorrower(client, appId, bid);
    if (!okv) unverified.push(String(bid));
  }
  const complete = need.length > 0 && unverified.length === 0;
  return { corrfirst: true, need: need.map(String), unverified, complete };
}

/**
 * Auto-clear (or self-correct) the SSN-verification condition. Gated on
 * SSN_AUTOCLEAR_ENABLED (default OFF). Never throws.
 * @returns {Promise<{enabled:boolean, satisfied:boolean, reopened:boolean, complete:boolean, reason?:string}>}
 */
async function maybeAutoSatisfySsn(client, appId, itemId) {
  const out = { enabled: !!cfg.ssnAutoclearEnabled, satisfied: false, reopened: false, complete: false };
  try {
    if (!out.enabled) { out.reason = 'disabled'; return out; }
    if (!itemId) { out.reason = 'no_item'; return out; }

    // Only act on an actual SSN condition (the rtl_p1_ssn template item).
    const item = (await client.query(
      `SELECT ci.id, ci.status, ci.signed_off_at, ci.signed_off_by, ci.notes,
              COALESCE(t.code,'') AS code
         FROM checklist_items ci
         LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1 AND ci.application_id=$2
        LIMIT 1`, [itemId, appId])).rows[0];
    if (!item) { out.reason = 'not_found'; return out; }
    if (item.code !== SSN_TEMPLATE_CODE) { out.reason = 'not_ssn_condition'; return out; }

    const autoCleared = item.status === 'satisfied' && item.signed_off_by == null
      && String(item.notes || '').startsWith('[auto]');
    const humanSignedOff = item.status === 'satisfied' && item.signed_off_by != null;
    if (humanSignedOff) { out.reason = 'human_signed_off'; return out; }

    const c = await ssnCompleteness(client, appId);
    out.complete = c.complete;

    if (c.complete) {
      if (item.status === 'satisfied' && item.signed_off_at) { out.reason = 'already_satisfied'; return out; }
      const note = '[auto] PILOT matched the Social Security number on file to the imported credit report — the SSN is verified, condition cleared.';
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
    // (the note buyer changed away from CorrFirst, the SSN on file changed, or a
    // co-borrower was added without a matching report), reopen so a stale
    // auto-clear can never stand. Never touches a human sign-off.
    if (autoCleared) {
      const note = '[auto] The Social Security number can no longer be confirmed from the credit report on file — please re-check it.';
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
    console.error('[ssn] maybeAutoSatisfySsn', appId, itemId, e && e.message);
    out.reason = 'error';
    return out;
  }
}

/**
 * Run the auto-clear pass over the file's SSN condition (rtl_p1_ssn). Best-effort;
 * never throws. Call this after a credit report has been imported for the file.
 * Early-returns before any query when the env flag is off.
 */
async function autoClearSsnCondition(client, appId) {
  try {
    if (!cfg.ssnAutoclearEnabled || !appId) return;
    const conds = await client.query(
      `SELECT ci.id
         FROM checklist_items ci
         JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.application_id=$1 AND t.code=$2`, [appId, SSN_TEMPLATE_CODE]);
    for (const row of conds.rows) {
      // eslint-disable-next-line no-await-in-loop
      await maybeAutoSatisfySsn(client, appId, row.id);
    }
  } catch (e) {
    console.error('[ssn] autoClearSsnCondition', appId, e && e.message);
  }
}

module.exports = {
  noteBuyerIsCorrFirst, ssnVerifiedForBorrower, ssnCompleteness,
  maybeAutoSatisfySsn, autoClearSsnCondition, SSN_TEMPLATE_CODE,
};
