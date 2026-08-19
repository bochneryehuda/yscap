#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE RAW CAPTURE WAS WIRED TO TWO DOORS THE PAID RUN NEVER OPENS (§2.112).
 *
 * ⛔ WHAT WAS BROKEN, and it was found by USING the thing rather than by reading it. §2.109 built the
 * raw-payload sink for the owner's standing instruction — "save all the data that is coming back" —
 * and its own text closed with "nothing is capturing yet; naming a directory is what starts it." A
 * directory was named on the live run of 2026-08-19 and the sink wrote:
 *
 *     8 price payloads, 14.0 MB raw -> 0.69 MB gzipped     0 DISQUALIFY payloads
 *
 * The disqualify tree is the BIGGER payload (§2.109 measured one at 173 MB) and it is the one carrying
 * the decline reasons this entire workstream is about. It was never saved.
 *
 * ROOT CAUSE: `client.js` has THREE disqualify functions and the sink was wired to two of them —
 * `pollDisqualified` and `pollDisqualifiedByKey`, the poll-only doors for a caller that already holds a
 * search key. The paid agreement run goes through `priceDisqualified` (see
 * `lp-agreement-legs.js`: "client.priceDisqualified(scenario, …)"), which had NO capture call on ANY of
 * its three payload-bearing returns. And the capture inside `pollDisqualified` was labelled
 * `via: 'priceDisqualified'` — naming a function it is not in — so the index would have blamed the
 * wrong door for every row it did write.
 *
 * ⛔ WHY §2.109's OWN SUITE PASSED ANYWAY, which is the lesson worth keeping. It asserted that
 * `client.js` hands the sink the string `'disqualify'` — a SOURCE-STRING assertion over the whole
 * file. That was true, and useless: the call existed, on a path nothing in the paid run reaches. **A
 * guard that asks "does this file mention X" cannot tell a live wire from a dead one.**
 *
 * SO THIS GUARD IS KEYED ON THE FUNCTION, NOT THE FILE. It splits `client.js` into its top-level
 * functions and asserts a STRUCTURAL invariant over each:
 *
 *   1. a function that RETURNS a payload of a capturable kind must CAPTURE that kind;
 *   2. every `via:` label must name the function it is written in;
 *   3. the runner must still await the flush, and the credential rule must still hold.
 *
 * Rule 1 fails the moment a fourth disqualify path is added without wiring, which is the whole class.
 * Rule 2 makes the mislabel permanently impossible.
 *
 * PURE: no DB, no network, no credentials. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const CLIENT = path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js');
const RUNNER = path.join(__dirname, 'test-lt-lp-agreement-run.js');
const LEGS = path.join(__dirname, '..', 'src', 'longterm', 'ppe', 'lp-agreement-legs.js');
const src = fs.readFileSync(CLIENT, 'utf8');

// ---- split into top-level functions ---------------------------------------------------------------
// `client.js` declares every function at column 0, so a closing brace at column 0 ends one. Asserted
// below rather than assumed: a file that stops following that shape must fail here loudly instead of
// silently splitting into one giant block that satisfies every rule by accident.
function topLevelFunctions(text) {
  const out = [];
  const lines = text.split('\n');
  let cur = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lines[i]);
    if (m) { cur = { name: m[1], line: i + 1, body: [] }; out.push(cur); continue; }
    if (cur) {
      if (/^\}/.test(lines[i])) { cur = null; continue; }
      cur.body.push(lines[i]);
    }
  }
  return out.map((f) => ({ ...f, body: f.body.join('\n') }));
}
const fns = topLevelFunctions(src);
ok(fns.length > 20, `S1 the file splits into its top-level functions — got ${fns.length}`);
const byName = new Map(fns.map((f) => [f.name, f]));
for (const n of ['price', 'priceDisqualified', 'pollDisqualified', 'pollDisqualifiedByKey']) {
  ok(byName.has(n), `S2 the ${n} door is found as its own function`);
}

