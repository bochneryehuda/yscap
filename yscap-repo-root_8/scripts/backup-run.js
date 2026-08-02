#!/usr/bin/env node
'use strict';
/**
 * THE NIGHTLY BACKUP.
 *
 *   node scripts/backup-run.js                 full run: database + documents + prune
 *   node scripts/backup-run.js --preflight     check everything is wired, write nothing
 *   node scripts/backup-run.js --db-only       skip the document copy
 *   node scripts/backup-run.js --no-prune      never delete an old backup this run
 *
 * WHAT IT PRODUCES: one encrypted, self-describing, independently restorable copy of the ENTIRE
 * database, in an object-storage vault outside Render, with a manifest proving what is inside it.
 *
 * WHY pg_dump AND NOT A TABLE LIST: pg_dump asks the database what exists and dumps all of it —
 * every table, view, index, sequence, constraint, trigger and function, in dependency order. There
 * is no list of tables anywhere in this system to keep up to date, which is the only way to
 * guarantee that a table added next month is backed up that same night. The inventory taken
 * alongside it is not a filter — it is the RECEIPT, used later to prove a restore came back whole.
 *
 * CONSISTENCY: pg_dump reads inside one repeatable-read snapshot, so the dump is the database as it
 * stood at one instant — not a smear of rows from across the run. It takes no exclusive locks, so
 * the portal keeps working normally while it runs.
 *
 * FAILURE POSTURE: every step that can fail loudly does. A partial upload is aborted rather than
 * left as a half object; a dump that exits non-zero never gets uploaded; a run that dies anywhere
 * writes a 'failed' row to the ledger and emails a human. The one thing this job will never do is
 * report success it did not earn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const cfg = require('../src/config');
const db = require('../src/db');
const cipher = require('../src/lib/backup/cipher');
const { vaultsFromEnv } = require('../src/lib/backup/vault');
const inventoryLib = require('../src/lib/backup/inventory');
const manifestLib = require('../src/lib/backup/manifest');
const retention = require('../src/lib/backup/retention');
const documentsLib = require('../src/lib/backup/documents');
const report = require('../src/lib/backup/report');
const { pgEnvFromUrl } = require('../src/lib/backup/targets');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const PREFLIGHT_ONLY = has('--preflight');
const DB_ONLY = has('--db-only');
const NO_PRUNE = has('--no-prune');

const SINGLE_PUT_CEILING = 64 * 1024 * 1024;    // above this, upload in parts
const log = (...m) => console.log('[backup]', ...m);

/** pg_dump's own version, or null when it is not installed. */
function pgDumpVersion() {
  try {
    const out = execFileSync('pg_dump', ['--version'], { encoding: 'utf8' });
    const m = /(\d+)(?:\.(\d+))?/.exec(out);
    return m ? { text: out.trim(), major: parseInt(m[1], 10) } : null;
  } catch (_) { return null; }
}

/** Free bytes on the filesystem holding `dir`, or null when it cannot be measured. */
function freeBytes(dir) {
  try {
    const s = fs.statfsSync(dir);
    return s.bavail * s.bsize;
  } catch (_) { return null; }
}

/**
 * Everything that must be true BEFORE a byte is written. Returns { ok, problems, facts }.
 * Run on its own with --preflight, and always as the first step of a real run: discovering that
 * pg_dump is the wrong version AFTER dumping 900 MB helps nobody.
 */
