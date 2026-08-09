/**
 * APPRAISAL PHOTOS REACH SHAREPOINT, IN THEIR OWN FOLDER — real Postgres, real
 * mirror code, a stubbed Graph.
 *
 * Owner-directed 2026-08-09. Shown the full list of what the document mirror
 * deliberately skips and asked which of it to change, the owner picked the
 * appraisal photos — "in their own subfolder". They had been excluded because
 * ~24 images per file would flood the category folder sitting next to the real
 * loan documents; a dedicated folder answers that without costing the pictures.
 *
 * What is proven here, none of which a pure test can reach (every one of these
 * is either a SQL predicate over the real `documents` table or the outcome of
 * the real folder-resolution code running against a real row):
 *
 *   · a NEW photo mirrors through the ordinary drain, into
 *     "Appraisal/Appraisal photos" — beside the report, not mixed in with it
 *   · the appraisal REPORT still lands in "Appraisal" itself
 *   · photos and the report are two VERSION STREAMS, so a re-import superseding
 *     24 photos cannot bump the report's Version-N counter
 *   · the back-fill copies the photos ALREADY on file — the whole back
 *     catalogue, which the policy change alone would never have reached
 *   · a SUPERSEDED set is retired, never copied (two contradictory photo sets of
 *     one property must not both be in the team site) and nothing is deleted
 *   · THE ALARM RULE: the back-fill never moves pending / oldest-pending /
 *     stuck. Un-settling months-old rows would breach the backlog SLO and email
 *     every admin over a deliberate policy change — so a FAILED copy must leave
 *     the row exactly as settled as it found it
 *   · the Heter Iska is STILL never mirrored — the one kind that did not change
 *   · the scoreboard still recognises both photo reasons (legacy + superseded),
 *     so no row falls into "other"
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

/* ── a tiny in-memory SharePoint, so a FOLDER PATH is observable ─────────────
   The sync LEAF is stubbed (the test is about what happens inside it), but the
   category path underneath is walked for real from `categoryPathFor` — that is
   the code under test, so it must not be stubbed away. */
