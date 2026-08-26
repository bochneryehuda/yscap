import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { moneyNum } from '../lib/money.js';

/* The REAL static Term Sheet Studio (web/tools/term-sheet.html) embedded in
   the portal through a same-origin iframe. The static page and its frozen
   engines are never modified — the portal only prefills its inputs
   (YS.applyState), hides the marketing chrome, reads the exact computed
   results back out (window.TS._calc / _calcGold, exposed by termsheet.js),
   and captures the exact jsPDF term sheet by intercepting doc.save() so the
   identical document can be attached to the loan file. Every guideline,
   limitation, note and number the borrower sees is the static tool's own. */

// WHO IS DRIVING THIS TOOL — one definition, shared with the Investor Suite.
import { stampToolOfficer } from '../lib/toolOfficer.js';

const STUDIO_URL = '/tools/term-sheet.html';

// Marketing chrome that has no place inside the portal. Everything else —
// the full form, program cards, leverage slider, eligibility, structure,
// fees, cash to close, liquidity, compliance text — renders untouched.
const HIDE_CSS = `
  .topbar, .tool-bar, .tool-hero, .suite-footer, #leadCapture, #handoff,
  #floatActions, #applyModal, .fill-hint { display: none !important; }
  body { padding-top: 0 !important; }
  /* height:auto so scrollHeight reflects CONTENT, not the iframe viewport —
     otherwise the auto-resize below reads its own height back (+24px) every
     tick and the frame grows forever, pushing the Register button away. */
  html, body { height: auto !important; min-height: 0 !important; }
`;
// Borrowers never see the studio's admin pricing zone; staff keep it (and get
// it pre-unlocked) so markups, origination and fee overrides work exactly as
// they do on the marketing tool.
//
// TWO different "not visible", and the difference matters. For STAFF the zone is
// merely HIDDEN — deliberately, so every admin value stays live in the (hidden)
// inputs and locking admin mode never resets the pricing, exactly how the static
// tool behaves. On a screen where the viewer can NEVER be admin (`adminCapable`
// false — the borrower's own pricing studio) hiding is not enough: the markup and
// origination inputs are still sitting in the DOM, one deleted style rule away
// from being read and edited. There the zone is REMOVED outright. Pricing is
// unaffected either way — the tool's `adminNum(id, dflt)` falls back to the same
// company defaults when a field is absent, which is what it already does before
// the fields are seeded.
const HIDE_ADMIN_CSS = `.ts-admin-zone { display: none !important; }`;

/* ---- shared field mapping: portal loan data <-> studio input ids ---- */

export function studioDealPurpose(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t.includes('cash')) return 'Cash-out refinance';
  if (t.includes('refi')) return 'Rate & term refinance';
  return 'Purchase';
}
export function portalLoanType(dealPurpose) {
  const t = String(dealPurpose || '').toLowerCase();
  if (t.includes('cash')) return 'Refinance — Cash-Out';
  if (t.includes('refinance')) return 'Refinance — Rate & Term';
  return 'Purchase';
}
export function studioDealType(program) {
  const p = String(program || '').toLowerCase();
  if (p.includes('bridge') || p.includes('stabil')) return 'Bridge / Stabilized';
  if (p.includes('ground')) return 'Ground-up Construction';
  if (p.includes('hold') || p.includes('brrrr')) return 'Fix & Hold (BRRRR)';
  return 'Fix & Flip';
}
export function portalProgram(dealType) {
  const t = String(dealType || '').toLowerCase();
  if (t.includes('bridge') || t.includes('stabil')) return 'Bridge';
  if (t.includes('ground')) return 'Ground-Up Construction';
  if (t.includes('hold') || t.includes('brrrr')) return 'Fix & Hold (BRRRR)';
  return 'Fix & Flip w/ Construction';
}

/* The rehab TYPE a studio scenario describes, in the loan application's own
   words (its REHAB_TYPES options, which are also the ClickUp Rehab Type
   crosswalk keys). The studio expresses the scope as a two-option scope select
   plus an "adding square footage" checkbox; this is the single place that turns
   those into the label the file stores, so the application form and the
   scenario→draft path can't drift apart. Mirrors the server's
   rehabTypeFromInputs (src/lib/product-registration.js), which writes the same
   label on register. '' = the scenario has no rehab scope to state (a bridge
   deal, or a renovation with no rehab money). */
export function rehabTypeFromStudio(f) {
  f = f || {};
  const dealType = String(f.dealType || '');
  if (/ground/i.test(dealType)) return 'Ground-up construction';
  if (/bridge|stabil/i.test(dealType)) return '';
  if (f.sqft) return 'Adding square footage';
  if (f.rehabScope === 'heavy') return 'Heavy / gut rehab';
  if (!(Number(String(f.construction == null ? '' : f.construction).replace(/[$,\s]/g, '')) > 0)) return '';
  return 'Moderate';                       // the studio's "Light / moderate rehab"
}

/* The rehab type to WRITE onto a form/draft that already has one, or null for
   "leave it alone". Same rule as the server: the label is lossy (Cosmetic and
   Moderate both price as a light rehab), so a borrower's more specific choice is
   only replaced when the studio's scope genuinely differs. */
export function rehabTypePatch(fields, currentLabel) {
  const next = rehabTypeFromStudio(fields);
  if (!next) return null;
  const cur = String(currentLabel || '').trim();
  if (!cur) return next;
  const scope = (s) => `${/heavy|gut|ground/i.test(s)}|${/square|sf|addition|ground/i.test(s)}`;
  return scope(cur) === scope(next) ? null : next;
}

const rawNum = (v) => {
  if (v == null || v === '') return '';
  const n = Number(String(v).replace(/[$,%\s,]/g, ''));
  return isFinite(n) ? String(n) : '';
};
const termDigits = (t) => {
  const m = /(\d{1,2})/.exec(String(t == null ? '' : t));
  return m ? m[1] : '12';
};

