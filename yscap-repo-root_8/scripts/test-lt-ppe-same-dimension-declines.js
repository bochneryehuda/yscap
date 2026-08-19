#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT A SECOND REFUSAL ON THE SAME AXIS IS NOT DELETED IN SILENCE (§2.108).
 *
 * ⛔ THE DEFECT. `reconcileLayer` built its per-dimension index with
 * `if (!byDim.has(r.dimension)) byDim.set(r.dimension, r)` on BOTH sides — keeping the FIRST row per
 * dimension and dropping every other one before anything compared, counted or reported it. An engine
 * that refuses on one axis for two reasons had one of them vanish, and NOTHING anywhere said so: not
 * the layer report, not `summary`, not the run's own JSON. Which of the two survived was decided by
 * arrival order.
 *
 * IT IS NOT HYPOTHETICAL. Measured over the canonical 305-scenario battery (2026-08-19) by running the
 * real `buildOursLeg` and stamping each decline's dimension from its own rule: our Deephaven program
 * declines TWICE on `fico` for the `fico 600` scenario — `"Min FICO 640"` AND
 * `"DSCR < 1.00: Min FICO 680"` — and that scenario is one of the eight in the live probe set, so a
 * rule was being dropped on real runs. This suite pins that case from the REAL program rather than a
 * hand-written fixture, so it cannot rot into a story about a sheet nobody prices.
 *
 * ⛔ THE SURPLUS IS REPORTED, NOT SCORED, and both halves are deliberate. Reported, because a rule
 * deleted in silence is the exact failure this comparison exists to prevent. NOT scored as a
 * disagreement, because it is not one: if we state two `fico` refusals and Lender Price states one,
 * both engines refuse on `fico`, and Lender Price routinely states ONE COMPOUND rule where our sheet
 * states two narrow ones (§2.106's whole subject). Counting the surplus against us would manufacture
 * disagreements on files where nothing is wrong — the expensive direction — so `layerVerdict` never
 * reads it. A dimension only ONE side names is different and DOES yield a row per rule: that is not a
 * scoring change of the same kind, it is the honest count of how many refusals went unmatched.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const { reconcileDisqualifiers, _internals } = require('../src/longterm/ppe/disqualifier-reconciler');
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { dimensionOfRule } = require('../src/longterm/ppe/agreement-dimensions');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const { buildAgreementScenarios } = require('../src/longterm/ppe/agreement-scenarios');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const lpDeclines = (...rules) => ({ ready: true, declined: [{ reasons: rules.map((r) => (typeof r === 'string' ? { rule: r, adjType: null } : r)) }] });
const extraOf = (rep) => (rep && rep.sameDimensionExtra) || [];

(async () => {
  // -------------------------------------------------------------------------
  // A. THE MEASURED CASE, FROM THE REAL PROGRAM — not a fixture.
  // -------------------------------------------------------------------------
  const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()));
  const byCode = new Map();
  for (const r of (program.rules || [])) if (r && r.code != null) byCode.set(r.code, r);
  const ourLeg = legs.buildOursLeg(program, {});
  const scenarios = buildAgreementScenarios().scenarios;
  const fico600 = scenarios.find((s) => s._label === 'fico 600');
  ok(!!fico600, 'A1 the measured scenario is still in the canonical battery');

  const quote = fico600 ? await ourLeg(fico600) : null;
  const declines = (quote && quote.declines) || [];
  const dims = declines.map((d) => {
    const rule = d.code != null ? byCode.get(d.code) : null;
    return { dimension: d.dimension || (rule ? dimensionOfRule(rule) : null), reason: d.reason };
  }).filter((d) => d.dimension != null);
  const ficoRows = dims.filter((d) => d.dimension === 'fico');
  ok(ficoRows.length >= 2,
    `A2 our own program really does refuse TWICE on one axis here — got ${JSON.stringify(dims)}`);
  ok(ficoRows.some((d) => /Min FICO 640/.test(d.reason)) && ficoRows.some((d) => /Min FICO 680/.test(d.reason)),
    `A3 …and they are the two measured rules — got ${JSON.stringify(ficoRows.map((d) => d.reason))}`);

  // Put that real pair against a single Lender Price fico refusal, the shape the live run produces.
  const real = reconcileDisqualifiers(
    { layer2: ficoRows.map((d) => ({ dimension: d.dimension, reason: d.reason })) },
    lpDeclines({ rule: 'DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640', adjType: 'FicoRateAdjustment' }), {});
  ok(real.summary.sameDimensionExtra === ficoRows.length - 1,
    `A4 every surplus rule is COUNTED — got ${real.summary.sameDimensionExtra}`);
  const allExtraReasons = (real.sameDimensionExtra || []).flatMap((e) => e.reasons);
  ok(ficoRows.slice(1).every((d) => allExtraReasons.includes(d.reason)),
    `A5 …and reported verbatim, never deleted — got ${JSON.stringify(allExtraReasons)}`);
  ok(real.verdict === 'agree',
    `A6 …while the verdict is UNCHANGED — both engines refuse on fico — got ${real.verdict}`);
  ok(real.summary.disagree === 0, `A7 …and no disagreement was manufactured — got ${real.summary.disagree}`);

  // -------------------------------------------------------------------------
  // B. THE PAIRING ARITHMETIC.
  // -------------------------------------------------------------------------
  const two1 = _internals.reconcileLayer(
    [{ dimension: 'ltv', reason: 'ours A' }, { dimension: 'ltv', reason: 'ours B' }],
    [{ dimension: 'ltv', reason: 'lp A' }]);
  ok(two1.agreements.length === 1, `B1 two-vs-one pairs ONE agreement — got ${two1.agreements.length}`);
  ok(extraOf(two1).length === 1 && extraOf(two1)[0].side === 'ours' && extraOf(two1)[0].extra === 1,
    `B2 …and the surplus is attributed to OUR side — got ${JSON.stringify(extraOf(two1))}`);
  ok(two1.onlyOurs.length === 0 && two1.onlyAuthority.length === 0,
    'B3 …and the surplus is NOT filed as a one-sided decline');

  const one2 = _internals.reconcileLayer(
    [{ dimension: 'ltv', reason: 'ours A' }],
    [{ dimension: 'ltv', reason: 'lp A' }, { dimension: 'ltv', reason: 'lp B' }]);
  ok(extraOf(one2).length === 1 && extraOf(one2)[0].side === 'authority',
    `B4 the surplus is attributed to the AUTHORITY when theirs is longer — got ${JSON.stringify(extraOf(one2))}`);

  const two2 = _internals.reconcileLayer(
    [{ dimension: 'ltv', reason: 'ours A' }, { dimension: 'ltv', reason: 'ours B' }],
    [{ dimension: 'ltv', reason: 'lp A' }, { dimension: 'ltv', reason: 'lp B' }]);
  ok(two2.agreements.length === 2 && extraOf(two2).length === 0,
    `B5 equal counts pair fully with no surplus — got ${two2.agreements.length}/${extraOf(two2).length}`);

  const one1 = _internals.reconcileLayer(
    [{ dimension: 'ltv', reason: 'ours A' }], [{ dimension: 'ltv', reason: 'lp A' }]);
  ok(one1.agreements.length === 1 && extraOf(one1).length === 0,
    'B6 the ordinary one-to-one case is untouched');

  // A dimension only one side names now yields a row PER RULE, not one per dimension.
  const oursOnly = _internals.reconcileLayer(
    [{ dimension: 'dscr', reason: 'ours A' }, { dimension: 'dscr', reason: 'ours B' }], []);
  ok(oursOnly.onlyOurs.length === 2,
    `B7 two unmatched refusals of ours count as TWO, not one — got ${oursOnly.onlyOurs.length}`);
  const lpOnly = _internals.reconcileLayer([],
    [{ dimension: 'dscr', reason: 'lp A' }, { dimension: 'dscr', reason: 'lp B' }]);
  ok(lpOnly.onlyAuthority.length === 2,
    `B8 …and the same on the authority side — got ${lpOnly.onlyAuthority.length}`);
  ok(extraOf(oursOnly).length === 0 && extraOf(lpOnly).length === 0,
    'B9 …neither is reported as a same-dimension surplus (nothing was paired away)');

  // -------------------------------------------------------------------------
  // C. VERDICT NEUTRALITY — the load-bearing half.
  // -------------------------------------------------------------------------
  ok(_internals.layerVerdict({ onlyOurs: [], onlyAuthority: [], related: [], unknown: [], sameDimensionExtra: [{ extra: 3 }] }) === 'agree',
    'C1 a surplus alone never makes a layer disagree or go indeterminate');
  const surplusOnly = reconcileDisqualifiers(
    { layer2: [{ dimension: 'fico', reason: 'a' }, { dimension: 'fico', reason: 'b' }, { dimension: 'fico', reason: 'c' }] },
    lpDeclines({ rule: 'DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640', adjType: 'FicoRateAdjustment' }), {});
  ok(surplusOnly.verdict === 'agree', `C2 …end to end as well — got ${surplusOnly.verdict}`);
  ok(surplusOnly.summary.sameDimensionExtra === 2,
    `C3 …with every surplus rule counted — got ${surplusOnly.summary.sameDimensionExtra}`);
  ok(surplusOnly.summary.agree === 1,
    `C4 …and exactly one agreement, not three — got ${surplusOnly.summary.agree}`);

  // A real disagreement on ANOTHER axis is still a disagreement while a surplus rides along.
  const mixed = reconcileDisqualifiers(
    { layer2: [{ dimension: 'fico', reason: 'a' }, { dimension: 'fico', reason: 'b' }, { dimension: 'ltv', reason: 'ours ltv' }] },
    lpDeclines({ rule: 'DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640', adjType: 'FicoRateAdjustment' }), {});
  ok(mixed.verdict === 'disagree',
    `C5 a genuine one-sided refusal still disagrees alongside a surplus — got ${mixed.verdict}`);
  ok(mixed.summary.sameDimensionExtra === 1, 'C6 …and the surplus is still counted separately');

  // -------------------------------------------------------------------------
  // D. IT IS CARRIED TO THE TOP LEVEL, LAYER-TAGGED.
  // -------------------------------------------------------------------------
  const layered = reconcileDisqualifiers(
    { layer2: [{ dimension: 'fico', reason: 'a' }, { dimension: 'fico', reason: 'b' }],
      layer3: [{ dimension: 'prepay', reason: 'p1' }, { dimension: 'prepay', reason: 'p2' }] },
    { ready: true,
      layer2: [{ dimension: 'fico', reason: 'lp fico' }],
      layer3: [{ dimension: 'prepay', reason: 'lp prepay' }] }, {});
  const layersSeen = new Set((layered.sameDimensionExtra || []).map((e) => e.layer));
  ok(layersSeen.has('layer2') && layersSeen.has('layer3'),
    `D1 a surplus on either layer reaches the top level, tagged — got ${JSON.stringify([...layersSeen])}`);
  ok(layered.summary.sameDimensionExtra === 2, `D2 …and both are counted — got ${layered.summary.sameDimensionExtra}`);
  ok(layered.verdict === 'agree', `D3 …still verdict-neutral across layers — got ${layered.verdict}`);

  // -------------------------------------------------------------------------
  // E. A CLEAN FILE IS SILENT.
  // -------------------------------------------------------------------------
  const clean = reconcileDisqualifiers(
    { layer2: [{ dimension: 'fico', reason: 'a' }] },
    lpDeclines({ rule: 'DSCR >=1.00, Loan Amount <=$1.5MM: Min FICO 640', adjType: 'FicoRateAdjustment' }), {});
  ok(clean.summary.sameDimensionExtra === 0 && (clean.sameDimensionExtra || []).length === 0,
    'E1 a file with nothing surplus reports nothing');
  ok(clean.verdict === 'agree', 'E2 …and is byte-for-byte the ordinary agreement it always was');

  console.log(`${fails.length ? 'FAIL' : 'PASS'} — same-dimension declines guard: ${pass} passed, ${fails.length} failed`);
  for (const f of fails) console.log('  ✗', f);
  process.exit(fails.length ? 1 : 0);
})();
