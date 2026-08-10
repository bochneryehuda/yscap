#!/usr/bin/env node
'use strict';
/**
 * THE PER-LINE VERIFICATION STATUS MODEL — pure. No database, no network.
 * (owner-directed 2026-08-10, #40; db/519.)
 *
 * The one thing that must never drift: what a track-record verification status
 * MEANS. It is defined in four places that a user sees at once —
 *   · app-v2/src/lib/trackRecordStatus.js   (the React Track Record Center)
 *   · web/v2/tools/track-record-portal.js    (the V2 static-tool bridge)
 *   · web/tools/track-record-portal.js       (the V1 static-tool bridge)
 *   · src/routes/staff.js                     (the verify route's TR_STATUSES)
 * and a picker offering a status the server then rejects, or two screens
 * labelling one status two different ways, is exactly the drift this guards.
 *
 * These files are read as TEXT (the React module is ESM, this test is CommonJS,
 * and the bridges are browser IIFEs) — what matters is that the VALUES agree,
 * not how they load. Same approach as scripts/test-entity-type-pure.js.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let pass = 0;
const ok = (what) => { pass++; console.log('  ✓', what); };
const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

/* Pull the KEYS of a `<name> = { key: ..., key: ... }` object literal. Crude on
   purpose (these literals are flat — no nested objects), matching the entity-type
   test: a real import would need a build step, and only the keys matter here. */
function objectKeys(src, name) {
  const at = src.indexOf(name + ' = {');
  assert.ok(at >= 0, `${name} object missing`);
  const open = src.indexOf('{', at);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > open, `${name} object never closes`);
  // Strip comments so a key preceded by a `// legacy` note (the React module has
  // one before `docs`) is still seen. Safe here — the label VALUES never contain
  // `//` or `/* */`.
  const body = src.slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const keys = [];
  // key:  at the start of an entry (after { or ,) — never a URL/label colon.
  const re = /(?:^|[{,])\s*([A-Za-z_]\w*)\s*:/g;
  let m;
  while ((m = re.exec(body))) keys.push(m[1]);
  return keys.sort();
}

/* Pull a string array literal `<name> = ["a", "b", ...]`. */
function stringArray(src, name) {
  const at = src.indexOf(name + ' = [');
  assert.ok(at >= 0, `${name} array missing`);
  const open = src.indexOf('[', at);
  const close = src.indexOf(']', open);
  assert.ok(close > open, `${name} array never closes`);
  return src.slice(open + 1, close).match(/["']([^"']+)["']/g).map((s) => s.slice(1, -1));
}

const CANONICAL = [
  'pending', 'verified', 'not_verified', 'unable_docs', 'unable_mismatch',
  'rejected', 'docs', 'limited',
].sort();
const PICKER = ['pending', 'verified', 'not_verified', 'unable_docs', 'unable_mismatch', 'rejected'];

const react = read('app-v2/src/lib/trackRecordStatus.js');
const v2 = read('web/v2/tools/track-record-portal.js');
const v1 = read('web/tools/track-record-portal.js');
const staff = read('src/routes/staff.js');
const htmlCopy = read('src/lib/track-record/html-copy.js');

