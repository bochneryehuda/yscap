'use strict';
/**
 * LT test — THE COMPARISON SHEET LOST THREE PAGES AND NOT ONE FACT.
 *
 * A comparison used to restate every option IN FULL after the table — programme,
 * purpose, loan amount, LTV, term, rate, prepayment, the payment breakdown, the
 * rent, the DSCR, the charges and the closing totals — on a page each. MEASURED
 * on a real render, that was three of a seven-page sheet, and every figure on
 * those pages already sat in the table or in the shared block above them. The
 * owner read one and said so: *"everything is way too big … just thrown on the
 * sheet without an order."*
 *
 * Dropping the repeat is easy. Dropping it WITHOUT QUIETLY LOSING SOMETHING is
 * the whole job, and it is not something a person can check by eye on one sample:
 * a fact that only ever showed on those pages — the rent, the credit score, the
 * split of the lender's own fees — would simply stop being on the paper, on a
 * document that goes out for signature, and nothing would say so.
 *
 * ⛔ SO THE PROOF IS COMPUTED, NEVER A LIST SOMEBODY KEEPS. `optionBlocks` and
 * `loanRows` are still exported and still built here, and every LABEL they would
 * have printed must appear in the comparison table's rows or in its shared block.
 * Add a row to the per-option blocks and this build fails until the table carries
 * it too — which is the only way the two can be kept in step by anything other
 * than memory.
 *
 * It runs the check over several SHAPES, because which rows appear at all is
 * decided by the data: a waived-fee option, an escrow waiver, dues, an
 * interest-only term and a scenario sheet whose options disagree about the
 * property each light up rows the plain case does not.
 */

const layout = require('../src/longterm/termsheet/layout.js');
const snapshot = require('../src/longterm/termsheet/snapshot.js');
const comparison = require('../src/longterm/termsheet/comparison.js');
const wording = require('../src/longterm/termsheet/wording.js');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const BASE = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
const sc = (o) => Object.assign({}, BASE, o || {});
const q = (label, ratePct, rawPrice, scenario, extra) => Object.assign({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario: scenario || BASE, pricedAt: '2026-08-30T13:30:00.000Z',
}, extra || {});

function build(selections) {
  const out = snapshot.buildSnapshot({
    selections, plan: PLAN, anchorIndex: 0,
    prepared: { borrowerName: 'Jonathan Reyes', propertyAddress: '18 Sycamore Ln, Lakewood, NJ 08701' },
  });
  if (!out.ok) throw new Error(`snapshot refused: ${out.error}`);
  return out.snapshot;
}

/**
 * The shapes. Each exists to light up a row the others do not — a suite that
 * only ever ran the plain case would prove the plain case.
 */
const SHAPES = {
  'same loan, three prices': [
    q('A', 7.375, 102), q('B', 7.125, 100.5), q('C', 6.875, 98.75),
  ],
  'different loan amounts (a scenario sheet)': [
    q('A', 6.75, 100, sc({ loan: 375000, ltv: 75 })),
    q('B', 7.0, 100, sc({ loan: 425000, ltv: 85, dscr: 1.15 })),
    q('C', 7.25, 100, sc({ loan: 450000, ltv: 90, dscr: 1.08 })),
  ],
  'one option waives the lender fees': [
    q('A', 7.375, 102.5, BASE, { mode: 'lenderPaid' }),
    q('B', 7.75, 103.5, BASE, { mode: 'lenderPaid', waiveLenderFees: true }),
  ],
  'escrows waived, dues charged, interest only': [
    q('A', 7.375, 102, sc({ escrowWaive: true, hoaMonthly: 210, interestOnly: true })),
    q('B', 7.125, 100.5, sc({ hoaMonthly: 210 })),
  ],
  'the options disagree about the property itself': [
    q('A', 7.375, 102, sc({ value: 500000, propertyType: 'Single family' })),
    q('B', 7.125, 100.5, sc({ value: 650000, propertyType: 'Multifamily 2-4', units: 3 })),
  ],
  'prepayment differs': [
    q('A', 7.375, 102, sc({ prepayMonths: 60, prepayStructure: '5 Year' })),
    q('B', 7.625, 102, sc({ prepayMonths: 36, prepayStructure: '3 Year' })),
  ],
};

/** Every label the retired per-option pages would have printed, for one member. */
function retiredLabels(m) {
  const out = [];
  for (const r of layout.loanRows(m)) if (r && r[0]) out.push(String(r[0]));
  for (const b of layout.optionBlocks(m)) {
    if (b && b.t === 'figures') {
      for (const r of b.rows || []) if (r && r[0]) out.push(String(r[0]));
    }
  }
  return out;
}

