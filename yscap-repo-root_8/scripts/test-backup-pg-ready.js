'use strict';

// =============================================================================
// PROOF that the backup drill waits out a database that is still starting up —
// and that it REFUSES to wait for one that never will.
// =============================================================================
//
// The weekly restore drill failed on 2026-08-16 with "the database system is in
// recovery mode". No backup was bad: that is SQLSTATE 57P03, sent while a server
// replays its write-ahead log after a restart or failover, and it clears itself
// in seconds. Every database connection in the backup system connected exactly
// once and gave up, so a momentary restart turned the one check that PROVES the
// backups work into a red alert that says nothing about the backups.
//
// The dangerous half of this fix is the waiting, not the failing. A retry loop
// that waits on a WRONG PASSWORD converts an instant, accurate answer into ten
// minutes of silence and then a timeout that blames the clock — so the transient
// set is a closed list, and the tests below spend more effort on what must NOT
// be waited for than on what must.
//
// PURE: the clock, the sleep and the client factory are all injected. Nothing
// here opens a socket, so it runs anywhere, in milliseconds.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  isTransientPgStartup, describeWait, connectWhenReady, waitForDatabaseReady, TRANSIENT_CODES,
} = require('../src/lib/backup/pg-ready.js');

let checks = 0;
const ok = (cond, what) => { assert.ok(cond, what); checks++; };
const eq = (a, b, what) => { assert.strictEqual(a, b, what); checks++; };

// ── 1. what is worth waiting for ────────────────────────────────────────────

const pgErr = (code, message) => Object.assign(new Error(message || 'x'), { code });

ok(isTransientPgStartup(pgErr('57P03', 'the database system is in recovery mode')),
  'THE REPORTED FAILURE ITSELF is transient');
ok(isTransientPgStartup(pgErr('57P03', 'the database system is starting up')), 'the other 57P03 wording');
ok(isTransientPgStartup(pgErr('57P01')), 'admin shutdown — a restart in progress');
ok(isTransientPgStartup(pgErr('57P02')), 'crash shutdown — recovery is about to begin');
ok(isTransientPgStartup(pgErr('53300')), 'no connection slots — somebody else\'s spike');
ok(isTransientPgStartup(pgErr('ECONNREFUSED')), 'nothing listening yet — the server is still binding');
ok(isTransientPgStartup(pgErr('ETIMEDOUT')), 'socket timeout');
ok(isTransientPgStartup(pgErr('ECONNRESET')), 'connection reset mid-handshake');

// The message-only path, for a proxy or driver that drops the SQLSTATE.
ok(isTransientPgStartup(new Error('FATAL: the database system is in recovery mode')),
  'recognised from the words alone when no code is attached');
ok(isTransientPgStartup(new Error('the database system is shutting down')), 'shutting down, from the words');

// ── 2. what must NEVER be waited for — the expensive direction ──────────────

ok(!isTransientPgStartup(pgErr('28P01', 'password authentication failed for user "x"')),
  'A WRONG PASSWORD IS NOT TRANSIENT — waiting on it hides the real answer for ten minutes');
ok(!isTransientPgStartup(pgErr('28000', 'no pg_hba.conf entry for host')), 'a rejected host is not transient');
ok(!isTransientPgStartup(pgErr('3D000', 'database "nope" does not exist')), 'a missing database never appears');
ok(!isTransientPgStartup(pgErr('42501', 'permission denied')), 'a permission error never resolves itself');
ok(!isTransientPgStartup(pgErr('ENOTFOUND', 'getaddrinfo ENOTFOUND db.example')),
  'a hostname that does not resolve is a typo or an unset URL, NOT something to wait on');
ok(!isTransientPgStartup(pgErr('ECONNABORTED')), 'an unlisted syscall is not assumed transient');
ok(!isTransientPgStartup(new Error('something went wrong')), 'an unrecognised error is not assumed transient');
ok(!isTransientPgStartup(null), 'null is not transient');
ok(!isTransientPgStartup(undefined), 'undefined is not transient');
ok(!isTransientPgStartup('57P03'), 'a bare string is not an error object');
ok(!isTransientPgStartup({}), 'an object with nothing readable is not assumed transient');

ok(TRANSIENT_CODES.size <= 8, 'the transient list stays CLOSED and small — every entry is a decision');

// ── 3. plain language, because a human reads the alert ──────────────────────

