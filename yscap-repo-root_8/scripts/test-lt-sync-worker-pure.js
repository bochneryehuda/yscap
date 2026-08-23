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
  // INVERTED 2026-08-23, owner-directed: "Set up the pullback and set everything on."
  // It shipped off because a worker nobody asked for should cost nothing; the owner
  // has asked for it. What used to be asserted here — that an untouched deployment is
  // unaffected — is still true and still asserted, just one layer down: with no
  // credentials the pass is REFUSED rather than not scheduled, which is proven in the
  // drain section below.
  console.log('it is on unless somebody turns it off');

  delete process.env.LT_SYNC_ENABLED;
  check(worker._internals.enabled() === true,
    'with no switch set it is ON — the owner asked for the pullback to run on its own (2026-08-23)');

  for (const v of ['0', 'false', 'no', 'OFF']) {
    process.env.LT_SYNC_ENABLED = v;
    if (worker._internals.enabled()) { failures += 1; console.error(`  FAIL "${v}" should turn it off`); }
  }
  check(true, 'and "0", "false", "no" and "off" all turn it off, in any casing');
  for (const v of ['1', 'true', 'YES', 'On', '', '   ']) {
    process.env.LT_SYNC_ENABLED = v;
    if (!worker._internals.enabled()) { failures += 1; console.error(`  FAIL "${v}" should leave it on`); }
  }
  check(true, 'while "1"/"true"/"yes"/"on" AND a blank all leave it on — a variable somebody cleared rather '
    + 'than removed must not silently stop the sync');
  delete process.env.LT_SYNC_ENABLED;

  console.log = (...a) => { logged.push(a.join(' ')); };
  process.env.LT_SYNC_ENABLED = '0';
  const offResult = worker.start();
  console.log = realLog;
  check(offResult === false, 'and with it off, nothing is scheduled');
  check(logged.some((l) => /disabled/.test(l) && /LT_SYNC_ENABLED/.test(l)),
    '…and it says WHY, naming the switch: a worker that is silently off looks exactly like one that is broken');
  delete process.env.LT_SYNC_ENABLED;

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

  // ── THE BACKFILL ────────────────────────────────────────────────────────────
  // Owner-directed 2026-08-23: "she will automatically pull old files and also
  // future files." `loans.syncOnce` reads 25 a pass, so 772 files is ~31 passes —
  // at one pass per 20-minute tick that is ten hours before anybody sees their
  // closed book. A tick therefore keeps going while there is more to do.
  console.log('\nthe backfill drains the history rather than trickling it');

  const { drainLoans } = worker._internals;

  {
    // A book of 130 due, 25 a pass. The stub counts down exactly as the real one
    // does: `remaining` is what says whether to go round again.
    let left = 130;
    let passes = 0;
    loanBehaviour = async () => {
      passes += 1;
      const read = Math.min(25, left);
      left -= read;
      return { ok: true, discovered: 130, due: left + read, read, failed: 0, remaining: left };
    };
    const out = await drainLoans(() => 0);
    check(passes === 6 && out.caughtUp === true,
      'a 130-file backlog is drained in ONE tick — six passes of 25, not six ticks two hours apart');
    check(out.read === 130,
      'THE ONE THAT MATTERS: every file is accounted for across the drain (130 read), so the totals describe the '
      + 'whole tick rather than only its last pass');
    check(out.passes === 6, '…and the answer says how many passes it took, so a stalled backfill is visible');
  }

  {
    // The ordinary steady state, and the reason this is cheap once the history is in.
    let passes = 0;
    loanBehaviour = async () => { passes += 1; return { ok: true, discovered: 40, read: 0, failed: 0, remaining: 0 }; };
    const out = await drainLoans(() => 0);
    check(passes === 1 && out.caughtUp === true,
      'THE ONE THAT MATTERS: a caught-up book costs exactly ONE pass — the drain is a backfill, not a busy loop, '
      + 'and `needsRead` is answered from the database so nothing re-reads a loan Encompass has not touched');
  }

  {
    // A pass that always claims more to do is a bug; it must burn a bounded number
    // of calls rather than every call the tenant has.
    let passes = 0;
    const CEILING = worker._internals.MAX_PASSES + 5;
    loanBehaviour = async () => {
      passes += 1;
      // THE STUB REFUSES TO BE OVER-CALLED, and that is not decoration. Written the
      // obvious way — a clock that never advances and a sync that always says "more"
      // — removing the cap makes this test LOOP FOR EVER rather than fail: in CI that
      // is a six-hour job timeout with no assertion pointing at the cause. Found by
      // running the mutation rather than by reading it. Throwing here turns the same
      // regression into an immediate, named failure.
      if (passes > CEILING) throw new Error(`the drain called syncOnce ${passes} times — the pass cap is not being applied`);
      return { ok: true, discovered: 9, read: 1, failed: 0, remaining: 999 };
    };
    const out = await drainLoans(() => 0);
    check(passes === worker._internals.MAX_PASSES && out.caughtUp === false,
      `THE ONE THAT MATTERS: a sync that always reports "more to do" is capped at ${worker._internals.MAX_PASSES} `
      + 'passes — an API budget shared with every other integration must not be drained by one loop that cannot end');
  }

  {
    // The wall clock is the normal end of a long drain: the gap before the next tick
    // is what has to be protected.
    let passes = 0;
    loanBehaviour = async () => { passes += 1; return { ok: true, discovered: 9, read: 1, failed: 0, remaining: 500 }; };
    let clock = 0;
    const out = await drainLoans(() => { clock += 200000; return clock; });   // 200s per pass
    check(passes < worker._internals.MAX_PASSES && out.caughtUp === false,
      'a slow drain is ended by the WALL CLOCK before the pass cap, so it can never still be running when the '
      + 'next tick lands');
  }

  {
    // AND THE PROPERTY THAT USED TO BE "OFF BY DEFAULT". Turning the worker on is not
    // the same as making it do something: a deployment with no long-term Encompass
    // credentials is refused, once, and the drain stops rather than retrying 60 times.
    let passes = 0;
    loanBehaviour = async () => {
      passes += 1;
      return { ok: false, reason: 'Encompass is not connected yet — add the long-term Encompass credentials first.' };
    };
    const out = await drainLoans(() => 0);
    check(passes === 1 && out.ok === false,
      'THE ONE THAT MATTERS: with no credentials the drain costs exactly ONE refused call — flipping the switch '
      + 'on changes nothing for a deployment that never configured long-term Encompass, which is what made the '
      + 'default safe to flip');
    check(/not connected/.test(out.reason || ''),
      '…and the reason survives, so the log says why rather than reporting a silent zero');
  }

  // Restore the stub the rest of the file expects.
  loanBehaviour = async () => { calls.push('loans'); return { ok: true, discovered: 3, read: 2, failed: 0, remaining: 0 }; };

  // ── IT MUST NOT PIN THE PROCESS OPEN ───────────────────────────────────────
  // A pending timer keeps the Node event loop alive. The day this worker went ON by
  // default that stopped being a detail: every process that merely REQUIRES the
  // long-term module could no longer exit, so all 100 `test-lt-*` suites hung and the
  // chain went from 32 seconds to a ten-minute timeout.
  //
  // ASSERTED BY ACTUALLY EXITING, in a child process, because that is the only thing
  // that proves it. A source grep for `unref` would pass against a build where the
  // call was made on the wrong handle, and asserting on a returned timer object would
  // test the stub rather than the schedule.
  console.log('\nstarting the worker does not stop the process ending');
  {
    const { spawnSync } = require('child_process');
    const workerPath = require.resolve('../src/longterm/sync/worker');
    const r = spawnSync(process.execPath,
      ['-e', `require(${JSON.stringify(workerPath)}).start();`],
      { timeout: 15000, encoding: 'utf8', env: { ...process.env, LT_SYNC_ENABLED: '1' } });
    check(r.status === 0 && !r.error,
      'THE ONE THAT MATTERS: a process that starts the worker and has nothing else to do EXITS — the poll timers '
      + 'are unref\'d, so requiring the long-term module never again hangs a test, a CLI or a migration runner');
  }

  console.log(failures ? `\n${failures} FAILED` : '\nall passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.log = realLog;
  console.error('FAIL unexpected error:', (e && e.message) || e);
  process.exit(1);
});