/**
 * ⛔ TWO LABELS THAT MEAN ONE THING. The per-option block spelled a few rows for
 * a page it owned outright; the table spells the same fact for a column two
 * inches wide. These are the ONLY rewordings allowed, and each is named with the
 * fact it is about — a bare "close enough" match here would let a genuinely
 * missing row pass as a renamed one, which is exactly the failure being guarded.
 */
const SAME_FACT = {
  // The block spelled these out on a page it owned; the table says the same fact
  // in a column two inches wide.
  'Loan to value': 'LTV',
  'Interest rate': 'Rate',
  // The block named the position; the table's row is the position.
  'Lender charges at closing, net': 'Lender charges, net',
  'Lender credit at closing, net': 'Lender charges, net',
  // The block totalled two fees it had just listed. The table lists them too,
  // and a total of two visible numbers is not a fact — it is arithmetic.
  'Lender fees, total': null,
  'Lender fees you are not paying': null,
};

/**
 * TWO LABELS ARE GENERATED, so they cannot be listed: `wording.housingCost`
 * composes the payment's name from whichever parts the scenario carries (…&
 * insurance, …& taxes, …, insurance & dues), and the block puts the down
 * payment's percentage INSIDE its label while the column puts it in the value.
 * Both are matched on the part that is FIXED, and the fixed part is the fact —
 * a normalisation that swallowed anything more would let a genuinely missing row
 * pass as a renamed one, which is the failure this file exists to catch.
 */
const GENERATED = [
  [/^Total monthly payment\b/, 'Total monthly payment'],
  [/^Down payment\b/, 'Down payment'],
];

console.log('\nevery fact the retired per-option pages carried is still on the sheet');

for (const [name, selections] of Object.entries(SHAPES)) {
  const snap = build(selections);
  const table = layout.comparisonTable(snap);
  const have = new Set();
  for (const r of table.rows || []) if (r && r[0]) have.add(String(r[0]));
  for (const r of table.shared || []) if (r && r[0]) have.add(String(r[0]));

  const missing = [];
  for (const m of snap.members) {
    for (const label of retiredLabels(m)) {
      const gen = GENERATED.find(([re]) => re.test(label));
      if (gen) {
        if (!have.has(gen[1])) missing.push(`${label} (as "${gen[1]}")`);
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(SAME_FACT, label)) {
        const alias = SAME_FACT[label];
        if (alias === null) continue;      // arithmetic over rows already shown
        if (have.has(alias)) continue;
        missing.push(`${label} (as "${alias}")`);
        continue;
      }
      if (!have.has(label)) missing.push(label);
    }
  }
  check(missing.length === 0,
    `${name}: nothing dropped${missing.length ? ` — missing: ${[...new Set(missing)].join(', ')}` : ''}`);

  // A shape that produced no per-option rows would pass the check above by
  // finding nothing to look for.
  const produced = snap.members.reduce((n, m) => n + retiredLabels(m).length, 0);
  check(produced > 10, `${name}: the retired pages really did carry rows (${produced}) — otherwise the check above is vacuous`);
}

console.log('\nand the sheet says each fact ONCE — the reason the pages went');

{
  const snap = build(SHAPES['same loan, three prices']);
  const table = layout.comparisonTable(snap);
  const sharedKeys = (table.shared || []).map((r) => r[0]);
  const rowKeys = (table.rows || []).map((r) => r[0]);
  const both = sharedKeys.filter((k) => rowKeys.includes(k));
  check(both.length === 0,
    `no fact is stated in the shared block AND as its own row${both.length ? ` — ${both.join(', ')}` : ''}`);
  check(sharedKeys.length >= 8,
    `the shared block is carrying the repetition (${sharedKeys.length} facts stated once instead of ${sharedKeys.length * snap.members.length} times)`);

  // ⛔ A ROW THE OPTIONS DISAGREE ON IS NEVER FOLDED. This is the owner's own
  // report — *"when it's saying that this and this amount is the same on all
  // scenarios (5-year Pre-pay Penalty), when in truth there can be different
  // scenarios with different amounts."* The fold is computed from the printed
  // values, so it cannot claim a shared term that is not shared; this pins it.
  const mixed = build(SHAPES['prepayment differs']);
  const mt = layout.comparisonTable(mixed);
  check(!(mt.shared || []).some((r) => r[0] === 'Prepayment'),
    'THE ONE THAT MATTERS: a prepayment the options disagree about is never lifted into "the same in all"');
  const prow = (mt.rows || []).find((r) => r[0] === 'Prepayment');
  check(prow && prow[1] !== prow[2],
    '…it keeps its own row, and the two columns say the two different terms');
}

