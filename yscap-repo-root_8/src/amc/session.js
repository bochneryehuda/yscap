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
// ONE wording for both desks — see src/lib/appraisal-messages.js.
const { nackMessage } = require('../lib/appraisal-messages');

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
    // WHY IT FAILED TRAVELS AS A CODE, NOT AS TEXT SOMEBODY LATER GREPS. `signInMessage`
    // has to tell three causes apart and used to do it by matching on these very
    // sentences, so rewording one of them silently changed what the desk was told.
    if (!a.loginAccount || !a.loginPassword || !a.subdomain) {
      const e = new Error('AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD / AMC_SUBDOMAIN are not all set');
      e.code = 'AMC_NOT_CONFIGURED';
      throw e;
    }
    const resp = await client.login(cdg.buildDoLogin({ loginAccount: a.loginAccount, loginPassword: a.loginPassword, subdomain: a.subdomain }));
    const key = cdg.parseDoLogin(resp);
    if (!key) {
      const err = cdg.parseError(resp);
      const e = new Error('AMC DoLogin failed: ' + (err ? (err.description || err.code) : 'no api key returned'));
      // They ANSWERED and turned us away — a different person fixes that from a
      // connection that never got there, so the two must not read alike.
      e.code = 'AMC_LOGIN_REJECTED';
      e.description = (err && err.description) || null;
      throw e;
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

/**
 * The identifiers every CDG message needs, with the api key resolved.
 *
 * `{ offline: true }` skips the sign-in entirely and returns the identifiers WITHOUT
 * an api key. That is what TEST MODE needs: a dry run builds the exact message and
 * sends nothing, so requiring a live AppraisalScope login to look at it is both
 * pointless and — on a tenant whose login is not set up yet — the reason a test click
 * used to fail. Anything built this way must never be posted; the transport's
 * `opts.dryrun` is what guarantees that.
 */
async function authContext(opts = {}) {
  const a = cfg.amc || {};
  return {
    apiKey: opts.offline ? null : await apiKey(),
    subdomain: a.subdomain,
    lenderIdentifier: a.lenderIdentifier,
    sourceClientId: a.sourceClientId,
  };
}

/**
 * Why we could not sign in, in words a non-developer can act on. Lives here, beside
 * the throw, so every caller of `authContext` says the same thing — the three real
 * causes need three different people, and "Something went wrong on our end" names
 * none of them.
 */
function signInMessage(e, opts = {}) {
  const code = String((e && e.code) || '');
  const raw = String((e && e.message) || '');
  // `savedDraft` is the order path's own reassurance, kept because it is the one
  // caller whose work really was written before the failure — telling somebody their
  // order is saved matters more than the tidiness of one shared sentence.
  const saved = opts.savedDraft ? ' The order was saved as a draft.' : '';
  if (code === 'AMC_DISABLED' || /AMC_DISABLED/.test(raw)) {
    return 'Appraisal ordering is switched off. Turn it on in API Health first.' + saved;
  }
  if (code === 'AMC_NOT_CONFIGURED' || /are not all set/.test(raw)) {
    return 'The appraisal company login isn’t set up yet, so nothing can be sent.' + saved
      + ' Turn on test mode to check this, or ask an admin to finish the connection.';
  }
  // THEIR OWN REFUSAL IS WORTH SHOWING — "Invalid credentials" tells somebody exactly
  // what to do — so it is framed and bounded by the shared wording, never pasted.
  if (code === 'AMC_LOGIN_REJECTED') {
    // THEIR TEXT ENDS WHERE WE SAY IT DOES. `nackMessage` closes on the vendor's own
    // words, which carry no full stop of their own, so appending to it ran two sentences
    // together: "…would not accept our sign-in: Invalid credentials The login details
    // need to be checked". Terminating it first is the whole fix; the vendor's fragment
    // still comes last within its own sentence.
    const said = nackMessage(e, 'our sign-in').replace(/[\s.]*$/, '.');
    return said + saved + ' The login details need to be checked or re-issued.';
  }
  // AND THE EXCEPTION'S OWN TEXT STOPS HERE. This used to end with
  // `' (' + raw.slice(0, 160) + ')'`, which put "AMC DoLogin failed: HTTP 502" and
  // "connect ECONNREFUSED 10.0.0.4:443" straight onto the appraisal desk — the exact
  // thing the rest of this change exists to prevent, and invisible to the refusal sweep
  // because it is a returned string rather than a `message:` key. The detail is in the
  // journal and the log, which every caller here already writes.
  return 'Could not reach the appraisal company to sign in, so nothing was sent.' + saved
    + ' Please try again in a moment.';
}

module.exports = { apiKey, invalidate, authContext, signInMessage };
