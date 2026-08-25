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
  // test-cure-pure.js was here and is now REGISTERED. Settled 2026-08-16: the
  // TEST was wrong, not the rule. cure.js and that suite were added in the SAME
  // commit (cc78975, #1127), so it had never passed — its "entity not screened"
  // fixture supplied no screened-parties data at all, which exercises the rule's
  // deliberate "we could not tell" branch while asserting the "not screened"
  // outcome. The fixtures moved to the branches they are actually asking about.
  // test-esign-cc-viewers.js was here and is now REGISTERED. Settled 2026-08-16,
  // and it is the SAME shape as the cure suite above: the TEST asserted the old
  // arrangement. The loan officer SIGNS the term sheet (owner-directed
  // 2026-07-21, and `loanOfficerRequired` landed in cc78975 / #1127 — the very
  // commit that added this suite still expecting them to be carbon-copied), and
  // a DocuSign recipient may not be both a signer and a CC of one envelope, so
  // the dedup drops them. The suite even asserted that dedup two lines down. It
  // also gained the no-database skip guard it needs to be in the chain at all.
  // test-mismo-db.js was here and is now REGISTERED. Settled 2026-08-16, and the
  // quarantine note's guess ("an import or a fixture has drifted from the MISMO
  // parser") was wrong in an instructive way: nothing had drifted and the parser
  // is fine. The fixture is a 'Refinance — Cash-Out' that the suite seeds with
  // raw SQL carrying a purchase price AND an assignment — a state no real door
  // would accept since the owner-directed 2026-08-02 rule, which the MISMO import
  // is named as enforcing. The import NORMALISES it; the suite still expected the
  // contradiction back. Now asserted the other way round, as a guard.
  // test-register-econversion.js and test-reregister-save.js were here and are
  // now REGISTERED. Settled 2026-08-17 by the OWNER, who was asked directly and
  // confirmed the rule in writing: a loan officer who engages manual pricing
  // REGISTERS — the 403 is gone — but never silently, and the borrower's term
  // sheet is withheld until an admin approves. So the protection these two cases
  // existed to give CHANGED SHAPE rather than disappearing, and asserting the old
  // 403 (and the "admin_override_stripped" audit row of the stripping era) was
  // asserting a door that the 2026-07-27 rule deliberately removed. Both suites
  // now assert the thing that actually protects the file: the registration is
  // flagged as needing approval, an escalation is opened naming WHY, and the
  // escalation is audited. Each of those assertions was proven to FAIL with the
  // approval rule neutralised, with clean runs either side.
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