/* ─────────────────────────────────────────────────────────────────────────
   THE TWO FORMULAS, HELD TO THE OWNER'S OWN ARITHMETIC.

   Both were corrected on the owner's working (2026-08-31) and both were then
   pinned by NOTHING — the worked examples lived in a comment above the function,
   where a change to the formula cannot fail. These decide what a borrower is
   told the extra money costs them and when they get their closing cash back, so
   they are held to the numbers the owner did by hand, and to the definition
   itself computed the long way beside the engine's answer.
   ───────────────────────────────────────────────────────────────────────── */
console.log('\nthe cost of the extra borrowing is the owner\'s own arithmetic');

{
  const mk = (loan, rate) => ({ loanAmount: loan, ratePct: rate, monthlyPI: 1 });
  // *"the actual contractual interest rate on that extra $25,000 is still 6.75%."*
  check(comparison.incrementalCostPct(mk(400000, 6.75), mk(375000, 6.75)) === 6.75,
    'the owner\'s first example: 375,000 and 400,000 both at 6.75% answers 6.75% — borrowing more at the same rate costs that rate and nothing else');
  // *"400,000 at 6% against 500,000 at 7% … effectively, on the extra 100,000,
  //   you're paying about 12%"* — their own hand-working (1 point on 400,000 is
  //   4 points of the extra 100,000, plus the 7 on the slice) comes to 11.
  check(comparison.incrementalCostPct(mk(500000, 7), mk(400000, 6)) === 11,
    'the owner\'s second example: 400,000 at 6% against 500,000 at 7% answers 11.00% — the extra slice AND the re-pricing of every dollar already borrowed');
  // The definition itself, computed the long way, on a third case neither
  // example covers — so the two above cannot be satisfied by a lookup table.
  const big = mk(612500, 7.875); const small = mk(431000, 6.125);
  const longWay = ((612500 * 0.07875) - (431000 * 0.06125)) / (612500 - 431000) * 100;
  check(Math.abs(comparison.incrementalCostPct(big, small) - Math.round(longWay * 100) / 100) < 0.005,
    `…and on an arbitrary third pair it is the definition worked out longhand (${Math.round(longWay * 100) / 100}%)`);
  // A cheaper blended cost on a BIGGER loan is real and is returned, not hidden.
  // 500,000 at 4% pays 20,000 a year; 400,000 at 6% pays 24,000. The bigger loan
  // costs LESS in total, so the extra 100,000 has a negative cost — real, and
  // returned rather than suppressed, because it is the best news on the page.
  check(comparison.incrementalCostPct(mk(500000, 4), mk(400000, 6)) === -4,
    'a bigger loan whose better rate cuts the total interest answers a NEGATIVE cost (-4%) rather than being suppressed — it is a real and useful answer');
  check(comparison.incrementalCostPct(mk(375000, 7), mk(375000, 7)) === null,
    'two loans of the same size have no gap to price, and it says so rather than dividing by zero');
}

console.log('\nand the break-even is the month the closing money is paid back');

{
  const snap = build(SHAPES['same loan, three prices']);
  const cmp = snap.comparison;
  let checked = 0;
  for (const r of cmp.rows) {
    if (r.isAnchor || !Number.isFinite(r.breakEvenMonths)) continue;
    const longWay = -r.deltaCostDollars / r.deltaMonthlyDollars;
    check(Math.abs(longWay - r.breakEvenMonths) < 0.06,
      `${snap.members[r.index].label}: ${r.breakEvenMonths} months is the ${Math.abs(r.deltaCostDollars)} paid at closing divided by the ${Math.abs(r.deltaMonthlyDollars)} saved every month (${longWay.toFixed(1)})`);
    checked += 1;
  }
  check(checked >= 2, `…on every option that has one (${checked}) — a fixture producing none would prove nothing`);

  // ⛔ IT REFUSES RATHER THAN INVENTING ONE. An option that costs more today AND
  // more every month never pays back, and a "break-even" on it would tell a
  // borrower to wait for a month that is not coming.
  const worse = { monthlyPI: 3000, charges: { lines: [{ key: 'buydown', dollars: 5000 }] }, closing: {} };
  const better = { monthlyPI: 2500, charges: { lines: [] }, closing: {} };
  check(comparison.breakEvenMonths(worse, better) === null,
    'THE ONE THAT MATTERS: an option that costs more at closing AND more every month gets no break-even — it never pays back, and a number there would say it does');
}

