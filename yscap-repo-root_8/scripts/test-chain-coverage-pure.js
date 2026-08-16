'use strict';
/**
 * EVERY TEST SUITE IS IN THE DEPLOY GATE, OR IT IS QUARANTINED IN WRITING.
 *
 * =============================================================================
 * WHY THIS EXISTS
 * =============================================================================
 *
 * `npm test` is a hand-typed `&&` chain of a thousand steps in package.json, and
 * it is the ONLY thing that decides what CI runs — `scripts/ci-test-plan.js`
 * reads that chain to pick a pull request's subset, and the `deploy` job is
 * `needs: test`. A suite that is not in the chain therefore runs NOWHERE. It is
 * not "covered a bit less"; it is dead weight in the repository that nobody will
 * ever see fail.
 *
 * That is a SILENT failure, and it accumulated: 85 suites were found outside the
 * chain in one sweep (2026-08-16), including all 27 LT PPE suites — a whole
 * feature with real tests and zero enforcement, its own aggregator carrying a
 * header that said it was "kept out of package.json for now". Writing a test and
 * forgetting the package.json line is one keystroke, and NOTHING anywhere said
 * so. CLAUDE.md's own build rule 4 names this exact shape: *"a list somebody has
 * to remember to update is a list that goes stale silently. Derive it from the
 * source of truth."* The source of truth is the `scripts/` directory.
 *
 * So: add a `scripts/test-*.js` file and this suite fails until it is either in
 * the chain or quarantined below with a reason. The gap can no longer open
 * quietly, which is the whole point — the previous 85 did not need a decision,
 * they needed somebody to NOTICE.
 *
 * =============================================================================
 * WHY QUARANTINE IS A LIST AND NOT A SILENT SKIP
 * =============================================================================
 *
 * A suite that FAILS cannot simply be added: `npm test` is `&&`-chained, so one
 * red step stops the run and blocks the deploy for everyone. main was red for
 * exactly that reason on 2026-08-16 and nothing published for over an hour.
 *
 * The honest answer is neither "add it and break the build" nor "leave it out
 * and say nothing" — it is to name it, with the reason, where somebody will read
 * it. An entry here is a debt that is VISIBLE. Removing an entry is the fix;
 * adding one needs a reason a human would accept.
 *
 * PURE — reads package.json and a directory listing. No database, no network.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCRIPTS = path.join(ROOT, 'scripts');

/**
 * Suites deliberately OUT of the chain, each with the reason.
 *
 * These six were found outside the chain on 2026-08-16 and were each RUN before
 * being listed — they fail on their own merits, on a clean database, on main.
 * That is why they were never registered. Adding one as-is would block every
 * deploy, so each is recorded here instead of quietly dropped.
 *
 * Every one of these is a REAL failing assertion, not a missing credential or a
 * flake, so each needs a human judgement about whether the TEST or the CODE is
 * the thing that is wrong. Fixing one and deleting its line here is a genuine
 * improvement and needs no permission.
 */
const QUARANTINE = {
  'scripts/test-cure-pure.js':
    'Fails on its own: expects a cure verdict of "creates_new_finding" and gets '
    + '"unable_to_determine". Pure, no database — so the test and the cure rule '
    + 'genuinely disagree and somebody has to say which is right.',
  'scripts/test-esign-cc-viewers.js':
    '16 of 17 pass; "the loan officer is copied on the term-sheet envelope" '
    + 'fails. Touches who is carbon-copied on a package that goes out for '
    + 'signature, so it wants a deliberate answer rather than a quick edit.',
  'scripts/test-mismo-db.js':
    'Reads a loan amount back as 0 where it expects 420000 — an import or a '
    + 'fixture has drifted from the MISMO parser.',
  'scripts/test-register-econversion.js':
    '12 of 14 pass. The two failures assert a 403 for a loan officer sending '
    + 'engaged manual pricing keys, and an "admin_override_stripped" audit row. '
    + 'BOTH LOOK SUPERSEDED rather than broken: the 2026-07-27 owner-directed '
    + 'rule opened the pricing admin zone to every staff role and states that '
    + '"nothing is stripped and no role is refused" — the 403 branches were '
    + 'REMOVED and approval replaced them. Updating this suite is very likely '
    + 'the right fix, but it is a claim about the pricing rules and belongs to '
    + 'whoever owns them, not to a chain-registration pass.',
  'scripts/test-reregister-save.js':
    '4 of 5 pass; one re-register assertion fails. Same pricing-rules '
    + 'neighbourhood as test-register-econversion.js above and probably the '
    + 'same root cause.',
};

/**
 * Aggregators: a registered runner that executes other suites itself.
 *
 * `test-lt-ppe-all.js` discovers its children with readdirSync, so it covers
 * every present AND future `test-lt-ppe-*.js` with no list to maintain — which
 * is the shape this whole file argues for. Registering the children as well
 * would run all 27 of them twice.
 */
