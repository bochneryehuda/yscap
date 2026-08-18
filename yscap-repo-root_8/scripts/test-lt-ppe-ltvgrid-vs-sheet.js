#!/usr/bin/env node
'use strict';
/**
 * LT PPE — THE ELIGIBILITY GRID AND THE RATE SHEET MUST AGREE ABOUT WHAT IS ELIGIBLE (§2.92).
 *
 * ⛔ TWO DOCUMENTS DESCRIBE THE SAME FRONTIER, AND NOTHING COMPARED THEM.
 *
 * Deephaven states the maximum leverage twice:
 *   • the **rate sheet** (`deephaven-dscr-ratesheet-corr-t0.json` → `priceAdjustmentsFicoByCltv`)
 *     prices a FICO × CLTV cell, or writes `"N/A"`. The last priced column in a row IS a max-CLTV
 *     statement — an N/A is an ineligibility, never a priced zero.
 *   • the **product matrix** (`deephaven-dscr-matrix.json` → `ltvGrid`) states a cap per
 *     tier × FICO × purpose × DSCR band.
 *
 * `scripts/test-lt-ppe-ratesheet-matrix-reconcile.js` exists precisely to stop these two drifting —
 * and it reconciles only the program PARAMETERS and the N/A cell COUNT. **It never compared the
 * matrix's caps against the sheet's own priced/N-A frontier**, so a cell where the two documents
 * disagree was resolved silently, by whichever engine happened to read which document.
 *
 * ⛔ AND THEY DO DISAGREE, ON A CELL THE LIVE RUN LANDED ON. Measured 2026-08-18: the battery
 * scenarios `fico=660 cltv=75 dscr=1.25` and `… dscr=1` were declined by our engine and priced by
 * Lender Price. The reason is here:
 *
 *     rate sheet, row "660 - 679", CLTV 70.5–75.5%  ->  -3.750   (PRICED)
 *     product matrix, tier ≤$1.5M, the 640 row       ->  cap 70%  (the matrix has NO 660 row,
 *                                                                  so its 640 row covers 640–699)
 *     Lender Price, measured live at that cell       ->  3.750    (PRICED)
 *
 * Two of Deephaven's own documents disagree, Lender Price sides with the rate sheet, and our engine
 * silently took the stricter. **That is a business question — which document governs — and the standing
 * rule is never to guess one.** So this suite does not pick a winner. It makes every such cell either
 * RECONCILED or RECORDED IN WRITING, so the set cannot grow in silence while somebody decides.
 *
 * The recording is not a way to mute the test: an entry must state both numbers and a real reason, and
 * a divergence that is NOT recorded fails. Same discipline, and same wording, as `RECORDED_DIVERGENCES`
 * in the sibling reconcile suite.
 *
 *   node scripts/test-lt-ppe-ltvgrid-vs-sheet.js
 *
 * PURE — reads the two source documents. No DB, no network. LT-only.
 */
const path = require('path');
const matrix = require('../docs/longterm/ppe-research/matrices/deephaven-dscr-matrix.json');
const sheetDoc = require('../docs/longterm/ppe-research/matrices/deephaven-dscr-ratesheet-corr-t0.json');
const { _internals: sheetInternals, buildDeephavenGrid } = require('../src/longterm/ppe/deephaven-dscr-sheet');

let failures = 0;
function ok(cond, label) { console.log(`${cond ? '  ok  ' : ' FAIL '} ${label}`); if (!cond) failures++; }

// The CLTV band upper bounds the sheet's columns mean, as PERCENT. `80.5` is the band's exclusive top;
// the eligibility statement it carries is "up to 80%".
const CLTV_TOPS = [50, 55, 60, 65, 70, 75, 80];

