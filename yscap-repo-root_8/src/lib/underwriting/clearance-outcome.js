'use strict';
/**
 * R5.28 — Explicit clearance outcomes + aggregator.
 *
 * The cure engine (cure.js) returns per-requirement statuses (satisfied /
 * not_satisfied / unable_to_determine). The review requires an explicit
 * TOP-LEVEL clearance outcome so a condition never clears on the wrong basis:
 *
 *   cleared                 every requirement satisfied
 *   partially_cleared       some satisfied, some not (none blocking)
 *   not_cleared             no requirement satisfied
 *   wrong_document          the submitted document is the wrong type
 *   document_unreadable     the document could not be read
 *   stale_evidence          a freshness-bound requirement's evidence is expired
 *   conflicting_evidence    current authoritative evidence conflicts
 *   new_material_finding     clearing surfaced a new material issue
 *   unable_to_determine     evidence insufficient to decide
 *   admin_question_required  two plausible readings — ask a super-admin
 *
 * aggregate() applies these in PRECEDENCE so a document-level blocker (wrong
 * doc / unreadable) is never masked by a satisfied requirement. Pure: no DB,
 * no AI.
 */

const OUTCOMES = Object.freeze([
  'cleared', 'partially_cleared', 'not_cleared', 'wrong_document',
  'document_unreadable', 'stale_evidence', 'conflicting_evidence',
  'new_material_finding', 'unable_to_determine', 'admin_question_required',
]);

// Only 'cleared' actually clears the condition. Everything else keeps it open
// (each with its own next step).
const CLEARS = new Set(['cleared']);

/**
 * aggregate(requirements, signals) →
 *   requirements: [{ id, status: 'satisfied'|'not_satisfied'|'unable_to_determine' }]
 *   signals: { wrongDocument?, unreadable?, stale?, conflicting?, newMaterialFinding?,
 *              ambiguous? }   (document-level blockers, highest precedence)
 * Returns { outcome, clears, reason, unmet:[ids] }.
 */
function aggregate(requirements, signals) {
  const reqs = Array.isArray(requirements) ? requirements : [];
  const s = signals || {};

  // Precedence 1 — document-level blockers (never masked by a satisfied req).
  if (s.wrongDocument) return out('wrong_document', 'The submitted document is the wrong type for this condition.');
  if (s.unreadable) return out('document_unreadable', 'The document could not be read — request a clean copy.');

  // Precedence 2 — evidence quality.
  if (s.conflicting) return out('conflicting_evidence', 'Current authoritative evidence conflicts — resolve before clearing.');
  if (s.stale) return out('stale_evidence', 'The evidence is past its freshness window — request an updated document.');

  // Precedence 3 — clearing surfaced a new material issue.
  if (s.newMaterialFinding) return out('new_material_finding', 'A new material issue surfaced while clearing — review it first.');

  // Precedence 4 — an explicit ambiguity → ask an admin.
  if (s.ambiguous) return out('admin_question_required', 'Two plausible readings — a super-admin decision is needed.', reqs);

  // Precedence 5 — aggregate the requirement statuses.
  if (!reqs.length) return out('unable_to_determine', 'No requirements evaluated.');
  const sat = reqs.filter((r) => r.status === 'satisfied').length;
  const failed = reqs.filter((r) => r.status === 'not_satisfied');
  const undet = reqs.filter((r) => r.status === 'unable_to_determine');
  const unmet = [...failed, ...undet].map((r) => r.id).filter((x) => x != null);

  if (sat === reqs.length) return out('cleared', 'Every requirement is satisfied.');
  if (sat === 0 && failed.length && !undet.length) return out('not_cleared', 'No requirement is satisfied.', unmet);
  // Some satisfied but blocked only by unable_to_determine (no hard fail) → can't
  // decide the rest, so it's unable_to_determine (never a silent partial clear).
  if (failed.length === 0 && undet.length) return out('unable_to_determine', `Cannot determine ${undet.length} requirement(s).`, unmet);
  // A mix of satisfied + failed → partially cleared.
  return out('partially_cleared', `${sat}/${reqs.length} requirements satisfied.`, unmet);
}

function out(outcome, reason, unmet) {
  return { outcome, clears: CLEARS.has(outcome), reason, unmet: unmet || [] };
}

module.exports = { aggregate, OUTCOMES, CLEARS };
