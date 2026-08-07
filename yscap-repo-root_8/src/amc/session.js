'use strict';
/**
 * AMC session — owns the AppraisalScope `api_key` obtained from DoLogin.
 *
 * The OAuth Bearer token lives in src/amc/client.js; this is the second half of the
 * two-step auth: DoLogin returns an api_key that goes in the BODY of every subsequent
 * request. Cached in-memory with single-flight (like the token), refreshed on demand.
 *
 * Kept separate from the transport so client.js stays pure request/response and this
 * owns the credential lifecycle. `authContext()` is the one-call helper the higher-level
 * services (lookups, order builder) use to build a CDG message.
 */
const cfg = require('../config');
const cdg = require('./cdg');
const client = require('./client');

let _apiKey = { value: null, exp: 0 };
let _inflight = null;

async function apiKey() {
  const a = cfg.amc || {};
  // Lower-env fallback: an explicit api key with no DoLogin account configured.
  if (a.fallbackApiKey && !a.loginAccount) return a.fallbackApiKey;
  const now = Date.now();
  if (_apiKey.value && now < _apiKey.exp) return _apiKey.value;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    if (!a.loginAccount || !a.loginPassword || !a.subdomain) {
      throw new Error('AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD / AMC_SUBDOMAIN are not all set');
    }
    const resp = await client.login(cdg.buildDoLogin({ loginAccount: a.loginAccount, loginPassword: a.loginPassword, subdomain: a.subdomain }));
    const key = cdg.parseDoLogin(resp);
    if (!key) {
      const err = cdg.parseError(resp);
      throw new Error('AMC DoLogin failed: ' + (err ? (err.description || err.code) : 'no api key returned'));
    }
    // DoLogin doesn't state a TTL; reuse the lookup-refresh window as a conservative
    // session length. A stale key surfaces as a NACK on a later call, which invalidates.
    const ttlMs = Math.max(1, cfg.amc.lookupRefreshHours || 24) * 3600 * 1000;
    _apiKey = { value: key, exp: Date.now() + ttlMs };
    return key;
  })().finally(() => { _inflight = null; });
  return _inflight;
}

function invalidate() { _apiKey = { value: null, exp: 0 }; }

// The identifiers every CDG message needs, with the api key resolved.
async function authContext() {
  const a = cfg.amc || {};
  return {
    apiKey: await apiKey(),
    subdomain: a.subdomain,
    lenderIdentifier: a.lenderIdentifier,
    sourceClientId: a.sourceClientId,
  };
}

module.exports = { apiKey, invalidate, authContext };
