'use strict';
/**
 * LT test — the pass that runs on its own, with no database and no tenant.
 *
 * Everything the long-term side mirrors filled only when a human pressed a
 * button. The questions here are the ones that decide whether a scheduled pass is
 * safe to hand a shared, rate-limited API:
 *
 *   · is it OFF until somebody turns it on, and does it SAY so?
 *   · does a pass actually call both syncs — or is this another writer nothing
 *     ever calls, one level up?
 *   · can a slow pass overlap the next tick and double our share of the budget?
 *   · can a failing sync take the server down through a timer?
 */

const path = require('path');

let failures = 0;
const check = (cond, msg) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failures += 1; console.error(`  FAIL ${msg}`); }
};

// The two syncs are replaced in the module cache BEFORE the worker is required,
// so the real pass runs end to end against stubs — a source grep would prove a
// call exists, not that it happens.
const loansPath = require.resolve('../src/longterm/sync/loans');
const condPath = require.resolve('../src/longterm/conditions/sync');
const calls = [];
let loanBehaviour = async () => { calls.push('loans'); return { ok: true, discovered: 3, read: 2, failed: 0, more: false }; };
let condBehaviour = async () => { calls.push('conditions'); return { ok: true, due: 1, read: 1, failed: 0, more: false }; };

require.cache[loansPath] = { id: loansPath, filename: loansPath, loaded: true, exports: { syncOnce: (...a) => loanBehaviour(...a) } };
require.cache[condPath] = { id: condPath, filename: condPath, loaded: true, exports: { syncOnce: (...a) => condBehaviour(...a) } };

const worker = require('../src/longterm/sync/worker');

// The log line is the only thing anybody watching a deployment sees, so it is
// captured rather than left to scroll past.
const logged = [];
const realLog = console.log;
console.log = (...a) => { logged.push(a.join(' ')); };

(async () => {
  console.log = realLog;
  console.log('it is off until somebody turns it on');
  console.log = (...a) => { logged.push(a.join(' ')); };

  delete process.env.LT_SYNC_ENABLED;
  const offResult = worker.start();
  console.log = realLog;
  check(offResult === false,
    'with no switch set, nothing is scheduled — so this ships to every deployment as it stands and changes none of them');
  check(logged.some((l) => /disabled/.test(l) && /LT_SYNC_ENABLED/.test(l)),
    '…and it says WHY, naming the switch: a worker that is silently off looks exactly like one that is broken');

  for (const v of ['0', 'false', 'no', '', '   ']) {
    process.env.LT_SYNC_ENABLED = v;
    if (worker._internals.enabled()) { failures += 1; console.error(`  FAIL "${v}" should not turn it on`); }
  }
  check(true, 'and "0", "false", "no" and a blank all mean off');
  for (const v of ['1', 'true', 'YES', 'On']) {
    process.env.LT_SYNC_ENABLED = v;
    if (!worker._internals.enabled()) { failures += 1; console.error(`  FAIL "${v}" should turn it on`); }
  }
  check(true, 'while "1", "true", "yes" and "on" all mean on, in any casing');

  console.log('\na pass really does call both syncs');

  calls.length = 0;
  const out = await worker.tickOnce();
  check(calls.join() === 'loans,conditions',
    'the loans first, then the Condition Center — a scheduled pass that calls neither is the same failure as a mirror with no writer, one level up');
  check(out.loans && out.loans.ok === true && out.conditions && out.conditions.ok === true,
    'and both answers are returned, so a caller can see what happened');

  console.log('\none half failing never costs the other');

  calls.length = 0;
  loanBehaviour = async () => { calls.push('loans'); throw new Error('Encompass 503'); };
  const halfOut = await worker.tickOnce();
  check(calls.includes('conditions'),
    'a loan pass that THREW still leaves the conditions read running — the two read different things and fail for different reasons');
  check(halfOut.loans.ok === false && /503/.test(halfOut.loans.reason),
    '…and the failure is reported rather than swallowed');
  loanBehaviour = async () => { calls.push('loans'); return { ok: true, discovered: 3, read: 2 }; };

  calls.length = 0;
  condBehaviour = async () => { calls.push('conditions'); throw new Error('conditions exploded'); };
  const half2 = await worker.tickOnce();
  check(half2.loans.ok === true && half2.conditions.ok === false,
    'and the other way round: a conditions failure never undoes the loans that were just mirrored');
  condBehaviour = async () => { calls.push('conditions'); return { ok: true, due: 1, read: 1 }; };

  console.log('\na slow pass never overlaps the next tick');

  // A real (short) delay rather than a gate somebody has to open: a mutated
  // worker that DOES overlap then finishes and fails the assertion, instead of
  // deadlocking on a promise the second pass is holding — a hanging test burns a
  // CI slot and says nothing about what is wrong.
  const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
  loanBehaviour = async () => { calls.push('loans'); await wait(120); return { ok: true, read: 1 }; };
  calls.length = 0;
  const slow = worker.tickOnce();
  const second = await worker.tickOnce();
  check(second.ok === false && /already running/.test(second.reason),
    'a tick landing on a busy pass is SKIPPED, not queued — queueing would double our share of an API budget shared with every other integration, and keep doing it on a slow tenant');
  await slow;
  check(calls.filter((c) => c === 'loans').length === 1,
    '…and the skipped tick really did no work: it read nothing, rather than reading the same loans a second time');
  loanBehaviour = async () => { calls.push('loans'); return { ok: true, read: 1 }; };

  const after = await worker.tickOnce();
  check(after.loans.ok === true,
    '…and the pass after it runs normally: the skip releases itself even when the slow one failed');

  console.log('\nnothing it does can take the server down');

  const src = require('fs').readFileSync(path.join(__dirname, '..', 'src/longterm/sync/worker.js'), 'utf8');
  check(/setTimeout\(safeTick/.test(src) && /setInterval\(safeTick/.test(src),
    'every timer fires the WRAPPED tick — an unhandled rejection inside a timer takes the whole process down, and a sync that kills the server is worse than a sync that misses an hour');
  check(/\.catch\(/.test(src.slice(src.indexOf('const safeTick'))),
    '…and that wrapper catches');

  console.log('\nit schedules nothing but reads');

  check(!/apiPost|apiPut|apiPatch|apiDelete|INSERT|UPDATE|DELETE/.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')),
    'the worker writes nothing itself — it schedules two passes that each own their own writes, and it can reach neither Encompass nor a database directly');

  const indexSrc = require('fs').readFileSync(path.join(__dirname, '..', 'src/longterm/index.js'), 'utf8');
  check(/require\('\.\/sync\/worker'\)\.start\(\)/.test(indexSrc),
    'and it is started by the long-term module itself, not from src/server.js — that would be a SECOND seam into Long-Term, which is exactly what the separation gate refuses');

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log = realLog;
  console.error('FAIL unexpected error:', (e && e.message) || e);
  process.exit(1);
});
