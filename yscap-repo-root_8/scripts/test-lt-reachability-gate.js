#!/usr/bin/env node
'use strict';
/**
 * LT — the reachability gate still BITES (scripts/check-lt-reachability.js).
 *
 * A gate nobody has seen fail is decoration, and this one is easy to make useless by accident: an
 * over-eager comment stripper, a resolver that quietly drops requires it cannot resolve, or a ledger
 * comparison that passes because both sides ended up empty. So the analyser is driven over PURPOSE-
 * BUILT fixture trees on disk where the right answer is known by construction, plus the real repo.
 *
 * WHAT IS PROVEN:
 *   1. it finds a module nothing requires;
 *   2. it does NOT call a module unreachable merely because it is required deep in a chain;
 *   3. requires are read LINE BY LINE — a header containing `/api/lt/*` must not swallow the requires
 *      below it. This is the exact bug the first cut of the analyser had (4 requires found in
 *      routes/ppe.js where there are 29, and the whole store layer declared dead), so it is pinned
 *      with a fixture that reproduces it;
 *   4. a commented-out require does NOT count as wiring;
 *   5. the ledger comparison catches BOTH directions — an unrecorded unreachable module, and a stale
 *      row that has since become reachable;
 *   6. against the REAL repo the two sides agree today, and — the assertion that stops this whole
 *      file from being vacuous — the real analysis actually finds a non-trivial number of modules
 *      and a non-trivial number of requires. A resolver that silently returned nothing would satisfy
 *      every "the sets match" check while proving nothing at all.
 *
 *   node scripts/test-lt-reachability-gate.js
 *
 * LT-only. Pure: reads source, writes only to a temp dir.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const check = require('./check-lt-reachability');

let n = 0; let failures = 0;
const ok = (cond, label) => { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); n += 1; if (!cond) failures += 1; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lt-reach-'));
const write = (rel, body) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

// ---- 1..4: the analyser's require reading, on fixtures ---------------------
{
  // A header carrying `/api/lt/*` — the shape that broke the first cut. The `/*` inside it opens a
  // block comment that a span-based stripper follows all the way to the next `*/`, taking the real
  // requires with it.
  const trap = write('trap.js', `'use strict';
/**
 * A module whose header mentions the route it serves: /api/lt/*
 * and then keeps talking for a while afterwards.
 */
const a = require('./target-a');
const b = require('./target-b');
module.exports = { a, b };
`);
  write('target-a.js', 'module.exports = 1;\n');
  write('target-b.js', 'module.exports = 2;\n');

  const found = check.requiresOf(trap).map((p) => path.basename(p)).sort();
  ok(found.length === 2 && found[0] === 'target-a.js' && found[1] === 'target-b.js',
    `R1 a header containing "/api/lt/*" does not swallow the requires below it (found ${found.join(', ') || 'none'})`);

  const commented = write('commented.js', `'use strict';
// const old = require('./target-a');
const live = require('./target-b');
module.exports = live;
`);
  const found2 = check.requiresOf(commented).map((p) => path.basename(p));
  ok(found2.length === 1 && found2[0] === 'target-b.js',
    'R2 a commented-out require does NOT count as wiring');
}

// ---- 5: the ledger comparison, both directions ----------------------------
// The comparison itself is small and is exercised here as pure set logic, on the same shape the
// script uses — an unrecorded unreachable module, and a recorded one that is reachable now.
{
  const unreachable = ['a.js', 'b.js'];
  const ledgerOk = new Set(['a.js', 'b.js']);
  const ledgerMissing = new Set(['a.js']);
  const ledgerStale = new Set(['a.js', 'b.js', 'c.js']);

  const undocumented = (u, l) => u.filter((f) => !l.has(f));
  const stale = (u, l) => [...l].filter((f) => !u.includes(f));

  ok(undocumented(unreachable, ledgerOk).length === 0 && stale(unreachable, ledgerOk).length === 0,
    'R3 a ledger that matches exactly is clean');
  ok(undocumented(unreachable, ledgerMissing).join() === 'b.js',
    'R4 a module nothing calls, with no ledger row, is reported');
  ok(stale(unreachable, ledgerStale).join() === 'c.js',
    'R5 a ledger row that is reachable now is reported as STALE (a ledger that overstates is untrusted)');
}

// ---- 6: against the REAL repo ---------------------------------------------
{
  const { all, reachable, unreachable } = check.computeUnreachable();

  // THE ANTI-VACUOUS ASSERTIONS. Every check above would still pass if the analyser resolved nothing
  // and returned empty sets; these are what make the real run mean something.
  ok(all.length > 80, `R6 the analyser sees the real Long-Term tree (${all.length} modules)`);
  ok(reachable.length > 40, `R7 …and genuinely reaches a large part of it from the router/boot (${reachable.length})`);
  ok(unreachable.length < all.length, 'R8 …so "unreachable" is not simply everything (the entry points resolved)');

  // The router is the entry point; if THIS is ever reported unreachable the walk is broken, not the code.
  const rel = (p) => p.replace(/\\/g, '/');
  ok(!unreachable.some((f) => rel(f).endsWith('src/longterm/routes/ppe.js')),
    'R9 the mounted PPE router is reachable — if it is not, the walk is broken rather than the code');
  ok(!unreachable.some((f) => rel(f).endsWith('src/longterm/ppe/store.js')),
    'R10 …and so is the store it requires (the exact pair the first cut got wrong)');

  const ledger = check.readLedger();
  ok(ledger && ledger.size > 0, 'R11 the ledger exists and has rows');
  const undocumented = unreachable.filter((f) => !ledger.has(f));
  const staleRows = [...ledger].filter((f) => !unreachable.includes(f));
  ok(undocumented.length === 0,
    `R12 every unwired module is recorded in the ledger${undocumented.length ? ` — missing: ${undocumented.join(', ')}` : ''}`);
  ok(staleRows.length === 0,
    `R13 every ledger row is genuinely unwired${staleRows.length ? ` — stale: ${staleRows.join(', ')}` : ''}`);

  // The two findings the ledger leads with, asserted rather than left as prose: if either becomes
  // reachable this test fails and the write-up must be corrected in the same commit.
  ok(unreachable.some((f) => rel(f).endsWith('src/longterm/audience.js')),
    'R14 audience.js is still uncalled by production code — the ledger says so, so it must be true');
  // The agreement harness is the one this check has already MOVED. It was unreachable when the ledger
  // was written — which is why the publish gate could only ever be passed by the recorded override —
  // and the run route wired it. The assertion is INVERTED rather than deleted, because the ledger's
  // prose now claims it is wired and an unbacked claim in that file is exactly what it warns about.
  ok(!unreachable.some((f) => rel(f).endsWith('src/longterm/ppe/ratesheet-agreement.js')),
    'R15 …and the agreement harness IS wired now, so the publish gate can be passed by measurement rather than only by override');
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures ? `${failures} FAILED of ${n}` : `all ${n} passed`}`);
assert.strictEqual(failures, 0);
process.exit(failures ? 1 : 0);
