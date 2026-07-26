'use strict';
/**
 * Pipeline V2 (owner-directed 2026-07-26) — VSLICE-5 stage manifest + fail-closed gate
 * (src/pipeline/stage-manifest.js). Pure: no DB, no network.
 *
 * Proves: a shadow job needs only intake+route_plan; a READ job also needs ocr_layout to have
 * COMPLETED (a not_applicable/failed/missing read → incomplete → fail closed — the "completed but
 * nothing was read" defect); classification is never required (not yet wired); never throws; fails
 * closed on garbage.
 */
const R = require('path').resolve(__dirname, '..');
const SM = require(R + '/src/pipeline/stage-manifest');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(function main() {
  // ---- shadow mode: intake + route_plan complete → complete; ocr_layout not required ----
  {
    const r = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'not_applicable' },
      { stage_key: 'classification', status: 'not_applicable' },
      { stage_key: 'page_disposition', status: 'completed' },
    ], { mode: 'shadow' });
    ok(r.complete === true, 'shadow: intake+route_plan completed → complete (ocr not required)');
    ok(r.mode === 'shadow', 'mode echoed');
  }

  // ---- shadow mode: route_plan missing → incomplete (fail closed) ----
  {
    const r = SM.evaluateManifest([{ stage_key: 'intake', status: 'completed' }], { mode: 'shadow' });
    ok(r.complete === false && r.missing.includes('route_plan'), 'shadow: missing route_plan → incomplete');
  }

  // ---- READ mode: the read MUST have completed ----
  {
    const done = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' },
      { stage_key: 'evidence', status: 'completed' },
      { stage_key: 'classification', status: 'pending' },
      { stage_key: 'page_disposition', status: 'completed' },
    ], { mode: 'read' });
    ok(done.complete === true, 'read: ocr_layout + evidence completed → complete (classification pending is not required)');

    // ---- RS-1: reading a document and recording NOTHING is not a completed job ----
    // The evidence write used to sit inside a swallow-everything catch, so a failed or empty
    // recording was invisible and the job still reported clean. It is a required stage now.
    const readNoEvidence = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' },
      { stage_key: 'evidence', status: 'failed' },
    ], { mode: 'read' });
    ok(readNoEvidence.complete === false,
      'read: a successful read that recorded NO evidence is INCOMPLETE — the job has no result to report');
    ok(readNoEvidence.incomplete.some((x) => x.stage === 'evidence'),
      'and the evidence stage is the one named as incomplete');

    const readEvidenceThrew = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' },
      { stage_key: 'evidence', status: 'failed_retryable' },
    ], { mode: 'read' });
    ok(readEvidenceThrew.complete === false, 'read: an evidence write that threw is also incomplete');

    const readEvidenceMissing = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' },
    ], { mode: 'read' });
    ok(readEvidenceMissing.complete === false && readEvidenceMissing.missing.includes('evidence'),
      'read: no evidence row at all → missing → incomplete (never silently complete)');

    // SHADOW must NOT require it — there is no read to turn into evidence, and requiring it would
    // fail every shadow job, the same mistake as requiring the not-yet-wired classifier.
    const shadowNoEvidence = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'not_applicable' },
      { stage_key: 'evidence', status: 'not_applicable' },
    ], { mode: 'shadow' });
    ok(shadowNoEvidence.complete === true, 'shadow: a planned job with no read and no evidence is still complete');

    const notRead = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'not_applicable' },
    ], { mode: 'read' });
    ok(notRead.complete === false, 'read: ocr_layout not_applicable → INCOMPLETE (nothing was read → fail closed)');
    ok(notRead.incomplete.some((x) => x.stage === 'ocr_layout' && x.status === 'not_applicable'), 'read: ocr_layout flagged incomplete with its status');

    const failedRead = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'failed_retryable' },
    ], { mode: 'read' });
    ok(failedRead.complete === false, 'read: ocr_layout failed → incomplete');

    const missingRead = SM.evaluateManifest([
      { stage_key: 'intake', status: 'completed' },
      { stage_key: 'route_plan', status: 'completed' },
    ], { mode: 'read' });
    ok(missingRead.complete === false && missingRead.missing.includes('ocr_layout'), 'read: no ocr_layout row → missing → incomplete');
  }

  // ---- required-stage sets ----
  ok(SM.requiredStages('read').includes('evidence') && !SM.requiredStages('shadow').includes('evidence'),
    'evidence is required in read mode and not in shadow mode');
  ok(SM.requiredStages('read').includes('ocr_layout') && !SM.requiredStages('shadow').includes('ocr_layout'),
    'ocr_layout required in read mode, not in shadow');
  /* RS-2 (revised after audit) — `classification` must be RECORDED, not necessarily SUCCESSFUL.
     Requiring it to reach 'completed' dead-lettered a document whose OCR read AND evidence write had
     both succeeded, just because the classifier could not place it — and since `enqueue` adopts the
     existing job for a document, that record stayed dead even after the model was retrained. An
     advisory stage's verdict must never throw away a good read. */
  ok(!SM.requiredStages('read').includes('classification'),
    'classification is not in the must-COMPLETE set');
  ok(SM.requiredPresentStages('read').includes('classification'),
    'classification IS in the must-be-RECORDED set for a real read');
  ok(!SM.requiredPresentStages('shadow').includes('classification'),
    'shadow mode requires nothing of classification — there was no read to classify');
  {
    const base = [
      { stage_key: 'intake', status: 'completed' }, { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' }, { stage_key: 'evidence', status: 'completed' },
      // RS-3: page_disposition is required-PRESENT too, so it has to be here for these cases to be
      // about classification's verdict rather than about a second missing stage.
      { stage_key: 'page_disposition', status: 'completed' },
    ];
    for (const st of ['failed_terminal', 'failed_retryable', 'not_applicable']) {
      const r = SM.evaluateManifest(base.concat([{ stage_key: 'classification', status: st }]), { mode: 'read' });
      ok(r.complete === true, `a classification recorded '${st}' does NOT fail a job whose read + evidence succeeded`);
      ok(r.advisory.some((a) => a.stage === 'classification' && a.status === st),
        `and '${st}' is reported as ADVISORY, so the surface can show it`);
    }
    const done = SM.evaluateManifest(base.concat([{ stage_key: 'classification', status: 'completed' }]), { mode: 'read' });
    ok(done.complete === true && done.advisory.length === 0, 'a completed classification raises no advisory');
    // The dark-code case the gate exists for: the stage never ran at all.
    const never = SM.evaluateManifest(base, { mode: 'read' });
    ok(never.complete === false && never.missing.includes('classification'),
      'a classification that was NEVER RECORDED still fails the job closed — that is the defect this gate is for');
  }
  ok(SM.requiredStages('bogus').join() === SM.requiredStages('shadow').join(), 'unknown mode defaults to shadow required set');

  // ---- accepts a plain {key:status} map ----
  {
    const r = SM.evaluateManifest({ intake: 'completed', route_plan: 'completed' }, { mode: 'shadow' });
    ok(r.complete === true, 'accepts a {key:status} map');
  }

  /* ---- RS-3: page_disposition sits on the required-PRESENT tier -------------------------------
     Same shape as classification, for the same reason plus one: the failure this stage exists to
     catch is a page nobody mentioned, so the stage NOT BEING RECORDED is precisely the defect —
     while its VERDICT ('a person has pages to place') must never throw away a paid-for read. */
  {
    ok(!SM.requiredStages('read').includes('page_disposition'),
      'page_disposition is not in the must-COMPLETE set — a page needing a human is not a failed job');
    ok(SM.requiredPresentStages('read').includes('page_disposition'),
      'page_disposition IS in the must-be-RECORDED set for a real read');
    ok(!SM.requiredPresentStages('shadow').includes('page_disposition'),
      'shadow mode requires nothing of it — there was no read, so there were no pages');

    const base = [
      { stage_key: 'intake', status: 'completed' }, { stage_key: 'route_plan', status: 'completed' },
      { stage_key: 'ocr_layout', status: 'completed' }, { stage_key: 'evidence', status: 'completed' },
      { stage_key: 'classification', status: 'completed' },
    ];
    const manual = SM.evaluateManifest(base.concat([{ stage_key: 'page_disposition', status: 'manual_required' }]), { mode: 'read' });
    ok(manual.complete === true,
      "a packet with pages awaiting a person still COMPLETES — the read and the evidence are good work");
    ok(manual.advisory.some((a) => a.stage === 'page_disposition' && a.status === 'manual_required'),
      'and it is surfaced as an advisory so the shadow screen can show the pages owed');

    const na = SM.evaluateManifest(base.concat([{ stage_key: 'page_disposition', status: 'not_applicable' }]), { mode: 'read' });
    ok(na.complete === true, "not-applicable (nothing to account for) does not fail the job either");

    const never = SM.evaluateManifest(base, { mode: 'read' });
    ok(never.complete === false && never.missing.includes('page_disposition'),
      'but a page accounting that NEVER RAN fails the job closed — a silently unaccounted packet is the defect');
  }

  // ---- never throws / fails closed on garbage ----
  ok(SM.evaluateManifest(null, { mode: 'read' }).complete === false, 'null stages → not complete (no throw)');
  ok(SM.evaluateManifest('x').complete === false, 'garbage stages → not complete');
  ok(SM.evaluateManifest([null, 5, {}]).complete === false, 'garbage rows → not complete');

  console.log(`test-stage-manifest-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
