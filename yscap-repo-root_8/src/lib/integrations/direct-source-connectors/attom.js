'use strict';
/**
 * ATTOM Data Solutions connector — STUB (Sovereign, API landscape Tier 1/2).
 *
 * When configured (ATTOM_API_KEY), fetch() should call ATTOM's property AVM +
 * property detail endpoints, returning:
 *   * appraisal.arv (via ATTOM's AVM value)
 *   * property.units / .year_built / .zoning / .last_sale_price / .last_sale_date
 *
 * ATTOM is BOTH an AVM source AND a property-intelligence source, so kind='avm'
 * lets the AVM consensus grab the ARV, and the property-detail fields flow to
 * the twin independently.
 */
const cfg = require('../../../config');
const KIND = 'avm';
function configured() { return !!(cfg.attom && cfg.attom.key); }
async function ping() {
  if (!configured()) return { ok: false, reason: 'ATTOM_API_KEY not set' };
  return { ok: false, reason: 'ATTOM connector is a stub — add /property/avm HTTP call' };
}
async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'ATTOM connector is a stub — add real HTTP call' };
}
module.exports = { configured, ping, fetch, kind: KIND };
