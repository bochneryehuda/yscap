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
  // ⛔ THE BAND AND THE FOOTER ARE PAGE FURNITURE NOW, NOT BLOCKS — which is a
  // STRONGER property than "a header first and a footer last" was. A header
  // BLOCK is drawn once, wherever it flows; furniture is drawn over every page
  // after the flow, so a page the renderer adds mid-table cannot come out bare.
  // The block list carries only the FACTS it states, and it must carry them
  // first, because nothing downstream of `meta` can put them back.
  check(types[0] === 'meta', 'the facts the brand band states come first');
  check(!types.includes('header') && !types.includes('footer'),
    'and neither the band nor the footer is a flowed block — a once-drawn header cannot brand every page');
  const meta = lay.blocks[0];
  check(!!meta.title && !!meta.disclaimer, 'the meta block carries the document name and the footer disclaimer');
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
  const hard = lay.blocks.filter((b) => b.t === 'pagebreak' && !Number.isFinite(b.ifLessThan));
  const soft = lay.blocks.filter((b) => b.t === 'pagebreak' && Number.isFinite(b.ifLessThan));
  check(hard.length === 3, 'one detail page per option — the owner\'s "it\'s just adding pages to it", literally');
  // ⛔ THE DISCLOSURES BREAK IS SOFT, AND THAT DISTINCTION IS LOAD-BEARING. A
  // hard break there produced a page carrying five rows and ten inches of
  // nothing on the first sheet rendered; a per-option break stays hard because
  // "one option per page" is a statement about the document, not about the room.
  check(soft.length === 1 && soft[0].ifLessThan > 0,
    'and exactly one SOFT break, for the disclosures, which move to their own page only when there is no room left');

  const single = layout.buildLayout(snapshot.buildSnapshot({ selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: {} }).snapshot, {});
  check(!single.blocks.some((b) => b.t === 'table'), 'a one-option sheet renders NO comparison table — a table with one column is not a comparison');
  const rowsOf = (blocks) => blocks.filter((b) => b.t === 'figures').flatMap((b) => b.rows);
  const singleRows = rowsOf(single.blocks);
  check(singleRows.some((r) => r[0] === 'Monthly rent') && singleRows.some((r) => r[0] === 'DSCR'),
    '…and it does show what the loan qualified on — the rent and the ratio');
  // ⛔ A TERM SHEET IS SIGNABLE AND A COMPARISON IS NOT. A signature under three
  // columns records agreement to nothing in particular, and the one thing a
  // signed page must be is unambiguous about what was signed.
  check(single.blocks.some((b) => b.t === 'signature'), 'a term sheet carries an acceptance block');
  check(!lay.blocks.some((b) => b.t === 'signature'), 'a comparison carries NONE — three columns cannot be signed');
  check(single.blocks.some((b) => b.t === 'disclosures') && lay.blocks.some((b) => b.t === 'disclosures'),
    'both carry the disclosures');
}

