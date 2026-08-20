'use strict';
/**
 * EMCAP PRICING & ELIGIBILITY TOOL — the pure suite (no database, no network).
 *
 * What it is really guarding, in order of how expensive the failure is:
 *
 *  1. A DROPDOWN VALUE THAT IS ONE CHARACTER OFF ITS OWN LIST. Every downstream
 *     formula in that workbook is an `INDEX(…Tokens, MATCH(C6, …Labels, 0))`, so a
 *     label the list does not contain does not look slightly wrong — it returns #N/A
 *     and the loan reads INELIGIBLE at the note buyer. So the test reads the LISTS
 *     OUT OF THE TEMPLATE ITSELF and asserts every value we can emit is a member.
 *     It never re-types EMCAP's wording, exactly like the module.
 *  2. AN INPUT CELL LEFT CARRYING THE VENDOR'S SAMPLE LOAN. The file EMCAP ships has
 *     a worked example typed into it, so "we didn't fill that cell" and "that cell
 *     is empty" are NOT the same thing. Every input cell must be written on every
 *     export — with a value or blank.
 *  3. A STALE CACHED ANSWER. Their formula cells carry the sample's answers; if one
 *     survived, a viewer that does not recalculate would render "ELIGIBLE" over OUR
 *     loan's inputs. Nothing in the pricing sheet may keep a cached value.
 *  4. THE REST OF THEIR WORKBOOK MOVING. Every other zip part must round-trip
 *     byte-for-byte — the pricing matrix, the tier grid, the hidden engine, the
 *     styles, the dropdown definitions.
 *
 * The recalculation half — proving the eligibility decision actually populates from
 * the seventeen cells — is scripts/test-emcap-pricing-tool-recalc.js, which needs a
 * spreadsheet engine and skips cleanly when there isn't one.
 */
const assert = require('assert');

const PT = require('../src/lib/tapes/emcap-pricing-tool');
const emcapTape = require('../src/lib/tapes/emcap');
const { fillXlsxCells, _cells } = require('../src/lib/tapes/xlsx-template');
const { unzip } = require('../src/lib/zip');

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };

// ---------------------------------------------------------------------------
// A synthetic loan in the exact shape assembleTapeLoan returns.
// ---------------------------------------------------------------------------
function loanFixture(over = {}) {
  const appOver = over.app || {};
  const app = Object.assign({
    id: '00000000-0000-0000-0000-000000000001',
    ys_loan_number: 'YSCAP258134999',
    program: 'Ground Up Construction', loan_type: 'Purchase', rehab_type: 'ground up',
    property_address: { line1: '129 Carlisle St', city: 'Wilkes-Barre', state: 'PA', zip: '08561' },
    property_type: 'SFR', units: 1,
    purchase_price: 250000, as_is_value: 250000, arv: 900000, rehab_budget: 400000,
    loan_amount: 600000, term: '18 months',
    requested_ir_months: 0, requested_ir_amount: 0,
    requested_exp_flips: 5, requested_exp_holds: 0, requested_exp_ground: 5,
  }, appOver);
  const quote = Object.assign({
    noteRate: 0.0925,
    sizing: { totalLoan: 600000, rehabHoldback: 400000, financedReserve: 0, initialAdvance: 200000 },
  }, over.quote || {});
  return Object.assign({
    found: true, app, fico: 740,
    address: { line1: app.property_address.line1, city: app.property_address.city, state: app.property_address.state, zip: app.property_address.zip },
    borrower: { first: 'Test', last: 'Borrower' }, coBorrower: null,
    registration: { program: 'silver', note_rate: quote.noteRate, total_loan: 600000, quote },
    quote,
    appraisal: null,
    exp: { flips: 5, holds: 0, ground: 5, total: 10, verified: { flips: 0, holds: 0, ground: 5 }, verifiedTotal: 5 },
    repeatBorrower: false, noteBuyerRaw: 'EMCAP Financial', releases: [], supplemental: {},
    vesting: { llc: '', ein: '', state: '', individual: false }, officer: {},
  }, over.loan || {});
}

