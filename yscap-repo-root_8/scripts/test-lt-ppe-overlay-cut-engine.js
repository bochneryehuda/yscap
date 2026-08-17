#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GENERIC OVERLAY-CUT INTERPRETER (PPE #47/#48; the scalable half of D36).
 *
 * Two proofs:
 *  A) RUNTIME EQUIVALENCE — the refactored, table-driven `evaluateOverlayDeclines` is BYTE-IDENTICAL to
 *     the pre-refactor HAND-WRITTEN imperative version over a boundary battery (every overlay flag × the
 *     numeric boundaries of each cut × occupancy × grid-cap present/absent). The `oracle()` below is a
 *     faithful copy of the imperative code the table replaced — the baseline, not read from git.
 *  B) ENGINE SEMANTICS — the interpreter's own contract, proven on a SYNTHETIC table (a second investor
 *     shape) so the reusability is demonstrated, not assumed: each cmp, the absent-fact fail-safe, the
 *     isTrue cross-fact cut, the gtRelative resolved/unresolved split, flags, and enforced-entry rules.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const { evaluateOverlayDeclines, _cuts } = require('../src/longterm/ppe/deephaven-overlay-rules');
const { evaluateCutTable } = require('../src/longterm/ppe/overlay-cut-engine');
const overlay = require('../src/longterm/ppe/overlay');