/* ─────────── A. every surface knows the same status set ─────────── */
console.log('\nA. the label set is identical on every surface');
{
  const rk = objectKeys(react, 'TR_STATUS_LABEL');
  const rs = objectKeys(react, 'TR_STATUS_SHORT');
  const v2k = objectKeys(v2, 'STATUS_LABEL');
  const v2c = objectKeys(v2, 'STATUS_COLOR');
  const v1k = objectKeys(v1, 'STATUS_LABEL');
  const v1c = objectKeys(v1, 'STATUS_COLOR');
  assert.deepStrictEqual(rk, CANONICAL, 'React TR_STATUS_LABEL set');
  assert.deepStrictEqual(rs, CANONICAL, 'React TR_STATUS_SHORT set');
  assert.deepStrictEqual(v2k, CANONICAL, 'V2 bridge STATUS_LABEL set');
  assert.deepStrictEqual(v2c, CANONICAL, 'V2 bridge STATUS_COLOR set');
  assert.deepStrictEqual(v1k, CANONICAL, 'V1 bridge STATUS_LABEL set');
  assert.deepStrictEqual(v1c, CANONICAL, 'V1 bridge STATUS_COLOR set');
  const hck = objectKeys(htmlCopy, 'STATUS_LABEL');
  assert.deepStrictEqual(hck, CANONICAL, 'server saved-copy STATUS_LABEL set');
  ok('React module, both bridges, the saved copy — all cover the same 8 statuses');
  // The two bridges must be byte-identical in the edited status block.
  assert.deepStrictEqual(v1k, v2k, 'V1 and V2 bridge STATUS_LABEL agree');
  ok('V1 and V2 bridges carry the same status set');
}

/* ─────────── B. only "Fully verified" counts ─────────── */
console.log('\nB. only "verified" counts toward experience');
{
  // The React helper.
  assert.ok(/String\(status \|\| ''\) === 'verified'/.test(react),
    'trStatusCounts should be exactly status === "verified"');
  // Neither bridge may treat any other value as counting.
  assert.ok(/nowCounts = sel\.value === "verified";/.test(v2), 'V2 nowCounts is verified-only');
  assert.ok(/nowCounts = sel\.value === "verified";/.test(v1), 'V1 nowCounts is verified-only');
  assert.ok(!/=== "limited"/.test(v2.split('nowCounts')[1] || ''), 'V2 no longer counts limited');
  ok('the counting rule is "verified" alone on every surface — limited no longer counts');
}

/* ─────────── C. the verify route accepts the whole set, counts one ─────────── */
console.log('\nC. the server verify route');
{
  const trStatuses = stringArray(staff, 'TR_STATUSES');
  assert.deepStrictEqual(trStatuses.slice().sort(), CANONICAL,
    'TR_STATUSES must be exactly the 8 statuses');
  ok('TR_STATUSES accepts every status the pickers can send');
  // The counting rule, verbatim.
  assert.ok(/const counts = status === 'verified';/.test(staff),
    "verify route: const counts = status === 'verified';");
  ok('the verify route counts "verified" alone (is_verified follows it)');
}

/* ─────────── D. the pickers offer the outcomes, never the legacy pair ─────────── */
console.log('\nD. the pickers');
{
  const v2opts = stringArray(v2, 'STATUS_OPTIONS');
  const v1opts = stringArray(v1, 'STATUS_OPTIONS');
  const outcomes = stringArray(react, 'TR_REVIEW_OUTCOMES');
  assert.deepStrictEqual(v2opts, PICKER, 'V2 STATUS_OPTIONS');
  assert.deepStrictEqual(v1opts, PICKER, 'V1 STATUS_OPTIONS');
  // The React "Mark review outcome" control is the picker WITHOUT 'verified'
  // (that has its own primary button with the readiness warning).
  assert.deepStrictEqual(outcomes, PICKER.filter((s) => s !== 'verified'),
    'React TR_REVIEW_OUTCOMES = picker minus verified');
  ok('every picker offers the six outcomes; React outcomes exclude the primary "verified"');
  // Legacy docs/limited are labelled (back book) but never offered.
  for (const legacy of ['docs', 'limited']) {
    assert.ok(!v2opts.includes(legacy) && !v1opts.includes(legacy) && !outcomes.includes(legacy),
      `${legacy} must not be an offered outcome`);
    assert.ok(CANONICAL.includes(legacy), `${legacy} must stay a valid label`);
  }
  ok('legacy docs/limited stay valid labels but are never offered in the picker');
}

