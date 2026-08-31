'use strict';
/**
 * SHAREPOINT AND THE OFF-SITE VAULT, SIDE BY SIDE — one short-term file and one
 * long-term loan, the same run, the same assertions.
 *
 * Owner-directed 2026-08-31: *"we need to open up a side-by-side comparison to
 * make sure SharePoint works exactly the same: how it searches / the address /
 * where to place the document / how it's syncing / how everything works /
 * Cloudflare."*
 *
 * ── WHY THIS SUITE EXISTS BESIDE test-lt-sharepoint-scope-db ────────────────
 *
 * That suite proves the long-term side files into the same tree and parks the
 * same way. It does not answer the owner's other four questions, and two of
 * them cannot be answered by the parity engine AT ALL:
 *
 *   · the parity engine measures what a PRODUCT'S OWN CODE reaches. The vault
 *     (`src/lib/backup/**`) is reached by NEITHER product — it is a scheduled
 *     job that enumerates the document store BY KEY and dumps the whole
 *     database with no table list. So "does the long-term side get backed up?"
 *     is not a question a reachability engine can answer, and inferring it from
 *     "there is no product filter in the source" is an argument, not a proof.
 *     Sections E and F run the real thing over real rows instead.
 *   · the same for the mirror's own helpers (the Microsoft client, the folder
 *     matcher, the shelf) — the MIRROR pulls those in, never a product.
 *
 * ── WHAT IS PROVEN, IN THE OWNER'S OWN ORDER ────────────────────────────────
 *
 *   A. HOW IT SEARCHES / THE ADDRESS — a folder already in SharePoint is FOUND
 *      and reused rather than duplicated, on both products, including when the
 *      street is spelled the other way ("Avenue" vs "Ave"); and a second
 *      document on the same file is filed into the folder already found.
 *   B. HOW IT SYNCS — the repair that shortens over-long names reads the same
 *      four names on a long-term row, so the 259-character rescue covers it.
 *   C. WHERE IT PLACES THE DOCUMENT — a replaced copy is shelved into
 *      "Old Versions/Version N" identically, and the two products' version
 *      counters are independent.
 *   D. THE INTEGRITY CHECK reaches a long-term copy and reads it the same way.
 *   E. CLOUDFLARE — the real encrypt → vault → restore round trip, on ONE
 *      short-term and ONE long-term document at once, both landing back at
 *      their original keys byte-for-byte.
 *   F. THE DATABASE HALF — the nightly receipt counts the lt_* tables, so the
 *      weekly restore drill compares them to the row.
 *
 * NAMED test-lt-* deliberately: the separation gate reads a test's FILENAME as
 * its product, and this one inserts lt_loans rows. Any other name would read as
 * short-term code reaching into the long-term side.
 */
if (!process.env.DATABASE_URL) { console.log('SKIP test-lt-sharepoint-cloudflare-db (no DATABASE_URL)'); process.exit(0); }

const os = require('os');
const path = require('path');
const fs = require('fs');

const tmpStore = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-cf-store-'));
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
const cipher = require('../src/lib/backup/cipher');
const vaultDocs = require('../src/lib/backup/documents');
const inventory = require('../src/lib/backup/inventory');

let failures = 0;
const assert = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); if (!c) failures++; };
const eq = (got, want, m) => assert(got === want,
  `${m}${got === want ? '' : `\n       got:  ${JSON.stringify(got)}\n       want: ${JSON.stringify(want)}`}`);

/* ── a tiny in-memory SharePoint, rooted at the real Pipeline Drive ──────────
   Only GRAPH is stubbed. The folder matcher, the address rules and the folder
   creation all run for real, so what is asserted is what the resolver does. */
