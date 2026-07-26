'use strict';
/**
 * One-time copy of every existing document from the local disk into S3-compatible storage
 * (owner-directed 2026-07-26). Run this AFTER the S3 adapter is live and BEFORE retiring the local
 * disk, so every historical document lives in the shared "filing cabinet" — not just new uploads.
 *
 * SAFE BY DESIGN:
 *  - DRY-RUN by default: prints what it WOULD copy and changes nothing. Pass `--apply` to copy.
 *  - IDEMPOTENT: a document already present in S3 (same key, same size) is skipped, so re-running is
 *    harmless. It copies bytes at the SAME key, so `documents.storage_ref` never changes.
 *  - NON-DESTRUCTIVE: it NEVER deletes the local copy. The local disk stays as a fallback (dual-read)
 *    until you're satisfied everything is in S3. Deleting the disk is a separate, manual decision.
 *  - Never mutates a loan file or any field other than optionally stamping `documents.storage_provider='s3'`.
 *
 * Requires: DATABASE_URL + the four S3_* env vars. Reads local bytes via storage._local, writes via
 * the S3 adapter's putAt(sameKey).
 *
 *   node scripts/migrate-storage-to-s3.js            # dry run
 *   node scripts/migrate-storage-to-s3.js --apply    # actually copy
 */
const R = require('path').resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

(async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  const s3 = require(R + '/src/lib/storage-s3');
  const local = require(R + '/src/lib/storage')._local;
  if (!s3._internals.configured()) { console.error('S3 is not configured (set the four S3_* env vars).'); process.exit(1); }
  if (!local) { console.error('local storage provider not available'); process.exit(1); }

  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let copied = 0, skipped = 0, missing = 0, failed = 0, scanned = 0;
  try {
    // Every document that still has a stored ref. Order oldest-first so a long run is resumable.
    const { rows } = await pool.query(
      `SELECT id, storage_ref, storage_provider FROM documents
        WHERE storage_ref IS NOT NULL AND storage_ref <> '' ORDER BY created_at ASC`);
    console.log(`${rows.length} documents to check.${APPLY ? '' : '  (DRY RUN — pass --apply to copy)'}`);

    for (const doc of rows) {
      scanned++;
      const ref = doc.storage_ref;
      // Already in S3? (same key + a real size) → skip.
      let inS3 = null;
      try { inS3 = await s3.stat(ref); } catch (_e) { inS3 = null; }
      // Local bytes present?
      let buf = null;
      try { buf = await local.read(ref); } catch (_e) { buf = null; }

      if (inS3 && inS3.size != null && buf && inS3.size === buf.length) { skipped++; continue; }
      if (!buf || !buf.length) {
        // Nothing on local to copy. If it's already in S3, fine; otherwise report it (don't guess).
        if (inS3) { skipped++; } else { missing++; console.log(`  MISSING local bytes: doc ${doc.id} ref ${ref}`); }
        continue;
      }
      if (!APPLY) { copied++; if (copied <= 20) console.log(`  would copy: doc ${doc.id} ref ${ref} (${buf.length} bytes)`); continue; }
      try {
        await s3.putAt(ref, buf);
        // Re-read the size to confirm the write landed before stamping the provider.
        const chk = await s3.stat(ref);
        if (!chk || chk.size !== buf.length) throw new Error(`size mismatch after copy (got ${chk && chk.size}, want ${buf.length})`);
        await pool.query(`UPDATE documents SET storage_provider='s3' WHERE id=$1`, [doc.id]);
        copied++;
        if (copied % 100 === 0) console.log(`  …${copied} copied`);
      } catch (e) { failed++; console.log(`  FAILED: doc ${doc.id} ref ${ref}: ${(e && e.message) || e}`); }
    }
    console.log(`\nDone. scanned=${scanned} copied=${APPLY ? copied : 0} would-copy=${APPLY ? 0 : copied} skipped=${skipped} missing-local=${missing} failed=${failed}`);
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
