#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the gate that proves `check-lt-ppe-route-tests.js` still BITES.
 *
 * A checker is a test like any other, and the one failure mode that matters for a checker is the one
 * nobody notices: it goes green because it stopped looking. This suite is the same shape
 * `test-lt-http-reachability-gate.js` is to its own checker — it drives the checker's own decision
 * function through every way it must fail, and it re-asserts the two derivations the whole gate rests
 * on (the door table, and which suites can reach the route).
 *
 * PURE: no database, no network, and it never re-runs the family — the checker's expensive half is
 * the measurement, and what needs guarding is the JUDGEMENT.
 *
 *   node scripts/test-lt-ppe-route-tests-gate.js
 *
 * LT-only.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const C = require('./check-lt-ppe-route-tests');

let failures = 0;
let n = 0;
const ok = (cond, label) => { n += 1; console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures += 1; };

console.log('the gate that guards check-lt-ppe-route-tests.js');

// ── 1) the door table is DERIVED, and the two derivations agree ─────────────
const { doors: table, fromSource } = C.doors();
ok(table.length >= 30, `G1 the router publishes ${table.length} doors, read off the router itself`);
ok(table.every((d) => /^[A-Z]+ \//.test(d.key)), 'G2 …each keyed `METHOD /path`, the shape the ledger and the two reachability gates use');
ok(table.every((d) => d.handler), 'G3 …and every one is NAMED by its own registration line — a door it cannot name is one it cannot guard');
ok(fromSource.size === table.length,
  `G4 the source registrations and the live router agree about how many doors there are (${fromSource.size} vs ${table.length})`);

// ── 2) the verdict, driven through every way it must fail ──────────────────
{
  const t = [{ key: 'GET /a', handler: 'a' }, { key: 'POST /b', handler: 'b' }];

  const clean = C.judge(t, new Set(['GET /a', 'POST /b']), new Map());
  ok(clean.undocumented.length === 0 && clean.stale.length === 0 && clean.gone.length === 0,
    'G5 CONTROL — every door invoked and an empty ledger is the clean state');

  const missed = C.judge(t, new Set(['GET /a']), new Map());
  ok(missed.undocumented.length === 1 && missed.undocumented[0] === 'POST /b',
    'G6 a door no suite invokes and nothing records is REFUSED, by name');

  const excused = C.judge(t, new Set(['GET /a']), new Map([['POST /b', 'waiting on a screen']]));
  ok(excused.undocumented.length === 0,
    'G7 …unless the ledger accounts for it — the escape hatch is a written reason, not silence');

  const stale = C.judge(t, new Set(['GET /a', 'POST /b']), new Map([['POST /b', 'stale row']]));
  ok(stale.stale.length === 1 && stale.stale[0] === 'POST /b',
    'G8 IT FAILS THE OTHER WAY TOO — a row for a door a suite DOES invoke is stale and is refused');

  const gone = C.judge(t, new Set(['GET /a', 'POST /b']), new Map([['DELETE /removed', 'a door that no longer exists']]));
  ok(gone.gone.length === 1 && gone.gone[0] === 'DELETE /removed',
    'G9 …and a row naming a door that no longer exists is refused, so the ledger cannot rot');
}

// ── 3) the ledger parser: a placeholder is not a reason ────────────────────
{
  const live = C.ledgerRows();
  ok(live instanceof Map, 'G10 the ledger parses (a missing ledger is a hard failure inside the checker)');
  const src = fs.readFileSync(C.LEDGER, 'utf8');
  ok(/\|\s*route\s*\|/.test(src) && /\|\s*---\s*\|/.test(src),
    'G11 …and the file really is the table shape the parser reads');
  ok(!live.has('route') && !live.has('---'),
    'G12 …with the header and its separator never read as rows');
}

// ── 4) which suites can reach the route — the closure, not a filename ──────
{
  const suites = C.candidateSuites();
  ok(suites.includes('test-lt-ppe-route.js'), 'G13 a suite that requires the route module is measured');
  ok(suites.includes('test-lt-ppe-http-db.js'), 'G14 …and so is one that reaches it through src/server.js, which no filename grep would find');
  ok(!suites.includes('test-lt-ppe-coverage.js'),
    'G15 …while a suite that cannot load the route is not run for nothing');
  ok(C.closureReaches(path.join(__dirname, 'test-lt-ppe-route.js'), C.ROUTE_FILE), 'G16 the closure walker answers yes about a direct require');
  ok(!C.closureReaches(path.join(__dirname, 'lt-suite-scan.js'), C.ROUTE_FILE), 'G17 …and no about a module that never reaches it');
}

// ── 5) the probe measures without being visible to the code it measures ────
//
// TWO THINGS AT ONCE, and both are load-bearing. The probe must record that a handler ran THROUGH the
// router; and it must leave the middleware chain alone, because `test-lt-ppe-http-db.js` asks which
// routes are gated by comparing each layer's first handle to `requirePpeAdmin` BY IDENTITY — an
// earlier version of the probe wrapped every handle, which silently turned that suite's answer into
// "0 routes are gated" and it went red for a reason that had nothing to do with the code under test.
{
  const out = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'lt-ppe-gate-')), 'hits.jsonl');
  const script = `
    const route = require(${JSON.stringify(C.ROUTE_FILE)});
    const gate = route._internals.requirePpeAdmin;
    let gatedIdentityKept = false;
    for (const layer of route.stack) {
      if (!layer.route) continue;
      if (layer.route.stack.length > 1 && layer.route.stack[0].handle === gate) { gatedIdentityKept = true; break; }
    }
    // Drive the TERMINAL handle of GET /health the way express would.
    const health = route.stack.find((l) => l.route && l.route.path === '/health');
    const chain = health.route.stack;
    const res = { headersSent: false, status() { return res; }, json() { res.headersSent = true; return res; } };
    Promise.resolve(chain[chain.length - 1].handle({ query: {}, params: {}, body: {} }, res))
      .catch(() => {})
      .then(() => { console.log(JSON.stringify({ gatedIdentityKept })); });
  `;
  const r = spawnSync(process.execPath, ['--require', C.PROBE, '-e', script], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL || '',
      LT_PPE_PROBE_TARGET: C.ROUTE_FILE,
      LT_PPE_PROBE_OUT: out,
      LT_PPE_PROBE_SUITE: 'gate-probe',
    },
  });
  let said = {};
  try { said = JSON.parse((r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop() || '{}'); } catch (_) { said = {}; }
  ok(said.gatedIdentityKept === true,
    'G18 the probe leaves requirePpeAdmin ITSELF in the chain — a suite can still ask which routes are gated by identity');

  const lines = fs.existsSync(out) ? fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean) : [];
  const hits = lines.length ? JSON.parse(lines[lines.length - 1]).hits : {};
  ok(hits['route:GET /health'] >= 1,
    `G19 …and it records the door that ran, through the router (${JSON.stringify(Object.keys(hits))})`);
  ok(Object.keys(hits).length === 1,
    'G20 …and only that one — a probe that credited a door nothing called would make the gate say the opposite of the truth');
}

// ── 6) the checker is in the chain that runs it ────────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  ok(/node scripts\/check-lt-ppe-route-tests\.js/.test(String(pkg.scripts.test || '')),
    'G21 `npm test` runs this checker — a gate the chain does not invoke guards nothing, which is the defect one layer out');
}

console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
process.exit(failures ? 1 : 0);
