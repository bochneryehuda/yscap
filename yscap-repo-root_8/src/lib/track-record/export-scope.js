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

/* ── WHAT THE EXPORT LEFT BEHIND ──────────────────────────────────────────────
   A verified-only export is a FILTER, and a filter that says nothing about what
   it removed is indistinguishable from a record that never had the line.

   That is not hypothetical. On 2026-08-26 a loan team verified a borrower's third
   project at 20:25:07, exported the investor package at 20:43:39, and got a
   workbook headed "VERIFIED EXPERIENCE ONLY" carrying two projects — because
   between those two moments the db/485 verify guard had silently returned the
   third line to `pending`. Nothing on the document, in the download response or
   in the audit row said a line had been left out, so the only way to notice was
   to count the rows by hand against the screen. The file was delivered, priced
   and taped as two deals when the borrower had three.

   The document side of the TPR package has answered this since 2026-08-10 — it
   reports `heldBack` and `missing` so "a package quietly one document short" is
   impossible. The track-record side did not. It does now, on the same terms:
   EVERY export states how many projects are on the record, how many it carried,
   and NAMES each one it held back with the reason.

   The wording lives HERE, once, because the Excel writer, the PDF writer, the
   staff export door and the investor package all say it — and four copies is how
   a workbook comes to disagree with the audit row about the same borrower. */

/** Why one line is not in this report. Keyed by SCOPE, not by the row's status:
 *  the question a reader is asking is "why is this shorter than the record", and
 *  the answer is the instruction the export was given. */
const HELD_BACK_REASON = {
  verified: 'not verified yet — this report carries only verified projects',
  unverified: 'already verified — this report carries only the not-yet-verified projects',
  all: null,   // `all` holds nothing back, so it can never need a reason
};

/**
 * Split rows the database already decided on into the ones this export CARRIES
 * and the ones it HOLDS BACK.
 *
 * The decision is NOT re-made here. Both export queries select every line on the
 * record and carry `scopePredicate()` itself as an `in_scope` column, so Postgres
 * answers with the SAME expression that used to be the WHERE clause. A JS twin of
 * that predicate would be a second definition, and the twin that drifts is the one
 * that leaks — which is the whole failure this module exists to prevent.
 *
 * @param {Array}  rows   every line on the record, in the export's own order
 * @param {string} scope
 * @param {function} label  row -> the property's name for a human (the caller's
 *                          `addrText`; never re-derived here)
 * @returns {{carried: Array, heldBack: Array, total: number}}
 */
function partitionInScope(rows, scope, label) {
  const s = normalizeScope(scope);
  const all = Array.isArray(rows) ? rows : [];
  const carried = [], heldBack = [];
  for (const r of all) {
    if (r && r.in_scope === true) { carried.push(r); continue; }
    heldBack.push({
      id: (r && r.id) || null,
      property: (typeof label === 'function' ? label(r) : '') || 'Project (no address on the line)',
      reason: HELD_BACK_REASON[s] || HELD_BACK_REASON.verified,
      verification_status: (r && r.verification_status) || null,
    });
  }
  return { carried, heldBack, total: all.length };
}

/** The one sentence that opens the held-back block. Stated once; the Excel and the
 *  PDF both print THIS, so they cannot come to describe the same gap differently. */
function heldBackHeadline(heldBackCount, total) {
  const n = Number(heldBackCount) || 0;
  const t = Number(total) || 0;
  return `ON THIS RECORD BUT NOT IN THIS REPORT — ${n} of ${t} project(s) held back:`;
}

/** The line for one held-back project. */
function heldBackLine(h) {
  return `${(h && h.property) || 'Project'} — ${(h && h.reason) || HELD_BACK_REASON.verified}`;
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
  HELD_BACK_REASON, partitionInScope, heldBackHeadline, heldBackLine,
};
