#!/usr/bin/env node
'use strict';
/**
 * LT PPE — which doors of the pricing engine's HTTP surface does any suite actually INVOKE?
 *
 * THE DEFECT THIS EXISTS FOR, MEASURED BEFORE IT WAS WRITTEN. A probe that wrapped the router's own
 * layers and ran every `scripts/test-lt-*` suite found:
 *   · **0 of 35 route registrations** in `src/longterm/routes/ppe.js` invoked THROUGH the router — the
 *     mount, the admin-gate chain and `wrap()`'s 500 shape were proven only by regexes over this
 *     file's own text, which a router that never mounts the gate would satisfy just as well;
 *   · **6 exported handlers invoked by nothing at all** — `breakdownRoute`, `ruleCoverageRoute`,
 *     `getProgramLpScopeRoute`, `setProgramLpScopeRoute`, `parityCellsRoute`, `deleteScheduleRoute`.
 *
 * That is this workstream's recurring shape one layer further out: built, mounted, green, and asked by
 * nothing. `check-lt-reachability.js` asks whether a MODULE is loaded and
 * `check-lt-http-reachability.js` whether a SCREEN can reach a route; neither can see whether a TEST
 * ever drives one, and a route with no test is the same silence in a different room.
 *
 * THE RULE. Every route `src/longterm/routes/ppe.js` publishes must be invoked by at least one
 * `scripts/test-lt-ppe-*` suite — through the router, or by calling its handler directly — or be
 * recorded in `docs/longterm/LT-PPE-DOORS-UNTESTED.md` with the reason. It fails BOTH WAYS, exactly
 * like the two reachability gates it sits beside:
 *   · a door no suite invokes and nothing documents;
 *   · a ledger row for a door a suite DOES invoke now — a ledger that overstates what is unguarded is
 *     one nobody trusts, so covering a door means striking it off in the same commit.
 *
 * IT MEASURES, IT DOES NOT GREP. Both sides are derived from the thing itself: the doors from the
 * ROUTER's own `stack` (plus the source registration lines, only to name each door's handler and to
 * prove the two agree), and the coverage by RUNNING the suites with `lt-ppe-door-probe.js` preloaded
 * and watching the functions be called. A text scan would count the word `quoteRoute` in a comment.
 *
 * WHICH SUITES IT RUNS is derived too: the `test-lt-ppe-*` family (from `lt-suite-scan`, the same
 * module the runner and the suite-coverage gate read) filtered to those whose REQUIRE CLOSURE contains
 * the route file. A suite that cannot load the module cannot invoke it, and walking the graph rather
 * than grepping for a filename is what keeps the filter from quietly excluding a suite that reaches
 * the route through `src/server.js`.
 *
 * A DATABASE IS PART OF THE MEASUREMENT. Most of these doors only answer with one, so without
 * DATABASE_URL the suites that drive them skip and every door would read as untested. With no database
 * this REPORTS and exits 0 rather than crying wolf; `LT_REQUIRE_DB=1` makes that a failure, which is
 * what CI sets — the same posture as `test-lt-ppe-all.js`.
 *
 *   node scripts/check-lt-ppe-route-tests.js
 *   DATABASE_URL=… LT_REQUIRE_DB=1 node scripts/check-lt-ppe-route-tests.js
 *
 * LT-only.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const scan = require('./lt-suite-scan');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const ROUTE_FILE = path.join(ROOT, 'src', 'longterm', 'routes', 'ppe.js');
const LEDGER = path.join(ROOT, 'docs', 'longterm', 'LT-PPE-DOORS-UNTESTED.md');
const PROBE = path.join(HERE, 'lt-ppe-door-probe.js');

// ---------------------------------------------------------------------------
// the doors — from the router itself, cross-checked against its own source
// ---------------------------------------------------------------------------

/** `router.<method>('<path>', [requirePpeAdmin,] wrap(<handler>, '<code>'))` — for the handler NAMES. */
function registrationsFromSource() {
  const src = fs.readFileSync(ROUTE_FILE, 'utf8');
  const re = /router\.(get|post|put|patch|delete)\(\s*'([^']+)'\s*,\s*(requirePpeAdmin\s*,\s*)?wrap\(\s*([A-Za-z0-9_$]+)/g;
  const out = new Map();
  let m;
  while ((m = re.exec(src))) {
    out.set(`${m[1].toUpperCase()} ${m[2]}`, { handler: m[4], gated: !!m[3] });
  }
  return out;
}

/** Every route the ROUTER publishes, in registration order. */
function doors() {
  const router = require(ROUTE_FILE);
  const fromSource = registrationsFromSource();
  const out = [];
  for (const layer of router.stack || []) {
    if (!layer.route) continue;
    for (const s of layer.route.stack) {
      if (!s.method) continue;
      const key = `${s.method.toUpperCase()} ${layer.route.path}`;
      if (out.some((d) => d.key === key)) continue;
      const meta = fromSource.get(key) || {};
      out.push({ key, method: s.method.toUpperCase(), path: layer.route.path, handler: meta.handler || null });
    }
  }
  return { doors: out, fromSource };
}

