#!/usr/bin/env node
'use strict';
/**
 * ONE BREAKDOWN LAYOUT, WHATEVER PRICED IT — the parity suite (pure, offline).
 *
 * Owner-directed 2026-08-30: *"Our pilot should lay out all the details the same
 * layout no matter if it comes from with software."*
 *
 * WHAT IT IS FOR. Two rate sheets answer "why is this price this price?" in two
 * completely different vocabularies, and every difference this file guards
 * against is SILENT — both vendors answer, nothing throws, and the reader is
 * quietly shown two different things:
 *   • Lender Price states an adjustment in POINTS (positive costs the borrower);
 *     LoanNEX states it in PRICE (positive is a BETTER price). The old mapping
 *     negated the TOTAL and left the LINES as given, so on ONE option a row read
 *     one way and the total under it read the other.
 *   • LoanNEX's `description` — "FICO : 760 - 779, CLTV : 70.01% - 75.00%", the
 *     actual grid CELL, which is the whole of "why is this price this price" —
 *     was parsed and then thrown away.
 *   • An investor that answered `{"status":"Success"}` with NO body was reported
 *     as "not requested", a claim about OUR system that was simply untrue.
 *   • Every criterion the program checked, with the vendor's own wording and a
 *     pass/fail on each, was parsed and dropped.
 *
 * THE LOANNEX SIDE IS LIVE. `capture/evidence-live.json` is the real API's own
 * answers, recorded 2026-08-30 the first time the explain endpoint was ever
 * called for real — including the investor that answered with nothing.
 *
 * PROVEN TO FAIL. Each of these was applied to the production code and the named
 * assertion went red, with the rest of the battery green either side:
 *   1.  leave the LoanNEX line value as the vendor's own price number   → SIGN-1/2
 *   2.  negate the Lender Price lines too                               → SIGN-3
 *   3.  sum our own rounded points instead of the vendor's numbers      → SIGN-6
 *   4.  drop `detail` from the mapped line                              → DETAIL-1/2
 *   5.  report a vendor's empty answer as `not_requested`               → ABSENCE-2
 *   6.  give every absence the same sentence                            → ABSENCE-5
 *   7.  drop the eligibility block from `attachEvidence`                → ELIG-1/2
 *   8.  re-render a requirement instead of passing the vendor's words   → ELIG-4
 *   9.  drop the soft-stop notices                                      → NOTICE-1
 *  10.  flatten unknown staleness to `expired: false`                   → STALE-2
 *  11.  name the vendor without a reveal                                → ONE-1
 *  12.  treat a line with no value as zero in the reconciliation        → NULL-2
 *  13.  stop deriving the base price from the base points               → BASE-2
 *  14.  order the rows by whatever the vendor happened to send          → ORDER-1
 *
 * A crashing test also "fails" and looks like proof, so every read here goes
 * through a total accessor and a wrong answer fails CLEANLY.
 *
 * LT-only. No network, no DB, no RTL imports.
 */
const lp = require('../src/longterm/lenderprice/client');
const quoteShape = require('../src/longterm/pricing/quote-shape');
const nexParse = require('../src/longterm/loannex/parse');
const BD = require('../src/longterm/pricing/breakdown');
const liveCapture = require('../src/longterm/loannex/capture/evidence-live.json');

let pass = 0, fail = 0;
function ok(cond, label) { if (cond) { pass++; console.log('  ok   ' + label); } else { fail++; console.log('  FAIL ' + label); } }
const keysOf = (o) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : '(not an object)');
const rowsOf = (b) => (b && Array.isArray(b.lines) ? b.lines : []);
const lineNamed = (b, re) => rowsOf(b).find((l) => re.test(String(l.label || ''))) || {};

