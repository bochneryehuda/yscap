#!/usr/bin/env node
'use strict';
/**
 * Long-Term DSCR pricer routes — load + gate test (no network, no DB).
 * Proves the routers construct without throwing (so server boot can mount them) and
 * that the secret gate on the diagnostics router behaves: off when LP_DIAG_TOKEN is
 * unset, 401 on a wrong token, pass-through on the right one.
 */
let failures = 0;
function ok(c, l) { console.log(`${c ? '  ok  ' : ' FAIL '} ${l}`); if (!c) failures++; }

// 1) The shared handlers/router module loads and builds a router.
const dp = require('../src/longterm/routes/dscr-pricer');
ok(typeof dp.makeRouter === 'function', 'dscr-pricer exports makeRouter()');
ok(Array.isArray(dp.BATTERY) && dp.BATTERY.length === 5, `battery has 5 scenarios (${dp.BATTERY.length})`);
const r = dp.makeRouter();
ok(r && typeof r === 'function' && typeof r.use === 'function', 'makeRouter() returns an express router');

// 2) The secret-gated diagnostics router loads (this is what server.js mounts).
const diag = require('../src/longterm/routes/lenderprice-diag');
ok(typeof diag === 'function' && typeof diag.use === 'function', 'lenderprice-diag is an express router');

// 2b) shapeDisqualified — the per-lender item CURSOR (audit §C3): a lender with more items than the
//     cap is fully retrievable by paging itemOffset.
const { shapeDisqualified, effectiveOf, unsupportedFields } = dp._internals;
const dq = { ready: true, lenderCount: 3, itemCount: 8, reasonCount: 8, lenders: [
  { lender: 'A', lenderId: 'a', itemCount: 5, items: [1, 2, 3, 4, 5] },
  { lender: 'B', lenderId: 'b', itemCount: 2, items: [1, 2] },
  { lender: 'C', lenderId: 'c', itemCount: 1, items: [1] },
] };
{
  const s0 = shapeDisqualified(dq, { itemLimit: 2, itemOffset: 0 }).disqualified;
  ok(s0.lenders[0].items.length === 2 && s0.lenders[0].itemNextOffset === 2 && s0.lenders[0].itemTruncated === true, 'first item page returns 2 + a cursor to the remainder');
  const s2 = shapeDisqualified(dq, { limit: 1, offset: 0, itemLimit: 2, itemOffset: 2 }).disqualified;
  ok(s2.lenders[0].items[0] === 3 && s2.lenders[0].itemNextOffset === 4, 'the cursor walks INTO the same lender (items 3,4 next)');
  const s4 = shapeDisqualified(dq, { limit: 1, offset: 0, itemLimit: 10, itemOffset: 4 }).disqualified;
  ok(s4.lenders[0].items.length === 1 && s4.lenders[0].itemNextOffset === null && s4.lenders[0].itemTruncated === false, 'the last item page has no further cursor');
  const lp1 = shapeDisqualified(dq, { limit: 1, offset: 1 }).disqualified;
  ok(lp1.lenders.length === 1 && lp1.lenders[0].lenderId === 'b' && lp1.page.nextOffset === 2, 'lender pagination still works alongside the item cursor');
}

// 2c) effectiveScenario now shows every transmitted selector (audit) + the new independent fields.
{
  const lp = require('../src/longterm/lenderprice/client');
  const payload = lp.buildSearch({ purpose: 'Cash out', value: 6e5, loan: 42e4, propertyType: 'Condo', attachment: 'Detached', nonWarrantable: true, prepayMonths: 60, cashoutAmount: 50000, zip: '33101', state: 'FL', countyFps: '12086' });
  const eff = effectiveOf(payload);
  ok(eff.reserves === 'Reserves_24' && eff.addlOccupancyType === 'Long_Term_Rental_Property', 'effectiveScenario shows reserves + rental term');
  ok(eff.location && eff.location.state === 'FL' && eff.location.county === '12086', 'effectiveScenario shows the complete location');
  ok(eff.cashoutAmount === 50000, 'effectiveScenario shows the transmitted cashoutAmount');
  ok(eff.attachmentType === 'Detached' && eff.nonWarrantableProject === true, 'effectiveScenario shows the independent attachment + non-warrantable');
  ok(Array.isArray(eff.specialMortgageOptions) && eff.specialMortgageOptions.every((s) => 'id' in s && 'name' in s), 'SMOs are reported as {id,name} identities');
  ok(unsupportedFields({ attachment: 'Detached', nonWarrantable: true, purpose: 'Purchase' }).length === 0, 'attachment + nonWarrantable are supported fields');
  ok(unsupportedFields({ madeUpField: 1 }).includes('madeUpField'), 'a truly unknown field is still rejected');
  // rentalTerm must be in the route allow-list (a builder field the route rejected = an inert feature).
  ok(unsupportedFields({ rentalTerm: 'short', purpose: 'Purchase' }).length === 0, 'rentalTerm is a supported route field (reachable over HTTP)');
  const stEff = effectiveOf(lp.buildSearch({ purpose: 'Purchase', value: 5e5, loan: 4e5, rentalTerm: 'short' }));
  ok(stEff.addlOccupancyType === 'Short_Term_Rental_Property', 'a rentalTerm:short request round-trips to Short_Term_Rental_Property in effectiveScenario');
}

// 3) Exercise the secret gate directly by pulling its first layer's handle.
//    layer[0] is the gate middleware added by router.use((req,res,next)=>{...}).
const gate = diag.stack && diag.stack[0] && diag.stack[0].handle;
ok(typeof gate === 'function', 'diag gate middleware present');
function mockRes() { return { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; }
function run(gateFn, headers, env) {
  const saved = process.env.LP_DIAG_TOKEN;
  if (env === undefined) delete process.env.LP_DIAG_TOKEN; else process.env.LP_DIAG_TOKEN = env;
  let nexted = false;
  const res = mockRes();
  gateFn({ get: (h) => headers[h.toLowerCase()] || '' }, res, () => { nexted = true; });
  if (saved === undefined) delete process.env.LP_DIAG_TOKEN; else process.env.LP_DIAG_TOKEN = saved;
  return { nexted, code: res.code, body: res.body };
}
// off by default → 404, no pass-through
let g = run(gate, {}, undefined);
ok(!g.nexted && g.code === 404, 'gate 404s when LP_DIAG_TOKEN unset (feature off)');
// token set, no header → 401
g = run(gate, {}, 'secret-abc');
ok(!g.nexted && g.code === 401, 'gate 401s with no token header');
// token set, wrong header → 401
g = run(gate, { 'x-lp-diag-token': 'wrong' }, 'secret-abc');
ok(!g.nexted && g.code === 401, 'gate 401s on wrong token');
// token set, right header → next()
g = run(gate, { 'x-lp-diag-token': 'secret-abc' }, 'secret-abc');
ok(g.nexted && g.code === null, 'gate passes through on correct token');

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
