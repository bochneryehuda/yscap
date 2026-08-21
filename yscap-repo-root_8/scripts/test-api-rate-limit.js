#!/usr/bin/env node
/**
 * NEVER MORE THAN THE CAP IN A MINUTE — ACROSS EVERY PROCESS.
 *
 * Owner-directed 2026-08-07: "ClickUp called me up with a warning about their API: we
 * cannot ask them for more than 100 requests per minute. Please set up this rule in our
 * system: never allow more than 100 requests within a minute. Also, look at our other
 * APIs that were doing too many requests… We shouldn't get throttled across all of our
 * APIs, but don't get the limits too aggressive."
 *
 * THE ONE ASSERTION THAT MATTERS is section 4: two SEPARATE NODE PROCESSES, sharing one
 * budget, cannot together exceed it. That is the hole ClickUp phoned about — each process
 * paced itself perfectly and the token still saw double.
 *
 * The DB sections SKIP without DATABASE_URL, like the rest of the suite. In `npm test`.
 */
'use strict';

const fs = require('fs');
const path = require('path');

let fails = 0;
function ok(cond, what) {
  if (cond) { console.log(`  ✓ ${what}`); return; }
  fails++; console.error(`  ✗ ${what}`);
}
const read = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

console.log('\n1. Every cap sits UNDER the provider ceiling, and none is aggressive');
{
  const RL = require('../src/lib/api-rate-limit');
  ok(RL.rpmFor('clickup') <= 100, `ClickUp is capped at or under its documented 100/min (${RL.rpmFor('clickup')})`);
  ok(RL.rpmFor('clickup') >= 60, '…but not so low that an ordinary sync pass crawls');
  ok(RL.rpmFor('osm') <= 60, `Nominatim is held to ~1/sec, its published policy (${RL.rpmFor('osm')}/min)`);
  ok(RL.rpmFor('google_geocode') > RL.rpmFor('osm') * 5,
    'Google has its OWN, far larger bucket — sharing Nominatim’s would make the live autocomplete crawl');
  for (const api of ['graph', 'encompass', 'trustpoint', 'sitewire']) {
    ok(RL.rpmFor(api) >= 100, `${api} gets a ceiling, not a brake (${RL.rpmFor(api)}/min)`);
  }
  ok(RL.rpmFor('nonexistent') === 60, 'an unknown API falls back to a safe default rather than unlimited');
  // Env override, so a provider's change needs no deploy.
  const before = process.env.CLICKUP_MAX_RPM;
  process.env.CLICKUP_MAX_RPM = '45';
  ok(RL.rpmFor('clickup') === 45, 'the cap is env-overridable at runtime');
  process.env.CLICKUP_MAX_RPM = '0';
  ok(RL.rpmFor('clickup') === 90, 'a nonsense override falls back to the default rather than to zero (which would stall everything)');
  if (before === undefined) delete process.env.CLICKUP_MAX_RPM; else process.env.CLICKUP_MAX_RPM = before;
}

console.log('\n2. Every outbound client that had no pacing now has some');
{
  const wired = [
    ['../src/clickup/client.js', 'clickup'],
    ['../src/lib/sharepoint.js', 'graph'],
    ['../src/lib/integrations/encompass.js', 'encompass'],
    ['../src/trustpoint/client.js', 'trustpoint'],
    ['../src/sitewire/client.js', 'sitewire'],
    ['../src/lib/osm-gate.js', 'osm'],
    ['../src/lib/address-canon.js', 'google_geocode'],
  ];
  for (const [f, api] of wired) {
    const s = read(f);
    ok(new RegExp(`acquire\\('${api}'`).test(s), `${path.basename(f)} paces itself on the shared '${api}' budget`);
  }
  // The ClickUp client must not keep a SECOND rate number that disagrees with the
  // enforced one — that was the shape of the original defect.
  const cu = read('../src/clickup/client.js');
  ok(!/const RPM =/.test(cu), 'clickup/client.js no longer carries its own RPM constant');
  // Encompass stays READ-ONLY: the limiter may only WAIT.
  const enc = read('../src/lib/integrations/encompass.js');
  ok(/READ_ONLY/.test(enc) && !/apiPost|apiPut|apiPatch|apiDelete/.test(enc.split('module.exports')[1] || ''),
    'the Encompass freeze is untouched — the limiter adds no method, path or export');
}

console.log('\n3. It fails OPEN, and never waits forever');
{
  const s = read('../src/lib/api-rate-limit.js');
  ok(/return \{ ok: 'unavailable' \}/.test(s),
    'a database error skips the shared layer rather than blocking every integration');
  ok(/await takeLocal\(api, deadline\)/.test(s),
    '…and the per-process bucket is ALWAYS applied, so that degrades to today’s behaviour');
  ok(/if \(deadline != null && Date\.now\(\) \+ wait > deadline\) return false/.test(s),
    'maxWaitMs bounds the LOCAL layer too — a limiter that advertises a maximum must honour it everywhere');
  ok(/maxWaitMs = 60000/.test(s), 'a hold is bounded — the work proceeds rather than being silently abandoned');
  ok(/waits = waits \+ 1/.test(s), 'a hold is COUNTED, so "real traffic wants more than the cap" is visible before a provider phones');
  ok(/API_RATE_LIMIT_DISABLED/.test(s), 'there is an incident escape hatch');
  ok(/still apply, so this never means "unlimited"/.test(s), '…which still leaves the per-process buckets in place');
}

