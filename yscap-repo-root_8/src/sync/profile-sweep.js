/**
 * BORROWER-PROFILE SWEEP — read EVERY ClickUp card, in EVERY status, forever.
 *
 * WHY THIS EXISTS (owner-reported 2026-07-26): "a loan officer goes into his list
 * of borrowers and doesn't see all the borrowers that closed already with him —
 * DSCR files." db/318 made a borrower belong to their officer, and the sync
 * stamps that from every card it reads — but it was only ever reading a SLICE of
 * ClickUp:
 *
 *   • `reconcileOnce` polls with `date_updated_gt` (a rolling watermark). A deal
 *     that closed months ago is NEVER touched again, so its card never comes back
 *     in that window — it is invisible to the portal forever.
 *   • `runBackfill` is the only pass that walks everything, and it runs ONLY when
 *     someone sets the `CLICKUP_RUN_BACKFILL` env var and restarts the service.
 *     It is a manual one-shot, so in practice the historical book was never
 *     imported at all.
 *
 * So this is the missing third loop: a slow, resumable, self-driving sweep over
 * every pipeline folder and every page, with no date window, that keeps cycling.
 *
 * WHAT IT BUILDS (and deliberately does NOT build):
 *   ✓ the borrower PROFILE — name, email, phone, SSN, date of birth, home
 *     address, citizenship, employment, housing (ingest.resolveBorrower +
 *     healBorrowerFields, all FILL-ONLY: a real stored value is never overwritten)
 *   ✓ their ENTITIES — every distinct LLC name/EIN across all their cards
 *   ✓ their TRACK RECORD — the property address of every CLOSED/funded card
 *   ✓ the OFFICER relationship — `borrower_officers` (db/325), many-to-many, so
 *     every officer who ever closed with them can see the profile
 *   ✗ loan FILES. `createFile:false` on every call, always. The owner was
 *     explicit: "we don't need to start looking on the DSCR files for real
 *     files" — this gathers the PEOPLE, it never materializes a deal. An RTL
 *     card that already HAS a portal file still refreshes it (that is
 *     ingestTask's normal linked-file update path, unchanged).
 *
 * SAFETY: it is pure inbound. It cannot write to ClickUp, cannot create a file,
 * and cannot delete anything. Every page is bounded and the cursor is durable, so
 * a restart resumes instead of restarting the whole workspace.
 */
const db = require('../db');
const cfg = require('../config');
const switches = require('../lib/integrations/switches');
const clickup = require('../clickup/client');
const ingest = require('../clickup/ingest');

const STATE_KEY = 'clickup_profile_sweep';

// How much work one tick does. The sweep is a BACKGROUND catch-up, not a race —
// small slices keep it far under ClickUp's rate limit (the client's token bucket
// paces the calls anyway) and leave the live reconcile/webhook loops responsive.
const PAGES_PER_TICK = Math.max(1, parseInt(process.env.CLICKUP_PROFILE_SWEEP_PAGES || '3', 10) || 3);
// Once a full pass finishes, wait this long before starting the next cycle. The
// reconcile loop already handles anything that CHANGES; this deep pass exists to
// catch what never changes (old closed deals) and to heal gaps, so it is slow.
const CYCLE_DAYS = Math.max(1, parseInt(process.env.CLICKUP_PROFILE_SWEEP_CYCLE_DAYS || '7', 10) || 7);
// A pass that read ZERO cards and errored means ClickUp was unreachable, not
// that the workspace is empty — retry it in minutes rather than serving the
// full weekly rest, so one outage cannot stall the import for a week.
const FAILED_RETRY_MS = 15 * 60 * 1000;

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
  } catch (_) { /* a lost bookmark only means we re-walk — never fatal */ }
}

/** A fresh cursor at the start of the folder list. */
const freshCursor = (folders, cycle) => ({
  cycle, folderIdx: 0, page: 0, folders,
  startedAt: new Date().toISOString(), finishedAt: null,
  tasks: 0, profiles: 0, errors: 0,
});

