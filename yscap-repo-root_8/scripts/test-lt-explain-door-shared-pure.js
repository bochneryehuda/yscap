'use strict';
/**
 * ONE EXPLAIN DOOR, MOUNTED BY BOTH ENGINES.
 *
 * ── WHAT THIS GUARDS (owner-directed 2026-09-03) ───────────────────────────
 * *"All the hours and hours of testing that we put in to set up LoanNEX, we did on the
 * combined pricing engine over there. LoanNEX was perfect, including pulling up the
 * itemization LLPA. I told you to copy it from here and bring in how it works."*
 *
 * The itemised breakdown was built and tested against the live rate sheet on ONE engine.
 * The General Pricing Engine — the one the company prices on, and the one the owner has
 * now switched five investors onto LoanNEX for — had no such door at all, so a LoanNEX row
 * there could show a price and never say what was in it.
 *
 * Four properties, each with a failure that is silent without a guard:
 *
 *   1. THERE IS ONE DOOR. A second implementation would let one engine itemise a price
 *      differently from the other on the same quote, and the copy that drifts is the one
 *      somebody quotes from.
 *   2. BOTH ENGINES MOUNT IT. A door nothing calls is not a fix.
 *   3. THE GENERAL ENGINE NEVER NAMES A VENDOR. That board is ONE SYSTEM by the owner's own
 *      rule; the reveal must be refused there whatever a caller sends — not merely not asked
 *      for by our own screen.
 *   4. AN ORDINARY LENDER PRICE BOARD STILL COSTS NOTHING. Its itemization arrives with the
 *      search, so a row with no explain handle is told so rather than sent to the vendor.
 *
 * PURE: no network, no database, no browser. The rate sheet is stubbed in the require cache
 * and every answer below comes out of the REAL route.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (p) => path.join(ROOT, p);

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };
const read = (p) => fs.readFileSync(R(p), 'utf8');
/* Every "must not appear" check reads the COMMENT-STRIPPED source: the code explaining why a
   rule exists necessarily names the thing it forbids, and a guard that read comments would
   fail on its own explanation and then get "fixed" by deleting the explanation. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

console.log('\nA · there is ONE door, and both engines mount it');
{
  const door = read('src/longterm/routes/explain-door.js');
  const combined = strip(read('src/longterm/routes/combined-pricer.js'));
  const general = strip(read('src/longterm/routes/dscr-pricer.js'));

  ok(/router\.post\('\/explain'/.test(door), 'A1 the door itself lives in explain-door.js');
  eq((strip(door).match(/router\.post\('\/explain'/g) || []).length, 1,
    'A2 …exactly once — one definition of how a price is explained');
  ok(!/router\.post\('\/explain'/.test(combined) && !/router\.post\('\/explain'/.test(general),
    'A3 NEITHER engine carries a second copy of it');
  ok(/explainDoor\.attach\(router, \{ reveal: 'ask' \}\)/.test(combined),
    'A4 the combined engine mounts it — super-admin only, so an admin may ASK where a row came from');
  ok(/require\('\.\/explain-door'\)\.attach\(router, \{ reveal: false \}\)/.test(general),
    'A5 the general engine mounts THE SAME door, with the reveal refused outright');

  /* The helpers moved with it. Two copies of `quoteFromBody` is how one door forgets to
     open the sealed price and quietly asks the sheet about a rounded one. */
  for (const f of ['quoteFromBody', 'explainScenario', 'scenarioRefused', 'holdbackOnRow', 'askedOf']) {
    ok(new RegExp(`(function|const) ${f}\\b`).test(door) && !new RegExp(`^(async function|function) ${f}\\(`, 'm').test(combined),
      `A6 \`${f}\` has ONE definition, in the shared door — the combined router requires it back`);
  }
}

