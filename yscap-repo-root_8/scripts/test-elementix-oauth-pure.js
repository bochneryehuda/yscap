'use strict';
/**
 * test-elementix-oauth-pure.js — the Elementix connection's decision logic, with
 * no database and no network.
 *
 * What this pins, and why each one matters:
 *   - the token cipher: a round trip, and that a WRONG key or a TAMPERED value
 *     reads as "not connected" rather than throwing or returning junk;
 *   - discovery URL derivation and the WWW-Authenticate pointer, because getting
 *     these wrong is silent — you just never find the authorization server;
 *   - `unattendedVerdict`, which is the answer to the owner's actual question
 *     ("does somebody have to keep clicking Approve?") and must never claim
 *     certainty it does not have;
 *   - the SSE vs JSON response parsing, because assuming JSON is what makes an
 *     MCP client look flaky against a server that streams;
 *   - that the PAID contact-enrichment tool is refused unless the caller
 *     explicitly means to spend money.
 *
 * Env is set BEFORE the requires: config.js reads process.env at require time.
 */

process.env.ELEMENTIX_URL = process.env.ELEMENTIX_URL || 'https://app.elementix.com/api/mcp';
process.env.ELEMENTIX_TOKEN_KEY = 'test-key-for-elementix-tokens-0123456789';
process.env.ELEMENTIX_ENABLED = '1';
process.env.ELEMENTIX_DRYRUN = '';
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || 'dev-only-ssn-key-for-tests';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-only-jwt-secret-for-tests';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// NO VENDOR CALLS. Learned the hard way: an assertion that drove `beginConnect`
// down the company-wide path reached live discovery AND dynamic client
// registration at Elementix from the CI runner — a unit test quietly talking to
// (and registering an OAuth client with) a paid third party on every push.
//
// The trap THROWS so no bytes ever leave the process, and it also RECORDS, which
// is the half that matters: `discover()` deliberately swallows every network
// error, so a throw alone is silent and the next person re-adds the call without
// ever seeing it. The recorded list is asserted empty at the end of the run.
const attemptedCalls = [];
global.fetch = (url) => {
  attemptedCalls.push(String(url));
  throw new Error(`this test must never call out — something tried to reach ${url}`);
};

const oauth = require('../src/elementix/oauth');
const client = require('../src/elementix/client');

const O = oauth._internals;
const C = client._internals;

let n = 0;
function ok(what) { n += 1; console.log(`  ✓ ${what}`); }

console.log('Elementix connection — pure logic');

// ---------------------------------------------------------------------------
console.log('\n1. Token encryption at rest');
// ---------------------------------------------------------------------------
{
  assert.strictEqual(O.canEncrypt(), true, 'a key is configured in this test');
  const secret = 'rt_a-long-refresh-token-value-9f8e7d6c';
  const enc = O.encrypt(secret);
  assert.ok(enc && enc !== secret, 'the stored form is not the plaintext');
  assert.ok(!enc.includes('refresh'), 'no readable fragment survives');
  assert.strictEqual(O.decrypt(enc), secret, 'round trips');
  ok('a token round trips and is unreadable at rest');

  // Two encryptions of the same value must differ — a fixed IV would let anyone
  // with database access tell that two rows hold the same token.
  assert.notStrictEqual(O.encrypt(secret), O.encrypt(secret), 'random IV per write');
  ok('the same token encrypts differently every time (random IV)');

  assert.strictEqual(O.encrypt(null), null);
  assert.strictEqual(O.encrypt(''), null);
  assert.strictEqual(O.decrypt(null), null);
  assert.strictEqual(O.decrypt(''), null);
  ok('empty in, empty out — never an encrypted empty string');

  // A tampered value must read as "not connected", which sends a human through
  // Approve again. It must NEVER throw (that would 500 a page) and must never
  // return partial plaintext.
  const raw = Buffer.from(enc, 'base64');
  raw[raw.length - 1] ^= 0xff;
  assert.strictEqual(O.decrypt(raw.toString('base64')), null, 'tampered → null');
  assert.strictEqual(O.decrypt('not-base64-at-all!!'), null, 'garbage → null');
  assert.strictEqual(O.decrypt('AAAA'), null, 'too short to be ours → null');
  ok('a tampered, short or garbage value reads as not-connected, never throws');
}