const AGGREGATORS = {
  'scripts/test-lt-ppe-all.js': /^scripts\/test-lt-ppe-.*\.js$/,
};

function chainFiles() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const chain = String((pkg.scripts && pkg.scripts.test) || '');
  const out = new Set();
  for (const step of chain.split('&&')) {
    const m = step.trim().match(/(scripts\/[\w.-]+\.(?:js|mjs))/);
    if (m) out.add(m[1]);
  }
  return out;
}

function suiteFiles() {
  return fs.readdirSync(SCRIPTS)
    .filter((f) => /^test-.*\.(js|mjs)$/.test(f))
    .map((f) => `scripts/${f}`)
    .sort();
}

function unregistered() {
  const inChain = chainFiles();
  // An aggregator only covers its children when the aggregator ITSELF is in the
  // chain — otherwise nothing runs and the children would be counted as covered
  // by a runner that never executes. That inverted check is the one way this
  // guard could report "all clear" over a hole.
  const covered = [];
  for (const [agg, re] of Object.entries(AGGREGATORS)) {
    if (inChain.has(agg)) covered.push(re);
  }
  const isCovered = (f) => covered.some((re) => re.test(f));

  return suiteFiles().filter((f) => (
    !inChain.has(f)
    && !isCovered(f)
    && !Object.prototype.hasOwnProperty.call(QUARANTINE, f)
  ));
}

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

// -----------------------------------------------------------------------------
// 1. THE ONE THAT MATTERS: no suite is silently outside the deploy gate.
// -----------------------------------------------------------------------------
const orphans = unregistered();
ok(
  orphans.length === 0,
  'THE ONE THAT MATTERS: these test suites exist but run NOWHERE — they are not '
  + 'in npm test\'s chain, not covered by a registered aggregator, and not '
  + 'quarantined with a reason. A suite outside the chain never runs in CI, so '
  + 'it can never fail and never protect anything. Add it to the "test" script '
  + 'in package.json, or — if it fails today — add it to QUARANTINE in '
  + `scripts/test-chain-coverage-pure.js with the reason:\n  ${orphans.join('\n  ')}`,
);

// -----------------------------------------------------------------------------
// 2. The quarantine list cannot rot: every entry names a file that still exists
//    and is genuinely still out of the chain.
// -----------------------------------------------------------------------------
const inChainNow = chainFiles();
for (const [f, why] of Object.entries(QUARANTINE)) {
  ok(
    fs.existsSync(path.join(ROOT, f)),
    `QUARANTINE names ${f}, which no longer exists — delete the entry`,
  );
  ok(
    !inChainNow.has(f),
    `${f} is quarantined AND in the chain. If it was fixed, delete its `
    + 'QUARANTINE entry; the list must never disagree with the chain',
  );
  ok(
    typeof why === 'string' && why.trim().length >= 40,
    `${f} is quarantined with no real reason — say what fails and why it is out`,
  );
}

// -----------------------------------------------------------------------------
// 3. An aggregator must itself be registered, or it covers nothing. This is the
//    check that stops the guard reporting "all clear" over a hole.
// -----------------------------------------------------------------------------
for (const agg of Object.keys(AGGREGATORS)) {
  ok(
    fs.existsSync(path.join(ROOT, agg)),
    `AGGREGATORS names ${agg}, which does not exist`,
  );
  ok(
    inChainNow.has(agg),
    `${agg} is declared as an aggregator but is NOT in the chain — every suite `
    + 'it claims to cover would run nowhere while this guard reported them covered',
  );
}

// -----------------------------------------------------------------------------
// 4. Every step in the chain points at a file that exists. A typo'd path is an
//    instant red build, but on a 1000-step line it is easy to write and hard to
//    see, and it fails a long way from the edit that caused it.
// -----------------------------------------------------------------------------
const dead = [...inChainNow].filter((f) => !fs.existsSync(path.join(ROOT, f)));
ok(
  dead.length === 0,
  `npm test's chain runs files that do not exist: ${dead.join(', ')}`,
);

// -----------------------------------------------------------------------------
// 5. No step is registered twice — a duplicate silently doubles a suite's cost
//    on every CI run and every deploy.
// -----------------------------------------------------------------------------
const pkgChain = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  .scripts.test.split('&&')
  .map((s) => s.trim())
  .filter(Boolean);
const seen = new Map();
const dupes = [];
for (const step of pkgChain) {
  const m = step.match(/(scripts\/[\w.-]+\.(?:js|mjs))/);
  if (!m) continue;
  seen.set(m[1], (seen.get(m[1]) || 0) + 1);
}
for (const [f, count] of seen) if (count > 1) dupes.push(`${f} x${count}`);
ok(dupes.length === 0, `npm test runs the same suite more than once: ${dupes.join(', ')}`);

console.log(`\n✓ test-chain coverage: ${n} assertions passed`);
console.log(`  ${suiteFiles().length} suites on disk, ${inChainNow.size} steps in the chain, `
  + `${Object.keys(QUARANTINE).length} quarantined with a written reason`);
