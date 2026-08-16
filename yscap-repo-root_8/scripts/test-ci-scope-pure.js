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

// EACH GATE IS NAMED HERE AS A LITERAL, and that is the whole point of this
// block. Iterating `ALWAYS_RUN_STEPS` and asserting things about its members is
// a TAUTOLOGY: delete an entry and the loop simply runs one fewer time, green.
// Mutation-proven — with `check-encompass-readonly.js` removed from the list the
// entire suite stayed green while the hardest rule in this repository silently
// left every reduced plan. So the list is pinned by VALUE. Adding a gate is a
// deliberate edit in two places; that is the intended cost.
const REQUIRED_GATES = [
  'check-product-separation.js',      // the premise the LT narrowing rests on
  'test-product-separation-gate.js',  // …and the proof it still bites
  'check-migrations.js',              // the shared boot chain
  'check-encompass-readonly.js',      // "the HARDEST rule, on top of all rules"
  'test-encompass-readonly-gate.js',
  'test-source-parses-pure.js',
  'check-schema-behind.js',
  'check-lt-schema-drift.js',
];
for (const name of REQUIRED_GATES) {
  ok(_internals.ALWAYS_RUN_STEPS.includes(name),
    `"${name}" is STILL in the always-run set — removing it drops a gate from every reduced plan`);
}
eq(_internals.ALWAYS_RUN_STEPS.length, REQUIRED_GATES.length,
  'the always-run set holds exactly the gates listed here — a silent addition is a decision, not a detail');

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

// ---------------------------------------------------------------------------
// G. TEST IMPACT — the measured selector.
//
// The governing property is asymmetric and every assertion below tests that
// side of it: the map may ADD a test, never excuse one. So the interesting
// cases are all the ways it must REFUSE to narrow, not the happy path.
// ---------------------------------------------------------------------------
const { loadDepMap, impactedTests, stepRunsImpacted, MAX_MAP_AGE_DAYS, _internals: I2 } = require('./ci-scope');

const TODAY = '2026-08-16';
const MAP = {
  builtAtUtcDay: '2026-08-15',
  tests: {
    'test-pricing-pure.js': ['src/lib/pricing.js', 'src/lib/rehab-budget.js'],
    'test-draw-email-pure.js': ['src/lib/email/draw-email.js', 'src/sitewire/rollup.js'],
    'test-react-hook-order.js': ['app-v2/src/screens/StaffDraws.jsx'],
  },
};
const P = (f) => `yscap-repo-root_8/${f}`;

// The happy path: a change reaches exactly the tests that recorded it.
let r = impactedTests([P('src/lib/pricing.js')], MAP, TODAY);
ok(r.ok, 'a mapped file selects');
eq(r.tests.size, 1, 'one test recorded touching pricing.js');
ok(r.tests.has('test-pricing-pure.js'), 'and it is the right one');

// A file two tests share selects both.
r = impactedTests([P('src/lib/pricing.js'), P('src/sitewire/rollup.js')], MAP, TODAY);
eq(r.tests.size, 2, 'two changed files select both their tests');

// A source guard that only ever READ a .jsx is still selected by a change to it.
// This is the case a require-only map would miss entirely.
r = impactedTests([P('app-v2/src/screens/StaffDraws.jsx')], MAP, TODAY);
ok(r.ok && r.tests.has('test-react-hook-order.js'),
  'a test that only READS a file is still selected when that file changes');

// --- every way it must refuse to narrow ---
ok(!impactedTests([P('src/lib/brand-new.js')], MAP, TODAY).ok,
  'a file no test was ever recorded touching runs everything');
ok(!impactedTests([P('db/552_new_thing.sql')], MAP, TODAY).ok,
  'a new migration runs everything — nothing recorded reading it');
ok(!impactedTests([P('src/lib/pricing.js')], null, TODAY).ok, 'no map at all runs everything');
ok(!impactedTests([P('src/lib/pricing.js')], { tests: {} }, TODAY).ok, 'an empty map runs everything');
ok(!impactedTests([P('src/lib/pricing.js')], { builtAtUtcDay: 'nonsense', tests: MAP.tests }, TODAY).ok,
  'a map with an unusable date runs everything');