// ---------------------------------------------------------------------------
console.log('\n2. PKCE and state');
// ---------------------------------------------------------------------------
{
  const a = O.newPkce();
  const b = O.newPkce();
  assert.strictEqual(a.method, 'S256');
  assert.notStrictEqual(a.verifier, b.verifier, 'a fresh verifier per approval');
  assert.notStrictEqual(a.challenge, b.challenge);
  assert.ok(a.verifier.length >= 43, 'verifier meets the RFC 7636 minimum length');
  assert.ok(!/[+/=]/.test(a.verifier + a.challenge), 'base64url only — no +, / or =');

  // The challenge must be the SHA-256 of the verifier, or the token exchange is
  // rejected and the approval fails at the last step with a useless error.
  const expect = require('crypto').createHash('sha256').update(a.verifier).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.strictEqual(a.challenge, expect, 'challenge = base64url(sha256(verifier))');
  ok('PKCE is S256, fresh per approval, and correctly derived');

  assert.notStrictEqual(O.newState(), O.newState(), 'state is random per approval');
  ok('state is random (CSRF protection on the round trip)');
}

// ---------------------------------------------------------------------------
console.log('\n3. Finding the authorization server');
// ---------------------------------------------------------------------------
{
  // RFC 9728: the 401 tells us where the metadata lives. Quoted and unquoted.
  assert.strictEqual(
    O.resourceMetadataUrlFrom('Bearer resource_metadata="https://app.elementix.com/.well-known/oauth-protected-resource"'),
    'https://app.elementix.com/.well-known/oauth-protected-resource');
  assert.strictEqual(
    O.resourceMetadataUrlFrom('Bearer realm="x", resource_metadata=https://a.example/.well-known/oauth-protected-resource'),
    'https://a.example/.well-known/oauth-protected-resource');
  ok('the resource_metadata pointer is read out of WWW-Authenticate');

  // A plain 401 with no pointer, and anything not https, must not be trusted.
  assert.strictEqual(O.resourceMetadataUrlFrom('Bearer'), null);
  assert.strictEqual(O.resourceMetadataUrlFrom(''), null);
  assert.strictEqual(O.resourceMetadataUrlFrom(null), null);
  assert.strictEqual(O.resourceMetadataUrlFrom('Bearer resource_metadata="http://insecure.example/x"'), null,
    'plain http is refused — an OAuth discovery document over http is a downgrade');
  ok('no pointer, or a non-https pointer, is refused rather than guessed');

  // The RFC form appends the resource PATH to the well-known root, and the
  // path-less form is the fallback. Both are tried, in that order.
  const cands = O.candidateResourceMetadataUrls('https://app.elementix.com/api/mcp');
  assert.deepStrictEqual(cands, [
    'https://app.elementix.com/.well-known/oauth-protected-resource/api/mcp',
    'https://app.elementix.com/.well-known/oauth-protected-resource',
  ]);
  ok('both well-known resource-metadata forms are tried, RFC form first');

  assert.deepStrictEqual(O.candidateResourceMetadataUrls('not a url'), [], 'a bad URL yields nothing, never a throw');

  const as = O.candidateAuthServerMetadataUrls('https://auth.elementix.com/');
  assert.deepStrictEqual(as, [
    'https://auth.elementix.com/.well-known/oauth-authorization-server',
    'https://auth.elementix.com/.well-known/openid-configuration',
  ], 'trailing slash normalised; OIDC tried as well as plain OAuth');
  assert.deepStrictEqual(O.candidateAuthServerMetadataUrls('http://x.example'), [], 'http refused');
  ok('authorization-server metadata is looked for at both well-known paths');
}

