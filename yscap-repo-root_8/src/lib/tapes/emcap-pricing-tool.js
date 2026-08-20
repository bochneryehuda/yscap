'use strict';
/**
 * EMCAP RTL SELLER PRICING & ELIGIBILITY TOOL — our loan filled into EMCAP's own
 * workbook, so THEIR sheet prices and rules the deal (owner-directed 2026-08-20).
 *
 * This is the workbook the Silver program was built from. `docs/SILVER-PROGRAM-EMCAP.md`:
 * *"Guidelines and rates are transcribed from the EMCAP RTL Seller Pricing &
 * Eligibility Tool v1 (June 2026 guideline version)"* — the Tier Grid tab, the
 * pricing matrix, the underwriting commentary and the hidden Engine tab (1,555
 * priced cells). Our transcription of it is the frozen engine
 * `web/tools/silver-program.js`. This export sends EMCAP the ORIGINAL: their file,
 * their formulas, with our loan's inputs typed into the yellow cells so section 2
 * (auto-classification), section 3 (pricing result), section 4 (eligibility detail)
 * and section 5 (the required-document checklist) all populate BY THEMSELVES when
 * they open it.
 *
 * NOT A DATA TAPE. A tape (./emcap.js) is the loan being SOLD — one row of loan
 * data on EMCAP's submission workbook, gated behind the Encompass reconciliation
 * because it is the sale. This is the question asked BEFORE that: *would EMCAP take
 * this loan, and at what rate*. It is deliberately not in the tape registry, does
 * not go through the tape export gate, and lives in its own section of Send to
 * investor. It DOES read every figure through the tape's own derivations
 * (emcap.js `economics`/`termMonths`) so the eligibility sheet and the tape can
 * never tell EMCAP two different numbers about the same loan.
 *
 * ── WHAT WE FILL, AND WHAT WE DELIBERATELY DO NOT ───────────────────────────
 * Owner-directed 2026-08-20, cell by cell. The workbook's own instruction row says
 * *"Enter the loan details in the yellow cells… Yellow = input; everything else is
 * locked"* — so we write the yellow cells and NOTHING else:
 *
 *   C6  Loan Product                 ← GUC / Bridge / Fix & Flip, from the loan
 *   C7  Loan Purpose                 ← Purchase / Refinance
 *   C8  Requested Term (months)      ← the 12/18/24 bucket the grid prices
 *   C9  Property Market              ← NYC five-borough vs Standard (Non-NYC)
 *   C10 Property ZIP code
 *   C11 Exit Strategy
 *   C13 FICO Score
 *   C14 # Comparable projects (3 yrs) ← VERIFIED experience only
 *   C15 GC-only experience?          ← always "No" (owner-directed; see below)
 *   C17 Total Loan Amount
 *   C18 Purchase / Acquisition Cost
 *   C19 Rehab / Construction Budget
 *   C20 After-Repair Value (ARV)
 *   C21 Note Rate                    ← the file's final note rate
 *   C24 Cash-Out Amount              ← REFINANCE only
 *   C23 Projected DSCR               ← always EMPTY (owner-directed)
 *   C25 Projected Project Profit     ← always EMPTY (owner-directed)
 *
 * Every other cell is EMCAP's own formula and is left exactly as it is — the
 * auto-classification, the tier, the bands, the rate key, the eligibility decision
 * and the cure text all compute themselves from the seventeen cells above.
 *
 * C15 IS NEVER DERIVED. "GC-only experience" means the sponsor's track record is
 * work done as a general contractor for someone else, which caps the tier (Tier 2
 * ≤$2.5M / Tier 3 above) and disqualifies sub-divisions. Nothing on the file
 * records that, and inferring it from a project list would be a guess that moves
 * EMCAP's tier. It goes out as "No" — the owner's instruction — and a human can
 * change it in the sheet, which is precisely why the dropdown is left live.
 *
 * ── THE DROPDOWNS ARE READ OUT OF THE WORKBOOK, NEVER RE-TYPED HERE ─────────
 * C6/C7/C9/C11/C15 are data-validation lists and every downstream formula is an
 * `INDEX(…Tokens, MATCH(C6, …Labels, 0))`, so a label that is one character off
 * its own list does not "look slightly wrong" — it makes the sheet return #N/A and
 * the loan reads INELIGIBLE. So this module does not contain a copy of EMCAP's
 * label text. It reads the workbook's OWN defined names at load time —
 * ProdLabels/ProdTokens, PurpLabels/PurpTokens, MktLabels/MktTokens,
 * ExitLabels/ExitTokens, TermsList, YesNoList — off the hidden Engine tab of the
 * very file we are about to fill, and looks each label up BY ITS TOKEN. The tokens
 * (FF/GUC/BR, P/R, STD/NYC, FLIP/HOLD/BRIDGE) are the same ones our frozen engine
 * already speaks, because both were transcribed from this workbook. If EMCAP ships
 * a v2 with re-worded labels, the export keeps working; if a token disappears, the
 * cell ships BLANK and is NAMED, rather than filled with a value their sheet cannot
 * match.
 *
 * ── AND THE CLASSIFICATION COMES FROM THE ENGINE, NOT FROM A SECOND OPINION ──
 * Product, market, exit and purpose are read off `SVP.evaluate()` — the same frozen
 * engine, on the same inputs (`pricing.buildInputs`), that priced the file. Not one
 * of those four is re-derived here. If our engine calls a deal a NYC ground-up
 * refinance, that is exactly what EMCAP's sheet is told.
 *
 * ── WHY THE EXPORTED FILE RECALCULATES ──────────────────────────────────────
 * The vendor ships the tool with a SAMPLE loan typed in, so every formula cell
 * carries that sample's cached answer. We drop those cached answers and set
 * `fullCalcOnLoad`, so the file recomputes on open — and a viewer that ignores the
 * flag shows an empty cell rather than the sample's verdict over our loan's inputs.
 * `scripts/test-emcap-pricing-tool-recalc.js` proves it by actually recalculating a
 * built file and reading the eligibility back out.
 *
 * PURE except for `previewEmcapPricingTool` / `buildEmcapPricingTool`, which read.
 * Writes nothing, anywhere.
 */
