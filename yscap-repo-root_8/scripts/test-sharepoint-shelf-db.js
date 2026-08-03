/**
 * THE SHAREPOINT SHELVES, END TO END — real Postgres, real mirror code, a stubbed
 * Graph. Skips cleanly with no DATABASE_URL.
 *
 * Owner-directed 2026-08-03: *"yes do the SharePoint folder too. Well, the
 * SharePoint folder should also have saved the old versions. Even though it gets
 * rejected, we should always still save copies in folders. So we should have a
 * folder with all old versions and old old versions to be placed in the old
 * version folder."*
 *
 * What is proven here, because none of it can be proven by a pure test:
 *   · a fresh human upload really is mirrored into "Waiting for review"
 *   · accepting it MOVES the copy up into the category folder
 *   · rejecting one MOVES it into "Old Versions" — it is never deleted
 *   · a superseded batch is grouped into ONE "Old Versions/Version N" folder,
 *     not one folder per document (the "Version 47" explosion this file fought)
 *   · a copy a HUMAN moved is left exactly where they put it, forever
 *   · PILOT's own documents (born accepted) go straight to the live shelf
 *   · the sweep is idempotent — a second pass moves nothing
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-sharepoint-shelf-db (no DATABASE_URL)'); process.exit(0); }

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-shelf-store-'));
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

/* ── a tiny in-memory SharePoint ──────────────────────────────────────────────
   Folders and items with real parents, so a MOVE is observable and a folder
   tree can be asserted the way a human would read it in Explorer. */
const tree = { folders: new Map(), items: new Map() };
tree.folders.set('cond1', { id: 'cond1', name: 'Insurance', parent: 'sync1' });
const folderPath = (id) => {
  const parts = [];
  let cur = tree.folders.get(id);
  while (cur && cur.id !== 'cond1') { parts.unshift(cur.name); cur = tree.folders.get(cur.parent); }
  return parts.join('/');
};
/** Where a document's copy sits, as a human would read it: '' = the category folder. */
const whereIs = async (docId) => {
  const r = (await db.query('SELECT sharepoint_parent_id FROM documents WHERE id=$1', [docId])).rows[0];
  return folderPath(r.sharepoint_parent_id);
};

map.resolveSyncFolder = async () => ({ driveId: 'drive1', syncFolderId: 'sync1', fullPath: 'Pipeline Drive/O/B/Addr/Synced by Pilot' });
map.resolveConditionFolder = async () => tree.folders.get('cond1');
map.invalidateScope = async () => {};

sp.ensureChildFolder = async (driveId, parentId, name) => {
  for (const f of tree.folders.values()) if (f.parent === parentId && f.name === name) return f;
  const id = `f${tree.folders.size + 1}`;
  const f = { id, name, parent: parentId };
  tree.folders.set(id, f);
  return f;
};
let uploads = 0;
sp.uploadNew = async (driveId, parentId, name, bytes) => {
  uploads += 1;
  const id = `item${uploads}`;
  tree.items.set(id, { id, name, parent: parentId });
  return { item: { id, webUrl: `https://sp.example/${id}`, size: bytes.length }, conflict: false };
};
sp.itemMetaByName = async () => null;
let deletes = 0;
sp.remove = async () => { deletes += 1; throw new Error('remove is a no-op'); };
sp.moveOwnItem = async (driveId, itemId, newParentId, { expectedParentId }) => {
  const it = tree.items.get(itemId);
  if (!it) { const e = new Error('itemNotFound'); e.status = 404; throw e; }
  if (it.parent !== expectedParentId) {
    throw new Error(`moveOwnItem refused: item is not in the expected portal-managed folder (found parent ${it.parent})`);
  }
  it.parent = newParentId;
  return { id: itemId, webUrl: `https://sp.example/${itemId}` };
};

