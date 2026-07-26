'use strict';
/**
 * Unit tests for the AI resilience layer (src/lib/ai/resilience.js) — the retry/backoff,
 * error taxonomy, Retry-After honoring, and circuit breaker that wrap the two Azure clients.
 * Pure: no real clock, no real network — now/sleep/rng are all injected.
 */
const assert = require('assert');
const R = require('../src/lib/ai/resilience');

// ---------------------------------------------------------------------------
// classifyStatus — the retry/breaker decision table.
// ---------------------------------------------------------------------------
{
  for (const s of [408, 429, 500, 502, 503, 504]) {
    const c = R.classifyStatus(s);
    assert.ok(c.retryable && c.breakerFault, `${s} must be retryable + breaker fault`);
    assert.strictEqual(c.outcome, 'transient');
  }
  for (const s of [401, 403]) {
    const c = R.classifyStatus(s);
    assert.ok(!c.retryable && c.breakerFault, `${s} terminal but breaker fault (config)`);
    assert.strictEqual(c.outcome, 'auth');
  }
  const c404 = R.classifyStatus(404);
  assert.ok(!c404.retryable && c404.breakerFault && c404.outcome === 'config');
  const c400 = R.classifyStatus(400);
  assert.ok(!c400.retryable && !c400.breakerFault, '400 is a document problem, not a breaker fault');
  assert.strictEqual(c400.outcome, 'bad_request');
  assert.strictEqual(R.classifyStatus(413).outcome, 'too_large');
  assert.ok(R.classifyStatus(200).ok, '2xx is ok');
}

// ---------------------------------------------------------------------------
// classifyThrown — network drops + our own AbortController timeout are transient.
// ---------------------------------------------------------------------------
{
  const abort = R.classifyThrown({ name: 'AbortError' });
  assert.ok(abort.retryable && abort.breakerFault, 'abort/timeout is retryable');
  const reset = R.classifyThrown({ code: 'ECONNRESET', message: 'socket hang up' });
  assert.ok(reset.retryable, 'ECONNRESET is retryable');
  const weird = R.classifyThrown({ message: 'TypeError: bad thing' });
  assert.ok(!weird.retryable, 'an unknown throw is NOT blindly retried');
}

// ---------------------------------------------------------------------------
// retryAfterMs — prefer ms header, fall back to seconds, else null.
// ---------------------------------------------------------------------------
{
  const hdr = (map) => ({ get: (k) => (k.toLowerCase() in map ? map[k.toLowerCase()] : null) });
  assert.strictEqual(R.retryAfterMs(hdr({ 'retry-after-ms': '2500' })), 2500);
  assert.strictEqual(R.retryAfterMs(hdr({ 'retry-after': '3' })), 3000);
  assert.strictEqual(R.retryAfterMs(hdr({})), null);
  assert.strictEqual(R.retryAfterMs(null), null);
}

// ---------------------------------------------------------------------------
// backoffMs — full jitter stays within [0, min(cap, base*2^attempt)).
// ---------------------------------------------------------------------------
{
  const one = () => 1 - 1e-9;  // rng just under 1 → the ceiling
  assert.ok(R.backoffMs(0, { baseMs: 500, capMs: 20000, rng: one }) < 500);
  assert.ok(R.backoffMs(1, { baseMs: 500, capMs: 20000, rng: one }) < 1000);
  assert.ok(R.backoffMs(2, { baseMs: 500, capMs: 20000, rng: one }) < 2000);
  assert.ok(R.backoffMs(10, { baseMs: 500, capMs: 20000, rng: one }) <= 20000, 'capped');
  assert.strictEqual(R.backoffMs(3, { rng: () => 0 }), 0, 'rng 0 → no wait');
}

