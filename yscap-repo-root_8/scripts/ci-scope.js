'use strict';

// =============================================================================
// CI TEST SCOPE — is this change provably Long-Term-only?
// =============================================================================
//
// Owner-directed 2026-08-16: a Long-Term change should not have to carry the
// weight of the whole short-term suite. `npm test` is 892 chained steps, of
// which exactly 5 are Long-Term tests, so an LT-only pull request currently
// runs 892 steps when about a dozen are relevant.
//
// THIS MODULE IS THE ONLY THING THAT DECIDES THAT, and it answers exactly one
// question: "can I PROVE every file in this change is Long-Term?" Anything else
// — including anything it cannot read, cannot parse, or has never seen — is
// `everything`. There is no middle answer and no heuristic.
//
// WHY SKIPPING IS SAFE WHEN THE ANSWER IS `long_term_only`, stated as an
// argument rather than assumed (this is the "change impact analysis" a
// safety-critical standard requires before any test reduction):
//
//   1. The two-product separation law forbids RTL code from importing, reading
//      or referencing anything Long-Term. `scripts/check-product-separation.js`
//      proves that structurally on every run — and it is in the always-run set
//      below, so the premise is re-proven by the very run that relies on it.
//   2. The single back-end seam is `src/server.js` mounting the LT router. That
//      is an RTL file, so touching it is not an LT-only change and lands in
//      `everything`.
//   3. An LT MIGRATION is the one genuine coupling — every migration runs on
//      boot for both products, so a broken `db/NNN_lt_*.sql` could stop RTL
//      booting. That is why the CI job still applies the FULL migration chain
//      even in this mode, and why `check-migrations.js` is always run.
//
// THE SELECTOR MAY NEVER BE USED TO SKIP TESTING A CHANGE TO THE SELECTOR.
// Its own files, the workflow and `package.json` are all in `ALWAYS_FULL`.
//
// Pure: no database, no network, no filesystem. Never throws.

/** Paths (relative to the GIT ROOT) that are Long-Term by the separation law. */
const LT_PATTERNS = [
  /^yscap-repo-root_8\/src\/longterm\//,
  /^yscap-repo-root_8\/app-v2\/src\/longterm\//,
  /^yscap-repo-root_8\/docs\/longterm\//,
  /^yscap-repo-root_8\/db\/\d+_lt_[\w.-]+\.sql$/,
  /^yscap-repo-root_8\/scripts\/test-lt-[\w.-]+\.(js|mjs)$/,
];

/**
 * Changes that must ALWAYS run the whole suite, whatever else is in the change.
 *
 * BE HONEST ABOUT WHAT THIS DOES TODAY: every path below ALSO fails the
 * "is it a Long-Term file?" test further down, so the outer rule already
 * catches all of them and this list changes no current answer. Mutation
 * testing proved exactly that — deleting an entry here left the suite green.
 *
 * It is kept as defence-in-depth against ONE specific future mistake: somebody
 * widening LT_PATTERNS (say, to a whole `docs/` folder) and accidentally
 * bringing the workflow, the step list, or this selector itself inside the
 * "provably Long-Term" set. Then this list is the thing that still refuses.
 * `test-ci-scope-pure.js` therefore tests it DIRECTLY, at the unit level,
 * rather than through `scopeFor` where the outer rule masks it.
 */
const ALWAYS_FULL = [
  /^\.github\//,                                   // the workflow that runs the tests
  /^yscap-repo-root_8\/package(-lock)?\.json$/,    // the step list itself
  /^yscap-repo-root_8\/scripts\/ci-scope\.js$/,    // this file
  /^yscap-repo-root_8\/scripts\/ci-test-plan\.js$/,
  /^yscap-repo-root_8\/scripts\/test-ci-scope-pure\.js$/,
  // THE BUILDER OF THE MAP IS PART OF THE SELECTOR TOO. Its guards live in
  // `test-ci-scope-pure.js`, so unless a change to it runs that suite, the
  // guards do not police the file they are about. That is not hypothetical:
  // the 2026-08-31 pass added a guard on this builder's header while the map
  // had already recorded that suite WITHOUT this file as a dependency, so the
  // new guard would not have been selected by a change to the thing it guards.
  // An exemption fixes that for good; a recorded dependency only fixes it
  // until the next rebuild happens to miss it again.
  /^yscap-repo-root_8\/scripts\/ci-deps-build\.js$/,
];

