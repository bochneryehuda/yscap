'use strict';
/**
 * Clear Capital ClearAVM direct-source connector — STUB (Sovereign, API
 * landscape Tier 1).
 *
 * When configured (CLEARCAPITAL_KEY), fetch() should return the ClearAVM
 * value estimate for the file's property, fed to the twin as an
 * api_verification observation of appraisal.arv. Independent from HouseCanary
 * so the AVM consensus is a real triangulation, not two views of the same data.
 */
const cfg = require('../../../config');
const KIND = 'avm';
function configured() { return !!(cfg.clearCapital && cfg.clearCapital.key); }
async function ping() {
  if (!configured()) return { ok: false, reason: 'CLEARCAPITAL_KEY not set' };
  return { ok: false, reason: 'Clear Capital connector is a stub — add ClearAVM HTTP call' };
}
async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'Clear Capital connector is a stub — add real HTTP call' };
}
module.exports = { configured, ping, fetch, kind: KIND };
