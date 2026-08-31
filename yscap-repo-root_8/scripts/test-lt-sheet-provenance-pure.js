'use strict';
/**
 * LT — PULLING UP A TERM SHEET BY ITS ID, AND WHO WAS REALLY BEHIND THE PRICE.
 *
 * Owner-reported 2026-08-31: *"there is no place where loan officers can go in
 * and see the data when they put in the ID … see exactly what the input was and
 * what exactly they priced in the real program and the real investors behind
 * everything."*
 *
 * The two halves of that ask pull in OPPOSITE directions and this suite exists
 * to hold both at once:
 *
 *   (1) an officer must be able to see the investor behind an issued price, and
 *   (2) an investor's name may never appear on the document (CLAUDE.md rule 10),
 *
 * which is why the record is a SIBLING of the snapshot rather than a key on it.
 * Every assertion below is about keeping those two apart — the projection that
 * decides what is recorded, the guarantee that the recorded name cannot reach
 * the document, and the SOURCE guards over the three files that draw one.
 *
 * NO DATABASE AND NO BROWSER: `internal.js` is pure by construction, and the
 * screen and the route are asserted by reading their source, because no unit
 * test can see whether a route hands a value to a screen that never mounts.
 */

const fs = require('fs');
const path = require('path');

const internal = require('../src/longterm/termsheet/internal');
const snapshot = require('../src/longterm/termsheet/snapshot');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};
const section = (t) => console.log(`\n${t}`);

const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
/** Comments necessarily NAME what they forbid, so a "must not appear" guard that
 *  read them would fail on its own explanation and then be "fixed" by deleting
 *  the explanation. Every absence assertion below runs on stripped source. */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');

// The documented ladder's own plan and scenario, so this suite prices the same
// loan `test-lt-termsheet-pure.js` does and the two cannot drift about what a
// valid quote looks like.
const PLAN = { borrowerPaid: 2, ysp: 2, lenderPaid: 2, applicationFee: 500, commitmentFee: 1595 };
const SCENARIO = {
  purpose: 'Purchase', propertyType: 'Single family', value: 500000, loan: 375000,
  ltv: 75, termYears: 30, dscr: 1.24, fico: 740, state: 'NJ', city: 'Lakewood', zip: '08701',
  rentMonthly: 4161, taxMonthly: 620, insuranceMonthly: 145, hoaMonthly: 0,
  prepayMonths: 60, prepayStructure: '5 Year',
};
/** A REAL investor spelling from the registry rule 10 is built on. If this ever
 *  reaches a document the scrub is the last defence, so the test uses one the
 *  scrub would actually recognise rather than an invented word. */
const INVESTOR = 'Deephaven Mortgage';
const quote = (label, ratePct, rawPrice, extra) => Object.assign({
  label, consumerLabel: 'Platinum', product: '30-Year Fixed DSCR', mode: 'borrowerPaid',
  ratePct, rawPrice, scenario: SCENARIO, pricedAt: '2026-08-30T13:30:00.000Z',
}, extra || {});
const withInvestor = (label, ratePct, rawPrice) => quote(label, ratePct, rawPrice, {
  internal: {
    investor: INVESTOR,
    investorKey: 'deephaven',
    lender: 'Deephaven Mortgage LLC',
    program: 'DSCR Elite 30yr Fixed',
    product: 'DSCR-E30',
    rateSheet: 'Wholesale 08/30 AM',
    rateGridId: 'grid-1188',
    rawPrice,
    adjustedPoints: -1.25,
  },
});

