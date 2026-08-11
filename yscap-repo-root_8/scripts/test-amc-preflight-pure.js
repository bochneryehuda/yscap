'use strict';
/**
 * Pure test for the AMC credential preflight (src/amc/preflight.js). No DB, no network:
 * the masking contract, the credential inventory, the failure classifier, and a full
 * run() driven through injected fakes.
 *
 * The two properties that actually matter here:
 *   1. a preflight NEVER prints a credential — it is run over a shared screen and
 *      pasted into tickets, so `mask` leaking even a tail of a short secret is a bug;
 *   2. a failure is NAMED — a blocked firewall and a wrong secret must not both come
 *      back as "unknown", because the whole point is telling the operator what to fix.
 */
const preflight = require('../src/amc/preflight');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.error('  FAIL:', m); } };

// ---- mask: never reveals a usable credential --------------------------------
const SECRET = 'zzTESTONLYzzTESTONLYzzTESTONLYzzTESTONLYzzTESTONLYzzTESTONLYzzTE';
const masked = preflight.mask(SECRET);
ok(!masked.includes(SECRET), 'mask never contains the whole secret');
ok(!SECRET.slice(0, 8).split('').every((ch) => masked.includes(ch)) || masked.length < 30, 'mask is short, not a re-encoding');
ok(masked.includes('64 chars'), 'mask reports the length so two credentials are distinguishable');
ok(masked.endsWith('…' + SECRET.slice(-4) + ')'), 'mask shows only the last four characters');
ok(preflight.mask('short12') === '(7 chars, hidden)', 'a short value is hidden entirely, not tailed');
ok(preflight.mask('') === null && preflight.mask(null) === null, 'empty and null mask to null');

// ---- environmentOf ----------------------------------------------------------
ok(preflight.environmentOf('https://api-uat.corelogic.com/x') === 'UAT', 'api-uat host reads as UAT');
ok(preflight.environmentOf('https://uat1.globalgateway.corelogic.com/x') === 'UAT', 'uat1 host reads as UAT');
ok(preflight.environmentOf('https://globalgateway.corelogic.com/x') === 'PRODUCTION', 'the bare gateway host reads as PRODUCTION');
// Cotality is CoreLogic's new name (the token host moved there, vendor-directed 2026-08)
// — both domains must read the same way, or the mixed-environment warning goes blind.
ok(preflight.environmentOf('https://api-uat.cotality.com/order-gateway-oauth2/token') === 'UAT', 'the new cotality UAT token host reads as UAT');
ok(preflight.environmentOf('https://api-prod.cotality.com/x') === 'PRODUCTION', 'a non-UAT cotality host reads as PRODUCTION');
ok(preflight.environmentOf('') === 'unset', 'an unset url reads as unset');

// ---- inventory --------------------------------------------------------------
const UAT = {
  oauthUrl: 'https://api-uat.corelogic.com/order-gateway-oauth2/token',
  loginUrl: 'https://uat1.globalgateway.corelogic.com/direct/appraisal_service/request/appraisalscope/client',
  orderUrl: 'https://uat1.globalgateway.corelogic.com/order/appraisal_service/request/appraisalscope/client',
  postDocumentsUrl: 'https://uat1.globalgateway.corelogic.com/postdocuments',
};
// Exactly what the owner supplied on 2026-08-06: OAuth pair + the GGID, nothing else.
const asIssued = preflight.inventory({ ...UAT, clientId: 'abc', clientSecret: SECRET, lenderIdentifier: 'GG000000' });
ok(asIssued.canToken === true, 'the OAuth pair alone is enough to attempt GetToken');
ok(asIssued.canLogin === false, 'DoLogin cannot be attempted without the account/password/subdomain');
ok(asIssued.canLookup === false, 'a lookup cannot be attempted without a session');
// AMC_SOURCE_CLIENT_ID is OPTIONAL (the tenant has none), so the GGID alone completes the
// order-message identifiers — ordering is not blocked on a credential that does not exist.
ok(asIssued.canOrder === true, 'ordering identifiers are complete once the GGID is set (source-client id is optional)');
ok(asIssued.missing.includes('AMC_LOGIN_ACCOUNT') && asIssued.missing.includes('AMC_SUBDOMAIN'),
   'missing names every still-needed variable');
ok(!asIssued.missing.includes('AMC_SOURCE_CLIENT_ID'), 'the optional source-client id is never reported as missing');
ok(!asIssued.missing.includes('AMC_LENDER_IDENTIFIER'), 'the GGID counts as AMC_LENDER_IDENTIFIER');
ok(!asIssued.missing.includes('AMC_FALLBACK_APIKEY'), 'the optional fallback key is never reported as missing');
// canOrder must NOT depend on the source-client id: a set with the GGID and no source-client
// id still unblocks ordering.
const noSourceClient = preflight.inventory({ ...UAT, clientId: 'a', clientSecret: 'b', loginAccount: 'u',
  loginPassword: 'p', subdomain: 'integrations.uat', lenderIdentifier: 'GG000000' });