eq(describeWait(pgErr('57P03', 'the database system is in recovery mode')), 'the database was still starting up',
  'the reported failure is described in words a non-developer reads');
eq(describeWait(pgErr('53300')), 'the database had no connection slots free', 'slots');
eq(describeWait(pgErr('ECONNREFUSED')), 'the database was not reachable yet', 'fallback wording');
eq(describeWait(null), 'the database was not reachable yet', 'null does not throw');

// ── 4. the loop itself ──────────────────────────────────────────────────────
//
// CommonJS, so the awaiting sections live inside main() — a top-level await
// would make Node treat this file as an ES module and every require() above it
// would stop working.


/** A fake clock + a fake server that refuses N times and then accepts. */
function harness({ failures, code = '57P03', permanentAt = -1, timeoutMs = 10 * 60 * 1000 }) {
  let t = 0;
  const slept = [];
  const made = [];
  let attempts = 0;
  const ended = [];
  const client = () => {
    const id = made.length;
    const c = {
      id,
      connected: false,
      async connect() {
        attempts += 1;
        if (attempts === permanentAt) throw pgErr('28P01', 'password authentication failed');
        if (attempts <= failures) throw pgErr(code, 'the database system is in recovery mode');
        this.connected = true;
      },
      async end() { ended.push(id); },
    };
    made.push(c);
    return c;
  };
  const logs = [];
  return {
    slept, made, ended, logs,
    get attempts() { return attempts; },
    run: () => connectWhenReady('postgres://u:p@h/scratch_verify', {
      timeoutMs,
      now: () => t,
      sleep: async (ms) => { slept.push(ms); t += ms; },
      makeClient: client,
      log: (m) => logs.push(m),
    }),
  };
}