/* Build the YS.applyState payload the studio understands from portal loan
   data (an application draft or an applications row — caller normalizes). */
export function buildStudioState(x) {
  const isAssign = !!x.isAssignment && rawNum(x.underlyingContractPrice) !== '';
  const price = rawNum(x.purchasePrice) ||
    (isAssign ? String((Number(rawNum(x.underlyingContractPrice)) || 0) + (Number(rawNum(x.assignmentFee)) || 0)) : '');
  // A blank/defaulted as-is value stays BLANK in the studio: the engines already
  // price a blank as-is as "worth the purchase price", and materializing the
  // default here displayed (and re-registered) it as if the borrower entered it —
  // which also froze it against later purchase-price changes (owner audit 2026-07-17).
  const asIs = x.asIsDefaulted ? '' : rawNum(x.asIsValue);
  const v = {
    entityName: x.entityName || '',
    borrowerName: x.borrowerName || '',
    coBorrowerName: x.coBorrowerName || '',
    propAddr: x.address || '',
    dealPurpose: studioDealPurpose(x.loanType),
    dealType: studioDealType(x.program),
    propState: String(x.state || '').toUpperCase(),
    propType: /2.?4/.test(String(x.propertyType || '')) || Number(x.units) > 1 ? '2-4' : 'sfr',
    price,
    origPrice: isAssign ? rawNum(x.underlyingContractPrice) : '',
    asIs,
    arv: rawNum(x.arv),
    construction: rawNum(x.rehabBudget),
    // The rehab scope, from the caller's EXPLICIT flag when it has one (a
    // registered scenario carries both engine booleans) and otherwise read off
    // the file's rehab-type label. See the sqft note below for why the explicit
    // flags exist at all.
    rehabScope: (x.heavyRehab != null ? !!x.heavyRehab : /heavy|gut/i.test(String(x.rehabType || ''))) ? 'heavy' : 'light',
    fico: rawNum(x.fico),
    expFlips: rawNum(x.expFlips) || '0',
    expBrrrr: rawNum(x.expHolds) || '0',
    expGround: rawNum(x.expGround) || '0',
    tsTerm: termDigits(x.termMonths || x.term),
    irMonths: rawNum(x.irMonths) || '',
    irAmount: rawNum(x.irAmount) || '',
    // Term-sheet options (owner-directed 2026-07-22): carry the file's estimated
    // closing date into the studio so it shows and re-registers without wiping.
    estClosingDate: (x.estClosingDate && /^\d{4}-\d{2}-\d{2}/.test(String(x.estClosingDate))) ? String(x.estClosingDate).slice(0, 10) : '',
    // The refinance payoff, and WHO holds it (owner-directed 2026-07-31). The
    // studio ids are `payoff` / `payoffLender` / `payoffLoanNo`; carrying them
    // both ways is what stops the number being retyped — and a retype is where
    // the file quietly stops agreeing with the term sheet the borrower was shown.
    payoff: rawNum(x.payoffAmount) || '',
    payoffLender: String(x.payoffLender || ''),
    payoffLoanNo: String(x.payoffLoanNumber || ''),
    // The payoff good-through date + the free-and-clear flag (db/575) — same
    // read-only file-fed shape; the sheet prints them, never prices on them.
    payoffGoodThrough: (x.payoffGoodThrough && /^\d{4}-\d{2}-\d{2}/.test(String(x.payoffGoodThrough))) ? String(x.payoffGoodThrough).slice(0, 10) : '',
    freeAndClear: x.propertyFreeAndClear === true ? '1' : '',
    /* The TYPED cash-out override, carried both ways too (audit-found
       2026-07-31). Without it, an officer's typed figure printed on the PDF,
       never reached the loan file, and silently reverted to the structural
       number the next time the studio was opened — the term sheet the borrower
       was shown and the file would then quote different cash. */
    cashOutAmt: rawNum(x.estimatedCashOut) || '',
    // Co-borrower personal-guaranty waiver (owner-directed 2026-07-22): a READ-ONLY
    // flag set by an approved super-admin exception (applications.co_borrower_pg_waived).
    // It drives the term sheet's guaranty wording; it is never editable in the studio
    // and the server ignores any client value (it reads the real flag from the file).
    coBorrowerPgWaived: (x.coBorrowerPgWaived === true || x.coBorrowerPgWaived === 1 ||
      String(x.coBorrowerPgWaived).toLowerCase() === 'true' || String(x.coBorrowerPgWaived) === '1') ? 'true' : '',
    // 1% closing-cost buffer waiver (owner-authorized 2026-07-31): READ-ONLY flag
    // from applications.liquidity_buffer_waived — the studio only DISPLAYS the
    // liquidity with/without the buffer; the waiver is set by an admin on the
    // file (its own audited endpoint), never in the studio, and the server's
    // pricing ignores any client value (file-owned in buildInputs).
    liqBufferWaived: (x.liqBufferWaived === true || x.liqBufferWaived === 1 ||
      String(x.liqBufferWaived).toLowerCase() === 'true' || String(x.liqBufferWaived) === '1') ? 'true' : '',
    /* The file's own unit count and city, READ-ONLY (the same shape as
       coBorrowerPgWaived). The term sheet's property question is "1 unit" or "2-4
       units", which cannot tell a 3-family from a 4-family — and New York City taxes
       those at 2.175% and 2.80% of the same loan, a $3,750 difference on a $600,000
       loan. So the file hands the studio the real figures; without them the studio
       assumes 4 (never short) and says so on the panel. The city matters for the same
       reason — New York, Philadelphia, Pittsburgh and Yonkers each levy their own. */
    fileUnits: Number(x.units) > 0 ? String(Math.round(Number(x.units))) : '',
    fileCity: x.city ? String(x.city) : '',
  };
  const c = {
    isAssign,
    addrTBD: !x.address,
    // Mirror the server's buildInputs sq-ft-addition detection EXACTLY (rehab-type
    // keyword OR an actual footprint increase) — the prefill dropped the
    // sqft_post > sqft_pre signal, so a register lifted the 87.5% sq-ft LTC cap the
    // server's own quote applies and over-lent (audit #22).
    //
    // A REGISTERED scenario passes the two engine booleans through explicitly
    // (scenarioFromEngineInputs) instead of a single rehab-type label, because
    // the label can't hold both: a heavy rehab that ALSO expands the footprint
    // collapsed to "Heavy / gut rehab", which doesn't match the sq-ft keywords —
    // so reopening the studio silently unchecked the expansion box, lifted that
    // same 87.5% cap, and a re-register wrote the bigger loan onto the file
    // (the audit-#22 class again, via the reopen path).
    sqft: x.sqftAddition != null
      ? !!x.sqftAddition
      : /square|sf|addition|ground/i.test(String(x.rehabType || '')) || (Number(x.sqftPost) || 0) > (Number(x.sqftPre) || 0),
  };
  return { v, c };
}