const fs = require('fs');
const path = require('path');
const { unzip } = require('../zip');
const { fillXlsxCells } = require('./xlsx-template');
const emcapTape = require('./emcap');
const programProvider = require('./program-provider');
const { normNoteBuyer } = require('../conditions/field-registry');

const TEMPLATE_FILE = path.join(__dirname, 'templates', 'emcap-pricing-tool.xlsx');
// The visible input tab, BY NAME — never a hardcoded sheet1.xml, so a re-ordered
// workbook is still filled in the right place (and a renamed one refuses loudly).
const SHEET_NAME = 'Pricing Tool';
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------------------
// READING THE WORKBOOK'S OWN VOCABULARY
// ---------------------------------------------------------------------------
const XML_ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return String(s == null ? '' : s).replace(/&(amp|lt|gt|quot|apos|#x?[0-9A-Fa-f]+);/g, (full, ent) => {
    if (XML_ENT[ent] != null) return XML_ENT[ent];
    const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return isFinite(code) ? String.fromCodePoint(code) : full;
  });
}

// sharedStrings.xml → the array every `t="s"` cell indexes into. A `<si>` may hold
// several `<t>` runs (rich text); they concatenate, exactly as Excel displays them.
function readSharedStrings(parts) {
  const p = parts.find((x) => x.name === 'xl/sharedStrings.xml');
  if (!p) return [];
  const xml = p.data.toString('utf8');
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(m[1]))) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

// One cell's VALUE out of a worksheet part. Handles the four forms this workbook
// uses: shared string, inline string, formula-string result and number.
function cellValue(sheetXml, sharedStrings, ref) {
  const re = new RegExp(`<c r="${ref}"(?:\\s[^>]*?)?/>|<c r="${ref}"(?:\\s[^>]*?)?>[\\s\\S]*?</c>`);
  const m = re.exec(sheetXml);
  if (!m) return null;
  const cell = m[0];
  const tm = /\st="([^"]+)"/.exec(cell);
  const type = tm ? tm[1] : 'n';
  if (type === 'inlineStr') {
    const is = /<is>([\s\S]*?)<\/is>/.exec(cell);
    if (!is) return null;
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(is[1]))) text += decodeXml(t[1]);
    return text;
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(cell);
  if (!v) return null;
  if (type === 's') { const i = Number(v[1]); return sharedStrings[i] != null ? sharedStrings[i] : null; }
  if (type === 'str') return decodeXml(v[1]);
  const n = Number(v[1]);
  return isFinite(n) ? n : decodeXml(v[1]);
}

