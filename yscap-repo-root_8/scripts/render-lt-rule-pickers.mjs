/**
 * THE RULE CENTER'S PICKERS — THE RENDER PROOF.
 *
 * `scripts/test-lt-rule-pickers-pure.js` runs the two rules the controls are
 * built on (the search, and the tick-box toggle) and reads the wiring. Neither
 * can see the thing the owner actually reported: *"When you want to select a
 * few things, the system doesn't let you select more than one."*
 *
 * That defect was the CONTROL, not the data. A native `<select multiple>` needs
 * a Ctrl or Cmd click; a plain click on a second option deselects the first. So
 * the only assertion that settles it is a REAL MOUSE clicking a second option
 * and the first still being ticked — which is what this does, against the
 * committed bundle, with the catalogue stubbed.
 *
 * It also proves the two things a source check cannot: that the field search
 * narrows a sixty-item list and picking a result fills the field in, and that
 * the investor box offers the published roster while still accepting a name
 * typed by hand.
 *
 * SKIPs (exit 0) without Chromium, so CI — which has no browser — stays green.
 */

import { readFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require_ = createRequire(import.meta.url);

let pw = null;
try { pw = require_('/opt/pw-browsers/../node_modules/playwright'); } catch { /* fall through */ }
if (!pw) { try { pw = require_('/opt/node22/lib/node_modules/playwright'); } catch { pw = null; } }
if (!pw) { try { pw = require_('playwright'); } catch { pw = null; } }
if (!pw) { console.log('SKIP render-lt-rule-pickers: playwright not available'); process.exit(0); }

let failures = 0;
const ok = (cond, what) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${what}`); if (!cond) failures++; };
const info = (what) => console.log(`INFO ${what}`);

// --- serve the committed bundle exactly as the app does ---------------------
const WEB = join(ROOT, 'web/v2');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};
const server = createServer((req, res) => {
  const rawPath = decodeURIComponent(String(req.url).split('?')[0]);
  let file = join(WEB, normalize(rawPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(WEB)) { res.writeHead(403).end('no'); return; }
  if (!existsSync(file) || file.endsWith('/')) file = join(WEB, 'portal/index.html');
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end('nope'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
info(`serving the committed bundle from ${BASE}/portal/`);

/* THE CATALOGUE IS THE SERVER'S OWN, not a hand-written stub of it. The screen
   draws whatever `/catalog` publishes, so a fixture invented here would prove
   the harness rather than the product — the field registry, the operator table
   and the list of verbs all come out of the real modules. The ROSTER half is
   stubbed, because that one genuinely needs a database. */
const fields = require_(join(ROOT, 'src/longterm/pricing/rules/fields'));
const rulesGrammar = require_(join(ROOT, 'src/lib/conditions/rules'));
const ruleActions = require_(join(ROOT, 'src/longterm/pricing/rules/actions'));
const facts = require_(join(ROOT, 'src/longterm/pricing/rules/facts'));
const sampleRow = require_(join(ROOT, 'src/longterm/pricing/rules/sample-row'));
const CATALOG = {
  ok: true,
  groups: fields.grouped(),
  operatorsByType: rulesGrammar.OPERATORS_BY_TYPE,
  operatorLabels: rulesGrammar.OPERATOR_LABEL,
  noValueOperators: rulesGrammar.NO_VALUE_OPS,
  rangeOperators: rulesGrammar.RANGE_OPS,
  listOperators: rulesGrammar.LIST_OPS,
  actions: ruleActions.KEYS.map((k) => ruleActions.ACTIONS[k]),
  maxPoints: ruleActions.MAX_POINTS,
  scenarioInput: facts.SCENARIO_INPUT,
  quoteInput: sampleRow.QUOTE_INPUT,
  derivedFacts: facts.DERIVED_SCENARIO_FACTS,
  engines: [{ v: 'all', label: 'Both engines' }, { v: 'general', label: 'General' }, { v: 'combined', label: 'Combined' }],
  optionsByField: {
    investor: [{ v: 'Verus Mortgage Capital', label: 'Verus Mortgage Capital' }, { v: 'Acra Lending', label: 'Acra Lending' }],
    white_label: [{ v: 'Eclipse', label: 'Eclipse' }, { v: 'Vermilion', label: 'Vermilion' }],
  },
  optionsProblem: null,
};
info(`the real catalogue: ${CATALOG.groups.reduce((n, g) => n + g.fields.length, 0)} fields in ${CATALOG.groups.length} groups`);

const browser = await pw.chromium.launch();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const TOKEN = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
  sub: '00000000-0000-4000-8000-000000000001', kind: 'staff', role: 'super_admin',
  exp: Math.floor(Date.now() / 1000) + 3600,
})}.rendercheck`;

const ctx = await browser.newContext({ viewport: { width: 1440, height: 980 } });
await ctx.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* private mode */ } },
  ['ys_portal_token', TOKEN]);
