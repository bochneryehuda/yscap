'use strict';
/**
 * LT test — THE TOKEN IS CACHED ON A LIFETIME THIS TENANT NEVER STATES.
 *
 * `src/longterm/encompass/client.js` caches its OAuth token until
 *
 *     Date.now() + Math.max(0, (j.expires_in || 1800) - 60) * 1000
 *
 * and the master plan records, in bold, **do not remove that fallback** — because
 * this tenant DOES NOT RETURN `expires_in` at all. The measured lifetime is 30
 * minutes and 1800 is exactly that, so the line is correct; what it was not, was
 * PROTECTED.
 *
 * WITHOUT THE FALLBACK NOTHING THROWS. `undefined - 60` is NaN, `Math.max(0, NaN)`
 * is NaN, and the stored expiry is NaN — so the cache test `exp > Date.now() +
 * 30000` is false FOREVER and every single Encompass read mints a fresh token
 * first. No error, no wrong figure on a screen: just silently twice the calls and
 * an extra serialised round trip on every read, against a tenant budget of
 * 500,000 calls a day and a ceiling of 30 CONCURRENT shared with every other
 * integration touching it (§12). That is the kind of failure that is discovered
 * as a rate limit during a busy morning rather than as a test going red.
 *
 * AND THE ONE TEST THAT TOUCHED TOKEN CACHING SUPPLIED `expires_in: 3600` — a
 * value this tenant never sends. It exercised the branch that cannot happen and
 * skipped the one that always does. Same shape as the LenderPrice fixture that
 * carried a negative `basePoints` beside a positive itemised adjustment: a
 * fixture that only carries the easy case proves the half that already worked.
 *
 * So this asks the question behaviourally, through the real client, with the
 * token response THIS TENANT ACTUALLY RETURNS: does a second read re-authenticate?
 *
 * Pure — a stubbed `fetch`, no network, no database.
 */

process.env.LT_ENCOMPASS_CLIENT_ID = process.env.LT_ENCOMPASS_CLIENT_ID || 'test-client';
process.env.LT_ENCOMPASS_CLIENT_SECRET = process.env.LT_ENCOMPASS_CLIENT_SECRET || 'test-secret';
process.env.LT_ENCOMPASS_INSTANCE_ID = process.env.LT_ENCOMPASS_INSTANCE_ID || 'TESTINSTANCE';
process.env.LT_ENCOMPASS_API_BASE = 'https://api.elliemae.example';
process.env.LT_ENCOMPASS_MIN_GAP_MS = '0';

const CLIENT_PATH = '../src/longterm/encompass/client';

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

/**
 * Drive the real client through N reads against a stubbed fetch, and report how
 * many times it asked for a token.
 *
 * `tokenBody` is what the token endpoint answers. The whole point is to be able
 * to ask the question with THIS TENANT'S answer — one that carries no
 * `expires_in` — rather than with a tidy one that hides it.
 */
async function tokenCallsOver(reads, tokenBody) {
  const realFetch = global.fetch;
  let tokenCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/v1/token')) {
      tokenCalls += 1;
      return new Response(JSON.stringify(tokenBody), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    // A fresh module instance so the token cache starts empty every time.
    delete require.cache[require.resolve('../src/longterm/config')];
    delete require.cache[require.resolve(CLIENT_PATH)];
    const c = require(CLIENT_PATH);
    for (let i = 0; i < reads; i += 1) await c.apiGet(`/encompass/v3/loans/guid-${i}`);
    return tokenCalls;
  } finally {
    global.fetch = realFetch;
    delete require.cache[require.resolve(CLIENT_PATH)];
  }
}

/**
 * Fire N reads AT ONCE and report what reached the wire.
 *
 * `tokenCallsOver` above drives its reads sequentially, which is what Long-Term
 * actually does today — so it can never see either of the properties below. A
 * burst is the shape that catches them, and the shape the first parallel sweep
 * somebody writes will have.
 */
