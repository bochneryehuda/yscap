'use strict';
/**
 * Pure (no-DB) test: a data tape never DISPLAYS a rounded rate — the
 * owner-reported class (2026-08-24) where a full-precision stored value showed
 * rounded because the template cell's number format carried too few decimals
 * (a 10.625% note rate reading "10.63%", an 84.375% LTC reading "84.4%" — the
 * same truncation lib/rate-format banned on every PILOT screen 2026-08-04).
 *
 * What is pinned, on every tape (fidelis / emcap / bluelake), on the SINGLE
 * export and the BULK export (both flow through fillXlsxTemplate — one
 * chokepoint):
 *   A. the note-rate cell stores the full-precision fraction AND its resolved
 *      number format is FMT.RATE ('0.00#%'), whose display equals
 *      rate-format.trim3 exactly (10.25 → "10.25%", 10.625 → "10.625%");
 *   B. Blue Lake's Total Points is FMT.RATE; its LTAIV/LTC/LTARV +
 *      Completion % are FMT.RATIO ('0.00%', the house 2-decimal leverage
 *      convention) — no more 0.0% / 0% displays;
 *   C. styles are APPEND-ONLY: every pre-existing xf/numFmt survives verbatim,
 *      the count attributes stay consistent, and a bulk fill appends exactly
 *      what a single fill appends (the resolver caches per (base, code));
 *   D. the CONTROL: the same build with the fmt declarations stripped shows
 *      the OLD truncating formats (0.00% / 0.0% / 0%) — proof the assertions
 *      would bite on the pre-fix code;
 *   E. resolver unit edges: idempotence (a base style already carrying the
 *      wanted format is returned unchanged), builtin reuse, a REDEFINED
 *      builtin id never being trusted, and a missing styles.xml degrading to
 *      "keep the base style" rather than corrupting the workbook.
 *
 * Runs in `npm test` with no database.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { unzip } = require('../src/lib/zip');
const { fillXlsxTemplate, FMT, makeFormatResolver } = require('../src/lib/tapes/xlsx-template');
const { trim3 } = require('../src/lib/rate-format');

const fidelis = require('../src/lib/tapes/fidelis');
const emcap = require('../src/lib/tapes/emcap');
const bluelake = require('../src/lib/tapes/bluelake');

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };

const TPL = (t) => fs.readFileSync(t.templateFile);

// ---- the loan every tape is fed: a rate that NEEDS its third decimal --------
const RATE = 0.10625;    // 10.625% — the owner's own 2026-08-04 example
const POINTS = 0.01125;  // 1.125 origination points
function synthLoan() {
  return {
    found: true,
    app: {
      ys_loan_number: 'YSCAP-PRECISION-1', investor_loan_number: null,
      program: 'Fix & Flip', loan_type: 'Purchase', rehab_type: 'heavy',
      property_type: 'SFR', property_address: {}, units: 1,
      purchase_price: 350000, as_is_value: 350000, arv: 500000, rehab_budget: 75000,
      loan_amount: 350000, rate_pct: null, term: '12', requested_ir_amount: 0,
      accrual_type: 'non_dutch', rental_income: 0, costs_already_paid: 0,
      sqft_pre: 1450, sqft_post: 2050, acquisition_date: '2025-12-31',
      actual_closing: '2026-01-02', est_closing_date: '2026-01-02',
      first_payment_date: '2026-03-01', maturity_date: '2027-02-01',
      estimated_rental_income: 2500,
    },
    fico: 742,
    address: { line1: '12 Main St', city: 'Trenton', state: 'NJ', zip: '08601' },
    borrower: { first: 'Pat', last: 'Doe', citizenship: 'US Citizen', fico: 742 },
    coBorrower: null,
    vesting: { llc: 'Doe Holdings LLC', individual: false },
    registration: { program: 'standard', total_loan: 350000, note_rate: String(RATE) },
    quote: { noteRate: RATE, origPct: POINTS, sizing: { totalLoan: 350000, initialAdvance: 275000, rehabHoldback: 75000, financedReserve: 0 } },
    appraisal: { form_type: 'FNM1004', effective_date: '2025-12-15', as_is_value: 350000, arv_value: 500000, units: 1, gla: 1450, beds: 3, baths_full: 2, baths_half: 0 },
    exp: { flips: 2, holds: 0, ground: 0, total: 2, verified: { flips: 2, holds: 0, ground: 0 }, verifiedTotal: 2 },
    repeatBorrower: false,
    noteBuyerRaw: null,
    releases: [],
    supplemental: {},
  };
}

// ---- helpers: the effective number format of a produced cell ---------------
const BUILTIN = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'm/d/yyyy', 49: '@' };
function stylesOf(parts) {
  const xml = parts.find((p) => p.name === 'xl/styles.xml').data.toString('utf8');
  const numFmts = {};
  let m; const nfRe = /<numFmt numFmtId="(\d+)" formatCode="([^"]*)"\s*\/?>/g;
  while ((m = nfRe.exec(xml))) numFmts[Number(m[1])] = m[2];
  const cx = /<cellXfs count="(\d+)"[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
  const xfs = cx[2].match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g) || [];
  const nfCount = (xml.match(/<numFmt /g) || []).length;
  const nfAttr = /<numFmts count="(\d+)"/.exec(xml);
  return {
    xml, xfs,
    cellXfsCountAttr: Number(cx[1]),
    numFmtCountAttr: nfAttr ? Number(nfAttr[1]) : 0,
    numFmtCount: nfCount,
    fmtOfStyle(idx) {
      const el = xfs[idx];
      if (!el) return null;
      const idM = /numFmtId="(\d+)"/.exec(el);
      const id = idM ? Number(idM[1]) : 0;
      return numFmts[id] != null ? numFmts[id] : (BUILTIN[id] != null ? BUILTIN[id] : `builtin#${id}`);
    },
  };
}
function cellIn(parts, sheetPart, ref) {
  const xml = parts.find((p) => p.name === sheetPart).data.toString('utf8');
  const m = new RegExp(`<c r="${ref}"([^>]*?)(?:/>|>([\\s\\S]*?)</c>)`).exec(xml);
  if (!m) return null;
  const sM = /\bs="(\d+)"/.exec(m[1]);
  const vM = m[2] ? /<v>([\s\S]*?)<\/v>/.exec(m[2]) : null;
  return { style: sM ? Number(sM[1]) : null, v: vM ? vM[1] : null };
}
function fill(tape, rows) {
  return unzip(fillXlsxTemplate(TPL(tape), {
    sheetPart: tape.sheetPart, firstRow: tape.firstRow, rows,
    lastCol: tape.lastCol, inheritStyles: !!tape.inheritStyles, forceFullCalc: true,
  }));
}
// The pre-fix build: same rows with every fmt declaration stripped.
const stripFmt = (rows) => rows.map((cells) => cells.map((c) => { const d = Object.assign({}, c); delete d.fmt; return d; }));

// ---- A. the note rate keeps every decimal, on every tape, single + bulk ----
const rateCellRef = { fidelis: 'W', emcap: 'V', bluelake: 'AZ' };
for (const tape of [fidelis, emcap, bluelake]) {
  const loan = synthLoan();
  const col = rateCellRef[tape.key];
  const singleRef = `${col}${tape.firstRow}`;

  const single = fill(tape, [tape.buildRow(loan)]);
  const st = stylesOf(single);
  const cell = cellIn(single, tape.sheetPart, singleRef);
  ok(cell && Number(cell.v) === RATE, `${tape.key}: ${singleRef} stores the full-precision fraction ${RATE}`);
  ok(st.fmtOfStyle(cell.style) === FMT.RATE, `${tape.key}: ${singleRef} displays with ${FMT.RATE} (was truncating) — got ${st.fmtOfStyle(cell.style)}`);

  // BULK — 3 loans through the same chokepoint: every row's rate cell carries
  // the SAME resolved style (shared, cached — no per-row style explosion).
  const rows = [tape.buildRow(synthLoan()), tape.buildRow(synthLoan()), tape.buildRow(synthLoan())];
  const bulk = fill(tape, rows);
  const bst = stylesOf(bulk);
  const styles = [0, 1, 2].map((i) => cellIn(bulk, tape.sheetPart, `${col}${tape.firstRow + i}`)).map((c) => c && c.style);
  ok(styles.every((s) => s === styles[0] && s != null), `${tape.key}: bulk rows share ONE resolved rate style (${styles.join(',')})`);
  ok(bst.fmtOfStyle(styles[0]) === FMT.RATE, `${tape.key}: bulk rate cells display with ${FMT.RATE}`);
  ok(bst.xfs.length === st.xfs.length, `${tape.key}: bulk appends exactly what single appends (${bst.xfs.length} xfs both)`);
}

// ---- B. Blue Lake's points + ratio columns ---------------------------------
{
  const loan = synthLoan();
  const parts = fill(bluelake, [bluelake.buildRow(loan)]);
  const st = stylesOf(parts);
  const fmtAt = (ref) => st.fmtOfStyle((cellIn(parts, bluelake.sheetPart, ref) || {}).style);
  ok(fmtAt('BC3') === FMT.RATE, `bluelake: BC3 Total Points displays with ${FMT.RATE} (1.125 points never "1.13%") — got ${fmtAt('BC3')}`);
  for (const ref of ['AN3', 'AO3', 'AP3']) {
    ok(fmtAt(ref) === FMT.RATIO, `bluelake: ${ref} ratio displays with ${FMT.RATIO} (was 0.0%) — got ${fmtAt(ref)}`);
  }
  ok(fmtAt('AE3') === FMT.RATIO, `bluelake: AE3 Completion %% displays with ${FMT.RATIO} (was 0%) — got ${fmtAt('AE3')}`);
  // The ratio format reuses BUILTIN numFmt 10 — no numFmt element added for it.
  const ratioXf = st.xfs[(cellIn(parts, bluelake.sheetPart, 'AN3') || {}).style];
  ok(/numFmtId="10"/.test(ratioXf), 'bluelake: the ratio clone reuses builtin numFmt 10 (0.00%)');
}

// ---- C. append-only styles: nothing pre-existing moved ---------------------
for (const tape of [fidelis, emcap, bluelake]) {
  const before = stylesOf(unzip(TPL(tape)));
  const after = stylesOf(fill(tape, [tape.buildRow(synthLoan())]));
  ok(after.xfs.length > before.xfs.length, `${tape.key}: styles grew (display formats appended)`);
  for (let i = 0; i < before.xfs.length; i++) {
    assert.strictEqual(after.xfs[i], before.xfs[i], `${tape.key}: pre-existing xf[${i}] must survive byte-identical`);
  }
  passed++;
  ok(after.cellXfsCountAttr === after.xfs.length, `${tape.key}: cellXfs count attribute consistent (${after.cellXfsCountAttr})`);
  ok(after.numFmtCountAttr === after.numFmtCount, `${tape.key}: numFmts count attribute consistent (${after.numFmtCountAttr})`);
}

// ---- D. the CONTROL: the fmt declarations are what close the class ---------
// Build the SAME loans with fmt stripped — the pre-fix state — and confirm the
// old truncating formats come back, so the section-A/B assertions provably bite.
{
  const emc = fill(emcap, stripFmt([emcap.buildRow(synthLoan())]));
  const est = stylesOf(emc);
  ok(est.fmtOfStyle((cellIn(emc, emcap.sheetPart, 'V2') || {}).style) === '0.00%',
    'CONTROL emcap: without fmt the rate cell shows 0.00% — 10.625% would read "10.63%"');

  const bl = fill(bluelake, stripFmt([bluelake.buildRow(synthLoan())]));
  const bst = stylesOf(bl);
  const fmtAt = (ref) => bst.fmtOfStyle((cellIn(bl, bluelake.sheetPart, ref) || {}).style);
  ok(fmtAt('AZ3') === '0.00%', 'CONTROL bluelake: without fmt the rate inherits 0.00%');
  ok(fmtAt('AN3') === '0.0%', 'CONTROL bluelake: without fmt the LTC/LTAIV inherit 0.0% — 84.375% would read "84.4%"');
  ok(fmtAt('AE3') === '0%', 'CONTROL bluelake: without fmt Completion %% inherits 0% — whole percents');
}

// ---- E. FMT.RATE displays exactly like the blessed rate-format.trim3 -------
// '0.00#%': two forced decimals + one optional = toFixed(3) with ONE trailing
// zero trimmed — byte-for-byte the trim3 algorithm, so a rate reads on the tape
// exactly as it reads on the term sheet, the studio and the DocuSign package.
{
  const excel00hash = (pct) => {
    let s = pct.toFixed(3);
    if (s.charAt(s.length - 1) === '0') s = s.slice(0, -1);
    return s;
  };
  for (const pct of [10, 10.25, 10.3, 10.5, 10.625, 10.99, 11.125, 9.875, 12.375]) {
    assert.strictEqual(excel00hash(pct), trim3(pct), `FMT.RATE display of ${pct} must equal trim3`);
  }
  passed++;
  ok(FMT.RATE === '0.00#%' && FMT.RATIO === '0.00%', 'the shared format constants are the audited codes');
}

// ---- F. resolver unit edges -------------------------------------------------
{
  // idempotence: a base style already carrying the wanted format is returned
  // unchanged and appends NOTHING (fidelis style 20 is the template's 0.000%).
  const parts = unzip(TPL(fidelis));
  const r = makeFormatResolver(parts);
  ok(r.resolve(20, '0.000%') === 20, 'resolver: base already right → base returned (byte-identical path)');
  const stylesBefore = parts.find((p) => p.name === 'xl/styles.xml').data;
  r.flush();
  ok(parts.find((p) => p.name === 'xl/styles.xml').data === stylesBefore, 'resolver: nothing resolved → styles.xml untouched');

  // a missing styles.xml degrades to "keep the base style", never a throw
  const noStyles = unzip(TPL(fidelis)).filter((p) => p.name !== 'xl/styles.xml');
  const r2 = makeFormatResolver(noStyles);
  ok(r2.resolve(20, FMT.RATE) === null, 'resolver: no styles.xml → null (cell keeps its base style)');
  r2.flush(); passed++; // and flush is a safe no-op

  // a template that REDEFINES a builtin id must not have that id trusted:
  // craft styles.xml where numFmtId 10 is redefined to a date — asking for
  // '0.00%' must allocate a FRESH custom id, never point at the redefinition.
  const crafted = [{
    name: 'xl/styles.xml',
    data: Buffer.from('<styleSheet><numFmts count="1"><numFmt numFmtId="10" formatCode="m/d/yyyy"/></numFmts><fonts count="1"><font/></fonts><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs></styleSheet>', 'utf8'),
  }];
  const r3 = makeFormatResolver(crafted);
  const idx = r3.resolve(0, '0.00%');
  r3.flush();
  const outXml = crafted[0].data.toString('utf8');
  const xfEls = outXml.match(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g).filter((e) => outXml.indexOf('<cellXfs') < outXml.indexOf(e));
  const newXf = xfEls[idx];
  ok(newXf && !/numFmtId="10"/.test(newXf), 'resolver: a redefined builtin id is never reused for the builtin code');
  ok(/formatCode="0\.00%"/.test(outXml), 'resolver: the wanted code was written as a fresh custom numFmt');
}

console.log(`test-tape-rate-precision-pure: OK (${passed} assertions)`);