// ---------------------------------------------------------------------------
console.log('\n4. Can it run unattended? — the owner\'s actual question');
// ---------------------------------------------------------------------------
{
  // The vendor said "the AI client will handle it", which is an answer for
  // somebody sitting in Cursor. These are the three states that matter to a
  // server with nobody at the keyboard.
  const yes = oauth.unattendedVerdict({ ok: true, grantTypesSupported: ['authorization_code', 'refresh_token'], scopesSupported: ['offline_access'] });
  assert.strictEqual(yes.verdict, 'likely');
  assert.strictEqual(yes.canSelfRenew, true);
  assert.ok(/offline_access/.test(yes.detail), 'says offline_access is offered');
  ok('refresh_token grant offered → likely self-renewing');

  const no = oauth.unattendedVerdict({ ok: true, grantTypesSupported: ['authorization_code'], scopesSupported: [] });
  assert.strictEqual(no.verdict, 'unlikely');
  assert.strictEqual(no.canSelfRenew, false);
  assert.ok(/re-approv/i.test(no.detail), 'warns a person will have to re-approve');
  ok('no refresh_token grant → unlikely, and it says so plainly');

  // The important one: silence is NOT a "no". Claiming either way here would be
  // fabricating an answer the server never gave.
  const quiet = oauth.unattendedVerdict({ ok: true, grantTypesSupported: [], scopesSupported: [] });
  assert.strictEqual(quiet.verdict, 'unknown');
  assert.strictEqual(quiet.canSelfRenew, null);
  ok('grant types not published → unknown, never guessed either way');

  const failed = oauth.unattendedVerdict({ ok: false, reason: 'unreachable' });
  assert.strictEqual(failed.verdict, 'unknown');
  assert.strictEqual(failed.canSelfRenew, null);
  assert.strictEqual(oauth.unattendedVerdict(null).verdict, 'unknown', 'null input does not throw');
  ok('a failed or absent probe is unknown, and never throws');
}

// ---------------------------------------------------------------------------
console.log('\n5. Reading the reply — JSON *and* SSE');
// ---------------------------------------------------------------------------
{
  const envelope = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: '{"a":1}' }] } };

  assert.deepStrictEqual(C.parseRpcBody(JSON.stringify(envelope), 'application/json'), envelope);
  ok('a plain JSON reply parses');

  // The same envelope delivered as a stream. An MCP server may answer either way
  // for the same call, so only handling JSON makes this look intermittently broken.
  const sse = `event: message\ndata: ${JSON.stringify(envelope)}\n\n`;
  assert.deepStrictEqual(C.parseRpcBody(sse, 'text/event-stream'), envelope);
  ok('the same envelope delivered as SSE parses identically');

  // Detected by SHAPE too, not only by the content-type header — a proxy that
  // rewrites or drops the header must not break the client.
  assert.deepStrictEqual(C.parseRpcBody(sse, 'application/octet-stream'), envelope);
  ok('SSE is recognised by shape even when the content-type is wrong');

  // Keep-alive comments, blank frames and [DONE] must be skipped, and the frame
  // carrying the actual result is the one that counts.
  const noisy = `: keep-alive\n\ndata: \n\nevent: message\ndata: ${JSON.stringify(envelope)}\n\ndata: [DONE]\n\n`;
  assert.deepStrictEqual(C.parseRpcBody(noisy, 'text/event-stream'), envelope);
  ok('keep-alives, empty frames and [DONE] are skipped');

  const err = { jsonrpc: '2.0', id: 2, error: { code: -32602, message: 'bad params' } };
  assert.deepStrictEqual(C.parseRpcBody(`data: ${JSON.stringify(err)}\n\n`, 'text/event-stream'), err);
  ok('an error envelope is picked up too, not just a result');

  assert.strictEqual(C.parseRpcBody('<html>gateway error</html>', 'text/html'), null,
    'an HTML error page is null, not a crash');
  assert.strictEqual(C.parseRpcBody('', 'application/json'), null);
  ok('an unparseable body yields null rather than throwing');
}

// ---------------------------------------------------------------------------
console.log('\n6. Getting the payload out of a tool result');
// ---------------------------------------------------------------------------
{
  // These tools return JSON inside a text block; the spec's structuredContent is
  // preferred when present.
  assert.deepStrictEqual(C.payloadOf({ content: [{ type: 'text', text: '{"isUnlocked":false}' }] }), { isUnlocked: false });
  assert.deepStrictEqual(C.payloadOf({ structuredContent: { a: 1 }, content: [{ type: 'text', text: '{"b":2}' }] }), { a: 1 },
    'structuredContent wins when both are present');
  ok('JSON in a text block is parsed; structuredContent takes priority');

  // A human-readable answer must never be thrown away just because it is not JSON.
  assert.strictEqual(C.payloadOf({ content: [{ type: 'text', text: 'No records found.' }] }), 'No records found.');
  ok('a non-JSON answer is returned as text rather than discarded');

  assert.strictEqual(C.payloadOf({}), null);
  assert.strictEqual(C.payloadOf({ content: [] }), null);
  assert.strictEqual(C.payloadOf({ content: [{ type: 'image', data: 'x' }] }), null, 'non-text blocks ignored');
  ok('an empty or non-text result is null');
}