// ---- 1. WHAT A FUNCTION RETURNS, IT CAPTURES ------------------------------------------------------
// The two capturable kinds and the shape of a return that carries one. `disqualified:` is the field
// `lp-agreement-legs` reads off this client; a `price` payload is returned as `raw` by `price()`.
// ⛔ THE TOKEN EXCHANGE IS STRUCTURALLY UNCAPTURABLE and is not on this list — a credential must never
// reach the sink, which is why CAPTURE_KINDS is a closed list and not "whatever a caller passes".
const RETURNS_DISQ = /\breturn\s*\{[^;]*\bdisqualified:/;
const CAPTURES_DISQ = /rawCapture\.capture\(\s*'disqualify'/;
const dqFns = fns.filter((f) => RETURNS_DISQ.test(f.body));
ok(dqFns.length >= 1, `C0 at least one function returns a disqualify payload — got ${dqFns.length}`);
for (const f of dqFns) {
  ok(CAPTURES_DISQ.test(f.body),
    `C1 ${f.name}() returns a disqualify payload, so it must CAPTURE one (client.js:${f.line}) — this is the §2.112 defect, and it is what a whole-file source check cannot see`);
}
// The paid agreement run's own door, named explicitly — a rename that quietly drops it from the sweep
// above would otherwise go unnoticed.
const pd = byName.get('priceDisqualified') || { body: '' };
ok(CAPTURES_DISQ.test(pd.body),
  'C2 priceDisqualified() — the ONE disqualify door the paid agreement run calls — captures');
const dqCalls = (pd.body.match(/rawCapture\.capture\(\s*'disqualify'/g) || []).length;
ok(dqCalls >= 3,
  `C3 …at EVERY return that carries a payload: the immediate tree, the polled tree, and the timed-out partial — got ${dqCalls}`);
ok(/ready:\s*false/.test(pd.body) && /ready:\s*true/.test(pd.body),
  'C4 …recording whether the tree was finished, so a partial can never be read as a complete one');

const pr = byName.get('price') || { body: '' };
ok(/rawCapture\.capture\(\s*'price'/.test(pr.body), 'C5 price() captures its ladder');

// ---- 2. A `via` LABEL NAMES THE FUNCTION IT IS WRITTEN IN -----------------------------------------
// ⛔ THE MISLABEL WAS REAL: the capture inside `pollDisqualified` claimed `via: 'priceDisqualified'`.
// An index that blames the wrong door is worse than no label — it is a confident wrong answer about
// where a payload came from, and it survives every test that only counts rows.
let viaChecked = 0;
for (const f of fns) {
  const re = /via:\s*'([A-Za-z0-9_$]+)'/g;
  let m;
  while ((m = re.exec(f.body))) {
    viaChecked += 1;
    ok(m[1] === f.name,
      `V1 a capture inside ${f.name}() labels itself "${m[1]}" — a via label must name its own function`);
  }
}
ok(viaChecked >= 3, `V2 there are via labels to check — got ${viaChecked}`);

// ---- 3. THE PAID RUN IS THE CALLER THIS WAS BUILT FOR --------------------------------------------
const legs = fs.readFileSync(LEGS, 'utf8');
ok(/client\.priceDisqualified\(/.test(legs),
  'R1 the agreement legs really do call priceDisqualified — the reason C2 is the load-bearing case');
const runner = fs.readFileSync(RUNNER, 'utf8');
ok(/client\.capture\.flush\(/.test(runner),
  'R2 the paid runner awaits the flush — the sink writes off the event loop, so a process that exits on its last scenario can exit before the bytes it paid for have landed');
// ⛔ AGAINST THE LAST `process.exit(`, NOT THE FIRST. The runner exits early on several `die()` paths
// long before any scenario is priced, so comparing against the first occurrence asks a question about
// argument validation and answers it about the flush. The one that matters is the exit at the end of a
// successful run.
ok(runner.indexOf('client.capture.flush(') < runner.lastIndexOf('process.exit('),
  'R3 …and it flushes BEFORE the exit that ends a successful run');

// ---- 4. THE CREDENTIAL RULE IS UNCHANGED ---------------------------------------------------------
const capture = require('../src/longterm/lenderprice/capture');
ok(JSON.stringify(capture.CAPTURE_KINDS) === JSON.stringify(['price', 'disqualify']),
  `K1 the capturable kinds are a CLOSED list — got ${JSON.stringify(capture.CAPTURE_KINDS)}`);
ok(!/rawCapture\.capture\(\s*'token'/.test(src) && !/rawCapture\.capture\(\s*[a-zA-Z]/.test(src),
  'K2 no call site hands the sink a computed kind — a variable here is how a token exchange gets captured by accident');

console.log(`${fails.length ? 'FAIL' : 'PASS'} — raw-capture wiring guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);
