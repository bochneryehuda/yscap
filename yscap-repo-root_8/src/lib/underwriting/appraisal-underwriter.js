'use strict';
/**
 * R6.8 — Appraisal underwriter (deterministic core).
 *
 * The MISMO parser (src/lib/appraisal) already extracts a rich appraisal into the
 * `appraisals` row + comps/units. This module UNDERWRITES that appraisal against
 * the registered structure (the whole-loan context): does the collateral SUPPORT
 * the values the loan was sized on, the property type/units pricing used, and the
 * strategy? Its findings feed the ONE consolidated run registry (R6.9) and the
 * CTC gate — never a separate UI island.
 *
 * HARD RULE: reads + compares only. It changes no engine number and no appraisal
 * value. A value the appraisal does not support is a FINDING (over-leverage risk),
 * not a re-price. A missing appraisal value is "not verifiable" (never treated as
 * support).
 *
 * Pure: no DB, no AI. Consumes already-loaded rows.
 */

const { propertyTypeUnitRange } = require('../mismo/enums');
const { appraisalFormExpectation, propertyTypeCompareKey } = require('../property-type');

function num(v) {
  if (v == null || String(v).trim() === '' || !Number.isFinite(Number(v))) return null;
  return Number(v);
}
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// Materiality: an appraisal value that falls short of the sizing value by more
// than this fraction is a real shortfall (below it is rounding).
const VALUE_SHORTFALL_TOL = 0.0025; // 0.25%

// Is the appraised value ENOUGH to support the value the loan sized on?
// support = appraisal >= sizing - tolerance. Returns { supported, shortfall }.
function valueSupports(appraisalValue, sizingValue) {
  const a = num(appraisalValue), s = num(sizingValue);
  if (a == null || s == null) return { supported: null, shortfall: null };
  if (s <= 0) return { supported: true, shortfall: 0 };
  const tol = s * VALUE_SHORTFALL_TOL;
  const shortfall = s - a;
  return { supported: shortfall <= tol, shortfall: shortfall > 0 ? +shortfall.toFixed(2) : 0 };
}

// A subject-to condition means the value is CONTINGENT (repairs / completion /
// inspection) — the as-completed value isn't real until met.
function isContingentCondition(c) {
  const k = norm(c);
  return k.indexOf('subjectto') > -1 || k.indexOf('subject to') > -1;
}

// Flood zones A/V (and their sub-zones) require flood insurance.
function isSpecialFloodZone(z) {
  const k = norm(z).toUpperCase().replace(/\s/g, '');
  return /^(A|AE|AH|AO|AR|A99|V|VE)/.test(k);
}

/**
 * underwriteAppraisal({ appraisal, context, comps, units, sizing }) → { findings, valueSupport }.
 *   appraisal: the current (non-superseded) appraisals row (or null → no-appraisal finding).
 *   context:   the whole-loan context (R6.3) — governing sizing values.
 *   sizing:    optional override of the values the loan sized on (else context.values).
 * Findings are shaped for the R6.9 registry (code/severity/blocks_*).
 */