ok(noSourceClient.canOrder === true, 'canOrder does not depend on the optional AMC_SOURCE_CLIENT_ID');
ok(noSourceClient.missing.length === 0, 'a set without the optional source-client id reports nothing missing');
const secretRow = asIssued.credentials.find((c) => c.env === 'AMC_CLIENT_SECRET');
ok(secretRow.set === true && !String(secretRow.display).includes(SECRET), 'the inventory reports the secret masked');
const idRow = asIssued.credentials.find((c) => c.env === 'AMC_CLIENT_ID');
ok(idRow.display === 'abc', 'a non-secret identifier is shown in full (it is an id, not a key)');

const complete = preflight.inventory({
  ...UAT, clientId: 'abc', clientSecret: SECRET, loginAccount: 'u', loginPassword: 'p',
  subdomain: 'integrations.uat', lenderIdentifier: 'GG000000', sourceClientId: '42',
});
ok(complete.missing.length === 0, 'a complete set reports nothing missing');
ok(complete.canToken && complete.canLogin && complete.canLookup && complete.canOrder, 'a complete set unblocks every step');
ok(complete.environments.length === 1 && complete.environments[0] === 'UAT', 'all-UAT endpoints report one environment');

// The fallback api key exists precisely to stand in for DoLogin in a lower environment.
const viaFallback = preflight.inventory({ ...UAT, clientId: 'a', clientSecret: 'b', subdomain: 's', fallbackApiKey: 'k' });
ok(viaFallback.canLogin === true, 'a fallback api key substitutes for the DoLogin pair');

// A production host mixed into a UAT run is the mistake worth shouting about.
const mixed = preflight.inventory({ ...UAT, orderUrl: 'https://globalgateway.corelogic.com/order' });
ok(mixed.environments.includes('UAT') && mixed.environments.includes('PRODUCTION'), 'a mixed environment is visible in the inventory');

// ---- classify: every failure gets a NAME and a fix ---------------------------
const net = preflight.classify('token', Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }));
ok(net.cause === 'network' && /egress|firewall/i.test(net.fix), 'a refused connection is named as network, not as bad credentials');
ok(preflight.classify('token', new Error('CONNECT tunnel failed, response 403')).cause === 'network',
  'a blocked proxy tunnel is network, not a credential problem');
ok(preflight.classify('token', Object.assign(new Error('x'), { code: 'ENOTFOUND' })).cause === 'dns', 'an unresolvable host is dns');
ok(preflight.classify('token', Object.assign(new Error('x'), { status: 401 })).cause === 'credentials', 'a 401 on GetToken is a credential problem');
ok(/UAT keys do not work/i.test(preflight.classify('token', Object.assign(new Error('x'), { status: 401 })).fix),
  'the 401 fix mentions the wrong-environment case');
// An egress gateway answers 403 with its own explanation. Reading that as "the vendor
// rejected your secret" sends someone to re-issue a credential that was never wrong.
const egress = preflight.classify('token', Object.assign(new Error('AMC GetToken -> 403'), {
  status: 403, body: { raw: 'Host not in allowlist: api-uat.corelogic.com. Add this host to your network egress settings to allow access.' },
}));
ok(egress.cause === 'network', 'a 403 from an egress allowlist is network, NOT a credential problem');
ok(/allowlist|deployed service/i.test(egress.fix), 'the egress fix says to allowlist the host or run it elsewhere');
ok(preflight.classify('token', Object.assign(new Error('x'), { status: 403, body: 'blocked by policy' })).cause === 'network',
  'a string body naming a policy block is also network');
ok(preflight.classify('token', Object.assign(new Error('x'), { status: 403, body: { error: 'invalid_client' } })).cause === 'credentials',
  'a 403 whose body is a real OAuth rejection stays a credential problem');
ok(preflight.classify('token', Object.assign(new Error('x'), { status: 403, body: { c: () => {} } })).cause === 'credentials',
  'an unserializable body does not throw');
ok(preflight.classify('lookup', Object.assign(new Error('x'), { status: 404 })).cause === 'endpoint', 'a 404 is an endpoint problem');
ok(preflight.classify('lookup', Object.assign(new Error('x'), { status: 503 })).cause === 'vendor', 'a 5xx is the vendor');
ok(preflight.classify('lookup', Object.assign(new Error('x'), { status: 429 })).cause === 'rate_limit', 'a 429 is rate limiting');
ok(preflight.classify('lookup', new Error('-100 NOT_AUTHENTICATED')).cause === 'session', 'a -100 NACK points at the session/subdomain');
ok(/subdomain/i.test(preflight.classify('lookup', new Error('-100 NOT_AUTHENTICATED')).fix), 'the -100 fix names the subdomain');
ok(preflight.classify('lookup', new Error('-996 Missing required field')).cause === 'message', 'a -996 NACK is a message-shape problem');
ok(preflight.classify('login', new Error('AMC DoLogin failed: no api key returned')).cause === 'credentials', 'a failed DoLogin is a credential problem');
ok(preflight.classify('token', Object.assign(new Error('nope'), { code: 'AMC_DISABLED' })).cause === 'switch', 'the master-switch refusal is named');
const unknown = preflight.classify('lookup', new Error('something nobody predicted'));
ok(unknown.cause === 'unknown' && unknown.detail && unknown.fix, 'an unrecognized failure still returns a complete shape');
ok(preflight.classify('token', null).cause === 'unknown', 'classify(null) does not throw');

