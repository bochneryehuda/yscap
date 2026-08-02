'use strict';
/**
 * DOCUMENT vault copy — the other half of a real restore.
 *
 * The database stores a reference to every uploaded file (appraisals, bank statements, insurance
 * binders, signed term sheets); the BYTES live in the documents object store. Restore the database
 * alone and you get every loan file, every borrower and every condition back — with every document
 * a dead link. That is not a restored system, so the documents are copied into the same vault, on
 * the same schedule, behind the same key.
 *
 * INCREMENTAL BY DESIGN. Documents are immutable once written (a new version gets a new key), so an
 * object already copied at the same size and ETag is skipped — the state lives in
 * `backup_document_state`. The first run copies everything; every run after it copies only that
 * day's uploads, which is minutes and pennies.
 *
 * ENCRYPTED THE SAME WAY as the database dump: a bank statement in a third-party bucket is exactly
 * as sensitive as the row that points at it. Same master key, fresh salt per object.
 *
 * ONE-WAY. Nothing here ever writes to, renames, or deletes anything in the SOURCE bucket. The
 * only delete it can ever do is inside the vault, under retention.
 */
const cipher = require('./cipher');
const { createVault, vaultConfigFromEnv } = require('./vault');
const cfg = require('../../config');

/** The live documents bucket, as a read-only vault client. Reuses the app's own S3_* settings. */
function sourceBucket(env = process.env) {
  return createVault(Object.assign(vaultConfigFromEnv('S3', env), { label: 'documents-source' }));
}

/** PURE — where a source document lands inside the vault. Keys are kept verbatim (plus `.ysbak`)
 *  so a restore can put every file back at exactly the key the database already points at. */
function vaultKeyFor(sourceKey) { return `documents/${sourceKey}.ysbak`; }
/** PURE — the inverse. */
function sourceKeyFor(vaultKey) {
  const m = /^documents\/(.+)\.ysbak$/.exec(String(vaultKey || ''));
  return m ? m[1] : null;
}

/**
 * PURE — decide what still needs copying.
 * @param {Array<{key,size,etag}>} sourceObjects  everything in the documents bucket
 * @param {Map<string,{source_etag,source_bytes}>} already  state keyed by source key
 * @param {number} limit  ceiling for this run
 */
function planCopy(sourceObjects, already, limit) {
  const todo = [];
  let skipped = 0;
  for (const o of sourceObjects) {
    if (!o.key || o.key.endsWith('/')) continue;                 // folder placeholders carry no bytes
    if (o.key.startsWith('_probe/')) continue;                   // our own connectivity probes
    const seen = already.get(o.key);
    // A changed size or ETag means the bytes changed under a key we already copied — re-copy it.
    if (seen && String(seen.source_etag || '') === String(o.etag || '') && Number(seen.source_bytes) === Number(o.size)) {
      skipped++;
      continue;
    }
    todo.push(o);
  }
  return { todo: todo.slice(0, limit), skipped, deferred: Math.max(0, todo.length - limit) };
}

/**
 * Copy new/changed documents into every vault.
 * @returns {{copied:number, skipped:number, deferred:number, bytes:number, failures:Array}}
 */
async function syncDocuments(db, vaults, { limit = 5000, encryptionKey, log = console.log } = {}) {
  const source = sourceBucket();
  if (!source.configured()) {
    log('[backup] documents: the app is not using object storage for documents (STORAGE_PROVIDER is not s3) — nothing to copy');
    return { copied: 0, skipped: 0, deferred: 0, bytes: 0, failures: [], skippedReason: 'no source bucket' };
  }

  const sourceObjects = await source.list('');
  log(`[backup] documents: ${sourceObjects.length} objects in the live bucket`);

  let copied = 0, skipped = 0, deferred = 0, bytes = 0;
  const failures = [];

  for (const vault of vaults) {
    const state = new Map();
    try {
      const rows = (await db.query(
        `SELECT object_key, source_etag, source_bytes FROM backup_document_state WHERE vault_label=$1`,
        [vault.label])).rows;
      for (const r of rows) state.set(r.object_key, r);
    } catch (e) {
      // No state = copy everything. Slow, never wrong. Far better than assuming "already done".
      log(`[backup] documents: could not read the copy state (${e.message}) — treating every object as new`);
    }

    const plan = planCopy(sourceObjects, state, limit);
    skipped += plan.skipped;
    deferred += plan.deferred;
    log(`[backup] documents → ${vault.label}: ${plan.todo.length} to copy, ${plan.skipped} already there` +
        (plan.deferred ? `, ${plan.deferred} left for the next run` : ''));

    for (const obj of plan.todo) {
      try {
        const buf = await source.get(obj.key);
        if (!buf) { failures.push({ key: obj.key, error: 'disappeared from the source bucket mid-run' }); continue; }
        const enc = await cipher.encryptBuffer(encryptionKey, buf, { name: obj.key });
        await vault.put(vaultKeyFor(obj.key), enc);
        await db.query(
          `INSERT INTO backup_document_state (vault_label, object_key, source_etag, source_bytes, copied_at)
           VALUES ($1,$2,$3,$4, now())
           ON CONFLICT (vault_label, object_key)
           DO UPDATE SET source_etag=EXCLUDED.source_etag, source_bytes=EXCLUDED.source_bytes, copied_at=now()`,
          [vault.label, obj.key, obj.etag || null, obj.size || 0]).catch(() => {});
        copied++;
        bytes += buf.length;
      } catch (e) {
        // One unreadable document must not abandon the other nine thousand. It is reported, and the
        // next run tries again because no state row was written for it.
        failures.push({ key: obj.key, error: e.message });
      }
    }
  }

  return { copied, skipped, deferred, bytes, failures };
}

/**
 * Put documents BACK — the restore direction. Reads `documents/…` out of the vault, decrypts, and
 * writes each object to `target` at its ORIGINAL key, so every reference already in the restored
 * database resolves without touching a single row.
 *
 * Skips anything already present at the right size, so an interrupted restore resumes.
 */
async function restoreDocuments(vault, target, { encryptionKey, log = console.log, limit = Infinity } = {}) {
  const objects = await vault.list('documents/');
  log(`[backup] restore: ${objects.length} documents in the vault`);
  let restored = 0, skipped = 0;
  const failures = [];
  for (const o of objects) {
    if (restored >= limit) break;
    const key = sourceKeyFor(o.key);
    if (!key) continue;
    try {
      const existing = await target.head(key).catch(() => null);
      if (existing && existing.bytes > 0) { skipped++; continue; }
      const enc = await vault.get(o.key);
      if (!enc) { failures.push({ key, error: 'missing from the vault' }); continue; }
      const plain = await cipher.decryptBuffer(encryptionKey, enc);
      await target.put(key, plain);
      restored++;
      if (restored % 250 === 0) log(`[backup] restore: ${restored} documents put back…`);
    } catch (e) {
      failures.push({ key, error: e.message });
    }
  }
  return { restored, skipped, failures, total: objects.length };
}

module.exports = { syncDocuments, restoreDocuments, sourceBucket, planCopy, vaultKeyFor, sourceKeyFor };
