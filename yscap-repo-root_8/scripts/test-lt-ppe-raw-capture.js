#!/usr/bin/env node
'use strict';
/**
 * LT — THE GUARD ON THE RAW LENDER PRICE CAPTURE SINK (owner-directed: "Save all the data that is
 * coming back, compress the data somewhere in the logs").
 *
 * Every paid Lender Price call returns a payload we parse and then throw away, so every later question
 * about it costs another paid call. Task #80 was answered out of files somebody had saved by hand;
 * §2.107's attempt to re-measure a run from its stored REPORT was lossy and had to be discarded,
 * because a report keeps conclusions and not evidence. This suite holds the four properties that make
 * a capture sink safe to leave switched on:
 *
 *   1. IT NEVER CAPTURES A CREDENTIAL, enforced twice — the token exchange is not a capturable KIND at
 *      all (so it cannot be reached even by a caller who wants to), and a scrub of credential-shaped
 *      keys runs anyway on what IS captured. An allowlist alone is one vendor change away from a leak
 *      (a token echoed inside a pricing response); a scrub alone is one forgotten key name away.
 *   2. IT NEVER THROWS. A full disk, an unwritable path, a circular payload — every one is a recorded
 *      skip. A sink that can raise is a sink that can take pricing down.
 *   3. IT IS BOUNDED. Over budget, the oldest payloads are evicted. This environment's writable space
 *      is a fixed per-session allowance and one Deephaven disqualify tree is 173 MB raw.
 *   4. IT IS INERT UNTIL A DIRECTORY IS NAMED, so nothing starts writing to a production container
 *      because a module was imported.
 *
 * PURE: no DB, no network, no Lender Price. Writes only inside its own temp directory. LT-only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const cap = require('../src/longterm/lenderprice/capture');

let pass = 0; const fails = [];
// Every capture's BYTES land off the event loop, so a test that reads a file must first await the
// write. `cap.flush()` is the same call a short-lived CLI has to make, so exercising it here is also
// the proof that the CLI contract works.
const settle = () => cap.flush({ timeoutMs: 20000 });
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-capture-test-'));
// The env is restored AFTER the body settles — with an async body a plain try/finally would put the
// variable back while the write was still in flight and the capture would land in the wrong place (or
// nowhere), which is a test bug that looks exactly like a production bug.
const withDir = async (dir, fn) => {
  const prev = process.env.LP_CAPTURE_DIR;
  if (dir == null) delete process.env.LP_CAPTURE_DIR; else process.env.LP_CAPTURE_DIR = dir;
  try { return await fn(); } finally { if (prev === undefined) delete process.env.LP_CAPTURE_DIR; else process.env.LP_CAPTURE_DIR = prev; }
};
const withBudget = async (mb, fn) => {
  const prev = process.env.LP_CAPTURE_MAX_MB;
  if (mb == null) delete process.env.LP_CAPTURE_MAX_MB; else process.env.LP_CAPTURE_MAX_MB = String(mb);
  try { return await fn(); } finally { if (prev === undefined) delete process.env.LP_CAPTURE_MAX_MB; else process.env.LP_CAPTURE_MAX_MB = prev; }
};

(async () => {
// ---------------------------------------------------------------------------
// A. INERT UNTIL A DIRECTORY IS NAMED.
// ---------------------------------------------------------------------------
await withDir(null, async () => {
  const r = cap.capture('price', { a: 1 });
  ok(r.ok === false && r.skipped === true && r.reason === 'no_capture_dir',
    `A1 with no directory it writes nothing and says why — got ${JSON.stringify(r)}`);
  ok(cap.captureDir() === null, 'A2 …and reports that it is switched off');
  ok(cap.readIndex().ok === false, 'A3 …and reading the index is a refusal, never a throw');
});
await withDir('   ', async () => ok(cap.captureDir() === null, 'A4 a whitespace-only directory is not a directory'));

// ---------------------------------------------------------------------------
// B. THE CREDENTIAL RULE — the strongest one here.
// ---------------------------------------------------------------------------
const dirB = path.join(ROOT, 'b'); fs.mkdirSync(dirB);
await withDir(dirB, async () => {
  // (1) THE KIND ALLOWLIST. The token exchange is not capturable at all.
  ok(!cap.CAPTURE_KINDS.includes('token') && !cap.CAPTURE_KINDS.includes('auth'),
    `B1 the auth/token exchange is not a capturable kind — got ${JSON.stringify(cap.CAPTURE_KINDS)}`);
  for (const k of ['token', 'auth', 'login', 'session', '', null, 'anything']) {
    const r = cap.capture(k, { password: 'hunter2' });
    ok(r.ok === false && r.reason === 'kind_not_capturable', `B2[${String(k)}] a non-allowlisted kind writes nothing`);
  }
  // (2) THE SCRUB, on what IS capturable — a vendor echoing a token inside a pricing response.
  const r = cap.capture('price', {
    results: { ok: 1 },
    session: { accessToken: 'AAA', refresh_token: 'BBB' },
    deep: [{ clientSecret: 'CCC' }, { fine: 'keep me' }],
    Authorization: 'Bearer zzz',
  }, { note: 'x', password: 'nope' });
  ok(r.ok === true, `B3 the pricing payload itself IS captured — got ${JSON.stringify(r)}`);
  await settle();
  const back = cap.readCapture(r.sha, dirB);
  const text = JSON.stringify(back || null);
  for (const leak of ['AAA', 'BBB', 'CCC', 'zzz', 'hunter2', 'nope']) {
    ok(!text.includes(leak), `B4[${leak}] no credential value survives into the stored payload`);
  }
  ok(text.includes('keep me') && ((back || {}).results || {}).ok === 1, 'B5 …while the real payload is stored intact');
  const idx = cap.readIndex(dirB);
  ok(!JSON.stringify(idx.rows).includes('nope'), 'B6 …and the INDEX is scrubbed too, not just the payload');
  ok(cap.looksSecretKey('Client-Secret') && cap.looksSecretKey('ACCESS_TOKEN') && !cap.looksSecretKey('program'),
    'B7 the key test ignores case and punctuation without catching ordinary field names');
});

// ---------------------------------------------------------------------------
// C. IT STORES ONCE, INDEXES EVERY TIME, AND ROUND-TRIPS.
// ---------------------------------------------------------------------------
const dirC = path.join(ROOT, 'c'); fs.mkdirSync(dirC);
await withDir(dirC, async () => {
  const payload = { results: { qualifiedNonQMData: { leafs: Array.from({ length: 500 }, (_, i) => ({ i, rate: 6.125 })) } } };
  const a = cap.capture('price', payload, { scenario: { _label: 'fico=660 cltv=75 dscr=1.25' } });
  const b = cap.capture('price', payload, { scenario: { _label: 'fico=660 cltv=75 dscr=1.25' }, note: 'a retry' });
  await settle();
  ok(a.ok && b.ok && a.sha === b.sha, 'C1 the same bytes resolve to one content-addressed name');
  const gz = fs.readdirSync(path.join(dirC, 'payloads')).filter((n) => n.endsWith('.json.gz'));
  ok(gz.length === 1, `C2 …and are stored ONCE — got ${gz.length} files`);
  const idx = cap.readIndex(dirC);
  ok(idx.rows.length === 2, `C3 …while BOTH sightings are indexed — got ${idx.rows.length}`);
  ok(idx.rows.every((r) => r.present === true), 'C4 …and the index says the bytes are still there');
  // The compressed size is only KNOWN once the write has run, so it comes off the handle rather than
  // the inline return — which is also the proof that the handle reports the real outcome.
  const landed = (await a.done) || {};
  ok(landed.ok === true && landed.gzBytes < landed.rawBytes / 2,
    `C5 it really is compressed — ${landed.gzBytes} vs ${landed.rawBytes} raw`);
  ok(idx.rows.every((r) => Number.isFinite(r.gzBytes) && r.gzBytes > 0),
    'C5b …and the index records the compressed size, not a placeholder');
  ok(JSON.stringify(cap.readCapture(a.sha, dirC)) === JSON.stringify(payload),
    'C6 …and what comes back out is what went in');
  // Read defensively: a mutation that stops the writes landing must produce NAMED failures here, not
  // a TypeError that hides every assertion after it (the standing rule — a crash is not proof).
  const row0 = idx.rows[0] || {};
  ok(((row0.meta || {}).scenario || {})._label === 'fico=660 cltv=75 dscr=1.25',
    `C7 a capture is findable by what it was ABOUT, not only by its hash — got ${JSON.stringify(row0.meta || null)}`);
  // Defensive again: with no file landed, `gz[0]` is undefined and path.join throws — which would
  // hide C9 and everything after it behind a crash instead of a named failure.
  let onDisk = null;
  try { onDisk = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(dirC, 'payloads', gz[0]))).toString('utf8')); } catch (_) { onDisk = null; }
  ok(JSON.stringify(onDisk) === JSON.stringify(payload),
    'C8 …and the file on disk is ordinary gzip anything can read');
  ok(fs.readdirSync(path.join(dirC, 'payloads')).every((n) => !n.endsWith('.tmp')),
    'C9 no temp file is left behind (a write is renamed into place, never truncated under its own hash)');
});

// ---------------------------------------------------------------------------
// D. IT NEVER THROWS.
// ---------------------------------------------------------------------------
const dirD = path.join(ROOT, 'd'); fs.mkdirSync(dirD);
await withDir(dirD, async () => {
  const circular = { a: 1 }; circular.self = circular;
  let threw = false; let res;
  try { res = cap.capture('price', circular); } catch (_) { threw = true; }
  ok(!threw, 'D1 a circular payload does not throw');
  ok(res && (res.ok === true || res.skipped === true), `D2 …it is either stored or skipped — got ${JSON.stringify(res)}`);
  ok(cap.capture('price', null).reason === 'empty_payload', 'D3 an empty payload is a named skip');
  ok(cap.readCapture('not-a-sha', dirD) === null, 'D4 asking for a payload that is not there answers null');
  ok(cap.readCapture('0'.repeat(64), dirD) === null, 'D5 …including a well-formed sha nobody stored');
  await settle();
});
await withDir(path.join(ROOT, 'd', 'blocked', 'deeper'), async () => {
  // A path that cannot be created (a FILE stands where the directory must go).
  fs.writeFileSync(path.join(ROOT, 'd', 'blocked'), 'not a directory');
  let threw = false; let res; let landed;
  try { res = cap.capture('price', { a: 1 }); landed = res && res.done ? await res.done : res; } catch (_) { threw = true; }
  ok(!threw, 'D6 an unwritable directory does not throw — not inline, and not on the handle either');
  ok(landed && landed.ok === false && /^(error:|write_failed)/.test(landed.reason || ''),
    `D7 …it is a recorded skip — got ${JSON.stringify(landed)}`);
  await settle();
});

// ---------------------------------------------------------------------------
// E. IT IS BOUNDED — oldest first, and the index outlives the bytes.
// ---------------------------------------------------------------------------
const dirE = path.join(ROOT, 'e'); fs.mkdirSync(dirE);
await withDir(dirE, () => withBudget(0.05, async () => {   // ~50 KB
  const shas = [];
  for (let i = 0; i < 12; i += 1) {
    // Genuinely INCOMPRESSIBLE payloads, or the budget is never reached and E1/E5 pass vacuously —
    // which is exactly what a first cut of this test did with repetitive filler that gzip ate. Hashed
    // hex is deterministic (no clock, no randomness) and compresses at best ~2x.
    let blob = '';
    for (let j = 0; j < 256; j += 1) blob += require('crypto').createHash('sha256').update(`${i}:${j}`).digest('hex');
    const r = cap.capture('price', { i, blob });
    if (r.ok) shas.push(r.sha);
    // Land this capture before the next one, so eviction sees a directory that is genuinely growing
    // one payload at a time rather than a burst that all arrives after the budget check.
    await settle();
    // Space the mtimes so "oldest" is well defined on a coarse filesystem clock.
    try { fs.utimesSync(path.join(dirE, 'payloads', `${r.sha}.json.gz`), new Date(1000 + i * 1000), new Date(1000 + i * 1000)); } catch (_) { /* evicted already */ }
  }
  await settle();
  const left = fs.readdirSync(path.join(dirE, 'payloads')).filter((n) => n.endsWith('.json.gz'));
  const total = left.reduce((n, f) => n + fs.statSync(path.join(dirE, 'payloads', f)).size, 0);
  ok(left.length < shas.length, `E1 over budget, payloads are evicted — kept ${left.length} of ${shas.length}`);
  ok(total <= cap.budgetBytes(), `E2 …until the directory fits the budget — ${total} <= ${cap.budgetBytes()}`);
  ok(left.includes(`${shas[shas.length - 1]}.json.gz`), 'E3 …and the NEWEST capture is the one kept');
  const idx = cap.readIndex(dirE);
  ok(idx.rows.length === shas.length, `E4 the index still records every capture ever made — got ${idx.rows.length}`);
  ok(idx.rows.some((r) => r.present === false),
    'E5 …and says plainly which bytes have aged out — "captured then evicted" is not "never captured"');
}));
ok(cap.budgetBytes() === 2048 * 1024 * 1024, 'E6 the default budget is 2 GB');
await withBudget('nonsense', async () => ok(cap.budgetBytes() === 2048 * 1024 * 1024, 'E7 an unreadable budget falls back to the default, never to zero'));
await withBudget(-5, async () => ok(cap.budgetBytes() === 2048 * 1024 * 1024, 'E8 …and so does a negative one'));