// ---------------------------------------------------------------------------
console.log('\n7. The paid tool cannot be called by accident');
// ---------------------------------------------------------------------------
(async () => {
  // submit_contact_enrichment charges credits per person. It must be refused
  // unless the caller explicitly says it means to spend money — and the refusal
  // has to happen BEFORE any network call or token use.
  assert.ok(client.PAID_TOOLS.has('submit_contact_enrichment'), 'the enrichment tool is on the paid list');

  const refused = await client.callTool('submit_contact_enrichment', { personId: 'x' });
  assert.strictEqual(refused.ok, false);
  assert.strictEqual(refused.reason, 'paid_tool_refused');
  assert.ok(/credits/i.test(refused.detail), 'the reason says it spends credits');
  ok('the paid enrichment tool is refused without an explicit allowPaid');

  // The refusal is decided BEFORE anything about the environment is read, so no
  // arrangement of switches, URL or stored token can let a sweep spend credits.
  const refusedEvenWhenOff = await client.callTool('submit_contact_enrichment', { personId: 'x' });
  assert.strictEqual(refusedEvenWhenOff.reason, 'paid_tool_refused',
    'the paid refusal does not depend on the switch or the URL being set');
  ok('the paid refusal is switch-independent — it is about what the caller asked for');

  // A free tool gets past the paid gate and stops on the CONNECTION instead —
  // proving the refusal above is about the paid list, not about being unset.
  // Which connection reason comes back depends on whether a database happens to
  // be reachable, so this asserts only what is true either way; the two reasons
  // are told apart deterministically just below.
  const free = await client.callTool('get_contact_status', { personId: 'x' });
  assert.strictEqual(free.ok, false);
  assert.notStrictEqual(free.reason, 'paid_tool_refused', 'a free tool is not blocked by the paid gate');
  assert.ok(['store_unreadable', 'not_connected'].includes(free.reason),
    `a free tool stops on the connection, got ${free.reason}`);
  assert.ok(typeof free.detail === 'string' && free.detail.length > 0, 'the failure says why in words');
  ok('a free tool passes the paid gate and stops on the connection');

  // "We cannot READ the stored authorization" and "there IS no authorization" are
  // different facts, and reporting the first as the second sends somebody to
  // re-approve a connection that is perfectly fine. Pinned by stubbing the
  // database in the require cache, so it holds with or without a real one — the
  // first cut asserted the unreadable case outright and only passed in a sandbox
  // that had no database at all, which is a test of the environment, not the code.
  const dbPath = require.resolve('../src/db');
  const realDb = require.cache[dbPath];
  const stubDb = (query) => { require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: { query } } }; };
  try {
    stubDb(async () => { throw new Error('the database is unreachable'); });
    const unreadable = await oauth.accessToken(null);
    assert.strictEqual(unreadable.ok, false);
    assert.strictEqual(unreadable.reason, 'store_unreadable',
      'a store we cannot read is reported as unreadable, never as "not connected"');
    assert.ok(/unreachable/.test(unreadable.detail), 'and it says what actually went wrong');

    stubDb(async () => ({ rows: [] }));
    const absent = await oauth.accessToken(null);
    assert.strictEqual(absent.reason, 'not_connected',
      'a readable store with nothing in it IS "not connected"');
    ok('an unreadable authorization is never confused with an absent one');

    // Same guard one level up: whatever the store does, the lookup answers.
    stubDb(async () => { throw new Error('the database is unreachable'); });
    const viaTool = await client.callTool('get_contact_status', { personId: 'x' });
    assert.strictEqual(viaTool.ok, false, 'the lookup answers rather than throwing');
    assert.strictEqual(viaTool.reason, 'store_unreadable');
    ok('a lookup over an unreadable store answers instead of becoming a 500');
  } finally {
    if (realDb) require.cache[dbPath] = realDb; else delete require.cache[dbPath];
  }

  assert.strictEqual((await client.callTool('')).reason, 'no_tool');
  ok('an empty tool name is refused');

  // NEVER THROWS is structural, not a promise each return statement keeps. Below
  // the switch checks there is a database read, a token refresh and two HTTP
  // calls; if ANY of them throws, the officer must still get a sentence. Forced
  // here by making the token step throw outright — the one thing that cannot be
  // provoked from outside, and the one whose absence turns a lookup into a 500.
  const realAccessToken = oauth.accessToken;
  oauth.accessToken = async () => { throw new Error('boom from the token step'); };
  try {
    const thrown = await client.callTool('get_contact_status', { personId: 'x' });
    assert.strictEqual(thrown.ok, false, 'a throw below the gates is answered, not propagated');
    assert.strictEqual(thrown.reason, 'error');
    assert.ok(/boom/.test(thrown.detail), 'the reason carries what actually went wrong');
    ok('a throw anywhere below the gates comes back as a shaped answer, never a 500');
  } finally {
    oauth.accessToken = realAccessToken;
  }

  // ---------------------------------------------------------------------------
  console.log('\n8. The shared rate ceiling');
  // ---------------------------------------------------------------------------
  const b = client.budget();
  assert.strictEqual(b.platformCeilingPerHour, 1000, 'the platform ceiling is recorded');
  assert.ok(b.maxPerHour < b.platformCeilingPerHour,
    'we self-cap BELOW the platform ceiling — it is shared with every other client, '
    + 'including every officer\'s own session');
  assert.ok(b.maxPerSec >= 1);
  assert.ok(/shared/i.test(b.note), 'the note explains the ceiling is org-wide');
  ok(`self-capped at ${b.maxPerHour}/hour against a shared 1,000/hour platform limit`);

  // ---------------------------------------------------------------------------
  console.log('\n9. Each officer has their own login (owner-directed 2026-08-18)');
  // ---------------------------------------------------------------------------
  // SUPERSEDES the 2026-08-07 "one company login" answer. Asked directly while
  // directing the CRM work, the owner confirmed every loan officer has their own
  // Elementix login — which is what lets a skip trace be signed by the officer
  // who made it, rather than attributed by guesswork. (The vendor's 40-tool MCP
  // surface cannot name the account's users or list their unlocks, so if the
  // attribution is not established at the click it cannot be established at all.)
  assert.strictEqual(O.SEAT_MODEL, 'officer', 'per-officer logins, per the owner');

  // BOTH models are asserted through the PURE rule, never by driving
  // beginConnect. That is not squeamishness: CI proved that calling beginConnect
  // reaches live discovery AND dynamic client registration at Elementix from the
  // runner. Under the 'officer' model NEITHER path refuses, so there is no
  // longer any argument that returns before the first byte leaves the process —
  // which is exactly why the old live call here had to go, and why `model` is a
  // parameter.
  assert.strictEqual(O.seatRefusal('00000000-0000-0000-0000-000000000001'), null,
    'an officer connecting their own login is allowed — the point of the change');
  assert.strictEqual(O.seatRefusal(null), null,
    'and the company-wide connection still works, for an officer who has not connected');
  ok('per-officer and company-wide connections are both allowed');

  // The 'company' model is kept and still bites, because the env override can
  // restore it and a rule nobody tests is a rule that quietly stops working.
  const underCompany = O.seatRefusal('00000000-0000-0000-0000-000000000001', 'company');
  assert.ok(underCompany && underCompany.ok === false);
  assert.strictEqual(underCompany.reason, 'officer_seat_not_enabled');
  assert.ok(/company/i.test(underCompany.detail), 'and it says to connect company-wide instead');
  assert.strictEqual(O.seatRefusal(null, 'company'), null,
    'the company-wide path is never refused under either model');
  ok('the company seat model is retained and still refuses a per-officer connect');

  // …and beginConnect really consults the rule, FIRST, before any network or
  // database work. Asserted from the SOURCE rather than by calling it, because
  // under 'officer' every argument now proceeds to the wire. A source check is
  // the weaker instrument, so it asserts the ORDER — seatRefusal must appear
  // before the first `await`, which is what "decided up front" actually means.
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'elementix', 'oauth.js'), 'utf8');
  const body = src.slice(src.indexOf('async function beginConnect'));
  const seatAt = body.indexOf('seatRefusal(');
  const awaitAt = body.indexOf('await ');
  assert.ok(seatAt > 0, 'beginConnect consults the seat rule');
  assert.ok(seatAt < awaitAt,
    'and consults it BEFORE the first await — so a refusal never reaches the vendor');
  ok('the seat rule is wired into beginConnect and decided before any network call');

  // ---------------------------------------------------------------------------
  console.log('\n10. The switches actually reach the API Health page');
  // ---------------------------------------------------------------------------
  // A switch is rendered NESTED INSIDE its integration (health-registry.js line
  // ~556 filters switches by `s.integration === entry.key`), so a switch naming an
  // integration that has no registry entry renders NOWHERE — silently. Nothing
  // errors, the flag is real, `switches.on()` reads it correctly, and the owner
  // simply cannot find the toggle they were told is on that page. This caught the
  // Elementix pair before merge; it is written for EVERY switch so the next one
  // cannot repeat it.
  /* THE RULE IS "THE OWNER CAN FIND THE TOGGLE", not "the switch names a card". A
     PLATFORM-level switch (integration: null) governs every integration rather than one,
     so it deliberately hangs off no card and the API Health page renders it in its own
     banner. That is a second way to be reachable — not an excuse to be unreachable — so
     each one is ENUMERATED here (a typo'd integration key must still fail, not silently
     read as "platform-level") AND the screen is checked for a control that actually
     renders it. Declaring an exemption without that second half would hand back exactly
     the invisible-toggle bug this section exists to prevent. */
  const PLATFORM_SWITCHES = new Map([
    ['INTEGRATIONS_MONITOR_ENABLED', 'MonitorBanner'],
  ]);
  const swList = require('../src/lib/integrations/switches').list();
  const registrySrc = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'src', 'lib', 'integrations', 'health-registry.js'), 'utf8');
  const entryKeys = new Set([...registrySrc.matchAll(/^\s*key: '([a-z0-9_]+)',/gm)].map((m) => m[1]));
  const orphans = swList
    .filter((s) => !entryKeys.has(s.integration) && !(s.integration === null && PLATFORM_SWITCHES.has(s.key)))
    .map((s) => `${s.key} → ${s.integration}`);
  assert.deepStrictEqual(orphans, [],
    `every switch must hang off a real health-registry entry, else it renders nowhere: ${orphans.join(', ')}`);
  // …and every platform switch must have somewhere on the page that renders it.
  {
    const screenSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'app-v2', 'src', 'screens', 'StaffApiHealth.jsx'), 'utf8');
    for (const [key, component] of PLATFORM_SWITCHES) {
      assert.ok(new RegExp(`function ${component}\\b`).test(screenSrc),
        `${key} is platform-level, so the page needs its ${component} to render it`);
      assert.ok(/<Toggle\b/.test(screenSrc.slice(screenSrc.indexOf(`function ${component}`))),
        `${component} must render a real Toggle — a platform switch with no control is the invisible-toggle bug`);
      assert.ok(new RegExp(`<${component}\\b`).test(screenSrc), `${component} is actually mounted on the page`);
    }
  }
  assert.ok(entryKeys.has('elementix'), 'Elementix has its own entry on the API Health page');
  const elx = swList.filter((s) => s.integration === 'elementix').map((s) => s.key);
  assert.deepStrictEqual(elx.sort(), ['ELEMENTIX_DRYRUN', 'ELEMENTIX_ENABLED']);
  assert.ok(swList.filter((s) => s.integration === 'elementix').every((s) => !s.dangerous),
    'a read-only vendor has no dangerous switch — there is no write path to Elementix');
  ok(`all ${swList.length} switches hang off a real integration entry, Elementix included`);

  // The other half of the network trap at the top of this file. `discover()`
  // swallows network errors by design, so a throw on its own is invisible — this
  // is what makes an accidental live call to Elementix a FAILURE rather than a
  // silent success.
  /* ── the RFC 8707 resource is what the resource DECLARES ──────────────────
     Root cause of the live 2026-08-09 "Could not start an Elementix session":
     every token request carried our MCP URL as `resource`, while the vendor's
     own RFC 9728 metadata declares the ORIGIN. A token minted for the wrong
     audience is rejected at `initialize`, silently, forever. `indicatorOf` is
     the one reader every wire-send goes through. */
  {
    const withStored = O.indicatorOf({
      resource_url: 'https://app.elementix.com/api/mcp',
      discovery: { resourceIndicator: 'https://app.elementix.com' },
    });
    assert.strictEqual(withStored, 'https://app.elementix.com');
    ok('a row stored after the fix sends the indicator its discovery recorded');

    const legacy = O.indicatorOf({ resource_url: 'https://app.elementix.com/api/mcp', discovery: {} });
    assert.strictEqual(legacy, 'https://app.elementix.com');
    ok('a PRE-fix row falls back to the ORIGIN of its stored URL — verified live as what Elementix declares — so an existing connection self-heals on its next refresh instead of needing a human to reconnect');

    const unparsable = O.indicatorOf({ resource_url: 'not a url', discovery: null });
    assert.strictEqual(unparsable, 'not a url');
    ok('an unparsable stored URL degrades to the old behaviour rather than crashing a refresh');
  }

  /* ═══ THE AUTHORIZATION SCHEME IS CANONICAL `Bearer` ON THE WIRE ═══
     ROOT CAUSE of the live "Elementix rejected our sign-in at the session
     handshake" (owner-reported 2026-08-09, AFTER the resource-indicator fix):
     Elementix's token endpoint answers `token_type: "bearer"` in lowercase,
     the client forwarded it verbatim, and the endpoint refuses the lowercase
     scheme as "No authorization provided". Verified live with the stored
     production token: `bearer oat_…` → 401, the identical token as
     `Bearer oat_…` → 200 with the full MCP handshake. RFC 9110 makes the
     scheme case-insensitive, so canonicalizing is also correct against every
     compliant server. Reconnecting can never cure it — the vendor spells it
     lowercase on every grant and refresh — so the WIRE is where it is fixed. */
  {
    assert.strictEqual(C.bearerScheme('bearer'), 'Bearer');
    ok('the exact lowercase spelling Elementix issues goes on the wire as canonical Bearer');
    assert.strictEqual(C.bearerScheme('Bearer'), 'Bearer');
    assert.strictEqual(C.bearerScheme('BEARER'), 'Bearer');
    assert.strictEqual(C.bearerScheme(' bearer '), 'Bearer');
    ok('every case/whitespace variant of Bearer canonicalizes');
    assert.strictEqual(C.bearerScheme(''), 'Bearer');
    assert.strictEqual(C.bearerScheme(null), 'Bearer');
    assert.strictEqual(C.bearerScheme(undefined), 'Bearer');
    ok('a missing token type defaults to Bearer, as before');
    assert.strictEqual(C.bearerScheme('DPoP'), 'DPoP');
    ok('a genuinely different scheme passes through verbatim — this is a spelling fix, not a scheme override');

    // The normalizer only helps if the header is actually composed through it.
    // `post()` is the ONE place the Authorization header is built, so pin the
    // wiring at the source: a refactor that reverts to forwarding the stored
    // token_type verbatim must fail here, not in production at the handshake.
    const clientSrc = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'elementix', 'client.js'), 'utf8');
    assert.ok(/authorization: `\$\{bearerScheme\(tokenType\)\} \$\{token\}`/.test(clientSrc),
      'client.js composes the Authorization header through bearerScheme()');
    assert.ok(!/authorization: `\$\{tokenType \|\| 'Bearer'\}/.test(clientSrc),
      'the verbatim token_type forwarding is gone from the wire');
    ok('the wire composes its header through the normalizer (source-pinned)');
  }

  assert.deepStrictEqual(attemptedCalls, [],
    `this test tried to reach the vendor: ${attemptedCalls.join(', ')}`);
  ok('nothing in this suite called out to Elementix');

  console.log(`\n✓ ${n} assertions passed — Elementix connection logic is sound.\n`);
})().catch((e) => {
  console.error('\n✘ FAILED:', e && e.message);
  console.error(e && e.stack);
  process.exit(1);
});
