'use strict';
/**
 * Class Valuation product (form) selection.
 *
 * Given a deal's shape (RTL program + property category + loan purpose + strategy +
 * property key), pick which Class PRODUCT (`productId`) to order, from the
 * admin-editable `class_form_map` rules. This is the Class mirror of
 * src/amc/form-select.js `chooseForm` — Class's "product" is what NAN calls a
 * "form", so the matcher is identical and only the value it returns differs
 * (a Class productId instead of an AppraisalScope product_code).
 *
 * The auto-pick is inert until the owner names real Class product ids: `class_form_map`
 * ships EMPTY (exactly as `amc_form_map` did before db/481 seeded it), so with no rows
 * this returns null and the order desk simply asks a human to pick from Class's live
 * product catalog — which is the current behaviour, unchanged.
 *
 * PURE — the DB read of the rules lives in order-service; this module only matches, so
 * it is fully unit-tested (scripts/test-class-form-select-pure.js).
 *
 * Matching (identical to chooseForm, deliberately, so the two form maps behave the same):
 * a rule field left NULL is a wildcard. A rule field set must equal the deal's value
 * NORMALIZED (lowercased, non-alphanumerics stripped, so "Multi 2-4" == "multi_2_4"). Among
 * all matching ACTIVE rules the winner is the lowest `priority`, then the MOST specific
 * (fewest wildcards), then the lowest id — deterministic and stable.
 */

// Canonical compare key — byte-identical to form-select.norm, so a rule keyed the
// same way matches the same deal on either desk.
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

// How many of a rule's dimensions are specified (not wildcards) — the specificity score.
function specificity(rule) {
  let n = 0;
  if (norm(rule.program)) n++;
  if (norm(rule.property_category)) n++;
  if (norm(rule.loan_purpose)) n++;
  if (norm(rule.loan_type)) n++;
  if (norm(rule.property_key)) n++;
  return n;
}

/**
 * Choose the best Class product for a deal.
 * @param deal  { program, propertyCategory, loanPurpose, loanType, propertyKey }
 * @param rules array of class_form_map rows { id, program, property_category, loan_purpose,
 *              loan_type, property_key, product_id, product_name, priority, active }
 * @returns { productId, productName, ruleId, matched } | null
 */
function chooseProduct(deal, rules) {
  if (!Array.isArray(rules) || !rules.length) return null;
  const d = deal || {};
  const candidates = [];
  for (const rule of rules) {
    if (rule.active === false) continue;
    // A rule with no product to order is not usable. `product_id` may legitimately be a
    // number (a Class catalog id) or a numeric string, so only null/blank is unusable —
    // NOT a falsy 0, which is why this tests for null/'' explicitly rather than truthiness.
    if (rule.product_id == null || String(rule.product_id).trim() === '') continue;
    const prog = fieldMatches(rule.program, d.program);
    const cat = fieldMatches(rule.property_category, d.propertyCategory);
    const purp = fieldMatches(rule.loan_purpose, d.loanPurpose);
    const lt = fieldMatches(rule.loan_type, d.loanType);
    const pk = fieldMatches(rule.property_key, d.propertyKey);
    if (!prog.match || !cat.match || !purp.match || !lt.match || !pk.match) continue;
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
    productId: String(win.product_id),
    productName: win.product_name != null && String(win.product_name).trim() ? String(win.product_name).trim() : null,
    ruleId: win.id != null ? win.id : null,
    matched: {
      program: !!norm(win.program), propertyCategory: !!norm(win.property_category),
      loanPurpose: !!norm(win.loan_purpose), loanType: !!norm(win.loan_type), propertyKey: !!norm(win.property_key),
    },
  };
}

module.exports = { chooseProduct, norm, _internals: { fieldMatches, specificity } };
