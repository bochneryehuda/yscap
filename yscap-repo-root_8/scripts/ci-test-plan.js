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
const {
  scopeFor, stepRuns, loadDepMap, impactedTests, stepRunsImpacted, isAlwaysFull,
} = require('./ci-scope');

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

  const steps = allSteps();

  // TWO SELECTORS, TRIED CHEAPEST-AND-MOST-CERTAIN FIRST.
  //
  // 1. Is the change provably Long-Term-only? That answer comes from the
  //    separation law, which CI re-proves on every run, so it needs no
  //    measurement and cannot go stale.
  // 2. Otherwise, ask the measured impact map which tests can reach these
  //    files. Anything it cannot answer confidently falls through to the whole
  //    suite — the map may only ever ADD a test, never excuse one.
  const decision = scopeFor(changed);
  let plan, how;

  // THE SELECTOR MAY NEVER BE USED TO SKIP TESTING A CHANGE TO THE SELECTOR.
  // `ci-scope.js` says exactly that in its header and `scopeFor` honours it —
  // it returns `everything` with the reason "…always runs the whole suite" for
  // its own files, the workflow and `package.json`. THIS FUNCTION USED TO THROW
  // THAT VERDICT AWAY: the `everything` answer was acted on only in the final
  // `else`, which is reached solely when the changed list is empty, so an
  // ALWAYS_FULL path fell straight through into the impact map. Measured: a
  // pull request whose only change was this 925-step `test` chain ran TEN
  // steps. The two paths that appeared to be safe (`package-lock.json`, the
  // workflow) escaped by accident — the map simply had no record of them — and
  // that escape would close the day it did.
  //
  // A hand-audited exemption is worth nothing if the code below it does not
  // read the answer, so the verdict is now honoured before anything else.
  const alwaysFull = Array.isArray(changed) ? changed.find(isAlwaysFull) : null;

  if (alwaysFull) {
    plan = steps;
    how = `everything — ${alwaysFull} always runs the whole suite`;
  } else if (decision.scope === 'long_term_only') {
    plan = steps.filter((s) => stepRuns(s, decision.scope));
    how = `long-term only — ${decision.reason}`;
  } else if (Array.isArray(changed) && changed.length) {
    const files = changed.map((s) => String(s).trim()).filter(Boolean);
    const map = loadDepMap(fs, path, __dirname);
    const today = new Date().toISOString().slice(0, 10);
    const impact = impactedTests(files, map, today);
    if (impact.ok) {
      plan = steps.filter((s) => stepRunsImpacted(s, impact.tests, impact.measured));
      how = `impacted only — ${impact.reason}`;
    } else {
      plan = steps;
      how = `everything — ${impact.reason}`;
    }
  } else {
    plan = steps;
    how = `everything — ${decision.reason}`;
  }

  console.log(`[ci-plan] ${how}`);
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