/* ------------------------------------------------------------------ DB ---- */
(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('\nSKIP the DB sections (no DATABASE_URL)');
    console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ api rate limit: all pure assertions passed\n');
    process.exit(fails ? 1 : 0);
  }
  const db = require('../src/db');
  const RL = require('../src/lib/api-rate-limit');
  const TEST_API = 'ratelimit_selftest';

  const reset = async (rpm) => {
    await db.query(
      `INSERT INTO api_rate_limits (api, capacity, refill_per_min, tokens, last_refill_at, waits)
       VALUES ($1,$2,$2,$2, now(), 0)
       ON CONFLICT (api) DO UPDATE SET capacity=$2, refill_per_min=$2, tokens=$2, last_refill_at=now(), waits=0`,
      [TEST_API, rpm]);
  };

  try {
    console.log('\n4. TWO SEPARATE PROCESSES cannot together exceed one budget');
    // THE REPORTED HOLE. A tiny budget makes it measurable in seconds: with 12 tokens/min
    // the bucket starts full at 12 and refills only ~0.2/sec, so two processes each asking
    // for 12 can get at most ~12 + a trickle. Before the shared bucket each would have got
    // all 12 — 24 in total, which is the ClickUp 140.
    await reset(12);
    RL.DEFAULTS[TEST_API] = { rpm: 12, env: 'RL_SELFTEST_MAX_RPM' };
    const child = `
      process.env.DATABASE_URL = ${JSON.stringify(process.env.DATABASE_URL)};
      const RL = require(${JSON.stringify(path.join(__dirname, '../src/lib/api-rate-limit.js'))});
      RL.DEFAULTS[${JSON.stringify(TEST_API)}] = { rpm: 12, env: 'RL_SELFTEST_MAX_RPM' };
      (async () => {
        let got = 0;
        for (let i = 0; i < 12; i++) {
          const r = await RL.acquire(${JSON.stringify(TEST_API)}, { maxWaitMs: 1 });
          if (!r.capped) got += 1;
        }
        process.stdout.write(String(got));
        process.exit(0);
      })();`;
    const { execFileSync } = require('child_process');
    const run = () => Number(execFileSync(process.execPath, ['-e', child], { encoding: 'utf8' }).trim());
    // Two independent processes, back to back, each trying to take the whole budget.
    const a = run();
    const b = run();
    ok(a + b <= 14,
      `two processes took ${a} + ${b} = ${a + b} tokens from a 12/min budget — the cap holds ACROSS processes ` +
      '(before this each would have taken all 12, for 24)');
    ok(a >= 1, 'the first process was not starved (it got ' + a + ')');

    console.log('\n5. The bucket SMOOTHS — a per-minute counter would allow double at the boundary');
    await reset(60);
    RL.DEFAULTS[TEST_API] = { rpm: 60, env: 'RL_SELFTEST_MAX_RPM' };
    // Drain it, then confirm a further request is HELD rather than served. Drain until it
    // actually refuses rather than counting to the capacity and assuming: 60/min is a token
    // a second, so on a database that answers slowly the bucket refills faster than a fixed
    // 60-iteration loop empties it, and the 61st request is legitimately served. That made
    // this assertion fail on the clock instead of on the behaviour. Draining still outruns
    // refilling by a wide margin (a round trip would have to take a full second to keep up),
    // so the bound below is a runaway guard, never the normal exit.
    let held = null;
    let drained = 0;
    for (let i = 0; i < 400 && !held; i++) {
      const r = await RL._internals.takeShared(TEST_API);
      if (r.ok === true) drained += 1; else held = r;
    }
    ok(held && held.ok === false && held.waitMs > 0,
      `an over-budget request is held after ${drained} served (waitMs ${held && held.waitMs}) — ` +
      'not served, and not a hot spin');
    ok(held && held.waitMs > 0 && held.waitMs <= 2000,
      'the hold is short so the caller re-checks promptly rather than stalling');
    // A refill genuinely brings a token back.
    await db.query(`UPDATE api_rate_limits SET last_refill_at = now() - interval '10 seconds' WHERE api=$1`, [TEST_API]);
    const after = await RL._internals.takeShared(TEST_API);
    ok(after.ok === true, 'ten seconds of refill at 60/min yields a token again');

    console.log('\n6. A hold is recorded, and an unmanaged API is left alone');
    await reset(1);
    RL.DEFAULTS[TEST_API] = { rpm: 1, env: 'RL_SELFTEST_MAX_RPM' };
    await RL.acquire(TEST_API, { maxWaitMs: 1 });          // takes the only token
    const r2 = await RL.acquire(TEST_API, { maxWaitMs: 30 });
    ok(r2.capped === true, 'a request that cannot be served inside its budget proceeds rather than being dropped');
    const w = (await db.query(`SELECT waits FROM api_rate_limits WHERE api=$1`, [TEST_API])).rows[0];
    ok(Number(w.waits) >= 1, 'and the hold was counted');
    const un = await RL._internals.takeShared('no_such_api_row');
    ok(un.ok === 'unavailable', 'an API with no row is reported unavailable, never blocked');

    console.log('\n7. The real ClickUp row exists and is under 100');
    const cu = (await db.query(`SELECT capacity, refill_per_min FROM api_rate_limits WHERE api='clickup'`)).rows[0];
    ok(!!cu, 'db/482 seeded the clickup bucket');
    ok(Number(cu.refill_per_min) <= 100 && Number(cu.capacity) <= 100,
      `and both its capacity and rate are at or under 100 (${cu.capacity}/${cu.refill_per_min})`);
  } catch (e) {
    fails++; console.error('  ✗ DB section threw:', e.message);
  } finally {
    try { await db.query(`DELETE FROM api_rate_limits WHERE api=$1`, [TEST_API]); } catch (_) { /* best-effort */ }
  }
  console.log(fails ? `\n✗ ${fails} assertion(s) failed\n` : '\n✓ api rate limit: all assertions passed\n');
  process.exit(fails ? 1 : 0);
})();
