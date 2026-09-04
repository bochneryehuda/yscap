#!/usr/bin/env node
/**
 * LT test — THE BAND BOARD REPORTS WHILE IT WORKS (owner-directed 2026-09-04).
 *
 * The progress bar is only worth anything if the reports genuinely arrive DURING the
 * search rather than all at once at the end — which is exactly the failure a buffering
 * proxy, a missing flush, or a client that waits for the whole body produces, and every
 * one of those looks identical in the source. So this drives the REAL route handler and
 * the REAL browser reader over a REAL socket and measures the ordering.
 *
 * ⛔ THE ROUTE'S TRANSPORT IS THE PART UNDER TEST, and it is exercised with the work
 * injected. Two live rate sheets cannot be reached from CI, and they are not what has
 * the traps in it: the traps are that the HTTP status is spent at the first byte, that
 * an up-front refusal must therefore happen before anything is written, and that a
 * failure AFTER that has to travel as a line instead. All three are checked here.
 *
 * ⛔ AND THE CLIENT IS THE SHIPPED ONE. `app-v2/src/longterm/http.js` imports cleanly
 * under Node (its one browser call, `localStorage`, is already inside a try) so the
 * reader that runs in the officer's browser is the reader that runs here — not a
 * re-implementation of it that would agree with itself for ever.
 *
 * No database, no vendor, no browser. One loopback socket.
 */
