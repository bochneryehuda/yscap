'use strict';
/**
 * Backup LEDGER + ALARM.
 *
 * A backup system that fails quietly is worse than no backup system, because everyone believes it
 * is working. Two jobs here:
 *   1. record every run (success or failure) in `backup_runs`, so /api/health and the admin page
 *      can answer "when did we last have a good backup?" without opening a bucket;
 *   2. EMAIL when a run fails, when it succeeds with warnings, or when a restore drill does not
 *      match — in plain language, because the person who needs to act on it is not a developer.
 *
 * Every function here fails OPEN: if the ledger insert or the email throws, the backup itself is
 * unaffected. Losing the paperwork must never lose the backup.
 */
const cfg = require('../../config');

/** Record one run. Returns the row id, or null if the ledger was unavailable. */
async function recordRun(db, row) {
  try {
    const r = await db.query(
      `INSERT INTO backup_runs
         (backup_id, kind, status, started_at, finished_at, duration_ms,
          tables_count, rows_count, plain_bytes, cipher_bytes, vaults, detail, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       RETURNING id`,
      [
        row.backupId || null, row.kind, row.status,
        row.startedAt || new Date(), row.finishedAt || new Date(), row.durationMs || null,
        row.tables == null ? null : row.tables,
        row.rows == null ? null : row.rows,
        row.plainBytes == null ? null : row.plainBytes,
        row.cipherBytes == null ? null : row.cipherBytes,
        row.vaults ? JSON.stringify(row.vaults) : null,
        row.detail ? JSON.stringify(row.detail) : null,
        row.error || null,
      ]);
    return r.rows[0].id;
  } catch (e) {
    console.error(`[backup] could not write the run to backup_runs: ${e.message} (the backup itself is unaffected)`);
    return null;
  }
}

/** The most recent run of a kind, whatever its status. */
async function lastRun(db, kind) {
  try {
    const r = await db.query(
      `SELECT * FROM backup_runs WHERE kind=$1 ORDER BY started_at DESC LIMIT 1`, [kind]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

/** The most recent SUCCESSFUL run of a kind — the number that actually matters. */
async function lastSuccess(db, kind) {
  try {
    const r = await db.query(
      `SELECT * FROM backup_runs WHERE kind=$1 AND status IN ('success','warning')
        ORDER BY started_at DESC LIMIT 1`, [kind]);
    return r.rows[0] || null;
  } catch (_) { return null; }
}

/**
 * Protection status, in the shape a health endpoint wants. `staleAfterHours` is how long a gap is
 * tolerated before the answer becomes "no" — a nightly backup that last succeeded 50 hours ago has
 * silently stopped, and that is precisely the state this exists to catch.
 */
async function protectionStatus(db, { staleAfterHours = 36, verifyStaleAfterDays = 10 } = {}) {
  const dbRun = await lastSuccess(db, 'database');
  const verifyRun = await lastSuccess(db, 'verify');
  const now = Date.now();
  const ageH = (r) => (r ? (now - new Date(r.started_at).getTime()) / 3600000 : Infinity);
  const dbAge = ageH(dbRun);
  const verifyAge = ageH(verifyRun) / 24;
  return {
    protected: dbAge <= staleAfterHours,
    lastBackupAt: dbRun ? new Date(dbRun.started_at).toISOString() : null,
    lastBackupAgeHours: Number.isFinite(dbAge) ? Math.round(dbAge * 10) / 10 : null,
    lastBackupTables: dbRun ? dbRun.tables_count : null,
    lastBackupRows: dbRun ? Number(dbRun.rows_count) : null,
    lastVerifiedAt: verifyRun ? new Date(verifyRun.started_at).toISOString() : null,
    verificationFresh: verifyAge <= verifyStaleAfterDays,
    // Plain-language, because this string ends up in front of the owner.
    message: dbAge <= staleAfterHours
      ? `Last good backup ${Math.round(dbAge)} hours ago.` +
        (verifyAge <= verifyStaleAfterDays ? ' A test restore of it succeeded recently.' : ' No recent test restore.')
      : (dbRun ? `WARNING: the last good backup was ${Math.round(dbAge)} hours ago.` : 'WARNING: no backup has ever completed.'),
  };
}

// `/api/health` is Render's own health check AND is polled by every open tab, so the two ledger
// reads above must not run on every hit. The answer changes at most once a night; a short memo is
// plenty, and a failure is never cached (so a transient DB blip does not freeze a stale verdict).
let statusMemo = null;
async function protectionStatusCached(db, opts = {}, ttlMs = 60000, now = () => Date.now()) {
  if (statusMemo && now() - statusMemo.at < ttlMs) return statusMemo.value;
  const value = await protectionStatus(db, opts);
  statusMemo = { at: now(), value };
  return value;
}

/** Human-readable byte size for the alert emails. */
function human(bytes) {
  const n = Number(bytes) || 0;
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/**
 * Send the alarm. Plain sentences, no jargon — the reader is the business owner, and the only
 * thing they need from this email is whether their data is safe and what to do next.
 */
async function alert({ ok, subject, lines, action = null }) {
  const to = (cfg.backup && cfg.backup.alertEmail) || '';
  if (!to) {
    console.warn('[backup] no BACKUP_ALERT_EMAIL / NOTIFY_ADMINS set — nobody will be told when a backup fails');
    return { sent: false, reason: 'no recipient' };
  }
  if (ok && !(cfg.backup && cfg.backup.alertOnSuccess)) return { sent: false, reason: 'success emails are off' };

  const body = [
    ...lines,
    '',
    action ? `What to do: ${action}` : null,
    '',
    'This message came from the automatic backup job.',
  ].filter((l) => l !== null).join('\n');

  try {
    const email = require('../email');
    await email.sendMail({
      to: to.split(/[,;\s]+/).filter(Boolean),
      subject: `${ok ? '' : '[ACTION NEEDED] '}${subject}`,
      text: body,
      html: `<pre style="font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap">${
        body.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>`,
      _skipCapture: true,     // an operations alarm is not part of any loan file's email history
    });
    return { sent: true };
  } catch (e) {
    console.error(`[backup] could not send the alert email: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = { recordRun, lastRun, lastSuccess, protectionStatus, protectionStatusCached, alert, human };