await ctx.route('**/api/lt/dscr/pricing-rules/catalog', (route) => route.fulfill({
  status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG),
}));
await ctx.route('**/api/lt/dscr/pricing-rules**', (route) => (route.request().url().includes('/catalog')
  ? route.fallback()
  : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rules: [], count: 0 }) })));
await ctx.route('**/api/**', (route) => (route.request().url().includes('/pricing-rules')
  ? route.fallback()
  : route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })));

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e && e.message ? e.message : e)));
await page.goto(`${BASE}/portal/#/internal/lt/pricing-rules`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);

ok(errors.length === 0, `A1 the rule centre renders with no page error${errors.length ? ` — ${errors[0]}` : ''}`);

// Open the builder.
const addBtn = page.locator('button', { hasText: /Write a rule|New rule|Add a rule/i }).first();
const haveAdd = await addBtn.count();
if (!haveAdd) {
  const text = (await page.innerText('body')).replace(/\s+/g, ' ').slice(0, 300);
  ok(false, `A2 the "write a rule" button was found — got: ${text}`);
} else {
  await addBtn.click();
  await page.waitForTimeout(500);
  ok(true, 'A2 the builder opens');
}

// ---------------------------------------------------------------------------
// B. THE FIELD SEARCH — the sixty-item dropdown, narrowed by typing.
// ---------------------------------------------------------------------------
{
  const picker = page.locator('[data-field-picker]').first();
  ok(await picker.count() > 0, 'B1 the field box is the searchable picker, not a <select>');
  await picker.click();
  await page.waitForTimeout(200);
  const search = page.locator('[data-field-search]').first();
  ok(await search.count() > 0, 'B2 …and it carries a search box');
  const before = await page.locator('[role="option"]').count();
  await search.fill('white');
  await page.waitForTimeout(200);
  const after = await page.locator('[role="option"]').count();
  info(`B3a ${before} fields before typing, ${after} after typing "white"`);
  ok(before > 20 && after > 0 && after < before,
    `B3 typing narrows the list (${before} -> ${after}) — the whole point of a search over sixty fields`);
  const first = page.locator('[role="option"]').first();
  const label = (await first.innerText()).trim();
  await first.click();
  await page.waitForTimeout(250);
  const now = (await picker.innerText()).trim();
  ok(now.includes(label.replace(/\s*✓$/, '')),
    `B4 …and picking a result FILLS THE FIELD IN (${JSON.stringify(now)})`);
}

