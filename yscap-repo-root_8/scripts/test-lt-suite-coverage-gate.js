#!/usr/bin/env node
'use strict';
/**
 * LT — the suite-coverage gate's own guard (`scripts/check-lt-suite-coverage.js`).
 *
 * THE DEFECT THE GATE EXISTS FOR: eleven `scripts/test-lt-*.js` suites — about 167 assertions — were
 * executed by nothing at all, because suite membership was kept by hand in two places (`package.json`
 * names 59; `test-lt-ppe-all.js` globs the PPE ones) and the two had gone stale. A test nobody runs is
 * indistinguishable from a test that does not exist, except that it looks like coverage on the shelf.
 *
 * A GATE THAT CANNOT FAIL IS THE SAME DEFECT ONE LAYER UP, so this spawns the REAL checker over fixture
 * trees whose answer is known — copied there verbatim, so what is measured is the file that ships and
 * there is no test-only seam that could drift from how it actually runs.
 *
 * WHAT IS PROVEN:
 *   1. a suite nothing runs and nothing documents FAILS the gate, and is named;
 *   2. the same suite recorded in the ledger PASSES — the ledger is the deliberate escape hatch;
 *   3. a ledger row for a suite that IS run now FAILS as stale — a ledger that overstates what is
 *      unguarded is one nobody trusts;
 *   4. THE SHARP ONE: an aggregate runner whose glob covers everything contributes NOTHING when the
 *      chain does not actually invoke it. Assuming it does would be exactly the silent-green failure
 *      the gate was built to catch.
 *
 *   node scripts/test-lt-suite-coverage-gate.js
 *
 * PURE: no database, no network. LT-only.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const HERE = __dirname;
const CHECKER = path.join(HERE, 'check-lt-suite-coverage.js');
const SCAN = path.join(HERE, 'lt-suite-scan.js');

const SUITE_SRC = "'use strict';\nconsole.log('  ok  fixture');\n";
const PPE_ALL_SRC = "'use strict';\n// stands in for the aggregate runner; the gate only cares that the chain names it.\n";

/**
 * Build a fixture repo and run the REAL checker in it.
 *   suites  — filenames to create under scripts/
 *   chain   — the package.json `scripts.test` string
 *   ledger  — suite filenames to record in the ledger (null omits the file entirely)
 */
function runGate({ suites, chain, ledger }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-suite-cov-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.mkdirSync(path.join(dir, 'docs', 'longterm'), { recursive: true });
    fs.copyFileSync(CHECKER, path.join(dir, 'scripts', 'check-lt-suite-coverage.js'));
    fs.copyFileSync(SCAN, path.join(dir, 'scripts', 'lt-suite-scan.js'));
    for (const s of suites) {
      fs.writeFileSync(path.join(dir, 'scripts', s), s === 'test-lt-ppe-all.js' ? PPE_ALL_SRC : SUITE_SRC);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', scripts: { test: chain } }, null, 2));
    if (ledger) {
      const rows = ledger.map((s) => `| \`${s}\` | a fixture reason |`).join('\n');
      fs.writeFileSync(path.join(dir, 'docs', 'longterm', 'LT-SUITES-UNRUN.md'),
        `# fixture ledger\n\n| suite | why |\n|---|---|\n${rows}\n`);
    }
    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-lt-suite-coverage.js')],
      { encoding: 'utf8', cwd: dir });
    return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* a scratch dir is not a failure */ }
  }
}

// The fixture family: two suites the chain names, one PPE suite the aggregate globs, one orphan.
const SUITES = ['test-lt-fx-a.js', 'test-lt-fx-b.js', 'test-lt-ppe-fx-c.js', 'test-lt-fx-orphan.js', 'test-lt-ppe-all.js'];
const CHAIN_FULL = 'node scripts/test-lt-fx-a.js && node scripts/test-lt-fx-b.js && node scripts/test-lt-ppe-all.js';

// ---- 1) an undocumented orphan fails, and is named ----------------------------------------------
{
  const r = runGate({ suites: SUITES, chain: CHAIN_FULL, ledger: [] });
  ok(r.status === 1, 'G1 a suite executed by NOTHING fails the gate');
  ok(r.out.includes('test-lt-fx-orphan.js'), 'G2 …and the gate names it');
  ok(/executed by NOTHING: 1/.test(r.out), 'G3 exactly one orphan is counted — the globbed PPE suite is covered');
}

// ---- 2) the ledger is the deliberate escape hatch ------------------------------------------------
{
  const r = runGate({ suites: SUITES, chain: CHAIN_FULL, ledger: ['test-lt-fx-orphan.js'] });
  ok(r.status === 0, 'G4 the same orphan RECORDED in the ledger passes');
  ok(/every LT suite is either run/.test(r.out), 'G5 …and the gate says so plainly');
}

// ---- 3) a stale ledger row fails ------------------------------------------------------------------
{
  // `test-lt-fx-a.js` IS named in the chain, so a ledger row claiming it is unrun is a lie.
  const r = runGate({ suites: SUITES, chain: CHAIN_FULL, ledger: ['test-lt-fx-orphan.js', 'test-lt-fx-a.js'] });
  ok(r.status === 1, 'G6 a ledger row for a suite that IS run fails as STALE');
  ok(/STALE/.test(r.out) && r.out.includes('test-lt-fx-a.js'), 'G7 …and names the stale row');
}

// ---- 4) THE SHARP ONE: an aggregate runner the chain never invokes covers nothing ----------------
{
  // Same tree, but the chain no longer runs the aggregate. Its glob still MATCHES the PPE suite —
  // and must contribute nothing, or the gate would report coverage that CI does not perform.
  const chain = 'node scripts/test-lt-fx-a.js && node scripts/test-lt-fx-b.js';
  const r = runGate({ suites: SUITES, chain, ledger: ['test-lt-fx-orphan.js'] });
  ok(r.status === 1, 'G8 with the aggregate runner NOT in the chain, the suites it globs are uncovered');
  ok(r.out.includes('test-lt-ppe-fx-c.js'), 'G9 …and the globbed suite is named as unrun');
  ok(/does NOT run it/.test(r.out), 'G10 …with the reason stated: the chain never invokes the runner');
}

// ---- 5) a missing ledger fails rather than passing silently --------------------------------------
{
  const r = runGate({ suites: SUITES, chain: CHAIN_FULL, ledger: null });
  ok(r.status === 1, 'G11 no ledger at all fails — the check must never pass by having nothing to compare');
}

// ---- 6) the REAL repository is clean --------------------------------------------------------------
{
  const r = spawnSync(process.execPath, [CHECKER], { encoding: 'utf8' });
  ok(r.status === 0, 'G12 CONTROL — the real repository passes the gate today');
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt suite coverage gate (${n} assertions)`}`);
assert.strictEqual(failures, 0);
