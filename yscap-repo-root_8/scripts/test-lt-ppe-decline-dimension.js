#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT EVERY ELIGIBILITY DECLINE CAN NAME ITS DIMENSION.
 *
 * ⛔ WHAT WAS BROKEN, and it made the whole eligibility half of the ≥200-scenario gate unreachable.
 * The per-layer disqualifier reconciler matches OUR declines against Lender Price's BY DIMENSION, and
 * reads ours through `agreement-dimensions.dimensionOfRule`. That function's last resort is
 * `soleLeafFact(rule.when)` — the single leaf fact of the predicate — which is null the moment a
 * predicate is COMPOUND. Every real Deephaven eligibility rule IS compound (a DSCR band x FICO band x
 * purpose x tier gate wrapped around one cap), and `ratesheet.ineligibilityToRule` did not carry the
 * sheet's own `dimension` onto the compiled rule. So EVERY one of our declines arrived at the
 * reconciler as `unknown / no_dimension`, every scenario came back `decline_reasons_unreadable`, and a
 * live run WITH the decline feed on could not produce a single comparable scenario.
 *
 * MEASURED LIVE 2026-08-18, 8 scenarios, `--filter-investor "Deephaven Mortgage" --filter-program-like
 * "^dscr"` WITH the disqualify feed: comparable 0 of 8, `decline_reasons_unreadable` 8 of 8, and 9
 * distinct reasons of ours every one of which reported `why:'no_dimension'`. Same run before the fix
 * on the compiled program: 0 of 59 eligibility rules could name a dimension.
 *
 * THE FIX IS THE DATA, NOT A TEXT HEURISTIC. Each eligibility rule states the fact it CONSTRAINS in
 * `deephaven-dscr-sheet.js` (hand table, the generated LTV grid, and the overlays), the compiler
 * carries it, and a PLACEHOLDER (`eligibility` / `fico_cltv_dscr` — names for a GROUP, not a fact)
 * becomes an honest null rather than a dimension that could never match anything.
 *
 * WHAT THIS SUITE HOLDS, and why each part is here rather than only the obvious one:
 *   A — coverage: no eligibility rule may be dimension-less unless its code is in RECORDED_UNKNOWNS.
 *       A floor alone ("most rules have one") would pass while a whole family regressed.
 *   B — HONESTY: a stated dimension must be a fact the rule's own predicate tests (through the shared
 *       `factsForDimension`, so `cashout` may be expressed by `cashout_amount`). This is what stops a
 *       stamp being a GUESS: a wrong dimension is worse than none, because the reconciler scores it as
 *       a disagreement instead of surfacing it as unknown.
 *   C — the placeholders never reach a rule, in either direction.
 *   D — END TO END, which is the property that actually matters: quote a battery of real scenarios and
 *       assert the reconciler records ZERO `no_dimension` unknowns on our side. A per-rule check cannot
 *       see a decline produced by a path the compiler never touched.
 *   E — a both-decline on the same dimension now RECONCILES as an agreement (the thing the live run
 *       could not do), and a genuinely dimension-less decline is still surfaced as unknown, never
 *       quietly given one.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const { rateSheetToProgram } = require('../src/longterm/ppe/ratesheet');
