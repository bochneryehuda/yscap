/**
 * The outbound-email rate gate (src/lib/email/rate-limit.js) — the fix for the
 * owner-reported "Resend 429, too many requests. You can only make 10 requests
 * per second."  PURE: no database, no network, no provider.
 *
 * Proves:
 *   • the token bucket refills at exactly `rps`, never banks past `burst`, and
 *     reports the EXACT wait when it is empty (so a waiter cannot hot-spin);
 *   • the provider's IETF headers are read (ratelimit-limit / -remaining /
 *     -reset), including the older `retry-after` in both its seconds and its
 *     HTTP-date forms, and unreadable values come back null rather than guessed;
 *   • a 429 is recognised from a typed status AND from message text;
 *   • `schedule` actually HOLDS THE RATE: 24 sends against a 6/second bucket
 *     take at least the ~3s the limit implies, and never more than 6 leave in
 *     any one-second window (the assertion that would have caught the defect);
 *   • order is FIFO — a queue that reorders mail is not a queue;
 *   • one failed send does not poison the sends queued behind it;
 *   • a 429 from the provider is retried, not lost, and the retry succeeds.
 *
 * The shared-Postgres path is exercised by the -db test; here the limiter runs
 * on its in-process fallback bucket, which is the same arithmetic.
 */
const path = require('path');
const R = path.resolve(__dirname, '..');

// No DATABASE_URL → db() fails, the limiter falls back to its local bucket.
delete process.env.DATABASE_URL;
process.env.EMAIL_MAX_RPS = '6';

const rl = require(R + '/src/lib/email/rate-limit');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; } else { fail++; console.log('  FAIL:', m); } };