// ---------------------------------------------------------------------------
// which suites CAN reach the route — the require closure, not a filename grep
// ---------------------------------------------------------------------------

// BOTH module systems, because several of these suites are `.mjs` and an `import` is a require the
// eye skips: reading only `require(...)` would silently drop a suite from the measurement and report
// the doors it drives as untested — a false alarm, which is the failure that gets a gate switched off.
const REQUIRE_RE = /(?:require\(\s*['"]([^'"]+)['"]\s*\)|(?:^|[\s;])import\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\))/g;

function closureReaches(entry, target, seen = new Set()) {
  const file = path.resolve(entry);
  if (seen.has(file)) return false;
  seen.add(file);
  if (file === target) return true;
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (_) { return false; }
  const dir = path.dirname(file);
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    if (!spec || !spec.startsWith('.')) continue; // a package can never be our route file
    let resolved;
    try { resolved = require.resolve(path.resolve(dir, spec)); } catch (_) { continue; }
    if (resolved === target) return true;
    if (!resolved.endsWith('.js') && !resolved.endsWith('.mjs')) continue;
    if (closureReaches(resolved, target, seen)) return true;
  }
  return false;
}

function candidateSuites() {
  return scan.ppeSuites(HERE).filter((f) => closureReaches(path.join(HERE, f), ROUTE_FILE));
}

// ---------------------------------------------------------------------------
// the ledger — same shape as docs/longterm/LT-ROUTES-UNREACHED.md
// ---------------------------------------------------------------------------

