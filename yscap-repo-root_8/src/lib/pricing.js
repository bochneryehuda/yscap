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
// Hardcoded fee fallback (used only if the company-settings cache is stone
// cold). Company defaults (Pricing Admin Center) override these for every
// not-yet-registered file; a per-file adminPricing override still wins over
// both. The engine MATH is untouched — this is the input/fee-default layer.
const FEES = { lender: 2195, credit: 150, appraisal: 800 };
const pricingSettings = require('./pricing-settings');

/* ---- small coercers ---- */
// Strips thousands-separator commas before parsing (#143): the studio's dollar
// inputs now DISPLAY comma-grouped, so an override can arrive as "400,000". For a
// comma-free value (the only form pre-#143) the replace is a no-op, so every
// existing input parses BYTE-IDENTICALLY — this only rescues a comma'd string that
// Number() would otherwise turn into NaN→0 and silently zero the loan. Frozen-safe.
function num(v) { const n = Number(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : 0; }
function clean(s) { return String(s == null ? '' : s).trim(); }
function round2(n) { return Math.round(num(n) * 100) / 100; }
function reserveMonths(totalLoan) { return num(totalLoan) > 1000000 ? 4 : 2; }

// Parse a free-text term ("12 months", "12", "18-month") into a month count.
function parseTermMonths(t) {
  const m = /(\d{1,2})/.exec(String(t == null ? '' : t));
  const n = m ? parseInt(m[1], 10) : 0;
  return n >= 1 && n <= 36 ? n : 12;
}

// The portal's program label "Fix & Flip w/ Construction" contains the word
// "construction", which the frozen engine's normStrategy() classifies as
// GROUND-UP — silently pricing every standard fix & flip on the wrong matrix
// (wrong tiers, wrong FICO minimums, wrong leverage). Normalize portal labels
// to the Term Sheet Studio's own strategy labels before they reach the
// engines; unknown labels pass through untouched.
function engineStrategy(s) {
  const x = clean(s).toLowerCase();
  if (!x || x.indexOf('not sure') > -1) return 'Fix & Flip';
  if (x.indexOf('bridge') > -1 || x.indexOf('stabil') > -1) return 'Bridge / Stabilized';
  if (x.indexOf('ground') > -1) return 'Ground-up Construction';
  if (x.indexOf('hold') > -1 || x.indexOf('brrrr') > -1) return 'Fix & Hold (BRRRR)';
  if (x.indexOf('flip') > -1) return 'Fix & Flip';
  return clean(s);
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
    strategy: engineStrategy(clean(app.program) || clean(app.loan_type)),
    state: clean(addr.state).toUpperCase(),
    city: clean(addr.city),
    address: clean(addr.line1 || addr.address || ''),
    propertyType: clean(app.property_type),
    units: num(app.units) || 0,
    purchasePrice: totalPrice,
    sellerPrice,
    isAssignment,
    // An empty as-is value defaults to the FINAL purchase price — leaving it
    // blank on the application means "worth what I'm paying for it". Applies
    // everywhere these inputs flow (quotes, registrations, the studio prefill).
    asIsValue: num(app.as_is_value) || totalPrice,
    // Display metadata only (engines ignore it): marks the value above as the
    // auto-default rather than an entered figure, so the studio prefill and the
    // registered-product panel never present it as if the borrower typed it.
    asIsDefaulted: !(num(app.as_is_value) > 0),
    arv: num(app.arv),
    rehabBudget: num(app.rehab_budget),
    fico: num(app.fico),
    expFlips: experience ? num(experience.flips) : 0,
    expHolds: experience ? num(experience.holds) : 0,
    expGround: experience ? num(experience.ground) : 0,
    term: parseTermMonths(app.term),
    irMonths: num(app.requested_ir_months),
    // Interest reserve as an exact dollar amount — an alternative to months
    // (owner-directed 2026-07-12). When > 0 the engines use it directly as the
    // desired reserve; 0/absent falls back to the months path (no change).
    irAmount: num(app.requested_ir_amount),
    heavyRehab: /heavy|gut|ground/i.test(clean(app.rehab_type)),
    sqftAddition: /square|sf|addition|ground/i.test(clean(app.rehab_type)) || num(app.sqft_post) > num(app.sqft_pre),
    targetLTC: 0,
    // Sticky per-file markup (#101): once a file is registered with a per-file
    // markup override it is persisted on the application (db/109) and re-applied to
    // EVERY subsequent quote — staff live, borrower live, AND borrower register — so
    // a borrower can never reprice below the markup the file was structured at. A
    // live STAFF override (in `overrides`) still supersedes it below (staff has
    // authority); the borrower path never sends a markup, so the sticky value fully
    // governs their pricing. NULL/absent → falls through to the company default →
    // engine, exactly as before (unregistered / no-override files are unchanged).
    ...(app.file_markup_std_pct  != null ? { markupStdPct:  num(app.file_markup_std_pct) }  : {}),
    ...(app.file_markup_gold_pct != null ? { markupGoldPct: num(app.file_markup_gold_pct) } : {}),
  };

  // Staff overrides win. Only copy known keys; coerce numeric fields.
  const NUMK = ['units', 'purchasePrice', 'sellerPrice', 'asIsValue', 'arv', 'rehabBudget',
    'fico', 'expFlips', 'expHolds', 'expGround', 'term', 'irMonths', 'irAmount', 'targetLTC',
    'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
    'markupStdPct', 'markupGoldPct', 'origStdPct', 'origGoldPct',
    'lenderFee', 'creditFee', 'appraisalFee', 'titleFee',
    'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice'];
  const STRK = ['loanType', 'strategy', 'state', 'city', 'address', 'propertyType'];
  const BOOLK = ['cashOut', 'isAssignment', 'heavyRehab', 'sqftAddition', 'forcePrice', 'manualPricing'];
  const out = Object.assign({}, base);
  if (overrides && typeof overrides === 'object') {
    for (const k of NUMK) if (overrides[k] != null && overrides[k] !== '') out[k] = num(overrides[k]);
    for (const k of STRK) if (overrides[k] != null) out[k] = clean(overrides[k]);
    for (const k of BOOLK) if (overrides[k] != null) out[k] = !!overrides[k];
    if (overrides.asIsValue != null && overrides.asIsValue !== '') out.asIsDefaulted = false;
    // Present-but-EMPTY means "clear it" (owner-reported 2026-07-16: a field the
    // user blanked in the studio must never silently revert to the previously-
    // saved value on re-register): markup '' → drop the sticky file markup so
    // the company default governs; irMonths '' → 0 (no reserve requested) —
    // mirroring irAmount's existing blank-sends-0 contract.
    if (overrides.markupStdPct === '') delete out.markupStdPct;
    if (overrides.markupGoldPct === '') delete out.markupGoldPct;
    if (overrides.irMonths === '') out.irMonths = 0;
  }
  out.strategy = engineStrategy(out.strategy);   // override labels get the same normalization
  if (out.manualPricing) {
    out.forcePrice = true;
    if (Object.prototype.hasOwnProperty.call(out, 'ovrAcqLTVPct')) out.ovrAcqLTV = num(out.ovrAcqLTVPct) / 100;
    if (Object.prototype.hasOwnProperty.call(out, 'ovrARLTVPct')) out.ovrARLTV = num(out.ovrARLTVPct) / 100;
    if (Object.prototype.hasOwnProperty.call(out, 'ovrLTCPct')) out.ovrLTC = num(out.ovrLTCPct) / 100;
    if (Object.prototype.hasOwnProperty.call(out, 'ovrRatePct')) out.ovrRate = num(out.ovrRatePct) / 100;
    if (Object.prototype.hasOwnProperty.call(out, 'ovrIrMonths')) out.irMonths = num(out.ovrIrMonths);
  }
  return out;
}

