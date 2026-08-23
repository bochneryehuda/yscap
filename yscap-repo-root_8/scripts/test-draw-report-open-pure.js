/**
 * Opening a draw report — the fix for the owner-reported *"it's going to a blank
 * page. It takes a very long time, and sometimes it's not even opening."*
 * PURE: no database, no storage, no PDF renderer.
 *
 * Two things had to be true for that report to stop looking broken:
 *
 *   A. ONE BUILD, NOT N — proved against src/lib/single-flight.js, the shared rule
 *      both report builders now use. Building a report is a SYNCHRONOUS jsPDF
 *      render over every archived photo; it holds the Node event loop for as long
 *      as it runs. Two of them in flight is a web service that has stopped
 *      answering, which from the outside is indistinguishable from a slow page —
 *      which is exactly why it was reported as "sometimes it's not even opening"
 *      rather than as an outage.
 *
 *   B. ONE BUILDER, NOT FOUR — proved structurally. The staff, borrower, TPO and
 *      public-token routes each carried their own inline copy of the build
 *      sequence. A copy is how a fix lands in one route and the other three go on
 *      stalling the service, so the rule is enforced rather than remembered. And
 *      every route that SERVES a report must offer the cheap "is it ready?" probe
 *      beside it — a screen that cannot ask is a screen that must show a blank
 *      page, which is the defect itself.
 */
const path = require('path');
const fs = require('fs');
const R = path.resolve(__dirname, '..');
const { singleFlight, inFlight } = require(R + '/src/lib/single-flight');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- A. one build, however many callers --------------------------------
  const m = new Map();
  let renders = 0;
  const render = async () => { renders++; await sleep(25); return { doc: 'doc-' + renders }; };

  const [a, b, c] = await Promise.all([
    singleFlight(m, 'report:v1', render),
    singleFlight(m, 'report:v1', render),
    singleFlight(m, 'report:v1', render),
  ]);
  ok(renders === 1, `three simultaneous opens ran ONE render (ran ${renders})`);
  ok(a.doc === b.doc && b.doc === c.doc, 'all three callers get the same result object');

  // A DIFFERENT report is never made to wait behind an unrelated one — the key is
  // the version-hashed filename, not a global lock.
  renders = 0;
  await Promise.all([singleFlight(m, 'report:v1', render), singleFlight(m, 'report:v2', render)]);
  ok(renders === 2, `two different reports both build (${renders} renders)`);

  // Once it settles the entry is gone, so a later open starts fresh rather than
  // being handed a stale promise from an hour ago.
  ok(!inFlight(m, 'report:v1'), 'the in-flight entry is cleared when the job settles');

  // ---- a FAILED build is not cached as the answer -------------------------
  let attempts = 0;
  const flaky = async () => { attempts++; if (attempts === 1) throw new Error('render blew up'); return 'ok'; };
  let threw = false;
  try { await singleFlight(m, 'flaky', flaky); } catch (e) { threw = /blew up/.test(e.message); }
  ok(threw, 'a failing job rejects with its own error — nothing is swallowed');
  ok(await singleFlight(m, 'flaky', flaky) === 'ok' && attempts === 2,
    'the NEXT caller retries — a failure is never cached as the answer');

  // Callers that share a failing job all see the failure, not one of them.
  attempts = 0;
  const alwaysFails = async () => { attempts++; await sleep(5); throw new Error('nope'); };
  const results = await Promise.allSettled([
    singleFlight(m, 'bad', alwaysFails), singleFlight(m, 'bad', alwaysFails),
  ]);
  ok(attempts === 1 && results.every((r) => r.status === 'rejected'),
    'shared callers each receive the rejection (one execution, two rejections)');

  // A job that throws SYNCHRONOUSLY must behave like any other failure, not blow
  // out of singleFlight leaving its entry stuck in the map forever.
  let sync = false;
  try { await singleFlight(m, 'sync', () => { throw new Error('sync boom'); }); }
  catch (e) { sync = /sync boom/.test(e.message); }
  ok(sync, 'a synchronous throw becomes a rejection');
  ok(!inFlight(m, 'sync'), 'and leaves no stuck entry behind');

  // ---- B. one builder, and a probe beside every report route --------------
  const routeDir = path.join(R, 'src', 'routes');
  const offenders = [];
  for (const f of fs.readdirSync(routeDir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    // A route may SERVE a report; it may not BUILD one.
    if (/drawReport\.buildDrawReport\s*\(/.test(src) || /drawReport\.storeDrawReport\s*\(/.test(src)) offenders.push(f);
  }
  ok(offenders.length === 0,
    `no route re-implements the draw-report build — it belongs to src/sitewire/draw-report.js alone (offenders: ${offenders.join(', ') || 'none'})`);

  const missing = [];
  for (const f of ['sitewire.js', 'borrower-draws.js', 'tpo.js']) {
    const src = fs.readFileSync(path.join(routeDir, f), 'utf8');
    if (/router\.get\('[^']*report'/.test(src) && !/router\.get\('[^']*report\/status'/.test(src)) missing.push(f);
  }
  ok(missing.length === 0,
    `every draw-report route offers the "is it ready?" probe beside it (missing on: ${missing.join(', ') || 'none'})`);

  // Both report builders go through the shared rule — not one of them.
  const dr = fs.readFileSync(path.join(R, 'src/sitewire/draw-report.js'), 'utf8');
  const tp = fs.readFileSync(path.join(R, 'src/trustpoint/report.js'), 'utf8');
  ok(/singleFlight\(/.test(dr), 'the Sitewire draw-report builder coalesces concurrent builds');
  ok(/singleFlight\(/.test(tp), 'the TrustPoint report builder coalesces concurrent builds');

  // The screen must never go back to opening a blank browser tab for a report.
  // (`window.open('', ...)` — an EMPTY url — is the shape that produced the blank
  // page; opening a real url in a tab is fine and is still used elsewhere.)
  const uiDir = path.join(R, 'app-v2', 'src', 'components');
  const blanks = [];
  for (const f of fs.readdirSync(uiDir)) {
    if (!f.endsWith('.jsx')) continue;
    const src = fs.readFileSync(path.join(uiDir, f), 'utf8');
    for (const line of src.split('\n')) {
      if (/window\.open\(\s*''\s*,/.test(line) && /[Rr]eport/.test(line)) blanks.push(`${f}: ${line.trim().slice(0, 90)}`);
    }
  }
  ok(blanks.length === 0,
    `no report button opens a blank browser tab and fills it later (offenders: ${blanks.join(' | ') || 'none'})`);

  console.log(`\ntest-draw-report-open-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test threw:', e); process.exit(1); });
