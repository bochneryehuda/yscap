'use strict';

// =============================================================================
// The CI test selector is itself tested — because a tool that decides which
// tests to skip is a way for a defect to reach production, and a wrong decision
// here is INVISIBLE (it shows up as a green build that tested less than it
// claimed). Safety-critical practice is explicit about this: a tool whose
// output justifies reducing verification has to be qualified itself.
//
// Every assertion below was mutation-proven — the production rule was broken
// and this suite was confirmed to go red — so none of them is decoration.
// No database, no network. In `npm test`.
// =============================================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { scopeFor, stepRuns, _internals } = require('./ci-scope');
const { allSteps } = require('./ci-test-plan');

// Every rule in ci-scope.js is exercised where nothing else can mask it — see
// section D, whose first cut passed for the wrong reason until mutation testing
// exposed it. If you add a rule there, test it at the unit level too.

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n++; };
const eq = (a, b, msg) => { assert.strictEqual(a, b, msg); n++; };

const LT = 'yscap-repo-root_8/src/longterm/pipeline.js';
const LT_FE = 'yscap-repo-root_8/app-v2/src/longterm/LtPipeline.jsx';
const LT_DOC = 'yscap-repo-root_8/docs/longterm/LOS-MASTER-PLAN.md';
const LT_MIG = 'yscap-repo-root_8/db/549_lt_loan_application.sql';
const LT_TEST = 'yscap-repo-root_8/scripts/test-lt-investor-block.js';
const RTL = 'yscap-repo-root_8/src/routes/staff.js';

// ---------------------------------------------------------------------------
// A. It says long-term-only ONLY when it can prove it
// ---------------------------------------------------------------------------
eq(scopeFor([LT]).scope, 'long_term_only', 'a long-term back-end file alone is long-term-only');
eq(scopeFor([LT, LT_FE, LT_DOC, LT_MIG, LT_TEST]).scope, 'long_term_only',
  'all five long-term shapes together are still long-term-only');

// ---------------------------------------------------------------------------
// B. Everything else is `everything` — the whole point of the module
// ---------------------------------------------------------------------------
eq(scopeFor([RTL]).scope, 'everything', 'a short-term file runs everything');
eq(scopeFor([LT, RTL]).scope, 'everything', 'ONE short-term file among long-term ones runs everything');
eq(scopeFor([]).scope, 'everything', 'an empty list proves nothing — run everything');
eq(scopeFor(null).scope, 'everything', 'no list at all runs everything');
eq(scopeFor(undefined).scope, 'everything', 'undefined runs everything');
eq(scopeFor('src/longterm/x.js').scope, 'everything', 'a string is not a file list');
eq(scopeFor([null, LT]).scope, 'everything', 'a list we could only partly read runs everything');
eq(scopeFor([42, LT]).scope, 'everything', 'a non-string entry runs everything');

// ---------------------------------------------------------------------------
// C. Near-misses: paths that LOOK long-term and are not.
//    Each of these is a real way a naive prefix match would leak.
// ---------------------------------------------------------------------------
eq(scopeFor(['yscap-repo-root_8/src/longterm-notes.md']).scope, 'everything',
  '"longterm-notes.md" is not inside src/longterm/');
eq(scopeFor(['yscap-repo-root_8/db/549_loan_application.sql']).scope, 'everything',
  'a migration without the _lt_ marker is a shared migration');
eq(scopeFor(['yscap-repo-root_8/scripts/test-ltv-pure.js']).scope, 'everything',
  '"test-ltv-" is not "test-lt-"');
eq(scopeFor(['src/longterm/pipeline.js']).scope, 'everything',
  'a path missing the repo-root prefix is not recognised, so it runs everything');
eq(scopeFor(['yscap-repo-root_8/src/longterm']).scope, 'everything',
  'the bare folder name without a trailing slash is not a file inside it');

// ---------------------------------------------------------------------------
// D. The selector can never be used to skip testing a change to the selector
// ---------------------------------------------------------------------------
eq(scopeFor(['.github/workflows/test.yml', LT]).scope, 'everything', 'a workflow change runs everything');
eq(scopeFor(['yscap-repo-root_8/package.json', LT]).scope, 'everything', 'a package.json change runs everything');
eq(scopeFor(['yscap-repo-root_8/scripts/ci-scope.js']).scope, 'everything', 'changing the selector runs everything');
eq(scopeFor(['yscap-repo-root_8/scripts/ci-test-plan.js']).scope, 'everything', 'changing the runner runs everything');
eq(scopeFor(['yscap-repo-root_8/scripts/test-ci-scope-pure.js']).scope, 'everything', 'changing this test runs everything');

