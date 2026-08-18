'use strict';
/**
 * Pure offline test for the DEEP half of the LT PPE pricing façade (src/longterm/ppe/facade.js) —
 * §2.8, "the dual-run model, deepened". All IO is stubbed; no DB, no network, no LP credentials.
 *   node scripts/test-lt-ppe-facade-deep.js
 *
 * What this pins, and why each section exists:
 *   A  the deep pass is ADDITIVE — with no `deps.lpDetail` nothing about the façade moves, and the
 *      block says WHY it did not run rather than going quiet.
 *   B  the two LIVE WIRING DEFECTS this work found: the route handed the façade the RAW LP envelope
 *      (never parsed) and used the program OBJECT as Lender Price's program-name filter, so Lender
 *      Price scored as INELIGIBLE on every single quote and the ledger filled with eligibility
 *      findings that were a wiring fact, not a disagreement.
 *   C  the axes the ladder cannot see (margin / base price / the LLPA stack) become real findings.
 *   D  the axes it CAN see are reported but NOT recorded twice.
 *   E  the D29 overlay reading wins the eligibility axis over the detectors' defect reading.
 *   F  every abstention carries a stated reason, and an unscoped multi-program capture abstains
 *      rather than comparing our one program against a merge of seventeen.
 *   G  the two façade guarantees still hold: the business answer is never blocked and never broken.
 *   H  a per-coupon difference is a per-coupon FINDING (identity), not one row for the whole ladder.
 */

const assert = require('assert');
const FA = require('../src/longterm/ppe/facade');
const findingLib = require('../src/longterm/ppe/finding');
const overlay = require('../src/longterm/ppe/overlay');

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n += 1; };
const eq = (a, b, m) => { assert.strictEqual(a, b, m); n += 1; };

const NOW = 1_700_000_000_000;

// ---------------------------------------------------------------------------
// Fixtures — the real shapes, not convenient ones.
// ---------------------------------------------------------------------------

// What `lp.price()` actually returns on the live route: the RAW envelope. NOT the parse() shape.
const lpEnvelope = () => ({ ok: true, raw: { results: {} }, request: {}, searchKey: 'k1' });

// client.parse(raw) — the shallow ladder shape.
const parsedOf = (program, price) => ({ programs: [{ program, product: 'Fixed', rungs: [{ rate: 7.125, price }] }] });

// client.parseFull(raw) — one option carrying every axis the detectors read.
const optionOf = (over = {}) => ({
  priceBuild: {
    noteRate: 7.125, price: 102.850, baseRate: 7.125, basePoints: -3.750, adjustmentPoints: 0.900, ...(over.priceBuild || {}),
  },
  holdback: over.holdback === null ? null : (over.holdback || { lender: [{ value: 0.25 }] }),
  adjustments: over.adjustments || [{ group: 'Purpose', reason: 'Cash-Out Refinance', adjType: 'price', value: 0.500 }],
  rateAdjustments: [],
  flags: {},
});
const fullOf = (program, over) => ({ programs: [{ lender: 'Deephaven', investor: 'Deephaven', program, product: 'Fixed', options: [optionOf(over)] }] });

// client.parseDisqualified(raw)
const disqOf = (program, rule) => ({ ready: true, lenders: [{ lender: 'Deephaven', investor: 'Deephaven', items: [{ program, reasons: [{ rule, adjType: 'eligibility' }] }] }] });
const disqNotReady = () => ({ ready: false, lenders: [] });

// quote.quoteProgram(...) — our reconstruction record. Agrees with the LP option above on every axis.
const ourRung = (over = {}) => ({
  rate: 7125, finalPriceMilli: 102850, basePriceMilli: 103750, marginMilli: 250, adjustmentCostMilli: 900, ...over,
});
const ourQuote = (over = {}) => ({ eligible: true, ladder: [ourRung(over.rung || {})], declines: over.declines || [], ...(over.top || {}) });

// The live route's own wiring, in one place: the raw envelope → the three parsed shapes.
const detailFrom = (parts) => () => parts;

