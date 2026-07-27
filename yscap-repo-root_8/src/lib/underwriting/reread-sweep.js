'use strict';
/**
 * UN-FUNDED RE-READ SWEEP (owner decision 2026-07-27, docs/FINDINGS-CLEANUP-SPEC.md).
 *
 * THE GAP THIS CLOSES. Fixing the document READER does not retroactively re-read a file that was
 * already analysed. So every extraction-level fix in the findings cleanup — the liquidity
 * double-count, the credit XML parse, the appraisal rural/transfer/unit-count reads, the OFAC
 * watch-list + cleared-fraud deep reads — lands INVISIBLE on existing files until something
 * re-runs them. The owner kept reviewing files and re-reporting problems that were fixed days
 * earlier, because the screen was showing the OLD read (a 7/23 finding on a file the code fixed on
 * 7/26). This sweep is that missing "re-run": it walks every ALIVE, not-yet-funded file and
 * re-reads its documents with the current reader.
 *
 * WHAT IT DOES / DOES NOT DO (the owner's requirement #5, verbatim: "it re-reads and re-records; it
 * does NOT clear a condition, move a status, or notify a borrower"):
 *   ✓ re-reads each document via the route's own analyzeOneDocument(force:true) — the exact paid
 *     pipeline the /auto-read button uses, so extraction + the deterministic checks + findings are
 *     recomputed and re-recorded with the improved reader. `force` is REQUIRED: the reusable-
 *     extraction cache is keyed on the analyzer version, and the fixes went into the deterministic
 *     checks (not the three cache-keyed extraction artifacts), so a non-forced read would just
 *     return the stale cached extraction + its stale findings.
 *   ✗ NEVER clears/opens/reopens a checklist condition, NEVER moves a status, NEVER sends a
 *     borrower or staff notification. analyzeOneDocument with actorId:null writes only extractions +
 *     document_findings (+ ensures the internal staff-only underwriting gate exists) — nothing
 *     borrower-facing. The compute-fresh layer (dedupe, guideline retraction, whole-loan run) runs
 *     on the next panel load, so a freshly re-read file shows the corrected findings when opened.
 *
 * THE FIVE REQUIREMENTS the owner set for the sweep itself (a portfolio-wide re-read is the single
 * most expensive thing this system can do), and how each is met:
 *   1. BOUNDED + RESUMABLE with a durable cursor — the per-file `generation` stamp
 *      (underwriting_reread_state, db/332) IS the cursor: a stamped file drops out of the selection,
 *      so a restart resumes on the next un-stamped file, never re-walking the book.
 *   2. PER-FILE SPEND respects the existing costMeter cap — allowSpend() is consulted before each
 *      file AND before each document, so one big file cannot blow past AI_PER_FILE_CAP_USD.
 *   3. IDEMPOTENT — a file already stamped at the current REREAD_GENERATION is skipped, so re-running
 *      the sweep on a file that already got the new result is a no-op.
 *   4. OFF-SWITCH by env (UNDERWRITING_REREAD_SWEEP_DISABLED=1) + an admin trigger, so it can be
 *      stopped/kicked without a deploy. NOTE: the AUTOMATIC cadence rides the notification-digests
 *      dispatcher, so setting NOTIFY_DIGESTS_ENABLED=0 also stops the automatic sweep (the admin
 *      "run now" trigger still works). The sweep itself notifies no one; this is only a scheduler
 *      coupling.
 *   5. RE-READS + RE-RECORDS only (see above).
 *
 * BUMPING THE GENERATION. REREAD_GENERATION is a CODE constant on purpose (not env): bumping it is a
 * deliberate part of shipping a reader/extraction fix that needs the whole un-funded book re-read.
 * Every file falls below the new number exactly once, is re-read, and is stamped back up — so one
 * bump = one controlled portfolio pass, and nothing re-bills until the next bump.
 */
const db = require('../../db');
const costMeter = require('../ai/cost-meter');

// The reader generation this build ships. BUMP by 1 whenever a reader/extraction fix ships that
// needs the whole un-funded book re-read (and say so in the commit). Generation 1 covers the
// 2026-07-27 findings-cleanup reader fixes (liquidity / credit / appraisal / OFAC+fraud deep reads).
const REREAD_GENERATION = 1;

const STATE_KEY = 'underwriting_reread_sweep';
// A small default slice per tick — the sweep is a slow background catch-up, not a race. Bounded so a
// tick stays well under the per-file AI cap and leaves the live desk responsive. Tunable by env.
const BATCH_FILES_DEFAULT = Math.max(1, parseInt(process.env.UNDERWRITING_REREAD_BATCH_FILES || '5', 10) || 5);
// A file that is FUNDED is done (never re-bill it) and one that is DEAD (withdrawn/declined/
// cancelled) is equally done — re-reading it spends real vendor money on a deal nobody is working.
// So the sweep covers files that are ALIVE and not yet funded (the owner's scope, verbatim:
// "everything that is not funded yet"). If dead files are ever wanted too, this is the one line.
const ALIVE_UNFUNDED_SQL = `a.deleted_at IS NULL AND a.status NOT IN ('funded','withdrawn','declined','cancelled')`;

