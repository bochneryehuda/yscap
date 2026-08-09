'use strict';
/**
 * A ROW ID THAT WILL FIT ITS COLUMN — the one definition, for every desk.
 *
 * `parseInt` is the wrong tool for a `bigint` primary key and fails in three ways that
 * all end at the same place: the route's catch-all turns a Postgres error into a 500,
 * which reads to the user as "PILOT is broken" rather than "no such order".
 *
 *   parseInt('99999999999999999999')  -> 1e20   — passes Number.isInteger, then
 *                                                 overflows the bind (Postgres 22003)
 *   parseInt('12abc')                 -> 12     — silently a DIFFERENT row
 *   parseInt(' 12')                   -> 12     — and `trim()` is not Postgres's trim:
 *                                                 it removes a non-breaking space,
 *                                                 Postgres does not, so a gate that
 *                                                 trims and a query that does not can
 *                                                 be looking at two different strings.
 *
 * So this neither parses nor trims. It accepts only a plain run of digits inside the
 * signed 64-bit range and returns THE STRING — pass that value downstream rather than
 * the raw parameter, and the check and the query can never disagree.
 *
 * Returns null for anything else; the caller answers 404, because "not a row id" and
 * "no such row" are the same answer to whoever asked.
 */
const MAX_BIGINT = 9223372036854775807n;

function bigintId(v) {
  const s = String(v == null ? '' : v);
  if (!/^[0-9]{1,19}$/.test(s)) return null;
  const n = BigInt(s);
  return n > 0n && n <= MAX_BIGINT ? s : null;
}

module.exports = { bigintId, MAX_BIGINT };