// The seventeen yellow input cells, from the workbook's own instruction row.
const INPUT_CELLS = ['C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C13', 'C14', 'C15', 'C17', 'C18', 'C19', 'C20', 'C21', 'C23', 'C24', 'C25'];

console.log('EMCAP pricing & eligibility tool — pure');

// ===========================================================================
// 1. THE WORKBOOK'S OWN VOCABULARY
// ===========================================================================
const vocab = PT.vocabulary();
ok(vocab.product && vocab.purpose && vocab.market && vocab.exit, 'every token→label list read out of the template');
ok(Array.isArray(vocab.terms) && vocab.terms.length > 0, 'the terms list read out of the template');
ok(Array.isArray(vocab.yesNo) && vocab.yesNo.length > 0, 'the Yes/No list read out of the template');

// The tokens our frozen Silver engine speaks must all exist in EMCAP's own lists —
// both were transcribed from this workbook, so a missing one is real drift.
for (const t of ['FF', 'GUC', 'BR']) ok(vocab.product[t], `the workbook still has a label for product token ${t}`);
for (const t of ['P', 'R']) ok(vocab.purpose[t], `the workbook still has a label for purpose token ${t}`);
for (const t of ['STD', 'NYC']) ok(vocab.market[t], `the workbook still has a label for market token ${t}`);
for (const t of ['FLIP', 'HOLD', 'BRIDGE']) ok(vocab.exit[t], `the workbook still has a label for exit token ${t}`);
// The engine buckets a term to 12 / 18 / 24; the workbook must offer those.
for (const m of [12, 18, 24]) ok(vocab.terms.map(Number).includes(m), `the workbook still offers a ${m}-month term`);

// ===========================================================================
// 2. EVERY EMITTED DROPDOWN VALUE IS A MEMBER OF THAT LIST
//    (this is the one that stops a sheet full of #N/A)
// ===========================================================================
const CELL_LIST = { C6: 'product', C7: 'purpose', C9: 'market', C11: 'exit' };
const scenarios = [
  ['ground-up purchase', {}],
  ['fix & flip purchase', { app: { program: 'Fix and Flip', loan_type: 'Purchase', rehab_type: 'light rehab' } }],
  ['fix & hold purchase', { app: { program: 'Fix and Hold', loan_type: 'Purchase', rehab_type: 'light rehab' } }],
  ['bridge purchase', { app: { program: 'Bridge', loan_type: 'Purchase', rehab_type: '' } }],
  ['refinance', { app: { loan_type: 'Refinance', as_is_value: 400000 } }],
  ['cash-out refinance', { app: { loan_type: 'Cash-Out Refinance', as_is_value: 400000 } }],
  ['NYC five-borough', { app: { property_address: { line1: '1 Bedford Ave', city: 'Brooklyn', state: 'NY', zip: '11249' } } }],
  ['12-month term', { app: { term: '12 months' } }],
  ['24-month term', { app: { term: '24 months' } }],
];
for (const [name, over] of scenarios) {
  const L = loanFixture(over);
  if (over.app && over.app.property_address) L.address = Object.assign({}, over.app.property_address);
  const out = PT.buildPricingToolCells(L);
  for (const [ref, list] of Object.entries(CELL_LIST)) {
    const spec = out.cells[ref];
    ok(spec, `${name}: ${ref} is written at all`);
    if (spec.type === 'blank' || spec.value == null || spec.value === '') continue; // named as a gap, checked below
    const members = Object.values(vocab[list]);
    ok(members.includes(spec.value), `${name}: ${ref} "${spec.value}" is one of EMCAP's own ${list} options`);
  }
  const term = out.cells.C8;
  if (term && term.type !== 'blank' && term.value != null && term.value !== '') {
    ok(vocab.terms.map(Number).includes(Number(term.value)), `${name}: the term ${term.value} is one of EMCAP's own term options`);
  }
  const gc = out.cells.C15;
  ok(gc && vocab.yesNo.map(String).includes(String(gc.value)), `${name}: GC-only experience is one of EMCAP's own Yes/No options`);
  // Anything left blank must be NAMED. (C23/C25 are owner-directed blanks and carry
  // no reason on purpose; C24 is blank on a purchase for the same reason.)
  for (const ref of INPUT_CELLS) {
    const s = out.cells[ref];
    ok(s, `${name}: every input cell is written — ${ref}`);
    const blank = s.type === 'blank' || s.value == null || s.value === '';
    if (blank && !['C23', 'C24', 'C25'].includes(ref)) {
      ok(out.gaps.some((g) => g.cell === ref), `${name}: the blank ${ref} is named as a gap`);
    }
  }
}

