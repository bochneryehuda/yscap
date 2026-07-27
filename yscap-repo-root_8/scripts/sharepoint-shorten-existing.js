'use strict';
/**
 * BACKWARDS path-shortening repair (owner-directed 2026-07-27).
 *
 * Windows/OneDrive refuse to OPEN a synced file whose full LOCAL path exceeds
 * 259 characters ("the file path is more than 259 characters" — Excel; "Access
 * denied" — Acrobat). The going-forward fix keeps NEW paths short; this one-time
 * repair shortens the ALREADY-mirrored files so existing files become openable
 * too, by renaming the automation's OWN items to shorter names:
 *   • a FILE   → its echo-stripped name  (drops the address/borrower baked into
 *                the filename that the folder already names)
 *   • a marked FOLDER → its plain name   (drops a redundant ", Synced by Pilot"
 *                / legacy ", YS portal sync" suffix on an officer/borrower/
 *                address folder)
 *
 * SAFE BY DESIGN:
 *  - DRY-RUN by default: prints what it WOULD rename and changes nothing.
 *    Pass --apply to actually rename.
 *  - Every rename goes through sharepoint.renameOwnItem, which refuses anything
 *    not created by this app (createdBy.application), anything outside a Pilot
 *    mirror tree, and any name that would collide with an existing sibling; it
 *    pins the change with an If-Match eTag. A human's file/folder is NEVER
 *    touched; nothing is ever deleted or moved.
 *  - A rename KEEPS the driveItem id, so documents.sharepoint_backup_ref and the
 *    folder cache stay valid — no re-pointing needed.
 *  - IDEMPOTENT: a file already echo-free / a folder already un-marked is
 *    skipped, so re-running is harmless.
 *  - Only touches items whose CURRENT estimated local path is over the ceiling,
 *    so already-openable files are left alone (no churn).
 *
 *   node scripts/sharepoint-shorten-existing.js                # dry run (files + folders)
 *   node scripts/sharepoint-shorten-existing.js --apply        # rename for real
 *   node scripts/sharepoint-shorten-existing.js --files        # files only
 *   node scripts/sharepoint-shorten-existing.js --folders      # folders (markers) only
 *
 * Env: PATH_CEILING (default 259), LOCAL_PREFIX_RESERVE (default 90 — an
 * estimate of the per-PC "C:\\Users\\<user>\\<synced library folder>\\" prefix
 * that is NOT part of the SharePoint path; raise it if your users' prefix is
 * longer). Requires DATABASE_URL + the MS_* SharePoint credentials.
 */
const R = require('path').resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const ONLY_FILES = process.argv.includes('--files');
const ONLY_FOLDERS = process.argv.includes('--folders');
const CEILING = parseInt(process.env.PATH_CEILING || '259', 10);
const RESERVE = parseInt(process.env.LOCAL_PREFIX_RESERVE || '90', 10);

// Estimate the full LOCAL path length from an item's SharePoint path. Graph's
// parentReference.path looks like "/drives/{id}/root:/Pipeline Drive/…/Cond";
// the drive-relative part maps 1:1 onto the local OneDrive folder, plus the
// per-PC prefix we can't see (RESERVE), plus "/<name>".
function localLen(item) {
  const p = (item.parentReference && item.parentReference.path) || '';
  let decoded = p;
  try { decoded = decodeURIComponent(p); } catch (_) { /* malformed %-seq — use raw */ }
  const rel = decoded.replace(/^.*?root:\/?/, '');
  return RESERVE + rel.length + 1 + String(item.name || '').length;
}

