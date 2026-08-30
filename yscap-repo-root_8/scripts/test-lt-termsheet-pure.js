'use strict';
/**
 * LT TERM SHEETS — the rules, with no database and no browser.
 *
 * Everything a term sheet decides before it is drawn: the ID a person types back
 * down a telephone, the wording, the comparison arithmetic, what may appear on
 * the document at all, and the block list the renderer walks.
 *
 * THE WORKED EXAMPLES ARE THE DOCUMENTATION'S OWN. `docs/longterm/
 * BORROWER-PRICING-LANGUAGE.md` prints a rate ladder on $375,000 over 30 years
 * and `docs/longterm/TERM-SHEETS-AND-COMPARISON.md` prints its break-evens; both
 * are asserted here verbatim, so the documents and the strings cannot drift.
 */

const path = require('path');

const code = require('../src/longterm/termsheet/code');
const overlay = require('../src/longterm/termsheet/overlay');
const wording = require('../src/longterm/termsheet/wording');
const comparison = require('../src/longterm/termsheet/comparison');
const snapshot = require('../src/longterm/termsheet/snapshot');
const layout = require('../src/longterm/termsheet/layout');
const pdf = require('../src/longterm/termsheet/pdf');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── the shared fixture: the documented ladder ───────────────────────────────
// Comp: 2 points of YSP, so a borrower-paid display price is the raw price less
// 2.000 — which puts 7.375% at exactly par and reproduces the printed table.
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 3900, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
const quote = (label, ratePct, rawPrice, extra) => Object.assign({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: '2026-08-30T13:30:00.000Z',
}, extra || {});

// =============================================================================
section('the term sheet ID survives being read down a telephone');
// =============================================================================
{
  // EXHAUSTIVE ON WHAT WE MINT. A code that cannot be typed back is a code that
  // does not work, and the two ways it could fail are both invisible from
  // reading the function: a fold applied to a letter the alphabet CONTAINS, and
  // a prefix strip that eats a code beginning with those same letters.
  let bad = 0;
  const seen = new Set();
  const N = 60000;
  for (let i = 0; i < N; i += 1) {
    const c = code.mintCode();
    for (const ch of c.slice(code.PREFIX.length)) seen.add(ch);
    const body = c.slice(code.PREFIX.length);
    for (const typed of [c, body, c.toLowerCase(), body.toLowerCase(), ` ${c} `, c.replace('-', '')]) {
      if (code.normalizeCode(typed) !== c) bad += 1;
    }
    if (!code.isCode(c)) bad += 1;
  }
  check(bad === 0, `${N} minted codes round-trip in every form a person types them (${bad} failures)`);
  check(seen.size === code.ALPHABET.length,
    `every symbol in the alphabet is reachable (${seen.size} of ${code.ALPHABET.length}) — a biased identifier is the defect nobody notices`);

  check(code.normalizeCode('TS-QQQQQQ') === 'TS-QQQQQQ',
    'Q IS A REAL SYMBOL and is never folded — Crockford drops I, L, O and U and KEEPS Q, so folding it would make about one code in six resolve to a different one and find nothing');
  check(code.normalizeCode('TS-OBCDEF') === 'TS-0BCDEF', 'O folds to 0 — what a person reading the printed page will type');
  check(code.normalizeCode('TS-IBCDEF') === 'TS-1BCDEF' && code.normalizeCode('TS-LBCDEF') === 'TS-1BCDEF', 'I and L fold to 1');
  check(code.normalizeCode('TSABCD') === 'TS-TSABCD',
    'a code that BEGINS with the letters T and S survives being typed without the prefix — the strip is decided by the LENGTH, not by the first two characters');
  check(code.normalizeCode('TS-TSABCD') === 'TS-TSABCD', '…and the same code with its prefix resolves identically');
  for (const junk of ['nonsense', 'TS-ABCDE', 'TS-ABCDEFG', 'TS-ABCDEU', '', null, undefined, 'TS-!!!!!!']) {
    check(code.normalizeCode(junk) === null, `refused rather than guessed: ${JSON.stringify(junk)}`);
  }
  check(code.ALPHABET.includes('Q') && !code.ALPHABET.includes('U')
    && !code.ALPHABET.includes('I') && !code.ALPHABET.includes('L') && !code.ALPHABET.includes('O'),
  'the alphabet itself is Crockford: no I, L, O or U, and Q is in');
}