// =============================================================================
section('A. what is recorded about a vendor is a whitelist, not a copy');
// =============================================================================
{
  const out = internal.projectInternal({
    investor: 'Deephaven Mortgage', lender: 'Deephaven Mortgage LLC',
    program: 'DSCR Elite', product: 'X1', rateSheet: 'Wholesale', rateGridId: 'g1',
    investorKey: 'deephaven', rawPrice: '99.875', adjustedPoints: -1.25,
    // Everything below is what a browser might also be holding on that row.
    borrowerName: 'A Real Person', ssn: '123-45-6789', internalNotes: 'do not keep',
    buyRate: 6.5, lenderId: 'lp-4412',
  });
  check(Object.keys(out).sort().join(',') === internal.FIELDS.slice().sort().join(','),
    'A1 exactly the nine declared fields survive');
  check(!('borrowerName' in out) && !('ssn' in out) && !('lenderId' in out),
    'A2 …and a caller cannot grow the record by sending more');
  check(out.rawPrice === 99.875 && out.adjustedPoints === -1.25,
    'A3 the two numbers are read as numbers, not kept as text');
  check(internal.projectInternal({ rawPrice: 'par' }).rawPrice === undefined,
    'A4 …and an unreadable number is dropped rather than stored as NaN');
  check(internal.projectInternal({ investor: `${'D'.repeat(400)}` }).investor.length === internal.CAPS.investor,
    'A5 text is capped by the field, so a runaway value cannot be stored');
  check(internal.projectInternal({ investor: ' Deephaven \n\t Mortgage ' }).investor === 'Deephaven Mortgage',
    'A6 control characters and whitespace runs are folded');
  check(internal.projectInternal({ investor: '   ' }).investor === undefined,
    'A7 a blank is not a value');
}
{
  // ⛔ ALWAYS AN OBJECT. Two shapes for one meaning would make every reader
  // handle a second case that says the same thing.
  for (const junk of [null, undefined, 'Deephaven', 42, [], true]) {
    const out = internal.projectInternal(junk);
    if (!out || typeof out !== 'object' || Array.isArray(out) || Object.keys(out).length !== 0) {
      check(false, `A8 junk input (${JSON.stringify(junk)}) yields an empty object`);
    }
  }
  check(true, 'A8 junk input yields an empty object, never null and never a copy');
  check(internal.isEmpty({}) && internal.isEmpty(null) && internal.isEmpty([]) && internal.isEmpty('x'),
    'A9 isEmpty answers true for everything that carries nothing');
  check(internal.isEmpty({ investor: 'Deephaven Mortgage' }) === false,
    'A10 …and false the moment there is something to show');
  check(/before/i.test(internal.NOT_RECORDED) && !/unknown/i.test(internal.NOT_RECORDED),
    'A11 the blank sentence says the record predates the feature, never "unknown"');
}

