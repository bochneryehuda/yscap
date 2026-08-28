'use strict';
/**
 * LT test — THE RECORD OF WHAT EACH SYNC PASS DID, against a REAL database.
 *
 * WHY THIS EXISTS. The owner asked twice why nothing was arriving on the long-term
 * side, and nobody could answer — including the person who built it. `GET /api/lt/sync`
 * assembles its whole answer out of `lt_loans`, so a pass that produced NO loans
 * (Encompass refused, the master switch is off, the search came back empty) rendered
 * as an untouched screen with the reason written to a process log nobody can read.
 * db/616 + `sync/run-log.js` record the RUN rather than only its output.
 *
 * WHAT THIS PROVES, and each is something a pure suite structurally cannot:
 *
 *   A. **The table and its columns are real.** A phantom column inside a swallowing
 *      catch becomes a confident, permanent silence — the class that left
 *      `lt_loans.borrower_id` unwritten for months. Every write here is wrapped in a
 *      catch BY DESIGN (a diary must never break the pass it describes), which makes
 *      this suite the only thing that can tell a working writer from a silent one.
 *   B. **A REFUSAL is recorded with its reason.** This is the whole feature: the
 *      state that used to be invisible.
 *   C. **A THROW is recorded AND re-thrown**, so the caller behaves exactly as before.
 *   D. **A CLEAN pass records its counts and NO reason** — a reason on a good pass
 *      would train people to ignore the column.
 *   E. **`latest()` answers per kind**, newest first, which is what the screen reads.
 *   F. **The log is bounded** by its own writer, so no scheduled job has to exist.
 *   G. **A broken diary never breaks a pass.** Proven by handing every function a
 *      database that refuses, and asserting the pass's own result is untouched.
 *
 * DB-GATED: skips cleanly with no database.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const assert = require('assert');

async function main() {
  await require(`${__dirname}/lib/db-gate`).skipUnlessDb('lt-sync-run-log');

  const db = require('../src/longterm/db');
  const runLog = require('../src/longterm/sync/run-log');

  let checks = 0;
  const ok = (c, w) => { assert.ok(c, w); checks++; console.log('  ok  ', w); };
  const eq = (a, b, w) => { assert.strictEqual(a, b, w); checks++; console.log('  ok  ', w); };
  const section = (t) => console.log(`\n${t}`);

  // Every row this suite writes carries its own kind, so it can never be confused
  // with another suite's rows — or with a real pass on a shared database.
  const tag = `t${Date.now().toString(36)}`;
  const KIND = `test_${tag}`;
  const rowsOf = async (kind = KIND) => (await db.query(
    'SELECT * FROM lt_sync_runs WHERE kind = $1 ORDER BY started_at', [kind])).rows;

  try {
    section('A. the table db/616 built is really there');
    const { rows: cols } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'lt_sync_runs'`);
    const names = new Set(cols.map((c) => c.column_name));
    for (const c of ['id', 'kind', 'trigger', 'started_at', 'finished_at', 'ok', 'reason',
      'discovered', 'read_count', 'failed', 'skipped', 'remaining', 'passes', 'detail']) {
      ok(names.has(c), `lt_sync_runs has ${c}`);
    }

    section('B. a pass that REFUSES records WHY — the state that used to be invisible');
    // The exact shape `loans.syncOnce` returns when the master switch is off.
    const off = 'Encompass is switched off (ENCOMPASS_ENABLED is set to off).';
    const refusal = await runLog.record(KIND, 'worker', async () => ({ ok: false, reason: off }));
    eq(refusal.reason, off, 'the pass result reaches the caller untouched');
    let rows = await rowsOf();
    eq(rows.length, 1, 'one row was written');
    eq(rows[0].ok, false, '…marked as not ok');
    eq(rows[0].reason, off, '…carrying the reason a person can act on');
    ok(rows[0].finished_at != null, '…and closed out, so it does not read as still running');
    eq(rows[0].trigger, 'worker', '…stamped with what set it off');

    section('C. a pass that THROWS is recorded and still throws');
    let threw = null;
    try {
      await runLog.record(KIND, 'manual', async () => { throw new Error('Encompass token 401'); });
    } catch (e) { threw = e; }
    ok(threw && /401/.test(threw.message), 'the error still reaches the caller — the diary changes nothing');
    rows = await rowsOf();
    const thrown = rows[rows.length - 1];
    eq(thrown.ok, false, 'the throw was recorded as a failure');
    ok(/401/.test(thrown.reason || ''), '…with the message as the reason');
    eq(thrown.trigger, 'manual', '…and it knows a person started it, not the timer');

    section('D. a clean pass records its counts and NO reason');
    await runLog.record(KIND, 'worker', async () => ({
      ok: true, discovered: 772, read: 25, failed: 0, skippedShortTerm: 300, remaining: 447, passes: 1,
    }));
    rows = await rowsOf();
    const good = rows[rows.length - 1];
    eq(good.ok, true, 'recorded as ok');
    eq(good.reason, null, '…and with NO reason, so the column stays worth reading');
    eq(good.discovered, 772, 'discovered');
    eq(good.read_count, 25, 'read');
    eq(good.skipped, 300, 'short-term files skipped');
    eq(good.remaining, 447, 'still to read');
    ok(good.detail && good.detail.discovered === 772, 'the pass’s own shape is kept verbatim in detail');

    section('E. latest() is what the screen reads: the newest of each kind');
    const OTHER = `${KIND}_two`;
    await runLog.record(OTHER, 'worker', async () => ({ ok: true, read: 1 }));
    const latest = await runLog.latest();
    const mine = latest.find((r) => r.kind === KIND);
    const other = latest.find((r) => r.kind === OTHER);
    ok(mine && other, 'both kinds appear, once each');
    eq(mine.ok, true, 'and the one returned for a kind is its NEWEST pass, not its first');
    eq(mine.discovered, 772, '…carrying that pass’s own figures');

    section('F. the log is bounded by its own writer');
    // Write past the cap on a kind of its own, then confirm the writer trimmed it.
    const CAP = `${KIND}_cap`;
    const over = runLog.KEEP_PER_KIND + 5;
    for (let i = 0; i < over; i++) {
      // eslint-disable-next-line no-await-in-loop
      await runLog.record(CAP, 'worker', async () => ({ ok: true, read: i }));
    }
    const capped = await rowsOf(CAP);
    ok(capped.length <= runLog.KEEP_PER_KIND,
      `${over} passes leave at most ${runLog.KEEP_PER_KIND} rows — no scheduled job needed`);
    // …and it keeps the NEWEST, which is the only half that matters.
    eq(capped[capped.length - 1].read_count, over - 1, 'and what it keeps is the newest');

    section('G. a diary that cannot be written never breaks the pass it describes');
    const broken = { query: async () => { throw new Error('database is on fire'); } };
    const id = await runLog.start(KIND, 'worker', broken);
    eq(id, null, 'a start that cannot be recorded answers null rather than throwing');
    let finishThrew = false;
    try { await runLog.finish('00000000-0000-0000-0000-000000000000', { ok: true, kind: KIND }, broken); }
    catch (_) { finishThrew = true; }
    eq(finishThrew, false, 'a finish that cannot be recorded is swallowed');
    const latestOnBroken = await runLog.latest(broken);
    ok(Array.isArray(latestOnBroken) && latestOnBroken.length === 0,
      'an unreadable diary answers "nothing recorded" so the screen still shows the figures it CAN read');

    // …and the same through `record`, which is what the worker actually calls: the
    // pass's own result must come back untouched even with the log unwritable.
    const realDb = require.cache[require.resolve('../src/longterm/db')];
    const origQuery = realDb.exports.query;
    realDb.exports.query = async () => { throw new Error('database is on fire'); };
    let survived = null;
    try {
      survived = await runLog.record(KIND, 'worker', async () => ({ ok: true, read: 7, kind: KIND }));
    } finally { realDb.exports.query = origQuery; }
    eq(survived && survived.read, 7, 'the pass result is returned unchanged when nothing could be logged');

    section('H. an unserialisable detail costs the DETAIL, never the ROW');
    // A pass can carry an Error or a circular reference; losing the whole record of
    // the pass over that would defeat the point of having one.
    const circular = { ok: true, read: 3 };
    circular.self = circular;
    await runLog.record(KIND, 'worker', async () => circular);
    rows = await rowsOf();
    const last = rows[rows.length - 1];
    eq(last.ok, true, 'the row is still written');
    eq(last.read_count, 3, '…with its counts intact');
    eq(last.detail, null, '…and only the detail is dropped');

    section('I. a back end is not a feature — the route carries it and the screen shows it');
    // The whole point of this work is a SCREEN that answers "why is nothing arriving".
    // A perfectly written diary nobody renders is the same silence with more code, so
    // both halves of the wiring are pinned here. Comments are stripped first: the code
    // that explains this necessarily NAMES the things being searched for, and a guard
    // that read its own explanation would pass while the wiring was gone.
    const fs = require('fs');
    const path = require('path');
    const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const route = strip(fs.readFileSync(path.join(__dirname, '..', 'src/longterm/routes/sync.js'), 'utf8'));
    const screen = strip(fs.readFileSync(path.join(__dirname, '..', 'app-v2/src/longterm/LtSync.jsx'), 'utf8'));

    ok(/runLog\.latest\(\)/.test(route), 'the sync state route reads the pass log');
    ok(/lastLoanRun/.test(route), '…and returns the loan pass by name, so the screen can lead with it');
    ok(/running:\s*worker\.isRunning\(\)/.test(route), '…and says whether a pass is in flight right now');
    ok(/worker\.tickOnce\(\{ trigger: 'manual' \}\)/.test(route),
      'the button stamps its passes as started by a person, not by the timer');
    ok(/if \(worker\.isRunning\(\)\)/.test(route),
      'and the button refuses out loud when a pass is already running, instead of answering "started"');

    ok(/<LastPull\b/.test(screen), 'the Sync screen renders the last pull');
    ok(/state\.lastLoanRun/.test(screen), '…from the loan pass the route named');
    for (const phrase of ['A pull is running right now', 'No pull has been recorded yet',
      'The last pull did not work', 'Encompass had no long-term files for us']) {
      ok(screen.includes(phrase), `…and states the case: "${phrase}"`);
    }

    // The worker records every pass, not just the loans — a condition sweep that
    // cannot reach Encompass is the same invisible failure one screen over.
    const workerSrc = strip(fs.readFileSync(path.join(__dirname, '..', 'src/longterm/sync/worker.js'), 'utf8'));
    for (const kind of ['loans', 'conditions', 'milestone_catalog', 'pilot_roles']) {
      ok(new RegExp(`runLog\\.record\\('${kind}'`).test(workerSrc), `the worker records its ${kind} pass`);
    }

    console.log(`\nall good — ${checks} checks`);
  } finally {
    await db.query('DELETE FROM lt_sync_runs WHERE kind LIKE $1', [`test_${tag}%`]).catch(() => {});
    if (db.end) await db.end().catch(() => {});
  }
}

main().catch((e) => { console.error('\nFAILED:', (e && e.message) || e); process.exit(1); });
