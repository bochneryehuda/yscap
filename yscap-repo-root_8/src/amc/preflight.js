'use strict';
/**
 * AMC credential preflight — prove the CoreLogic / AppraisalScope credentials work,
 * WITHOUT placing an order.
 *
 * Section 7 of docs/AMC-APPRAISALSCOPE-INTEGRATION.md lists what the vendor has to
 * issue before any of this can run. The moment a credential lands, the question is
 * always the same: "is it the right credential, and does it reach the right tenant?"
 * This module answers that in four escalating steps, each of which isolates ONE
 * credential so a failure names the thing that is wrong instead of "it didn't work":
 *
 *   1. inventory  — which AMC_* variables are set, which are missing, what each is FOR
 *   2. token      — AMC_CLIENT_ID / AMC_CLIENT_SECRET, via OAuth GetToken
 *   3. login      — AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD / AMC_SUBDOMAIN, via DoLogin
 *   4. lookup     — the tenant really answers: a read-only GetLoanType / GetJobType
 *
 * It goes through the REAL transport (src/amc/client.js) and the REAL session
 * (src/amc/session.js) on purpose. A preflight that re-implements the request proves
 * only that the re-implementation works; this one fails exactly where production
 * would fail.
 *
 * READ-ONLY BY CONSTRUCTION. Every call it makes is a read (`client.read` / `client.login`),
 * and the runner additionally forces the outbound write gate OFF in-process, so a
 * preflight can never place a billable order even if someone runs it with
 * AMC_OUTBOUND_ENABLED=1 in the environment.
 *
 * NOTHING here prints a secret. Values are reported through `mask()` — a length and
 * the last few characters, enough to tell two credentials apart in a screenshot,
 * never enough to use one.
 *
 * The diagnosis half (inventory, mask, classify) is pure and dependency-free so it is
 * unit-tested by scripts/test-amc-preflight-pure.js; only `run()` touches the network.
 */

// ---------------------------------------------------------------------------
// What each credential is for, and which step it gates. Order matters — this is
// the order the report prints in, and it walks auth from outside in.
// ---------------------------------------------------------------------------
const CREDENTIALS = [
  { env: 'AMC_CLIENT_ID', cfgKey: 'clientId', step: 'token', required: true,
    what: 'OAuth client id (CoreLogic Digital Gateway "GetToken")' },
  { env: 'AMC_CLIENT_SECRET', cfgKey: 'clientSecret', step: 'token', required: true, secret: true,
    what: 'OAuth client secret' },
  { env: 'AMC_LOGIN_ACCOUNT', cfgKey: 'loginAccount', step: 'login', required: true,
    what: 'AppraisalScope user the orders are placed AS (DoLogin loginAccountIdentifier)' },
  { env: 'AMC_LOGIN_PASSWORD', cfgKey: 'loginPassword', step: 'login', required: true, secret: true,
    what: 'that user\'s password (DoLogin loginAccountPassword)' },
  { env: 'AMC_SUBDOMAIN', cfgKey: 'subdomain', step: 'login', required: true,
    what: 'our AppraisalScope tenant, e.g. "integrations.uat" (ServiceProviderSubDomain)' },
  { env: 'AMC_LENDER_IDENTIFIER', cfgKey: 'lenderIdentifier', step: 'order', required: true,
    what: 'the GGID — CoreLogic\'s lender id, e.g. GG000000 (DigitalGatewayLenderIdentifier)' },
  // OPTIONAL: the vendor (Tony Pham, 2026-08-11) confirmed there is no such credential
  // for this tenant — DoLogin issues an api_key without it and no auth / lookup / status /
  // comment / revision / document call carries it. Only CreateAppraisal references it, and
  // the builder (src/amc/cdg.js) omits sourceInformation entirely when it is unset, so an
  // order is valid without it. Left settable in case a future tenant is issued one.
  { env: 'AMC_SOURCE_CLIENT_ID', cfgKey: 'sourceClientId', step: 'order', required: false,
    what: 'OPTIONAL — our client/user id inside AppraisalScope (sourceInformation.sourceClientIdentifier); not issued for this tenant' },
  { env: 'AMC_FALLBACK_APIKEY', cfgKey: 'fallbackApiKey', step: 'login', required: false, secret: true,
    what: 'UAT-only: a pre-issued api_key that skips DoLogin entirely' },
];