const tree = { folders: new Map(), items: new Map() };
tree.folders.set('root', { id: 'root', name: 'Pipeline Drive', parent: null });
const folderPath = (id) => {
  const parts = []; let cur = tree.folders.get(id);
  while (cur) { parts.unshift(cur.name); cur = cur.parent ? tree.folders.get(cur.parent) : null; }
  return parts.join('/');
};
const whereIs = async (docId) => {
  const r = (await db.query('SELECT sharepoint_parent_id FROM documents WHERE id=$1', [docId])).rows[0];
  return folderPath(r.sharepoint_parent_id);
};
/** Put a folder in SharePoint BY HAND, the way a person would. */
const humanFolder = (name, parentId) => {
  const id = `h${tree.folders.size + 1}`;
  tree.folders.set(id, { id, name, parent: parentId });
  return id;
};
const childrenNamed = (parentId, name) =>
  [...tree.folders.values()].filter((f) => f.parent === parentId && f.name === name).length;

sp.resolveDrive = async () => ({ driveId: 'drive1' });
sp.itemByPath = async (_d, p) => {
  if (String(p) !== 'Pipeline Drive') throw new Error(`unexpected root path ${p}`);
  return tree.folders.get('root');
};
sp.listChildren = async (_d, parentId) => [...tree.folders.values()]
  .filter((f) => f.parent === parentId)
  .map((f) => ({ id: f.id, name: f.name, isFolder: true, webUrl: `https://sp.example/${f.id}` }));
sp.ensureChildFolder = async (_d, parentId, name) => {
  for (const f of tree.folders.values()) if (f.parent === parentId && f.name === name) return f;
  const id = `f${tree.folders.size + 1}`;
  const f = { id, name, parent: parentId };
  tree.folders.set(id, f);
  return f;
};
let uploads = 0;
sp.uploadNew = async (_d, parentId, name, bytes) => {
  uploads += 1;
  const id = `item${uploads}`;
  tree.items.set(id, { id, name, parent: parentId, size: bytes.length });
  return { item: { id, webUrl: `https://sp.example/${id}`, size: bytes.length }, conflict: false };
};
sp.itemMetaByName = async () => null;
sp.itemMeta = async (_d, itemId) => {
  const it = tree.items.get(itemId);
  if (!it) { const e = new Error('itemNotFound'); e.status = 404; throw e; }
  return { id: it.id, name: it.name, size: it.size, folder: false };
};
let deletes = 0;
sp.remove = async () => { deletes += 1; throw new Error('remove is a no-op'); };
sp.moveOwnItem = async (_d, itemId, newParentId, { expectedParentId }) => {
  const it = tree.items.get(itemId);
  if (!it) { const e = new Error('itemNotFound'); e.status = 404; throw e; }
  if (it.parent !== expectedParentId) throw new Error('moveOwnItem refused: not in the expected folder');
  it.parent = newParentId;
  return { id: itemId, webUrl: `https://sp.example/${itemId}` };
};

/* Fixed ids so a re-run leaves the database exactly as it found it. */
const OFF_RTL = '7a1c0000-0000-4000-8000-0000000000a1';
const OFF_LT  = '7a1c0000-0000-4000-8000-0000000000a2';
const BORR    = '7a1c0000-0000-4000-8000-0000000000a3';
const APP     = '7a1c0000-0000-4000-8000-0000000000a4';
const LOAN    = '7a1c0000-0000-4000-8000-0000000000a5';

async function cleanup() {
  await db.query('DELETE FROM documents WHERE lt_loan_id=$1::uuid OR application_id=$2::uuid', [LOAN, APP]);
  await db.query('DELETE FROM checklist_items WHERE lt_loan_id=$1::uuid OR application_id=$2::uuid', [LOAN, APP]);
  await db.query('DELETE FROM sharepoint_condition_state WHERE scope_key = ANY($1::text[])', [[`lt:${LOAN}`, `app:${APP}`]]);
  await db.query('DELETE FROM sharepoint_folder_cache  WHERE scope_key = ANY($1::text[])', [[`lt:${LOAN}`, `app:${APP}`]]);
  await db.query('DELETE FROM lt_properties WHERE loan_id=$1::uuid', [LOAN]);
  await db.query('DELETE FROM lt_loans WHERE id=$1::uuid', [LOAN]);
  await db.query('DELETE FROM applications WHERE id=$1::uuid', [APP]);
  await db.query('DELETE FROM borrowers WHERE id=$1::uuid', [BORR]);
  await db.query('DELETE FROM staff_users WHERE id = ANY($1::uuid[])', [[OFF_RTL, OFF_LT]]);
}

