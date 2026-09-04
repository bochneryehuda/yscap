'use strict';
/**
 * LONG-TERM — WHICH ENGINE PRICED A ROW, AND WHERE A BAND'S EXPLAIN IS ASKED.
 *
 * PURE. No database, no network, no browser: every rule under test is a plain
 * function or a fact about the source, so this runs on every push.
 *
 * THE THREE OWNER REPORTS OF 2026-09-04 THIS GUARDS:
 *   1. *"Base price — this sentence is saying even for stuff that is coming from
 *      LoanPass and not from LenderPric … Adjustments total (Lender Price) — same
 *      issue … Margin & holdback / Lender Price returned no margin or holdback
 *      lines on this quote — same thing."*
 *   2. *"We need to have a stamp somewhere where we open up the details. It should
 *      say from where this scenario was priced exactly. Also, in the future, we're
 *      going to add more engines."*
 *   3. *"When you do this bracket search by doing a full scenario search, when you
 *      click on details, you don't see the adjustments."*
 *
 * ⛔ AND ONE THING THAT MUST NOT MOVE: the vendor's own identifiers still leave
 * without an admin reveal. `pricedBy` is one key from a closed list of OUR engines;
 * `source` / `lenderId` / `investorOrganizationGuid` are the vendor's, and the two
 * are asserted apart in both directions.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const engineLabel = require(path.join(ROOT, 'src/longterm/pricing/engine-label.js'));
const quoteShape = require(path.join(ROOT, 'src/longterm/pricing/quote-shape.js'));
const board = require(path.join(ROOT, 'src/longterm/pricing/bracket-board.js'));

let pass = 0;
const fails = [];
function ok(cond, msg) { if (cond) pass += 1; else fails.push(msg); }

/** Read a source file with its COMMENTS STRIPPED — a "must not appear" check that
 *  read comments would fail on the very note explaining the fix, and then get
 *  "fixed" by deleting the explanation. */