ok(!impactedTests([P('src/lib/pricing.js')], { builtAtUtcDay: '2026-09-01', tests: MAP.tests }, TODAY).ok,
  'a map dated in the FUTURE runs everything — a clock we cannot trust is not evidence');
ok(!impactedTests([P('src/lib/pricing.js')], { builtAtUtcDay: '2026-07-01', tests: MAP.tests }, TODAY).ok,
  `a map older than ${MAX_MAP_AGE_DAYS} days runs everything`);
ok(impactedTests([P('src/lib/pricing.js')], { builtAtUtcDay: '2026-08-02', tests: MAP.tests }, TODAY).ok,
  'a map exactly inside the age limit is still trusted');

// THE LIMIT ITSELF IS PINNED, not merely bracketed. The two dates above are 14
// and 46 days from TODAY, so ANY limit between 14 and 45 satisfies both — and a
// mutation setting it to 45 left the suite green. A trust window three times
// longer than intended is exactly the kind of change that should require
// somebody to edit a test on purpose.
eq(MAX_MAP_AGE_DAYS, 14, 'the map is trusted for 14 days — widening that is a deliberate decision');
{
  const dayBefore = (n) => {
    const d = new Date(`${TODAY}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  ok(impactedTests([P('src/lib/pricing.js')],
    { builtAtUtcDay: dayBefore(MAX_MAP_AGE_DAYS), tests: MAP.tests }, TODAY).ok,
  'a map exactly AT the limit is trusted');
  ok(!impactedTests([P('src/lib/pricing.js')],
    { builtAtUtcDay: dayBefore(MAX_MAP_AGE_DAYS + 1), tests: MAP.tests }, TODAY).ok,
  'and one day past it is not — the boundary is asserted, not straddled');
}
ok(!impactedTests(['some/other/repo/file.js'], MAP, TODAY).ok,
  'a path outside the project folder runs everything');

// A changed TEST always runs itself, even one the baseline never mapped.
r = impactedTests([P('scripts/test-brand-new-thing.js')], MAP, TODAY);
ok(r.ok && r.tests.has('test-brand-new-thing.js'), 'a brand-new test file selects itself');

// loadDepMap swallows every failure into "run everything".
eq(loadDepMap({ readFileSync() { throw new Error('nope'); } }, path, __dirname), null,
  'an unreadable map file reads as no map');
eq(loadDepMap({ readFileSync: () => 'not json' }, path, __dirname), null, 'malformed JSON reads as no map');
eq(loadDepMap({ readFileSync: () => '{"tests":null}' }, path, __dirname), null, 'a null test set reads as no map');

// stepRunsImpacted — the always-run gates survive every narrowing.
const someTests = new Set(['test-pricing-pure.js']);
ok(stepRunsImpacted('node scripts/test-pricing-pure.js', someTests), 'an impacted test runs');
ok(!stepRunsImpacted('node scripts/test-tpo-orders-db.js', someTests), 'an unimpacted test does not');
for (const g of I2.ALWAYS_RUN_STEPS) {
  ok(stepRunsImpacted(`node scripts/${g}`, someTests), `the ${g} gate runs even when narrowed`);
}
ok(stepRunsImpacted('npm run something-odd', someTests), 'a step whose script cannot be read is run');
ok(stepRunsImpacted('node scripts/test-anything.js', null), 'a null test set runs everything');

// daysBetween, the primitive the age guard rests on.
eq(I2.daysBetween('2026-08-01', '2026-08-16'), 15, 'daysBetween counts whole days');
eq(I2.daysBetween('bad', '2026-08-16'), null, 'daysBetween refuses an unusable date');


// ---------------------------------------------------------------------------
// G2. The guards the first mutation battery proved were NOT covered.
//
// Two of section G's assertions passed for the wrong reason — the same trap
// section D fell into. An empty map was refused because it also had no date,
// and a null map was "caught" only by throwing. Both are tested directly here,
// where nothing else can mask them.
// ---------------------------------------------------------------------------
const DATED_BUT_EMPTY = JSON.stringify({ builtAtUtcDay: TODAY, tests: {} });
eq(loadDepMap({ readFileSync: () => DATED_BUT_EMPTY }, path, __dirname), null,
  'a map with a PERFECTLY GOOD date but no tests in it still reads as no map');

// impactedTests must never throw — a selector that throws stops a build for a
// reason nobody can act on. Every shape of rubbish answers "everything".
for (const [label, bad] of [
  ['null', null], ['a string', 'nope'], ['a number', 7], ['an array', []],
  ['an object with no tests', { builtAtUtcDay: TODAY }],
  ['tests set to null', { builtAtUtcDay: TODAY, tests: null }],
  ['tests set to a string', { builtAtUtcDay: TODAY, tests: 'x' }],
]) {
  let res;
  assert.doesNotThrow(() => { res = impactedTests([P('src/lib/pricing.js')], bad, TODAY); },
    `impactedTests does not throw on ${label}`);
  n++;
  ok(res && res.ok === false, `impactedTests answers "everything" for ${label}`);
}

// And a dep list that is not an array cannot crash the scan either.
let res2;
assert.doesNotThrow(() => {
  res2 = impactedTests([P('src/lib/pricing.js')],
    { builtAtUtcDay: TODAY, tests: { 'test-a.js': null } }, TODAY);
}, 'a malformed dep list does not throw');
n++;
ok(res2 && res2.ok === false, 'a malformed dep list answers "everything"');


// ---------------------------------------------------------------------------
// G3. The on-disk format is an INDEX, not repeated paths (ci-deps-build.js).
// loadDepMap expands it, so nothing downstream ever sees the compact form.
// Every way that expansion could go wrong must answer "no map" -> everything.
// ---------------------------------------------------------------------------
const INDEXED = (over) => JSON.stringify(Object.assign({
  format: 'indexed-v1',
  builtAtUtcDay: TODAY,
  files: ['src/lib/pricing.js', 'src/sitewire/rollup.js'],
  tests: { 'test-a.js': [0], 'test-b.js': [0, 1] },
}, over || {}));

let expanded = loadDepMap({ readFileSync: () => INDEXED() }, path, __dirname);
ok(expanded && expanded.tests, 'an indexed map loads');
assert.deepStrictEqual(expanded.tests['test-a.js'], ['src/lib/pricing.js']); n++;
assert.deepStrictEqual(expanded.tests['test-b.js'], ['src/lib/pricing.js', 'src/sitewire/rollup.js']); n++;

// And it selects correctly once expanded — the point of the whole exercise.
let ri = impactedTests([P('src/sitewire/rollup.js')], expanded, TODAY);
ok(ri.ok && ri.tests.size === 1 && ri.tests.has('test-b.js'),
  'an indexed map selects the same tests a plain one would');

eq(loadDepMap({ readFileSync: () => INDEXED({ files: 'not an array' }) }, path, __dirname), null,
  'an indexed map with no file list reads as no map');
eq(loadDepMap({ readFileSync: () => INDEXED({ tests: { 'test-a.js': 'nope' } }) }, path, __dirname), null,
  'an entry that is not a list of indexes reads as no map');
eq(loadDepMap({ readFileSync: () => INDEXED({ tests: { 'test-a.js': [99] } }) }, path, __dirname), null,
  'an index pointing past the end of the file list reads as no map');
eq(loadDepMap({ readFileSync: () => INDEXED({ tests: { 'test-a.js': [-1] } }) }, path, __dirname), null,
  'a negative index reads as no map');

// A map in the OLD plain-path shape still loads — the reader is not
// format-locked, so a regeneration mid-flight cannot brick selection.
const PLAIN = JSON.stringify({ builtAtUtcDay: TODAY, tests: { 'test-a.js': ['src/lib/pricing.js'] } });
ok(loadDepMap({ readFileSync: () => PLAIN }, path, __dirname).tests['test-a.js'][0] === 'src/lib/pricing.js',
  'a plain-path map still loads');

// ---------------------------------------------------------------------------
// THE SEAM — the planner must ACT on what the scope decides
// ---------------------------------------------------------------------------
//
// Everything above tests the two halves separately, and an audit proved that is
// exactly where all three real defects lived: each half behaved correctly and
// the JOIN between them threw the answer away. So this section runs the REAL
// `ci-test-plan.js` end to end, as CI does, and asserts on the plan it prints.
//
//   1. ALWAYS_FULL was honoured by `scopeFor` and IGNORED by the planner, so a
//      pull request whose only change was the 925-step chain itself ran TEN
//      steps — the selector excusing a change to the selector.
//   2. An unknown NON-test file under `scripts/` was silently dropped instead
//      of forcing everything: 9 steps, reported as success.
//   3. A test absent from the dependency map could never be selected, so all 19
//      `.mjs` guards — including the one that fails the build when a portal
//      screen calls `alert()` — were unreachable by any change but their own.
//
// A unit test cannot see any of these; only running the planner can.
{
  const { spawnSync } = require('child_process');
  const os = require('os');
  const PLAN = path.join(__dirname, 'ci-test-plan.js');

  /** Run the real planner over one changed file and return its printed plan. */
  const planFor = (p) => {
    const f = path.join(os.tmpdir(), `ci-seam-${process.pid}-${Math.abs(hashish(p))}.txt`);
    fs.writeFileSync(f, `${p}\n`);
    try {
      const r = spawnSync(process.execPath, [PLAN, '--changed-from', f, '--list'], { encoding: 'utf8' });
      const out = `${r.stdout || ''}${r.stderr || ''}`;
      const m = out.match(/running (\d+) of (\d+) step\(s\)/);
      return {
        ran: m ? Number(m[1]) : -1,
        total: m ? Number(m[2]) : -1,
        lines: out.split('\n').map((s) => s.trim()),
        status: r.status,
      };
    } finally { try { fs.unlinkSync(f); } catch (_) { /* best effort */ } }
  };
  // A stable filename per input, without needing crypto.
  function hashish(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

  // 1. THE SELECTOR MAY NOT EXCUSE A CHANGE TO THE SELECTOR.
  for (const p of [
    'yscap-repo-root_8/package.json',
    'yscap-repo-root_8/package-lock.json',
    'yscap-repo-root_8/scripts/ci-scope.js',
    'yscap-repo-root_8/scripts/ci-test-plan.js',
    'yscap-repo-root_8/scripts/test-ci-scope-pure.js',
    '.github/workflows/test.yml',
  ]) {
    const r = planFor(p);
    eq(r.ran, r.total, `${p} runs the WHOLE suite — the selector never excuses a change to itself`);
  }

  // 2. A FILE NOTHING WAS RECORDED TOUCHING RUNS EVERYTHING — including one
  //    under scripts/, which is where the hole was.
  for (const p of [
    'yscap-repo-root_8/scripts/a-brand-new-helper-nobody-has-seen.js',
    'yscap-repo-root_8/src/a-brand-new-module.js',
  ]) {
    const r = planFor(p);
    eq(r.ran, r.total, `${p} is unknown to the map, so everything runs`);
  }

  // 3. A GUARD THE MAP NEVER MEASURED IS STILL REACHED.
  {
    const r = planFor('yscap-repo-root_8/app-v2/src/lib/dialog.js');
    ok(r.ran > 0 && r.ran < r.total, `a mapped portal file still narrows (${r.ran} of ${r.total})`);
    ok(r.lines.some((l) => l.includes('test-app-dialog-pure.mjs')),
      'the dialog guard is IN the plan for the module it polices — it is absent from the '
      + 'dependency map, so this only passes because an unmeasured test always runs');
    ok(r.lines.filter((l) => l.endsWith('.mjs')).length >= 10,
      'and so is every other unmeasured .mjs guard');
  }

  // 4. NARROWING STILL HAPPENS. Without this the three fixes above could be
  //    "satisfied" by running everything always, which would be no selector.
  {
    const r = planFor('yscap-repo-root_8/src/longterm/dscr/pricer.js');
    ok(r.ran < r.total / 4, `a Long-Term-only change still narrows sharply (${r.ran} of ${r.total})`);
    for (const g of REQUIRED_GATES) {
      ok(r.lines.some((l) => l.includes(g)), `and the ${g} gate is still in that plan`);
    }
  }
}

console.log(`ci-scope impact: ${n} assertions passed in total`);
