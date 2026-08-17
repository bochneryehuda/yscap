'use strict';
/**
 * LT PPE — a disagreement now says WHY, on the row that records it (`divergence.js`, wired in the façade).
 *
 * THE GAP THIS CLOSES. `divergence.diagnose` has always been able to put our full build-up (base →
 * itemized LLPAs → margin → round → clamp) beside Lender Price's single number and point at the ONE
 * component whose magnitude most closely matches the gap. Nothing called it, so every finding in the
 * ledger said only THAT the two disagreed and by how much — and the first question a reviewer asks is
 * the one the ledger could not answer.
 *
 * WHY IN THE FAÇADE, AND NOWHERE ELSE. The diagnosis needs OUR reconstruction record, and that exists
 * at exactly one moment: while the comparison is being made. Neither producer of findings has ever
 * passed `ourPayload`, so `our_payload` is NULL on every row in the ledger — a screen re-deriving the
 * explanation later would have to re-price the scenario against whatever the sheet says TODAY and
 * would quietly be answering a different question about a different sheet. Diagnosing where the
 * evidence is means the explanation is about the run it is attached to.
 *
 * WHAT IS PROVEN HERE:
 *   1. a price disagreement carries an explanation, and it reaches the LEDGER RECORD — not just the
 *      HTTP response, which nobody reads three weeks later;
 *   2. the rung is matched by EXACT coupon and ABSTAINS otherwise — a near-match would read every LLPA
 *      and the margin off the wrong rate and then name a suspect with full confidence;
 *   3. the confidence is honest: 'strong' only when a single component EXACTLY equals the gap;
 *   4. a non-price finding (an engine error, an eligibility split) still gets its own plain summary;
 *   5. a diagnosis can NEVER cost a verdict that has already been reached.
 *
 *   node scripts/test-lt-ppe-divergence-wiring.js
 *
 * Pure: every IO dependency of the façade is injected. LT-only, no RTL imports.
 */
const assert = require('assert');
const FA = require('../src/longterm/ppe/facade');

let n = 0; let failures = 0;
const ok = (c, m) => { console.log(`${c ? '  ok  ' : ' FAIL '} ${m}`); n += 1; if (!c) failures += 1; };

const NOW = 1_700_000_000_000;
const lpParsed = (price) => ({ programs: [{ program: 'DSCR', product: 'Fixed', rungs: [{ rate: 7.0, price }] }] });

/**
 * Our quote at coupon 7.000, built so ONE component is exactly the size of the gap under test: the
 * price is 0.250 pts above Lender Price's, and the `dscr_band` LLPA is exactly 0.250.
 */
const ourQuote = (opts = {}) => ({
  eligible: true,
  ladder: [{
    rate: opts.rate == null ? 7000 : opts.rate,
    basePriceMilli: 103100,
    adjustments: [
      { code: 'dscr_band', category: 'dscr', costMilli: 250 },
      { code: 'state_ny', category: 'state', costMilli: 1000 },
    ],
    adjustmentCostMilli: 1250,
    marginMilli: 500,
    rawPriceMilli: 103100,
    roundedPriceMilli: 103100,
    finalPriceMilli: 103100,
  }],
});