/* Everything the studio currently shows, read straight out of the static
   page: the raw inputs (by element id), the chosen program, and the exact
   calc objects the static tool renders + exports from.

   EXPORTED (owner-directed 2026-08-06) so the Investor Suite's "Create loan
   file →" can read its own term-sheet iframe with the SAME function this
   component uses. That hand-off has to carry the elected program and the admin
   pricing knobs onto the new file, and the alternatives were both worse: the
   plain `YS.collectState()` drops every `data-noshare` admin field (the markup)
   AND has no idea which program card is active, and re-deriving any of it in
   the Suite would be a second reading of the studio that could disagree with
   this one. One reader, one answer. */
export function readSnapshot(win) {
  const doc = win.document;
  const val = (id) => { const e = doc.getElementById(id); return e ? String(e.value).trim() : ''; };
  // #143 — the dollar inputs DISPLAY comma-grouped ("400,000"); every money field
  // captured here flows to the server (overridesFromSnapshot → the register/quote),
  // so strip the separators so the server never sees a comma (its own num() also
  // strips defensively — belt and suspenders). Non-money fields (names/addresses)
  // keep val() untouched, since a comma can be meaningful there ("Smith, LLC").
  const moneyVal = (id) => val(id).replace(/,/g, '');
  // Interest reserve months<->amount is ONE value shown two ways (owner-directed
  // 2026-07-20). The field the user did NOT drive is a DERIVED mirror (data-derived="1")
  // the tool fills for display only. The register/quote must send ONLY the source field,
  // exactly as the studio priced it — sending the mirror instead would resize the loan
  // off the rounded equivalent and diverge from the shown quote by a dollar or two. So a
  // derived field is harvested as blank.
  const derived = (id) => { const e = doc.getElementById(id); return !!(e && e.dataset && e.dataset.derived === '1'); };
  const srcVal = (id) => derived(id) ? '' : val(id);
  const chk = (id) => { const e = doc.getElementById(id); return !!(e && e.checked); };
  const active = (id) => { const e = doc.getElementById(id); return !!(e && e.classList.contains('pcard-active')); };
  const program = active('pcardGold') ? 'gold' : active('pcardSilver') ? 'silver'
    : active('pcardManual') ? 'manual' : active('pcardStd') ? 'standard' : null;
  const missBox = doc.getElementById('rMissing');
  const ready = !!missBox && missBox.style.display === 'none';
  const missing = missBox ? Array.from(missBox.querySelectorAll('li')).map((li) => li.textContent) : [];
  let std = null, gold = null, silver = null;
  try { std = win.TS._calc(); } catch (_) { /* engine not ready yet */ }
  try { gold = win.TS._calcGold(); } catch (_) { /* gold engine optional */ }
  try { silver = win.TS._calcSilver && win.TS._calcSilver(); } catch (_) { /* silver engine optional */ }
  const d = program === 'gold' && gold && !gold.unavailable ? gold
    : program === 'silver' && silver && !silver.unavailable ? silver : std;
  return {
    program, ready, missing, std, gold, silver, d,
    fields: {
      entityName: val('entityName'), borrowerName: val('borrowerName'), coBorrowerName: val('coBorrowerName'), propAddr: val('propAddr'), addrTBD: chk('addrTBD'),
      dealPurpose: val('dealPurpose'), dealType: val('dealType'),
      propState: val('propState'), propType: val('propType'),
      price: moneyVal('price'), isAssign: chk('isAssign'), origPrice: moneyVal('origPrice'),
      asIs: moneyVal('asIs'), arv: moneyVal('arv'), construction: moneyVal('construction'),
      rehabScope: val('rehabScope'), sqft: chk('sqft'),
      fico: val('fico'), expFlips: val('expFlips'), expBrrrr: val('expBrrrr'), expGround: val('expGround'),
      tsTerm: val('tsTerm'), irMonths: srcVal('irMonths'), irAmount: derived('irAmount') ? '' : moneyVal('irAmount'),
      tsEffPrice: moneyVal('tsEffPrice'),
      // Out-of-pocket rehab exception (owner-authorized 2026-07-31): the dollar box + the
      // "raise the initial to its max" toggle in the admin zone.
      tsOopRehab: moneyVal('tsOopRehab'), tsOopRehabMax: chk('tsOopRehabMax'),
      // A typed loan amount (owner-directed 2026-08-06) — the admin zone's exact-amount box.
      tsTargetLoan: moneyVal('tsTargetLoan'),
      tsLadderPick: val('tsLadderPick'),
      // admin pricing knobs (staff mode) — same names the staff pricing API takes
      tsYspStd: val('tsYspStd'), tsYspGold: val('tsYspGold'), tsYspSilver: val('tsYspSilver'),
      // Manual GOLD top-tier markup (item 15) — the studio's "manual section for the top tier".
      tsYspGoldT1: val('tsYspGoldT1'),
      tsOrigStd: val('tsOrigStd'), tsOrigGold: val('tsOrigGold'), tsOrigSilver: val('tsOrigSilver'),
      tsOrigManual: val('tsOrigManual'),
      tsFeeUW: moneyVal('tsFeeUW'), tsFeeCredit: moneyVal('tsFeeCredit'),
      /* OUR FEE'S TWO PARTS + the optional New York settlement agent fee (owner-directed
         2026-08-26). `tsFeeUW` above KEEPS its old meaning — the whole fee typed as ONE
         number — so a quote registered before the split restores and re-registers exactly
         as it always did; these are the new per-part boxes. */
      tsFeeUwPart: moneyVal('tsFeeUwPart'), tsFeeLegal: moneyVal('tsFeeLegal'),
      tsFeeSettlement: moneyVal('tsFeeSettlement'),
      tsFeeAppr: moneyVal('tsFeeAppr'), tsFeeTitle: moneyVal('tsFeeTitle'),
      tsFeasFee: moneyVal('tsFeasFee'),
      /* GOVERNMENT CHARGES — the manual section (owner-directed 2026-08-23). Each
         box is blank unless somebody typed in it; a typed figure overrides the
         automatic one for that ONE charge and leaves the rest calculated. The
         COUNTY is here because New York and Maryland set their mortgage /
         recordation tax by county — without it the estimate has to fall back to the
         state's highest known rate and say so. */
      tsTaxUnits: val('tsTaxUnits'), tsTaxCity: val('tsTaxCity'),
      tsTaxCounty: val('tsTaxCounty'), tsTaxBuyerShare: val('tsTaxBuyerShare'),
      tsTaxMortgage: moneyVal('tsTaxMortgage'), tsTaxIntangible: moneyVal('tsTaxIntangible'),
      tsTaxTransferState: moneyVal('tsTaxTransferState'), tsTaxTransferLocal: moneyVal('tsTaxTransferLocal'),
      tsTaxMansion: moneyVal('tsTaxMansion'),
      tsManualOn: chk('tsManualOn'),
      tsMLtv: val('tsMLtv'), tsMArv: val('tsMArv'), tsMLtc: val('tsMLtc'),
      tsMRate: val('tsMRate'), tsMIr: val('tsMIr'),
      // Term-sheet options (owner-directed 2026-07-22) — display/record only.
      estClosingDate: val('estClosingDate'),
      // The payoff and who it goes to, read back out so a register carries them.
      payoff: moneyVal('payoff'), payoffLender: val('payoffLender'), payoffLoanNo: val('payoffLoanNo'),
      cashOutAmt: moneyVal('cashOutAmt'),
      tsAccrual: val('tsAccrual'), tsDeferredOrig: val('tsDeferredOrig'),
      tsMinIntStd: chk('tsMinIntStd'), tsMinIntGold: chk('tsMinIntGold'), tsMinIntSilver: chk('tsMinIntSilver'), tsMinIntManual: chk('tsMinIntManual'),
    },
  };
}