// =============================================================================
section('the wording — the language spec is the fixture');
// =============================================================================
{
  check(wording.money(375000) === '$375,000' && wording.money(null) === '—',
    'whole dollars, grouped; an unknown figure is an em dash and never $0');
  check(wording.moneyExact(8437.5) === '$8,437.50' && wording.moneyExact(2095) === '$2,095',
    'a fixed fee carries its cents when it has them — $1,595 is not an estimate');
  check(wording.points(2.25) === '2.250', 'points to a thousandth');
  check(wording.rate(7.375) === '7.375%' && wording.rate(7.5) === '7.5%', 'a rate reads as a rate sheet quotes it');

  // R3: never print a price. This is the whole reason the overlay exists — 101.750
  // is a wholesale number with no meaning to a borrower, and teaching them one is
  // the babysitting the owner ruled out.
  const ladder = [
    { rate: 6.875, raw: 99.75, text: 'You pay $8,438 (2.250 pts)' },
    { rate: 7.125, raw: 100.75, text: 'You pay $4,688 (1.250 pts)' },
    { rate: 7.375, raw: 102.0, text: 'No points either way' },
    { rate: 7.625, raw: 103.0, text: 'You receive $3,750 (1.000 pts)' },
    { rate: 7.875, raw: 103.75, text: 'You receive $6,563 (1.750 pts)' },
  ];
  for (const rung of ladder) {
    const charges = overlay.quoteCharges('borrowerPaid', PLAN, rung.raw, 375000, false);
    const cc = wording.costOrCredit(charges);
    check(cc.text === rung.text,
      `the documented ladder at ${rung.rate}% reads "${rung.text}"${cc.text === rung.text ? '' : ` — got "${cc.text}"`}`);
  }
  const parText = wording.costOrCredit(overlay.quoteCharges('borrowerPaid', PLAN, 102, 375000, false)).text;
  check(!/\bpar\b/i.test(parText), '"par" is a wholesale word and never appears — the honest reading is "No points either way"');
  const all = JSON.stringify([wording.DISCLOSURE, wording.THIRD_PARTY, ...ladder.map((r) => r.text)]);
  check(!/\b(10[0-9]\.\d|price|buy rate|YSP|compensation)\b/i.test(all),
    'no price, no buy rate, no compensation word reaches a borrower-facing string');

  const m = overlay.monthlyPI({ loanAmount: 375000, ratePct: 7.125, termYears: 30, interestOnly: false });
  check(Math.abs(m - 2526.44) < 0.01, `the standard amortisation formula: $375,000 at 7.125% over 30 years is $2,526.44 (got ${m.toFixed(2)})`);
}

// =============================================================================
section('the comparison — the owner\'s two workflows');
// =============================================================================
{
  const built = snapshot.buildSnapshot({
    selections: [
      quote('No points', 7.375, 102),
      quote('Buy the rate down', 6.875, 99.75),
      quote('Take the credit', 7.875, 103.75),
    ],
    plan: PLAN,
    anchorIndex: 0,
    prepared: { borrowerName: 'Jonathan Reyes', officerName: 'Sara Klein' },
  });
  check(built.ok, `a three-option comparison builds${built.ok ? '' : ` — ${built.error}`}`);
  const cmp = built.snapshot.comparison;
  check(cmp.workflow === 'A', 'the same loan at three prices is workflow A — the rate/point trade');
  check(cmp.anchorIndex === 0 && cmp.rows[0].isAnchor, 'one anchor, and its own cells are never zeros');
  // THE ENGINE KEEPS THE UNROUNDED MONTHS and the WORDING rounds them, so a
  // figure is never rounded twice — 66.7 rounded to 67 for the page, and 67
  // never re-rounded by anything downstream.
  check(Math.abs(cmp.rows[1].breakEvenMonths - 66.7) < 0.05 && Math.abs(cmp.rows[2].breakEvenMonths - 50.9) < 0.05,
    `the break-even months are kept unrounded (${cmp.rows[1].breakEvenMonths} and ${cmp.rows[2].breakEvenMonths})`);
  check(wording.monthsWords(cmp.rows[1].breakEvenMonths) === '67 months (5 years 7 months)'
    && wording.monthsWords(cmp.rows[2].breakEvenMonths) === '51 months (4 years 3 months)',
  'and the documented sentences round them once, at the page: 67 months (5 years 7 months) and 51 months (4 years 3 months)');

  const b = comparison.buildComparison([
    { ...built.snapshot.members[0], loanAmount: 350000, ltv: 70, monthlyPI: 2417 },
    { ...built.snapshot.members[0], loanAmount: 400000, ltv: 80, monthlyPI: 2762 },
  ], 0);
  check(b.workflow === 'B', 'two different loan amounts is workflow B — 70 against 80 LTV, comparing the payment');
  check(b.differs.includes('loanAmount'), 'and it NAMES what differs, so the reader is never left to spot it');

  // The direction rule: a break-even only exists when one option costs more
  // today and saves later. Two options pointing the same way have none, and
  // printing a number there would be arithmetic dressed as advice.
  check(comparison.breakEvenMonths(-1000, 50) === null || comparison.breakEvenMonths(1000, -50) === null,
    'no break-even when the two figures point the same way — a number there would be nonsense');

  // compareSnapshots — the third leg of the replay.
  const A = built.snapshot;
  const moved = JSON.parse(JSON.stringify(A));
  moved.members[0].ratePct = 7.5;
  const d = comparison.compareSnapshots(A, moved);
  check(d.moved === true && d.rows[0].ratePct.delta === 0.125, 'a re-price reports what moved, to a thousandth');
  check(comparison.compareSnapshots(A, A).moved === false, 'and reports nothing moved when nothing did');
  const shorter = { members: A.members.slice(0, 2) };
  const d2 = comparison.compareSnapshots(A, shorter);
  check(d2.comparable === false && d2.unmatched.issued === 1 && d2.rows.length === 2,
    'two runs of different lengths are NOT silently compared — the surplus is reported, because a delta comparing three options against two is one nobody can trust');
  const other = JSON.parse(JSON.stringify(A));
  other.members[0].consumerLabel = 'Diamond';
  check(comparison.compareSnapshots(A, other).rows[0].sameProgram === false,
    'a programme that is no longer the same programme is STATED, not left to be inferred from a rate that moved');
}

