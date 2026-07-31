'use strict';

/**
 * EMD REFOLDER — the "previous files" half of the EMD-gets-its-own-folder
 * change (owner-directed 2026-07-31: "run the recategorize script so old files
 * get the EMD folder").
 *
 * The 2026-07-31 categorizer change (tpr-export.categoryFor) files the
 * CorrFirst earnest-money proof (cond_emd_corrfirst) under its OWN "EMD"
 * category — going forward. This module is the deterministic, idempotent
 * backfill for files mirrored BEFORE it (the "previous AND future" rule): a
 * ONE-SHOT boot pass that renames the automation's OWN old condition folders
 * to the clean EMD name — exactly what running
 * scripts/sharepoint-recategorize-existing.js --apply would do, SCOPED to the
 * EMD case the owner asked about. The general recategorize script stays the
 * manual, dry-run-first tool for everything else.
 *
 * WHY AUTOMATIC (a deliberate, owner-directed exception to the "repair scripts
 * are run by hand" posture): the manual script needs a shell with the live
 * SharePoint credentials, which the owner (not a developer) does not use. The
 * owner asked for the outcome, so the pass ships WITH the categorizer change
 * and runs itself once after the deploy — the same pattern as every other
 * previous-files backfill here (and the sanctioned corrupt-mirror delete
 * already runs unattended behind its guards). Safety is UNCHANGED from the
 * manual script:
 *  - Every rename still goes through sp.renameOwnItem's guards: created-by-
 *    this-app only, in-mirror ancestry, sibling-collision refusal (two folders
 *    are never merged), eTag pin. A human's folder is structurally untouchable.
 *  - ONLY a folder whose EVERY current mirrored document categorizes as the
 *    EMD category is renamed. A folder mixing contract + EMD docs is SKIPPED
 *    and reported — never renamed, never split (a human sorts those).
 *  - Nothing is moved or deleted; a rename keeps the driveItem id, so
 *    documents.sharepoint_backup_ref and the folder cache stay valid.
 *  - ONE-SHOT: a durable sync_runtime_state marker records a completed pass;
 *    a pass that hit transient (Graph/DB) errors does NOT stamp, so the next
 *    boot retries. If the inspect cap is hit — or ANY inspect error occurred
 *    (second-audit hardening: a doc whose enrichment/walk failed may be the
 *    non-EMD resident of a folder that was grouped) — the rename phase is
 *    SKIPPED entirely: a partial view cannot prove a folder is all-EMD.
 *  - Kill switch: SHAREPOINT_EMD_REFOLDER_DISABLED=1. Always best-effort —
 *    it can never block or fail boot.
 */

const STATE_KEY = 'sharepoint_emd_refolder_v1';
const MAX_DOCS = Math.max(50, parseInt(process.env.SHAREPOINT_EMD_REFOLDER_MAX_DOCS || '2000', 10) || 2000);

// The category name is DERIVED from the one chokepoint (never re-inlined):
// whatever tpr-export files the EMD condition under is what we rename to.
function emdCategory() {
  return require('./tpr-export').categoryFor({ template_code: 'cond_emd_corrfirst' });
}

/**
 * Walk UP from a document's immediate parent folder to the folder that sits
 * DIRECTLY under the sync leaf — the top "category/condition" folder a repair
 * may rename. Handles a doc filed in the folder root OR inside a "Version N"
 * subfolder. Returns null if the leaf is reached without a category child (a
 * doc filed straight in the leaf) or the chain leaves the tree. Shared with
 * scripts/sharepoint-recategorize-existing.js — ONE definition, no drift.
 * opts.onError (one-shot only): a Graph failure must COUNT for the boot pass —
 * "the walk failed" and "the doc sits in the leaf root" both return null, and
 * stamping the marker on an outage would silently skip the repair forever.
 */
async function topCategoryFolder(sp, driveId, startParentId, leafId, opts = {}) {
  let curId = startParentId;
  for (let hop = 0; hop < 12 && curId; hop++) {
    let f;
    try { f = await sp.graph(`/drives/${driveId}/items/${curId}?$select=id,name,parentReference`); }
    catch (e) { if (opts.onError) opts.onError(e); return null; }
    if (!f || f.id == null) return null;
    if (f.id === leafId) return null;                                   // reached the leaf, no category child
    if (f.parentReference && f.parentReference.id === leafId) return { id: f.id, name: String(f.name || '') };
    curId = f.parentReference && f.parentReference.id;
  }
  return null;
}

