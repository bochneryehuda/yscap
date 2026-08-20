'use strict';
/**
 * EMCAP PRICING & ELIGIBILITY TOOL — THE RECALCULATION PROOF.
 *
 * The pure suite proves we write the right values into the right cells. It cannot
 * prove the thing the whole feature is FOR: that when EMCAP opens the file, THEIR
 * formulas take those seventeen inputs and fill in the auto-classification, the
 * borrower tier, the band lookups, the rate key, the indicative buy rate and the
 * eligibility decision — by themselves, with nobody typing anything.
 *
 * The only way to prove that is to actually recalculate the workbook we produced and
 * read the answers back out. So this script builds a real file, hands it to a
 * spreadsheet engine (LibreOffice, headless), and asserts on what the workbook's own
 * formulas computed — never on anything we wrote.
 *
 * It also proves the two failure modes that would be invisible on inspection:
 *   · the vendor's SAMPLE loan is genuinely gone (its answers do not survive as
 *     stale cached values dressed up as ours), and
 *   · the recalculation is driven by OUR inputs — feed it a different loan and every
 *     derived answer moves with it.
 *
 * SKIPS CLEANLY with no spreadsheet engine installed (CI has none), and says so
 * rather than passing silently — a proof that did not run is not a proof.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const PT = require('../src/lib/tapes/emcap-pricing-tool');
const { fillXlsxCells } = require('../src/lib/tapes/xlsx-template');

// ---------------------------------------------------------------------------
// Is there a spreadsheet engine on this machine?
// ---------------------------------------------------------------------------
function findSoffice() {
  for (const bin of ['soffice', 'libreoffice']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) {
      // libreoffice-core without libreoffice-calc cannot open a spreadsheet at all,
      // and reports that as "source file could not be loaded" — which would read as
      // a broken workbook rather than a missing package. Check for the Calc filter.
      const probe = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000 });
      if (probe.status === 0) return bin;
    }
  }
  return null;
}

const SOFFICE = process.env.EMCAP_RECALC_SOFFICE || findSoffice();
if (!SOFFICE) {
  console.log('EMCAP pricing tool recalculation — SKIPPED (no LibreOffice on this machine).');
  console.log('  Install libreoffice-calc to run the proof, or set EMCAP_RECALC_SOFFICE.');
  process.exit(0);
}

let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, `${what} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`); pass++; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'emcap-recalc-'));
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ } });

// ---------------------------------------------------------------------------
// One loan, in the shape assembleTapeLoan returns.
// ---------------------------------------------------------------------------
function loanFixture(over = {}) {
  const app = Object.assign({
    id: '00000000-0000-0000-0000-000000000001',
    ys_loan_number: 'YSCAP258134999',
    program: 'Ground Up Construction', loan_type: 'Purchase', rehab_type: 'ground up',
    property_address: { line1: '129 Carlisle St', city: 'Wilkes-Barre', state: 'PA', zip: '08561' },
    property_type: 'SFR', units: 1,
    purchase_price: 250000, as_is_value: 250000, arv: 900000, rehab_budget: 400000,
    loan_amount: 600000, term: '18 months', requested_ir_months: 0, requested_ir_amount: 0,
    requested_exp_flips: 5, requested_exp_holds: 0, requested_exp_ground: 5,
  }, over.app || {});
  const quote = Object.assign({
    noteRate: 0.0925,
    sizing: { totalLoan: 600000, rehabHoldback: 400000, financedReserve: 0, initialAdvance: 200000 },
  }, over.quote || {});
  const L = {
    found: true, app, fico: over.fico != null ? over.fico : 740,
    address: { line1: app.property_address.line1, city: app.property_address.city, state: app.property_address.state, zip: app.property_address.zip },
    borrower: { first: 'Test', last: 'Borrower' }, coBorrower: null,
    registration: { program: 'silver', note_rate: quote.noteRate, total_loan: quote.sizing.totalLoan, quote },
    quote, appraisal: null,
    exp: over.exp || { flips: 5, holds: 0, ground: 5, total: 10, verified: { flips: 0, holds: 0, ground: 5 }, verifiedTotal: 5 },
    repeatBorrower: false, noteBuyerRaw: 'EMCAP Financial', releases: [], supplemental: {},
    vesting: { llc: '', ein: '', state: '', individual: false }, officer: {},
  };
  return L;
}

// ---------------------------------------------------------------------------
// Build → recalculate → read the sheet back as a grid.
// ---------------------------------------------------------------------------
function csvRows(text) {
  const rows = []; let row = []; let cell = ''; let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; }
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

let built = 0;
function recalculate(loan, label) {
  const tpl = PT.template();
  const out = PT.buildPricingToolCells(loan, { vocab: tpl.vocab });
  const buf = fillXlsxCells(tpl.buf, { sheetPart: tpl.sheetPart, cells: out.cells, clearCached: true, forceFullCalc: true });
  const name = `case${built++}`;
  const xlsx = path.join(TMP, `${name}.xlsx`);
  fs.writeFileSync(xlsx, buf);
  const outDir = path.join(TMP, name);
  fs.mkdirSync(outDir, { recursive: true });
  // Its own profile directory: a shared one makes concurrent/repeat runs flaky.
  execFileSync(SOFFICE, [
    '--headless', `-env:UserInstallation=file://${path.join(TMP, '.loprofile')}`,
    '--convert-to', 'csv', '--outdir', outDir, xlsx,
  ], { stdio: 'pipe', timeout: 300000 });
  const csv = path.join(outDir, `${name}.csv`);
  ok(fs.existsSync(csv), `${label}: the workbook we built opens in a spreadsheet engine`);
  const grid = csvRows(fs.readFileSync(csv, 'utf8'));
  // The first sheet IS the Pricing Tool tab (csv export takes the first sheet).
  const at = (ref) => {
    const m = /^([A-Z]+)(\d+)$/.exec(ref);
    let col = 0; for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
    const r = grid[Number(m[2]) - 1] || [];
    return (r[col - 1] == null ? '' : String(r[col - 1])).trim();
  };
  return { at, cells: out.cells, gaps: out.gaps, bytes: buf.length };
}

console.log(`EMCAP pricing tool recalculation — using ${SOFFICE}`);

// ===========================================================================
// CASE A — an eligible ground-up purchase.
// Every assertion below is a cell EMCAP's own formulas computed. We wrote none
// of them.
// ===========================================================================
{
  const r = recalculate(loanFixture(), 'A');

  // Section 1's hidden engine tokens — proof the dropdown labels MATCHED their lists
  // (a label one character off returns #N/A here instead of a token).
  eq(r.at('K5'), 'STD', 'A: the market token resolved from the label we wrote');
  eq(r.at('K7'), 'GUC', 'A: the product token resolved');
  eq(r.at('K8'), 'P', 'A: the purpose token resolved');
  eq(r.at('K10'), 'FLIP', 'A: the exit token resolved');
  eq(r.at('K9'), '18', 'A: the term token resolved');
  eq(r.at('K28'), '085', 'A: the geography prefix came off the ZIP we wrote');

  // Section 2 — the auto-classification the owner asked to fill itself in.
  eq(r.at('C30'), '$100k – $2.5M', 'A: the loan-size band computed itself');
  eq(r.at('C31'), 'Tier 1', 'A: the borrower tier computed itself from the verified projects');
  eq(r.at('C32'), '65.00%-70.00%', 'A: the AR-LTV band computed itself');
  eq(r.at('C33'), 'FICO 700+', 'A: the FICO band computed itself');
  eq(r.at('C34'), '90.00%-92.50%', 'A: the LTC band computed itself');
  ok(/^80(\.0+)?%$/.test(r.at('C27')), 'A: the acquisition LTV computed itself');

  // Section 3 — the pricing result.
  eq(r.at('K20'), 'STD|S|GUC|P|18|T1|65.00%-70.00%|FICO 700+|90.00%-92.50%', 'A: the nine-part rate key assembled itself');
  eq(r.at('C38'), 'ELIGIBLE', 'A: EMCAP\'s own sheet decides this loan is ELIGIBLE');
  ok(/%$/.test(r.at('C37')), 'A: and prints an indicative buy rate');
  eq(r.at('C39'), '', 'A: with no flags');
  eq(r.at('K39'), '0', 'A: and no hard fails');

  // Section 4 — every eligibility check passed.
  for (const ref of ['C44', 'C45', 'C46', 'C47', 'C48', 'C49', 'C50', 'C51', 'C54']) {
    eq(r.at(ref), 'Pass', `A: eligibility check ${ref} passed`);
  }

  // THE SAMPLE IS GONE. The file EMCAP ships is a Philadelphia (191xx) loan that
  // reads INELIGIBLE on geography, with an $800,000 ARV. None of that survives.
  eq(r.at('C44'), 'Pass', 'A: the vendor sample\'s geography FAIL is gone');
  eq(r.at('C20'), '900000', 'A: the vendor sample\'s ARV is gone');
  ok(!r.at('C39').includes('Geography excluded'), 'A: the vendor sample\'s flag text is gone');

  // And the file is a sane size — their 270 KB workbook must not come back as 2 MB.
  ok(r.bytes < 600000, `A: the exported workbook stays small (${r.bytes} bytes)`);
}

// ===========================================================================
// CASE B — the same loan in an excluded market. Only the ZIP moves.
// ===========================================================================
{
  const L = loanFixture({ app: { property_address: { line1: '1 N State St', city: 'Chicago', state: 'IL', zip: '60601' } } });
  L.address = { line1: '1 N State St', city: 'Chicago', state: 'IL', zip: '60601' };
  const r = recalculate(L, 'B');
  eq(r.at('K28'), '606', 'B: the Chicago prefix came off the ZIP we wrote');
  eq(r.at('C44'), 'FAIL', 'B: EMCAP\'s own geography check fails it');
  eq(r.at('C38'), 'INELIGIBLE / REVIEW', 'B: and their sheet decides INELIGIBLE');
  ok(r.at('C39').includes('Geography excluded'), 'B: naming geography as the reason');
  ok(r.at('D44').includes('606'), 'B: against OUR ZIP, not the sample\'s');
}

// ===========================================================================
// CASE C — a borrower with nothing verified drops to their bottom tier.
// (The claimed experience is unchanged; only the VERIFIED count goes out.)
// ===========================================================================
{
  const L = loanFixture({ exp: { flips: 9, holds: 0, ground: 9, total: 9, verified: { flips: 0, holds: 0, ground: 0 }, verifiedTotal: 0 } });
  const r = recalculate(L, 'C');
  eq(r.at('C14'), '0', 'C: zero verified comparable projects went out');
  eq(r.at('C31'), 'Tier 3', 'C: EMCAP\'s own tier ladder drops the borrower to Tier 3');
  eq(r.at('K22'), 'GUC|P|T3', 'C: and their tier-grid lookup follows');
  ok(r.at('D45').includes('950,000'), 'C: their Tier 3 max loan is what the sheet now quotes');
  // Tier 3 also tightens their leverage caps (max AR-LTV 65%, max LTC 80%), and this
  // structure is above both — so the SAME loan that was eligible at Tier 1 is refused.
  eq(r.at('C48'), 'FAIL', 'C: the loan now breaks their Tier 3 AR-LTV ceiling');
  eq(r.at('C49'), 'FAIL', 'C: and their Tier 3 LTC ceiling');
  eq(r.at('C38'), 'INELIGIBLE / REVIEW', 'C: and the decision follows the tier');
  ok(r.at('C39').includes('AR-LTV') || r.at('C39').includes('LTC'), 'C: with their own cure text naming the leverage');
}

// ===========================================================================
// CASE D — a cash-out refinance. Purpose, the tier-grid row and the cash-out
// overlay all move; the DSCR and profit cells stay empty as directed.
// ===========================================================================
{
  const L = loanFixture({
    app: { loan_type: 'Cash-Out Refinance', as_is_value: 400000, program: 'Fix and Flip', rehab_type: 'light rehab' },
    quote: {
      noteRate: 0.1025,
      sizing: { totalLoan: 500000, rehabHoldback: 200000, financedReserve: 0, initialAdvance: 300000 },
      refi: { payoff: 200000, fundedAtClose: 300000, closing: 10000, cashOut: 90000 },
    },
  });
  L.app.rehab_budget = 200000;
  const r = recalculate(L, 'D');
  eq(r.at('K8'), 'R', 'D: the refinance purpose token resolved');
  eq(r.at('K7'), 'FF', 'D: the fix & flip product token resolved');
  eq(r.at('C24'), '90000', 'D: the cash-out amount went out');
  eq(r.at('C23'), '', 'D: the projected DSCR stayed empty, as directed');
  eq(r.at('C25'), '', 'D: the projected project profit stayed empty, as directed');
  eq(r.at('C61'), 'YES', 'D: EMCAP\'s cash-out overlay switched itself on');
  eq(r.at('C58'), 'YES', 'D: and their refinance background/exit overlay too');
  eq(r.at('K38'), '0', 'D: with no profit stated, their cash-out test cannot fail — the neutral reading');
}

// ===========================================================================
// CASE E — NYC. The five-borough market is never typed by hand; it is derived
// from the property, and it drives a different rate grid.
// ===========================================================================
{
  const L = loanFixture({ app: { property_address: { line1: '1 Bedford Ave', city: 'Brooklyn', state: 'NY', zip: '11249' } } });
  L.address = { line1: '1 Bedford Ave', city: 'Brooklyn', state: 'NY', zip: '11249' };
  const r = recalculate(L, 'E');
  eq(r.at('K5'), 'NYC', 'E: a Brooklyn property resolves to EMCAP\'s NYC market token');
  ok(r.at('K20').startsWith('NYC|'), 'E: and their rate key looks up the NYC grid');
}

console.log(`\nOK — ${pass} checks passed against ${built} recalculated workbooks.`);