/**
 * The closed-deal count per (borrower, officer). Recomputed from the task index
 * rather than incremented per task, because the same card is ingested many times
 * — a running counter could only ever drift. Display only; nothing gates on it.
 */
async function recountDeals() {
  try {
    await db.query(
      `UPDATE borrower_officers bo
          SET deals = COALESCE(x.n, 0)
         FROM (SELECT t.borrower_id, t.loan_officer_id,
                      count(*) FILTER (WHERE lower(btrim(coalesce(t.internal_status,''))) IN
                        ('closed reconciled','closed (6-email funded)','non del closed reconciled','refinanced',
                         'waiting for final docs','in purchase review','purchase conditions','pa issued-post closing.'))::int AS n
                 FROM clickup_task_index t
                WHERE t.borrower_id IS NOT NULL AND t.loan_officer_id IS NOT NULL
                GROUP BY t.borrower_id, t.loan_officer_id) x
        WHERE bo.borrower_id = x.borrower_id AND bo.staff_id = x.loan_officer_id
          AND bo.deals IS DISTINCT FROM COALESCE(x.n, 0)`);
  } catch (_) { /* best-effort */ }
}

/**
 * Do ONE bounded slice of the sweep. Returns a small progress object.
 * Safe to call concurrently-ish: the cursor is advanced after each page, so the
 * worst case of an overlap is re-ingesting a page (which is idempotent).
 */