const { gridToRateSheet } = require('../src/longterm/ppe/deephaven-grid');
const { buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');
const { dimensionOfRule, factsForDimension } = require('../src/longterm/ppe/agreement-dimensions');
const { reconcileDisqualifiers } = require('../src/longterm/ppe/disqualifier-reconciler');
const legs = require('../src/longterm/ppe/lp-agreement-legs');
const settings = require('../src/longterm/ppe/settings');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

// Every fact name a predicate tests on, at any depth.
function factsOf(pred, out) {
  const acc = out || new Set();
  if (!pred || typeof pred !== 'object') return acc;
  if (pred.fact) acc.add(pred.fact);
  for (const k of ['all', 'any']) if (Array.isArray(pred[k])) pred[k].forEach((p) => factsOf(p, acc));
  if (pred.not) factsOf(pred.not, acc);
  return acc;
}

// The ONLY eligibility rules allowed to have no dimension: a cell refused at EVERY leverage, whose
// predicate therefore names no constraining fact to read one from. Calling those `ltv` ("a max-LTV of
// nothing") is arguable and is exactly the guess this whole file refuses — so they are RECORDED, by
// code prefix, and stay visible as unknown. A NEW dimension-less rule outside these fails section A.
const RECORDED_UNKNOWNS = [
  /^dhvn_na_/,            // the 4-axis Max-LTV grid's N/A cells
  /^DHVN_DSCR30_fc___/,   // the fico x CLTV price grid's own N/A cells
];
const recordedUnknown = (code) => RECORDED_UNKNOWNS.some((re) => re.test(String(code || '')));

const program = rateSheetToProgram(gridToRateSheet(buildDeephavenGrid()));
const eligibility = (program.rules || []).filter((r) => r.kind === 'eligibility');

ok(eligibility.length >= 50, `A0 the sheet compiles a real eligibility envelope (got ${eligibility.length})`);

// ---- A. COVERAGE -------------------------------------------------------------------------------
const missing = eligibility.filter((r) => dimensionOfRule(r) == null && !recordedUnknown(r.code));
ok(missing.length === 0,
  `A1 every eligibility rule names its dimension unless recorded — dimension-less: ${missing.map((r) => r.code).join(', ')}`);

const stamped = eligibility.filter((r) => dimensionOfRule(r) != null);
ok(stamped.length >= 45, `A2 the overwhelming majority carry one (got ${stamped.length} of ${eligibility.length})`);

// The recorded set must stay REAL: a pattern that matches nothing is a rule that was renamed or
// deleted, and a stale exemption is how a regression hides behind a record.
for (const re of RECORDED_UNKNOWNS) {
  ok(eligibility.some((r) => re.test(String(r.code || '')) && dimensionOfRule(r) == null),
    `A3 the recorded-unknown pattern ${re} still matches a real dimension-less rule`);
}

// ---- B. HONESTY: a stated dimension is a fact the rule actually tests ---------------------------
const dishonest = [];
for (const r of stamped) {
  const dim = dimensionOfRule(r);
  const facts = factsOf(r.when);
  if (!factsForDimension(dim).some((f) => facts.has(f))) {
    dishonest.push(`${r.code} says '${dim}' but tests {${[...facts].join(', ')}}`);
  }
}
ok(dishonest.length === 0, `B1 no stated dimension is about a fact the rule never tests — ${dishonest.join(' | ')}`);

// The alias is load-bearing, not decoration: without it the two cash-out caps read as dishonest.
ok(factsForDimension('cashout').includes('cashout_amount'), 'B2 the cashout dimension is expressed by cashout_amount');
ok(factsForDimension('ltv').length === 1 && factsForDimension('ltv')[0] === 'ltv',
  'B3 an ordinary dimension is expressed by its own name and nothing else');

// ---- C. PLACEHOLDERS NEVER REACH A RULE --------------------------------------------------------
const PLACEHOLDERS = new Set(['eligibility', 'fico_cltv_dscr', 'other', 'grid']);
const leaked = eligibility.filter((r) => PLACEHOLDERS.has(String(dimensionOfRule(r))));
ok(leaked.length === 0, `C1 no placeholder reaches a rule as a dimension — ${leaked.map((r) => r.code).join(', ')}`);
// …and the sheet layer really does emit them, so C1 is not passing because there is nothing to catch.
const sheetSide = gridToRateSheet(buildDeephavenGrid());
const sheetIneligibilities = sheetSide.ineligibilities || sheetSide.eligibility || [];
ok(sheetIneligibilities.some((e) => PLACEHOLDERS.has(String(e && e.dimension))),
  'C2 the sheet layer does emit a placeholder dimension (so C1 has something to strip)');

// ---- D. END TO END over real scenarios ---------------------------------------------------------
const ours = legs.buildOursLeg(program, settings, null);
const BATTERY = [
  { _label: 'fico=660 cltv=75 dscr=1.25', purpose: 'Purchase', value: 500000, loan: 375000, fico: 660, dscr: 1.25, state: 'NY' },
  { _label: 'fico=640 cltv=80 dscr=1', purpose: 'Purchase', value: 500000, loan: 400000, fico: 640, dscr: 1.0, state: 'NY' },
  { _label: 'fico=760 cltv=80 dscr=0.95', purpose: 'Purchase', value: 500000, loan: 400000, fico: 760, dscr: 0.95, state: 'NY' },
  { _label: 'fico 600', purpose: 'Purchase', value: 500000, loan: 350000, fico: 600, dscr: 1.2, state: 'NY' },
  { _label: 'dscr 0.6', purpose: 'Purchase', value: 500000, loan: 350000, fico: 740, dscr: 0.6, state: 'NY' },
  { _label: 'tiny loan 60k', purpose: 'Purchase', value: 100000, loan: 60000, fico: 740, dscr: 1.2, state: 'NY' },
  { _label: 'min-loan 150k dscr 0.9', purpose: 'Purchase', value: 300000, loan: 150000, fico: 740, dscr: 0.9, state: 'NY' },
  { _label: 'cash-out over cap', purpose: 'Cash Out Refinance', value: 3000000, loan: 1800000, fico: 760, dscr: 1.3, state: 'NY', cashoutAmount: 1200000 },
  { _label: 'huge loan', purpose: 'Purchase', value: 5000000, loan: 3500000, fico: 760, dscr: 1.4, state: 'NY' },
];

let declinedScenarios = 0; let totalDeclines = 0; const noDimension = [];
for (const sc of BATTERY) {
  const q = ours(sc);
  if (q.eligible) continue;
  declinedScenarios += 1;
  totalDeclines += (q.declines || []).length;
  const rec = reconcileDisqualifiers(q, { ready: true, declined: [] }, { program });
  for (const u of (rec.unknown || [])) {
    if (u.side === 'ours' && u.why === 'no_dimension') noDimension.push(`${sc._label}: ${u.reason}`);
  }
}
ok(declinedScenarios >= 7, `D1 the battery really exercises declines (${declinedScenarios} of ${BATTERY.length} declined)`);
ok(totalDeclines >= 10, `D2 and produces a real number of decline rows (${totalDeclines})`);
// The whole point. Before the fix this list held EVERY decline the battery produced.
ok(noDimension.length === 0,
  `D3 no decline reaches the reconciler dimension-less — ${noDimension.slice(0, 6).join(' | ')}${noDimension.length > 6 ? ` (+${noDimension.length - 6})` : ''}`);

// ---- E. THE RECONCILIATION IT UNBLOCKS ---------------------------------------------------------
// A both-decline on the same dimension is an AGREEMENT — the thing the live run could not reach.
const weak = ours({ purpose: 'Purchase', value: 500000, loan: 400000, fico: 640, dscr: 0.95, state: 'NY' });
ok(weak.eligible === false, 'E0 the sample scenario does decline on our side');
const agreed = reconcileDisqualifiers(weak, {
  ready: true,
  declined: [{ reasons: [{ rule: 'DSCR < 1.00: Min FICO 680', adjType: 'FicoRateAdjustment' }] }],
}, { program });
const l2 = agreed.layers.layer2;
ok(l2.agreements.some((a) => a.dimension === 'fico'),
  `E1 a both-decline on FICO reconciles as an agreement (got ${JSON.stringify(l2.agreements)})`);
ok((agreed.unknown || []).filter((u) => u.side === 'ours' && u.why === 'no_dimension').length === 0,
  'E2 and nothing on our side is left unreadable');

// A rule that genuinely has no single dimension is STILL surfaced as unknown, never given one.
const naRule = eligibility.find((r) => /^dhvn_na_/.test(String(r.code || '')));
ok(naRule && dimensionOfRule(naRule) == null,
  'E3 an N/A cell (refused at every leverage) is still honestly dimension-less, not guessed into one');

console.log(`${fails.length ? 'FAIL' : 'PASS'} — decline dimension guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);
