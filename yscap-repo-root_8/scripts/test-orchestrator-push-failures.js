/* WO-1 (F-C1) — a failed ClickUp field write must NEVER be silently swallowed.
 *
 * Before this fix, orchestrator.pushApplication caught a setField error, logged
 * it, and CONTINUED; the function returned normally and pushOutboxOnce marked
 * the queue job 'done' — so a ClickUp 429/500/timeout on one field silently
 * dropped the staffer's edit (no retry, no review row). The fix records every
 * failure PII-FREE and throws after the loop so the queue retries and, on
 * exhaustion, dead-letters to a visible review card.
 *
 * Verifies, with no DB / no network, the two pure helpers the fix is built on:
 *   1. recordFieldFailure — tracks a failure with ONLY field id / status / code
 *      / message; NEVER the value being written (GLBA: no PII in error trails).
 *   2. assertPushComplete — returns null when nothing failed (push may complete)
 *      and an Error tagged CLICKUP_FIELD_WRITES_FAILED when anything failed (the
 *      push must throw, not be marked done). The message is PII-free.
 * Run: node scripts/test-orchestrator-push-failures.js */
const orch = require('../src/clickup/orchestrator');

let pass = 0, fail = 0;
const eq = (name, got, exp) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL ${name}: got ${g} expected ${e}`); }
};
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// A realistic client error (client.js builds exactly this shape — value-free).
function clickupErr(path, status) {
  const e = new Error(`ClickUp POST ${path} -> ${status}`);
  e.status = status; e.body = { err: 'rate limit', ECODE: 'OAUTH_077' };
  return e;
}

// ---- 1. recordFieldFailure: PII-free, correct shape ------------------------
{
  const stats = { written: 2, suppressed: 0, blocked: 0, failed: 0 };
  const failures = [];
  orch.recordFieldFailure(stats, failures, 'field-DOB-id', clickupErr('/task/abc/field/dob', 429));
  eq('failed counter increments', stats.failed, 1);
  eq('one failure recorded', failures.length, 1);
  // The record must carry ONLY these keys — never the value being written.
  eq('record keys are id/status/code/retryable/message only',
    Object.keys(failures[0]).sort(), ['code', 'fieldId', 'message', 'retryable', 'status']);
  eq('captures field id', failures[0].fieldId, 'field-DOB-id');
  eq('captures HTTP status', failures[0].status, 429);
  ok('message is the value-free client message',
    failures[0].message === 'ClickUp POST /task/abc/field/dob -> 429');
}

// A borrower's real DOB value must never leak into the failure record, even if
// an exotic error object carried it. We only ever store fieldId/status/code and
// the (client-produced, value-free) message — assert the value is nowhere.
{
  const stats = { written: 0, suppressed: 0, blocked: 0, failed: 0 };
  const failures = [];
  const e = new Error('ClickUp POST /task/x/field/y -> 400'); e.status = 400; e.code = 'BAD';
  orch.recordFieldFailure(stats, failures, 'field-x', e);
  const serialized = JSON.stringify(failures[0]);
  ok('no borrower value anywhere in the record', !/1990-05-03|123-45-6789/.test(serialized));
  eq('captures error code', failures[0].code, 'BAD');
  eq('permanent failure is not retryable', failures[0].retryable, false);
}

// WO-2: the client tags transient errors e.retryable; the record must carry it
// faithfully so the queue can retry patiently vs dead-letter fast.
{
  const stats = { written: 0, suppressed: 0, blocked: 0, failed: 0 };
  const failures = [];
  const transient = new Error('ClickUp POST /t -> 503'); transient.status = 503; transient.retryable = true;
  orch.recordFieldFailure(stats, failures, 'f503', transient);
  eq('retryable flag propagates from the client error', failures[0].retryable, true);
}

// ---- 2. assertPushComplete: null when clean, throws-error when anything failed
{
  const clean = { written: 3, suppressed: 1, blocked: 1, failed: 0 };
  eq('no failures → returns null (push may complete)', orch.assertPushComplete(clean, []), null);
  eq('null stats → null', orch.assertPushComplete(null, null), null);
}
{
  const stats = { written: 1, suppressed: 0, blocked: 0, failed: 2 };
  const failures = [
    { fieldId: 'field-DOB-id', status: 429, code: null, message: 'ClickUp POST /task/abc/field/dob -> 429' },
    { fieldId: 'status', status: 500, code: null, message: 'ClickUp PUT /task/abc -> 500' },
  ];
  const err = orch.assertPushComplete(stats, failures);
  ok('returns an Error', err instanceof Error);
  eq('tagged for queue classification', err && err.code, 'CLICKUP_FIELD_WRITES_FAILED');
  ok('message names how many failed', /2 field write\(s\) failed/.test(err.message));
  ok('message lists field ids + statuses', /field-DOB-id:429/.test(err.message) && /status:500/.test(err.message));
  ok('message is PII-free (no DOB/SSN value)', !/1990|123-45-6789/.test(err.message));
  eq('partial counts exposed', err.partial, { written: 1, failed: 2 });
}

// WO-2: retryability of the whole push — all-transient retries patiently; any
// permanent failure dead-letters sooner (so a bad value surfaces as a card).
{
  const allTransient = orch.assertPushComplete(
    { written: 0, failed: 2 },
    [{ fieldId: 'a', status: 429, retryable: true }, { fieldId: 'b', status: 503, retryable: true }]);
  eq('all-transient push is retryable (queue waits it out)', allTransient.retryable, true);

  const mixed = orch.assertPushComplete(
    { written: 0, failed: 2 },
    [{ fieldId: 'a', status: 429, retryable: true }, { fieldId: 'b', status: 400, retryable: false }]);
  eq('one permanent failure → not retryable (dead-letters to a card)', mixed.retryable, false);
}

// ---- 3. the whole point: a lossy push cannot silently "succeed" -------------
// Simulate the loop outcome: 3 fields, 1 threw. assertPushComplete MUST yield a
// throw so pushApplication never returns normally (which would mark the job done).
{
  const stats = { written: 2, suppressed: 0, blocked: 0, failed: 0 };
  const failures = [];
  orch.recordFieldFailure(stats, failures, 'loan_amount-field', clickupErr('/task/abc/field/amt', 500));
  const err = orch.assertPushComplete(stats, failures);
  ok('one failed write forces a throw (job will retry, not be marked done)', err instanceof Error);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