// A defined name ("ProdLabels") → { sheet:'Engine', col:'L', from:2, to:4 }.
// Single-column ranges only, which is every list this workbook declares.
function definedRange(workbookXml, name) {
  const re = new RegExp(`<definedName name="${name}"(?:\\s[^>]*?)?>([\\s\\S]*?)</definedName>`);
  const m = re.exec(workbookXml);
  if (!m) return null;
  const ref = decodeXml(m[1]).trim();
  const r = /^'?([^'!]+)'?!\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/.exec(ref);
  if (!r || (r[4] && r[4] !== r[2])) return null;
  return { sheet: r[1], col: r[2], from: Number(r[3]), to: Number(r[5] || r[3]) };
}

// Sheet display name → its zip part, via workbook.xml's <sheet r:id> and the rels.
function sheetPartsByName(parts) {
  const wb = parts.find((p) => p.name === 'xl/workbook.xml');
  const rels = parts.find((p) => p.name === 'xl/_rels/workbook.xml.rels');
  if (!wb || !rels) return {};
  const relsXml = rels.data.toString('utf8');
  const target = {};
  const relRe = /<Relationship\b([^>]*)\/>/g;
  let m;
  while ((m = relRe.exec(relsXml))) {
    const id = /\bId="([^"]+)"/.exec(m[1]);
    const tgt = /\bTarget="([^"]+)"/.exec(m[1]);
    if (id && tgt) target[id[1]] = 'xl/' + decodeXml(tgt[1]).replace(/^\.?\//, '');
  }
  const out = {};
  const wbXml = wb.data.toString('utf8');
  const sheetRe = /<sheet\b([^>]*)\/>/g;
  while ((m = sheetRe.exec(wbXml))) {
    const nm = /\bname="([^"]+)"/.exec(m[1]);
    const rid = /\br:id="([^"]+)"/.exec(m[1]);
    if (nm && rid && target[rid[1]]) out[decodeXml(nm[1])] = target[rid[1]];
  }
  return out;
}

// Read one label/token list pair off the Engine tab and return { TOKEN: label }.
// A row whose token or label is blank is skipped: a half-declared option can never
// become a value we write.
function tokenLabelMap(parts, sharedStrings, byName, workbookXml, labelName, tokenName) {
  const labels = definedRange(workbookXml, labelName);
  const tokens = definedRange(workbookXml, tokenName);
  if (!labels || !tokens || labels.sheet !== tokens.sheet) return null;
  const part = parts.find((p) => p.name === byName[labels.sheet]);
  if (!part) return null;
  const xml = part.data.toString('utf8');
  const map = Object.create(null);
  const rows = Math.min(labels.to - labels.from, tokens.to - tokens.from);
  for (let i = 0; i <= rows; i++) {
    const label = cellValue(xml, sharedStrings, `${labels.col}${labels.from + i}`);
    const token = cellValue(xml, sharedStrings, `${tokens.col}${tokens.from + i}`);
    if (label == null || label === '' || token == null || token === '') continue;
    map[String(token).trim().toUpperCase()] = String(label);
  }
  return Object.keys(map).length ? map : null;
}

// A plain single-column list (TermsList, YesNoList) → its values, in sheet order.
function plainList(parts, sharedStrings, byName, workbookXml, name) {
  const range = definedRange(workbookXml, name);
  if (!range) return null;
  const part = parts.find((p) => p.name === byName[range.sheet]);
  if (!part) return null;
  const xml = part.data.toString('utf8');
  const out = [];
  for (let r = range.from; r <= range.to; r++) {
    const v = cellValue(xml, sharedStrings, `${range.col}${r}`);
    if (v != null && v !== '') out.push(v);
  }
  return out.length ? out : null;
}

