/* DB integration test — the SharePoint VERIFY pass must not raise the alarming
 * "local-missing / the mirror may be the only surviving copy — do not delete it"
 * verdict on a TRANSIENT source-read failure. Root cause it guards (found by the
 * 2026-08 S3 provider-agnostic audit): making verifyRow provider-agnostic exposed
 * it to S3's transient errors (5xx/timeout, which the dual-read wrapper does NOT
 * fall back on), which its catch blindly treated as local-missing — a sticky
 * 30-day stamp + a false "your only copy is gone" card + mirror-unhealthy.
 *
 * Requires a throwaway Postgres in DATABASE_URL. No network/Graph (the verify read
 * throws BEFORE any Graph call). Run: DATABASE_URL=... node scripts/test-sp-verify-transient-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-verify-transient-db (no DATABASE_URL)'); process.exit(0); }

process.env.SHAREPOINT_BACKUP_ENABLED = process.env.SHAREPOINT_BACKUP_ENABLED || '1';
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'c';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const backup = require('../src/lib/sharepoint-backup');
const storage = require('../src/lib/storage');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// Monkey-patch the LOCAL provider's read + probe so we can drive verifyRow's
// error path deterministically. providerForRow() returns storage._local for a
// 'local' doc, and both files share this singleton, so the patch is visible.
const realRead = storage._local.read;
const realProbe = storage._local.probe;
function patch({ readError, probe }) {
  storage._local.read = async () => { throw new Error(readError); };
  storage._local.probe = () => probe;
}
function restore() { storage._local.read = realRead; storage._local.probe = realProbe; }

const HEALTHY = { ok: true, base: '/x', configured: '/x', persistent: true };
const UNMOUNTED = { ok: false, base: null, configured: '/x', persistent: false };

(async () => {
  await ensureSchema();

  const email = 'spverify@example.test';
  const prior = (await db.query(`SELECT id FROM borrowers WHERE email=$1`, [email])).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }
  const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Ver','Ify',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b])).rows[0].id;

  // A MIRRORED doc due for verification (backup_ref set, verified_at NULL).
  const mkMirrored = async () => (await db.query(
    `INSERT INTO documents (filename, content_type, doc_kind, storage_provider, storage_ref, size_bytes,
        application_id, borrower_id, is_current, sharepoint_backup_ref, sharepoint_verified_at)
     VALUES ('EOI.pdf','application/pdf','insurance','local','ab/eoi.pdf',10,$1,$2,true,'sp:drive1:item1',NULL)
     RETURNING id`, [app, b])).rows[0].id;

  const integrityOf = async (id) => (await db.query(`SELECT sharepoint_integrity AS i, sharepoint_verified_at AS v FROM documents WHERE id=$1`, [id])).rows[0];
  const cardCount = async (id) => (await db.query(`SELECT count(*)::int AS n FROM sync_review_queue WHERE task_id=$1`, [`spdoc:${id}`])).rows[0].n;

  // === CASE A: healthy storage + a TRANSIENT read error (S3 5xx) ==============
  // Must NOT alarm local-missing — re-check on the next rotation instead.
  const docA = await mkMirrored();
  patch({ readError: 's3 read failed (HTTP 503)', probe: HEALTHY });
  await backup.verifyOnce({ limit: 100 });
  restore();
  const a = await integrityOf(docA);
  ok('A: a transient S3 5xx during verify → verify-error (NOT local-missing)',
    /^verify-error/.test(a.i || ''));
  ok('A: a transient verify error does NOT raise the "only surviving copy" card',
    (await cardCount(docA)) === 0);
  ok('A: a transient verify error is backdated (stays in the recheck rotation, no 30-day exile)',
    a.v != null && (Date.now() - new Date(a.v).getTime()) > 5 * 24 * 3600 * 1000);

  // === CASE B: healthy storage + a GENUINELY MISSING source (ENOENT) ==========
  // This is the real "the source copy is gone" case — alarm as before.
  const docB = await mkMirrored();
  patch({ readError: 'ENOENT: no such file or directory, open \'ab/eoi.pdf\'', probe: HEALTHY });
  await backup.verifyOnce({ limit: 100 });
  restore();
  const bRow = await integrityOf(docB);
  ok('B: a genuinely-missing source (ENOENT) on healthy storage → local-missing', bRow.i === 'local-missing');
  ok('B: a genuinely-missing source DOES raise the "do not delete" card', (await cardCount(docB)) >= 1);

  // === CASE C: TRANSIENTLY UNMOUNTED disk + ENOENT ============================
  // The file reads ENOENT only because the disk is down — NOT because it's gone.
  // Must be verify-error, never local-missing.
  const docC = await mkMirrored();
  patch({ readError: 'ENOENT: no such file or directory, open \'ab/eoi.pdf\'', probe: UNMOUNTED });
  await backup.verifyOnce({ limit: 100 });
  restore();
  const c = await integrityOf(docC);
  ok('C: ENOENT while the disk is transiently unmounted → verify-error (not local-missing)',
    /^verify-error/.test(c.i || ''));
  ok('C: a transiently-unmounted disk does NOT raise the "only surviving copy" card',
    (await cardCount(docC)) === 0);

  // Cleanup
  await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id=$1)`, [b]);
  await db.query(`DELETE FROM documents WHERE borrower_id=$1`, [b]);
  await db.query(`DELETE FROM applications WHERE borrower_id=$1`, [b]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [b]);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  process.exit(fail ? 1 : 0);
})().catch((e) => { restore(); console.error('TEST CRASH:', e); process.exit(1); });