let pass = 0; let fail = 0;
function ok(c, l) { if (c) { pass++; console.log('  ok   ' + l); } else { fail++; console.log('  FAIL ' + l); } }
const J = (x) => JSON.stringify(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

console.log('LT PPE — generic overlay-cut interpreter (equivalence + semantics)\n');

// ---- the ORACLE: a faithful copy of the imperative logic the declarative table replaced -------------
const CITE = 'Deephaven Corr Flow DSCR matrix, eff 08/04/26 — Advanced overlays';
function oracle(facts, opts = {}) {
  const f = facts || {};
  const declines = []; const enforced = []; const stillFlagged = [];
  const C = _cuts;
  const flag = (o, n) => stillFlagged.push({ overlay: o, needs: n });
  const decline = (fact, reason, code) => declines.push(overlay.overlayDecline(fact, reason, { code, citation: CITE }));
  const fico = f.fico, ltv = f.ltv, dscr = f.dscr, loan = f.loan_amount, units = f.units;
  if (f.short_term_rental === true) {
    const cuts = [];
    if (isNum(dscr) && dscr < C.STR_MIN_DSCR) { decline('short_term_rental', 'Short-Term Rental requires DSCR >= 1.15x', 'overlay_str_min_dscr'); cuts.push('dscr>=1.15'); }
    if (isNum(fico) && fico < C.STR_MIN_FICO) { decline('short_term_rental', 'Short-Term Rental requires FICO >= 720', 'overlay_str_min_fico'); cuts.push('fico>=720'); }
    if (isNum(ltv) && ltv > C.STR_MAX_LTV) { decline('short_term_rental', 'Short-Term Rental caps LTV at 75%', 'overlay_str_max_ltv'); cuts.push('ltv<=75'); }
    if (isNum(units) && units >= 2) { decline('short_term_rental', 'Short-Term Rental is not allowed on a 2+ unit property', 'overlay_str_units'); cuts.push('units<2'); }
    if (f.first_time_investor === true) { decline('short_term_rental', 'Short-Term Rental is not allowed for a first-time investor', 'overlay_str_no_fti'); cuts.push('not first-time investor'); }
    if (f.rural_property === true) { decline('short_term_rental', 'Short-Term Rental is not allowed on a rural property', 'overlay_str_no_rural'); cuts.push('not rural'); }
    enforced.push({ overlay: 'short_term_rental', cuts });
  }
  if (f.first_time_investor === true) {
    const cuts = [];
    if (isNum(dscr) && dscr < C.FTI_MIN_DSCR) { decline('first_time_investor', 'First-Time Investor requires DSCR >= 1.00x', 'overlay_fti_min_dscr'); cuts.push('dscr>=1.00'); }
    if (isNum(fico) && fico < C.FTI_MIN_FICO) { decline('first_time_investor', 'First-Time Investor requires FICO >= 700', 'overlay_fti_min_fico'); cuts.push('fico>=700'); }
    enforced.push({ overlay: 'first_time_investor', cuts });
  }
  if (f.rural_property === true) {
    const cuts = [];
    if (isNum(ltv) && ltv > C.RURAL_MAX_LTV) { decline('rural_property', 'Rural caps LTV at 65%', 'overlay_rural_max_ltv'); cuts.push('ltv<=65'); }
    enforced.push({ overlay: 'rural_property', cuts });
    flag('Rural: DSCR > 1.0x, <=10 acres, no ag/farm use', 'DSCR strict-vs-inclusive boundary + acreage / land-use facts not carried');
  }
  if (f.declining_market === true) {
    const gridMax = opts.gridMaxLtvMilli;
    if (isNum(gridMax) && isNum(ltv)) {
      const eff = gridMax - C.DECLINING_LTV_CUT_MILLI; const cuts = [];
      if (ltv > eff) { decline('declining_market', `Declining market reduces max LTV by 5 points (to ${eff / 1000}%)`, 'overlay_declining_ltv'); cuts.push(`ltv<=${eff / 1000}`); }
      enforced.push({ overlay: 'declining_market', cuts });
    } else {
      flag('Declining market: Max LTV -5%', 'needs the Layer-2 grid max-LTV cap (gridMaxLtvMilli) for this cell');
    }
  }
  if (f.foreign_national === true) {
    const cuts = [];
    if (isNum(loan) && loan > C.FN_MAX_LOAN) { decline('foreign_national', 'Foreign National max loan $1,500,000', 'overlay_fn_max_loan'); cuts.push('loan<=1.5M'); }
    if (isNum(dscr) && dscr < C.FN_MIN_DSCR) { decline('foreign_national', 'Foreign National requires DSCR >= 1.00x', 'overlay_fn_min_dscr'); cuts.push('dscr>=1.00'); }
    enforced.push({ overlay: 'foreign_national', cuts });
    flag('Foreign National: LTV caps 70/60', 'which cap (70 vs 60) applies is not stated in the matrix');
  }
  if (f.occupancy === 'vacant') flag('Vacant/Unleased: ineligible for R/T & C/O refi; -5% LTV on refi; 2+unit max 1 vacant', 'D27 — internally ambiguous rule text (owner decision pending)');
  if (f.first_time_homebuyer === true) flag('First-Time Homebuyer: ineligible unless 2+ borrowers with one non-FTHB', 'needs a borrower-count / non-FTHB fact');
  if (f.renovation === true) flag('Renovation cash-out: appraised value under 6mo ownership at max 75% LTV', 'needs a seasoning (months owned) fact');
  return { declines, enforced, stillFlagged };
}

// ---- A) RUNTIME EQUIVALENCE over a deterministic boundary battery -----------------------------------
{
  // boundary-hitting numeric domains for every cut, incl. `undefined` (the fail-safe absent-fact case)
  const DSCR = [undefined, 999, 1000, 1149, 1150, 1250];
  const FICO = [undefined, 699, 700, 719, 720, 760];
  const LTV = [undefined, 64000, 65000, 65001, 74999, 75000, 75001, 80000];
  const LOAN = [undefined, 1499999, 1500000, 1500001];
  const UNITS = [undefined, 1, 2, 3];
  const GRID = [undefined, 70000, 80000];
  const OCC = [undefined, 'leased', 'vacant'];
  // deterministic LCG so the sample is fixed run-to-run (no Math.random — banned + non-reproducible)
  let seed = 1234567;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  let checked = 0; let mismatches = 0; let firstBad = null;
  // all 2^5 combinations of the 5 ENFORCING overlay flags, × sampled numerics/occupancy/grid/aux flags
  for (let mask = 0; mask < 32; mask++) {
    for (let s = 0; s < 90; s++) {
      const facts = {
        short_term_rental: !!(mask & 1),
        first_time_investor: !!(mask & 2),
        rural_property: !!(mask & 4),
        declining_market: !!(mask & 8),
        foreign_national: !!(mask & 16),
        first_time_homebuyer: rnd() < 0.5,
        renovation: rnd() < 0.5,
        occupancy: pick(OCC),
        dscr: pick(DSCR), fico: pick(FICO), ltv: pick(LTV), loan_amount: pick(LOAN), units: pick(UNITS),
      };
      const opts = { gridMaxLtvMilli: pick(GRID) };
      const got = evaluateOverlayDeclines(facts, opts);
      const want = oracle(facts, opts);
      checked++;
      if (J(got) !== J(want)) { mismatches++; if (!firstBad) firstBad = { facts, opts, got, want }; }
    }
  }
  ok(mismatches === 0, `RUNTIME EQUIVALENCE: table-driven ≡ hand-written over ${checked} boundary scenarios (0 mismatches)`);
  if (firstBad) console.log('   first mismatch:\n     facts=' + J(firstBad.facts) + '\n     got =' + J(firstBad.got) + '\n     want=' + J(firstBad.want));

  // a self-check that the battery actually EXERCISES the interpreter (not all-empty): at least one
  // scenario must have produced a decline AND at least one an unresolved-declining flag.
  let sawDecline = false; let sawFlag = false;
  seed = 42;
  for (let i = 0; i < 500 && !(sawDecline && sawFlag); i++) {
    const facts = { short_term_rental: true, declining_market: true, dscr: pick(DSCR), ltv: pick(LTV), fico: pick(FICO) };
    const r = evaluateOverlayDeclines(facts, { gridMaxLtvMilli: pick(GRID) });
    if (r.declines.length) sawDecline = true;
    if (r.stillFlagged.some((x) => /Declining market: Max LTV -5%/.test(x.overlay))) sawFlag = true;
  }
  ok(sawDecline && sawFlag, 'the battery genuinely exercised the interpreter (produced declines AND an unresolved-cap flag)');
}

// ---- B) ENGINE SEMANTICS on a SYNTHETIC (second-investor) table -------------------------------------
// Reuse real overlay fact keys (overlayDecline THROWS on a non-overlay fact — that guard is the point),
// but with DIFFERENT cuts than Deephaven, proving the interpreter is not Deephaven-specific.
{
  const CIT = 'Synthetic investor overlay table (test)';
  const TABLE = [
    {
      when: 'renovation', enforce: true,          // Deephaven only FLAGS renovation; here it ENFORCES
      cuts: [
        { code: 'x_reno_ltv', fact: 'ltv', cmp: 'gt', value: 70000, reason: 'Reno caps LTV at 70%', label: 'ltv<=70' },
        { code: 'x_reno_fico', fact: 'fico', cmp: 'lt', value: 680, reason: 'Reno needs FICO >= 680', label: 'fico>=680' },
      ],
    },
    {
      when: 'foreign_national', enforce: true,     // a RELATIVE cut on a different base key
      cuts: [{
        code: 'x_fn_rel', fact: 'ltv', cmp: 'gtRelative', base: 'baselineLtv', delta: 10000,
        reason: (c) => `capped at ${c.eff / 1000}%`, label: (c) => `ltv<=${c.eff / 1000}`,
        unresolvedFlag: { overlay: 'FN relative cap', needs: 'needs baselineLtv' },
      }],
    },
    { when: 'occupancy', whenEquals: 'vacant', flags: [{ overlay: 'vacant flag', needs: 'ambiguous' }] },
  ];
  const run = (f, o) => evaluateCutTable(f, TABLE, { ...o, citation: CIT });

  // gt / lt numeric cuts, and the fail-safe
  ok(run({ renovation: true, ltv: 70001 }).declines.some((d) => d.code === 'x_reno_ltv'), 'engine: gt cut fires just over the threshold');
  ok(!run({ renovation: true, ltv: 70000 }).declines.some((d) => d.code === 'x_reno_ltv'), 'engine: gt cut does NOT fire at the threshold (inclusive max)');
  ok(run({ renovation: true, fico: 679 }).declines.some((d) => d.code === 'x_reno_fico'), 'engine: lt cut fires just below the threshold');
  ok(run({ renovation: true }).declines.length === 0, 'engine: an armed group with NO numeric facts declines nothing (fail-safe)');
  ok(run({ renovation: true }).enforced.some((e) => e.overlay === 'renovation' && e.cuts.length === 0), 'engine: an armed enforcing group is recorded as enforced even with zero fired cuts');
  ok(run({ renovation: false, ltv: 90000 }).declines.length === 0 && run({ renovation: false }).enforced.length === 0, 'engine: a DISARMED group is entirely inert');

  // gtRelative: resolved fires / does not; unresolved flags and is NOT enforced
  ok(run({ foreign_national: true, ltv: 71000 }, { baselineLtv: 80000 }).declines.some((d) => d.code === 'x_fn_rel'), 'engine: gtRelative fires above (base 80 − 10 = 70; asked 71)');
  ok(!run({ foreign_national: true, ltv: 70000 }, { baselineLtv: 80000 }).declines.length, 'engine: gtRelative does NOT fire at the reduced cap');
  {
    const r = run({ foreign_national: true, ltv: 90000 }); // no baselineLtv → unresolvable
    ok(r.declines.length === 0 && r.stillFlagged.some((x) => x.overlay === 'FN relative cap') && !r.enforced.some((e) => e.overlay === 'foreign_national'), 'engine: an unresolvable relative cut FLAGS and is not recorded as enforced (never invents the base)');
  }
  // the dynamic reason/label carried the computed eff
  {
    const d = run({ foreign_national: true, ltv: 71000 }, { baselineLtv: 80000 }).declines.find((x) => x.code === 'x_fn_rel');
    ok(d && /capped at 70%/.test(d.reason) && d.citation === CIT, 'engine: a function reason receives the computed eff, and the table citation is stamped');
  }
  // whenEquals + flag-only group
  ok(run({ occupancy: 'vacant' }).stillFlagged.some((x) => x.overlay === 'vacant flag') && run({ occupancy: 'vacant' }).declines.length === 0, 'engine: a whenEquals flag-only group reports its flag, never a decline');
  ok(run({ occupancy: 'leased' }).stillFlagged.length === 0, 'engine: whenEquals does not arm on a different value');

  // isTrue cross-fact cut (proven via the Deephaven table's own STR→FTI rule, but here through the engine)
  ok(evaluateCutTable({ short_term_rental: true, first_time_investor: true, dscr: 1250, fico: 760 }, require('../src/longterm/ppe/deephaven-overlay-rules').DEEPHAVEN_OVERLAY_CUTS, { citation: 'x' }).declines.some((d) => d.code === 'overlay_str_no_fti'), 'engine: an isTrue cross-fact cut fires on the linked overlay fact');

  // every emitted synthetic decline is still a VALID overlay decline (the E3 classifier will accept it)
  ok(run({ renovation: true, ltv: 90000, fico: 600 }).declines.every((d) => overlay.isValidOverlayDecline(d)), 'engine: every emitted decline is a valid overlay decline (real overlay fact + reason + flag)');

  // an empty table and empty facts are inert (never throws)
  ok(J(evaluateCutTable({}, [], {})) === J({ declines: [], enforced: [], stillFlagged: [] }), 'engine: empty table / empty facts → empty result');
  ok(J(evaluateCutTable(null, TABLE, {})) === J({ declines: [], enforced: [], stillFlagged: [] }), 'engine: null facts arm nothing');
}

// ---- C) MUTATION SENTINEL — a wrong cmp in a table is caught (the engine BITES) ---------------------
{
  const good = evaluateCutTable({ renovation: true, ltv: 90000 }, [{ when: 'renovation', enforce: true, cuts: [{ code: 'm', fact: 'ltv', cmp: 'gt', value: 70000, reason: 'r', label: 'l' }] }], { citation: 'c' });
  const mutated = evaluateCutTable({ renovation: true, ltv: 90000 }, [{ when: 'renovation', enforce: true, cuts: [{ code: 'm', fact: 'ltv', cmp: 'lt', value: 70000, reason: 'r', label: 'l' }] }], { citation: 'c' });
  ok(good.declines.length === 1 && mutated.declines.length === 0, 'mutation sentinel: flipping gt→lt changes the outcome (the interpreter actually reads cmp)');
}

console.log(`\n${fail === 0 ? 'OFFLINE: all passed' : 'FAILURES: ' + fail} (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
