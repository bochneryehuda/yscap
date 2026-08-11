'use strict';
/**
 * THE RTL SCOPE GATE — what this build is allowed to ask DocLab for.
 *
 * Owner-directed, in the owner's own words: *"Anything related to DSCR and prepayment
 * penalty doesn't belong to our RTL build. We need to focus on bridge, hold back,
 * New York building loan ground up construction and stuff like that."*
 *
 * WHY THIS IS CODE AND NOT A CONVENTION. DocLab is one API serving both families,
 * and the two are one string apart: `template.loan_category` decides which document
 * set gets drafted, and `prepayment_option_code` decides which prepayment clause is
 * merged into the promissory note. Nothing at their end knows which product WE are.
 * So "we don't do DSCR here" has to be a refusal in the transport, not a note in a
 * document — the same reasoning behind `scripts/check-product-separation.js`. Every
 * path that can reach DocLab goes through `assertInScope()`, which is why the client
 * calls it too rather than trusting the caller.
 *
 * PREPAYMENT IS NOT SIMPLY OMITTED, AND THAT IS THE SUBTLE PART. DocLab makes
 * `prepayment_option_code` a REQUIRED root field — their migration note states it
 * twice, and their Prepayment Penalty page adds that the `pre_payment_penalty` array
 * "is required and must contain at least one value, even if the selected option does
 * not utilize it." Leaving the field out is not "no penalty", it is an invalid
 * request; and a template with an unresolved `{{Pre_Payment_Penalty}}` tag is a note
 * with a hole in it. So the RTL answer is the code that ASKS FOR NO PENALTY —
 * `RTL-No` — sent deliberately on every file. "No prepayment penalty" is a thing we
 * state, not a thing we omit.
 *
 * WHAT THIS GATE IS NOT. It is not a licence check, a state check, or a template
 * check — DocLab owns all three and answers them live. It only decides whether a
 * request belongs to this build at all.
 */

const catalog = require('./catalog');

/** Every category this build may submit. Derived — never a second hand-typed list. */
const RTL_CATEGORIES = Object.freeze(
  catalog.LOAN_CATEGORIES.filter((c) => c.track === 'rtl').map((c) => c.category));

/** Every category this build refuses. Same source, other side. */
const OUT_OF_SCOPE_CATEGORIES = Object.freeze(
  catalog.LOAN_CATEGORIES.filter((c) => c.track !== 'rtl').map((c) => c.category));

/**
 * Does this name read as a DSCR product?
 *
 * TWO TESTS, ON PURPOSE, AND THE SECOND IS THE IMPORTANT ONE. The catalog lookup
 * answers for every category DocLab publishes TODAY. The token test catches a
 * category DocLab adds TOMORROW — their own product-name mapping is mid-rename
 * ("DSCR SFR" → "DSCR SFR 1 to 4"), so a name we have never seen is the expected
 * case, not the exotic one. An unrecognised name containing DSCR is refused rather
 * than allowed through on the grounds that it is not in our table.
 *
 * The token test is a WORD-BOUNDARY match, not a substring: a substring test would
 * be a trap the day a category legitimately contains those four letters inside a
 * longer word, and this function's job is to be right, not merely strict.
 */
const DSCR_TOKEN = /(^|[^a-z0-9])dscr([^a-z0-9]|$)/i;
function isDscrCategory(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  const row = catalog.categoryOf(s);
  if (row) return row.track === 'dscr';
  return DSCR_TOKEN.test(s);
}

/**
 * A prepayment option code that belongs to the DSCR ladder.
 *
 * Same shape as above and for the same reason: the published list is checked first,
 * then the `DSCR-` prefix catches a rung PLL adds later. Their codes are literally
 * `DSCR-<n>/<n>/<n>` — a family named by its prefix — so the prefix is the identity,
 * not a guess about it.
 */
function isDscrPrepaymentCode(code) {
  const s = String(code == null ? '' : code).trim();
  if (!s) return false;
  if (catalog.PREPAYMENT_OPTION_CODES.dscr.includes(s)) return true;
  return /^dscr[-\s]/i.test(s);
}

