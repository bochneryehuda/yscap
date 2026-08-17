#!/usr/bin/env node
'use strict';
/**
 * LT PPE rich Lender Price normalizer (Part 3 P1) — pure offline test.
 * Proves the FULL capture (margin, itemized LLPAs, base rate, disqualification reasons) survives from
 * the REAL LP parser (client.parseFull / client.parseDisqualified) into our canonical integer units —
 * the feed the six difference detectors (P3) need. Round-trips a real raw searchRaw-shaped tree through
 * the actual parser, not a hand-built parseFull object.
 *
 *   node scripts/test-lt-ppe-lp-normalize-full.js
 */
const lp = require('../src/longterm/lenderprice/client');
const { normalizeLpFull, normalizeLpDisqualified, _internals } = require('../src/longterm/ppe/lp-normalize-full');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

console.log('LT PPE rich LP normalizer — offline\n');

// A real QUALIFIED searchRaw-shaped tree: one Deephaven DSCR option with a full price build, one
// itemized LLPA, and the 0.25 margin line.
const rawQual = {
  results: {
    lenderDtos: { lenderDtoNonQm: [{ id: 'L1', name: 'Deephaven Mortgage', shortName: 'DHVN' }] },
    qualifiedNonQMData: {
      key: [], keyLabel: 'ROOT', type: null, childs: [{
        type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed', childs: [{
          type: 'RateKey', keyLabel: '7.125', childs: [{
            type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"', childs: [],
            leafs: [{
              companyName: 'Deephaven Mortgage', programName: 'DSCR 30 Yr Fixed', productName: 'DSCR 30 Yr Fixed',
              rate: 7.125, baseRates: 7.125, basePoints: -3.75, adjustmentPoints: 0.9, adjustedPoints: -2.85,
              fico: 740, ltv: 70, cltv: 70, dscr: 1.2, isInterestOnly: false, loanPurpose: 'Purchase',
              groupAdjustmentProperties: [{
                name: 'LTV/FICO', adjustments: [
                  { key: 'CLTV 70-75 / FICO 720-739', adjType: 'FicoLtvRateAdjustment', type: 'LLPA', valueType: 'Points', adj: 0.9 },
                ],
              }],
              holdBackResult: { lender: { adjustments: [{ key: 'NDC Margin - 0.25%', type: 'Margin', valueType: 'Points', adj: 0.25 }] } },
            }],
          }],
        }],
      }],
    },
  },
};

const full = lp.parseFull(rawQual);
ok(full.programCount === 1 && full.optionCount === 1, 'the real parser found the one option');

const nz = normalizeLpFull(full, { program: 'DSCR 30 Yr Fixed', priceScale: 1000, rateScale: 1000 });
ok(nz.eligible && nz.programsMatched === 1 && nz.programs[0].rungs.length === 1, 'normalized to one matched program with one rung');
const rung = nz.programs[0].rungs[0];

// 1) The price build survives in canonical milli units.
ok(rung.rate === 7125, 'note rate → 7125 milli-percent');
ok(rung.priceMilli === 102850, 'price → 102850 (100 − (−2.85 points))');
ok(rung.baseRateMilli === 7125, 'base rate → 7125 milli-percent');
ok(rung.basePointsMilli === -3750, 'base points → −3750');
ok(rung.adjustmentPointsMilli === 900, 'LLPA stack total → 900 (0.9 points)');

// 2) MARGIN survives (was invisible to the shallow normalizer).
ok(rung.marginMilli === 250, 'margin → 250 milli (0.25 point, from the lender holdback tier)');
ok(rung.marginByTier.lender === 250, 'the per-tier margin breakdown is carried');

// 3) The ITEMIZED LLPAs survive verbatim, with adjType, in milli.
ok(rung.llpas.length === 1 && rung.llpas[0].reason === 'CLTV 70-75 / FICO 720-739', 'the itemized LLPA reason is verbatim');
ok(rung.llpas[0].adjType === 'FicoLtvRateAdjustment' && rung.llpas[0].valueMilli === 900, 'the LLPA carries adjType + value in milli');

// 4) bestLadder (the simple price axis) is present.
ok(nz.bestLadder.length === 1 && nz.bestLadder[0].rate === 7125 && nz.bestLadder[0].priceMilli === 102850, 'bestLadder carries the merged best price per coupon');

// 5) A program filter that matches nothing → not eligible, no rungs.
const noMatch = normalizeLpFull(full, { program: 'Some Other Program' });
ok(!noMatch.eligible && noMatch.programsMatched === 0, 'a non-matching program filter yields nothing (never a fabricated rung)');

// 6) The DISQUALIFIED side: reasons survive with adjType, filtered per investor/program.
const rawDisq = {
  results: {
    lenderDtos: { lenderDtoDisq: [{ id: 'L1', name: 'Deephaven Mortgage', shortName: 'DHVN' }] },
    disqualifiedData: {
      key: [], keyLabel: 'ROOT', type: null, childs: [{
        type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed', childs: [{
          type: 'RateKey', keyLabel: '6.5', childs: [{
            type: 'LenderKey', keyLabel: 'Deephaven', plenderId: '"L1"', childs: [],
            leafs: [{
              companyName: 'Deephaven Mortgage', programName: 'DSCR 30 Yr Fixed', rate: 6.5, disqualified: true,
              groupAdjustmentProperties: [{ disqualifyAdjustments: [
                { key: 'FICO - below 660', adjType: 'FicoRateAdjustment', type: 'LLPA', valueType: 'Points' },
              ] }],
            }],
          }],
        }],
      }],
    },
  },
};
const disq = lp.parseDisqualified(rawDisq);
const nzd = normalizeLpDisqualified(disq, { investor: 'Deephaven Mortgage' });
ok(nzd.ready && nzd.declined.length === 1, 'the declined program survives, filtered by investor');
ok(nzd.declined[0].program === 'DSCR 30 Yr Fixed' && nzd.declined[0].reasons[0].rule === 'FICO - below 660', 'the decline reason is verbatim');
ok(nzd.declined[0].reasons[0].adjType === 'FicoRateAdjustment', 'the decline reason carries adjType (for the crosswalk)');

// 7) marginOf / llpasOf edge behavior.
ok(_internals.marginOf({ holdback: null }, 1000).totalMilli === null, 'no holdback → null margin (never 0)');
ok(_internals.llpasOf(null, 1000).length === 0, 'no adjustments → empty itemized list');

// 8) The broker tier is excluded from the margin total (correspondent flow), but still reported.
{
  const m = _internals.marginOf({ holdback: { broker: [{ value: 1.0 }], lender: [{ value: 0.25 }] } }, 1000);
  ok(m.totalMilli === 250 && m.byTier.broker === 1000 && m.byTier.lender === 250, 'broker tier reported but not summed into the correspondent margin total');
}

console.log(`\n${failures ? failures + ' FAILED' : 'all passed'}`);
process.exit(failures ? 1 : 0);
