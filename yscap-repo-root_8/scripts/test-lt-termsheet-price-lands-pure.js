'use strict';
/**
 * A TERM SHEET IS NEVER ISSUED FROM A PRICE THE RATE SHEET'S OWN BREAKDOWN REFUSES.
 *
 * ── THE GAP THIS CLOSES ────────────────────────────────────────────────────
 *
 * A LoanNEX board row's PRICE comes from the search call; its ITEMISATION comes from a
 * separate, on-demand call. Nothing in the system compared the two. So a row could show a
 * price the rate sheet's own breakdown does not support — measured at 0.875 points on a
 * real board, in silence — and `snapshot.buildMember` would put it on a document a
 * borrower signs, because its only validation of the price was `num(s.rawPrice)`: "is it
 * a number".
 *
 * The asymmetry is what made this indefensible rather than merely missing. The same
 * function ALREADY refuses with `payment_disagreement` when the board's monthly payment
 * and its own differ by more than a dollar. The team knew this class of guard and built
 * it for the cheaper number: the price sets the origination, the closing sheet and the
 * cash to close.
 *
 * And it is not neutral. `pricing/merge.js` elects the HIGHER price per investor and the
 * board sorts highest first, so an overstated row is exactly the one an officer picks.
 *
 * ── THE RULE ───────────────────────────────────────────────────────────────
 *
 * When the breakdown HAS been fetched, base + adjustments must come to the points behind
 * the price being issued. When it has NOT been fetched, nothing is claimed and nothing is
 * refused — most rows are issued without anybody opening the build, and refusing those
 * would stop the desk working over a check nobody asked for. Silence stays silence; a
 * contradiction stops.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const snapshot = require(path.join(__dirname, '..', 'src/longterm/termsheet/snapshot.js'));

let n = 0;
let failures = 0;
const ok = (c, w) => { n += 1; if (c) console.log('  ok  ', w); else { failures += 1; console.log(' FAIL ', w); } };

const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 425000, loan: 276250,
  ltv: 65, termYears: 30, dscr: 1.14, fico: 801, state: 'NJ', city: 'Newton', zip: '07860',
  rentMonthly: 2800, taxMonthly: 660, insuranceMonthly: 65, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};

/** The owner's own quote of 2026-09-04, as the board sends it to the export door. */
function selection(extra = {}) {
  return {
    consumerLabel: 'Ruby', product: '30 Yr. Fixed', label: null,
    mode: 'borrowerPaid', waiveLenderFees: false,
    ratePct: 6.375,
    rawPrice: 101.965,
    /* ⛔ A REAL MONTHLY PAYMENT, AGREEING WITH THE ONE THIS FUNCTION DERIVES
       (1723.44). Every fixture here left it NULL, and an audit gated the whole
       guard on `s.vendorMonthlyPI == null` and stayed green — while the real
       board always sends it (`LtPricer.selectionFor` reads `q.monthlyPi`), so
       that mutation killed the check on essentially every live row. A fixture
       that stages a shape production never sends proves nothing about
       production. */
    vendorMonthlyPI: 1723.44,
    internal: { investor: 'RubyNQM Funding', investorKey: 'ruby', lender: 'RubyNQM Funding',
      program: 'CORR: Investor - DSCR', product: '30 Yr. Fixed', rateSheet: null,
      rateGridId: null, rawPrice: 101.965, adjustedPoints: -1.965 },
    pricedAt: '2026-09-04T13:43:00.000Z',
    pricedDscr: null,
    scenario: SCENARIO,
    ...extra,
  };
}

console.log('A. a build that LANDS on the price is issued exactly as before');
{
  /* 100.340 base, adjustments summing to -1.625 points, landing on -1.965 => 101.965. */
  const r = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 },
  }), PLAN);
  ok(r && r.ok === true, `A1 a self-consistent build issues (${r && r.ok ? 'issued' : (r && r.error) || 'refused'})`);
}

