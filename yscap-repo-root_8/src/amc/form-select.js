'use strict';
/**
 * AMC form (appraisal product) selection.
 *
 * Given a deal's shape (RTL program + property category + loan purpose), pick which
 * AppraisalScope form (`productCode`) + add-on subproducts + preferred AMC to order,
 * from the admin-editable `amc_form_map` rules. The owner's decision (2026-08-05): the
 * form auto-picks, and staff can override it on the order preview before sending.
 *
 * PURE — the DB read of the rules lives in the caller / lookups service; this module
 * only does the matching, so it is fully unit-tested (scripts/test-amc-form-select-pure.js).
 *
 * Matching: a rule field left NULL is a wildcard (matches anything). A rule field set
 * must equal the deal's value (normalized: lowercased, non-alphanumerics stripped, so
 * "Ground Up" == "ground_up" == "ground-up"). Among all matching ACTIVE rules the winner
 * is the lowest `priority`, then the MOST specific (fewest wildcards), then the lowest id
 * — a deterministic, stable choice.
 */

// Canonical compare key: lowercase, strip everything but a-z0-9. Mirrors the repo's
// normNoteBuyer discipline so "Multi 2-4" / "multi_2_4" / "Multi 2 4" all match.
function norm(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// Does a single rule field match the deal's value? A NULL/blank rule field is a wildcard.
function fieldMatches(ruleValue, dealValue) {
  const r = norm(ruleValue);
  if (!r) return { match: true, wildcard: true };       // wildcard
  const d = norm(dealValue);
  if (!d) return { match: false, wildcard: false };      // rule is specific but the deal has no value
  return { match: r === d, wildcard: false };
}

// How many of a rule's three dimensions are specified (not wildcards) — the specificity score.
function specificity(rule) {
  let n = 0;
  if (norm(rule.program)) n++;
  if (norm(rule.property_category)) n++;
  if (norm(rule.loan_purpose)) n++;
  return n;
}

/**
 * Choose the best form for a deal.
 * @param deal  { program, propertyCategory, loanPurpose }
 * @param rules array of amc_form_map rows { id, program, property_category, loan_purpose,
 *              product_code, subproduct_codes, amc_identifier, priority, active }
 * @returns { productCode, subproductCodes, amcIdentifier, ruleId, matched } | null
 */
function chooseForm(deal, rules) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const d = deal || {};
  const candidates = [];
  for (const rule of rules) {
    if (rule.active === false) continue;
    if (!rule.product_code) continue;   // a rule with no form to order is not usable
    const prog = fieldMatches(rule.program, d.program);
    const cat = fieldMatches(rule.property_category, d.propertyCategory);
    const purp = fieldMatches(rule.loan_purpose, d.loanPurpose);
    if (!prog.match || !cat.match || !purp.match) continue;
    candidates.push(rule);
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => {
    const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : 100;
    const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : 100;
    if (pa !== pb) return pa - pb;                     // lower priority number wins
    const sa = specificity(a), sb = specificity(b);
    if (sa !== sb) return sb - sa;                     // more specific wins
    return Number(a.id || 0) - Number(b.id || 0);      // stable tiebreak
  });
  const win = candidates[0];
  return {
    productCode: String(win.product_code),
    subproductCodes: Array.isArray(win.subproduct_codes) ? win.subproduct_codes.map(String) : [],
    amcIdentifier: win.amc_identifier != null ? String(win.amc_identifier) : null,
    ruleId: win.id != null ? win.id : null,
    matched: { program: !!norm(win.program), propertyCategory: !!norm(win.property_category), loanPurpose: !!norm(win.loan_purpose) },
  };
}

module.exports = { chooseForm, norm, _internals: { fieldMatches, specificity } };
