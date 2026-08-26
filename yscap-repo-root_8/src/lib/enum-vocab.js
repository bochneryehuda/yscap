'use strict';
/**
 * ONE VOCABULARY FOR THE FOUR CROSSWALKED DEAL ENUMS — the public marketing form
 * speaks a dialect, and the rest of the system does not understand it.
 *
 * OWNER-REPORTED 2026-08-26, file YSCAP258134859 (598 Pawling Ave, Troy NY):
 * *"This is a fix and hold, not a fix and flip, but it was not filled in ClickUp
 * as a fix and hold. I think the program field was empty. Check it out … Check
 * out the actual dropdown that is available in ClickUp through the connector."*
 *
 * WHAT THE CONNECTOR ACTUALLY SHOWED. The ClickUp `*Program` dropdown DOES carry
 * "Fix & Hold With Construction" (the owner added it 2026-07-27) and the
 * crosswalk maps our canonical 'Fix & Hold' onto it correctly, in both
 * directions. So the mapping was never the problem. The problem is what the file
 * was carrying: it came in through the PUBLIC loan application, whose
 * `<option value>` attributes were written for DISPLAY and never made the values
 * the system stores. `intake.js` files them RAW, so the row held
 * 'Fix & Hold (BRRRR)' — a spelling the crosswalk has no key for — and the push
 * dropped the field IN SILENCE, exactly as the enum-guard module describes.
 *
 * IT IS FOUR FIELDS, NOT ONE. Measured against the live dropdowns, of the public
 * form's own options: program 3 of 4 unmappable, loan type 2 of 3 (BOTH
 * refinances), property type 5 of 7, rehab type 2 of 5. A borrower applying for a
 * cash-out refinance on a 2–4 unit with a heavy rehab produced a card with all
 * four fields blank, and the team filled them in by hand.
 *
 * THE ROOT CAUSE is that `applications.program` (and its three siblings) has
 * several producers writing several vocabularies while everything downstream —
 * the ClickUp push, `change-requests.ALLOWED`, the Encompass field map, the tape
 * gate — keys on ONE of them. The form is not "wrong" in isolation; it is the
 * only producer that was never pointed at the shared vocabulary.
 *
 * WHY THE FIX IS HERE AND NOT IN THE FORM. Changing the form's option VALUES
 * looks like the obvious repair and is the riskiest one available: those exact
 * strings are compared in a dozen places in the page's own script, and three of
 * those comparisons feed the FROZEN pricing engine (`snStrategy`,
 * `propTypeToken`, `heavyRehab`, `sqftAddition`). A single missed comparison
 * silently changes what the marketing site QUOTES. So the form keeps its display
 * dialect and the value is canonicalized where it crosses into our storage — the
 * boundary, which is also where the repo's standing rule puts it ("a value must
 * fit its column, and the COLUMN decides — never the door").
 *
 * TWO LAYERS, DELIBERATELY, because they fix different populations:
 *   1. `canonicalEnum` at the INTAKE door — every new application stores the
 *      canonical spelling, so every downstream reader agrees from the first day.
 *   2. the same table consulted by `crosswalk.toClickUpLabel` — so the rows
 *      ALREADY holding a dialect push correctly on their next push, with NO
 *      column rewrite. That matters: `program` / `property_type` / `loan_type`
 *      are pricing inputs watched by db/071/072, so rewriting them in bulk would
 *      reopen Products & Pricing and un-sign live term sheets across the book
 *      for a change that moves no number.
 *
 * NOTHING IS EVER GUESSED. An unrecognised value is returned UNCHANGED — never
 * blanked, never mapped to a neighbour. A value with no ClickUp twin at all
 * (`DSCR / Rental`, `PUD`) is left alone and handled where it already is, by
 * `inbound-enum-guard` + `crosswalk.unmappableToClickUp`, which keep it in PILOT
 * and park a review saying so.
 *
 * PROVEN PRICE-NEUTRAL. Every alias below is read by the frozen engines through
 * `pricing.js engineStrategy` / `normPropertyType` and by
 * `deal-basis.sizesOnAsIsValue`, and the test runs each alias and its canonical
 * twin through those functions and asserts they answer identically — so
 * canonicalizing changes which LABEL is stored and nothing about what is priced.
 *
 * PURE — no database, no config, no requires. Every rule is unit-testable.
 */

