/**
 * THE DAILY BACKUP WATCH (src/lib/notification-digests.js backupFreshnessWatchOnce).
 *
 * The nightly backup emails only when it FAILS, and a job that never runs never fails — so a
 * stopped cron is completely silent. The weekly drill was the only detector, which means up to six
 * days of believing you are protected when you are not. This watch closes that to one day.
 *
 * What is pinned here is mostly what it must NOT do, because a backup alarm that cries wolf is one
 * people learn to ignore — and then the real one is ignored too:
 *   · silent while protected                      (the healthy state sends nothing)
 *   · silent when no backup was ever taken here   (not configured ≠ broken)
 *   · silent when the ledger is unreadable        (a DB blip is not "unprotected")
 *   · at most one alarm a day while it stays down (a nudge, not a flood)
 *   · a stale DRILL is its own quieter message, and never fires over a stopped backup
 *
 * Requires DATABASE_URL with migrations applied; skips cleanly otherwise.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-backup-watch-db (no DATABASE_URL)'); process.exit(0); }
process.env.SSN_ENCRYPTION_KEY = process.env.SSN_ENCRYPTION_KEY || '0'.repeat(64);
process.env.JWT_SECRET = process.env.JWT_SECRET || 'testsecrettestsecrettestsecret12';
process.env.EMAIL_PROVIDER = 'none';
// report.alert() refuses to send with no recipient, which would make every assertion below pass for
// the wrong reason.
process.env.BACKUP_ALERT_EMAIL = 'backup-alerts@example.test';

const assert = require('assert');
const db = require('../src/db');
const email = require('../src/lib/email');
const D = require('../src/lib/notification-digests');

let n = 0; const ok = (m) => { n++; console.log('  ok -', m); };
const sent = [];
email.sendMail = async (m) => { sent.push(m); return { ok: true }; };

const GATES = ['backup_freshness_alert', 'backup_verify_stale_alert'];

/** Put the ledger in a known state, and clear both once-per-period stamps. */
async function setLedger(rows) {
  await db.query(`DELETE FROM backup_runs`);
  for (const r of rows) {
    await db.query(
      `INSERT INTO backup_runs (backup_id, kind, status, started_at, finished_at)
       VALUES ($1,$2,$3, now() - ($4||' hours')::interval, now() - ($4||' hours')::interval)`,
      [`test-${Math.random().toString(16).slice(2)}`, r.kind, r.status || 'success', String(r.agoHours)]);
  }
  await db.query(`DELETE FROM audit_log WHERE action = ANY($1)`, [GATES]);
  sent.length = 0;
}

(async () => {
  // ── 1. Protected: the healthy state is SILENCE ────────────────────────────
  await setLedger([{ kind: 'database', agoHours: 5 }, { kind: 'verify', agoHours: 30 }]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 0);
  assert.strictEqual(sent.length, 0, 'a healthy backup must email nobody');
  ok('a current backup with a recent test restore sends nothing');

  // ── 2. The stopped nightly — the failure this whole watch exists for ──────
  await setLedger([{ kind: 'database', agoHours: 50 }, { kind: 'verify', agoHours: 60 }]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 1);
  assert.strictEqual(sent.length, 1, 'a stopped backup must raise exactly one alarm');
  const stop = sent[0];
  assert.match(stop.subject, /\[ACTION NEEDED\]/, 'a stopped backup is action-needed');
  assert.match(stop.subject, /stopped/i);
  assert.match(stop.subject, /50 hours|2 days/, 'the subject states how old the last backup is');
  assert.match(stop.text, /ys-capital-backup/, 'it names the job to go and look at');
  assert.match(stop.text, /no data has been lost/i, 'it says plainly that the live system is fine');
  // Plain language: the reader is the business owner, not a developer.
  assert.ok(!/\b(cron|pg_dump|env var|S3|bucket|manifest)\b/i.test(stop.text),
    'the alarm must not use developer jargon');
  ok('a backup that stopped 50 hours ago raises one plain-language alarm naming the job');

  // ── 3. …and only ONE a day while it stays broken ──────────────────────────
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 0);
  assert.strictEqual(sent.length, 1, 'the second run the same day must stay quiet');
  ok('a still-broken backup does not re-alarm the same day');

  // ── 4. Never ran here = not configured, not broken ────────────────────────
  await setLedger([]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 0);
  assert.strictEqual(sent.length, 0, 'a deployment with no backup at all must not be nagged daily');
  ok('no backup ever recorded → silent (the env lives on the cron service, not here)');

  // A FAILED run is not a successful one: the ledger has rows, but nothing to be protected by, and
  // the nightly job already emailed about its own failure. Still no second alarm from here.
  await setLedger([{ kind: 'database', agoHours: 3, status: 'failure' }]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 0);
  assert.strictEqual(sent.length, 0);
  ok('a failing-but-never-successful backup is left to the job\'s own failure email');

  // ── 5. Backups fine, drill stale → a separate, quieter message ────────────
  await setLedger([{ kind: 'database', agoHours: 5 }, { kind: 'verify', agoHours: 24 * 30 }]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 1);
  assert.strictEqual(sent.length, 1);
  const drill = sent[0];
  assert.match(drill.subject, /test-restored recently/i);
  assert.ok(!/stopped/i.test(drill.subject), 'a stale drill must not read as a stopped backup');
  assert.match(drill.text, /nightly backup is working/i, 'it must say the backups themselves are fine');
  assert.match(drill.text, /ys-capital-backup-verify/, 'it names the drill job, not the backup job');
  ok('backups current but never test-restored → its own quieter message');

  // ── 6. A stopped backup OUTRANKS a stale drill (never both, never the wrong one) ──
  await setLedger([{ kind: 'database', agoHours: 80 }, { kind: 'verify', agoHours: 24 * 30 }]);
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 1);
  assert.strictEqual(sent.length, 1, 'one alarm, not two');
  assert.match(sent[0].subject, /stopped/i, 'the louder problem is the one that gets sent');
  ok('with both wrong, only the stopped backup is reported');

  // ── 7. An unreadable ledger is NOT reported as "unprotected" ──────────────
  await setLedger([{ kind: 'database', agoHours: 5 }]);
  const realQuery = db.query;
  db.query = async () => { throw new Error('connection terminated unexpectedly'); };
  let threw = false;
  try { assert.strictEqual(await D.backupFreshnessWatchOnce(), 0); } catch (_) { threw = true; }
  db.query = realQuery;
  assert.ok(!threw, 'the watch must never throw into the dispatcher');
  assert.strictEqual(sent.length, 0, 'a database blip must not raise a backup alarm');
  ok('an unreadable ledger raises nothing and never throws');

  // ── 8. The switch really switches it off ──────────────────────────────────
  await setLedger([{ kind: 'database', agoHours: 500 }]);
  const cfg = require('../src/config');
  const prev = cfg.backup.watchMaxAgeHours;
  cfg.backup.watchMaxAgeHours = 0;
  assert.strictEqual(await D.backupFreshnessWatchOnce(), 0);
  assert.strictEqual(sent.length, 0);
  cfg.backup.watchMaxAgeHours = prev;
  ok('BACKUP_WATCH_MAX_AGE_HOURS=0 disables the watch entirely');

  // Leave the ledger clean for whatever runs next.
  await db.query(`DELETE FROM backup_runs`);
  await db.query(`DELETE FROM audit_log WHERE action = ANY($1)`, [GATES]);

  console.log(`\ntest-backup-watch-db: ${n} assertions passed`);
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