// =============================================================================
section('what may go on the document at all — the whitelist, not a filter');
// =============================================================================
{
  const raw = snapshot.buildMember({ ...quote('x', 7.375, 102), mode: 'raw' }, PLAN);
  check(!raw.ok && raw.error === 'raw_cannot_export',
    'RAW PRICING IS REFUSED BY NAME — it is the vendor\'s own numbers before our compensation');
  check(/borrower-paid or lender-paid/i.test(raw.message),
    '…with a sentence that says what to do instead, not a bare code');
  check(!overlay.ISSUABLE_MODES.includes('raw'), 'and "raw" is absent from the issuable set, so nothing can reach it by another door');

  const unnamed = snapshot.buildMember({ ...quote('x', 7.375, 102), consumerLabel: null }, PLAN);
  check(!unnamed.ok && unnamed.error === 'program_not_named',
    'AN INVESTOR WE CANNOT NAME SAFELY IS REFUSED. On the staff board an unresolved investor is KEPT (hiding a row nobody chose to hide is a silent drop); on a document a client reads the rule INVERTS');

  check(!snapshot.buildMember({ ...quote('x', 7.375, 102), ratePct: null }, PLAN).ok, 'a quote with no rate cannot be issued');
  check(!snapshot.buildMember({ ...quote('x', 7.375, 102), rawPrice: null }, PLAN).ok, 'nor one with no price');
  check(!snapshot.buildMember(quote('x', 7.375, 102), null).ok, 'nor one whose compensation plan could not be read — never one priced at zero comp');

  const disagree = snapshot.buildMember({ ...quote('x', 7.375, 102), vendorMonthlyPI: 3000 }, PLAN);
  check(!disagree.ok && disagree.error === 'payment_disagreement',
    'A PAYMENT THE BOARD DISAGREES WITH REFUSES THE EXPORT rather than issuing a document that contradicts the screen the officer was reading');
  check(snapshot.buildMember({ ...quote('x', 7.375, 102), vendorMonthlyPI: 2590.5 }, PLAN).ok,
    '…while a rounding-sized difference is accepted, because two conventions are not a disagreement');

  // The whitelist itself. A blacklist has to be right about every key that will
  // ever exist; this has to be right once.
  const leaky = snapshot.buildMember({
    ...quote('x', 7.375, 102),
    lender: 'Deephaven', investor: 'deephaven', lenderId: 42, rateSheetName: 'Deephaven Wholesale',
    scenario: { ...SCENARIO, lender: 'Verus', investor: 'verus', buyRate: 6.5 },
  }, PLAN);
  check(leaky.ok, 'a quote carrying the vendor\'s own investor fields still builds');
  const asText = JSON.stringify(leaky.member);
  // The VALUES can never appear at all. The KEYS are asserted with their JSON
  // colon, because a term sheet legitimately carries LENDER FEES — `waiveLenderFees`
  // and the fee lines both contain the word, and a bare substring search would
  // fail on the honest ones while proving nothing about the vendor's.
  for (const v of ['Deephaven', 'deephaven', 'Verus', 'verus', 'Wholesale', '6.5']) {
    check(!asText.includes(v), `…and the vendor value ${JSON.stringify(v)} is nowhere on it`);
  }
  for (const k of ['lender', 'investor', 'lenderId', 'rateSheetName', 'buyRate']) {
    check(!asText.includes(`"${k}":`), `…and there is no "${k}" key — nothing is spread off the caller's object, every key is NAMED`);
  }

  const many = snapshot.buildSnapshot({ selections: Array.from({ length: 9 }, (_, i) => quote(`o${i}`, 7 + i / 8, 102)), plan: PLAN });
  check(!many.ok && many.error === 'too_many', 'past the cap it stops being a comparison and becomes a catalogue');
  check(!snapshot.buildSnapshot({ selections: [], plan: PLAN }).ok, 'nothing selected is refused');
}

