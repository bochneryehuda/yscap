/**
 * ALL THREE DOCUMENTS READ A LoanNEX PROGRAM EXACTLY LIKE A LENDER PRICE ONE.
 *
 * ── THE OWNER'S ASK ────────────────────────────────────────────────────────
 * 2026-09-03: *"we need to make sure that the system understands the new programs exactly the same,
 * and all three PDFs (the term sheet and the comparisons) operate the same. It works exactly the
 * same with programs, no matter what the source is. It understands the numbers correctly, doesn't
 * display the margin holdback stats, and everything is the same … no matter if our system is adding
 * to the holdback or if the holdback is already there … The PDF needs to understand everything the
 * same, which is the pricing after the holdback for the programs that have holdbacks."*
 *
 * Three documents, and the owner's three requirements, are what this pins:
 *
 *   term sheet · comparison sheet · scenario comparison   (`snapshot.DOC_KINDS`)
 *
 *   1. THE SAME, WHATEVER PRICED IT. A LoanNEX-sourced option and a Lender Price one describing the
 *      same loan produce the same member, the same snapshot hash and the same rendered document —
 *      BYTE FOR BYTE, on all three.
 *   2. THE NUMBERS ARE THE HELD-BACK ONES. A LoanNEX price reaches the browser with our margin
 *      already taken out (`vendor-margin.applyToBoard` runs before the merge), so the figure the
 *      document is built from is the one on the board, never the vendor's own.
 *   3. NOTHING ABOUT THE HOLDBACK, THE VENDOR OR THE INVESTOR IS ON THE PAGE.
 *
 * ── WHY THE LoanNEX HALF IS DRIVEN THROUGH THE REAL PIPELINE ───────────────
 * A fixture hand-written to look like a LoanNEX row proves the document reads THAT OBJECT, which is
 * a fact about the fixture. So the vendor payload here goes through the actual chain the board runs
 * — `parse` then `vendor-margin.applyToBoard` then `quote-shape.programsFromLoanNex` — and the
 * option this suite hands the document is the one that chain produced. If any step starts leaking a
 * figure or a name onto the row, this fails.
 *
 * AND THE SELECTION IS BUILT ONCE, FROM THE BOARD'S OWN FIELDS. `LtPricer.selectionFor` is the
 * browser's mapping from a board option to the thing the export door is posted; a JSX file cannot be
 * required here, so section A asserts against ITS SOURCE that this suite reads the same fields it
 * does. A mirror nobody holds to the original is a fixture pretending to be a proof.
 *
 * Sections: A the mapping · B one loan, two vendors, one member · C the held-back number ·
 *           D all three documents, identical · E swept for a tell ·
 *           G an unnamed programme is refused · F what must not move.
 *
 * ── PROVEN TO FAIL ─────────────────────────────────────────────────────────
 * Six mutations of the production code, each with a green control either side:
 *
 *   1. the member is spread from the selection ...................... red
 *   2. the member carries the `internal` block ...................... red
 *   3. `internal` becomes a key on the snapshot ..................... red
 *   4. the holdback stops being applied to the board ................ red
 *   5. the row falls back to the investor's real name ............... red
 *   6. an unnamed programme prints blank instead of refusing ........ red
 *
 * ⛔ AND MUTATION 5 FOUND A REAL GAP RATHER THAN CONFIRMING ONE. It went GREEN on the first pass:
 * every section above prices a row that HAS a white label, so a change making the row fall back to
 * the investor's own name when it has none was never reached. Section G is that missing case, and
 * it is the one place the source can leak by ACCIDENT rather than by design.
 *
 * PURE: no network, no database, no RTL import.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = (p) => require(path.join(ROOT, p));

const parse = R('src/longterm/loannex/parse');
const vendorMargin = R('src/longterm/pricing/vendor-margin');
const quoteShape = R('src/longterm/pricing/quote-shape');
const snapshot = R('src/longterm/termsheet/snapshot');
const layout = R('src/longterm/termsheet/layout');

let pass = 0;
const ok = (c, n) => { assert.ok(c, n); pass++; console.log('  ok  ' + n); };
const eq = (a, b, n) => { assert.deepStrictEqual(a, b, `${n} — got ${JSON.stringify(a)}, want ${JSON.stringify(b)}`); pass++; console.log('  ok  ' + n); };

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

/* The compensation plan and the deal. Internally consistent on purpose: 375,000 at 7.375% over 30
   years is 2,590.03 a month; with 620 tax and 145 insurance that is 3,355.03, and 4,161 of rent is
   the 1.24 ratio the option claims — a deal the export gate would actually issue. */
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 4161, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
const PREPARED = { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein' };

/**
 * THE BROWSER'S OWN MAPPING, from a board option to the export door's selection — the fields
 * `LtPricer.selectionFor` reads, and section A holds this to that source. `internal` carries the
 * vendor's real identity ON PURPOSE: it is what the staff-side record keeps, and the whole claim
 * below is that it reaches the document nowhere.
 */
function selectionFrom(q, extra = {}) {
  return {
    consumerLabel: q.consumerLabel || q.whiteLabel || null,
    product: q.product || q.program || null,
    label: null,
    mode: 'borrowerPaid',
    waiveLenderFees: false,
    ratePct: q.noteRate,
    rawPrice: q.price,
    vendorMonthlyPI: q.monthlyPi,
    internal: {
      investor: q.investor || null,
      investorKey: q.investorKey != null ? q.investorKey : null,
      lender: q.lender || null,
      program: q.program || null,
      product: q.product || null,
      rateSheet: q.sheet || null,
      rateGridId: q.rateGridId != null ? q.rateGridId : null,
      rawPrice: q.price,
      adjustedPoints: q.adjustedPoints,
    },
    pricedAt: '2026-08-30T13:30:00.000Z',
    pricedDscr: null,
    scenario: SCENARIO,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
console.log('\nA · this suite reads the fields the browser reads');
// ---------------------------------------------------------------------------
{
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/LtPricer.jsx'), 'utf8'));
  const block = src.slice(src.indexOf('selectionFor: (q, o) => ({'), src.indexOf('pricedDscr:'));
  ok(block.length > 200, 'A0 (located the browser\'s selection builder)');
  for (const k of ['consumerLabel', 'product', 'mode', 'ratePct', 'rawPrice', 'vendorMonthlyPI', 'internal']) {
    ok(new RegExp(`(^|\\s)${k}:`, 'm').test(block), `A1 the browser's selection carries \`${k}\`, and so does this suite's`);
  }
  ok(/rawPrice: q\.price/.test(block),
    'A2 …and the price it sends is the BOARD\'S price — which on a LoanNEX row is the held-back one');
  ok(/investor: q\.investor/.test(block) && /lender: q\.lender/.test(block),
    'A3 …and the vendor\'s real identity travels in `internal`, which is what section E proves never reaches the page');
}

// ---------------------------------------------------------------------------
console.log('\nB · one loan, two vendors, one member');
// ---------------------------------------------------------------------------
/**
 * A LoanNEX payload in the shape `/quick-prices` really answers, driven through the REAL chain.
 * The vendor's own price is 104.1762; the standing 0.25 holdback takes the board to 103.926.
 */
const RAW = {
  status: 'Success',
  data: {
    investors: [{ id: 7233, name: 'NQM Funding', organizationGuid: 'g-nqm' }],
    programs: [{ id: 1382, name: 'CORR: Investor - DSCR', programCode: 'C9001' }],
    products: [{ id: 38068, mortgageProductId: 900 }],
    mortgageProducts: [{ id: 900, description: '30 Yr. Fixed', amortizationType: 'Fixed', termInMonths: 360, isInterestOnly: false }],
    prices: [
      { rate: 7.375, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.24, payment: 2590.03,
        priceHashKey: '38068-1382-33114-5316',
        lockTermPrices: [{ lockDays: 30, price: 104.1762, cushionedLockDays: 30 }] },
      { rate: 6.875, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.24, payment: 2463.17,
        priceHashKey: '38068-1382-33114-5317',
        lockTermPrices: [{ lockDays: 30, price: 101.75, cushionedLockDays: 30 }] },
      { rate: 7.875, investorId: 7233, programId: 1382, productId: 38068, dscr: 1.24, payment: 2719.46,
        priceHashKey: '38068-1382-33114-5318',
        lockTermPrices: [{ lockDays: 30, price: 105.9, cushionedLockDays: 30 }] },
    ],
  },
};

const heldBoard = vendorMargin.applyToBoard(parse.parse(RAW), 'loannex', {});
const nexRows = quoteShape.programsFromLoanNex(heldBoard, {
  transactionId: 'txn-1', investorKey: 'nqm', whiteLabel: 'Platinum',
});
const nexOpts = nexRows[0].options.slice().sort((a, b) => a.priceBuild.noteRate - b.priceBuild.noteRate);

/** A board option, in the shape the screen's rate stack hands `selectionFor`. */
const asQuote = (o, row) => ({
  noteRate: o.priceBuild.noteRate,
  price: o.priceBuild.price,
  monthlyPi: o.monthlyPayment ? o.monthlyPayment.monthlyPI : null,
  consumerLabel: row.consumerLabel,
  whiteLabel: row.whiteLabel,
  product: (o.terms && o.terms.product) || row.product,
  program: row.program,
  investor: row.investor,
  lender: row.lender,
  investorKey: row.investorKey,
  sheet: null,
  rateGridId: row.rateGridId,
  adjustedPoints: o.priceBuild.adjustedPoints,
});

/** The Lender Price twin: the same loan at the same board price, from the other programme. */
const asLenderPrice = (q) => ({
  ...q,
  investor: 'Some Other Investor',
  lender: 'Lender Price',
  investorKey: 'lp-investor',
  program: 'Their own programme name',
  sheet: 'LP DSCR sheet 2026-09-01',
});

{
  const q = asQuote(nexOpts.find((o) => o.priceBuild.noteRate === 7.375), nexRows[0]);
  eq(q.price, 103.926, 'B1 the board price is the vendor\'s 104.1762 with our 0.25 taken out');

  const nexM = snapshot.buildMember(selectionFrom(q), PLAN);
  const lpM = snapshot.buildMember(selectionFrom(asLenderPrice(q)), PLAN);
  ok(nexM.ok && lpM.ok, `B2 both build${nexM.ok && lpM.ok ? '' : ` — ${nexM.error || lpM.error}`}`);
  eq(JSON.stringify(nexM.member), JSON.stringify(lpM.member),
    'B3 THE MEMBERS ARE BYTE-IDENTICAL — the document cannot tell which programme priced it');

  /* And the fields that would tell it apart are on NEITHER, so B3 is not two copies of one leak. */
  for (const k of ['investor', 'lender', 'lenderId', 'rateSheetName', 'source', 'vendor',
    'marginHoldback', 'vendorPrice', 'priceExact', 'priceSeal', 'rawPrice', 'internal']) {
    ok(!(k in nexM.member), `B4 \`${k}\` is not a key on the member`);
  }

  /* The staff-side record DOES keep the vendor, and that is the other half of the rule: the
     question "who really funds this?" stays answerable, just not on the borrower's page. */
  const built = snapshot.buildSnapshot({ selections: [selectionFrom(q)], plan: PLAN, prepared: PREPARED });
  ok(built.ok, 'B5 a snapshot builds from a LoanNEX option');
  ok(Array.isArray(built.internal) && built.internal[0] && built.internal[0].investor === 'NQM Funding',
    'B6 the vendor\'s real investor IS recorded, staff-side');
  ok(!('internal' in built.snapshot),
    'B7 …and `internal` is a SIBLING of the snapshot, not a key on it — nothing that renders, hashes or replays the document can reach it');
}

// ---------------------------------------------------------------------------
console.log('\nC · the numbers are the held-back ones');
// ---------------------------------------------------------------------------
{
  const q = asQuote(nexOpts.find((o) => o.priceBuild.noteRate === 7.375), nexRows[0]);
  const held = snapshot.buildMember(selectionFrom(q), PLAN);
  /* The same option priced from the VENDOR'S OWN number — what the document would say if the
     holdback were dropped anywhere between the board and the page. */
  const raw = snapshot.buildMember(selectionFrom({ ...q, price: 104.1762 }), PLAN);
  ok(held.ok && raw.ok, 'C0 (both build)');
  ok(held.member.charges.displayPrice !== raw.member.charges.displayPrice,
    'C1 the two are genuinely different documents — so C2 is not comparing a number to itself');
  ok(Math.abs(held.member.charges.displayPrice - (103.926 - 2)) < 0.0005,
    `C2 the document is priced from the BOARD's 103.926, not the vendor's 104.1762 (${held.member.charges.displayPrice})`);

  /* AND THE HOLDBACK IS NOT RECOVERABLE FROM THE DOCUMENT. Every number anywhere on the member is
     swept: none of them may be 0.25 away from another, which is what "does not display the margin
     holdback stats" means when it is written as a property rather than as a field name. */
  const nums = [];
  (function walk(v) {
    if (v == null) return;
    if (typeof v === 'number' && Number.isFinite(v)) { nums.push(v); return; }
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v === 'object') { Object.values(v).forEach(walk); }
  }(held.member));
  const pairs = [];
  for (let i = 0; i < nums.length; i += 1) {
    for (let j = i + 1; j < nums.length; j += 1) {
      if (Math.abs(Math.abs(nums[i] - nums[j]) - 0.25) < 0.0005) pairs.push([nums[i], nums[j]]);
    }
  }
  eq(pairs.length, 0, `C3 no two figures on the member are the holdback apart — ${JSON.stringify(pairs.slice(0, 4))}`);
  ok(!nums.some((n) => Math.abs(n - 104.1762) < 0.0005),
    'C4 …and the vendor\'s own price appears nowhere on it');

  /**
   * THE OWNER'S OTHER CLAUSE, IN ONE PAIR OF ASSERTIONS: *"no matter if our system is adding to the
   * holdback or if the holdback is already there."* A LoanNEX row with the holdback turned OFF
   * reaches the board at the vendor's own figure — which is what a Lender Price row does, since
   * that sheet is quoted at the price we sell at. The document must not be able to tell those two
   * apart either, so it is built from a board priced with NO holdback and compared to the Lender
   * Price twin at that same price.
   */
  /* The saved setting is `opts.saved` — `resolveHoldback`'s own second argument, which is what an
     admin turning the holdback off actually writes. `{ points: 0 }` is not that shape and was
     silently ignored, which is how the first cut of C5 read 103.926 and failed. */
  const noHold = vendorMargin.applyToBoard(parse.parse(RAW), 'loannex', { saved: 0 });
  const noHoldRows = quoteShape.programsFromLoanNex(noHold, {
    transactionId: 'txn-1', investorKey: 'nqm', whiteLabel: 'Platinum',
  });
  const nq = asQuote(noHoldRows[0].options.find((o) => o.priceBuild.noteRate === 7.375), noHoldRows[0]);
  eq(nq.price, 104.176,
    'C5 with the holdback off the board carries the vendor\'s own price, rounded for the screen');
  const a = snapshot.buildMember(selectionFrom(nq), PLAN);
  const b = snapshot.buildMember(selectionFrom(asLenderPrice(nq)), PLAN);
  ok(a.ok && b.ok, 'C5a (both build)');
  eq(JSON.stringify(a.member), JSON.stringify(b.member),
    'C6 …and the document is STILL identical to the other programme\'s — the page never asks whether a holdback was taken');
}

// ---------------------------------------------------------------------------
console.log('\nD · all three documents, built both ways, identical');
// ---------------------------------------------------------------------------
/** The same three options, once from each vendor. The two lists differ ONLY in `internal`. */
function selections(fromNex) {
  return nexOpts.map((o) => {
    const q = asQuote(o, nexRows[0]);
    return selectionFrom(fromNex ? q : asLenderPrice(q));
  });
}
/**
 * A scenario comparison is the SAME option at three loan amounts — workflow B.
 *
 * `vendorMonthlyPI` is dropped on these, and the reason is a production guard doing its job rather
 * than a workaround: `buildMember` refuses a member whose vendor payment and our own disagree by
 * more than a dollar, so carrying the 375,000 option's payment onto a 350,000 one is a
 * `payment_disagreement` — which is exactly right, and is what the first cut of this fixture did.
 * A board asked for a different loan amount states that amount's own payment; a cart entry that
 * never carried one leaves the cross-check unrun, which is the honest shape here.
 */
function scenarioSelections(fromNex) {
  const base = selections(fromNex)[0];
  return [375000, 350000, 400000].map((loan, i) => ({
    ...base,
    vendorMonthlyPI: null,
    scenario: { ...SCENARIO, loan, ltv: Math.round((loan / SCENARIO.value) * 100) },
    label: `Option ${i + 1}`,
  }));
}

const DOCS = [
  ['term sheet', (nex) => [selections(nex)[0]]],
  ['comparison sheet', (nex) => selections(nex)],
  ['scenario comparison', (nex) => scenarioSelections(nex)],
];
const built = {};
for (const [name, make] of DOCS) {
  const a = snapshot.buildSnapshot({ selections: make(true), plan: PLAN, anchorIndex: 0, prepared: PREPARED });
  const b = snapshot.buildSnapshot({ selections: make(false), plan: PLAN, anchorIndex: 0, prepared: PREPARED });
  ok(a.ok && b.ok, `D1 the ${name} builds from both${a.ok && b.ok ? '' : ` — ${a.error || b.error}`}`);
  built[name] = a;
  const la = layout.buildLayout(a.snapshot, { code: 'TS-4KH92B', expiryHours: 48 });
  const lb = layout.buildLayout(b.snapshot, { code: 'TS-4KH92B', expiryHours: 48 });
  eq(JSON.stringify(la), JSON.stringify(lb),
    `D2 …and the ${name} renders BYTE FOR BYTE the same whichever programme priced it`);
  eq(snapshot.hashSnapshot(a.snapshot), snapshot.hashSnapshot(b.snapshot),
    `D3 …and hashes the same, so the replay cannot tell them apart either`);
}
/* Each of the three really is the document it is named after — otherwise D2 would be proving the
   same page three times. */
eq(built['term sheet'].snapshot.docKind, snapshot.DOC_KINDS.TERM_SHEET, 'D4 the first is the term sheet');
eq(built['comparison sheet'].snapshot.docKind, snapshot.DOC_KINDS.COMPARISON, 'D5 the second is the comparison sheet');
eq(built['scenario comparison'].snapshot.docKind, snapshot.DOC_KINDS.SCENARIO, 'D6 the third is the scenario comparison');

// ---------------------------------------------------------------------------
console.log('\nE · swept for a tell — every string on every page');
// ---------------------------------------------------------------------------
{
  /**
   * THE SWEEP IS OVER THE WHOLE RENDERED LAYOUT, not over a list of fields. A guard that named the
   * keys it checked would pass the day a vendor name arrives inside a sentence somebody wrote.
   */
  const textOf = (lay) => {
    const out = [];
    (function walk(v) {
      if (v == null) return;
      if (typeof v === 'string') { out.push(v); return; }
      if (typeof v === 'number') { out.push(String(v)); return; }
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (typeof v === 'object') Object.values(v).forEach(walk);
    }(lay));
    return out.join('  ');
  };

  const BANNED = [
    [/NQM/i, 'the investor\'s real name'],
    [/LoanNEX|loannex|Lender Price|lenderprice/i, 'a vendor\'s name'],
    [/CORR: Investor/i, 'the vendor\'s own programme name'],
    [/holdback/i, 'the word holdback'],
    [/priceExact|priceSeal|vendorPrice|marginHoldback/i, 'an internal price field'],
    [/104\.1762/, 'the vendor\'s own price'],
    [/38068|1382|7233/, 'a vendor id'],
    [/g-nqm/i, 'the vendor\'s organisation guid'],
  ];
  for (const [name, make] of DOCS) {
    const b = snapshot.buildSnapshot({ selections: make(true), plan: PLAN, anchorIndex: 0, prepared: PREPARED });
    const text = textOf(layout.buildLayout(b.snapshot, { code: 'TS-4KH92B', expiryHours: 48 }));
    ok(text.length > 500, `E0 the ${name} really rendered something to sweep (${text.length} characters)`);
    for (const [re, what] of BANNED) {
      const hit = text.match(re);
      ok(!hit, `E1 the ${name} carries ${what} nowhere${hit ? ` — found "${hit[0]}"` : ''}`);
    }
    /* The white label IS on the page — that is what a document names a programme. A sweep that
       found nothing at all would pass on a blank document. */
    ok(/Platinum/.test(text), `E2 …while the white-labelled name IS printed on the ${name}`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nG · a programme nobody has named is REFUSED, never named after its investor');
// ---------------------------------------------------------------------------
{
  /**
   * THE GAP A MUTATION FOUND. Every section above prices a row that HAS a white label, so a
   * production change making the row fall back to the investor's own name when it has none went
   * green through all of them — the fallback was never reached. That is the one case where the
   * source can leak by ACCIDENT rather than by design, so it is proven here rather than left to
   * the fixture's luck.
   *
   * Rule 10 inverts on a document a client reads: an investor we cannot name safely is REFUSED,
   * not shown blank and never shown as itself.
   */
  const bare = quoteShape.programsFromLoanNex(heldBoard, { transactionId: 'txn-1' })[0];
  eq(bare.consumerLabel, null,
    'G1 a LoanNEX row with no white label carries NO consumer label — never a fall-back to the investor\'s real name');
  eq(bare.investor, 'NQM Funding', 'G1b …while the investor IS on the row, staff-side, so G1 is not an empty board');

  const q = { ...asQuote(nexOpts.find((o) => o.priceBuild.noteRate === 7.375), bare), consumerLabel: null, whiteLabel: null };
  const unnamed = snapshot.buildMember(selectionFrom(q), PLAN);
  ok(!unnamed.ok, 'G2 …and a document cannot be built from it at all');
  eq(unnamed.error, 'program_not_named', 'G2b …refused by name, so a screen can say what to do about it');

  const named = snapshot.buildMember(selectionFrom({ ...q, consumerLabel: 'NQM Funding' }), PLAN);
  ok(!named.ok, 'G3 a programme an officer named after the investor is refused too');
  eq(named.error, 'program_name_names_investor', 'G3b …by its own name');

  /* And the refusal reaches every one of the three, with the offending option NAMED. */
  for (const [name, n] of [['term sheet', 1], ['comparison sheet', 3]]) {
    const sels = Array.from({ length: n }, () => selectionFrom(q));
    const b = snapshot.buildSnapshot({ selections: sels, plan: PLAN, anchorIndex: 0, prepared: PREPARED });
    ok(!b.ok, `G4 the ${name} is refused when an option has no client-facing name`);
    eq(b.memberIndex, 0, `G4b …naming which option it was`);
  }
}

// ---------------------------------------------------------------------------
console.log('\nF · what must not move');
// ---------------------------------------------------------------------------
{
  /* The member is a WHITELIST, and it is written out field by field rather than spread from the
     selection — which is the mechanism the whole of section B rests on. */
  const src = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/termsheet/snapshot.js'), 'utf8'));
  const body = src.slice(src.indexOf('function buildMember'), src.indexOf('function exportGate'));
  ok(body.length > 500, 'F0 (located buildMember)');
  ok(!/\.\.\.s\b|\.\.\.sel\b/.test(body),
    'F1 the member is never spread from the selection — a spread is how a field nobody listed reaches a borrower\'s page');
  ok(/consumerLabel,/.test(body), 'F2 …it names the consumer label it prints');
  ok(!/[^.\w]internal\s*:/.test(body), 'F3 …and never puts `internal` on it');

  /* The staff-side record is projected, so a browser cannot widen what is kept either. */
  const rec = stripComments(fs.readFileSync(path.join(ROOT, 'src/longterm/termsheet/internal.js'), 'utf8'));
  ok(/function projectInternal/.test(rec), 'F4 the staff-side record goes through its own projection');
}

console.log('\n' + pass + ' checks passed\n');
