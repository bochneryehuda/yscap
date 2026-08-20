'use strict';
/**
 * ONE-SHOT: put every document currently carrying a `source-suspect` verdict back
 * in front of the integrity audit, so the FIXED content sniffer can re-judge it.
 *
 * WHY THIS EXISTS (owner-reported 2026-08-20, "we're getting this lately a lot"):
 * `upload-bytes.sniffKind` ran its tolerant "%PDF anywhere in the first 1KB" scan
 * BEFORE the anchored ZIP signature. Our own ZIP writer stores members
 * UNCOMPRESSED (lib/zip.js is STORE-only on purpose — its members are already-
 * compressed PDFs), so the first member's raw "%PDF" sits about seventy bytes
 * into the file. Every TPR export whose first document is a PDF therefore sniffed
 * as a PDF, and the audit reported a perfectly good package PILOT had just built
 * as "the FILE ITSELF appears corrupted (content is pdf, not zip)". The sniffer is
 * fixed; this is the other half of the standing "previous AND future" rule.
 *
 * WHY IT ONLY CLEARS THE STAMP AND RE-JUDGES NOTHING ITSELF. It would be easy to
 * re-read the bytes here and decide — and wrong: there would then be TWO places
 * that judge a document's content, and the one that drifts is the one that leaks.
 * Clearing `sharepoint_verified_at` puts the row at the head of the audit's own
 * queue (its selector orders NULLS FIRST), and the audit re-judges it with every
 * guard it already has — remote comparison included. A row that really IS damaged
 * is simply re-stamped `source-suspect`, and `queueReview` dedupes on the open
 * card, so nobody is re-emailed about a card they already have (and a dismissal
 * still sticks).
 *
 * WHY ONE-SHOT, MARKER-GUARDED. Clearing the stamp unconditionally on every boot
 * would loop forever: clear -> audit stamps -> clear again. The marker records a
 * completed pass, exactly like sharepoint-emd-refolder's. Off with
 * SP_SOURCE_SUSPECT_RECHECK_DISABLED=1.
 */
const dbDefault = require('../db');

const STATE_KEY = 'sp_source_suspect_recheck_v1';
const BATCH = Math.max(1, parseInt(process.env.SP_SOURCE_SUSPECT_RECHECK_BATCH || '500', 10) || 500);

function disabled() { return process.env.SP_SOURCE_SUSPECT_RECHECK_DISABLED === '1'; }

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

/**
 * Returns {skipped:true} when it has already run (or is switched off), else a
 * summary of what it re-queued. NEVER throws — a boot pass may not break boot.
 */
async function recheckSourceSuspectOnce({ db = dbDefault } = {}) {
  if (disabled()) return { skipped: true, reason: 'disabled' };
  try {
    if (await readMarker(db)) return { skipped: true, reason: 'already_ran' };

    // Only a MIRRORED row can carry an integrity verdict, and only a row whose
    // stamp we clear can be re-judged. Bounded so one pass can never issue an
    // unbounded UPDATE against the whole documents table.
    const r = await db.query(
      `UPDATE documents SET sharepoint_verified_at = NULL
        WHERE id IN (
          SELECT id FROM documents
           WHERE sharepoint_backup_ref IS NOT NULL
             AND sharepoint_integrity LIKE 'source-suspect%'
             AND sharepoint_verified_at IS NOT NULL
           ORDER BY sharepoint_verified_at DESC
           LIMIT $1)
        RETURNING id`, [BATCH]);

    const requeued = r.rows.length;
    // A full batch means there may be more than one pass' worth. Say so rather
    // than stamping "done" over a silent truncation — the marker is only written
    // once the set is genuinely drained, so the next boot finishes the job.
    const more = requeued === BATCH;
    if (!more) await stampMarker(db, { requeued });
    if (requeued) {
      console.log(`[sp-source-suspect] re-queued ${requeued} document(s) for a fresh integrity read`
        + `${more ? ' (a full batch — the next boot continues)' : ''}`);
    } else {
      console.log('[sp-source-suspect] nothing carried a source-suspect verdict — nothing to re-check');
    }
    return { requeued, more, done: !more };
  } catch (e) {
    console.warn('[sp-source-suspect] re-check pass skipped:', e.message);
    return { skipped: true, reason: 'error', error: e.message };
  }
}

module.exports = { recheckSourceSuspectOnce, STATE_KEY, _internals: { readMarker, stampMarker } };
