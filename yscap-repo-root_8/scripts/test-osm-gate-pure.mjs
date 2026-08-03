/**
 * ONE CLOCK FOR OPENSTREETMAP — and the reason it needs an escape hatch.
 *
 * Nominatim's published limit is one request per second for the PROCESS, and four
 * places in this codebase call it. Three of them used to keep their OWN pacer, so
 * any two running together could fire twice inside one second while every one of
 * them looked correct in isolation. Merging them into one clock is right.
 *
 * It also creates a problem that did not exist before, and this file is mostly
 * about that problem: a BACKGROUND SWEEP now sits in front of an INTERACTIVE
 * caller. A 25-address ClickUp backfill tick parks ~28 seconds of work ahead of
 * the next keystroke on the public loan application — measured at 27,535ms
 * against 0ms when the clocks were separate. So the gate can be ASKED how long a
 * new caller would wait, and an interactive caller gives up instead of making
 * somebody watch a spinner for half a minute (address autocomplete degrades to
 * plain typing, which is what it does when the provider is down anyway).
 *
 * Measured, not reasoned about. Run: node scripts/test-osm-gate-pure.mjs
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const G = require(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'osm-gate.js'));
let pass = 0, fail = 0;
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) fail++; else pass++; };

G._internals.reset();
ok(G.osmWouldWait() === 0, 'an idle gate says a new caller waits no time');

// A background sweep parks 25 lookups. An interactive caller must be able to SEE
// that before it queues — this is the measurement that made the shared clock a
// regression for /suggest (27,535ms behind a backfill tick).
const sweep = [];
for (let i = 0; i < 25; i++) sweep.push(G.osmGate());
const would = G.osmWouldWait();
ok(would > 20000, `behind a 25-item sweep a new caller would wait ~${Math.round(would / 1000)}s — visible before queueing`);

G._internals.reset();
// The counter must DRAIN, or the gate would permanently claim to be busy.
await Promise.all([G.osmGate(), G.osmGate(), G.osmGate()]);
await new Promise((r) => setTimeout(r, 20));
const drained = G.osmWouldWait();
ok(drained < 1200, `the wait estimate drains once the queue does (${drained}ms)`);
// AND NEVER GOES NEGATIVE. `reset()` can zero the counter while turns are still
// pending, and their decrements would drive it below zero — which would make the
// shed check silently stop shedding, at the exact moment it is needed.
ok(drained >= 0, `and never reports a negative wait (${drained}ms)`);

// A rejecting caller must not poison the chain — one failed lookup breaking every
// future one until restart is the trap the private chains all documented.
G._internals.reset();
let threw = false;
try { await G.osmRun(async () => { throw new Error('provider blew up'); }); } catch { threw = true; }
ok(threw, "the caller still sees its own failure");
const after = await G.osmRun(async () => 'fine');
ok(after === 'fine', 'and the next caller through the gate is unaffected');

// The spacing is actually enforced.
G._internals.reset();
const t0 = Date.now();
await G.osmGate(); await G.osmGate(); await G.osmGate();
const span = Date.now() - t0;
ok(span >= 2 * G.MIN_GAP_MS - 50, `three turns are spaced ${span}ms apart, at least 2 x ${G.MIN_GAP_MS}`);

console.log(fail ? `\ntest-osm-gate-pure: ${pass} passed, ${fail} FAILED` : `\ntest-osm-gate-pure: ${pass} passed`);
process.exit(fail ? 1 : 0);