/* ─────────── E. rejected is hidden by default, with a toggle ─────────── */
console.log('\nE. rejected is hidden by default with a reveal toggle');
{
  for (const [name, src] of [['V2', v2], ['V1', v1]]) {
    assert.ok(/var showRejected = false;/.test(src), `${name} bridge defaults rejected hidden`);
    assert.ok(/p\.status === "rejected"/.test(src), `${name} bridge keys the hide on rejected`);
    assert.ok(/showRejected \? "" : "none"/.test(src), `${name} bridge hides via display:none`);
    assert.ok(/applyRejected\(\);/.test(src), `${name} bridge re-applies on every render`);
  }
  const ledger = read('app-v2/src/components/track-record/RecordLedger.jsx');
  assert.ok(/useState\(false\)/.test(ledger) && /showRejected/.test(ledger), 'RecordLedger defaults rejected hidden');
  assert.ok(/isRejected = \(t\) =>/.test(ledger), 'RecordLedger separates rejected from the REO band');
  assert.ok(/r\.reo && !isRejected\(r\.t\)/.test(ledger), 'REO band excludes rejected');
  ok('rejected is hidden by default with a "Show rejected (N)" toggle on every surface');
}

/* ─────────── F. applyRejected actually hides + toggles (both bridges) ─────────── */
/* The bridges are browser IIFEs with no exports and they return early without a
   token, so — exactly like test-track-record-tool-preserve — the REAL slice is
   cut out of each file and run under a tiny fake DOM. This proves the shipped
   code hides rejected cards, injects one toggle, and reveals them on click —
   catching a runtime typo the shape assertions in E cannot. */
console.log('\nF. applyRejected runs: hides rejected, one toggle, reveals on click');

function fakeDom() {
  const byId = {};
  function el(tag) {
    const e = {
      tagName: tag, id: '', className: '', type: '',
      style: {}, children: [], parentNode: null, onclick: null, _attrs: {}, _text: '',
      getAttribute(k) { return k === 'data-card' ? (this._attrs['data-card'] || null) : (this._attrs[k] || null); },
      setAttribute(k, v) { this._attrs[k] = v; },
      appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) byId[c.id] = c; return c; },
      insertBefore(c, ref) { c.parentNode = this; this.children.unshift(c); if (c.id) byId[c.id] = c; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); if (c.id && byId[c.id] === c) delete byId[c.id]; c.parentNode = null; return c; },
    };
    // Real DOM: setting textContent REPLACES all children. The bridge relies on
    // `bar.textContent = ""` to clear the old button before re-adding it.
    Object.defineProperty(e, 'textContent', {
      get() { return this._text; },
      set(v) { this._text = v; this.children = []; },
    });
    Object.defineProperty(e, 'firstChild', { get() { return this.children[0] || null; } });
    return e;
  }
  const cards = [];
  const document = {
    _cards: cards,
    createElement: (t) => el(t),
    getElementById: (id) => byId[id] || null,
    querySelectorAll: (sel) => (sel.indexOf('tr-card') >= 0 ? cards.slice() : []),
  };
  const root = el('div'); root.id = 'tr-app'; byId['tr-app'] = root;
  return { document, cards, root, el, byId };
}