// ===========================================================================
// 3. THE CLASSIFICATION COMES FROM THE ENGINE, NOT A SECOND OPINION
// ===========================================================================
{
  const L = loanFixture();
  const cls = PT.classify(L);
  ok(cls, 'the frozen Silver engine classifies the loan');
  eq(cls.product, 'GUC', 'a ground-up loan is EMCAP product GUC');
  eq(cls.purpose, 'P', 'a purchase is purpose P');
  eq(cls.market, 'STD', 'a Pennsylvania property is the standard market');
  eq(cls.exit, 'FLIP', 'a ground-up-to-sell exits FLIP');
  eq(cls.acqDenom, 250000, 'C18 is the engine\'s own acquisition denominator');

  const nyc = loanFixture({ app: { property_address: { line1: '1 Bedford Ave', city: 'Brooklyn', state: 'NY', zip: '11249' } } });
  nyc.address = { line1: '1 Bedford Ave', city: 'Brooklyn', state: 'NY', zip: '11249' };
  eq(PT.classify(nyc).market, 'NYC', 'a Brooklyn property reads as the NYC five-borough market');
  const out = PT.buildPricingToolCells(nyc);
  eq(out.cells.C9.value, vocab.market.NYC, 'and the NYC label written is EMCAP\'s own');

  // Every other market is Standard — the owner's rule, and never filled by hand.
  const pa = PT.buildPricingToolCells(loanFixture());
  eq(pa.cells.C9.value, vocab.market.STD, 'everywhere else is Standard (Non-NYC)');
}