const ENDPOINTS = [
  { env: 'AMC_OAUTH_URL', cfgKey: 'oauthUrl', what: 'OAuth GetToken' },
  { env: 'AMC_LOGIN_URL', cfgKey: 'loginUrl', what: 'DoLogin' },
  { env: 'AMC_ORDER_URL', cfgKey: 'orderUrl', what: 'lookups / create / status' },
  { env: 'AMC_POSTDOCUMENTS_URL', cfgKey: 'postDocumentsUrl', what: 'document upload' },
];

/**
 * Mask a credential for display: never the value, always enough to TELL TWO APART.
 * A short value is fully hidden — showing the tail of a 6-character password would
 * give most of it away.
 */
function mask(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  if (s.length <= 8) return `(${s.length} chars, hidden)`;
  return `(${s.length} chars, …${s.slice(-4)})`;
}

/** Does this URL point at a UAT host, a production host, or something unrecognized? */
function environmentOf(url) {
  const u = String(url || '').toLowerCase();
  if (!u) return 'unset';
  if (/\buat\b|-uat|uat\d/.test(u)) return 'UAT';
  // cotality.com is CoreLogic's new name (rebrand, 2026) — both domains serve the
  // same gateway, so a non-UAT host on either one reads as PRODUCTION.
  if (/corelogic\.com|cotality\.com/.test(u)) return 'PRODUCTION';
  return 'custom';
}

/**
 * The credential inventory: what is set, what is missing, and which steps can run.
 * Pure — takes the resolved cfg.amc object, touches no network and no env directly.
 */
function inventory(amc) {
  const a = amc || {};
  const credentials = CREDENTIALS.map((c) => ({
    env: c.env,
    what: c.what,
    step: c.step,
    required: c.required,
    set: a[c.cfgKey] != null && a[c.cfgKey] !== '',
    display: c.secret ? mask(a[c.cfgKey]) : (a[c.cfgKey] || null),
  }));
  const endpoints = ENDPOINTS.map((e) => ({
    env: e.env, what: e.what, url: a[e.cfgKey] || null, environment: environmentOf(a[e.cfgKey]),
  }));

  const isSet = (env) => credentials.find((c) => c.env === env).set;
  const missing = credentials.filter((c) => c.required && !c.set).map((c) => c.env);

  // Which steps have everything they need to even be ATTEMPTED. A fallback api key
  // stands in for the whole DoLogin pair (that is what it is for), so it unblocks
  // login and everything downstream of it.
  const hasFallback = isSet('AMC_FALLBACK_APIKEY');
  const canToken = isSet('AMC_CLIENT_ID') && isSet('AMC_CLIENT_SECRET');
  const canLogin = isSet('AMC_SUBDOMAIN')
    && (hasFallback || (isSet('AMC_LOGIN_ACCOUNT') && isSet('AMC_LOGIN_PASSWORD')));

  return {
    credentials,
    endpoints,
    missing,
    // The environments disagreeing (one PROD url among UAT ones) is a real foot-gun.
    environments: [...new Set(endpoints.map((e) => e.environment))],
    canToken,
    canLogin,
    // A lookup needs a token (or the fallback key) AND a session.
    canLookup: canLogin && (canToken || hasFallback),
    // Ordering additionally needs the GGID (DigitalGatewayLenderIdentifier) that rides on
    // every order message. AMC_SOURCE_CLIENT_ID is OPTIONAL (the tenant is not issued one),
    // so it does not gate ordering — the builder omits it when unset.
    canOrder: isSet('AMC_LENDER_IDENTIFIER'),
  };
}

/**
 * Turn a thrown error / a CDG NACK into a NAMED cause and a next action.
 *
 * The whole point of the preflight is that "it didn't work" is useless: a blocked
 * firewall, a wrong client secret and a wrong subdomain all surface as "the call
 * failed", and they have three completely different fixes. Pure and total — an
 * unrecognized failure still returns a shape, never throws.
 */