async function burstOf(n, opts = {}) {
  const realFetch = global.fetch;
  let tokenCalls = 0; let reads = 0; let inflight = 0; let peakConcurrent = 0;
  global.fetch = async (url) => {
    inflight += 1; peakConcurrent = Math.max(peakConcurrent, inflight);
    await new Promise((r) => setTimeout(r, 5));   // a request takes time, or nothing can overlap
    inflight -= 1;
    if (String(url).endsWith('/oauth2/v1/token')) {
      tokenCalls += 1;
      if (opts.failFirstToken && tokenCalls === 1) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    reads += 1;
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete require.cache[require.resolve('../src/longterm/config')];
    delete require.cache[require.resolve(CLIENT_PATH)];
    const c = require(CLIENT_PATH);
    await Promise.all(Array.from({ length: n }, (_, i) => c.apiGet(`/encompass/v3/loans/g${i}`).catch(() => null)));
    return { tokenCalls, reads, peakConcurrent };
  } finally {
    global.fetch = realFetch;
    delete require.cache[require.resolve(CLIENT_PATH)];
  }
}

/**
 * One read that fails to get a token, then another. The first must not leave its
 * rejected attempt sitting in the single-flight slot for the next caller.
 */
async function sequentialAfterFailure() {
  const realFetch = global.fetch;
  let tokenCalls = 0;
  global.fetch = async (url) => {
    if (String(url).endsWith('/oauth2/v1/token')) {
      tokenCalls += 1;
      if (tokenCalls === 1) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    delete require.cache[require.resolve('../src/longterm/config')];
    delete require.cache[require.resolve(CLIENT_PATH)];
    const c = require(CLIENT_PATH);
    await c.apiGet('/encompass/v3/loans/a').catch(() => null);
    let secondSucceeded = false;
    await c.apiGet('/encompass/v3/loans/b').then(() => { secondSucceeded = true; }).catch(() => {});
    return { tokenCalls, secondSucceeded };
  } finally {
    global.fetch = realFetch;
    delete require.cache[require.resolve(CLIENT_PATH)];
  }
}

async function main() {
  console.log('the token is cached even though this tenant states no lifetime');

  // THE CASE THAT ACTUALLY HAPPENS: the measured token response, verbatim.
  const real = await tokenCallsOver(5, { access_token: 't', token_type: 'Bearer' });
  check(real === 1,
    `THE ONE THAT MATTERS: five reads against a token response with NO expires_in — the shape this tenant actually returns — asked for a token ${real} time(s); it must be 1, or every read re-authenticates against a 500,000-a-day budget with a 30-concurrent ceiling`);

  // The case the previous fixture covered, kept so the ordinary path stays proven.
  const stated = await tokenCallsOver(5, { access_token: 't', expires_in: 3600 });
  check(stated === 1,
    'and five reads against a response that DOES state a lifetime also ask once — the branch the old fixture covered still works');

  // A lifetime so short the token is already stale must NOT be cached: the
  // fallback is there to supply a missing number, never to override a stated one.
  const shortLived = await tokenCallsOver(3, { access_token: 't', expires_in: 10 });
  check(shortLived === 3,
    'a stated lifetime of 10 seconds is honoured rather than replaced by the fallback — three reads, three tokens, because a token we know is stale must never be reused');

  // THE 60-SECOND MARGIN. A token good for another 75 seconds is NOT reused: 60
  // are given back so a request already in flight cannot outlive its own token,
  // and the read-time check keeps 30 more. Without the margin a 75-second token
  // looks comfortably fresh and gets handed to a call that may still be running
  // when it dies — which arrives as a 401 from Encompass, not as a test failure.
  const nearEnd = await tokenCallsOver(3, { access_token: 't', expires_in: 75 });
  check(nearEnd === 3,
    `a token with 75 seconds left is re-minted rather than reused (${nearEnd} of 3) — the 60 seconds handed back are what stop a request outliving the token it was sent with`);
  const comfortable = await tokenCallsOver(3, { access_token: 't', expires_in: 120 });
  check(comfortable === 1,
    '…while two minutes is comfortably fresh and IS reused, so the margin trims the end of a life rather than refusing to cache at all');

  // And a lifetime that is not a number is not a lifetime. `Number(true)` is 1,
  // which would read as a one-second token; the safe answer is to re-authenticate
  // rather than to cache on a figure nobody sent.
  const junk = await tokenCallsOver(2, { access_token: 't', expires_in: 'soon' });
  check(junk === 2,
    `and an unreadable lifetime caches NOTHING — two reads asked twice (${junk}), because "soon" − 60 is NaN and a token must never be held on a figure nobody sent`);

  // ── A BURST MINTS ONE TOKEN, AND NEVER RUNS SIDE BY SIDE ─────────────────
  //
  // Two properties the master plan's §12 budget risk rests on, neither of which
  // anything checked. The cache is read at the TOP of getToken, so before the
  // single-flight guard a burst of callers each saw an empty cache and each
  // minted their own: MEASURED at five concurrent reads issuing five tokens plus
  // five reads — ten calls where six would do, against 500,000 a day shared with
  // every integration on this tenant.
  console.log('\na burst of readers mints ONE token and never runs side by side');

  const burst = await burstOf(5);
  check(burst.tokenCalls === 1,
    `THE ONE THAT MATTERS: five concurrent reads asked for ${burst.tokenCalls} token(s) — one, or a parallel sweep quietly doubles the tenant's call budget`);
  check(burst.reads === 5, `…and still performed all five reads (${burst.reads})`);
  check(burst.peakConcurrent === 1,
    `and no two Encompass requests were ever in flight together (peak ${burst.peakConcurrent}) — this tenant's ceiling is 30 CONCURRENT and it is shared with RTL, so Long-Term holding at one is what keeps a sweep from starving the other product`);

  // A token request that FAILS must not be handed to the next caller for ever.
  // Concurrent callers correctly SHARE one failed attempt — that is what
  // single-flight means — so the property is about the read that comes AFTER it.
  const afterFailure = await sequentialAfterFailure();
  check(afterFailure.tokenCalls === 2 && afterFailure.secondSucceeded,
    `a failed token is never left in flight as the answer — the next read asks again and succeeds (${afterFailure.tokenCalls} attempts)`);

  console.log('\nand the fallback is still the measured 30 minutes');
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/longterm/encompass/client.js'), 'utf8');
  check(/expires_in \|\| 1800/.test(src),
    'the fallback is 1800 seconds — the lifetime this tenant was MEASURED to give, so the cache expires when the token really does rather than at a guess');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