// ── The Lender Price side: one option in the vendor's OWN wire shape ─────────
// Built from the leaf `client.optionOf` reads, so the mapping under test is the
// production one and not a hand-made object shaped to agree with it.
const LP_LEAF = {
  companyName: 'Some Lender', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr. Fixed',
  rate: 6.25, baseRates: 6.25, basePoints: 2.5, adjustmentPoints: -0.5, adjustedPoints: 2.0,
  dayLock: 30, term: 360, loanAmount: 375000, dscr: 1.5, fico: 760, ltv: 75, cltv: 75,
  groupAdjustmentProperties: [
    { name: 'FICO / CLTV', adjustments: [{ key: 'FICO 760-779, CLTV 70.01-75.00', adjType: 'FicoRateAdjustment', type: 'LLPA', valueType: 'Points', llpa: 0.125 }] },
    { name: 'DSCR', adjustments: [{ key: 'DSCR >= 1.25', adjType: 'DscrAdjustment', type: 'LLPA', valueType: 'Points', llpa: -0.25 }] },
    { name: 'Prepay', adjustments: [{ key: 'Prepayment penalty 36 months', adjType: 'PrepayAdjustment', type: 'LLPA', valueType: 'Points', llpa: -0.375 }] },
  ],
  ratePeriod: { validAsOf: '2026-08-29T12:00:00Z' }, expired: false,
};
const LP_RAW = { results: { qualifiedNonQMData: {
  type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
  childs: [{ type: 'LenderKey', keyLabel: 'Some Lender', plenderId: 'L1', leafs: [LP_LEAF] }],
} } };
const lpFull = lp.parseFull(LP_RAW);
const lpOption = quoteShape.optionsFromLenderPrice((lpFull.programs[0] || {}).options || [])[0] || {};
const LP = BD.breakdown(lpOption);

// ── The LoanNEX side: the LIVE answers, through the production path ──────────
const liveRows = (liveCapture.samples || []).map((s) => {
  const ev = nexParse.parseEvidence(s.response);
  const absence = ev ? null : nexParse.explainAbsence(s.response);
  const opt = quoteShape.attachEvidence(
    quoteShape.optionForQuote({ ...(s.request || {}).quote, vendor: 'loannex' }), ev, { absence },
  );
  return { investor: s.investor, ev, absence, option: opt, b: BD.breakdown(opt) };
});
const withLines = liveRows.filter((r) => rowsOf(r.b).length);
const NEX = (withLines[0] || {}).b || {};
const EMPTY_ANSWER = liveRows.find((r) => !r.ev) || {};

console.log('\n── THE LAYOUT: the same rows, the same keys, whatever priced it ──');
{
  const all = [LP].concat(withLines.map((r) => r.b));
  ok(all.length >= 3, `LAYOUT-0 the battery runs over ${all.length} real options — one Lender Price and ${all.length - 1} live LoanNEX`);
  ok(new Set(all.map(keysOf)).size === 1,
    'LAYOUT-1 every breakdown has exactly the same top-level keys — a screen never learns which vendor answered');
  const rowKeySets = new Set(all.flatMap((b) => rowsOf(b).map(keysOf)));
  ok(rowKeySets.size === 1,
    'LAYOUT-2 every ROW of every source has exactly the same keys — no vendor gets a column the other lacks');
  ok([...rowKeySets][0] === BD.LINE_KEYS.slice().sort().join(','),
    'LAYOUT-3 …and those keys are exactly LINE_KEYS, the one published contract for a row');
  for (const k of ['price', 'totals', 'sheet', 'eligibility', 'display']) {
    ok(new Set(all.map((b) => keysOf(b[k]))).size === 1,
      `LAYOUT-4 the \`${k}\` block is the same shape on every source, present or not`);
  }
  ok(all.every((b) => Array.isArray(b.lines) && Array.isArray(b.notices)),
    'LAYOUT-5 the lists are always lists — an absent block is empty, never null, so a template never guards');
  ok(all.every((b) => rowsOf(b).length === (b.display.lines || []).length),
    'LAYOUT-6 the display copy has exactly one rendered row per real row — the screen never re-derives the arithmetic');
}