async function main() {
{
  // THE REPORTED CASE: recovering, then ready.
  const h = harness({ failures: 3 });
  const c = await h.run();
  ok(c && c.connected, 'it eventually connects');
  eq(h.attempts, 4, 'after exactly the failures plus one success');
  ok(h.slept.length === 3, 'and slept between each attempt');
  ok(h.slept.every((ms) => ms > 0 && ms <= 15000), 'each wait is bounded — never zero, never unbounded');
  ok(h.slept[1] > h.slept[0], 'and backs off rather than hammering a server replaying its log');
  ok(h.logs.some((m) => /still starting up/.test(m)), 'it says what it is waiting for');
  ok(h.logs.some((m) => /answered after/.test(m)), 'and says when it got in');

  // NO LEAKED SOCKETS: every failed attempt's client is ended, the successful one is not.
  eq(h.ended.length, 3, 'each failed attempt is closed');
  ok(!h.ended.includes(h.made.length - 1), 'and the one it hands back is left open for the caller');
}

{
  // First try succeeds — no waiting, no noise.
  const h = harness({ failures: 0 });
  const c = await h.run();
  ok(c.connected, 'connects immediately');
  eq(h.attempts, 1, 'one attempt');
  eq(h.slept.length, 0, 'no sleeping');
  eq(h.logs.length, 0, 'and says nothing — a healthy run stays quiet');
}

{
  // A PERMANENT ERROR STOPS EVERYTHING, IMMEDIATELY. This is the assertion that
  // matters most: the retry must not swallow the real answer.
  const h = harness({ failures: 0, permanentAt: 1 });
  let threw = null;
  try { await h.run(); } catch (e) { threw = e; }
  ok(threw, 'a wrong password throws');
  eq(threw.code, '28P01', 'with its ORIGINAL error, unchanged');
  ok(/password authentication failed/.test(threw.message), 'and its original message');
  eq(h.slept.length, 0, 'having waited exactly zero times');
  eq(h.attempts, 1, 'and tried exactly once');
}

{
  // A permanent error AFTER some transient ones still stops at once.
  const h = harness({ failures: 2, permanentAt: 3 });
  let threw = null;
  try { await h.run(); } catch (e) { threw = e; }
  eq(threw.code, '28P01', 'the permanent error wins the moment it appears');
  eq(h.slept.length, 2, 'only the transient ones were waited out');
}

{
  // THE DEADLINE. A server that never comes back must fail with a sentence that
  // is about the CHECK, not about the backups.
  const h = harness({ failures: Infinity, timeoutMs: 60 * 1000 });
  let threw = null;
  try { await h.run(); } catch (e) { threw = e; }
  ok(threw, 'it gives up eventually');
  eq(threw.code, 'BACKUP_DB_NOT_READY', 'with its own code');
  ok(/never became ready/.test(threw.message), 'saying the database never became ready');
  ok(/says nothing about whether the backups are good/.test(threw.message),
    'AND SAYING PLAINLY THAT THIS IS NOT A VERDICT ON THE BACKUPS — the whole point');
  ok(/recovery mode/.test(threw.message), 'while keeping the underlying error for whoever debugs it');
  ok(threw.cause && threw.cause.code === '57P03', 'and the original error is attached');

  const waited = h.slept.reduce((a, b) => a + b, 0);
  ok(waited <= 60 * 1000, `it honours the deadline rather than overshooting (waited ${waited}ms)`);
  ok(h.slept.length >= 3, 'and genuinely retried before giving up');
  eq(h.ended.length, h.made.length, 'every client it made was closed — none leaked');
}

// ── 4b. the NIGHTLY backup's shape — the same rule through a pool ───────────
//
// The drill owns its connections; the nightly reaches the database through the
// application's shared pool, so there is nothing to reconnect — only the query
// to retry. Both go through ONE loop, and these assertions exist so that stays
// true: a second copy of "which errors are worth waiting for" would be the
// first thing to drift, and the drifted one would be the one that waits on a
// wrong password.
{
  let calls = 0;
  const slept = [];
  const runQuery = async () => {
    calls += 1;
    if (calls <= 2) throw pgErr('57P03', 'the database system is in recovery mode');
    return { rows: [{ '?column?': 1 }] };
  };
  let t = 0;
  await waitForDatabaseReady(runQuery, {
    timeoutMs: 4 * 60 * 1000,
    now: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
  });
  eq(calls, 3, 'the pool shape retries the QUERY and eventually succeeds');
  eq(slept.length, 2, 'waiting between attempts, like the connection shape');

  // And it refuses the same things, because it is the same rule.
  let threw = null;
  try {
    await waitForDatabaseReady(async () => { throw pgErr('28P01', 'password authentication failed'); },
      { timeoutMs: 60000, now: () => 0, sleep: async () => {} });
  } catch (e) { threw = e; }
  eq(threw && threw.code, '28P01', 'a wrong password is NOT waited on through the pool either');

  // The nightly's deadline is deliberately shorter than the drill's — it runs
  // again tomorrow, so it must not sit for ten minutes.
  const src = fs.readFileSync(path.join(__dirname, 'backup-run.js'), 'utf8');
  ok(/waitForDatabaseReady\(/.test(src), 'the nightly waits for the database before calling it unreachable');
  ok(/timeoutMs: 4 \* 60 \* 1000/.test(src), 'with its own shorter deadline');
  // Match the CODE, not the prose: the comment explaining this fix necessarily
  // quotes "cannot reach the database" above the call, so a bare indexOf finds
  // the explanation and reports the order backwards. Same trap the workflow
  // guard hit — assert on what runs, never on what describes it.
  const iWait = src.indexOf('await waitForDatabaseReady(');
  const iUnreachable = src.indexOf('problems.push(`cannot reach the database');
  ok(iWait > 0, 'the nightly actually calls the wait');
  ok(iUnreachable > iWait,
    'and the wait happens BEFORE the "cannot reach the database" verdict, not after it');
}

// ── 4c. a CRASHED server is not a STARTING server ───────────────────────────
//
// This is the distinction that cost a whole wrong diagnosis on 2026-08-16. When
// the scratch database died under the restore, pg_restore reported "server
// closed the connection unexpectedly", the server restarted into crash
// recovery, and the next connection answered 57P03 — so the alert said "the
// database system is in recovery mode", which is the AFTERMATH. Twice, on two
// separate runs, on the same table. The waiting fix above is correct and does
// NOT address this, and the two must never again be reported as one thing.
{
  const { lostServerDuringRestore, firstFailedTable } = require('./backup-verify.js')._internals;

  // The real tail from the failed run, trimmed.
  const crashed = {
    code: 1,
    errors: 317,
    tail: 'pg_restore: error: COPY failed for table "rv_orders": server closed the connection unexpectedly\n'
      + 'pg_restore: error: could not commit database transaction: no connection to the server\n'
      + 'pg_restore: error: could not execute query: no connection to the server\n',
  };
  ok(lostServerDuringRestore(crashed), 'a server that died mid-restore is recognised as a CRASH');
  eq(firstFailedTable(crashed), 'rv_orders', 'and the first failing table is named — the useful half of 317 errors');

  // Ordinary per-object errors are NOT a crash: the restore carried on, and
  // calling those a crash would send somebody resizing a database over a
  // missing extension.
  const ordinary = {
    code: 1,
    errors: 3,
    tail: 'pg_restore: error: could not execute query: ERROR:  extension "pg_trgm" is not available\n'
      + 'pg_restore: error: could not execute query: ERROR:  role "someone" does not exist\n',
  };
  ok(!lostServerDuringRestore(ordinary), 'ordinary per-object restore errors are NOT a crash');
  eq(firstFailedTable(ordinary), null, 'and no table is invented when none failed');

  ok(!lostServerDuringRestore({ code: 0, errors: 0, tail: '' }), 'a clean restore is not a crash');
  ok(!lostServerDuringRestore(null), 'null does not throw');
  ok(!lostServerDuringRestore({}), 'a result with no tail is not assumed to be a crash');
  ok(lostServerDuringRestore({ tail: 'FATAL: terminating connection due to administrator command' }),
    'a terminated connection counts too');

  // And the drill must RAISE it, before anything reconnects — otherwise the
  // reconnect answers 57P03 and buries the cause exactly as it did.
  const src = fs.readFileSync(path.join(__dirname, 'backup-verify.js'), 'utf8');
  const iCrash = src.indexOf('if (lostServerDuringRestore(res))');
  const iReconnect = src.indexOf('const client = await connectWhenReady(target');
  ok(iCrash > 0, 'the drill checks for a crashed server after the restore');
  ok(iReconnect > iCrash,
    'and it does so BEFORE reconnecting — or 57P03 masks the real cause, which is exactly what happened');
  ok(/is NOT a bad backup/.test(src), 'and the message says plainly that this is not a bad backup');
  ok(/BACKUP_VERIFY_JOBS/.test(src), 'and offers the free mitigation as well as the real one');
}

// ── 5. the drill still checks WHERE it is pointing before it connects ───────
//
// The waiting must never become the first thing that happens to an unchecked
// target: the two guards that stop the drill wiping the live database are only
// safe because they run first. A source assertion, because the ordering is the
// property — not any single function's behaviour.
{
  const src = fs.readFileSync(path.join(__dirname, 'backup-verify.js'), 'utf8');
  const iSame = src.indexOf('isSameDatabase(target');
  const iScratch = src.indexOf('looksLikeScratch(target)');
  const iWipe = src.indexOf('wipeScratch(target)');
  ok(iSame > 0 && iScratch > 0 && iWipe > 0, 'the guards and the first connection are all present');
  ok(iSame < iWipe, 'the live-database refusal runs BEFORE anything connects');
  ok(iScratch < iWipe, 'the looks-disposable refusal runs BEFORE anything connects');

  // ORDER IS NOT ENOUGH, and finding that out cost a mutation. Short-circuiting
  // a guard to `false && …` leaves it sitting at exactly the right position, so
  // the index checks above pass while the drill would happily wipe the live
  // database. So the guard region is also read for a guard that can still bite:
  // both conditions present, each able to REFUSE, and no constant short-circuit
  // anywhere between them and the first destructive call.
  const region = src.slice(src.indexOf('const target = cfg.backup.verifyDatabaseUrl'), iWipe);
  ok(region.length > 100, 'the guard region was actually extracted');
  ok(/isSameDatabase\(target,\s*cfg\.databaseUrl/.test(region),
    'the live-database guard compares against the REAL database url, not a constant');
  ok(/looksLikeScratch\(target\)/.test(region), 'the disposability guard tests the REAL target');
  eq((region.match(/throw new Error\(/g) || []).length, 3,
    'each guard can actually refuse (live database, not-disposable, no pg_restore)');
  ok(!/(false|0)\s*&&/.test(region), 'no guard is short-circuited off with a falsy constant');
  ok(!/(true|1)\s*\|\|/.test(region), 'and none is short-circuited on with a truthy constant');
  ok(/connectWhenReady/.test(src), 'and the drill uses the waiting connector');
  ok(!/new Client\(/.test(src), 'with no bare one-shot connection left anywhere in it');
}

console.log(`test-backup-pg-ready: ${checks} assertions passed.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