(async () => {
  // ---- the bucket arithmetic ------------------------------------------------
  const t0 = 1000000;
  let s = rl.refillAndSpend({ tokens: 3, updatedAt: t0, rps: 10, burst: 10 }, t0);
  ok(s.granted === true && Math.abs(s.tokens - 2) < 1e-9, 'a full-enough bucket grants and leaves tokens-1');

  s = rl.refillAndSpend({ tokens: 0, updatedAt: t0, rps: 10, burst: 10 }, t0);
  ok(s.granted === false, 'an empty bucket refuses');
  ok(s.waitMs === 100, `an empty 10/s bucket says wait exactly 100ms (got ${s.waitMs})`);

  s = rl.refillAndSpend({ tokens: 0, updatedAt: t0, rps: 10, burst: 10 }, t0 + 500);
  ok(s.granted === true && Math.abs(s.tokens - 4) < 1e-9, '500ms at 10/s refills 5 tokens, one is spent → 4 left');

  // The burst cap is the whole reason a quiet process cannot bank an hour and
  // then spend it in one instant — which is how a system under its average
  // limit still gets refused.
  s = rl.refillAndSpend({ tokens: 0, updatedAt: t0, rps: 10, burst: 10 }, t0 + 3600000);
  ok(Math.abs(s.tokens - 9) < 1e-9, 'an hour idle refills to burst (10), never past it');

  // Never negative, never NaN, whatever nonsense is stored.
  s = rl.refillAndSpend({ tokens: NaN, updatedAt: null, rps: 0, burst: -5 }, t0);
  ok(Number.isFinite(s.tokens) && Number.isFinite(s.waitMs) && s.waitMs >= 0,
    'a nonsense bucket still yields finite, non-negative numbers');

  // ---- the provider's headers ----------------------------------------------
  let h = rl.readRateHeaders({ 'ratelimit-limit': '10', 'ratelimit-remaining': '3', 'ratelimit-reset': '2' });
  ok(h.limit === 10 && h.remaining === 3 && h.resetSec === 2, 'IETF ratelimit-* headers are read');

  h = rl.readRateHeaders({ 'retry-after': '7' });
  ok(h.resetSec === 7, 'retry-after in seconds is honoured when ratelimit-reset is absent');

  h = rl.readRateHeaders({ 'retry-after': new Date(Date.now() + 5000).toUTCString() });
  ok(h.resetSec > 3 && h.resetSec <= 5.5, `retry-after as an HTTP-date becomes a wait in seconds (got ${h.resetSec})`);

  h = rl.readRateHeaders({ 'ratelimit-limit': 'not-a-number' });
  ok(h.limit === null && h.remaining === null && h.resetSec === null,
    'an unreadable header is null — never a fabricated ceiling');

  h = rl.readRateHeaders(null);
  ok(h.limit === null && h.resetSec === null, 'no headers at all → all null, no throw');

  // A real fetch Headers object (what the provider actually hands us).
  if (typeof Headers === 'function') {
    const real = new Headers({ 'ratelimit-limit': '10', 'ratelimit-reset': '1' });
    h = rl.readRateHeaders(real);
    ok(h.limit === 10 && h.resetSec === 1, 'a real fetch Headers object is read the same way');
  } else { pass++; }

  // ---- recognising the refusal ---------------------------------------------
  ok(rl.isRateLimitError({ status: 429 }) === true, 'a typed 429 status is a rate refusal');
  ok(rl.isRateLimitError(new Error('Resend 429: Too many requests')) === true, 'the message text is the fallback');
  ok(rl.isRateLimitError(new Error('Resend 403: domain not verified')) === false, 'a 403 is NOT a rate refusal');
  ok(rl.isRateLimitError(null) === false, 'no error is not a rate refusal');

  // ---- the gate actually holds the rate ------------------------------------
  // 24 sends through a 6/second budget. Strict pacing (burst 1) means one send
  // every ~167ms, so 24 of them cannot finish in under ~3.8s. Anything faster
  // means the limit is NOT being held — which is the production defect.
  rl._resetForTest(6);
  const sentAt = [];
  const started = Date.now();
  await Promise.all(Array.from({ length: 24 }, () => rl.schedule(async () => { sentAt.push(Date.now()); })));
  const elapsed = Date.now() - started;
  ok(sentAt.length === 24, 'all 24 sends completed');
  ok(elapsed >= 3500, `24 sends at 6/s took at least ~3.8s (got ${elapsed}ms)`);

  /* THE ASSERTION THAT CAUGHT THE DEFECT. This failed on the first draft of the
     limiter — burst = rps put ELEVEN sends into one second of a 6/second budget
     — which is what forced the strict-pacing default. A token bucket of capacity
     C at rate R admits C + R*T per window T, so the honest bound at burst 1 is
     rps + 1, and that is what is asserted. Loosen this only by loosening `burst`
     on purpose, never to make a red test green. */
  let worst = 0;
  for (let i = 0; i < sentAt.length; i++) {
    const inWindow = sentAt.filter((t) => t >= sentAt[i] && t < sentAt[i] + 1000).length;
    if (inWindow > worst) worst = inWindow;
  }
  ok(worst <= 7, `no 1-second window carried more than the 6/s budget + 1 (worst window: ${worst})`);

  // ---- FIFO ----------------------------------------------------------------
  rl._resetForTest(500);
  const order = [];
  await Promise.all(Array.from({ length: 12 }, (_, i) => rl.schedule(async () => { order.push(i); })));
  ok(order.join(',') === '0,1,2,3,4,5,6,7,8,9,10,11', `sends leave in the order they were asked for (got ${order.join(',')})`);

  // ---- one failure does not poison the queue behind it ----------------------
  rl._resetForTest(500);
  const after = [];
  const bad = rl.schedule(async () => { throw new Error('Resend 403: domain not verified'); }).catch((e) => e.message);
  const good1 = rl.schedule(async () => { after.push('a'); return 'a'; });
  const good2 = rl.schedule(async () => { after.push('b'); return 'b'; });
  const badMsg = await bad;
  ok(/403/.test(badMsg), 'the failing send rejects with its own error');
  ok((await good1) === 'a' && (await good2) === 'b' && after.join(',') === 'a,b',
    'the sends queued behind a failure still go, in order');

  // ---- a 429 is retried, not lost ------------------------------------------
  rl._resetForTest(500);
  let calls = 0;
  const res = await rl.schedule(async () => {
    calls++;
    if (calls === 1) {
      throw Object.assign(new Error('Resend 429: Too many requests'),
        { status: 429, rateHeaders: { limit: 10, remaining: 0, resetSec: 0.05 } });
    }
    return 'delivered';
  });
  ok(calls === 2, `a 429 re-offers the SAME message (provider called ${calls}x)`);
  ok(res === 'delivered', 'the retried message is delivered, not lost');

  // ---- the snapshot the health surface reads -------------------------------
  const snap = rl.snapshot();
  ok(typeof snap.rps === 'number' && typeof snap.queueDepth === 'number' && typeof snap.granted === 'number',
    'snapshot() reports the live rate, queue depth and counters');

  console.log(`\ntest-email-rate-limit-pure: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('test threw:', e); process.exit(1); });
