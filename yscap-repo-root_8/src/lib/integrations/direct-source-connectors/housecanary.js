'use strict';
/**
 * HouseCanary direct-source connector — STUB (Sovereign, blueprint API landscape Tier 1).
 *
 * When configured (HOUSECANARY_KEY + HOUSECANARY_SECRET), fetch() should call:
 *   * value_report — automated valuation model, returns { price_upper, price_mean, price_lower }
 *   * rental_avm  — rent estimate for DSCR
 *
 * Both flow to the twin as api_verification observations:
 *   * appraisal.arv          ← price_mean
 *   * appraisal.market_rent  ← rent_mean
 *
 * Interface: configured() / ping() / fetch(appId, ctx) — matches every other
 * direct-source stub (Plaid, property-data, Xactus). Returns
 * `kind: 'avm'` so the AVM consensus module can filter to the AVM connectors.
 *
 * TODAY (no key): configured() returns false; hub.verifyFile skips this
 * connector cleanly. Real HTTP is a one-file change when the key arrives.
 */
const cfg = require('../../../config');

const KIND = 'avm';

function configured() {
  return !!(cfg.houseCanary && cfg.houseCanary.key && cfg.houseCanary.secret);
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'HOUSECANARY_KEY + HOUSECANARY_SECRET not set' };
  return { ok: false, reason: 'HouseCanary connector is a stub — add /property/value_report HTTP call' };
}

async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'HouseCanary connector is a stub — add real HTTP call' };
}

module.exports = { configured, ping, fetch, kind: KIND };
