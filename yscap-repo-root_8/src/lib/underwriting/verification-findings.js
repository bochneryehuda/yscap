'use strict';
/**
 * #193 — Independent VERIFICATION → whole-loan run findings (AVM connector first).
 *
 * The independent-verification stack (AVM consensus, and later bank/entity/
 * property/fraud sources) computes signals but nothing carried them INTO the
 * whole-loan decision loop (run.js): a material AVM-vs-appraisal disagreement
 * lived only in document_findings / the cockpit tile, never in the immutable run
 * registry the underwriter reviews as the single decision record. This module is
 * the bridge: it turns a verification report into a run-finding shaped exactly
 * like every other desk's finding, so the whole-loan run surfaces it in ONE
 * registry.
 *
 * ADVISORY ONLY. Every finding produced here is NON-blocking (blocks_term_sheet/
 * ctc/funding all false) — an independent-source disagreement is a signal for a
 * human to review (order a desk review, a second appraisal, or resize), never an
 * automatic decision. The frozen engine + the human stay the authority.
 *
 * Split so the mapping is testable without a DB:
 *   • avmFindingFromReport(report)          PURE — report → finding | null.
 *   • gatherVerificationFindings(appId, db) best-effort DB — reads the AVM
 *     consensus report and maps it; catches everything (verification must NEVER
 *     break or block a run). Returns [] on any error / no data.
 */

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `$${Math.round(v).toLocaleString('en-US')}` : null;
}

/**
 * avmFindingFromReport(report) → a run finding for a MATERIAL AVM-vs-appraisal
 * disagreement, or null when there is no material disagreement / not enough data.
 * `report` is the shape avm-consensus.analyzeFileARV returns:
 *   { consensus:{median,...}, appraisal:{value}, comparison:{disagrees,message}, thresholdPct }
 * PURE, never throws.
 */
function avmFindingFromReport(report) {
  try {
    if (!report || !report.comparison || report.comparison.disagrees !== true) return null;
    const c = report.comparison;
    const median = money(report.consensus && report.consensus.median);
    const arv = money(report.appraisal && report.appraisal.value);
    const pct = Math.round((Number(report.thresholdPct) || 0.10) * 100);
    return {
      code: 'avm_consensus_disagreement',
      subject: 'appraisal.arv',
      severity: 'warning',                 // advisory — see blocks_* below
      category: 'verification',
      title: 'AVM consensus disagrees with the appraisal ARV',
      explanation: (c.message && String(c.message))
        || 'Independent AVMs disagree materially with the appraisal ARV.',
      source: 'avm_consensus',
      governing_rule: `AVM median within ${pct}% of the appraisal ARV`,
      expected_value: arv,                 // the appraisal's ARV
      actual_value: median,                // the independent AVM median
      // ADVISORY: an independent-source disagreement is a review signal, never an
      // automatic block. A human orders a desk review / second appraisal / resize.
      blocks_term_sheet: false,
      blocks_ctc: false,
      blocks_funding: false,
      permitted_actions: ['order_desk_review', 'order_second_appraisal', 'acknowledge'],
    };
  } catch (_e) { return null; }
}

/**
 * gatherVerificationFindings(applicationId, db) → [finding] — the independent-
 * verification findings for one file, mapped into run-finding shape. Best-effort:
 * ANY error (missing table, no appraisal observations, connector failure) yields
 * [] so a run is never broken or blocked by the verification layer. Read-only.
 *
 * Today: AVM consensus. New verification sources (bank ownership, entity, fraud)
 * add another guarded block here and return their own non-blocking finding(s).
 */
async function gatherVerificationFindings(applicationId, db) {
  const out = [];
  if (!applicationId) return out;
  // AVM consensus (kind='avm'): the appraisal ARV vs the independent AVM median.
  try {
    const avm = require('./avm-consensus');
    const report = await avm.analyzeFileARV(applicationId, db);
    const finding = avmFindingFromReport(report);
    if (finding) out.push(finding);
  } catch (_e) { /* best-effort — verification never breaks or blocks a run */ }
  return out;
}

module.exports = { avmFindingFromReport, gatherVerificationFindings, _internals: { money } };