/* Normalize a saved product_registrations.inputs row (frozen-engine input
   shape) back into the scenario shape buildStudioState() takes, so reopening
   the studio shows exactly the registered scenario. */
export function scenarioFromEngineInputs(inp, extra = {}) {
  inp = inp || {};
  return {
    loanType: inp.loanType === 'Refinance' ? (inp.cashOut ? 'Refinance — Cash-Out' : 'Refinance — Rate & Term') : 'Purchase',
    program: inp.strategy,
    state: inp.state,
    propertyType: inp.propertyType,
    units: inp.units,
    purchasePrice: inp.purchasePrice,
    isAssignment: !!inp.isAssignment,
    underlyingContractPrice: inp.sellerPrice,
    assignmentFee: inp.isAssignment && inp.purchasePrice && inp.sellerPrice
      ? Math.max(0, moneyNum(inp.purchasePrice) - moneyNum(inp.sellerPrice)) : '',
    asIsValue: inp.asIsValue,
    arv: inp.arv,
    rehabBudget: inp.rehabBudget,
    rehabType: inp.heavyRehab ? 'Heavy / gut rehab' : (inp.sqftAddition ? 'Adding square footage' : ''),
    // …and the two flags UNCOLLAPSED, so a scenario that is both heavy AND an
    // expansion reopens with both set (buildStudioState prefers these over the
    // single label above, which can only carry one of them).
    heavyRehab: !!inp.heavyRehab,
    sqftAddition: !!inp.sqftAddition,
    fico: inp.fico,
    expFlips: inp.expFlips, expHolds: inp.expHolds, expGround: inp.expGround,
    termMonths: inp.term, irMonths: inp.irMonths, irAmount: inp.irAmount,
    ...extra,
  };
}

/* Admin-knob values from saved engine inputs -> studio admin field ids, so a
   staff re-open restores the registered markups/fees too. */