// =============================================================================
section('B. the investor is recorded BESIDE the document, never on it');
// =============================================================================
{
  const built = snapshot.buildSnapshot({
    selections: [withInvestor('The offer', 7.375, 102)], plan: PLAN, prepared: {},
  });
  check(built.ok, 'B1 a quote carrying the investor block still builds');
  const asText = JSON.stringify(built.snapshot);
  check(!asText.includes('Deephaven'),
    'B2 ⛔ the SNAPSHOT — the thing the PDF is drawn from — carries no investor name');
  check(!asText.includes('DSCR Elite') && !asText.includes('Wholesale 08/30 AM') && !asText.includes('grid-1188'),
    'B3 …nor their programme name, their rate sheet or their grid id');
  check(!asText.includes('"internal"'),
    'B4 …and `internal` is not a key on the snapshot at all');
  check(Array.isArray(built.internal) && built.internal.length === 1,
    'B5 the record comes back as a SIBLING of the snapshot');
  check(built.internal[0].investor === INVESTOR && built.internal[0].program === 'DSCR Elite 30yr Fixed',
    'B6 …carrying what the officer actually priced');
}
{
  // ⛔ THE RECORD CANNOT MOVE THE DOCUMENT'S FINGERPRINT. The hash is the proof
  // of what was sent; if the provenance could change it, adding a note about the
  // investor would make an untouched sheet report as tampered with on replay.
  const withIt = snapshot.buildSnapshot({
    selections: [withInvestor('The offer', 7.375, 102)], plan: PLAN, prepared: {},
  });
  const without = snapshot.buildSnapshot({
    selections: [quote('The offer', 7.375, 102)], plan: PLAN, prepared: {},
  });
  check(snapshot.hashSnapshot(withIt.snapshot) === snapshot.hashSnapshot(without.snapshot),
    'B7 the same quote hashes identically with and without the provenance');
  check(internal.isEmpty(without.internal[0]),
    'B8 …and a board that sent none records none, rather than an invented one');
}
{
  // POSITIONAL ALIGNMENT IS THE CONTRACT: index i of `internal` describes index i
  // of `members`, and a comparison is where that would silently go wrong.
  const built = snapshot.buildSnapshot({
    selections: [
      withInvestor('First', 7.375, 102),
      quote('Second', 7.625, 101, { internal: { investor: 'Verus Mortgage Capital', program: 'Investor Cash Flow' } }),
      quote('Third', 7.875, 100),
    ],
    plan: PLAN,
    prepared: {},
  });
  check(built.ok && built.snapshot.members.length === 3 && built.internal.length === 3,
    'B9 a three-option comparison records three, in order');
  check(built.internal[0].investor === INVESTOR
    && built.internal[1].investor === 'Verus Mortgage Capital'
    && internal.isEmpty(built.internal[2]),
    'B10 …each aligned with its own option, and the one with nothing stays empty');
  check(!JSON.stringify(built.snapshot).includes('Verus'),
    'B11 …and neither name is anywhere on the comparison document');
}
{
  // A REFUSAL MUST NOT LEAVE A HALF-BUILT RECORD BEHIND.
  const bad = snapshot.buildSnapshot({
    selections: [withInvestor('ok', 7.375, 102), quote('no rate', null, 101)],
    plan: PLAN,
    prepared: {},
  });
  check(!bad.ok && bad.memberIndex === 1, 'B12 a bad option is refused by position');
  check(bad.internal === undefined, 'B13 …and a refusal carries no provenance at all');
}

// =============================================================================
section('C. nothing that DRAWS a document can reach the record');
// =============================================================================
{
  // The three files that turn a snapshot into something a client reads. If any
  // of them learns about `internal`, the separation stops being structural.
  for (const rel of ['src/longterm/termsheet/pdf.js', 'src/longterm/termsheet/layout.js',
    'src/longterm/termsheet/comparison.js']) {
    const src = stripComments(read(rel));
    check(!/\binternal\b/.test(src), `C1 ${path.basename(rel)} never names the provenance`);
  }
}
{
  const store = stripComments(read('src/longterm/termsheet/store.js'));
  // The PDF and the replay are built from `findByCode`'s row. The provenance is
  // deliberately NOT selected there: a projection mistake in the replay route
  // cannot leak what the replay route never loaded.
  const findBy = store.slice(store.indexOf('async function findByCode'), store.indexOf('function verifyIntegrity'));
  check(findBy.length > 0 && !/internal/.test(findBy),
    'C2 `findByCode` — what the PDF is drawn from — does not select the provenance');
  check(/async function readInternal/.test(store),
    'C3 …it has its own reader instead');
  check(/parent_kind = 'sheet'/.test(store.slice(store.indexOf('async function readInternal'))),
    'C4 …scoped to the SHEET rows, so a cart cannot answer for a sheet');
}
{
  const route = read('src/longterm/routes/term-sheet.js');
  const stripped = stripComments(route);
  check(/internal: built\.internal/.test(stripped),
    'C5 the ISSUE door passes the provenance to the store');
  // ⛔ THE PREVIEW MUST NOT. A preview is a look at the document, and the door is
  // reachable before anything is stored — there is nothing to record against.
  const preview = stripped.slice(stripped.indexOf("router.post('/preview'"), stripped.indexOf("router.post('/',"));
  check(preview.length > 0 && !/internal/.test(preview),
    'C6 …and the PREVIEW door does not, because a preview stores nothing');
  check(/internal,\s*\n\s*internalError,/.test(stripped),
    'C7 the lookup answers it as its own key, never merged into the snapshot');
  check(/readInternal\(row\.id\)/.test(stripped) && /catch/.test(stripped.slice(stripped.indexOf('readInternal'))),
    'C8 …and a failed read is REPORTED, never returned as an empty list');
}

