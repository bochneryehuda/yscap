'use strict';
/**
 * LONG-TERM — WHERE A LONG-TERM LOAN'S SHAREPOINT IDENTITIES LIVE.
 *
 * The owner, 2026-08-30 (the share-the-code directive, quoted in full in
 * `docs/longterm/SHARE-THE-CODE-DIRECTIVE.md`):
 *
 *   *"Same thing is with SharePoint: you need to share the code."*
 *   *"The SharePoint looks for the same exact folder, same exact logic that we
 *    build up on the short-term side."*
 *
 * SO THE MIRROR IS NOT COPIED HERE, AND MUST NEVER BE. `src/lib/sharepoint-backup.js`
 * stays the ONE implementation — one drain, one folder resolver, one shelf sweep,
 * one no-delete law, one backlog SLO. A long-term document files into the SAME
 * Pipeline Drive tree an RTL document files into:
 *
 *     Pipeline Drive / <Officer> / <Borrower> / <Address> / <sync leaf> / <category>
 *
 * What lives in this file is the ONLY part that is genuinely Long-Term's own: the
 * answer to *"for an lt_loan-scoped document, who is the officer, who is the
 * borrower, and what is the property?"* — because that answer reads `lt_loans`,
 * `lt_properties` and `lt_loan_contacts`, and RTL code may never name a Long-Term
 * table (`scripts/check-product-separation.js`, and it is RIGHT to refuse: the
 * live product must not grow a dependency on the side build's schema).
 *
 * So the shape is: this module hands the shared mirror SQL FRAGMENTS plus ONE pure
 * predicate, and the mirror splices them into its own selectors. The mirror keeps
 * every decision; Long-Term only says where its own facts are kept. The mirror
 * requires this module through a try/catch, so if the side build is not present
 * the live mirror behaves exactly as it did before this shipment.
 *
 * THE JS/SQL TWIN. `identitiesResolved()` (JS, over an enriched row) and
 * `unresolvedSql()` (SQL, over a `documents` row) are two spellings of one rule —
 * the same discipline `product-term.js` already applies to the product line — and
 * `scripts/test-lt-sharepoint-scope-db.js` runs BOTH over the same fixtures and
 * fails the moment they disagree. They must agree, because between them they
 * decide whether a document is mirrored or PARKED, and a disagreement is either a
 * document that never files or a doomed upload that retries until it is DEAD.
 *
 * PURE. No database handle, no network and no config — every input is passed in, so
 * the whole policy is testable without a Postgres. It requires exactly one module,
 * `./access`, which is itself pure (zero requires of its own) and which owns the
 * effective-person expression; see below for why that is imported rather than typed.
 */
const { effectiveStaffSql } = require('./access');

/** The fourth owner scope of the one Condition Center (db/652). */
const SCOPE = 'lt_loan';

/**
 * The scope-key prefix the mirror's folder cache is keyed on. `app:` and
 * `borrower:` are RTL's two; this is the third, and it is a LOAN FILE scope —
 * it gets the full officer/borrower/address chain, exactly like `app:`.
 */
const SCOPE_KEY_PREFIX = 'lt';

/** The folder-cache scope key for one long-term loan. */
function scopeKey(loanId) {
  return `${SCOPE_KEY_PREFIX}:${loanId}`;
}

/** Is this one of ours? (The mirror asks before reading any lt_* identity.) */
function isScopeKey(key) {
  return String(key || '').startsWith(`${SCOPE_KEY_PREFIX}:`);
}

// ---------------------------------------------------------------------------
// The identity expressions. Every one is NULL-SAFE and returns NULL — never ''
// — when the fact is not on the loan, because the mirror's folder resolver
// treats NULL as "not known" and an empty string as a folder name.
//
// The aliases (ltl / ltp / ltb / ltsu / ltoff) are the ones `enrichJoinsSql()`
// creates, and they are deliberately unmistakable: the mirror's own query
// already uses d / ci / ct / tr / l / a / su / b / recent, and a collision would
// silently read the wrong row.
// ---------------------------------------------------------------------------