function classify(step, err) {
  const e = err || {};
  const msg = String(e.message || e || '');
  const status = e.status;
  const code = e.code;
  // The response body matters as much as the status: an egress proxy answers 403 too.
  let body = '';
  try { body = typeof e.body === 'string' ? e.body : (e.body ? JSON.stringify(e.body) : ''); } catch { body = ''; }

  // ---- an egress gateway refusing on our side, wearing an HTTP status ----
  // This is checked FIRST and deliberately: a corporate proxy / sandbox allowlist that
  // denies the CONNECT answers 403 with its own explanation, which reads exactly like
  // "the vendor rejected your client secret". Sending someone to re-issue a perfectly
  // good credential because their firewall said no is the single most expensive wrong
  // answer this function can give.
  if (/host_not_allowed|not in allowlist|egress|blocked by policy|denied by policy|forbidden by proxy|proxy denied|CONNECT tunnel/i.test(body + ' ' + msg)) {
    return { cause: 'network', detail: 'An egress proxy/firewall on OUR side refused the connection — the request never reached CoreLogic.',
      fix: 'Allowlist the CoreLogic hosts for this environment\'s outbound network, or run the preflight from the deployed service.' };
  }

  // ---- network: never reached the vendor at all ----
  if (code === 'ENOTFOUND' || /getaddrinfo|ENOTFOUND/i.test(msg)) {
    return { cause: 'dns', detail: 'The endpoint host does not resolve from this machine.',
      fix: 'Check the URL for a typo, or run the preflight from the environment that is allowed to reach CoreLogic.' };
  }
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT'
      || /CONNECT tunnel|proxy|EAI_AGAIN|network|fetch failed|socket hang up|aborted/i.test(msg)) {
    return { cause: 'network', detail: 'The request never reached CoreLogic — connection refused, blocked or timed out.',
      fix: 'This is egress/firewall, not a credential. Run it from the deployed service, and make sure CoreLogic allowlists that egress IP.' };
  }
  if (code === 'AMC_DISABLED') {
    return { cause: 'switch', detail: 'The AMC master switch is off, so the transport refused to call out.',
      fix: 'Run this through scripts/amc-preflight.js, which turns the switch on for its own process only.' };
  }
  if (code === 'AMC_OUTBOUND_DISABLED') {
    return { cause: 'switch', detail: 'A write was attempted with the outbound gate off.',
      fix: 'The preflight must only ever read — this is a bug in the preflight, not a configuration problem.' };
  }

  // ---- HTTP: reached the vendor, the vendor said no ----
  if (status === 401 || status === 403) {
    return step === 'token'
      ? { cause: 'credentials', detail: `The OAuth endpoint rejected the client id/secret (HTTP ${status}).`,
        fix: 'Confirm AMC_CLIENT_ID / AMC_CLIENT_SECRET, and that they are the credentials for THIS environment (UAT keys do not work against production).' }
      : { cause: 'credentials', detail: `The gateway rejected the request (HTTP ${status}).`,
        fix: 'The OAuth token was accepted for GetToken but not here — check the account is entitled to this endpoint.' };
  }
  if (status === 404) {
    return { cause: 'endpoint', detail: 'HTTP 404 — the URL is wrong or that path is not enabled for this account.',
      fix: 'Re-check the endpoint against the vendor iPackage; override it with the matching AMC_*_URL variable.' };
  }
  if (status === 429) {
    return { cause: 'rate_limit', detail: 'HTTP 429 — rate limited by the gateway.', fix: 'Wait and re-run; nothing is wrong with the credentials.' };
  }
  if (typeof status === 'number' && status >= 500) {
    return { cause: 'vendor', detail: `HTTP ${status} — the gateway itself errored.`, fix: 'Transient on their side; re-run. If it persists, it is a vendor ticket.' };
  }

  // ---- CDG NACKs: reached the tenant, the message was refused ----
  if (/-100\b|NOT_AUTHENTICATED|not authenticated/i.test(msg)) {
    return { cause: 'session', detail: 'CDG answered NOT_AUTHENTICATED (-100) — the api_key was not accepted.',
      fix: 'Usually a wrong AMC_SUBDOMAIN, or a login account that is not a user of that tenant.' };
  }
  if (/-99[0-9]\b|Missing required field/i.test(msg)) {
    return { cause: 'message', detail: 'CDG rejected the message shape (a required field is missing).',
      fix: 'A builder-level mismatch against this tenant\'s configuration — capture the response and compare with the vendor sample.' };
  }
  if (/no api key returned|DoLogin failed/i.test(msg)) {
    return { cause: 'credentials', detail: 'DoLogin was delivered but returned no api_key.',
      fix: 'Check AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD, and that the user is active on the AMC_SUBDOMAIN tenant.' };
  }
  if (/are not set|not all set|returned no accessToken/i.test(msg)) {
    return { cause: 'config', detail: msg, fix: 'Set the named variables and re-run.' };
  }

  return { cause: 'unknown', detail: msg || 'The call failed with no recognizable cause.',
    fix: 'Re-run with --verbose to see the raw response body.' };
}