async function readMarker(db) {
  const r = await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [STATE_KEY]);
  return r.rows[0] ? r.rows[0].value : null;
}

async function stampMarker(db, summary) {
  await db.query(
    `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [STATE_KEY, JSON.stringify({ ...summary, finishedAt: new Date().toISOString() })]);
}

async function auditRename(db, detail) {
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind, actor_id, action, entity_type, entity_id, detail)
       VALUES ('system', NULL, 'sharepoint_emd_refolder_renamed', 'sharepoint_sync', NULL, $1::jsonb)`,
      [JSON.stringify(detail).slice(0, 2000)]);
  } catch (_) { /* audit is best-effort — the rename itself is the record */ }
}

/**
 * The one-shot pass. Never throws. Returns a summary object; `deps` exists for
 * tests (fake sp/db, real or hybrid backup) — production callers pass nothing.
 */
async function refolderEmdOnce(deps = {}) {
  const summary = { emdDocs: 0, inspected: 0, folders: 0, renamed: 0, alreadyClean: 0, heterogeneous: 0, skipped: 0, errors: 0 };
  try {
    if (process.env.SHAREPOINT_EMD_REFOLDER_DISABLED === '1') return { ...summary, skippedReason: 'disabled' };
    const backup = deps.backup || require('./sharepoint-backup');
    if (!backup.enabled()) return { ...summary, skippedReason: 'sync disabled' };
    const db = deps.db || require('../db');
    const sp = deps.sp || require('./sharepoint');

    if (await readMarker(db)) return { ...summary, skippedReason: 'done' };

    // Mirrored documents on the EMD condition — the apps whose sync leaves the
    // pass looks at. Everything else in the tenant is out of scope by SELECT.
    const emd = await db.query(
      `SELECT d.id, COALESCE(d.application_id, ci.application_id) AS app_id
         FROM documents d
         JOIN checklist_items ci ON ci.id = d.checklist_item_id
         JOIN checklist_templates ct ON ct.id = ci.template_id
        WHERE ct.code = 'cond_emd_corrfirst'
          AND d.sharepoint_backup_ref IS NOT NULL AND d.sharepoint_backup_ref <> ''
          AND d.sharepoint_parent_id IS NOT NULL`);
    summary.emdDocs = emd.rows.length;
    const appIds = [...new Set(emd.rows.map((r) => r.app_id).filter(Boolean))];
    if (!appIds.length) {
      // Nothing mirrored under the old name — going forward the categorizer
      // already files EMD correctly, so the repair is complete by vacuity.
      await stampMarker(db, summary);
      return summary;
    }

    // EVERY current mirrored doc on those files — the homogeneity evidence.
    // (Judging a folder by only its EMD docs could rename a mixed folder;
    // the whole point of the heterogeneous guard is to never do that.)
    const all = await db.query(
      `SELECT d.id, d.sharepoint_backup_ref, d.sharepoint_parent_id
         FROM documents d
         LEFT JOIN checklist_items ci ON ci.id = d.checklist_item_id
        WHERE COALESCE(d.application_id, ci.application_id) = ANY($1::uuid[])
          AND d.sharepoint_backup_ref IS NOT NULL AND d.sharepoint_backup_ref <> ''
          AND d.sharepoint_parent_id IS NOT NULL AND d.is_current = true
        ORDER BY d.created_at ASC
        LIMIT ${MAX_DOCS + 1}`, [appIds]);
    if (all.rows.length > MAX_DOCS) {
      // A truncated view cannot PROVE any folder is all-EMD — renaming on
      // partial evidence is exactly the mistake the heterogeneous guard
      // exists to prevent. Leave everything alone (and unstamped) for the
      // manual script. Never a silent cap.
      console.warn(`[sp-emd-refolder] over ${MAX_DOCS} candidate documents — pass skipped; run scripts/sharepoint-recategorize-existing.js --apply manually`);
      return { ...summary, skippedReason: 'cap' };
    }

    const { driveId } = await sp.resolveDrive();
    const EMD = emdCategory();
    const leafCache = new Map();     // scopeKey -> sync_folder_id | null
    const parentTop = new Map();     // `${leafId}|${parentId}` -> {id,name} | null
    const folders = new Map();       // topFolderId -> { name, cats:Set }

    for (const d of all.rows) {
      try {
        let ref; try { ref = sp.parseRef(d.sharepoint_backup_ref); } catch { continue; }
        if (ref.driveId !== driveId) continue;
        const row = await backup.enrichedRowById(d.id);
        if (!row) continue;
        const cleanTop = backup.categoryPathFor(row)[0];
        const scopeKey = backup.scopeKeyFor(row);
        if (!scopeKey || !cleanTop) continue;

        let leafId = leafCache.get(scopeKey);
        if (leafId === undefined) {
          const r = await db.query(
            `SELECT sync_folder_id FROM sharepoint_folder_cache WHERE scope_key=$1 AND sync_folder_id IS NOT NULL LIMIT 1`, [scopeKey]);
          leafId = r.rows[0] ? r.rows[0].sync_folder_id : null;
          leafCache.set(scopeKey, leafId);
        }
        if (!leafId) continue;

        const memoKey = `${leafId}|${d.sharepoint_parent_id}`;
        let top = parentTop.get(memoKey);
        if (top === undefined) {
          top = await topCategoryFolder(sp, driveId, d.sharepoint_parent_id, leafId,
            { onError: () => { summary.errors++; } });
          parentTop.set(memoKey, top);
        }
        if (!top) continue;

        summary.inspected++;
        let g = folders.get(top.id);
        if (!g) { g = { name: top.name, cats: new Set() }; folders.set(top.id, g); }
        g.cats.add(cleanTop);
      } catch (e) {
        summary.errors++;
        console.warn('[sp-emd-refolder] inspect error:', e.message);
      }
    }
    summary.folders = folders.size;

    if (summary.errors > 0) {
      // Partial evidence must never prove a folder is all-EMD — the same rule
      // as the inspect cap: a doc whose enrichment or walk failed may be the
      // non-EMD resident of a folder the loop DID manage to group. Rename
      // nothing this pass; unstamped, so the next boot retries complete.
      console.warn(`[sp-emd-refolder] ${summary.errors} inspect error(s) — rename phase skipped this pass (retries next boot)`);
      return { ...summary, skippedReason: 'inspect-errors' };
    }

    for (const [folderId, g] of folders) {
      // Scope filter: this pass ONLY repairs the EMD case the owner asked
      // about. Anything else stays for the manual recategorize script.
      if (!g.cats.has(EMD)) continue;
      if (g.cats.size > 1) {
        summary.heterogeneous++;
        console.log(`[sp-emd-refolder] skip "${g.name}": holds ${[...g.cats].join(' + ')} — mixed folders are a human's call, never auto-renamed`);
        continue;
      }
      if (g.name === EMD) { summary.alreadyClean++; continue; }
      try {
        const res = await sp.renameOwnItem(driveId, folderId, EMD, { kind: 'folder' });
        if (res.renamed) {
          summary.renamed++;
          console.log(`[sp-emd-refolder] renamed "${res.from}" → "${res.to}"`);
          await auditRename(db, { folderId, from: res.from, to: res.to });
        } else {
          // A refusal from the guards (collision, human folder, no eTag) is a
          // FINAL state for this pass — reported, and left for a human.
          summary.skipped++;
          console.log(`[sp-emd-refolder] skip "${g.name}" → "${EMD}": ${res.reason}`);
        }
      } catch (e) {
        summary.errors++;
        console.warn(`[sp-emd-refolder] rename error on "${g.name}":`, e.message);
      }
    }

    // Stamp ONLY a pass whose view was complete and error-free. Guard
    // refusals (collision/heterogeneous) are permanent, human-owned states —
    // they stamp; a Graph/DB blip does not, so the next boot retries.
    if (summary.errors === 0) await stampMarker(db, summary);
    console.log(`[sp-emd-refolder] done: emdDocs=${summary.emdDocs} folders=${summary.folders} renamed=${summary.renamed} ` +
      `already-clean=${summary.alreadyClean} mixed=${summary.heterogeneous} skipped=${summary.skipped} errors=${summary.errors}` +
      (summary.errors ? ' (unstamped — retries next boot)' : ''));
    return summary;
  } catch (e) {
    console.warn('[sp-emd-refolder] pass error:', e.message);
    return { ...summary, errors: summary.errors + 1, skippedReason: 'error' };
  }
}

let _kicked = false;
/** Boot hook: schedule the one-shot shortly after start; never blocks boot. */
function kickoff() {
  if (_kicked) return;
  _kicked = true;
  const t = setTimeout(() => { refolderEmdOnce().catch(() => {}); }, 45000);
  if (t.unref) t.unref();
}

module.exports = { refolderEmdOnce, kickoff, topCategoryFolder, STATE_KEY, _internals: { emdCategory, MAX_DOCS } };
