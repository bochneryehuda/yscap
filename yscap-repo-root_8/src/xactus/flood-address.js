'use strict';
/**
 * src/xactus/flood-address.js — PURE property-address resolver for the Xactus flood
 * order (no DB), split out of flood-desk.js so it is unit-testable on its own.
 *
 * property_address arrives in several historical shapes (an object keyed by
 * line1/street, an object carrying only a composed oneLine/formatted string, or a
 * bare string). Recover {street, city, state, zip} from whatever shape the file
 * has — a flood determination is ordered on the property address.
 */
function clean(v) { return v == null ? '' : String(v).trim(); }

function resolveAddress(pa) {
  let parseAddress = null;
  try { parseAddress = require('../lib/address').parseAddress; } catch (_) { /* optional */ }
  const fromComposed = (s) => {
    if (!parseAddress || !clean(s)) return {};
    try { const p = parseAddress(s) || {}; return { street: clean(p.line1 || p.street), city: clean(p.city), state: clean(p.state), zip: clean(p.zip || p.postalCode) }; }
    catch (_) { return {}; }
  };
  if (!pa) return { street: '', city: '', state: '', zip: '' };
  if (typeof pa === 'string') { const c = fromComposed(pa); return { street: c.street || '', city: c.city || '', state: c.state || '', zip: c.zip || '' }; }
  let street = clean(pa.line1 || pa.address || pa.street || pa.streetAddress);
  let city = clean(pa.city);
  let state = clean(pa.state);
  let zip = clean(pa.zip || pa.postalCode || pa.postal_code);
  if (!street || !city || !state || !zip) {
    const c = fromComposed(pa.oneLine || pa.formatted_address || pa.formatted);
    street = street || c.street || '';
    city = city || c.city || '';
    state = state || c.state || '';
    zip = zip || c.zip || '';
  }
  return { street, city, state, zip };
}

function addressUsable(addr) { return !!(addr && addr.street && addr.city && addr.state && addr.zip); }

module.exports = { resolveAddress, addressUsable };
