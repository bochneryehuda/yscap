/* Ad-hoc unit tests for the credit credential/adapter layer (Phase 1d).
 * Pure + injected-transport only — no DB, no network.
 * Run: node scripts/test-credit-credentials.js */
const crypto = require('../src/lib/crypto');
const providers = require('../src/lib/credit/providers');
const credentials = require('../src/lib/credit/credentials');
const xactus = require('../src/lib/integrations/xactus');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };
const throws = (name, fn) => { try { fn(); fail++; console.log(`FAIL ${name}: expected throw`); } catch (_) { pass++; } };
async function rejects(name, p) { try { await p; fail++; console.log(`FAIL ${name}: expected reject`); } catch (_) { pass++; } }
async function resolves(name, p) { try { return await p; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); } }

// A fetch-like fake response.
function resp(status, body, contentType = 'text/xml') {
  return { status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? contentType : null) }, text: async () => body };
}
// A transport that records the call and returns a canned response.
function transportOf(status, body, ct) {
  const calls = [];
  const fn = async (url, opts) => { calls.push({ url, opts }); return resp(status, body, ct); };
  fn.calls = calls;
  return fn;
}

(async () => {
  // ===== crypto.encryptSecret / decryptSecret =====
  const rt = crypto.decryptSecret(crypto.encryptSecret('@pl41nT3xt!'));
  eq('secret roundtrip', rt, '@pl41nT3xt!');
  eq('secret roundtrip unicode', crypto.decryptSecret(crypto.encryptSecret('pä$$—wörd✓')), 'pä$$—wörd✓');
  eq('encryptSecret null', crypto.encryptSecret(null), null);
  eq('encryptSecret empty', crypto.encryptSecret(''), null);
  eq('decryptSecret null', crypto.decryptSecret(null), null);
  ok('ciphertext is bytes', Buffer.isBuffer(crypto.encryptSecret('x')));
  ok('ciphertext not plaintext', !crypto.encryptSecret('hunter2secret').includes('hunter2secret'));
  // Two encryptions of the same value differ (random IV) but both decrypt back.
  const c1 = crypto.encryptSecret('same'), c2 = crypto.encryptSecret('same');
  ok('random iv → distinct ciphertext', !c1.equals(c2));
  eq('both decrypt', [crypto.decryptSecret(c1), crypto.decryptSecret(c2)], ['same', 'same']);
  // Tampered auth tag must THROW (never silently return a blank/garbage secret).
  const tampered = Buffer.from(crypto.encryptSecret('secret')); tampered[tampered.length - 1] ^= 0xff;
  throws('tampered secret throws', () => crypto.decryptSecret(tampered));

  // ===== providers._normalize =====
  eq('normalize string caps', providers._normalize({ id: 1, key: 'x', display_name: 'X', enabled: true, is_default: true, capabilities: '{"reissue":true}' }),
     { id: 1, key: 'x', displayName: 'X', enabled: true, isDefault: true, capabilities: { reissue: true } });
  eq('normalize object caps + falsy', providers._normalize({ id: 2, key: 'y', display_name: 'Y', enabled: false, is_default: false, capabilities: { softPull: true } }),
     { id: 2, key: 'y', displayName: 'Y', enabled: false, isDefault: false, capabilities: { softPull: true } });
  eq('normalize bad caps → {}', providers._normalize({ id: 3, key: 'z', display_name: 'Z', enabled: true, is_default: false, capabilities: 'not json' }).capabilities, {});
  eq('normalize null', providers._normalize(null), null);

  // ===== credentials.cleanIdentifier =====
  eq('ident trim', credentials.cleanIdentifier('  user1  '), 'user1');
  eq('ident empty → null', credentials.cleanIdentifier('   '), null);
  eq('ident null → null', credentials.cleanIdentifier(null), null);
  eq('ident control char → null', credentials.cleanIdentifier('user\x001'), null);
  eq('ident tab → null', credentials.cleanIdentifier('a\tb'), null);
  eq('ident too long → null', credentials.cleanIdentifier('x'.repeat(201)), null);
  eq('ident keeps normal', credentials.cleanIdentifier('YSCAP_LO_42'), 'YSCAP_LO_42');

  // ===== xactus.basicAuth =====
  eq('basicAuth format', xactus.basicAuth('u', 'p'), 'Basic ' + Buffer.from('u:p').toString('base64'));

  // ===== xactus.orderReport (injected transport) =====
  const okXml = '<?xml version="1.0"?><RESPONSE_GROUP/>';
  const good = await resolves('order 200', xactus.orderReport({
    endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<REQUEST/>', transport: transportOf(200, okXml),
  }));
  eq('order 200 body', good && good.body, okXml);
  eq('order 200 status', good && good.httpStatus, 200);
  // auth
  const authT = transportOf(401, '<err/>');
  await rejects('order 401 rejects', xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: authT }));
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportOf(403, 'x') }); }
  catch (e) { eq('403 kind auth', e.kind, 'auth'); ok('403 not retriable', e.retriable === false); }
  // 500 retriable
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportOf(503, 'x') }); }
  catch (e) { eq('503 kind http', e.kind, 'http'); ok('503 retriable', e.retriable === true); }
  // 400 not retriable
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportOf(400, 'x') }); }
  catch (e) { eq('400 kind http', e.kind, 'http'); ok('400 not retriable', !e.retriable); }
  // empty body
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportOf(200, '   ') }); }
  catch (e) { eq('empty kind', e.kind, 'empty'); }
  // network failure (throw) → retriable network
  const netThrow = async () => { const err = new Error('ECONNRESET'); throw err; };
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: netThrow }); }
  catch (e) { eq('network kind', e.kind, 'network'); ok('network retriable', e.retriable === true); }
  // abort (timeout) → timeout retriable
  const abortThrow = async () => { const err = new Error('aborted'); err.name = 'AbortError'; throw err; };
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: abortThrow }); }
  catch (e) { eq('timeout kind', e.kind, 'timeout'); ok('timeout retriable', e.retriable === true); }
  // config validation
  await rejects('order no endpoint', xactus.orderReport({ endpoint: '', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportOf(200, okXml) }));
  await rejects('order no secret', xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: '', requestXml: '<R/>', transport: transportOf(200, okXml) }));
  await rejects('order no requestXml', xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '', transport: transportOf(200, okXml) }));
  // auth header + content-type actually sent
  const spyT = transportOf(200, okXml);
  await xactus.orderReport({ endpoint: 'https://x.test/', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', path: '/order', transport: spyT });
  eq('order url trims + path', spyT.calls[0].url, 'https://x.test/order');
  eq('order sends basic auth', spyT.calls[0].opts.headers.Authorization, xactus.basicAuth('u', 'p'));
  ok('order sends xml content-type', /text\/xml/.test(spyT.calls[0].opts.headers['Content-Type']));

  // ===== Retry-After honoring (429 rate-limit + 503) =====
  // A transport whose response carries arbitrary headers (for Retry-After).
  const transportH = (status, body, headers = {}) => {
    const h = Object.assign({ 'content-type': 'text/xml' }, headers);
    return async () => ({ status, headers: { get: (k) => (h[String(k).toLowerCase()] != null ? h[String(k).toLowerCase()] : null) }, text: async () => body });
  };
  eq('parseRetryAfter seconds→ms', xactus.parseRetryAfter('120'), 120000);
  eq('parseRetryAfter null', xactus.parseRetryAfter(null), null);
  eq('parseRetryAfter garbage', xactus.parseRetryAfter('soon'), null);
  ok('parseRetryAfter caps at 1h', xactus.parseRetryAfter('999999') === 3600000);
  ok('parseRetryAfter past date → 0', xactus.parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT') === 0);
  // 429 → rate_limit, retriable, Retry-After captured (must NOT be a generic non-retriable 4xx)
  let e429 = null;
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportH(429, 'slow down', { 'retry-after': '30' }) }); }
  catch (e) { e429 = e; }
  ok('429 threw', !!e429);
  eq('429 kind rate_limit', e429 && e429.kind, 'rate_limit');
  ok('429 retriable', e429 && e429.retriable === true);
  eq('429 retryAfterMs captured', e429 && e429.retryAfterMs, 30000);
  // 503 with Retry-After also surfaces the wait
  let e503 = null;
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportH(503, 'x', { 'retry-after': '5' }) }); }
  catch (e) { e503 = e; }
  eq('503 retryAfterMs captured', e503 && e503.retryAfterMs, 5000);
  // 429 without a header → still retriable, retryAfterMs null
  let e429b = null;
  try { await xactus.orderReport({ endpoint: 'https://x.test', operatorIdentifier: 'u', secret: 'p', requestXml: '<R/>', transport: transportH(429, 'x') }); }
  catch (e) { e429b = e; }
  ok('429 no-header still retriable', e429b && e429b.retriable === true);
  eq('429 no-header retryAfterMs null', e429b && e429b.retryAfterMs, null);

  // ===== xactus.verifyCredential =====
  eq('verify 429 → unverified', (await xactus.verifyCredential({ operatorIdentifier: 'u', secret: 'p', endpoint: 'https://x.test', verifyPath: '/ping', transport: transportH(429, '') })).status, 'unverified');
  eq('verify missing → invalid', (await xactus.verifyCredential({ operatorIdentifier: '', secret: '' })).status, 'invalid');
  eq('verify no endpoint → unverified', (await xactus.verifyCredential({ operatorIdentifier: 'u', secret: 'p', endpoint: '' })).status, 'unverified');
  eq('verify 401 → invalid', (await xactus.verifyCredential({ operatorIdentifier: 'u', secret: 'p', endpoint: 'https://x.test', verifyPath: '/ping', transport: transportOf(401, '') })).status, 'invalid');
  eq('verify 200 → ok', (await xactus.verifyCredential({ operatorIdentifier: 'u', secret: 'p', endpoint: 'https://x.test', verifyPath: '/ping', transport: transportOf(200, '') })).status, 'ok');
  eq('verify 500 → unverified', (await xactus.verifyCredential({ operatorIdentifier: 'u', secret: 'p', endpoint: 'https://x.test', verifyPath: '/ping', transport: transportOf(503, '') })).status, 'unverified');

  // ===== adverse-action draft assembler (pure) =====
  const aa = require('../src/lib/credit/adverse-action');
  const body = aa.draftBody({ borrowerName: 'Ann Freddie', decision: 'declined',
    principalReasons: ['Insufficient credit history', 'Delinquent past obligations'],
    scoresDisclosed: [{ bureau: 'Equifax', score: 640 }, { bureau: 'Experian', score: 655 }] });
  ok('aa marks DRAFT / review-required', /DRAFT — for compliance review/.test(body));
  ok('aa lists principal reasons', /Insufficient credit history/.test(body) && /Delinquent past obligations/.test(body));
  ok('aa discloses scores', /Equifax: 640/.test(body) && /Experian: 655/.test(body));
  ok('aa includes ECOA notice', /Equal Credit Opportunity Act/.test(body));
  ok('aa counteroffer wording', /different terms/.test(aa.draftBody({ decision: 'counteroffer' })));
  ok('aa no-scores omits disclosure', !/Credit scores used/.test(aa.draftBody({ decision: 'declined' })));
  ok('aa guarantor flags not-owed', /GUARANTOR/.test(aa.draftBody({ decision: 'declined', partyRole: 'guarantor' })));
  ok('aa applicant no guarantor note', !/GUARANTOR/.test(aa.draftBody({ decision: 'declined', partyRole: 'applicant' })));

  console.log(`\ncredit-credentials: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
