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
 * `classification` (RS-2) is REQUIRED-PRESENT in 'read' mode, not required-completed: it must have
 * been recorded with some real outcome, but its verdict never decides whether the job's work is
 * kept. See REQUIRED_PRESENT below for why — an advisory stage that dead-letters a successful read
 * loses a good record and re-bills the vendor on every retry.
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
 * RS-2 (2026-07-26, revised after audit) — stages that must be RECORDED, but need not have SUCCEEDED.
 *
 * There are two different questions, and conflating them was a real defect:
 *   "did this stage run?"      — a stage that records nothing is invisible; that is the dark-code
 *                                failure this whole gate exists to catch.
 *   "did this stage succeed?"  — a different question, and for an ADVISORY stage the answer must
 *                                not decide whether the job's work is kept.
 *
 * The first version required `classification` to reach 'completed'. That dead-lettered a document
 * whose OCR read AND evidence write had both succeeded, because the classifier could not place it —
 * and since `enqueue` adopts the existing job for a document, that document's V2 record stayed dead
 * even after the model was retrained. It also meant a misconfigured classifier re-ran the whole
 * processor (including the already-successful, already-paid-for OCR read) on every retry.
 *
 * Classification is advisory: it tells a human what the document looks like. Its verdict must never
 * throw away a good read. So it must be PRESENT — recorded with some real outcome — and its status
 * is reported as advisory rather than gating. A stage that is present but not completed shows up in
 * `advisory` for the surface to display; a stage that was never recorded still fails the job closed.
 */
const REQUIRED_PRESENT = Object.freeze({
  shadow: [],
  read: [STAGE.CLASSIFICATION],
});

function requiredStages(mode) {
  return REQUIRED[mode] ? REQUIRED[mode].slice() : REQUIRED.shadow.slice();
}

/** Stages that must appear in the manifest with SOME outcome (see REQUIRED_PRESENT). */
function requiredPresentStages(mode) {
  return REQUIRED_PRESENT[mode] ? REQUIRED_PRESENT[mode].slice() : REQUIRED_PRESENT.shadow.slice();
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
 * @returns {{ mode, complete, required, requiredPresent, missing, incomplete, advisory, reason }}
 *   complete        = true ONLY if every required stage is present AND 'completed', AND every
 *                     required-PRESENT stage was recorded at all (with any outcome).
 *   missing         = required (or required-present) stages with no recorded row.
 *   incomplete      = required stages recorded but not 'completed' ([{stage,status}]).
 *   advisory        = required-PRESENT stages recorded with a non-completed outcome. These are
 *                     reported for the surface and do NOT make the job incomplete — an advisory
 *                     stage's verdict must never throw away a read that succeeded.
 */
function evaluateManifest(stages, opts = {}) {
  try {
    const mode = (opts && opts.mode === 'read') ? 'read' : 'shadow';
    const required = requiredStages(mode);
    const present = requiredPresentStages(mode);
    const byKey = stageStatusMap(stages);
    const missing = [];
    const incomplete = [];
    const advisory = [];
    for (const key of required) {
      if (!byKey.has(key)) { missing.push(key); continue; }
      const st = byKey.get(key);
      if (st !== 'completed') incomplete.push({ stage: key, status: st });
    }
    for (const key of present) {
      // Never recorded at all → the stage did not run, which is the defect this gate exists for.
      if (!byKey.has(key)) { missing.push(key); continue; }
      const st = byKey.get(key);
      if (st !== 'completed') advisory.push({ stage: key, status: st });
    }
    const complete = missing.length === 0 && incomplete.length === 0;
    let reason;
    if (complete) reason = 'all required stages completed';
    else if (missing.length) reason = `missing required stage(s): ${missing.join(', ')}`;
    else reason = `required stage(s) not completed: ${incomplete.map((x) => `${x.stage}=${x.status}`).join(', ')}`;
    return { mode, complete, required, requiredPresent: present, missing, incomplete, advisory, reason };
  } catch (_e) {
    // Fail CLOSED on any evaluation error — an unevaluable manifest is not "complete".
    return { mode: 'shadow', complete: false, required: requiredStages('shadow'), requiredPresent: requiredPresentStages('shadow'), missing: [], incomplete: [], advisory: [], reason: 'manifest evaluation error' };
  }
}

module.exports = { STAGE, REQUIRED, REQUIRED_PRESENT, requiredStages, requiredPresentStages, evaluateManifest, _internals: { stageStatusMap } };