/* Alias → canonical, per `applications` column. The CANONICAL side must be a key
   the ClickUp crosswalk's own `to` map carries (asserted by the test against
   `crosswalk.FIELDS`, so this table can never invent a value the push cannot
   translate). Keys are matched case- and whitespace-insensitively, and with the
   dash family folded, because an en-dash and a hyphen are the same word to a
   human and the two spellings are both live in this codebase.

   WHERE EACH ALIAS COMES FROM is recorded beside it — an alias with no producer
   is a guess, and the test requires every marketing-form option to appear here. */
const ALIASES = Object.freeze({
  program: Object.freeze({
    // web/v2/tools/loan-application.html #dealType
    'fix & flip': 'Fix & Flip w/ Construction',
    'fix & hold (brrrr)': 'Fix & Hold',
    'brrrr': 'Fix & Hold',
    'bridge / stabilized': 'Bridge',
    'ground-up construction': 'Ground-Up Construction',   // case only
    // app-v2/src/screens/StaffNewFile.jsx used this spelling; the canonical one
    // is 'DSCR / Rental' (enums.js, change-requests.ALLOWED). It still has no
    // ClickUp twin — that is a separate, already-handled fact.
    'dscr rental': 'DSCR / Rental',
    'dscr': 'DSCR / Rental',
    // Spellings the engine already treats as fix & hold.
    'fix & hold with construction': 'Fix & Hold',
    'fix and hold': 'Fix & Hold',
    'fix & hold w/ construction': 'Fix & Hold',
    'fix & flip with construction': 'Fix & Flip w/ Construction',
    'fix and flip': 'Fix & Flip w/ Construction',
  }),
  loan_type: Object.freeze({
    // web/v2/tools/loan-application.html radio name="purpose"
    'cash-out refi': 'Refinance — Cash-Out',
    'rate & term refi': 'Refinance — Rate & Term',
    // Other spellings in circulation.
    'refi cash-out': 'Refinance — Cash-Out',
    'refi rate & term': 'Refinance — Rate & Term',
    'refinance - cash-out': 'Refinance — Cash-Out',
    'refinance - rate & term': 'Refinance — Rate & Term',
  }),
  property_type: Object.freeze({
    // web/v2/tools/loan-application.html #propType
    'single-family (sfr)': 'SFR (1 unit)',
    'sfr': 'SFR (1 unit)',
    '2-4 unit': 'Multi 2–4',
    'multi 2-4': 'Multi 2–4',
    'multifamily 5+': 'Multi 5+',
    'mixed-use': 'Mixed use',
    'mixed use': 'Mixed use',       // the ClickUp label's casing, written by the completeness panel
    'multi 5+': 'Multi 5+',         // (identical after folding; listed so the panel's list is covered explicitly)
    // 'PUD' is DELIBERATELY absent: the live ClickUp dropdown has no PUD option,
    // and folding it into Townhouse or SFR would file a different property type
    // than the borrower chose. It stays as typed and reads as unmappable.
  }),
  rehab_type: Object.freeze({
    // web/v2/tools/loan-application.html #rehabType — note these send the
    // CLICKUP label, not our portal value, which is why they dropped.
    'heavy': 'Heavy / gut rehab',
    'ground-up': 'Ground-up construction',
    'adding sf': 'Adding square footage',
    'gut': 'Heavy / gut rehab',
    'heavy / gut': 'Heavy / gut rehab',
  }),
});

/* Fold a spelling to its lookup key: trimmed, lower-cased, every dash-family
   character reduced to a plain hyphen and runs of whitespace collapsed. The dash
   fold is load-bearing — the portal writes 'Multi 2–4' with an EN DASH and every
   other producer writes a hyphen, and CLAUDE.md already records that exact
   character costing a day. */
function key(v) {
  return String(v == null ? '' : v)
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/* The canonical spelling of `raw` for `column`, or `raw` UNCHANGED when we do not
   recognise it. Never blanks, never throws, never guesses. */
function canonicalEnum(column, raw) {
  if (raw == null || raw === '') return raw;
  const table = ALIASES[column];
  if (!table) return raw;
  const hit = table[key(raw)];
  return hit === undefined ? raw : hit;
}

/* Did canonicalEnum actually change anything? Callers that want to audit or log a
   normalization ask this rather than comparing strings themselves. */
function wasAliased(column, raw) {
  const out = canonicalEnum(column, raw);
  return out !== raw;
}

/* Every column this module knows about — used by the guard test and by any caller
   that wants to canonicalize a whole patch without hard-coding the list. */
const COLUMNS = Object.freeze(Object.keys(ALIASES));

module.exports = { canonicalEnum, wasAliased, COLUMNS, ALIASES, _internals: { key } };