(async function main() {
  if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is required'); process.exit(1); }
  const sp = require(R + '/src/lib/sharepoint');
  const backup = require(R + '/src/lib/sharepoint-backup');
  const cfg = require(R + '/src/config');
  if (!sp.configured()) { console.error('SharePoint is not configured (set MS_TENANT_ID/MS_CLIENT_ID + secret or cert).'); process.exit(1); }
  const db = require(R + '/src/db');
  const { driveId } = await sp.resolveDrive();
  const pipelineRoot = String(cfg.sharepointPipelineRoot || 'Pipeline Drive').toLowerCase();

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ceiling ${CEILING}, local-prefix reserve ${RESERVE}` +
    `${ONLY_FILES ? ' (files only)' : ONLY_FOLDERS ? ' (folders only)' : ' (files + folders)'}`);

  let filesSeen = 0, filesRenamed = 0, filesSkipped = 0;
  let foldersSeen = 0, foldersRenamed = 0, foldersSkipped = 0;

  // ─────────────────────────────── FILES ────────────────────────────────────
  if (!ONLY_FOLDERS) {
    const { rows } = await db.query(
      `SELECT id, sharepoint_backup_ref FROM documents
        WHERE sharepoint_backup_ref IS NOT NULL AND sharepoint_backup_ref <> ''
        ORDER BY created_at ASC`);
    console.log(`${rows.length} mirrored documents to check.`);
    for (const d of rows) {
      let ref; try { ref = sp.parseRef(d.sharepoint_backup_ref); } catch { continue; }
      if (ref.driveId !== driveId) continue;
      filesSeen++;
      let item; try { item = await sp.itemMeta(driveId, ref.itemId); } catch { filesSkipped++; continue; }
      if (!item || item.folder || item.id == null) { filesSkipped++; continue; }
      const row = await backup.enrichedRowById(d.id).catch(() => null);
      if (!row) { filesSkipped++; continue; }
      const short = backup.stripPathEchoes(String(item.name), row);
      if (short === item.name) { filesSkipped++; continue; }        // no echo to strip
      const before = localLen(item);
      if (before <= CEILING) { filesSkipped++; continue; }          // already openable — leave it
      const after = before - (String(item.name).length - short.length);
      // Run the SAME guards in dry-run and apply (dryRun stops before the PATCH),
      // so the preview faithfully reflects what --apply would do.
      const res = await sp.renameOwnItem(driveId, ref.itemId, short, { kind: 'file', dryRun: !APPLY }).catch((e) => ({ skipped: true, reason: e.message }));
      if (res.renamed || res.wouldRename) {
        filesRenamed++;
        if (filesRenamed <= 60 || (APPLY && filesRenamed % 50 === 0)) console.log(`  ${APPLY ? 'renamed' : 'would rename'} FILE  ${before}→${after}  "${res.from}" → "${res.to}"`);
      } else { filesSkipped++; console.log(`  skip FILE doc ${d.id}: ${res.reason}`); }
    }
  }

  // ────────────────────────────── FOLDERS ───────────────────────────────────
  // Walk UP from every mirror leaf (sharepoint_folder_cache.sync_folder_id) to
  // the Pipeline root, collecting the automation's OWN marked officer/borrower/
  // address folders and dropping the marker. Deduped by folder id (a borrower
  // folder is shared across its addresses/scopes).
  if (!ONLY_FILES) {
    const { rows } = await db.query(
      `SELECT DISTINCT sync_folder_id FROM sharepoint_folder_cache WHERE sync_folder_id IS NOT NULL`);
    console.log(`${rows.length} sync leaves to walk for marked ancestor folders.`);
    const done = new Set();
    for (const r of rows) {
      let cursor = { id: r.sync_folder_id };
      for (let hop = 0; hop < 12 && cursor && cursor.id; hop++) {
        let f; try { f = await sp.graph(`/drives/${driveId}/items/${cursor.id}?$select=id,name,parentReference,createdBy`); } catch { break; }
        const nm = String(f.name || '');
        if (nm.toLowerCase() === pipelineRoot) break;               // reached the root — stop
        const plain = sp.dropSyncMarker(nm);
        if (plain && !done.has(f.id)) {
          done.add(f.id); foldersSeen++;
          const res = await sp.renameOwnItem(driveId, f.id, plain, { kind: 'folder', dryRun: !APPLY }).catch((e) => ({ skipped: true, reason: e.message }));
          if (res.renamed || res.wouldRename) {
            foldersRenamed++;
            if (foldersRenamed <= 60 || (APPLY && foldersRenamed % 25 === 0)) console.log(`  ${APPLY ? 'renamed' : 'would rename'} FOLDER "${res.from}" → "${res.to}"`);
          } else { foldersSkipped++; console.log(`  skip FOLDER "${nm}": ${res.reason}`); }
        }
        cursor = f.parentReference;
      }
    }
  }

  console.log(`\nDone. files: seen=${filesSeen} ${APPLY ? 'renamed' : 'would-rename'}=${filesRenamed} skipped=${filesSkipped}` +
    ` | folders: seen=${foldersSeen} ${APPLY ? 'renamed' : 'would-rename'}=${foldersRenamed} skipped=${foldersSkipped}`);
  if (!APPLY) console.log('(DRY RUN — re-run with --apply to rename for real.)');
  try { await db.pool.end(); } catch (_) { /* ignore */ }
})().catch((e) => { console.error(e); process.exitCode = 1; });