// ===========================================================================
// 4. THE OWNER'S CELL-BY-CELL RULES
// ===========================================================================
{
  const L = loanFixture();
  const out = PT.buildPricingToolCells(L);
  const val = (r) => out.cells[r] && out.cells[r].value;

  eq(val('C13'), 740, 'the FICO is the file\'s pricing score');
  eq(val('C17'), 600000, 'the total loan is the registered figure');
  eq(val('C18'), 250000, 'the acquisition cost');
  eq(val('C19'), 400000, 'the FULL construction budget');
  eq(val('C20'), 900000, 'the ARV');
  eq(val('C21'), 0.0925, 'the note rate goes in as the fraction the percent cell stores');
  eq(val('C10'), '08561', 'a leading-zero ZIP survives as text');

  // C14 is VERIFIED experience only, through the engine's own comparable-projects
  // definition (ground-up counts ground-up).
  eq(val('C14'), 5, 'the comparable-projects cell is the VERIFIED count, not the claimed one');
  const noneVerified = loanFixture();
  noneVerified.exp = { flips: 9, holds: 0, ground: 9, total: 9, verified: { flips: 0, holds: 0, ground: 0 }, verifiedTotal: 0 };
  const nv = PT.buildPricingToolCells(noneVerified);
  eq(nv.cells.C14.value, 0, 'nine CLAIMED projects with none verified sends 0 — a pending project never reaches an investor');
  ok(nv.gaps.some((g) => g.cell === 'C14'), 'and the staffer is told that will tier the borrower at Tier 3');

  // C15 is never derived.
  ok(/^no$/i.test(String(val('C15'))), 'GC-only experience always goes out as No');

  // C23 / C25 are always empty; C24 only on a refinance with a cash-out.
  eq(out.cells.C23.type, 'blank', 'the projected DSCR always ships empty');
  eq(out.cells.C25.type, 'blank', 'the projected project profit always ships empty');
  eq(out.cells.C24.type, 'blank', 'a purchase carries no cash-out');

  const refi = loanFixture({
    app: { loan_type: 'Cash-Out Refinance', as_is_value: 400000 },
    quote: { noteRate: 0.0925, sizing: { totalLoan: 600000, rehabHoldback: 400000, financedReserve: 0, initialAdvance: 200000 }, refi: { payoff: 100000, fundedAtClose: 200000, closing: 10000, cashOut: 90000 } },
  });
  const r = PT.buildPricingToolCells(refi);
  eq(r.cells.C7.value, vocab.purpose.R, 'a refinance says Refinance');
  eq(r.cells.C24.value, 90000, 'a refinance carries its cash-out figure');
  eq(r.cells.C23.type, 'blank', 'and still no DSCR');
  eq(r.cells.C25.type, 'blank', 'and still no projected profit');

  const refiNoCash = loanFixture({ app: { loan_type: 'Refinance', as_is_value: 400000 } });
  eq(PT.buildPricingToolCells(refiNoCash).cells.C24.type, 'blank', 'a rate-and-term refinance carries no cash-out');
}

// ===========================================================================
// 5. FAIL CLOSED — a term outside their grid, a missing figure, no engine
// ===========================================================================
{
  const long = loanFixture({ app: { term: '30 months' } });
  const out = PT.buildPricingToolCells(long);
  eq(out.cells.C8.type, 'blank', 'a 30-month term is outside EMCAP\'s 12/18/24 and is left for a human');
  ok(out.gaps.some((g) => g.cell === 'C8' && /individual review|12 \/ 18 \/ 24/.test(g.why)), 'and it says why');

  const noEngine = PT.buildPricingToolCells(loanFixture(), { classification: null });
  for (const ref of ['C6', 'C7', 'C9', 'C11']) {
    eq(noEngine.cells[ref].type, 'blank', `with no engine, ${ref} ships blank rather than guessed`);
    ok(noEngine.gaps.some((g) => g.cell === ref), `and ${ref} is named`);
  }

  const noArv = loanFixture({ app: { arv: null } });
  const na = PT.buildPricingToolCells(noArv);
  eq(na.cells.C20.type, 'blank', 'no ARV → an empty cell, never a guess');
  ok(na.gaps.some((g) => g.cell === 'C20'), 'and the staffer is told the rate cannot compute without it');

  const noZip = loanFixture();
  noZip.address = { line1: 'x', city: 'y', state: 'PA', zip: '' };
  const nz = PT.buildPricingToolCells(noZip);
  eq(nz.cells.C10.type, 'blank', 'no ZIP → empty');
  ok(nz.gaps.some((g) => g.cell === 'C10'), 'and named — their geography check reads the first three digits');

  // ZIP+4 reduces to the five-digit ZIP.
  const plus4 = loanFixture();
  plus4.address = { line1: 'x', city: 'y', state: 'NJ', zip: '07036-1234' };
  eq(PT.buildPricingToolCells(plus4).cells.C10.value, '07036', 'a ZIP+4 is written as the five-digit ZIP');
}

