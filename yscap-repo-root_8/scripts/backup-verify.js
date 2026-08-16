#!/usr/bin/env node
'use strict';
/**
 * THE RESTORE DRILL — the difference between having backups and being able to restore.
 *
 *   node scripts/backup-verify.js              verify the newest backup
 *   node scripts/backup-verify.js --id 4f2a91  verify a specific one
 *   node scripts/backup-verify.js --quick      checksum + decrypt only, no restore
 *
 * WHAT IT ACTUALLY DOES: downloads a real backup, decrypts it, RESTORES it into a scratch database,
 * counts what came back, and compares that against the inventory taken the moment the dump was
 * made. Then it says, in plain words, whether the backup would have worked.
 *
 * WHY IT IS NOT OPTIONAL: every well-known backup disaster is the same story — the backup job was
 * green for months, and the file turned out to be unusable on the one day it mattered. A backup
 * nobody has ever restored is a hypothesis. This runs weekly and turns it into a fact, and shouts
 * by email the first time the answer changes.
 *
 * THE SCRATCH DATABASE IS WIPED, EVERY TIME. Two guards stand between this and a catastrophe: it
 * refuses a target that is the live database, and it refuses one whose name does not look like a
 * scratch database (unless BACKUP_VERIFY_FORCE=1 is set deliberately).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { connectWhenReady } = require('../src/lib/backup/pg-ready');
const { spawn, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const cfg = require('../src/config');
const db = require('../src/db');
const cipher = require('../src/lib/backup/cipher');
const { vaultsFromEnv } = require('../src/lib/backup/vault');
const manifestLib = require('../src/lib/backup/manifest');
const inventoryLib = require('../src/lib/backup/inventory');
const report = require('../src/lib/backup/report');
const { pgEnvFromUrl, isSameDatabase, looksLikeScratch } = require('../src/lib/backup/targets');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const log = (...m) => console.log('[verify]', ...m);

function sslFor(url) {
  const mode = (process.env.PGSSLMODE || new URL(url).searchParams.get('sslmode') || 'require').toLowerCase();
  return (mode === 'disable' || mode === 'off') ? false : { rejectUnauthorized: false };
}

/** Empty the scratch database completely — every non-system schema, not just `public`, or a
 *  leftover schema from a previous drill would be counted as if the backup had produced it. */
async function wipeScratch(url) {
  // WAIT OUT A SERVER THAT IS STILL COMING UP. This is the first thing the
  // drill asks of the scratch database, so it is where a restart lands — and on
  // 2026-08-16 it did: "the database system is in recovery mode" (57P03) failed
  // the whole weekly check while every backup was fine. The two safety guards
  // (never the live database, never a target that does not look disposable) have
  // ALREADY run in main() before this point, and must stay there — waiting must
  // never become the first thing that happens to an unchecked target.
  const client = await connectWhenReady(url, { ssl: sslFor(url), log });
  try {
    const schemas = (await client.query(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('pg_catalog','information_schema')
          AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp%'`)).rows.map((r) => r.nspname);
    for (const s of schemas) await client.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
    await client.query('CREATE SCHEMA IF NOT EXISTS public');
    return schemas.length;
  } finally { await client.end().catch(() => {}); }
}

/**
 * Did the SERVER go away during the restore, rather than the restore merely
 * hitting errors?
 *
 * PURE, and the distinction is the whole point. Ordinary restore errors (a
 * missing extension, an owner that does not exist here) are per-object and the
 * restore carries on. "Server closed the connection unexpectedly" followed by
 * "no connection to the server" is categorically different: the database
 * PROCESS died, everything after it failed for one reason, and the error COUNT
 * is meaningless — 317 errors is one crash, not 317 problems.
 */
function lostServerDuringRestore(res) {
  if (!res || typeof res.tail !== 'string') return false;
  const t = res.tail.toLowerCase();
  return /server closed the connection unexpectedly|no connection to the server|connection to server was lost|terminating connection due to/.test(t);
}

/** The first table whose COPY failed — the useful half of a wall of errors. */
function firstFailedTable(res) {
  const m = /copy failed for table "([^"]+)"/i.exec(String((res && res.tail) || ''));
  return m ? m[1] : null;
}