/**
 * Steps that run in EVERY mode, including `long_term_only`. Matched against the
 * script filename in a step. Each earns its place:
 *   - the two separation gates prove the premise this whole module rests on;
 *   - the migration-number gate protects the shared boot chain;
 *   - the Encompass read-only gates cover the hardest rule in the repo, which
 *     Long-Term is the largest consumer of;
 *   - the parse check is the cheapest possible "did anything become invalid";
 *   - the schema-map freshness check answers, with no database and in
 *     milliseconds, the one question a migration makes urgent — is the
 *     committed map now describing a database that no longer exists. Selection
 *     could not be trusted to reach it: a Long-Term migration is provably
 *     Long-Term-only, so the reduced plan would skip it precisely when it
 *     matters. It never fails the build;
 *   - the Long-Term schema check proves that product's own stated invariant —
 *     that its Prisma schema and its migrations always agree. An LT migration
 *     is the exact change that can break it, and an LT migration is exactly
 *     what the reduced plan is for, so selection cannot be trusted to reach it
 *     either. It reads two committed files and never fails the build.
 */
const ALWAYS_RUN_STEPS = [
  'check-product-separation.js',
  'test-product-separation-gate.js',
  'check-migrations.js',
  'check-encompass-readonly.js',
  'test-encompass-readonly-gate.js',
  'test-source-parses-pure.js',
  'check-schema-behind.js',
  'check-lt-schema-drift.js',
];

/** A step that is a Long-Term test. */
const LT_STEP = /(^|\/)test-lt-[\w.-]+\.(js|mjs)$/;

const isLtPath = (p) => LT_PATTERNS.some((re) => re.test(p));
const isAlwaysFull = (p) => ALWAYS_FULL.some((re) => re.test(p));