(async () => {
  await db.query('SELECT 1');
  await ensureSchema();
  map._resetMemory();
  await cleanup();

  /* ═══ FIXTURES — one file each side, as alike as two products can be ═════ */

  await db.query(
    `INSERT INTO staff_users (id, email, full_name, role) VALUES
       ($1::uuid,'spcf-rtl@test.local','Cf Rtl Officer','loan_officer'),
       ($2::uuid,'spcf-lt@test.local','Cf Lt Officer','loan_officer')`, [OFF_RTL, OFF_LT]);
  await db.query(
    `INSERT INTO borrowers (id, first_name, last_name, email)
     VALUES ($1::uuid,'Meir','Cfborrower','spcf-b@test.local')`, [BORR]);
  await db.query(
    `INSERT INTO applications (id, borrower_id, loan_officer_id, ys_loan_number, property_address)
     VALUES ($1::uuid,$2::uuid,$3::uuid,'YS-CF-1',$4)`,
    [APP, BORR, OFF_RTL, JSON.stringify({ oneLine: '41 Parity Ave, Lakewood, NJ 08701' })]);
  await db.query(
    `INSERT INTO lt_loans (id, loan_number, borrower_first_name, borrower_last_name, loan_officer_id)
     VALUES ($1::uuid,'LT-CF-9100','Meir','Cfborrower',$2::uuid)`, [LOAN, OFF_LT]);
  await db.query(
    `INSERT INTO lt_properties (loan_id, street, city, state, zip)
     VALUES ($1::uuid,'41 Parity Ave','Lakewood','NJ','08701')`, [LOAN]);

  const rtlItem = (await db.query(
    `INSERT INTO checklist_items (application_id, scope, label, item_kind, status)
     VALUES ($1::uuid,'application','Insurance (binder + invoice)','document','outstanding') RETURNING id`,
    [APP])).rows[0].id;
  const ltItem = (await db.query(
    `INSERT INTO checklist_items (lt_loan_id, scope, label, item_kind, status)
     VALUES ($1::uuid,'lt_loan','Insurance binder & invoice','document','outstanding') RETURNING id`,
    [LOAN])).rows[0].id;

  const mkDoc = async (filename, over = {}, body = null) => {
    const bytes = body || Buffer.from(`%PDF-1.4\n${filename}\n${'x'.repeat(64)}\n`);
    const { ref, provider } = await storage.save(bytes, { filename });
    const cols = {
      filename, content_type: 'application/pdf', size_bytes: bytes.length,
      storage_provider: provider, storage_ref: ref, uploaded_by_kind: 'borrower',
      is_current: true, review_status: 'pending', ...over,
    };
    const keys = Object.keys(cols);
    const id = (await db.query(
      `INSERT INTO documents (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`,
      keys.map((k) => cols[k]))).rows[0].id;
    await db.query('UPDATE documents SET created_at = now() - interval \'1 hour\' WHERE id=$1', [id]);
    return { id, bytes, ref };
  };

  const enrich = (id) => backup.enrichedRowById(id);
  const mirror = async (id) => backup.mirrorRow(await enrich(id));

  /* ═══ A. HOW IT SEARCHES, AND THE ADDRESS ═══════════════════════════════
     The owner's first two questions. A folder somebody already made must be
     FOUND, not duplicated — that is what "how it searches" means in practice,
     and a mirror that duplicates instead of matching is how one property ends
     up with its papers in two places. The two products are given the SAME
     obstacle: an existing folder whose street is spelled out in full. */

  const root = 'root';
  const rtlOffFolder = humanFolder('Cf Rtl Officer', root);
  const rtlBorrFolder = humanFolder('Meir Cfborrower', rtlOffFolder);
  humanFolder('41 Parity Avenue', rtlBorrFolder);            // spelled the OTHER way, by a person
  const ltOffFolder = humanFolder('Cf Lt Officer', root);
  const ltBorrFolder = humanFolder('Meir Cfborrower', ltOffFolder);
  humanFolder('41 Parity Avenue', ltBorrFolder);             // the same obstacle, long-term side

  const rtlDoc = await mkDoc('rtl-binder.pdf', { application_id: APP, borrower_id: BORR, checklist_item_id: rtlItem });
  const ltDoc  = await mkDoc('lt-binder.pdf',  { lt_loan_id: LOAN, checklist_item_id: ltItem });

  const rtlPath = (await mirror(rtlDoc.id)).path;
  const ltPath  = (await mirror(ltDoc.id)).path;

  eq(rtlPath, 'Pipeline Drive/Cf Rtl Officer/Meir Cfborrower/41 Parity Avenue/Synced by Pilot/Insurance/Waiting for review',
    'A1 short-term: the folder a PERSON already made is found and used, even spelled "Avenue"');
  eq(ltPath, 'Pipeline Drive/Cf Lt Officer/Meir Cfborrower/41 Parity Avenue/Synced by Pilot/Insurance/Waiting for review',
    'A2 long-term: the same search finds the same kind of folder, spelled the same other way');
  eq(rtlPath.split('/').slice(4).join('/'), ltPath.split('/').slice(4).join('/'),
    'A3 …and below the file the two products build a byte-identical path');

  eq(childrenNamed(rtlBorrFolder, '41 Parity Ave'), 0,
    'A4 short-term: no duplicate address folder was created beside the one that existed');
  eq(childrenNamed(ltBorrFolder, '41 Parity Ave'), 0,
    'A5 long-term: no duplicate either — the matcher, not a second folder');

  // A SECOND document on the same file must land in the folder already found.
  const rtlDoc2 = await mkDoc('rtl-invoice.pdf', { application_id: APP, borrower_id: BORR, checklist_item_id: rtlItem });
  const ltDoc2  = await mkDoc('lt-invoice.pdf',  { lt_loan_id: LOAN, checklist_item_id: ltItem });
  eq((await mirror(rtlDoc2.id)).path, rtlPath, 'A6 short-term: a second document files into the folder already found');
  eq((await mirror(ltDoc2.id)).path, ltPath,  'A7 long-term: same — one search per file, not one per document');

  const cacheKeys = (await db.query(
    'SELECT scope_key, full_path FROM sharepoint_folder_cache WHERE scope_key = ANY($1::text[]) ORDER BY scope_key',
    [[`app:${APP}`, `lt:${LOAN}`]])).rows;
  eq(cacheKeys.length, 2, 'A8 each file remembered its folder once, under its own key');
  eq(cacheKeys.map((r) => r.scope_key).join(','), `app:${APP},lt:${LOAN}`,
    'A9 …the short-term one under app:<file>, the long-term one under lt:<loan>');

  /* ═══ B. THE 259-CHARACTER RESCUE READS THE SAME FOUR NAMES ═════════════
     Windows refuses to OPEN a synced file whose whole path passes 259
     characters, and the repair that shortens them strips the officer, the
     borrower and the address back out of the filename. It can only do that if
     it can SEE those names on the row — so this asks the long-term row the
     same question it asks a short-term one. */

  /* Each of the four names is asked about ON ITS OWN. A single filename
     carrying all of them proves far less than it looks: the borrower's name is
     stripped for BOTH products by the same candidate, so a comparison of the two
     shortened names stays equal even when the long-term address never reaches
     the repair at all — which is exactly what a mutation of the address lookup
     showed while the suite went on passing. Four names, four questions. */
  const slugOf = (v) => String(v || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const stripsIt = (row, value) => {
    const echo = `${slugOf(value)}_Binder_2026-08-31.pdf`;
    const short = backup.stripPathEchoes(echo, row);
    return { ok: short !== echo && short.endsWith('.pdf'), echo, short };
  };

  for (const [label, doc] of [['short-term', rtlDoc], ['long-term', ltDoc]]) {
    const row = await enrich(doc.id);
    for (const [what, value] of [
      ['the address', row.address_one_line],
      ['the borrower', `${row.borrower_first} ${row.borrower_last}`],
      ['the officer', row.officer_name],
    ]) {
      assert(value && String(value).trim(),
        `B1 ${label}: the repair can SEE ${what} on this row (${JSON.stringify(value)})`);
      const r = stripsIt(row, value);
      assert(r.ok, `B2 ${label}: …and strips ${what} back out of a filename that echoes it (${r.echo} → ${r.short})`);
    }
  }

  const repairSrc = fs.readFileSync(path.join(__dirname, 'sharepoint-shorten-existing.js'), 'utf8');
  const repairSelect = (repairSrc.match(/SELECT id, sharepoint_backup_ref FROM documents[\s\S]*?`/) || [''])[0];
  assert(repairSelect && !/application_id|lt_loan_id/.test(repairSelect),
    'B3 the repair looks at EVERY mirrored document — it has no idea which product a copy came from');

  /* ═══ C. WHERE A REPLACED COPY GOES ═════════════════════════════════════
     Nothing is ever deleted, so a replaced document is MOVED into
     "Old Versions/Version N". Both products, and the counters are per file. */

  for (const [label, doc, item, owner] of [
    ['short-term', rtlDoc, rtlItem, { application_id: APP, borrower_id: BORR }],
    ['long-term',  ltDoc,  ltItem,  { lt_loan_id: LOAN }],
  ]) {
    await db.query('UPDATE documents SET is_current=false WHERE id=$1', [doc.id]);
    const replacement = await mkDoc(`${label}-replacement.pdf`, { ...owner, checklist_item_id: item });
    await mirror(replacement.id);
    await backup.refileOnce();
    const shelved = await whereIs(doc.id);
    assert(/\/Old Versions\/Version 1$/.test(shelved),
      `C1 ${label}: the replaced copy is MOVED into "Old Versions/Version 1", never deleted (${shelved})`);
  }
  const versions = (await db.query(
    `SELECT scope_key, state_key, current_version FROM sharepoint_condition_state
       WHERE scope_key = ANY($1::text[]) ORDER BY scope_key`,
    [[`app:${APP}`, `lt:${LOAN}`]])).rows;
  eq(versions.length, 2, 'C2 each file keeps its own version stream, under its own key');
  assert(versions.every((v) => Number(v.current_version) === 1),
    `C3 …each advanced to Version 1 on its own — one product's replacement never bumps the other's count (${JSON.stringify(versions)})`);

  /* ═══ D. THE INTEGRITY CHECK REACHES A LONG-TERM COPY ═══════════════════ */

  for (const [label, doc] of [['short-term', rtlDoc2], ['long-term', ltDoc2]]) {
    const verdict = await backup.verifyRow(await enrich(doc.id));
    eq(verdict, 'ok', `D1 ${label}: a healthy copy verifies clean`);
  }
  // Now make the SharePoint copy the wrong size — the same damage, both sides.
  for (const [label, doc] of [['short-term', rtlDoc2], ['long-term', ltDoc2]]) {
    const ref = (await db.query('SELECT sharepoint_backup_ref FROM documents WHERE id=$1', [doc.id])).rows[0].sharepoint_backup_ref;
    const { itemId } = sp.parseRef(ref);
    tree.items.get(itemId).size = 3;                          // truncated in SharePoint
    const verdict = await backup.verifyRow(await enrich(doc.id));
    assert(verdict !== 'ok', `D2 ${label}: a damaged copy is CAUGHT, not passed (${verdict})`);
  }

  /* ═══ E. CLOUDFLARE — the real round trip, both documents at once ═══════
     Not "there is no product filter in the source" (an argument) but "we put
     both documents in and both came back" (a proof). Real encryption, real
     decryption, real keys. */

  const rtlRow = (await db.query('SELECT storage_ref FROM documents WHERE id=$1', [rtlDoc2.id])).rows[0];
  const ltRow  = (await db.query('SELECT storage_ref FROM documents WHERE id=$1', [ltDoc2.id])).rows[0];
  const objects = [
    { key: rtlRow.storage_ref, size: rtlDoc2.bytes.length, etag: 'e1' },
    { key: ltRow.storage_ref,  size: ltDoc2.bytes.length,  etag: 'e2' },
  ];
  const plan = vaultDocs.planCopy(objects, new Map(), 100);
  eq(plan.todo.length, 2, 'E1 the nightly copy plans BOTH documents — it never asks which product');
  eq(vaultDocs.sourceKeyFor(vaultDocs.vaultKeyFor(ltRow.storage_ref)), ltRow.storage_ref,
    'E2 a long-term document keeps its key verbatim in the vault, so a restore puts it back where the file already points');

  const KEY = 'a'.repeat(64);                                  // a 32-byte master key, in hex
  const store = new Map();
  const fakeVault = {
    label: 'test-vault',
    put: async (k, buf) => { store.set(k, buf); },
    get: async (k) => store.get(k) || null,
    list: async (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ key: k, size: store.get(k).length })),
  };
  for (const o of plan.todo) {
    const bytes = await storage.read(o.key);
    store.set(vaultDocs.vaultKeyFor(o.key), await cipher.encryptBuffer(KEY, bytes, { name: o.key }));
  }
  const back = new Map();
  const fakeTarget = {
    head: async (k) => (back.has(k) ? { bytes: back.get(k).length } : null),
    put: async (k, buf) => { back.set(k, buf); },
  };
  const res = await vaultDocs.restoreDocuments(fakeVault, fakeTarget, { encryptionKey: KEY, log: () => {} });
  eq(res.restored, 2, 'E3 both documents come back out of the vault');
  eq(res.failures.length, 0, `E4 …with nothing unreadable (${JSON.stringify(res.failures)})`);
  assert(back.has(ltRow.storage_ref) && Buffer.compare(back.get(ltRow.storage_ref), ltDoc2.bytes) === 0,
    'E5 the long-term document is back at its ORIGINAL key, byte for byte');
  assert(back.has(rtlRow.storage_ref) && Buffer.compare(back.get(rtlRow.storage_ref), rtlDoc2.bytes) === 0,
    'E6 and so is the short-term one — the same key, the same bytes, the same key material');

  const docsSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'backup', 'documents.js'), 'utf8');
  assert(!/application_id|lt_loan_id|is_tpo/.test(docsSrc),
    'E7 …and the vault carries no product filter at all, so neither product can ever be left out of it');

  /* ═══ F. THE DATABASE HALF — the receipt counts the long-term tables ════
     The nightly dump asks the database what exists rather than carrying a list
     of tables, which is what makes a new table backed up the day it is added.
     The RECEIPT taken beside it is what the weekly restore drill compares, so
     it has to name the long-term tables too. */

  const inv = await inventory.takeInventory(db);
  const tableNames = new Set((inv.tables || []).map((t) => t.name || `${t.schema}.${t.table}`));
  const named = [...tableNames].filter((n) => /(^|\.)lt_/.test(n));
  assert(named.length >= 5,
    `F1 the nightly receipt counts the long-term tables, so a restore is checked to the row (${named.length} of them)`);
  assert([...tableNames].some((n) => /(^|\.)documents$/.test(n)),
    'F2 …and the shared documents table, which is where a long-term document\'s record lives');

  const runSrc = fs.readFileSync(path.join(__dirname, 'backup-run.js'), 'utf8');
  const args = (runSrc.match(/function dumpArgs[\s\S]*?\n\}/) || [''])[0];
  assert(args && !/'--table|'-t'|--schema=/.test(args),
    'F3 the dump names no tables at all — it takes whatever the database has, so nothing can be left out by omission');

  eq(deletes, 0, 'G1 NOTHING was deleted, anywhere, at any point — the no-delete law is untouched');

  await cleanup();
  await db.pool.end().catch(() => {});
  console.log(failures ? `\n${failures} FAILURE(S)` : '\ntest-lt-sharepoint-cloudflare-db: all assertions passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
