/**
 * ClickUp sync worker. Four loops, all gated by cfg.clickupSyncEnabled:
 *   pushOutbox   — drain sync_queue outbound jobs → orchestrator.pushApplication
 *   processInbox — drain clickup_webhook_inbox → ingest (with materialization gate)
 *   reconcile    — periodic filtered poll to catch missed webhooks + hot duplicates
 *   backfill     — one-shot historical ingest of every Pipeline task (paced)
 *
 * Everything is idempotent and keyed on task_id, so re-runs are safe.
 */
const db = require('../db');
const cfg = require('../config');
const clickup = require('../clickup/client');
const registry = require('../clickup/registry');
const ingest = require('../clickup/ingest');
const orchestrator = require('../clickup/orchestrator');
const identity = require('../clickup/identity');
const mapper = require('../clickup/mapper');
const routing = require('../clickup/routing');
const statusMap = require('../clickup/status');

const PIPELINE_FOLDERS = () => {
  const f = new Set();
  for (const o of Object.values(routing.LOAN_OFFICERS)) if (o.pipeline) f.add(o.pipeline);
  for (const p of Object.values(routing.PROCESSORS)) if (p.pipeline) f.add(p.pipeline);
  f.add(routing.LEAD_CAPTURE_FOLDER);
  return [...f];
};

// A task is "real enough" to materialize a portal file: >=2 identity fields and
// past the scratch statuses. (§4.3/§4.4)
const SCRATCH = new Set(['starting', 'prospect / pricing']);
function canMaterialize(read) {
  const idObj = ingest.identityFrom(read);
  if (!identity.canMaterialize(idObj)) return false;
  if (SCRATCH.has(String(read.internalStatus || '').trim().toLowerCase())) return false;
  return true;
}

async function optionMap() {
  // any Pipeline list carries the space-level dropdown options
  try {
    const folder = PIPELINE_FOLDERS()[0];
    const listId = await orchestrator.firstListId(folder);
    return await registry.optionMap(listId);
  } catch { return registry.peek(); }
}

