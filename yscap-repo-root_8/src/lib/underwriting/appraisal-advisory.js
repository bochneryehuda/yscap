'use strict';
/**
 * Appraisal-review condition ADVISORY signal (IG-W11, owner-directed 2026-07-24).
 *
 * The "Appraisal review cleared" condition (appraisal_review_cleared) is the clear-to-close
 * gate for PILOT's appraisal findings engine. PILOT NEVER signs this condition off itself —
 * a human always clears a Condition Center condition (the owner-directed reversal). Instead
 * PILOT lays an ADVISORY on top of the human layer (pilot-advice-engine), telling the
 * underwriter whether the appraisal has been read and reads clean. Advisory only — this
 * clears nothing and blocks nothing.
 *
 * "PILOT has confirmed the appraisal" is the SAME strict, provable state the sign-off gate
 * uses (staff.js signOffGate, isAppraisalReview branch), reused here 1:1 so the advisory can
 * never disagree with the gate:
 *   - a CURRENT appraisal exists for THIS application (a non-superseded `appraisals` row) —
 *     i.e. PILOT actually read + imported the appraisal on this file; AND
 *   - there is ZERO open FATAL appraisal finding that blocks CTC (`appraisal_findings`
 *     status='open' severity='fatal' blocks_ctc=true) — wrong property, value below
 *     purchase, expired license, C6/Q6 condition, stale effective date, flood-zone
 *     mismatch, … — which is exactly what would make a human revisit a cleared appraisal.
 *
 * So "ready" only ever fires once the appraisal is actually read + clean; a missing or
 * unread appraisal advises "not ready" (never a false "ready"). Unlike experience, appraisal
 * DOES support DISPUTE: an open fatal appraisal finding is POSITIVE contradicting evidence,
 * so a signed-off appraisal condition with an open fatal → 'dispute'. Never throws.
 */

// The appraisal review's finding table is `appraisal_findings` (the desk table the human
// gate reads) — NOT document_findings and NOT underwriting_run_findings. Reading the SAME
// table + predicate the gate reads is what guarantees the advisory never disagrees with it.
async function appraisalCompleteness(client, appId) {
  const out = { appraisalRead: false, openFatal: 0, complete: false };
  if (!appId) return out;
  try {
    const r = await client.query(
      `SELECT 1 FROM appraisals
        WHERE application_id = $1 AND superseded = false
        LIMIT 1`, [appId]);
    out.appraisalRead = !!r.rows[0];

    const fr = await client.query(
      `SELECT count(*)::int AS n FROM appraisal_findings
        WHERE application_id = $1 AND status = 'open'
          AND severity = 'fatal' AND blocks_ctc = true`, [appId]);
    out.openFatal = (fr.rows[0] && fr.rows[0].n) || 0;

    out.complete = out.appraisalRead && out.openFatal === 0;
  } catch (e) {
    console.error('[appraisal-advisory] appraisalCompleteness', appId, e && e.message);
  }
  return out;
}

module.exports = { appraisalCompleteness };