(async () => {
  // =========================================================================
  // 1. the explanation reaches the LEDGER, not only the response
  // =========================================================================
  {
    const recorded = [];
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'ltv=70', ltv: 70 }, investor: 'Acme', program: 'DSCR' },
      {
        mode: () => 'shadow',
        priceLp: async () => lpParsed(102.850),          // 102.850 vs our 103.100 → a 0.250 gap
        ourQuote: async () => ourQuote(),
        recordFinding: (r) => recorded.push(r),
        nowMs: NOW,
      },
      { priceToleranceMilli: 0 },
    );

    const f = (res.shadow.findings || []).find((x) => x.kind === 'price_mismatch');
    ok(!!f, 'D1 the two engines disagree on price');
    ok(f && f.explanation && f.explanation.kind === 'price_mismatch', 'D2 …and the finding carries an explanation');
    ok(f && /higher than Lender Price/.test(f.explanation.summary || ''),
      'D3 …stated in a sentence, with the direction — not a bare delta');
    ok(f && f.explanation.confidence === 'strong' && f.explanation.topSuspect
      && f.explanation.topSuspect.component === 'adjustment',
      'D4 …naming the ONE component whose size exactly equals the gap');
    ok(f && f.explanation.buildUp && f.explanation.buildUp.basePriceMilli === 103100
      && f.explanation.buildUp.finalPriceMilli === 103100 && f.explanation.buildUp.marginMilli === 500,
      'D5 …and our whole build-up beside it, so the reviewer can check the claim rather than trust it');

    // The response is read once; the LEDGER is what somebody opens three weeks later. If the
    // explanation does not ride into the record, the diagnosis was made and thrown away.
    const rec = recorded.length ? recorded[0].find((r) => r.kind === 'price_mismatch') : null;
    ok(!!rec, 'D6 the finding was recorded');
    ok(rec && rec.diff && rec.diff.explanation && rec.diff.explanation.confidence === 'strong',
      'D7 …and the explanation is ON the recorded row — the diagnosis outlives the request that made it');
  }

  // =========================================================================
  // 2. the rung is matched by EXACT coupon, and abstains otherwise
  // =========================================================================
  {
    // Asserted on `attachDiagnosis` directly, because the relationship under test is between ONE
    // finding's coupon and ONE ladder's coupons — driving it through the whole façade would leave the
    // comparator free to answer with a different finding kind, and the assertion would then pass
    // without ever exercising the rule (it did: the first cut of this section ended in an `ok(true)`).
    //
    // Our ladder prices 7.125; the finding is about 7.000. Reading the 7.125 rung's LLPAs to explain a
    // 7.000 gap would name `dscr_band` with FULL confidence — off the wrong rate.
    const cmp = { agree: false, findings: [{ kind: 'price_mismatch', rate: 7000, deltaMilli: 250 }] };
    FA._internals.attachDiagnosis(cmp, ourQuote({ rate: 7125 }), { priceToleranceMilli: 0 });
    const ex = cmp.findings[0].explanation;
    ok(ex && ex.topSuspect === null && ex.confidence === 'none',
      'D8 with no rung at the finding\'s own coupon, NO suspect is named');
    ok(ex && /cannot be narrowed/.test(ex.summary || ''),
      'D9 …and the summary says so, rather than pointing at another rate\'s LLPA');

    // The control on the same fixture: at the MATCHING coupon the very same build-up does name it, so
    // D8/D9 are the rule biting rather than the diagnosis being unable to answer at all.
    const same = { agree: false, findings: [{ kind: 'price_mismatch', rate: 7000, deltaMilli: 250 }] };
    FA._internals.attachDiagnosis(same, ourQuote({ rate: 7000 }), { priceToleranceMilli: 0 });
    ok(same.findings[0].explanation.topSuspect
      && same.findings[0].explanation.topSuspect.label === 'LLPA dscr_band'
      && same.findings[0].explanation.confidence === 'strong',
      'D9b …while the SAME build-up at the matching coupon names dscr_band exactly — the control');
  }

  // =========================================================================
  // 3. a NON-price finding still explains itself
  // =========================================================================
  {
    const recorded = [];
    await FA.priceWithShadow(
      { scenario: { _label: 'x=1' }, investor: 'Acme', program: 'DSCR' },
      {
        mode: () => 'shadow',
        priceLp: async () => lpParsed(102.850),
        ourQuote: async () => { throw new Error('our boom'); },
        recordFinding: (r) => recorded.push(r),
        nowMs: NOW,
      },
    );
    const rec = recorded[0][0];
    ok(rec.kind === 'engine_error', 'D10 our engine throwing is recorded as an engine_error');
    ok(rec.diff.explanation && /our bug to fix/.test(rec.diff.explanation.summary || ''),
      'D11 …and its explanation says plainly that it is OUR bug, not a Lender Price disagreement');
  }

  // =========================================================================
  // 4. a diagnosis can never cost a verdict
  // =========================================================================
  {
    // A frozen finding cannot take the property: in strict mode the assignment THROWS. That is the
    // cheapest honest way to fire the failure path, and what it proves is the guarantee — the
    // comparison survives and the finding is returned exactly as it was.
    const frozen = Object.freeze({ kind: 'price_mismatch', rate: 7000, deltaMilli: 250 });
    const cmp = { agree: false, findings: [frozen] };
    let threw = null;
    try { FA._internals.attachDiagnosis(cmp, ourQuote(), { priceToleranceMilli: 0 }); } catch (e) { threw = e; }
    ok(threw === null, 'D12 a diagnosis that cannot be attached does not throw');
    ok(cmp.findings[0] === frozen && cmp.findings[0].explanation === undefined,
      'D13 …and the finding stands exactly as the comparison left it');

    // And the ordinary no-op cases: nothing to diagnose, and nothing to diagnose WITH.
    const empty = { agree: true, findings: [] };
    FA._internals.attachDiagnosis(empty, ourQuote(), {});
    ok(empty.findings.length === 0, 'D14 an agreeing comparison is untouched');
    const noQuote = { agree: false, findings: [{ kind: 'price_mismatch', rate: 7000, deltaMilli: 250 }] };
    FA._internals.attachDiagnosis(noQuote, null, {});
    ok(noQuote.findings[0].explanation && noQuote.findings[0].explanation.topSuspect === null,
      'D15 with no quote at all it still explains the gap — and names no cause');
  }

  console.log(`\n${failures ? `${failures} FAILED of ${n}` : `ok - lt ppe divergence wiring (${n} assertions)`}`);
  assert.strictEqual(failures, 0);
})().catch((e) => { console.error(e); process.exit(1); });
