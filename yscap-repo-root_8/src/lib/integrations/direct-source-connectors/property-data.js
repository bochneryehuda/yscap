'use strict';
/**
 * Property Data direct-source connector — STUB.
 *
 * When configured (PROPERTY_DATA_PROVIDER + PROPERTY_DATA_KEY), fetch() would
 * call a vendor (CoreLogic / DataTree / ATTOM) for the file's property and
 * return:
 *   * property.address           — the recorded address
 *   * property.units             — recorded unit count
 *   * property.year_built        — recorded year built
 *   * property.zoning            — zoning code
 *   * title.liens                — recorded liens (mortgages, tax, judgments)
 *   * appraisal.arv (advisory)   — AVM estimate for cross-check
 *
 * Same api_verification source_type so the twin's reconciler treats these as
 * verified when they agree with the title/appraisal documents.
 */
const cfg = require('../../../config');

function configured() {
  return !!(cfg.propertyData && cfg.propertyData.provider && cfg.propertyData.key);
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'property-data provider + key not set' };
  return { ok: false, reason: 'property-data connector is a stub — implement fetch()' };
}

async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'property-data connector is a stub — add real HTTP call' };
}

module.exports = { configured, ping, fetch };