// The five assertions above pass for TWO reasons — none of those paths is a
// Long-Term file either — so they cannot prove the ALWAYS_FULL list itself
// works. Mutation testing showed that: deleting an entry left them green.
// These test the rule DIRECTLY, where nothing masks it, so the list is
// genuinely covered against the future widening of LT_PATTERNS it exists for.
const { isAlwaysFull } = _internals;
ok(isAlwaysFull('.github/workflows/test.yml'), 'the workflow is on the always-full list in its own right');
ok(isAlwaysFull('yscap-repo-root_8/package.json'), 'package.json is on the always-full list in its own right');
ok(isAlwaysFull('yscap-repo-root_8/package-lock.json'), 'the lockfile is on the always-full list');
ok(isAlwaysFull('yscap-repo-root_8/scripts/ci-scope.js'), 'the selector is on the always-full list');
ok(isAlwaysFull('yscap-repo-root_8/scripts/ci-test-plan.js'), 'the runner is on the always-full list');
ok(isAlwaysFull('yscap-repo-root_8/scripts/test-ci-scope-pure.js'), 'this test is on the always-full list');
ok(!isAlwaysFull(LT), 'an ordinary long-term file is NOT on the always-full list');
ok(!isAlwaysFull(RTL), 'an ordinary short-term file is not on it either (the outer rule handles those)');

// ---------------------------------------------------------------------------
// E. stepRuns — what actually runs in each mode
// ---------------------------------------------------------------------------
ok(stepRuns('node scripts/test-lt-investor-block.js', 'long_term_only'), 'a long-term test runs in long-term mode');
ok(stepRuns('node scripts/check-product-separation.js', 'long_term_only'), 'the separation gate always runs');
ok(stepRuns('node scripts/check-migrations.js', 'long_term_only'), 'the migration gate always runs');
ok(!stepRuns('node scripts/test-tpo-orders-db.js', 'long_term_only'), 'an unrelated short-term test does NOT run in long-term mode');
ok(stepRuns('node scripts/test-tpo-orders-db.js', 'everything'), 'that same test DOES run in the everything mode');
ok(stepRuns(null, 'long_term_only'), 'an unreadable step is run rather than skipped');

// ---------------------------------------------------------------------------
// F. DRIFT GUARDS — the assertions that keep this honest over time.
//    Without these the module silently rots: a renamed gate quietly leaves the
//    always-run set, or a new long-term test is quietly never selected.
// ---------------------------------------------------------------------------
const steps = allSteps();
ok(steps.length > 800, `the step list is read from package.json and is long (${steps.length})`);

const pkgChain = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  .scripts.test.split('&&').map((s) => s.trim()).filter(Boolean);
eq(steps.length, pkgChain.length, 'the plan reads every step of npm test — no step is invisible to it');

for (const name of _internals.ALWAYS_RUN_STEPS) {
  ok(steps.some((s) => s.includes(name)),
    `always-run step "${name}" is really a step of npm test (a typo here silently drops a gate)`);
  ok(fs.existsSync(path.join(__dirname, name)), `always-run step "${name}" exists on disk`);
}

const ltSteps = steps.filter((s) => /scripts\/test-lt-/.test(s));
ok(ltSteps.length >= 5, `npm test carries the long-term tests (${ltSteps.length} found)`);
for (const s of ltSteps) {
  ok(stepRuns(s, 'long_term_only'), `long-term test is selected in long-term mode: ${s}`);
}

// The plan can never be empty — an empty plan is a green build that tested
// nothing, which is the worst possible failure of a tool like this.
const ltPlan = steps.filter((s) => stepRuns(s, 'long_term_only'));
ok(ltPlan.length >= ltSteps.length + _internals.ALWAYS_RUN_STEPS.length - 1,
  `the long-term plan carries the long-term tests AND the gates (${ltPlan.length} steps)`);
ok(ltPlan.length < steps.length, 'the long-term plan is genuinely smaller than the full suite');

// And the whole point: `everything` really is everything.
eq(steps.filter((s) => stepRuns(s, 'everything')).length, steps.length,
  'in the everything mode, every single step runs');

console.log(`ci-scope: ${n} assertions passed ` +
  `(long-term plan = ${ltPlan.length} of ${steps.length} steps)`);
