/**
 * APPRAISAL PHOTOS ARE NOT MIRRORED TO SHAREPOINT — real Postgres, real mirror
 * code, a stubbed Graph.
 *
 * Owner-directed 2026-08-12 (REVERSES the 2026-08-09 decision to mirror them).
 * The owner now wants ONLY the appraisal PDF and the appraisal XML in SharePoint
 * (and in the TPR export); the individual photos stay in PILOT + the regular
 * off-site backup and never reach the team site or investor delivery. So
 * appraisal_photo is a never-mirror KIND again.
 *
 * What is proven here (each a SQL predicate over the real `documents` table or
 * the outcome of the real drain running against a real row):
 *   · appraisal_photo is EXCLUDED from the drain (never-mirror), Heter Iska too
 *   · a NEW photo is NOT copied to SharePoint by the normal drain
 *   · the appraisal REPORT (appraisal_pdf) STILL mirrors, into "Appraisal"
 *   · the back-fill is a no-op (there is nothing to copy)
 *   · nothing is deleted — a photo's bytes stay in PILOT
 *   · the scoreboard still recognises the photo skip reason (no row → "other")
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-appraisal-photo-mirror-db (no DATABASE_URL)'); process.exit(0); }

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-photo-store-'));
process.env.STORAGE_DIR = tmpStore;
process.env.SHAREPOINT_BACKUP_ENABLED = '1';
process.env.MS_TENANT_ID = 't'; process.env.MS_CLIENT_ID = 'c'; process.env.MS_CLIENT_SECRET = 's';
process.env.SHAREPOINT_STAMP_METADATA = '0';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const storage = require('../src/lib/storage');
const map = require('../src/lib/sharepoint-map');
const sp = require('../src/lib/sharepoint');
const backup = require('../src/lib/sharepoint-backup');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };

/* ── a tiny in-memory SharePoint, so a FOLDER PATH is observable ───────────── */
const folders = new Map();
const items = new Map();
let seq = 0;
const mkFolder = (name, parent) => {
  for (const f of folders.values()) if (f.parent === parent && f.name === name) return f;
  const id = `f${++seq}`; const f = { id, name, parent }; folders.set(id, f); return f;
};
const pathOf = (id) => {
  const out = []; let cur = folders.get(id);
  while (cur && cur.id !== 'sync1') { out.unshift(cur.name); cur = cur.parent ? folders.get(cur.parent) : null; }
  return out.join('/');
};
folders.set('sync1', { id: 'sync1', name: 'Synced by Pilot', parent: null });

map.resolveSyncFolder = async () => ({ driveId: 'd', syncFolderId: 'sync1', fullPath: 'Pipeline/O/B/Addr/Synced by Pilot' });
map.resolveConditionFolder = async (driveId, syncId, categoryPath) => {
  let cur = folders.get(syncId);
  for (const seg of (categoryPath || [])) cur = mkFolder(seg, cur.id);
  return cur;
};
map.invalidateScope = async () => {};

sp.ensureChildFolder = async (driveId, parentId, name) => mkFolder(name, parentId);
sp.uploadNew = async (driveId, parentId, name, bytes) => {
  const id = `item${++seq}`;
  items.set(id, { id, name, parent: parentId });
  return { item: { id, webUrl: `https://sp.test/${id}`, size: (bytes && bytes.length) || 10 }, conflict: false };
};
sp.itemMetaByName = async () => null;
sp.remove = async () => { throw new Error('remove is a no-op'); };
sp.probe = async () => ({ ok: true });
sp.deleteEnabled = () => false;
sp.credentialHealth = () => null;
sp.isOfficeFormat = () => false;

const TAG = `photo-${Date.now()}`;
let appId, borrowerId;

async function mkPhoto(name, cols = {}) {
  const saved = await storage.save(Buffer.from(`bytes-${name}`), { filename: name });
  const set = Object.assign({
    application_id: appId, borrower_id: borrowerId, doc_kind: 'appraisal_photo',
    content_type: 'image/jpeg', storage_provider: saved.provider, storage_ref: saved.ref,
    review_status: 'accepted', source_type: 'system', is_current: true,
    // The drain deliberately ignores a document for a few seconds after upload.
    created_at: new Date(Date.now() - 10 * 60 * 1000),
  }, cols);
  const keys = Object.keys(set);
  const { rows } = await db.query(
    `INSERT INTO documents (filename, ${keys.join(',')})
     VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING id`,
    [`${TAG}-${name}`, ...keys.map((k) => set[k])]);
  return rows[0].id;
}
const docRow = async (id) => (await db.query(
  `SELECT sharepoint_backup_ref, sharepoint_backed_up_at, sharepoint_skipped_reason,
          sharepoint_web_url, sharepoint_parent_id FROM documents WHERE id=$1`, [id])).rows[0];

