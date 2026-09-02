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
    ok(JSON.stringify(pf.wantFrom({ termYears: 30 })) === JSON.stringify({ amortization: null, io: null, termMonths: null, lockDays: null }),
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
    // RE-POINTED 2026-09-02: the interest-only answer now follows the BUILT Lender Price request
    // when the scenario is silent (owner-reported: IO programmes stayed on with the switch off).
    // This search states no `io`, Lender Price's own base carries `interestOnly: false`, so the
    // 'IO 40' programme is refused on INTEREST-ONLY — the dimension checked before term — where it
    // used to fall through to the term check. One programme moved from `term` to `interestOnly`;
    // nothing was loosened: the same five programmes, the same two survivors.
    ok(out.productFilter.dropped.amortization === 1 && out.productFilter.dropped.interestOnly === 1 && out.productFilter.dropped.term === 1,
      `ROUTE-3 …with a count per dimension (${JSON.stringify(out.productFilter.dropped)})`);
    ok(out.productFilter.asked && out.productFilter.asked.io === false,
      'ROUTE-3b an unstated interest-only answer is resolved to what Lender Price was actually asked (false), never left un-narrowed');
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


  console.log('\n── THE RATE LOCK: THE FOURTH DIMENSION, MIRRORED OFF THE REQUEST ──');
  {
    /* ⛔ THE REAL RECORDED BOARD, not the five-programme fixture. This defect is about a spread
       between locks that only a real rate sheet has: the fixture's every rung is 30 days, so it
       could not show the defect and cannot prove the fix. */
    const nexParse = require(path.join(ROOT, 'src/longterm/loannex/parse'));
    const REAL = nexParse.parse(require(path.join(ROOT, 'src/longterm/loannex/capture/quick-prices.json')).response);

    // ── WHAT IT COSTS TO GET THIS WRONG, measured on that board ──────────────────────────────
    let multiLock = 0; const spreads = [];
    for (const pr of REAL.programs) {
      const byRate = new Map();
      for (const r of pr.rungs) if (r.price != null) { if (!byRate.has(r.rate)) byRate.set(r.rate, []); byRate.get(r.rate).push(r); }
      for (const rs of byRate.values()) {
        if (rs.length < 2) continue;
        multiLock += 1;
        const ps = rs.map((r) => r.price);
        spreads.push(Math.max(...ps) - Math.min(...ps));
      }
    }
    const meanSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
    const maxSpread = Math.max(...spreads);
    ok(multiLock === 1661 && Math.abs(meanSpread - 0.2059) < 0.001 && Math.abs(maxSpread - 0.5) < 1e-9,
      `LOCK-1 the harm is real and measured: ${multiLock} rate-points on the recorded board carry more than ONE lock, mean spread ${meanSpread.toFixed(4)} points and max ${maxSpread.toFixed(3)} — twice the whole 0.25 margin holdback`);

    const acra = REAL.programs.find((pr) => /acra/i.test(pr.investor || '') && /30 Yr\. Fixed/i.test(pr.product || ''));
    const acraRungs = acra ? acra.rungs.filter((r) => r.rate === 6.25 && r.price != null) : [];
    const acraAt = (d) => { const r = acraRungs.find((x) => x.lockDays === d); return r ? r.price : null; };
    ok(acraAt(15) === 101.036 && acraAt(30) === 100.886 && acraAt(45) === 100.736,
      `LOCK-2 …and it is one investor's one rate: Acra's 30-year fixed at 6.25 is ${acraAt(15)} at 15 days, ${acraAt(30)} at 30 and ${acraAt(45)} at 45 — a 15-day rung beside a 30-day Lender Price quote looked a sixth of a point better for no reason on the row`);

    // ── THE MIRROR: read off the request Lender Price was ACTUALLY sent ──────────────────────
    for (const [asked, expect] of [[undefined, 30], [15, 15], [45, 45], [60, 60]]) {
      const raw = { ...LP_BASE };
      if (asked === undefined) delete raw.lockDays; else raw.lockDays = asked;
      const v = lpModel.validateScenario({ ...SCENARIO, ...raw });
      const body = lpModel.buildSearch(v.scenario);
      const w = pf.wantFrom(v.scenario, lpModel._internals, { lpCriteria: body.criteria, lpRequest: body });
      ok(body.dayLocksCriteria[0] === expect && w.lockDays === expect,
        `LOCK-3${asked === undefined ? 'a' : asked} Lender Price is asked ${body.dayLocksCriteria[0]} days and LoanNEX is narrowed to ${w.lockDays} — read off the WIRE body, so an unstated lock resolves through the profile's OWN 30-day default rather than a second copy of it here`);
    }
    ok(pf.wantFrom({}, {}, { lpRequest: { brokerCriteria: { dayLocks: 45 } } }).lockDays === 45,
      'LOCK-4 a body carrying the lock only in `brokerCriteria` is still mirrored — the two halves of the request say the same thing and either one will do');
    ok(pf.wantFrom({}, {}, { lpRequest: {} }).lockDays === null
      && pf.wantFrom({}, {}, {}).lockDays === null,
      'LOCK-5 …and with no lock anywhere in the request the dimension is NOT narrowed — never a guessed 30, which would drop every rung of a board nobody asked a lock about');
    ok(pf.wantFrom({ lockDays: 21 }, {}, {}).lockDays === 21,
      'LOCK-6 a caller with no Lender Price request to mirror falls back to the scenario\'s own lock');

    // ── THE DEFECT, AND THAT IT IS CLOSED ────────────────────────────────────────────────────
    /* ⛔ THE FULL `want` THE SCREEN ACTUALLY PRODUCES — fixed, 360 months, plus the lock — and the
       SAME want with the lock alone removed as the control. A first cut of this battery compared a
       lock-only want against a fixed+term one and reported the two boards as before-and-after; they
       were two different questions, and the "after" board came out LARGER than the "before". Both
       sides of a comparison have to be narrowed the same way or the numbers mean nothing. */
    const FULL = { amortization: 'fixed', io: null, termMonths: [360] };
    const at = (d) => pf.narrowBoard(REAL, { ...FULL, lockDays: d });
    const before = pf.narrowBoard(REAL, { ...FULL, lockDays: null });
    const shape = (n) => `${n.kept}/${n.board.rungCount}`;
    const shapes = [15, 30, 45, 60].map((d) => shape(at(d)));
    ok(shape(before) === '26/1553' && new Set(shapes).size === 4,
      `LOCK-7 one search, four locks: the board WAS ${shape(before)} whichever lock was asked, and is now ${shapes.join('  ')} — four different boards where there had been one, which is the whole defect`);
    ok(shapes.every((x) => Number(x.split('/')[1]) < 1553),
      `LOCK-7b …and every one of them is SMALLER than the board that ignored the lock — the rungs removed are the ones priced at a lock nobody asked for, never a shortening of the answer`);
    for (const d of [15, 30, 45, 60]) {
      const n = at(d);
      const strays = [];
      for (const pr of n.board.programs) for (const r of pr.rungs) if (r.lockDays != null && Number(r.lockDays) !== d) strays.push(r.lockDays);
      ok(n.board.rungCount > 0 && strays.length === 0,
        `LOCK-8@${d} every one of the ${n.board.rungCount} surviving rungs is at the asked ${d}-day lock — ${strays.length} at any other`);
    }

    // ── UNKNOWNS ARE KEPT, THE SAME DIRECTION THE OTHER THREE FAIL IN ────────────────────────
    const blind = { source: 'loannex', programCount: 1, lenderCount: 1, rungCount: 2, programs: [{
      lender: 'L', investor: 'L', program: 'P', product: 'P', amortizationType: 'Fixed', isInterestOnly: false, termInMonths: 360,
      rungs: [{ rate: 7, price: 101, points: -1, lockDays: null }, { rate: 7.25, price: 100, points: 0, lockDays: null }],
      rungCount: 2, lockDaysOffered: [],
    }] };
    const bn = pf.narrowBoard(blind, { lockDays: 30 });
    ok(bn.kept === 1 && bn.board.programs[0].rungs.length === 2 && bn.unclassified === 1 && bn.unclassifiedRungs === 2,
      'LOCK-9 a programme that publishes NO lock is kept and counted unclassified, rungs and all — a board we cannot judge is not a board we silently shorten');
    const partial = { source: 'loannex', programCount: 1, lenderCount: 1, rungCount: 3, programs: [{
      lender: 'L', investor: 'L', program: 'P', product: 'P', amortizationType: 'Fixed', isInterestOnly: false, termInMonths: 360,
      rungs: [{ rate: 6.5, price: 99, points: 1, lockDays: 30 }, { rate: 7, price: 102.5, points: -2.5, lockDays: 60 }, { rate: 7.25, price: 101, points: -1, lockDays: null }],
      rungCount: 3, lockDaysOffered: [30, 60],
    }] };
    const pn = pf.narrowBoard(partial, { lockDays: 30 });
    const kept = pn.board.programs[0];
    ok(kept.rungs.length === 2 && kept.rungCount === 2 && kept.minRate === 6.5 && kept.maxPrice === 101
      && kept.minPoints === -1 && JSON.stringify(kept.lockDaysOffered) === '[30]',
      `LOCK-10 EVERY aggregate is recomputed off the surviving rungs (rungCount ${kept.rungCount}, minRate ${kept.minRate}, maxPrice ${kept.maxPrice}, minPoints ${kept.minPoints}, offers ${JSON.stringify(kept.lockDaysOffered)}) — a maxPrice left behind from the dropped 60-day rung would have the row advertising 102.5 at a lock that is no longer on it`);
    ok(partial.programs[0].rungs.length === 3 && partial.rungCount === 3 && REAL.rungCount === 5286,
      'LOCK-11 …and the vendor\'s own board is never mutated — a new board, new programmes, new rung arrays');
    const gone = pf.narrowBoard({ source: 'loannex', programCount: 1, lenderCount: 1, rungCount: 1, programs: [{
      lender: 'L', investor: 'L', program: 'P', product: 'P', amortizationType: 'Fixed', isInterestOnly: false, termInMonths: 360,
      rungs: [{ rate: 7, price: 101, points: -1, lockDays: 60 }], rungCount: 1, lockDaysOffered: [60],
    }] }, { lockDays: 30 });
    ok(gone.kept === 0 && gone.dropped.lock === 1 && gone.board.programCount === 0,
      'LOCK-12 a programme that does not price at the asked lock AT ALL is off the board and SAID SO — never kept at some other lock');
    ok(pf.narrowBoard(REAL, { lockDays: null }).narrowed === false,
      'LOCK-13 with no lock asked and nothing else asked either, the board is returned untouched — the general engine\'s door passes no request here and must stay exactly as it was');
  }

  console.log('\n── AND THE ROW SAYS WHICH LOCK IT IS, ON THE BOARD WHERE TWO PROGRAMS ANSWER ──');
  {
    const eng = read('app-v2/src/longterm/pricerEngine.js');
    ok(/key: 'general',[\s\S]{0,6000}?showRowLock: false,/.test(eng),
      'ROW-1 the GENERAL engine does not print the lock — every row there came from one vendor answering one lock, and the owner\'s rule for that screen is "don\'t touch our current setup"');
    ok(/key: 'combined',[\s\S]{0,6000}?showRowLock: true,/.test(eng),
      'ROW-2 …and the COMBINED engine does, because that is the board where two programs answer and the lock is what says the comparison is like for like');
    const pricer = read('app-v2/src/longterm/LtPricer.jsx');
    ok(/lockDays: o && o\.terms && nn\(o\.terms\.dayLock\) \? o\.terms\.dayLock : null,/.test(pricer),
      'ROW-3 the row carries the lock off `o.terms.dayLock` — the ONE place the server puts it, so the row and the Details panel cannot disagree');
    ok(/const lockNote = \(q\) => \(engine\.showRowLock && q && nn\(q\.lockDays\)/.test(pricer),
      'ROW-4 …and it is drawn behind the engine flag, so a component rendered with no provider above it draws nothing new');
    ok((noComments(pricer).match(/\{lockNote\(/g) || []).length === 2,
      'ROW-5 …on BOTH row lines — the lender line and the per-programme line under it, so opening a lender does not lose the lock');
  }


  console.log('\n── AND A SHORT BOARD SAYS SO ON THE SCREEN, WITHOUT NAMING A VENDOR ──');
  {
    const pricer = read('app-v2/src/longterm/LtCombinedPricer.jsx');
    ok(/export function ShortBoardNotice\(\{ completeness \}\)/.test(pricer),
      'SHORT-1 the notice exists and takes ONLY the server\'s own answer — it works nothing out for itself');
    ok(/if \(!c \|\| c\.complete !== false \|\| !c\.message\) return null;/.test(pricer),
      'SHORT-2 …and renders NOTHING when the board is whole, which is almost always');
    ok(/<ShortBoardNotice completeness=\{res\.completeness\} \/>/.test(pricer),
      'SHORT-3 …and it is mounted on the combined screen, reading the key the route lifts to the top level');
    const idxNotice = pricer.indexOf('<ShortBoardNotice');
    const idxNear = pricer.indexOf('<NearTierFlag');
    ok(idxNotice > 0 && idxNear > 0 && idxNotice < idxNear,
      'SHORT-4 …ABOVE everything else on the strip — "some of your prices are missing" outranks every other thing a person could read there');
    ok(!/loannex|LoanNEX|Lender Price/.test(pricer.slice(idxNotice - 1400, idxNotice + 200)),
      'SHORT-5 …and the notice names no vendor, so it can be said on the one-system board at all');

    /* THE EMPTY-BOARD SENTENCE. `sheetSubject` is RIGHT in the three places that describe ONE
       quote's own sheet, and was wrong for the whole board, which two rate sheets quote. Forked
       whole rather than assembled — "Neither rate sheet returned no priced rungs" is what splicing
       a subject into a shared sentence produces. */
    const eng = read('app-v2/src/longterm/pricerEngine.js');
    ok(/key: 'general',[\s\S]{0,6000}?emptyBoardLine: 'Lender Price returned no priced rungs for this scenario\.',/.test(eng),
      'SHORT-6 the GENERAL engine\'s empty-board sentence is unchanged, word for word');
    ok(/key: 'combined',[\s\S]{0,6000}?emptyBoardLine: 'Neither rate sheet returned a priced rung for this scenario\.',/.test(eng),
      'SHORT-7 …and the COMBINED engine says NEITHER, because two rate sheets quote that board');
    const lt = read('app-v2/src/longterm/LtPricer.jsx');
    ok(/\$\{engine\.emptyBoardLine\} The Ineligible view/.test(lt),
      'SHORT-8 …and the shared screen draws the engine\'s own sentence rather than splicing a subject into one of its own');
    ok((noComments(lt).match(/engine\.sheetSubject/g) || []).length === 3,
      'SHORT-9 …while the three ONE-QUOTE messages still use `sheetSubject`, where the singular is correct — this forked the board sentence, not the word');
  }

  console.log(`\n${fail ? 'FAILED' : 'OFFLINE: all passed'} (${pass} passed, ${fail} failed)`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