async function preflight() {
  const problems = [];
  const facts = {};

  if (!cfg.backup.encryptionKey) {
    problems.push('BACKUP_ENCRYPTION_KEY is not set. Generate one with:  openssl rand -base64 32');
  } else {
    try { facts.keyId = cipher.keyFingerprint(cfg.backup.encryptionKey); }
    catch (e) { problems.push(e.message); }
  }

  if (!cfg.backup.databaseUrl) problems.push('DATABASE_URL (or BACKUP_DATABASE_URL) is not set — there is nothing to back up');

  const vaults = vaultsFromEnv();
  facts.vaults = vaults.map((v) => `${v.label} → ${v.config.bucket}`);
  if (!vaults.length) {
    problems.push('No backup vault is configured. Set BACKUP_S3_BUCKET, BACKUP_S3_ENDPOINT, ' +
                  'BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY.');
  }
  for (const v of vaults) {
    const p = await v.probe();
    facts[`vault:${v.label}`] = p;
    if (!p.ok) problems.push(`vault ${v.label} (${v.config.bucket}) is not usable: ${p.error}`);
    else if (!v.config.objectLockMode) {
      // Not fatal — a backup in a plain bucket is still a backup. But WORM is the difference
      // between "we have copies" and "nobody, including us, can destroy the copies", so it is
      // always said out loud.
      log(`NOTE: vault ${v.label} has no Object Lock configured. Backups can be deleted by anyone ` +
          'holding the bucket credentials. Set BACKUP_S3_OBJECT_LOCK_MODE=COMPLIANCE and ' +
          'BACKUP_S3_OBJECT_LOCK_DAYS to make them undeletable.');
    }
  }

  const pgd = pgDumpVersion();
  facts.pgDump = pgd ? pgd.text : null;
  if (!pgd) {
    problems.push('pg_dump is not installed in this container. Use the backup Dockerfile ' +
                  '(docs/DATABASE-BACKUP-AND-RESTORE.md) so the right postgresql-client is present.');
  }

  let server = null;
  if (cfg.backup.databaseUrl) {
    try {
      const r = await db.query(`SELECT current_setting('server_version_num') AS n, version() AS v`);
      server = { num: parseInt(r.rows[0].n, 10), text: r.rows[0].v };
      facts.server = server.text;
    } catch (e) {
      problems.push(`cannot reach the database: ${e.message}`);
    }
  }
  if (pgd && server) {
    const serverMajor = Math.floor(server.num / 10000);
    facts.serverMajor = serverMajor;
    // pg_dump refuses to dump a server NEWER than itself, and would silently produce an archive an
    // older pg_restore cannot read. Same-or-newer is the only safe combination.
    if (pgd.major < serverMajor) {
      problems.push(`pg_dump is version ${pgd.major} but the database is PostgreSQL ${serverMajor}. ` +
                    `pg_dump must be ${serverMajor} or newer — install postgresql-client-${serverMajor}.`);
    }
  }

  const tmpDir = cfg.backup.tempDir || os.tmpdir();
  facts.tempDir = tmpDir;
  if (!cfg.backup.streamDirect) {
    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (e) { problems.push(`temp directory ${tmpDir} is not usable: ${e.message}`); }
    const free = freeBytes(tmpDir);
    facts.tempFreeBytes = free;
    if (free != null && server) {
      // The compressed dump is typically well under a quarter of the on-disk database, but "well
      // under" is not a guarantee, so half is the bar. Below it, say so now rather than run out of
      // disk at 95%.
      try {
        const size = Number((await db.query(`SELECT pg_database_size(current_database()) AS s`)).rows[0].s);
        facts.databaseBytes = size;
        if (free < size * 0.5) {
          problems.push(`only ${report.human(free)} free in ${tmpDir}, for a ${report.human(size)} database. ` +
                        'Give the backup job more disk, or set BACKUP_STREAM_DIRECT=1 to upload without a scratch file.');
        }
      } catch (_) { /* the size check is advisory */ }
    }
  }

  return { ok: problems.length === 0, problems, facts, vaults, pgDump: pgd, server };
}

/** Make sure the ledger tables exist even if the web service has not deployed this migration yet.
 *  db/406 is idempotent, so running it here is free and means the cron job is never blocked. */
async function ensureLedger() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', '406_backup_runs.sql'), 'utf8');
    await db.query(sql);
  } catch (e) {
    log(`could not ensure the backup ledger tables (${e.message}) — continuing; the backup does not depend on them`);
  }
}

