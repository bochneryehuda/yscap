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
// ⛔ THE PRODUCTION MASK, NOT A HAND-ROLLED IMITATION OF IT. The first cut of this
// harness spelled its own record options (`maskAllInputs`, `recordCanvas`, …) and so
// carried NO `blockSelector` and NO `maskTextSelector` — it proved the tool iframe is
// MIRRORED and proved nothing whatever about masking inside it (post-merge audit,
// 2026-09-02). That is the wrong half to leave unproven: this harness is precisely
// what established that a same-origin tool iframe mirrors in FULL, and the tool pages
// live outside `app-v2`, so they carry none of the block markers the app's own screens
// do. The mask module is ESM with no imports; read it in as plain script.
const maskSrc = fs.readFileSync(path.join(root, 'app-v2/src/lib/cobrowseMask.js'), 'utf8')
  .replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ')
  + '\nwindow.__mask = { BLOCK_SELECTOR, MASK, recordOptions };';

// A secret marked the way a tool page would have to mark one, and an ordinary string
// beside it. The mask must swallow the first and leave the second alone — otherwise
// "masking works" is a claim about the top document only.
const CHILD_SECRET = '111-22-3333';
const CHILD_PLAIN = 'CHILD_PLAIN_TEXT';

const REAL = fs.readFileSync(path.join(root, 'web/v2/tools/term-sheet.html'), 'utf8');
const CHILD = REAL.replace('</body>',
  `<div data-cobrowse-block="ssn"><span id="cb-secret">${CHILD_SECRET}</span></div>`
  + `<p id="cb-plain">${CHILD_PLAIN}</p>`
  + '<h1 id="cb-marker">STUDIO_MARKER</h1><p id="cb-later">Loan structure</p>'
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
    await guest.addScriptTag({ content: maskSrc });
    // Recording starts BEFORE the tool document exists — the case under test — and it
    // records through the SAME options the product uses, never a copy of them.
    await guest.evaluate(() => {
      window.__ev = [];
      window.rrwebRecord.record(window.__mask.recordOptions((e) => window.__ev.push(e)));
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
    const window_MASK_MARK = await guest.evaluate(() => window.__mask.MASK);
    ok(raw.includes('STUDIO_MARKER'), `the tool's own content is in the recorded stream (${(raw.length / 1024).toFixed(0)} KB)`);
    ok(raw.includes('LATER_CHANGE'), 'and so is a change made inside it afterwards');
    // ⛔ AND THE MASK REACHES INSIDE THE CHILD. This is the half the first version of
    // this harness left unproven: it recorded with hand-rolled options that carried no
    // `blockSelector` at all, so it could have reported a full mirror of a document
    // leaking a Social Security number and called that a pass.
    ok(!raw.includes(CHILD_SECRET),
      `a data-cobrowse-block secret INSIDE the tool iframe never reaches the stream (${CHILD_SECRET})`);
    // THE CONTROL. Without it the assertion above would pass just as well for a mask
    // that swallowed the whole child document, or for a child that never loaded.
    ok(raw.includes(CHILD_PLAIN),
      'while ordinary text beside it in the same child document does — the mask is selective, not a blanket');
    // NOT "the marker appears somewhere" — it appears all over a 237 KB stream from
    // `maskAllInputs` on the term sheet's own inputs, so that assertion passed while
    // NOTHING was blocked. The SECOND attempt hunted `ev.data.node` of the guest's
    // own type-2 snapshot — and the child iframe's document is not in that tree at
    // all, so it always answered "absent" and passed identically with the mask
    // removed. Two vacuous assertions in a row on the same line (pre-merge audits,
    // 2026-09-02). This one walks EVERY recorded event, and proves the walk reaches
    // the child before concluding anything from an absence.
    const probe = await guest.evaluate(({ secret, plain }) => {
      const texts = [];
      const attrs = [];
      const seen = new Set();
      const walk = (n) => {
        if (!n || typeof n !== 'object' || seen.has(n)) return;
        seen.add(n);
        if (typeof n.textContent === 'string') texts.push(n.textContent);
        if (n.attributes && typeof n.attributes === 'object') {
          for (const v of Object.values(n.attributes)) if (typeof v === 'string') attrs.push(v);
        }
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object') walk(v);
        }
      };
      for (const ev of window.__ev) walk(ev);
      return {
        total: texts.length,
        // ATTRIBUTES TOO. A secret living in a `value` or a `title` is invisible to a
        // text-only search, and the walk's own comment claimed to look everywhere.
        secret: texts.filter((t) => t.includes(secret)).length
          + attrs.filter((v) => v.includes(secret)).length,
        plain: texts.filter((t) => t.includes(plain)).length,
        maskedAttrs: attrs.filter((v) => v === window.__mask.MASK).length,
      };
    }, { secret: CHILD_SECRET, plain: CHILD_PLAIN });
    // THE CONTROL FIRST: the walk must actually reach the child's own text, or "the
    // secret is not there" is a statement about a broken walk and nothing else.
    ok(probe.plain > 0,
      `the node walk really reaches the child document's text (plain marker found ${probe.plain}x across ${probe.total} text nodes)`);
    ok(probe.secret === 0,
      `and the blocked secret appears in NO node of ANY recorded event (${probe.secret} occurrences)`);
    // A SECOND, INDEPENDENT PROPERTY: `maskAllInputs` is reaching the child too. The
    // block above removes a marked subtree; this is the other half of the mask, and
    // it lands on ATTRIBUTES (an input's value), not on text — the first version of
    // this assertion counted masked TEXT nodes and failed for that reason, which is
    // the mask working, not the mask broken.
    ok(probe.maskedAttrs > 0,
      `every input inside the tool iframe is masked too (${probe.maskedAttrs} masked attribute value(s))`);

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
