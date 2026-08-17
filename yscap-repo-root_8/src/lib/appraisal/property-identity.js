'use strict';
/**
 * IS THIS APPRAISAL EVEN ABOUT THIS PROPERTY? — ONE definition, shared by every
 * automatic writer that acts on a returned appraisal.
 *
 * THE QUESTION
 * ------------
 * `src/lib/appraisal/findings.js` raises three FATAL findings when the report and
 * the loan file disagree about WHICH property was appraised:
 *
 *   • `address_mismatch`        — the report's street address is not the file's
 *   • `units_mismatch`          — the report's unit count is not the file's
 *   • `property_type_mismatch`  — the report's unit count falls outside the range
 *                                 the file's property type implies
 *
 * Any one of them means we may be holding somebody else's report, or the right
 * report for a different deal. Nothing automatic may act on an appraisal while one
 * is open — not writing a value onto the loan, and not vouching for the documents.
 *
 * WHY IT IS A MODULE RATHER THAN A QUERY
 * --------------------------------------
 * `as-is-desk.js` has asked this question since 2026-07-28 (before adopting an
 * As-Is value off the report). `src/amc/sync.js` needed to ask exactly the same
 * question before auto-accepting the returned documents, and a second hand-written
 * copy of the code list is how the two drift: add a fourth identity finding to
 * findings.js and only one caller would learn about it. The list lives here once.
 *
 * IT FAILS CLOSED, ALWAYS. An unreadable findings table answers `'unknown'`, which
 * every caller must treat exactly as it treats a real mismatch — "we could not
 * confirm this report is about this property" is not the same as "it is". A caller
 * that fails OPEN here turns a database hiccup into a wrong-property write.
 *
 * NOTE the three As-Is findings (`asis_mismatch` / `asis_below_price`) are
 * deliberately NOT on this list: they are about the VALUE, not about which house,
 * and resolving them is the whole point of the As-Is desk.
 */

/**
 * The fatal findings that mean "this report may not be about this property".
 * Frozen so a caller cannot mutate the shared list.
 */
const IDENTITY_CODES = Object.freeze(['address_mismatch', 'units_mismatch', 'property_type_mismatch']);

/**
 * The open identity problem on a file, or null when there is none.
 *
 * Returns the finding CODE (so a caller can say which one it was), or the string
 * `'unknown'` when the findings could not be read at all. NEVER throws.
 *
 * @param {string} appId       the application id
 * @param {object} dbh         a db handle / pooled client (anything with .query)
 * @returns {Promise<string|null>} a code, `'unknown'`, or null when the report matches
 */
async function identityIssue(appId, dbh) {
  if (!appId || !dbh) return 'unknown';
  try {
    const bad = (await dbh.query(
      `SELECT code FROM appraisal_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal'
          AND code = ANY($2::text[]) LIMIT 1`,
      [appId, IDENTITY_CODES])).rows[0];
    return bad ? bad.code : null;
  } catch (_) { return 'unknown'; }
}

/** Plain-language wording for a code this module returned. Never a code on its own. */
function describeIdentityIssue(code) {
  switch (code) {
    case 'address_mismatch': return 'the address on the appraisal does not match this file';
    case 'units_mismatch': return 'the unit count on the appraisal does not match this file';
    case 'property_type_mismatch': return 'the appraisal\'s unit count is outside the range this file\'s property type allows';
    case 'unknown': return 'we could not confirm the appraisal is about this property';
    default: return null;
  }
}

module.exports = { IDENTITY_CODES, identityIssue, describeIdentityIssue };