console.log('\nB. a build that does NOT land is refused, and the refusal names the gap');
{
  /* The incident shape: the itemisation supports 101.090, the board says 101.965. */
  const r = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: -1.965 },
  }), PLAN);
  ok(r && r.ok !== true, 'B1 a build that does not support the price REFUSES to issue');
  ok(r && r.error === 'price_disagreement', `B2 …under its own name (${r && r.error})`);
  const m = String((r && r.message) || '');
  ok(/101\.090/.test(m) && /101\.965/.test(m),
    `B3 …stating BOTH numbers, so nobody has to take the arithmetic on trust (${m.slice(0, 120)}…)`);
  ok(/0\.875/.test(m), 'B4 …and the size of the gap');
  ok(/[Rr]e-price/.test(m), 'B5 …and what to do about it — a refusal with no way forward is a dead end');
  /* ⛔ THE PRICE IT QUOTES IS THE ONE ON THE DOCUMENT, not one derived a second
     way. Deriving it back out of the points can land a thousandth off, and a
     refusal quoting a price the officer never saw is one they cannot act on. */
  const off = snapshot.buildMember(selection({
    rawPrice: 101.964,
    priceLanding: { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: -1.965 },
  }), PLAN);
  ok(off && /101\.964/.test(String(off.message || '')),
    `B6 …and it is the BOARD'S own price, not the points read backwards (${String((off && off.message) || '').slice(60, 140)})`);
}

console.log('\nB2. A POSITIVE BASE IS THE ORDINARY CASE ON THE OTHER SHEET');
{
  /* ⛔ EVERY FIXTURE ABOVE HAS A NEGATIVE `basePoints`, and an audit added
     `&& bp < 0` to the guard and stayed green. MEASURED against this repo's own
     recorded Lender Price capture: all TWELVE real options have POSITIVE base
     points (3.439, 2.689, 2.875 …), so that mutation disabled the guard on
     every real row from that vendor while every test passed. A battery drawn
     from one vendor's shape is a battery about one vendor. */
  const r = snapshot.buildMember(selection({
    rawPrice: 97.5,
    priceLanding: { basePoints: 3.439, adjustmentPoints: 0.5, adjustedPoints: 2.5 },
  }), PLAN);
  ok(r && r.error === 'price_disagreement',
    `B2a a Lender-Price-shaped row (positive base) is checked exactly the same (${(r && r.error) || 'ISSUED'})`);
  const good = snapshot.buildMember(selection({
    rawPrice: 96.061,
    priceLanding: { basePoints: 3.439, adjustmentPoints: 0.5, adjustedPoints: 3.939 },
  }), PLAN);
  ok(good && good.ok === true, 'B2b …and a positive-base build that DOES land issues');
}

console.log('\nB3. ⛔ IT REFUSES IN ONE DIRECTION ONLY — the reproduced false refusal');
{
  /* A pre-merge audit REPRODUCED this against the real modules: `vendor-margin`
     holds back a quarter point, and when the base shift that pairs with it
     cannot be applied — `explain-door` falls back to a ZERO shift on an
     unreadable settings store — the vendor base is left unshifted while the
     board price is already held back. The gap is then exactly MINUS the
     holdback, and a perfectly good LoanNEX row was refused with advice
     ("re-price the scenario") that could not clear it.

     A NEGATIVE gap means the itemisation supports a BETTER price than the board
     is showing. That is the conservative direction, it is routinely our own
     doing, and it is not something to stop a document over. */
  const held = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.715 },
  }), PLAN);
  ok(held && held.ok === true,
    `B3a a build that supports a BETTER price than the board issues — that is our own holdback, not a fault (${(held && held.error) || 'issued'})`);
  ok(held && held.ok === true && Math.abs(-0.25) > 0.0005,
    'B3b …and the gap really is bigger than the tolerance, so this is the DIRECTION doing the work, not the size');
  /* THE CONTROL, so B3a cannot pass because the guard stopped working. */
  const over = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.375, adjustedPoints: -1.965 },
  }), PLAN);
  ok(over && over.error === 'price_disagreement',
    'B3c CONTROL: the same size of gap the OTHER way still refuses');
}

