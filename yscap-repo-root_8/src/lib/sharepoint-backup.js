/**
 * STATUS: RESEARCH SPIKE (2026-07-12) — verified end-to-end but NOT wired into
 * server boot and OFF by default. Do not treat as final; the shape (folder
 * target, sync model, backfill) is still under discussion. See
 * docs/SHAREPOINT-INTEGRATION-RESEARCH.md §10–11.
 *
 * SharePoint backup reconciler — APPEND-ONLY, best-effort, out-of-band.
 *
 * Instead of editing the ~8 upload call sites, this is a single central
 * chokepoint: it scans `documents` for rows not yet mirrored to SharePoint and
 * copies each one's bytes (read from primary local storage) up to a dedicated,
 * clearly-labeled backup tree. Because it reconciles the whole table, it covers
 * EVERY upload surface (borrower/staff/chat/track-record) AND both previous and
 * future files — no hot-path change, and an upload never depends on SharePoint.
 *
 * Nothing here deletes/moves/renames/overwrites SharePoint. See sharepoint.js
 * and docs/SHAREPOINT-POLICY.md.
 *
 * Self-gated: does nothing unless SHAREPOINT_BACKUP_ENABLED=1 and the MS_* Graph
 * creds are present.
 */
const cfg = require('../config');
const db = require('../db');
const storage = require('./storage');
const sp = require('./sharepoint');

const MAX_ATTEMPTS = 5;          // stop retrying a doc that keeps failing
const DEFAULT_BATCH = 25;

function enabled() {
  return !!cfg.sharepointBackupEnabled && sp.configured();
}

/**
 * Canonical backup folder path for a document: officer / borrower / loan.
 * Pure function of the joined row — safe to unit-test. Every part falls back so
 * a sparse row still gets a deterministic, non-empty path.
 */
function buildFolderSegments(row) {
  const officer = (row.officer_name && row.officer_name.trim())
               || (row.loan_officer_name && row.loan_officer_name.trim())
               || 'Unassigned Officer';
  const borrower = [row.borrower_last, row.borrower_first].filter(Boolean).join(', ').trim()
               || 'Unknown Borrower';
  const loan = (row.address_one_line && row.address_one_line.trim())
            || (row.ys_loan_number && String(row.ys_loan_number).trim())
            || (row.application_id ? `Application ${String(row.application_id).slice(0, 8)}` : null)
            || `Borrower ${String(row.borrower_id || '').slice(0, 8)}`;
  return [officer, borrower, loan];
}

// A unique, human-readable filename that can never overwrite an existing item.
function backupFilename(row) {
  const base = String(row.filename || 'file').replace(/[\\/]+/g, '_');
  return `${String(row.id).slice(0, 8)}__${base}`;
}

// Select documents that still need mirroring. Only local-stored docs with a ref,
// under the retry cap, are eligible.
async function pendingBatch(limit) {
  const { rows } = await db.query(
    `SELECT d.id, d.filename, d.content_type, d.storage_provider, d.storage_ref,
            d.application_id, d.borrower_id,
            a.ys_loan_number,
            a.loan_officer_name,
            a.property_address->>'oneLine'                    AS address_one_line,
            su.full_name                                      AS officer_name,
            b.first_name                                      AS borrower_first,
            b.last_name                                       AS borrower_last
       FROM documents d
       LEFT JOIN applications a ON a.id = d.application_id
       LEFT JOIN staff_users  su ON su.id = a.loan_officer_id
       LEFT JOIN borrowers    b  ON b.id = d.borrower_id
      WHERE d.sharepoint_backed_up_at IS NULL
        AND d.storage_ref IS NOT NULL
        AND COALESCE(d.storage_provider, 'local') = 'local'
        AND d.sharepoint_backup_attempts < $2
      ORDER BY d.created_at ASC
      LIMIT $1`,
    [limit, MAX_ATTEMPTS],
  );
  return rows;
}

async function backupRow(row) {
  // Read the bytes from primary (local) storage.
  const buf = await storage.read(row.storage_ref);
  const saved = await sp.save(buf, {
    filename: backupFilename(row),
    folderSegments: buildFolderSegments(row),
  });
  await db.query(
    `UPDATE documents
        SET sharepoint_backup_ref = $2,
            sharepoint_web_url = $3,
            sharepoint_backed_up_at = now(),
            sharepoint_backup_error = NULL,
            sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
            sharepoint_backup_attempted_at = now()
      WHERE id = $1`,
    [row.id, saved.ref, saved.webUrl],
  );
  return saved;
}

async function recordFailure(row, err) {
  await db.query(
    `UPDATE documents
        SET sharepoint_backup_error = $2,
            sharepoint_backup_attempts = sharepoint_backup_attempts + 1,
            sharepoint_backup_attempted_at = now()
      WHERE id = $1`,
    [row.id, String(err && err.message || err).slice(0, 500)],
  );
}

/**
 * One reconciliation pass. Returns { backedUp, failed, scanned }.
 * Never throws for a single doc — failures are recorded and the pass continues.
 */
async function runOnce({ limit = DEFAULT_BATCH } = {}) {
  if (!enabled()) return { skipped: true, backedUp: 0, failed: 0, scanned: 0 };
  const rows = await pendingBatch(limit);
  let backedUp = 0, failed = 0;
  for (const row of rows) {
    try { await backupRow(row); backedUp++; }
    catch (e) {
      failed++;
      try { await recordFailure(row, e); } catch (_) { /* best-effort */ }
      console.warn(`[sp-backup] doc ${row.id} failed: ${e.message}`);
    }
  }
  if (rows.length) console.log(`[sp-backup] pass: scanned ${rows.length}, backed up ${backedUp}, failed ${failed}`);
  return { backedUp, failed, scanned: rows.length };
}

let _timer = null;
function start() {
  if (_timer) return;
  if (!enabled()) {
    console.log('[sp-backup] disabled (set SHAREPOINT_BACKUP_ENABLED=1 and MS_* creds to enable)');
    return;
  }
  const ms = Math.max(30, cfg.sharepointBackupPollSec) * 1000;
  console.log(`[sp-backup] enabled — reconciling every ${ms / 1000}s into "${cfg.sharepointBackupRoot}"`);
  const tick = () => runOnce().catch(e => console.warn('[sp-backup] pass error:', e.message));
  _timer = setInterval(tick, ms);
  if (_timer.unref) _timer.unref();
  tick(); // kick one immediately
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, runOnce, buildFolderSegments, backupFilename, enabled };