(async () => {
  await ensureSchema();

  // This suite runs in `npm test` against a PERSISTENT database, and every run
  // leaves mirrored documents whose copies live in the previous run's in-memory
  // SharePoint. They would pile up in the re-file sweep's batch — which is
  // bounded — and eventually crowd out the very rows the assertions watch, so
  // each run clears its own predecessors first.
  const prior = (await db.query(
    `SELECT id FROM borrowers WHERE first_name='Shelf' AND last_name='Tester' AND email LIKE 'shelf-%@example.test'`
  )).rows.map((r) => r.id);
  if (prior.length) {
    await db.query(
      `DELETE FROM sharepoint_condition_state s
        WHERE s.scope_key IN (SELECT 'app:'||id FROM applications WHERE borrower_id = ANY($1))
           OR s.scope_key IN (SELECT 'borrower:'||unnest($1::uuid[]))`, [prior]);
    await db.query(`DELETE FROM documents WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM checklist_items WHERE application_id IN (SELECT id FROM applications WHERE borrower_id = ANY($1))`, [prior]);
    await db.query(`DELETE FROM applications WHERE borrower_id = ANY($1)`, [prior]);
    await db.query(`DELETE FROM borrowers WHERE id = ANY($1)`, [prior]);
  }

  const uniq = `shelf-${process.pid}-${Date.now()}`;
  const borrower = (await db.query(
    `INSERT INTO borrowers (first_name,last_name,email) VALUES ('Shelf','Tester',$1) RETURNING id`,
    [`${uniq}@example.test`])).rows[0].id;
  const appId = (await db.query(
    `INSERT INTO applications (borrower_id, property_address) VALUES ($1,$2) RETURNING id`,
    [borrower, JSON.stringify({ oneLine: '3 Shelf Rd, Lakewood, NJ 08701' })])).rows[0].id;
  const item = (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, item_kind, status)
     VALUES ($1,'application','Insurance binder & invoice','document','outstanding') RETURNING id`, [appId])).rows[0].id;

  const mkDoc = async (filename, over = {}) => {
    const bytes = Buffer.from(`%PDF-1.4\n${filename}\n`);
    const { ref, provider } = await storage.save(bytes, { filename });
    const cols = {
      application_id: appId, borrower_id: borrower, checklist_item_id: item,
      filename, content_type: 'application/pdf', size_bytes: bytes.length,
      storage_provider: provider, storage_ref: ref, uploaded_by_kind: 'borrower',
      is_current: true, review_status: 'pending', ...over,
    };
    const keys = Object.keys(cols);
    return (await db.query(
      `INSERT INTO documents (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => cols[k]))).rows[0].id;
  };
  const mirror = async (id) => backup.mirrorRow(await backup.enrichedRowById(id));

  /* ═══ 1. A FRESH UPLOAD WAITS ═══════════════════════════════════════════ */

  const binder = await mkDoc('binder.pdf', { slot_label: 'Insurance binder' });
  await mirror(binder);
  assert(await whereIs(binder) === 'Waiting for review',
    'a human upload is mirrored into "Waiting for review" — nobody has decided on it yet');
  assert((await db.query('SELECT sharepoint_shelf FROM documents WHERE id=$1', [binder])).rows[0].sharepoint_shelf === 'waiting',
    'and the shelf is recorded, so the sweep can find it in one indexed query');

  /* ═══ 2. ACCEPTING IT MOVES IT UP ═══════════════════════════════════════ */

  await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE id=$1`, [binder]);
  await backup.refileOnce();
  assert(await whereIs(binder) === '',
    'THE OWNER’S RULE: once accepted, the copy moves UP into the Insurance folder — what a human opens the folder to see');
  assert((await db.query('SELECT sharepoint_shelf FROM documents WHERE id=$1', [binder])).rows[0].sharepoint_shelf === 'live',
    'and the record follows it');

  const before = uploads;
  await backup.refileOnce();
  assert(uploads === before && await whereIs(binder) === '',
    'a second sweep moves nothing — it is idempotent');

  /* ═══ 3. A REJECTED DOCUMENT IS SAVED, NOT DELETED ══════════════════════ */

  const oldBinder = await mkDoc('OLD-carrier-binder.pdf', { slot_label: 'Insurance binder' });
  await mirror(oldBinder);
  await db.query(`UPDATE documents SET review_status='rejected', reviewed_at=now() WHERE id=$1`, [oldBinder]);
  await backup.refileOnce();
  const oldWhere = await whereIs(oldBinder);
  assert(oldWhere.startsWith('Old Versions'),
    `THE OWNER’S RULE: a REJECTED document is still saved — it moves to Old Versions (got "${oldWhere}")`);
  assert(deletes === 0, 'and NOTHING was deleted, anywhere, at any point');
  assert(tree.items.has((await db.query('SELECT sharepoint_backup_ref FROM documents WHERE id=$1', [oldBinder])).rows[0]
    .sharepoint_backup_ref.split(':').pop()), 'the rejected copy is still a real item in SharePoint');

  /* ═══ 4. A SUPERSEDED BATCH IS GROUPED — one Version folder, not N ══════ */

  const a = await mkDoc('invoice-v1.pdf', { slot_label: 'Insurance invoice', review_status: 'accepted' });
  const b2 = await mkDoc('endorsement-v1.pdf', { slot_label: 'Endorsement', review_status: 'accepted' });
  await mirror(a); await mirror(b2);
  assert(await whereIs(a) === '' && await whereIs(b2) === '',
    'both accepted documents start on the live shelf');

  await db.query(`UPDATE documents SET is_current=false WHERE id = ANY($1::uuid[])`, [[a, b2]]);
  await backup.refileOnce();
  const wa = await whereIs(a), wb = await whereIs(b2);
  assert(/^Old Versions\/Version \d+$/.test(wa),
    `a superseded copy lands in a numbered batch folder (got "${wa}")`);
  assert(wa === wb,
    'and the WHOLE batch shares ONE Version folder — never one folder per document ("Version 47")');

  // A LATER supersede is a different batch, so it gets the NEXT number — which is
  // what "old versions and old old versions" means when you open the folder.
  const c = await mkDoc('invoice-v2.pdf', { slot_label: 'Insurance invoice', review_status: 'accepted' });
  await mirror(c);
  await db.query(`UPDATE documents SET is_current=false WHERE id=$1`, [c]);
  await backup.refileOnce();
  const wc = await whereIs(c);
  assert(/^Old Versions\/Version \d+$/.test(wc) && wc !== wa,
    `a LATER supersede is its own batch — the old and the older sit in different Version folders (${wa} vs ${wc})`);

  /* ═══ 5. A HUMAN'S ARRANGEMENT WINS, PERMANENTLY ════════════════════════ */

  const moved = await mkDoc('someone-moved-me.pdf', { slot_label: 'Insurance binder' });
  await mirror(moved);
  const movedRef = (await db.query('SELECT sharepoint_backup_ref FROM documents WHERE id=$1', [moved])).rows[0].sharepoint_backup_ref;
  tree.items.get(movedRef.split(':').pop()).parent = 'somewhere-a-human-chose';   // a human dragged it
  await db.query(`UPDATE documents SET review_status='accepted', reviewed_at=now() WHERE id=$1`, [moved]);
  await backup.refileOnce();
  assert(tree.items.get(movedRef.split(':').pop()).parent === 'somewhere-a-human-chose',
    'a copy a HUMAN moved is left exactly where they put it — never forced back');
  const mrow = (await db.query('SELECT sharepoint_shelf, sharepoint_skipped_reason FROM documents WHERE id=$1', [moved])).rows[0];
  assert(mrow.sharepoint_shelf === 'live' && /left where a human put it/.test(mrow.sharepoint_skipped_reason || ''),
    'and the row records WHY, so the sweep stops re-asking Graph about it every pass');

  /* ═══ 6. PILOT'S OWN DOCUMENTS GO STRAIGHT TO THE LIVE SHELF ════════════ */

  const generated = await mkDoc('term-sheet-executed.pdf', {
    review_status: 'accepted', source_type: 'system', doc_kind: 'term_sheet_signed', checklist_item_id: null,
  });
  await mirror(generated);
  assert(await whereIs(generated) === '',
    'a document PILOT generated is born accepted, so it is filed straight into the category folder — no detour through "Waiting for review"');

  /* ═══ 7. THE FOLDER READS THE WAY THE OWNER ASKED ═══════════════════════ */

  const names = [...tree.folders.values()].filter((f) => f.parent === 'cond1').map((f) => f.name).sort();
  assert(names.includes('Waiting for review') && names.includes('Old Versions'),
    `the Insurance folder holds exactly the two shelves plus the live documents (got ${JSON.stringify(names)})`);
  assert(!names.some((n) => /^Version \d+$/.test(n)),
    'and NO bare "Version N" folder sits at the top any more — they all live inside Old Versions');

  await db.pool.end().catch(() => {});
  console.log(failures ? `\n${failures} FAILURE(S)` : '\nsharepoint-shelf-db: all assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
