#!/usr/bin/env node
'use strict';
/**
 * LT — WHAT HAVE WE BUILT THAT NOTHING CALLS?
 *
 * THE DEFECT CLASS THIS EXISTS FOR. This workstream has now found the same shape five separate
 * times: complete, unit-tested machinery with no caller anywhere in `src/`. The parity screen, the
 * Lender-Price scope writer, the canary schedule, the ≥200-scenario agreement gate, and every
 * rate-sheet writer. Each was found by hand, one at a time, and each looked fine from every angle
 * except the one nobody checks — **is anything wired to it?** The absence of a caller never fails a
 * test, never fails a build, and its symptom is a feature that silently does nothing.
 *
 * SO THE SET IS COMPUTED AND THE REASONS ARE AUTHORED. This walks `require()` from what the server
 * actually mounts and boots, and compares the unreachable set against the ledger in
 * `docs/longterm/LT-UNREACHED.md`. It fails when:
 *
 *   · a module is unreachable and is NOT in the ledger — something was built with no caller and no
 *     record of why, which is exactly how the five above happened; and
 *   · a module IS in the ledger but has since become reachable — a ledger that overstates what is
 *     unwired is a ledger nobody trusts, so wiring something means striking it off in the same
 *     commit.
 *
 * It is deliberately NOT a ban on unreachable modules. Half of this engine is written ahead of its
 * wiring on purpose (the Deephaven layers, the compilers, the drift chain), and a gate that failed on
 * all of them would be switched off within a day. What it bans is doing it SILENTLY.
 *
 * WHY THE REQUIRES ARE READ LINE BY LINE, and this is not a detail: a first cut stripped block
 * comments with a regex, and these files carry paths like `/api/lt/*` inside their headers — the `/*`
 * in one opens a comment that swallows everything down to the next `*​/`, which here meant the real
 * requires below it. That version reported 4 requires in `routes/ppe.js` where there are 29, and
 * declared the whole store layer dead. A confidently wrong map is worse than no map, so comments are
 * skipped per line and never by span.
 *
 * ADVISORY by default (it prints and exits 0) so it can never block somebody else's pull request on
 * a judgement call; `LT_REACHABILITY_ENFORCE=1` makes it blocking. That mirrors the two schema-drift
 * checks, whose enforcement is likewise the owner's call and not an agent's.
 *
 *   node scripts/check-lt-reachability.js
 *
 * LT-only. Reads source; touches no database and no network.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LT = path.join(ROOT, 'src', 'longterm');
const LEDGER = path.join(ROOT, 'docs', 'longterm', 'LT-UNREACHED.md');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Resolve one require target to a real file, or null. */
function resolveTarget(fromFile, spec) {
  let p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.js');
  if (!p.endsWith('.js')) p += '.js';
  return fs.existsSync(p) ? p : null;
}

/**
 * Relative requires in one file. LINE BY LINE, skipping lines that are themselves comments — see the
 * header for why a block-comment stripper cannot be used on these files.
 */
function requiresOf(file) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (t.startsWith('//') || t.startsWith('*')) continue;
    for (const m of t.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const r = resolveTarget(file, m[1]);
      if (r) out.push(r);
    }
  }
  return out;
}

function entryPoints() {
  const entries = [];
  const index = path.join(LT, 'index.js');
  if (fs.existsSync(index)) entries.push(index);

  // Whatever src/server.js pulls in from the Long-Term side — the router mount, any booted worker.
  const serverFile = path.join(ROOT, 'src', 'server.js');
  if (fs.existsSync(serverFile)) {
    for (const line of fs.readFileSync(serverFile, 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*')) continue;
      for (const m of t.matchAll(/require\(\s*['"](\.[^'"]*longterm[^'"]*)['"]\s*\)/g)) {
        const r = resolveTarget(serverFile, m[1]);
        if (r) entries.push(r);
      }
    }
  }
  // The sync workers are booted on their own rather than through the router.
  for (const f of walk(LT)) if (f.includes(`${path.sep}sync${path.sep}`)) entries.push(f);
  return [...new Set(entries)];
}

function computeUnreachable() {
  const all = walk(LT);
  const seen = new Set();
  const stack = entryPoints();
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const r of requiresOf(f)) if (!seen.has(r)) stack.push(r);
  }
  return {
    all,
    reachable: [...seen].filter((f) => f.startsWith(LT)),
    unreachable: all.filter((f) => !seen.has(f)).map((f) => path.relative(ROOT, f)).sort(),
  };
}

/** The ledger's own list: every line of the form `| `path` | … |` in the markdown table. */
function readLedger() {
  if (!fs.existsSync(LEDGER)) return null;
  const out = new Set();
  for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
    const m = line.match(/^\s*\|\s*`([^`]+)`\s*\|/);
    if (m) out.add(m[1].trim());
  }
  return out;
}

function main() {
  const { all, reachable, unreachable } = computeUnreachable();
  const ledger = readLedger();

  console.log('check-lt-reachability: what have we built that nothing calls?');
  console.log(`  · Long-Term modules: ${all.length}`);
  console.log(`  · reachable from the router / boot: ${reachable.length}`);
  console.log(`  · NOT reachable: ${unreachable.length}`);

  if (!ledger) {
    console.log(`\n  ! no ledger at ${path.relative(ROOT, LEDGER)} — create it, or this check can say nothing.`);
    process.exit(0);
  }

  const undocumented = unreachable.filter((f) => !ledger.has(f));
  const stale = [...ledger].filter((f) => !unreachable.includes(f)).sort();

  if (undocumented.length) {
    console.log(`\n  ✗ ${undocumented.length} module(s) nothing calls, and nothing records why:`);
    for (const f of undocumented) console.log(`      ${f}`);
    console.log('    Wire it, or add a row to docs/longterm/LT-UNREACHED.md saying what would.');
  }
  if (stale.length) {
    console.log(`\n  ✗ ${stale.length} ledger row(s) are STALE — these are reachable now:`);
    for (const f of stale) console.log(`      ${f}`);
    console.log('    Strike them off. A ledger that overstates what is unwired is one nobody trusts.');
  }
  if (!undocumented.length && !stale.length) {
    console.log('\n  ✓ every unwired module is recorded, and every recorded one is genuinely unwired.');
  }

  const bad = undocumented.length + stale.length;
  if (bad && process.env.LT_REACHABILITY_ENFORCE === '1') process.exit(1);
  process.exit(0);
}

if (require.main === module) main();
module.exports = { computeUnreachable, readLedger, requiresOf, _internals: { resolveTarget, entryPoints } };