// ---------------------------------------------------------------------------
// G. THE EXPENSIVE HALF IS OFF THE EVENT LOOP.
// ---------------------------------------------------------------------------
// A Deephaven disqualify tree is 173 MB and `zlib.gzipSync` on that blocks the whole process for
// SECONDS. This is asserted STRUCTURALLY rather than by timing, because a wall-clock threshold on a
// shared CI box is a flaky test that eventually gets deleted — and deleting it would take the guard
// with it. The property is simply: this module does not call the synchronous compressor at all.
// Comments are stripped first: this module's own header EXPLAINS why gzipSync is not used, and a
// guard that reads comments would fail on the very sentence documenting the fix — and would then be
// "fixed" by deleting the explanation. (Same discipline as §2.107's source sweep.)
const capSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'capture.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
// `zlib\.gzipSync` and not a bare `gzipSync`, or this matches `gunzipSync` — which the READ path uses
// deliberately and correctly: reading a capture back is offline analysis, never the request path.
ok(!/\bzlib\.gzipSync\b/.test(capSrc), 'G1 the sink never calls zlib.gzipSync — compression runs on the threadpool');
ok(!/\b(writeFileSync|appendFileSync)\b/.test(capSrc), 'G2 …and never writes the payload or the index synchronously');
ok(/\bgunzipSync\b/.test(capSrc), 'G2b …while reading one back stays synchronous, which is not on any hot path');
ok(typeof cap.flush === 'function', 'G3 a short-lived process has a way to wait for the bytes to land');
const flushed = await cap.flush({ timeoutMs: 5 });
ok(flushed && flushed.ok === true, `G4 flushing with nothing in flight is an immediate ok — got ${JSON.stringify(flushed)}`);
await withDir(path.join(ROOT, 'g'), async () => {
  const h = cap.capture('price', { a: 1 });
  ok(h.pending === true && typeof h.done.then === 'function',
    'G5 a capture returns immediately with a handle, not a finished write');
  const settledH = await cap.flush({ timeoutMs: 20000 });
  ok(settledH.ok === true && settledH.waited >= 1, `G6 …and flush actually waited for it — got ${JSON.stringify(settledH)}`);
  ok(cap.readCapture(h.sha, path.join(ROOT, 'g')) != null, 'G7 …after which the bytes are readable');
});