// =============================================================================
section('the hash is a hash of the MEANING, not of the key order');
// =============================================================================
{
  const built = snapshot.buildSnapshot({ selections: [quote('a', 7.375, 102)], plan: PLAN, prepared: {} });
  const s1 = built.snapshot;
  // Postgres hands jsonb back in its OWN key order, so a hash taken over
  // JSON.stringify directly would report tampering on a document nobody touched.
  const reordered = JSON.parse(JSON.stringify(s1, Object.keys(s1).sort().reverse()));
  const rebuiltKeys = {};
  for (const k of Object.keys(s1).sort().reverse()) rebuiltKeys[k] = s1[k];
  check(snapshot.hashSnapshot(s1) === snapshot.hashSnapshot(rebuiltKeys),
    'the same snapshot with its keys in another order hashes the same — which is what makes a replay able to say "this IS the document"');
  const tampered = JSON.parse(JSON.stringify(s1));
  tampered.members[0].ratePct = 9.99;
  check(snapshot.hashSnapshot(s1) !== snapshot.hashSnapshot(tampered), '…and a changed figure hashes differently');
  check(JSON.stringify(snapshot.canonicalize({ b: 1, a: { d: 2, c: 3 } })) === '{"a":{"c":3,"d":2},"b":1}',
    'keys are sorted at every depth');
  const arr = snapshot.canonicalize({ m: [3, 1, 2] });
  check(JSON.stringify(arr.m) === '[3,1,2]', '…while ARRAYS keep their order, because the order of the members IS the document');
  void reordered;
}

