'use strict';
/**
 * LONG-TERM — CONCURRENT LOANNEX SEARCHES SHARE ONE LOGIN.
 *
 * ── THE BUG THIS PINS ──────────────────────────────────────────────────────
 * The GENERAL DSCR engine runs `bracket-run.js` with `CONCURRENCY = 3`, and that
 * file's own header PROMISES the client "holds ONE shared service login behind a
 * single-flight lock … so concurrent searches don't collide." It did not: on a
 * COLD session cache, three `getSession` calls each saw no cached session and
 * each fired a FULL portal sign-in at once — three simultaneous logins on one
 * service account, which a form-based portal rejects/rate-limits. Every band
 * threw, the LoanNEX half of the board was dropped, and (a separate defect) the
 * reason was swallowed.
 *
 * The COMBINED engine makes exactly ONE `nex.price` call → one login → never
 * collides. That is precisely why Combined pulled LoanNEX live while the General
 * engine "showed nothing." The credentials were never the problem (confirmed:
 * NEX_USERNAME and NEX_PASSWORD are set on the live server); the missing lock was.
 *
 * PURE: the network work (`performLogin`) is replaced through the client's own
 * `_impl` seam and counted. No vendor, no credentials, no database.
 */

const client = require('../src/longterm/loannex/client');
const { singleFlight, sessions, _impl } = client._internals;

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const tick = () => new Promise((r) => setTimeout(r, 5));

async function run() {
  console.log('\n── A. singleFlight dedupes concurrent work by key ──');
  {
    const map = new Map();
    let calls = 0;
    const work = async () => { calls += 1; await tick(); return { n: calls }; };
    const [a, b, c] = await Promise.all([
      singleFlight(map, 'k', work), singleFlight(map, 'k', work), singleFlight(map, 'k', work),
    ]);
    ok(calls === 1, `three concurrent calls on one key ran the work ONCE (ran ${calls})`);
    ok(a === b && b === c, 'all three got the SAME result');
    ok(map.size === 0, 'the slot is cleared once it settles');
  }

  console.log('\n── B. a different key is its own flight ──');
  {
    const map = new Map();
    let calls = 0;
    const work = async () => { calls += 1; await tick(); return calls; };
    await Promise.all([singleFlight(map, 'x', work), singleFlight(map, 'y', work)]);
    ok(calls === 2, `two different keys each ran once (${calls})`);
  }

  console.log('\n── C. a rejection propagates AND clears the slot (no poisoned key) ──');
  {
    const map = new Map();
    let calls = 0;
    const boom = async () => { calls += 1; await tick(); throw new Error('boom'); };
    let threwCount = 0;
    await Promise.all([0, 0, 0].map(() => singleFlight(map, 'e', boom).catch(() => { threwCount += 1; })));
    ok(calls === 1, `a failing call still ran once for three waiters (${calls})`);
    ok(threwCount === 3, 'all three waiters saw the failure');
    ok(map.size === 0, 'the failed slot is cleared, so the next attempt can retry');
    const okAfter = await singleFlight(map, 'e', async () => 'recovered');
    ok(okAfter === 'recovered', 'a later attempt on the same key runs fresh');
  }

  console.log('\n── D. getSession: concurrent cold-cache callers share ONE login ──');
  {
    const realPerform = _impl.performLogin;
    let logins = 0;
    _impl.performLogin = async (p) => { logins += 1; await tick(); const sess = { portal: p, token: 't', userGuid: 'g', expiresAt: Date.now() + 55 * 60 * 1000 }; sessions.set(p, sess); return sess; };
    try {
      sessions.clear(); // COLD cache — the exact state at the start of a general search
      const results = await Promise.all([
        client.getSession('web'), client.getSession('web'), client.getSession('web'),
      ]);
      ok(logins === 1, `three concurrent cold getSession('web') → ONE login (got ${logins})`);
      ok(results[0] === results[1] && results[1] === results[2], 'all three got the same session');

      console.log('\n── E. the CONTROL: without the lock it would be three logins ──');
      // Prove the detector bites: the OLD path was concurrent performLogin calls.
      sessions.clear(); logins = 0;
      await Promise.all([_impl.performLogin('web'), _impl.performLogin('web'), _impl.performLogin('web')]);
      ok(logins === 3, `three UNLOCKED concurrent logins really do sign in three times (got ${logins}) — the collision the lock removes`);

      console.log('\n── F. a warm session is reused with ZERO logins ──');
      logins = 0;
      const warm = await Promise.all([client.getSession('web'), client.getSession('web')]);
      ok(logins === 0, `a warm cache signs in ZERO more times (got ${logins})`);
      ok(warm[0].token === 't', 'and returns the cached session');

      console.log('\n── G. force always mints its own fresh login ──');
      logins = 0;
      await client.getSession('web', { force: true });
      ok(logins === 1, `force re-signs in even on a warm cache (got ${logins})`);
    } finally {
      _impl.performLogin = realPerform;
      sessions.clear();
    }
  }

  console.log(`\ntest-lt-loannex-login-singleflight-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
run();
