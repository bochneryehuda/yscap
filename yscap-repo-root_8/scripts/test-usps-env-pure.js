/**
 * "THE USPS KEYS ARE ALREADY IN RENDER" — and if they are under a different name,
 * the integration says "not connected" forever and nobody can tell why.
 *
 * That sentence is the owner's, and it is the exact situation this guards. The
 * code reads `USPS_CLIENT_ID` / `USPS_CLIENT_SECRET`; a value set under any other
 * name is invisible to it, and from the outside "never configured" and "configured
 * under a name we do not read" look identical. One of them is a five-second fix
 * nobody knows to make.
 *
 * TWO BEHAVIOURS, and the second is the one that earns its keep:
 *   1. The common alternate names are accepted (USPS's own portal calls the same
 *      v3 OAuth pair "Consumer Key" / "Consumer Secret" on some screens).
 *   2. When it is STILL not configured, it says what it can SEE — by variable
 *      name, never by value — so the health screen names the problem instead of
 *      restating the symptom.
 *
 * AND ONE ALIAS DELIBERATELY REFUSED: a Web Tools user id is a credential for a
 * DIFFERENT (older, XML) USPS API. Aliasing it into the OAuth client would produce
 * an authentication failure that reads as "your key is wrong" when the truth is
 * "that is a key for another service".
 *
 * Pure. Run: node scripts/test-usps-env-pure.js
 */
'use strict';
const E = require('../src/lib/usps-env');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log(`FAIL ${m}`); } };
const NEVER = 'sk_live_do_not_print_me';

// ---------------------------------------------------------------------------
// A. THE DOCUMENTED NAMES STILL WIN
// ---------------------------------------------------------------------------
{
  const c = E.credentials({ USPS_CLIENT_ID: 'id', USPS_CLIENT_SECRET: 'sec' });
  ok(c.clientId === 'id' && c.clientSecret === 'sec', 'the documented names are read');
  ok(c.idName === 'USPS_CLIENT_ID', 'and reported as the ones in use');
  ok(E.describe({ USPS_CLIENT_ID: 'id', USPS_CLIENT_SECRET: 'sec' }).detail === 'Credentials are set.',
    'with nothing extra to say when they are exactly where they are documented to be');

  // A deployment that sets BOTH the canonical and an alternate keeps the
  // documented behaviour rather than silently switching.
  const both = E.credentials({ USPS_CLIENT_ID: 'canonical', USPS_CONSUMER_KEY: 'alternate',
    USPS_CLIENT_SECRET: 's' });
  ok(both.clientId === 'canonical', 'the canonical name takes priority when both are set');
}

// ---------------------------------------------------------------------------
// B. THE ALTERNATES ARE ACCEPTED, AND IT SAYS WHICH IT USED
// ---------------------------------------------------------------------------
{
  for (const [idName, secName] of [
    ['USPS_CONSUMER_KEY', 'USPS_CONSUMER_SECRET'],
    ['USPS_API_KEY', 'USPS_API_SECRET'],
    ['USPS_KEY', 'USPS_SECRET'],
  ]) {
    const env = { [idName]: 'id', [secName]: 'sec' };
    const c = E.credentials(env);
    ok(c.clientId === 'id' && c.clientSecret === 'sec', `${idName} / ${secName} are accepted`);
    const d = E.describe(env);
    ok(d.configured === true, `and read as configured`);
    ok(d.detail.includes(idName) && d.detail.includes(secName),
      `saying which names it used, so nobody has to guess: ${d.detail}`);
  }
  // Mixed pairs are ordinary — somebody sets one half from an old deployment.
  const mixed = E.credentials({ USPS_CLIENT_ID: 'a', USPS_CONSUMER_SECRET: 'b' });
  ok(mixed.clientId === 'a' && mixed.clientSecret === 'b', 'the two halves are resolved independently');
}

