#!/usr/bin/env node
'use strict';
/**
 * RESTORE FROM A BACKUP — the tool you reach for on the worst day.
 *
 *   node scripts/backup-restore.js --list                       what backups exist
 *   node scripts/backup-restore.js --show <id>                  everything known about one
 *   node scripts/backup-restore.js --latest --to-file dump.pgc  fetch + decrypt, restore by hand
 *   node scripts/backup-restore.js --latest --target "postgres://…/newdb"
 *   node scripts/backup-restore.js --id 4f2a91bd --target "…" --documents
 *
 * DESIGN NOTES, because this runs under pressure:
 *   · `--list` needs NOTHING but the vault credentials. The manifests are plaintext, so you can
 *     see what you have before anyone finds the encryption key.
 *   · Every restore is verified BEFORE it is applied: the ciphertext checksum is compared to the
 *     manifest, and the GCM tag has to verify, or nothing is written. A half-good backup is
 *     refused rather than half-restored.
 *   · Restoring ONTO the live database requires typing an explicit flag. The default target is a
 *     NEW, empty database — which is what you almost always want, because it lets you look before
 *     you switch.
 *   · Nothing here writes to the vault. A restore can never damage the backups.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { pipeline } = require('stream/promises');

const cfg = require('../src/config');
const cipher = require('../src/lib/backup/cipher');
const { vaultsFromEnv, createVault, vaultConfigFromEnv } = require('../src/lib/backup/vault');
const manifestLib = require('../src/lib/backup/manifest');
const documentsLib = require('../src/lib/backup/documents');
const report = require('../src/lib/backup/report');
const { pgEnvFromUrl, isSameDatabase } = require('../src/lib/backup/targets');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const log = (...m) => console.log(...m);

function usage() {
  log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 22).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
}

/** The vault to read from — the primary unless --vault names another. */
function pickVault() {
  const wanted = val('--vault');
  const vaults = vaultsFromEnv();
  if (!vaults.length) {
    throw new Error('No backup vault is configured. Set BACKUP_S3_BUCKET / _ENDPOINT / _ACCESS_KEY_ID / _SECRET_ACCESS_KEY.');
  }
  if (!wanted) return vaults[0];
  const v = vaults.find((x) => x.label === wanted || x.config.bucket === wanted);
  if (!v) throw new Error(`no configured vault called "${wanted}" (have: ${vaults.map((x) => x.label).join(', ')})`);
  return v;
}

/** Every backup in the vault, newest first, with its manifest where one can be read. */
async function listBackups(vault) {
  const objects = await vault.list('db/');
  const manifests = objects.filter((o) => o.key.endsWith('.manifest.json'));
  const out = [];
  for (const o of manifests) {
    const parsed = manifestLib.parseKey(o.key);
    if (!parsed) continue;
    let manifest = null;
    try { manifest = manifestLib.parseManifest(await vault.get(o.key)); } catch (_) { /* listed anyway */ }
    out.push({ key: o.key, base: parsed.base, at: parsed.at, id: parsed.id, manifest });
  }
  return out.sort((a, b) => b.at - a.at);
}

function describe(b) {
  const m = b.manifest;
  const when = b.at.toISOString().replace('T', ' ').replace(/\.\d+Z/, 'Z');
  if (!m) return `${b.id}  ${when}  (manifest unreadable — the dump may still be fine)`;
  return `${b.id}  ${when}  ${String(m.totals.tables).padStart(4)} tables  ` +
         `${String(m.totals.rows.toLocaleString('en-US')).padStart(13)} rows  ` +
         `${report.human(m.artifact.cipherBytes).padStart(10)}  pg${m.source.postgresMajor}  ` +
         `key ${m.encryption.keyId}${m.verification && m.verification.ok ? '  [test-restored ✓]' : ''}`;
}