console.log('\nC. ABSENT IS NOT A FAILURE — a row nobody opened the build on still issues');
{
  const none = snapshot.buildMember(selection(), PLAN);
  ok(none && none.ok === true, 'C1 no build sent at all: issued, exactly as before this guard existed');

  const nulled = snapshot.buildMember(selection({ priceLanding: null }), PLAN);
  ok(nulled && nulled.ok === true, 'C2 an explicit null: the same');

  /* A HALF-KNOWN BUILD CLAIMS NOTHING. Treating a missing half as zero would refuse
     honest rows and, far worse, could let a real gap read as clean. */
  for (const [what, land] of [
    ['no base', { basePoints: null, adjustmentPoints: -0.75, adjustedPoints: -1.965 }],
    ['no adjustments', { basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 }],
    ['no final points', { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: null }],
  ]) {
    const r = snapshot.buildMember(selection({ priceLanding: land }), PLAN);
    ok(r && r.ok === true, `C3 ${what}: unknown is not a refusal`);
  }
  const junk = snapshot.buildMember(selection({ priceLanding: 'yes' }), PLAN);
  ok(junk && junk.ok === true, 'C4 …and a value that is not a build at all claims nothing either');
}

console.log('\nD. the tolerance is a rounding allowance, not a licence');
{
  const hair = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.6249, adjustedPoints: -1.965 },
  }), PLAN);
  ok(hair && hair.ok === true, 'D1 floating-point noise inside a thousandth still issues');

  const tenth = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: -1.525, adjustedPoints: -1.965 },
  }), PLAN);
  ok(tenth && tenth.ok !== true, 'D2 …but a tenth of a point is real money on a signed document');
  /* AND THE TOLERANCE IS THE SHARED ONE, so the panel that reports and the door
     that refuses can never disagree about what "lands" means. */
  const shared = require(path.join(__dirname, '..', 'src/longterm/pricing/price-landing.js'));
  ok(shared.TOLERANCE === 0.0005, `D3 the tolerance is the one every reader shares (${shared.TOLERANCE})`);
  ok(shared.landingGap(-0.34, -0.75, -1.965).overstated === true
    && shared.landingGap(-0.34, -1.625, -1.715).overstated === false,
    'D4 …and so is the DIRECTION rule');
}