import http from 'http';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const express = require('express');
const { _internals } = require(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'));
const { ltStreamNdjson } = await import(new URL('../app-v2/src/longterm/http.js', import.meta.url));

let failures = 0;
const ok = (c, l) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('LT — the band board streams its progress, and the browser reads it\n');

/* ── the harness ────────────────────────────────────────────────────────────
   One app, one route, and a board function the test supplies per case. */
const cases = Object.create(null);
const app = express();
app.use(express.json());
app.post('/b/:name', (req, res) => {
  const board = cases[req.params.name];
  return _internals.priceBracketsStream(req, res, board).catch((e) => {
    if (res.headersSent) { try { res.end(); } catch { /* gone */ } return; }
    res.status(500).json({ ok: false, error: 'lt_dscr_price_brackets_error', message: e.message });
  });
});
const server = http.createServer(app);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/b`;

/* ── A. THE REPORTS ARRIVE WHILE THE WORK IS STILL RUNNING ──────────────────
   The board sleeps between bands. If anything buffers — the route, a missing flush,
   the reader — every event lands at the end and the timestamps collapse. */
{
  cases.slow = async (req, res, onProgress) => {
    onProgress({ phase: 'start', totalBands: 11, seedTier: 7 });
    for (const tier of [7, 6, 8]) {
      await sleep(60);
      onProgress({ phase: 'bracket', tier, ok: true, rates: 3, settled: tier, totalBands: 11 });
    }
    onProgress({ phase: 'finished', settled: 11, totalBands: 11 });
    return { status: 200, body: { ok: true, brackets: [{ tier: 7 }], searchedBrackets: [6, 7, 8] } };
  };
  const t0 = Date.now();
  const seen = [];
  const out = await ltStreamNdjson(`${base}/slow`, { scenario: {} }, (ev) => seen.push({ ...ev, at: Date.now() - t0 }));
  const done = Date.now() - t0;
  ok(out && out.ok === true && Array.isArray(out.searchedBrackets),
    'A1 the answer comes back, and it is the same object the plain door returns');
  ok(seen.length === 5, `A2 every report arrived (${seen.length} of 5)`);
  ok(seen[0].phase === 'start' && seen[seen.length - 1].phase === 'finished',
    'A3 …in order, from the start of the run to the end of it');
  /* ⛔ THE MEASUREMENT THIS FILE EXISTS FOR. The first band answers ~60ms in and the
     whole run takes ~180ms; if anything buffered, the first event would arrive with the
     last. Half the total is a wide margin on a loopback socket and still fails hard on a
     buffered response, where the gap is zero. */
  const first = seen.find((e) => e.phase === 'bracket');
  ok(first && first.at < done * 0.7,
    `A4 ⛔ the first band was reported at ${first ? first.at : '—'}ms of a ${done}ms run — the bar really does move while the search is going`);
  ok(seen.filter((e) => e.phase === 'bracket').every((e) => e.t === 'progress'),
    'A5 …and every report is marked as one, so nothing can be mistaken for the answer');
}

/* ── B. THE ANSWER IS THE LAST LINE, AND IT IS NOT A REPORT ────────────────── */
{
  cases.plain = async () => ({ status: 200, body: { ok: true, brackets: [], marker: 'THE-ANSWER' } });
  const seen = [];
  const out = await ltStreamNdjson(`${base}/plain`, {}, (ev) => seen.push(ev));
  /* ⛔ AND IT COMES BACK AS PLAIN JSON WITH A REAL STATUS, not as a one-line stream.
     Nothing was reported, so the status had not been spent and the route kept it — the
     same body, byte for byte, that the plain door sends. The reader tells the two apart
     by the content type, which is also what lets it be pointed at the plain door on the
     404 fallback. Reading this as a progress line was the first cut's defect and it lost
     the board entirely. */
  ok(out.marker === 'THE-ANSWER', 'B1 a run that reports nothing still answers');
  ok(seen.length === 0, 'B2 …with no progress events at all, and no invented ones');
  ok(!('t' in out), 'B3 …and the envelope key never reaches the caller');
}

/* ── C. A REFUSAL BEFORE THE FIRST BYTE IS STILL A REAL STATUS ──────────────
   This is why `bracketBoardFor` does its two validations first: once the 200 has gone
   there is no way back to a 422, and a screen that reads a status would be told the
   search succeeded. */
{
  cases.refuse = async (req, res) => { res.status(422).json({ ok: false, error: 'unknown_loan_purpose', message: 'no' }); return { handled: true }; };
  let caught = null;
  try { await ltStreamNdjson(`${base}/refuse`, {}, () => {}); } catch (e) { caught = e; }
  ok(caught && caught.status === 422, `C1 an up-front refusal is a real HTTP status (${caught && caught.status})`);
  ok(caught && /no/.test(caught.message) && caught.data && caught.data.error === 'unknown_loan_purpose',
    'C1a …carrying the server\'s own sentence and code, exactly as the plain door does');

  // A refusal the RUNNER produced, with nothing streamed yet — the status is still ours.
  cases.late422 = async () => ({ status: 422, body: { ok: false, error: 'lt_bracket_figures_incomplete', message: 'need the rent' } });
  let c2 = null;
  try { await ltStreamNdjson(`${base}/late422`, {}, () => {}); } catch (e) { c2 = e; }
  ok(c2 && c2.status === 422 && /rent/.test(c2.message),
    'C2 …and so is one the runner produced before a single band was reported');
}

/* ── D. A FAILURE AFTER THE STREAM STARTED TRAVELS AS A LINE ────────────────
   The status is spent. The one thing that must not happen is a silent truncation the
   screen reads as "no bands". */
{
  cases.blowup = async (req, res, onProgress) => {
    onProgress({ phase: 'start', totalBands: 11 });
    throw new Error('the sheet fell over mid-run');
  };
  const seen = [];
  const out = await ltStreamNdjson(`${base}/blowup`, {}, (ev) => seen.push(ev));
  ok(seen.length === 1 && out && out.ok === false,
    'D1 a throw after the first report comes back as a result line saying so');
  ok(out.error === 'lt_dscr_price_brackets_error' && /fell over/.test(out.message || ''),
    `D1a …naming what went wrong rather than an empty board (${out.message})`);

  // And a stream that simply STOPS is not read as an empty answer.
  cases.truncated = async (req, res, onProgress) => {
    onProgress({ phase: 'start', totalBands: 11 });
    res.end();                       // no result line, ever
    return { status: 200, body: { ok: true, brackets: [] } };
  };
  let cut = null;
  try { await ltStreamNdjson(`${base}/truncated`, {}, () => {}); } catch (e) { cut = e; }
  ok(cut && /ended before it answered/i.test(cut.message),
    `D2 ⛔ a stream that stops short THROWS — it is never read as a board with no bands (${cut && cut.message})`);
}

/* ── E. A LINE SPLIT ACROSS TWO PACKETS IS STILL ONE OBJECT ─────────────────
   The reader buffers on newlines; a report large enough to be split by TCP is the
   ordinary case, not an exotic one. Forced here by making one enormous. */
{
  cases.big = async (req, res, onProgress) => {
    onProgress({ phase: 'round', tiers: [1, 2, 3], filler: 'x'.repeat(200000) });
    return { status: 200, body: { ok: true, brackets: [], marker: 'AFTER-THE-BIG-ONE' } };
  };
  const seen = [];
  const out = await ltStreamNdjson(`${base}/big`, {}, (ev) => seen.push(ev));
  ok(seen.length === 1 && seen[0].filler && seen[0].filler.length === 200000,
    'E1 a report far larger than one packet is reassembled into one object');
  ok(out.marker === 'AFTER-THE-BIG-ONE', 'E2 …and the answer after it is still read');
}

/* ── F. THE NON-STREAMING FALLBACK READS THE SAME LINES ─────────────────────
   An older browser, or a proxy that collected the whole body, has no `res.body` to
   read. That path must still produce the answer — losing a board to protect a progress
   bar would be the decoration costing the thing it decorates. Forced by handing the
   reader a Response whose body is not readable. */
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const r = await realFetch(...args);
    const text = await r.text();
    // A Response-alike with NO getReader, which is exactly what the old path looks like.
    return { ok: r.ok, status: r.status, headers: r.headers, body: null, text: async () => text, json: async () => JSON.parse(text) };
  };
  try {
    cases.fb = async (req, res, onProgress) => {
      onProgress({ phase: 'start', totalBands: 11 });
      onProgress({ phase: 'bracket', tier: 7, ok: true, rates: 2 });
      return { status: 200, body: { ok: true, brackets: [{ tier: 7 }], marker: 'FELL-BACK' } };
    };
    const seen = [];
    const out = await ltStreamNdjson(`${base}/fb`, {}, (ev) => seen.push(ev));
    ok(out.marker === 'FELL-BACK', 'F1 a response with no readable stream still yields the board');
    ok(seen.length === 2, 'F2 …and the reports are still read, all at once instead of as they happened');
  } finally { globalThis.fetch = realFetch; }
}

/* ── G. A LISTENER THAT THROWS NEVER COSTS THE BOARD ────────────────────────
   The likeliest one: the screen unmounted mid-search. */
{
  cases.g = async (req, res, onProgress) => {
    onProgress({ phase: 'start', totalBands: 11 });
    onProgress({ phase: 'bracket', tier: 7, ok: true, rates: 1 });
    return { status: 200, body: { ok: true, marker: 'SURVIVED' } };
  };
  const out = await ltStreamNdjson(`${base}/g`, {}, () => { throw new Error('unmounted'); });
  ok(out.marker === 'SURVIVED', 'G1 a listener that throws on every event does not cost the answer');
}

/* ── H. THE ROUTE IS ACTUALLY REGISTERED ────────────────────────────────────
   Everything above drives the handler directly; this is what proves a browser can
   reach it. */
{
  const dp = require(path.join(ROOT, 'src/longterm/routes/dscr-pricer.js'));
  const paths = (dp.makeRouter().stack || [])
    .filter((l) => l.route)
    .map((l) => `${Object.keys(l.route.methods).join(',')} ${l.route.path}`);
  ok(paths.includes('post /price-brackets/stream'),
    `H1 the streaming door is on the router a browser talks to (${paths.filter((p) => /brackets/.test(p)).join(' | ')})`);
  ok(paths.includes('post /price-brackets'),
    'H2 …and the plain door is untouched beside it, which is what the fallback lands on');
}

server.close();
console.log(`\n${failures ? `FAILED (${failures})` : 'OFFLINE: all passed'}`);
process.exit(failures ? 1 : 0);