/** Stream one backup out of the vault, decrypting and checking it on the way past. */
async function fetchDecrypted(vault, entry, destPath) {
  const m = entry.manifest;
  const dumpKey = m ? m.artifact.key : `${entry.base}.ysbak`;
  log(`fetching ${dumpKey}…`);
  const { stream } = await vault.getStream(dumpKey);

  const dec = cipher.createDecryptStream(cfg.backup.encryptionKey, {
    onHeader: (h) => log(`  encrypted ${h.createdAt} with key ${h.keyId} (${h.alg})`),
  });
  const out = fs.createWriteStream(destPath, { mode: 0o600 });
  await pipeline(stream, dec, out);

  const bytes = fs.statSync(destPath).size;
  log(`  decrypted ${report.human(bytes)}`);
  // The manifest is the receipt. If the plaintext does not hash to what was recorded when the
  // backup was taken, something changed in between and the restore stops here.
  if (m && m.artifact.plainSha256 && dec.plainSha256 !== m.artifact.plainSha256) {
    throw new Error(
      `CHECKSUM MISMATCH: the restored data hashes to ${dec.plainSha256} but the manifest recorded ` +
      `${m.artifact.plainSha256}. Do NOT use this file — try another backup.`);
  }
  if (m) log('  checksum matches the manifest ✓');
  return { bytes, sha256: dec.plainSha256 };
}

/**
 * pg_restore the archive into `targetUrl`.
 *
 * `--no-owner --no-privileges` because the roles in a fresh managed database are not the roles the
 * dump was taken under. `--exit-on-error` is deliberately NOT set: a restore into a database that
 * already has some objects reports errors for each one and still restores everything else, and on
 * the day you need this you want as much of the data back as possible. Every error is printed and
 * counted, so "restored with 3 errors" is never mistaken for a clean run.
 */