/**
 * The borrower's first name.
 *
 * The SHARED borrower profile wins when the loan is linked to one — that is the
 * whole point of the shared identity zone (ledger 2026-08-03, "same login same
 * borrower record"): one person, one folder, whichever product the file is on,
 * spelled the way the profile spells it. Only when no profile is linked do we
 * fall back to the names Encompass mirrored onto the loan, and last of all to
 * the pipeline's single `borrower_name` string (db/573 keeps all three because
 * "the pipeline gives one string and the loan gives the parts").
 */
const BORROWER_FIRST_SQL = `COALESCE(
  NULLIF(BTRIM(ltb.first_name), ''),
  NULLIF(BTRIM(ltl.borrower_first_name), ''),
  NULLIF(split_part(BTRIM(ltl.borrower_name), ' ', 1), ''))`;

/**
 * The borrower's last name — same precedence.
 *
 * The `borrower_name` fallback takes EVERYTHING after the first space ("John C
 * Smith" → "C Smith"), which is what the mirror's borrower matcher wants: it
 * compares the LAST token of the last name and ignores middles on either side.
 * A single-token name ("Acme") yields NULL rather than repeating itself, or the
 * folder would read "Acme Acme".
 */
const BORROWER_LAST_SQL = `COALESCE(
  NULLIF(BTRIM(ltb.last_name), ''),
  NULLIF(BTRIM(ltl.borrower_last_name), ''),
  CASE WHEN position(' ' in BTRIM(ltl.borrower_name)) > 0
       THEN NULLIF(BTRIM(substr(BTRIM(ltl.borrower_name),
                                position(' ' in BTRIM(ltl.borrower_name)) + 1)), '') END)`;

/** The whole borrower name, built from the two above so it can never disagree with them. */
const BORROWER_NAME_SQL = `NULLIF(BTRIM(CONCAT_WS(' ', ${BORROWER_FIRST_SQL}, ${BORROWER_LAST_SQL})), '')`;

/**
 * The property, as ONE line, in the SAME shape RTL's applications carry
 * ("<street>, <city>, <state>") — because the mirror's address matcher compares
 * the pre-comma street segment and names a NEW folder from it. Building it any
 * other way would file the same house under two folder names.
 *
 * Each part is NULLIF'd before CONCAT_WS so a blank city can never leave ", , NJ".
 */
const ADDRESS_ONE_LINE_SQL = `NULLIF(BTRIM(CONCAT_WS(', ',
  NULLIF(BTRIM(ltp.street), ''),
  NULLIF(BTRIM(ltp.city), ''),
  NULLIF(BTRIM(ltp.state), ''))), '')`;

/** The loan number — the address folder's fallback name, exactly as `ys_loan_number` is on the RTL side. */
const LOAN_NUMBER_SQL = `NULLIF(BTRIM(ltl.loan_number), '')`;

/**
 * Who the loan's officer is.
 *
 * `lt_loans.loan_officer_id` is the PILOT-side link into the SHARED staff roster
 * and is the answer whenever it is set. Otherwise the loan's own Encompass
 * contact roles decide: an OVERRIDE beats the synced staff link (db/553's rule —
 * "a sync NEVER clears an override"), and a login nobody has linked to a staff
 * user yet still yields the name Encompass gave, so a file gets its real officer
 * folder instead of landing in Unfiled.
 */
const OFFICER_SQL = `COALESCE(NULLIF(BTRIM(ltsu.full_name), ''), NULLIF(BTRIM(ltoff.officer_name), ''))`;

/**
 * The joins that make the expressions above readable, for a query that already
 * has the `documents` row in scope.
 *
 * @param {string} ownerExpr SQL naming the lt_loan this document belongs to.
 *
 * Every join is a LEFT JOIN on a primary key (and the officer lateral is LIMIT 1
 * against a UNIQUE (loan_id, role) index), so this can never multiply a row: an
 * RTL document, whose ownerExpr is NULL, matches nothing and every column above
 * comes back NULL — which is what keeps the RTL side byte-identical.
 */