// ---- outbound (portal → ClickUp) -----------------------------------------
async function pushOutboxOnce() {
  const r = await db.query(
    `UPDATE sync_queue SET status='processing', updated_at=now()
      WHERE id = (SELECT id FROM sync_queue WHERE target='clickup' AND direction='push'
                   AND status='queued' AND run_after <= now() ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`);
  const job = r.rows[0];
  if (!job) return false;
  try {
    if (job.entity_type === 'application') await orchestrator.pushApplication(job.entity_id, { force: true });
    await db.query(`UPDATE sync_queue SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
  } catch (e) {
    const attempts = job.attempts + 1;
    const dead = attempts >= 8;
    const backoff = Math.min(2 ** attempts, 3600);
    await db.query(
      `UPDATE sync_queue SET status=$1, attempts=$2, last_error=$3, run_after=now()+($4||' seconds')::interval, updated_at=now() WHERE id=$5`,
      [dead ? 'dead' : 'queued', attempts, String(e.message).slice(0, 500), backoff, job.id]);
  }
  return true;
}

// ---- dirty sweep (portal edits → ClickUp, no write-path wiring needed) -----
// Pushes any RTL / already-linked application whose updated_at is newer than its
// last sync (10s debounce lets rapid edits settle). Because ingest sets
// updated_at and clickup_last_synced_at together, pulled changes never look
// dirty — so this cannot loop.
async function sweepDirtyOnce() {
  const r = await db.query(
    `SELECT a.id FROM applications a
      WHERE a.deleted_at IS NULL
        AND a.sync_state NOT IN ('manual_review','descoped')
        AND (a.clickup_pipeline_task_id IS NOT NULL OR a.program IN ('Fix & Flip w/ Construction','Bridge','Ground-Up Construction'))
        AND (a.clickup_last_synced_at IS NULL OR a.updated_at > a.clickup_last_synced_at + interval '10 seconds')
      ORDER BY a.updated_at LIMIT 5`);
  let n = 0;
  for (const row of r.rows) {
    try { await orchestrator.pushApplication(row.id, { force: true }); n++; }
    catch (e) { console.error('[clickup-sync] push dirty', row.id, e.message); }
  }
  return n > 0;
}

// ---- inbound (ClickUp → portal) ------------------------------------------
async function processInboxOnce() {
  const r = await db.query(
    `UPDATE clickup_webhook_inbox SET status='processing'
      WHERE id = (SELECT id FROM clickup_webhook_inbox WHERE status='received'
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  const row = r.rows[0];
  if (!row) return false;
  try {
    if (row.task_id) await ingestOne(row.task_id);
    await db.query(`UPDATE clickup_webhook_inbox SET status='done', processed_at=now() WHERE id=$1`, [row.id]);
  } catch (e) {
    const attempts = row.attempts + 1;
    await db.query(`UPDATE clickup_webhook_inbox SET status=$1, attempts=$2, last_error=$3 WHERE id=$4`,
      [attempts >= 6 ? 'error' : 'received', attempts, String(e.message).slice(0, 500), row.id]);
  }
  return true;
}

/** Fetch + ingest a single task by id, applying the materialization gate. */
async function ingestOne(taskId) {
  const task = await clickup.getTask(taskId, { include: ['custom_fields'] });
  const options = await optionMap();
  const read = mapper.readTaskFields(task, options);
  const createFile = canMaterialize(read);
  return ingest.ingestTask(task, options, { createFile });
}

// ---- reconciliation poll --------------------------------------------------
let _watermark = 0;
async function reconcileOnce() {
  const options = await optionMap();
  const since = _watermark || (Date.now() - 24 * 3600 * 1000);
  const res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, {
    folderIds: PIPELINE_FOLDERS(), includeClosed: true, dateUpdatedGt: since, subtasks: true,
  });
  const tasks = (res && res.tasks) || [];
  for (const t of tasks) {
    try {
      const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
      const read = mapper.readTaskFields(full, options);
      await ingest.ingestTask(full, options, { createFile: canMaterialize(read) });
    } catch (e) { console.error('[clickup] reconcile task failed', t.id, e.message); }
  }
  _watermark = Date.now();
  return tasks.length;
}

// ---- historical backfill (one-shot, paced) --------------------------------
async function runBackfill({ createFiles = true, pageLimit = 1000 } = {}) {
  const options = await optionMap();
  let total = 0;
  for (const folder of PIPELINE_FOLDERS()) {
    for (let page = 0; page < pageLimit; page++) {
      let res;
      try { res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, { folderIds: [folder], includeClosed: true, page, subtasks: true }); }
      catch (e) { console.error('[backfill] page failed', folder, page, e.message); break; }
      const tasks = (res && res.tasks) || [];
      if (!tasks.length) break;
      for (const t of tasks) {
        try {
          const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
          const read = mapper.readTaskFields(full, options);
          await ingest.ingestTask(full, options, { createFile: createFiles && canMaterialize(read) });
          total++;
        } catch (e) { console.error('[backfill] task failed', t.id, e.message); }
      }
      if (tasks.length < 100) break; // last page
    }
  }
  console.log(`[backfill] ingested ${total} tasks`);
  return total;
}

// ---- loops ----------------------------------------------------------------
function start() {
  if (!cfg.clickupSyncEnabled) { console.log('[clickup-sync] disabled (CLICKUP_SYNC_ENABLED!=1)'); return; }
  console.log('[clickup-sync] worker started');
  const tick = async (fn, name) => { try { while (await fn()) { /* drain */ } } catch (e) { console.error(`[clickup-sync] ${name}`, e.message); } };
  setInterval(() => tick(pushOutboxOnce, 'push'), 4000);
  setInterval(() => tick(sweepDirtyOnce, 'dirty'), 8000);
  setInterval(() => tick(processInboxOnce, 'inbox'), 4000);
  setInterval(() => { reconcileOnce().catch((e) => console.error('[clickup-sync] reconcile', e.message)); }, (cfg.clickupPollSec || 300) * 1000);
}

module.exports = { start, pushOutboxOnce, sweepDirtyOnce, processInboxOnce, ingestOne, reconcileOnce, runBackfill, canMaterialize, PIPELINE_FOLDERS };
