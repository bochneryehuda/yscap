#!/usr/bin/env node
'use strict';
/**
 * LT — which HTTP routes can a person actually GET TO, and which are only reachable by curl?
 *
 * `check-lt-reachability.js` asks whether a MODULE is loaded. A route module is loaded by definition —
 * `src/longterm/index.js` mounts it — so every route inside it reads as reachable however dead it is.
 * This is that check one layer up, and it exists because the same defect keeps turning up at every
 * layer of this workstream: something is built, it loads, its tests pass, and nothing can reach it.
 *
 * It fails when a route no screen can call is not RECORDED, and it fails the other way too — a ledger
 * row for a route a screen now calls is STALE and is refused, because a ledger that overstates what is
 * unreachable is one nobody reads. `docs/longterm/LT-ROUTES-UNREACHED.md` is the deliberate escape
 * hatch: a route reached by a script, a worker, a vendor callback or a human with curl belongs there
 * WITH THAT REASON WRITTEN DOWN. Recording it is the point; a route nobody can name a caller for is the
 * thing this catches.
 *
 * It also reports, and refuses to smooth over:
 *   · an AMBIGUOUS match — a client path whose runtime-supplied segment lines up with a route's literal
 *     segment, so the call could be to this route or to its neighbour. Crediting one is exactly how a
 *     gate comes to report a dead route as live, so it is never counted as coverage;
 *   · a client call that matches NO route at all — a request that can only 404;
 *   · a screen that writes its own `/api/lt/...` URL instead of going through the one client, which is
 *     a call this scan cannot follow;
 *   · an `ltApi` entry no screen calls — the same dead end one step nearer the user.
 *
 *   node scripts/check-lt-http-reachability.js
 *
 * PURE: no database, no network. LT-only.
 */

const fs = require('fs');
const path = require('path');
const scan = require('./lt-http-scan');

const ROOT = path.resolve(__dirname, '..');
const LEDGER = path.join(ROOT, 'docs', 'longterm', 'LT-ROUTES-UNREACHED.md');

/** Ledger rows are `| `METHOD /path` | reason |`; the reason must be real text, not a placeholder. */
function ledgerRows() {
  let src = '';
  try { src = fs.readFileSync(LEDGER, 'utf8'); } catch (_) { return null; }
  const out = new Map();
  const re = /^\|\s*`([A-Z]+)\s+(\/[^`]*)`\s*\|\s*([^|]*?)\s*\|/gm;
  let m;
  while ((m = re.exec(src))) {
    const reason = m[3].trim();
    if (!reason || /^-+$/.test(reason)) continue;
    out.set(`${m[1]} ${m[2]}`, reason);
  }
  return out;
}

function main() {
  const routes = scan.serverRoutes(ROOT);
  const calls = scan.clientCalls(ROOT);
  const rows = scan.reachability(routes, calls);
  const entries = scan.clientEntries(ROOT);
  const strays = scan.strayFetches(ROOT);
  const { unknown: unknownVerbs } = scan.clientVerbs(ROOT);

  console.log('check-lt-http-reachability: which LT routes can a screen actually reach?');
  console.log(`  · routes published: ${routes.length}`);
  console.log(`  · calls in the one client (app-v2/src/longterm/api.js): ${calls.length}`);

  const reached = rows.filter((r) => r.calls.length);
  const unreached = rows.filter((r) => !r.calls.length);
  const ambiguous = rows.filter((r) => !r.calls.length && r.ambiguous.length);
  const orphanCalls = calls.filter((c) => !rows.some((r) => r.calls.includes(c)));

  console.log(`  · reachable from a screen: ${reached.length}`);
  console.log(`  · reachable by nothing this can see: ${unreached.length}`);

  const ledger = ledgerRows();
  let failed = 0;

  if (ledger === null) {
    console.log(`\n  ✗ the ledger ${path.relative(ROOT, LEDGER)} is missing.`);
    console.log('    This check must never pass by having nothing to compare against.');
    process.exit(1);
  }

  const undocumented = unreached.filter((r) => !ledger.has(`${r.method} ${r.path}`));
  if (undocumented.length) {
    failed += 1;
    console.log(`\n  ✗ ${undocumented.length} route(s) no screen can reach, and not recorded:`);
    for (const r of undocumented) console.log(`      ${r.method} ${r.path}   (${r.file})`);
    console.log('    Give it a caller, or record it in LT-ROUTES-UNREACHED.md with the reason it has');
    console.log('    none. A route nobody can reach is not a feature.');
  }

  const stale = [...ledger.keys()].filter((k) => {
    const r = rows.find((x) => `${x.method} ${x.path}` === k);
    return r && r.calls.length;
  });
  if (stale.length) {
    failed += 1;
    console.log(`\n  ✗ ${stale.length} ledger row(s) are STALE — a screen DOES reach these now:`);
    for (const k of stale) console.log(`      ${k}`);
    console.log('    Take the row out. A ledger that overstates what is unreachable is one nobody reads.');
  }

  const gone = [...ledger.keys()].filter((k) => !rows.some((x) => `${x.method} ${x.path}` === k));
  if (gone.length) {
    failed += 1;
    console.log(`\n  ✗ ${gone.length} ledger row(s) name a route that no longer exists:`);
    for (const k of gone) console.log(`      ${k}`);
  }

  if (unknownVerbs.length) {
    // A helper whose method cannot be read makes every call through it INVISIBLE to this scan, which
    // would report live routes as unreachable — the cry-wolf failure that gets a gate switched off.
    failed += 1;
    console.log(`\n  ✗ ${unknownVerbs.length} client helper(s) whose HTTP method cannot be read:`);
    for (const v of unknownVerbs) console.log(`      ${v}`);
    console.log('    Every call made through one is invisible here. Give it an explicit method, or');
    console.log('    route it through ltFetch.');
  }

  if (orphanCalls.length) {
    failed += 1;
    console.log(`\n  ✗ ${orphanCalls.length} client call(s) match NO route — these can only 404:`);
    for (const c of orphanCalls) console.log(`      ${c.method} ${c.path}`);
  }

  if (ambiguous.length) {
    // Reported, never fatal: it is a limit of reading source rather than running it, and the routes it
    // concerns are already counted as UNREACHED, which is the safe side.
    console.log(`\n  ! ${ambiguous.length} route(s) have only an AMBIGUOUS caller — a client path whose`);
    console.log('    runtime segment could mean this route or its neighbour. Counted as unreached, which');
    console.log('    is the honest side: crediting a maybe is how a dead route comes to read as live.');
    for (const r of ambiguous) console.log(`      ${r.method} ${r.path}`);
  }

  if (strays.length) {
    console.log(`\n  ! ${strays.length} screen(s) write their own /api/lt/ URL instead of using the one client:`);
    for (const f of strays) console.log(`      ${f}`);
    console.log('    Those requests are invisible to this scan. Route them through ltApi.');
  }

  const uncalled = entries.filter((e) => !e.called);
  if (uncalled.length) {
    console.log(`\n  ! ${uncalled.length} ltApi entr(ies) that no screen calls — the same dead end, one step nearer the user:`);
    for (const e of uncalled) console.log(`      ltApi.${e.name}`);
  }

  if (failed) process.exit(1);
  console.log(`\n  ✓ every LT route is either reachable from a screen or recorded with a reason (${unreached.length} recorded).`);
  process.exit(0);
}

main();