/** The pg_dump arguments, in one place so the manifest records exactly what produced the archive. */
function dumpArgs(snapshotId) {
  const a = [
    '--format=custom',      // the restorable archive format: compressed, and pg_restore can pull a
                            // single table out of it without unpacking the rest
    '--no-owner',           // a restore into a fresh managed database has a different owner role
    '--no-privileges',      // …and different GRANTs; the app creates what it needs
    '--compress=6',
  ];
  // Dump the EXACT snapshot the inventory was counted from, so the receipt and the archive describe
  // the same instant and a restore drill can compare row counts to the row instead of to a
  // tolerance. Without it the two are seconds apart, which on a live system is a handful of rows.
  if (snapshotId) a.push(`--snapshot=${snapshotId}`);
  return a;
}

/**
 * Run pg_dump, piping its output through `chain` (transform streams, then optionally a sink).
 * Resolves when pg_dump has exited 0 AND the pipeline has finished; rejects with pg_dump's own
 * stderr, which is the only useful diagnostic when a dump goes wrong.
 *
 * With a single transform and no sink, the caller MUST start consuming that transform (e.g. hand it
 * to a multipart upload) before awaiting — pg_dump fills the pipe and stops otherwise.
 */
function runPgDump(pgEnv, snapshotId, ...chain) {
  const a = dumpArgs(snapshotId);
  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', a, { env: Object.assign({}, process.env, pgEnv), stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const done = pipeline(proc.stdout, ...chain);
    proc.on('error', (e) => reject(new Error(`could not start pg_dump: ${e.message}`)));
    proc.on('close', (code) => {
      done.then(() => {
        if (code === 0) resolve({ stderr });
        else reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim().slice(0, 2000)}`));
      }).catch((e) => reject(new Error(`writing the dump failed: ${e.message}${stderr ? ` (pg_dump said: ${stderr.trim().slice(0, 500)})` : ''}`)));
    });
  });
}

/** Upload one local file to a vault, in one shot or in parts depending on size. */
async function uploadFile(vault, key, filePath, bytes) {
  if (bytes <= SINGLE_PUT_CEILING) {
    return vault.put(key, fs.readFileSync(filePath));
  }
  return vault.putStream(key, fs.createReadStream(filePath), {
    onProgress: ({ parts, bytes: sent }) => {
      if (parts % 10 === 0) log(`  ${vault.label}: ${parts} parts, ${report.human(sent)} uploaded`);
    },
  });
}

/** Delete the objects a retention plan condemned. Never throws — a prune failure must not turn a
 *  successful backup into a failed run. */
async function prune(vault, plan) {
  let deleted = 0;
  const failures = [];
  for (const item of plan.delete) {
    for (const key of [`${item.base}.ysbak`, `${item.base}.manifest.json`, `${item.base}.inventory.ysbak`]) {
      try { await vault.del(key); deleted++; } catch (e) { failures.push({ key, error: e.message }); }
    }
  }
  return { deleted, failures };
}

async function backupDatabase(pre) {
  const startedAt = new Date();
  const started = Date.now();
  const id = manifestLib.newBackupId();
  const keys = manifestLib.keysFor('db', startedAt, id);
  const tmpDir = cfg.backup.tempDir || os.tmpdir();
  const tmpPath = path.join(tmpDir, `yscap-backup-${id}.ysbak`);
  let tmpWritten = false;

  // ONE SNAPSHOT FOR BOTH. A read-only repeatable-read transaction is opened, its snapshot is
  // exported, the inventory is counted inside it, and pg_dump is told to use that same snapshot.
  // The receipt and the archive then describe the identical instant. The transaction is held open
  // for the length of the dump (pg_dump holds an equivalent one anyway) and released in `finally`.
  let snapClient = null;
  let snapshotId = null;
  // Held only for as long as pg_dump needs it. An open transaction stops VACUUM reclaiming dead
  // rows, so it is ended the moment the dump is on disk rather than at the end of the whole run.
  const releaseSnapshot = async () => {
    if (!snapClient) return;
    const c = snapClient;
    snapClient = null;
    try { await c.query('ROLLBACK'); } catch (_) { /* read-only — nothing to lose */ }
    try { c.release(); } catch (_) {}
  };

  try {
    try {
      snapClient = await db.getClient();
      await snapClient.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      snapshotId = (await snapClient.query('SELECT pg_export_snapshot() AS s')).rows[0].s;
    } catch (e) {
      // Not every deployment can export a snapshot (a connection pooler in between, for one). The
      // backup is still correct without it — pg_dump takes its own consistent snapshot; only the
      // row counts become approximate, which the verifier already tolerates.
      log(`could not share a snapshot with pg_dump (${e.message}) — counting separately; the dump is still consistent`);
      if (snapClient) { try { await snapClient.query('ROLLBACK'); } catch (_) {} snapClient.release(); snapClient = null; }
      snapshotId = null;
    }

    log('taking the inventory of what is in the database…');
    const inventory = await inventoryLib.takeInventory(snapClient || db, { inTransaction: !!snapClient });
    log(`  ${inventory.totals.tables} tables, ${inventory.totals.rows.toLocaleString('en-US')} rows, ` +
        `${report.human(inventory.server.sizeBytes)} on disk, schema at ${inventory.migrations.latest || 'unknown'}` +
        (snapshotId ? ' (counted from the same snapshot the dump uses)' : ''));

    // Compare against the last run so a table that VANISHED, or a table that lost most of its rows,
    // is noticed by a person the next morning rather than discovered during a restore.
    let shapeChange = { firstRun: true, newTables: [], droppedTables: [], bigRowDrops: [] };
    try {
      const prev = await report.lastSuccess(db, 'database');
      const prevInv = prev && prev.detail && prev.detail.inventorySummary;
      if (prevInv) shapeChange = inventoryLib.diffInventories(prevInv, inventory);
    } catch (_) { /* advisory */ }
    if (shapeChange.newTables.length) log(`  new since the last backup (already included): ${shapeChange.newTables.join(', ')}`);
    if (shapeChange.droppedTables.length) log(`  WARNING — tables that existed last time and are gone now: ${shapeChange.droppedTables.join(', ')}`);
    for (const d of shapeChange.bigRowDrops) log(`  WARNING — ${d.table} dropped from ${d.was} rows to ${d.now}`);

    const pgEnv = pgEnvFromUrl(cfg.backup.databaseUrl);
    const enc = cipher.createEncryptStream(cfg.backup.encryptionKey, {
      name: `${inventory.server.database}.dump`,
      createdAt: startedAt.toISOString(),
      meta: { postgresMajor: inventory.server.majorVersion, tables: inventory.totals.tables, rows: inventory.totals.rows },
    });

    let artifact;
    const uploaded = [];

    if (cfg.backup.streamDirect) {
      // No scratch file: pg_dump → encrypt → straight into the first vault's multipart upload.
      // The dump is STARTED but not awaited: putStream is what drains the encryptor, and awaiting
      // the dump first would deadlock on a full pipe.
      const primary = pre.vaults[0];
      log(`dumping and uploading straight to ${primary.label} (no scratch file)…`);
      const dumpDone = runPgDump(pgEnv, snapshotId, enc);
      const put = await primary.putStream(keys.dump, enc, {
        onProgress: ({ parts, bytes }) => { if (parts % 10 === 0) log(`  ${parts} parts, ${report.human(bytes)} uploaded`); },
      });
      await dumpDone;
      uploaded.push({ vault: primary, result: put });
      artifact = {
        cipherBytes: enc.cipherBytes, plainBytes: enc.plainBytes,
        cipherSha256: enc.cipherSha256, plainSha256: enc.plainSha256,
      };
      if (pre.vaults.length > 1) {
        log('NOTE: BACKUP_STREAM_DIRECT only writes to the first vault. Turn it off to mirror to the second.');
      }
    } else {
      log('dumping the database…');
      const out = fs.createWriteStream(tmpPath, { mode: 0o600 });   // 0600: only this user can read
                                                                    // the whole company off the disk
      await runPgDump(pgEnv, snapshotId, enc, out);
      tmpWritten = true;
      const stat = fs.statSync(tmpPath);
      artifact = {
        cipherBytes: enc.cipherBytes, plainBytes: enc.plainBytes,
        cipherSha256: enc.cipherSha256, plainSha256: enc.plainSha256,
      };
      // The bytes on disk must be the bytes the encryptor produced. A mismatch here is a failing
      // disk, and uploading it would put a corrupt backup in the vault with a valid-looking manifest.
      if (stat.size !== artifact.cipherBytes) {
        throw new Error(`the scratch file is ${stat.size} bytes but the encryptor produced ${artifact.cipherBytes} — the disk is not writing what we gave it`);
      }
      log(`  dumped ${report.human(artifact.plainBytes)}, encrypted to ${report.human(artifact.cipherBytes)}`);

      for (const vault of pre.vaults) {
        log(`uploading to ${vault.label} (${vault.config.bucket})…`);
        const res = await uploadFile(vault, keys.dump, tmpPath, artifact.cipherBytes);
        uploaded.push({ vault, result: res });
      }
    }

    await releaseSnapshot();      // the dump is captured; the database is free again

    // Prove each copy is actually there and the right size before anything is called a success.
    const stored = [];
    for (const { vault } of uploaded) {
      const head = await vault.head(keys.dump);
      const problems = manifestLib.auditManifest(
        { id, artifact: Object.assign({ key: keys.dump }, artifact), totals: inventory.totals }, head);
      if (problems.length) throw new Error(`${vault.label}: the uploaded backup did not check out — ${problems.join('; ')}`);
      stored.push({
        label: vault.label, bucket: vault.config.bucket, key: head.key,
        objectLock: head.lockMode ? `${head.lockMode} until ${head.lockedUntil}` : null,
      });
      log(`  ${vault.label}: ${report.human(head.bytes)} stored at ${head.key}` +
          (head.lockMode ? ` (locked ${head.lockMode} until ${head.lockedUntil})` : ''));
    }

    const manifest = manifestLib.buildManifest({
      id, at: startedAt, kind: 'db', keys, inventory,
      dump: { tool: 'pg_dump', toolVersion: pre.pgDump && pre.pgDump.text, format: 'custom', args: ['--no-owner', '--no-privileges', '--compress=6'] },
      encryption: { algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256', keyId: enc.keyId },
      artifact, vaults: stored, durationMs: Date.now() - started,
      app: { commit: process.env.RENDER_GIT_COMMIT || null, service: process.env.RENDER_SERVICE_NAME || null, host: os.hostname() },
    });

    const invEncrypted = await cipher.encryptBuffer(
      cfg.backup.encryptionKey, Buffer.from(JSON.stringify(inventory), 'utf8'), { name: `${id}.inventory.json` });
    for (const { vault } of uploaded) {
      await vault.put(keys.inventory, invEncrypted);
      await vault.put(keys.manifest, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), { contentType: 'application/json' });
    }

    // The ledger keeps a SUMMARY inventory (totals + table names and counts) so the next run can
    // diff the shape without downloading and decrypting last night's sidecar.
    const inventorySummary = {
      tables: inventory.tables.map((t) => ({ schema: t.schema, name: t.name, rows: t.rows, exact: t.exact })),
      totals: inventory.totals, objects: inventory.objects,
    };

    await report.recordRun(db, {
      backupId: id, kind: 'database', status: shapeChange.droppedTables.length || shapeChange.bigRowDrops.length ? 'warning' : 'success',
      startedAt, finishedAt: new Date(), durationMs: Date.now() - started,
      tables: inventory.totals.tables, rows: inventory.totals.rows,
      plainBytes: artifact.plainBytes, cipherBytes: artifact.cipherBytes,
      vaults: stored, detail: { manifest, inventorySummary, shapeChange },
    });

    return { ok: true, id, keys, manifest, inventory, stored, shapeChange, durationMs: Date.now() - started };
  } catch (e) {
    await report.recordRun(db, {
      backupId: id, kind: 'database', status: 'failed',
      startedAt, finishedAt: new Date(), durationMs: Date.now() - started, error: e.message,
    });
    throw e;
  } finally {
    await releaseSnapshot();      // backstop — a failure anywhere must not strand the transaction
    // The scratch file holds the whole database in a form one key opens. It never outlives the run.
    if (tmpWritten || fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (e) { log(`WARNING: could not delete the scratch file ${tmpPath}: ${e.message}`); }
    }
  }
}

async function pruneAll(vaults) {
  const policy = retention.policyFromEnv();
  const results = [];
  for (const vault of vaults) {
    try {
      const objects = await vault.list('db/');
      // Plan off the MANIFESTS: one manifest per backup, so each backup is counted once.
      const backups = objects
        .filter((o) => o.key.endsWith('.manifest.json'))
        .map((o) => {
          const parsed = manifestLib.parseKey(o.key);
          return parsed ? { key: o.key, base: parsed.base, at: parsed.at } : null;
        })
        .filter(Boolean);
      const plan = retention.planRetention(backups, new Date(), policy);
      if (plan.aborted) { log(`${vault.label}: ${plan.aborted}`); results.push({ vault: vault.label, aborted: plan.aborted }); continue; }
      if (!plan.delete.length) { log(`${vault.label}: ${backups.length} backups stored, none old enough to remove`); results.push({ vault: vault.label, kept: plan.keep.length, deleted: 0 }); continue; }
      const res = await prune(vault, plan);
      log(`${vault.label}: kept ${plan.keep.length} backups, removed ${plan.delete.length} expired ones` +
          (plan.skippedLocked.length ? ` (${plan.skippedLocked.length} still inside their lock window)` : '') +
          (res.failures.length ? ` — ${res.failures.length} objects could not be deleted` : ''));
      results.push({ vault: vault.label, kept: plan.keep.length, deleted: plan.delete.length, failures: res.failures });
    } catch (e) {
      log(`${vault.label}: could not prune (${e.message}) — old backups are kept, which is the safe direction`);
      results.push({ vault: vault.label, error: e.message });
    }
  }
  return results;
}

async function main() {
  const runStarted = Date.now();
  log(`starting — ${new Date().toISOString()}`);

  const pre = await preflight();
  for (const [k, v] of Object.entries(pre.facts)) {
    if (k.startsWith('vault:')) log(`  ${k}: ${v.ok ? 'reachable' : 'NOT USABLE — ' + v.error}` +
      (v.objectLockOnBucket && v.objectLockOnBucket.enabled ? ` (Object Lock is on: ${v.objectLockOnBucket.defaultMode || 'no default'})` : ''));
    else log(`  ${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`);
  }
  if (!pre.ok) {
    for (const p of pre.problems) console.error(`[backup] BLOCKED: ${p}`);
    if (!PREFLIGHT_ONLY) {
      await ensureLedger();
      await report.recordRun(db, {
        kind: 'database', status: 'failed', startedAt: new Date(runStarted), finishedAt: new Date(),
        durationMs: Date.now() - runStarted, error: pre.problems.join(' | '),
      });
      await report.alert({
        ok: false,
        subject: 'The backup could not run',
        lines: ['The nightly backup did not run because it is not fully set up yet:', '',
          ...pre.problems.map((p) => `  • ${p}`)],
        action: 'Send this message to whoever set up the backup — each line above is a setting that needs a value.',
      });
    }
    process.exitCode = 1;
    return;
  }
  log('preflight passed — everything the backup needs is present');
  if (PREFLIGHT_ONLY) return;

  await ensureLedger();

  let dbResult = null;
  let failure = null;
  try {
    dbResult = await backupDatabase(pre);
  } catch (e) {
    failure = e;
    console.error(`[backup] DATABASE BACKUP FAILED: ${e.message}`);
  }

  let docResult = null;
  if (!DB_ONLY && cfg.backup.documents) {
    const docStarted = Date.now();
    try {
      docResult = await documentsLib.syncDocuments(db, pre.vaults, {
        limit: cfg.backup.documentsPerRun, encryptionKey: cfg.backup.encryptionKey, log,
      });
      log(`documents: ${docResult.copied} copied (${report.human(docResult.bytes)}), ${docResult.skipped} already stored` +
          (docResult.deferred ? `, ${docResult.deferred} queued for the next run` : '') +
          (docResult.failures.length ? `, ${docResult.failures.length} FAILED` : ''));
      await report.recordRun(db, {
        kind: 'documents', status: docResult.failures.length ? 'warning' : 'success',
        startedAt: new Date(docStarted), finishedAt: new Date(), durationMs: Date.now() - docStarted,
        plainBytes: docResult.bytes, detail: { ...docResult, failures: docResult.failures.slice(0, 50) },
      });
    } catch (e) {
      console.error(`[backup] DOCUMENT COPY FAILED: ${e.message}`);
      await report.recordRun(db, {
        kind: 'documents', status: 'failed', startedAt: new Date(docStarted), finishedAt: new Date(),
        durationMs: Date.now() - docStarted, error: e.message,
      });
      if (!failure) failure = new Error(`the database backup succeeded but the document copy failed: ${e.message}`);
    }
  }

  // Only prune once the new backup is safely stored. Pruning before would, on a bad night, delete
  // an old backup and then fail to write the new one.
  if (dbResult && !NO_PRUNE) await pruneAll(pre.vaults);

  const mins = ((Date.now() - runStarted) / 60000).toFixed(1);
  if (failure) {
    await report.alert({
      ok: false,
      subject: 'The nightly backup did not complete',
      lines: [
        `The backup job ran at ${new Date().toISOString()} and did not finish cleanly.`, '',
        `What went wrong: ${failure.message}`, '',
        dbResult
          ? `The database copy itself DID succeed (${dbResult.inventory.totals.tables} tables, ` +
            `${dbResult.inventory.totals.rows.toLocaleString('en-US')} rows).`
          : 'No database copy was made tonight. The most recent good backup is still in the vault.',
      ],
      action: 'Forward this to whoever looks after the system. Until it is fixed, the newest data is not being copied off-site.',
    });
    process.exitCode = 1;
    return;
  }

  log(`done in ${mins} minutes`);
  const warn = dbResult.shapeChange.droppedTables.length || dbResult.shapeChange.bigRowDrops.length;
  await report.alert({
    ok: !warn,
    subject: warn ? 'Backup finished, but the database changed shape' : 'Backup finished',
    lines: [
      `The backup finished at ${new Date().toISOString()} (${mins} minutes).`, '',
      `Copied: ${dbResult.inventory.totals.tables} tables, ${dbResult.inventory.totals.rows.toLocaleString('en-US')} rows ` +
      `(${report.human(dbResult.manifest.artifact.plainBytes)} of data, ${report.human(dbResult.manifest.artifact.cipherBytes)} encrypted).`,
      `Stored in: ${dbResult.stored.map((s) => s.bucket).join(', ')}.`,
      // `null` is the omit marker, NOT '' — an empty string here is a deliberate blank LINE, and
      // filtering those out would collapse the whole message into one paragraph.
      docResult ? `Documents copied this run: ${docResult.copied}.` : null,
      ...(dbResult.shapeChange.droppedTables.length
        ? ['', 'These tables existed in the last backup and are GONE now:', ...dbResult.shapeChange.droppedTables.map((t) => `  • ${t}`)] : []),
      ...(dbResult.shapeChange.bigRowDrops.length
        ? ['', 'These tables lost more than half their rows:', ...dbResult.shapeChange.bigRowDrops.map((d) => `  • ${d.table}: ${d.was} → ${d.now}`)] : []),
    ].filter((l) => l !== null),
    action: warn ? 'If nobody deleted these on purpose, restore from an earlier backup before tonight.' : null,
  });
}

main()
  .catch((e) => { console.error('[backup] UNEXPECTED FAILURE:', e); process.exitCode = 1; })
  .finally(async () => { try { await db.pool.end(); } catch (_) {} });