const folders = new Map();        // id -> {id,name,parent}
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
// Walk the REAL category path so the folder tree reflects categoryPathFor.
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
    // The drain deliberately ignores a document for a few seconds after upload
    // (the settle window that collapses an editing burst into one mirrored
    // copy), so a fixture created microseconds ago would never be claimed.
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

  // A real borrower + application, so scopeKeyFor resolves the way it does live.
  borrowerId = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Photo','Test',$1) RETURNING id`,
    [`${TAG}@test.local`])).rows[0].id;
  appId = (await db.query(
    `INSERT INTO applications (borrower_id,status) VALUES ($1,'underwriting') RETURNING id`,
    [borrowerId])).rows[0].id;

  // ── 1. the folder rule, before anything is uploaded ───────────────────────
  assert(backup.categoryFor({ doc_kind: 'appraisal_photo' }) === 'Appraisal/Appraisal photos',
    'a photo files into "Appraisal/Appraisal photos"');
  assert(backup.categoryFor({ doc_kind: 'appraisal_pdf' }) === 'Appraisal',
    'the appraisal REPORT still files into "Appraisal" itself');
  assert(!backup.NEVER_MIRROR_SQL.includes('appraisal_photo'),
    'appraisal_photo is no longer excluded from the drain');
  assert(backup.NEVER_MIRROR_SQL.includes('heter_iska_signed'),
    'the Heter Iska is STILL never mirrored — the one kind that did not change');

  // ── 2. a NEW photo mirrors through the ordinary drain ─────────────────────
  const fresh = await mkPhoto('appraisal-photo-1.jpg');
  await backup.runOnce({ limit: 50 });
  const f = await docRow(fresh);
  assert(!!f.sharepoint_backup_ref, 'a new photo is copied to SharePoint by the normal drain');
  assert(f.sharepoint_skipped_reason == null, 'and carries no skip reason once copied');
  const freshPath = f.sharepoint_parent_id ? pathOf(f.sharepoint_parent_id) : '';
  assert(/Appraisal\/Appraisal photos$/.test(freshPath),
    `it lands in the photos folder (got "${freshPath}")`);

  // The report itself must land in the PARENT folder, so the two sit side by side.
  const report = await mkPhoto('appraisal-report.pdf', { doc_kind: 'appraisal_pdf', content_type: 'application/pdf' });
  await backup.runOnce({ limit: 50 });
  const rp = await docRow(report);
  const reportPath = rp.sharepoint_parent_id ? pathOf(rp.sharepoint_parent_id) : '';
  assert(/Appraisal$/.test(reportPath) && !/Appraisal photos/.test(reportPath),
    `the report sits in the parent folder, beside the photos (got "${reportPath}")`);
  assert(rp.sharepoint_parent_id !== f.sharepoint_parent_id,
    'photos and report are genuinely two different folders');

  // ── 3. two folders MUST mean two version streams ──────────────────────────
  const scope = backup.scopeKeyFor({ app_id: appId });
  assert(backup.stateKeyFor({ doc_kind: 'appraisal_photo' }, scope)
      !== backup.stateKeyFor({ doc_kind: 'appraisal_pdf' }, scope),
    'a re-import superseding 24 photos cannot bump the REPORT\'s Version-N counter');

  // ── 4. the back-fill reaches the photos already on file ───────────────────
  // Exactly the state every pre-2026-08-09 photo is in: settled, skip-stamped.
  const LEGACY = backup._scoreboardSql.reasons.appraisalPhotoLegacy;
  const old1 = await mkPhoto('appraisal-photo-old-1.jpg',
    { sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: LEGACY });
  const old2 = await mkPhoto('appraisal-photo-old-2.jpg',
    { sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: LEGACY });
  // ...and a SUPERSEDED set, which must be retired rather than copied.
  const stale = await mkPhoto('appraisal-photo-stale.jpg',
    { is_current: false, sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: LEGACY });

  const before = await backup.reconciliation();
  const res = await backup.backfillAppraisalPhotoMirrorOnce();
  assert(res.mirrored >= 2, `the back-fill copies the photos already on file (mirrored ${res.mirrored})`);

  const o1 = await docRow(old1), o2 = await docRow(old2);
  assert(!!o1.sharepoint_backup_ref && !!o2.sharepoint_backup_ref,
    'every current back-catalogue photo is now in SharePoint');
  assert(o1.sharepoint_skipped_reason == null,
    'and its "not mirrored" reason is cleared — it is no longer a skipped document');
  assert(/Appraisal\/Appraisal photos$/.test(pathOf(o1.sharepoint_parent_id)),
    'a back-filled photo lands in the same photos folder as a new one');

  const st = await docRow(stale);
  assert(!st.sharepoint_backup_ref, 'a SUPERSEDED photo set is NOT copied');
  assert(st.sharepoint_skipped_reason === backup._scoreboardSql.reasons.appraisalPhotoSuperseded,
    'it is retired with a reason that says a newer import replaced it');
  const staleBytes = (await db.query(`SELECT storage_ref FROM documents WHERE id=$1`, [stale])).rows[0];
  assert(!!staleBytes.storage_ref, 'and nothing is deleted — its copy is still in PILOT');

  // ── 5. THE ALARM RULE ─────────────────────────────────────────────────────
  const after = await backup.reconciliation();
  assert(after.pending === before.pending && after.exhausted === before.exhausted,
    `the back-fill moves neither "waiting" nor "stuck" (${before.pending}/${before.exhausted} → ${after.pending}/${after.exhausted})`);
  assert(String(after.oldest_pending_hours) === String(before.oldest_pending_hours),
    'and never ages the backlog — a policy change must not fire the SLO alarm');

  // A FAILED copy must leave the row exactly as settled as it found it, or the
  // next reconciliation would report a months-old backlog that nobody caused.
  const upload = sp.uploadNew;
  sp.uploadNew = async () => { const e = new Error('graph exploded'); e.status = 500; throw e; };
  const doomed = await mkPhoto('appraisal-photo-doomed.jpg',
    { sharepoint_backed_up_at: new Date(), sharepoint_skipped_reason: LEGACY });
  const failRes = await backup.backfillAppraisalPhotoMirrorOnce();
  sp.uploadNew = upload;
  const dm = await docRow(doomed);
  assert(failRes.failed >= 1, 'a failed copy is counted, not swallowed');
  assert(dm.sharepoint_backed_up_at != null && dm.sharepoint_skipped_reason != null,
    'a FAILED copy leaves the row settled — it never re-enters the pending population');
  const afterFail = await backup.reconciliation();
  assert(afterFail.pending === before.pending,
    'so even a total Graph outage during the back-fill cannot breach the backlog SLO');

  // ── 6. the scoreboard still recognises every photo reason ─────────────────
  const recon = await backup.reconciliation();
  assert(Number(recon.skip_other || 0) === 0,
    'neither photo reason falls into "other" — the scoreboard still names them all');
  const photoLine = (recon.skipped_breakdown || []).find((b) => b.key === 'appraisal_photos');
  assert(!photoLine || /older, replaced appraisal/.test(photoLine.label),
    'and the photo line now describes what is actually left: older, replaced sets');

  // ── 7. the Heter Iska is untouched by all of this ─────────────────────────
  const iska = await mkPhoto('heter.pdf', { doc_kind: 'heter_iska_signed', content_type: 'application/pdf' });
  await backup.runOnce({ limit: 50 });
  const ik = await docRow(iska);
  assert(!ik.sharepoint_backup_ref && ik.sharepoint_skipped_reason != null,
    'the signed Heter Iska is still never copied — that policy did not change');

  await db.query(`DELETE FROM documents WHERE filename LIKE $1`, [`${TAG}-%`]);
  await db.query(`DELETE FROM applications WHERE id=$1`, [appId]);
  await db.query(`DELETE FROM borrowers WHERE id=$1`, [borrowerId]);
  fs.rmSync(tmpStore, { recursive: true, force: true });
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nAll appraisal-photo mirror assertions passed.');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
