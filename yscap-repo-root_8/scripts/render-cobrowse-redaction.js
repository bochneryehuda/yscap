'use strict';
/**
 * CO-BROWSING — THE REDACTION HARNESS (Phase C). Proves, in a REAL browser, that
 * the mask the guest records with (app-v2/src/lib/cobrowseMask.js — the ONE
 * definition the recorder reads) keeps a secret out of the event stream:
 *
 *   · text inside a `data-cobrowse-block` element (the SSN row) never appears;
 *   · a password's value never appears, whatever was typed;
 *   · a one-time code's value never appears;
 *   · an ordinary typed value is masked to the fixed-length marker, so the stream
 *     carries neither the text nor its length;
 *   · and the LIMIT is stated rather than hidden: an SSN printed in a cell nobody
 *     marked DOES reach the stream — which is exactly the frame the server-side
 *     guard (src/lib/cobrowse/redaction.js) refuses to relay, asserted here too.
 *
 * SKIPs (exit 0) without Chromium; runs the real @rrweb/record UMD build against a
 * page served from a throwaway http server. No PILOT server, no database.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

let pw = null;
try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (_) { try { pw = require('playwright'); } catch (_2) { pw = null; } }
if (!pw) { console.log('SKIP render-cobrowse-redaction: playwright not available'); process.exit(0); }

const root = path.join(__dirname, '..');
const recordUmd = fs.readFileSync(path.join(root, 'app-v2/node_modules/@rrweb/record/dist/record.umd.cjs'), 'utf8');
const redaction = require('../src/lib/cobrowse/redaction');

// The mask module is ESM with no imports; read it into the page as plain script.
const maskSrc = fs.readFileSync(path.join(root, 'app-v2/src/lib/cobrowseMask.js'), 'utf8')
  .replace(/^export const /gm, 'const ').replace(/^export function /gm, 'function ') + '\nwindow.__mask = { BLOCK_SELECTOR, NO_RECORD_ROUTES, MASK, NO_DRIVE_SELECTOR, recordOptions };';

const SSN = '123-45-6789', UNMARKED_SSN = '987-65-4321', PASSWORD = 'hunter2!Secret', OTP = '482913', TYPED = 'Lakewood Holdings LLC';
const page = `<!doctype html><html><head><meta charset="utf-8"><title>redaction</title></head><body>
  <h1>Borrower profile</h1>
  <div class="metrow" data-cobrowse-block="ssn"><span class="k">SSN</span><span class="v">${SSN}</span></div>
  <div id="unmarked"><span>Note: ${UNMARKED_SSN}</span></div>
  <form>
    <input id="pw" type="password" value="${PASSWORD}">
    <input id="otp" type="text" autocomplete="one-time-code" value="${OTP}">
    <input id="name" type="text" value="">
    <div data-cobrowse-block="mfa"><code id="secret">JBSWY3DPEHPK3PXP</code></div>
  </form>
  <script>${recordUmd}</script>
  <script>${maskSrc}</script>
  <script>
    window.__events = [];
    const { record } = window.rrwebRecord;
    window.__stop = record(window.__mask.recordOptions((ev) => window.__events.push(ev)));
    document.getElementById('name').value = ${JSON.stringify(TYPED)};
    document.getElementById('name').dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(() => { record.takeFullSnapshot(true); window.__done = true; }, 200);
  </script>
</body></html>`;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };

(async () => {
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); });
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await pw.chromium.launch({ headless: true, executablePath: fs.existsSync('/opt/pw-browsers/chromium') ? undefined : undefined });
  try {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(url);
    await p.waitForFunction(() => window.__done === true, null, { timeout: 10000 });
    const events = await p.evaluate(() => window.__events);
    const json = JSON.stringify(events);
    ok(events.length >= 2, `the recorder produced events (${events.length})`);
    ok(events.some((e) => e.type === 2), 'a full snapshot is among them');
    ok(!json.includes(SSN), 'the SSN inside a data-cobrowse-block row never reaches the stream');
    ok(!json.includes('JBSWY3DPEHPK3PXP'), 'the 2FA secret inside a data-cobrowse-block panel never reaches the stream');
    ok(!json.includes(PASSWORD), 'a password value never reaches the stream');
    ok(!json.includes(OTP), 'a one-time code never reaches the stream');
    ok(!json.includes(TYPED), 'a typed value is not sent in the clear');
    ok(json.includes('••••••'), 'typed values are replaced by the fixed-length marker');
    // The stated limit, and the guard that catches it.
    ok(json.includes(UNMARKED_SSN), 'LIMIT: an SSN printed in an UNMARKED cell does reach the stream (this is what the server guard is for)');
    const verdict = redaction.judgeBatch(JSON.stringify({ t: 'rrweb', events }), { t: 'rrweb' });
    ok(verdict.ok === false, 'and the server-side guard refuses exactly that batch');
    const clean = events.filter((e) => !JSON.stringify(e).includes(UNMARKED_SSN));
    ok(redaction.judgeBatch(JSON.stringify({ t: 'rrweb', events: clean }), { t: 'rrweb' }).ok === true, 'while a batch without it passes (the guard does not cry wolf on the masked page)');
    await ctx.close();
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
