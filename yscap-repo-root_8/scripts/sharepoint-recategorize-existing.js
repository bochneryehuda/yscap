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
 *    folder cache stay valid — no re-pointing. Nothing is moved or deleted.
 *  - TWO PASSES: pass 1 groups every mirrored document by its current top folder
 *    and collects the clean category each document maps to; pass 2 renames a
 *    folder ONLY when EVERY document in it maps to the SAME clean name. A folder
 *    whose documents map to MORE THAN ONE category (the old "General Documents"
 *    catch-all, or a legacy fraud folder holding both background + criminal docs)
 *    is left alone and reported — never renamed to whichever document came first.
 *  - The clean name comes from each document's REAL metadata via
 *    sharepoint-backup.categoryPathFor (the SAME function the live mirror uses),
 *    so an LLC / REO / Term Sheet / Closing / photo-ID folder — already correct —
 *    is recognized (its clean top == its own name) and left alone.
 *  - IDEMPOTENT: a folder already at its clean name is skipped; re-running is safe.
 *
 *   node scripts/sharepoint-recategorize-existing.js           # dry run
 *   node scripts/sharepoint-recategorize-existing.js --apply   # rename for real
 *
 * Requires DATABASE_URL + the MS_* SharePoint credentials.
 */
const R = require('path').resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

// The leaf-walk lives in the shared module (the one-shot EMD refolder uses the
// SAME definition — owner-directed 2026-07-31) so the two can never drift.
const { topCategoryFolder } = require(R + '/src/lib/sharepoint-emd-refolder');

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

  const leafCache = new Map();     // scopeKey -> sync_folder_id (null = none)
  const parentTop = new Map();     // parent driveItem id -> topFolder {id,name} | null
  const folders = new Map();       // topFolderId -> { name, cats:Set }

  // ---- PASS 1: group documents by their current top folder + collect categories.
  let inspected = 0;
  for (const d of rows) {
    let ref; try { ref = sp.parseRef(d.sharepoint_backup_ref); } catch { continue; }
    if (ref.driveId !== driveId) continue;
    const row = await backup.enrichedRowById(d.id).catch(() => null);
    if (!row) continue;

    const cleanTop = backup.categoryPathFor(row)[0];
    const scopeKey = backup.scopeKeyFor(row);
    if (!scopeKey || !cleanTop) continue;

    let leafId = leafCache.get(scopeKey);
    if (leafId === undefined) {
      const r = await db.query(
        'SELECT sync_folder_id FROM sharepoint_folder_cache WHERE scope_key=$1 AND sync_folder_id IS NOT NULL LIMIT 1', [scopeKey]);
      leafId = r.rows[0] ? r.rows[0].sync_folder_id : null;
      leafCache.set(scopeKey, leafId);
    }
    if (!leafId) continue;

    // Resolve (and memoize) the top folder for this document's parent — many
    // documents share a parent, so this avoids re-walking the same chain.
    const memoKey = `${leafId}|${d.sharepoint_parent_id}`;
    let top = parentTop.get(memoKey);
    if (top === undefined) {
      top = await topCategoryFolder(sp, driveId, d.sharepoint_parent_id, leafId);
      parentTop.set(memoKey, top);
    }
    if (!top) continue;

    inspected++;
    let g = folders.get(top.id);
    if (!g) { g = { name: top.name, cats: new Set() }; folders.set(top.id, g); }
    g.cats.add(cleanTop);
  }
  console.log(`${inspected} documents grouped into ${folders.size} top folder(s).`);

  // ---- PASS 2: rename only HOMOGENEOUS folders that need it.
  let renamed = 0, alreadyClean = 0, heterogeneous = 0, skipped = 0, collisions = 0;
  for (const [folderId, g] of folders) {
    if (g.cats.size > 1) {
      heterogeneous++;
      console.log(`  skip FOLDER "${g.name}": holds ${g.cats.size} categories (${[...g.cats].join(', ')}) — a human sorts these, never auto-renamed`);
      continue;
    }
    const cleanTop = [...g.cats][0];
    if (g.name === cleanTop) { alreadyClean++; continue; }
    const res = await sp.renameOwnItem(driveId, folderId, cleanTop, { kind: 'folder', dryRun: !APPLY })
      .catch((e) => ({ skipped: true, reason: e.message }));
    if (res.renamed || res.wouldRename) {
      renamed++;
      console.log(`  ${APPLY ? 'renamed' : 'would rename'} FOLDER  "${res.from}" → "${res.to}"`);
    } else {
      skipped++;
      if (/sibling named/.test(res.reason || '')) collisions++;
      console.log(`  skip FOLDER "${g.name}" → "${cleanTop}": ${res.reason}`);
    }
  }

  console.log(`\nDone. folders: ${folders.size} total | ${APPLY ? 'renamed' : 'would-rename'}=${renamed} ` +
    `already-clean=${alreadyClean} heterogeneous=${heterogeneous} skipped=${skipped} collisions=${collisions}`);
  if (collisions) {
    console.log(`(${collisions} folder(s) map to a clean name that ALREADY exists — two old folders → one category. ` +
      `Nothing was merged; a human moves the stragglers, or the going-forward mirror fills the clean folder.)`);
  }
  if (!APPLY) console.log('(DRY RUN — re-run with --apply to rename for real.)');
  try { await db.pool.end(); } catch (_) { /* ignore */ }
})().catch((e) => { console.error(e); process.exitCode = 1; });