function hasInput(input, key) {
  return input && Object.prototype.hasOwnProperty.call(input, key) && input[key] != null && input[key] !== '';
}
function numberOverride(input, key, fallback) {
  return hasInput(input, key) ? num(input[key]) : fallback;
}
function percentOverride(input, key, fallbackFraction) {
  return hasInput(input, key) ? num(input[key]) / 100 : fallbackFraction;
}
function markupOverride(input, program) {
  const key = program === 'gold' ? 'markupGoldPct' : 'markupStdPct';
  return hasInput(input, key) ? num(input[key]) / 100 : null;
}
function setEngineMarkup(program, value) {
  const engine = program === 'gold' ? GSP : YSP;
  if (engine && typeof engine.setMarkup === 'function') engine.setMarkup(value);
}

/* ---- normalize an engine result into one UI-agnostic quote shape ---- */
function normalize(program, input, ev, ladder) {
  const s = ev.sizing || {};
  const cd = pricingSettings.current();   // company-wide defaults (or literals)
  // Origination default: per-file override → COMPANY default → engine constant.
  const engineOrigPct = (program === 'gold' ? (GSP.constants && GSP.constants.ORIG_PCT) : (YSP.constants && YSP.constants.ORIG_PCT)) || 0.0125;
  const companyOrigPct = program === 'gold' ? cd.origGoldPct : cd.origStdPct;
  const defaultOrigPct = (companyOrigPct != null ? companyOrigPct / 100 : engineOrigPct);
  const origPct = percentOverride(input, program === 'gold' ? 'origGoldPct' : 'origStdPct', defaultOrigPct);
  // Rounding policy (owner-directed 2026-07-09): the financed loan is reported in
  // WHOLE DOLLARS, floored DOWN — never lend more than the engine sized. The
  // reported breakdown must reconcile EXACTLY (initial advance + holdback +
  // financed reserve === total loan), so the initial and holdback are floored too
  // and the financed reserve absorbs the reconciling residual (when a reserve is
  // present; otherwise the initial advance absorbs it, so no phantom reserve
  // appears on a no-reserve deal). This mirrors the LOS, which floors both the
  // loan amount AND the initial. The engine's sizing math itself is unchanged —
  // this only floors/reconciles the reported figures.
  const totalLoan = Math.floor(num(s.totalLoan));
  const rehabHoldback = Math.floor(num(s.rehabLoan));
  let initialAdvance = Math.floor(num(s.acquisition));
  let financedReserve = 0;
  if (num(s.financedIR) > 0.5) financedReserve = Math.max(0, totalLoan - initialAdvance - rehabHoldback);
  else initialAdvance = Math.max(0, totalLoan - rehabHoldback);
  const state = clean(input.state).toUpperCase();
  const title = YSTitle.estimate(state, totalLoan, input.loanType);
  const titleAutoTotal = num(title.total);
  // Title: per-file override → COMPANY flat title (if set) → per-state estimate.
  const titleOverridden = hasInput(input, 'titleFee');
  const titleTotal = titleOverridden ? num(input.titleFee)
    : (cd.titleFee != null ? num(cd.titleFee) : titleAutoTotal);
  // Flat fees: per-file override → COMPANY default → hardcoded literal.
  const lenderFee = numberOverride(input, 'lenderFee', cd.lenderFee != null ? cd.lenderFee : FEES.lender);
  const creditFee = numberOverride(input, 'creditFee', cd.creditFee != null ? cd.creditFee : FEES.credit);
  const appraisalFee = numberOverride(input, 'appraisalFee', cd.appraisalFee != null ? cd.appraisalFee : FEES.appraisal);
  const origination = totalLoan > 0 ? round2(totalLoan * origPct) : 0;
  const assignmentExcess = num(s.assignmentExcessOOP) || num(ev.assignment && ev.assignment.excessOOP);
  const closingDueAtClose = round2(origination + lenderFee + creditFee + titleTotal);
  const cashToClose = round2(num(s.downPayment) + assignmentExcess + closingDueAtClose);
  let reserveRequirement = 0;
  let reserveBasis = '';
  let reserveMo = 0;
  let liquidityPct = null;
  if (totalLoan > 0) {
    if (program === 'gold') {
      liquidityPct = num(ev.liquidityPct) || 0.05;
      reserveRequirement = round2(totalLoan * liquidityPct);
      reserveBasis = `${(liquidityPct * 100).toFixed(1)}% of loan amount`;
    } else {
      reserveMo = reserveMonths(totalLoan);
      reserveRequirement = round2(num(s.fullPayment) * reserveMo);
      reserveBasis = `${reserveMo} months of full-payment interest reserves`;
    }
  }
  const liquidityRequired = round2(cashToClose + reserveRequirement);
  const caps = ev.caps ? {
    maxLoan: num(ev.caps.maxLoan),
    minFico: num(ev.caps.minFico),
    maxAcqLtv: num(ev.caps.maxAcqLTV),
    maxArvLtv: num(ev.caps.maxARLTV),
    maxLtc: num(ev.caps.maxLTC),
  } : null;

  const quote = {
    program,
    programLabel: PROGRAM_LABEL[program],
    productLabel: ev.productLabel || null,
    kind: ev.kind || null,
    reserveEligible: ev.reserveEligible !== false,
    status: ev.status,
    eligible: ev.status !== 'INELIGIBLE',
    reasons: (ev.reasons || []).map((r) => ({ level: r.level, msg: r.msg })),
    tier: ev.tier || null,
    tierLabel: ev.tierLabel || null,
    noteRate: ev.noteRate != null ? ev.noteRate : null,
    origPct,
    origination,
    sizing: {
      totalLoan,
      initialAdvance,
      rehabHoldback,
      financedReserve,
      downPayment: num(s.downPayment),
      assignmentExcessOOP: assignmentExcess,
      initialPayment: num(s.initialPayment),
      monthlyPayment: num(s.fullPayment),
      ltcPct: num(s.ltcPct),
      acqLtvPct: num(s.acqLtvPct),
      arvPct: num(s.arvPct),
      maxReserve: num(s.maxReserve),
      costBasis: num(s.costBasis),
      binding: s.binding || '',
    },
    title: { total: titleTotal, premium: num(title.premium), fees: num(title.fees), known: !!title.known,
      autoTotal: titleAutoTotal, overridden: titleOverridden },
    closingCosts: {
      origination,
      lenderFee,
      creditFee,
      titleAndSettlement: titleTotal,
      dueAtClosing: closingDueAtClose,
      appraisalPoc: appraisalFee,
      totalIncludingPoc: round2(closingDueAtClose + appraisalFee),
    },
    cashToClose,
    reserveRequirement,
    reserveMonths: reserveMo,
    reserveBasis,
    liquidityPct,
    liquidityRequired,
    assignment: ev.assignment || null,
    ladder: ladder || null,
    liquidity: liquidityRequired,
    guidelines: {
      caps,
      tierLabel: ev.tierLabel || null,
      binding: (s && s.binding) || '',
      reserveRequirement,
      reserveMonths: reserveMo,
      reserveBasis,
      liquidityPct,
      drawFee: num(ev.drawFee),
      irRequired: !!ev.irRequired,
      irLocked: !!ev.irLocked,
      reserveCapped: !!s.reserveCapped,
      reserveCapBy: s.reserveCapBy || '',
      maxReserveMonths: num(s.maxReserveMonths),
      heavyRehab: !!ev.heavy,
      sqftAddition: !!ev.sqft,
    },
    adminPricing: {
      markupPct: hasInput(input, program === 'gold' ? 'markupGoldPct' : 'markupStdPct')
        ? num(input[program === 'gold' ? 'markupGoldPct' : 'markupStdPct']) : null,
      origPct: origPct * 100,
      lenderFee,
      creditFee,
      appraisalFee,
      titleFee: titleOverridden ? titleTotal : null,
      manualPricing: !!input.forcePrice,
    },
  };
  return quote;
}

