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
  const out = { appraisalRead: false, openFatal: 0, openFindings: 0, asIsConfirmed: false, complete: false };
  if (!appId) return out;
  try {
    const r = await client.query(
      `SELECT 1 FROM appraisals
        WHERE application_id = $1 AND superseded = false
        LIMIT 1`, [appId]);
    out.appraisalRead = !!r.rows[0];

    // MIRRORS THE GATE 1:1 (see the file header). Since 2026-08-02 the gate requires EVERY open
    // appraisal finding to be resolved, not only the fatal ones, and it counts both tables — the
    // appraisal desk's own rows and the appraisal findings the document desk stores (which now
    // render and resolve on the Appraisal page). Reading a narrower set here would make the badge
    // say "ready" on a file the gate refuses, which is the one thing this advisory must never do.
    const fr = await client.query(
      `SELECT
         (SELECT count(*)::int FROM appraisal_findings
           WHERE application_id = $1 AND status = 'open'
             AND severity = 'fatal' AND blocks_ctc = true) AS fatal,
         (SELECT count(*)::int FROM appraisal_findings
           WHERE application_id = $1 AND status = 'open') AS open_all,
         (SELECT count(*)::int FROM document_findings
           WHERE application_id = $1 AND COALESCE(status,'open') = 'open'
             AND source = ANY($2::text[])) AS desk_open`,
      [appId, require('../appraisal/finding-subject').APPRAISAL_SOURCE_LIST]);
    const c = fr.rows[0] || {};
    out.openFatal = c.fatal || 0;
    out.openFindings = (c.open_all || 0) + (c.desk_open || 0);

    // The As-Is prerequisite must mirror the sign-off gate 1:1 (owner-directed 2026-07-30;
    // post-merge audit finding #3) — otherwise the badge reads "ready" while the gate
    // refuses. Confirmed = the file carries a real As-Is value AND, when the confirm
    // condition exists, it is genuinely signed off or override-cleared (not merely made
    // optional / plain-waived). Same predicate as signOffGate's isAppraisalReview branch.
    const av = await client.query(
      `SELECT (SELECT a.as_is_value FROM applications a WHERE a.id=$1) AS as_is_value,
              EXISTS (
                SELECT 1 FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
                 WHERE ci.application_id=$1 AND t.code='appraisal_as_is_verify'
                   AND NOT (
                     (ci.signed_off_at IS NOT NULL AND ci.waived_at IS NULL)
                     OR ci.override_at IS NOT NULL
                   )
              ) AS as_is_open`, [appId]);
    const val = av.rows[0] && av.rows[0].as_is_value != null ? Number(av.rows[0].as_is_value) : null;
    out.asIsConfirmed = !(av.rows[0] && av.rows[0].as_is_open) && val != null && Number.isFinite(val) && val > 0;

    out.complete = out.appraisalRead && out.openFindings === 0 && out.asIsConfirmed;
  } catch (e) {
    console.error('[appraisal-advisory] appraisalCompleteness', appId, e && e.message);
  }
  return out;
}

/**
 * TERM SHEETS ARE HELD WHILE A FATAL APPRAISAL FINDING IS OPEN (owner-directed
 * 2026-07-31: "The fatals caused by the appraisal … it's clear to hold off CTC,
 * hold off generating term sheets"). The CTC half already exists
 * (signOffGate + advancementBlockers on appraisal_review_cleared); this is the
 * TERM-SHEET half — one reason string every issuance door consults:
 *   • POST /applications/:id/documents with docKind 'term_sheet' (the studio's
 *     register-and-attach + any manual attach) — staff AND borrower routes;
 *   • the borrower "your terms are ready" email on (re-)register (withheld,
 *     exactly like a needs-approval manual product's);
 *   • the in-file studio's own Download-PDF button (the reason travels to the
 *     tool as window.TS_ISSUE_HOLD via GET /pricing → TermSheetStudio).
 *
 * Deliberately NARROWER than the CTC gate: a file with NO imported appraisal is
 * NOT held — the initial term sheet before the appraisal comes back is the
 * normal flow. Only an appraisal PILOT actually read, with an open fatal
 * blocks_ctc finding, holds issuance. The DocuSign package was already held
 * transitively (esign gate → appraisal_review_cleared). Fails OPEN (an error
 * returns null): a DB blip must never stop a term sheet by itself — the
 * enforced sign-off gate is the real control.
 * Kill switch: the same APPRAISAL_FINDINGS_ENFORCE=0 that lifts the CTC gate.
 */
async function appraisalTermSheetHold(client, appId) {
  try {
    if (!appId) return null;
    if (!require('./advisory-policy').appraisalReviewEnforced()) return null;
    const fr = await client.query(
      `SELECT count(*)::int AS n FROM appraisal_findings
        WHERE application_id = $1 AND status = 'open'
          AND severity = 'fatal' AND blocks_ctc = true`, [appId]);
    const n = (fr.rows[0] && fr.rows[0].n) || 0;
    if (n > 0) {
      return `Term sheets are on hold for this file: ${n} fatal appraisal finding${n === 1 ? '' : 's'} `
        + `${n === 1 ? 'is' : 'are'} still open. Resolve ${n === 1 ? 'it' : 'them'} in the Appraisal section first.`;
    }
    return null;
  } catch (e) {
    console.error('[appraisal-advisory] appraisalTermSheetHold', appId, e && e.message);
    return null;
  }
}

module.exports = { appraisalCompleteness, appraisalTermSheetHold };
