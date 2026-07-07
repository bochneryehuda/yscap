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
    if (job.entity_type === 'application') {
      // Scoped push: the job carries the specific fields the edit changed
      // (payload.only). A queue job MUST name its fields — a job with no field
      // set (a legacy job enqueued before scoped push, or an empty set) is
      // skipped rather than pushed, so it can NEVER fall back to a full-payload
      // overwrite. Full pushes happen only via the explicit admin repush.
      const only = job.payload && Array.isArray(job.payload.only) ? job.payload.only.filter(Boolean) : [];
      if (only.length) await orchestrator.pushApplication(job.entity_id, { force: true, only });
    }
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
  // Go-live guard: when CLICKUP_OUTBOUND_SINCE is set, only push apps that are
  // already linked to a ClickUp task OR were created at/after the cutoff. This
  // stops the sweep from bulk-pushing the pre-existing portal backlog (which
  // would create duplicate ClickUp tasks). Empty cutoff = push everything dirty.
  const since = cfg.clickupOutboundSince || null;
  const r = await db.query(
    `SELECT a.id FROM applications a
      WHERE a.deleted_at IS NULL
        AND a.sync_state NOT IN ('manual_review','descoped')
        AND (a.clickup_pipeline_task_id IS NOT NULL OR a.program IN ('Fix & Flip w/ Construction','Bridge','Ground-Up Construction'))
        AND ($1::timestamptz IS NULL OR a.clickup_pipeline_task_id IS NOT NULL OR a.created_at >= $1::timestamptz)
        AND (a.clickup_last_synced_at IS NULL OR a.updated_at > a.clickup_last_synced_at + interval '3 seconds')
      ORDER BY a.updated_at LIMIT 12`, [since]);
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
  // Inbound new-file creation is gated (see cfg.clickupInboundCreateFiles) to
  // avoid duplicating an existing unlinked portal app; linked files still update.
  const createFile = cfg.clickupInboundCreateFiles && canMaterialize(read);
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
      await ingest.ingestTask(full, options, { createFile: cfg.clickupInboundCreateFiles && canMaterialize(read) });
    } catch (e) { console.error('[clickup] reconcile task failed', t.id, e.message); }
  }
  _watermark = Date.now();
  return tasks.length;
}

// ---- program reconcile (one-shot) -----------------------------------------
// Re-check every LINKED, non-descoped RTL file against its CURRENT ClickUp task
// program. If the program was changed to something we don't build yet (non-RTL,
// e.g. Short-Term Rehab → DSCR), ingestTask descopes it — removes it from the
// portal, ClickUp untouched. Bounded to already-linked files (cheap), idempotent
// (descoped files are excluded next run), and read-only against ClickUp. Catches
// the backlog of flips that predate the descope logic or that are older than the
// reconcile poll's rolling window. Never creates or deletes anything in ClickUp.
async function reconcileLinkedProgramsOnce() {
  const r = await db.query(
    `SELECT clickup_pipeline_task_id AS task_id FROM applications
      WHERE clickup_pipeline_task_id IS NOT NULL AND deleted_at IS NULL
        AND sync_state NOT IN ('descoped','manual_review')
      ORDER BY updated_at DESC`);
  let checked = 0, descoped = 0;
  for (const row of r.rows) {
    try {
      const res = await ingestOne(row.task_id);
      checked++;
      if (res && res.matchStatus === 'descoped') descoped++;
    } catch (e) { console.error('[clickup] reconcile-programs task failed', row.task_id, e.message); }
  }
  console.log(`[clickup-sync] reconcile-programs: checked ${checked} linked files, descoped ${descoped}`);
  return { checked, descoped };
}

// ---- historical backfill (one-shot, paced) --------------------------------
// folders: optional subset (e.g. one officer's pipeline folder for a self-serve
// re-sync); defaults to every configured pipeline folder.
async function runBackfill({ createFiles = true, pageLimit = 1000, folders = null } = {}) {
  const options = await optionMap();
  let total = 0;
  const folderList = (folders && folders.length) ? folders : PIPELINE_FOLDERS();
  for (const folder of folderList) {
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
          // folderId fallback: the per-folder loop knows the folder even if the
          // filtered task payload omits task.folder (officer resolution).
          await ingest.ingestTask(full, options, { createFile: createFiles && canMaterialize(read), folderId: folder });
          total++;
        } catch (e) { console.error('[backfill] task failed', t.id, e.message); }
      }
      if (tasks.length < 100) break; // last page
    }
  }
  console.log(`[backfill] ingested ${total} tasks`);
  // Verification summary (assignment + match outcomes) — no PII, safe to log.
  try {
    const s = await db.query(
      `SELECT count(*)::int linked, count(*) FILTER (WHERE loan_officer_id IS NOT NULL)::int assigned,
              count(DISTINCT loan_officer_id)::int distinct_officers
         FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`);
    const mi = await db.query(`SELECT match_status, count(*)::int n FROM clickup_task_index WHERE match_status IS NOT NULL GROUP BY match_status ORDER BY n DESC`);
    const st = await db.query(`SELECT status, count(*)::int n FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL GROUP BY status ORDER BY n DESC`);
    console.log('[backfill] linked apps:', JSON.stringify(s.rows[0]));
    console.log('[backfill] match_status:', JSON.stringify(mi.rows));
    console.log('[backfill] borrower-status spread:', JSON.stringify(st.rows));
  } catch (e) { console.error('[backfill] summary failed', e.message); }
  return total;
}