function enabled() { return process.env.UNDERWRITING_REREAD_SWEEP_DISABLED !== '1'; }

// In-process guard so two overlapping slices — the dispatcher tick meeting an admin "run now" kick,
// or two admin clicks — cannot both select the SAME un-stamped files and re-read (double-bill) them
// before either stamps (the stamp lands only after a file's whole batch is read). Both callers live
// in the one web process, so a boolean covers the realistic race. (Cross-instance scale-out could
// still race one file in a narrow window; the per-file cost cap + generation stamp bound the cost to
// at most one duplicate read of one file, and it self-heals on the next pass.)
let _running = false;

/** True when BOTH the OCR reader and the AI analyzer are configured — never make a paid call we
 *  cannot fulfil. Guarded so a missing module during a partial deploy is treated as "off". */
function readerConfigured() {
  try {
    const docint = require('../ai/docint');
    const azureOpenai = require('../ai/azure-openai');
    return !!(docint.configured() && azureOpenai.available());
  } catch (_) { return false; }
}

async function loadState() {
  try {
    const r = await db.query(`SELECT value FROM sync_runtime_state WHERE key=$1`, [STATE_KEY]);
    return (r.rows[0] && r.rows[0].value) || null;
  } catch (_) { return null; }
}
async function saveState(value) {
  try {
    await db.query(
      `INSERT INTO sync_runtime_state (key, value, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
      [STATE_KEY, JSON.stringify(value)]);
  } catch (_) { /* a lost progress note only means the admin screen is stale — never fatal */ }
}

/** Stamp a file as re-read at the current generation (the durable cursor + idempotency record). */
async function stampFile(appId, { generation = REREAD_GENERATION, docsRead = 0, lastError = null } = {}) {
  try {
    await db.query(
      `INSERT INTO underwriting_reread_state (application_id, generation, docs_read, last_error, last_read_at, updated_at)
         VALUES ($1,$2,$3,$4, now(), now())
       ON CONFLICT (application_id) DO UPDATE
         SET generation=EXCLUDED.generation, docs_read=EXCLUDED.docs_read,
             last_error=EXCLUDED.last_error, last_read_at=now(), updated_at=now()`,
      [appId, generation, docsRead, lastError ? String(lastError).slice(0, 300) : null]);
  } catch (e) { console.error('[reread-sweep] stamp failed', appId, e && e.message); }
}

/** How many alive, un-funded files still need a re-read at the current generation. Never throws. */
async function pendingCount() {
  try {
    const r = await db.query(
      `SELECT count(*)::int AS n
         FROM applications a
         LEFT JOIN underwriting_reread_state s ON s.application_id = a.id
        WHERE ${ALIVE_UNFUNDED_SQL} AND COALESCE(s.generation, 0) < $1`, [REREAD_GENERATION]);
    return r.rows[0].n;
  } catch (_) { return null; }
}

/**
 * Re-read ONE file. Returns { attempted, docsRead, lastError }.
 * `deps` is injectable for tests (defaults to the live route + costMeter):
 *   uw         — { AUTOREAD_ENABLED, AUTOREAD_MAX_PER_CALL, fileForById, fileDocById,
 *                  buildAutoReadQueue, analyzeOneDocument }
 *   costAllow  — async (appId) => boolean
 *   force      — passed to analyzeOneDocument (default true; MUST be true to bypass the extraction cache)
 */
async function rereadFileOnce(appId, deps = {}) {
  const uw = deps.uw || require('../../routes/underwriting');
  const costAllow = deps.costAllow || ((id) => costMeter.allowSpend(id));
  const force = deps.force !== false;

  const app = await uw.fileForById(appId);
  // A file that vanished/was deleted between selection and now — stamp it so the sweep does not keep
  // selecting a ghost, and move on (the ON DELETE CASCADE would have removed the stamp anyway).
  if (!app) return { attempted: false, docsRead: 0, lastError: 'file_gone', skip: true };

  // Cost gate BEFORE spending a cent on this file.
  if (!(await costAllow(appId))) {
    await stampFile(appId, { generation: REREAD_GENERATION, docsRead: 0, lastError: 'cost_cap_reached' });
    return { attempted: false, docsRead: 0, lastError: 'cost_cap_reached' };
  }

  // The RE-READ queue: every current, readable document on the file — INCLUDING ones already read
  // (that is the whole point; the normal auto-reader skips those). Bounded by the route's own cap.
  const queue = await uw.buildAutoReadQueue(app, { includeAnalyzed: true });
  const batch = queue.slice(0, uw.AUTOREAD_MAX_PER_CALL);
  let docsRead = 0, lastError = null;
  for (const item of batch) {
    // Re-check the cap per document so a file with many documents cannot walk past it mid-file.
    if (!(await costAllow(appId))) { lastError = 'cost_cap_reached'; break; }
    let doc;
    try { doc = await uw.fileDocById(app, item.id); } catch (_) { doc = null; }
    if (!doc) continue;
    try {
      // actorId:null → no audit-as-a-person; suppressNotify:true → re-record WITHOUT re-firing the
      // "new fatal finding" staff/admin email (these findings are not new to the humans, and a
      // portfolio-wide re-read would otherwise bombard every team); force → a genuine re-read that
      // re-runs the improved reader + checks instead of returning the cached stale extraction.
      // analyzeOneDocument contains its own errors and RETURNS {ok:false,error} — inspect it so a
      // failed read is not counted as read (observability), and surface the first error.
      const r = await uw.analyzeOneDocument(app, doc, item.expectedType, { actorId: null, force, suppressNotify: true });
      if (r && r.ok) docsRead += 1;
      else if (r && r.error && !lastError) lastError = r.error;
    } catch (e) {
      // A truly unexpected throw (analyzeOneDocument normally returns rather than throws). The file is
      // still stamped below so it is not retried forever within this generation.
      if (!lastError) lastError = (e && e.message) ? String(e.message).slice(0, 200) : 'analyze_threw';
      console.error('[reread-sweep] doc failed', appId, item.id, e && e.message);
    }
  }
  await stampFile(appId, { generation: REREAD_GENERATION, docsRead, lastError });
  return { attempted: true, docsRead, lastError };
}

/**
 * Do ONE bounded slice of the sweep. Returns a small progress object. Never throws.
 * opts: { batchFiles, force, uw, costAllow, readerOn }  (all injectable for tests)
 */
async function sweepOnce(opts = {}) {
  if (!enabled()) return { skipped: 'disabled' };
  const uw = opts.uw || require('../../routes/underwriting');
  if (!uw.AUTOREAD_ENABLED) return { skipped: 'autoread_disabled' };
  const readerOn = opts.readerOn != null ? opts.readerOn : readerConfigured();
  if (!readerOn) return { skipped: 'reader_off' };
  // Refuse to run a second slice concurrently (see _running note above) — a double-bill guard.
  if (_running) return { skipped: 'already_running' };
  _running = true;
  try {
    const batchFiles = Math.max(1, opts.batchFiles || BATCH_FILES_DEFAULT);
    let targets;
    try {
      targets = await db.query(
        `SELECT a.id
           FROM applications a
           LEFT JOIN underwriting_reread_state s ON s.application_id = a.id
          WHERE ${ALIVE_UNFUNDED_SQL} AND COALESCE(s.generation, 0) < $1
          -- Oldest file first + a total tie-break on the id, so an unordered LIMIT can never let a
          -- file be perpetually passed over (the same discipline as the digest/auto-read sweeps).
          ORDER BY a.created_at ASC, a.id
          LIMIT $2`, [REREAD_GENERATION, batchFiles]);
    } catch (e) {
      console.error('[reread-sweep] select failed', e && e.message);
      return { skipped: 'select_failed' };
    }

    let filesRead = 0, docsTotal = 0, capped = 0, errors = 0;
    for (const row of targets.rows) {
      try {
        const r = await rereadFileOnce(row.id, { uw, costAllow: opts.costAllow, force: opts.force });
        if (r.attempted) { filesRead += 1; docsTotal += r.docsRead; }
        if (r.lastError === 'cost_cap_reached') capped += 1;
      } catch (e) { errors += 1; console.error('[reread-sweep] file failed', row.id, e && e.message); }
    }

    const remaining = await pendingCount();
    const done = remaining === 0;
    await saveState({
      generation: REREAD_GENERATION,
      lastRunAt: new Date().toISOString(),
      lastFilesRead: filesRead, lastDocsRead: docsTotal, lastCapped: capped, lastErrors: errors,
      remaining, done,
    });
    return { generation: REREAD_GENERATION, filesRead, docsRead: docsTotal, capped, errors, remaining, done };
  } finally {
    _running = false;
  }
}

/** Progress for the admin screen — never throws. */
async function status() {
  const st = await loadState();
  const remaining = await pendingCount();
  return {
    enabled: enabled(),
    readerOn: readerConfigured(),
    generation: REREAD_GENERATION,
    remaining,
    done: remaining === 0,
    lastRunAt: (st && st.lastRunAt) || null,
    lastFilesRead: (st && st.lastFilesRead) || 0,
    lastDocsRead: (st && st.lastDocsRead) || 0,
    lastCapped: (st && st.lastCapped) || 0,
    lastErrors: (st && st.lastErrors) || 0,
  };
}

module.exports = {
  sweepOnce, rereadFileOnce, status, pendingCount, stampFile,
  enabled, readerConfigured,
  REREAD_GENERATION, STATE_KEY, BATCH_FILES_DEFAULT, ALIVE_UNFUNDED_SQL,
};