// =============================================================================
section('the layout — the block list a renderer walks');
// =============================================================================
{
  const built = snapshot.buildSnapshot({
    selections: [quote('No points', 7.375, 102), quote('Buy the rate down', 6.875, 99.75), quote('Take the credit', 7.875, 103.75)],
    plan: PLAN,
    anchorIndex: 0,
    prepared: { borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701', officerName: 'Sara Klein' },
  });
  const lay = layout.buildLayout(built.snapshot, { code: 'TS-4KH92B' });
  const types = lay.blocks.map((b) => b.t);
  check(types[0] === 'header' && types[types.length - 1] === 'footer', 'a header first and a footer last');
  check(types.includes('table'), 'a comparison carries a table');
  const table = lay.blocks.find((b) => b.t === 'table');
  check(/compared against/.test(table.head[1]), 'the anchor column SAYS it is the one everything is compared against');
  const breakEven = table.rows.find((r) => r[0] === 'Break-even');
  check(breakEven && breakEven[2] === '67 months (5 years 7 months)',
    `the break-even row reads in years and months, as the docs print it (got ${breakEven && breakEven[2]})`);
  const paras = lay.blocks.filter((b) => b.t === 'para').map((b) => b.text).join(' ');
  check(/costs \$8,438 more at closing than No points and saves \$127 a month\. You are ahead after 67 months \(5 years 7 months\)/.test(paras),
    'the buydown sentence is the documented one, verbatim');
  check(/costs \$6,563 less at closing than No points and \$129 more a month/.test(paras), 'and so is the credit sentence');
  // ⛔ EVERY FIGURE IN THOSE SENTENCES IS A DIFFERENCE, so each one NAMES what it
  // is a difference from. They used to read "costs $8,438 today" — true, and it
  // reads as absolute. Harmless on this ladder, where the anchor is at par so the
  // two coincide; on the owner's three offers, where borrower-paid sits beside
  // lender-paid, the table said "You receive $1,655" one line above while the
  // sentence said "pays you $11,250 today". Both right, different questions,
  // nothing on the page saying which. Found by reading a rendered sample.
  check(paras.split('No points').length - 1 >= 3,
    'and every comparative sentence names the option it is comparing against, so no figure on the page reads as absolute when it is a difference');
  check(lay.blocks.filter((b) => b.t === 'pagebreak').length === 3, 'one detail page per option — the owner\'s "it\'s just adding pages to it", literally');

  const single = layout.buildLayout(snapshot.buildSnapshot({ selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: {} }).snapshot, {});
  check(!single.blocks.some((b) => b.t === 'table'), 'a one-option sheet renders NO comparison table — a table with one column is not a comparison');
  check(single.blocks.some((b) => b.t === 'section' && b.title === 'Qualifying'), '…and it does show the qualifying figures, which a comparison has no room for');
}

// =============================================================================
section('the renderer measures the way the page is actually drawn');
// =============================================================================
{
  // THE TRAP: pdf-lib's `widthOfTextAtSize` applies the font's KERN PAIRS while
  // its `drawText` emits a plain show-text operator carrying no kern
  // adjustments — so the measurement is ~1% NARROWER than the ink, and every
  // wrap decision comes out optimistic. This is measured against Adobe's own
  // published Helvetica advances, which is what a viewer uses.
  const { PDFDocument, StandardFonts } = require('pdf-lib');
  const AFM = { ' ': 278, A: 667, v: 500, o: 556, ',': 278, e: 556, w: 722 };
  const probe = 'Av o, ew';
  let afm = 0;
  for (const ch of probe) afm += AFM[ch];
  (async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const kerned = font.widthOfTextAtSize(probe, 1000);
    const adv = (s2, size, w) => pdf._internals.advance({ widths: new Map() }, s2, font, size || 1000, w);
    check(Math.abs(kerned - afm) > 1,
      `pdf-lib's own measurement disagrees with Adobe's published advances (${kerned} against ${afm}) — kerning it measures and does not draw`);
    check(Math.abs(adv(probe) - afm) < 0.01,
      `…while ours matches them exactly (${adv(probe)} against ${afm}), which is what the viewer will advance`);
    // ⛔ THE FIXTURE MUST CONTAIN KERN PAIRS, or this proves nothing. A line of
    // "a a a a" has no pair Helvetica kerns, so the kerned and un-kerned
    // measurements are identical and a wrap reverted to `widthOfTextAtSize`
    // sails through — which it did, once, until this string was changed. Real
    // prose carries "Av", "o," and "ew", and those are exactly the pairs that
    // make the two answers differ.
    const prose = ('Available at Avenue, however, we owe, Avon, Take a view, Yaw, '
      + 'Wave, Try, Pay, and, of course, Avery. ').repeat(14);
    const lines = pdf._internals.wrap({ widths: new Map() }, prose, font, 10, 200);
    check(lines.length > 1, 'long prose wraps');
    const widest = Math.max(...lines.map((l) => adv(l, 10)));
    check(widest <= 200, `and every wrapped line fits its column, MEASURED against the advances a viewer uses (widest ${widest.toFixed(2)} of 200)`);
    check(lines.some((l) => font.widthOfTextAtSize(l, 10) < adv(l, 10) - 0.01),
      '…and at least one of those lines is one pdf-lib would have measured NARROWER than it draws, so a wrap that trusted it would put ink past the column');
    // ⛔ THE VISIBLE SYMPTOM, WHICH IS THE ONE WORTH ASSERTING. Measuring while
    // packing with pdf-lib's kerned figure over-packs each line; the SECOND,
    // correct measurement then hard-breaks the surplus, so nothing ever runs off
    // the margin — the belt holds. What the reader sees instead is prose chopped
    // in the middle of words (49 lines where there should be 35). A width check
    // alone cannot see that, and a mutation reverting the packing measurement
    // survived this suite until this assertion was added.
    const wordsIn = prose.trim().split(' ').filter(Boolean).length;
    const wordsOut = lines.join(' ').split(' ').filter(Boolean).length;
    check(wordsOut === wordsIn,
      `…and no word is chopped in half getting there (${wordsOut} words out of ${wordsIn} in) — the symptom a reader actually sees when the packing measurement is wrong`);
    const broken = pdf._internals.hardBreak({ widths: new Map() }, 'x'.repeat(500), font, 10, 100);
    check(broken.length > 1, 'a token wider than its column is HARD-BROKEN — the guarantee that pathological input cannot run off the sheet');
    check(pdf._internals.clip({ widths: new Map() }, 'The property', font, 10, 2) === '',
      'a clip with no room answers nothing, never a bare ellipsis — an ellipsis alone reads as a rendering fault rather than as a shortened label');
    finish();
  })().catch((e) => { failures += 1; console.error('  FAIL renderer measurement threw:', e.message); finish(); });
}

function finish() {
  console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}
void path;
