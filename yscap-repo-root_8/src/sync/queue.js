/**
 * Sync worker — drains sync_queue and performs the real ClickUp writes
 * (contact task + loan-file task, dual-write PII, checklist status).
 * Runs on an interval; each row retried with backoff. Encompass/Graph
 * targets slot in here behind the same interface later.
 */
const db = require('../db');
const clickup = require('../clickup/client');
const { pipelineCustomFields, crmCustomFields } = require('../clickup/mapping');
const { getFolderLists } = require('../clickup/client');

// Resolve the first list inside a folder (files live in a list within the folder).
async function firstListId(folderId) {
  const r = await getFolderLists(folderId);
  return r && r.lists && r.lists[0] ? r.lists[0].id : null;
}

async function handleApplicationCreate(row) {
  const { intake, routing } = row.payload;
  const listId = await firstListId(routing.pipelineFolderId);
  if (!listId) throw new Error('no list in pipeline folder ' + routing.pipelineFolderId);

  const task = await clickup.createTask(listId, {
    name: `${intake.borrowerName || 'New Borrower'} — ${intake.program || 'Loan'}`,
    custom_fields: pipelineCustomFields(intake),
  });

  await db.query(
    `UPDATE applications SET clickup_pipeline_task_id=$1, sync_status='synced', updated_at=now()
      WHERE id=$2`, [task.id, row.entity_id]);
  return task.id;
}

async function tick() {
  // DEFENSIVE SCOPING (2026-07-12 audit): only ever claim the `op='create'` jobs
  // this legacy worker actually handles. Without the `op='create'` filter this
  // SELECT would grab the modern ClickUp scoped-push jobs (`op='update'`, drained
  // by src/sync/clickup-sync.js `pushOutboxOnce`), find no matching branch below,
  // and mark them `done` WITHOUT pushing — silently dropping outbound edits. This
  // worker is not started anymore (see src/server.js), but the filter guarantees
  // it can never steal another worker's jobs even if it is ever re-wired.
  const r = await db.query(
    `UPDATE sync_queue SET status='processing', updated_at=now()
      WHERE id = (SELECT id FROM sync_queue
                   WHERE status='queued' AND op='create' AND run_after <= now()
                   ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING *`);
  if (!r.rows[0]) return;
  const job = r.rows[0];
  try {
    if (job.entity_type === 'application' && job.op === 'create') {
      await handleApplicationCreate(job);
    }
    await db.query(`UPDATE sync_queue SET status='done', updated_at=now() WHERE id=$1`, [job.id]);
  } catch (e) {
    const attempts = job.attempts + 1;
    const backoff = Math.min(2 ** attempts, 3600); // seconds
    await db.query(
      `UPDATE sync_queue SET status='queued', attempts=$1, last_error=$2,
              run_after = now() + ($3 || ' seconds')::interval, updated_at=now()
        WHERE id=$4`, [attempts, e.message, backoff, job.id]);
  }
}

function start(intervalMs = 5000) {
  setInterval(() => { tick().catch(e => console.error('[sync] tick failed:', db.describeError(e))); }, intervalMs);
  console.log('[sync] worker started');
}

module.exports = { start, tick };