// =============================================================================
section('the three documents — one option, three options, three scenarios');
// =============================================================================
{
  // ⛔ THE KIND IS DERIVED FROM THE OPTIONS, NEVER TAKEN FROM THE CALLER. A sheet
  // that called itself a term sheet while carrying three options would print a
  // signature block under a comparison; one that called itself a comparison with
  // one option would draw a table with a single column.
  const mk = (sels, prep) => snapshot.buildSnapshot({
    selections: sels, plan: PLAN, prepared: prep || { borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701' },
  });
  const one = mk([quote('The offer', 7.375, 102)]);
  const three = mk([quote('A', 7.375, 102), quote('B', 6.875, 99.75), quote('C', 7.875, 103.75)]);
  const scen = mk([
    quote('75% LTV', 7.375, 102),
    quote('70% LTV', 7.125, 102, { scenario: Object.assign({}, SCENARIO, { loan: 350000, ltv: 70 }) }),
  ]);
  check(one.snapshot.docKind === snapshot.DOC_KINDS.TERM_SHEET, 'one option is a TERM SHEET');
  check(three.snapshot.docKind === snapshot.DOC_KINDS.COMPARISON,
    'the same loan priced three ways is a COMPARISON SHEET — the owner\'s "same scenario, different options"');
  check(scen.snapshot.docKind === snapshot.DOC_KINDS.SCENARIO,
    'two different loans is a SCENARIO COMPARISON — "different scenarios and different options broken down"');
  // The kind cannot be dictated: a caller asserting one is ignored.
  const lied = snapshot.buildSnapshot({
    selections: [quote('A', 7.375, 102), quote('B', 6.875, 99.75)],
    plan: PLAN, prepared: { docKind: 'term_sheet' },
  });
  check(lied.snapshot.docKind === snapshot.DOC_KINDS.COMPARISON,
    'and a caller cannot declare it — two options is a comparison however it is asked for');

  // Each document names itself, on its own face and in its own footer.
  const lay1 = layout.buildLayout(one.snapshot, { expiryHours: 24 });
  const lay3 = layout.buildLayout(three.snapshot, { expiryHours: 48 });
  const layS = layout.buildLayout(scen.snapshot, { expiryHours: 48 });
  check(lay1.blocks[0].title === 'Term Sheet', 'the term sheet says "Term Sheet" in the brand band');
  check(lay3.blocks[0].title === 'Comparison Sheet' && /3 options/.test(lay3.blocks[0].subtitle),
    'the comparison says "Comparison Sheet", and how many options');
  check(layS.blocks[0].title === 'Scenario Comparison' && /2 scenarios/.test(layS.blocks[0].subtitle),
    'the scenario comparison says so, and counts scenarios rather than options');
  const scenParas = layS.blocks.filter((b) => b.t === 'para').map((b) => b.text).join(' ');
  check(/These scenarios differ in: .*loan amount/.test(scenParas),
    'a scenario comparison SAYS what changed between the scenarios — two numbers with no stated difference is not a comparison');
}

// =============================================================================
section('a term sheet is only issued complete — the export gate');
// =============================================================================
{
  const FULL = { borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701' };
  const bare = Object.assign({}, SCENARIO, { rentMonthly: null, taxMonthly: null, insuranceMonthly: null, dscr: null });

  const ok = snapshot.buildSnapshot({ selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: FULL });
  check(snapshot.exportGate(ok.snapshot).ok, 'a complete term sheet exports');

  const missing = snapshot.buildSnapshot({
    selections: [quote('The offer', 7.375, 102, { scenario: bare })], plan: PLAN, prepared: {},
  });
  const g = snapshot.exportGate(missing.snapshot);
  check(!g.ok, 'one with no rent, no taxes, no insurance and no ratio does NOT');
  // ⛔ IT NAMES EVERY MISSING THING AT ONCE. A gate that reveals its blockers one
  // at a time is four round trips, and each of these is a box on the screen the
  // officer is already looking at.
  for (const k of ['rentMonthly', 'taxMonthly', 'insuranceMonthly', 'dscr', 'borrowerName', 'propertyAddress']) {
    check(g.missing.includes(k), `…and it names ${k} rather than revealing it on the next attempt`);
  }
  check(/monthly rent/.test(g.message) && /export a comparison/.test(g.message),
    'the refusal is a sentence an officer can act on, and says what they CAN still export');

  // ⛔ THE COMPARISON'S HALF NEEDS NO GATE, BY CONSTRUCTION. "It should not have
  // the principal, interest, tax, and insurance" is not a second rule — the PITI
  // block renders only when the figures are complete, so an incomplete comparison
  // carries none whether or not anybody remembered to check.
  const cmpBare = snapshot.buildSnapshot({
    selections: [quote('A', 7.375, 102, { scenario: bare }), quote('B', 6.875, 99.75, { scenario: bare })],
    plan: PLAN, prepared: {},
  });
  check(snapshot.exportGate(cmpBare.snapshot).ok, 'a comparison with no taxes or insurance still exports');
  const cmpRows = layout.buildLayout(cmpBare.snapshot, {}).blocks
    .filter((b) => b.t === 'figures').flatMap((b) => b.rows);
  check(!cmpRows.some((r) => /Total monthly payment/.test(r[0])),
    '…and carries NO total monthly payment, because there is no real one to carry');
  const cmpTable = layout.buildLayout(cmpBare.snapshot, {}).blocks.find((b) => b.t === 'table');
  check(!cmpTable.rows.some((r) => r[0] === 'Total monthly payment'),
    '…and neither does its comparison table');
}

// =============================================================================
section('PITI — the total appears only when it is a real one');
// =============================================================================
{
  const piti = (over) => layout.paymentRows({
    monthlyPI: 2526.44,
    scenario: Object.assign({ taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0 }, over || {}),
  });
  check(piti().complete && Math.abs(piti().total - 3291.44) < 0.01,
    'principal, interest, taxes and insurance add up to the total the sheet prints');
  check(piti().rows.some((r) => /principal, interest, taxes & insurance/.test(r[0])),
    '…and the row says in words which four things it is the total of');
  // ⛔ NEVER A PARTIAL PITI. A tax figure with no insurance figure sums to a
  // number that LOOKS like a monthly cost and is short by an insurance premium —
  // the exact shape of an under-quote somebody acts on.
  check(!piti({ insuranceMonthly: null }).complete && piti({ insuranceMonthly: null }).total === null,
    'taxes without insurance produces NO total — a partial PITI is an under-quote wearing the right label');
  check(!piti({ taxMonthly: null }).complete, 'and insurance without taxes likewise');
  // HOA is different: most properties have none, and "no dues" is a fact.
  check(piti({ hoaMonthly: null }).complete, 'association dues are not required — "no dues" is a fact, not a missing figure');
  check(/dues/.test(piti({ hoaMonthly: 210 }).rows.slice(-1)[0][0]),
    '…and when there ARE dues the total says it includes them');

  // ⛔ THE PAGE MAY NOT CONTRADICT ITSELF. The scenario carries ONE ratio; a
  // comparison prints three different total payments. MEASURED on a real render,
  // the scenario's single 1.24 was printed under all three.
  const three = snapshot.buildSnapshot({
    selections: [quote('A', 7.375, 102), quote('B', 6.875, 99.75), quote('C', 7.875, 103.75)],
    plan: PLAN, prepared: {},
  });
  const t = layout.comparisonTable(three.snapshot);
  const dscrRow = t.rows.find((r) => r[0] === 'DSCR');
  const payRow = t.rows.find((r) => r[0] === 'Total monthly payment');
  check(new Set(payRow.slice(1)).size === 3, 'three options genuinely have three different total payments');
  check(new Set(dscrRow.slice(1)).size === 3,
    '…so they have three different ratios — the printed DSCR is the division a reader can do off this very page');
  const rentM = SCENARIO.rentMonthly;
  const money = (s) => Number(String(s).replace(/[$,]/g, ''));
  for (let i = 1; i < 4; i += 1) {
    const expect = (rentM / money(payRow[i])).toFixed(2);
    check(dscrRow[i] === expect, `…and column ${i} divides out exactly (${dscrRow[i]} = ${rentM} / ${payRow[i]})`);
  }
}

// =============================================================================
section('the fees are listed out, and broken down');
// =============================================================================
{
  const rowsOf = (m) => layout.chargeRows(m).concat(layout.lenderFeeRows(m).rows);
  const built = snapshot.buildSnapshot({
    selections: [
      quote('Pays the fees', 7.375, 102),
      quote('Fees waived', 7.875, 103.75, { mode: 'lenderPaid', waiveLenderFees: true }),
    ],
    plan: PLAN, prepared: {},
  });
  const [paying, waived] = built.snapshot.members;

  // ⛔ THE ORIGINATION SHOWS ITS ARITHMETIC. "Origination fee (2.000 points)
  // $7,500" states two numbers and shows none of the working; a reader who wants
  // to check it has to know the loan amount, find it elsewhere and multiply.
  const orig = rowsOf(paying).find((r) => r[0] === 'Origination fee');
  check(!!orig && orig[1] === '$7,500', 'the origination fee is on the sheet with its dollars');
  check(/2\.000 points of the \$375,000 loan amount/.test((orig[2] || {}).note || ''),
    '…and the breakdown underneath is the multiplication itself, in words');
  check(!/\(/.test(orig[0]), '…and the points are no longer crushed into the label');

  // ⛔ A WAIVED FEE IS LISTED, NOT OMITTED. "You need to be able to see the
  // difference" — and two fewer rows than the column beside it is not a
  // difference a reader can see, it is one they have to notice the absence of.
  const wRows = rowsOf(waived);
  const app = wRows.find((r) => r[0] === 'Application fee');
  const com = wRows.find((r) => r[0] === 'Commitment fee');
  check(!!app && !!com, 'a waived option still LISTS both lender fees by name');
  check(app[1] === 'Waived' && com[1] === 'Waived', '…each said to be waived rather than shown as a zero');
  check(/\$500 — covered by the lender/.test((app[2] || {}).note || ''),
    '…with the amount it would have been, so the saving is on the page rather than in the reader\'s head');
  check(wRows.some((r) => r[0] === 'Lender fees you are not paying' && r[1] === '$2,095'),
    '…and the two are totalled as the saving');
  check(rowsOf(paying).some((r) => r[0] === 'Lender fees, total' && r[1] === '$2,095'),
    'while the option that pays them totals the same two fees as a charge');

  // The arithmetic is UNMOVED by any of this — a waived line is the same zero
  // that an absent line already contributed.
  check(waived.charges.borrowerPaysDollars === waived.charges.lines
    .filter((l) => !l.waived).reduce((s, l) => s + l.dollars, 0),
  'listing a waived fee changes no total — its dollars are the zero the absent line already contributed');

  const table = layout.comparisonTable(built.snapshot);
  const feeRow = table.rows.find((r) => r[0] === 'Lender fees');
  check(feeRow && feeRow.some((c) => /^Waived \(\$2,095\)$/.test(String(c))) && feeRow.some((c) => c === '$2,095'),
    'and the comparison table puts the waived column beside the charged one, both naming the same $2,095');
}

// =============================================================================
section('"no points either way" no longer sits over an origination fee');
// =============================================================================
{
  // ⛔ THE OWNER'S OWN REPORT, REPRODUCED. The sheet said:
  //     At closing                       No points either way
  //     Origination fee (2.000 points)   $7,500
  // Both lines were arithmetically right and the document was wrong: the value
  // answered what the RATE costs and its label promised the whole closing
  // position. A test that checks arithmetic can never see this.
  const built = snapshot.buildSnapshot({
    selections: [quote('At par, paying origination', 7.375, 102)], plan: PLAN,
    prepared: { borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Avenue, Lakewood, NJ 08701' },
  });
  const m = built.snapshot.members[0];
  const lay = layout.buildLayout(built.snapshot, { expiryHours: 24 });
  const rows = lay.blocks.filter((b) => b.t === 'figures').flatMap((b) => b.rows);

  const parRow = rows.find((r) => /No points either way/.test(String(r[1])));
  check(!parRow, 'the par phrase no longer appears as a figure at all on a sheet that charges an origination fee');
  const origRow = rows.find((r) => r[0] === 'Origination fee');
  check(origRow && origRow[1] === '$7,500', '…while the origination fee is still stated in full');

  // The closing figure is now the NET of everything, so the headline and the
  // list can never disagree.
  const net = rows.find((r) => /Lender charges at closing, net/.test(String(r[0])));
  check(!!net, 'the closing line is labelled as the NET of the lender charges');
  const expected = m.charges.borrowerPaysDollars - m.charges.borrowerCreditDollars;
  check(net[1] === wording.moneyExact(expected),
    `…and it IS that net (${net[1]} = every charge less every credit)`);
  check(wording.closingPosition(m.charges).kind === 'pay' && /You pay \$9,595/.test(wording.closingPosition(m.charges).text),
    'and the position states the direction as a verb, never as a signed number');

  // At genuine par with NO origination the rate line is still honest.
  const lp = snapshot.buildSnapshot({
    selections: [quote('Lender paid, at par', 7.375, 104, { mode: 'lenderPaid' })], plan: PLAN, prepared: {},
  });
  const cc = wording.costOrCredit(lp.snapshot.members[0].charges);
  check(cc.kind === 'receive' || cc.kind === 'none', 'a lender-paid option at or above par costs nothing to get the rate');
  const table = layout.comparisonTable(snapshot.buildSnapshot({
    selections: [quote('A', 7.375, 102), quote('B', 6.875, 99.75)], plan: PLAN, prepared: {},
  }).snapshot);
  check(table.rows.some((r) => r[0] === 'Cost to get this rate'),
    'the comparison names the rate row for what it is about — the rate, not "at closing"');
  check(table.rows.some((r) => r[0] === 'Lender charges, net'),
    '…and carries the whole closing position as its own separate row');
}

// =============================================================================
section('an unnamed program may be named — and never after the investor');
// =============================================================================
{
  // ⛔ THE WARNING IS ADVICE; THE REFUSAL IS THE CONTROL. Rule 10 is a HARD rule
  // and a sentence under a text box does not enforce one. The typed name goes
  // through `audience.mentionsInvestor` — the ONE definition, built on the
  // registry — never a second `!== 'Deephaven'` check that `Deepahven` walks past.
  const unnamed = (extra) => Object.assign({}, quote('The offer', 7.375, 102), { consumerLabel: null }, extra || {});

  const none = snapshot.buildMember(unnamed(), PLAN);
  check(!none.ok && none.error === 'program_not_named', 'a program with no client-facing name is refused');
  check(/type a program name/.test(none.message) && /never the investor/.test(none.message),
    '…and the refusal tells the officer they may name it themselves, and warns them off the one name they must not use');

  const named = snapshot.buildMember(unnamed({ manualProgramName: '30-Year Rental Select' }), PLAN);
  check(named.ok && named.member.consumerLabel === '30-Year Rental Select', 'a name the officer types is accepted');
  check(named.member.programNamedBy === 'manual',
    '…and the sheet records that a human named it, because "we publish this" and "an officer called it that today" are different facts');

  const registry = snapshot.buildMember(quote('The offer', 7.375, 102, { manualProgramName: 'Something else' }), PLAN);
  check(registry.ok && registry.member.consumerLabel === 'Platinum' && registry.member.programNamedBy === 'registry',
    'a program that HAS a white-label name is never renamed by hand — two sheets would call one program two things');

  // Every recorded spelling, not one.
  // The REGISTRY's own spellings, read from the registry — a hand-typed list of
  // investors in a test proves only that the test agrees with itself, and the
  // spellings are exactly the thing that has 117 variants.
  const audience = require('../src/longterm/audience');
  const spellings = audience._internals.spellings();
  let leaked = 0;
  let tried = 0;
  for (const entry of spellings) {
    const s = entry && entry.text ? String(entry.text) : '';
    // A name a program name could plausibly BE. The registry also carries
    // parenthesised composites that no officer would type; sweeping those proves
    // nothing about the guard and would flatter it.
    if (s.length < 4 || s.length > 40) continue;
    tried += 1;
    if (snapshot.resolveProgramName({ manualProgramName: `${s} Select` }).ok) leaked += 1;
    if (snapshot.resolveProgramName({ manualProgramName: s }).ok) leaked += 1;
  }
  check(tried > 10 && leaked === 0,
    `every recorded investor spelling is refused as a program name (${tried} tried, ${leaked} accepted)`);
  const good = snapshot.resolveProgramName({ manualProgramName: '30-Year Rental Select' });
  check(good.ok, '…while an ordinary program name is accepted, so the guard is not simply refusing everything');
  check(!snapshot.resolveProgramName({ manualProgramName: 'X' }).ok, 'a name too short to read is refused');
}

// =============================================================================
section('the expiry says what the owner said');
// =============================================================================
{
  const s = snapshot.buildSnapshot({
    selections: [quote('The offer', 7.375, 102)], plan: PLAN,
    prepared: { borrowerName: 'Jonathan Reyes', propertyAddress: '218 Forest Ave', expiresAt: 'August 31, 2026 9:14 AM' },
  }).snapshot;
  // ⛔ "1 day" IS ARITHMETICALLY IDENTICAL AND READS AS A LOOSER PROMISE. The
  // owner's words were "it should also say that it's expiring in 24 hours", and
  // on a document whose whole purpose is urgency the unit IS the message.
  check(/expires in 24 hours/.test(layout.expiryBlock(s, { expiryHours: 24 }).title),
    'a 24-hour window says 24 HOURS, never "1 day"');
  check(/expires in 48 hours/.test(layout.expiryBlock(s, { expiryHours: 48 }).title), '48 hours likewise');
  check(/expires in 3 days/.test(layout.expiryBlock(s, { expiryHours: 72 }).title),
    'past two days it reads in days, where that genuinely is clearer');
  check(/Good through August 31, 2026 9:14 AM/.test(layout.expiryBlock(s, { expiryHours: 24 }).text),
    '…and the panel states the actual instant, not only the window');
  // ⛔ IT STATES WHAT WE SET, NOT A LITERAL. A hard-coded "24 hours" would go on
  // saying 24 after somebody changed the setting.
  const src = require('fs').readFileSync(path.join(__dirname, '../src/longterm/termsheet/layout.js'), 'utf8');
  const body = src.slice(src.indexOf('function expiryBlock'), src.indexOf('function buildLayout'));
  check(!/24 hours/.test(body.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'and the window is never written into the page as a literal');

  const lay = layout.buildLayout(s, { expiryHours: 24 });
  check(lay.blocks.some((b) => b.t === 'callout' && /24 hours/.test(b.title)),
    'the term sheet carries the expiry as its own panel, where it cannot be skimmed past');
  const cmp = snapshot.buildSnapshot({
    selections: [quote('A', 7.375, 102), quote('B', 6.875, 99.75)], plan: PLAN,
    prepared: { expiresAt: 'September 1, 2026' },
  }).snapshot;
  check(!layout.buildLayout(cmp, { expiryHours: 48 }).blocks.some((b) => b.t === 'callout'),
    'a comparison does not — it is a working document, not an offer with a clock on it');
}

// =============================================================================
section('the disclosures — the same kind as the RTL sheet, about THIS loan');
// =============================================================================
{
  const withPrepay = snapshot.buildSnapshot({
    selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: {},
  }).snapshot;
  const noPrepay = snapshot.buildSnapshot({
    selections: [quote('The offer', 7.375, 102, { scenario: Object.assign({}, SCENARIO, { prepayMonths: 0, prepayStructure: null }) })],
    plan: PLAN, prepared: {},
  }).snapshot;
  const heads = (s) => layout.disclosureItems(s).map((i) => i[0]);
  for (const must of ['Business purpose only', 'Personal guaranty / recourse', 'Title', 'Insurance',
    'Legal fees and expenses', 'Disclaimer', 'Acknowledgement & indemnification']) {
    check(heads(withPrepay).includes(must), `the disclosures carry "${must}", as the RTL sheet does`);
  }
  for (const must of ['How this loan qualifies', 'Escrows and impounds', 'Rate and pricing']) {
    check(heads(withPrepay).includes(must), `…and "${must}", which a 30-year rental loan needs and a bridge sheet never did`);
  }
  // ⛔ A DISCLOSURE ABOUT SOMETHING THIS LOAN HAS NOT GOT PUTS A TERM ON THE
  // DOCUMENT THAT IS NOT A TERM OF THE LOAN.
  check(heads(withPrepay).includes('Prepayment'), 'a loan with a prepayment term discloses it');
  check(!heads(noPrepay).includes('Prepayment'), '…and one without does not — it is silent, not falsely reassuring');
  const bodies = layout.disclosureItems(withPrepay).map((i) => i[1]).join(' ');
  check(!/minimum earned interest|deferred origination|construction draw/i.test(bodies),
    'and none of the BRIDGE sheet\'s own terms were copied across onto a rental loan');
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
