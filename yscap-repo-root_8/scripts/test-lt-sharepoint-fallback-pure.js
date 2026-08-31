'use strict';
/**
 * THE FALLBACK STUB MUST ANSWER EVERYTHING THE MIRROR ASKS OF IT.
 *
 * `sharepoint-backup.js` reaches the Long-Term scope helpers through a try/catch
 * require, on purpose: RTL is the live product and must keep mirroring even if the
 * side build is absent. That promise is only as good as the stub in the catch block
 * — and it was NOT good. The stub shipped without `isScopeKey`, while the mirror
 * asks, for EVERY row:
 *
 *     hasApplication: scopeKey.startsWith('app:') || ltScope.isScopeKey(scopeKey)
 *
 * An `app:` row survives on the `||` short-circuit. A `borrower:` row — every photo
 * ID, every track-record document, every borrower-profile document in the live RTL
 * product — reaches the second operand and throws. `runOnce` catches the throw and
 * calls `recordFailure`, so eight sweeps later the row is terminally DEAD with a
 * review card and a standing backlog-SLO breach. Losing the side build would have
 * inflicted on RTL exactly the fail-loop the shipment exists to abolish.
 *
 * A test that just checked for `isScopeKey` would fix this instance and none of the
 * next ones. So this suite derives the CALL SET from the mirror's own source — every
 * `ltScope.<name>` it actually uses — and asserts the stub answers all of them, with
 * the same shape as the real module. Add a new `ltScope.foo()` call and forget the
 * stub, and this goes red before a sweep ever does.
 *
 * PURE — no database, no network.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, 'src', 'lib', 'sharepoint-backup.js');
const QUEUE = path.join(ROOT, 'src', 'lib', 'sp-mirror-queue.js');

let n = 0;
const ok = (cond, what) => { assert.ok(cond, what); n++; };

/* ── 1. WHAT DOES THE RTL SIDE ACTUALLY ASK FOR? ─────────────────────────────
   Read it off the source rather than maintaining a hand-written list, which is the
   list that goes stale. Both RTL readers are scanned; the queue must stay in
   lock-step with the mirror (sp-mirror-queue.js says so itself). */
const sources = [BACKUP, QUEUE].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f, 'utf8'));
const called = new Set();
for (const src of sources) {
  for (const m of src.matchAll(/\bltScope\s*\.\s*([A-Za-z_$][\w$]*)/g)) called.add(m[1]);
}
ok(called.size > 0, `the mirror really does call the lt scope helpers (${[...called].sort().join(', ')})`);

/* ── 2. THE REAL MODULE ANSWERS ALL OF THEM ──────────────────────────────────
   If this fails the mirror is broken with the side build PRESENT, which is louder
   but no less real. */
const real = require('../src/longterm/sharepoint-scope');
for (const name of called) {
  ok(Object.prototype.hasOwnProperty.call(real, name),
    `the real lt scope module exports ${name}`);
}

/* ── 3. THE STUB ANSWERS ALL OF THEM TOO, WITH THE SAME SHAPE ────────────────
   Getting at the stub without deleting the file: reload sharepoint-backup with the
   Long-Term module's resolution blocked, exactly the condition it is written for,
   then read the fallback back off the module it built. */
function loadWithLtAbsent() {
  const Module = require('module');
  const realResolve = Module._resolveFilename;
  const ltPath = require.resolve('../src/longterm/sharepoint-scope');
  // Drop anything already cached so the try/catch really re-runs.
  for (const key of Object.keys(require.cache)) {
    if (key === ltPath || key === require.resolve(BACKUP)) delete require.cache[key];
  }
  Module._resolveFilename = function (request, parent, ...rest) {
    const resolved = (() => { try { return realResolve.call(this, request, parent, ...rest); } catch (_) { return null; } })();
    if (resolved === ltPath) { const e = new Error(`Cannot find module '${request}'`); e.code = 'MODULE_NOT_FOUND'; throw e; }
    return realResolve.call(this, request, parent, ...rest);
  };
  try {
    return require(BACKUP);
  } finally {
    Module._resolveFilename = realResolve;
    for (const key of Object.keys(require.cache)) {
      if (key === ltPath || key === require.resolve(BACKUP)) delete require.cache[key];
    }
  }
}

let degraded;
try {
  degraded = loadWithLtAbsent();
} catch (e) {
  assert.fail('sharepoint-backup.js must LOAD with the Long-Term module absent — '
    + 'that is the whole point of the try/catch. It threw: ' + e.message);
}
ok(degraded && typeof degraded === 'object', 'the mirror still loads with the side build absent');

// The stub itself is not exported, so read the source of the catch block and check
// each called name is answered there. A name present only in the real module is the
// exact defect this suite exists to catch.
const backupSrc = fs.readFileSync(BACKUP, 'utf8');
const catchBlock = backupSrc.split('let ltScope;')[1].split('\n}\n')[0];
ok(catchBlock && catchBlock.includes('ltScope = {'), 'the fallback stub is where this suite expects it');
for (const name of called) {
  ok(new RegExp(`\\b${name}\\s*:`).test(catchBlock),
    `the FALLBACK stub answers ${name} — without it, losing the side build fail-loops every `
    + 'borrower-scoped RTL document to DEAD');
}

/* ── 4. AND THE STUB'S PREDICATE AGREES WITH THE REAL ONE ────────────────────
   Present is not enough. A stub answering `isScopeKey: () => true` would satisfy the
   shape check above and then mis-file every borrower-profile document at the ADDRESS
   level — building, and permanently caching, the wrong folder chain.

   This reads the predicate off the STUB THE DEGRADED MODULE ACTUALLY BUILT
   (`_ltScope`, exported for exactly this). Re-implementing the stub's rule here and
   asserting against the copy would be a test that cannot fail — which is the same
   defect this suite exists to catch, one level up. */
const stub = degraded._ltScope;
ok(stub && typeof stub === 'object', 'the degraded module exposes the stub it built');
ok(typeof stub.isScopeKey === 'function', 'the stub really carries isScopeKey (not just the source text)');
for (const [key, expected] of [
  ['lt:abc', true], ['app:abc', false], ['borrower:abc', false], ['', false], [null, false], [undefined, false],
]) {
  ok(real.isScopeKey(key) === expected, `real isScopeKey(${JSON.stringify(key)}) === ${expected}`);
  ok(stub.isScopeKey(key) === expected, `STUB isScopeKey(${JSON.stringify(key)}) === ${expected}`);
}

console.log(`\ntest-lt-sharepoint-fallback-pure: ${n} checks passed`);