(async () => {
  await ensureSchema();

  borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Photo','Test',$1) RETURNING id`,
    [`${TAG}@test.local`])).rows[0].id;
  appId = (await db.query(
    `INSERT INTO applications (borrower_id,status) VALUES ($1,'underwriting') RETURNING id`,
    [borrowerId])).rows[0].id;

  const PHOTO_REASON = backup._scoreboardSql.reasons.appraisalPhotoLegacy;

  // ── 1. the never-mirror rule ──────────────────────────────────────────────
  assert(backup.NEVER_MIRROR_SQL.includes("'appraisal_photo'"),
    'appraisal_photo is EXCLUDED from the drain (never-mirror again)');
  assert(backup.NEVER_MIRROR_SQL.includes("'heter_iska_signed'"),
    'the Heter Iska is STILL never mirrored');
  assert(backup.categoryFor({ doc_kind: 'appraisal_pdf' }) === 'Appraisal',
    'the appraisal REPORT still files into "Appraisal"');

  // ── 2. a NEW photo is NOT copied to SharePoint ────────────────────────────
  const fresh = await mkPhoto('appraisal-photo-1.jpg');
  await backup.runOnce({ limit: 50 });
  const f = await docRow(fresh);
  assert(!f.sharepoint_backup_ref, 'a new appraisal photo is NOT mirrored');

  // ── 3. the appraisal PDF STILL mirrors ────────────────────────────────────
  const report = await mkPhoto('appraisal-report.pdf', { doc_kind: 'appraisal_pdf', content_type: 'application/pdf' });
  await backup.runOnce({ limit: 50 });
  const rp = await docRow(report);
  assert(!!rp.sharepoint_backup_ref, 'the appraisal PDF is still copied to SharePoint');
  const reportPath = rp.sharepoint_parent_id ? pathOf(rp.sharepoint_parent_id) : '';
  assert(/Appraisal$/.test(reportPath) && !/Appraisal photos/.test(reportPath),
    `the report lands in "Appraisal" (got "${reportPath}")`);

  // ── 4. the back-fill is a no-op ───────────────────────────────────────────
  const res = await backup.backfillAppraisalPhotoMirrorOnce();
  assert(res.mirrored === 0 && res.skipped != null,
    `the photo back-fill is a no-op now (${JSON.stringify(res)})`);

  // ── 5. nothing is deleted — bytes stay in PILOT ───────────────────────────
  const bytes = (await db.query(`SELECT storage_ref FROM documents WHERE id=$1`, [fresh])).rows[0];
  assert(!!bytes.storage_ref, 'the photo bytes are still in PILOT (nothing deleted)');

  // ── 6. the scoreboard still recognises the photo skip reason ──────────────
  // A settled, skip-stamped photo (the state settleNeverMirror leaves) must group
  // under "appraisal_photos", never fall into the amber "other" bucket.
  await mkPhoto('appraisal-photo-skipped.jpg',
    { sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: PHOTO_REASON });
  const recon = await backup.reconciliation();
  assert(Number(recon.skip_other || 0) === 0,
    'the photo skip reason is recognised — nothing falls into "other"');
  const photoLine = (recon.skipped_breakdown || []).find((b) => b.key === 'appraisal_photos');
  assert(!!photoLine, 'the scoreboard has an appraisal_photos line');

  // ── 7. the Heter Iska is untouched ────────────────────────────────────────
  const iska = await mkPhoto('heter.pdf', { doc_kind: 'heter_iska_signed', content_type: 'application/pdf' });
  await backup.runOnce({ limit: 50 });
  const ik = await docRow(iska);
  assert(!ik.sharepoint_backup_ref, 'the signed Heter Iska is still never copied');

  await db.query(`DELETE FROM documents WHERE filename LIKE $1`, [`${TAG}-%`]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  fs.rmSync(tmpStore, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll appraisal-photo (not-mirrored) assertions passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