function enrichJoinsSql(ownerExpr) {
  return `
      LEFT JOIN lt_loans      ltl  ON ltl.id = ${ownerExpr}
      LEFT JOIN lt_properties ltp  ON ltp.loan_id = ltl.id
      LEFT JOIN borrowers     ltb  ON ltb.id = ltl.borrower_id
      LEFT JOIN staff_users   ltsu ON ltsu.id = ltl.loan_officer_id
      -- WHO THE OFFICER IS, ASKED RATHER THAN RETYPED. A long-term file can be
      -- reassigned on the PILOT side, so "the officer" is not simply the resolved
      -- staff_id — the local override wins where one exists. That rule was once
      -- typed out in five places, drifted in the one nobody thought of as a copy,
      -- and left a reassigned file in the previous officer's filter while staying
      -- in their own pipeline. access.js owns the expression now and exports
      -- effectiveStaffSql(alias) for callers like this one, which takes the alias
      -- because every caller joins the table under its own name.
      -- test-lt-contact-override-pure.js fails the build if a sixth copy appears —
      -- which is why this comment describes the rule instead of spelling it.
      LEFT JOIN LATERAL (
        SELECT COALESCE(NULLIF(BTRIM(csu.full_name), ''), NULLIF(BTRIM(c.encompass_name), '')) AS officer_name
          FROM lt_loan_contacts c
          LEFT JOIN staff_users csu ON csu.id = ${effectiveStaffSql('c')}
         WHERE c.loan_id = ltl.id AND c.role = 'loan_officer'
         LIMIT 1
      ) ltoff ON true`;
}

/**
 * TRUE for a long-term document this mirror cannot file: the loan it belongs to
 * cannot name its own borrower, or cannot name a place (neither a property
 * address nor even a loan number).
 *
 * A missing OFFICER is deliberately NOT unresolved — the shared resolver already
 * has an honest answer for that (the clearly-labelled Unfiled area, which
 * upgrades itself into the real officer tree once one is assigned), and it is
 * the same answer an RTL file gets. Sharing the code means sharing that too.
 *
 * A loan id pointing at a loan that is not there resolves to NOT EXISTS, i.e.
 * unresolved — deliberate: `documents.lt_loan_id` is a bare uuid with no foreign
 * key (db/652: the gate forbids welding an RTL table to the side build), so a
 * dangling id is a real state and it must PARK, never churn.
 *
 * @param {string} ownerExpr SQL naming the lt_loan this document belongs to.
 */
function unresolvedSql(ownerExpr) {
  return `(${ownerExpr} IS NOT NULL AND NOT EXISTS (
        SELECT 1
          FROM lt_loans ltl
          LEFT JOIN lt_properties ltp ON ltp.loan_id = ltl.id
          LEFT JOIN borrowers     ltb ON ltb.id = ltl.borrower_id
         WHERE ltl.id = ${ownerExpr}
           AND ${BORROWER_NAME_SQL} IS NOT NULL
           AND (${ADDRESS_ONE_LINE_SQL} IS NOT NULL OR ${LOAN_NUMBER_SQL} IS NOT NULL)))`;
}

/**
 * The JS twin of `unresolvedSql`, over one enriched mirror row.
 *
 * Reads ONLY the lt_-prefixed identity columns the enrichment computes from the
 * expressions above — never the folder columns, which COALESCE an RTL owner in
 * front of them — so the two spellings are answering the same question about the
 * same facts.
 */
function identitiesResolved(row) {
  if (!row) return false;
  const name = String(row.lt_borrower_name || '').trim();
  const place = String(row.lt_address_one_line || '').trim() || String(row.lt_loan_number || '').trim();
  return !!name && !!place;
}

module.exports = {
  SCOPE,
  SCOPE_KEY_PREFIX,
  scopeKey,
  isScopeKey,
  OFFICER_SQL,
  BORROWER_FIRST_SQL,
  BORROWER_LAST_SQL,
  BORROWER_NAME_SQL,
  ADDRESS_ONE_LINE_SQL,
  LOAN_NUMBER_SQL,
  enrichJoinsSql,
  unresolvedSql,
  identitiesResolved,
};
