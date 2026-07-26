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
      { stage_key: 'classification', status: 'pending' },
    ], { mode: 'read' });
    ok(done.complete === true, 'read: ocr_layout completed → complete (classification pending is not required)');

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
  ok(SM.requiredStages('read').includes('ocr_layout') && !SM.requiredStages('shadow').includes('ocr_layout'),
    'ocr_layout required in read mode, not in shadow');
  ok(!SM.requiredStages('read').includes('classification'), 'classification is not required (not yet wired)');
  ok(SM.requiredStages('bogus').join() === SM.requiredStages('shadow').join(), 'unknown mode defaults to shadow required set');

  // ---- accepts a plain {key:status} map ----
  {
    const r = SM.evaluateManifest({ intake: 'completed', route_plan: 'completed' }, { mode: 'shadow' });
    ok(r.complete === true, 'accepts a {key:status} map');
  }

  // ---- never throws / fails closed on garbage ----
  ok(SM.evaluateManifest(null, { mode: 'read' }).complete === false, 'null stages → not complete (no throw)');
  ok(SM.evaluateManifest('x').complete === false, 'garbage stages → not complete');
  ok(SM.evaluateManifest([null, 5, {}]).complete === false, 'garbage rows → not complete');

  console.log(`test-stage-manifest-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