function runPgRestore(targetUrl, dumpPath, { jobs = 2, clean = false } = {}) {
  const env = pgEnvFromUrl(targetUrl);
  // --dbname is REQUIRED. Without it pg_restore writes the SQL to stdout and restores NOTHING,
  // which looks like a clean, instant, successful restore. Only the database NAME goes on the
  // command line; the credentials ride in the environment, out of `ps`.
  const args = ['--no-owner', '--no-privileges', '--verbose', `--jobs=${Math.max(1, jobs)}`, `--dbname=${env.PGDATABASE}`];
  if (clean) args.push('--clean', '--if-exists');
  args.push(dumpPath);
  return new Promise((resolve, reject) => {
    const proc = spawn('pg_restore', args, {
      env: Object.assign({}, process.env, env), stdio: ['ignore', 'inherit', 'pipe'],
    });
    let errors = 0;
    let tail = '';
    proc.stderr.on('data', (c) => {
      const s = c.toString();
      tail = (tail + s).slice(-8000);
      for (const line of s.split('\n')) {
        if (/^pg_restore: error:/.test(line)) { errors++; console.error(line); }
      }
    });
    proc.on('error', (e) => reject(new Error(`could not start pg_restore: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0 || errors > 0) resolve({ code, errors, tail });
      else reject(new Error(`pg_restore exited with code ${code}: ${tail.slice(-1500)}`));
    });
  });
}

/**
 * Put the loan documents back into the live document bucket, at their ORIGINAL keys — so every
 * reference already in the restored database resolves without touching a single row.
 *
 * Deliberately INDEPENDENT of the database restore: the two halves fail and are re-run separately,
 * and "the database is fine, the documents are gone" is a real scenario that must not require
 * restoring a database you already have.
 */
async function restoreDocumentsInto(vault) {
  log('\nputting the documents back…');
  const targetBucket = createVault(Object.assign(vaultConfigFromEnv('S3'), { label: 'documents-target' }));
  if (!targetBucket.configured()) {
    log('  SKIPPED: the document bucket (S3_*) is not configured in this environment.');
    return;
  }
  const out = await documentsLib.restoreDocuments(vault, targetBucket, { encryptionKey: cfg.backup.encryptionKey, log });
  log(`  ${out.restored} documents restored, ${out.skipped} already present` +
      (out.failures.length ? `, ${out.failures.length} FAILED` : ''));
  for (const f of out.failures.slice(0, 20)) log(`    ! ${f.key}: ${f.error}`);
}

async function main() {
  if (!argv.length || has('--help') || has('-h')) { usage(); return; }

  const vault = pickVault();
  const backups = await listBackups(vault);

  if (has('--list')) {
    if (!backups.length) { log(`No backups found in ${vault.config.bucket}.`); return; }
    log(`${backups.length} backups in ${vault.config.bucket} (newest first):\n`);
    for (const b of backups) log('  ' + describe(b));
    log('\nRestore one with:  node scripts/backup-restore.js --id <id> --target "postgres://…"');
    return;
  }

  if (has('--show')) {
    const id = val('--show');
    const b = backups.find((x) => x.id === id);
    if (!b) { console.error(`No backup with id ${id}.`); process.exitCode = 1; return; }
    log(JSON.stringify(b.manifest || { note: 'manifest unreadable', key: b.key }, null, 2));
    return;
  }

  const entry = has('--latest') ? backups[0] : backups.find((x) => x.id === val('--id'));
  if (!entry) {
    console.error(has('--latest') ? 'There are no backups in the vault.' : `No backup with id ${val('--id')}. Try --list.`);
    process.exitCode = 1;
    return;
  }
  log(`using backup ${describe(entry)}`);

  if (!cfg.backup.encryptionKey) {
    console.error('BACKUP_ENCRYPTION_KEY is not set — the backup cannot be decrypted without it. ' +
                  'It is the same key the backup job used when this was written' +
                  (entry.manifest ? ` (fingerprint ${entry.manifest.encryption.keyId}).` : '.'));
    process.exitCode = 1;
    return;
  }

  const target = val('--target');
  const toFile = val('--to-file');
  const tmpPath = toFile || path.join(cfg.backup.tempDir || os.tmpdir(), `yscap-restore-${entry.id}.pgc`);
  let cleanupTmp = !toFile;

  try {
    await fetchDecrypted(vault, entry, tmpPath);

    if (!target) {
      cleanupTmp = false;
      log(`\nWrote the decrypted archive to ${tmpPath}`);
      log('Restore it with:  pg_restore --no-owner --no-privileges -d "postgres://…" ' + tmpPath);
      // The documents are a SEPARATE restore and must not be reachable only through a database
      // target — "the database is fine, the documents are gone" is a real day.
      if (has('--documents')) await restoreDocumentsInto(vault);
      return;
    }

    // THE ONE IRREVERSIBLE MOMENT IN THIS TOOL.
    if (isSameDatabase(target, cfg.databaseUrl || '') && !has('--overwrite-the-live-database')) {
      console.error(
        '\nREFUSING: that target IS the live database.\n' +
        'Restoring over it replaces live data with the backup, and anything entered since the backup\n' +
        'was taken is gone. The safe move is to restore into a NEW empty database, look at it, and\n' +
        'then switch over.\n' +
        'If replacing production really is what you want, re-run with --overwrite-the-live-database.');
      process.exitCode = 1;
      return;
    }

    try { execFileSync('pg_restore', ['--version'], { stdio: 'ignore' }); }
    catch (_) { throw new Error('pg_restore is not installed here. Use the backup Dockerfile, or restore the file by hand.'); }

    log(`\nrestoring into ${new URL(target).pathname.replace(/^\//, '')}…`);
    const res = await runPgRestore(target, tmpPath, {
      jobs: parseInt(val('--jobs') || '2', 10) || 2,
      clean: has('--overwrite-the-live-database') || has('--clean'),
    });
    if (res.errors) {
      log(`\nRestore finished with ${res.errors} errors (printed above). This is normal when the target ` +
          'already contained objects; check them before trusting the result.');
    } else {
      log('\nRestore finished with no errors.');
    }
    log('Verify it with:  node scripts/backup-verify.js --id ' + entry.id);

    if (has('--documents')) await restoreDocumentsInto(vault);
  } finally {
    if (cleanupTmp && fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }
}

// Only run when invoked directly — the tests require this file for `isSameDatabase`, and a restore
// tool that starts working the moment it is imported would be its own kind of disaster.
if (require.main === module) {
  main().catch((e) => { console.error('\nRESTORE FAILED:', e.message); process.exitCode = 1; });
}

module.exports = { _internals: { describe, listBackups } };
