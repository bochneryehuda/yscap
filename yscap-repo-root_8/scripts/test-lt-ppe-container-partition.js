#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE GUARD THAT LENDER PRICE'S PROGRAM PARTITION IS NOT A STATEMENT ABOUT THE BORROWER,
 * AND THAT NOTHING HERE READS A DSCR BAND OUT OF A PROGRAM NAME. Task #80.
 *
 * ⛔ WHAT WAS MEASURED (2026-08-18, two live captures of ONE scenario — dscr 1.25, fico 660, ltv 75%,
 * $375,000, Deephaven Mortgage; pinned verbatim in scripts/fixtures/lp-dscr-band-containers.json):
 *
 *   `DSCR < 1.00`       PRICED it — 28 rungs at 6.125% — and applied the band-CORRECT adjustment row,
 *                       `DSCR Ratio - DSCR >= 1.25 / CLTV >70.01 % <= 75.0 %` = -0.25
 *   `DSCR  1.00 - 1.24` declined, on the LTV grid only, carrying NO band filter whatsoever
 *   `DSCR > = 1.25`     declined, by a group named `Filter - DSCR >= 1.25%`, saying
 *                       "DSCR >=1.25%  only eligible on this program" — about a loan that IS >= 1.25
 *
 * So the container NAME does not describe the loan's band; the band is priced by an ADJUSTMENT ROW
 * inside the grid. Two things follow, and this suite holds both.
 *
 * 1. THE PARTITION SENTENCE IS NOT A REFUSAL. Scored as an authority decline we failed to make, it
 *    reads as "we would price a loan Lender Price refuses" — the dangerous direction, and false: a
 *    sibling container priced the same loan on the same request. It is separated into its own
 *    `partition` bucket, counted, never silently dropped, and never counted toward
 *    `ineligibleAuthority`.
 * 2. NO CODE MAY DERIVE A BAND FROM A NAME. A source sweep over src/longterm/** fails if any live
 *    line tests a program/grid name against a DSCR band literal. This is the property the measurement
 *    makes non-negotiable: on the one scenario measured, doing so would have been wrong.
 *
 * A THIRD THING IT HOLDS: the family pattern the runs actually use, /^dscr/i, still matches all three
 * container names — so recognising the partition changes what a decline MEANS without changing which
 * programs a run looks at.
 *
 * PURE: no DB, no network. LT-only. No RTL imports.
 */
const fs = require('fs');
const path = require('path');
const { classifyReason, isContainerPartitionReason, MEASURED } = require('../src/longterm/ppe/lp-container-partition');
const { reconcileDisqualifiers } = require('../src/longterm/ppe/disqualifier-reconciler');
const { normalizeLpDisqualified } = require('../src/longterm/ppe/lp-normalize-full');
const { previewScope } = require('../src/longterm/ppe/lp-scope');

let pass = 0; const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'lp-dscr-band-containers.json'), 'utf8'));
const byName = new Map(FIX.containers.map((c) => [c.rateProgramName, c]));
const priced = FIX.containers.find((c) => !c.disqualified);
const banded = byName.get('DSCR > = 1.25');
const unbanded = byName.get('DSCR  1.00 - 1.24');

// ---------------------------------------------------------------------------
// A. The measurement itself — the fixture says what the captures said.
// ---------------------------------------------------------------------------
ok(FIX._scenario.dscr === 1.25, `A1 the measured loan's DSCR is 1.25 — got ${FIX._scenario.dscr}`);
ok(priced && priced.rateProgramName === 'DSCR < 1.00',
  `A2 the container that PRICED a 1.25 loan is the one named "DSCR < 1.00" — got ${priced && priced.rateProgramName}`);
ok(FIX.containers.filter((c) => !c.disqualified).length === 1, 'A3 exactly one container priced');

const pricedBandAdj = priced.groups.flatMap((g) => g.dscrAdjustments);
ok(pricedBandAdj.length === 1 && /DSCR >= 1\.25/.test(pricedBandAdj[0].key),
  `A4 …and the row it applied is the band-CORRECT one — got ${JSON.stringify(pricedBandAdj)}`);
ok(pricedBandAdj[0].llpa === -0.25, `A5 …at the measured value -0.25 (LP charge-positive) — got ${pricedBandAdj[0].llpa}`);

const filterGroups = FIX.containers.flatMap((c) => c.groups.filter((g) => /^Filter\b/i.test(g.name || '')));
ok(filterGroups.length === 1, `A6 exactly ONE container carries a band filter group — got ${filterGroups.length}`);
ok(banded.groups.some((g) => g.name === 'Filter - DSCR >= 1.25%'), 'A7 …and it is the one named ">= 1.25"');
ok(!unbanded.groups.some((g) => /^Filter\b/i.test(g.name || '')),
  'A8 …while the 1.00-1.24 container has no band filter at all');
