'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-5: the full STAGE MANIFEST + fail-closed gate.
 *
 * A document-processing job records a stage manifest (document_pipeline_stages): intake →
 * route_plan → ocr_layout → classification. The owner's review flagged a real defect: the
 * job was being marked COMPLETED even when no document was actually read. This module is the
 * single source of truth for "did this job actually finish the stages it was supposed to?" —
 * and it FAILS CLOSED: a required stage that is missing or did not reach 'completed' means the
 * job is NOT complete, so it is never falsely reported as a clean run.
 *
 * PURE + never-throws. It decides completeness from the recorded stage statuses only; it makes
 * no decision about the loan, writes nothing, and touches no frozen number or borrower surface.
 *
 * MODE-AWARE required sets:
 *   - 'shadow' (no real read adapters injected): the read stages are legitimately not-applicable,
 *     so only intake + route_plan are required. A shadow job that planned a route IS complete.
 *   - 'read'   (real adapters injected → a real vendor read was attempted): the read MUST have
 *     completed. ocr_layout is required; a job whose read was skipped/failed/not-applicable is
 *     INCOMPLETE → fail closed (the "completed but nothing was read" defect).
 * `classification` (RS-2) is required in 'read' mode ONLY when the caller reports that a trained
 * classifier was actually available for the job (`classifierAvailable:true`) — see requiredStages.
 * Until the owner trains the model, no classifier is reachable, the stage records not_applicable,
 * and requiring it would fail every job for a capability the environment does not have.
 */

const STAGE = Object.freeze({
  INTAKE: 'intake',
  ROUTE_PLAN: 'route_plan',   // was mis-named 'packet_control' (defect #4): this stage PLANS the read route
  OCR_LAYOUT: 'ocr_layout',
  CLASSIFICATION: 'classification',
  EVIDENCE: 'evidence',       // RS-1: the read was turned into recorded evidence
});

// The stages that MUST reach 'completed' for a job to count as a complete run, per mode.
//
// RS-1 (2026-07-26) adds `evidence` to the READ set. Reading a document and recording nothing is
// the same defect as not reading it at all, one step later: the pipeline is evidence-first, so a
// job that produced no evidence produced no result, and reporting it 'completed' says the opposite.
// The recording used to sit inside a swallow-everything try/catch, so a failed or empty write was
// invisible and the job still completed clean. It is now a stage like any other and runs through
// this same fail-closed gate.
//
// Shadow mode does NOT require it: with no adapters injected there is no read to turn into
// evidence, and requiring it would fail every shadow job — the same mistake as requiring the
// not-yet-wired classifier.
const REQUIRED = Object.freeze({
  shadow: [STAGE.INTAKE, STAGE.ROUTE_PLAN],
  read: [STAGE.INTAKE, STAGE.ROUTE_PLAN, STAGE.OCR_LAYOUT, STAGE.EVIDENCE],
});

/**
 * RS-2 (2026-07-26) — `classification` is required WHEN A CLASSIFIER WAS ACTUALLY AVAILABLE, and
 * only then. This is the same shape as `read` mode itself: `read` is not a setting, it is the fact
 * that real adapters were injected, and a job is held to what it was actually equipped to do.
 *
 * Both alternatives are wrong. Requiring it unconditionally would fail every job in an environment
 * where the owner has not trained the Azure classifier yet — the mistake the original code warned
 * about. Never requiring it re-creates the defect this whole gate exists for: the stage could fail
 * on every document forever and the job would still report a clean run, which is exactly how
 * classification sat recording "not yet wired" long after a classifier existed.
 *
 * So the CAPABILITY is reported by the caller (was a trained classifier reachable for this job?) and
 * the RULE stays here, with the rest of the manifest. Callers report facts; this module decides.
 */
function requiredStages(mode, opts = {}) {
  const base = REQUIRED[mode] ? REQUIRED[mode].slice() : REQUIRED.shadow.slice();
  const isRead = REQUIRED[mode] === REQUIRED.read;
  if (isRead && opts && opts.classifierAvailable === true && !base.includes(STAGE.CLASSIFICATION)) {
    base.push(STAGE.CLASSIFICATION);
  }
  return base;
}

// Normalize a mixed list of stage rows ([{stage_key|stage, status}] or a plain {key:status} map)
// into a Map(key -> status). Tolerant of any shape; unknown → empty map.
function stageStatusMap(stages) {
  const m = new Map();
  if (Array.isArray(stages)) {
    for (const s of stages) {
      if (!s || typeof s !== 'object') continue;
      const key = s.stage_key != null ? s.stage_key : s.stage;
      if (key == null) continue;
      m.set(String(key), s.status == null ? null : String(s.status));
    }
  } else if (stages && typeof stages === 'object') {
    for (const key of Object.keys(stages)) m.set(String(key), stages[key] == null ? null : String(stages[key]));
  }
  return m;
}

/**
 * PURE — evaluate the recorded stages against the mode's required manifest. FAILS CLOSED.
 * @param {Array|object} stages  the recorded stage rows (or a {key:status} map)
 * @param {object} opts          { mode: 'shadow'|'read' } (default 'shadow')
 * @returns {{ mode, complete, required, missing, incomplete, reason }}
 *   complete   = true ONLY if every required stage is present AND its status === 'completed'.
 *   missing    = required stages with no recorded row.
 *   incomplete = required stages recorded but not 'completed' ([{stage,status}]).
 */
function evaluateManifest(stages, opts = {}) {
  try {
    const mode = (opts && opts.mode === 'read') ? 'read' : 'shadow';
    const required = requiredStages(mode, { classifierAvailable: !!(opts && opts.classifierAvailable) });
    const byKey = stageStatusMap(stages);
    const missing = [];
    const incomplete = [];
    for (const key of required) {
      if (!byKey.has(key)) { missing.push(key); continue; }
      const st = byKey.get(key);
      if (st !== 'completed') incomplete.push({ stage: key, status: st });
    }
    const complete = missing.length === 0 && incomplete.length === 0;
    let reason;
    if (complete) reason = 'all required stages completed';
    else if (missing.length) reason = `missing required stage(s): ${missing.join(', ')}`;
    else reason = `required stage(s) not completed: ${incomplete.map((x) => `${x.stage}=${x.status}`).join(', ')}`;
    return { mode, complete, required, missing, incomplete, reason };
  } catch (_e) {
    // Fail CLOSED on any evaluation error — an unevaluable manifest is not "complete".
    return { mode: 'shadow', complete: false, required: requiredStages('shadow'), missing: [], incomplete: [], reason: 'manifest evaluation error' };
  }
}

module.exports = { STAGE, REQUIRED, requiredStages, evaluateManifest, _internals: { stageStatusMap } };