// -----------------------------------------------------------------------------
// 6. No step in the chain hard-codes an ABSOLUTE filesystem root.
//
//    A step that requires `/home/<somebody>/…/src/db` resolves on the ONE machine
//    it was typed on and nowhere else: CI checks out to /home/runner/work/…, so
//    the very first require is a MODULE_NOT_FOUND, the process dies before its
//    first assertion, and the whole `&&` chain stops there. It is the same class
//    section 4 guards — a step that cannot run — and it is worse in one way: it
//    passes perfectly on the machine where it was written, so nothing says so
//    until CI. (Found 2026-08-24 in `test-esign-sign-link-db.js`, which needed a
//    resolved path to stub a module through `require.cache` and used an absolute
//    one to get it. `path.join(__dirname, '..')` is the same value, anywhere.)
//
//    Scoped to the CHAIN rather than to all of `scripts/`, deliberately: the
//    one-off local rendering helpers are not run by anything and are not the
//    hazard this describes.
// -----------------------------------------------------------------------------
const ABSOLUTE_ROOT = /(?:require\(|require\.resolve\(|from\s+)['"`]\/(?:home|Users|root|mnt|var)\//;
const rooted = [];
for (const f of inChainNow) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;               // section 4 already reports those
  const body = fs.readFileSync(full, 'utf8');
  // Also catch the two-step form: a root in a variable, then required off it.
  const viaVar = /=\s*['"`]\/(?:home|Users|root|mnt|var)\/[^'"`]*['"`]\s*;/.test(body)
    && /require\([A-Za-z_$][\w$]*\s*\+/.test(body);
  if (ABSOLUTE_ROOT.test(body) || viaVar) rooted.push(f);
}
ok(
  rooted.length === 0,
  'a suite in npm test hard-codes an absolute filesystem root, so it can only run on one machine '
  + `(use path.join(__dirname, '..')): ${rooted.join(', ')}`,
);

// -----------------------------------------------------------------------------
// 7. Every *-db step SURVIVES having no database.
//
//    `npm test` is ONE chain and BOTH CI jobs run it: `test-db` with a Postgres
//    service, and `test` with no database at all. A suite that dials one and
//    does not catch takes the whole build down — and the DEPLOY with it, because
//    `deploy` is `needs: test`. `scripts/lib/db-gate.js` exists for exactly this
//    and its header records the first time it happened (#1224); it happened
//    again on 2026-08-24 in `test-esign-sign-link-db.js`, which went straight
//    into its first INSERT and died with ECONNREFUSED, stopping every step
//    behind it. Both times it passed perfectly on the machine it was written on.
//
//    TWO STAGES, because the cheap one alone cannot answer it. The source screen
//    below recognises the three house shapes (a DATABASE_URL check, an emitted
//    SKIPPED, or the shared `skipUnlessDb`) — but a suite that is simply built to
//    run OFFLINE uses none of them and is perfectly fine, so a source-only guard
//    would fail working code and grow an exception list. So anything the screen
//    cannot vouch for is RUN, with no database, and has to exit 0. That is the
//    real invariant, it needs no list, and it self-maintains: a genuinely
//    offline-capable suite passes because it genuinely passes.
// -----------------------------------------------------------------------------
{
  const { execFileSync } = require('child_process');
  const HOUSE_SHAPES = /DATABASE_URL|SKIPPED|skipUnlessDb|db-gate/;
  const stripComments = (t) => t
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  const candidates = [...inChainNow]
    .filter((f) => /-db\.js$/.test(f))
    .filter((f) => fs.existsSync(path.join(ROOT, f)))
    .filter((f) => !HOUSE_SHAPES.test(stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))))
    .sort();

  /* A CAP, and it is REPORTED rather than silent. The screen normally leaves a
     handful; if a change ever leaves dozens, spawning them all would turn an
     instant gate into a slow one, so it says so and stops instead. */
  const SPAWN_CAP = 12;
  ok(
    candidates.length <= SPAWN_CAP,
    `${candidates.length} *-db suites in the chain declare no missing-database handling — too many `
    + `to verify here. Give them scripts/lib/db-gate.js: ${candidates.slice(0, 15).join(', ')}`,
  );

  const crashed = [];
  for (const f of candidates.slice(0, SPAWN_CAP)) {
    // A clean environment: dropping DATABASE_URL is not enough on its own, since
    // libpq also reads PGHOST/PGPORT/PGUSER and a developer with those exported
    // would get a pass this check has not earned.
    const env = { ...process.env };
    for (const k of Object.keys(env)) if (k === 'DATABASE_URL' || /^PG[A-Z]/.test(k)) delete env[k];
    try {
      execFileSync(process.execPath, [path.join(ROOT, f)], {
        cwd: ROOT, env, timeout: 60000, stdio: 'ignore',
      });
    } catch (e) {
      crashed.push(`${f} (${e && e.signal === 'SIGTERM' ? 'timed out' : `exit ${e && e.status}`})`);
    }
  }
  ok(
    crashed.length === 0,
    'a *-db suite in npm test does not survive having no database, so the no-database CI job — and '
    + `the deploy behind it — dies there. Use scripts/lib/db-gate.js: ${crashed.join(', ')}`,
  );
}

console.log(`\n✓ test-chain coverage: ${n} assertions passed`);
console.log(`  ${suiteFiles().length} suites on disk, ${inChainNow.size} steps in the chain, `
  + `${Object.keys(QUARANTINE).length} quarantined with a written reason`);