function underwriteAppraisal(inputs) {
  const i = inputs || {};
  const appr = i.appraisal || null;
  const ctx = i.context || {};
  const v = (ctx.values) || {};
  const sizing = i.sizing || {};
  const findings = [];

  const sizingAsIs = num(sizing.as_is_value) != null ? num(sizing.as_is_value) : num(v.as_is_value);
  const sizingArv = num(sizing.arv) != null ? num(sizing.arv) : num(v.arv);
  const rehabBudget = num(v.rehab_budget);
  const isRehabDeal = rehabBudget != null && rehabBudget > 0;

  // No current appraisal → cannot support the collateral value (not ready to CTC).
  if (!appr) {
    findings.push(mk('appraisal_missing', 'warning', 'collateral', 'No current appraisal imported',
      // blocks_funding too (fix 2026-07-23): a loan must never FUND without an
      // appraisal on file, independent of the CTC gate having been satisfied.
      'No appraisal is on file to support the values the loan was sized on.', { blocks_ctc: true, blocks_funding: true }));
    return { findings, valueSupport: { asIs: null, arv: null } };
  }

  const apprAsIs = num(appr.as_is_value) != null ? num(appr.as_is_value) : num(appr.appraised_value);
  const apprArv = num(appr.arv_value);

  // --- as-is value support ---
  const asIsSupport = valueSupports(apprAsIs, sizingAsIs);
  if (apprAsIs == null && sizingAsIs != null) {
    findings.push(mk('appraisal_as_is_unreadable', 'warning', 'collateral', 'As-Is value not readable from the appraisal',
      'The appraisal As-Is value could not be read, so the sizing basis is unverified.', { field: 'as_is_value', blocks_ctc: true }));
  } else if (asIsSupport.supported === false) {
    findings.push(mk('appraisal_as_is_below_sizing', 'fatal', 'collateral', 'Appraisal As-Is below the value the loan sized on',
      `Appraisal As-Is ${apprAsIs} is below the ${sizingAsIs} the loan sized on (short ${asIsSupport.shortfall}).`,
      { field: 'as_is_value', expected_value: sizingAsIs, actual_value: apprAsIs, blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true }));
  }

  // --- ARV support (only meaningful on a rehab deal) ---
  if (isRehabDeal) {
    if (apprArv == null && sizingArv != null) {
      findings.push(mk('appraisal_arv_missing', 'warning', 'collateral', 'No ARV on the appraisal for a rehab loan',
        'This is a rehab loan sized on an after-repair value, but the appraisal has no ARV.', { field: 'arv', blocks_ctc: true }));
    } else {
      const arvSupport = valueSupports(apprArv, sizingArv);
      if (arvSupport.supported === false) {
        findings.push(mk('appraisal_arv_below_sizing', 'fatal', 'collateral', 'Appraisal ARV below the value the loan sized on',
          `Appraisal ARV ${apprArv} is below the ${sizingArv} the loan sized on (short ${arvSupport.shortfall}).`,
          { field: 'arv', expected_value: sizingArv, actual_value: apprArv, blocks_term_sheet: true, blocks_ctc: true, blocks_funding: true }));
      }
    }
  }

  // --- property type / units match the pricing inputs ---
  // The pricing property_type is a RANGE CATEGORY (SFR = 1, Multi 2–4, Multi 5+, Condo = 1),
  // NOT a unit count — so judge it by the appraisal's real UNIT COUNT against the range our
  // property_type implies, never a string compare of the range category to the appraisal's
  // specific type text (that false-fires on every multi-family file — owner-reported
  // 2026-07-24). Silent when the type is unknown (range null) or the appraisal count is absent.
  const ptRange = propertyTypeUnitRange(v.property_type);
  const au = num(appr.units);
  if (ptRange && au != null && (au < ptRange.min || au > ptRange.max)) {
    const rangeText = ptRange.max === Infinity ? `${ptRange.min}+ units`
      : ptRange.min === ptRange.max ? `${ptRange.min} unit${ptRange.min === 1 ? '' : 's'}`
        : `${ptRange.min}–${ptRange.max} units`;
    findings.push(mk('appraisal_property_type_mismatch', 'warning', 'collateral', 'Appraisal unit count is outside the file property type',
      `File property type ${v.property_type} (${rangeText}); appraisal shows ${au} unit${au === 1 ? '' : 's'}.`,
      { field: 'property_type', expected_value: v.property_type, actual_value: au }));
  }
  // The real, count-vs-count check: the application's own unit count vs the appraisal's.
  if (num(v.units) != null && num(appr.units) != null && num(v.units) !== num(appr.units)) {
    findings.push(mk('appraisal_units_mismatch', 'warning', 'collateral', 'Appraisal unit count differs from application',
      `Application units ${v.units}; appraisal units ${appr.units}.`,
      { field: 'units', expected_value: v.units, actual_value: appr.units }));
  }

  // --- THE FORM ITSELF IS EVIDENCE (owner-directed 2026-07-26) ---
  // "If it's a 1025 appraisal it must match with property type 2–4; if it's a 1073 then condo; if
  // it's a 1004 then single family." The form number is the most reliable property-type fact on
  // the document and we were not using it at all: an appraiser cannot report a duplex on a 1004 or
  // a condo on a 1025, because the forms are written for a category and the agencies will not
  // accept them otherwise. That makes it a HARD statement, unlike the free-text style word
  // ("Detached"), which is decorative and is compared against nothing.
  //
  // Two DIFFERENT claims come out of one form, so they are checked separately and worded
  // separately — collapsing them would tell an underwriter the wrong thing to go fix:
  const formExp = appraisalFormExpectation(appr.form_type);
  if (formExp) {
    // (a) the form vs the FILE's property type.
    const fileKey = propertyTypeCompareKey(v.property_type);
    if (fileKey && fileKey !== formExp.propertyKey) {
      findings.push(mk('appraisal_form_property_type_mismatch', 'warning', 'collateral',
        'The appraisal form does not match the file\'s property type',
        `The appraisal is a ${String(appr.form_type).trim()}, which is the form for ${formExp.label} — but the file is registered as ${v.property_type}. One of the two is wrong: either the property type on the file, or the form the appraisal was written on. A form written for the wrong category cannot support the collateral, so settle which is correct before this value is relied on.`,
        { field: 'property_type', expected_value: formExp.label, actual_value: v.property_type }));
    }
    // (b) the form vs the appraisal's OWN unit count — an internal contradiction in one document,
    //     which says the reading is wrong or the report is, and is worth knowing on its own.
    const au2 = num(appr.units);
    if (au2 != null && (au2 < formExp.minUnits || au2 > formExp.maxUnits)) {
      const expects = formExp.minUnits === formExp.maxUnits
        ? `exactly ${formExp.minUnits} unit${formExp.minUnits === 1 ? '' : 's'}`
        : `${formExp.minUnits}–${formExp.maxUnits} units`;
      findings.push(mk('appraisal_form_units_mismatch', 'warning', 'collateral',
        'The appraisal form does not match its own unit count',
        `The appraisal is a ${String(appr.form_type).trim()} (${formExp.label}, ${expects}) but reports ${au2} unit${au2 === 1 ? '' : 's'} on the subject property. The document contradicts itself — check whether the unit count was read correctly, then whether the right form was used.`,
        { field: 'units', expected_value: expects, actual_value: au2 }));
    }
  }

  // --- condition of appraisal (subject-to) makes the value contingent ---
  if (isContingentCondition(appr.condition_of_appraisal)) {
    findings.push(mk('appraisal_subject_to_conditions', 'warning', 'collateral', 'Appraisal is subject to conditions',
      `The appraised value is contingent (${appr.condition_of_appraisal}) — the conditions must be met before the value is relied on.`,
      { field: 'condition_of_appraisal', actual_value: appr.condition_of_appraisal, blocks_ctc: true }));
  }

  // --- contract price vs the recognized/effective purchase price ---
  const recognized = num(v.effective_purchase_price) != null ? num(v.effective_purchase_price) : num(v.purchase_price);
  const contract = num(appr.contract_price);
  if (contract != null && recognized != null && Math.abs(contract - recognized) > Math.max(1, recognized * 0.005)) {
    findings.push(mk('appraisal_contract_price_mismatch', 'warning', 'collateral', 'Appraisal contract price differs from the file',
      `Appraisal contract price ${contract} differs from the recognized purchase price ${recognized}.`,
      { field: 'contract_price', expected_value: recognized, actual_value: contract }));
  }

  // --- zoning legal/nonconforming ---
  if (norm(appr.zoning_compliance).indexOf('nonconform') > -1 || norm(appr.zoning_compliance).indexOf('illegal') > -1) {
    findings.push(mk('appraisal_zoning_nonconforming', 'warning', 'collateral', 'Property zoning is non-conforming',
      `Zoning compliance: ${appr.zoning_compliance}. Confirm rebuild/insurance implications.`,
      { field: 'zoning_compliance', actual_value: appr.zoning_compliance }));
  }

  // --- special flood zone → flood insurance required ---
  if (isSpecialFloodZone(appr.flood_zone)) {
    findings.push(mk('appraisal_special_flood_zone', 'info', 'collateral', 'Property is in a special flood hazard area',
      `Flood zone ${appr.flood_zone} — flood insurance is required.`, { field: 'flood_zone', actual_value: appr.flood_zone }));
  }

  return {
    findings,
    valueSupport: {
      asIs: asIsSupport.supported,
      arv: isRehabDeal ? valueSupports(apprArv, sizingArv).supported : null,
    },
  };
}

// Build a finding in the R6.9 registry shape.
function mk(code, severity, category, title, explanation, extra) {
  return Object.assign({
    code, severity, category, title, explanation, source: 'appraisal',
    blocks_term_sheet: false, blocks_ctc: false, blocks_funding: false,
  }, extra || {});
}

module.exports = { underwriteAppraisal, valueSupports, _internals: { isContingentCondition, isSpecialFloodZone, VALUE_SHORTFALL_TOL } };