// ===========================================================================
// 6. AVAILABILITY — this is EMCAP's own sheet
// ===========================================================================
{
  const byBuyer = loanFixture();
  byBuyer.registration = null;
  ok(PT.emcapAvailability(byBuyer).available, 'the real "EMCAP Financial" label makes it available');

  const byProgram = loanFixture();
  byProgram.noteBuyerRaw = null;
  ok(PT.emcapAvailability(byProgram).available, 'a Silver-registered file is available before a provider is set');

  const other = loanFixture();
  other.noteBuyerRaw = 'Fidelis Investors LLC';
  other.registration = { program: 'standard', quote: {} };
  const a = PT.emcapAvailability(other);
  ok(!a.available, 'a Fidelis / Standard file is not offered EMCAP\'s sheet');
  ok(a.why && /EMCAP/.test(a.why), 'and it says what to do about it');

  const none = loanFixture();
  none.noteBuyerRaw = null; none.registration = null;
  ok(!PT.emcapAvailability(none).available, 'a file with no provider and no program is not offered it');
}

// ===========================================================================
// 7. THE WRITTEN WORKBOOK — the sample is gone, their file is not
// ===========================================================================
{
  const tpl = PT.template();
  const before = unzip(tpl.buf);
  const L = loanFixture();
  const built = PT.buildPricingToolCells(L, { vocab: tpl.vocab });
  const buf = fillXlsxCells(tpl.buf, { sheetPart: tpl.sheetPart, cells: built.cells, clearCached: true, forceFullCalc: true });
  const after = unzip(buf);

  eq(after.length, before.length, 'no zip part is added or lost');
  const byName = (parts) => Object.fromEntries(parts.map((p) => [p.name, p.data]));
  const B = byName(before); const A = byName(after);
  for (const name of Object.keys(B)) {
    if (name === tpl.sheetPart || name === 'xl/workbook.xml') continue;
    ok(A[name] && A[name].equals(B[name]), `${name} round-trips byte-for-byte`);
  }
  ok(A['xl/workbook.xml'].toString('utf8').includes('fullCalcOnLoad="1"'), 'the workbook is told to recalculate on open');

  const sheet = A[tpl.sheetPart].toString('utf8');
  // Every input cell carries what we wrote — and nothing carries the vendor sample.
  eq(/<c r="C6"[^>]*t="inlineStr"[^>]*>/.test(sheet), true, 'C6 is written as an inline string (sharedStrings untouched)');
  ok(sheet.includes('Ground-Up Construction (GUC)'), 'the product label we chose is in the sheet');
  ok(!/<c r="C10"[^>]*><v>19133<\/v>/.test(sheet), 'the vendor sample ZIP is gone');
  ok(!/<c r="C17"[^>]*><v>600000<\/v>[\s\S]{0,40}<c r="C18"[^>]*><v>250000<\/v>[\s\S]{0,40}<c r="C19"[^>]*><v>400000<\/v>[\s\S]{0,40}<c r="C20"[^>]*><v>800000<\/v>/.test(sheet), 'the vendor sample ARV is gone');
  // The blank cells keep their formatting and carry no value.
  for (const ref of ['C23', 'C25']) {
    ok(new RegExp(`<c r="${ref}" s="\\d+"/>`).test(sheet), `${ref} is a styled empty cell — formatting kept, sample value gone`);
  }
  // NOT ONE formula cell may keep a cached answer.
  const cells = sheet.match(/<c [^>]*?\/>|<c [^>]*?>[\s\S]*?<\/c>/g) || [];
  const stale = cells.filter((c) => c.indexOf('<f') > -1 && /<v>/.test(c));
  eq(stale.length, 0, 'no formula cell keeps the sample loan\'s cached answer');
  ok(cells.filter((c) => c.indexOf('<f') > -1).length > 50, 'and their formulas are all still there');
  // The labels in column B are untouched — we only ever write column C.
  ok(sheet.includes('<c r="B17" s="2" t="s">'), 'the printed label beside an input cell is untouched');
  ok(/<c r="K20"[^>]*><f>/.test(sheet), 'the hidden engine helpers beside the inputs are untouched');
}

