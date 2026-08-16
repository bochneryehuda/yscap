'use strict';
/**
 * Pure offline test for the LT PPE pricing façade (src/longterm/ppe/facade.js).
 * All IO (LP call, our engine, finding persist, mode) is stubbed.
 *   node scripts/test-lt-ppe-facade.js
 */

const assert = require('assert');
const FA = require('../src/longterm/ppe/facade');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const NOW = 1_700_000_000_000;

// LP parsed result (lp.parse shape) for one program.
const lpParsed = (priceBump = 0) => ({ programs: [{ program: 'DSCR', product: 'Fixed', rungs: [{ rate: 7.0, price: 102.850 + priceBump }] }] });
// our quote.js result at a matching coupon (milli units).
const ourQuote = (priceMilli = 102850) => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: priceMilli }] });

async function main() {
  // ---- shadow mode: LP is the answer, agreement recorded, no finding -------
  {
    let lpCalls = 0; let ourCalls = 0; const recorded = [];
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'ltv=70' }, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'shadow', priceLp: async () => { lpCalls += 1; return lpParsed(0); }, ourQuote: async () => { ourCalls += 1; return ourQuote(102850); }, recordFinding: (r) => recorded.push(r), nowMs: NOW },
      { priceToleranceMilli: 0 },
    );
    eq(res.mode, 'shadow', 'shadow mode');
    eq(res.authoritative, 'lp', 'LP is authoritative in shadow');
    ok(res.answer && res.answer.programs, 'answer is the LP parsed result');
    eq(res.shadow.agreed, true, 'engines agree');
    eq(lpCalls, 1, 'LP called once');
    eq(ourCalls, 1, 'our engine called once');
    eq(recorded.length, 0, 'no finding recorded on agreement');
  }

  // ---- shadow mode: disagreement -> finding recorded, LP still the answer --
  {
    const recorded = [];
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'ltv=70', ltv: 70 }, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'shadow', priceLp: async () => lpParsed(0), ourQuote: async () => ourQuote(102900), recordFinding: (r) => recorded.push(r), nowMs: NOW },
      { priceToleranceMilli: 0 },
    );
    eq(res.shadow.agreed, false, 'engines disagree');
    ok(res.answer.programs, 'business answer is still LP');
    eq(recorded.length, 1, 'a finding batch was recorded (fire-and-forget, called synchronously)');
    eq(recorded[0][0].kind, 'price_mismatch', 'the finding is a price mismatch');
    eq(recorded[0][0].investor, 'Acme', 'finding carries investor');
    eq(recorded[0][0].scenario, 'ltv=70', 'finding carries scenario label');
  }

  // ---- shadow mode: our engine throws -> LP answer still returns -----------
  {
    const recorded = [];
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'x=1' }, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'shadow', priceLp: async () => lpParsed(0), ourQuote: async () => { throw new Error('our boom'); }, recordFinding: (r) => recorded.push(r), nowMs: NOW },
    );
    ok(res.answer.programs, 'LP answer returned despite our-engine failure');
    eq(res.shadow.agreed, false, 'shadow marks disagreement on our failure');
    eq(recorded[0][0].kind, 'engine_error', 'an engine_error finding recorded');
    ok(recorded[0][0].diff.detail.includes('our boom'), 'error detail carried');
  }

  // ---- shadow mode: LP throws -> propagates (LP is the business answer) ----
  {
    let threw = false;
    try {
      await FA.priceWithShadow(
        { scenario: {}, investor: 'Acme', program: 'DSCR' },
        { mode: () => 'shadow', priceLp: async () => { throw new Error('LP down'); }, ourQuote: async () => ourQuote() },
      );
    } catch (e) { threw = e.message.includes('LP down'); }
    ok(threw, 'LP failure propagates in shadow mode');
  }

  // ---- a throwing recordFinding never breaks the response ------------------
  {
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'x' }, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'shadow', priceLp: async () => lpParsed(0), ourQuote: async () => ourQuote(103000), recordFinding: () => { throw new Error('db down'); }, nowMs: NOW },
      { priceToleranceMilli: 0 },
    );
    ok(res.answer.programs, 'response fine even though recordFinding threw');
    eq(res.shadow.agreed, false, 'still reports the disagreement');
  }

  // ---- live mode: our engine is the answer, LP not called ------------------
  {
    let lpCalls = 0;
    const res = await FA.priceWithShadow(
      { scenario: {}, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'live', priceLp: async () => { lpCalls += 1; return lpParsed(0); }, ourQuote: async () => ourQuote() },
    );
    eq(res.mode, 'live', 'live mode');
    eq(res.authoritative, 'ours', 'our engine authoritative in live');
    ok(res.answer.ladder, 'answer is our quote');
    eq(res.shadow, null, 'no shadow without a canary');
    eq(lpCalls, 0, 'LP not called in live mode by default');
  }

  // ---- live mode + canary: LP called as a spot-check ----------------------
  {
    let lpCalls = 0; const recorded = [];
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'c' }, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'live', priceLp: async () => { lpCalls += 1; return lpParsed(1); }, ourQuote: async () => ourQuote(102850), recordFinding: (r) => recorded.push(r), nowMs: NOW },
      { canary: true, priceToleranceMilli: 0 },
    );
    eq(lpCalls, 1, 'canary calls LP');
    eq(res.shadow.agreed, false, 'canary detects the divergence');
    eq(recorded.length, 1, 'canary records a finding');
  }

  // ---- live mode + canary: a canary LP failure never breaks the live answer
  {
    const res = await FA.priceWithShadow(
      { scenario: {}, investor: 'Acme', program: 'DSCR' },
      { mode: () => 'live', priceLp: async () => { throw new Error('LP down'); }, ourQuote: async () => ourQuote() },
      { canary: true },
    );
    ok(res.answer.ladder, 'live answer returns even when the canary LP call fails');
    eq(res.shadow, null, 'a failed canary yields no shadow verdict, not an error');
  }

  // ---- default mode is shadow ---------------------------------------------
  {
    const res = await FA.priceWithShadow(
      { scenario: {}, investor: 'Acme', program: 'DSCR' },
      { priceLp: async () => lpParsed(0), ourQuote: async () => ourQuote() },
    );
    eq(res.mode, 'shadow', 'no mode fn -> defaults to shadow');
  }

  console.log(`ok - lt ppe facade (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