/** Their own test fixture. Real enough to be sent by accident, so it is named. */
function isTestPrepaymentCode(code) {
  return catalog.PREPAYMENT_OPTION_CODES.test.includes(String(code == null ? '' : code).trim());
}

/**
 * Judge a submission. Returns `{ ok, problems: [{ code, field, message }] }` and
 * NEVER throws — the caller decides whether a problem is a refusal or a warning.
 *
 * FAILS CLOSED on a blank loan category: with nothing to judge we cannot say the
 * request is in scope, and "we could not tell" must never read as "yes". A blank
 * category is also a request DocLab itself would refuse, so nothing is lost.
 */
function check({ loanCategory, prepaymentOptionCode } = {}) {
  const problems = [];
  const cat = String(loanCategory == null ? '' : loanCategory).trim();

  if (!cat) {
    problems.push({ code: 'category_missing', field: 'template.loan_category',
      message: 'No loan category, so PILOT cannot tell whether this belongs to the RTL build.' });
  } else if (isDscrCategory(cat)) {
    problems.push({ code: 'dscr_category', field: 'template.loan_category',
      message: `"${cat}" is a DSCR (long-term rental) product. This build only drafts RTL documents — bridge, holdback, ground-up construction, NY building loan, CEMA and commercial.` });
  } else if (!catalog.categoryOf(cat)) {
    // Not refused: DocLab may well have added it. Named so a human decides.
    problems.push({ code: 'category_unknown', field: 'template.loan_category', warning: true,
      message: `"${cat}" is not one of the loan categories DocLab has published to us. Check the spelling against the lender/category list before submitting.` });
  }

  const ppc = String(prepaymentOptionCode == null ? '' : prepaymentOptionCode).trim();
  if (ppc && isDscrPrepaymentCode(ppc)) {
    problems.push({ code: 'dscr_prepayment', field: 'prepayment_option_code',
      message: `"${ppc}" is a DSCR prepayment-penalty option. RTL loan documents are drafted with no prepayment penalty (${catalog.RTL_CODES.none}).` });
  } else if (ppc && isTestPrepaymentCode(ppc)) {
    problems.push({ code: 'test_prepayment', field: 'prepayment_option_code',
      message: `"${ppc}" is DocLab's own test value and must never reach a real loan document.` });
  }

  return { ok: problems.every((p) => p.warning === true), problems };
}

/**
 * The refusal. Throws `doclab_out_of_scope` naming every real problem, so a caller
 * gets one message it can show a human rather than discovering the next one on the
 * retry. Warnings are carried on the error but never cause one.
 */
function assertInScope(args) {
  const r = check(args);
  const hard = r.problems.filter((p) => p.warning !== true);
  if (!hard.length) return r;
  const e = new Error(`doclab: this request is outside the RTL build — ${hard.map((p) => p.message).join(' ')}`);
  e.code = 'doclab_out_of_scope';
  e.problems = r.problems;
  throw e;
}

/**
 * The prepayment code an RTL file sends.
 *
 * `allowed` is the live per-state list from `GET /getPrepaymentOptions/{state}` when
 * we have it. If that list is present and does NOT contain `RTL-No`, we do not
 * substitute something plausible — we return null and say why, because picking a
 * prepayment clause on behalf of a lender is not a decision code gets to make.
 */
function rtlPrepaymentCode(allowed) {
  const none = catalog.RTL_CODES.none;
  if (!Array.isArray(allowed) || !allowed.length) return { code: none, confirmed: false, reason: null };
  const codes = allowed.map((o) => (typeof o === 'string' ? o : (o && (o.optionCode || o.code)) || '')).map((s) => String(s).trim());
  if (codes.includes(none)) return { code: none, confirmed: true, reason: null };
  return { code: null, confirmed: false,
    reason: `DocLab does not offer "${none}" in this state. Somebody has to choose the right no-penalty option from: ${codes.filter(Boolean).join(', ') || '(the state list came back empty)'}.` };
}

module.exports = {
  RTL_CATEGORIES, OUT_OF_SCOPE_CATEGORIES,
  isDscrCategory, isDscrPrepaymentCode, isTestPrepaymentCode,
  check, assertInScope, rtlPrepaymentCode,
};
