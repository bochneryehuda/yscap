'use strict';

/**
 * WHICH TRACK-RECORD LINES AN EXPORT CARRIES, AND HOW AN UNVERIFIED ONE IS STAMPED
 * (owner-directed 2026-08-21).
 *
 * The owner: *"We're looking to enhance the export button. Right now, it's only exporting
 * verified. We need to add a button over there for 'Export all of them' and also [un]verified
 * ones. It should have a stamp next to it on the PDF or on the Excel, whatever you are
 * exporting. Again, the regular export button (PDF or Excel) should only export the verified
 * ones. There should be an extra option to export the PDF or an Excel from the unverified ones,
 * but everything that is unverified should have a stamp that it's not verified yet, and it
 * still needs to go through verification."*
 *
 * WHY THIS IS ONE MODULE RATHER THAN A PARAMETER PASSED AROUND. The rule has three parts that
 * MUST agree — which rows come out of the database, what the document SAYS it contains, and
 * what stamp each row carries — and they are consumed in three different places (the SQL in
 * `tpr-export`, the Excel writer and the PDF writer in `track-record-export`, and the staff
 * export door). Three copies of "what does unverified mean" is how a PDF ends up headed
 * "verified only" while carrying a line nobody verified.
 *
 * THE THREE SCOPES:
 *   · `verified`   — the DEFAULT, and byte-identical to what shipped before. Only a line the
 *                    loan team confirmed (`is_verified = true`, the same definition the tier and
 *                    experience math use). This is what the investor package delivers, per the
 *                    owner's 2026-08-12 rule, and nothing here changes that.
 *   · `all`        — every line on the record, verified or not.
 *   · `unverified` — only the lines still to be verified.
 *
 * THE STAMP IS NOT DECORATION. `all` and `unverified` put lines in front of a reader that
 * nobody has confirmed, so every one of them carries the words on its own row — never only a
 * summary at the top, which a reader skimming page three has long since scrolled past. The
 * document ALSO carries a banner naming its scope, because "why is this list shorter than the
 * one I saw yesterday" must be answerable from the document itself.
 *
 * The wording is stated ONCE here and never retyped: `scripts/test-export-scope-pure.js` reads
 * the Excel and PDF writers and fails the moment either states it in its own words.
 */

/** The scope keys, in the order a chooser should offer them. */
const SCOPES = ['verified', 'all', 'unverified'];

/** The DEFAULT. Anything unrecognised resolves here — an export that cannot read its own
 *  instruction must fall back to the SAFE, narrow set, never to the wide one. */
const DEFAULT_SCOPE = 'verified';

const SCOPE_META = {
  verified: {
    key: 'verified',
    button: 'Verified only',
    title: 'VERIFIED EXPERIENCE ONLY',
    note: 'This report contains only the projects the loan team has verified.',
    // No banner: a verified-only export is the ordinary one and says so in its own title.
    banner: null,
  },
  all: {
    key: 'all',
    button: 'Export all',
    title: 'ALL EXPERIENCE — VERIFIED AND NOT YET VERIFIED',
    note: 'This report contains every project on the borrower’s record. Projects that have not been verified are marked.',
    banner: 'CONTAINS UNVERIFIED PROJECTS — every line marked “NOT VERIFIED” still needs to go through verification.',
  },
  unverified: {
    key: 'unverified',
    button: 'Unverified only',
    title: 'NOT-YET-VERIFIED EXPERIENCE',
    note: 'This report contains only the projects that have NOT been verified yet.',
    banner: 'NOT VERIFIED — every project in this report still needs to go through verification.',
  },
};

/** The words that go beside an unverified line. Stated once; never retyped by a writer. */
const NOT_VERIFIED_STAMP = 'NOT VERIFIED — still needs to go through verification';
/** The short form, for a narrow column where the sentence cannot fit. */
const NOT_VERIFIED_SHORT = 'NOT VERIFIED';

/** Resolve whatever arrived (a query string, a button, undefined) to a real scope. */
function normalizeScope(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return SCOPES.includes(s) ? s : DEFAULT_SCOPE;
}

/** True only for a value that IS one of the three — used by a door that should refuse junk
 *  rather than quietly widen or narrow what somebody asked for. */
function isScope(v) { return SCOPES.includes(String(v == null ? '' : v).trim().toLowerCase()); }

function scopeMeta(v) { return SCOPE_META[normalizeScope(v)]; }

/**
 * The SQL predicate for a scope, against a `track_records` alias.
 *
 * Returns a fragment that is always safe to `AND` into a WHERE — `TRUE` for `all`, so the
 * caller never has to branch and can never forget one of the three.
 *
 * NOTE `is_verified` is a plain boolean column with no NULLs in this table, but the predicate
 * is written NULL-safe anyway: a bare `NOT is_verified` would silently drop a NULL row from
 * BOTH the verified and the unverified export, so a line could exist on the record and appear
 * in neither — the three-valued-logic trap this codebase has been bitten by before.
 */
function scopeSql(alias = 't') {
  const a = String(alias).replace(/[^a-zA-Z0-9_]/g, '') || 't';
  return {
    verified: `${a}.is_verified = true`,
    all: 'TRUE',
    unverified: `COALESCE(${a}.is_verified, false) = false`,
  };
}

/** The predicate for ONE scope. */
function scopePredicate(scope, alias = 't') { return scopeSql(alias)[normalizeScope(scope)]; }

/**
 * The stamp for one row, or null when the row is verified.
 * @param {object} row  anything carrying `is_verified` (or the export's own `__verified`)
 */
function rowStamp(row) {
  const verified = row && (row.is_verified === true || row.__verified === true);
  return verified ? null : { text: NOT_VERIFIED_STAMP, short: NOT_VERIFIED_SHORT };
}

/** Does this set of section rows contain anything unverified? Decides whether the banner and
 *  the per-row stamp column appear at all — an all-blank column on a verified-only export is
 *  noise, and that export must stay byte-identical to what shipped before. */
function hasUnverified(sections) {
  for (const sec of (sections || [])) {
    for (const row of (sec.rows || [])) if (rowStamp(row)) return true;
  }
  return false;
}

module.exports = {
  SCOPES, DEFAULT_SCOPE, SCOPE_META, NOT_VERIFIED_STAMP, NOT_VERIFIED_SHORT,
  normalizeScope, isScope, scopeMeta, scopeSql, scopePredicate, rowStamp, hasUnverified,
};