// ---------------------------------------------------------------------------
// C. ⛔ THE DEFECT ITSELF: a plain click on a second value keeps the first.
// ---------------------------------------------------------------------------
{
  /* Pick a field that carries a list, then an "is any of" test, then click two
     options with an ORDINARY click — no Ctrl, no Cmd, which is exactly what the
     old `<select multiple>` required and what nobody does. */
  const picker = page.locator('[data-field-picker]').first();
  await picker.click();
  await page.waitForTimeout(150);
  /* "State" — 52 options, so the tick-box list has something real in it. The
     search is the field's own KEY as well as its label, which is why `state`
     finds it whatever the label happens to read. */
  await page.locator('[data-field-search]').first().fill('state');
  await page.waitForTimeout(200);
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(250);

  const testSelect = page.locator('[data-op-select]').first();
  const opts = await testSelect.locator('option').allTextContents();
  const anyOf = opts.find((t) => /any of/i.test(t));
  ok(!!anyOf, `C1 the "is any of" test is offered (${JSON.stringify(opts.slice(0, 6))})`);
  if (anyOf) {
    await testSelect.selectOption({ label: anyOf });
    await page.waitForTimeout(350);
  }

  const list = page.locator('[data-tickbox-list]').first();
  ok(await list.count() > 0, 'C2 the value box is a tick-box list');
  const boxes = list.locator('input[type="checkbox"]');
  const n = await boxes.count();
  ok(n > 5, `C3 …with the field's real options in it (${n})`);

  await boxes.nth(0).click();
  await page.waitForTimeout(150);
  await boxes.nth(1).click();          // an ORDINARY click on a SECOND option
  await page.waitForTimeout(150);
  const firstStill = await boxes.nth(0).isChecked();
  const secondNow = await boxes.nth(1).isChecked();
  ok(firstStill && secondNow,
    `C4 ⛔ AN ORDINARY CLICK ON A SECOND VALUE KEEPS THE FIRST (first ${firstStill ? 'still ticked' : 'LOST'}, second ${secondNow ? 'ticked' : 'not ticked'}) — the reported defect`);

  await boxes.nth(2).click();
  await page.waitForTimeout(150);
  const count = (await list.locator('[data-tickbox-count]').innerText()).trim();
  ok(/^3 picked/.test(count), `C5 …and it says how many are picked (${JSON.stringify(count)})`);

  /* THE SEARCH INSIDE THE LIST NEVER HIDES WHAT IS PICKED. */
  await list.locator('[data-tickbox-search]').fill('zzzz');
  await page.waitForTimeout(200);
  const stillCount = (await list.locator('[data-tickbox-count]').innerText()).trim();
  ok(/^3 picked/.test(stillCount),
    `C6 …and a search that matches nothing still reports the three picked (${JSON.stringify(stillCount)})`);
  await list.locator('[data-tickbox-search]').fill('');
  await page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// D. THE INVESTOR BOX OFFERS THE ROSTER AND STILL TAKES A TYPED NAME.
// ---------------------------------------------------------------------------
{
  const picker = page.locator('[data-field-picker]').first();
  await picker.click();
  await page.waitForTimeout(150);
  await page.locator('[data-field-search]').first().fill('white_label');
  await page.waitForTimeout(200);
  await page.locator('[role="option"]').first().click();
  await page.waitForTimeout(300);

  /* ⛔ AND ON A LIST TEST THE ROSTER IS STILL A SHORTCUT. The operator carried
     over from the previous section is "is any of", so this is the tick-box list
     over the roster — where a name nobody has quoted yet must ALSO be
     writable, or the shortcut has quietly become a gate for half the operators. */
  {
    const list = page.locator('[data-tickbox-list]').first();
    ok(await list.count() > 0, 'D0a a list test over a text field ticks the roster');
    const add = list.locator('[data-tickbox-add]');
    ok(await add.count() > 0, 'D0b …and offers a box for a name that is not on it');
    await list.locator('input[type="checkbox"]').first().click();
    await page.waitForTimeout(150);
    await add.fill('Brand New Capital');
    await add.press('Enter');
    await page.waitForTimeout(250);
    const count = (await list.locator('[data-tickbox-count]').innerText()).trim();
    ok(/^2 picked/.test(count),
      `D0c …a typed name is added BESIDE the ticked one, never instead of it (${JSON.stringify(count)})`);
    const labels = await list.locator('label').allTextContents();
    ok(labels.some((t) => /Brand New Capital/.test(t) && /typed in/.test(t)),
      'D0d …and is shown as one somebody typed, so nobody hunts for it on the roster');
  }

  /* Back to a single-value test for the combo. */
  await page.locator('[data-op-select]').first().selectOption({ label: 'is' });
  await page.waitForTimeout(300);

  const combo = page.locator('[data-value-combo]').first();
  ok(await combo.count() > 0, 'D1 a white-label rule offers a list rather than a bare text box');
  await combo.click();
  await page.waitForTimeout(250);
  const listed = await page.locator('[role="option"]').allTextContents();
  ok(listed.some((t) => /Eclipse/.test(t)),
    `D2 …the published roster is in it (${JSON.stringify(listed.slice(0, 4))})`);
  await page.locator('[role="option"]', { hasText: 'Eclipse' }).first().click();
  await page.waitForTimeout(200);
  ok((await combo.inputValue()) === 'Eclipse', 'D3 …picking one fills it in');

  /* ⛔ AND A NAME THE ROSTER HAS NEVER SEEN IS STILL ACCEPTED. These are TEXT
     fields; a rule written the day before an investor is added must be
     writable, so the list is a shortcut and never a gate. */
  await combo.fill('Some Brand New Investor');
  await page.waitForTimeout(200);
  ok((await combo.inputValue()) === 'Some Brand New Investor',
    'D4 ⛔ …and a name nobody has ever quoted is still typeable — the list is a shortcut, not a gate');
}

// ---------------------------------------------------------------------------
// E. "BLOCK THIS PROGRAM NAME" IS OFFERED BESIDE "BLOCK THIS INVESTOR".
// ---------------------------------------------------------------------------
{
  /* THE ACTION PICKER BY ITS OWN HANDLE. "The last `<select>` on the page" read
     the sample-loan panel's white-label box instead — this screen holds a dozen
     of them, and an index is a guess. */
  const verbs = await page.locator('[data-action-select]').first().locator('option').allTextContents();
  ok(verbs.some((t) => /block this investor/i.test(t)) && verbs.some((t) => /block this program name/i.test(t)),
    `E1 a rule may block the investor OR the one program — the writer picks (${JSON.stringify(verbs)})`);
}

// ---------------------------------------------------------------------------
// F. AN IPHONE 12 — one pixel of sideways overflow switches the phone
//    breakpoints off and the whole page renders zoomed-out and tiny.
// ---------------------------------------------------------------------------
{
  const iPhone = pw.devices['iPhone 12'];
  const ctx2 = await browser.newContext({ ...iPhone });
  await ctx2.addInitScript(([k, t]) => { try { localStorage.setItem(k, t); } catch { /* private mode */ } },
    ['ys_portal_token', TOKEN]);
  await ctx2.route('**/api/lt/dscr/pricing-rules/catalog', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify(CATALOG),
  }));
  await ctx2.route('**/api/**', (route) => (route.request().url().includes('/catalog')
    ? route.fallback()
    : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, rules: [], count: 0 }) })));
  const p2 = await ctx2.newPage();
  const errs2 = [];
  p2.on('pageerror', (e) => errs2.push(String(e && e.message ? e.message : e)));
  await p2.goto(`${BASE}/portal/#/internal/lt/pricing-rules`, { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1000);
  const add2 = p2.locator('button', { hasText: /Write a rule|New rule|Add a rule/i }).first();
  if (await add2.count()) { await add2.click(); await p2.waitForTimeout(500); }
  const m = await p2.evaluate(() => ({
    inner: window.innerWidth,
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  ok(errs2.length === 0, `F1 the builder renders on a phone with no page error${errs2.length ? ` — ${errs2[0]}` : ''}`);
  ok(m.inner === 390, `F2 the layout viewport is the device width (innerWidth ${m.inner})`);
  ok(m.scroll - m.client <= 1, `F3 no sideways scroll (${m.scroll} vs ${m.client})`);
  await ctx2.close();
}

await ctx.close();
await browser.close();
await new Promise((r) => server.close(r));

console.log(`\n${failures ? `FAILURES: ${failures}` : 'The rule centre pickers render'}`);
process.exit(failures ? 1 : 0);
