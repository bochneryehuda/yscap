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