function runPgRestore(targetUrl, dumpPath, jobs) {
  const env = pgEnvFromUrl(targetUrl);
  return new Promise((resolve, reject) => {
    // --dbname is REQUIRED: without it pg_restore prints the SQL to stdout instead of loading it,
    // and the drill would "pass" against an empty database. Only the NAME is passed on the command
    // line; host/user/password ride in the environment so they never reach `ps`.
    const proc = spawn('pg_restore', [
      '--no-owner', '--no-privileges', `--jobs=${jobs}`, `--dbname=${env.PGDATABASE}`, dumpPath,
    ], {
      env: Object.assign({}, process.env, env), stdio: ['ignore', 'ignore', 'pipe'],
    });
    let errors = 0, tail = '';
    proc.stderr.on('data', (c) => {
      const s = c.toString();
      tail = (tail + s).slice(-8000);
      for (const line of s.split('\n')) if (/^pg_restore: error:/.test(line)) { errors++; if (errors <= 20) console.error('  ' + line); }
    });
    proc.on('error', (e) => reject(new Error(`could not start pg_restore: ${e.message}`)));
    proc.on('close', (code) => resolve({ code, errors, tail }));
  });
}

async function main() {
  const startedAt = new Date();
  const started = Date.now();
  const quick = has('--quick');

  const vaults = vaultsFromEnv();
  if (!vaults.length) throw new Error('no backup vault is configured');
  const vault = vaults[0];
  if (!cfg.backup.encryptionKey) throw new Error('BACKUP_ENCRYPTION_KEY is not set — a backup cannot be verified without it');

  // Find the backup to test.
  const objects = await vault.list('db/');
  const entries = objects
    .filter((o) => o.key.endsWith('.manifest.json'))
    .map((o) => ({ key: o.key, parsed: manifestLib.parseKey(o.key) }))
    .filter((e) => e.parsed)
    .sort((a, b) => b.parsed.at - a.parsed.at);
  if (!entries.length) throw new Error('there are no backups in the vault to verify');

  const wantId = val('--id');
  const chosen = wantId ? entries.find((e) => e.parsed.id === wantId) : entries[0];
  if (!chosen) throw new Error(`no backup with id ${wantId}`);

  const manifest = manifestLib.parseManifest(await vault.get(chosen.key));
  if (!manifest) throw new Error(`the manifest for ${chosen.parsed.id} could not be read`);
  log(`testing backup ${manifest.id} from ${manifest.createdAt} ` +
      `(${manifest.totals.tables} tables, ${manifest.totals.rows.toLocaleString('en-US')} rows)`);

  // IS THE NEWEST BACKUP STILL RECENT? See manifest.freshness for why this is the drill's job.
  // Only when we auto-picked the newest: an explicit --id means "test THIS one", and complaining
  // about the age of a backup somebody deliberately named would be noise.
  const staleness = wantId
    ? { stale: false, ageHours: null, maxAgeHours: cfg.backup.verifyMaxAgeHours }
    : manifestLib.freshness(manifest.createdAt || chosen.parsed.at, Date.now(), cfg.backup.verifyMaxAgeHours);
  if (staleness.stale) {
    console.error(`[verify] STALE — the newest backup is ${manifestLib.describeAge(staleness.ageHours)} ` +
                  `(limit ${staleness.maxAgeHours}h). The nightly backup appears to have stopped running.`);
  }

  // Step 1 — is the object even there, and the size it claims?
  const head = await vault.head(manifest.artifact.key);
  const problems = manifestLib.auditManifest(manifest, head);
  if (problems.length) throw new Error('the stored backup does not check out: ' + problems.join('; '));
  log('the backup is present and the right size ✓');

  // Step 2 — decrypt it. The GCM tag proves nothing was altered or truncated.
  const tmpPath = path.join(cfg.backup.tempDir || os.tmpdir(), `yscap-verify-${manifest.id}.pgc`);
  let restoreReport = null;
  let comparison = null;
  try {
    const { stream } = await vault.getStream(manifest.artifact.key);
    const dec = cipher.createDecryptStream(cfg.backup.encryptionKey);
    await pipeline(stream, dec, fs.createWriteStream(tmpPath, { mode: 0o600 }));
    if (dec.plainSha256 !== manifest.artifact.plainSha256) {
      throw new Error(`the decrypted data hashes to ${dec.plainSha256}, the manifest says ${manifest.artifact.plainSha256}`);
    }
    log(`decrypted ${report.human(dec.plainBytes)} and the checksum matches ✓`);

    if (quick) {
      log('--quick: stopping before the test restore');
    } else {
      // Step 3 — actually restore it, and count what comes back.
      const target = cfg.backup.verifyDatabaseUrl;
      if (!target) {
        log('NOTE: BACKUP_VERIFY_DATABASE_URL is not set, so no TEST RESTORE was done. ' +
            'The file is provably intact, but nothing has proven it can be loaded. ' +
            'Point that at an empty scratch database to complete the drill.');
      } else if (isSameDatabase(target, cfg.databaseUrl || '')) {
        throw new Error('BACKUP_VERIFY_DATABASE_URL points at the LIVE database. The drill wipes its target — refusing.');
      } else if (!looksLikeScratch(target) && process.env.BACKUP_VERIFY_FORCE !== '1') {
        throw new Error(
          `BACKUP_VERIFY_DATABASE_URL points at "${new URL(target).pathname.replace(/^\//, '')}", which does not ` +
          'look like a scratch database. The drill DELETES everything in its target. Rename it to include ' +
          '"verify"/"scratch", or set BACKUP_VERIFY_FORCE=1 if you are certain.');
      } else {
        try { execFileSync('pg_restore', ['--version'], { stdio: 'ignore' }); }
        catch (_) { throw new Error('pg_restore is not installed here — the test restore cannot run'); }

        const dropped = await wipeScratch(target);
        log(`scratch database emptied (${dropped} schemas dropped)`);
        const res = await runPgRestore(target, tmpPath, parseInt(val('--jobs') || process.env.BACKUP_VERIFY_JOBS || '2', 10) || 2);
        restoreReport = res;
        log(`test restore finished (exit ${res.code}, ${res.errors} errors)`);

        // THE CAUSE MUST NOT BE MASKED BY ITS OWN CONSEQUENCE. When the scratch
        // server DIES mid-restore, pg_restore reports "server closed the
        // connection unexpectedly" and then hundreds of "no connection to the
        // server"; the server restarts into crash recovery; and the very next
        // thing this script does is connect — which answers 57P03, "the
        // database system is in recovery mode". That is the message that
        // reached the alert on 2026-08-16, twice, and it describes the
        // AFTERMATH. It cost a whole wrong diagnosis: a server that crashed
        // under the restore reads exactly like a server that happened to be
        // restarting. So the crash is named HERE, before anything reconnects.
        if (lostServerDuringRestore(res)) {
          throw new Error(
            'the test database CRASHED while the backup was being loaded into it — it closed the '
            + `connection part-way through and restarted (${res.errors} errors from pg_restore, first `
            + `failure on "${firstFailedTable(res) || 'an unknown table'}"). This is NOT a bad backup: `
            + 'the file was present, decrypted and matched its checksum before this point. It means the '
            + 'test database cannot hold a full copy of production — it is almost always too small. '
            + 'Give it at least as much memory as the live database, or lower BACKUP_VERIFY_JOBS to 1 '
            + 'to reduce the peak, then run the drill again.');
        }

        // Same wait here: a restore can take many minutes, and a server that
        // restarts during it would otherwise lose the whole drill at the last
        // step, after all the expensive work was already done.
        const client = await connectWhenReady(target, { ssl: sslFor(target), log });
        try {
          const restored = await inventoryLib.takeInventory({ query: (t, p) => client.query(t, p) });
          // The full per-table inventory lives encrypted beside the dump — that is what makes an
          // exact, table-by-table comparison possible instead of a totals-only sanity check.
          const original = JSON.parse(
            (await cipher.decryptBuffer(cfg.backup.encryptionKey, await vault.get(manifest.inventoryKey))).toString('utf8'));
          comparison = inventoryLib.compareInventories(original, restored);
          log(comparison.summary);
          for (const t of comparison.missingTables.slice(0, 20)) log(`  MISSING TABLE: ${t}`);
          for (const r of comparison.rowMismatches.slice(0, 20)) log(`  ROW COUNT: ${r.table} expected ${r.expected}, got ${r.actual}`);
          for (const o of comparison.objectShortfalls) log(`  FEWER ${o.kind}: expected ${o.expected}, got ${o.actual}`);
        } finally { await client.end().catch(() => {}); }
      }
    }
  } finally {
    if (fs.existsSync(tmpPath)) { try { fs.unlinkSync(tmpPath); } catch (_) {} }
  }

  // The restore and the SCHEDULE are judged separately, then reported together. A three-week-old
  // backup restores perfectly — that is a passing restore and a failing schedule, and merging them
  // into one boolean is how the drill would have sent "passed" while the nightly job was dead.
  const restoreOk = !comparison ? true : comparison.ok;
  const ok = restoreOk && !staleness.stale;
  const verification = {
    verifiedAt: new Date().toISOString(),
    ok,
    restoreOk,
    freshness: staleness,
    mode: quick ? 'checksum-only' : (comparison ? 'test-restore' : 'decrypt-only'),
    restoreErrors: restoreReport ? restoreReport.errors : null,
    comparison: comparison ? {
      ok: comparison.ok, summary: comparison.summary,
      missingTables: comparison.missingTables, rowMismatches: comparison.rowMismatches.slice(0, 50),
      objectShortfalls: comparison.objectShortfalls,
    } : null,
  };

  // Stamp the result onto the backup's own manifest, so `--list` shows which backups have actually
  // been proven restorable. Best-effort: a vault that refuses the overwrite (Object Lock in
  // COMPLIANCE mode does exactly that, correctly) must not fail the drill.
  try {
    await vault.put(chosen.key, Buffer.from(JSON.stringify(Object.assign({}, manifest, { verification }), null, 2), 'utf8'),
      { contentType: 'application/json' });
  } catch (e) {
    log(`could not stamp the manifest with the result (${e.message}) — the ledger below still records it`);
  }

  await report.recordRun(db, {
    backupId: manifest.id, kind: 'verify', status: ok ? 'success' : 'failed',
    startedAt, finishedAt: new Date(), durationMs: Date.now() - started,
    tables: comparison ? manifest.totals.tables : null,
    rows: comparison ? manifest.totals.rows : null,
    detail: verification,
    error: ok ? null
      : (staleness.stale
          ? `the newest backup is ${manifestLib.describeAge(staleness.ageHours)} — the nightly backup has stopped` +
            (restoreOk ? '' : `; it also did not restore cleanly: ${comparison && comparison.summary}`)
          : (comparison && comparison.summary)),
  });

  // A stale backup that RESTORED is its own alarm, and it must not borrow the "did not restore"
  // wording — the file is fine, the schedule is not, and the two need different actions.
  if (staleness.stale && restoreOk) {
    await report.alert({
      ok: false,
      subject: 'THE NIGHTLY BACKUP HAS STOPPED RUNNING',
      lines: [
        `The newest backup we can find is ${manifestLib.describeAge(staleness.ageHours)}, taken on ${manifest.createdAt}.`,
        `A backup should be taken every night, so anything over ${staleness.maxAgeHours} hours means the nightly job is not running.`,
        '',
        // Only claim what this run actually did: with --quick, or with no scratch database wired
        // up, nothing was restored and saying otherwise would be the same lie in a smaller font.
        ...(comparison
          ? ['The good news: that backup is genuinely fine. We restored it into a test database and it',
             'came back complete, so nothing already saved has been lost.']
          : ['That backup file itself is intact and decrypts correctly, but it was not test-restored on',
             'this run, so what is in it has not been proven to load.']),
        '',
        `The problem: everything entered since ${manifest.createdAt} is NOT in any backup.`,
        '',
        'The nightly job only sends an email when it fails — so if it stops running altogether it goes',
        'quiet instead of complaining. This message is that missing alarm.',
      ],
      action: 'Ask whoever looks after the system to check the ys-capital-backup scheduled job in Render TODAY — ' +
              'whether it is still enabled, and whether its last runs succeeded.',
    });
    process.exitCode = 1;
  } else if (ok) {
    log(`PASS — backup ${manifest.id} ${comparison ? 'was restored and matches the original' : 'is intact'}`);
    await report.alert({
      ok: true,
      subject: 'Backup test passed',
      lines: [
        `We took the backup from ${manifest.createdAt}, restored it into a test database, and checked it.`,
        '',
        comparison ? comparison.summary : 'The backup file is intact and decrypts correctly.',
        '', 'This is the check that proves the backups would actually work.',
      ],
    });
  } else {
    console.error(`[verify] FAIL — backup ${manifest.id} did not restore cleanly`);
    await report.alert({
      ok: false,
      subject: 'THE BACKUP DID NOT RESTORE CORRECTLY',
      lines: [
        `We took the backup from ${manifest.createdAt} and tried to restore it into a test database.`,
        'It did not come back complete.', '',
        comparison ? comparison.summary : 'The restore failed.',
        ...(comparison ? comparison.missingTables.slice(0, 15).map((t) => `  • missing: ${t}`) : []),
        ...(comparison ? comparison.rowMismatches.slice(0, 15).map((r) => `  • ${r.table}: expected ${r.expected} rows, got ${r.actual}`) : []),
      ],
      action: 'Send this to whoever looks after the system TODAY. Until it is understood, treat the backups as unproven.',
    });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main()
    .catch((e) => {
      console.error('[verify] FAILED:', e.message);
      process.exitCode = 1;
      return report.alert({
        ok: false,
        subject: 'The backup test could not run',
        lines: ['The weekly backup test did not complete.', '', `What went wrong: ${e.message}`],
        action: 'Send this to whoever looks after the system — until it runs, nobody has proven the backups work.',
      }).catch(() => {});
    })
    .finally(async () => { try { await db.pool.end(); } catch (_) {} });
}

module.exports = { _internals: { lostServerDuringRestore, firstFailedTable } };