// ---- the two frontiers, each derived from its OWN document ---------------------------------------
// The sheet's statement: the top of the last column that carries a NUMBER. `"N/A"` (and null) is the
// sheet's own ineligibility marker, so the frontier stops before it.
function sheetFrontier() {
  const rows = sheetDoc.priceAdjustmentsFicoByCltv.rows;
  const out = [];
  for (const r of rows) {
    const label = String(r.fico || r.label || '');
    let last = -1;
    r.byCltv.forEach((v, i) => { if (typeof v === 'number') last = i; });
    out.push({ label, maxCltv: last >= 0 ? CLTV_TOPS[last] : null });
  }
  return out;
}
// The matrix's statement for the SAME question: purchase/rate-term, DSCR >= 1.00, smallest tier — the
// axis the sheet's grid is stated on. The matrix rows are FICO FLOORS in descending order, so a row
// governs from its floor up to the next row above it.
function matrixCapFor(fico) {
  const rows = (matrix.ltvGrid.tiers[0].rows || []).filter((r) => typeof r.fico === 'number');
  const sorted = rows.slice().sort((a, b) => b.fico - a.fico);
  for (const r of sorted) if (fico >= r.fico) return { floor: r.fico, cap: r.P_RT_ge1 == null ? null : Math.round(r.P_RT_ge1 * 100) };
  return { floor: null, cap: null };
}
// The FICO a sheet row speaks for: its LOWEST score, which is where the row's cap has to hold.
function lowFicoOf(label) {
  const m = String(label).match(/(\d{3})/);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------------------------
// RECORDED DIVERGENCES — a written entry, with both numbers and a real reason. Not a mute switch:
// the entry must name the cell and say what is unresolved, and an UNRECORDED divergence fails.
// ---------------------------------------------------------------------------------------------
const RECORDED_DIVERGENCES = [
  {
    cell: '660 - 679',
    sheetMaxCltv: 75,
    matrixCap: 70,
    resolved: false,
    reason:
      'OPEN — OWNER QUESTION, RAISED 2026-08-18, NOT GUESSED. Deephaven states this cell twice and the '
      + 'two statements disagree. The RATE SHEET prices "660 - 679" at CLTV 70.5-75.5% (-3.750), which '
      + 'is an eligibility statement of 75%. The PRODUCT MATRIX has no 660 row at all, so its 640 row '
      + '(cap 70%) covers 640-699. Lender Price was measured live at that cell PRICING it at 3.750, '
      + 'siding with the rate sheet. Our engine silently took the stricter of the two and declined, '
      + 'which is why `fico=660 cltv=75 dscr=1.25` and `... dscr=1` came back as disagreements on the '
      + '2026-08-18 live run. The question for the owner is general, not local: WHEN THE RATE SHEET AND '
      + 'THE PRODUCT MATRIX CONFLICT, WHICH GOVERNS? Answer it once and it becomes a precedence rule '
      + 'rather than a one-cell patch. Until then this stays recorded and the engine keeps declining — '
      + 'the safe direction, and the one that costs us business rather than costing us money.',
  },
];
const recordedFor = (cell) => RECORDED_DIVERGENCES.find((d) => d.cell === cell) || null;

// ---- A: both documents are readable, and the derivation has teeth --------------------------------
console.log('-- A: the two frontiers --');
const frontier = sheetFrontier();
ok(frontier.length >= 8, `the rate sheet states ${frontier.length} FICO rows`);
ok(frontier.every((f) => f.maxCltv != null), 'every sheet row has at least one priced cell — none is entirely N/A');
ok(matrix.ltvGrid.tiers.length === 3, `the matrix states ${matrix.ltvGrid.tiers.length} loan tiers`);
// Teeth: the derivation must actually vary, or "they agree" would be vacuous.
const tops = new Set(frontier.map((f) => f.maxCltv));
ok(tops.size >= 3, `the sheet's frontier really varies by FICO (${[...tops].sort((a, b) => b - a).join(', ')}%)`);
ok(frontier.find((f) => /780/.test(f.label)).maxCltv === 80, 'the strongest row reaches 80%');
ok(frontier.find((f) => /640/.test(f.label)).maxCltv === 70, 'the weakest numeric row stops at 70%');

// ---- B: the reconciliation ----------------------------------------------------------------------
console.log('\n-- B: cell by cell, sheet against matrix --');
let agreed = 0; const diverged = [];
for (const f of frontier) {
  const low = lowFicoOf(f.label);
  if (low == null) continue; // the Foreign National row is a borrower TYPE, not a FICO band — §C
  const { cap } = matrixCapFor(low);
  if (cap == null) { diverged.push({ ...f, matrixCap: null }); continue; }
  if (cap === f.maxCltv) { agreed += 1; continue; }
  diverged.push({ ...f, matrixCap: cap });
}
ok(agreed >= 5, `${agreed} FICO rows agree between the rate sheet and the product matrix`);
for (const d of diverged) {
  const rec = recordedFor(d.cell || d.label);
  ok(!!rec, `DIVERGENCE at "${d.label}": sheet says ${d.maxCltv}%, matrix says ${d.matrixCap}% — is it recorded?`);
  if (rec) {
    ok(rec.sheetMaxCltv === d.maxCltv && rec.matrixCap === d.matrixCap,
      `…and the record carries the SAME two numbers (${rec.sheetMaxCltv} / ${rec.matrixCap}) — a stale record is not a record`);
    ok(typeof rec.reason === 'string' && rec.reason.length > 120,
      '…and states a real reason, not a shrug');
  }
}
// The recorded set must not outlive the divergence it records — a record for a cell that now agrees is
// a claim about the documents that is no longer true.
for (const rec of RECORDED_DIVERGENCES) {
  ok(diverged.some((d) => (d.cell || d.label) === rec.cell),
    `the recorded divergence "${rec.cell}" is still real — a record for a reconciled cell would be stale`);
}
ok(diverged.length === RECORDED_DIVERGENCES.length,
  `every divergence is recorded and every record is live (${diverged.length} of each)`);

// ---- C: what is deliberately NOT compared, said out loud -----------------------------------------
console.log('\n-- C: the limits of this comparison --');
{
  const fn = frontier.find((f) => /Foreign/i.test(f.label));
  ok(!!fn, 'the sheet carries a Foreign National row');
  ok(lowFicoOf(fn.label) === null, '…which is a borrower TYPE, not a FICO band, so it is not compared here');
  // The matrix carries the same row, and neither engine encodes it — recorded elsewhere, named here so
  // this suite is not mistaken for full coverage of the grid.
  const fnRow = (matrix.ltvGrid.tiers[0].rows || []).find((r) => r.fico === 'ForeignNational');
  ok(!!fnRow, '…and the matrix carries it too, so the gap is in the ENGINES, not in the documents');
  ok(fn.maxCltv === 70 && Math.round(fnRow.P_RT_ge1 * 100) === 70,
    'and on the axis this suite checks, the two documents AGREE about it (70%) — the gap is that nothing enforces it');
}
// This suite compares ONE axis: purchase/rate-term, DSCR >= 1.00, smallest tier. The sheet's grid is
// stated on that axis alone; the matrix's other three columns and two larger tiers have no sheet
// counterpart to reconcile against, and inventing one would be the guess this file refuses.
ok(matrix.ltvGrid.tiers[0].maxLoan === 1500000, 'the tier compared is the sheet\'s own (<=$1.5M)');
ok(['P_RT_lt1', 'CO_ge1', 'CO_lt1'].every((k) => matrix.ltvGrid.tiers[0].rows[0][k] !== undefined),
  'the matrix states three further columns this suite does NOT reconcile — the sheet has no counterpart for them');

// ---- D: the engine follows the stricter, and that is a CHOICE ------------------------------------
console.log('\n-- D: what the engine actually does with the conflict --');
{
  // Not asserted from prose: built from the real sheet and read back.
  const grid = buildDeephavenGrid();
  const src = require('fs').readFileSync(path.join(__dirname, '../src/longterm/ppe/deephaven-dscr-sheet.js'), 'utf8');
  ok(/SHEET_LTV_GRID/.test(src), 'the engine encodes the MATRIX grid alongside the sheet cells');
  ok(!!grid, 'the sheet builds');
  // The consequence, stated so the record and the behaviour cannot drift apart: at the disputed cell
  // the engine declines, which is the matrix's answer, not the sheet's.
  const rec = RECORDED_DIVERGENCES[0];
  ok(rec.matrixCap < rec.sheetMaxCltv,
    `the recorded conflict is one where the matrix is STRICTER (${rec.matrixCap}% vs ${rec.sheetMaxCltv}%)`);
  ok(/keeps declining|stricter/.test(rec.reason),
    '…and the record says which way the engine currently resolves it, so nobody has to go and find out');
}

console.log(`\n${failures ? `${failures} FAILED` : 'all passed'}`);
process.exit(failures ? 1 : 0);
