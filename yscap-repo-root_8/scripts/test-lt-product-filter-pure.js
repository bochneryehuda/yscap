#!/usr/bin/env node
/**
 * FIXED / ARM, INTEREST-ONLY AND TERM — filtered by what each vendor PUBLISHES, never by a word in
 * a product name.
 *
 * ⛔ THE DEFECT THIS EXISTS FOR (owner-reported 2026-09-01, over a board reading "59 rates · 12,299
 * quotes · 209 programmes" with a 5/6 ARM at the top): *"it's coming up with all kinds of ARMs and
 * interest-onlys … find a way to filter this in a legit way, not by looking at the words, but in a
 * real legit way, out of Lender, out of LoanX."*
 *
 * TWO VENDORS, TWO MECHANISMS, ONE QUESTION — and knowing which is which is the whole design:
 *
 *   LENDER PRICE takes all three as SEARCH CRITERIA (`criteria.loanType` + `loanTypeCriteria`,
 *   `criteria.interestOnly`, `termsCriteria`) and answers with the product asked for. Its board must
 *   therefore never be re-filtered here: re-judging an answer the vendor already judged can only
 *   remove a row the vendor said belongs. What it was MISSING was a way for a caller to say ARM at
 *   all — `loanType` has been hard-forced to `Fixed` since the DSCR profile was written.
 *
 *   LOANNEX takes NONE of the three. Interest-only is a PRODUCT it returns rather than a question it
 *   accepts, and its search carries no amortization and no term. So it answers with everything it
 *   has and STATES what each programme is — `amortizationType` ("Fixed"|"ARM"), `isInterestOnly`
 *   (a real boolean) and `termInMonths` (360/480/180), measured on all 19 programmes of the
 *   recorded answer. Its board is narrowed on those, after the search.
 *
 * THE PROPERTY THAT MAKES BOTH SAFE: an unstated search is BYTE-IDENTICAL to what it has always
 * been on the wire, and the narrowing mirrors what Lender Price was ACTUALLY asked rather than what
 * the form happened to say — so the two boards answer one question by construction.
 *
 * PURE: no network, no database. The vendor clients are stubbed before the route is required.
 */
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const nexClient = require(path.join(ROOT, 'src/longterm/loannex/client'));
const lpClient = require(path.join(ROOT, 'src/longterm/lenderprice/client'));

/** One Lender Price leaf — enough to reach the board; this battery is about the OTHER vendor. */
const LP_RAW = { results: { qualifiedNonQMData: {
  type: 'CriteriaFromLineResultKey', keyLabel: 'DSCR 30 Yr Fixed',
  childs: [{ type: 'LenderKey', keyLabel: 'Acra Lending', plenderId: 'L1', leafs: [{
    companyId: 'L1', companyName: 'Acra Lending', programName: 'DSCR 30 Yr Fixed', productName: '30 Yr Fixed',
    rate: 7.5, adjustedPoints: 1, basePoints: 0.5, adjustmentPoints: 0.5, dayLock: 30, term: 30,
    loanAmount: 375000, monthlyPayment: { monthlyPI: 2500 },
  }] }],
} } };
lpClient.price = async () => ({ ok: true, raw: LP_RAW, searchKey: 'k1', request: {}, provenance: null });

/**
 * A LoanNEX board in the vendor's OWN published shape — every field below is one `loannex/parse.js`
 * maps straight off `mortgageProducts`, with the values measured in `capture/quick-prices.json`.
 * The programme NAMES are deliberately misleading in both directions (a programme called
 * "30 Yr Fixed" that is structurally an ARM, and one called "ARM Special" that is structurally
 * Fixed) so a filter that read the words would get every one of these backwards.
 */
const P = (o) => ({
  lender: o.lender, investor: o.lender, program: o.program, product: o.program,
  rungs: [{ rate: 7, price: 101.5, points: -1.5, lockDays: 30, payment: 2400, priceHashKey: `h-${o.program}` }],
  rungCount: 1,
  amortizationType: o.amort, isInterestOnly: o.io, termInMonths: o.months,
});
/* Two investors the merge resolves by default, so this battery is about the PROGRAMME narrowing
   and never about the routing beside it. */
const NEX_PROGRAMS = [
  P({ lender: 'NQM Funding', program: '30 Yr Fixed', amort: 'ARM', io: false, months: 360 }),
  P({ lender: 'NQM Funding', program: 'ARM Special', amort: 'Fixed', io: false, months: 360 }),
  P({ lender: 'Verus Mortgage Capital', program: 'IO 40', amort: 'Fixed', io: true, months: 480 }),
  P({ lender: 'Verus Mortgage Capital', program: 'Short', amort: 'Fixed', io: false, months: 180 }),
  P({ lender: 'NQM Funding', program: 'Unlabelled', amort: null, io: null, months: null }),
];
nexClient.price = async () => ({ board: {
  source: 'loannex', programCount: NEX_PROGRAMS.length,
  lenderCount: new Set(NEX_PROGRAMS.map((p) => p.lender)).size,
  rungCount: NEX_PROGRAMS.length, programs: NEX_PROGRAMS,
} });

