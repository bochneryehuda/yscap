'use strict';
/**
 * R5.43 — Underwriting error taxonomy (the 20 primary causes).
 *
 * Every underwriter correction / QA miss is tagged with ONE primary cause (and
 * optional secondaries) from this fixed list, so learning is analyzable by
 * component and a regression fixture (R5.65) records WHICH stage failed first.
 * The taxonomy is the review's §11.2 list, ordered from earliest pipeline stage
 * to latest, so "the earliest failed component" is answerable.
 *
 * Pure: no DB, no AI. This owns the vocabulary + a validator; the correction UI
 * (frontend) and the postmortem (R5.49) both consume it.
 */

// Ordered earliest-stage → latest-stage. The order matters: a postmortem picks
// the EARLIEST failed component, and a single root fix upstream often prevents
// many downstream symptoms.
const CAUSES = Object.freeze([
  { key: 'ingestion',           stage: 1,  label: 'Ingestion / file intake' },
  { key: 'packet_boundary',     stage: 2,  label: 'Packet boundary (wrong split)' },
  { key: 'classification',      stage: 3,  label: 'Document classification' },
  { key: 'ocr',                 stage: 4,  label: 'OCR / text read' },
  { key: 'field_extraction',    stage: 5,  label: 'Field extraction' },
  { key: 'evidence_alignment',  stage: 6,  label: 'Evidence alignment (wrong span/page)' },
  { key: 'document_version',    stage: 7,  label: 'Document version / precedence' },
  { key: 'normalization',       stage: 8,  label: 'Value normalization' },
  { key: 'party_role',          stage: 9,  label: 'Party / role resolution' },
  { key: 'timing',              stage: 10, label: 'Timing / as-of resolution' },
  { key: 'fact_reconciliation', stage: 11, label: 'Fact reconciliation (twin)' },
  { key: 'guideline_selection', stage: 12, label: 'Guideline selection / version' },
  { key: 'deterministic_rule',  stage: 13, label: 'Deterministic rule' },
  { key: 'ai_reasoning',        stage: 14, label: 'AI reasoning' },
  { key: 'root_cause_clustering', stage: 15, label: 'Root-cause clustering' },
  { key: 'condition_requirement', stage: 16, label: 'Condition requirement' },
  { key: 'condition_aggregation', stage: 17, label: 'Condition aggregation' },
  { key: 'human_workflow',      stage: 18, label: 'Human / workflow' },
  { key: 'vendor_drift',        stage: 19, label: 'Vendor / API drift' },
  { key: 'new_facts_after_decision', stage: 20, label: 'New facts after decision' },
]);

const KEYS = new Set(CAUSES.map((c) => c.key));
const BY_KEY = new Map(CAUSES.map((c) => [c.key, c]));

function isValidCause(key) { return KEYS.has(key); }
function labelOf(key) { const c = BY_KEY.get(key); return c ? c.label : null; }
function stageOf(key) { const c = BY_KEY.get(key); return c ? c.stage : null; }

// Given several tagged causes, the EARLIEST-stage one is the primary suspect
// (fixing the earliest failure usually prevents the downstream ones).
function earliest(keys) {
  const valid = (keys || []).filter(isValidCause);
  if (!valid.length) return null;
  return valid.reduce((a, b) => (stageOf(a) <= stageOf(b) ? a : b));
}

/**
 * structureCorrection({ primary, secondaries, note, isException }) →
 *   a validated correction record (throws on an invalid primary cause, so a
 *   correction can never be tagged with a cause outside the taxonomy).
 */
function structureCorrection(input) {
  const i = input || {};
  if (!isValidCause(i.primary)) throw new Error(`error-taxonomy: invalid primary cause "${i.primary}"`);
  const secondaries = (i.secondaries || []).filter(isValidCause);
  return {
    primary: i.primary,
    primaryLabel: labelOf(i.primary),
    primaryStage: stageOf(i.primary),
    secondaries,
    note: i.note || null,
    // A file-specific exception is NOT a general defect — flagged so it does not
    // become a universal rule (the review's "separate exception from defect").
    isException: !!i.isException,
  };
}

module.exports = { CAUSES, KEYS, isValidCause, labelOf, stageOf, earliest, structureCorrection };
