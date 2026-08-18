'use strict';
/**
 * Pure offline test for the POINT-FOR-POINT PARITY MATRIX (src/longterm/ppe/parity-matrix.js) and for
 * the defect that had to be fixed before it could exist — master plan P9.
 *   node scripts/test-lt-ppe-parity-matrix.js
 *
 *   A. THE FACTS SURVIVE THE RUN. `shadow.runOne` reduced the scenario to a display STRING and threw
 *      the object away, one function before anybody could use it. The findings ledger has a
 *      `scenario_facts` column (db/561) the canary path could never fill, and a dashboard sliced "by
 *      state / DSCR band / FICO / LTV" had nothing to slice by.
 *   B. THE BANDS ARE THE SHEET'S OWN EDGES — derived from the program's rules, never invented.
 *   C. …and they are HALF-OPEN, so a scenario sitting exactly on an edge lands in exactly one cell.
 *   D. the per-cell measures, including the two price-gap questions that must not be conflated.
 *   E. NOTHING IS SILENTLY BUCKETED: every skip has a reason and every dimension reconciles.
 *   F. the REAL Deephaven sheet — the bands are its own seven axes.
 *   G. ranking, caps, and the degenerate inputs.
 */

const assert = require('assert');
const shadow = require('../src/longterm/ppe/shadow');
const canary = require('../src/longterm/ppe/canary');
const finding = require('../src/longterm/ppe/finding');
const M = require('../src/longterm/ppe/parity-matrix');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };
const deep = (a, b, m) => { assert.deepStrictEqual(a, b, m); n += 1; };

// A program whose rules define the axes — this is the ONLY source of numeric bands.
const PROGRAM = {
  code: 'test',
  rules: [
    { code: 'f1', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'between', value: [700, 760] }] } },
    { code: 'f2', kind: 'pricing', when: { all: [{ fact: 'fico', op: 'between', value: [760, 800] }] } },
    { code: 'l1', kind: 'eligibility', when: { all: [{ fact: 'ltv', op: 'lte', value: 75000 }] } },
    // Unreadable as a region (a complement) — it must contribute NO edges rather than a guessed one.
    { code: 'x1', kind: 'eligibility', when: { all: [{ fact: 'occupancy', op: 'neq', value: 'vacant' }] } },
  ],
};

const res = (over = {}) => ({ agree: true, incomparable: false, overlay: false, findings: [], ...over });
const priceGap = (...deltas) => deltas.map((d) => ({ kind: 'price_mismatch', deltaMilli: d }));

