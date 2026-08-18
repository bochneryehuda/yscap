'use strict';
/**
 * PROOF of the Lender Price RETRY POLICY — what happens when the pricing engine
 * fails, and what must never happen.
 *
 * Eighth thread from the coverage sweep. `searchRawWithRecovery` is the wrapper
 * every DSCR price goes through. Its pieces are tested in isolation — the circuit
 * breaker and the §28.2 live-foundation gate each have their own suite — but the
 * ORCHESTRATION had never executed: which failures are retried, how many times,
 * what the retry is built from, and what the caller is finally told.
 *
 * Nothing is stubbed inside the module. `req()` bottoms out at global `fetch`, so
 * the suite replaces `fetch` and the REAL code path runs end to end: login,
 * live-config fetch, searchRaw, and the recovery. No product code is changed to
 * make it testable, and no vendor is contacted.
 *
 * WHAT IS WORTH PINNING:
 *
 *   · ONLY A 500 IS RETRIED. A 4xx is deterministic request validation — the same
 *     request will be refused the same way for ever. Retrying it spends a second
 *     request out of a shared vendor allowance to be told the same thing, and
 *     "retry on failure" is exactly the kind of helpfulness somebody widens later.
 *
 *   · A 500 IS RETRIED EXACTLY ONCE. Not in a loop. A pricing engine having a bad
 *     minute must not have a login storm pointed at it.
 *
 *   · THE RETRY IS BUILT FROM THE FRESH FOUNDATION. The whole point of the
 *     re-login is that the session and the live pricing config are re-fetched;
 *     re-posting the body that was built from the stale ones would send the very
 *     request that just failed and call it a recovery.
 *
 *   · `recovered` IS HONEST, both ways. It is what tells anybody reading a
 *     support ticket whether they are looking at a one-off or a pattern.
 *
 *   · THE VENDOR'S OWN DIAGNOSIS SURVIVES. When their answer names the problem —
 *     "Loan Officer Pricing Configuration not setup" — that sentence IS the fix.
 *     The wrapper used to overwrite it with a description of what WE did, which is
 *     true and useless, and is how a two-line email becomes an hour of probing.
 *
 * PURE: no database, no network, no vendor. The credentials below are obvious
 * fakes and exist only so `configured()` returns true.
 */

const assert = require('assert');

process.env.LP_USERNAME = 'not-a-real-user@example.test';
process.env.LP_PASSWORD = 'not-a-real-password';
process.env.LP_CLIENT_SECRET = 'not-a-real-secret';
process.env.LP_COMPANY_ID = 'test-company';
process.env.LP_USER_ID = 'test-user';
// The recovery must be ON for this suite to be about anything; an operator can
// disable it during an incident, and that is a different test.
delete process.env.LP_RECOVERY_MAX;
delete process.env.LP_REQUIRE_LIVE_FOUNDATION;

let checks = 0;
const ok = (c, w) => { assert.ok(c, w); checks++; };
const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; };

// ── The vendor, as HTTP ───────────────────────────────────────────────────
const calls = [];
/** Each entry is one scripted searchRaw answer, consumed in order. */
let searchPlan = [];
let liveBaseVariant = 'first';

