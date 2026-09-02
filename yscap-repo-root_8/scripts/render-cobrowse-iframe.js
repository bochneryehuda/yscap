'use strict';
/**
 * DOES THE HEAVIEST TOOL PAGE REACH THE MIRROR? (owner-reported 2026-09-02: "I wasn't
 * able to open products and pricing … It didn't come up.")
 *
 * Products & Pricing is a SAME-ORIGIN IFRAME — the Term Sheet Studio, web/v2/tools/
 * term-sheet.html, the largest document this app puts on a screen. This harness serves
 * THAT REAL FILE as an iframe child, records it with the REAL @rrweb/record build and
 * replays it with the REAL @rrweb/replay build, then reads the mirrored document back
 * out. It exists because the report was never reproduced and the theories were being
 * ruled out by reasoning; this rules one out by measurement.
 *
 * THREE WAYS AN EARLIER VERSION OF THIS PROBE FOOLED ITSELF INTO "REPRODUCING" THE BUG.
 * Every one is guarded below, and they generalise well beyond this file:
 *
 *   1. IT FED A RECORDED STREAM INTO `startLive`. The live scheduler draws an event
 *      older than the baseline at once and queues a newer one for `baseline + elapsed`,
 *      so a stream recorded over N seconds is redrawn over N seconds. Reading the mirror
 *      before that finished said "the tool never arrived" about a tool that was on its
 *      way. The viewer here waits past the whole span.
 *   2. IT RAN INTO THIS SANDBOX'S GOOGLE-FONTS HANG. A blocking <link> in <head> that
 *      cannot resolve stalls parsing for ~25s, so the GUEST'S OWN iframe sat at
 *      `readyState:"loading"` with 16 nodes — there was nothing to record and the
 *      failure belonged to the network. The font requests are answered locally.
 *   3. IT READ `innerText`. That is LAYOUT-DEPENDENT and returned '' while `textContent`
 *      held the whole page — so it said "the tool is missing" about a tool that was
 *      entirely there. ASSERT ON `textContent` when you want to know what a document
 *      CONTAINS. HONEST NOTE, measured: swapping this harness back to `innerText` still
 *      passes, because the replayer's own stage gives the mirrored document real layout
 *      here. `textContent` is used because it answers the question being asked, not
 *      because this file would catch the swap.
 *
 * SKIPs (exit 0) without Playwright. Needs no database and no server.
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
let pw = null;
try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (_) { try { pw = require('playwright'); } catch (_2) { pw = null; } }
if (!pw) { console.log('SKIP render-cobrowse-iframe: playwright not available'); process.exit(0); }

const root = path.join(__dirname, '..');
let recordUmd; let replayUmd; let replayCss;
try {
  recordUmd = fs.readFileSync(path.join(root, 'app-v2/node_modules/@rrweb/record/dist/record.umd.cjs'), 'utf8');
  replayUmd = fs.readFileSync(path.join(root, 'app-v2/node_modules/@rrweb/replay/dist/replay.umd.cjs'), 'utf8');
  replayCss = fs.readFileSync(path.join(root, 'app-v2/node_modules/@rrweb/replay/dist/style.css'), 'utf8');
} catch (_) { console.log('SKIP render-cobrowse-iframe: rrweb builds not installed'); process.exit(0); }

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

// The real tool page, plus a marker and a later mutation so both the FIRST PICTURE and a
// CHANGE INSIDE the child can be told apart in the mirror.
const REAL = fs.readFileSync(path.join(root, 'web/v2/tools/term-sheet.html'), 'utf8');
const CHILD = REAL.replace('</body>',
  '<h1 id="cb-marker">STUDIO_MARKER</h1><p id="cb-later">Loan structure</p>'
  + '<script>window.addEventListener("message",function(e){if(e.data==="mut"){document.getElementById("cb-later").textContent="LATER_CHANGE";}});<\/script></body>');
const HOST = '<!doctype html><html><head><meta charset="utf-8"><title>host</title></head><body>'
  + '<h1>Products &amp; Pricing</h1>'
  + '<iframe id="tool" src="/tool.html" style="width:900px;height:400px;border:1px solid #ccc"></iframe>'
  + '</body></html>';

// How late the tool document arrives. A real one is a few hundred milliseconds; 1500 is
// deliberately slower than that, because "the tool was still loading when the picture was
// taken" was the leading hypothesis and it must be tested rather than assumed away.
const DELAY_MS = Number(process.env.COBROWSE_IFRAME_DELAY_MS || 1500);

async function main() {
  const server = http.createServer((req, res) => {
    if ((req.url || '').startsWith('/tool.html')) {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(CHILD); }, DELAY_MS);
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(HOST);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await pw.chromium.launch({ args: ['--no-sandbox'] });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    // Trap 2: answer the font requests locally, or <head> parsing stalls and the guest's
    // own iframe never finishes — a fact about this sandbox, not about the product.
    await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));

    const guest = await ctx.newPage();
    await guest.goto(`${base}/host.html`, { waitUntil: 'commit' });
    await guest.addScriptTag({ content: recordUmd });
    // Recording starts BEFORE the tool document exists — the case under test.
    await guest.evaluate(() => {
      window.__ev = [];
      window.rrwebRecord.record({
        emit: (e) => window.__ev.push(e),
        maskAllInputs: true, recordCanvas: false, collectFonts: false, inlineImages: false,
        sampling: { input: 'last', mousemove: 50, scroll: 100, media: 800 },
        slimDOMOptions: { script: true, comment: true },
      });
    });

    await guest.waitForTimeout(DELAY_MS + 2500);
    const own = await guest.evaluate(() => {
      const f = document.getElementById('tool');
      try {
        return { ready: f.contentDocument.readyState, nodes: f.contentDocument.querySelectorAll('*').length };
      } catch (e) { return { err: String(e) }; }
    });
    // Trap 2 again, as an ASSERTION: if the guest's own iframe never loaded there is
    // nothing to prove and a "did not reach the mirror" verdict below would be a lie.
    ok(own.ready === 'complete' && own.nodes > 500,
      `the guest's own Products & Pricing iframe really loaded (${own.ready}, ${own.nodes} nodes)`);

    await guest.evaluate(() => document.getElementById('tool').contentWindow.postMessage('mut', '*'));
    await guest.waitForTimeout(1500);
    const raw = await guest.evaluate(() => JSON.stringify(window.__ev));
    ok(raw.includes('STUDIO_MARKER'), `the tool's own content is in the recorded stream (${(raw.length / 1024).toFixed(0)} KB)`);
    ok(raw.includes('LATER_CHANGE'), 'and so is a change made inside it afterwards');

    const viewer = await ctx.newPage();
    await viewer.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${replayCss}</style></head><body><div id="stage"></div></body></html>`);
    await viewer.addScriptTag({ content: replayUmd });
    await viewer.evaluate((events) => {
      const evs = JSON.parse(events);
      const rp = new window.rrwebReplay.Replayer([], {
        root: document.getElementById('stage'), liveMode: true, mouseTail: false, showWarning: false, showDebug: false,
      });
      // The baseline comes from the FIRST EVENT'S OWN timestamp — the product's rule, and
      // the one that keeps a viewer's clock out of the schedule.
      rp.startLive(evs[0].timestamp - 40);
      for (const e of evs) rp.addEvent(e);
    }, raw);
    // Trap 1: a recorded stream is redrawn across its original span, so wait past it.
    await viewer.waitForTimeout(DELAY_MS + 6000);

    const seen = await viewer.evaluate(() => {
      const wrap = document.querySelector('.replayer-wrapper');
      const outer = wrap && wrap.querySelector('iframe');
      const outerDoc = outer && outer.contentDocument;
      const inner = outerDoc && outerDoc.querySelector('#tool');
      let nodes = null; let text = '';
      try {
        nodes = inner && inner.contentDocument ? inner.contentDocument.querySelectorAll('*').length : null;
        // Trap 3: textContent, never innerText — a mirrored document has no layout.
        text = inner && inner.contentDocument && inner.contentDocument.body
          ? inner.contentDocument.body.textContent.replace(/\s+/g, ' ').trim() : '';
      } catch (e) { /* reported as a null node count */ }
      return { hasIframe: !!inner, nodes, text };
    });

    ok(seen.hasIframe, 'the mirror carries the tool iframe itself');
    ok(seen.nodes !== null && seen.nodes > own.nodes * 0.9,
      `and the tool's whole document inside it (${seen.nodes} of the guest's ${own.nodes} nodes)`);
    ok(seen.text.includes('STUDIO_MARKER'), 'the tool\'s content really is readable in the mirror');
    ok(seen.text.includes('Term Sheet Studio'), `including its own real text (${seen.text.slice(0, 60)}…)`);
    ok(seen.text.includes('LATER_CHANGE'), 'and a change made inside the tool afterwards reaches the mirror too');
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error('render-cobrowse-iframe failed:', e); process.exit(1); });
