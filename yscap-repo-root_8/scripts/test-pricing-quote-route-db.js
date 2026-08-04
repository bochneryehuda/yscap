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

    /* THE ABOVE IS A DENYLIST OF FIVE WORDS, AND IT WAS NOT ENOUGH. An audit
       (2026-08-03) passed every one of those assertions while the body carried
       Silver's `overlays` — the note-buyer Underwriting Commentary, all 13
       items including the ones that do not apply — plus `tierCaps`, the
       workbook Tier Grid row verbatim, and `rateKey`, the RATE_BLOCKS index of
       the cell just priced. None of them contains any of the five words.

       A denylist can only ever name what somebody already thought of, so the
       route now projects through an ALLOWLIST and this asserts the two
       properties that actually matter. */
    console.log('\n== B2. the withheld fields are genuinely withheld ==');
    for (const p of ['standard', 'gold', 'silver']) {
      const e = (B[p] && B[p].evaluate) || {};
      for (const k of ['overlays', 'tierCaps', 'rateKey']) {
        ok(!(k in e), `${p}.evaluate does not carry "${k}"`);
      }
    }
    // A capital-partner / third-party name must never reach an anonymous
    // surface. `overlays` carried one outright.
    for (const name of ['Elementix', 'Fidelis', 'Blue Lake', 'BlueLake', 'CorrFirst', 'EMCAP', 'Temple View', 'Churchill']) {
      ok(!new RegExp(name.replace(/\s/g, '\\s*'), 'i').test(text), `no third-party name "${name}" in the response`);
    }

    /* AND THE CLASSIFICATION IS COMPLETE. This is the part that keeps working
       after everyone here has moved on: every key the engines actually produce
       must be either shipped or deliberately withheld. A field added to an
       engine tomorrow lands in neither set and fails HERE, so a future
       `overlays` is caught before it ships rather than by the next audit. */
    console.log('\n== B3. every engine field is classified — new ones fail here ==');
    const _int = require('../src/routes/pricing-quote')._internals;
    const {
      PUBLIC_EVALUATE_FIELDS, WITHHELD_EVALUATE_FIELDS,
      PUBLIC_BLOCK_FIELDS, WITHHELD_BLOCK_FIELDS,
      PUBLIC_TOP_FIELDS, WITHHELD_TOP_FIELDS,
    } = _int;
    const studioLib = require('../src/lib/pricing-studio');
    const seen = new Set();
    // The block and the top level are swept by the SAME battery — the first
    // pass of this test only ever looked at `evaluate`, so the allowlist was
    // fail-closed in one place and fail-open in the two wrapped around it.
    const seenBlock = new Set();
    const seenTop = new Set();
    for (const strategy of ['Fix & Flip', 'Fix & Hold', 'Bridge', 'Ground-Up Construction', 'DSCR / Rental']) {
      for (const state of ['NJ', 'NY', 'FL', 'TX']) {
        for (const loanType of ['Purchase', 'Refinance']) {
          for (const isAssignment of [false, true]) {
            let q = null;
            try {
              q = studioLib.studioQuote({
                ...DEAL, strategy, state, loanType, isAssignment,
                sellerPrice: isAssignment ? 350000 : 0,
              }, { standard: 0.005, gold: 0.005, silver: 0.005 });
            } catch (_) { continue; }
            if (q) for (const k of Object.keys(q)) seenTop.add(k);
            for (const p of ['standard', 'gold', 'silver']) {
              const blk = q && q[p];
              if (blk && typeof blk === 'object') for (const k of Object.keys(blk)) seenBlock.add(k);
              const e = blk && blk.evaluate;
              if (e) for (const k of Object.keys(e)) seen.add(k);
            }
          }
        }
      }
    }
    /* The three error siblings only appear when an engine actually throws, and
       none did across the battery above — but they are real keys programBlock
       can attach, and an unswept key is exactly how `overlays` shipped. Add them
       by hand so the classification covers them whether or not this run
       happened to make an engine fall over. */
    for (const k of ['evaluateError', 'ladderError', 'capsError', 'reason']) seenBlock.add(k);
    seenTop.add('reason');

    const unclassified = [...seen].filter((k) => !PUBLIC_EVALUATE_FIELDS.has(k) && !WITHHELD_EVALUATE_FIELDS.has(k));
    ok(seen.size > 30, `the sweep actually exercised the engines (${seen.size} distinct fields)`);
    ok(
      unclassified.length === 0,
      `every engine field is either shipped or deliberately withheld${unclassified.length ? ` — UNCLASSIFIED: ${unclassified.join(', ')}. Add each to PUBLIC_EVALUATE_FIELDS or WITHHELD_EVALUATE_FIELDS in src/routes/pricing-quote.js, with a reason.` : ''}`,
    );

    const unclassifiedBlock = [...seenBlock].filter((k) => !PUBLIC_BLOCK_FIELDS.has(k) && !WITHHELD_BLOCK_FIELDS.has(k));
    ok(seenBlock.size >= 5, `the block level was swept too (${seenBlock.size} distinct keys)`);
    ok(
      unclassifiedBlock.length === 0,
      `every per-program key is classified${unclassifiedBlock.length ? ` — UNCLASSIFIED: ${unclassifiedBlock.join(', ')}. Add each to PUBLIC_BLOCK_FIELDS or WITHHELD_BLOCK_FIELDS.` : ''}`,
    );

    const unclassifiedTop = [...seenTop].filter((k) => !PUBLIC_TOP_FIELDS.has(k) && !WITHHELD_TOP_FIELDS.has(k));
    ok(seenTop.size >= 5, `the top level was swept too (${seenTop.size} distinct keys)`);
    ok(
      unclassifiedTop.length === 0,
      `every top-level key is classified${unclassifiedTop.length ? ` — UNCLASSIFIED: ${unclassifiedTop.join(', ')}. Add each to PUBLIC_TOP_FIELDS or WITHHELD_TOP_FIELDS.` : ''}`,
    );

    /* AND THE PROJECTIONS ACTUALLY DROP THEM. The classification above says what
       we DECIDED; this says what the code DOES. Both are needed — the sets can
       be right while the projection still spreads the object through, which is
       what shipped. */
    console.log('\n== B3b. the block and the top level really are projected ==');
    {
      const rich = {
        program: 'standard', available: true, reason: 'engine not loaded',
        evaluate: { status: 'ELIGIBLE', overlays: ['x'], noteRate: 0.12 },
        evaluateError: "Cannot read properties of undefined (reading 'MATRIX')",
        ladder: { eligible: true, rows: [] }, ladderError: 'threw at RATE_BLOCKS[3]',
        caps: { maxLTC: 0.9 }, capsError: 'caps threw',
        somethingNew: 'invented tomorrow',
      };
      const proj = _int.publicBlock(rich);
      for (const k of ['evaluateError', 'ladderError', 'capsError', 'reason', 'somethingNew']) {
        ok(!(k in proj), `a block does not ship "${k}"`);
      }
      ok(proj.engineFailed === true, 'but the caller IS told the engine failed');
      ok(!('overlays' in proj.evaluate), 'and the evaluate allowlist still applies underneath');

      // A refused deal must not carry a leverage-matrix row.
      const refused = _int.publicBlock({ program: 'standard', available: true, evaluate: { status: 'INELIGIBLE', reasons: [] }, caps: { maxLoan: 2500000, minFico: 600, maxAcqLTV: 0.9 } });
      eq(refused.caps, null, 'a deal the engine REFUSED to price carries no caps row');
      const priced = _int.publicBlock({ program: 'standard', available: true, evaluate: { status: 'ELIGIBLE' }, caps: { maxLTC: 0.9 } });
      ok(priced.caps && priced.caps.maxLTC === 0.9, 'a priced deal still carries the caps the sheet prints');

      const top = _int.publicTop({ available: true, standard: null, gold: null, silver: null, title: {}, derived: {}, titleFor: {}, reason: 'pricing engines unavailable: /srv/app/web/tools/x.js not found', futureKey: 1 }, { state: 'NJ' });
      ok(!('reason' in top), 'the top level does not ship studioQuote\'s reason (it can carry a filesystem path)');
      ok(!('futureKey' in top), 'nor a key nobody has classified');
      ok(top.deal && top.deal.state === 'NJ', 'and the priced deal is still echoed');
    }

    /* A MONEY INPUT HAS A CEILING. 1e308 is finite, so it passed every guard and
       the engine turned it into an Infinity cost basis, which JSON writes as
       null — a confident 200 with a hole in the breakdown. */
    console.log('\n== B3c. an absurd number is clamped, not priced ==');
    {
      const huge = _int.sanitizeDeal({ ...DEAL, purchasePrice: 1e308, asIsValue: 1e308, arv: 1e308, rehabBudget: 1e308, sellerPrice: 1e308 });
      for (const k of ['purchasePrice', 'asIsValue', 'arv', 'rehabBudget']) {
        ok(huge[k] === _int.MAX_MONEY, `${k} is clamped to the ceiling (${huge[k]})`);
      }
      const r = await call(server, { ...DEAL, purchasePrice: 1e308, asIsValue: 1e308, arv: 1e308, rehabBudget: 1e308 });
      ok(r.status === 200, `the door still answers (${r.status})`);
      const sizing = r.body.standard && r.body.standard.evaluate && r.body.standard.evaluate.sizing;
      const holes = sizing ? Object.entries(sizing).filter(([, v]) => v === null).map(([k]) => k) : [];
      ok(holes.length === 0, `and the breakdown has no holes in it${holes.length ? ` — null: ${holes.join(', ')}` : ''}`);
    }

    console.log('\n== B4. the leverage slider actually moves the loan ==');
    /* `targetLTC` is the studio's leverage slider. It was missing from the
       whitelist, so every rung of the ladder answered with the maximum-leverage
       loan and moving the slider changed nothing on screen. It belongs here and
       is not an admin knob: all three engines apply it as
       Math.min(maxLTC, targetLTC), so it can only ever ask for LESS. */
    const loanOf = (r) => r.body && r.body.standard && r.body.standard.evaluate
      && r.body.standard.evaluate.sizing && r.body.standard.evaluate.sizing.totalLoan;
    const noTarget = loanOf(await call(server, DEAL));
    const wide = loanOf(await call(server, { ...DEAL, targetLTC: 0.90 }));
    const tight = loanOf(await call(server, { ...DEAL, targetLTC: 0.65 }));
    ok(typeof wide === 'number' && typeof tight === 'number', 'both rungs price');
    ok(tight < wide, `a lower target sizes a smaller loan (${tight} < ${wide})`);
    // And it can only ever LOWER — the engines apply Math.min(maxLTC, targetLTC),
    // so an out-of-range target must land exactly on the untargeted answer.
    const absurd = loanOf(await call(server, { ...DEAL, targetLTC: 9.99 }));
    ok(absurd === noTarget, `an out-of-range target cannot raise leverage (${absurd} === ${noTarget})`);

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

    /* == H2. A REFUSED DEAL CARRIES NO LEVERAGE ROW — AT EITHER LEVEL ==
       `caps` lives at TWO levels and the first cut of the rule only closed one.
       standard-program.js returns `caps: null` on an INELIGIBLE deal, so
       nulling the BLOCK-level copy LOOKED complete — and the B3b unit test
       above passes a Standard-shaped payload, so it could not see the other
       half. Gold and Silver populate `evaluate.caps` regardless of the verdict,
       and `caps` is on the evaluate allowlist, so a refusal still shipped the
       row (measured 2026-08-03: a FICO-560 refusal shipped Silver's
       {maxLoan, minFico, maxAcqLTV, maxARLTV, maxLTC}).

       So this sweeps EVERY program on EVERY refusal shape rather than asserting
       one hand-picked block: a program that starts populating a third copy of
       the row, or a fourth program, is caught without anyone remembering to
       come back here. It also asserts each shape really did refuse SOMETHING —
       otherwise a change that made these deals eligible would turn the whole
       section into a green no-op. */
    console.log('\n== H2. a refused deal carries no leverage row at EITHER level ==');
    {
      const LEVERAGE_KEYS = ['caps', 'pricedCeiling'];
      for (const [label, deal] of [
        ['an unsupported state', { ...DEAL, state: 'IN' }],
        ['a FICO below every minimum', { ...DEAL, fico: 560 }],
        ['no profit at exit', { ...DEAL, arv: 405000, rehabBudget: 150000 }],
      ]) {
        const res = await call(server, deal);
        ok(res.status === 200, `${label}: answers 200 (${res.status})`);
        let refusals = 0;
        for (const p of ['standard', 'gold', 'silver']) {
          const block = (res.body || {})[p];
          if (!block || !block.evaluate || block.evaluate.status !== 'INELIGIBLE') continue;
          refusals++;
          for (const k of LEVERAGE_KEYS) {
            eq(block.evaluate[k] == null, true, `${label}: ${p}.evaluate.${k} is withheld on a refusal`);
          }
          eq(block.caps == null, true, `${label}: ${p}.caps is withheld on a refusal`);
        }
        ok(refusals > 0, `${label}: at least one program actually refused it (${refusals})`);
      }
      // And the rule lives in publicEvaluate itself, not only in the caller.
      const ref = _int.publicEvaluate({ status: 'INELIGIBLE', reasons: [], caps: { maxLTC: 0.9 }, pricedCeiling: 1200000 });
      eq(ref.caps, null, 'publicEvaluate nulls a refused deal\'s caps');
      eq(ref.pricedCeiling, null, 'publicEvaluate nulls a refused deal\'s pricedCeiling');
      const okEval = _int.publicEvaluate({ status: 'ELIGIBLE', caps: { maxLTC: 0.9 }, pricedCeiling: 1200000 });
      ok(okEval.caps && okEval.caps.maxLTC === 0.9, 'a priced deal keeps the caps the sheet prints');
      eq(okEval.pricedCeiling, 1200000, 'and keeps its priced ceiling');
    }

    console.log('\n== I. one caller cannot leave a markup behind for the next ==');
    const a1 = await call(server, DEAL);
    await call(server, { ...DEAL, markupStdPct: 99 });
    const a2 = await call(server, DEAL);
    const rate1 = a1.body.standard.evaluate.noteRate != null ? a1.body.standard.evaluate.noteRate : a1.body.standard.evaluate.maxNoteRate;
    const rate2 = a2.body.standard.evaluate.noteRate != null ? a2.body.standard.evaluate.noteRate : a2.body.standard.evaluate.maxNoteRate;
    eq(rate2, rate1, 'the rate is identical before and after a hostile request');

    /* == J. EVERY TITLE FIGURE SAYS WHAT IT WAS COMPUTED FOR ==
       Added after a break-it sweep (2026-08-03) deleted `out.titleFor` from
       src/lib/pricing-studio.js outright and every test in the repo still
       passed. The page asks for title through a GLOBAL — YSTitle.estimate(state,
       loan, txnType) — which says nothing about WHICH PROGRAM is asking, so a
       client reading these answers back has to identify the right figure
       itself, and the only honest way is to match on everything the estimate
       depends on. Without titleFor there is nothing to match on, and the seam
       falls back to guessing by loan amount alone — the exact defect a live
       browser audit measured at $3,600 against $3,615, and a cash-to-close
       $2,520 short on an ineligible deal.

       So: for every program that priced, the figure must be labelled, and the
       label must agree with the loan it was quoted for. */
    console.log('\n== J. every title figure says which loan, state and txn type it is for ==');
    {
      const t = await call(server, DEAL);
      const title = t.body.title || {};
      const titleFor = t.body.titleFor || {};
      let labelled = 0;
      for (const p of ['standard', 'gold', 'silver']) {
        const sized = t.body[p] && t.body[p].evaluate && t.body[p].evaluate.sizing;
        const loan = sized ? Math.floor(Number(sized.totalLoan) || 0) : 0;
        if (!loan) { ok(titleFor[p] == null, `${p} priced nothing, so it carries no title label`); continue; }
        labelled++;
        ok(title[p] && Number(title[p].total) > 0, `${p} has a title figure`);
        ok(!!titleFor[p], `${p} title is LABELLED with what it was computed for`);
        eq(Math.floor(Number((titleFor[p] || {}).loan) || 0), loan, `  ${p} label names the loan it was quoted for`);
        eq((titleFor[p] || {}).state, DEAL.state, `  ${p} label names the state`);
        eq((titleFor[p] || {}).loanType, DEAL.loanType, `  ${p} label names the transaction type`);
      }
      ok(labelled >= 2, `at least two programs priced, so the check means something (${labelled})`);
      // The label must be a SIBLING, never folded into the engine's own return
      // value — the parity proof compares title[p] field for field against the
      // browser's, and an extra key there would make it compare unlike things.
      for (const p of ['standard', 'gold', 'silver']) {
        if (title[p]) ok(!('loan' in title[p]) && !('forLoan' in title[p]), `${p} title itself is untouched by the labelling`);
      }
    }

    /* == K. AN ADMIN-FORCED PRICE STILL TURNS A REFUSAL INTO A REVIEW ==
       Also from the sweep: the forcePrice rule could be deleted from
       pricing-studio and nothing failed. It cannot be reached through THIS door
       (section D proves an anonymous caller's admin knobs are dropped), so it
       is asserted where it actually lives — a direct studioQuote call, the way
       the staff paths use it. It mirrors pricing.js quoteProgram: an admin
       forcing a price gets a MANUAL review, not a flat refusal. */
    console.log('\n== K. forcePrice turns an INELIGIBLE into a MANUAL review ==');
    {
      const inelDeal = { ...DEAL, state: 'IN' };
      const plain = studioLib.studioQuote(inelDeal, {});
      eq(plain.standard.evaluate.status, 'INELIGIBLE', 'without forcePrice the deal is refused');
      const forced = studioLib.studioQuote({ ...inelDeal, forcePrice: true }, {});
      eq(forced.standard.evaluate.status, 'MANUAL', 'with forcePrice it becomes a manual review');
      /* NOT ASSERTED, deliberately: the second half of that rule
         (`exitShortfall = 0`) cannot be observed. Measured over 1,920 INELIGIBLE
         deals across 6 states x 5 FICOs x 4 experience levels x every ARV/rehab/
         price combination, the engine reports `exitShortfall: undefined` on
         EVERY ineligible deal — it returns before the exit gate runs — and on a
         FORCED deal it already reports 0 itself. A deal with a real gap is
         MANUAL, not INELIGIBLE, so this branch never sees one. The line stays
         because it mirrors pricing.js quoteProgram exactly, which is the whole
         point of it; a test that asserted `=== 0` would pass whether or not the
         line existed, which is the same weaker-question trap this section was
         added to close. Say so rather than bank a green check on nothing. */
      // A deal that was never ineligible must be untouched by the flag.
      const okDeal = studioLib.studioQuote({ ...DEAL, forcePrice: true }, {});
      ok(okDeal.standard.evaluate.status !== 'MANUAL' || DEAL.state === 'IN',
        'forcePrice does not downgrade a deal that priced cleanly');
    }

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
