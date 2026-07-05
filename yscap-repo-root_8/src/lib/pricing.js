/* =====================================================================
   pricing.js — server-side wrapper over the FROZEN pricing engines.

   Loads the same byte-identical engine modules the browser loads
   (standard-program.js -> YSP, gold-standard.js -> GSP, title-cost.js ->
   YSTitle) and turns a loan-file row into an authoritative term-sheet
   quote. This module NEVER reimplements or alters engine math — it only
   maps application data to engine inputs and normalizes engine output.

   Registering a product recomputes here on the server so a tampered
   client can never inject fabricated terms; the browser copy of the
   engines is used only for instant what-if display.
   ===================================================================== */
'use strict';

let YSP = null, GSP = null, YSTitle = null, loadErr = null;
try {
  YSP = require('../../web/tools/standard-program.js');
  GSP = require('../../web/tools/gold-standard.js');
  YSTitle = require('../../web/tools/title-cost.js');
} catch (e) {
  loadErr = e && e.message ? e.message : String(e);
}

function enginesReady() { return !!(YSP && GSP && YSTitle); }

const PROGRAM_LABEL = { standard: 'Standard Program', gold: 'Gold Standard Program' };

/* ---- small coercers ---- */
function num(v) { const n = Number(v); return isFinite(n) ? n : 0; }
function clean(s) { return String(s == null ? '' : s).trim(); }

// Parse a free-text term ("12 months", "12", "18-month") into a month count.
function parseTermMonths(t) {
  const m = /(\d{1,2})/.exec(String(t == null ? '' : t));
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 && n <= 36 ? n : 12;
}

// Refinance if the loan type mentions refi; cash-out if it says so.
function loanTypeOf(app) {
  const lt = clean(app.loan_type).toLowerCase();
  return lt.indexOf('refi') > -1 || lt.indexOf('refinance') > -1 ? 'Refinance' : 'Purchase';
}
function isCashOut(app) {
  const lt = clean(app.loan_type).toLowerCase();
  return lt.indexOf('cash') > -1;
}

/* ---- build the engine input from a loan file (+ experience + staff overrides) ----
   `app` is a row from GET /applications/:id (joined borrower fico + address).
   `experience` = { flips, holds, ground } counted from the borrower track record.
   `overrides`  = staff edits from the pricing panel (same field names as the
                  returned inputs), applied last so they win. */
function buildInputs(app, experience, overrides) {
  app = app || {};
  const addr = app.property_address || {};
  const loanType = loanTypeOf(app);

  // Assignment purchases: leverage/pricing size off seller price + financeable fee.
  const isAssignment = loanType === 'Purchase' && !!app.is_assignment && num(app.underlying_contract_price) > 0;
  const sellerPrice = isAssignment ? num(app.underlying_contract_price) : 0;
  const totalPrice = isAssignment
    ? num(app.underlying_contract_price) + num(app.assignment_fee)
    : num(app.purchase_price);

  const base = {
    loanType,
    cashOut: loanType === 'Refinance' && isCashOut(app),
    strategy: clean(app.program) || clean(app.loan_type) || 'Fix & Flip',
    state: clean(addr.state).toUpperCase(),
    city: clean(addr.city),
    address: clean(addr.line1 || addr.address || ''),
    propertyType: clean(app.property_type),
    units: num(app.units) || 0,
    purchasePrice: totalPrice,
    sellerPrice,
    isAssignment,
    asIsValue: num(app.as_is_value),
    arv: num(app.arv),
    rehabBudget: num(app.rehab_budget),
    fico: num(app.fico),
    expFlips: experience ? num(experience.flips) : 0,
    expHolds: experience ? num(experience.holds) : 0,
    expGround: experience ? num(experience.ground) : 0,
    term: parseTermMonths(app.term),
    irMonths: 0,
    heavyRehab: false,
    sqftAddition: false,
    targetLTC: 0,
  };

  // Staff overrides win. Only copy known keys; coerce numeric fields.
  const NUMK = ['units', 'purchasePrice', 'sellerPrice', 'asIsValue', 'arv', 'rehabBudget',
    'fico', 'expFlips', 'expHolds', 'expGround', 'term', 'irMonths', 'targetLTC',
    'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate'];
  const STRK = ['loanType', 'strategy', 'state', 'city', 'address', 'propertyType'];
  const BOOLK = ['cashOut', 'isAssignment', 'heavyRehab', 'sqftAddition', 'forcePrice'];
  const out = Object.assign({}, base);
  if (overrides && typeof overrides === 'object') {
    for (const k of NUMK) if (overrides[k] != null && overrides[k] !== '') out[k] = num(overrides[k]);
    for (const k of STRK) if (overrides[k] != null) out[k] = clean(overrides[k]);
    for (const k of BOOLK) if (overrides[k] != null) out[k] = !!overrides[k];
  }
  return out;
}

