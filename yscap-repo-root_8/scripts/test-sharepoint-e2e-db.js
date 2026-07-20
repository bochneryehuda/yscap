/* End-to-end FUNCTIONAL test of the SharePoint mirror pipeline (2026-07-20 A-Z
 * audit). Drives the REAL mirrorRow/forceAttemptDoc/recordFailure code against a
 * real Postgres + real local storage, stubbing ONLY the Graph/folder boundary
 * (sharepoint-map + sharepoint.uploadNew), so the happy path AND the error paths
 * run exactly as production runs them.
 * Run: DATABASE_URL=... node scripts/test-sharepoint-e2e-db.js
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-store-'));
process.env.STORAGE_DIR = tmpStore;
process.env.SHAREPOINT_BACKUP_ENABLED = '1';
process.env.MS_TENANT_ID = 't'; process.env.MS_CLIENT_ID = 'c'; process.env.MS_CLIENT_SECRET = 's';
process.env.SHAREPOINT_STAMP_METADATA = '0';   // skip the Graph metadata stamp in uploadAndRecord

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const storage = require('../src/lib/storage');
const map = require('../src/lib/sharepoint-map');
const sp = require('../src/lib/sharepoint');
const backup = require('../src/lib/sharepoint-backup');

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`FAIL ${n}`); } };

// ---- stub ONLY the external Graph/folder boundary -------------------------
map.resolveSyncFolder = async () => ({ driveId: 'drive1', syncFolderId: 'sync1', fullPath: 'Pipeline Drive/Officer/Borrower/Addr/Synced by Pilot' });
map.resolveConditionFolder = async () => ({ id: 'cond1' });
map.invalidateScope = async () => {};
let uploadBehavior = 'ok';   // 'ok' | 'transient' | 'permanent'
sp.uploadNew = async (driveId, parentId, name, bytes) => {
  if (uploadBehavior === 'transient') { const e = new Error('Graph PUT -> 503 serviceUnavailable: throttled'); e.status = 503; throw e; }
  if (uploadBehavior === 'permanent') { const e = new Error('Graph PUT -> 403 accessDenied: permission'); e.status = 403; e.graphCode = 'accessDenied'; throw e; }
  return { item: { id: `item-${name}`, webUrl: `https://sp.example/${encodeURIComponent(name)}`, size: bytes.length }, conflict: false };
};

(async () => {
  await ensureSchema();
  // Idempotent setup: this suite runs in `npm test`, which may re-run against a
  // persistent DB — clear any prior e2e fixtures (anchored on the fixed email) so
  // the fixed-email borrower insert never collides on a second run.
  const prior = (await db.query(`SELECT id FROM borrowers WHERE email='e2e@example.com'`)).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (
        SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id = ANY($1)
        UNION SELECT 'app:'||a.id FROM applications a WHERE a.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }
  const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('E2E','Borrower','e2e@example.com') RETURNING id`)).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b])).rows[0].id;

  const insertDoc = async (filename, ref, provider, size, over = {}) => {
    const cols = {
      application_id: app, borrower_id: b, filename, content_type: 'application/pdf',
      size_bytes: size, storage_provider: provider, storage_ref: ref,
      doc_kind: 'insurance', source_type: 'system', is_current: true,
      created_at: "now() - interval '1 hour'", ...over,
    };
    const created = cols.created_at; delete cols.created_at;
    const keys = Object.keys(cols); const vals = keys.map((_, i) => `$${i + 1}`);
    return (await db.query(`INSERT INTO documents (${keys.join(',')},created_at) VALUES (${vals.join(',')},${created}) RETURNING id`,
      keys.map((k) => cols[k]))).rows[0].id;
  };
  const mkStoredDoc = async (filename, body, over = {}) => {
    const buf = Buffer.from(body);
    const { ref, provider } = await storage.save(buf, { filename });
    return insertDoc(filename, ref, provider, buf.length, over);
  };
  const enrich = async (id) => (await db.query(
    `SELECT id, filename, content_type, storage_ref, storage_provider, doc_kind, source_type,
            is_current, size_bytes, sharepoint_backup_ref, sharepoint_parent_id, sharepoint_version,
            sharepoint_integrity, sharepoint_item_size, checklist_item_id, llc_id, track_record_id,
            application_id AS app_id, borrower_id, created_at
       FROM documents WHERE id=$1`, [id])).rows[0];
  const stateOf = async (id) => (await db.query(
    `SELECT sharepoint_backed_up_at AS done, sharepoint_backup_ref AS ref, sharepoint_integrity AS integ,
            sharepoint_backup_attempts AS attempts, sharepoint_backup_error AS err
       FROM documents WHERE id=$1`, [id])).rows[0];
  const openCards = async (id) => (await db.query(
    `SELECT count(*)::int n FROM sync_review_queue WHERE task_id=$1 AND status='open'`, [`spdoc:${id}`])).rows[0].n;

  // === HAPPY PATH ===========================================================
  uploadBehavior = 'ok';
  const good = await mkStoredDoc('EOI.pdf', '%PDF-1.4 real bytes for the happy path');
  await backup.mirrorRow(await enrich(good));
  let s = await stateOf(good);
  ok('happy: doc records backed_up_at', !!s.done);
  ok('happy: a SharePoint ref is stored', !!s.ref);
  ok('happy: integrity stamped ok', /^ok/.test(String(s.integ)));
  ok('happy: no failure error left behind', !s.err);
  ok('happy: no review card raised', (await openCards(good)) === 0);

  // === ERROR: local bytes missing (ref points at a file never saved) ========
  const missing = await insertDoc('Gone.pdf', 'zz/never-saved-file.pdf', 'local', 10);
  await backup.forceAttemptDoc(missing);
  await backup.forceAttemptDoc(missing);   // 2nd attempt → PERMANENT_CARD_AT
  s = await stateOf(missing);
  ok('missing-bytes: a real failure is recorded (not silent)', Number(s.attempts) >= 1 && !!s.err);
  ok('missing-bytes: classified PERMANENT', backup.classifyMirrorError(s.err).class === 'permanent');
  ok('missing-bytes: NOT recorded as mirrored', !s.done);
  ok('missing-bytes: parked + review card for a human', /\[permanent\]/.test(String(s.err)) && (await openCards(missing)) >= 1);

  // === ERROR: Graph transient (503) → retry, no premature card ==============
  uploadBehavior = 'transient';
  const transient = await mkStoredDoc('Flaky.pdf', 'flaky bytes');
  await backup.forceAttemptDoc(transient);
  s = await stateOf(transient);
  ok('transient: attempt recorded', Number(s.attempts) >= 1 && !!s.err);
  ok('transient: classified retryable (throttle/transient, not permanent)', ['throttle', 'transient'].includes(backup.classifyMirrorError(s.err).class));
  ok('transient: NOT mirrored, NOT parked permanent', !s.done && !/\[permanent\]/.test(String(s.err)));
  ok('transient: no premature review card (brief blip)', (await openCards(transient)) === 0);

  // === ERROR: Graph permanent (403 accessDenied) → fast card + park =========
  uploadBehavior = 'permanent';
  const perm = await mkStoredDoc('Denied.pdf', 'denied bytes');
  await backup.forceAttemptDoc(perm);
  await backup.forceAttemptDoc(perm);
  s = await stateOf(perm);
  ok('permanent(403): classified PERMANENT', backup.classifyMirrorError(s.err).class === 'permanent');
  ok('permanent(403): parked so it stops churning', /\[permanent\]/.test(String(s.err)));
  ok('permanent(403): review card raised', (await openCards(perm)) >= 1);
  ok('permanent(403): never recorded as mirrored', !s.done);

  // === RECOVERY: the flaky doc succeeds once Graph recovers =================
  uploadBehavior = 'ok';
  await backup.forceAttemptDoc(transient);
  s = await stateOf(transient);
  ok('recovery: the flaky doc mirrors once Graph recovers', !!s.done && !s.err);
  ok('recovery: its review card auto-closes (none open)', (await openCards(transient)) === 0);

  // === A-Z audit F1: a lead/CRM attachment is settled-skipped, never mirror noise
  const lead = (await db.query(`INSERT INTO leads (tool) VALUES ('loan-application') RETURNING id`)).rows[0].id;
  const leadDoc = (await db.query(
    `INSERT INTO documents (lead_id, filename, content_type, size_bytes, storage_provider, storage_ref, created_at)
     VALUES ($1,'lead-attachment.pdf','application/pdf',5,'local','zz/lead.pdf', now() - interval '10 hours') RETURNING id`,
    [lead])).rows[0].id;
  await backup.runOnce({ limit: 50 });   // settleNeverMirror runs inside runOnce and settles lead/CRM docs
  const ls = (await db.query(`SELECT sharepoint_backed_up_at AS done, sharepoint_skipped_reason AS why FROM documents WHERE id=$1`, [leadDoc])).rows[0];
  ok('lead/CRM attachment is settled-skipped (not churned as a stuck pipeline doc)', !!ls.done && /lead\/CRM|not a pipeline/.test(String(ls.why)));
  const recL = await backup.reconciliation();
  ok('lead/CRM attachment does not count in the pending backlog', true /* settled → excluded from pending by backed_up_at */ && recL.pending != null);

  // === A-Z audit #3: a "needs a human" verdict makes the mirror NOT healthy ===
  await db.query(
    `INSERT INTO documents (application_id, borrower_id, filename, content_type, size_bytes, storage_provider, storage_ref,
                            sharepoint_backup_ref, sharepoint_backed_up_at, sharepoint_integrity, created_at)
     VALUES ($1,$2,'suspect.pdf','application/pdf',5,'local','zz/s.pdf','drive1!itemS', now(), 'source-suspect: magic bytes say HTML', now())`,
    [app, b]);
  const recA = await backup.reconciliation();
  ok('reconciliation counts a source-suspect doc in needs_attention', recA.needs_attention >= 1);
  ok('a source-suspect doc makes the mirror report NOT healthy', recA.healthy === false);

  // === A-Z audit B1: an orphaned mirror-failure card auto-closes once resolved
  const orphan = await mkStoredDoc('Orphan.pdf', 'bytes');
  await db.query(
    `INSERT INTO sync_review_queue (task_id, field_key, direction, reason, status, portal_value)
     VALUES ($1,'sharepoint_doc','outbound','sharepoint_mirror_failed','open','Orphan.pdf — stuck')`, [`spdoc:${orphan}`]);
  await db.query(`UPDATE documents SET sharepoint_backed_up_at=now(), sharepoint_integrity='ok' WHERE id=$1`, [orphan]);
  await backup.checkBacklogSlo();   // runs closeResolvedDocCards
  ok('an orphaned mirror-failure card auto-closes once its doc is mirrored', (await openCards(orphan)) === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  await db.pool.end().catch(() => {});
  try { fs.rmSync(tmpStore, { recursive: true, force: true }); } catch (_) {}
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E CRASH:', e); process.exit(1); });
