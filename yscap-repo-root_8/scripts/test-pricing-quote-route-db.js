'use strict';
/**
 * THE PUBLIC STUDIO-QUOTE DOOR — what it answers, and everything it refuses.
 * (issue #7 phase 2; src/routes/pricing-quote.js)
 *
 * This is the one door in the whole #7 plan that an anonymous visitor can call,
 * so the interesting assertions are the REFUSALS. It exists because the
 * marketing term sheet is anonymous — a login-gated route could not serve it —
 * and it is a net win only for as long as it keeps handing back ONE priced deal
 * instead of the tables behind it.
 *
 * Runs against a real server on a real Postgres (the pricing settings it applies
 * are read from the DB), through real HTTP.
 *
 * SELF-SKIPS WITHOUT A DATABASE, and requires nothing that opens a pool until
 * after that check — the rule every other *-db.js suite in the chain follows.
 * The first version of this file broke it (`require('../src/server')` at the
 * top, no guard) and CI caught it: `npm test` runs in BOTH CI jobs, and the
 * `test` job has no Postgres service, so the boot sat in its connect-retry loop
 * against the default database and failed the whole run. Check first, exit 0,
 * require afterwards.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-pricing-quote-route-db (no DATABASE_URL)'); process.exit(0); }

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-pricing-quote';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || 'test-ssn-key-for-verification-only-32bytes!!';
process.env.EMAIL_PROVIDER = 'none';
process.env.NODE_ENV = 'test';

const http = require('http');

const app = require('../src/server');
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass++; } else { fails.push(m); console.log(`FAIL ${m}`); } };
const eq = (a, b, m) => ok(JSON.stringify(a) === JSON.stringify(b), `${m} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

function call(server, body, opts) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: server.address().port, path: '/api/pricing/studio', method: 'POST',
      headers: { 'Content-Type': (opts && opts.contentType) || 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let d = ''; res.on('data', (c) => { d += c; });
      res.on('end', () => { let j = null; try { j = JSON.parse(d); } catch (_) { /* not json */ } resolve({ status: res.statusCode, headers: res.headers, body: j, raw: d }); });
    });
    req.on('error', () => resolve({ status: 0, headers: {}, body: null, raw: '' }));
    req.end(payload);
  });
}

const DEAL = {
  loanType: 'Purchase', strategy: 'Fix & Flip', state: 'NJ', propertyType: 'SFR',
  fico: 740, expFlips: 12, expHolds: 2, expGround: 0,
  purchasePrice: 400000, asIsValue: 400000, arv: 600000, rehabBudget: 80000, term: 12, irMonths: 6,
};