// ---- run(): the whole flow, driven through fakes ----------------------------
const fakeCdg = {
  buildLookup: ({ actionType }) => ({ message: { requestActionType: actionType } }),
  parseError: (r) => (r && r.__nack) || null,
  parseLookup: () => [{ id: '1', name: 'Fix & Flip' }, { id: '2', name: 'Bridge' }],
};
const completeCfg = { amc: { ...UAT, clientId: 'a', clientSecret: 'b', loginAccount: 'u', loginPassword: 'p', subdomain: 'integrations.uat', lenderIdentifier: 'GG000000', sourceClientId: '42' } };

(async () => {
  // Happy path.
  const good = await preflight.run({
    cfg: completeCfg, cdg: fakeCdg,
    // The lookup step MUST hit the "/direct/" endpoint via client.lookup (not client.read /
    // "/order/"): a plain read() here would silently pass while production 500s.
    client: { getAccessToken: async () => 'tok_abcdefghijkl', lookup: async () => ({ ok: true }),
      read: async () => { throw new Error('preflight must use client.lookup for catalog lookups, not client.read'); } },
    session: { apiKey: async () => 'key_abcdefghijkl', authContext: async () => ({ apiKey: 'key_abcdefghijkl', subdomain: 'integrations.uat' }) },
  });
  ok(good.ok === true, 'a fully working environment passes every step');
  ok(good.steps.map((s) => s.step).join(',') === 'token,login,lookup', 'the steps run in credential order');
  ok(/2 row/.test(good.steps[2].detail), 'the lookup step reports the row count');
  ok(!JSON.stringify(good).includes('tok_abcdefghijkl'), 'the run result never carries the raw access token');
  ok(!JSON.stringify(good).includes('key_abcdefghijkl'), 'the run result never carries the raw api key');

  // A blocked network at the token step must not be reported as a bad secret, and
  // must not leave the later steps claiming anything they never tested.
  const blocked = await preflight.run({
    cfg: completeCfg, cdg: fakeCdg,
    client: { getAccessToken: async () => { throw Object.assign(new Error('fetch failed'), { code: 'ECONNREFUSED' }); }, read: async () => ({}) },
    session: { apiKey: async () => 'k', authContext: async () => ({}) },
  });
  ok(blocked.ok === false, 'a blocked network fails the run');
  ok(blocked.steps[0].cause === 'network', 'the token step names the network as the cause');
  ok(blocked.steps[1].skipped === true && blocked.steps[2].skipped === true, 'downstream steps are skipped, never guessed');
  ok(blocked.steps.every((s) => !s.ok), 'a skipped step is not reported as a pass');

  // Missing credentials: the run still reports, and blames configuration.
  const bare = await preflight.run({
    cfg: { amc: { ...UAT, clientId: 'a', clientSecret: 'b', lenderIdentifier: 'GG000000' } }, cdg: fakeCdg,
    client: { getAccessToken: async () => 'tok_abcdefghijkl', read: async () => ({}) },
    session: { apiKey: async () => { throw new Error('unreachable'); }, authContext: async () => ({}) },
  });
  ok(bare.steps[0].ok === true, 'the token step still runs when only the OAuth pair is set');
  ok(bare.steps[1].skipped === true && bare.steps[1].cause === 'config', 'DoLogin is skipped as a config problem, not attempted');
  ok(bare.inventory.missing.includes('AMC_SUBDOMAIN'), 'the run carries the inventory of what is missing');

  // A tenant-level NACK on the lookup is a real failure, not a pass with zero rows.
  const nacked = await preflight.run({
    cfg: completeCfg,
    cdg: { ...fakeCdg, parseError: () => ({ code: '-100', description: 'NOT_AUTHENTICATED' }) },
    client: { getAccessToken: async () => 'tok_abcdefghijkl', lookup: async () => ({ __nack: true }) },
    session: { apiKey: async () => 'key_abcdefghijkl', authContext: async () => ({ apiKey: 'k', subdomain: 'wrong.tenant' }) },
  });
  ok(nacked.ok === false && nacked.steps[2].ok === false, 'a NACKed lookup fails the run');
  ok(nacked.steps[2].cause === 'session', 'a -100 on the lookup is classified as a session/subdomain problem');

  console.log(`\n[test-amc-preflight-pure] ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
