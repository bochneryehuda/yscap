'use strict';

// =============================================================================
// CI TEST PLAN — run the steps this change actually needs, and prove it.
// =============================================================================
//
// `npm test` IS NOT TOUCHED BY ANY OF THIS. It is still the same 892-step
// chain it has always been, it is still what runs on a push to main, and it is
// still what gates the deploy. This runner is an ADDITION used on pull requests
// only, so that a Long-Term change does not have to carry the whole short-term
// suite (owner-directed 2026-08-16).
//
// That split is the safety property, and it is the one a safety-critical
// standard insists on: SELECTION DECIDES WHAT RUNS ON A PULL REQUEST, NEVER
// WHAT RUNS BEFORE A DEPLOY. Nothing ever goes unrun — a step skipped here is
// still run on main before anything is published.
//
// THE STEP LIST IS READ FROM `package.json`'s OWN `test` SCRIPT — never
// re-typed, never maintained separately. A second hand-kept list is how a test
// silently stops running, so there isn't one: if a step is added to `npm test`
// it is automatically known here, and `test-ci-scope-pure.js` asserts that the
// two agree.
//
// Usage:
//   node scripts/ci-test-plan.js --changed-from <file>   # one path per line
//   node scripts/ci-test-plan.js --list                  # print the plan, run nothing
// With no changed-file list it runs EVERYTHING, which is the safe default for a
// developer typing it by hand.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { scopeFor, stepRuns } = require('./ci-scope');

/** Every step of `npm test`, in order, exactly as package.json declares them. */
function allSteps() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const script = (pkg.scripts && pkg.scripts.test) || '';
  return script.split('&&').map((s) => s.trim()).filter(Boolean);
}

function readChangedFiles(file) {
  // A list we cannot read is not evidence of anything — scopeFor(null) answers
  // 'everything', which is what we want.
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.log(`[ci-plan] could not read ${file} (${e.message}) — running everything`);
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  const listOnly = argv.includes('--list');
  const i = argv.indexOf('--changed-from');
  const changed = i >= 0 && argv[i + 1] ? readChangedFiles(argv[i + 1]) : null;

  const decision = scopeFor(changed);
  const steps = allSteps();
  const plan = steps.filter((s) => stepRuns(s, decision.scope));

  console.log(`[ci-plan] scope: ${decision.scope} — ${decision.reason}`);
  console.log(`[ci-plan] running ${plan.length} of ${steps.length} step(s)`);

  // A selector that silently selected nothing would report a green build having
  // tested nothing at all. It cannot happen — ALWAYS_RUN_STEPS is non-empty —
  // but "cannot happen" is exactly what this guard is for.
  if (!plan.length) {
    console.error('[ci-plan] the plan is empty — refusing to report a pass on nothing');
    process.exit(1);
  }
  if (listOnly) { plan.forEach((s) => console.log('  ' + s)); return; }

  const failed = [];
  for (const step of plan) {
    const r = spawnSync(step, { shell: true, stdio: 'inherit', cwd: path.join(__dirname, '..') });
    if (r.status !== 0) {
      failed.push(step);
      // Match `npm test`'s own behaviour: the `&&` chain stops at the first
      // failure, so this does too. Same signal, same place.
      break;
    }
  }

  if (failed.length) {
    console.error(`[ci-plan] FAILED: ${failed[0]}`);
    process.exit(1);
  }
  console.log(`[ci-plan] all ${plan.length} step(s) passed`);
}

if (require.main === module) main();

module.exports = { allSteps };
