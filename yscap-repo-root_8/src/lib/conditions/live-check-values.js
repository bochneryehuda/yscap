'use strict';
/**
 * WHAT A CHECK CONSTRAINT ACTUALLY ADMITS, READ OUT OF THE DATABASE ITSELF.
 *
 * A value set written down in JavaScript beside a column is a COPY, and a copy
 * nothing checks is the copy that drifts: a migration narrows the column, the
 * constant stays, and the first thing anybody hears about it is a check
 * violation on somebody's file. This reads the real thing — one read-only query
 * against `pg_constraint`, the database's own catalogue — so a build-time check
 * can be run against the constraint that is genuinely in force rather than
 * against a copy of it.
 *
 * IT IS NOT PRODUCT CODE and touches no product's tables: `pg_constraint` is
 * Postgres's own catalogue, exactly like `information_schema`, which this repo
 * already reads to enumerate foreign keys (`borrower-merge.js`) and to hold the
 * numeric-column bounds table honest (`test-column-bounds-doors-db.js`).
 *
 * IT NEVER THROWS, AND ABSENCE IS NOT EMPTINESS. A constraint it cannot read is
 * simply not in the result — never an empty array, which a caller would read as
 * "this column admits nothing" and refuse every value there is. The caller falls
 * back to its own declared set, which degrades to the pure check rather than
 * failing for the wrong reason.
 */

/**
 * The quoted text literals a CHECK's rendered definition names.
 *
 * `pg_get_constraintdef` renders an enumerated CHECK as
 * `CHECK ((col = ANY (ARRAY['a'::text, 'b'::text])))`, so the quoted literals
 * ARE the accepted set. A doubled `''` inside one is SQL's own escape for a
 * single quote and is unescaped here.
 *
 * PURE — exported on its own so the parsing can be unit-tested with no database.
 */
function valuesInConstraintDef(def) {
  return [...String(def == null ? '' : def).matchAll(/'((?:[^']|'')*)'::text/g)]
    .map((m) => m[1].replace(/''/g, "'"));
}

/**
 * Read several CHECK constraints at once.
 *
 * @param {object} client — anything with `.query`, so a caller inside a
 *   transaction asks its OWN connection rather than a different snapshot.
 * @param {string[]} names — constraint names, as `pg_constraint.conname`.
 * @returns {Promise<Object<string,string[]>>} name → accepted values, omitting
 *   any constraint that could not be read or that names no literals.
 */
async function liveCheckValues(client, names) {
  const out = {};
  const want = (names || []).map((n) => String(n)).filter(Boolean);
  if (!want.length || !client || typeof client.query !== 'function') return out;
  try {
    const { rows } = await client.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def
         FROM pg_constraint WHERE conname = ANY($1::text[])`, [want]);
    for (const r of rows || []) {
      const vals = valuesInConstraintDef(r.def);
      if (vals.length) out[r.conname] = vals;
    }
  } catch (_) { /* an unreadable catalogue leaves the caller on its declared sets */ }
  return out;
}

module.exports = { liveCheckValues, valuesInConstraintDef };