// ---------------------------------------------------------------------------
// C. WHEN IT IS NOT CONFIGURED, IT NAMES WHAT IT CAN SEE
// ---------------------------------------------------------------------------
{
  const none = E.describe({});
  ok(none.configured === false, 'nothing set reads as not configured');
  ok(/no usps credentials are set at all/i.test(none.detail),
    'and says so plainly rather than implying something is broken: ' + none.detail);

  // HALF SET is the confusing one — the screen used to say the same thing as
  // nothing set, which sends somebody looking for a key they already added.
  const half = E.describe({ USPS_CLIENT_ID: 'id' });
  ok(half.configured === false, 'one half alone is not configured');
  ok(/secret is not/i.test(half.detail), 'and it says WHICH half is missing: ' + half.detail);
  ok(half.detail.includes('USPS_CLIENT_ID'), 'naming the one that IS set');

  // A USPS-ish variable under a name we do not read — the whole point.
  const wrong = E.describe({ USPS_ADDRESS_KEY: 'x', USPS_ADDRESS_SECRET: 'y' });
  ok(wrong.configured === false, 'a key under an unrecognised name is still not configured');
  ok(wrong.unread.join(',') === 'USPS_ADDRESS_KEY,USPS_ADDRESS_SECRET',
    'but it is SEEN, and listed');
  ok(/are set but are not names this reads/i.test(wrong.detail) && /rename it/i.test(wrong.detail),
    'and the sentence tells somebody what to do about it: ' + wrong.detail);

  // NEVER A VALUE. This is a public-ish diagnostic on an admin screen and the
  // whole point is that it can be read out loud.
  const secretful = E.describe({ USPS_ADDRESS_KEY: NEVER, USPS_CLIENT_ID: NEVER });
  ok(!JSON.stringify(secretful).includes(NEVER),
    'the diagnostic never contains a credential VALUE, anywhere in it');
  ok(secretful.seen.every((n) => /^USPS/.test(n)), 'it only ever lists variable NAMES');
}

// ---------------------------------------------------------------------------
// D. THE WEB TOOLS CREDENTIAL IS NAMED, NEVER USED
// ---------------------------------------------------------------------------
{
  const wt = { USPS_USERID: '123ABC456' };
  const c = E.credentials(wt);
  ok(c.clientId == null && c.clientSecret == null,
    'a Web Tools user id is NEVER used as an OAuth client id — it is a key for a different API');
  const d = E.describe(wt);
  ok(d.webTools.includes('USPS_USERID'), 'it is recognised');
  ok(/web tools/i.test(d.detail) && /older/i.test(d.detail) && /developer\.usps\.com/i.test(d.detail),
    'and explained, so an authentication failure is never mistaken for a wrong key: ' + d.detail);
  ok(/client id AND secret/i.test(d.detail), 'saying what IS needed instead');

  // Having a Web Tools id alongside a real pair must not stop the real pair working.
  const both = E.describe({ USPS_USERID: 'old', USPS_CLIENT_ID: 'id', USPS_CLIENT_SECRET: 'sec' });
  ok(both.configured === true, 'and an old Web Tools id sitting alongside real keys changes nothing');
}

// ---------------------------------------------------------------------------
// E. IT READS THE REAL ENVIRONMENT BY DEFAULT, AND CANNOT THROW
// ---------------------------------------------------------------------------
{
  ok(typeof E.describe().detail === 'string', 'it works against the real environment with no argument');
  for (const junk of [null, undefined, {}, { USPS_CLIENT_ID: '' }, { USPS_CLIENT_ID: '   ' }]) {
    let threw = false;
    try { E.describe(junk === null || junk === undefined ? {} : junk); } catch (e) { threw = true; }
    ok(!threw, `it does not throw on ${JSON.stringify(junk)}`);
  }
  ok(E.credentials({ USPS_CLIENT_ID: '   ' }).clientId == null,
    'a whitespace-only value is not a credential — it would authenticate as nothing and report as set');
}

console.log(`\ntest-usps-env-pure: ${pass} passed${fail ? `, ${fail} FAILED` : ''}`);
process.exit(fail ? 1 : 0);