export function adminStateFromEngineInputs(inp) {
  inp = inp || {};
  const v = {};
  const put = (id, val) => { if (val != null && val !== '') v[id] = String(val); };
  put('tsYspStd', inp.markupStdPct); put('tsYspGold', inp.markupGoldPct); put('tsYspSilver', inp.markupSilverPct);
  put('tsYspGoldT1', inp.markupGoldT1Pct);   // manual Gold top-tier markup (item 15)
  put('tsOrigStd', inp.origStdPct); put('tsOrigGold', inp.origGoldPct); put('tsOrigSilver', inp.origSilverPct);
  put('tsOrigManual', inp.origManualPct);
  put('tsFeeUW', inp.lenderFee); put('tsFeeCredit', inp.creditFee);
  put('tsFeeUwPart', inp.underwritingFee); put('tsFeeLegal', inp.legalFee);
  put('tsFeeSettlement', inp.settlementFee);
  put('tsFeeAppr', inp.appraisalFee); put('tsFeeTitle', inp.titleFee);
  put('tsFeasFee', inp.feasibilityFee);
  put('tsMLtv', inp.ovrAcqLTVPct); put('tsMArv', inp.ovrARLTVPct);
  put('tsMLtc', inp.ovrLTCPct); put('tsMRate', inp.ovrRatePct); put('tsMIr', inp.ovrIrMonths);
  put('tsOopRehab', inp.oopRehab);   // out-of-pocket rehab exception (owner-authorized 2026-07-31)
  // The typed loan amount, so reopening a file restores it. `put` keeps a 0 (it only
  // skips null/''), and a 0 here means "no amount" — restoring it would paint a zero
  // into a money box. Belt-and-suspenders with pricing.js no longer storing one.
  if (Number(inp.targetLoan) > 0) put('tsTargetLoan', inp.targetLoan);
  /* THE LADDER RUNG THE FILE WAS REGISTERED AT. It lives only in the studio's own
     module scope, which resets on every iframe load — so without this a reopened file
     showed the slider at MAXIMUM and the mandatory post-appraisal re-register
     (esign/gate.js requires one before a term sheet may issue) registered that
     maximum: a signed $1,794,000 at 8.500% came back as $2,070,000 at 9.125%.
     The value-side rung is named so the studio applies it on the RIGHT axis — two
     rungs can share an LTC, so a bare number could pick the wrong one. */
  if (Number(inp.targetARLTV) > 0) put('tsLadderPick', 'arv:' + Number(inp.targetARLTV));
  else if (Number(inp.targetLTC) > 0) put('tsLadderPick', 'ltc:' + Number(inp.targetLTC));
  // Re-arm the manual-scenario toggle whenever ANY manual override value was
  // registered — not only when inp.manualPricing is set. Otherwise reopening a
  // manually-priced file restores the rate VALUE into the (hidden) field but leaves
  // the toggle off, so the studio ignores it and a re-register silently reverts to
  // the AUTO rate (the "typed 10.25, file shows 10.3" report — 10.3 is the auto
  // rate). Older/other-path registrations that stored the override without the flag
  // are covered too. The server (buildInputs) honors a present override regardless.
  const hasManualOverride = ['ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths']
    .some((k) => inp[k] != null && inp[k] !== '');
  const c = {};
  if (inp.manualPricing || hasManualOverride) c.tsManualOn = true;
  if (inp.oopRehabMax) c.tsOopRehabMax = true;   // re-arm the "raise initial to max" toggle
  return { v, c };
}

/* A compact, human-readable copy of the priced structure — stored on the
   draft/file as the placeholders for every detail from the static studio. */
export function selectionFromSnapshot(snap) {
  const d = snap.d || {};
  return {
    source: 'term-sheet-studio',
    selectedAt: new Date().toISOString(),
    program: snap.program,
    programLabel: snap.program === 'gold' ? 'Gold Standard Program' : snap.program === 'silver' ? 'Silver Program' : snap.program === 'manual' ? 'Manual Program' : 'Standard Program',
    strategy: snap.fields.dealType,
    purpose: snap.fields.dealPurpose,
    status: d.status || null,
    tierLabel: d.tierLabel || null,
    totalLoan: d.totalLoan || 0,
    noteRatePct: d.rate || 0,
    termMonths: d.term || null,
    irMonths: d.irMonths || 0,
    irAmount: d.irAmount || 0,
    initialAdvance: d.initialAdvance || 0,
    rehabHoldback: d.rehabHoldback || 0,
    financedInterestReserve: d.financedIR || 0,
    downPayment: d.downPayment || 0,
    originationFee: d.origFee || 0,
    originationPct: d.origPct != null ? d.origPct * 100 : null,
    lenderFee: d.lenderFee || 0,
    creditFee: d.creditFee || 0,
    appraisalFeePoc: d.apprFee || 0,
    titleEstimate: d.titleCost || 0,
    closingCosts: d.closing || 0,
    cashToClose: d.cashToClose || 0,
    reserveToShow: d.reserves || 0,
    liquidityToShow: d.liquidity || 0,
    ltcPct: d.ltcPct != null ? d.ltcPct * 100 : null,
    asIsLtvPct: d.ltvPct != null ? d.ltvPct * 100 : null,
    arvLtvPct: d.arvPct != null ? d.arvPct * 100 : null,
    binding: d.binding || '',
    targetLTC: (d.inp && d.inp.targetLTC) || null,
    // Silver's ladder steps on the VALUE side too, so the snapshot has to carry
    // whichever lever the chosen rung used — see overridesFromSnapshot.
    targetARLTV: (d.inp && d.inp.targetARLTV) || null,
  };
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const s = String(r.result); const i = s.indexOf(','); resolve(i >= 0 ? s.slice(i + 1) : s); };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* CAPTURE THE EXACT PDF THE STATIC TOOL WOULD DOWNLOAD, for any window hosting it.
   `doc.save()` is swapped for an `output('blob')` capture for the duration of the one
   export call and then restored in a `finally`, so a throw mid-export can never leave
   the tool unable to download normally. Returns `{blob, filename}` or null — null on
   every "not ready" path (no frame, no TS API, the PDF engine would not load), so a
   caller can say "give it a moment" instead of shipping an empty attachment.

   ONE DEFINITION, used by the studio component's `capturePdf()` ref method AND by the
   Investor Suite, which hosts the same tool through a bare StaticToolFrame. */
export async function capturePdfFromWindow(win) {
  if (!win || !win.TS) return null;
  if (!(win.jspdf && win.jspdf.jsPDF)) {
    try { await loadPdfEngine(win.document); } catch (_) { return null; }
  }
  if (!(win.jspdf && win.jspdf.jsPDF)) return null;
  const API = win.jspdf.jsPDF.API;
  const orig = API.save;
  let captured = null;
  API.save = function saveCapture(name) {
    try { captured = { blob: this.output('blob'), filename: String(name || 'YS_Term_Sheet.pdf') }; } catch (_) { /* fall through */ }
    return this;
  };
  try { await win.TS.exportPdf(null); } finally { API.save = orig; }
  return captured;
}