console.log('\nand the page never states two different DSCRs');

{
  /* ⛔ FOUND BY RENDERING, NOT BY READING. The table derives the ratio from the
     total payment it prints beside it; the sentence beneath read the single
     figure the board priced on. MEASURED on a real scenario sheet, one page said
     `DSCR 1.09` in the column and *"moves from 1.24 to 1.15"* in the paragraph
     directly under it — both honestly computed, and a reader dividing the two
     numbers printed above gets only one of them. */
  const snap = build(SHAPES['different loan amounts (a scenario sheet)']);
  const table = layout.comparisonTable(snap);
  const drow = (table.rows || []).find((r) => r[0] === 'DSCR');
  check(!!drow, 'the scenario sheet prints a DSCR per option');

  const cmp = snap.comparison;
  const anchor = snap.members[cmp.anchorIndex];
  const shown = (m) => layout.shownDscr(m, layout.paymentRows(m)).value;
  let checked = 0;
  for (const r of cmp.rows) {
    if (r.isAnchor) continue;
    const m = snap.members[r.index];
    const sentence = wording.incrementalSentence(r, m, anchor, {
      member: shown(m), anchor: shown(anchor),
    });
    if (!sentence || !/DSCR moves from/.test(sentence)) continue;
    const [, from, to] = sentence.match(/DSCR moves from (\d+\.\d+) to (\d+\.\d+)/) || [];
    const colIndex = (table.head || []).findIndex((h) => String(h).startsWith(m.label));
    check(to === String(drow[colIndex]),
      `THE ONE THAT MATTERS: ${m.label}'s sentence says ${to} and its own column says ${drow[colIndex]} — the same page may not state two`);
    check(from === String(drow[1]),
      `…and the ratio it compares from is the anchor's own column (${drow[1]})`);
    checked += 1;
  }
  check(checked >= 2, `…on every option that names one (${checked})`);
}

console.log('\nand the layout no longer builds the repeat');

const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'src/longterm/termsheet/layout.js'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check(!/for \(const m of s\.members\) \{[\s\S]{0,200}optionBlocks\(m\)/.test(src),
  'the per-member page loop is gone from the comparison branch — a guard on the RENDER alone would pass the day somebody re-added it behind a flag');
/* ⛔ AND THE TERM SHEET STILL PRINTS EVERY ONE OF THEM — PROVEN ON A BUILT
   LAYOUT, NOT ON THE SHAPE OF A LINE OF SOURCE.
   This asserted that layout.js literally contained `blocks.push(...optionBlocks(first))`,
   which was a PROXY for the property that matters and stopped being true the day
   the term sheet's body was re-arranged into two columns. A source-shape guard
   also cannot see whether the rows reach the page — it only sees that a function
   was called. So the property is asserted directly: build a real term sheet and
   require every label the shared per-option blocks would print to be on it.
   `textOf` walks the block tree, so a row nested inside a container is found
   exactly as a top-level one is — which is what stops this going quiet the next
   time the page is re-arranged. */
function textOfBlocks(blocks) {
  const out = [];
  const walk = (v) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') Object.keys(v).forEach((k) => walk(v[k]));
  };
  walk(blocks);
  return out;
}
{
  const snap = build([q('Only', 7.375, 102, sc({ escrowWaive: true, hoaMonthly: 55 }))]);
  const m = snap.members[0];
  const blocks = layout.buildLayout(snap, { code: 'TS-NOTHINGLOST', expiryHours: 24 }).blocks;
  const drawn = new Set(textOfBlocks(blocks));
  const want = retiredLabels(m);
  check(want.length >= 12, `the shared per-option blocks name ${want.length} labels — a fixture producing a handful would prove nothing`);
  const missing = want.filter((l) => !drawn.has(l));
  check(missing.length === 0,
    `…and a SINGLE term sheet prints every one of them (${want.length} labels, ${missing.length} missing${missing.length ? `: ${missing.join(', ')}` : ''})`);
  // The control: the sweep can tell a missing label from a present one.
  check(!drawn.has('A label no sheet has ever printed'),
    '…and the sweep would notice one that was not there — the control');
}

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exit(failures ? 1 : 0);
