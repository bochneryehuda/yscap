'use strict';

// =============================================================================
// DEPENDENCY PROBE — record which files a test actually touches
// =============================================================================
//
// Preloaded into a test with `node -r ./scripts/ci-deps-probe.js <test>`. It
// watches the test run and, on exit, writes the list of repository files that
// test actually depended on. Those lists become the map that lets a pull
// request run only the tests a change can possibly affect.
//
// THIS IS THE MEASURED APPROACH, NOT A GUESSED ONE. Microsoft's Test Impact
// Analysis works the same way: record, on a baseline run, the files each test
// exercises; then on a change, run only the tests whose recorded list contains
// a changed file. A map guessed from folder names would be a hand-kept list
// wearing a disguise, and would go stale in silence.
//
// IT RECORDS TWO KINDS OF DEPENDENCY, AND THE SECOND ONE IS WHY THIS WORKS HERE:
//   1. `require()` — the obvious one.
//   2. FILES READ AS TEXT. A large number of this repo's suites are source
//      guards: they read a .jsx, .sql, .html or .md file with fs and assert
//      something about its CONTENTS. `test-react-hook-order.js`,
//      `test-engine-copies-match.js` and `test-app-dialog-pure.mjs` never
//      `require` the files they police. A require-only map would declare those
//      tests independent of the very files they exist to watch, and a change to
//      one would skip the test guarding it. That is the failure this repo would
//      notice last and regret most.
//
// It NEVER changes what the test does: it wraps the loader and the read
// functions, records a path, and delegates. If anything in here throws, it
// swallows it — a probe must never be able to fail a test or change its result.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const OUT = process.env.CI_DEPS_OUT;          // where to write; absent = do nothing
const LABEL = process.env.CI_DEPS_LABEL || '';

const touched = new Set();

/** Repo-relative path, or null for anything outside the project (node internals, node_modules). */
function repoRelative(p) {
  try {
    if (typeof p !== 'string' || !p) return null;
    const abs = path.resolve(p);
    if (!abs.startsWith(ROOT + path.sep)) return null;
    const rel = abs.slice(ROOT.length + 1);
    // node_modules is not our code and never appears in a change.
    if (rel.startsWith('node_modules' + path.sep)) return null;
    return rel.split(path.sep).join('/');
  } catch (_) { return null; }
}

const record = (p) => { const r = repoRelative(p); if (r) touched.add(r); };

// ---- 1. require() ----------------------------------------------------------
const realLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const m = realLoad.apply(this, arguments);
  try {
    // Resolve to a real path so `./foo` and `../lib/foo` land on the same entry.
    record(Module._resolveFilename(request, parent, isMain));
  } catch (_) { /* an unresolvable request is the test's problem, not ours */ }
  return m;
};

// ---- 2. files read as text -------------------------------------------------
// Wrapped rather than replaced, so behaviour and return values are untouched.
for (const fn of ['readFileSync', 'openSync', 'createReadStream', 'existsSync', 'statSync']) {
  const real = fs[fn];
  if (typeof real !== 'function') continue;
  fs[fn] = function (p, ...rest) {
    try { record(typeof p === 'string' ? p : (p && p.path)); } catch (_) {}
    return real.call(this, p, ...rest);
  };
}
if (fs.promises && typeof fs.promises.readFile === 'function') {
  const real = fs.promises.readFile;
  fs.promises.readFile = function (p, ...rest) {
    try { record(typeof p === 'string' ? p : (p && p.path)); } catch (_) {}
    return real.call(this, p, ...rest);
  };
}

// ---- write on exit ---------------------------------------------------------
// `exit` (not `beforeExit`) so it still fires when the test calls process.exit,
// which many of these suites do.
process.on('exit', () => {
  if (!OUT) return;
  try {
    fs.writeFileSync(OUT, JSON.stringify({
      test: LABEL,
      deps: [...touched].sort(),
    }) + '\n');
  } catch (_) { /* never let the probe change an exit code */ }
});