function loadPdfEngine(doc) {
  return new Promise((resolve, reject) => {
    const add = (src, onerr) => {
      const s = doc.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = onerr;
      doc.head.appendChild(s);
    };
    // Local vendored copy first (same-origin, instant); CDN as fallback.
    add('/tools/vendor/jspdf.umd.min.js',
      () => add('https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js',
        () => add('https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js', reject)));
  });
}

const TermSheetStudio = forwardRef(function TermSheetStudio({ prefill, lockedIds = [], onState, showAdmin = false, adminCapable = true, officer = null, issueHold = null, provenance = null, pricingDefaults = null }, ref) {
  const frameRef = useRef(null);
  const winRef = useRef(null);
  const adminStyleRef = useRef(null);   // the injected style hiding the admin zone
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const prefillRef = useRef(prefill);
  prefillRef.current = prefill;
  // Resolved TPO firm pricing (channel/firm markup + origination + the broker fee)
  // for a broker file — null off a TPO file. Pushed into the tool so a broker sheet
  // prices and prints exactly what its firm's settings register (owner-directed
  // 2026-08-06). A ref so the boot handler reads the latest without re-subscribing.
  const pricingDefaultsRef = useRef(pricingDefaults);
  pricingDefaultsRef.current = pricingDefaults;
  const [failed, setFailed] = useState(false);
  // Gate the iframe hidden until it is dark, de-chromed and prefilled — without
  // this the marketing page paints for ~1s in light theme with its full chrome
  // (the "wiped-off coloring" blink) before the embed styling is injected.
  const [loaded, setLoaded] = useState(false);

  // Strip the admin pricing zone out of the embedded document entirely. Used
  // only where the viewer can never be admin (see HIDE_ADMIN_CSS above); after
  // this there is nothing left to un-hide, which is the point.
  function stripAdminZone() {
    const win = winRef.current;
    if (!win) return;
    try {
      const zone = win.document.querySelector('.ts-admin-zone');
      if (zone && zone.remove) zone.remove();
    } catch (_) { /* best-effort; the CSS hide below is still in force */ }
  }

  // Show/hide the studio's admin pricing zone WITHOUT remounting the frame:
  // hiding keeps every admin value live in the (hidden) inputs — exactly how
  // the static tool behaves — so locking admin mode never resets the pricing.
  function applyAdminVisible(show) {
    const win = winRef.current;
    if (!win) return;
    // On a viewer-can-never-be-admin screen the zone is gone from the DOM, so a
    // stray show() must not be able to conjure it back.
    if (show && !adminCapable) return;
    try {
      const doc = win.document;
      if (show) {
        if (adminStyleRef.current) { adminStyleRef.current.remove(); adminStyleRef.current = null; }
        const panel = doc.getElementById('tsAdminPanel');
        const lock = doc.getElementById('tsAdminLock');
        const trig = doc.getElementById('tsAdminTrigger');
        if (panel) panel.hidden = false;
        if (lock) lock.hidden = true;
        if (trig) trig.hidden = true;
      } else if (!adminStyleRef.current) {
        const style = doc.createElement('style');
        style.textContent = HIDE_ADMIN_CSS;
        doc.head.appendChild(style);
        adminStyleRef.current = style;
      }
    } catch (_) { /* cosmetic only */ }
  }

  useImperativeHandle(ref, () => ({
    snapshot() {
      const win = winRef.current;
      if (!win || !win.TS) return null;
      try { return readSnapshot(win); } catch (_) { return null; }
    },
    // #103: the RAW input state the frozen tool round-trips through YS.applyState
    // — used by the borrower self-service Pricing screen to SAVE a scenario and
    // reopen it later. Distinct from snapshot() (the computed pricing result).
    readState() {
      const win = winRef.current;
      if (!win || !win.YS || typeof win.YS.readState !== 'function') return null;
      try { return win.YS.readState(); } catch (_) { return null; }
    },
    applyState(state) {
      const win = winRef.current;
      if (!win || !win.YS || typeof win.YS.applyState !== 'function' || !state) return false;
      try { win.YS.applyState(state); return true; } catch (_) { return false; }
    },
    setAdminVisible(show) { applyAdminVisible(show); },
    /* Bring the admin pricing zone into view. `container` is the scrolling
       ancestor (the studio sheet body) — falls back to the window. */
    scrollToAdmin(container) {
      const win = winRef.current, frame = frameRef.current;
      if (!win || !frame) return;
      try {
        const el = win.document.getElementById('tsAdminPanel') || win.document.querySelector('.ts-admin-zone');
        if (!el) return;
        const y = frame.getBoundingClientRect().top + el.getBoundingClientRect().top;
        if (container && typeof container.scrollBy === 'function') {
          container.scrollBy({ top: y - (container.getBoundingClientRect ? container.getBoundingClientRect().top : 0) - 80, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: y - 90, behavior: 'smooth' });
        }
      } catch (_) { /* scrolling is best-effort */ }
    },
    /* Set the INITIAL/FINAL provenance stamp RIGHT NOW, synchronously, and
       report whether it landed (owner-directed 2026-08-02). The `provenance`
       prop drives the same window flag through an effect, but a caller that has
       just learned the truth from the server — the register response says
       whether this file is ready to issue — must be able to stamp the sheet it
       is about to capture in the same tick, without waiting for a re-render.
       Returns false when the frame isn't up, so the caller can record the stamp
       it actually got rather than the one it asked for. */
    setProvenance(kind) {
      const win = winRef.current;
      if (!win) return false;
      try { win.TS_PROVENANCE = kind ? { kind } : null; return true; } catch (_) { return false; }
    },
    /* Push the resolved TPO firm pricing into the tool imperatively — belt-and-
       suspenders next to the boot handler + the prop effect, so a caller that has
       just loaded the firm settings can seed them in the same tick before it
       captures the sheet. No-op with no settings or before the frame is up. */
    setPricingDefaults(d) {
      const win = winRef.current;
      if (!win || !win.TS || typeof win.TS.setPricingDefaults !== 'function' || !d) return false;
      try { win.TS.setPricingDefaults(d); return true; } catch (_) { return false; }
    },
    /* Build the exact PDF the static tool downloads, but capture the bytes
       instead. The mechanics live in the exported `capturePdfFromWindow` so the
       Investor Suite — which hosts the same tool through a bare StaticToolFrame
       rather than this component — captures the sheet the SAME way, rather than
       growing a second copy of a save()-swapping trick. */
    async capturePdf() { return capturePdfFromWindow(winRef.current); },
  }), []);

  // Keep the tool's hold reason live: a resolved finding lifts the hold on the
  // next pricing reload without remounting the iframe.
  useEffect(() => {
    try { const w = winRef.current; if (w) w.TS_ISSUE_HOLD = issueHold || null; } catch (_) { /* advisory */ }
  }, [issueHold]);
  // Same for the provenance stamp (file → file_final when the gate clears).
  useEffect(() => {
    try { const w = winRef.current; if (w) w.TS_PROVENANCE = provenance ? { kind: provenance } : null; } catch (_) { /* cosmetic */ }
  }, [provenance]);
  // Push the resolved TPO firm pricing whenever it lands/changes (a pricing reload
  // on a TPO file). The tool's own boot fetch is overridden by this. No-op off a
  // TPO file (pricingDefaults null) or before the frame is up (the boot handler
  // covers the initial push).
  useEffect(() => {
    try {
      const w = winRef.current;
      if (w && w.TS && typeof w.TS.setPricingDefaults === 'function' && pricingDefaults) w.TS.setPricingDefaults(pricingDefaults);
    } catch (_) { /* best-effort */ }
  }, [pricingDefaults]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let poller = null;
    let disposed = false;

    // Safety net: never leave the studio permanently hidden. If the engines are
    // slow (or the ready-poll is still spinning), reveal the frame anyway after
    // a beat — earlyStamp has already made it light + de-chromed, so revealing it
    // shows the real tool loading, not the raw marketing page.
    const revealFallback = setTimeout(() => { if (!disposed) setLoaded(true); }, 2500);

    // Belt-and-braces: stamp the WHITE (light) theme + chrome-hiding CSS the
    // moment the frame's document exists (even mid-parse), so the FIRST paint is
    // already white and de-chromed — the fade-in below then reveals nothing
    // wrong. The portal is white-first now, so every embedded tool is light.
    let earlyStamp = null;
    let stamped = false;
    const stampEarly = () => {
      if (stamped || disposed) return;
      try {
        const doc = frame.contentWindow && frame.contentWindow.document;
        if (!doc || !doc.documentElement) return;
        // about:blank has no real URL yet; wait for the tool document.
        const href = frame.contentWindow.location && frame.contentWindow.location.href;
        if (!href || href === 'about:blank') return;
        doc.documentElement.setAttribute('data-theme', 'light');
        if (doc.head) {
          const s = doc.createElement('style');
          s.textContent = HIDE_CSS + '\n.ys-theme-toggle{display:none!important}\nhtml,body{background:#F4F0E7!important}';
          doc.head.appendChild(s);
        }
        stamped = true;
        if (earlyStamp) { clearInterval(earlyStamp); earlyStamp = null; }
      } catch (_) { /* cross-doc timing — try again next tick */ }
    };
    earlyStamp = setInterval(stampEarly, 30);
    stampEarly();

    // On failure, stop every timer (setFailed only re-renders — it does not
    // unmount, so the effect cleanup would not otherwise run) and surface the
    // error notice.
    const fail = () => {
      if (earlyStamp) { clearInterval(earlyStamp); earlyStamp = null; }
      clearTimeout(revealFallback);
      setFailed(true);
    };

    let booted = false;
    const boot = () => {
      if (booted || disposed) return;
      booted = true;
      let win;
      try { win = frame.contentWindow; if (!win || !win.document) throw new Error('no frame'); }
      catch (_) { fail(); return; }

      // termsheet.js wires itself on DOMContentLoaded, so TS/YS may land a
      // beat after the frame's load event — wait for both. (`win` is the
      // frame's WindowProxy, so it follows the about:blank → tool navigation.)
      let tries = 0;
      const ready = setInterval(() => {
        if (disposed) { clearInterval(ready); return; }
        tries += 1;
        if (!(win.TS && win.YS)) {
          if (tries > 100) { clearInterval(ready); fail(); }
          return;
        }
        clearInterval(ready);
        winRef.current = win;
        const doc = win.document;
        try {
          const style = doc.createElement('style');
          style.textContent = HIDE_CSS;
          doc.head.appendChild(style);
          // Match the white-first portal regardless of the visitor's saved
          // marketing-site theme; the embed hides the tool's own toggle.
          doc.documentElement.setAttribute('data-theme', 'light');
          const themeStyle = doc.createElement('style');
          themeStyle.textContent = '.ys-theme-toggle{display:none!important}html,body{background:#F4F0E7!important}';
          doc.head.appendChild(themeStyle);
        } catch (_) { /* cosmetic only */ }
        // Portal-authenticated staff (or an unlocked admin session) get the
        // pricing controls open; everyone else gets them hidden — togglable
        // later through the ref WITHOUT remounting (values persist hidden).
        applyAdminVisible(!!showAdmin);
        // Where the viewer can NEVER be admin, hidden is not good enough — take
        // the whole zone out of the document. The CSS hide above runs first and
        // stays as the fallback if the node can't be found.
        if (!adminCapable) stripAdminZone();
        // Loan-officer branding (owner-directed 2026-07-21): when this studio is
        // opened on a file with an ASSIGNED loan officer, publish the officer to
        // the tool's window.YSBRAND so the exported term-sheet PDF renders the LO
        // signature block with the /ts_lo_sig/ + /ts_lo_dt/ anchors DocuSign uses
        // to place the LO signer's tabs. No-op when no officer prop is given.
        try {
          if (officer && officer.name) {
            win.YSBRAND = Object.assign({}, officer, {
              code: officer.code || String(officer.email || officer.name || '').split('@')[0].toLowerCase(),
            });
          }
        } catch (_) { /* cosmetic — falls back to no LO block */ }
        /* NO ASSIGNED OFFICER IS NOT "NOBODY" — it is the person at the keyboard
           (owner-directed 2026-08-07: "if somebody is doing something from his login,
           it should always stay with his information, his name"). On a file WITH an
           assigned officer that officer wins and nothing changes: the term sheet is
           the file's, not the operator's. On an UNASSIGNED file the tool was
           completely anonymous, so anything it posted lost its owner to the lead
           round-robin exactly as the Investor Suite did. The stamp also declares the
           staff-portal origin unconditionally, which is what keeps the rotation out
           of the way even when the identity cannot be resolved (lib/toolOfficer.js).
           Fire-and-forget: it must never delay or block the studio. */
        stampToolOfficer(win, { keepExisting: !!(officer && officer.name) });
        // Term-sheet hold (owner-directed 2026-07-31): open fatal appraisal
        // findings hold generation — the tool's Download-PDF button refuses
        // with this reason (termsheet.js reads window.TS_ISSUE_HOLD). The
        // attach door is server-enforced; this stops the local download too.
        try { win.TS_ISSUE_HOLD = issueHold || null; } catch (_) { /* advisory */ }
        // Provenance stamp (owner-directed 2026-07-31): the host says HOW this
        // term sheet is being generated — borrower portal / active file /
        // final — and the PDF prints the matching stamp (termsheet.js
        // PROV_COPY). Absent → the tool self-derives (website/officer/portal).
        try { win.TS_PROVENANCE = provenance ? { kind: provenance } : null; } catch (_) { /* cosmetic */ }
        // TPO firm pricing (owner-directed 2026-08-06): seed the resolved firm
        // markup/origination + broker fee so a broker sheet prices what registers.
        // Wins over the tool's own /api/pricing-defaults boot fetch (the override
        // flag makes ordering irrelevant). No-op off a TPO file (null).
        try { if (pricingDefaultsRef.current && win.TS && typeof win.TS.setPricingDefaults === 'function') win.TS.setPricingDefaults(pricingDefaultsRef.current); } catch (_) { /* best-effort */ }
        try { if (prefillRef.current) win.YS.applyState(prefillRef.current); } catch (_) { /* keep defaults */ }
        for (const id of lockedIds) {
          const e = doc.getElementById(id);
          if (!e) continue;
          e.disabled = true;
          const wrap = e.closest && e.closest('.input');
          if (wrap) wrap.classList.add('is-ro');
        }
        // one input event on a wired field makes the studio recompute + render;
        // the manual-scenario checkbox needs its change handler to sync its
        // dependent fields' visibility after a prefill.
        try {
          const m = doc.getElementById('tsManualOn');
          if (m) m.dispatchEvent(new win.Event('change', { bubbles: true }));
          const f = doc.getElementById('fico');
          if (f) f.dispatchEvent(new win.Event('input', { bubbles: true }));
        } catch (_) { /* studio still renders on its own next input */ }

        // Everything above is applied — the frame is white, de-chromed and
        // prefilled — so it is now safe to fade it into view.
        if (earlyStamp) { clearInterval(earlyStamp); earlyStamp = null; }
        setLoaded(true);

        poller = setInterval(() => {
          if (disposed) return;
          try {
            // Fit the frame to the studio's CONTENT. Only move when the size
            // genuinely changed — resizing every tick fed the measurement back
            // into itself (scrollHeight tracks the viewport when content is
            // shorter), growing the frame ~24px per tick with an ever-larger
            // empty gap before the Register button.
            const want = Math.max(900, win.document.body.scrollHeight + 24);
            const have = parseInt(frame.style.height, 10) || 0;
            if (Math.abs(want - have) > 30) frame.style.height = want + 'px';
            if (onStateRef.current) onStateRef.current(readSnapshot(win));
          } catch (_) { /* frame navigated / torn down */ }
        }, 700);
      }, 100);
    };

    // Boot right away instead of waiting for the frame's full `load` event —
    // the internal TS/YS poll already waits for the engines, and a stalled
    // third-party resource (fonts CDN) used to keep `load` from ever firing.
    boot();
    return () => {
      disposed = true;
      clearTimeout(revealFallback);
      if (poller) clearInterval(poller);
      if (earlyStamp) clearInterval(earlyStamp);
      winRef.current = null;
    };
    // mount-once: the frame prefill/lock/admin setup applies to the initial props
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (failed) {
    return (
      <div role="alert" className="notice err">
        The Term Sheet Studio could not be loaded. Refresh the page, or continue and your loan
        team will price the file with you.
      </div>
    );
  }
  return (
    <div className="toolframe" style={{ position: 'relative', minHeight: 900 }}>
      {!loaded && (
        <div className="toolframe-loading" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
          <span>Loading the Term Sheet Studio…</span>
        </div>
      )}
      <iframe ref={frameRef} src={STUDIO_URL} title="YS Term Sheet Studio"
        style={{ width: '100%', border: 0, display: 'block', minHeight: 900, background: 'transparent',
          opacity: loaded ? 1 : 0, transition: 'opacity .2s ease' }} />
    </div>
  );
});

export default TermSheetStudio;