// ---- data audit (portal vs ClickUp coverage; assignment; completeness) ----
// Runs server-side from the DB (applications + clickup_task_index snapshots) and
// logs a masked report so data quality can be verified from the logs. Answers:
// who's unassigned, what's missing, which ClickUp fields we're NOT capturing,
// and what long-term (non-RTL) data we preserved.
async function auditData() {
  const q = (sql, p = []) => db.query(sql, p).then((r) => r.rows).catch((e) => [{ error: e.message }]);
  const out = {};
  out.filesPerOfficer = await q(
    `SELECT COALESCE(loan_officer_name,'(unassigned)') officer, count(*)::int n
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL
      GROUP BY 1 ORDER BY n DESC`);
  out.unassignedByFolder = await q(
    `SELECT clickup_folder_id, count(*)::int n FROM applications
      WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL AND loan_officer_id IS NULL
      GROUP BY 1 ORDER BY n DESC`);
  out.completeness = (await q(
    `SELECT count(*)::int total,
            count(*) FILTER (WHERE property_address IS NULL)::int no_address,
            count(*) FILTER (WHERE loan_amount IS NULL)::int no_loan_amount,
            count(*) FILTER (WHERE program IS NULL)::int no_program,
            count(*) FILTER (WHERE ys_loan_number IS NULL)::int no_ys_loan,
            count(*) FILTER (WHERE loan_officer_id IS NULL)::int no_officer,
            count(*) FILTER (WHERE internal_status IS NULL)::int no_status
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`))[0];
  out.topUnmappedFields = await q(
    `SELECT k AS field, count(*)::int n FROM clickup_task_index, LATERAL jsonb_object_keys(snapshot->'unmapped') k
      WHERE snapshot ? 'unmapped' GROUP BY k ORDER BY n DESC LIMIT 30`);
  out.nonRtlPrograms = await q(
    `SELECT COALESCE(program,'(none)') program, count(*)::int n FROM clickup_task_index
      WHERE kind='data_only' GROUP BY 1 ORDER BY n DESC LIMIT 30`);
  out.matchStatus = await q(`SELECT match_status, count(*)::int n FROM clickup_task_index WHERE match_status IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  out.ambiguous = await q(`SELECT task_id, task_name FROM clickup_task_index WHERE match_status='ambiguous' LIMIT 25`);
  out.snapshotsStored = (await q(`SELECT count(*)::int n FROM clickup_task_index WHERE snapshot IS NOT NULL`))[0];
  // ---- reconciliation diagnostics (portal vs ClickUp RTL SHORT MTM dashboard) ----
  // Raw ClickUp status distribution for the linked RTL files, so we can map the
  // portal's counts onto ClickUp's own dashboard buckets (which filter on raw
  // statuses / status-type) and reverse-engineer its 30-active / 96-funded rule.
  out.rtlInternalStatus = await q(
    `SELECT COALESCE(internal_status,'(none)') st, count(*)::int n FROM applications
      WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL GROUP BY 1 ORDER BY n DESC`);
  // Raw status of data_only (blank / non-RTL *Program) tasks. A FUNDED status here
  // is a likely "missing funded" the ClickUp RTL dashboard counts but the portal
  // skipped for lack of a recognized RTL program label.
  out.dataOnlyStatus = await q(
    `SELECT COALESCE(snapshot->>'status','(none)') st, count(*)::int n FROM clickup_task_index
      WHERE kind='data_only' GROUP BY 1 ORDER BY n DESC LIMIT 40`);
  // Hard proof the address fix landed: linked files whose property_address is the
  // NORMALIZED shape (has oneLine) vs still-raw vs blank.
  out.addressShape = (await q(
    `SELECT count(*) FILTER (WHERE property_address ? 'oneLine')::int normalized,
            count(*) FILTER (WHERE property_address IS NOT NULL AND NOT (property_address ? 'oneLine'))::int raw_or_other,
            count(*) FILTER (WHERE property_address IS NULL)::int none
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`))[0];
  // Funded files still awaiting an actual closing date (K1: the "funded, no date yet" bucket).
  out.fundedDateCoverage = (await q(
    `SELECT count(*) FILTER (WHERE status='funded')::int funded_total,
            count(*) FILTER (WHERE status='funded' AND actual_closing IS NULL)::int funded_no_date,
            count(*) FILTER (WHERE status='funded' AND actual_closing IS NOT NULL)::int funded_dated
       FROM applications WHERE deleted_at IS NULL`))[0];
  // The EXACT data_only FUNDED files that are missing a *Program in ClickUp but
  // carry RTL signals (ARV / rehab budget / rehab type) — the concrete candidates
  // behind the portal-vs-ClickUp funded-count gap. Listed with name + address so
  // they can be opened in ClickUp and verified.
  const FUNDED_RAW = `('closed reconciled','closed (6-email funded)','non del closed reconciled','refinanced','waiting for final docs','in purchase review','purchase conditions','pa issued-post closing.')`;
  out.rtlFundedMissingProgram = await q(
    `SELECT task_id, task_name,
            snapshot->>'status' AS status,
            NULLIF(snapshot->'app'->>'arv','') AS arv,
            NULLIF(snapshot->'app'->>'rehab_budget','') AS rehab_budget,
            NULLIF(snapshot->'app'->>'rehab_type','') AS rehab_type,
            NULLIF(snapshot->'app'->>'loan_type','') AS loan_type,
            NULLIF(snapshot->'app'->>'dscr_ratio','') AS dscr_ratio
       FROM clickup_task_index
      WHERE kind='data_only'
        AND lower(btrim(COALESCE(snapshot->>'status',''))) IN ${FUNDED_RAW}
        AND (snapshot->>'rawProgram') IS NULL
        AND (NULLIF(snapshot->'app'->>'arv','') IS NOT NULL
             OR NULLIF(snapshot->'app'->>'rehab_budget','') IS NOT NULL
             OR NULLIF(snapshot->'app'->>'rehab_type','') IS NOT NULL)
      ORDER BY task_name LIMIT 40`);
  // Breakdown of ALL data_only funded files by their *Program label (blank vs
  // DSCR/non-QM), + how many of each carry an RTL signal — sizes the whole gap.
  out.dataOnlyFundedByProgram = await q(
    `SELECT COALESCE(NULLIF(snapshot->>'rawProgram',''),'(blank program)') raw_program, count(*)::int n,
            count(*) FILTER (WHERE NULLIF(snapshot->'app'->>'arv','') IS NOT NULL
                                OR NULLIF(snapshot->'app'->>'rehab_budget','') IS NOT NULL)::int with_rtl_signal
       FROM clickup_task_index
      WHERE kind='data_only' AND lower(btrim(COALESCE(snapshot->>'status',''))) IN ${FUNDED_RAW}
      GROUP BY 1 ORDER BY n DESC LIMIT 30`);
  console.log('[audit] ' + JSON.stringify(out));
  return out;
}

// ---- field-value diff audit (portal value vs live ClickUp value) ----------
// Re-reads each linked task from ClickUp and compares field-by-field with the
// stored portal value — surfaces transformation bugs, stale data, and fields
// present in ClickUp but missing in the portal (and vice-versa). Read-only.
async function auditFieldDiff({ limit = 120 } = {}) {
  const options = await optionMap();
  const apps = await db.query(
    `SELECT id, clickup_pipeline_task_id, clickup_folder_id, program, loan_type, property_type, loan_amount,
            purchase_price, arv, rehab_budget, ys_loan_number, lender, term, units, occupancy, internal_status, status
       FROM applications WHERE deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT $1`, [limit]).then((r) => r.rows).catch(() => []);
  const NUM = new Set(['loan_amount', 'purchase_price', 'arv', 'rehab_budget', 'units']);
  const FIELDS = ['program', 'loan_type', 'property_type', 'occupancy', 'loan_amount', 'purchase_price', 'arv', 'rehab_budget', 'ys_loan_number', 'lender', 'term', 'units', 'internal_status'];
  const mismatch = {}, missingPortal = {}, missingClickup = {}, samples = [];
  let checked = 0, folderMismatch = 0, taskErr = 0;
  for (const app of apps) {
    let task; try { task = await clickup.getTask(app.clickup_pipeline_task_id); } catch { taskErr++; continue; }
    const read = mapper.readTaskFields(task, options);
    checked++;
    const cuFolder = task.folder && task.folder.id;
    if (cuFolder && app.clickup_folder_id && String(cuFolder) !== String(app.clickup_folder_id)) folderMismatch++;
    for (const f of FIELDS) {
      const pv = f === 'internal_status' ? app.internal_status : app[f];
      const cv = f === 'internal_status' ? read.internalStatus : read.app[f];
      const P = pv == null || pv === '' ? null : String(pv);
      const C = cv == null || cv === '' ? null : String(cv);
      if (C != null && P == null) { missingPortal[f] = (missingPortal[f] || 0) + 1; continue; }
      if (C == null && P != null) { missingClickup[f] = (missingClickup[f] || 0) + 1; continue; }
      if (P != null && C != null && P !== C) {
        if (NUM.has(f) && Math.abs(Number(P) - Number(C)) < 1) continue;   // numeric rounding
        mismatch[f] = (mismatch[f] || 0) + 1;
        if (samples.length < 20) samples.push({ field: f, portal: P.slice(0, 40), clickup: C.slice(0, 40), task: app.clickup_pipeline_task_id });
      }
    }
  }
  const out = { checked, taskErr, folderMismatch, mismatch, missingPortal, missingClickup, samples };
  console.log('[audit-diff] ' + JSON.stringify(out));
  return out;
}

// ---- dry-run backfill (READ-ONLY validation, zero DB writes) --------------
// Fetches a sample of real tasks per folder, runs the mapper, and reports what
// WOULD happen — for validating the mapping/identity graph before enabling sync.
async function dryRunBackfill({ samplePerFolder = 8 } = {}) {
  const options = await optionMap();
  const stats = { folders: 0, tasksSeen: 0, rtl: 0, dataOnly: 0, materializable: 0, withSSN: 0, withLLC: 0, programs: {}, samples: [] };
  for (const folder of PIPELINE_FOLDERS()) {
    stats.folders++;
    let res;
    try { res = await clickup.getFilteredTeamTasks(cfg.clickupTeamId, { folderIds: [folder], includeClosed: true, subtasks: true }); }
    catch (e) { continue; }
    const tasks = ((res && res.tasks) || []).slice(0, samplePerFolder);
    for (const t of tasks) {
      try {
        const full = t.custom_fields ? t : await clickup.getTask(t.id, { include: ['custom_fields'] });
        const read = mapper.readTaskFields(full, options);
        stats.tasksSeen++;
        const prog = read.app.program || '(none)';
        stats.programs[prog] = (stats.programs[prog] || 0) + 1;
        const isRtl = read.app.program && ingest.RTL_PROGRAMS.has(read.app.program);
        if (isRtl) stats.rtl++; else stats.dataOnly++;
        if (canMaterialize(read)) stats.materializable++;
        if (read.borrower.ssn) stats.withSSN++;
        if (read.llc.llc_name) stats.withLLC++;
        if (stats.samples.length < 12) stats.samples.push({
          task: full.id, status: read.internalStatus, external: statusMap.externalFor(read.internalStatus),
          program: read.app.program, loan_type: read.app.loan_type, property_type: read.app.property_type,
          loan_amount: read.app.loan_amount, arv: read.app.arv, ys_loan: read.app.ys_loan_number,
          borrower: `${read.borrower.first_name || ''} ${read.borrower.last_name || ''}`.trim(),
          hasSSN: !!read.borrower.ssn, llc: read.llc.llc_name || null, lender: read.app.lender || null,
          extraKeys: Object.keys(read.extra).length,
        });
      } catch (e) { /* skip */ }
    }
  }
  return stats;
}

// ---- loops ----------------------------------------------------------------
function start() {
  // Stage 0 — DRY-RUN validation boot mode. Read-only: fetch a sample of real
  // tasks, run the mapper, and dump what WOULD happen to the logs. Runs even
  // when the master switch is off (it writes nothing), so the mapping/identity
  // graph can be validated against production ClickUp before anything is live.
  if (cfg.clickupRunDryrun) {
    if (!cfg.clickupToken) { console.log('[clickup-sync] DRY-RUN requested but CLICKUP_API_TOKEN not set'); return; }
    console.log('[clickup-sync] DRY-RUN starting (read-only, no writes)…');
    dryRunBackfill({ samplePerFolder: 8 })
      .then((s) => console.log('[clickup-sync] DRY-RUN result:', JSON.stringify(s, null, 2)))
      .catch((e) => console.error('[clickup-sync] DRY-RUN failed', e.message));
    return; // validation-only boot; do not start the live loops
  }

  if (!cfg.clickupSyncEnabled) { console.log('[clickup-sync] disabled (CLICKUP_SYNC_ENABLED!=1)'); return; }
  console.log('[clickup-sync] worker started');

  // Warm the dropdown-option cache immediately so outbound pushes for already-
  // linked tasks resolve dropdown option ids from the first tick (the cache is
  // space-level and shared; without this, the first ~poll-interval of linked
  // pushes silently dropped dropdown fields).
  optionMap().then(() => console.log('[clickup-sync] option cache warmed'))
    .catch((e) => console.error('[clickup-sync] option cache warm failed', e.message));

  // Stage 1 — one-shot inbound backfill on boot (identity graph, and RTL files
  // when mode='full'). Inbound only; writes to the portal, never to ClickUp.
  if (cfg.clickupRunBackfill) {
    const createFiles = cfg.clickupRunBackfill === 'full';
    console.log(`[clickup-sync] boot backfill (mode=${cfg.clickupRunBackfill}, createFiles=${createFiles})…`);
    runBackfill({ createFiles })
      .then((n) => console.log('[clickup-sync] boot backfill ingested', n))
      .catch((e) => console.error('[clickup-sync] boot backfill', e.message));
  }

  // One-shot data audit on boot (CLICKUP_RUN_AUDIT=1) — logs the coverage /
  // assignment / completeness report after any backfill has had time to run.
  if (cfg.clickupRunAudit) {
    setTimeout(() => {
      auditData()
        .catch((e) => console.error('[audit]', e.message))
        .then(() => auditFieldDiff({ limit: 120 }))
        .catch((e) => console.error('[audit-diff]', e.message));
    }, cfg.clickupRunBackfill ? 60000 : 3000);
  }

  // One-shot program reconcile: descope any file whose ClickUp program was flipped
  // to a non-RTL type (e.g. Short-Term Rehab → DSCR) before the descope logic
  // existed or outside the reconcile poll's window. Portal-only, ClickUp untouched,
  // idempotent. Delayed so the option cache + any boot backfill settle first.
  setTimeout(() => {
    reconcileLinkedProgramsOnce().catch((e) => console.error('[clickup-sync] reconcile-programs', e.message));
  }, cfg.clickupRunBackfill ? 120000 : 15000);

  const tick = async (fn, name) => { try { while (await fn()) { /* drain */ } } catch (e) { console.error(`[clickup-sync] ${name}`, e.message); } };

  // Inbound loops (ClickUp → portal) always run when the master switch is on —
  // the portal is the mirror, so pulling is always safe.
  console.log('[clickup-sync] inbound ' +
    (cfg.clickupInboundCreateFiles
      ? 'materializes new RTL loan files (CLICKUP_INBOUND_CREATE_FILES=1)'
      : 'identity-graph + linked-file updates only — new-file creation OFF (CLICKUP_INBOUND_CREATE_FILES!=1)'));
  setInterval(() => tick(processInboxOnce, 'inbox'), 4000);
  setInterval(() => { reconcileOnce().catch((e) => console.error('[clickup-sync] reconcile', e.message)); }, (cfg.clickupPollSec || 300) * 1000);

  // Stage 2 — outbound loops (portal → ClickUp writes) are gated separately so
  // inbound/backfill can run and be validated first, before the portal is
  // allowed to write to production ClickUp.
  if (cfg.clickupOutboundEnabled) {
    // SAFETY (post-incident): outbound pushes ONLY changes explicitly enqueued by a
    // staff edit in the portal (enqueue-on-write). The old "dirty sweep" auto-pushed
    // ANY file whose updated_at moved — including files just re-ingested FROM ClickUp
    // (a round-trip), which overwrote ClickUp with the portal's mapped/synthetic
    // values and looped. The sweep is intentionally NOT started; only the queue
    // drain runs, so nothing reaches ClickUp unless a human changed it in the portal.
    console.log('[clickup-sync] outbound writes ENABLED — enqueue-on-write ONLY (no auto-sweep)');
    setInterval(() => tick(pushOutboxOnce, 'push'), 3000);
  } else {
    console.log('[clickup-sync] outbound writes DISABLED (CLICKUP_OUTBOUND_ENABLED!=1) — inbound/reconcile only');
  }
}

module.exports = { start, pushOutboxOnce, sweepDirtyOnce, processInboxOnce, ingestOne, reconcileOnce, reconcileLinkedProgramsOnce, runBackfill, dryRunBackfill, auditData, auditFieldDiff, canMaterialize, PIPELINE_FOLDERS };