// The template's bytes + its vocabulary, read ONCE. The file never changes at
// runtime, and a workbook we cannot read the lists out of is refused HERE, at the
// first export, rather than producing a sheet full of #N/A at the note buyer.
let _tpl = null;
function template() {
  if (_tpl) return _tpl;
  const buf = fs.readFileSync(TEMPLATE_FILE);
  const parts = unzip(buf);
  const wb = parts.find((p) => p.name === 'xl/workbook.xml');
  if (!wb) throw new Error('EMCAP pricing tool: the template has no workbook.xml.');
  const workbookXml = wb.data.toString('utf8');
  const byName = sheetPartsByName(parts);
  const sheetPart = byName[SHEET_NAME];
  if (!sheetPart) {
    throw new Error(`EMCAP pricing tool: the template has no "${SHEET_NAME}" tab (found: ${Object.keys(byName).join(', ') || 'none'}).`);
  }
  const ss = readSharedStrings(parts);
  const vocab = {
    product: tokenLabelMap(parts, ss, byName, workbookXml, 'ProdLabels', 'ProdTokens'),
    purpose: tokenLabelMap(parts, ss, byName, workbookXml, 'PurpLabels', 'PurpTokens'),
    market: tokenLabelMap(parts, ss, byName, workbookXml, 'MktLabels', 'MktTokens'),
    exit: tokenLabelMap(parts, ss, byName, workbookXml, 'ExitLabels', 'ExitTokens'),
    terms: plainList(parts, ss, byName, workbookXml, 'TermsList'),
    yesNo: plainList(parts, ss, byName, workbookXml, 'YesNoList'),
  };
  for (const k of Object.keys(vocab)) {
    if (!vocab[k]) throw new Error(`EMCAP pricing tool: the template's "${k}" dropdown list could not be read — refusing to fill a sheet whose own lists we cannot see.`);
  }
  _tpl = { buf, sheetPart, vocab };
  return _tpl;
}

/** The workbook's dropdown vocabulary (read from the template). Exposed for tests. */
function vocabulary() { return template().vocab; }

// ---------------------------------------------------------------------------
// THE LOAN'S CLASSIFICATION — from the frozen engine, never re-derived
// ---------------------------------------------------------------------------
let _svp; let _svpTried = false;
function silverEngine() {
  if (_svpTried) return _svp;
  _svpTried = true;
  try { _svp = require(path.join(__dirname, '..', '..', '..', 'web', 'tools', 'silver-program.js')); }
  catch (_) { _svp = null; }
  return _svp;
}

/**
 * classify(loan) → { product, purpose, market, exit, strategyCode, acqDenom } | null
 *
 * Runs the SAME frozen Silver engine, on the SAME inputs (`pricing.buildInputs`),
 * that priced this file. `evaluate()` fills those four classification fields on
 * EVERY result shape — including the early refusals — so an INELIGIBLE deal still
 * classifies, which matters: an ineligible loan is exactly the one somebody wants
 * to put in front of EMCAP's own sheet.
 *
 * Returns null when the engine or the pricing loader is unavailable; the caller
 * then ships those cells BLANK and names them, rather than guessing a product.
 */
