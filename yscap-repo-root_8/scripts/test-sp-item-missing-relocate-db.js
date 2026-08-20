'use strict';
/* DB integration test — the SharePoint integrity audit must LOOK for a mirror copy
 * before it declares it deleted, and must not exile the verdict for 30 days.
 *
 * Root cause it guards (owner-reported 2026-08-20: a signed assignment on file
 * YSCAP258134738 reported "its mirror copy is no longer in SharePoint"): the mirror
 * held ONE handle on its SharePoint copy — the driveItem id in
 * documents.sharepoint_backup_ref — and treated a single Graph 404 on it as proof
 * the copy was gone. That id survives a rename and an in-drive move; it does NOT
 * survive a delete-then-restore, a re-upload, or a drag through an Explorer/
 * OneDrive-synced folder. Every mirrored item already carries a PilotDocumentId
 * stamp written "so the link survives ANY human rename/move" — and nothing ever
 * read it back. A false "item-missing" then PARKS the document forever: nothing
 * re-mirrors a row whose sharepoint_backed_up_at is set, and the 30-day stamp kept
 * a copy restored an hour later reported missing for a month.
 *
 * Requires a throwaway Postgres in DATABASE_URL. No network (every Graph call is
 * stubbed). Run: DATABASE_URL=... node scripts/test-sp-item-missing-relocate-db.js
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sp-item-missing-relocate-db (no DATABASE_URL)'); process.exit(0); }

process.env.SHAREPOINT_BACKUP_ENABLED = process.env.SHAREPOINT_BACKUP_ENABLED || '1';
process.env.MS_TENANT_ID = process.env.MS_TENANT_ID || 't';
process.env.MS_CLIENT_ID = process.env.MS_CLIENT_ID || 'pilot-app-id';
process.env.MS_CLIENT_SECRET = process.env.MS_CLIENT_SECRET || 's';

const db = require('../src/db');
const { ensureSchema } = require('../src/migrate-boot');
const backup = require('../src/lib/sharepoint-backup');
const sp = require('../src/lib/sharepoint');
const storage = require('../src/lib/storage');

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) pass++; else { fail++; console.log(`FAIL ${name}`); } };

// The document's real bytes. A genuine PDF header — otherwise the source-corruption
// sniffer fires and we'd be measuring the wrong verdict.
const BYTES = Buffer.from(`%PDF-1.4\n% Assignment — 734 Dennis Pl\n%%EOF\n`, 'latin1');
const QX = sp.quickXorHash(BYTES);
const HEALTHY = { ok: true, base: '/x', configured: '/x', persistent: true };

const DRIVE = 'drive1';
const DEAD_ITEM = 'item-that-no-longer-resolves';
const OLD_PARENT = 'parent-folder-1';
const WEB_URL = 'https://ys.sharepoint.com/sites/Pipeline/Shared%20Documents/Assignment%20v2%20JM%20CLEAN%20-%20signed.pdf';

// A driveItem as Graph reports it. `appId` drives createdBy.application.id, which is
// what sp.createdByThisApp() tests — the guard that stops us adopting a human's file.
const item = (id, { appId = process.env.MS_CLIENT_ID, parentId = OLD_PARENT, size = BYTES.length, qx = QX } = {}) => ({
  id, name: 'Assignment v2 JM CLEAN - signed.pdf', size,
  file: { hashes: { quickXorHash: qx } },
  parentReference: { id: parentId },
  webUrl: `https://ys.sharepoint.com/sites/Pipeline/Shared%20Documents/${id}.pdf`,
  eTag: '"1"', createdBy: { application: { id: appId } },
  lastModifiedDateTime: '2026-01-01T00:00:00Z',
});

// Stub the three Graph reads verifyRow + relocateMirror make. Nothing here touches
// the network; each case supplies exactly what SharePoint would answer.
const real = { itemMeta: sp.itemMeta, itemMetaByName: sp.itemMetaByName, findByPilotDocumentId: sp.findByPilotDocumentId };
const notFound = () => { const e = new Error('itemNotFound'); e.status = 404; e.graphCode = 'itemNotFound'; throw e; };
function stubGraph({ byId = {}, byName = null, byStamp = null }) {
  sp.itemMeta = async (_d, id) => (byId[id] ? byId[id] : notFound());
  sp.itemMetaByName = async () => (byName ? byName : notFound());
  sp.findByPilotDocumentId = async () => byStamp;
}
function restoreGraph() { Object.assign(sp, real); }

(async () => {
  await ensureSchema();

  const email = 'spreloc@example.test';
  const prior = (await db.query(`SELECT id FROM borrowers WHERE email=$1`, [email])).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(`DELETE FROM sync_review_queue WHERE task_id IN (SELECT 'spdoc:'||d.id FROM documents d WHERE d.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM audit_log WHERE entity_type='document' AND entity_id IN (SELECT d.id FROM documents d WHERE d.borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }
  const b = (await db.query(`INSERT INTO borrowers (first_name,last_name,email) VALUES ('Asher','Salamon',$1) RETURNING id`, [email])).rows[0].id;
  const app = (await db.query(`INSERT INTO applications (borrower_id) VALUES ($1) RETURNING id`, [b])).rows[0].id;

  // The source bytes always read fine — this test is about the REMOTE side.
  const realRead = storage._local.read, realProbe = storage._local.probe;
  storage._local.read = async () => BYTES;
  storage._local.probe = () => HEALTHY;

  // A mirrored doc due for verification, pointing at an id that no longer resolves.
  const mkMirrored = async () => (await db.query(
    `INSERT INTO documents (filename, content_type, doc_kind, storage_provider, storage_ref, size_bytes,
        application_id, borrower_id, is_current, sharepoint_backup_ref, sharepoint_parent_id,
        sharepoint_web_url, sharepoint_backed_up_at, sharepoint_verified_at)
     VALUES ('Assignment_Asher_Salamon_734_Dennis_Pl v2 JM CLEAN - signed.pdf','application/pdf','closing',
        'local','ab/assignment.pdf',$3,$1,$2,true,$4,$5,$6, now() - interval '40 days', NULL)
     RETURNING id`, [app, b, BYTES.length, `sp:${DRIVE}:${DEAD_ITEM}`, OLD_PARENT, WEB_URL])).rows[0].id;

  const docOf = async (id) => (await db.query(
    `SELECT sharepoint_integrity AS i, sharepoint_verified_at AS v, sharepoint_backup_ref AS ref,
            sharepoint_parent_id AS parent, sharepoint_backed_up_at AS done
       FROM documents WHERE id=$1`, [id])).rows[0];
  const cardCount = async (id) => (await db.query(
    `SELECT count(*)::int AS n FROM sync_review_queue WHERE task_id=$1`, [`spdoc:${id}`])).rows[0].n;
  const relocatedLogs = async (id) => (await db.query(
    `SELECT count(*)::int AS n FROM audit_log WHERE entity_id=$1::uuid AND action='sharepoint_mirror_relocated'`, [id])).rows[0].n;

  // === CASE A: the copy is back in its own folder with a NEW id ===============
  // A restore from the recycle bin / a re-upload. Graph's createdBy says it is
  // ours, so the audit must re-point and verify — never card it as deleted.
  const docA = await mkMirrored();
  stubGraph({ byName: item('restored-item-id', { parentId: 'parent-folder-2' }) });
  await backup.verifyOnce({ limit: 100 });
  restoreGraph();
  const a = await docOf(docA);
  ok('A: a copy found in its own folder is re-pointed, not declared missing', a.i === 'ok');
  ok('A: the ref now names the item that actually exists', a.ref === `sp:${DRIVE}:restored-item-id`);
  ok('A: the recorded parent folder follows the copy', a.parent === 'parent-folder-2');
  ok('A: no loan-officer card for a copy that was found again', (await cardCount(docA)) === 0);
  ok('A: the relocation is audit-logged', (await relocatedLogs(docA)) === 1);

  // === CASE B: only the PilotDocumentId stamp finds it =======================
  // The copy moved to another folder and came back with a new id, so name+folder
  // misses. The identity stamp PILOT writes on every upload is what finds it —
  // the read that never existed before this fix.
  const docB = await mkMirrored();
  stubGraph({ byStamp: item('stamped-item-id', { parentId: 'parent-folder-3' }) });
  await backup.verifyOnce({ limit: 100 });
  restoreGraph();
  const bRow = await docOf(docB);
  ok('B: the PilotDocumentId stamp re-finds a copy that name+folder cannot', bRow.i === 'ok');
  ok('B: the ref is re-pointed at the stamped item', bRow.ref === `sp:${DRIVE}:stamped-item-id`);
  ok('B: no card when the stamp found it', (await cardCount(docB)) === 0);

  // === CASE C: a HUMAN's same-named file must never be adopted ===============
  // Same folder, same name, but Graph says a person created it. Provenance fails,
  // the stamp finds nothing → the honest "missing" verdict, as before.
  const docC = await mkMirrored();
  stubGraph({ byName: item('a-humans-own-file', { appId: 'some-other-app' }), byStamp: null });
  await backup.verifyOnce({ limit: 100 });
  restoreGraph();
  const c = await docOf(docC);
  ok('C: a same-named file a PERSON created is never claimed as our mirror copy', c.i === 'item-missing');
  ok('C: the ref is left pointing at our own (dead) item, not at their file', c.ref === `sp:${DRIVE}:${DEAD_ITEM}`);
  ok('C: the loan officer IS carded when the copy is genuinely unfindable', (await cardCount(docC)) === 1);

  // === CASE D: genuinely gone → item-missing, and it STAYS in the rotation ====
  // The 30-day stamp meant a copy restored an hour later stayed "missing" for a
  // month with the officer's card open (only a good verdict closes it, and only
  // this pass writes one). Backdated = re-checked on the next rotation.
  const docD = await mkMirrored();
  stubGraph({});                       // every probe 404s / finds nothing
  await backup.verifyOnce({ limit: 100 });
  restoreGraph();
  const d = await docOf(docD);
  ok('D: nothing found anywhere → item-missing', d.i === 'item-missing');
  ok('D: the verdict is NOT stamped "checked just now" — it is backdated into the rotation',
    d.v != null && (Date.now() - new Date(d.v).getTime()) > 5 * 24 * 3600 * 1000);
  ok('D: it is not re-read on this pass (backdated to one day short of the window, not zero)',
    !(await backup.verifyBatch(500)).some((r) => r.id === docD));

  // === CASE E: the copy comes back → the verdict and the card clear themselves =
  // One day on. Before this fix the stamp was now(), so the row sat outside the
  // 30-day window and a copy a person restored an hour later stayed "missing" for
  // a month with the officer's card open. Backdated, it re-enters the selection
  // the next day — assert that, then verify it against the restored copy.
  // The CONTROL first: what the old code stamped (now()) is still nowhere near
  // eligible a day later — so it is the backdating, not the passing day, that
  // brings the row back. Then the real thing.
  await db.query(`UPDATE documents SET sharepoint_verified_at = now() - interval '1 day' WHERE id=$1`, [docD]);
  ok('E: control — a "checked just now" stamp is still out of the rotation a day later',
    !(await backup.verifyBatch(500)).some((r) => r.id === docD));
  await db.query(
    `UPDATE documents SET sharepoint_verified_at = now() - make_interval(days => $2) WHERE id=$1`,
    [docD, backup.VERIFY_RECHECK_DAYS]);
  ok('E: a day later the item-missing row is back in the audit selection',
    (await backup.verifyBatch(500)).some((r) => r.id === docD));
  stubGraph({ byId: { [DEAD_ITEM]: item(DEAD_ITEM) } });
  await backup.verifyOnce({ limit: 100 });
  restoreGraph();
  const e = await docOf(docD);
  ok('E: a restored copy verifies clean on the very next rotation', e.i === 'ok');
  const rowE = (await db.query(
    `SELECT * FROM sync_review_queue WHERE task_id=$1 AND status='open'`, [`spdoc:${docD}`])).rows[0];
  if (rowE) await require('../src/lib/sync-review-recheck').recheckReview(rowE);
  ok('E: the loan officer’s card auto-closes once the copy verifies clean',
    (await db.query(`SELECT count(*)::int n FROM sync_review_queue WHERE task_id=$1 AND status='open'`,
      [`spdoc:${docD}`])).rows[0].n === 0);

  // === CASE F: the pure name recovery ========================================
  ok('F: the mirrored name is recovered from the recorded webUrl (percent-decoded)',
    backup.mirrorNameFromWebUrl(WEB_URL) === 'Assignment v2 JM CLEAN - signed.pdf');
  ok('F: a query string / fragment never leaks into the name',
    backup.mirrorNameFromWebUrl(`${WEB_URL}?web=1#x`) === 'Assignment v2 JM CLEAN - signed.pdf');
  ok('F: a viewer .aspx URL yields no name to probe (skips the hopeless lookup)',
    backup.mirrorNameFromWebUrl('https://ys.sharepoint.com/_layouts/15/Doc.aspx?sourcedoc=%7Bguid%7D') === null);
  ok('F: no webUrl → no name', backup.mirrorNameFromWebUrl(null) === null);

  storage._local.read = realRead; storage._local.probe = realProbe;
  console.log(`\n${pass} passed, ${fail} failed`);
  await db.end?.();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