const { priceBoth } = require(path.join(ROOT, 'src/longterm/routes/combined-pricer'))._internals;
const lpModel = require(path.join(ROOT, 'src/longterm/lenderprice/search-model'));
const pf = require(path.join(ROOT, 'src/longterm/pricing/product-filter'));

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** Comments necessarily NAME what they explain, so a "must not appear" guard reads the code only. */
const noComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SCENARIO = { purpose: 'Purchase', value: 500000, loan: 375000, zip: '08201', fico: 760, dscr: 1.3, termYears: 30 };
const LP_BASE = { zip: '08201', value: 500000, loan: 375000, fico: 760, dscr: 1.25, purpose: 'purchase', propertyType: 'single family', termYears: 30, lockDays: 30 };
const TO_LP = { acra: { source: 'lenderprice' } };
const board = (sc = {}, opts = {}) => priceBoth({ ...SCENARIO, ...sc }, { marginHoldback: null, routes: TO_LP, links: {}, ...opts });
const nexRows = (out) => (out.programs || []).filter((p) => NEX_PROGRAMS.some((n) => n.program === p.program));

(async () => {
  console.log('\n── NOT BY LOOKING AT THE WORDS: the module reads structure, and only structure ──');
  {
    const src = noComments(read('src/longterm/pricing/product-filter.js'));
    ok(!/\.(program|product|programName|productName|name|label|description)\b/.test(src),
      'WORD-1 the narrowing reads no programme name, product name, label or description — the owner\'s own condition on this filter');
    ok(/amortizationType/.test(src) && /isInterestOnly/.test(src) && /termInMonths/.test(src),
      'WORD-2 …it reads the three fields the vendor publishes about each programme, and nothing else');
    const i = pf._internals;
    ok(i.amortizationKey('Fixed') === 'fixed' && i.amortizationKey('ARM') === 'arm',
      'WORD-3 the vendor\'s two published spellings map to our two tokens');
    ok(i.amortizationKey('5/6 ARM (30 Yr. Term)') === null && i.amortizationKey('') === null && i.amortizationKey(null) === null,
      'WORD-4 …and a PRODUCT NAME containing the word "ARM" is unknown, never a match — reading it would be exactly the words rule this replaces');
  }

  console.log('\n── LENDER PRICE IS ASKED, AND AN UNSTATED SEARCH IS UNCHANGED TO THE BYTE ──');
  {
    const plain = lpModel.buildSearch(LP_BASE);
    ok(plain.criteria.loanType === 'Fixed' && JSON.stringify(plain.loanTypeCriteria) === '["Fixed"]',
      'LP-1 with nothing stated the profile still forces Fixed in BOTH halves of the request');
    const blank = lpModel.buildSearch({ ...LP_BASE, amortization: '' });
    const absent = lpModel.buildSearch({ ...LP_BASE, amortization: null });
    ok(JSON.stringify(plain) === JSON.stringify(blank) && JSON.stringify(plain) === JSON.stringify(absent),
      'LP-2 …and a blank or absent answer produces a BYTE-IDENTICAL request — which is what leaves the General Pricing Engine untouched');
    const arm = lpModel.buildSearch({ ...LP_BASE, amortization: 'arm' });
    ok(arm.criteria.loanType === 'ARM' && JSON.stringify(arm.loanTypeCriteria) === '["ARM"]',
      'LP-3 an ARM search moves BOTH halves — a body saying Fixed in one place and ARM in the other is a request no reader can honour');
    const A = JSON.parse(JSON.stringify(plain));
    A.criteria.loanType = arm.criteria.loanType; A.loanTypeCriteria = arm.loanTypeCriteria;
    ok(JSON.stringify(A) === JSON.stringify(arm),
      'LP-4 …and moves NOTHING else in the whole request — the two loanType keys are the entire difference');
    const bad = lpModel.validateScenario({ ...LP_BASE, amortization: 'balloon' });
    ok(bad.ok === false && bad.error === 'invalid_amortization',
      'LP-5 an unreadable answer is REFUSED, never quietly priced as Fixed — which would answer an ARM question with a fixed-rate board and look like a successful quote');
    const fixedExplicit = lpModel.buildSearch({ ...LP_BASE, amortization: 'Fixed' });
    ok(JSON.stringify(fixedExplicit) === JSON.stringify(plain),
      'LP-6 saying Fixed out loud produces the same request as saying nothing');
  }

  console.log('\n── LOANNEX IS NARROWED, ON THE FIELDS IT PUBLISHES ──');
  {
    const want = (sc) => pf.wantFrom(sc, lpModel._internals);
    // Counted FROM the fixture, so the "before" figures can never be a fiction of this test.
    const b = {
      source: 'loannex', programs: NEX_PROGRAMS,
      programCount: NEX_PROGRAMS.length,
      lenderCount: new Set(NEX_PROGRAMS.map((x) => x.lender)).size,
      rungCount: NEX_PROGRAMS.reduce((n, x) => n + x.rungCount, 0),
    };

    const fixed = pf.narrowBoard(b, want({ termYears: 30 }));
    const kept = fixed.board.programs.map((p) => p.program).sort();
    ok(JSON.stringify(kept) === JSON.stringify(['ARM Special', 'Unlabelled']),
      `NEX-1 a fixed-rate 30-year search keeps the structurally-Fixed programme and drops the structurally-ARM one — whatever they are CALLED (${kept.join(', ')})`);
    ok(fixed.dropped.amortization === 1 && fixed.dropped.term === 2 && fixed.dropped.interestOnly === 0,
      `NEX-2 …and says which dimension dropped what (${JSON.stringify(fixed.dropped)}) — a board that went from 209 to 41 with no reason is the same silence as an empty price build`);
    ok(fixed.unclassified === 1 && kept.includes('Unlabelled'),
      'NEX-3 a programme the vendor left unlabelled is KEPT and COUNTED — dropping on an unknown hides real pricing with nothing on the screen to say so');

    const arm = pf.narrowBoard(b, want({ termYears: 30, amortization: 'arm' }));
    ok(arm.board.programs.map((p) => p.program).sort().join(',') === '30 Yr Fixed,Unlabelled',
      'NEX-4 an ARM search keeps the structurally-ARM programme — the one whose NAME says "30 Yr Fixed"');

    const io = pf.narrowBoard(b, want({ termYears: 30, io: true }));
    ok(io.board.programs.some((p) => p.program === 'IO 40') && !io.board.programs.some((p) => p.program === 'ARM Special'),
      'NEX-5 an interest-only search keeps the interest-only product and drops the amortising one — LoanNEX takes no such input, so this is the only place it can happen');
    ok(want({ termYears: 30, io: true }).termMonths.join(',') === '360,480',
      'NEX-6 …and an interest-only search covers 40 years too, from `resolveSearchTerms` — the ONE definition, so a change to that rule can never narrow one vendor and not the other');

    const term = pf.narrowBoard(b, want({ termYears: 30 }));
    ok(!term.board.programs.some((p) => p.termInMonths === 180),
      'NEX-7 a 30-year search drops a 15-year programme — the term is a number the vendor states, never a phrase in a name');

    ok(b.programCount === 5 && b.lenderCount === 2 && b.rungCount === 5
      && fixed.board.programCount === 2 && fixed.board.lenderCount === 1 && fixed.board.rungCount === 2,
      `NEX-8 all three counts the board carries MOVE with the list (${b.programCount}/${b.lenderCount}/${b.rungCount} → ${fixed.board.programCount}/${fixed.board.lenderCount}/${fixed.board.rungCount}) — a header saying 209 over a list of 41 is the complaint this answers, and the lender count is the one a programme filter is most likely to leave behind`);
    ok(b.programs.length === 5 && b.programCount === 5,
      'NEX-9 …and the vendor\'s own board is never mutated — a new board, a new list');
  }

  console.log('\n── THE TWO BOARDS ANSWER THE SAME QUESTION, BY CONSTRUCTION ──');
  {
    for (const [asked, expectLp, expectNex] of [[undefined, 'Fixed', 'fixed'], ['fixed', 'Fixed', 'fixed'], ['arm', 'ARM', 'arm']]) {
      const sc = asked === undefined ? { ...LP_BASE } : { ...LP_BASE, amortization: asked };
      const lp = lpModel.buildSearch(sc).criteria.loanType;
      const nex = pf.wantFrom(sc, lpModel._internals).amortization;
      ok(lp === expectLp && nex === expectNex,
        `SAME-${asked || 'unstated'} Lender Price is asked ${lp} and LoanNEX is narrowed to ${nex} — read through the SAME mapper, so they cannot drift`);
    }
    ok(JSON.stringify(pf.wantFrom({ termYears: 30 })) === JSON.stringify({ amortization: null, io: null, termMonths: null }),
      'SAME-none with no Lender Price request to mirror, nothing is narrowed at all — the honest answer, never a guessed one');
  }

  console.log('\n── AND THE REAL ROUTE DOES IT: one board, narrowed before anything reads it ──');
  {
    const out = await board();
    const rows = nexRows(out);
    ok(rows.length === 2 && !rows.some((p) => p.program === '30 Yr Fixed'),
      `ROUTE-1 the programme rows the SCREEN draws are the narrowed set (${rows.map((p) => p.program).join(', ')})`);
    ok(out.productFilter && out.productFilter.applied === true,
      'ROUTE-2 the answer REPORTS that it narrowed — never a silent cap');
    ok(out.productFilter.dropped.amortization === 1 && out.productFilter.dropped.term === 2,
      `ROUTE-3 …with a count per dimension (${JSON.stringify(out.productFilter.dropped)})`);
    ok(out.productFilter.asked && out.productFilter.asked.amortization === 'fixed',
      'ROUTE-4 …and what it took the search to be asking for');
    ok(out.productFilter.unclassified === 1,
      'ROUTE-5 …and how many it could not judge and therefore kept');

    const armOut = await board({ amortization: 'arm' });
    const armRows = nexRows(armOut);
    ok(armRows.some((p) => p.program === '30 Yr Fixed') && !armRows.some((p) => p.program === 'ARM Special'),
      'ROUTE-6 asking for an ARM turns the board over — on the structure, not the names');

    // The Lender Price row must survive every one of these: its board was already narrowed by the
    // vendor, and narrowing it again here could only ever remove a row the vendor said belongs.
    const lpRow = (o) => (o.programs || []).find((p) => p.program === 'DSCR 30 Yr Fixed');
    ok(!!lpRow(out) && !!lpRow(armOut),
      'ROUTE-7 the Lender Price programme is never touched by the narrowing, on either answer');

    const counts = await board();
    ok(counts.merged && counts.merged.investors.every((e) => (e.programs || []).length === (e.programCount == null ? (e.programs || []).length : e.programCount)),
      'ROUTE-8 the merged board\'s per-investor counts describe the narrowed list, not the one before it');
  }

  console.log('\n── THE SCREEN: the control exists where the officer may choose, and nowhere else ──');
  {
    const eng = read('app-v2/src/longterm/pricerEngine.js');
    ok(/key: 'general',[\s\S]{0,4000}?amortizationChoice: false,/.test(eng),
      'UI-1 the GENERAL engine offers no rate-type control — its search has forced Fixed since it was written, and the owner\'s rule for that board is "don\'t touch it"');
    ok(/key: 'combined',[\s\S]{0,4000}?amortizationChoice: true,/.test(eng),
      'UI-2 the COMBINED engine offers it, because on that board it decides what comes back from both programs at once');
    const fields = read('app-v2/src/longterm/LtScenarioFields.jsx');
    ok(/engine\.amortizationChoice && \(/.test(fields),
      'UI-3 …and the control itself is forked on that flag, so a screen with no provider above it renders nothing new');
    ok(/amortization: '',/.test(fields),
      'UI-4 the form\'s own default is BLANK — `toScenario` omits a blank, so an untouched form sends no key and the general request stays byte-identical');
    const sf = read('app-v2/src/longterm/scenarioFields.js');
    const values = [...sf.matchAll(/\{ value: '(fixed|arm)', label:/g)].map((m) => m[1]);
    ok(values.length === 2 && values.every((v) => lpModel._internals.mapAmortization(v)),
      `UI-5 every value the picker can send is one the server's mapper ACCEPTS (${values.join(', ')}) — the mapper refuses what it cannot read, so an offered value it rejects would be a dead end`);
    const pricer = read('app-v2/src/longterm/LtPricer.jsx');
    ok(!/Lender Price returned no/.test(noComments(pricer)),
      'UI-6 no message on this shared screen names one vendor any more — the combined board is quoted by two');
    /* THE REAL FUNCTION, LIFTED OUT OF THE SCREEN AND RUN — not a copy of it. The panel is ESM
       JSX and this suite is CommonJS, so the source is read and the one function evaluated; a
       re-typed twin here would pass while the screen said something else. */
    const fnSrc = (pricer.match(/export function narrowedAway\(res\) \{[\s\S]*?\n\}/) || [])[0];
    ok(!!fnSrc, 'UI-7a the empty-board explainer is still where this suite reads it');
    // eslint-disable-next-line no-new-func
    const narrowedAway = new Function(`${(fnSrc || 'function narrowedAway(){return null;}').replace(/^export /, '')}\nreturn narrowedAway;`)();
    ok(narrowedAway({}) === '' && narrowedAway(null) === '',
      'UI-7 an answer carrying no narrowing report says nothing extra — the general board\'s empty state is unchanged');
    ok(/left out/.test(narrowedAway({ productFilter: { applied: true, asked: { amortization: 'fixed' }, dropped: { amortization: 3, interestOnly: 0, term: 2 } } })),
      'UI-8 …and an empty board that a product answer emptied SAYS SO, rather than reading as "nothing prices this loan"');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
