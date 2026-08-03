'use strict';
/**
 * ONE definition of "is this property already on the borrower's track record?"
 *
 * OWNER-REPORTED 2026-08-02: "one track record has twice the same address …
 * there is an issue why we have two addresses on the same."
 *
 * ROOT CAUSE: four writers each invented their own dedupe key, so the SAME
 * property arriving from two sources produced two different keys and therefore
 * two rows.
 *
 *   clickup/ingest.js  addrKey   lower-cased, every non-alphanumeric stripped.
 *                                No abbreviation, ordinal, ZIP+4 or country
 *                                handling — "26 S 10th St" and "26 South 10th
 *                                Street" are two different properties to it.
 *   encompass/enrich.js normAddr street types + directions mapped, country and
 *                                ZIP+4 dropped — better, and STILL not the same
 *                                string as the one above, and blind to ordinals
 *                                ("15 Ave" vs "15th Ave").
 *   the two tool-save routes     wrote NO address_key at all. They dedupe on
 *                                client_row_id, which is per tool session, so a
 *                                line re-entered next week is a fresh row.
 *   lib/address-heal.js          rewrites property_address into the canonical
 *                                mailing form and never recomputes the key, so
 *                                a healed row's key describes the OLD text.
 *
 * THE FIX IS A CHOKEPOINT, and it deliberately reuses what the repo already
 * settled on 2026-07-26: `address.sameAddress` is THE answer to "are these the
 * same place", and it already understands ordinals, unit keywords, USPS
 * abbreviations, ZIP-beats-city, house-number ranges and a missing unit.
 *
 * TWO LAYERS, and the split is the important part:
 *
 *   trackRecordKey()  is a GROUPING key (address.addressCompareKey —
 *                     house|street|zip). It is deliberately UNIT-FREE, because
 *                     one side routinely omits the unit; that makes it a good
 *                     net and a BAD verdict — two condo units in one building
 *                     share it.
 *   matchTrackRecord() is the VERDICT. It narrows by key, then confirms with
 *                     sameAddress on the addresses actually stored, which does
 *                     treat two different units as two different properties.
 *
 * So a writer nets candidates cheaply and then asks the one function that is
 * allowed to say yes. Never throws; an unreadable address yields '' / null,
 * which every caller must read as "cannot dedupe this" — never as a match.
 */

const ADDR = require('./address');

/**
 * The stored `track_records.address_key`. A GROUPING key, not an identity:
 * '' when the address cannot be read well enough to group on (no house number
 * or no street), in which case the row simply never joins a group.
 */
function trackRecordKey(address) {
  try { return ADDR.addressCompareKey(address) || ''; }
  catch (_) { return ''; }
}

/**
 * The verdict. Given the borrower's existing rows and an incoming address,
 * return the row that IS this property, or null.
 *
 * `rows` need only carry { id, property_address, address_key }. The key is used
 * as a fast pre-filter ONLY where both sides have one; a row whose stored key is
 * stale (written by one of the four old normalizers, or left behind by
 * address-heal) is still caught, because the confirmation reads the stored
 * ADDRESS rather than trusting the key. That is what makes the fix correct on
 * the very first deploy instead of only after the heal has drained.
 */
function matchTrackRecord(rows, address) {
  const key = trackRecordKey(address);
  if (!key) return null;                        // unreadable → never claim a match
  const list = Array.isArray(rows) ? rows : [];
  // Prefer a row whose key already agrees — cheapest and the common case.
  for (const r of list) {
    if (r && r.address_key && r.address_key === key && sameProperty(r.property_address, address)) return r;
  }
  // Then anything whose stored ADDRESS is the same place, whatever its key says.
  for (const r of list) {
    if (r && sameProperty(r.property_address, address)) return r;
  }
  return null;
}

/** sameAddress, but never throwing and never true on an unreadable side. */
function sameProperty(a, b) {
  try { return ADDR.sameAddress(a, b); } catch (_) { return false; }
}

module.exports = { trackRecordKey, matchTrackRecord, sameProperty };