function classify(loan) {
  const SVP = silverEngine();
  if (!SVP) return null;
  try {
    const pricing = require('../pricing');
    // `fico` is what the pricing loader calls the file's pricing score (the
    // GREATEST across borrower + co-borrower); the tape assembler carries the same
    // number as `loan.fico`. Naming it the loader's way is what lets buildInputs
    // read it — see staff.js loadFileForPricing.
    const app = Object.assign({}, loan.app, { fico: loan.fico });
    const input = pricing.buildInputs(app, loan.exp);
    const ev = SVP.evaluate(input);
    if (!ev || typeof ev !== 'object') return null;
    return {
      product: ev.product || null,               // FF | GUC | BR
      purpose: ev.loanType === 'Refinance' ? 'R' : 'P',
      market: ev.market || null,                 // STD | NYC
      exit: ev.exit || null,                     // FLIP | HOLD | BRIDGE
      strategyCode: ev.strategyCode || null,     // FF | NC | BR  (for projectCount)
      /* The engine's own acquisition denominator — `purchase ? min(price, as-is)
         : as-is`. EMCAP's C18 is the denominator of BOTH their acq-LTV
         ((C17−C19)/C18) and their cost basis (C18+C19), which is the same role
         `acqDenom` plays in `costBasis0 = acqDenom + rehab`. Sending the engine's
         own number is what makes their sheet's LTC and acq-LTV equal ours. */
      acqDenom: (ev.sizing && Number(ev.sizing.acqDenom)) || null,
      cashOut: !!ev.cashOut,
      SVP,
    };
  } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// THE CELL MAP
// ---------------------------------------------------------------------------
const n = (v) => { if (v == null || v === '') return null; const x = Number(v); return isFinite(x) ? x : null; };

// A 5-character ZIP, as TEXT. The workbook reads it with `LEFT(TEXT(C10,"00000"),3)`
// to get the excluded-market prefix, which works for either form — but a New Jersey
// 07036 written as a NUMBER *displays* as 7036 in their General-formatted cell, and
// a note-buyer reviewer reading "7036" on a ZIP line is a support call. Text keeps
// the leading zero on screen and feeds TEXT() identically.
function zipCell(loan) {
  const raw = String((loan.address && loan.address.zip) || '').trim();
  // ZIP+4 ("07036-1234") and stray spaces both reduce to the five-digit ZIP.
  const m = /(\d{5})/.exec(raw);
  return m ? m[1] : '';
}

/** The refinance cash-out figure the file's registered quote carries ($0 → null). */
function cashOutAmount(loan) {
  const refi = loan.quote && loan.quote.refi;
  const amt = refi ? n(refi.cashOut) : null;
  return amt != null && amt > 0 ? amt : null;
}

/**
 * buildPricingToolCells(loan, opts) → { cells, filled, gaps, classification }
 *
 * PURE — no DB, no network. `cells` is what fillXlsxCells writes; `filled` is the
 * staff-facing summary of every value that went in; `gaps` names every input cell
 * that ships EMPTY and why, so nothing goes to a note buyer unannounced.
 */
function buildPricingToolCells(loan, opts = {}) {
  const vocab = (opts.vocab || vocabulary());
  const cls = ('classification' in opts) ? opts.classification : classify(loan);
  const econ = emcapTape.economics(loan);
  const isRefi = cls ? cls.purpose === 'R' : (emcapTape.purchaseRefi(loan) === 'Refinance');

  const cells = {};
  const filled = [];
  const gaps = [];

  // A cell is either FILLED (and summarized) or BLANK (and named). There is no
  // third outcome — an input cell must never keep the vendor sample's value.
  function put(ref, label, value, type, display) {
    if (value == null || value === '') {
      cells[ref] = { type: 'blank' };
      return false;
    }
    cells[ref] = { value, type };
    filled.push({ cell: ref, label, value, display: display == null ? String(value) : display });
    return true;
  }
  function blank(ref, label, why) {
    cells[ref] = { type: 'blank' };
    if (why) gaps.push({ cell: ref, label, why });
  }
  // A dropdown cell: look the label up BY TOKEN in the workbook's own list.
  function putVocab(ref, label, list, token, missingWhy) {
    const key = token == null ? '' : String(token).trim().toUpperCase();
    const text = key && list[key] != null ? list[key] : null;
    if (!text) { blank(ref, label, missingWhy); return false; }
    return put(ref, label, text, 's');
  }

  // ---- C6 / C7 / C9 / C11 — the four dropdowns the engine classifies ----
  const noEngine = 'our pricing engine could not classify this file, so the dropdown is left for a human to pick';
  putVocab('C6', 'Loan Product', vocab.product, cls && cls.product,
    cls ? `the loan's product ("${cls.product}") is not one of EMCAP's own product options` : noEngine);
  putVocab('C7', 'Loan Purpose', vocab.purpose, cls && cls.purpose,
    cls ? `the loan's purpose is not one of EMCAP's own options` : noEngine);
  putVocab('C9', 'Property Market', vocab.market, cls && cls.market,
    cls ? `the property's market is not one of EMCAP's own options` : noEngine);
  putVocab('C11', 'Exit Strategy', vocab.exit, cls && cls.exit,
    cls ? `the loan's exit strategy is not one of EMCAP's own options` : noEngine);

  // ---- C8 Requested Term — the 12/18/24 bucket their grid prices ----
  const months = n(emcapTape.termMonths(loan));
  const SVP = (cls && cls.SVP) || silverEngine();
  let termValue = null;
  if (months != null && SVP && typeof SVP.termToken === 'function') {
    const bucket = Number(SVP.termToken(months));
    // >24 months is outside EMCAP's grid entirely (our own program routes it to
    // individual review). Bucketing it down to 24 would understate the term to the
    // note buyer, so it goes out empty and says so.
    if (months <= Math.max.apply(null, vocab.terms.map(Number)) && vocab.terms.map(Number).includes(bucket)) termValue = bucket;
  }
  if (termValue != null) put('C8', 'Requested Term (months)', termValue, 'n', `${termValue} months`);
  else if (months != null) blank('C8', 'Requested Term (months)', `a ${months}-month term is outside the 12 / 18 / 24-month terms EMCAP's tool offers — pick a term in the sheet or submit for individual review`);
  else blank('C8', 'Requested Term (months)', 'no term on the file');

  // ---- C10 ZIP ----
  const zip = zipCell(loan);
  if (zip) put('C10', 'Property ZIP code', zip, 's');
  else blank('C10', 'Property ZIP code', 'no ZIP on the property address — EMCAP’s geography check reads the first three digits of it');

  // ---- C13 FICO ----
  const fico = n(loan.fico);
  if (fico) put('C13', 'FICO Score', fico, 'n');
  else blank('C13', 'FICO Score', 'no credit score on file for either borrower');

  /* ---- C14 comparable projects, VERIFIED only (owner-directed) ----
     The cell EMCAP reads is "# Comparable projects completed (last 3 yrs)", and it
     sets the borrower's tier — the tier that sets their max loan, min FICO and every
     leverage cap. So it carries the VERIFIED count, not the claimed one: the same
     `is_verified = true` rule the TPR/REO package and the CorrFirst export already
     follow ("a project still pending review never goes to an investor"). Note our
     OWN sizing prices on the claimed-of-record figure (loadFileForPricing), so this
     number can legitimately sit below the tier we priced — that is the point of
     asking the note buyer.
     WHICH projects count as "comparable" is the engine's own definition
     (`projectCount`, ground-up counts ground-up only), not a second reading. */
  const verified = (loan.exp && loan.exp.verified) || null;
  let comparable = null;
  if (verified && SVP && typeof SVP.projectCount === 'function' && cls && cls.strategyCode) {
    const c = Number(SVP.projectCount(cls.strategyCode, verified));
    if (isFinite(c) && c >= 0) comparable = c;
  } else if (verified) {
    comparable = Number(loan.exp.verifiedTotal) || 0;
  }
  if (comparable != null) {
    put('C14', '# Comparable projects completed (last 3 yrs)', comparable, 'n');
    if (comparable === 0) {
      gaps.push({
        cell: 'C14',
        label: '# Comparable projects completed (last 3 yrs)',
        why: 'no VERIFIED comparable projects in the last 3 years — EMCAP’s sheet will tier this borrower at Tier 3. Verify the borrower’s track record and export again.',
      });
    }
  } else blank('C14', '# Comparable projects completed (last 3 yrs)', 'the borrower’s verified track record could not be read');

  /* ---- C15 GC-only experience — always "No" (owner-directed) ----
     Never derived. See the module header. */
  const noLabel = (vocab.yesNo || []).map(String).find((v) => /^no$/i.test(v.trim()));
  if (noLabel) put('C15', 'GC-only experience?', noLabel, 's');
  else blank('C15', 'GC-only experience?', 'EMCAP’s Yes/No list could not be read');

  // ---- C17..C21 the money and the rate ----
  put('C17', 'Total Loan Amount ($)', n(econ.totalLoan), 'n');
  if (n(econ.totalLoan) == null) gaps.push({ cell: 'C17', label: 'Total Loan Amount ($)', why: 'the file has no registered loan amount' });

  // C18 is EMCAP's acquisition denominator — the engine's own acqDenom (see
  // classify). Falls back to the tape's purchase price when the engine could not
  // run, which is the same figure on a purchase.
  const acq = (cls && n(cls.acqDenom)) != null ? n(cls.acqDenom)
    : (isRefi ? n(loan.app.as_is_value) : n(econ.purchasePrice));
  put('C18', 'Purchase / Acquisition Cost ($)', acq, 'n');
  if (acq == null) {
    gaps.push({
      cell: 'C18',
      label: 'Purchase / Acquisition Cost ($)',
      why: isRefi ? 'a refinance is sized on the as-is value and this file has none — EMCAP’s acq-LTV and LTC cannot compute without it'
        : 'no purchase price on the file — EMCAP’s acq-LTV and LTC cannot compute without it',
    });
  }

  put('C19', 'Rehab / Construction Budget ($)', n(econ.totalRehab), 'n');
  if (n(econ.totalRehab) == null) gaps.push({ cell: 'C19', label: 'Rehab / Construction Budget ($)', why: 'no rehab / construction budget on the file' });

  put('C20', 'After-Repair Value — ARV ($)', n(econ.arv), 'n');
  if (n(econ.arv) == null) gaps.push({ cell: 'C20', label: 'After-Repair Value — ARV ($)', why: 'no ARV on the file or its appraisal — EMCAP’s AR-LTV band, and therefore the rate, cannot compute without it' });

  // The note rate goes in as the FRACTION the percent-formatted cell stores.
  const rate = n(econ.noteRate);
  put('C21', 'Note Rate (%)', rate, 'n', rate != null ? `${(rate * 100).toFixed(3)}%` : '');
  if (rate == null) gaps.push({ cell: 'C21', label: 'Note Rate (%)', why: 'no note rate on the file — EMCAP’s indicative buy rate is the higher of their grid rate and the note rate less 1.00 point, so it needs this' });

  /* ---- C23 / C24 / C25 — the three conditional cells (owner-directed) ----
     C23 (projected DSCR) and C25 (projected project profit) are always EMPTY: we
     hold neither figure, and EMCAP's own checks read them as "not stated" when
     blank (their DSCR gate tests `C23>0`, their cash-out gate tests `C25>0`), so an
     empty cell is the honest answer AND the neutral one. C24 carries the cash-out
     on a refinance, which is what turns on their "cash-out ≤ 50% of projected
     profit" overlay row. */
  blank('C23', 'Projected DSCR (if Fix & Hold / DSCR)', null);
  const cashOut = isRefi ? cashOutAmount(loan) : null;
  if (cashOut != null) put('C24', 'Cash-Out Amount ($) (if Refinance)', cashOut, 'n');
  else blank('C24', 'Cash-Out Amount ($) (if Refinance)', null);
  blank('C25', 'Projected Project Profit ($) (if Refinance)', null);

  return { cells, filled, gaps, classification: cls ? { product: cls.product, purpose: cls.purpose, market: cls.market, exit: cls.exit } : null, isRefi };
}

// ---------------------------------------------------------------------------
// AVAILABILITY — is this an EMCAP loan?
// ---------------------------------------------------------------------------
/**
 * emcapAvailability(loan) → { available, buyer, buyerKey, program, why }
 *
 * This is EMCAP's own guideline sheet, so it is offered on an EMCAP loan: the
 * file's capital provider is EMCAP (the tape's ENUMERATED alias list — the same
 * closed list, never a fuzzy match, because this direction sends our borrower's
 * figures out of the building), OR the file is registered on the program EMCAP
 * buys (Silver — `program-provider.js`). Either alone is enough: a file often
 * carries the program before anyone sets the provider, and the whole point of the
 * sheet is to ask EMCAP before the loan is theirs.
 */
function emcapAvailability(loan) {
  const raw = loan && loan.noteBuyerRaw;
  const buyerKey = normNoteBuyer(raw);
  const program = (loan && loan.registration && loan.registration.program) || null;
  const buyerIsEmcap = !!buyerKey && (buyerKey === emcapTape.buyerKey
    || (emcapTape.buyerAliases || []).includes(buyerKey));
  const programIsEmcaps = !!program && programProvider.programMatchesBuyer(program, emcapTape.buyerKey);
  const available = buyerIsEmcap || programIsEmcaps;
  return {
    available,
    buyer: raw || null,
    buyerKey: buyerKey || null,
    program,
    why: available ? null
      : (raw
        ? `This file's capital provider is "${String(raw).trim()}" and it isn't registered on the ${programProvider.programLabel('silver')} program. The EMCAP pricing & eligibility tool is EMCAP's own sheet — set the capital provider to EMCAP, or register the file as ${programProvider.programLabel('silver')}.`
        : `This file has no capital provider set and isn't registered on the ${programProvider.programLabel('silver')} program. The EMCAP pricing & eligibility tool is EMCAP's own sheet — set the capital provider to EMCAP, or register the file as ${programProvider.programLabel('silver')}.`),
  };
}

// ---------------------------------------------------------------------------
// FILENAME
// ---------------------------------------------------------------------------
function filename(loan) {
  const ln = (loan.app.ys_loan_number || loan.app.investor_loan_number || 'loan').replace(/[^A-Za-z0-9._-]+/g, '-');
  const last = (loan.borrower && loan.borrower.last) ? '-' + String(loan.borrower.last).replace(/[^A-Za-z0-9]+/g, '') : '';
  return `EMCAP-Pricing-Eligibility-${ln}${last}.xlsx`;
}

// ---------------------------------------------------------------------------
// THE TWO IO ENTRY POINTS
// ---------------------------------------------------------------------------
/**
 * previewEmcapPricingTool(appId, db) — what the export WILL contain, before it is
 * built: every value that goes into a yellow cell, and every cell that ships empty
 * with the reason. Never produces bytes. null when the file does not exist.
 */
async function previewEmcapPricingTool(appId, db) {
  // Lazily required: ./assemble reaches the database, and every PURE piece of this
  // module (the vocabulary, the cell map, the availability rule) must load with no
  // database in reach so it unit-tests on its own.
  const { assembleTapeLoan } = require('./assemble');
  const loan = await assembleTapeLoan(appId, db);
  if (!loan.found) return null;
  const availability = emcapAvailability(loan);
  const { filled, gaps, classification, isRefi } = buildPricingToolCells(loan);
  return {
    availability,
    isRefinance: !!isRefi,
    classification,
    filled,
    gaps,
    filename: filename(loan),
    // What the borrower's VERIFIED track record actually holds, by category, so a
    // staffer can see what the tier-setting number in C14 is made of.
    verifiedExperience: (loan.exp && loan.exp.verified)
      ? { flips: loan.exp.verified.flips, holds: loan.exp.verified.holds, ground: loan.exp.verified.ground, total: loan.exp.verifiedTotal }
      : null,
  };
}

/**
 * buildEmcapPricingTool(appId, db) — EMCAP's workbook with our loan's inputs in it.
 * Returns { buf, filename, contentType, filled, gaps, availability }.
 * null when the file does not exist.
 */
async function buildEmcapPricingTool(appId, db) {
  const { assembleTapeLoan } = require('./assemble');
  const loan = await assembleTapeLoan(appId, db);
  if (!loan.found) return null;
  const availability = emcapAvailability(loan);
  const tpl = template();
  const { cells, filled, gaps, classification } = buildPricingToolCells(loan, { vocab: tpl.vocab });
  const buf = fillXlsxCells(tpl.buf, {
    sheetPart: tpl.sheetPart,
    cells,
    // The vendor's sample loan is cached in every formula cell of this tab. Drop
    // those, and force the recalculation that fills them with OUR loan's answers.
    clearCached: true,
    forceFullCalc: true,
  });
  return { buf, filename: filename(loan), contentType: CONTENT_TYPE, filled, gaps, classification, availability };
}

module.exports = {
  buildEmcapPricingTool,
  previewEmcapPricingTool,
  // pure pieces, exposed for the unit tests and for callers that already hold a loan
  buildPricingToolCells,
  emcapAvailability,
  classify,
  vocabulary,
  filename,
  template,
  TEMPLATE_FILE,
  SHEET_NAME,
  CONTENT_TYPE,
};
