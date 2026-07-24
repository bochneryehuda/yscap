'use strict';
/**
 * R6.8 — Appraisal ↔ program fit (deterministic core).
 *
 * A companion to appraisal-underwriter: given the appraisal + the registered
 * structure, does the appraisal SUPPORT the selected strategy end-to-end? It
 * answers the yes/no questions the review asks — does the appraisal support the
 * transaction type, the as-is basis, the ARV basis, the property type/units used
 * by pricing, and the rehab classification — and returns a single fit verdict
 * with the reasons.
 *
 * Pure: no DB, no AI. Non-authoritative — it explains fit; it never re-prices.
 */

const apprUw = require('./appraisal-underwriter');
const { propertyTypeUnitRange } = require('../mismo/enums');

function num(v) { return (v === '' || v == null || !Number.isFinite(Number(v))) ? null : Number(v); }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

/**
 * assessFit({ appraisal, context, sizing }) → {
 *   supports,               // true | false | null (not determinable)
 *   checks: [{ key, ok, detail }],
 *   reasons: [string],      // the failing reasons
 * }
 */
function assessFit(inputs) {
  const i = inputs || {};
  const appr = i.appraisal || null;
  const v = (i.context && i.context.values) || {};
  const sizing = i.sizing || {};
  const checks = [];
  const add = (key, ok, detail) => checks.push({ key, ok, detail });

  if (!appr) {
    return { supports: null, checks: [{ key: 'appraisal_present', ok: null, detail: 'No appraisal on file.' }], reasons: ['No appraisal is on file.'] };
  }

  const sizingAsIs = num(sizing.as_is_value) != null ? num(sizing.as_is_value) : num(v.as_is_value);
  const sizingArv = num(sizing.arv) != null ? num(sizing.arv) : num(v.arv);
  const rehabBudget = num(v.rehab_budget);
  const isRehabDeal = rehabBudget != null && rehabBudget > 0;

  // as-is basis supported
  const asIs = apprUw.valueSupports(appr.as_is_value != null ? appr.as_is_value : appr.appraised_value, sizingAsIs);
  add('as_is_basis', asIs.supported, asIs.supported === false ? `As-Is short by ${asIs.shortfall}` : 'As-Is supported');

  // ARV basis supported (rehab deals)
  if (isRehabDeal) {
    const arv = apprUw.valueSupports(appr.arv_value, sizingArv);
    add('arv_basis', arv.supported, arv.supported === false ? `ARV short by ${arv.shortfall}` : (num(appr.arv_value) == null ? 'no ARV on appraisal' : 'ARV supported'));
  }

  // property type / units — judge the property type by the appraisal's UNIT COUNT against
  // the range our property_type category implies (SFR = 1, Multi 2–4, Multi 5+, Condo = 1),
  // NOT a string compare of the range category to the appraisal's specific type text (which
  // false-"disagrees" on every multi-family file — owner-reported 2026-07-24).
  const ptRange = propertyTypeUnitRange(v.property_type);
  const au = num(appr.units);
  if (ptRange && au != null) add('property_type', au >= ptRange.min && au <= ptRange.max, `file ${v.property_type} vs appraisal ${au} unit${au === 1 ? '' : 's'}`);
  if (num(v.units) != null && num(appr.units) != null) add('units', num(v.units) === num(appr.units), `application ${v.units} vs appraisal ${appr.units}`);

  // transaction type: a rehab loan wants a value that reflects the after-repair
  // condition; a straight purchase wants a clean AsIs (not subject-to).
  const contingent = norm(appr.condition_of_appraisal).indexOf('subject') > -1;
  if (isRehabDeal) {
    // rehab: subject-to-completion IS expected; a clean AsIs-only with an ARV is fine too.
    add('strategy', true, contingent ? 'rehab: subject-to condition expected' : 'rehab: as-is + ARV');
  } else {
    add('strategy', !contingent, contingent ? 'purchase but appraisal is subject-to conditions' : 'clean AsIs supports purchase');
  }

  const failing = checks.filter((c) => c.ok === false);
  const undetermined = checks.some((c) => c.ok === null);
  const supports = failing.length ? false : (undetermined ? null : true);
  return { supports, checks, reasons: failing.map((c) => `${c.key}: ${c.detail}`) };
}

module.exports = { assessFit };
