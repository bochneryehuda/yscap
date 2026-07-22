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

function num(v) {
  if (v === '' || v == null || !Number.isFinite(Number(v))) return null;
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
      'No appraisal is on file to support the values the loan was sized on.', { blocks_ctc: true }));
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
      { field: 'as_is_value', expected_value: sizingAsIs, actual_value: apprAsIs, blocks_ctc: true, blocks_funding: true }));
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
          { field: 'arv', expected_value: sizingArv, actual_value: apprArv, blocks_ctc: true, blocks_funding: true }));
      }
    }
  }

  // --- property type / units match the pricing inputs ---
  if (v.property_type && appr.property_type && norm(v.property_type) !== norm(appr.property_type)) {
    findings.push(mk('appraisal_property_type_mismatch', 'warning', 'collateral', 'Appraisal property type differs from pricing',
      `Priced as ${v.property_type}; appraisal says ${appr.property_type}.`,
      { field: 'property_type', expected_value: v.property_type, actual_value: appr.property_type }));
  }
  if (num(v.units) != null && num(appr.units) != null && num(v.units) !== num(appr.units)) {
    findings.push(mk('appraisal_units_mismatch', 'warning', 'collateral', 'Appraisal unit count differs from application',
      `Application units ${v.units}; appraisal units ${appr.units}.`,
      { field: 'units', expected_value: v.units, actual_value: appr.units }));
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
