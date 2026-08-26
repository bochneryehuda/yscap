'use strict';
/**
 * FINDING A FILE BY WHAT A PERSON TYPES — one definition, every queue.
 *
 * Owner-directed 2026-08-26, on the exception workflow: *"merge everything into
 * one place with filters for exceptions … search by loan number, by address …
 * filter by statuses."* The merge and the status/type filters shipped
 * 2026-07-31 (the Approvals hub); the SEARCH did not exist anywhere in it, so a
 * queue of a hundred rows could only be scrolled.
 *
 * AND THE ADDRESS HALF WAS ALREADY BROKEN WHERE IT DID EXIST. The global
 * omnibox matched an address against `property_address->>'oneLine'` alone —
 * MEASURED on the live shape: of 319 files carrying an address, only **137**
 * hold a `oneLine` key at all. The public marketing form and the staff new-file
 * form both store `{line1, city, state, zip}` (and older rows use `street`), so
 * **57% of files could not be found by their own address**, silently — the
 * search simply returned nothing and looked like "no such file". Composing the
 * haystack from whichever parts a row actually holds resolves **316 of 319**.
 *
 * PURE — it returns SQL TEXT and a parameter VALUE; it never touches a database,
 * so every rule here is unit-testable and no caller can be surprised by a query
 * it did not write.
 */

/* THE ADDRESS HAYSTACK. `oneLine` when the row has one (it is the canonical,
   already-formatted string), otherwise composed from the parts — accepting BOTH
   `line1` and `street`, because both spellings are live in this table and a
   search that knows only one of them is the bug this exists to fix. Kept as a
   single expression so a caller cannot half-adopt it. */
function ADDRESS_TEXT_SQL(alias = 'a') {
  const p = `${alias}.property_address`;
  return `COALESCE(
            NULLIF(${p}->>'oneLine',''),
            NULLIF(concat_ws(', ',
              COALESCE(NULLIF(${p}->>'line1',''), ${p}->>'street'),
              ${p}->>'city', ${p}->>'state', ${p}->>'zip'), ''),
            '')`;
}

/* WHAT A TYPED STRING BECOMES ON THE WIRE — or null when there is nothing to
   search for.

   THE ESCAPING IS NOT DECORATION: `%` and `_` are LIKE wildcards, so a person
   typing "100%" would otherwise match every row in the queue, and a `\` would
   swallow the character after it. Postgres' default LIKE escape IS the
   backslash, and a bound PARAMETER is not re-parsed for escapes, so escaping
   here and binding the result works with a plain ILIKE and no ESCAPE clause
   (verified against a real Postgres, both directions).

   A single character is refused: on a queue keyed to loan numbers and addresses
   it matches nearly everything, which reads as "the search is broken". */
function likeParam(raw, { min = 2, max = 80 } = {}) {
  const s = String(raw == null ? '' : raw).trim();
  if (s.length < min) return null;
  const escaped = s.slice(0, max).replace(/([\\%_])/g, '\\$1');
  return `%${escaped}%`;
}

/* THE ONE SEARCH PREDICATE for an approvals queue: the file's LOAN NUMBER, its
   ADDRESS, or the BORROWER's name. `$${idx}` is the caller's own parameter
   position — the value is always bound, never interpolated.

   The borrower name is matched on the parts rather than on `full_name`, because
   that column is a GENERATED one and is only as complete as the parts; matching
   both halves separately also lets "scharf" find a person whose first name is
   stored with a middle name attached. */
function fileSearchSql(idx, { app = 'a', borrower = 'b' } = {}) {
  const p = `$${idx}`;
  return `(
      COALESCE(${app}.ys_loan_number,'')            ILIKE ${p}
   OR ${ADDRESS_TEXT_SQL(app)}                      ILIKE ${p}
   OR COALESCE(${borrower}.first_name,'')           ILIKE ${p}
   OR COALESCE(${borrower}.last_name,'')            ILIKE ${p}
   OR COALESCE(${borrower}.first_name,'') || ' ' || COALESCE(${borrower}.last_name,'') ILIKE ${p}
  )`;
}

module.exports = { ADDRESS_TEXT_SQL, likeParam, fileSearchSql };
