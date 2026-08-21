/**
 * EVERY ORDER BLOCKER THE SERVER CAN RAISE HAS WORDS ON THE SCREEN — pure (no DB).
 *
 * The bug this pins (owner-reported 2026-08-19, file YSCAP258134663): the server
 * added the 'usps' blocker to `closing-prep.blockers()` and `orders.blockers()`
 * (nothing carrying the property address leaves the building un-USPS-verified),
 * but neither card was taught the code. The closing-prep card rendered
 * "To send this, first:" with an EMPTY list over a disabled Send button — a dead
 * end with no words — and the title/insurance cards showed nothing at all and let
 * the click fail afterwards.
 *
 * The class: the server's blocker-code list and the cards' wording are two
 * hand-kept lists. This test makes them ONE list in effect:
 *   1. every code `blockers()` can push (except 'file' — the routes 404 before a
 *      card can render it) must be named by its card, AND refused with wording at
 *      its place route;
 *   2. both cards must keep the unknown-code FALLBACK line, so a code added in a
 *      hurry still renders as SOMETHING rather than an empty gate;
 *   3. the cards' KNOWN lists may not name codes the server cannot emit — a stale
 *      entry would let a renamed server code slip past the fallback unnoticed.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

// The codes a `blockers()` function can push, read out of its own body — never a
// hand-typed list here, or this test would drift exactly the way the cards did.
function blockerCodes(source, file) {
  const start = source.indexOf('function blockers(');
  if (start === -1) throw new Error(`no blockers() in ${file}`);
  // The function ends at the first line that is exactly "}" after its start.
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end === -1 ? source.length : end);
  const out = [];
  const re = /out\.push\('([a-z_]+)'\)/g;
  let m;
  while ((m = re.exec(body))) out.push(m[1]);
  return out;
}

const closingLib = read('src/lib/closing-prep.js');
const ordersLib = read('src/lib/orders.js');
const closingCard = read('app-v2/src/components/ClosingPrepCard.jsx');
const ordersCard = read('app-v2/src/components/OrdersPanel.jsx');
const staffRoutes = read('src/routes/staff.js');

const closingCodes = blockerCodes(closingLib, 'closing-prep.js');
const orderCodes = blockerCodes(ordersLib, 'orders.js');

// 'file' means "the application does not exist" — both GET routes answer 404
// before a card can render, so no card wording can ever show for it.
const UNRENDERABLE = ['file'];

/* ── 1. the extraction itself works (or every assertion below is vacuous) ───── */
assert(closingCodes.includes('usps') && closingCodes.includes('term_sheet'),
  `closing-prep blockers() codes were extracted (${closingCodes.join(', ')})`);
assert(orderCodes.includes('usps') && orderCodes.includes('contact'),
  `orders blockers() codes were extracted (${orderCodes.join(', ')})`);

/* ── 2. every renderable code has wording on its card ───────────────────────── */
for (const code of closingCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(closingCard.includes(`blockers.includes('${code}')`),
    `ClosingPrepCard names the '${code}' blocker (an unnamed one renders an empty "To send this, first:" box)`);
}
for (const code of orderCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(ordersCard.includes(`blockers.includes('${code}')`),
    `OrdersPanel names the '${code}' blocker (an unnamed one leaves the Order button with no visible reason)`);
}

/* ── 2b. …and the wording is a rendered <li>, not just a referenced constant ──
   The first cut of this test asserted only that `blockers.includes('<code>')`
   appears SOMEWHERE in the file — which OrdersPanel satisfies through its
   derivation consts (`const needsUsps = blockers.includes('usps')`) even with
   the <li> deleted. So a deleted wording line left the test green while a
   blocked order rendered the gate heading over an EMPTY list — the exact
   dead-end shape this suite exists to prevent (pre-merge audit finding,
   2026-08-19). A code counts as WORDED only when a <li> is gated on it,
   directly (`{blockers.includes('code') && <li`) or through an alias
   (`const needsX = blockers.includes('code')` … `{needsX && <li`). */
function rendersLi(source, code, file) {
  const names = [];
  const aliasRe = new RegExp(`const (\\w+) = blockers\\.includes\\('${code}'\\)`, 'g');
  let m;
  while ((m = aliasRe.exec(source))) names.push(m[1]);
  const gates = names.concat([`blockers\\.includes\\('${code}'\\)`]);
  return gates.some((g) => new RegExp(`\\{(?:${g})\\s*&&\\s*<li[\\s>]`).test(source));
}
for (const code of closingCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(rendersLi(closingCard, code),
    `ClosingPrepCard renders a <li> for the '${code}' blocker (a referenced-but-unrendered code shows an empty gate)`);
}
for (const code of orderCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(rendersLi(ordersCard, code),
    `OrdersPanel renders a <li> for the '${code}' blocker (a referenced-but-unrendered code shows an empty gate)`);
}

/* ── 3. both cards keep the unknown-code fallback ───────────────────────────── */
assert(/KNOWN_BLOCKERS\.includes\(b\)/.test(closingCard) && /does not know how to explain/.test(closingCard),
  'ClosingPrepCard renders a fallback line for a blocker code it has no wording for');
assert(/KNOWN_ORDER_BLOCKERS\.includes\(b\)/.test(ordersCard) && /does not know how to explain/.test(ordersCard),
  'OrdersPanel renders a fallback line for a blocker code it has no wording for');

/* ── 4. the KNOWN lists cannot go stale against the server ──────────────────── */
function knownList(source, name, file) {
  const m = source.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
  if (!m) throw new Error(`no ${name} in ${file}`);
  return m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
}
const cardKnown = knownList(closingCard, 'KNOWN_BLOCKERS', 'ClosingPrepCard.jsx');
const orderKnown = knownList(ordersCard, 'KNOWN_ORDER_BLOCKERS', 'OrdersPanel.jsx');
for (const code of cardKnown) {
  assert(closingCodes.includes(code),
    `ClosingPrepCard KNOWN_BLOCKERS '${code}' is a code the server can actually emit`);
}
for (const code of orderKnown) {
  assert(orderCodes.includes(code),
    `OrdersPanel KNOWN_ORDER_BLOCKERS '${code}' is a code the server can actually emit`);
}

/* ── 5. every renderable code is refused with wording at its place route ────── */
for (const code of closingCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(staffRoutes.includes(`blk.includes('${code}')`),
    `the closing-prep place route refuses '${code}' with its own wording`);
}
for (const code of orderCodes.filter((c) => !UNRENDERABLE.includes(c))) {
  assert(staffRoutes.includes(`blk.includes('${code}')`),
    `the order place route refuses '${code}' with its own wording`);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASS');
process.exit(failures ? 1 : 0);