function ledgerRows() {
  let src = '';
  try { src = fs.readFileSync(LEDGER, 'utf8'); } catch (_) { return null; }
  const out = new Map();
  const re = /^\|\s*`([A-Z]+)\s+(\/[^`]*)`\s*\|\s*([^|]*?)\s*\|/gm;
  let m;
  while ((m = re.exec(src))) {
    const reason = m[3].trim();
    if (!reason || /^-+$/.test(reason)) continue; // a placeholder is not a reason
    out.set(`${m[1]} ${m[2]}`, reason);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the verdict — extracted so `test-lt-ppe-route-tests-gate.js` can prove it bites
// without a database and without re-running the family
// ---------------------------------------------------------------------------

/**
 * `table`   — every door the router publishes: [{ key, handler }]
 * `reached` — the Set of door keys some suite invoked
 * `ledger`  — Map(key -> reason) from LT-PPE-DOORS-UNTESTED.md
 * Returns the three ways this can be wrong, each a list of door keys.
 */
function judge(table, reached, ledger) {
  const undocumented = table.filter((d) => !reached.has(d.key) && !ledger.has(d.key)).map((d) => d.key);
  const stale = [...ledger.keys()].filter((k) => reached.has(k) && table.some((d) => d.key === k));
  const gone = [...ledger.keys()].filter((k) => !table.some((d) => d.key === k));
  return { undocumented, stale, gone };
}

function main() {
  const { doors: table, fromSource } = doors();
  console.log('check-lt-ppe-route-tests: which LT PPE doors does a suite actually invoke?');
  console.log(`  · routes the router publishes: ${table.length}`);

  // The router and its own source must agree about what is registered. They can only disagree if a
  // route is added some other way — and a door this checker cannot name is a door it cannot judge.
  const unnamed = table.filter((d) => !d.handler).map((d) => d.key);
  if (unnamed.length) {
    console.log(`\n  ✗ ${unnamed.length} route(s) the router publishes are not registered in the shape this reads:`);
    for (const k of unnamed) console.log(`      ${k}`);
    console.log('    Register them as `router.<method>(\'<path>\', [requirePpeAdmin,] wrap(<handler>, \'<code>\'))`,');
    console.log('    or teach this checker the new shape. A door it cannot name is a door it cannot guard.');
    process.exit(1);
  }
  const ghost = [...fromSource.keys()].filter((k) => !table.some((d) => d.key === k));
  if (ghost.length) {
    console.log(`\n  ✗ ${ghost.length} registration(s) in the source are not on the live router: ${ghost.join(', ')}`);
    process.exit(1);
  }

  const suites = candidateSuites();
  console.log(`  · LT PPE suites whose require closure reaches the route: ${suites.length}`);

  const hasDb = !!process.env.DATABASE_URL;
  if (!hasDb) {
    console.log('\n  ! DATABASE_URL is not set. Most of these doors only answer with a database, so the');
    console.log('    suites that drive them will skip and every door would read as untested. Reporting');
    console.log('    rather than failing — set LT_REQUIRE_DB=1 to make an unmeasured run a failure.');
    if (process.env.LT_REQUIRE_DB === '1') {
      console.log('\n  ✗ LT_REQUIRE_DB=1 and there is no database: this run measured nothing.');
      process.exit(1);
    }
    process.exit(0);
  }

  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lt-ppe-doors-')), 'hits.jsonl');
  const failedSuites = [];
  for (const f of suites) {
    const r = spawnSync(process.execPath, [path.join(HERE, f)], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 600000,
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require ${PROBE}`.trim(),
        LT_PPE_PROBE_TARGET: ROUTE_FILE,
        LT_PPE_PROBE_OUT: out,
        LT_PPE_PROBE_SUITE: f,
      },
    });
    if (r.status !== 0) failedSuites.push(`${f} (exit ${r.status})`);
  }

  // A suite that FAILED still counted whatever it invoked before it stopped, which is honest — but a
  // red suite is said out loud rather than folded into a coverage number.
  if (failedSuites.length) {
    console.log(`\n  ! ${failedSuites.length} suite(s) did not pass while being measured — their coverage is counted, their failure is not this gate's:`);
    for (const s of failedSuites) console.log(`      ${s}`);
  }

  const byDoor = new Map();
  const byHandler = new Map();
  for (const line of (fs.existsSync(out) ? fs.readFileSync(out, 'utf8').split('\n') : [])) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    for (const k of Object.keys(rec.hits || {})) {
      if (k.startsWith('route:')) {
        const key = k.slice('route:'.length);
        if (!byDoor.has(key)) byDoor.set(key, new Set());
        byDoor.get(key).add(rec.suite);
      } else if (k.startsWith('handler:')) {
        const name = k.slice('handler:'.length);
        if (!byHandler.has(name)) byHandler.set(name, new Set());
        byHandler.get(name).add(rec.suite);
      }
    }
  }

  // A DIRECT HANDLER CALL ONLY CREDITS A DOOR WHEN THAT HANDLER SERVES EXACTLY ONE ROUTE. Where two
  // routes share a handler, a call to it cannot say which of them was meant — and crediting both is
  // how a brand-new route pointing at an already-tested handler would read as covered on the day it
  // was added, which is the exact silence this gate exists to break. Those doors need the ROUTER.
  const routesPerHandler = new Map();
  for (const d of table) routesPerHandler.set(d.handler, (routesPerHandler.get(d.handler) || 0) + 1);

  const reached = [];
  const unreached = [];
  for (const d of table) {
    const viaRoute = byDoor.get(d.key);
    const viaHandler = routesPerHandler.get(d.handler) === 1 ? byHandler.get(d.handler) : null;
    if ((viaRoute && viaRoute.size) || (viaHandler && viaHandler.size)) reached.push(d);
    else unreached.push(d);
  }
  const shared = [...routesPerHandler.entries()].filter(([, count]) => count > 1).map(([h]) => h);
  if (shared.length) console.log(`  · handler(s) serving more than one route, so only the router can credit them: ${shared.join(', ')}`);
  const overHttp = table.filter((d) => (byDoor.get(d.key) || new Set()).size).length;

  console.log(`  · invoked by a suite: ${reached.length}`);
  console.log(`  · …of which THROUGH THE ROUTER (so the mount, the gate chain and wrap() ran too): ${overHttp}`);
  console.log(`  · invoked by nothing: ${unreached.length}`);

  const ledger = ledgerRows();
  if (ledger === null) {
    console.log(`\n  ✗ the ledger ${path.relative(ROOT, LEDGER)} is missing.`);
    console.log('    This check must never pass by having nothing to compare against.');
    process.exit(1);
  }

  let bad = false;
  const verdict = judge(table, new Set(reached.map((d) => d.key)), ledger);
  const { undocumented, stale, gone } = verdict;
  if (undocumented.length) {
    bad = true;
    console.log(`\n  ✗ ${undocumented.length} door(s) no suite invokes, and not recorded:`);
    for (const k of undocumented) {
      const d = table.find((x) => x.key === k);
      console.log(`      ${k}   (${d && d.handler})`);
    }
    console.log('    Give it a test, or record it in LT-PPE-DOORS-UNTESTED.md with the reason it cannot');
    console.log('    have one. A route nothing exercises is a route nothing protects.');
  }
  if (stale.length) {
    bad = true;
    console.log(`\n  ✗ ${stale.length} ledger row(s) are STALE — a suite DOES invoke these now:`);
    for (const k of stale) console.log(`      ${k}`);
    console.log('    Strike them off. A ledger that overstates what is unguarded is one nobody reads.');
  }
  if (gone.length) {
    bad = true;
    console.log(`\n  ✗ ${gone.length} ledger row(s) name a door that no longer exists:`);
    for (const k of gone) console.log(`      ${k}`);
  }
  if (bad) process.exit(1);

  console.log(`\n  ✓ every LT PPE door is either invoked by a suite or recorded with a reason (${unreached.length} recorded).`);
}

if (require.main === module) main();
module.exports = {
  doors, candidateSuites, ledgerRows, registrationsFromSource, judge, closureReaches,
  LEDGER, ROUTE_FILE, PROBE,
};