/* ---- quote one program (no persistence) ---- */
function quoteProgram(program, input) {
  if (!enginesReady()) throw new Error('pricing engines unavailable' + (loadErr ? ': ' + loadErr : ''));
  // Markup: per-file override → COMPANY default → engine's built-in markup.
  // Applied through the SAME frozen setMarkup hook and reset in finally — the
  // engine math is never changed, only which markup input it runs with.
  let m = markupOverride(input, program);
  if (m == null) {
    const cd = pricingSettings.current();
    const companyMarkup = program === 'gold' ? cd.markupGoldPct : cd.markupStdPct;
    if (companyMarkup != null) m = num(companyMarkup) / 100;
  }
  if (m != null) setEngineMarkup(program, m);
  if (program === 'gold') {
    try {
      const ev = GSP.evaluate(input);
      if (input.forcePrice && ev.status === 'INELIGIBLE') { ev.status = 'MANUAL'; ev.exitShortfall = 0; }
      return normalize('gold', input, ev, null);
    } finally {
      if (m != null) setEngineMarkup(program, null);
    }
  }
  try {
    const ev = YSP.evaluate(input);
    if (input.forcePrice && ev.status === 'INELIGIBLE') { ev.status = 'MANUAL'; ev.exitShortfall = 0; }
    let ladder = null;
    try {
      const pl = YSP.priceLadder(input);
      if (pl && pl.eligible && pl.rows && pl.rows.length) {
        ladder = { maxLtc: pl.maxLtc, maxBucket: pl.maxBucket, binding: pl.binding, rows: pl.rows };
      }
    } catch (_) { /* ladder is best-effort */ }
    return normalize('standard', input, ev, ladder);
  } finally {
    if (m != null) setEngineMarkup(program, null);
  }
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

// Optimistic-concurrency fingerprint of the FILE-owned pricing basis. GET
// /pricing hands it to the studio; register refuses (409) when the file's
// economics moved in between — so a stale studio session (long-open tab, old
// autosave, an edit that landed from the form/ClickUp while the sheet was open)
// can never silently re-register OLD economics and write them back onto the
// file (root-caused 2026-07-17: LO re-registers were clobbering later file
// edits with the previously-registered scenario). Only file-owned inputs that
// buildInputs reads participate — registration itself rewrites several of them,
// so a fresh GET is required after every register (the panel already reloads).
function econVersionFor(app) {
  const crypto = require('crypto');
  const f = (v) => {
    if (v == null || v === '') return '';
    if (typeof v === 'boolean') return v ? '1' : '0';
    const n = Number(v);
    return isFinite(n) && String(v).trim() !== '' && /^-?[\d.]+$/.test(String(v).trim()) ? String(n) : String(v).trim().toLowerCase();
  };
  const basis = [
    app.purchase_price, app.as_is_value, app.arv, app.rehab_budget,
    app.term, app.requested_ir_months, app.requested_ir_amount,
    app.requested_exp_flips, app.requested_exp_holds, app.requested_exp_ground,
    app.is_assignment, app.underlying_contract_price, app.assignment_fee,
    app.program, app.loan_type, app.property_type, app.units,
    // Also file-owned pricing inputs buildInputs reads (audit 2026-07-17):
    // rehab scope, sqft addition, the property STATE (title cost/eligibility),
    // the file's pricing FICO (computed onto f.app by loadFileForPricing), and
    // the sticky per-file markups.
    app.rehab_type, app.sqft_pre, app.sqft_post,
    (app.property_address && app.property_address.state) || '',
    app.fico, app.file_markup_std_pct, app.file_markup_gold_pct,
  ].map(f).join('|');
  return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 16);
}

module.exports = {
  enginesReady, loadErr: () => loadErr,
  buildInputs, quoteProgram, quoteAll, parseTermMonths, PROGRAM_LABEL,
  econVersionFor,
};