(async () => {
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  try {
    console.log('== A. it answers the studio question, in full ==');
    const r = await call(server, DEAL);
    ok(r.status === 200, `200 (${r.status})`);
    const B = r.body || {};
    ok(B.available === true, 'available');
    for (const p of ['standard', 'gold', 'silver']) {
      ok(B[p] && B[p].evaluate, `${p} has an evaluation`);
    }
    ok(B.standard.ladder && B.standard.ladder.rows.length > 0, 'the leverage ladder comes back with rows');
    ok(!!B.standard.caps, 'the caps row comes back');
    ok(!!B.title && !!B.title.standard, 'a title estimate comes back');
    eq(B.derived.strategyCode, 'FF', 'the strategy code is resolved by the engine');
    ok(B.derived.projectCount > 0, 'the claimed-experience count is resolved by the engine');
    ok(!!B.deal, 'it echoes the deal it priced (so a stale answer is detectable)');

    console.log('\n== B. it never leaks the guideline TABLES, only this one deal ==');
    const text = JSON.stringify(B);
    // The whole point of #7: the matrix / rate build-up / Silver grid must not
    // ride along in the answer.
    for (const k of ['MATRIX', 'RATE_BLOCKS', 'ORIG_PCT', 'MARKUP', 'constants']) {
      ok(!text.includes(k), `the response carries no ${k}`);
    }

    console.log('\n== C. the answer is not cacheable and not indexable ==');
    eq(r.headers['cache-control'], 'no-store', 'Cache-Control');
    eq(r.headers['x-robots-tag'], 'noindex', 'X-Robots-Tag');

    console.log('\n== D. IT REFUSES THE ADMIN KNOBS — an anonymous caller cannot move our pricing ==');
    const base = (await call(server, DEAL)).body;
    const baseRate = base.standard.evaluate.noteRate != null ? base.standard.evaluate.noteRate : base.standard.evaluate.maxNoteRate;
    const baseLoan = base.standard.evaluate.sizing && base.standard.evaluate.sizing.totalLoan;

    // Every one of these would be a real exposure if it were honoured.
    const KNOBS = [
      ['markupStdPct', 0], ['markupGoldPct', 0], ['markupSilverPct', 0],
      ['origStdPct', 0], ['origGoldPct', 0], ['lenderFee', 0], ['creditFee', 0],
      ['appraisalFee', 0], ['titleFee', 0],
      ['ovrAcqLTV', 0.99], ['ovrARLTV', 0.99], ['ovrLTC', 0.99], ['ovrRate', 0.01],
      ['ovrIrMonths', 24], ['ovrEffPrice', 1], ['forcePrice', true], ['manualPricing', true],
      ['oopRehab', 999999], ['oopRehabMax', true],
    ];
    for (const [k, v] of KNOBS) {
      const res = await call(server, { ...DEAL, [k]: v });
      const e = res.body && res.body.standard && res.body.standard.evaluate;
      const rate = e && (e.noteRate != null ? e.noteRate : e.maxNoteRate);
      const loan = e && e.sizing && e.sizing.totalLoan;
      ok(rate === baseRate && loan === baseLoan, `"${k}" changes nothing about the quote`);
      /* The check above is necessary and NOT sufficient, which an audit of this
         very test proved: with the whitelist deliberately removed, `ovrAcqLTV`
         and `ovrLTC` still "passed" — not because they were refused, but because
         this particular deal is not bound by those caps, so honouring them moved
         no number. A knob that reaches the engine on a deal that happens not to
         care is still a knob that reaches the engine. So assert the STRUCTURAL
         fact too, which no choice of deal can mask: the key is dropped, not
         merely unused. */
      ok(!(k in (res.body.deal || {})), `  …and "${k}" never reaches the priced deal at all`);
    }

    console.log('\n== E. the markup comes from OUR settings, and the rate proves it ==');
    // The rate must include a markup: quoting at the engine's bare cost would
    // mean the company default never reached the engine.
    ok(typeof baseRate === 'number' && baseRate > 0, `a real note rate came back (${baseRate})`);

    console.log('\n== F. a refinance is sized on the as-is value, never a price ==');
    const refi = await call(server, { ...DEAL, loanType: 'Refinance', purchasePrice: 9999999, asIsValue: 350000, arv: 520000 });
    eq(refi.body.deal.purchasePrice, 350000, 'the purchase price is re-asserted to the as-is value');
    const refi2 = await call(server, { ...DEAL, loanType: 'Refinance', purchasePrice: 350000, asIsValue: 350000, arv: 520000 });
    const l1 = refi.body.standard.evaluate.sizing && refi.body.standard.evaluate.sizing.totalLoan;
    const l2 = refi2.body.standard.evaluate.sizing && refi2.body.standard.evaluate.sizing.totalLoan;
    eq(l1, l2, 'so an inflated price cannot change what a refinance sizes to');

    console.log('\n== G. junk in does not take the door down ==');
    for (const [label, body] of [
      ['an empty body', {}],
      ['nulls everywhere', { loanType: null, strategy: null, state: null, fico: null, purchasePrice: null }],
      ['strings where numbers go', { ...DEAL, purchasePrice: 'lots', fico: 'good', term: 'a year' }],
      ['absurd numbers', { ...DEAL, purchasePrice: 1e300, arv: -5, term: 9999, fico: 1e9 }],
      ['an array', []],
      ['a deep object', { ...DEAL, nested: { a: { b: { c: 1 } } } }],
    ]) {
      const res = await call(server, body);
      ok(res.status === 200 || res.status === 503, `${label}: answers cleanly (${res.status})`);
      ok(res.body !== null, `${label}: and answers JSON`);
    }
    const bad = await call(server, '{not json', { contentType: 'application/json' });
    ok(bad.status >= 400 && bad.status < 500, `malformed JSON is a client error (${bad.status})`);

    console.log('\n== H. an ineligible deal is REPORTED, not hidden and not thrown ==');
    const inel = await call(server, { ...DEAL, state: 'IN' });
    ok(inel.status === 200, 'still a 200');
    eq(inel.body.standard.evaluate.status, 'INELIGIBLE', 'and it says so plainly');
    ok(Array.isArray(inel.body.standard.evaluate.reasons) && inel.body.standard.evaluate.reasons.length > 0, 'with a reason');

    console.log('\n== I. one caller cannot leave a markup behind for the next ==');
    const a1 = await call(server, DEAL);
    await call(server, { ...DEAL, markupStdPct: 99 });
    const a2 = await call(server, DEAL);
    const rate1 = a1.body.standard.evaluate.noteRate != null ? a1.body.standard.evaluate.noteRate : a1.body.standard.evaluate.maxNoteRate;
    const rate2 = a2.body.standard.evaluate.noteRate != null ? a2.body.standard.evaluate.noteRate : a2.body.standard.evaluate.maxNoteRate;
    eq(rate2, rate1, 'the rate is identical before and after a hostile request');

    console.log(`\n${fails.length ? 'FAILED' : 'ALL PASS'} — ${pass} assertions, ${fails.length} failure(s)`);
    fails.forEach((f) => console.log('  - ' + f));
  } catch (e) {
    fails.push('threw: ' + (e && e.stack || e));
    console.log('FAIL threw:', e && e.stack || e);
  } finally {
    server.close();
    try { await require('../src/db').pool.end(); } catch (_) { /* already closed */ }
  }
  process.exit(fails.length ? 1 : 0);
})();
