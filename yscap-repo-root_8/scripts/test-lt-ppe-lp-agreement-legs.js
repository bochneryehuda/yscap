#!/usr/bin/env node
'use strict';
/**
 * LT PPE — the agreement-harness LEG ADAPTERS (lp-agreement-legs.js), pure/offline. Proves the two legs
 * plug the real quote engine and a (STUBBED) Lender Price client into ratesheet-agreement's contract:
 * the ours-leg prices a scenario off the sheet-under-test; the LP-leg maps price()/priceDisqualified()
 * → { full, disqualified }; a hard LP failure THROWS (so the orchestrator makes it an engine_error and
 * the batch survives) while a disqualify TIMEOUT does not; and readiness() names the absent credentials.
 *
 * LT-only. No network (the client is a stub), no DB, no RTL imports.
 */
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { runRatesheetAgreement } = require('../src/longterm/ppe/ratesheet-agreement');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }

console.log('LT PPE — agreement-harness leg adapters\n');

// A tiny real program + scenario the real quoteProgram prices (mirrors the quote/agreement fixtures).
const PROGRAM = {
  code: 'DHVN_DSCR30', name: 'DSCR 30yr', investorCode: 'DHVN',
  rules: [{ code: 'cashout', kind: 'pricing', when: { fact: 'purpose', op: 'eq', value: 'cashout' }, adjustment: { code: 'cashout', category: 'purpose', adjMilli: 500 } }],
  baseGrid: [{ rate: 71250, lockDays: 30, basePriceMilli: 102850 }],
};
const SETTINGS = { 'pricing.correspondent_margin_milli': 250, 'pricing.rounding_mode': 'none', 'pricing.price_floor_milli': 98000 };
const SCENARIO = { state: 'TX', fico: 740, ltv: 70000, dscr: 1200, purpose: 'cashout', lock_days: 30, loan_amount: 500000 };

// ---- 1) the OURS leg prices off the program ----------------------------------------------------
const ours = legs.buildOursLeg(PROGRAM, SETTINGS);
const q = ours(SCENARIO);
ok(q.eligible && q.ladder.length === 1 && q.ladder[0].finalPriceMilli === 102100,
  'OURS leg: prices the scenario off the sheet-under-test (102.100)');
try { legs.buildOursLeg(null); ok(false, 'buildOursLeg refuses a missing program'); }
catch (_) { ok(true, 'buildOursLeg refuses a missing program (the sheet-under-test)'); }

// ---- a STUB LP client (no network) -------------------------------------------------------------
function stubClient(over = {}) {
  return {
    configured: () => over.configured !== undefined ? over.configured : true,
    price: async () => over.price || { ok: true, raw: { RAW: 'full' } },
    priceDisqualified: async () => over.priceDisqualified || { ok: true, ready: true, disqualified: { RAW: 'disq' } },
    parseFull: (raw) => ({ programs: raw && raw.RAW === 'full' ? [{ investor: 'DHVN', program: 'DSCR 30yr', options: [] }] : [] }),
    parseDisqualified: (raw) => ({ ready: true, lenders: raw && raw.RAW === 'disq' ? [{ investor: 'DHVN', items: [{ program: 'DSCR 30yr', reasons: [{ rule: 'x' }] }] }] : [] }),
  };
}

// ---- 2) the LP leg maps price + priceDisqualified → { full, disqualified } ----------------------
(async () => {
  const lp = legs.buildLpLeg(stubClient());
  const out = await lp(SCENARIO);
  ok(out.full && Array.isArray(out.full.programs) && out.full.programs.length === 1, 'LP leg: full comes from parseFull(price().raw)');
  ok(out.disqualified && out.disqualified.lenders.length === 1, 'LP leg: disqualified comes from parseDisqualified(priceDisqualified())');

  // ---- 3) withDisqualify:false skips the disqualify call ---------------------------------------
  let calledDisq = false;
  const noDisq = legs.buildLpLeg({ ...stubClient(), priceDisqualified: async () => { calledDisq = true; return { ok: true }; } }, { withDisqualify: false });
  const out2 = await noDisq(SCENARIO);
  ok(!calledDisq && out2.disqualified.lenders.length === 0, 'LP leg: withDisqualify:false never calls priceDisqualified');

  // ---- 4) a hard LP failure THROWS (→ engine_error, batch survives) ----------------------------
  const failLp = legs.buildLpLeg(stubClient({ price: { ok: false, error: 'lp_login_failed', message: 'login 401' } }));
  let threw = false;
  try { await failLp(SCENARIO); } catch (e) { threw = /login 401/.test(String(e.message)); }
  ok(threw, 'LP leg: a hard price() failure throws (with LP\'s reason)');

  // ---- 5) a disqualify TIMEOUT is NOT a hard failure -------------------------------------------
  const timeoutLp = legs.buildLpLeg(stubClient({ priceDisqualified: { ok: false, ready: false } }));
  const out3 = await timeoutLp(SCENARIO);
  ok(out3.full.programs.length === 1 && out3.disqualified.ready === false && out3.disqualified.lenders.length === 0,
    'LP leg: a disqualify timeout yields no declines but does NOT throw');

  // ---- 6) readiness names the absent credentials -----------------------------------------------
  const notReady = legs.readiness(stubClient({ configured: false }), {});
  ok(notReady.configured === false && notReady.missing.length === 3 && /LP_USERNAME/.test(notReady.message),
    'readiness: not configured → names all three missing credentials');
  const ready = legs.readiness(stubClient({ configured: true }), { LP_USERNAME: 'u', LP_PASSWORD: 'p', LP_CLIENT_SECRET: 's' });
  ok(ready.configured === true && ready.missing.length === 0, 'readiness: configured → nothing missing');

  // ---- 7) both legs plug into the orchestrator end to end --------------------------------------
  const client = {
    ...stubClient(),
    // an LP program that agrees with our single 102.100 rung to the penny
    parseFull: () => ({ programs: [{ investor: 'DHVN', program: 'DSCR 30yr', options: [{ priceBuild: { noteRate: 71.25, price: 102.100, baseRate: 71.25, basePoints: -2.85, adjustmentPoints: 0.5 }, adjustments: [{ adjType: 'purpose', reason: 'Cash-Out', value: 0.5 }], holdback: { investor: [{ value: 0.25 }] }, flags: {} }] }] }),
    priceDisqualified: async () => ({ ok: true, ready: true, disqualified: { RAW: 'none' } }),
    parseDisqualified: () => ({ ready: true, lenders: [] }),
  };
  const batch = await runRatesheetAgreement([SCENARIO], { ours: legs.buildOursLeg(PROGRAM, SETTINGS), lp: legs.buildLpLeg(client) }, { filter: { investor: 'DHVN' } });
  ok(batch.summary.gateMet === true && batch.summary.agreed === 1,
    'END-TO-END: the two adapters drive the orchestrator to a met gate');

  console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
  process.exit(fail === 0 ? 0 : 1);
})();
