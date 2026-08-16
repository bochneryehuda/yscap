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
];

/**
 * Steps that run in EVERY mode, including `long_term_only`. Matched against the
 * script filename in a step. Each earns its place:
 *   - the two separation gates prove the premise this whole module rests on;
 *   - the migration-number gate protects the shared boot chain;
 *   - the Encompass read-only gates cover the hardest rule in the repo, which
 *     Long-Term is the largest consumer of;
 *   - the parse check is the cheapest possible "did anything become invalid".
 */
const ALWAYS_RUN_STEPS = [
  'check-product-separation.js',
  'test-product-separation-gate.js',
  'check-migrations.js',
  'check-encompass-readonly.js',
  'test-encompass-readonly-gate.js',
  'test-source-parses-pure.js',
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

module.exports = {
  scopeFor,
  stepRuns,
  _internals: { LT_PATTERNS, ALWAYS_FULL, ALWAYS_RUN_STEPS, LT_STEP, isLtPath, isAlwaysFull, cleanPath },
};