for (const [name, src] of [['V2', v2], ['V1', v1]]) {
  const from = src.indexOf('var showRejected = false;');
  const anchor = '  window.TR_PORTAL_ONRENDER';
  const to = src.indexOf(anchor, from);
  assert.ok(from >= 0 && to > from, `${name}: applyRejected slice anchors present`);
  const slice = src.slice(from, to);

  const dom = fakeDom();
  const propsById = {
    r1: { status: 'rejected' }, r2: { status: 'rejected' }, k1: { status: 'verified' }, p1: { status: 'pending' },
  };
  for (const id of ['r1', 'k1', 'r2', 'p1']) {
    const c = dom.el('div'); c.className = 'tr-card'; c.setAttribute('data-card', id); dom.cards.push(c);
  }
  // Run the real slice with the fake document + propsById in scope.
  // eslint-disable-next-line no-new-func
  const run = new Function('document', 'propsById', slice + '\n; return { applyRejected: applyRejected };');
  const { applyRejected } = run(dom.document, propsById);

  applyRejected();
  const rejectedCards = dom.cards.filter((c) => propsById[c.getAttribute('data-card')].status === 'rejected');
  const otherCards = dom.cards.filter((c) => propsById[c.getAttribute('data-card')].status !== 'rejected');
  assert.ok(rejectedCards.every((c) => c.style.display === 'none'), `${name}: rejected cards hidden by default`);
  assert.ok(otherCards.every((c) => c.style.display !== 'none'), `${name}: non-rejected cards untouched`);
  const bar = dom.byId['tr-rejected-toggle'];
  assert.ok(bar && bar.children.length === 1, `${name}: exactly one toggle bar injected`);
  assert.ok(/Show rejected \(2\)/.test(bar.children[0].textContent), `${name}: toggle counts the 2 rejected`);
  ok(`${name}: two rejected cards hidden, one "Show rejected (2)" toggle injected`);

  // Click the toggle → reveal.
  bar.children[0].onclick();
  assert.ok(rejectedCards.every((c) => c.style.display === ''), `${name}: rejected revealed on click`);
  assert.ok(/Hide rejected \(2\)/.test(dom.byId['tr-rejected-toggle'].children[0].textContent), `${name}: toggle now says Hide`);
  ok(`${name}: clicking the toggle reveals the rejected cards`);

  // No rejected at all → no bar.
  const dom2 = fakeDom();
  const props2 = { a: { status: 'verified' } };
  const c2 = dom2.el('div'); c2.className = 'tr-card'; c2.setAttribute('data-card', 'a'); dom2.cards.push(c2);
  // eslint-disable-next-line no-new-func
  const run2 = new Function('document', 'propsById', slice + '\n; return { applyRejected: applyRejected };');
  run2(dom2.document, props2).applyRejected();
  assert.ok(!dom2.byId['tr-rejected-toggle'], `${name}: no toggle when there are no rejected lines`);
  ok(`${name}: no toggle bar when nothing is rejected`);
}

/* ─────────── G. the borrower saved copy: rejected excluded, new labels ─────────── */
console.log('\nG. the borrower saved copy hides rejected and labels every outcome');
{
  const COPY = require('../src/lib/track-record/html-copy');
  const rows = [
    { property_address: { oneLine: '1 Verified St' }, deal_type: 'flip', verification_status: 'verified', sale_price: 300000 },
    { property_address: { oneLine: '2 Rejected St' }, deal_type: 'flip', verification_status: 'rejected', sale_price: 250000 },
    { property_address: { oneLine: '3 Unable St' }, deal_type: 'hold', verification_status: 'unable_mismatch', rent_amount: 2000 },
  ];
  const html = COPY.buildSavedCopyHtml({ borrowerName: 'Test', rows, generatedAt: new Date('2026-08-10T12:00:00Z') });
  assert.ok(html.includes('1 Verified St'), 'a verified deal appears');
  assert.ok(!html.includes('2 Rejected St'), 'a REJECTED deal is excluded from the borrower saved copy');
  assert.ok(html.includes('3 Unable St'), 'a non-rejected review outcome still appears');
  assert.ok(html.includes('Fully verified'), 'the saved copy uses the "Fully verified" label');
  assert.ok(html.includes('Unable to verify'), 'a new outcome is labelled, not shown as its raw value');
  assert.ok(!/unable_mismatch/.test(html), 'the raw stored value never leaks into the document');
  assert.ok(/2 deals/.test(html), 'the deal count excludes the rejected deal');
  ok('rejected excluded, new outcomes labelled, counts exclude rejected');
}

console.log(`\nPASSED — ${pass} checks\n`);