/** One step's result, in the shape the CLI renders and the exit code is derived from. */
function stepResult(name, ok, extra) {
  return { step: name, ok: !!ok, ...(extra || {}) };
}

/**
 * Run the live preflight. `deps` exists so the pure test can drive it without a network.
 * Never throws — every failure becomes a classified step result.
 */
async function run(deps = {}) {
  const cfg = deps.cfg || require('../config');
  const client = deps.client || require('./client');
  const session = deps.session || require('./session');
  const cdg = deps.cdg || require('./cdg');

  const amc = cfg.amc || {};
  const inv = inventory(amc);
  const steps = [];

  // ---- 2. OAuth GetToken ----
  if (!inv.canToken) {
    steps.push(stepResult('token', false, { skipped: true,
      ...classify('token', new Error('AMC_CLIENT_ID / AMC_CLIENT_SECRET are not set')) }));
  } else {
    try {
      const token = await client.getAccessToken();
      steps.push(stepResult('token', true, { detail: token ? `Access token issued ${mask(token)}.` : 'Using the fallback api key instead of OAuth.' }));
    } catch (e) {
      steps.push(stepResult('token', false, { ...classify('token', e), raw: e && e.body }));
    }
  }

  // ---- 3. DoLogin ----
  const tokenOk = steps[0].ok;
  if (!inv.canLogin) {
    steps.push(stepResult('login', false, { skipped: true,
      ...classify('login', new Error('AMC_LOGIN_ACCOUNT / AMC_LOGIN_PASSWORD / AMC_SUBDOMAIN are not all set')) }));
  } else if (!tokenOk) {
    steps.push(stepResult('login', false, { skipped: true, cause: 'blocked',
      detail: 'Skipped — DoLogin rides on the OAuth token, which did not come back.', fix: 'Fix the token step first.' }));
  } else {
    try {
      const key = await session.apiKey();
      steps.push(stepResult('login', true, { detail: `AppraisalScope api_key issued ${mask(key)} for subdomain "${amc.subdomain}".` }));
    } catch (e) {
      steps.push(stepResult('login', false, { ...classify('login', e) }));
    }
  }

  // ---- 4. A read-only lookup: does the tenant actually answer? ----
  const loginOk = steps[1].ok;
  const lookupType = deps.lookupType || 'GetLoanType';
  if (!loginOk) {
    steps.push(stepResult('lookup', false, { skipped: true, cause: 'blocked',
      detail: 'Skipped — a lookup needs the api_key from DoLogin.', fix: 'Fix the login step first.' }));
  } else {
    try {
      const ctx = await session.authContext();
      const resp = await client.read(cdg.buildLookup({ actionType: lookupType, apiKey: ctx.apiKey, subdomain: ctx.subdomain }), { label: lookupType });
      const nack = cdg.parseError(resp);
      if (nack) {
        steps.push(stepResult('lookup', false, { ...classify('lookup', new Error(`${nack.code} ${nack.description || nack.name || ''}`)), raw: nack }));
      } else {
        const rows = cdg.parseLookup(resp);
        steps.push(stepResult('lookup', true, {
          detail: `${lookupType} returned ${rows.length} row(s) — the tenant is live and answering.`,
          sample: rows.slice(0, 5),
        }));
      }
    } catch (e) {
      steps.push(stepResult('lookup', false, { ...classify('lookup', e), raw: e && e.body }));
    }
  }

  const ok = steps.every((s) => s.ok);
  return { ok, inventory: inv, steps, lookupType };
}

module.exports = { CREDENTIALS, ENDPOINTS, mask, environmentOf, inventory, classify, run };
