'use strict';

/**
 * PREVIOUS FILES REPAIR — a public-records track-record line stored its address
 * as a bare one-line STRING, not the canonical object.
 *
 * Owner-reported: a track-record line "brought on from the public records" showed
 * "(no address)" and raised "Property address is required." on the tool. ROOT
 * CAUSE: elementix `shapes.js` flattens a deed's `addresses[{addressFull}]` to a
 * one-line string, `importer.firstAddress` carried that string through, and
 * `importNew` stored it verbatim — but every reader (the tool bridge
 * `propFromRow`, the to-do `addressOf`) expects `{ line1, city, state, zip,
 * oneLine }`, and a JS string has none of those keys. The tool / ClickUp /
 * Encompass writers already stored the object; the importer was the one door
 * that did not.
 *
 * The importer is fixed at the source (it now stores the object). This pass
 * reshapes the rows it already wrote — the owner's "previous AND future" rule.
 * Parsing a one-line address is `address.parseAddress` (JS), so this is a JS boot
 * heal rather than a SQL migration, for the same reason `address-heal` /
 * `name-heal` are: a PL/pgSQL twin of the parser would drift from the live one.
 *
 * Bounded, self-draining (a reshaped row's `jsonb_typeof` becomes 'object' and
 * stops matching the prefilter, so a backlog larger than `limit` finishes over
 * later boots), and never throws — a repair failure must not stop the server
 * coming up. `oneLine` keeps the verbatim stored text, so `address_key` (keyed
 * off that text) is unchanged and is deliberately left in place.
 */
const db = require('../db');
const ADDR = require('./address');

async function healTrackRecordAddressShapeOnce({ limit = 2000 } = {}) {
  let fixed = 0;
  let rows;
  try {
    rows = (await db.query(
      `SELECT id, property_address #>> '{}' AS s FROM track_records
        WHERE jsonb_typeof(property_address) = 'string'
        LIMIT $1`, [limit])).rows;
  } catch (_) {
    // A fresh DB mid-migration (table absent) is not an error.
    return { fixed: 0 };
  }
  for (const r of rows) {
    let obj = null;
    try { obj = ADDR.parseToAddressObject(r.s); } catch (_) { obj = null; }
    if (!obj) continue;
    try {
      // Re-check the value is still the same string inside the UPDATE, so a
      // concurrent human edit between the read and the write is never clobbered.
      const w = await db.query(
        `UPDATE track_records SET property_address = $2::jsonb, updated_at = now()
          WHERE id = $1 AND jsonb_typeof(property_address) = 'string'
            AND property_address #>> '{}' = $3`,
        [r.id, JSON.stringify(obj), r.s]);
      // Only count an actual write — a concurrent sibling instance may have
      // reshaped this row between the read and here (the guard matched 0 rows).
      fixed += w.rowCount || 0;
    } catch (_) { /* best effort, row by row */ }
  }
  return { fixed };
}

module.exports = { healTrackRecordAddressShapeOnce };
