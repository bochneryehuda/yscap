'use strict';
/**
 * PROOF that a secret cannot travel out of the long-term Encompass client in an
 * error string.
 *
 * WHY. `mintToken` puts the token endpoint's OWN response body into the message it
 * throws on a failed mint. `ping()` turns that message into `reason`, and
 * `routes/encompass-knowledge.js` returns `reason` in an HTTP response — so
 * whatever the identity server chose to say about our request travels, verbatim,
 * onto a screen and into every log that catches it. The request we sent it carries
 * the client secret and, on the password grant, the user's password.
 *
 * Most OAuth servers answer a bad grant with `{"error":"invalid_client"}` and
 * nothing more. "Most" is not a property to rely on for a credential — and the
 * Lender Price client in this same repository has scrubbed for exactly this reason
 * since it shipped. This side had no scrubber at all.
 *
 * The probe used to hand back the ACCESS TOKEN as well. No caller has ever read it:
 * the one diagnostic that calls `tokenProbe` prints the granted scope and the
 * status. A live credential in a returned object that nothing uses is the worst
 * version of the field-nobody-reads shape this side keeps finding — harmless right
 * up until somebody logs the whole result.
 *
 * PURE: `fetch` is replaced, so nothing reaches Encompass. The credentials below
 * are obvious fakes.
 */

const assert = require('assert');

const SECRET = 'lt-fake-client-secret-DO-NOT-USE';
const PASSWORD = 'lt-fake-password-DO-NOT-USE';

process.env.LT_ENCOMPASS_CLIENT_ID = 'fake-client-id';
process.env.LT_ENCOMPASS_CLIENT_SECRET = SECRET;
process.env.LT_ENCOMPASS_INSTANCE_ID = 'fakeinstance';
process.env.LT_ENCOMPASS_USERNAME = 'fake.user';
process.env.LT_ENCOMPASS_PASSWORD = PASSWORD;

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// A token endpoint that echoes the whole request back in its refusal — which is
// the case worth defending against, and the one nobody can rule out.
let nextTokenResponse = null;
globalThis.fetch = async (url, init = {}) => {
  const body = init.body ? String(init.body) : '';
  const r = nextTokenResponse(body);
  return { ok: r.status === 200, status: r.status, text: async () => r.text };
};

const client = require('../src/longterm/encompass/client');
const { scrub } = client._internals;

async function main() {
  ok(client.configured(), 'the fake credentials are enough for the client to consider itself configured');

  // ── A. THE SCRUBBER ITSELF ──────────────────────────────────────────────
  ok(!scrub(`oops ${SECRET} oops`).includes(SECRET), 'the client secret is removed wherever it appears');
  ok(!scrub(`oops ${PASSWORD} oops`).includes(PASSWORD), 'and so is the password');
  ok(scrub(`a ${SECRET} b`).includes('<redacted>'), '…replaced with something a reader can see happened, not silently dropped');
  ok(!scrub('{"access_token":"abc.def-123"}').includes('abc.def-123'), 'a token in a JSON body is removed even though we never compared it to anything');
  ok(!scrub('Authorization: Bearer abc.def-123').includes('abc.def-123'), '…and one in a Bearer header');
  ok(!scrub(`client_secret=${SECRET}&grant_type=password`).includes(SECRET),
    '…and one in a form-encoded body, which is the shape the request we send actually has');
  eq(scrub(null), '', 'a null scrubs to an empty string rather than the word "null"');
  eq(scrub('nothing secret here'), 'nothing secret here', 'and an innocent string is left exactly alone');

  // ── B. THE ONE THAT MATTERS — A FAILED MINT ─────────────────────────────
  nextTokenResponse = (body) => ({
    status: 401,
    // The server hands our own request straight back. Some do.
    text: `{"error":"invalid_client","error_description":"bad request: ${body}"}`,
  });
  const pinged = await client.ping();
  eq(pinged.ok, false, 'a refused token mint reports as unreachable');
  ok(!pinged.reason.includes(SECRET),
    'THE ONE THAT MATTERS: and the client secret is NOT in the reason — which is returned in an HTTP response and written to every log that catches it');
  ok(!pinged.reason.includes(PASSWORD), '…nor the password');
  ok(/<redacted>/.test(pinged.reason), '…with the redaction visible, so nobody debugging thinks the field was simply empty');
  ok(/401/.test(pinged.reason), '…while the status still comes through, because the whole point is to say what went wrong');

  // ── C. THE PROBE DOES NOT HAND BACK A TOKEN ─────────────────────────────
  nextTokenResponse = () => ({
    status: 200,
    text: '{"access_token":"a-real-looking-token-value","scope":"lp","expires_in":1800}',
  });
  const granted = await client.tokenProbe(null);
  eq(granted.ok, true, 'a successful probe reports success');
  eq(granted.granted, 'lp', '…and what we were actually granted, which is the whole question it asks');
  ok(!('token' in granted),
    'THE ONE THAT MATTERS: and the access token is NOT in the result at all — no caller ever read it, and a live credential in a field nothing uses is harmless right up until somebody logs the whole object');
  ok(!JSON.stringify(granted).includes('a-real-looking-token-value'),
    '…checked across the WHOLE result rather than the one field it used to sit in');

  // A refused probe scrubs its error the same way.
  nextTokenResponse = (body) => ({ status: 400, text: `refused: ${body}` });
  const refused = await client.tokenProbe('lp');
  eq(refused.ok, false, 'a refused probe reports the refusal');
  ok(!refused.error.includes(SECRET), 'and its error carries no secret either');
  ok(!refused.error.includes(PASSWORD), '…nor the password');

  console.log(`\n✓ lt encompass secret scrub (pure): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt encompass secret scrub (pure) FAILED');
  console.error(e);
  process.exit(1);
});