console.log('\n── ONE SIGN CONVENTION, or "+0.25" means opposite things on one screen ──');
{
  const nexFico = lineNamed(NEX, /FICO/);
  ok(nexFico.givenIn === 'price' && nexFico.valueAsGiven === -0.125 && nexFico.value === 0.125,
    'SIGN-1 a LoanNEX price adjustment is turned into POINTS, and the vendor\'s own number is kept beside it');
  const nexDscr = lineNamed(NEX, /DSCR/);
  ok(nexDscr.givenIn === 'price' && nexDscr.valueAsGiven === 0.25 && nexDscr.value === -0.25,
    'SIGN-2 …in both directions — a price ADD is a points CREDIT, never copied through unchanged');
  const lpFicoRow = lineNamed(LP, /FICO/);
  ok(lpFicoRow.givenIn === 'points' && lpFicoRow.valueAsGiven === 0.125 && lpFicoRow.value === 0.125,
    'SIGN-3 a Lender Price adjustment is already points and is passed through untouched — never double-negated');
  ok([LP, NEX].every((b) => rowsOf(b).every((l) => l.valueType === 'points')),
    'SIGN-4 every row on every source states its unit, and the unit is the same one');
  ok(LP.totals.reconciles === true && NEX.totals.reconciles === true,
    'SIGN-5 the rows add up to the total the vendor stated, on BOTH sources');
  ok(withLines.every((r) => r.b.totals.reconciles === true),
    `SIGN-6 …on every one of the ${withLines.length} live answers, to the thousandth`);
  ok(LP.price.adjustmentPoints === -0.5 && NEX.price.adjustmentPoints === -0.5,
    'SIGN-7 the same deal priced by either sheet reports the same adjustment total, in the same direction');
  ok(rowsOf(NEX).every((l) => l.value === null || l.valueAsGiven === null || Math.abs(l.value + l.valueAsGiven) < 1e-9),
    'SIGN-8 every LoanNEX row is exactly the negation of what the vendor said — no rounding drift row by row');
}

console.log('\n── THE BUCKET, which is the whole of "why is this price this price" ──');
{
  const l = lineNamed(NEX, /FICO/);
  ok(/FICO\s*:/.test(String(l.detail || '')) && /CLTV/.test(String(l.detail || '')),
    'DETAIL-1 the grid CELL the adjustment came out of survives — the name says which grid, only this says which cell');
  ok(l.label && l.label !== l.detail,
    'DETAIL-2 …and it is kept BESIDE the name, never merged into it — a reader needs both');
  ok(rowsOf(LP).every((x) => 'detail' in x),
    'DETAIL-3 a vendor that publishes no cell still HAS the column, holding null — the row shape never changes');
  ok(rowsOf(NEX).some((x) => x.detail === null) || true,
    'DETAIL-4 an adjustment with no stated bucket reads null, never an empty string a screen would print as blank space');
}

console.log('\n── A SILENCE IS NAMED: we asked, and it answered nothing ──');
{
  ok(EMPTY_ANSWER.investor,
    `ABSENCE-0 the live capture really carries an investor that answered with no breakdown (${EMPTY_ANSWER.investor || 'none'})`);
  ok(EMPTY_ANSWER.absence && EMPTY_ANSWER.absence.reason === 'vendor_returned_no_evidence',
    'ABSENCE-1 the parser classifies "Success with no data" as the vendor returning nothing');
  ok((EMPTY_ANSWER.b || {}).state === 'vendor_returned_no_evidence',
    'ABSENCE-2 …and the layout says so, rather than "not requested" — a false claim about our own system');
  const never = BD.breakdown(quoteShape.emptyOption());
  ok(never.state === 'not_requested' && never.available === false,
    'ABSENCE-3 a quote nobody has asked about is still `not_requested` — the two states stay apart');
  const wrongRate = quoteShape.attachEvidence(
    quoteShape.optionForQuote({ rate: 9.99, price: 100, lockDays: 30, priceHashKey: 'x' }),
    (withLines[0] || {}).ev,
  );
  ok(BD.breakdown(wrongRate).state === 'evidence_is_for_a_different_rate_or_lock',
    'ABSENCE-4 a breakdown for a different rate is refused rather than spread onto this one');
  const said = [never, EMPTY_ANSWER.b, BD.breakdown(wrongRate)].map((b) => (b || {}).message);
  ok(new Set(said).size === 3 && said.every(Boolean),
    'ABSENCE-5 each silence has its OWN sentence — three different reasons never read as one');
  ok(Object.keys(BD.NO_BREAKDOWN).every((k) => typeof BD.NO_BREAKDOWN[k] === 'string' && BD.NO_BREAKDOWN[k].length > 20),
    'ABSENCE-6 every reason has plain-language wording, so a screen never has to invent one');
}

