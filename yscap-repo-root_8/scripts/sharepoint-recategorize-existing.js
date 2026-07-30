'use strict';
/**
 * BACKWARDS repair (owner-directed 2026-07-30): rename the automation's OWN
 * condition folders inside each Pilot sync leaf to the clean TPR category names
 * ("Bank Statements", "Contract & Assignment", "Appraisal", "Credit Report", …)
 * so ALREADY-mirrored files match the new going-forward naming, instead of the
 * long per-condition labels ("Assets & bank statements verified — met", …).
 *
 * SAFE BY DESIGN (mirrors scripts/sharepoint-shorten-existing.js):
 *  - DRY-RUN by default: prints what it WOULD rename and changes nothing.
 *    Pass --apply to actually rename.
 *  - Every rename goes through sharepoint.renameOwnItem, which refuses anything
 *    not created by this app (createdBy.application), anything outside a Pilot
 *    mirror tree, and any name that would COLLIDE with an existing sibling — so
 *    two old folders that map to one clean name are SKIPPED, never merged, and a
 *    human folder is never touched. It pins the change with an If-Match eTag.
 *  - A rename KEEPS the driveItem id, so documents.sharepoint_backup_ref and the
 *    folder cache stay valid — no re-pointing needed. Nothing is moved or deleted.
 *  - The clean name is computed from each document's REAL metadata via
 *    sharepoint-backup.categoryPathFor (the SAME function the live mirror uses),
 *    so an LLC / REO / Term Sheet / Closing / photo-ID folder — already correct —
 *    is recognized and left alone; only the flat per-condition folders are renamed.
 *  - IDEMPOTENT: a folder already at its clean name is skipped; re-running is safe.
 *
 *   node scripts/sharepoint-recategorize-existing.js           # dry run
 *   node scripts/sharepoint-recategorize-existing.js --apply   # rename for real
 *
 * Requires DATABASE_URL + the MS_* SharePoint credentials.
 */
const R = require('path').resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// Walk UP from a document's immediate parent folder to the folder that sits
// DIRECTLY under the sync leaf — that is the top "category/condition" folder we
// may rename. Handles a doc filed in the folder root (version 0) OR inside a
// "Version N" subfolder. Returns null if the leaf is reached without a category
// child (a doc filed straight in the leaf) or the chain leaves the tree.
async function topCategoryFolder(sp, driveId, startParentId, leafId) {
  let curId = startParentId;
  for (let hop = 0; hop < 12 && curId; hop++) {
    let f;
    try { f = await sp.graph(`/drives/${driveId}/items/${curId}?$select=id,name,parentReference`); }
    catch { return null; }
    if (!f || f.id == null) return null;
    if (f.id === leafId) return null;                                   // reached the leaf, no category child
    if (f.parentReference && f.parentReference.id === leafId) return { id: f.id, name: String(f.name || '') };
    curId = f.parentReference && f.parentReference.id;
  }
  return null;
}

(async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  const sp = require(R + '/src/lib/sharepoint');
  const backup = require(R + '/src/lib/sharepoint-backup');
  if (!sp.configured()) { console.error('SharePoint is not configured (set MS_TENANT_ID/MS_CLIENT_ID + secret or cert).'); process.exit(1); }
  const db = require(R + '/src/db');
  const { driveId } = await sp.resolveDrive();

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — recategorize condition folders to clean TPR names`);

  const { rows } = await db.query(
    `SELECT id, sharepoint_backup_ref, sharepoint_parent_id FROM documents
      WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_backup_ref <> ''
        AND sharepoint_parent_id IS NOT NULL AND is_current = true
      ORDER BY created_at ASC`);
  console.log(`${rows.length} mirrored documents to inspect.`);

  const leafCache = new Map();     // scopeKey -> sync_folder_id
  const doneFolder = new Set();    // folder ids already handled (rename each folder once)
  let seen = 0, renamed = 0, skipped = 0, collisions = 0;

  for (const d of rows) {
    let ref; try { ref = sp.parseRef(d.sharepoint_backup_ref); } catch { continue; }
    if (ref.driveId !== driveId) continue;
    const row = await backup.enrichedRowById(d.id).catch(() => null);
    if (!row) { skipped++; continue; }

    const cleanTop = backup.categoryPathFor(row)[0];
    const scopeKey = backup.scopeKeyFor(row);
    if (!scopeKey || !cleanTop) { skipped++; continue; }

    let leafId = leafCache.get(scopeKey);
    if (leafId === undefined) {
      const r = await db.query(
        'SELECT sync_folder_id FROM sharepoint_folder_cache WHERE scope_key=$1 AND sync_folder_id IS NOT NULL LIMIT 1', [scopeKey]);
      leafId = r.rows[0] ? r.rows[0].sync_folder_id : null;
      leafCache.set(scopeKey, leafId);
    }
    if (!leafId) { skipped++; continue; }

    const top = await topCategoryFolder(sp, driveId, d.sharepoint_parent_id, leafId);
    if (!top) { skipped++; continue; }
    if (doneFolder.has(top.id)) continue;
    doneFolder.add(top.id);
    seen++;

    if (top.name === cleanTop) { skipped++; continue; }                 // already clean — leave it
    const res = await sp.renameOwnItem(driveId, top.id, cleanTop, { kind: 'folder', dryRun: !APPLY })
      .catch((e) => ({ skipped: true, reason: e.message }));
    if (res.renamed || res.wouldRename) {
      renamed++;
      console.log(`  ${APPLY ? 'renamed' : 'would rename'} FOLDER  "${res.from}" → "${res.to}"`);
    } else {
      skipped++;
      if (/sibling named/.test(res.reason || '')) collisions++;
      console.log(`  skip FOLDER "${top.name}" → "${cleanTop}": ${res.reason}`);
    }
  }

  console.log(`\nDone. folders: seen=${seen} ${APPLY ? 'renamed' : 'would-rename'}=${renamed} skipped=${skipped} collisions=${collisions}`);
  if (collisions) {
    console.log(`(${collisions} folder(s) map to a clean name that ALREADY exists — two old folders → one category. ` +
      `Nothing was merged; a human moves the stragglers, or the going-forward mirror fills the clean folder.)`);
  }
  if (!APPLY) console.log('(DRY RUN — re-run with --apply to rename for real.)');
  try { await db.pool.end(); } catch (_) { /* ignore */ }
})().catch((e) => { console.error(e); process.exitCode = 1; });