// ===========================================================================
// 8. THE CELL WRITER'S OWN EDGE CASES
// ===========================================================================
{
  // A self-closing cell must be matched BEFORE the open/close form, or the regex
  // runs on to the next cell's closing tag and swallows everything between.
  const row = '<row r="9"><c r="B9" s="5"/><c r="C9" s="3" t="s"><v>13</v></c><c r="J9" s="1"/></row>';
  const outRow = _cells.putCellInRow(row, 'C9', { value: 'Hello', type: 's' });
  ok(outRow.includes('<c r="B9" s="5"/>'), 'the self-closing cell before ours survives');
  ok(outRow.includes('<c r="J9" s="1"/>'), 'the cell after ours survives');
  ok(outRow.includes('Hello'), 'our value landed');
  ok(outRow.includes('<c r="C9" s="3" t="inlineStr">'), 'and it inherited the template cell\'s style');

  // A cell the template does not have is inserted IN COLUMN ORDER.
  const ins = _cells.putCellInRow('<row r="4"><c r="B4"><v>1</v></c><c r="J4"><v>2</v></c></row>', 'D4', { value: 5, type: 'n' });
  const order = (ins.match(/<c r="([A-Z]+)4"/g) || []).join(',');
  eq(order, '<c r="B4",<c r="D4",<c r="J4"', 'an inserted cell lands in column order');

  // Text is XML-escaped and formula injection is neutralized.
  const esc = _cells.cellElement('C6', { value: 'Fix & Flip <script> "x"', type: 's' }, 3);
  ok(esc.includes('&amp;') && esc.includes('&lt;script&gt;') && !esc.includes('<script>'), 'XML specials are escaped');
  // safeStr prefixes an apostrophe, which xmlEsc then escapes — so the cell can
  // never be evaluated as a formula in the investor's file.
  ok(_cells.cellElement('C6', { value: '=cmd|x', type: 's' }, null).includes('&apos;=cmd|x'), 'a leading = is neutralized');

  // Blank keeps the style; a null value is a blank.
  eq(_cells.cellElement('C23', { type: 'blank' }, 11), '<c r="C23" s="11"/>', 'blank keeps the cell\'s formatting');
  eq(_cells.cellElement('C24', { value: null, type: 'n' }, 6), '<c r="C24" s="6"/>', 'a null value is written as a blank, never as 0');

  // A shared-formula cell keeps its formula and loses only the cached value.
  const cleared = _cells.clearCachedFormulaValues('<c r="C45" s="23" t="str"><f t="shared" si="0"/><v>Pass</v></c><c r="B45" t="s"><v>7</v></c>');
  ok(cleared.includes('<f t="shared" si="0"/>'), 'a shared formula reference survives');
  ok(!cleared.includes('<v>Pass</v>'), 'its stale answer does not');
  ok(cleared.includes('<c r="B45" t="s"><v>7</v></c>'), 'a plain value cell is untouched');
}

// ===========================================================================
// 9. ONE DEFINITION — the money comes through the tape's own derivations
// ===========================================================================
{
  const L = loanFixture();
  const econ = emcapTape.economics(L);
  const out = PT.buildPricingToolCells(L);
  eq(out.cells.C17.value, econ.totalLoan, 'the total loan is the tape\'s own figure');
  eq(out.cells.C19.value, econ.totalRehab, 'the rehab budget is the tape\'s own figure');
  eq(out.cells.C20.value, econ.arv, 'the ARV is the tape\'s own figure');
  eq(out.cells.C21.value, econ.noteRate, 'the note rate is the tape\'s own figure');
  ok(typeof emcapTape.termMonths === 'function', 'the term months come from the tape too');
}

// The filename says what it is and is safe on every filesystem.
{
  const f = PT.filename(loanFixture());
  ok(/^EMCAP-Pricing-Eligibility-/.test(f) && /\.xlsx$/.test(f), 'the filename names the sheet');
  ok(!/[^A-Za-z0-9._-]/.test(f), 'and carries no character a filesystem would refuse');
}

console.log(`\nOK — ${pass} checks passed.`);
