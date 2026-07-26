'use strict';

/**
 * PREVIOUS FILES REPAIR — rewrite addresses a geocoder display name leaked into.
 *
 * Owner-reported 2026-07-26: subject-property and home addresses across PILOT
 * had turned into the raw OpenStreetMap display name —
 *   "26, South 10th Street, Williamsburg, Brooklyn, Kings County, New York,
 *    11249, United States"
 * — instead of the mailing form ClickUp shows:
 *   "26 S 10th St, Brooklyn, NY 11249, USA".
 *
 * Root cause is fixed at the source (lib/address-canon builds the mailing form
 * from components instead of storing `display_name`; the ClickUp push and the
 * inbound parser both compact whatever they are handed). This pass cleans up
 * what the old code already wrote — the owner's "previous AND future" rule —
 * across every address jsonb we keep:
 *   applications.property_address, borrowers.current_address / prior_address,
 *   track_records.property_address, leads.property_address,
 *   plus the permanent geocode cache (address_canon_cache) so a cached long
 *   form can never be handed back out.
 *
 * Only a record whose one-line IS a provider long form is touched — a clean
 * address is left byte-for-byte alone (canonicalizeAddressValue returns null),
 * so the pass is idempotent and a fast no-op on every later boot. Never throws:
 * a repair failure must not stop the server coming up.
 */
const db = require('../db');
const ADDR = require('./address');

// SQL PREFILTER only — cheap, deliberately loose. `canonicalizeAddressValue` in
// JS is the authority on what is actually a long form and what gets rewritten.
const LONG_FORM_RE = '(county|united states)';
const suspectText = (expr) => `(${expr} ~* '${LONG_FORM_RE}' OR ${expr} ~ '^[0-9]+[A-Za-z]?, ')`;
// Both storage shapes: the normal object, and the legacy bare-string address
// (jsonb_typeof = 'string', read with #>>'{}').
const suspect = (col) => `(`
  + suspectText(`${col}->>'formatted_address'`) + ` OR ` + suspectText(`${col}->>'oneLine'`)
  + ` OR ` + suspectText(`${col}->>'line1'`)
  + ` OR (jsonb_typeof(${col}) = 'string' AND ` + suspectText(`${col}#>>'{}'`) + `))`;

const TARGETS = [
  { table: 'applications', col: 'property_address' },
  { table: 'borrowers', col: 'current_address' },
  { table: 'borrowers', col: 'prior_address' },
  { table: 'track_records', col: 'property_address' },
  { table: 'leads', col: 'property_address' },
];

/** Repair one table.column. Returns the number of rows rewritten. */
async function healColumn({ table, col }, limit) {
  let fixed = 0;
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, ${col} AS addr FROM ${table}
        WHERE ${col} IS NOT NULL AND jsonb_typeof(${col}) IN ('object','string') AND ${suspect(col)}
        LIMIT $1`, [limit])).rows;
  } catch (e) {
    // A table that doesn't exist yet (fresh DB mid-migration) is not an error.
    return 0;
  }
  for (const r of rows) {
    let next = null;
    try { next = ADDR.canonicalizeAddressValue(r.addr); } catch (_) { next = null; }
    if (!next) continue;   // clean already, or nothing we can improve
    try {
      // Re-check the stored value inside the UPDATE so a concurrent human edit
      // between the read and the write is never clobbered. Compare as jsonb, not
      // as text: jsonb::text re-orders keys and re-spaces, so a text compare
      // against JSON.stringify() never matches and the repair silently no-ops.
      const w = await db.query(
        `UPDATE ${table} SET ${col} = $2::jsonb WHERE id = $1 AND ${col} = $3::jsonb`,
        [r.id, JSON.stringify(next), JSON.stringify(r.addr)]);
      fixed += w.rowCount || 0;
    } catch (_) { /* best effort, row by row */ }
  }
  return fixed;
}

/** Repair the permanent geocode cache so an old row can't re-poison a push. */
async function healGeocodeCache(limit) {
  let fixed = 0;
  let rows;
  try {
    rows = (await db.query(
      `SELECT input_key, formatted FROM address_canon_cache
        WHERE formatted IS NOT NULL AND (formatted ~* '${LONG_FORM_RE}' OR formatted ~ '^[0-9]+[A-Za-z]?, ')
        LIMIT $1`, [limit])).rows;
  } catch (_) { return 0; }
  for (const r of rows) {
    let next = null;
    try { next = ADDR.compactFormattedAddress(r.formatted); } catch (_) { next = null; }
    if (!next || next === r.formatted) continue;
    try {
      const w = await db.query(
        `UPDATE address_canon_cache SET formatted=$2 WHERE input_key=$1 AND formatted=$3`,
        [r.input_key, next, r.formatted]);
      fixed += w.rowCount || 0;
    } catch (_) { /* best effort */ }
  }
  return fixed;
}

/**
 * One bounded pass. Idempotent and self-draining: repaired rows stop matching
 * the prefilter, so a backlog larger than `limit` finishes over later boots.
 */
async function healProviderLongAddressesOnce({ limit = 2000 } = {}) {
  const out = { fixed: 0, byColumn: {} };
  for (const t of TARGETS) {
    const n = await healColumn(t, limit);
    if (n) { out.byColumn[`${t.table}.${t.col}`] = n; out.fixed += n; }
  }
  const cache = await healGeocodeCache(limit);
  if (cache) { out.byColumn['address_canon_cache.formatted'] = cache; out.fixed += cache; }
  return out;
}

module.exports = { healProviderLongAddressesOnce, healColumn, healGeocodeCache, TARGETS };