ok(unbanded.groups.some((g) => g.disqualifyAdjustments.some((r) => /Maximum LTV\/CLTV 70%/.test(r))),
  'A9 …it declined for a real, borrower-facing reason instead (the LTV grid)');

// ---------------------------------------------------------------------------
// B. The classifier — a closed measured list, nothing wider.
// ---------------------------------------------------------------------------
const PARTITION = 'DSCR >=1.25%  only eligible on this program';
const REAL = 'DSCR >=1.00, Loan Amount <= $1.5 MM, Purch RT, FICO < 680:  Maximum LTV/CLTV 70%';
ok(isContainerPartitionReason(PARTITION), 'B1 the measured partition sentence is recognised');
ok(!isContainerPartitionReason(REAL), 'B2 the real eligibility refusal beside it is NOT');
ok(isContainerPartitionReason('DSCR >=1.25% only eligible on this program'),
  'B3 …recognised through the vendor\'s doubled space (whitespace is normalized)');
ok(!isContainerPartitionReason('DSCR >=1.50% only eligible on this program'),
  'B4 …but a sentence nobody has measured is NOT recognised — the list is closed, not a pattern');
ok(!isContainerPartitionReason('only eligible on this program'),
  'B5 …and neither is a fragment of one');
ok(!isContainerPartitionReason('') && !isContainerPartitionReason(null),
  'B6 …empty and null are not partition reasons');

const withGroup = classifyReason({ rule: PARTITION, group: 'Filter - DSCR >= 1.25%' });
ok(withGroup.partition && withGroup.groupMatches === true, 'B7 a matching group corroborates the entry');
const noGroup = classifyReason({ rule: PARTITION });
ok(noGroup.partition && noGroup.groupMatches === null,
  'B8 …a caller with no group still matches, and says so with null rather than false');
const otherGroup = classifyReason({ rule: PARTITION, group: 'Eligibility - something else' });
ok(otherGroup.partition && otherGroup.groupMatches === false,
  'B9 …and a group that does NOT corroborate is visible, not absorbed');
ok(MEASURED.every((m) => m.reason && m.investor && m.measured && m.evidence && m.pricedBy),
  'B10 every entry carries where and when it was measured, and what priced the loan instead');

// ---------------------------------------------------------------------------
// C. The reconciler — set aside, counted, and out of "the authority refused this borrower".
// ---------------------------------------------------------------------------
const authorityBoth = { ready: true, declined: [{ program: 'DSCR  >= 1.25  - 30 Yr Fixed', reasons: [
  { rule: PARTITION, adjType: null, group: 'Filter - DSCR >= 1.25%' },
  { rule: REAL, adjType: 'FicoRateAdjustment', group: 'Eligibility - DSCR (>=1.00) Matrix - WHL/CORR (9.22.25)' },
] }] };
const both = reconcileDisqualifiers({ layer2: [{ dimension: 'fico', reason: 'ours' }] }, authorityBoth, {});
ok(both.summary.partition === 1, `C1 the partition sentence is COUNTED — got ${both.summary.partition}`);
// Read defensively: a mutation that stops the classifier firing must produce NAMED failures here,
// not a TypeError that hides every assertion after it.
const p0 = (f) => (both.partition[0] || {})[f];
ok(both.partition.length === 1 && p0('reason') === PARTITION,
  'C2 …and reported verbatim, never silently dropped');
ok(p0('pricedBy') === 'DSCR < 1.00  -  30 Yr Fixed',
  'C3 …alongside the container that priced the same loan');
const l2Reasons = both.layers.layer2.onlyAuthority.map((r) => r.reason).concat(both.layers.layer2.agreements.map((r) => r.lpReason));
ok(!l2Reasons.includes(PARTITION), 'C4 …and it is NOT in the layer the comparison scores');
ok(l2Reasons.includes(REAL), 'C5 …while the real refusal beside it still is');
ok(both.summary.ineligibleAuthority === true,
  'C6 the authority still refused this borrower — the real reason is what says so');
ok(both.summary.partitionOnly === false, 'C7 …so partitionOnly is false');

const authorityPartitionOnly = { ready: true, declined: [{ program: 'DSCR  >= 1.25  - 30 Yr Fixed',
  reasons: [{ rule: PARTITION, adjType: null, group: 'Filter - DSCR >= 1.25%' }] }] };