async function run(deps, opts, req) {
  return FA.priceWithShadow(
    { scenario: { _label: 'ltv=70', ltv: 70 }, investor: 'Deephaven', program: 'DSCR 30 Yr Fixed', ...(req || {}) },
    { mode: () => 'shadow', nowMs: NOW, ...deps },
    { priceToleranceMilli: 0, rateToleranceMilli: 0, marginToleranceMilli: 0, basePriceToleranceMilli: 0, ...(opts || {}) },
  );
}

async function main() {
  // =========================================================================
  // A. ADDITIVE — no lpDetail wired changes nothing, and says why it did not run
  // =========================================================================
  {
    const recorded = [];
    const res = await run({
      priceLp: async () => parsedOf('DSCR 30 Yr Fixed', 102.850),
      ourQuote: async () => ourQuote(),
      recordFinding: (r) => recorded.push(r),
    });
    const deep = (res.shadow && res.shadow.deep) || {};
    eq(res.shadow.agreed, true, 'A1 the ladder comparison still agrees with no deep pass');
    eq(deep.ran, false, 'A2 the deep pass did not run');
    ok(/deps\.lpDetail is not wired/.test(deep.why || ''), 'A3 and it says exactly what is missing');
    eq(recorded.length, 0, 'A4 nothing recorded on agreement');
  }

  // =========================================================================
  // B. THE TWO LIVE WIRING DEFECTS
  // =========================================================================
  {
    // B1/B2 — the raw envelope. Before lpDetail, the façade normalized `{ok, raw, request}` as if it
    // were the parse() shape: no `.programs`, so ZERO matched programs, so Lender Price read as
    // INELIGIBLE and every quote manufactured an eligibility finding.
    const recorded = [];
    const before = await run({
      priceLp: async () => lpEnvelope(),
      ourQuote: async () => ourQuote(),
      recordFinding: (r) => recorded.push(r),
    });
    eq(before.shadow.agreed, false, 'B1 unparsed: the raw envelope reads as a disagreement');
    eq((before.shadow.findings[0] || {}).kind, 'eligibility_mismatch', 'B2 …specifically a phantom "Lender Price declined it"');

    const after = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    });
    eq(after.shadow.agreed, true, 'B3 with lpDetail the same envelope compares correctly and AGREES');
    ok(after.answer && after.answer.raw, 'B4 the business answer is still Lender Price\'s own envelope, untouched');
  }
  {
    // B5 — the program OBJECT. The live route passes the whole program (baseGrid + rules), which as an
    // exact name filter renders "[object object]" and matches nothing. A non-string program must be
    // ignored as a filter, never used as one.
    const programObject = { code: 'v-7', name: 'Deephaven DSCR', baseGrid: [{ rate: 7125 }] };
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    }, null, { program: programObject });
    eq(res.shadow.agreed, true, 'B5 a program OBJECT no longer filters Lender Price down to nothing');
    eq(FA._internals.lpScope(programObject, {}).filter, null, 'B6 lpScope refuses to use an object as a program name');
    eq(FA._internals.lpScope('DSCR', {}).source, 'program_name', 'B7 …and still honours a plain string');
    eq(FA._internals.lpScope({}, { lpFilter: { programLike: 'DSCR' } }).source, 'lpFilter', 'B8 …with opts.lpFilter winning');
  }

  // =========================================================================
  // C. THE AXES THE LADDER CANNOT SEE
  // =========================================================================
  {
    // Same coupon, same FINAL price — so the ladder comparison agrees completely — but Lender Price
    // applied a 0.25 margin we did not, and our base price and LLPA stack are both off. This is the
    // entire point of §2.8: before this, a live quote in exactly this state reported "agreed".
    const recorded = [];
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote({ rung: { marginMilli: 500, basePriceMilli: 103000, adjustmentCostMilli: 400 } }),
      recordFinding: (r) => recorded.push(r),
    });
    const deep = (res.shadow && res.shadow.deep) || {};
    const cats = (deep.differences || []).map((d) => d.category).sort();
    eq(deep.ran, true, 'C1 the deep pass ran');
    eq(res.shadow.findings.length, 0, 'C2 the ladder comparison saw NOTHING — the final price agrees');
    eq(res.shadow.agreed, false, 'C3 …but the scenario does NOT agree, because the deep pass disagrees');
    assert.deepStrictEqual(cats, ['base_price', 'llpa_total', 'margin'], 'C4 all three invisible axes named');
    n += 1;
    const margin = (deep.differences || []).find((d) => d.category === 'margin') || {};
    eq(margin.ourValue, 500, 'C5 the margin difference carries our value');
    eq(margin.lpValue, 250, 'C6 …and Lender Price\'s');
    eq(margin.deltaMilli, 250, 'C7 …and the delta');
    const kinds = (recorded[0] || []).map((r) => r.kind).sort();
    assert.deepStrictEqual(kinds, ['base_price', 'llpa_total', 'margin'], 'C8 all three became durable findings');
    n += 1;
    eq(deep.recorded, 3, 'C9 the block reports how many were recorded');
    const one = (recorded[0] || [])[0] || {};
    eq(one.investor, 'Deephaven', 'C10 a deep finding carries the investor');
    eq(one.scenario, 'ltv=70', 'C11 …and the scenario label');
    eq(one.status, 'open', 'C12 …and is born open');
  }
  {
    // C13 — the itemized LLPAs Lender Price applied ride along on the finding, which is what lets a
    // human (or the rule-suggestion miner) see WHICH adjustment we are missing rather than only that
    // the total is off. That itemization is the thing the shallow capture could never carry.
    const recorded = [];
    await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote({ rung: { adjustmentCostMilli: 0 } }),
      recordFinding: (r) => recorded.push(r),
    });
    const rec = (recorded[0] || []).find((r) => r.kind === 'llpa_total') || {};
    const llpas = (rec.diff && rec.diff.lpLlpas) || [];
    eq((llpas[0] || {}).reason, 'Cash-Out Refinance', 'C13 the LP adjustment we are missing is named verbatim');
    eq((llpas[0] || {}).valueMilli, 500, 'C14 …with its value in milli-points');
  }

  // =========================================================================
  // D. NO DOUBLE-RECORDING of an axis the ladder already reports
  // =========================================================================
  {
    const recorded = [];
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote({ rung: { finalPriceMilli: 102000 } }),
      recordFinding: (r) => recorded.push(r),
    });
    const deep = (res.shadow && res.shadow.deep) || {};
    const kinds = (recorded[0] || []).map((r) => r.kind);
    eq(kinds.filter((k) => k === 'price_mismatch').length, 1, 'D1 the ladder recorded the price disagreement once');
    eq(kinds.filter((k) => k === 'final_price').length, 0, 'D2 the deep pass did NOT record the same fact a second time');
    ok((deep.differences || []).some((d) => d.category === 'final_price'), 'D3 …it is still fully REPORTED');
    const held = (deep.notRecorded || []).find((h) => h.category === 'final_price') || {};
    ok(/already records this/.test(held.why || ''), 'D4 …and the block says why it was held back');
  }

  // =========================================================================
  // E. THE OVERLAY READING WINS THE ELIGIBILITY AXIS
  // =========================================================================
  {
    // Our matrix declines on a stated overlay-only fact Lender Price cannot see (D29) — an intentional
    // override, not a defect. The detectors have no such concept and would type it
    // `disqualification_extra`. Recording both would put a "defect" row next to the "intentional"
    // row for one decision.
    const recorded = [];
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      // Authored through the REAL overlay constructor, so this fixture can never drift from the shape
      // the classifier actually recognizes (a hand-typed look-alike would silently score as a defect
      // and the section would pass for the wrong reason).
      ourQuote: async () => ({ eligible: false, ladder: [], declines: [overlay.overlayDecline('occupancy', 'Vacant/Unleased is ineligible on this matrix — Lender Price cannot see occupancy')] }),
      recordFinding: (r) => recorded.push(r),
    });
    const deep = (res.shadow && res.shadow.deep) || {};
    const kinds = (recorded[0] || []).map((r) => r.kind);
    ok(kinds.length === 1, 'E1 exactly one finding for one eligibility decision');
    eq(kinds.filter((k) => k === 'disqualification_extra').length, 0, 'E2 the detectors\' defect reading was dropped');
    ok((deep.differences || []).some((d) => d.category === 'disqualification_extra'), 'E3 …though still reported');
    const held = (deep.notRecorded || []).find((h) => h.category === 'disqualification_extra') || {};
    ok(/overlay/.test(held.why || ''), 'E4 …and the reason names the overlay reading');
  }
  {
    // E5 — the DANGEROUS direction is genuinely new information the ladder cannot reach: Lender Price
    // DECLINED the program in its disqualify tree while we priced it. The ladder sees a priced LP
    // ladder and agrees; only the disqualify tree tells the truth.
    const recorded = [];
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({
        parsed: { programs: [] },
        full: { programs: [] },
        disqualified: disqOf('DSCR 30 Yr Fixed', 'FICO below 660'),
      }),
      ourQuote: async () => ourQuote(),
      recordFinding: (r) => recorded.push(r),
    }, { lpFilter: { program: 'DSCR 30 Yr Fixed' } });
    const rec = (recorded[0] || []).find((r) => r.kind === 'disqualification_missing') || {};
    eq(rec.kind, 'disqualification_missing', 'E5 the dangerous direction is recorded');
    const reasons = (rec.diff && rec.diff.lpReasons) || [];
    eq((reasons[0] || {}).rule, 'FICO below 660', 'E6 …carrying Lender Price\'s own decline reason');
    eq(res.shadow.agreed, false, 'E7 …and the scenario does not agree');
    // The ladder ALSO saw this as an eligibility disagreement — but its reading is the poorer one (no
    // decline reason, and it cannot tell a real decline from a program-family split). One decision is
    // one ledger row, and it must be the row somebody can act on.
    const allKinds = (recorded[0] || []).map((r) => r.kind);
    eq(allKinds.length, 1, 'E8 one eligibility decision produced exactly one ledger row');
    eq(allKinds.filter((k) => k === 'eligibility_mismatch').length, 0, 'E9 …and it is not the ladder\'s poorer reading');
    ok(((res.shadow.deep || {}).supersededLadderKinds || []).includes('eligibility_mismatch'), 'E10 …with the supersession stated on the block');
    ok(res.shadow.findings.some((f) => f.kind === 'eligibility_mismatch'), 'E11 …while both readings stay visible on the response');
  }

  // =========================================================================
  // F. EVERY ABSTENTION CARRIES A STATED REASON
  // =========================================================================
  {
    const cases = [
      {
        name: 'F1 lpDetail throws',
        deps: { lpDetail: () => { throw new Error('parse blew up'); } },
        why: /could not be read: parse blew up/,
      },
      {
        name: 'F2 no full parse in the capture',
        deps: { lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850) }) },
        why: /carried no full parse/,
      },
      {
        name: 'F3 an empty capture',
        deps: { lpDetail: detailFrom({ parsed: { programs: [] }, full: { programs: [] }, disqualified: disqNotReady() }) },
        why: /no priced programs and no disqualify tree/,
      },
      {
        name: 'F4 our engine threw',
        deps: { lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed') }), ourQuote: async () => { throw new Error('our boom'); } },
        why: /our engine produced no quote/,
      },
    ];
    for (const c of cases) {
      const res = await run({
        priceLp: async () => lpEnvelope(),
        lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
        ourQuote: async () => ourQuote(),
        recordFinding: () => {},
        ...c.deps,
      });
      const deep = (res.shadow && res.shadow.deep) || {};
      eq(deep.ran, false, `${c.name} — abstains`);
      ok(c.why.test(deep.why || ''), `${c.name} — and says why (${deep.why})`);
    }
  }
  {
    // F14 — the abstention has to reach the LADDER half too, not just the deep block. An unreadable
    // capture that falls back to "Lender Price offered nothing" is exactly the defect this whole
    // change fixes, arriving by a second door: it scores as a Lender Price DECLINE and fills the
    // ledger with eligibility findings that are a wiring fact.
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: () => { throw new Error('parse blew up'); },
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    });
    const f = res.shadow.findings[0] || {};
    eq(f.kind, 'incomparable', 'F14 an unreadable capture leaves the ladder INCOMPARABLE, never a phantom decline');
    ok(/could not be read/.test(f.detail || ''), 'F15 …with the reason carried on the finding itself');
    eq(res.shadow.agreed, false, 'F16 …and an incomparable scenario is never scored as agreement');
  }
  {
    // F17 — same rule for a capture that simply carries no ladder. "We could not read Lender Price"
    // and "Lender Price declined" are different facts and only one of them is true here.
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    });
    const f = res.shadow.findings[0] || {};
    eq(f.kind, 'incomparable', 'F17 a capture with no parsed ladder is INCOMPARABLE, never a phantom decline');
    ok(/carried no parsed ladder/.test(f.detail || ''), 'F18 …and says exactly what was missing');
  }
  {
    // F5 — the SCOPE rule. Lender Price answers one request with every program it sells (17 on the
    // live Deephaven capture, across several investors). Comparing our single-program ladder against
    // a merge of them is not a weaker comparison, it is a meaningless one — so with no scope it
    // ABSTAINS on both halves rather than manufacturing differences.
    const many = { programs: [1, 2, 3].map((i) => ({ program: `Prog ${i}`, product: 'Fixed', rungs: [{ rate: 7.125, price: 100 + i }] })) };
    const manyFull = { programs: [1, 2, 3].map((i) => ({ lender: 'X', investor: 'X', program: `Prog ${i}`, product: 'Fixed', options: [optionOf()] })) };
    const recorded = [];
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: many, full: manyFull, disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: (r) => recorded.push(r),
    }, null, { program: { code: 'v-7' } });
    const deep = (res.shadow && res.shadow.deep) || {};
    eq(deep.ran, false, 'F5 an unscoped multi-program capture abstains');
    ok(/3 programs and this comparison is not scoped/.test(deep.why || ''), 'F6 …naming the count');
    ok(/lpFilter/.test(deep.why || ''), 'F7 …and exactly how to scope it');
    eq((res.shadow.findings[0] || {}).kind, 'incomparable', 'F8 the ladder half is INCOMPARABLE, never a phantom decline');
    ok(/not scoped to one/.test((res.shadow.findings[0] || {}).detail || ''), 'F9 …with the same stated reason');

    // …and naming the scope makes both halves work on the very same capture.
    const scoped = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: many, full: manyFull, disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    }, { lpFilter: { programLike: '^Prog 2$' } }, { program: { code: 'v-7' } });
    eq(((scoped.shadow || {}).deep || {}).ran, true, 'F10 with a scope the deep pass runs');
    eq(((scoped.shadow || {}).deep || {}).programsMatched, 1, 'F11 …against exactly one program');
  }
  {
    // F12 — Lender Price computes its disqualify tree ASYNCHRONOUSLY, so an ordinary price call
    // usually returns before it is ready. That leaves the eligibility axis half-tested, and the block
    // says so rather than letting an absence of declines read as "Lender Price declined nothing".
    const notReady = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    });
    eq(((notReady.shadow || {}).deep || {}).disqualifyReady, false, 'F12 an unready disqualify tree is reported as unready');
    const ready = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: { ready: true, lenders: [] } }),
      ourQuote: async () => ourQuote(),
      recordFinding: () => {},
    });
    eq(((ready.shadow || {}).deep || {}).disqualifyReady, true, 'F13 …and a ready one as ready');
  }

  // =========================================================================
  // G. THE TWO FAÇADE GUARANTEES STILL HOLD
  // =========================================================================
  {
    // G1/G2 — a deep-side failure never breaks or blocks the business answer.
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: () => { throw new Error('detail down'); },
      ourQuote: async () => ourQuote(),
      recordFinding: () => { throw new Error('db down'); },
    });
    ok(res.answer && res.answer.raw, 'G1 Lender Price\'s answer returns despite a broken capture read AND a broken persist');
    eq(res.authoritative, 'lp', 'G2 …and it is still authoritative');
  }
  {
    // G3 — a deep finding is persisted fire-and-forget: an async persist is never awaited, so the
    // response cannot be blocked on it.
    let settled = false;
    const res = await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
      ourQuote: async () => ourQuote({ rung: { marginMilli: 999 } }),
      recordFinding: () => new Promise((r) => setTimeout(() => { settled = true; r(); }, 30)),
    });
    eq(settled, false, 'G3 the response did not wait on the persist');
    eq(res.shadow.agreed, false, 'G4 …and still reports the disagreement');
  }
  {
    // G5 — live mode + canary reaches the deep pass too (it runs through the same compareSafely).
    const res = await FA.priceWithShadow(
      { scenario: { _label: 'c' }, investor: 'Deephaven', program: 'DSCR 30 Yr Fixed' },
      {
        mode: () => 'live', nowMs: NOW,
        priceLp: async () => lpEnvelope(),
        lpDetail: detailFrom({ parsed: parsedOf('DSCR 30 Yr Fixed', 102.850), full: fullOf('DSCR 30 Yr Fixed'), disqualified: disqNotReady() }),
        ourQuote: async () => ourQuote({ rung: { marginMilli: 500 } }),
        recordFinding: () => {},
      },
      { canary: true, priceToleranceMilli: 0, marginToleranceMilli: 0 },
    );
    eq(((res.shadow || {}).deep || {}).ran, true, 'G5 a live canary also gets the deep comparison');
    eq(res.authoritative, 'ours', 'G6 …without changing who is authoritative');
  }

  // =========================================================================
  // H. IDENTITY — a per-coupon difference is a per-coupon FINDING
  // =========================================================================
  {
    const twoRungFull = { programs: [{ lender: 'D', investor: 'D', program: 'P', product: 'F', options: [
      optionOf(),
      optionOf({ priceBuild: { noteRate: 7.375, price: 103.500, baseRate: 7.375, basePoints: -3.500, adjustmentPoints: 0.900 } }),
    ] }] };
    const recorded = [];
    await run({
      priceLp: async () => lpEnvelope(),
      lpDetail: detailFrom({ parsed: { programs: [{ program: 'P', rungs: [{ rate: 7.125, price: 102.850 }, { rate: 7.375, price: 103.500 }] }] }, full: twoRungFull, disqualified: disqNotReady() }),
      ourQuote: async () => ({ eligible: true, declines: [], ladder: [
        ourRung({ marginMilli: 500 }),
        ourRung({ rate: 7375, finalPriceMilli: 103500, basePriceMilli: 103500, marginMilli: 500 }),
      ] }),
      recordFinding: (r) => recorded.push(r),
    }, { lpFilter: { program: 'P' } });
    const margins = (recorded[0] || []).filter((r) => r.kind === 'margin');
    eq(margins.length, 2, 'H1 a margin difference at two coupons is TWO findings');
    eq(new Set(margins.map((m) => m.key)).size, 2, 'H2 …with two distinct ledger keys');
    ok(findingLib.RATE_KINDS.has('margin'), 'H3 margin is registered as a per-coupon kind');
    ok(findingLib.RATE_KINDS.has('base_price') && findingLib.RATE_KINDS.has('llpa_total'), 'H4 …as are base_price and llpa_total');
    ok(!findingLib.RATE_KINDS.has('disqualification_missing'), 'H5 an eligibility kind is NOT per-coupon');
  }

  console.log(`ok - lt ppe facade deep comparison (${n} assertions)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
