'use strict';
/**
 * Plaid direct-source connector — STUB.
 *
 * When configured (PLAID_CLIENT_ID + PLAID_SECRET), fetch() should call
 * Plaid's Assets API for the file's borrower and return:
 *   * assets.bank_account_owner  — the account owner names Plaid reports
 *   * assets.bank_ending_balance — the ending balance from the latest month
 *
 * Both observations feed the twin as `api_verification` — outranking any
 * bank_statement document observation for the same facts.
 *
 * TODAY (no key): configured() returns false; verifyFile() skips this
 * connector cleanly. The interface is stable so wiring the real API is a
 * one-file change.
 */
const cfg = require('../../../config');

function configured() {
  return !!(cfg.plaid && cfg.plaid.clientId && cfg.plaid.secret);
}

async function ping() {
  if (!configured()) return { ok: false, reason: 'PLAID_CLIENT_ID + PLAID_SECRET not set' };
  // Real implementation: POST to /institutions/get or similar low-cost health call.
  return { ok: false, reason: 'Plaid connector is a stub — set PLAID_CLIENT_ID + PLAID_SECRET and implement fetch()' };
}

async function fetch(/* appId, ctx */) {
  return { ok: false, reason: 'Plaid connector is a stub — add real HTTP call' };
}

module.exports = { configured, ping, fetch };
