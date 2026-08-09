'use strict';
/**
 * THE ROOT CAUSE OF THE FLAPPING DOWN-ALERTS (owner-reported 2026-08-09: "why is
 * everything going down every day a few times and getting back up so soon?").
 *
 * Nothing was going down. Two self-inflicted delays were pushing PILOT's OWN health
 * probes past their OWN 8-second deadline, so a perfectly healthy vendor was reported
 * "not reachable" and then "back up" minutes later:
 *
 *   1. `api-rate-limit.acquire()` deliberately WAITS — up to a minute — when a bucket is
 *      empty. Six vendor clients call it, and every probe is wrapped in an 8-second
 *      timebox, so during any busy sync the probe queued behind our own pacing and timed
 *      out. `runAsHealthProbe` marks the probe's async tree so the limiter never holds it.
 *   2. `probeAll` fired all 28 probes at once, so they competed for TLS handshakes,
 *      sockets and rate-limit tokens under that same deadline. It now runs a bounded pool.
 *
 * Both halves are tested here with no network and no database (the DB half only adds the
 * `waits`-counter rule). The monitor's own behaviour — the silent window, one email per
 * sweep, who receives it — is `test-integrations-monitor.js`.
 */
const assert = require('assert');
const rate = require('../src/lib/api-rate-limit');
const health = require('../src/lib/integrations/health-registry');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- PURE: the probe context follows the call, and nothing else ----
{
  assert.strictEqual(rate.inHealthProbe(), false, 'ordinary code is not in a probe');

  // It survives awaits — the whole point, since the limiter is reached several async
  // frames down inside a vendor client.
  const seen = [];
  const done = rate.runAsHealthProbe(async () => {
    seen.push(rate.inHealthProbe());
    await sleep(5);
    seen.push(rate.inHealthProbe());
    await Promise.resolve().then(() => seen.push(rate.inHealthProbe()));
    return 'value';
  });
  // Code OUTSIDE the probe, running concurrently, must NOT be inside it — a shared
  // module-level flag would have leaked here and let real traffic skip the limiter.
  assert.strictEqual(rate.inHealthProbe(), false, 'concurrent ordinary work is unaffected');

  done.then((v) => {
    assert.strictEqual(v, 'value', 'runAsHealthProbe returns what the probe returned');
    assert.deepStrictEqual(seen, [true, true, true], 'the context survives every await');
    assert.strictEqual(rate.inHealthProbe(), false, 'and is gone once the probe finishes');
  });

  // A probe that THROWS must not leave the context set for whatever runs next.
  rate.runAsHealthProbe(async () => { throw new Error('probe blew up'); })
    .catch(() => assert.strictEqual(rate.inHealthProbe(), false, 'a failed probe leaves no context behind'));
}

