'use strict';
/**
 * THE CLICKUP HALF OF THE RECONCILIATION READ — paging, filtering, and the fields.
 *
 * The live pull needs real credentials, so what is provable without them is the part
 * that would silently go wrong: how far it pages, when it stops, which cards it keeps,
 * and which five custom fields it reads. Each of those has a cheap failure mode that
 * looks like success — a paging loop that stops after one page returns 100 cards and
 * reads as "that is the whole workspace"; a classifier that keeps RTL files puts short
 * -term deals in a long-term reconciliation; a wrong field id returns null on every
 * card, which reads as "nobody has a loan number".
 *
 * The ClickUp client is replaced in the require cache before the route is loaded, so
 * this runs offline and nothing reaches the network.
 */

const assert = require('assert');
const path = require('path');

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); console.log('  ok  ', w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, `${w} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); console.log('  ok  ', w); checks++; };

const { PIPELINE, SYNC } = require('../src/clickup/fields');

// A card as the team-task read hands it back.
const card = (i, program, over) => Object.assign({
  id: 'task' + i,
  custom_id: 'FILLE-' + (2000 + i),
  name: 'Borrower ' + i + ' - 1 Example St, Lakewood, NJ 08701',
  status: { status: 'waiting for final docs' },
  folder: { name: 'Solomon Weiss Files' },
  list: { name: 'Pipeline' },
  custom_fields: [
    { id: PIPELINE.program, value: program },
    { id: PIPELINE.ysLoanNumber, value: 'YSCAP' + (100000 + i) },
    { id: PIPELINE.loanAmount, value: '415000' },
    { id: PIPELINE.subjectAddress, value: { formatted_address: '1 Example St, Lakewood, NJ 08701, USA' } },
    { id: SYNC.portalFileId, value: i === 1 ? 'already-stamped-uuid' : '' },
  ],
}, over || {});

/** Load the route with a stubbed ClickUp client. Returns { router, calls }. */
function loadWithStub(pages) {
  const clientPath = require.resolve('../src/longterm/clickup/client');
  const routePath = require.resolve('../src/longterm/routes/book-diag');
  delete require.cache[routePath];
  const calls = [];
  require.cache[clientPath] = {
    id: clientPath, filename: clientPath, loaded: true, exports: {
      configured: () => true,
      pipelineTasksPage: async (page) => { calls.push(page); return pages[page] || { tasks: [], last_page: true }; },
      getTask: async () => ({}),
      ping: async () => ({ ok: true }),
      READ_ONLY: true,
    },
  };
  const router = require(routePath);
  return { router, calls };
}

/** Drive one GET through the router without a server. */
function get(router, url, headers) {
  return new Promise((resolve) => {
    const req = { method: 'GET', url, query: {}, headers: headers || {},
      get(h) { return (this.headers[String(h).toLowerCase()] || ''); } };
    const q = url.split('?')[1];
    if (q) for (const kv of q.split('&')) { const [k, v] = kv.split('='); req.query[k] = decodeURIComponent(v || ''); }
    req.url = url;
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b }); return this; },
    };
    router(req, res, () => resolve({ status: 404, body: { fellThrough: true } }));
  });
}

(async () => {
  process.env.LT_BOOK_DIAG_TOKEN = 'a-token';
  const H = { 'x-lt-diag-token': 'a-token' };

  // ── A. it pages until ClickUp says that is the last one ──────────────────
  console.log('\nA. paging stops when ClickUp says so, not after one page');
  {
    const pages = [
      { tasks: [card(1, 'Non-QM - DSCR Ratio'), card(2, 'Fix & Flip With Construction')] },
      { tasks: [card(3, 'HELOC')], last_page: true },
      { tasks: [card(4, 'Non-QM - DSCR Ratio')] },   // must never be asked for
    ];
    const { router, calls } = loadWithStub(pages);
    const r = await get(router, '/cards?product=long', H);
    eq(r.status, 200, 'it answers');
    eq(calls.length, 2, 'two pages read, then it stopped on last_page');
    eq(r.body.count, 2, 'two long-term cards found across those pages');
    ok(!r.body.cards.some((c) => c.id === 'task4'), 'nothing from the page past last_page leaked in');
  }

  // ── B. an empty page also ends it ────────────────────────────────────────
  console.log('\nB. an empty page ends it too — some pages carry no last_page flag');
  {
    const { router, calls } = loadWithStub([{ tasks: [card(1, 'HELOAN')] }, { tasks: [] }]);
    const r = await get(router, '/cards?product=long', H);
    eq(calls.length, 2, 'it stopped on the empty page');
    eq(r.body.count, 1, 'and kept what it had');
  }

  // ── C. the bound holds ───────────────────────────────────────────────────
  console.log('\nC. a workspace that never says last_page cannot page forever');
  {
    const endless = {};
    for (let i = 0; i < 60; i += 1) endless[i] = { tasks: [card(i, 'Non-QM - DSCR Ratio')] };
    const { router, calls } = loadWithStub(endless);
    const r = await get(router, '/cards?product=long', H);
    eq(calls.length, 30, 'it stopped at the 30-page bound');
    eq(r.body.pages, 30, 'and reports how far it got, rather than implying it saw everything');
  }

  // ── D. the owner's inverted rule, applied ────────────────────────────────
  console.log('\nD. RTL cards are left out; anything not RTL is ours');
  {
    const { router } = loadWithStub([{ tasks: [
      card(1, 'Fix & Flip With Construction'), card(2, 'Ground-Up'),
      card(3, 'bridge Without Construction'), card(4, 'Private hard money'),
      card(5, 'Fix & Hold With Construction'),
      card(6, 'Non-QM - DSCR Ratio'), card(7, 'HELOC'), card(8, 'HELOAN'),
      card(9, 'Something Nobody Has Built Yet'), card(10, ''),
    ], last_page: true }]);
    const long = await get(router, '/cards?product=long', H);
    eq(long.body.count, 4, 'the four real long-term programs are kept');
    ok(long.body.cards.every((c) => c.product === 'long_term'), 'each marked long-term');
    ok(long.body.cards.some((c) => c.program === 'Something Nobody Has Built Yet'),
      'INCLUDING a program nobody has seen — the failure direction is loud, not silent');
    ok(!long.body.cards.some((c) => c.program === 'Ground-Up'), 'and Ground-Up is not in it');
    const all = await get(router, '/cards?product=all', H);
    eq(all.body.count, 10, 'product=all returns every card, RTL and unset included');
  }

  // ── E. the five fields, read by the right ids ────────────────────────────
  console.log('\nE. the match keys come off the right custom fields');
  {
    const { router } = loadWithStub([{ tasks: [card(1, 'HELOC'), card(2, 'HELOC')], last_page: true }]);
    const r = await get(router, '/cards?product=long', H);
    const c = r.body.cards[0];
    eq(c.custom_id, 'FILLE-2001', 'the FILLE number a person recognises');
    eq(c.status, 'waiting for final docs', 'the status, unwrapped from ClickUp\'s object');
    eq(c.folder, 'Solomon Weiss Files', 'the officer folder');
    eq(c.ys, 'YSCAP100001', 'the YS loan number');
    eq(c.amount, '415000', 'the loan amount');
    eq(c.addr.formatted_address, '1 Example St, Lakewood, NJ 08701, USA', 'the address, kept as the object it is');
    eq(c.portal, 'already-stamped-uuid', 'and the portal stamp when the card carries one');
    eq(r.body.cards[1].portal, null, 'a blank stamp reads as null, never as an empty string');
  }

  // ── E2. THE SHAPE CLICKUP ACTUALLY SENDS: a drop-down reads back as a NUMBER
  // This is the bug that shipped and was caught on the first real pull. *Program is
  // a drop-down, so ClickUp hands back the option's `orderindex` — 0, 3 — and the
  // labels sit beside it in `type_config.options`. The product rule decides a file
  // is long-term unless it is one of the five RTL programs BY NAME, so an
  // unresolved number is a program it has never heard of: MEASURED on the live
  // workspace, 216 Fix & Flip files were classified long-term, silently, and the
  // reconciliation would have proposed ClickUp cards for short-term deals.
  console.log('\nE2. a drop-down arrives as an orderindex and must be resolved to its label');
  {
    const OPTIONS = [
      { id: 'opt-ff', orderindex: 0, name: 'Fix & Flip With Construction' },
      { id: 'opt-gu', orderindex: 1, name: 'Ground-Up' },
      { id: 'opt-dscr', orderindex: 3, name: 'Non-QM - DSCR Ratio' },
    ];
    // A card exactly as the live API sends it: a number, plus the option list.
    const real = (i, orderindex) => {
      const c = card(i, null);
      c.custom_fields = c.custom_fields.map((f) => (f.id === PIPELINE.program
        ? { id: PIPELINE.program, type: 'drop_down', value: orderindex, type_config: { options: OPTIONS } }
        : f));
      return c;
    };
    const { router } = loadWithStub([{ tasks: [real(1, 0), real(2, 3), real(3, 1)], last_page: true }]);
    const long = await get(router, '/cards?product=long', H);
    eq(long.body.count, 1, 'only the DSCR file is long-term');
    eq(long.body.cards[0].program, 'Non-QM - DSCR Ratio', 'and its program reads as the LABEL, not "3"');
    ok(!long.body.cards.some((c) => /^\d+$/.test(String(c.program))),
      'no card carries a bare number as its program');
    const all = await get(router, '/cards?product=all', H);
    const ff = all.body.cards.find((c) => c.id === 'task1');
    eq(ff.program, 'Fix & Flip With Construction', 'the Fix & Flip card resolves to its real name');
    eq(ff.product, 'short_term', 'and is therefore correctly SHORT-term, not long');

    // An option the field does not list is shown as it came, never dropped: an
    // unknown value must be visible, not read as "no program set".
    const { router: r2 } = loadWithStub([{ tasks: [real(9, 77)], last_page: true }]);
    const odd = await get(r2, '/cards?product=all', H);
    eq(String(odd.body.cards[0].program), '77', 'an unlisted option is reported as-is rather than blanked');
  }

  // ── F. it never answers with an empty list it cannot stand behind ────────
  console.log('\nF. not connected is said in words');
  {
    const clientPath = require.resolve('../src/longterm/clickup/client');
    const routePath = require.resolve('../src/longterm/routes/book-diag');
    delete require.cache[routePath];
    require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
      exports: { configured: () => false, pipelineTasksPage: async () => { throw new Error('should not be called'); } } };
    const router = require(routePath);
    const r = await get(router, '/cards', H);
    eq(r.status, 503, 'it refuses');
    ok(/not connected/i.test(r.body.error), 'in words');
    eq(r.body.cards, undefined, 'with no cards key — an empty list would read as "there are none"');
  }

  // ── G. a vendor failure is an answer, not a crash ────────────────────────
  console.log('\nG. a ClickUp outage is reported, not thrown');
  {
    const clientPath = require.resolve('../src/longterm/clickup/client');
    const routePath = require.resolve('../src/longterm/routes/book-diag');
    delete require.cache[routePath];
    require.cache[clientPath] = { id: clientPath, filename: clientPath, loaded: true,
      exports: { configured: () => true, pipelineTasksPage: async () => { const e = new Error('ClickUp GET failed (HTTP 502)'); throw e; } } };
    const router = require(routePath);
    const r = await get(router, '/cards', H);
    eq(r.status, 502, 'it answers 502');
    ok(/502/.test(r.body.error), 'saying what ClickUp said');
  }

  console.log(`\nall good — ${checks} checks`);
})().catch((e) => { console.error('\nFAILED:', e && e.message, '\n', e && e.stack); process.exit(1); });