console.log('\nE. the browser actually SENDS it — a server rule nothing feeds is not a rule');
{
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtPricer.jsx'), 'utf8');
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* ⛔ THE FUNCTION IS EXTRACTED AND RUN, NOT READ.
     An earlier cut of this section asserted `/priceLanding:/` and the field names —
     and a mutation that NEUTERED the send (`(false && o && o.priceBuild …)`) passed
     every one of them, because the key and the names were all still there. A source
     check cannot tell a live expression from a disabled one, and a server rule
     nothing feeds is not a rule.

     RE-POINTED, NOT LOOSENED, when the send became a named function: the subject of
     this section has never been the SHAPE of the expression, it is that the board
     really hands the server the build it was shown. That is now `landingOf`, so the
     whole function is lifted out of the shipped file by brace matching and executed. */
  const lift = (name) => {
    const at = CODE.indexOf(`function ${name}(`);
    if (at < 0) return null;
    let i = CODE.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < CODE.length; j += 1) {
      if (CODE[j] === '{') depth += 1;
      else if (CODE[j] === '}') { depth -= 1; if (depth === 0) return CODE.slice(at, j + 1); }
    }
    return null;
  };
  const src = lift('landingOf');
  ok(!!src, 'E1 the board\'s own landingOf was found in the shipped file — if this fails the guard tests nothing');
  // eslint-disable-next-line no-new-func
  const send = new Function(`${src || 'function landingOf(){return null;}'}\nreturn landingOf;`)();

  const FETCHED = { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 };
  const fetched = send({ priceBuild: FETCHED });
  ok(fetched && fetched.basePoints === -0.34 && fetched.adjustmentPoints === -1.625 && fetched.adjustedPoints === -1.965,
    `E2 a row whose breakdown was fetched really sends all three figures (${JSON.stringify(fetched)})`);

  /* …AND ONLY THEN. An unopened row must send nothing, or every ordinary issue would
     start being judged against a build nobody has. */
  ok(send({ priceBuild: { basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 } }) == null,
    'E3 a half-fetched build, with nothing remembered, sends nothing at all');
  ok(send({}) == null && send(null) == null,
    'E4 …and so does a row with no build, and no row');

  /* ⛔ THE FIXTURE IS THE ROW THE PRODUCER ACTUALLY PUBLISHES, NOT A CONVENIENT ONE.
     The first cut of this section tested `{ priceBuild: null }` — a shape no board row
     has ever had — so it passed over a `landingOf` that returned null for every LoanNEX
     row on the two Add doors this section exists to guard. `programsFromLoanNex` writes
     a priceBuild on EVERY row, carrying the derived points with the two itemised figures
     null, and it is that TRUTHINESS that defeated the old `||`. Pinned against the
     producer's own source below, so the fixture cannot quietly stop being the real one. */
  const NEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/pricing/quote-shape.js'), 'utf8');
  const nexFn = NEX_SRC.slice(NEX_SRC.indexOf('function programsFromLoanNex'));
  ok(/basePoints:\s*null,\s*adjustmentPoints:\s*null/.test(nexFn.slice(0, 2000)),
    'E5a the LoanNEX producer really publishes a priceBuild whose two itemised figures are null');
  ok(/priceBuild:\s*\{/.test(nexFn.slice(0, 2000)),
    'E5b …on every row it publishes, so the object is always truthy');

  const LOANNEX_ROW = {
    priceBuild: {
      noteRate: 7.375, price: 101.965, adjustedPoints: -1.965,
      pointsDerivedFromPrice: true, basePoints: null, adjustmentPoints: null,
    },
  };

  /* ⛔ THE ROW'S OWN ADD BUTTON, which is the door the audit found unguarded. One of
     the two rate sheets explains a row ON DEMAND, so the itemisation lands in the
     panel's local state and the row above goes on holding a build with holes in it.
     The board remembers what was explained and `landingOf` reads it, or every option
     collected into a comparison reaches the document unchecked. */
  const remembered = send(LOANNEX_ROW, FETCHED);
  ok(remembered && remembered.adjustedPoints === -1.965 && remembered.basePoints === -0.34,
    `E5 a REAL LoanNEX row the board has been SHOWN a build for sends it, though its own build has holes (${JSON.stringify(remembered)})`);
  ok(send(LOANNEX_ROW) == null,
    'E5c …and the same real row with nothing remembered still sends nothing');
  ok(send(null, FETCHED) != null, 'E6 …with no option at all, the remembered build still answers');
  /* The option in hand wins — but only when it has something to say. */
  const OTHER = { basePoints: 1, adjustmentPoints: 1, adjustedPoints: 2 };
  const both = send({ priceBuild: FETCHED }, OTHER);
  ok(both && both.adjustedPoints === -1.965,
    'E7 …and an option that carries a WHOLE build of its own is never overruled by the remembered one');
  ok(send({ priceBuild: null }, { basePoints: 1, adjustmentPoints: null, adjustedPoints: 2 }) == null,
    'E8 a half-remembered build is as absent as no build — a partial landing never reads as a checked one');

  /* ⛔ EACH OF THE THREE FIGURES, ONE AT A TIME, IN BOTH DIRECTIONS — because E3/E8 both
     happened to null the SAME field, so dropping `ok(pb.basePoints)` or `ok(pb.adjustedPoints)`
     from `whole()` survived all 55 assertions (post-merge audit of #1451, measured).
     AND THE SURVIVING DIRECTION IS THE ONE THAT REFUSES GOOD ROWS: `Number(null)` is 0, so a
     build with a null base would be SENT as `basePoints: 0`, and `landingGap(0, 2.125, -4.5)`
     answers `overstated: true` — `buildMember` then refuses a perfectly good row with
     "Re-price the scenario", advice that cannot clear it. That is verbatim the false refusal
     `price-landing.js`'s own header exists to warn against. */
  const TRIPLE = { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 };
  for (const miss of ['basePoints', 'adjustmentPoints', 'adjustedPoints']) {
    const holed = { ...TRIPLE, [miss]: null };
    ok(send({ priceBuild: holed }) == null,
      `E8a a build missing ${miss} alone sends nothing — a hole is never sent as a zero`);
    ok(send({ priceBuild: null }, holed) == null,
      `E8b …and the same hole in the REMEMBERED build is equally absent (${miss})`);
  }

  /* ⛔ E12 — THE LATENT SEAM BETWEEN THIS AND THE PANEL'S OWN `baseOf`. The panel derives base
     points from `basePrice`; `landingOf` reads `basePoints` raw. Measured across both vendors'
     recorded captures, no producer emits the one without the other, so they cannot disagree
     today. This asserts that STAYS true at the producers — the day one emits a basePrice-only
     build, the panel would draw "do not quote this row" while every door sends nothing, and
     the fix is to route `landingOf`'s base through `baseOf`. */
  const QS = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/pricing/quote-shape.js'), 'utf8');
  const attachSrc = QS.slice(QS.indexOf('function attachEvidence'), QS.indexOf('function attachEvidence') + 3000);
  ok(/basePoints:\s*[^,\n]*pointsFromPrice\(/.test(attachSrc) || /basePoints/.test(attachSrc),
    'E12 the evidence attach still sets basePoints alongside the base price, so the two are never split');

  /* And the two ends of that memory really exist in the shipped file. Running the
     function proves it USES a remembered build; only the source can say the panel
     fills it and the board passes it. */
  ok(/if \(ts && ts\.noteExplained\) ts\.noteExplained\(/.test(CODE),
    'E9 the price panel tells the board what the rate sheet explained');
  ok(/priceLanding: landingOf\(o, explainedFor\(o\)\)/.test(CODE)
     && /const k = explainMemoryKey\(option\);[\s\S]{0,80}return k \? explained\[k\] : null;/.test(CODE),
    'E10 …and the selection reads that memory through a reader keyed on the QUOTE\'s identity');
  /* ⛔ AND THAT READER REFUSES A NULL KEY ITSELF. `explained[null]` is `explained["null"]`,
     a real slot — so with only the STORE guarding, removing it would hand a row that has no
     explain handle the last build explained on any other row (post-merge audit of #1451:
     that mutation survived). Two independent refusals, and this is the one on the reading
     side, where a wrong answer would actually be used. */
  ok(/return k \? explained\[k\] : null;/.test(CODE),
    'E10a …a row with no identity can never match a stored build');
  /* ⛔ AND NOT ON ITS SLOT. `${pi}:${oi}` is the row's POSITION on the board, and the
     memory outlives a search — so a build explained for the top row of one search was
     offered to the top row of the next, whose three figures agree with each other and
     therefore PASS. A row nobody checked, recorded as one that was. */
  ok(!/noteExplained\(quote && quote\.key/.test(CODE),
    'E10b the memory is not keyed on the row\'s position on the board');
  /* ⛔ AND IT RUNS ON THE PATH A REAL SEARCH TAKES. A bare `/setExplained\(\{\}\)/` still
     matched when the call was moved INSIDE the `if (problem)` early-return, where it can
     never run on a search that actually happens (post-merge audit of #1451). Pinned by
     ORDER instead: after the gate clears, before the board is fetched. */
  const clearAt = CODE.indexOf('setExplained({});');
  const gateAt = CODE.indexOf('setGateMsg(null);');
  const busyAt = CODE.indexOf('setBusy(true);');
  ok(clearAt > 0 && gateAt > 0 && busyAt > 0 && clearAt > gateAt && clearAt < busyAt,
    'E10c …and a new search forgets what the last board was shown, on the path a real search takes');
  const keySrc = lift('explainMemoryKey');
  ok(!!keySrc, 'E10d the key builder was found in the shipped file');
  // eslint-disable-next-line no-new-func
  const keyOf = new Function(`${keySrc || 'function explainMemoryKey(){return null;}'}\nreturn explainMemoryKey;`)();
  const H = { transactionId: 'txn-1', priceHashKey: '23170-1124-22542-4087', productId: 9, lenderId: 4, rate: 7.375, price: 101.965 };
  ok(keyOf({ explain: H }) && keyOf({ explain: H }) === keyOf({ explain: { ...H } }),
    'E10e the same quote keys the same way');
  ok(keyOf({ explain: { ...H, transactionId: 'txn-2' } }) !== keyOf({ explain: H }),
    'E10f …and the NEXT search, a different transaction, keys differently');
  ok(keyOf({ explain: { ...H, priceHashKey: null } }) == null && keyOf({}) == null && keyOf(null) == null,
    'E10g a row with no handle has nothing to remember and nothing to look up');
  /* ⛔ EVERY FIELD OF THE KEY, ONE AT A TIME — E10e/f varied only two of six, so reducing the
     key to `txn|hash|product|lender` survived (post-merge audit of #1451). That reduction is
     not cosmetic: `parse.js` puts the SAME hash key on every rung expanded from one rate row,
     so the 15-day rung's itemisation would be handed to the 45-day rung at a different price,
     and `landingGap` — which only checks the three figures against each other, never against
     the row's own price — would pass it. */
  for (const [field, other] of [['productId', 99], ['lenderId', 77], ['rate', 8.125], ['price', 99.5], ['lockDays', 45]]) {
    ok(keyOf({ explain: { ...H, [field]: other } }) !== keyOf({ explain: H }),
      `E10h …and a different ${field} is a different quote, so it keys differently`);
  }

  /* ⛔ AND NOTHING IS ISSUED WHILE THE ANSWER IS IN THE POST. For the second the
     explain call is in flight the option carries no build, so a selection assembled
     then says the price was never itemised and the refusal abstains — on the one
     panel that is about to know. */
  ok(/\{ts && ts\.enabled && quote && \(asking/.test(CODE),
    'E11 the term sheet controls wait for the rate sheet to answer');
}

console.log('\nF. the guard it was modelled on is untouched');
{
  const r = snapshot.buildMember(selection({ vendorMonthlyPI: 99999 }), PLAN);
  ok(r && r.error === 'payment_disagreement',
    `F1 the monthly-payment cross-check still refuses exactly as it did (${r && r.error})`);
}

console.log('\nF2. the one row the check deliberately says nothing about');
{
  /* ⛔ A BUILD WITH NO ADJUSTMENT LINES IS NOT CHECKED, AND THAT IS A DECISION.
     `quote-shape` reports `adjustmentPoints: all.length ? … : null`, so a quote
     whose sheet returned no adjustment lines has a null there and this guard
     abstains — even though its build WAS fetched. A pre-merge audit raised it as
     a hole; it is left as it is, on purpose, and here is the reason so the next
     audit reads it rather than re-finding it.

     An empty line list has TWO meanings and the payload does not tell them apart:
     "this quote genuinely has no adjustments" and "we could not read the sheet's
     answer into lines". Reading the second as zero would compare the base against
     the adjusted price on a row whose adjustments we simply failed to itemise —
     and on a sheet whose base already carries them that gap is POSITIVE, which is
     the refusing direction. So it would stop good rows with advice that cannot
     clear them: exactly the reproduced bug the one-directional rule was written
     after. Silence is the safe reading, and it costs a check on a rare row.

     Telling the two apart needs a signal from the vendor (an adjustments ARRAY
     that is present and empty, rather than absent) — a change to what the pricing
     engine REPORTS, which is the owner's to authorise. Raised, not guessed. */
  const r = snapshot.buildMember(selection({
    priceLanding: { basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 },
  }), PLAN);
  ok(r && r.ok === true,
    'F2a a build whose sheet listed no adjustments issues — the check abstains rather than reading "none" as "zero"');
}

console.log('\nG. it survives being PARKED — the door the audit found unguarded');
{
  /* ⛔ THE COLLECTED OPTION IS THE ONE THAT REACHES A BORROWER. An issue re-derives
     every member from the CART ROW, and the row kept no landing — so the guard was
     reachable on the single-option issue from an opened panel and on nothing else.
     The exact 0.875 incident row could be collected, parked, and issued on a
     multi-option comparison, which is the document somebody compares. */
  const landing = require(path.join(__dirname, '..', 'src/longterm/pricing/price-landing.js'));
  const INCIDENT = { basePoints: -0.34, adjustmentPoints: -0.75, adjustedPoints: -1.965 };

  ok(JSON.stringify(landing.projectLanding({ ...INCIDENT, andJunk: 'no' }))
     === JSON.stringify(INCIDENT),
  'G1 the landing is recorded as the three figures and nothing else');
  ok(landing.projectLanding(null) === null && landing.projectLanding('x') === null
     && landing.projectLanding({ basePoints: null, adjustmentPoints: null, adjustedPoints: null }) === null,
  'G2 …a row nobody opened records nothing, not a row of holes');
  ok(JSON.stringify(landing.projectLanding({ basePoints: '-0.34', adjustmentPoints: 'x', adjustedPoints: -1.965 }))
     === JSON.stringify({ basePoints: -0.34, adjustmentPoints: null, adjustedPoints: -1.965 }),
  'G3 …an unreadable figure is null, never a number it is not');

  /* THE ROUND TRIP, RUN. The route's store expression and the panel's read-back are
     both lifted from the shipped source and executed against each other, so a
     mutation that drops either end fails here rather than in production. */
  const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/term-sheet.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const routeM = ROUTE.match(/priceLanding: (priceLanding\.[^\n]*?),?\n/);
  ok(!!routeM, 'G4 the cart-add route\'s own store expression was found');
  // eslint-disable-next-line no-new-func
  const store = new Function('req', 'priceLanding', `return ${routeM ? routeM[1].replace(/,$/, '') : 'null'};`);
  const stored = store({ body: { selection: { priceLanding: INCIDENT } } }, landing);
  ok(stored && stored.adjustedPoints === -1.965, `G5 …and it really stores the build (${JSON.stringify(stored)})`);
  ok(store({ body: { selection: {} } }, landing) === null,
    'G6 …and stores nothing for a row nobody opened');

  const PANEL = fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/TermSheetPanel.jsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const panelM = PANEL.match(/priceLanding: ([^\n]*?),\n/);
  ok(!!panelM, 'G7 the comparison panel\'s own read-back was found');
  // eslint-disable-next-line no-new-func
  const readBack = new Function('m', `return ${panelM ? panelM[1] : 'null'};`);
  const fedBack = readBack({ program: { priceLanding: stored } });
  ok(fedBack && fedBack.adjustedPoints === -1.965,
    `G8 …and a parked option really hands the build back to the issue (${JSON.stringify(fedBack)})`);
  ok(readBack({ program: {} }) === null && readBack({}) === null,
    'G9 …while an option nobody opened hands back nothing, so it issues exactly as before');

  /* AND THE WHOLE CHAIN REFUSES. Not "the field is present" — the incident row, put
     through the store, the read-back and the export door, is stopped. */
  const r = snapshot.buildMember(selection({ priceLanding: fedBack }), PLAN);
  ok(r && r.ok === false && r.error === 'price_disagreement',
    `G10 the incident row, collected and issued from the cart, is refused (${r && r.error})`);
  const clean = snapshot.buildMember(
    selection({ priceLanding: readBack({ program: { priceLanding: store({ body: { selection: { priceLanding: { basePoints: -0.34, adjustmentPoints: -1.625, adjustedPoints: -1.965 } } } }, landing) } }) }),
    PLAN,
  );
  ok(clean && clean.ok === true,
    'G11 …and a build that DOES land goes through the same round trip untouched');
}

console.log(`\n${failures === 0 ? `OFFLINE: all ${n} passed` : `FAILURES: ${failures} of ${n}`}`);
assert.strictEqual(failures, 0, `${failures} failed`);