// ---- PURE: bounded probe concurrency (order kept, pool never exceeded) ----
(async () => {
  const map = health._internals.mapWithConcurrency;

  // 28 items — the real registry's size — through a pool of 6.
  const items = Array.from({ length: 28 }, (_, i) => i);
  let inFlight = 0, peak = 0;
  const out = await map(items, 6, async (n) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(1 + (n % 3));                       // uneven, so a slow one can't stall the rest
    inFlight--;
    return n * 10;
  });
  assert.strictEqual(peak, 6, 'never more than the limit in flight at once');
  assert.deepStrictEqual(out, items.map((n) => n * 10), 'results come back in REGISTRY ORDER, not finish order');

  // A slow item holds ONE slot, not the batch — the reason for a pool over Promise.all
  // chunking. With 8 fast items and one 40ms straggler through a pool of 2, the fast ones
  // keep flowing on the other worker.
  const order = [];
  await map([40, 1, 1, 1, 1, 1, 1, 1, 1], 2, async (ms, i) => { await sleep(ms); order.push(i); });
  assert.strictEqual(order[order.length - 1], 0, 'the slow item finishes last while the rest flow past it');

  // Degenerate inputs behave.
  assert.deepStrictEqual(await map([], 6, async () => 1), [], 'an empty list resolves to an empty list');
  assert.deepStrictEqual(await map([1, 2], 99, async (n) => n), [1, 2], 'a limit larger than the list is fine');
  assert.deepStrictEqual(await map([1, 2, 3], 1, async (n) => n), [1, 2, 3], 'a limit of 1 is a plain sequence');
  assert.ok(health._internals.PROBE_CONCURRENCY >= 1, 'the registry has a real concurrency limit');
  console.log('  ok - probeAll runs a bounded pool: order kept, no 28-way stampede');

  // ---- PURE: inside a probe, the limiter never holds the call ----
  /* The limiter is switched off for this section so ONLY the per-process bucket's wait is
     measured — that is the delay being tested, and it keeps the test off the database and
     out of the shared bucket's state. `acquire` still applies the local bucket and still
     reports `capped` when it could not take a token, so the two paths stay comparable. */
  const env = { ...process.env };
  try {
    process.env.API_RATE_LIMIT_DISABLED = '1';
    process.env.CLICKUP_MAX_RPM = '600';            // 100 ms to refill one token
    // Drain the per-process bucket. `takeLocal` with a deadline of "now" never sleeps, so
    // this empties it in a few milliseconds.
    let taken = 0;
    while (taken < 5000 && await rate._internals.takeLocal('clickup', Date.now())) taken++;
    assert.ok(taken > 0, 'the bucket was full to start with, and is now empty');

    // AN ORDINARY CALLER WAITS — this is correct, and is what the probe was doing wrong.
    let t = Date.now();
    let r = await rate.acquire('clickup', { maxWaitMs: 5000 });
    const ordinaryWait = Date.now() - t;
    assert.ok(ordinaryWait >= 50, `an ordinary caller waits for a token (waited ${ordinaryWait}ms)`);
    assert.strictEqual(r.capped, false, 'and then gets one');

    // A PROBE DOES NOT. Drain again (the wait above earned a token) and re-measure.
    while (await rate._internals.takeLocal('clickup', Date.now())); // eslint-disable-line no-empty
    t = Date.now();
    r = await rate.runAsHealthProbe(() => rate.acquire('clickup'));   // the DEFAULT 60s deadline
    const probeWait = Date.now() - t;
    assert.ok(probeWait < 50, `a probe is never held (waited ${probeWait}ms, ordinary caller ${ordinaryWait}ms)`);
    assert.strictEqual(r.capped, true, 'it reports that it took no token — it just does not queue for one');

    // With a token free, a probe still SPENDS it — a health check is a real request and is
    // never exempt from the budget, only from the queue.
    process.env.CLICKUP_MAX_RPM = '7';              // re-sizing re-fills the bucket
    const before = await rate.runAsHealthProbe(() => rate.acquire('clickup'));
    assert.strictEqual(before.capped, false, 'a probe takes a token when one is available');
  } finally { process.env = env; }
  console.log('  ok - a health probe never queues behind our own rate limiter');

  // ---- DB: a probe never inflates the `waits` counter ----
  if (!process.env.DATABASE_URL) {
    console.log('SKIP test-health-probe-no-queue DB half (no DATABASE_URL)');
    console.log('test-health-probe-no-queue: probe context + bounded concurrency + no-queue pass');
    return;
  }
  const db = require('../src/db');
  await require('../src/migrate-boot').ensureSchema();
  const env2 = { ...process.env };
  const waits = async () => Number((await db.query(
    `SELECT waits FROM api_rate_limits WHERE api = 'clickup'`)).rows[0].waits);
  try {
    process.env.CLICKUP_MAX_RPM = '600';
    while (await rate._internals.takeLocal('clickup', Date.now())); // eslint-disable-line no-empty

    /* `waits` is the owner's signal that a REAL cap is squeezing REAL work — the number
       they would act on by raising a limit. A health check inflating it would send them
       chasing a limit that is not in anyone's way. */
    const w0 = await waits();
    await rate.runAsHealthProbe(() => rate.acquire('clickup'));
    assert.strictEqual(await waits(), w0, 'a held probe does not count as a wait');

    // …while an ordinary caller held by the same empty bucket DOES count. (maxWaitMs 0 so
    // it reports the hold without sleeping.)
    await rate.acquire('clickup', { maxWaitMs: 0 });
    assert.strictEqual(await waits(), w0 + 1, 'an ordinary caller held by the cap IS counted');
    await db.query(`UPDATE api_rate_limits SET waits = $1 WHERE api = 'clickup'`, [w0]);
  } finally { process.env = env2; }

  console.log('test-health-probe-no-queue: probe context + bounded concurrency + no-queue + waits-counter pass');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