async function sweepOnce({ pages = PAGES_PER_TICK, folders = null } = {}) {
  if (!switches.on('CLICKUP_SYNC_ENABLED')) return { skipped: 'sync_disabled' };
  if (process.env.CLICKUP_PROFILE_SWEEP_DISABLED === '1') return { skipped: 'disabled' };

  // Lazy-require so this module can be loaded (and unit-tested) without pulling
  // the whole sync worker graph.
  const worker = require('./clickup-sync');
  // SCOPE = THE WHOLE PIPELINE SPACE, not the routing folder list. The owner
  // asked for "every single file in ClickUp for every single status", and the
  // folder registry in routing.js is a hand-maintained map of CURRENT officers —
  // it deliberately EXCLUDES departed officers (whose past borrowers are still
  // the company's clients and may be re-assigned) and cannot know about a folder
  // created in ClickUp since the last deploy. Paging the space covers every
  // folder in it, including ones nobody has registered yet. The folder list stays
  // as the fallback if the space id is ever unset, and an explicit `folders`
  // argument still works for a targeted re-import.
  const scopes = (folders && folders.length)
    ? folders.map((id) => ({ kind: 'folder', id }))
    : (cfg.clickupPipelineSpace
      ? [{ kind: 'space', id: String(cfg.clickupPipelineSpace) }]
      : worker.PIPELINE_FOLDERS().map((id) => ({ kind: 'folder', id })));
  if (!scopes.length) return { skipped: 'no_folders' };
  const folderList = scopes.map((s) => `${s.kind}:${s.id}`);

  let st = await loadState();
  // Start a cycle when there is none, when the folder set changed (a new officer
  // folder must not wait a week to be walked), or when the rest period is over.
  const sameFolders = st && Array.isArray(st.folders) && st.folders.join(',') === folderList.join(',');
  if (!st || !sameFolders) {
    st = freshCursor(folderList, ((st && st.cycle) || 0) + 1);
  } else if (st.finishedAt) {
    // A pass that read NOTHING and errored did not really happen — ClickUp was
    // unreachable. Retry it in minutes, not after the full weekly rest, or one
    // transient outage would stall the whole import for a week.
    const restMs = st.failed ? FAILED_RETRY_MS : CYCLE_DAYS * 24 * 3600 * 1000;
    if (Date.now() - Date.parse(st.finishedAt) < restMs) {
      return { idle: true, cycle: st.cycle, finishedAt: st.finishedAt, failed: !!st.failed };
    }
    st = freshCursor(folderList, (st.cycle || 0) + 1);
  }

  const options = await worker.optionMapForSweep();
  let pagesDone = 0;

  while (pagesDone < pages && st.folderIdx < scopes.length) {
    const scope = scopes[st.folderIdx];
    let res;
    try {
      res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, {
        // include_closed is what makes this cover CLOSED / funded / cancelled
        // cards — exactly the history the officer's book was missing. No
        // date_updated filter: an old deal that never changes must still be read.
        ...(scope.kind === 'space' ? { spaceIds: [scope.id] } : { folderIds: [scope.id] }),
        includeClosed: true, subtasks: true, page: st.page,
      });
    } catch (e) {
      st.errors++;
      // A scope that errors must not wedge the sweep forever — move on and let
      // the next cycle retry it.
      console.error('[profile-sweep] page failed', scope.id, st.page, e && e.message);
      st.folderIdx++; st.page = 0; pagesDone++;
      await saveState(st);
      continue;
    }
    const tasks = (res && res.tasks) || [];
    for (const t of tasks) {
      try {
        const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
        // createFile:false ALWAYS — this sweep builds people, never deals.
        // folderId is left to the task's own `task.folder.id` when we are paging
        // a SPACE (a space page spans many officers' folders, so passing one
        // folder would mis-attribute every card to it).
        const out = await ingest.ingestTask(full, options, {
          createFile: false,
          ...(scope.kind === 'folder' ? { folderId: scope.id } : {}),
        });
        st.tasks++;
        if (out && out.borrowerId) st.profiles++;
      } catch (e) {
        st.errors++;
        console.error('[profile-sweep] task failed', t.id, e && e.message);
      }
    }
    pagesDone++;
    if (tasks.length < 100) { st.folderIdx++; st.page = 0; }   // last page of this folder
    else st.page++;
    await saveState(st);
  }

  if (st.folderIdx >= scopes.length && !st.finishedAt) {
    st.finishedAt = new Date().toISOString();
    // "Failed" = we finished the pass having read nothing, with errors. That is
    // an outage signature, and it earns a short retry instead of the weekly rest.
    st.failed = st.tasks === 0 && st.errors > 0;
    await saveState(st);
    if (!st.failed) await recountDeals();
    console.log(`[profile-sweep] cycle ${st.cycle} ${st.failed ? 'FAILED (ClickUp unreachable) — will retry shortly' : 'complete'} — ${st.tasks} cards read, ${st.profiles} profiles touched, ${st.errors} errors`);
  }
  return {
    cycle: st.cycle, folder: st.folderIdx, ofFolders: scopes.length,
    page: st.page, tasks: st.tasks, profiles: st.profiles, errors: st.errors,
    finishedAt: st.finishedAt, done: !!st.finishedAt, failed: !!st.failed,
  };
}

/** Progress for the admin screen — never throws. */
async function status() {
  const st = await loadState();
  if (!st) return { started: false, enabled: process.env.CLICKUP_PROFILE_SWEEP_DISABLED !== '1' };
  return {
    started: true, enabled: process.env.CLICKUP_PROFILE_SWEEP_DISABLED !== '1',
    cycle: st.cycle, folder: st.folderIdx, ofFolders: (st.folders || []).length,
    page: st.page, tasks: st.tasks, profiles: st.profiles, errors: st.errors,
    startedAt: st.startedAt, finishedAt: st.finishedAt, done: !!st.finishedAt,
    failed: !!st.failed,
  };
}

/** Force a brand-new cycle to begin on the next tick (admin "re-import now"). */
async function restart() {
  const st = await loadState();
  await saveState(freshCursor([], ((st && st.cycle) || 0) + 1));
  return { ok: true, cycle: ((st && st.cycle) || 0) + 1 };
}

module.exports = { sweepOnce, status, restart, recountDeals, STATE_KEY, _internals: { freshCursor } };