// =============================================================================
section('D. the screen exists, is staff-only, and shows both halves');
// =============================================================================
{
  const app = read('app-v2/src/App.jsx');
  check(/LtSheetLookup/.test(app), 'D1 the lookup screen is wired into the router');
  const line = (app.match(/.*internal\/lt\/sheets.*/) || [''])[0];
  check(/StaffPrivate/.test(line),
    'D2 ⛔ …behind StaffPrivate, because it names investors');
  const nav = read('app-v2/src/components/StaffLayout.jsx');
  check(/internal\/lt\/sheets/.test(nav),
    'D3 …and there is a way to reach it — a back end nobody can open is not a feature');
}
{
  const screen = read('app-v2/src/longterm/LtSheetLookup.jsx');
  check(/termSheetGet\(/.test(screen), 'D4 the screen looks a sheet up by its code');
  check(/ScenarioBlock/.test(screen) && /sc\.rentMonthly/.test(screen),
    'D5 …shows what the officer typed, the calculator figures included');
  check(/rec\.investor/.test(screen) && /rec\.program/.test(screen),
    'D6 …and the investor and THEIR programme name, which is what was asked for');
  check(/internalNotRecorded/.test(screen),
    'D7 an older sheet says why there is no investor on it, rather than "unknown"');
  check(/integrity/.test(screen),
    'D8 …and a sheet whose bytes no longer match its fingerprint says so first');
  // ⛔ `--ink*` IS A LIGHT PAPER COLOUR IN THIS PALETTE. One used as a text
  // colour renders white on white, which is how a whole card went invisible.
  check(!/color:\s*['"]?var\(--ink/.test(screen),
    'D9 no --ink token is used as a text colour');
  check(!/termSheetReplay/.test(stripComments(screen)),
    'D10 it replays and never re-prices — the ID is a record of what was sent');
}

// =============================================================================
section('E. the provenance survives the cart, which is where a comparison is made');
// =============================================================================
{
  const board = stripComments(read('app-v2/src/longterm/LtPricer.jsx'));
  const sel = board.slice(board.indexOf('selectionFor: (q, o) => ({'), board.indexOf('selectionFor: (q, o) => ({') + 2600);
  check(/internal:\s*\{/.test(sel) && /investor: q\.investor/.test(sel),
    'E1 the board sends the provenance as its own block');
  check(/investorKey: q\.investorKey/.test(sel),
    'E2 …including the SERVER\'s canonical investor key, carried and never re-derived');
  const panel = stripComments(read('app-v2/src/longterm/TermSheetPanel.jsx'));
  check(/internal: m\.internal/.test(panel),
    'E3 a comparison assembled in the cart hands it straight back on issue');
  const route = stripComments(read('src/longterm/routes/term-sheet.js'));
  check(/internal: \(req\.body\.selection \|\| \{\}\)\.internal/.test(route),
    'E4 …because the cart door stored it in the first place');
  const store = stripComments(read('src/longterm/termsheet/store.js'));
  const add = store.slice(store.indexOf('async function addToCart'));
  check(/internalRecord\.projectInternal\(member\.internal\)/.test(add),
    'E5 and the cart projects it through the SAME whitelist the issue does');
}

// =============================================================================
console.log('');
if (failures) { console.error(`OFFLINE: ${failures} failed`); process.exit(1); }
console.log('OFFLINE: all passed');