// ---------------------------------------------------------------------------
// F. THE CLIENT IS WIRED TO IT, AND ONLY AT THE RAW-PAYLOAD SITES.
// ---------------------------------------------------------------------------
const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'lenderprice', 'client.js'), 'utf8');
ok(/require\(['"]\.\/capture['"]\)/.test(clientSrc), 'F1 the client requires the sink');
const calls = clientSrc.match(/rawCapture\.capture\(/g) || [];
ok(calls.length === 3, `F2 …and calls it at the three raw-payload sites — got ${calls.length}`);
ok(/rawCapture\.capture\('price'/.test(clientSrc) && /rawCapture\.capture\('disqualify'/.test(clientSrc),
  'F3 …for the priced payload and the disqualify tree');
ok(!/rawCapture\.capture\((?!'price'|'disqualify')/.test(clientSrc),
  'F4 …and for no other kind — a credential-bearing call can never be handed to it');
ok(/capture:\s*rawCapture/.test(clientSrc), 'F5 …and the sink is reachable from the client for a flush');

// THE PAID RUNNER MUST FLUSH. It exits the moment its last scenario returns, and the write is now off
// the event loop — so without this the bytes it just paid Lender Price for can be lost on exit. This
// is a source assertion because the runner needs live credentials and cannot be executed here.
const runnerSrc = fs.readFileSync(path.join(__dirname, 'test-lt-lp-agreement-run.js'), 'utf8');
ok(/capture\.flush\(/.test(runnerSrc), 'F6 the paid agreement runner awaits the captures before exiting');
const flushIdx = runnerSrc.indexOf('capture.flush(');
const exitIdx = runnerSrc.lastIndexOf('process.exit(');
ok(flushIdx > 0 && exitIdx > flushIdx, 'F7 …and it flushes BEFORE it exits, not after');

console.log(`${fails.length ? 'FAIL' : 'PASS'} — raw Lender Price capture sink: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
process.exit(fails.length ? 1 : 0);
})();