// ---------------------------------------------------------------------------
// runWithRetry — retries transient, gives up terminal, honors deadline + Retry-After.
// ---------------------------------------------------------------------------
async function main() {
  // A fake clock: now() advances only when sleep() is called.
  function fakeClock(start = 0) {
    let t = start;
    return {
      now: () => t,
      sleep: async (ms) => { t += ms; },
      advance: (ms) => { t += ms; },
    };
  }

  // (a) Succeeds on the 3rd attempt after two transient 500s.
  {
    const clk = fakeClock();
    let tries = 0;
    const waits = [];
    const res = await R.runWithRetry(async () => {
      tries += 1;
      if (tries < 3) return { ok: false, retryable: true, breakerFault: true, outcome: 'transient' };
      return { ok: true, value: 'done' };
    }, { now: clk.now, sleep: clk.sleep, rng: () => 0.5, onRetry: (r) => waits.push(r.wait), deadlineMs: 100000 });
    assert.ok(res.ok && res.value === 'done', 'eventually succeeds');
    assert.strictEqual(tries, 3, 'took three attempts');
    assert.strictEqual(waits.length, 2, 'backed off twice');
  }

  // (b) A terminal 400 is NOT retried.
  {
    const clk = fakeClock();
    let tries = 0;
    const res = await R.runWithRetry(async () => {
      tries += 1;
      return { ok: false, retryable: false, breakerFault: false, outcome: 'bad_request', reason: 'bad doc' };
    }, { now: clk.now, sleep: clk.sleep });
    assert.ok(!res.ok && tries === 1, 'terminal error tried exactly once');
  }

  // (c) Honors Retry-After: the wait is at least the header value.
  {
    const clk = fakeClock();
    let tries = 0; let waited = 0;
    await R.runWithRetry(async () => {
      tries += 1;
      if (tries === 1) return { ok: false, retryable: true, breakerFault: true, retryAfterMs: 7000 };
      return { ok: true };
    }, { now: clk.now, sleep: clk.sleep, rng: () => 0, onRetry: (r) => { waited = r.wait; }, deadlineMs: 100000 });
    assert.strictEqual(waited, 7000, 'waited the Retry-After even though jitter was 0');
  }

  // (d) Deadline stops the loop instead of waiting past it.
  {
    const clk = fakeClock();
    let tries = 0;
    const res = await R.runWithRetry(async () => {
      tries += 1;
      return { ok: false, retryable: true, breakerFault: true, retryAfterMs: 50000 };
    }, { now: clk.now, sleep: clk.sleep, rng: () => 0, deadlineMs: 10000, retries: 10 });
    assert.ok(!res.ok, 'gave up');
    assert.strictEqual(tries, 1, 'did not sleep past the deadline');
  }

  // ---------------------------------------------------------------------------
  // Breaker — opens after threshold faults, fails fast, half-opens after cooldown.
  // ---------------------------------------------------------------------------
  {
    const b = new R.Breaker({ threshold: 3, cooldownMs: 1000 });
    assert.ok(b.canRequest(0));
    b.onFailure(0); b.onFailure(0); assert.strictEqual(b.state, 'closed');
    b.onFailure(0); assert.strictEqual(b.state, 'open', 'opens on the 3rd fault');
    assert.ok(!b.canRequest(500), 'fails fast during cooldown');
    assert.ok(b.canRequest(1000), 'half-opens after cooldown');
    assert.ok(!b.canRequest(1000), 'only one probe at a time');
    b.onSuccess(); assert.strictEqual(b.state, 'closed', 'a good probe closes it');
    // A document-specific terminal error must NOT open the breaker.
    const b2 = new R.Breaker({ threshold: 2 });
    b2.onNeutral(); b2.onNeutral(); b2.onNeutral();
    assert.strictEqual(b2.state, 'closed', 'neutral doc-errors never open the breaker');

    // REGRESSION (audit #1): a neutral (blocked/truncated) result on the HALF-OPEN probe must
    // CLOSE the breaker and free the probe slot — not strand it half-open forever.
    const b3 = new R.Breaker({ threshold: 1, cooldownMs: 1000 });
    b3.onFailure(0);                       // open
    assert.ok(b3.canRequest(1000), 'half-opens after cooldown');   // consumes the probe
    b3.onNeutral();                        // the probe returned a blocked/truncated document
    assert.strictEqual(b3.state, 'closed', 'a neutral probe closes the breaker');
    assert.ok(b3.canRequest(1001), 'traffic flows again — not stranded half-open');
  }

  // (e) runWithRetry fails fast (no attempt) when the breaker is already open.
  {
    const clk = fakeClock();
    const b = new R.Breaker({ threshold: 1, cooldownMs: 100000 });
    b.onFailure(clk.now());   // open it
    let tries = 0;
    const res = await R.runWithRetry(async () => { tries += 1; return { ok: true }; },
      { now: clk.now, sleep: clk.sleep, breaker: b, label: 'the reader' });
    assert.ok(!res.ok && res.breakerOpen && tries === 0, 'open breaker fails fast without calling out');
    assert.ok(res.retryable, 'a breaker-open result is retryable (queue for later, never a fake success)');
  }

  // (f) A run of transient failures through runWithRetry trips the shared breaker.
  {
    const clk = fakeClock();
    const b = new R.Breaker({ threshold: 2, cooldownMs: 100000 });
    for (let i = 0; i < 2; i++) {
      await R.runWithRetry(async () => ({ ok: false, retryable: true, breakerFault: true }),
        { now: clk.now, sleep: clk.sleep, rng: () => 0, breaker: b, retries: 0 });
    }
    assert.strictEqual(b.state, 'open', 'repeated transient failures open the breaker');
  }

  console.log('ai-resilience: all tests passed');
}

main().catch((e) => { console.error(e); process.exit(1); });