/* ---- normalize an engine result into one UI-agnostic quote shape ---- */
function normalize(program, input, ev, ladder) {
  const s = ev.sizing || {};
  const origPct = (program === 'gold' ? (GSP.constants && GSP.constants.ORIG_PCT) : (YSP.constants && YSP.constants.ORIG_PCT)) || 0.0125;
  const totalLoan = num(s.totalLoan);
  const state = clean(input.state).toUpperCase();
  const title = YSTitle.estimate(state, totalLoan, input.loanType);

  const quote = {
    program,
    programLabel: PROGRAM_LABEL[program],
    productLabel: ev.productLabel || null,
    status: ev.status,
    eligible: ev.status !== 'INELIGIBLE',
    reasons: (ev.reasons || []).map((r) => ({ level: r.level, msg: r.msg })),
    tier: ev.tier || null,
    tierLabel: ev.tierLabel || null,
    noteRate: ev.noteRate != null ? ev.noteRate : null,
    origPct,
    origination: totalLoan > 0 ? Math.round(totalLoan * origPct) : 0,
    sizing: {
      totalLoan,
      initialAdvance: num(s.acquisition),
      rehabHoldback: num(s.rehabLoan),
      financedReserve: num(s.financedIR),
      downPayment: num(s.downPayment),
      initialPayment: num(s.initialPayment),
      monthlyPayment: num(s.fullPayment),
      ltcPct: num(s.ltcPct),
      acqLtvPct: num(s.acqLtvPct),
      arvPct: num(s.arvPct),
      maxReserve: num(s.maxReserve),
      binding: s.binding || '',
    },
    title: { total: num(title.total), premium: num(title.premium), fees: num(title.fees), known: !!title.known },
    assignment: ev.assignment || null,
    ladder: ladder || null,
    liquidity: ev.liquidity != null ? num(ev.liquidity) : null,
  };
  return quote;
}

/* ---- quote one program (no persistence) ---- */
function quoteProgram(program, input) {
  if (!enginesReady()) throw new Error('pricing engines unavailable' + (loadErr ? ': ' + loadErr : ''));
  if (program === 'gold') {
    const ev = GSP.evaluate(input);
    return normalize('gold', input, ev, null);
  }
  const ev = YSP.evaluate(input);
  let ladder = null;
  try {
    const pl = YSP.priceLadder(input);
    if (pl && pl.eligible && pl.rows && pl.rows.length) {
      ladder = { maxLtc: pl.maxLtc, maxBucket: pl.maxBucket, binding: pl.binding, rows: pl.rows };
    }
  } catch (_) { /* ladder is best-effort */ }
  return normalize('standard', input, ev, ladder);
}

/* ---- quote both programs for a file (panel default) ---- */
function quoteAll(app, experience, overrides) {
  const input = buildInputs(app, experience, overrides);
  const standard = safeQuote('standard', input);
  const gold = safeQuote('gold', input);
  return { inputs: input, standard, gold };
}

function safeQuote(program, input) {
  try { return quoteProgram(program, input); }
  catch (e) { return { program, programLabel: PROGRAM_LABEL[program], status: 'ERROR', eligible: false, reasons: [{ level: 'INELIGIBLE', msg: e.message || 'pricing error' }], sizing: null }; }
}

module.exports = {
  enginesReady, loadErr: () => loadErr,
  buildInputs, quoteProgram, quoteAll, parseTermMonths, PROGRAM_LABEL,
};