const only = reconcileDisqualifiers({ layer2: [] }, authorityPartitionOnly, {});
ok(only.summary.ineligibleAuthority === false,
  'C8 a container-only refusal is NOT a refusal of the borrower');
ok(only.summary.partitionOnly === true,
  'C9 …and the caller is told exactly why ineligibleAuthority went false');
ok(only.summary.disagree === 0,
  `C10 …so it scores no disagreement — got ${only.summary.disagree}`);

// The pre-normalized path is the one a replayed run uses; it must not bypass the filter.
const pre = reconcileDisqualifiers({ layer2: [] },
  { ready: true, layer2: [{ dimension: 'dscr', reason: PARTITION }], layer3: [] }, {});
ok(pre.summary.partition === 1 && pre.layers.layer2.onlyAuthority.length === 0,
  'C11 the pre-normalized authority path goes through the same filter');

// ---------------------------------------------------------------------------
// D. The normalizer carries the group — the structural signal survives the trip.
// ---------------------------------------------------------------------------
const norm = normalizeLpDisqualified({ ready: true, lenders: [{ lender: 'Deephaven Mortgage', investor: 'Deephaven Mortgage',
  items: [{ program: 'DSCR  >= 1.25  - 30 Yr Fixed', reasons: [{ rule: PARTITION, adjType: null, group: 'Filter - DSCR >= 1.25%' }] }] }] },
{ programLike: '^dscr' });
ok(norm.declined.length === 1 && norm.declined[0].reasons[0].group === 'Filter - DSCR >= 1.25%',
  `D1 the vendor's group name survives normalization — got ${JSON.stringify(norm.declined[0] && norm.declined[0].reasons[0])}`);

// ---------------------------------------------------------------------------
// E. The scope still sees all three containers — meaning changed, coverage did not.
// ---------------------------------------------------------------------------
const names = FIX.containers.map((c) => c.programName);
const prev = previewScope({ programLike: '^dscr' }, names);
ok(prev.matched.length === 3 && prev.unmatched.length === 0,
  `E1 /^dscr/i still matches all three measured container names — matched ${prev.matched.length}, missed ${JSON.stringify(prev.unmatched)}`);

// ---------------------------------------------------------------------------
// F. THE SWEEP — no live line derives a DSCR band from a program/grid NAME.
// ---------------------------------------------------------------------------
// The measurement is the reason this is a hard rule: on the one scenario measured, a 1.25 loan priced
// under the container named "< 1.00", so any code doing this would have been confidently wrong. The
// sweep strips comments first (the three modules that EXPLAIN the split must be free to say so), then
// fails any remaining line that mentions a program-name field and a band literal together.
const NAME_FIELD = /\b(programName|rateGridName|rateProgram|programLike|\.program\b|lpProgram)/;
const BAND_LITERAL = /(?:^|[^\d.])1\.(?:00|24|25)(?![\d])/;
function stripComments(src) {
  // Block comments, then line comments. Crude by design: it can only ever make the sweep STRICTER,
  // because anything it fails to strip stays eligible to fail the test.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
function jsFiles(dir, acc) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, acc);
    else if (e.isFile() && p.endsWith('.js')) acc.push(p);
  }
  return acc;
}
const ROOT = path.join(__dirname, '..', 'src', 'longterm');
const offenders = [];
for (const file of jsFiles(ROOT, [])) {
  const rel = path.relative(path.join(__dirname, '..'), file);
  const lines = stripComments(fs.readFileSync(file, 'utf8')).split('\n');
  lines.forEach((line, i) => {
    if (NAME_FIELD.test(line) && BAND_LITERAL.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 120)}`);
  });
}
ok(offenders.length === 0,
  `F1 no live line reads a DSCR band out of a program name — found ${offenders.length}:\n      ${offenders.join('\n      ')}`);
// …and the sweep can actually see such a line, so F1 passing means something.
const canary = stripComments('const band = programName.includes("DSCR < 1.00") ? "low" : "high";');
ok(NAME_FIELD.test(canary) && BAND_LITERAL.test(canary), 'F2 the sweep detects the shape it forbids');
const commentOnly = stripComments('// LP splits the sheet into DSCR < 1.00, 1.00-1.24 and >= 1.25 programs\nconst x = 1;');
ok(!(NAME_FIELD.test(commentOnly) && BAND_LITERAL.test(commentOnly)), 'F3 …and a comment explaining the split is not an offence');

console.log(`${fails.length ? 'FAIL' : 'PASS'} — LP container partition + band-name guard: ${pass} passed, ${fails.length} failed`);
for (const f of fails) console.log('  ✗', f);
process.exit(fails.length ? 1 : 0);
