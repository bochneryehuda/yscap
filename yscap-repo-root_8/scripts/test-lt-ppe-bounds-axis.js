#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE CAP / FLOOR (MAX PRICE / MIN PRICE) AXIS OF THE E3 GATE.
 *
 * WHY THIS EXISTS. The owner's ⛔ HARD RULE for building a rate sheet names four things that must AGREE
 * with Lender Price before anything is built: every LLPA, every eligibility, every ineligibility, and
 * "you need to understand **max price and min price**". Three of those were gated and reported. The
 * fourth was computed per rung by `boundsProbe` and then DROPPED — `summarize()` never looked at
 * `result.bounds`, and the live runner passed `skipBounds: builtin`, so on every live run the cap/floor
 * axis was neither gated nor reported. Nothing was wrong with the probe; nobody could see its answer.
 *
 * AND THE FLAG THAT HID IT WAS ONE FLAG DOING TWO JOBS — the same shape as task #82:
 *   • `samePrice`     is FRAME-DEPENDENT. On the live Deephaven sheet LP's displayed price carries an
 *                     origination/margin ours does not (task #78), so it cannot be gated there.
 *   • `clampFaithful` is FRAME-FREE. It asks only whether OUR clamped price equals OUR stated limit.
 * `skipBounds` switched off both, so the frame-free check was lost for the frame-dependent one's reason.
 * `boundsGate` now names the checks that count, and everything else is REPORTED rather than silent.
 *
 * WHAT THE MEASUREMENT FOUND, and it is pinned below rather than described. Over the whole 299-scenario
 * battery, 7,168 rungs per grid:
 *   • the DEFAULT built-in grid states **no ceiling at all** (the max-price block lives in the
 *     --with-prepay grid) and prices up to **110.500**, against an investor sheet whose own ceiling is
 *     105 — so the default live run has never tested a max price, and now says so;
 *   • the composed --with-prepay grid clamps **4,180** rungs at the cap and 57 at the floor;
 *   • `clampFaithful` is false on **zero** rungs on either grid — which is what makes gating it on the
 *     live run safe, measured rather than hoped.
 *
 * OFFLINE + PURE: no DB, no network, no login. Runs in `npm test` via the `test-lt-ppe-*` glob.
 */
let pass = 0; const fails = [];
const ok = (c, m) => { if (c) { pass += 1; } else { fails.push(m); console.log(`  ✗ ${m}`); } };

const { boundsProbe } = require('../src/longterm/ppe/ratesheet-agreement-diff');
const agreement = require('../src/longterm/ppe/ratesheet-agreement');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { buildPrepayMaxPriceGrid } = require('../src/longterm/ppe/deephaven-dscr-prepay-maxprice');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');
const settings = require('../src/longterm/ppe/settings');
const legs = require('../src/longterm/ppe/lp-agreement-legs');

console.log('LT PPE — the cap/floor (max price / min price) axis\n');

// ── 1. THE PROBE: two independent checks, plus what was actually exercised ─────────────────────────
{
  // A rung that clamped AT the cap: faithful, and the cap is what bound it.
  const atCap = boundsProbe({ finalPriceMilli: 104750, capMilli: 104750, floorMilli: 98000, clamped: true }, 104750);
  ok(atCap.checks.clampFaithful === true && atCap.boundBy === 'cap', 'a price clamped to the cap is faithful, and reports the cap as what bound it');
  ok(atCap.capStated === true && atCap.floorStated === true && atCap.clamped === true, '…and reports both limits as stated and the limit as exercised');

  const atFloor = boundsProbe({ finalPriceMilli: 98000, capMilli: 104750, floorMilli: 98000, clamped: true }, 98000);
  ok(atFloor.boundBy === 'floor', 'a price clamped to the floor reports the floor');

  // Clamped but landing on NEITHER limit: our engine's own arithmetic is wrong. Frame-free.
  const bad = boundsProbe({ finalPriceMilli: 104000, capMilli: 104750, floorMilli: 98000, clamped: true }, 104000);
  ok(bad.checks.clampFaithful === false && bad.boundBy === null, 'clamped to neither limit is UNFAITHFUL — the check that catches a broken clamp');
  ok(bad.checks.samePrice === true, '…and it is caught even when the price matches Lender Price exactly (the two checks are independent)');

  // The mirror case: prices differ, but our clamp is faithful. Also independent.
  const framed = boundsProbe({ finalPriceMilli: 104750, capMilli: 104750, floorMilli: 98000, clamped: true }, 104500);
  ok(framed.checks.samePrice === false && framed.checks.clampFaithful === true,
    'a frame difference fails samePrice and leaves clampFaithful true — which is the live Deephaven state');

  // No limit stated: nothing to test, and nothing is claimed.
  const none = boundsProbe({ finalPriceMilli: 110500, capMilli: null, floorMilli: null, clamped: false }, 110500);
  ok(none.capStated === false && none.floorStated === false && none.clamped === false && none.boundBy === null,
    'no limit stated → nothing stated as tested (an unstated ceiling is never reported as an agreed one)');
  ok(none.checks.clampFaithful === true, '…and clampFaithful is vacuously true when nothing was clamped');
}

// ── 2. THE GATE: per-check, validated, and never silently gating nothing ──────────────────────────
// Our ladder rung: one coupon, clamped to a stated cap. Rates are the engine's milli units, matching
// the LP leg's noteRate × 1000 (the same convention the sibling agreement suite uses).
const ourRung = (finalPriceMilli, capMilli) => ({
  rate: 72500, basePriceMilli: 105000, finalPriceMilli, capMilli, floorMilli: 98000, clamped: true, adjustments: [],
});
const OURS_OK = async () => ({ eligible: true, ladder: [ourRung(104750, 104750)] });
// LP prices the same coupon 0.25 lower — the live frame gap (task #78) — so samePrice fails while
// clampFaithful holds. This is the shape client.parseFull produces.
const lpLeg = (price) => async () => ({
  full: {
    programs: [{
      lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage', program: 'DSCR 1.00-1.24', product: '30yr',
      options: [{ priceBuild: { noteRate: 72.5, price, baseRate: 72.5, basePoints: -5.0, adjustmentPoints: 0 }, adjustments: [], holdback: { investor: [{ value: 0.25 }] }, flags: {} }],
    }],
  },
  disqualified: {},
});
const LP_FRAMED = lpLeg(104.5);
// Every coarse axis that carries the frame gap is ignored here on purpose: this suite is about the
// BOUNDS axis, and leaving them in would fail every case for a reason the suite is not testing.
const OPTS = {
  filter: { investor: 'Deephaven Mortgage' }, settings: {},
  coarseIgnore: ['final_price', 'llpa_total', 'margin', 'base_price'],
};
const SC = { purpose: 'Purchase', value: 500000, loan: 350000, fico: 760, dscr: 1.25, state: 'NY', zip: '11211' };

(async () => {
  const gateBoth = await agreement.runOne(SC, OURS_OK, LP_FRAMED, OPTS);
  ok(gateBoth.agree === false, 'gating BOTH checks (the default) fails on the frame gap — samePrice counts');
  ok(Array.isArray(gateBoth.boundsGate) && gateBoth.boundsGate.length === 2, '…and the verdict records which checks gated it');

  const gateFrameFree = await agreement.runOne(SC, OURS_OK, LP_FRAMED, { ...OPTS, boundsGate: ['clampFaithful'] });
  ok(gateFrameFree.agree === true, 'gating the FRAME-FREE check only lets the same scenario agree — the live runner\'s setting');
  ok(gateFrameFree.bounds[0].checks.samePrice === false,
    '…while the ungated check is still REPORTED as failed, never silently passed');

  const legacySkip = await agreement.runOne(SC, OURS_OK, LP_FRAMED, { ...OPTS, skipBounds: true });
  ok(legacySkip.agree === true && legacySkip.boundsGate.length === 0,
    'the legacy skipBounds still means "gate no bounds check" — no existing caller\'s gate moved');

  // A BROKEN CLAMP must fail under the live runner's own setting — otherwise gating the frame-free
  // check would be decorative. This is the assertion that gives the change its value.
  const OURS_BROKEN = async () => ({ eligible: true, ladder: [ourRung(104000, 104750)] });
  const broken = await agreement.runOne(SC, OURS_BROKEN, LP_FRAMED, { ...OPTS, boundsGate: ['clampFaithful'] });
  ok(broken.agree === false, 'a clamp that lands on neither limit FAILS the gate under the live setting');
  const brokenSkipped = await agreement.runOne(SC, OURS_BROKEN, LP_FRAMED, { ...OPTS, skipBounds: true });
  ok(brokenSkipped.agree === true, '…and would have passed unnoticed under the old blunt skip — the defect this restores');

  // A typo in the gate spec is a caller bug and must SURFACE. Silently gating nothing is exactly the
  // failure this whole change removes, so an unknown check name throws rather than being ignored.
  let threw = false;
  try { await agreement.runOne(SC, OURS_OK, LP_FRAMED, { ...OPTS, boundsGate: ['clampfaithful'] }); } catch (e) { threw = /unknown boundsGate/.test(e.message); }
  ok(threw, 'a mis-spelled check name throws — a gate that silently gates nothing is the bug, not a convenience');

  // ── 3. THE ROLL-UP: summarize() reports the axis instead of discarding it ────────────────────────
  // Read through a defaulted local so a MISSING roll-up fails these as assertions rather than throwing
  // — a crashing test "fails" too, and looks like proof (CLAUDE.md build rule #2).
  const sum = agreement.summarize([gateFrameFree]);
  const b = (sum && sum.bounds) || {};
  ok(b.rungsProbed === 1, 'summarize() reports the rungs the bounds probe actually saw');
  ok(b.capStated === 1 && b.floorStated === 1 && b.clamped === 1 && b.boundByCap === 1,
    '…what was stated, and what actually BOUND (an unexercised limit is not a verified one)');
  ok(b.failures && b.failures.samePrice === 1, '…and every check failure, gated or not');
  ok(Array.isArray(b.gated) && b.gated.join() === 'clampFaithful' && (b.ungated || []).join() === 'samePrice',
    '…plus which checks counted and which were only reported — so a skipped check is STATED, never silent');

  const emptyB = (agreement.summarize([]) || {}).bounds || null;
  ok(emptyB && emptyB.rungsProbed === 0 && emptyB.gated === null,
    'an empty run reports an empty axis rather than an absent one');

  // ── 4. THE MEASURED STATE OF THE TWO BUILT-IN GRIDS ──────────────────────────────────────────────
  // Measured, not described: what the live gate is actually pricing against. Pinning it is what turns
  // "the default run tested no ceiling" from a comment into something that fails when it stops being
  // true — including the day the max-price block is folded into the default grid, which SHOULD fail
  // here and be re-measured rather than quietly change what the gate covers.
  const s = settings.resolveAll().values;
  const scenarios = buildAgreementScenarios().scenarios;
  const measure = async (grid) => {
    const prog = rateSheetToProgram(gridToRateSheet(grid), { code: 'DHVN_DSCR30', name: 'Deephaven DSCR 30yr', investorCode: 'DHVN' });
    const ours = legs.buildOursLeg(prog, s, { factsFromLp: true });
    const out = { rungs: 0, capStated: 0, floorStated: 0, byCap: 0, byFloor: 0, unfaithful: 0, best: -Infinity };
    for (const sc of scenarios) {
      let q; try { q = await ours(sc); } catch (e) { continue; }
      if (!q || !q.eligible) continue;
      for (const r of q.ladder || []) {
        const bp = boundsProbe({ finalPriceMilli: r.finalPriceMilli, floorMilli: r.floorMilli, capMilli: r.capMilli, clamped: r.clamped }, r.finalPriceMilli);
        out.rungs += 1;
        if (bp.capStated) out.capStated += 1;
        if (bp.floorStated) out.floorStated += 1;
        if (bp.boundBy === 'cap') out.byCap += 1;
        if (bp.boundBy === 'floor') out.byFloor += 1;
        if (bp.checks.clampFaithful === false) out.unfaithful += 1;
        if (r.finalPriceMilli > out.best) out.best = r.finalPriceMilli;
      }
    }
    return out;
  };

  const base = await measure(buildDeephavenGrid());
  const composed = await measure(buildPrepayMaxPriceGrid());

  ok(base.rungs > 5000 && composed.rungs === base.rungs, 'both grids price the same rung population (a like-for-like measurement)');
  ok(base.capStated === 0,
    'THE DEFAULT built-in grid states NO ceiling on any rung — so the default live run has never tested a max price');
  ok(base.best > 105000,
    `…and it prices above the investor sheet's own 105 ceiling (best ${base.best} milli) — measured, and now reported by the gate`);
  ok(base.floorStated === base.rungs && base.byFloor > 0,
    'the FLOOR is stated on every rung and actually binds on the default grid — so the frame-free check was never idle');
  ok(composed.capStated === composed.rungs && composed.byCap > 1000,
    'the composed --with-prepay grid states a ceiling on every rung and clamps thousands of them — the caps genuinely bind');
  ok(composed.best <= 104750,
    `…and nothing prices above the 104.750 cap in Lender Price's frame (best ${composed.best} milli)`);
  ok(base.unfaithful === 0 && composed.unfaithful === 0,
    'clampFaithful is false on ZERO rungs on either grid — which is what makes gating it on the live run safe, measured not assumed');

  console.log(`\n${fails.length ? `FAILURES: ${fails.length}` : 'OFFLINE: all passed'} (${pass} passed, ${fails.length} failed)`);
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error(`bounds-axis suite failed: ${e && e.stack || e}`); process.exit(1); });