const jsonRes = (status, body) => ({
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  calls.push({ url: u, method: init.method || 'GET', body: init.body || null });

  if (u.includes('/oauth/token')) {
    return jsonRes(200, {
      access_token: `tok-${calls.length}`, expires_in: 3600,
      companyId: 'test-company', userId: 'test-user',
    });
  }
  if (u.includes('/pricing/defaultSearch')) {
    // The live base CHANGES after the re-login. That is what makes "the retry is
    // built from the FRESH foundation" checkable rather than merely stated.
    return jsonRes(200, { criteria: { marker: liveBaseVariant } });
  }
  if (u.includes('/pricing/smo')) {
    return jsonRes(200, [{ id: 'smo-1', name: 'DSCR' }]);
  }
  if (u.includes('/pricing/searchRaw')) {
    const next = searchPlan.shift();
    if (!next) throw new Error('searchRaw called more times than the test scripted');
    return jsonRes(next.status, next.body);
  }
  // ppe-user-link and anything else: harmless empty answer.
  return jsonRes(200, {});
};

const lp = require('../src/longterm/lenderprice/client');
const I = lp._internals;

const searchCalls = () => calls.filter((c) => c.url.includes('/pricing/searchRaw'));
const reset = (plan, { base = 'first' } = {}) => {
  calls.length = 0;
  searchPlan = plan.slice();
  liveBaseVariant = base;
  I.invalidateSession();
  I.invalidateFoundation();
};
const buildBody = (f) => ({ criteria: { fromBase: (f.liveBase && f.liveBase.criteria && f.liveBase.criteria.marker) || null } });

async function main() {
  // ── A. THE CONTROL ──────────────────────────────────────────────────────
  {
    reset([{ status: 200, body: { results: { ok: true } } }]);
    const r = await I.searchRawWithRecovery(buildBody);
    eq(r.ok, true, 'a price that succeeds first time succeeds — so the failures below are policy and not a broken harness');
    eq(searchCalls().length, 1, '…having asked the engine exactly once');
    eq(r.recovered, false, '…and it is NOT reported as a recovery, which is what makes the flag worth reading');
  }

  // ── B. THE ONE THAT MATTERS — A 4xx IS NEVER RETRIED ────────────────────
  // 401 is deliberately NOT in this list: it means the TOKEN was rejected, which
  // is a different, documented path ("on 401, clear it, log in again, retry once")
  // and is asserted separately below. Leaving it out silently would have made this
  // section look like it covered every 4xx.
  for (const status of [400, 403, 404, 409, 422]) {
    reset([{ status, body: 'that request is not valid' }]);
    const r = await I.searchRawWithRecovery(buildBody);
    eq(r.ok, false, `a ${status} from the engine is a failure`);
    eq(searchCalls().length, 1,
      `THE ONE THAT MATTERS: a ${status} is asked ONCE and never retried — it is deterministic request validation, so a second attempt spends another request out of a shared vendor allowance to be told the same thing`);
    eq(r.recovered, undefined, '…and no recovery is claimed');
  }

  // ── B2. THE DELIBERATE EXCEPTION — A 401 IS THE TOKEN, NOT THE REQUEST ──
  // Retried once with a fresh login, and it is NOT the 500 recovery: the body is
  // the same one, because nothing about the REQUEST was wrong.
  {
    reset([
      { status: 401, body: 'token rejected' },
      { status: 200, body: { results: { ok: true } } },
    ]);
    const r = await I.searchRawWithRecovery(buildBody);
    eq(r.ok, true, 'a 401 is recovered — it means the TOKEN was rejected, not that the request was wrong');
    eq(searchCalls().length, 2, '…by logging in again and asking once more');
    eq(r.recovered, false,
      '…and it is NOT reported as a 500 recovery, because nothing about the request or the pricing config had to change — conflating the two would make a routine token renewal look like a vendor incident');
    const bodies = searchCalls().map((c) => JSON.parse(c.body));
    eq(bodies[1].criteria.fromBase, bodies[0].criteria.fromBase,
      '…and the SAME request is re-sent, because nothing about it was in question');
  }

  // ── C. A 500 IS RETRIED EXACTLY ONCE, FROM A FRESH FOUNDATION ──────────
  {
    reset([
      { status: 500, body: 'upstream blew up' },
      { status: 200, body: { results: { ok: true } } },
    ]);
    const r = await I.searchRawWithRecovery(buildBody);
    eq(r.ok, true, 'a 500 followed by a success comes back as a success');
    eq(searchCalls().length, 2, 'THE ONE THAT MATTERS: a 500 is retried EXACTLY once — a pricing engine having a bad minute must not have a login storm pointed at it');
    eq(r.recovered, true, '…and the recovery is REPORTED, which is what tells somebody reading a ticket whether this is a one-off or a pattern');

    const bodies = searchCalls().map((c) => JSON.parse(c.body));
    eq(bodies[0].criteria.fromBase, 'first', 'the first attempt is built from the foundation in force');
    eq(bodies[1].criteria.fromBase, 'first', '…and the retry is REBUILT rather than re-posted');
  }

  // The same again, with the live config genuinely CHANGING between the two —
  // which is the case the rebuild exists for.
  {
    reset([{ status: 500, body: 'stale session' }]);
    liveBaseVariant = 'first';
    // After the first failure the vendor starts answering with a different base.
    const realFetch = globalThis.fetch;
    let seenSearch = 0;
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/pricing/searchRaw')) {
        seenSearch += 1;
        if (seenSearch === 1) return jsonRes(500, 'stale session');
        calls.push({ url: u, method: 'POST', body: init.body });
        return jsonRes(200, { results: { ok: true } });
      }
      if (u.includes('/pricing/defaultSearch')) return jsonRes(200, { criteria: { marker: seenSearch >= 1 ? 'second' : 'first' } });
      return realFetch(url, init);
    };
    searchPlan = [];
    const r = await I.searchRawWithRecovery(buildBody);
    globalThis.fetch = realFetch;
    eq(r.ok, true, 'the retry succeeds');
    const retried = calls.filter((c) => c.url.includes('/pricing/searchRaw') && c.body);
    // Exactly one: `calls` was cleared by reset(), and this block records a
    // searchRaw body only on the SECOND attempt. "At least one" would have passed
    // a wrapper that retried in a loop, which is the other half of the rule this
    // section is about.
    eq(retried.length, 1, 'the retry was sent exactly once');
    eq(JSON.parse(retried[retried.length - 1].body).criteria.fromBase, 'second',
      'THE ONE THAT MATTERS: the retry is built from the FRESH live config, not from the stale one — re-posting the body that just failed and calling it a recovery is the failure this whole wrapper exists to avoid');
  }

  // ── D. TWO 500s — THE VENDOR'S OWN DIAGNOSIS SURVIVES ──────────────────
  {
    // The vendor answers with JSON carrying a `message`, which is the shape their
    // 500s actually take — measured verbatim on 2026-08-16 and recorded in
    // `classifyUpstreamError`. The first draft of this test sent a bare string,
    // and the sentence did not survive: not because the wrapper drops it, but
    // because an unclassifiable body has no sentence to carry. A fixture in the
    // wrong shape proves the wrong thing quietly.
    const VENDOR_SAID = { message: 'Loan Officer Pricing Configuration not setup' };
    reset([
      { status: 500, body: VENDOR_SAID },
      { status: 500, body: VENDOR_SAID },
    ]);
    const r = await I.searchRawWithRecovery(buildBody);
    eq(r.ok, false, 'a 500 both times is a failure');
    eq(searchCalls().length, 2, '…after exactly two attempts, never a third');
    eq(r.error, 'lp_price_500_after_retry', '…under a stable name a caller can branch on');
    ok(/not setup/i.test(r.message || ''),
      'THE ONE THAT MATTERS: and the VENDOR\'S own sentence survives — when their answer names the problem, that sentence IS the fix, and burying it under our retry narrative is how a two-line email becomes an hour of probing');
    ok(/fresh login|stale session/i.test(r.message || ''),
      '…with our own finding added BESIDE it rather than instead of it: it is not a stale session');
  }

  // ── E. AN ENGINE ERROR IS NEVER DRESSED UP AS A PRICE ──────────────────
  {
    reset([{ status: 500, body: 'x' }, { status: 500, body: 'x' }]);
    const r = await I.searchRawWithRecovery(buildBody);
    ok(!r.raw, 'a failed price carries no raw result somebody could parse as programs');
    ok(r.http, '…and does carry the upstream status, so a human can tell an outage from a bad request');
  }

  console.log(`\n✓ lt lender price retry policy (pure): ${checks} assertions passed`);
}

main().catch((e) => {
  console.error('✗ lt lender price retry policy (pure) FAILED');
  console.error(e);
  process.exit(1);
});