async function main() {
  // =========================================================================
  // A. THE DEFECT: the scenario's facts must survive the run
  // =========================================================================
  {
    const sc = { _label: 'fico=720 state=NY', fico: 720, ltv: 70000, state: 'NY' };
    const r = await shadow.runOne(
      sc,
      async () => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 102000 }] }),
      async () => ({ eligible: true, rungs: [{ rate: 7000, priceMilli: 101000 }] }),
      { priceToleranceMilli: 0 },
    );
    eq(r.scenario, 'fico=720 state=NY', 'A1 the LABEL is unchanged — the finding key is built from it');
    deep(r.facts, { fico: 720, ltv: 70000, state: 'NY' }, 'A2 …and the FACTS now ride alongside it');
    ok(!Object.prototype.hasOwnProperty.call(r.facts, '_label'), 'A3 the label is not duplicated into the facts');
  }
  {
    // An engine failure is still a scenario that happened somewhere — an error concentrated in one
    // state is exactly the thing a sliced report exists to show, so the error paths carry facts too.
    const r = await shadow.runOne(
      { _label: 'x', state: 'NY' },
      async () => { throw new Error('boom'); },
      async () => ({ eligible: true, rungs: [] }),
      {},
    );
    eq(r.error, 'ours', 'A4 the engine error is recorded');
    deep(r.facts, { state: 'NY' }, 'A5 …and the errored scenario is still placeable');
  }
  {
    // A caller whose "scenario" is a bare label gets null, not a facts bag made of characters.
    const r = await shadow.runOne('just-a-label', async () => ({ eligible: true, ladder: [] }), async () => ({ eligible: true, rungs: [] }), {});
    eq(r.facts, null, 'A6 a string scenario yields NO facts, never a fabricated one');
    eq(shadow._internals.factsOf({ _label: 'only' }), null, 'A7 a scenario that is only a label has no facts');
    eq(shadow._internals.factsOf([1, 2]), null, 'A8 an array is not a facts bag');
  }
  {
    // …and the LEDGER finally records them. `recordsFromComparison` writes `scenarioFacts` only when
    // handed an object, and the canary used to hand it the label.
    const out = await canary.runCanary(
      [{ _label: 'fico=650', fico: 650, state: 'FL' }],
      {
        ours: async () => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: 102000 }] }),
        theirs: async () => ({ eligible: true, rungs: [{ rate: 7000, priceMilli: 100000 }] }),
      },
      { investor: 'DHVN', program: 'P', nowMs: 1700000000000, priceToleranceMilli: 0 },
    );
    const rec = (out.records || [])[0] || {};
    deep(rec.scenarioFacts, { fico: 650, state: 'FL' }, 'A9 the canary fills the ledger\'s scenario_facts');
    eq(rec.scenario, 'fico=650', 'A10 …while the scenario LABEL is still the label');
    ok(String(rec.key).includes('fico=650'), 'A11 …so the finding key is unchanged');
  }

  // =========================================================================
  // B. THE BANDS ARE THE SHEET'S OWN EDGES
  // =========================================================================
  {
    const b = M.bandsFromProgram(PROGRAM);
    deep(b.get('fico'), [700, 760, 800], 'B1 the FICO edges are the rules\' own');
    deep(b.get('ltv'), [75000], 'B2 …and a one-sided bound contributes its finite end only');
    eq(b.has('occupancy'), false, 'B3 a rule that is not a readable region contributes NO edges');
    eq(M.bandsFromProgram(null).size, 0, 'B4 no program → no bands (never a default set of "usual" cuts)');
    eq(M.bandsFromProgram({ rules: 'nonsense' }).size, 0, 'B5 junk → no bands, no throw');
  }

  // =========================================================================
  // C. HALF-OPEN, AND A VALUE ON AN EDGE LANDS IN EXACTLY ONE CELL
  // =========================================================================
  {
    const bands = M._internals.bandsOf([700, 760]);
    eq(bands.length, 3, 'C1 two edges make three bands, including both open ends');
    eq(M._internals.bandLabel(bands[0]), '< 700', 'C2 the open low end reads as an inequality');
    eq(M._internals.bandLabel(bands[2]), '>= 760', 'C3 …as does the open high end');
    // THE EDGE CASE THAT MATTERS: `rules.js` `between` is [min, max), so 700 belongs to [700,760) and
    // to nothing else. Closing both ends would double-count it and the reconciliation would quietly
    // stop adding up.
    const hits = [700, 759.999, 760].map((v) => M._internals.bandIndex(bands, v));
    deep(hits, [1, 1, 2], 'C4 a value ON an edge lands in the band that STARTS there, and only that one');
    eq(M._internals.bandIndex(bands, 'seven hundred'), null, 'C5 a non-number is placed nowhere');
    eq(M._internals.bandIndex(bands, NaN), null, 'C6 …and neither is NaN');
    eq(M._internals.bandsOf([]).length, 0, 'C7 no edges make no bands');
  }

  // =========================================================================
  // D. THE PER-CELL MEASURES
  // =========================================================================
  {
    const results = [
      res({ facts: { fico: 720, state: 'NY' } }),
      res({ agree: false, facts: { fico: 720, state: 'NY' }, findings: priceGap(-250, -500) }),
      res({ agree: false, facts: { fico: 720, state: 'NY' }, findings: priceGap(1000) }),
      res({ facts: { fico: 780, state: 'FL' } }),
    ];
    const d = M.sliceBy(results, 'fico', [700, 760, 800]);
    const cell = d.cells.find((c) => c.label === '700–760') || {};
    eq(cell.total, 3, 'D1 the cell counts its scenarios');
    eq(cell.agreed, 1, 'D2 …how many agreed');
    eq(cell.disagreed, 2, 'D3 …and how many did not');
    eq(Number(cell.agreementRate.toFixed(4)), 0.3333, 'D4 …with the rate that follows from them');

    // TWO DIFFERENT QUESTIONS, and conflating them is how one scenario disagreeing on eight coupons
    // reads as eight bad loans.
    eq(cell.priceDelta.scenarios, 2, 'D5 `scenarios` counts LOANS with a price gap');
    eq(cell.priceDelta.samples, 3, 'D6 `samples` counts the individual COUPONS');

    // The MEAN is signed and the WORST is absolute, and they answer different questions: a sheet
    // uniformly light is not the same problem as one scattered either side of Lender Price.
    eq(cell.priceDelta.minMilli, -500, 'D7 the most negative gap');
    eq(cell.priceDelta.maxMilli, 1000, 'D8 …the most positive');
    eq(cell.priceDelta.worstAbsMilli, 1000, 'D9 …how bad it gets, regardless of direction');
    eq(Number(cell.priceDelta.meanMilli.toFixed(4)), 83.3333, 'D10 …and the SIGNED mean, which -250/-500/+1000 nearly cancels');
    ok(!('_sum' in cell.priceDelta), 'D11 the running total is not left on the report');

    const clean = d.cells.find((c) => c.label === '760–800') || {};
    eq(clean.priceDelta.samples, 0, 'D12 a clean cell reports ZERO, never undefined');
    eq(clean.priceDelta.worstAbsMilli, null, 'D13 …and null for a gap that does not exist');
    eq(clean.agreementRate, 1, 'D14 …with a full agreement rate');
  }
  {
    // Errors, overlays and incomparables are counted in their own right — an OVERLAY decline is an
    // intentional, reasoned disagreement (D29), not a defect, and a cell that hides it inside
    // `disagreed` makes a correct sheet look broken.
    const results = [
      res({ agree: false, overlay: true, facts: { state: 'NY' } }),
      res({ agree: false, incomparable: true, facts: { state: 'NY' } }),
      res({ agree: false, error: 'theirs', facts: { state: 'NY' } }),
    ];
    const c = M.sliceBy(results, 'state', null).cells[0] || {};
    eq(c.overlay, 1, 'D15 overlays are counted');
    eq(c.incomparable, 1, 'D16 incomparables are counted');
    eq(c.errors, 1, 'D17 engine errors are counted');
    eq(c.total, 3, 'D18 …and all three are still in the total');
  }

  // =========================================================================
  // E. NOTHING IS SILENTLY BUCKETED
  // =========================================================================
  {
    const results = [
      res({ facts: { fico: 720 } }),
      res({ facts: null }),                        // no facts at all
      res({ facts: { state: 'NY' } }),             // does not state fico
      res({ facts: { fico: null } }),              // states it, blank
      res({ facts: { fico: 'seven twenty' } }),    // not a number
      null,                                        // no result for that scenario
    ];
    const d = M.sliceBy(results, 'fico', [700, 760]);
    eq(d.cells.reduce((s, c) => s + c.total, 0), 1, 'E1 exactly one scenario could be placed');
    eq(d.unsliceableTotal, 5, 'E2 the other five are counted, never dropped');
    eq(d.cells.reduce((s, c) => s + c.total, 0) + d.unsliceableTotal, results.length, 'E3 the dimension RECONCILES');
    eq(d.unsliceable.length, 5, 'E4 each has its OWN reason — not one lumped "other"');
    ok(d.unsliceable.every((u) => typeof u.why === 'string' && u.why.length > 12), 'E5 …and each reason is a sentence a human can act on');
    ok(d.unsliceable.some((u) => /not a number/.test(u.why)), 'E6 a non-numeric value on a numeric axis is named as such');
    ok(!d.cells.some((c) => /n\/a|unknown|other/i.test(c.label)), 'E7 there is NO catch-all cell masquerading as a band of the sheet');
  }
  {
    const results = [
      res({ facts: { fico: 720, state: 'NY' } }),
      res({ agree: false, facts: { fico: 650, state: 'FL' }, findings: priceGap(200) }),
      res({ facts: null }),
    ];
    const m = M.buildParityMatrix(results, { program: PROGRAM });
    eq(m.reconciles, true, 'E8 the whole matrix reports that every dimension adds up');
    // AND THE CHECK ITSELF IS PROVEN, against a hand-built lossy dimension. On the production path
    // this is a THEOREM — every result enters exactly one cell or is counted as unsliceable, so
    // `buildParityMatrix` cannot produce a dimension that fails it, and a mutation hard-coding it to
    // `true` changes nothing any caller can observe. That is the same shape as the
    // containment-vs-overlap mutation recorded in parity status §2.20: a green mutation revealing a
    // theorem, not a coverage hole. Testing the extracted check directly is what makes it real.
    eq(M.reconcilesAll([{ cells: [{ total: 2 }], unsliceableTotal: 1 }], 3), true, 'E8a a dimension that adds up passes');
    eq(M.reconcilesAll([{ cells: [{ total: 2 }], unsliceableTotal: 0 }], 3), false, 'E8b ONE LOST SCENARIO fails it — the check is not decoration');
    eq(M.reconcilesAll([{ cells: [{ total: 2 }], unsliceableTotal: 2 }], 3), false, 'E8c …and so does one counted twice');
    eq(M.reconcilesAll([], 0), true, 'E8d no dimensions is vacuously fine');
    eq(m.total, 3, 'E9 the run total is the run total');
    // The AGGREGATE counts all three, including the one no dimension can place: it agreed, and
    // whether we can slice it is a fact about our facts bag, not about the two engines. That is
    // precisely why the unsliceable count is reported separately — the headline rate must not quietly
    // become "the rate over the scenarios we happened to be able to categorise".
    eq(m.agreed, 2, 'E10 the aggregate counts every scenario, sliceable or not');
    eq(m.dimensions[0].cells.reduce((s, c) => s + c.agreed, 0), 1, 'E10a …while the CELLS only count the ones they could place');
    eq(m.factsMissing, 1, 'E11 a scenario with no facts is reported as such, not hidden');
    deep(m.factsSeen, ['fico', 'state'], 'E12 the dimensions come from what the run ACTUALLY states');
    ok(m.dimensions.some((d) => d.dimension === 'fico' && d.kind === 'band'), 'E13 a fact the sheet bands is sliced as bands');
    ok(m.dimensions.some((d) => d.dimension === 'state' && d.kind === 'category'), 'E14 …and one it does not, by its own values');
  }
  {
    // A numeric fact the PROGRAM says nothing about is NOT bucketed by guesswork — it falls to the
    // category slice over its own distinct values, which is honest, and a caller who knows the right
    // cuts can supply them.
    const results = [res({ facts: { loan_amount: 250000 } }), res({ facts: { loan_amount: 750000 } })];
    const noBands = M.buildParityMatrix(results, { program: PROGRAM });
    const dim = noBands.dimensions.find((d) => d.dimension === 'loan_amount') || {};
    eq(dim.kind, 'category', 'E15 an axis the sheet does not describe is not given invented bands');
    const withBands = M.buildParityMatrix(results, { program: PROGRAM, bands: { loan_amount: [500000] } });
    const dim2 = withBands.dimensions.find((d) => d.dimension === 'loan_amount') || {};
    eq(dim2.kind, 'band', 'E16 …and a caller-supplied cut point is honoured');
    eq(dim2.cells.length, 2, 'E17 …producing the two bands it defines');
  }

  // =========================================================================
  // F. THE REAL DEEPHAVEN SHEET
  // =========================================================================
  {
    const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
    const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
    const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
    const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()), { code: 'dhvn' });

    const bands = M.bandsFromProgram(program);
    ok(bands.size >= 5, `F1 the real sheet yields several axes (${bands.size})`);
    // THE POINT OF THE WHOLE DESIGN: these are the sheet's own FICO breaks, read off its rules. A
    // dashboard that cut at 660/680/700 "because those are the usual numbers" would straddle 640 and
    // 780 and average a good band with a bad one.
    deep(bands.get('fico'), [640, 660, 680, 700, 720, 740, 760, 780], 'F2 the FICO bands are the REAL sheet\'s own edges');
    ok((bands.get('ltv') || []).length >= 10, 'F3 …and the LTV axis carries its many cuts');
    ok(bands.has('dscr') && bands.has('loan_amount'), 'F4 …as do DSCR and loan amount');

    // A run straddling a real break is reported as two cells, not one average.
    const results = [
      res({ facts: { fico: 655 } }),
      res({ agree: false, facts: { fico: 665 }, findings: priceGap(-1250) }),
      res({ agree: false, facts: { fico: 675 }, findings: priceGap(-1250) }),
      res({ facts: { fico: 700 } }),
    ];
    const d = M.sliceBy(results, 'fico', bands.get('fico'));
    const lo = d.cells.find((c) => c.label === '640–660') || {};
    const mid = d.cells.find((c) => c.label === '660–680') || {};
    eq(lo.agreementRate, 1, 'F5 the 640–660 band is clean');
    eq(mid.agreementRate, 0, 'F6 …and the 660–680 band is entirely off, shown apart from it');
    eq(mid.priceDelta.worstAbsMilli, 1250, 'F7 …with the size of the gap on the band that has it');
    eq(d.cells.reduce((s, c) => s + c.total, 0), 4, 'F8 and the real-sheet slice reconciles too');
  }

  // =========================================================================
  // G. RANKING, CAPS, DEGENERATE INPUTS
  // =========================================================================
  {
    const results = [
      res({ agree: false, facts: { state: 'NY' }, findings: priceGap(3000) }),
      res({ facts: { state: 'FL' } }),
      res({ facts: { state: 'FL' } }),
    ];
    const m = M.buildParityMatrix(results, {});
    const worst = M.worstCells(m, 5);
    eq(worst[0].label, 'NY', 'G1 the worst-agreeing cell ranks first');
    eq(worst[0].worstAbsMilli, 3000, 'G2 …carrying the gap that makes it worst');
    eq(M.worstCells(m, 1).length, 1, 'G3 the limit is honoured');
    eq(M.worstCells(null).length, 0, 'G4 no matrix ranks nothing, and does not throw');
  }
  {
    // A "category" axis with thousands of distinct values is not categorical at all. Capped — and the
    // overflow is REPORTED, both as a count and as a reason, never silently truncated into a report
    // that looks complete.
    const many = [];
    for (let i = 0; i < M._internals.MAX_CELLS_PER_DIMENSION + 25; i += 1) many.push(res({ facts: { ref: `r${i}` } }));
    const d = M.sliceBy(many, 'ref', null);
    eq(d.cells.length, M._internals.MAX_CELLS_PER_DIMENSION, 'G5 the cell count is capped');
    eq(d.cellsTruncated, 25, 'G6 …and what did not fit is counted');
    ok(d.unsliceable.some((u) => /not categorical/.test(u.why)), 'G7 …with a reason that names the real problem');
    eq(d.cells.reduce((s, c) => s + c.total, 0) + d.unsliceableTotal, many.length, 'G8 even at the cap it reconciles');
  }
  {
    const empty = M.buildParityMatrix([], {});
    eq(empty.total, 0, 'G9 an empty run totals zero');
    eq(empty.agreementRate, null, 'G10 …with NO agreement rate, never a flattering 1');
    eq(empty.reconciles, true, 'G11 …and it still reconciles');
    deep(empty.dimensions, [], 'G12 …with no dimensions invented');
    eq(M.buildParityMatrix(null, {}).total, 0, 'G13 junk input does not throw');
  }

  // =========================================================================
  // H. IT IS REACHABLE — a measurement nobody can see is not a measurement
  // =========================================================================
  // This repo has shipped a fully-built, fully-tested PPE with no route once already. The matrix rides
  // on the canary, which is the one place a whole scenario battery is priced.
  {
    const out = await canary.runCanary(
      [{ _label: 'a', fico: 720, state: 'NY' }, { _label: 'b', fico: 650, state: 'NY' }],
      {
        ours: async (s) => ({ eligible: true, ladder: [{ rate: 7000, finalPriceMilli: s.fico > 700 ? 102000 : 100000 }] }),
        theirs: async () => ({ eligible: true, rungs: [{ rate: 7000, priceMilli: 102000 }] }),
      },
      { investor: 'DHVN', program: PROGRAM, nowMs: 1, priceToleranceMilli: 0 },
    );
    ok(out.matrix && out.matrix.dimensions.length > 0, 'H1 a canary run carries its parity matrix');
    eq(out.matrix.reconciles, true, 'H2 …which reconciles');
    eq(out.matrix.agreementRate, 0.5, 'H3 …and agrees with the run\'s own rate');
    const fico = out.matrix.dimensions.find((d) => d.dimension === 'fico') || { cells: [] };
    const bad = fico.cells.find((c) => c.label === '< 700') || {};
    eq(bad.agreementRate, 0, 'H4 …and it says WHICH band is off, which the single rate never could');
    eq(bad.priceDelta.worstAbsMilli, 2000, 'H5 …and by how much');
    ok(Array.isArray(out.results) && out.results.length === 2, 'H6 the per-scenario results are available for a second slice');
  }
  {
    // The matrix is a measurement OF a measurement, so it must never be the thing that loses a run.
    const out = await canary.runCanary(
      [{ _label: 'a', fico: 720 }],
      { ours: async () => ({ eligible: true, ladder: [] }), theirs: async () => ({ eligible: true, rungs: [] }) },
      { investor: 'D', program: { rules: { broken: true } }, nowMs: 1 },
    );
    ok(out.summary, 'H7 a canary survives an unusable program shape');
    ok(out.matrix !== undefined, 'H8 …and still reports a matrix field rather than omitting it');
  }
  {
    const fs = require('fs');
    const path = require('path');
    const routeSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'longterm', 'routes', 'ppe.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ok(/matrix:\s*run\.matrix/.test(routeSrc), 'H9 the canary route publishes the matrix');
    ok(/worstCells:/.test(routeSrc), 'H10 …and the cells worth looking at first');
    // Up to 500 per-scenario results is a payload nobody reads; the matrix is the answer.
    ok(!/results:\s*run\.results/.test(routeSrc), 'H11 …without dumping every per-scenario result onto the response');
  }

  console.log(`ok - lt ppe parity matrix (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