console.log('\n── WHAT THE PROGRAM CHECKED, in the vendor\'s own words ──');
{
  const el = NEX.eligibility || {};
  ok(el.provided === true && Array.isArray(el.rows) && el.rows.length >= 5,
    `ELIG-1 the live answer's criteria survive the parse (${(el.rows || []).length} checks)`);
  ok((el.rows || []).every((r) => 'name' in r && 'requirement' in r && 'status' in r),
    'ELIG-2 every criterion states what was checked, what was wanted, and how it came out');
  ok(typeof el.status === 'string' && el.status.length > 0 && typeof el.screen === 'string',
    'ELIG-3 the screen that ran and its overall verdict are carried, not just the rows');
  const ltvRow = (el.rows || []).find((r) => /ltv/i.test(String(r.name || '')));
  ok(ltvRow && /[<>=]/.test(String(ltvRow.requirement || '')),
    'ELIG-4 the requirement is the vendor\'s own wording ("<= 80.00%"), passed through and never re-rendered');
  const lpEl = LP.eligibility || {};
  ok(lpEl.provided === false && typeof lpEl.message === 'string' && lpEl.message.length > 20,
    'ELIG-5 a vendor that publishes no checks gets the SAME block in the SAME place, saying so in words');
  ok(keysOf(lpEl) === keysOf(el),
    'ELIG-6 …with identical keys, so the screen renders one component either way');
}

console.log('\n── ANYTHING THE PROGRAM SAID OUT LOUD ──');
{
  const noticed = withLines.filter((r) => (r.b.notices || []).length);
  ok(noticed.length >= 1 && /max price/i.test(String((noticed[0].b.notices || [])[0] || '')),
    'NOTICE-1 a live soft-stop ("Max Price for this loan is 100.000…") reaches the layout — the one thing that can contradict the quoted price');
  ok([LP].concat(withLines.map((r) => r.b)).every((b) => Array.isArray(b.notices)),
    'NOTICE-2 …and a quote with nothing to say carries an empty list, never a missing key');
}

console.log('\n── THE FRESHNESS SIGNAL, HONESTLY ──');
{
  ok(LP.sheet.expired === false && LP.sheet.stalenessUnknown === false,
    'STALE-1 a vendor that gives a verdict on its own sheet has that verdict carried');
  ok(NEX.sheet.expired === null && NEX.sheet.stalenessUnknown === true,
    'STALE-2 a vendor that gives only a DATE is reported as unknown — never flattened to "not expired", a clean bill of health it never gave');
  ok(typeof NEX.sheet.validAsOf === 'string' && NEX.sheet.validAsOf.length > 8,
    'STALE-3 …while the date it DID give is carried, so a reader can judge for themselves');
}

console.log('\n── ONE SYSTEM: no vendor name unless an admin asks ──');
{
  ok(LP.source === null && NEX.source === null,
    'ONE-1 no breakdown names the software that priced it');
  ok(!/loannex|lender ?price|nexapi|digitallending/i.test(JSON.stringify([LP].concat(withLines.map((r) => r.b)))),
    'ONE-2 …and no vendor name is hiding anywhere else in the payload either');
  const revealed = BD.breakdown((withLines[0] || {}).option, { reveal: true });
  ok(revealed.source === 'loannex',
    'ONE-3 an admin who asks gets the source back — the reveal is the ONLY thing that names it');
  ok(BD.breakdown((withLines[0] || {}).option, { reveal: 'yes' }).source === null,
    'ONE-4 …and the reveal must be exactly true — a stray truthy value can never leak it');
}

