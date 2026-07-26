'use strict';
/**
 * Xactus direct-source connector — STUB.
 *
 * When configured (XACTUS_ACCOUNT + XACTUS_USER + XACTUS_PASSWORD), fetch()
 * would call Xactus (formerly CreditPlus) for the file's borrower and return:
 *   * borrower.fico                     — the tri-merge middle score
 *   * compliance.ofac_subject_name      — screened subject
 *   * compliance.ofac_result            — clear / potential / confirmed
 *   * background reports + fraud alerts as separate observations
 *
 * Same api_verification source_type so the twin reconciler treats these as
 * outranking credit_report / background_report document observations.
 */
const cfg = require('../../../config');

function configured() {
  return !!(cfg.xactus && cfg.xactus.account && cfg.xactus.user && cfg.xactus.password);
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'Xactus credentials not set' };
  return { ok: false, reason: 'Xactus connector is a stub — implement fetch()' };
}

async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'Xactus connector is a stub — add real HTTP call' };
}

module.exports = { configured, ping, fetch };