/** Normalise one entry from a `git diff --name-only` list. Non-strings vanish. */
function cleanPath(p) {
  if (typeof p !== 'string') return null;
  const t = p.trim().replace(/^\.\//, '');
  return t.length ? t : null;
}

/**
 * THE DECISION. Returns { scope, reason, files, ltFiles } where scope is
 * 'long_term_only' or 'everything'. Never throws; anything unexpected is
 * 'everything'.
 *
 * @param {string[]} changedFiles paths relative to the git root
 */
function scopeFor(changedFiles) {
  const full = (reason) => ({ scope: 'everything', reason, files: 0, ltFiles: 0 });

  if (!Array.isArray(changedFiles)) return full('no file list was provided');

  const files = changedFiles.map(cleanPath).filter(Boolean);
  if (!files.length) return full('the list of changed files was empty');

  // Some entries survived cleaning as unusable — we cannot see the whole change.
  if (files.length !== changedFiles.length) {
    return full('part of the file list could not be read');
  }

  const forced = files.find(isAlwaysFull);
  if (forced) return full(`${forced} always runs the whole suite`);

  const foreign = files.find((p) => !isLtPath(p));
  if (foreign) return full(`${foreign} is not a Long-Term file`);

  return {
    scope: 'long_term_only',
    reason: `all ${files.length} changed file(s) are Long-Term`,
    files: files.length,
    ltFiles: files.length,
  };
}

/** Should this step run under the given scope? */
function stepRuns(step, scope) {
  if (scope !== 'long_term_only') return true;
  if (typeof step !== 'string') return true;          // unreadable step → run it
  if (LT_STEP.test(step)) return true;
  return ALWAYS_RUN_STEPS.some((name) => step.includes(name));
}

// =============================================================================
// TEST IMPACT — run only the tests a change can actually reach
// =============================================================================
//
// The Long-Term rule above answers one narrow question very cheaply. This
// answers the general one, and it does it from MEASUREMENT: `ci-deps-build.js`
// records, during a full run with a database, which repository files each test
// actually read or required. A change then selects the tests whose recorded
// list contains one of the changed files. Microsoft's Test Impact Analysis is
// the same shape, including the part that matters most —
//
//   ANYTHING THE MAP DOES NOT KNOW ABOUT RUNS EVERYTHING.
//
// A new file, a file type nothing recorded, a test that failed or was skipped
// during the baseline, a map that is missing, unreadable, or older than
// MAX_MAP_AGE_DAYS — every one of those falls back to the whole suite. The map
// can only ever be used to ADD confidence that a test is needed; it is never
// evidence that one is not.

const MAX_MAP_AGE_DAYS = 14;

/**
 * WARN BEFORE IT EXPIRES, because the expiry itself is not an early warning.
 *
 * MAX_MAP_AGE_DAYS is a cliff: on day 14 everything is normal and on day 15 the
 * planner stops narrowing, `test-ci-scope-pure.js` goes red, and EVERY open
 * pull request in the repository fails on a file nobody touched. That is what
 * happened on 2026-08-31 against a map built on 2026-08-16 — the alarm worked
 * exactly as designed and the first anybody heard of it was the whole
 * repository going red at once.
 *
 * Nothing rebuilds this map on a cadence (see the header of ci-deps-build.js),
 * so somebody has to run `npm run ci:deps` by hand. This gives them four days'
 * notice instead of none.
 *
 * It is DELIBERATELY NOT A FAILURE and DELIBERATELY DOES NOT TOUCH SELECTION:
 * a warning that could change which tests run would be a second, quieter copy
 * of the age rule, and the one that drifts is the one that leaks. The only
 * thing this decides is whether to print a sentence.
 */
const WARN_MAP_AGE_DAYS = 10;

/**
 * The sentence, or null when there is nothing to say.
 *
 * Silent in all four cases something else already handles: no map at all, an
 * unusable or future date (both are refusals with their own reason), and a map
 * that has ALREADY expired — there the refusal reason is louder and more
 * accurate than a warning about an expiry that has happened.
 */
function mapAgeWarning(map, todayUtcDay) {
  if (!map || typeof map !== 'object') return null;
  const age = daysBetween(map.builtAtUtcDay, todayUtcDay);
  if (age === null || age < 0) return null;
  if (age > MAX_MAP_AGE_DAYS) return null;
  if (age < WARN_MAP_AGE_DAYS) return null;
  return `the dependency map is ${age} days old and stops narrowing at `
    + `${MAX_MAP_AGE_DAYS} — rebuild it with \`npm run ci:deps\` (needs DATABASE_URL)`;
}

/**
 * Load the recorded map. Any problem at all answers null, which means "run everything".
 *
 * ON THE INNER GUARDS BELOW, HONESTLY: this function's `try/catch` is the
 * load-bearing part — mutation testing confirms that removing IT is caught,
 * while removing some of the individual checks inside is NOT, because the throw
 * they would have prevented is caught anyway and produces the same `null`.
 * They are kept as defence-in-depth and because each one names a specific
 * failure, but do not read them as though each independently changes an
 * outcome. Where a guard CAN be isolated it is tested directly in
 * `test-ci-scope-pure.js`; the redundant ones are recorded as redundant rather
 * than left to imply more than they do.
 */
function loadDepMap(fsMod, pathMod, dirname) {
  try {
    const file = pathMod.join(dirname, '..', 'docs', 'ci', 'test-deps.json');
    const raw = JSON.parse(fsMod.readFileSync(file, 'utf8'));
    if (!raw || typeof raw.tests !== 'object' || !raw.tests) return null;
    if (!Object.keys(raw.tests).length) return null;

    // The file stores paths once and refers to them by index (see
    // ci-deps-build.js). Expand it here so everything downstream — and every
    // test of it — deals in plain path strings and never in this format.
    if (raw.format === 'indexed-v1') {
      if (!Array.isArray(raw.files)) return null;
      const tests = {};
      for (const [test, idxs] of Object.entries(raw.tests)) {
        if (!Array.isArray(idxs)) return null;         // a malformed entry is not evidence
        const paths = idxs.map((i) => raw.files[i]);
        if (paths.some((p) => typeof p !== 'string')) return null;  // an index out of range
        tests[test] = paths;
      }
      return { ...raw, tests };
    }
    return raw;
  } catch (_) { return null; }
}

/** Whole days between two YYYY-MM-DD strings; null if either is unusable. */
function daysBetween(fromDay, toDay) {
  const a = Date.parse(`${fromDay}T00:00:00Z`);
  const b = Date.parse(`${toDay}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Which tests can this change reach?
 *
 * @param {string[]} files   changed paths, already cleaned, relative to the git root
 * @param {object}   map     the parsed test-deps.json
 * @param {string}   todayUtcDay  'YYYY-MM-DD' — passed in, never read from the clock,
 *                                so the decision is reproducible and testable
 * @returns {{ok:boolean, reason:string, tests?:Set<string>}}
 */
function impactedTests(files, map, todayUtcDay) {
  try {
    return impactedTestsInner(files, map, todayUtcDay);
  } catch (e) {
    // A selector that throws is a selector that stops the build for a reason
    // nobody can act on. Any internal failure answers "everything" instead —
    // slower, never weaker. Proven by a mutation test rather than assumed.
    return { ok: false, reason: `the impact map could not be read (${e && e.message})` };
  }
}

function impactedTestsInner(files, map, todayUtcDay) {
  // BE HONEST: this guard changes no OUTCOME. Mutation testing showed that
  // deleting it leaves the suite green, because the try/catch above already
  // turns the resulting TypeError into the same "run everything" answer.
  // It is kept for one small real reason — it produces a reason a human can
  // act on ("no dependency map") instead of a caught "cannot read properties
  // of null". Removing the CATCH, by contrast, IS caught by the tests: that
  // one is load-bearing.
  if (!map || typeof map !== 'object' || !map.tests) {
    return { ok: false, reason: 'no dependency map — running everything' };
  }

  const age = daysBetween(map.builtAtUtcDay, todayUtcDay);
  if (age === null) return { ok: false, reason: 'the dependency map has no usable date' };
  if (age < 0) return { ok: false, reason: 'the dependency map is dated in the future' };
  if (age > MAX_MAP_AGE_DAYS) {
    return { ok: false, reason: `the dependency map is ${age} days old (limit ${MAX_MAP_AGE_DAYS})` };
  }

  // Every file any test was recorded as touching. A changed file outside this
  // set is one the baseline never saw — a new module, a new migration, a file
  // type nothing reads — and we cannot reason about it.
  const known = new Set();
  for (const deps of Object.values(map.tests)) for (const d of deps) known.add(d);

  const wanted = new Set();
  for (const f of files) {
    // The repo lives in a subfolder; the map is relative to that folder while
    // the changed-file list is relative to the git root.
    const inner = f.startsWith('yscap-repo-root_8/') ? f.slice('yscap-repo-root_8/'.length) : null;
    if (!inner) return { ok: false, reason: `${f} is outside the project folder` };

    // A changed TEST always runs itself, whatever the map says.
    //
    // `handledAsTest` IS THE WHOLE GUARD, and the earlier version got it wrong
    // in a way that defeated the fail-safe this function exists for. It read:
    //
    //   const asTest = inner.startsWith('scripts/') ? inner.slice(…) : null;
    //   if (asTest && (map.tests[asTest] || /^(test|check)-/.test(asTest))) wanted.add(asTest);
    //   if (!known.has(inner)) { if (asTest) continue; return { ok:false, … }; }
    //
    // `asTest` is truthy for ANY path under `scripts/`, not only for a test —
    // so an unrecognised NON-test script (`scripts/schema-glossary.js`,
    // `scripts/migrate.js`, anything added tomorrow, or any file RENAMED into
    // `scripts/`, since git reports only the destination) was added to nothing
    // and then SILENTLY DISCARDED by the `continue`, instead of forcing the
    // whole suite. Measured: one such file selected 9 of 925 steps and reported
    // it as success. The claim in this file's own header — "anything the map
    // does not know about runs everything" — was false for an entire directory.
    const asTest = inner.startsWith('scripts/') ? inner.slice('scripts/'.length) : null;
    const handledAsTest = !!asTest && (!!map.tests[asTest] || /^(test|check)-/.test(asTest));
    if (handledAsTest) wanted.add(asTest);

    if (!known.has(inner)) {
      if (handledAsTest) continue;                // a test file we just handled
      return { ok: false, reason: `no test was ever recorded touching ${inner}` };
    }
    for (const [test, deps] of Object.entries(map.tests)) {
      if (deps.includes(inner)) wanted.add(test);
    }
  }

  return {
    ok: true,
    reason: `${wanted.size} test(s) can reach these ${files.length} file(s)`,
    tests: wanted,
    // WHICH TESTS WERE EVER MEASURED. `stepRunsImpacted` needs this to tell
    // "measured, and this change cannot reach it" from "never measured at all",
    // which are opposite answers. Without it the second silently became the
    // first — see the note there.
    measured: new Set(Object.keys(map.tests)),
  };
}

/**
 * Should this step run, given an impacted-test set? Always-run steps always do.
 *
 * A STEP THAT WAS NEVER MEASURED ALWAYS RUNS, and that rule is the reason a
 * lagging map is merely slow rather than blind. `ci-deps-build.js` says so in
 * its own header — a `.mjs` guard "gets NO entry, which ci-scope reads as
 * always run" — and this function did the exact opposite: absence from the map
 * meant absence from `wanted`, so the step could only ever be selected by
 * changing its own file.
 *
 * Measured on the committed map: 47 of 925 steps were unreachable that way —
 * all 19 `.mjs` guards (structurally unmappable, because `node -r` cannot
 * preload into an ES module) plus 28 tests added since the map was built. Among
 * them `test-app-dialog-pure.mjs`, which is the guard that fails the build when
 * a portal screen calls `alert()`/`window.confirm()` — so editing
 * `app-v2/src/lib/dialog.js`, the very module it polices, ran 14 steps and not
 * one of its own guards.
 *
 * It also makes map STALENESS safe by construction rather than by the date
 * check alone: a test the map has never heard of is run, so a map that lags
 * `package.json` costs time, never coverage.
 */
function stepRunsImpacted(step, tests, measured) {
  if (typeof step !== 'string') return true;
  if (ALWAYS_RUN_STEPS.some((name) => step.includes(name))) return true;
  const m = step.match(/scripts\/([\w.-]+\.(?:js|mjs))/);
  if (!m) return true;                      // a step we cannot read is a step we run
  if (!tests) return true;
  if (measured && !measured.has(m[1])) return true;   // never measured → always run
  return tests.has(m[1]);
}

module.exports = {
  scopeFor,
  isAlwaysFull,
  stepRuns,
  loadDepMap,
  impactedTests,
  stepRunsImpacted,
  MAX_MAP_AGE_DAYS,
  WARN_MAP_AGE_DAYS,
  mapAgeWarning,
  _internals: { LT_PATTERNS, ALWAYS_FULL, ALWAYS_RUN_STEPS, LT_STEP, isLtPath, isAlwaysFull, cleanPath, daysBetween },
};