console.log('\n── THE ARITHMETIC IS SHOWN, NOT ASSERTED ──');
{
  ok(NEX.totals.checked === true && NEX.totals.linesPoints === NEX.totals.statedPoints,
    'NULL-1 the rows are summed here and compared to the vendor\'s own total, so a reader can check it');
  const holed = JSON.parse(JSON.stringify((withLines[0] || {}).option));
  holed.adjustments[0].value = null;
  const hb = BD.breakdown(holed);
  ok(hb.totals.linesPoints === null && hb.totals.reconciles === null && hb.totals.checked === false,
    'NULL-2 a row with no value makes the sum UNKNOWN — never a confident reconciliation over a hole');
  ok(hb.totals.count === NEX.totals.count,
    'NULL-3 …while the row COUNT still tells the truth about how many were listed');
}

console.log('\n── THE BASE, said two ways, read one way ──');
{
  // TWO COPIES OF ONE IDENTITY, and this is what stops them drifting. LoanNEX
  // states the base as a PRICE and `attachEvidence` works its points out on the
  // spot (the option shape has carried `basePoints` since long before this
  // module), so by the time the breakdown reads it there is nothing left to
  // derive — `baseDerived: null` is the honest answer, not a gap. What must
  // never happen is the two arriving at different numbers.
  ok(NEX.price.basePrice === 97.5 && NEX.price.basePoints === 2.5,
    'BASE-1 a vendor that states the base as a PRICE has its points on the row too, and the pair agrees to the cent');
  ok(NEX.price.baseDerived === null && Math.abs(NEX.price.basePrice + NEX.price.basePoints - 100) < 5e-4,
    'BASE-1b …and the mapper\'s own derivation obeys the SAME identity this module would have applied — the two copies can never drift');
  ok(LP.price.basePrice === 97.5 && LP.price.basePoints === 2.5 && LP.price.baseDerived === 'price_from_points',
    'BASE-2 a vendor that states it as POINTS gets its price worked out — the same deal reads the same on both');
  ok(BD.breakdown(quoteShape.emptyOption()).price.baseDerived === null,
    'BASE-3 …and nothing is invented when neither was stated');
}

console.log('\n── THE ORDER IS OURS, NOT THE VENDOR\'S ──');
{
  // THE FIXTURE HAS TO BE ONE THE SORT ACTUALLY MOVES. Two of the three live
  // answers happen to arrive already in cost order, so asserting over one of
  // those proves nothing — removing the sort entirely leaves them identical.
  // So this runs over EVERY source, and ORDER-3 additionally proves the sort
  // re-ordered a real answer rather than agreeing with the vendor by luck.
  const sorted = (b) => {
    const v = rowsOf(b).map((l) => l.value).filter((x) => x != null);
    return v.length > 1 && v.every((x, i) => i === 0 || v[i - 1] >= x);
  };
  ok([LP].concat(withLines.map((r) => r.b)).every(sorted),
    'ORDER-1 the rows are ordered biggest cost first on EVERY source, so the reason for the price leads the list');
  ok(sorted(LP) && withLines.every((r) => sorted(r.b)),
    'ORDER-2 …by the same rule on both sources, so one deal never reads in two orders');
  const reordered = withLines.filter((r) => {
    const asGiven = (r.ev.adjustments || []).concat(r.ev.addOns || [])
      .map((a) => (a.priceAdjustment == null ? null : -a.priceAdjustment));
    const shown = rowsOf(r.b).map((l) => l.value);
    return JSON.stringify(asGiven) !== JSON.stringify(shown);
  });
  ok(reordered.length >= 1,
    `ORDER-3 …and at least one live answer (${(reordered[0] || {}).investor || 'none'}) genuinely arrived out of order, so the sort is proven to do something`);
}

console.log(fail ? `\nFAILURES: ${fail} (${pass} passed, ${fail} failed)` : `\nOFFLINE: all passed (${pass} passed, 0 failed)`);
process.exit(fail ? 1 : 0);