console.log('\nB · the door answers, and the general engine can never be made to name a vendor');
{
  // A LoanNEX answer in the vendor's OWN shape, taken from the live capture and parsed by the
  // production parser — never an invented one. (Two earlier cuts of this harness invented a
  // shape and then used the wrong lock field, and both reported an empty breakdown that was
  // the HARNESS's fault. An invented fixture cannot tell you that.)
  const parse = require(R('src/longterm/loannex/parse'));
  const capture = require(R('src/longterm/loannex/capture/evidence-live.json'));
  const liveEv = (capture.samples || []).map((s) => parse.parseEvidence(s.response)).find(Boolean);
  ok(!!liveEv && (liveEv.adjustments || []).length > 0,
    `B0 CONTROL: the capture holds a real itemised answer to work from (${(liveEv.adjustments || []).length} adjustments)`);

  let asked = null;
  const realNex = require(R('src/longterm/loannex/client'));
  require.cache[require.resolve(R('src/longterm/loannex/client'))].exports = Object.assign({}, realNex, {
    price: async () => ({ board: NX_BOARD, transactionId: 'txn-77', portal: 'a-portal' }),
    evidence: async (sc, quote, ident) => {
      asked = { sc, quote, ident };
      // `evidenceCoversRate` compares `ev.rate` to the option's note rate and `ev.lockPeriod`
      // — the vendor's OWN field name — to its lock. Point the real answer at this row.
      return { transactionId: ident.transactionId || null,
        evidence: { ...liveEv, rate: Number(quote.rate), lockPeriod: Number(quote.lockDays) } };
    },
  });

  const gb = require(R('src/longterm/pricing/general-board'));
  const ip = require(R('src/longterm/lenderprice/investor-programs'));
  const lpClient = require(R('src/longterm/lenderprice/client'));
  const sm = require(R('src/longterm/lenderprice/search-model'));
  var NX_BOARD = parse.parse(require(R('src/longterm/loannex/capture/quick-prices.json')).response);

  const leaf = (co, rate) => ({ companyId: co, companyName: co, programName: 'DSCR 30 Yr Fixed',
    productName: '30 Yr Fixed', rate, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5,
    dayLock: 30, term: 30, loanAmount: 375000, dscr: 1.3, fico: 760, ltv: 75,
    monthlyPayment: { monthlyPI: 2500, mi: 0 }, groupAdjustmentProperties: [],
    ratePeriod: { validAsOf: '2026-09-03T00:00:00Z' }, expired: false });
  const LP_RAW = { results: { qualifiedNonQMData: { type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR',
    childs: [{ type: 'LenderKey', keyLabel: 'Deephaven', plenderId: 'C', leafs: [leaf('Deephaven', 7.6)] }] } } };
  /* ⛔ NO STATE, DELIBERATELY — this is what a browser actually sends. It knows the ZIP and
     nothing else about the location; `validateScenario` is what turns that into state + county.
     An earlier cut of this fixture carried `state: 'NJ'` itself, so B4 passed whether or not the
     door enriched anything and a mutation that sent the raw scenario straight to the vendor
     sailed through it. A fixture that already holds the answer cannot test the step that
     produces it. */
  const SC = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3,
    ltv: 75, termYears: 30, lockDays: 30, propertyType: 'SingleFamily' };
  const v = sm.validateScenario(SC);
  const lp = { price: async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: v.request, provenance: null }),
    parseFull: lpClient.parseFull };

  const dp = require(R('src/longterm/routes/dscr-pricer'));
  const handler = dp.makeRouter().stack.find((l) => l.route && l.route.path === '/explain').route.stack[0].handle;
  const call = (body) => new Promise((done) => {
    const res = { status(c) { this._c = c; return this; }, json(b) { done({ code: this._c || 200, body: b }); return this; } };
    handler({ body, actor: { id: 's1', kind: 'staff', role: 'super_admin' }, query: {} }, res);
  });

  (async () => {
    const cfg = await gb.loadConfig({ routes: null });
    cfg.staticRequest = v.request;
    const board = await gb.boardForScenario(SC, { lp, nex: { price: async () => ({ board: NX_BOARD, transactionId: 'txn-77', portal: 'a-portal' }) }, investorPrograms: ip }, cfg);

    const nxProg = board.programs.find((p) => p.investorKey !== 'deephaven');
    const nxOpt = (nxProg.options || []).find((o) => o.explain && o.explain.priceHashKey);
    ok(!!nxOpt, 'B1 CONTROL: a LoanNEX row on the GENERAL board carries an explain handle to ask with');
    ok(!!(nxOpt.explain.transactionId), 'B1b …stamped with the search it came out of, so the sheet is asked about a search it has seen');

    const r1 = await call({ quote: nxOpt.explain, scenario: SC, option: nxOpt, investorKey: nxProg.investorKey });
    eq(r1.code, 200, 'B2 the general engine answers a LoanNEX row');
    ok(r1.body.ok === true && ((r1.body.breakdown || {}).lines || []).length > 0,
      `B3 …with a real itemised breakdown (${((r1.body.breakdown || {}).lines || []).length} lines)`);
    ok(SC.state === undefined, 'B4a CONTROL: the browser sent no state — only a ZIP, as it really does');
    eq(asked.sc.state, 'NJ',
      'B4 …and the sheet was asked about the ENRICHED loan the board was priced on, not the raw browser scenario');
    eq(asked.ident.transactionId, 'txn-77', 'B5 …about the search that produced the row');

    const lpProg = board.programs.find((p) => p.investorKey === 'deephaven');
    const lpOpt = (lpProg.options || [])[0];
    const r2 = await call({ quote: lpOpt.explain || {}, scenario: SC, option: lpOpt, investorKey: 'deephaven' });
    ok(r2.body.ok === true && r2.body.alreadyExplained === true,
      'B6 a LENDER PRICE row is told its breakdown already arrived — an ordinary board makes no extra call');

    /* ⛔ THE REVEAL IS REFUSED HERE, NOT MERELY UNASKED. A caller posting `revealSource: true`
       to this engine must still get nothing: the mount decides, not the request. */
    const r3 = await call({ quote: nxOpt.explain, scenario: SC, option: nxOpt, investorKey: nxProg.investorKey, revealSource: true });
    const text = JSON.stringify(r3.body);
    ok(!/loannex|lender\s*price/i.test(text), 'B7 asked to reveal, the general engine still names no vendor');
    eq(r3.body.asked.portal, undefined, 'B7b …no portal, which would name the investor\'s own sheet');
    eq(r3.body.asked.price, undefined, 'B7c …and no vendor price, which subtracted from the row would give our margin away');
    ok(!/vendorBasePoints/.test(text), 'B7d …and no pre-holdback base, for the same reason');

    console.log('\n' + pass + ' checks passed\n');
  })().catch((e) => { console.error('THREW', (e && e.stack) || e); process.exit(1); });
}
