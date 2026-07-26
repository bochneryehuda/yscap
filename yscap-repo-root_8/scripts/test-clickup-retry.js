/* WO-2 (F-H1) — ClickUp client rate-limit manners + retry contract.
 *
 * Before this, client.call() was a single bare fetch with no timeout and no
 * retry; a 429 ("slow down") threw a generic error that burned a dead-letter
 * attempt, so ClickUp's 100-req/min limit routinely turned into lost edits.
 * The fix ports the SharePoint client discipline: honor Retry-After on 429/5xx,
 * capped exponential backoff otherwise, a per-minute token bucket, and errors
 * tagged e.retryable / e.status / e.retryAfter so the durable queue can retry
 * transient failures patiently instead of dead-lettering a good edit.
 *
 * Verifies, with no DB / no network, the pure helpers the retry loop is built on:
 *   - isRetryableStatus: 429 + 5xx retry; 4xx fail fast.
 *   - backoffMs: honors Retry-After; else capped exponential; never exceeds cap.
 *   - httpError: value-free message, tagged status/retryable/retryAfter.
 * Run: node scripts/test-clickup-retry.js */
const client = require('../src/clickup/client');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// ---- isRetryableStatus: retry the transient, fail fast on client errors -----
eq('429 retryable', client.isRetryableStatus(429), true);
eq('500 retryable', client.isRetryableStatus(500), true);
eq('502 retryable', client.isRetryableStatus(502), true);
eq('503 retryable', client.isRetryableStatus(503), true);
eq('504 retryable', client.isRetryableStatus(504), true);
eq('400 NOT retryable (bad value — retrying cannot fix it)', client.isRetryableStatus(400), false);
eq('401 NOT retryable (bad token — do not hammer)', client.isRetryableStatus(401), false);
eq('403 NOT retryable', client.isRetryableStatus(403), false);
eq('404 NOT retryable', client.isRetryableStatus(404), false);
eq('200 NOT retryable', client.isRetryableStatus(200), false);

// ---- backoffMs: honor Retry-After, else capped exponential ------------------
eq('Retry-After honored (2s → 2000ms)', client.backoffMs(1, 2), 2000);
eq('Retry-After capped at 8s', client.backoffMs(1, 999), 8000);
eq('no Retry-After → attempt 1 = base 500ms', client.backoffMs(1), 500);
eq('attempt 2 = 1000ms', client.backoffMs(2), 1000);
eq('attempt 3 = 2000ms', client.backoffMs(3), 2000);
ok('backoff never exceeds the in-call cap', client.backoffMs(20) <= 8000);
ok('every attempt yields a positive wait', [1, 2, 3, 4, 5].every((a) => client.backoffMs(a) > 0));

// ---- httpError: value-free + tagged for the queue ---------------------------
{
  const e = client.httpError('POST', '/task/abc/field/dob', 429, 3);
  eq('status captured', e.status, 429);
  eq('retryable set from status', e.retryable, true);
  eq('retryAfter captured', e.retryAfter, 3);
  ok('message is value-free (field id only, never the value)',
    e.message === 'ClickUp POST /task/abc/field/dob -> 429');
}
{
  const e = client.httpError('POST', '/task/abc/field/ssn', 400);
  eq('400 not retryable', e.retryable, false);
  ok('no retryAfter when none given', e.retryAfter === undefined);
  ok('a borrower SSN never appears in the error', !/\d{3}-\d{2}-\d{4}/.test(e.message));
}

// ---- N-1 (round-2): non-idempotent create is not re-sent when it may have landed
const R = (idem, status) => client.inCallRetryAllowed(idem, status);
// Idempotent (GET/PUT/setField): retry all transient — network, 429, 5xx.
eq('idempotent + network → retry', R(true, null), true);
eq('idempotent + 429 → retry', R(true, 429), true);
eq('idempotent + 503 → retry', R(true, 503), true);
// Non-idempotent (createTask/addComment): a 429 was rejected (nothing created) →
// safe to retry; a network/timeout or 5xx MIGHT have created the card → do NOT
// re-send (that's the duplicate-PII bug N-1).
eq('create + 429 → retry (rejected, not created)', R(false, 429), true);
eq('create + network → NO retry (may have landed)', R(false, null), false);
eq('create + 502 → NO retry (ambiguous outcome)', R(false, 502), false);
eq('create + 500 → NO retry', R(false, 500), false);
// Never retry a non-transient status regardless of idempotency.
eq('idempotent + 400 → no retry', R(true, 400), false);
eq('create + 404 → no retry', R(false, 404), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