function strip(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

/* ── A. THE REGISTRY ─────────────────────────────────────────────────────── */
ok(engineLabel.labelFor('lenderprice') === 'Lender Price', 'A1 lenderprice names itself');
ok(engineLabel.labelFor('loannex') === 'LoanNEX', 'A2 loannex names itself');
ok(engineLabel.labelFor('LOANNEX') === 'LoanNEX', 'A3 the key is read case-insensitively');
ok(engineLabel.labelFor('  loannex  ') === 'LoanNEX', 'A4 stray space is not a different engine');
// NEVER GUESSED: a panel that names the WRONG engine is worse than one that names none.
ok(engineLabel.labelFor('optimalblue') === null, 'A5 an engine we do not carry is not named');
ok(engineLabel.labelFor('') === null && engineLabel.labelFor(null) === null
  && engineLabel.labelFor(undefined) === null, 'A6 nothing is not an engine');
ok(engineLabel.subjectFor('loannex') === 'LoanNEX', 'A7 a sentence about a known engine names it');
ok(engineLabel.subjectFor('nope') === engineLabel.UNKNOWN_SUBJECT,
  'A8 a sentence about an unknown engine falls back to the neutral subject, never to an engine');
ok(engineLabel.ENGINE_KEYS.length === 2, 'A9 the registry carries exactly the two engines that exist today');

/* ── B. THE BROWSER MIRROR AGREES WITH THE SERVER, KEY FOR KEY ───────────── */
{
  const mirror = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/engineLabel.js'), 'utf8');
  for (const k of engineLabel.ENGINE_KEYS) {
    ok(new RegExp('\\b' + k + '\\s*:\\s*\\{').test(mirror), 'B1 the browser mirror carries ' + k);
    ok(mirror.indexOf("'" + engineLabel.ENGINES[k].label + "'") !== -1,
      'B2 the mirror prints the same name for ' + k);
  }
  // A mirror carrying an engine the server does not would name a row nothing produced.
  const mirrorKeys = (mirror.match(/^ {2}[a-z]+: \{ key:/gm) || []);
  ok(mirrorKeys.length === engineLabel.ENGINE_KEYS.length,
    'B3 the mirror carries no engine the server does not (' + mirrorKeys.length + ')');
  ok(mirror.indexOf(engineLabel.UNKNOWN_SUBJECT) !== -1,
    'B4 the neutral subject is the same sentence on both sides');
}

/* ── C. THE BOARD STAMPS BOTH HALVES — ON THE SCREEN THAT NAMES ITS ENGINE ─
   RE-POINTED after the combined board's own sweep (`test-lt-loannex-same-loan-pure` D14)
   caught the first cut of this: BOTH boards come off `programsForBoard`, so stamping
   unconditionally put `pricedBy: "loannex"` — the vendor's own name, on a priced row —
   onto the ONE-SYSTEM screen, which is the exact thing that sweep exists to find. The
   guard's subject has not moved (the stamp reaches both halves, the vendor trail still
   leaves); what it now asserts is the RULE the caller carries. */
{
  const merged = () => ({
    investors: [{
      key: 'ruby',
      whiteLabel: 'Ruby',
      programs: [
        { source: 'lenderprice', lenderId: 'LP-9', investorOrganizationGuid: 'guid-1', lender: 'NQM', options: [{}] },
        { lender: 'Acra', rungs: [{ rate: 7.375, price: 101 }] },
      ],
    }],
  });
  const rows = quoteShape.programsForBoard(merged(), { stampEngine: true });
  ok(rows.length === 2, 'C1 both halves reach the board');
  ok(rows[0].pricedBy === 'lenderprice', 'C2 the Lender Price half says so');
  ok(rows[1].pricedBy === 'loannex', 'C3 the LoanNEX half says so');
  // THE ONE-SYSTEM RULE IS UNTOUCHED without a reveal.
  ok(rows[0].source === undefined && rows[0].lenderId === undefined
    && rows[0].investorOrganizationGuid === undefined,
  'C4 the vendor trail still leaves without a reveal');
  ok(rows[1].source === undefined, 'C5 a LoanNEX row still gains no vendor trail without a reveal');
  const revealed = quoteShape.programsForBoard(merged(), { reveal: true });
  ok(revealed[0].source === 'lenderprice' && revealed[0].lenderId === 'LP-9',
    'C6 an admin reveal is unchanged');
  ok(rows[0].pricedBy === 'lenderprice' && rows[1].pricedBy === 'loannex'
    && rows[0].source === undefined,
  'C7 the stamp is NOT the reveal — the naming board carries it with the vendor trail stripped');

  /* ⛔ AND THE HALF THAT WAS MISSING. A caller that does not say its screen names the
     engine gets NOTHING on either half — this is the one-system property, asserted here
     on the SAME two rows so "withheld" is proven against a control that plainly has it. */
  const quiet = quoteShape.programsForBoard(merged(), {});
  ok(quiet.length === 2 && quiet.every((r) => r.pricedBy === undefined),
    `C7a a board that does not name its engine carries no stamp on either half (${quiet.filter((r) => r.pricedBy !== undefined).length} do)`);
  ok(JSON.stringify(quiet).toLowerCase().indexOf('loannex') === -1,
    'C7b …so the vendor\'s own name appears NOWHERE in that answer — the sweep D14 makes');
  ok(revealed[0].pricedBy === 'lenderprice' && revealed[1].pricedBy === 'loannex',
    'C7c …and an admin who ASKS gets it back, so the withholding is a decision, not a gap');
}
{
  /* THE TWO REAL CALLERS, PINNED. The rule above is worth nothing if the one-system board
     opts in, and a unit test of the builder can never see which board asked. */
  const gen = strip('src/longterm/pricing/general-board.js');
  const comb = strip('src/longterm/routes/combined-pricer.js');
  ok(/programsForBoard\(routed, \{[\s\S]{0,400}?stampEngine: true/.test(gen),
    'C7d the GENERAL board — staff-only, owner asked for the stamp — opts in');
  ok(!/stampEngine/.test(comb),
    'C7e the COMBINED board does not, so the one-system screen is never stamped');
}
{
  // A row whose origin the merged board did not state is inferred from its SHAPE,
  // never left to whichever engine is first in the registry.
  const rows = quoteShape.programsForBoard({
    investors: [{ key: 'k', programs: [{ lender: 'X', options: [{}] }, { lender: 'Y', rungs: [{ rate: 7 }] }] }],
  }, { stampEngine: true });
  ok(rows[0].pricedBy === 'lenderprice' && rows[1].pricedBy === 'loannex',
    'C8 an unstated origin is read from the row shape');
}
{
  // A BROWSER MAY NOT ASSERT IT — same reason as `source`: the response's to apply.
  const laid = quoteShape.optionFromRow({ pricedBy: 'loannex', source: 'loannex', terms: { term: 30 } });
  ok(laid && laid.pricedBy === undefined, 'C9 a posted row cannot assert which engine priced it');
  ok(laid && laid.source === undefined, 'C10 nor the vendor trail (unchanged)');
}

/* ── D. THE PRICE BUILD READS THE ROW, NOT THE BOARD ─────────────────────── */
{
  const src = strip('app-v2/src/longterm/LtPricer.jsx');
  ok(/\(quote && quote\.pricedBy\) \|\| \(oProp && oProp\.pricedBy\)/.test(src),
    'D1 the panel takes the engine off the row it is describing');
  ok(/pricedBy:\s*p\.pricedBy\s*\|\|\s*null/.test(src),
    'D2 the row carries the server stamp — never derived in the browser');
  // The three sentences the owner named, plus the fee and comp ones in the same class.
  ok(!/Every line came from \$\{engine\.sheetLabel\}/.test(src),
    'D3 "every line came from" no longer names the board-wide sheet');
  ok(/Every line came from \$\{buildSubject\}/.test(src),
    'D4 "every line came from" names this row\'s engine');
  ok(!/Adjustments total \(\$\{engine\.sheetLabel\}\)/.test(src),
    'D5 the adjustments total no longer names the board-wide sheet');
  /* ⛔ D6 IS INVERTED NOW, AND THE SECTION'S SUBJECT IS UNCHANGED.
     It pinned `Adjustments total (${engineName})` — correct about the thing this
     section is FOR (name THIS row's engine, never the board-wide sheet) and wrong
     about something it was not looking at: on a LoanNEX row that number is not the
     vendor's total at all. `quote-shape` derives each line's value from the vendor's
     `priceAdjustment` and then derives `adjustmentPoints` by SUMMING THOSE VALUES, so
     the total is this page's own arithmetic. Captioning it with the rate sheet's name
     told a reader checking our price against that very sheet that the sheet had
     vouched for the number — the one thing it must not say.
     The section's subject is still fully guarded: D3/D4/D5/D7/D8/D10 keep every
     sentence that NEEDS a subject on this row's engine, and a total that names no
     engine cannot name the wrong one. */
  ok(!/Adjustments total \(\$\{engineName\}\)/.test(src),
    'D6 the adjustments total does NOT claim the rate sheet\'s name — it is our sum of its lines');
  ok(/k="Adjustments total"/.test(src),
    'D6b …it is captioned as exactly what it is');
  ok(!/\$\{engine\.sheetSubject\} returned no/.test(src),
    'D7 no "returned no …" sentence names the board-wide sheet any more');
  ok((src.match(/\$\{buildSubject\} returned no/g) || []).length === 3,
    'D8 all three "returned no …" sentences name this row\'s engine');
  /* AN UNNAMED ROW PRINTS NOTHING RATHER THAN A GUESS — still true, and now true of
     every row: the total names no engine at all, so there is no name to guess. What
     still has to fall back safely is the SENTENCE that needs a subject (D10). */
  ok(/\$\{engineName \? `\$\{engineName\} ` : 'The rate sheet '\}/.test(src),
    'D9 the total\'s explanation names this row\'s engine, or says "the rate sheet" — never a guess');
  ok(/const buildSubject = engineName \|\| engine\.sheetSubject/.test(src),
    'D10 a sentence that needs a subject falls back to the neutral one');
}

/* ── E. THE STAMP ────────────────────────────────────────────────────────── */
{
  const src = strip('app-v2/src/longterm/LtPricer.jsx');
  ok(/Priced by \$\{engineName\}/.test(src), 'E1 the details panel stamps where the price came from');
  ok(/\{engineName && \(/.test(src), 'E2 a row we cannot name draws no stamp at all');
  /* ⛔ AND WHETHER A ROW MAY NAME ITS ENGINE IS THE ENGINE'S DECISION. The general
     board names it (the owner asked for it, and it is staff-only); the COMBINED board
     is ONE SYSTEM and shows a source only when an admin asks, so it names none — both
     boards come off the same builder and both carry `pricedBy`, so this flag is the
     one thing keeping them apart. The combined half is pinned by WIRE-13c/d in
     test-lt-combined-details-pure.js, which owns that screen's rule. */
  ok(/const rowEngine = engine\.namesRowEngine/.test(src),
    'E3 the panel READS that decision rather than making it');
  const eng = strip('app-v2/src/longterm/pricerEngine.js');
  ok(/key: 'general'[\s\S]*?namesRowEngine: true/.test(eng) || /namesRowEngine: true/.test(eng),
    'E4 …and the general engine is the one that says yes');
}

/* ── F. THE BAND'S OWN SEARCH RATIO ──────────────────────────────────────── */
{
  const F = board.readFigures({
    rentMonthly: 3800, taxMonthly: 500, insuranceMonthly: 150,
    loanAmount: 375000, termYears: 30, hoaMonthly: 0,
  });
  ok(F !== null, 'F0 the battery\'s figures are readable');
  const option = {
    priceBuild: { noteRate: 7.5 },
    monthlyPayment: { monthlyPI: 2622.06 },
    adjustments: [{ label: 'FICO 720-739', value: -0.25 }],
  };
  const runs = [];
  for (let t = 1; t <= 11; t += 1) {
    runs.push({ tier: t, sentRatio: 1 + (t / 100), programs: [{ lender: 'L', options: [option] }] });
  }
  const built = board.buildBoard(F, runs);
  const opts = [];
  for (const b of built.brackets) {
    for (const p of b.programs) for (const o of (p.options || [])) opts.push({ b: b, o: o });
  }
  ok(opts.length > 0, 'F1 the battery produces at least one in-band option');
  ok(opts.every((x) => x.o.searchDscr === x.b.sentRatio),
    'F2 every option carries the ratio ITS OWN band was searched at');
  ok(opts.every((x) => Array.isArray(x.o.adjustments) && x.o.adjustments.length === 1),
    'F3 the itemised adjustments survive the bracket board (they always did)');
  // The band's SEARCHED ratio and the ratio the RATE REACHES are different numbers.
  ok(opts.some((x) => x.o.searchDscr !== x.o.dscr),
    'F4 the searched ratio is not the reached ratio — they are two facts, not one');
}
{
  const src = strip('app-v2/src/longterm/LtPricer.jsx');
  ok(/const band = option && option\.searchDscr;/.test(src),
    'F5 the explain is bound to the band the row was priced in');
  ok(/\{ \.\.\.sc, dscr: Number\(band\) \}/.test(src),
    'F6 it asks the sheet about THAT band\'s loan');
  ok(/: sc;/.test(src), 'F7 an unbanded row asks exactly what it always asked');
}

/* ── G. THE BOARD STAYS WHERE IT IS ──────────────────────────────────────── */
{
  const keep = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/keepScroll.js'), 'utf8');
  ok(/behavior: 'auto'/.test(keep), 'G1 the correction is instant — a smooth one is itself a slide');
  ok(/requestAnimationFrame/.test(keep), 'G2 it restores after the browser has laid the change out');
  const src = strip('app-v2/src/longterm/LtPricer.jsx');
  /* ── A FINISHED SEARCH STARTS AT THE TOP OF ITS OWN ANSWER ───────────────────
     Owner-reported 2026-09-04: *"You search this scenario, and the search finishes. You
     right away get to the bottom, to the highest rate, the 11.5 rate. You need to stay at
     the top."*

     ⛔ THE CAUSE IS THE FOLD, so the guard is tied to the fold. `setFormOpen(false)` takes
     a long form out from ABOVE the board while the browser keeps the scroll offset, and
     that offset then points into the end of a much shorter page. A guard that only checked
     "backToTop is imported" would pass on a version that never calls it, and one that only
     checked "it is called somewhere" would pass on a call in the wrong handler. */
  {
    const kb = fs.readFileSync(path.join(ROOT, 'app-v2/src/longterm/keepScroll.js'), 'utf8');
    ok(/export function backToTop/.test(kb),
      'G9 the go-to-the-top move is a named, importable function — not two lines inside a handler CI cannot run');
    ok(/w\.scrollTo\(0, 0\)/.test(kb),
      'G9a …with the two-argument fallback, so an older browser is moved rather than silently left');
    ok(/backToTop/.test(src) && /import \{ keepPlaceOnClick, backToTop \}/.test(src),
      'G10 the board imports it from the one module that owns this screen\'s scrolling');
    /* THE CALL IS IN THE SUCCESS PATH, RIGHT AFTER THE FOLD — measured on the source, by
       distance, because "somewhere in the file" is exactly what would let it drift onto a
       refusal path or onto the band board that lands later. */
    const fold = src.indexOf('setFormOpen(false);');
    const call = src.indexOf('backToTop()', fold);
    ok(fold > 0 && call > fold && (call - fold) < 400,
      'G10a …and it runs in the success path immediately after the form is folded away, which is what moved the page');
    ok(/requestAnimationFrame\(\(\) => backToTop\(\)\)/.test(src),
      'G10b …on the NEXT frame, because the fold has not been laid out when the handler returns');
    // The band board and the ineligible list arrive seconds later; either one scrolling the
    // page would yank a board somebody is already reading.
    const calls = [...src.matchAll(/backToTop\(\)/g)].map((m) => m.index);
    ok(calls.length === 2 && calls.every((i) => i > fold && (i - fold) < 400),
      `G10c …and BOTH calls are that one pair (the frame and its fallback) — nothing else on this screen moves the page (${calls.length} found)`);
  }
  const wired = (src.match(/keepPlaceOnClick\(e,/g) || []).length;
  ok(wired === 4, 'G3 every open/close control on the board is anchored (found ' + wired + ' of 4)');
  ok(!/onClick=\{\(\) => onOpenQuote\(/.test(src), 'G4 no Details button toggles without the anchor');
  const ts = strip('app-v2/src/longterm/TermSheetPanel.jsx');
  ok(/keepPlaceOnClick\(e,/.test(ts), 'G5 the comparison button is anchored too');
  ok(/Added to comparison/.test(ts) && /Removed from comparison/.test(ts),
    'G6 the comparison press says what it did, beside the control that did it');
  ok(/wasBusy\.current && !busy/.test(ts),
    'G7 it says so only once the cart has answered — never on the click');
  /* ⛔ AND IT DESCRIBES THE PRESS, NOT THE LIST (owner-reported 2026-09-04: every Add
     announced itself as "Taken out of the comparison"). The direction is captured at the
     CLICK, from the state the click acted on; reading the membership at the moment the
     press finishes asks a different question and gets the pre-add answer. So the witness
     may never key on `on`, and the effect may never depend on it. */
  ok(/sending\.current = on \? 'remove' : 'add'/.test(ts),
    'G8 the direction is recorded at the click, off the state the click acted on');
  ok(/sending\.current === 'remove' \? 'Removed from comparison'/.test(ts),
    'G8a …and the sentence is chosen from THAT, never from the membership list');
  ok(/\}, \[busy\]\);/.test(ts),
    'G8b …so the witness no longer re-runs on a cart reload, which is what mis-fired it');
}

/* ── the tally ───────────────────────────────────────────────────────────── */
console.log('\n' + pass + ' passed, ' + fails.length + ' failed');
for (const f of fails) console.log('  X ' + f);
process.exit(fails.length ? 1 : 0);
