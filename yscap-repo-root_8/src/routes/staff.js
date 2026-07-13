/**
 * Staff API (loan officers, processors, underwriters, admins).
 * Officers see their assigned pipeline; admins see everything. They add
 * conditions + document requests, update checklist status, verify LLCs and
 * track records, and assign Lead-Capture (unassigned) applications.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const { scrubText } = require('../lib/borrower-safe');
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const changeRequests = require('../lib/change-requests');
const mail = require('../lib/email/catalog');
const { serveDocument } = require('../lib/serve-document');
const cfg = require('../config');
const storage = require('../lib/storage');
const { requireAuth, requireRole, issueEmailToken } = require('../auth');
const pricing = require('../lib/pricing');
const { persistProductRegistration } = require('../lib/product-registration');
const { syncExperienceChecklistForApplication, RECENT_EXIT_SQL } = require('../lib/experience');
const { enqueueClickupPush, enqueueChecklistStatusPush } = require('../clickup/enqueue');
const statusMap = require('../clickup/status');
const llcLib = require('../lib/llc');
const conditionEngine = require('../lib/conditions/engine');
const conditionRules = require('../lib/conditions/rules');
const conditionRegistry = require('../lib/conditions/field-registry');
const { CONDITION_TYPES, TOOLS, CATEGORIES, conditionTypeOf } = require('../lib/conditions/types');
const { raiseEntityIssue } = require('../lib/raise-issue');

const { can } = require('../lib/permissions');
// Every staff persona reaches the console; per-file scoping + capability gates
// (below) decide what each can see and do.
router.use(requireAuth, requireRole('admin', 'loan_officer', 'processor', 'underwriter', 'loan_coordinator', 'software_setup'));
// Who sees every file vs. only their assigned ones — now a capability, so an
// admin can grant "see all files" to a coordinator without a code change.
const seesAll = (req) => can(req.actor, 'see_all_files');
// The borrower DIRECTORY / CRM has a WIDER audience than file-level see_all_files
// (owner-directed): admins, underwriters, loan_coordinators (seesAll) AND
// processors may open ANY borrower's full profile; loan_officers stay limited to
// borrowers they've done a loan for. File-level access (/applications/:id) is
// unchanged — a processor still opens individual files only where assigned.
const seesAllBorrowers = (req) => seesAll(req) || (req.actor && req.actor.role === 'processor');
// The standard post-closing trailing-doc set, seeded when a file funds.
const POST_CLOSING_SET = [
  ['note', 'Final executed note'],
  ['mortgage', 'Recorded mortgage / deed of trust'],
  ['title_policy', 'Final title policy'],
  ['settlement', 'Settlement statement (final CD/HUD)'],
  ['closing_package', 'Full executed closing package'],
  ['funding_confirmation', 'Funding confirmation'],
  ['trailing_docs', 'Recorded trailing documents'],
];
async function seedPostClosing(appId) {
  for (const [code, label] of POST_CLOSING_SET) {
    await db.query(
      `INSERT INTO post_closing_items (application_id,code,label) VALUES ($1,$2,$3)
       ON CONFLICT (application_id,code) DO NOTHING`, [appId, code, label]);
  }
}

// May this staffer act on a given application? (for routes not under the
// /applications/:id path-scope middleware, e.g. /loan-conditions/:cid/*).
async function canTouchApp(req, appId) {
  if (seesAll(req)) return true;
  // deleted_at check mirrors the /applications/:id path middleware — without it
  // an assigned officer could keep mutating (conditions/messages/post-closing)
  // a file an admin soft-deleted.
  const r = await db.query(
    `SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL
        AND (loan_officer_id=$2 OR processor_id=$2
             OR loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2))`,
    [appId, req.actor.id]);
  return !!r.rows[0];
}
const isAdmin = (req) => ['admin', 'super_admin'].includes(req.actor.role);
function intField(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

async function audit(req, action, entity_type, entity_id, detail) {
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
     VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
    [req.actor.id, action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, detail || null]);
}
// officers/processors only see their files; admins/super-admins/underwriters see all.
// PLUS: a staffer may be granted access to specific loan officers' files (their
// visible_officer_ids). The uncorrelated subquery reads that list off the actor's
// staff row, so this stays a SINGLE-param ($SCOPE) clause — no caller changes.
const VISIBLE_OFFICERS_SQL = (alias, p) =>
  `(${alias}.loan_officer_id=${p} OR ${alias}.processor_id=${p}` +
  ` OR ${alias}.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p}))`;
function scopeClause(req, alias = 'a') {
  if (seesAll(req)) return { where: '', params: [] };
  return { where: `AND ${VISIBLE_OFFICERS_SQL(alias, '$SCOPE')}`, params: [req.actor.id] };
}

// Guard every /applications/:id* route: a non-privileged staffer may only touch
// a file they are the loan officer or processor on. (Borrower :id routes live
// under /borrowers/:id and are unaffected by this path-scoped middleware.)
router.use('/applications/:id', async (req, res, next) => {
  try {
    if (seesAll(req)) return next();
    // A soft-deleted file is inaccessible to non-privileged staff (admins can
    // still reach it to restore); this blocks open/mutate-by-direct-link.
    const r = await db.query(
      `SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL
          AND (loan_officer_id=$2 OR processor_id=$2
               OR loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2))`,
      [req.params.id, req.actor.id]);
    if (!r.rows[0]) return res.status(403).json({ error: 'forbidden' });
    next();
  } catch (e) { next(e); }
});

// ---------------- dashboard KPIs ----------------
// Dashboard scope = role scope PLUS the pipeline view the staffer is looking at.
// A scoped user (loan_officer/processor) is always limited to their own files.
// A seesAll user (admin/underwriter) sees everyone by default, but can narrow the
// KPIs to match the pipeline view: ?mine=1 (only their files) or ?officerId=<uuid>
// (one officer's files) — so "Monthly production" et al. reflect exactly what the
// list below shows. The view can only ever NARROW, never widen, a user's access.
function dashboardScope(req) {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const mine = req.query.mine === '1' || req.query.mine === 'true';
  const officerId = UUID.test(String(req.query.officerId || '')) ? String(req.query.officerId) : null;
  if (!seesAll(req)) return { where: `AND (a.loan_officer_id=$1 OR a.processor_id=$1 OR a.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$1))`, params: [req.actor.id] };
  if (mine) return { where: `AND (a.loan_officer_id=$1 OR a.processor_id=$1)`, params: [req.actor.id] };
  if (officerId) return { where: `AND (a.loan_officer_id=$1 OR a.processor_id=$1)`, params: [officerId] };
  return { where: '', params: [] };
}

router.get('/dashboard', async (req, res) => {
  try {
    const s = dashboardScope(req);
    const w = s.where.replace(/\$SCOPE/g, '$1');
    // Status GROUPS (owner-defined): active = any in-progress status; closed =
    // funded; cancelled = withdrawn/declined. These drive the dashboard so a held
    // or closed file never inflates the live pipeline. NOTE: at the `status` level
    // ClickUp 'cancelled/trash/recalled' all map to 'withdrawn' (see clickup/status.js).
    const ACTIVE_SQL = `status NOT IN ('funded','declined','withdrawn')`;
    const CANCELLED_SQL = `status IN ('declined','withdrawn')`;
    // A genuinely NEW file is a real portal/staff intake this week — NOT a row the
    // ClickUp backfill just inserted (those default created_at=now() and would make
    // the whole back-book look "new"). Exclude backfilled origin.
    const NEW_SQL = `created_at > now() - interval '7 days' AND COALESCE(source,'') <> 'clickup_backfill'`;
    const [byStatus, totals, leads, aging, fundedByMonth] = await Promise.all([
      // Every figure must exclude archived (soft-deleted) files — otherwise an
      // archived/removed loan keeps inflating the counts and pipeline dollars.
      db.query(`SELECT status, count(*)::int c, COALESCE(sum(loan_amount),0)::bigint v
                  FROM applications a WHERE a.deleted_at IS NULL ${w} GROUP BY status`, s.params),
      db.query(`SELECT count(*)::int total,
                       -- Pipeline value = ACTIVE (open) files ONLY. Funded/withdrawn/
                       -- declined are excluded so the number reflects live pipeline.
                       COALESCE(sum(loan_amount) FILTER (WHERE ${ACTIVE_SQL}),0)::bigint pipeline_value,
                       count(*) FILTER (WHERE ${NEW_SQL})::int new_week,
                       count(*) FILTER (WHERE status='funded')::int funded,
                       count(*) FILTER (WHERE ${ACTIVE_SQL})::int active,
                       count(*) FILTER (WHERE ${CANCELLED_SQL})::int cancelled,
                       -- "Actively processing" = files being worked (this matches the
                       -- ClickUp "Active RTL Files" card): excludes new/in_review (early)
                       -- and on_hold. Lets the portal show the same active number ClickUp does.
                       count(*) FILTER (WHERE status IN ('processing','underwriting','approved','clear_to_close'))::int actively_processing,
                       count(*) FILTER (WHERE status='on_hold')::int on_hold,
                       -- Ops/AI signal: active files gone stale (untouched > 7 days) — the
                       -- files silently stalling in the pipeline that need a nudge.
                       count(*) FILTER (WHERE ${ACTIVE_SQL} AND updated_at < now() - interval '7 days')::int stalled,
                       -- Funded bucketed by ACTUAL closing date (the ClickUp MTM basis).
                       count(*) FILTER (WHERE status='funded' AND actual_closing >= date_trunc('month', now()))::int funded_mtd,
                       count(*) FILTER (WHERE status='funded' AND actual_closing >= date_trunc('month', now()) - interval '1 month' AND actual_closing < date_trunc('month', now()))::int funded_last_month,
                       count(*) FILTER (WHERE status='funded' AND actual_closing >= date_trunc('year', now()))::int funded_ytd,
                       COALESCE(sum(loan_amount) FILTER (WHERE status='funded' AND actual_closing >= date_trunc('year', now())),0)::bigint funded_ytd_value,
                       COALESCE(sum(loan_amount) FILTER (WHERE status='funded'),0)::bigint funded_lifetime_value,
                       -- K1: funded but no actual closing date YET (ClickUp can add the
                       -- date later). Still counted as funded; held in a dateless bucket
                       -- and auto-moves into its month once a date lands.
                       count(*) FILTER (WHERE status='funded' AND actual_closing IS NULL)::int funded_no_date,
                       COALESCE(sum(loan_amount) FILTER (WHERE status='funded' AND actual_closing IS NULL),0)::bigint funded_no_date_value,
                       -- Portfolio-health KPIs (industry-standard lending metrics):
                       -- avg funded loan size YTD, avg days from submit→close (cycle time),
                       -- and pipeline-aging buckets for the ACTIVE book (how long each
                       -- open file has been in the pipeline). Pull-through is derived in JS.
                       COALESCE(avg(loan_amount) FILTER (WHERE status='funded' AND actual_closing >= date_trunc('year', now())),0)::bigint avg_funded_ytd,
                       COALESCE(round(avg(EXTRACT(epoch FROM (actual_closing::timestamptz - submitted_at))/86400.0)
                                FILTER (WHERE status='funded' AND actual_closing IS NOT NULL AND submitted_at IS NOT NULL))::int,0) avg_cycle_days,
                       count(*) FILTER (WHERE ${ACTIVE_SQL} AND created_at >= now() - interval '7 days')::int age_0_7,
                       count(*) FILTER (WHERE ${ACTIVE_SQL} AND created_at < now() - interval '7 days' AND created_at >= now() - interval '14 days')::int age_8_14,
                       count(*) FILTER (WHERE ${ACTIVE_SQL} AND created_at < now() - interval '14 days' AND created_at >= now() - interval '30 days')::int age_15_30,
                       count(*) FILTER (WHERE ${ACTIVE_SQL} AND created_at < now() - interval '30 days')::int age_30p
                  FROM applications a WHERE a.deleted_at IS NULL ${w}`, s.params),
      seesAll(req)
        ? db.query(`SELECT count(*)::int c FROM leads WHERE status NOT IN ('converted','archived')`)
        : db.query(`SELECT count(*)::int c FROM leads WHERE status NOT IN ('converted','archived') AND (officer_id=$1 OR officer_id IS NULL)`, [req.actor.id]),
      db.query(`SELECT count(*)::int c FROM applications a
                 WHERE a.deleted_at IS NULL AND ${ACTIVE_SQL}
                   AND updated_at < now() - interval '5 days' ${w}`, s.params),
      // Month-to-month funded closings (by actual closing date) — mirrors the
      // ClickUp "RTL SHORT MTM" dashboard so the two can be compared side by side.
      db.query(`SELECT to_char(date_trunc('month', actual_closing),'YYYY-MM') ym,
                       count(*)::int c, COALESCE(sum(loan_amount),0)::bigint v
                  FROM applications a
                 WHERE a.deleted_at IS NULL AND status='funded' AND actual_closing IS NOT NULL ${w}
                 GROUP BY 1 ORDER BY 1 DESC LIMIT 18`, s.params),
    ]);
    const t = totals.rows[0];
    // Month-over-month funded momentum: this month's funded count vs. last
    // month's, as an absolute delta and a rounded % change (null when there's
    // no prior-month base to divide by).
    const fundedMomDelta = t.funded_mtd - t.funded_last_month;
    const fundedMomPct = t.funded_last_month > 0
      ? Math.round((fundedMomDelta / t.funded_last_month) * 100)
      : null;
    // Pull-through = funded / (funded + cancelled): of every file that reached a
    // terminal state, the share that actually closed. A truer conversion signal
    // than funded/total (which is diluted by the still-open active book). Null
    // when nothing has reached a terminal state yet.
    const terminal = t.funded + t.cancelled;
    const pullThrough = terminal > 0 ? Math.round((t.funded / terminal) * 100) : null;
    res.json({
      byStatus: byStatus.rows,
      total: t.total, pipelineValue: Number(t.pipeline_value), active: t.active,
      cancelled: t.cancelled, activelyProcessing: t.actively_processing, onHold: t.on_hold, stalled: t.stalled,
      funded: t.funded, newThisWeek: t.new_week,
      // funded broken out by actual closing date (MTM), + running dollar totals
      fundedMtd: t.funded_mtd, fundedLastMonth: t.funded_last_month, fundedYtd: t.funded_ytd,
      fundedMomDelta, fundedMomPct,
      fundedYtdValue: Number(t.funded_ytd_value), fundedLifetimeValue: Number(t.funded_lifetime_value),
      fundedNoDate: t.funded_no_date, fundedNoDateValue: Number(t.funded_no_date_value),
      fundedByMonth: fundedByMonth.rows.map((r) => ({ month: r.ym, count: r.c, value: Number(r.v) })),
      openLeads: leads.rows[0].c,
      stale: aging.rows[0].c,           // active files untouched > 5 days
      conversion: t.total ? Math.round((t.funded / t.total) * 100) : 0,
      // Portfolio-health block
      pullThrough,
      avgFundedYtd: Number(t.avg_funded_ytd),
      avgCycleDays: t.avg_cycle_days,
      aging: { a0_7: t.age_0_7, a8_14: t.age_8_14, a15_30: t.age_15_30, a30p: t.age_30p },
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- pipeline ----------------
// Optional filter params — all AND-combined; with no filter params this returns
// the same scoped pipeline (same row shape, same ORDER BY) as before. Every
// user-supplied value is bound as a placeholder (never interpolated into SQL);
// scopeClause() still enforces per-file authorization.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.get('/applications', async (req, res) => {
  try {
    const q = req.query;
    const s = scopeClause(req);
    // Scope params always occupy the leading placeholders ($1 when present);
    // add() appends each filter value and hands back its own placeholder so the
    // numbering stays correct regardless of which filters are active.
    const params = [...s.params];
    const add = (val) => { params.push(val); return `$${params.length}`; };
    const where = ['a.deleted_at IS NULL'];
    if (s.where) where.push(s.where.replace(/\$SCOPE/g, '$1').replace(/^AND\s+/, ''));

    // status GROUP — same predicates the dashboard uses. An EXACT status filter
    // takes precedence over the group bucket: applying both (e.g. group=active
    // AND status=funded from a stale URL/deep-link) would contradict and return
    // ZERO rows — the classic "switch to Funded shows nothing" bug. So when an
    // exact status is set, skip the group predicate entirely.
    if (q.status) {
      where.push(`a.status = ${add(String(q.status))}`);
    } else if (q.group === 'active') {
      where.push(`a.status NOT IN ('funded','declined','withdrawn')`);
    } else if (q.group === 'cancelled') {
      where.push(`a.status IN ('declined','withdrawn')`);
    } else if (q.group === 'closed') {
      where.push(`a.status = 'funded'`);
    }
    // 'all'/absent group with no status → no status predicate.

    if (q.program) where.push(`a.program = ${add(String(q.program))}`);
    if (q.loanType) where.push(`a.loan_type = ${add(String(q.loanType))}`);
    // Free-text search across borrower name, YS loan number, and property address.
    // One bound ILIKE value, matched against several columns — never interpolated.
    if (q.q !== undefined && String(q.q).trim() !== '') {
      const like = `%${String(q.q).trim().slice(0, 80)}%`;
      const p = add(like);
      where.push(`((b.first_name || ' ' || b.last_name) ILIKE ${p}
                   OR a.ys_loan_number ILIKE ${p}
                   OR COALESCE(a.property_address->>'oneLine','') ILIKE ${p})`);
    }
    if (q.officerId) {
      if (!UUID_RE.test(String(q.officerId))) return res.status(400).json({ error: 'invalid officerId' });
      where.push(`a.loan_officer_id = ${add(String(q.officerId))}`);
    }
    if (q.processorId) {
      if (!UUID_RE.test(String(q.processorId))) return res.status(400).json({ error: 'invalid processorId' });
      where.push(`a.processor_id = ${add(String(q.processorId))}`);
    }

    // Numeric bounds on loan_amount — coerce safely, ignore non-numeric input.
    if (q.minAmount !== undefined && q.minAmount !== '') {
      const n = Number(q.minAmount);
      if (Number.isFinite(n)) where.push(`a.loan_amount >= ${add(n)}`);
    }
    if (q.maxAmount !== undefined && q.maxAmount !== '') {
      const n = Number(q.maxAmount);
      if (Number.isFinite(n)) where.push(`a.loan_amount <= ${add(n)}`);
    }

    // Date bounds — must be YYYY-MM-DD; reject anything malformed.
    for (const [key, col, op] of [
      ['fundedFrom', 'a.actual_closing', '>='],
      ['fundedTo', 'a.actual_closing', '<='],
      ['createdFrom', 'a.created_at', '>='],
      ['createdTo', 'a.created_at', '<='],
    ]) {
      const v = q[key];
      if (v === undefined || v === '') continue;
      if (!DATE_RE.test(String(v))) return res.status(400).json({ error: `invalid ${key}` });
      where.push(`${col} ${op} ${add(String(v))}`);
    }

    // Ops flags — mirror the dashboard's stale (active + untouched > 5 days) and
    // its dateless-funded (K1) bucket.
    if (q.flag === 'stalled') {
      where.push(`a.status NOT IN ('funded','declined','withdrawn') AND a.updated_at < now() - interval '5 days'`);
    } else if (q.flag === 'nodate') {
      where.push(`a.status = 'funded' AND a.actual_closing IS NULL`);
    }

    let limit = parseInt(q.limit, 10);
    if (!Number.isFinite(limit)) limit = 500;
    limit = Math.min(1000, Math.max(1, limit));
    let offset = parseInt(q.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    // Sort — strict whitelist (never interpolate user text into ORDER BY). NULLS
    // LAST keeps blank amounts/dates from floating to the top of a sort.
    // "Newest/Oldest first" sorts by the REAL file date — the ClickUp task
    // creation date for imported files, falling back to created_at for native
    // portal files. (Sorting on created_at alone clustered the whole imported
    // back-book at one import timestamp, so the sort looked broken.)
    const CREATED = 'COALESCE(a.clickup_created_at, a.submitted_at, a.created_at)';
    const SORTS = {
      created_desc: `${CREATED} DESC`,
      created_asc: `${CREATED} ASC`,
      amount_desc: 'a.loan_amount DESC NULLS LAST',
      amount_asc: 'a.loan_amount ASC NULLS LAST',
      closing_desc: 'a.actual_closing DESC NULLS LAST',
      closing_asc: 'a.actual_closing ASC NULLS LAST',
      name_asc: 'b.last_name ASC, b.first_name ASC',
      name_desc: 'b.last_name DESC, b.first_name DESC',
    };
    // A UNIQUE tiebreaker (a.id) after the chosen sort — imported ClickUp files
    // often share the same created timestamp, and without a stable tiebreaker
    // those equal-key rows reshuffle between fetches, which reads as "the sort is
    // random / broken."
    const orderBy = (SORTS[String(q.sort || '')] || SORTS.created_desc) + ', a.id DESC';

    const sql = `SELECT a.id,a.ys_loan_number,a.program,a.loan_type,a.status,a.internal_status,a.sync_state,
                        a.clickup_pipeline_task_id,a.property_address,a.lender,
                        a.loan_amount,a.loan_officer_id,a.loan_officer_name,a.processor_id,a.created_at,a.actual_closing,
                        b.first_name,b.last_name,b.email,
                        (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id) AS total_items,
                        (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id
                           AND (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')) AS done_items
                 FROM applications a JOIN borrowers b ON b.id=a.borrower_id
                 WHERE ${where.join(' AND ')} ORDER BY ${orderBy}
                 LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Self-serve ClickUp re-sync: pull THIS staffer's own pipeline folder into the
// portal (materialize/refresh + reassign their RTL files) — no developer needed.
// Runs in the background; the UI refreshes its pipeline after a moment.
router.post('/clickup/sync-mine', async (req, res) => {
  if (!cfg.clickupToken) return res.status(400).json({ error: 'ClickUp is not configured' });
  const r = await db.query(`SELECT pipeline_folder_id, full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
  const folderId = r.rows[0] && r.rows[0].pipeline_folder_id;
  if (!folderId) return res.status(400).json({ error: 'No ClickUp pipeline folder is linked to your account — ask an admin.' });
  const sync = require('../sync/clickup-sync');
  sync.runBackfill({ createFiles: true, folders: [String(folderId)], pageLimit: 50 })
    .then((n) => console.log('[sync-mine]', req.actor.id, 'folder', folderId, 'ingested', n))
    .catch((e) => console.error('[sync-mine] failed', e.message));
  res.json({ ok: true, started: true, folderId: String(folderId) });
});

// The known internal (ClickUp) task statuses we mirror 1:1 (the KEYS of the
// EXTERNAL_FOR map), each with the borrower-facing status it derives to. Feeds
// the staff "Internal (ClickUp) status" picker.
router.get('/clickup/internal-statuses', (req, res) => {
  const list = Object.keys(statusMap.EXTERNAL_FOR).map((value) => ({
    value, external: statusMap.externalFor(value),
  }));
  res.json(list);
});

// Exception dashboard — how many files are in each "needs attention" bucket,
// scoped to what the staffer can see. Powers the command-center KPI strip.
router.get('/exceptions', async (req, res) => {
  const s = scopeClause(req);
  const w = s.where.replace(/\$SCOPE/g, '$1');
  try {
    const r = await db.query(
      `SELECT
         count(*) FILTER (WHERE a.loan_officer_id IS NULL AND a.status NOT IN ('funded','declined','withdrawn'))::int AS unassigned,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.status='issue'))::int AS needs_correction,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both') AND ci.status IN ('outstanding','requested')))::int AS awaiting_borrower,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.status='received'))::int AS awaiting_review,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM messages m WHERE m.application_id=a.id AND m.channel='borrower' AND m.sender_kind='borrower' AND m.read_at IS NULL))::int AS unread_messages,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM conditions c WHERE c.application_id=a.id AND c.status='open'))::int AS open_conditions,
         count(*) FILTER (WHERE EXISTS(SELECT 1 FROM post_closing_items p WHERE p.application_id=a.id AND p.status='exception'))::int AS post_closing_exceptions
       FROM applications a WHERE a.deleted_at IS NULL ${w}`, s.params);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Everything on my plate across all my files: tasks explicitly assigned to me,
// or role-routed (loan_officer/processor) to a file I'm assigned to. Open only.
router.get('/my-tasks', async (req, res) => {
  const r = await db.query(
    `SELECT ci.id, ci.label, ci.status, ci.due_date, ci.role_scope, ci.item_kind,
            ci.application_id, a.ys_loan_number, a.property_address, a.status AS app_status,
            b.first_name, b.last_name,
            (ci.assignee_staff_id=$1) AS assigned_to_me,
            (SELECT count(*)::int FROM messages m WHERE m.application_id=a.id
               AND m.channel='borrower' AND m.sender_kind='borrower' AND m.read_at IS NULL) AS unread
       FROM checklist_items ci
       JOIN applications a ON a.id=ci.application_id
       JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.deleted_at IS NULL
        AND ci.status NOT IN ('satisfied')
        AND (ci.assignee_staff_id=$1
             OR (ci.assignee_staff_id IS NULL AND ci.role_scope='loan_officer' AND a.loan_officer_id=$1)
             OR (ci.assignee_staff_id IS NULL AND ci.role_scope='processor' AND a.processor_id=$1))
      ORDER BY ci.due_date NULLS LAST, a.created_at`, [req.actor.id]);
  res.json(r.rows);
});

router.get('/lead-capture', async (req, res) => {
  // Assigning unassigned files is an admin/underwriter function (a loan officer
  // or processor can't even open an unassigned file — the path-scope guard
  // 403s it), so only they see this queue and its borrower PII. Soft-deleted
  // files are excluded.
  if (!seesAll(req)) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(
    `SELECT a.id,a.ys_loan_number,a.program,a.property_address,a.created_at,b.first_name,b.last_name,b.email
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     WHERE a.loan_officer_id IS NULL AND a.deleted_at IS NULL ORDER BY a.created_at DESC`);
  res.json(r.rows);
});

// ---------------- staff originates a mortgage file (borrower need not exist) ----------------
// Any staffer (admin / loan officer / operations) can open a file from their
// side: match-or-create the borrower by email (no login required), create the
// application, generate its checklist, and assign an officer. The borrower can
// be invited to join this specific file at any time (now or later).
router.post('/applications', async (req, res) => {
  const b = req.body || {};
  const bo = b.borrower || {};
  const email = String(bo.email || '').trim();
  const firstName = String(bo.firstName || '').trim();
  const lastName = String(bo.lastName || '').trim();
  const addr = b.propertyAddress || null;
  if (!email) return res.status(400).json({ error: 'borrower email required' });
  if (!firstName) return res.status(400).json({ error: 'borrower first name required' });
  if (!addr || !(addr.oneLine || addr.street || addr.line1))
    return res.status(400).json({ error: 'property address required' });
  try {
    // Match-or-create the borrower. Never overwrite existing PII — only fill
    // blank fields — so an existing borrower record is preserved intact.
    const br = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO UPDATE SET
         cell_phone = COALESCE(borrowers.cell_phone, EXCLUDED.cell_phone),
         updated_at = now()
       RETURNING id, (xmax=0) AS created`,
      [firstName, lastName || '', email, bo.phone || null]);
    const borrowerId = br.rows[0].id;

    // A borrower may have MANY files (one per property) and any staffer may open
    // a new one for an existing borrower (owner-directed). Opening a file assigns
    // the creator to THAT file only; a borrower's PII (SSN) + shared profile/LLC
    // docs then become visible, which is inherent to working any file for them.
    // Cross-file safety still holds: APPLICATION documents are authorized solely
    // by assignment to their own application (see canSeeDocument), so this never
    // exposes another officer's file for the same borrower; every SSN reveal and
    // document download remains audited.

    // Resolve the assigned officer: explicit pick, else the creator when they
    // are a loan officer (their own pipeline), else null => Lead Capture.
    let officerId = null, officerName = null;
    if (b.loanOfficerId) {
      const o = await db.query(`SELECT id,full_name FROM staff_users WHERE id=$1 AND is_active=true`, [b.loanOfficerId]);
      if (o.rows[0]) { officerId = o.rows[0].id; officerName = o.rows[0].full_name; }
    }
    if (!officerId && req.actor.role === 'loan_officer') {
      const meRow = await db.query(`SELECT id,full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
      if (meRow.rows[0]) { officerId = meRow.rows[0].id; officerName = meRow.rows[0].full_name; }
    }
    let processorId = null;
    if (b.processorId) {
      const p = await db.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true AND role='processor'`, [b.processorId]);
      if (p.rows[0]) processorId = p.rows[0].id;
    }
    // A processor who opens a file is assigned to it, so it stays on their desk
    // (otherwise they'd immediately lose sight of the file they just created).
    if (!processorId && req.actor.role === 'processor') processorId = req.actor.id;

    // Assignment purchases: capture the underlying price + fee (like the
    // borrower path) so leverage/pricing size off seller price + fee and the
    // assignment doc is generated.
    const isAssignment = !!b.isAssignment && Number(b.underlyingContractPrice) > 0;
    const underlying = isAssignment ? (b.underlyingContractPrice || null) : null;
    const assignFee = isAssignment ? (b.assignmentFee || null) : null;
    const purchasePrice = isAssignment
      ? (Number(b.underlyingContractPrice || 0) + Number(b.assignmentFee || 0))
      : (b.purchasePrice || null);

    const ins = await db.query(
      `INSERT INTO applications
         (borrower_id,property_address,property_type,units,program,loan_type,
          purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
          rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
          processor_id,is_assignment,underlying_contract_price,assignment_fee,source,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'staff','new',now())
       RETURNING id,ys_loan_number`,
      [borrowerId, JSON.stringify(addr), b.propertyType || null, b.units || null,
       b.program || null, b.loanType || null, purchasePrice, b.asIsValue || null,
       b.arv || null, b.rehabBudget || null, officerId, officerName,
       b.rehabType || null, intField(b.sqftPre) || null, intField(b.sqftPost) || null,
       intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
       processorId, isAssignment, underlying, assignFee]);
    const appId = ins.rows[0].id;

    try { await require('./borrower').generateChecklist(appId, borrowerId, b.program, b.loanType, { isAssignment }); }
    catch (e) { console.error('[staff-origination] checklist failed:', db.describeError(e)); }
    // Optionally add a CO-BORROWER right at creation (#98) — same identity-graph
    // linking as adding one later. A bad co-borrower payload must not fail the
    // whole file (it's already created); surface it as a soft warning instead.
    let coBorrowerId = null, coBorrowerWarning = null;
    if (b.coBorrower && (b.coBorrower.borrowerId || b.coBorrower.firstName || b.coBorrower.email)) {
      try { coBorrowerId = await attachCoBorrowerToApp(appId, borrowerId, b.coBorrower); }
      catch (e) { coBorrowerWarning = e.message || 'could not add the co-borrower'; console.error('[staff-origination] co-borrower failed:', e.message); }
    }
    // Oversight flag: a scoped staffer opening a file for a PRE-EXISTING borrower
    // they had no prior relationship with now gains that borrower's PII (SSN) +
    // shared profile docs. This is allowed (owner-directed multi-file), but we
    // stamp a high-signal audit flag so cross-officer originations are reviewable.
    let crossBorrower = false;
    if (!br.rows[0].created && !seesAll(req)) {
      const rel = await db.query(
        `SELECT 1 FROM applications WHERE borrower_id=$1 AND id<>$3 AND (loan_officer_id=$2 OR processor_id=$2) LIMIT 1`,
        [borrowerId, req.actor.id, appId]);
      crossBorrower = !rel.rows[0];
    }
    await audit(req, 'create_application', 'application', appId, { origin: 'staff', borrowerId, coBorrowerId: coBorrowerId || undefined, crossBorrower: crossBorrower || undefined });
    // Create + link the ClickUp task in the correct folder (officer's pipeline, or
    // Lead Capture if none) the moment the file is started (#92). Best-effort and
    // non-blocking — the file is created regardless of ClickUp availability.
    require('../clickup/orchestrator').createForNewFile(appId).catch((e) => console.error('[clickup] create-on-start (staff)', appId, e && e.message));

    // Optionally invite the borrower to the portal for this file right away.
    let invited = null;
    if (b.inviteBorrower) {
      try { invited = await inviteBorrowerToFile({ appId, borrowerId, email, firstName, req }); }
      catch (e) { console.error('[staff-origination] borrower invite failed:', db.describeError(e)); }
    }
    res.status(201).json({
      ok: true, applicationId: appId, ysLoanNumber: ins.rows[0].ys_loan_number,
      borrowerId, borrowerCreated: br.rows[0].created, invited,
      coBorrowerId, coBorrowerWarning: coBorrowerWarning || undefined });
  } catch (e) { res.status(500).json({ error: db.describeError(e) }); }
});

// Invite the file's borrower to the portal (they need not have signed up yet).
// Issues a borrower invite bound to their email; on acceptance they link to the
// SAME borrower record (ON CONFLICT email) and immediately see this file. If
// they already have a login they're simply pointed to sign in.
async function inviteBorrowerToFile({ appId, borrowerId, email, firstName, req }) {
  const hasAuth = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]);
  let acceptUrl, token = null;
  if (hasAuth.rows[0]) {
    acceptUrl = mail.link('/login');
  } else {
    token = C.randomToken(24);
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,created_by,expires_at)
       VALUES ($1,'borrower',$2,$3, now() + interval '14 days')`,
      [C.sha256(token), email, req.actor.id]);
    acceptUrl = mail.link('/accept?token=' + token);
  }
  const meta = await db.query(
    `SELECT COALESCE(property_address->>'oneLine', property_address->>'street', 'your loan') AS addr,
            ys_loan_number FROM applications WHERE id=$1`, [appId]);
  const inviter = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
  await mail.send('borrowerInvite', email, {
    firstName,
    propertyLabel: meta.rows[0]?.addr || 'your loan',
    loanNumber: meta.rows[0]?.ys_loan_number || null,
    inviter: inviter.rows[0]?.full_name || null,
    acceptUrl, hasAccount: !!hasAuth.rows[0],
  });
  await audit(req, 'invite_borrower', 'application', appId, { email });
  // Best-effort in-app notice to the file's team.
  return { emailed: true, hasAccount: !!hasAuth.rows[0], inviteToken: token };
}

// Invite the borrower to an existing file (guarded by the /applications/:id
// access middleware below).
router.post('/applications/:id/invite-borrower', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT a.borrower_id, b.email, b.first_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!r.rows[0].email) return res.status(400).json({ error: 'borrower has no email on file' });
    const out = await inviteBorrowerToFile({
      appId: req.params.id, borrowerId: r.rows[0].borrower_id,
      email: r.rows[0].email, firstName: r.rows[0].first_name, req });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/applications/:id', async (req, res) => {
  const r = await db.query(
    `SELECT a.*, b.first_name,b.last_name,b.email,b.cell_phone,b.fico,
            l.llc_name AS entity_name, l.is_verified AS entity_verified,
            cb.first_name AS co_first_name, cb.last_name AS co_last_name,
            cb.email AS co_email, cb.cell_phone AS co_cell_phone,
            cb.date_of_birth AS co_date_of_birth, cb.ssn_last4 AS co_ssn_last4,
            cb.fico AS co_fico, cb.current_address AS co_current_address,
            cb.citizenship AS co_citizenship, cb.tier AS co_tier,
            pr.program AS registered_program, pr.product_label AS registered_product_label,
            pr.status AS registered_product_status, pr.note_rate AS registered_note_rate,
            pr.total_loan AS registered_total_loan, pr.quote AS registered_quote,
            pr.created_at AS registered_at
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     LEFT JOIN llcs l ON l.id=a.llc_id
     LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
     LEFT JOIN LATERAL (
       SELECT program, product_label, status, note_rate, total_loan, quote, created_at
         FROM product_registrations
        WHERE application_id=a.id AND is_current
        ORDER BY created_at DESC LIMIT 1
     ) pr ON true
     WHERE a.id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Resolve-or-create a co-borrower from an identity payload and bind it to a
// file. Shared by the standalone /co-borrower endpoint AND file creation (#98),
// so "add a co-borrower while creating the application" runs the exact same
// linking (identity-graph match, encrypted SSN, gov-ID condition, LLC owners).
// Throws an Error with `.status` on a validation problem. `primaryBorrowerId`
// guards against linking the primary borrower to themselves.
async function attachCoBorrowerToApp(appId, primaryBorrowerId, b) {
  let coId = b.borrowerId || null;
  if (!coId) {
    const first = String(b.firstName || '').trim();
    const last = String(b.lastName || '').trim();
    const email = String(b.email || '').trim().toLowerCase();
    if (!first || !last) { const e = new Error('co-borrower first and last name are required'); e.status = 400; throw e; }
    if (!email) { const e = new Error('co-borrower email is required'); e.status = 400; throw e; }
    const ssn = b.ssn ? String(b.ssn) : null;
    const identity = require('../clickup/identity');
    const ssnHash = ssn ? identity.ssnHash(ssn, cfg.ssnMatchKey) : null;
    const ssnEnc = ssn ? C.encryptSSN(ssn) : null;
    const ssnLast4 = ssn ? ssn.replace(/\D/g, '').slice(-4) : null;
    // Identity graph: match an existing borrower by SSN-hash first (so the same
    // person across files stays one record), else create/update by email.
    if (ssnHash) {
      const m = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 LIMIT 1`, [ssnHash]);
      if (m.rows[0]) coId = m.rows[0].id;
    }
    if (!coId) {
      const ins = await db.query(
        `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,ssn_encrypted,ssn_last4,ssn_hash,origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'co_borrower')
         ON CONFLICT (email) DO UPDATE SET
           first_name=COALESCE(NULLIF(borrowers.first_name,''),EXCLUDED.first_name),
           last_name=COALESCE(NULLIF(borrowers.last_name,''),EXCLUDED.last_name),
           cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
           date_of_birth=COALESCE(borrowers.date_of_birth,EXCLUDED.date_of_birth),
           ssn_encrypted=COALESCE(borrowers.ssn_encrypted,EXCLUDED.ssn_encrypted),
           ssn_last4=COALESCE(borrowers.ssn_last4,EXCLUDED.ssn_last4),
           ssn_hash=COALESCE(borrowers.ssn_hash,EXCLUDED.ssn_hash),
           updated_at=now()
         RETURNING id`,
        [first, last, email, b.phone || null, b.dob || null, ssnEnc, ssnLast4, ssnHash]);
      coId = ins.rows[0].id;
    }
  }
  if (coId === primaryBorrowerId) { const e = new Error('the co-borrower must be a different person than the primary borrower'); e.status = 400; throw e; }
  await db.query(`UPDATE applications SET co_borrower_id=$2, updated_at=now() WHERE id=$1`, [appId, coId]);
  // The co-borrower's government-ID condition (named with their name) appears
  // on the file the moment they're linked.
  try { await require('../lib/co-borrower').ensureCoBorrowerIdCondition(appId, coId); } catch (_) {}
  // Link both borrowers to the file's vesting LLC so the entity is owned by
  // both — each borrower's ownership % is filled in on the file (#81).
  try { await require('../lib/llc-borrowers').syncVestingLlcBorrowers(appId); } catch (_) {}
  return coId;
}

// Set / link / unlink the CO-BORROWER on a file. Staff enter the second
// borrower's identity (or link an existing borrower id); it creates/updates an
// ENCRYPTED borrower record (SSN encrypted at rest + hashed for the identity
// graph, so it re-links on future files) and binds applications.co_borrower_id.
// Unlink clears the link only — it never deletes the borrower record. The
// /applications/:id path middleware already scoped the actor to this file.
router.post('/applications/:id/co-borrower', async (req, res) => {
  try {
    const b = req.body || {};
    const appId = req.params.id;
    const ar = await db.query(`SELECT borrower_id, co_borrower_id, llc_id FROM applications WHERE id=$1`, [appId]);
    const app = ar.rows[0];
    if (!app) return res.status(404).json({ error: 'not found' });

    if (b.unlink === true) {
      await db.query(`UPDATE applications SET co_borrower_id=NULL, updated_at=now() WHERE id=$1`, [appId]);
      try { await require('../lib/co-borrower').ensureCoBorrowerIdCondition(appId, null); } catch (_) {}
      // Also drop the co-borrower's ownership link on the file's vesting LLC (#81).
      try { if (app.llc_id && app.co_borrower_id) await require('../lib/llc-borrowers').unlinkBorrower(app.llc_id, app.co_borrower_id); } catch (_) {}
      await audit(req, 'unlink_co_borrower', 'application', appId, {});
      return res.json({ ok: true, unlinked: true });
    }

    const coId = await attachCoBorrowerToApp(appId, app.borrower_id, b);
    await audit(req, 'set_co_borrower', 'application', appId, { coBorrowerId: coId });
    res.json({ ok: true, coBorrowerId: coId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'server error', detail: e.message });
  }
});

// #81 — the subject vesting LLC's borrower-owners and each one's ownership %.
// On a co-borrower file both borrowers own the entity; this reads / sets their
// stakes and keeps the entity linked to both.
router.get('/applications/:id/vesting-llc-owners', async (req, res) => {
  try {
    const a = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (!a.llc_id) return res.json({ llcId: null, owners: [] });
    const llc = (await db.query(`SELECT llc_name FROM llcs WHERE id=$1`, [a.llc_id])).rows[0];
    const owners = await require('../lib/llc-borrowers').getOwners(a.llc_id);
    res.json({ llcId: a.llc_id, llcName: llc && llc.llc_name, owners });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/vesting-llc-owners', async (req, res) => {
  try {
    const a = (await db.query(`SELECT llc_id, borrower_id FROM applications WHERE id=$1`, [req.params.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'not found' });
    if (!a.llc_id) return res.status(400).json({ error: 'link a vesting LLC to this file first' });
    const lb = require('../lib/llc-borrowers');
    const owners = Array.isArray((req.body || {}).owners) ? req.body.owners : [];
    for (const o of owners) {
      const p = lb.pct(o.ownershipPct);
      if (p && typeof p === 'object' && p.error) return res.status(400).json({ error: p.error });
      await lb.linkBorrower(a.llc_id, o.borrowerId, p == null ? null : p);
      // Keep llcs.ownership_pct in step with the PRIMARY owner's stake so the
      // existing LLC verification math stays consistent.
      if (o.borrowerId === a.borrower_id && p != null) {
        await db.query(`UPDATE llcs SET ownership_pct=$2, updated_at=now() WHERE id=$1`, [a.llc_id, p]);
      }
    }
    await audit(req, 'set_vesting_llc_owners', 'application', req.params.id, { count: owners.length });
    res.json({ ok: true, owners: await lb.getOwners(a.llc_id) });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// The entities that are VERIFIABLE from inside this file — NOT the borrower's
// whole LLC library. That set is exactly: the file's vesting entity
// (applications.llc_id) PLUS the entities tied to this borrower's (and any
// co-borrower's) track record — the LLCs that held/flipped the track-record
// properties, either by the real track_records.llc_id link or by a name match
// of the free-text track_records.entity_name against the borrower's own library.
// Any LLC unrelated to the application or the track record is deliberately
// excluded. Returns the same verify bundles as GET /borrowers/:id/llcs plus a
// `vesting` flag, so the in-file review section shows only the relevant entities.
// Path is under the /applications/:id scope middleware (assigned staff / seesAll).
router.get('/applications/:id/verify-llcs', async (req, res) => {
  try {
    const idsRes = await db.query(
      `WITH b AS (SELECT borrower_id, co_borrower_id, llc_id FROM applications WHERE id=$1)
       SELECT DISTINCT x.id FROM (
         -- the file's vesting entity
         SELECT b.llc_id AS id FROM b WHERE b.llc_id IS NOT NULL
         UNION
         -- track-record entities, real FK link
         SELECT t.llc_id FROM track_records t, b
          WHERE t.llc_id IS NOT NULL
            AND t.borrower_id IN (b.borrower_id, b.co_borrower_id)
         UNION
         -- track-record entities recorded only as free-text, matched by name
         -- against THIS borrower's / co-borrower's own library (never global)
         SELECT l.id FROM llcs l, b
          WHERE l.borrower_id IN (b.borrower_id, b.co_borrower_id)
            AND EXISTS (
              SELECT 1 FROM track_records t
               WHERE t.borrower_id IN (b.borrower_id, b.co_borrower_id)
                 AND t.entity_name IS NOT NULL
                 AND lower(btrim(t.entity_name)) = lower(btrim(l.llc_name))
            )
       ) x`, [req.params.id]);
    const app = (await db.query(`SELECT llc_id FROM applications WHERE id=$1`, [req.params.id])).rows[0] || {};
    // Layered entities: every entity that (transitively) OWNS one of the
    // file's entities belongs on the verify surface too — a child can only be
    // verified bottom-up, so staff need its owners in front of them.
    const ids = idsRes.rows.map((r) => String(r.id));
    const layered = new Set();
    for (const id of [...ids]) {
      for (const anc of await llcLib.getAncestorEntityIds(id)) {
        if (!ids.includes(anc)) { ids.push(anc); layered.add(anc); }
      }
    }
    const out = [];
    for (const id of ids) {
      const bundle = await llcLib.getLlcBundle(id);
      if (bundle) out.push({
        ...bundle,
        vesting: app.llc_id === id,
        layered: layered.has(id),   // present because it owns another entity on the file
        missing: llcLib.missingForVerification(bundle, bundle.members, bundle.slots),
      });
    }
    // Vesting entity first, then the rest by name for a stable order.
    out.sort((a2, b2) => (b2.vesting - a2.vesting) || String(a2.llc_name || '').localeCompare(String(b2.llc_name || '')));
    res.json({ vestingLlcId: app.llc_id || null, llcs: out });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// Set (or change) the file's vesting entity — staff parity with the borrower's
// link-llc. The entity must belong to the file's borrower or co-borrower. Honors
// the Clear-to-Close lock (#84) and keeps the multi-borrower owner link, LLC
// document checklist, and LLC condition in step (same follow-through as
// borrower.js link-llc). Used by the in-file entity section when staff stand up
// / pick the vesting entity for a file that has none.
router.post('/applications/:id/vesting-llc', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.llcId) return res.status(400).json({ error: 'llcId required' });
    const app = (await db.query(
      `SELECT id, llc_id, status, borrower_id, co_borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`,
      [req.params.id])).rows[0];
    if (!app) return res.status(404).json({ error: 'not found' });
    if (['clear_to_close', 'funded', 'declined', 'withdrawn'].includes(app.status))
      return res.status(409).json({ error: 'This file is Clear to Close — the vesting entity is locked. Move it back to an earlier status to change it.' });
    const own = (await db.query(
      `SELECT id FROM llcs WHERE id=$1 AND borrower_id = ANY($2::uuid[])`,
      [b.llcId, [app.borrower_id, app.co_borrower_id].filter(Boolean)])).rows[0];
    if (!own) return res.status(404).json({ error: 'entity not found for this borrower' });
    const previous = app.llc_id;
    // Single authority (src/lib/vesting.js): set llc_id + the full wiring (owner
    // links, LLC doc checklist, LLC condition, rule re-eval) AND enqueue the
    // outbound ClickUp push so the portal-set vesting entity propagates back to the
    // task — previously the vesting change was never pushed to ClickUp.
    try { await require('../lib/vesting').setVestingLlc(req.params.id, b.llcId, { source: 'staff', actor: req.actor, force: true }); } catch (_) {}
    await audit(req, 'link_llc', 'application', req.params.id, { llcId: b.llcId, previous });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

/* ---------------- Product registration / term sheet ----------------
   Pricing is computed here on the server from the same FROZEN engines the
   browser loads, so a registered product is always authoritative. */

// Load a joined application row + count the borrower's track record into the
// experience buckets the engines expect (flips / holds / ground-up).
async function loadFileForPricing(appId) {
  const a = await db.query(
    // Pricing FICO = the HIGHEST score across the file's borrowers (#99): with a
    // co-borrower, the stronger credit prices the deal. NULL when neither has one.
    `SELECT a.*, NULLIF(GREATEST(COALESCE(b.fico,0), COALESCE(cb.fico,0)), 0) AS fico
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
      WHERE a.id=$1`, [appId]);
  const app = a.rows[0];
  if (!app) return null;
  // Only VERIFIED deals count toward experience/tier — the same basis the
  // borrowers.tier recompute uses. Unverified, borrower-claimed deals must not
  // inflate the authoritative pricing tier. Staff can still override the exp*
  // inputs in the panel for a what-if.
  // On a co-borrower file the experience is the SUM of BOTH borrowers (#80):
  // e.g. 2 flips each → 4 flips feed the pricing engine. This only changes the
  // COUNT fed in, never the frozen pricing math.
  const expBorrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const tr = await db.query(
    `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
       FROM track_records WHERE borrower_id = ANY($1::uuid[]) AND is_verified=true AND (${RECENT_EXIT_SQL}) GROUP BY 1`, [expBorrowerIds]);
  const exp = { flips: 0, holds: 0, ground: 0 };
  for (const row of tr.rows) {
    if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) exp.ground += row.n;
    else if (row.dt.indexOf('flip') > -1) exp.flips += row.n;
    else exp.holds += row.n;   // fix-and-hold, rental, anything else
  }
  return { app, exp };
}

// Staff pricing overrides: loan officers, processors, underwriters and admins
// can use the same pricing and fee knobs as the marketing term-sheet tool.
// The saved product is still recomputed server-side from the frozen engines,
// so the browser never gets to fabricate final loan terms.
// caps/rate/eligibility that ovrLTC/ovrRate do — and it must stay verified-only
// for non-admins (a loan officer/processor can what-if the deal economics, but
// not inject unverified experience or override the caps/rate). For anyone else
// these keys are stripped. Returns { overrides, strippedAdminKeys }.
// Cap/rate/eligibility overrides and manual experience are ADMIN-ONLY. For
// everyone else they're stripped, so a loan officer/processor/underwriter can
// what-if deal economics but cannot force-register an INELIGIBLE file, inject
// unverified experience, or dictate the rate/caps from the client.
const ADMIN_ONLY_OVERRIDE_KEYS = [
  'forcePrice', 'manualPricing',
  'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths',
  'expFlips', 'expHolds', 'expGround',
];
function sanitizeOverrides(req, raw) {
  const overrides = (raw && typeof raw === 'object') ? { ...raw } : {};
  const role = req.actor && req.actor.role;
  if (role === 'admin' || role === 'super_admin') return { overrides, strippedAdminKeys: false };
  let stripped = false;
  for (const k of ADMIN_ONLY_OVERRIDE_KEYS) {
    if (k in overrides) { delete overrides[k]; stripped = true; }
  }
  return { overrides, strippedAdminKeys: stripped };
}

// Fresh quote for both programs (no persistence). Body: { program?, overrides? }.
router.post('/applications/:id/pricing/quote', async (req, res) => {
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadFileForPricing(req.params.id);
    if (!f) return res.status(404).json({ error: 'not found' });
    const { overrides } = sanitizeOverrides(req, (req.body && req.body.overrides) || {});
    const out = pricing.quoteAll(f.app, f.exp, overrides);
    res.json({ ...out, experience: f.exp });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// Current registered product + history, plus a fresh default quote for the panel.
router.get('/applications/:id/pricing', async (req, res) => {
  try {
    const f = await loadFileForPricing(req.params.id);
    if (!f) return res.status(404).json({ error: 'not found' });
    const hist = await db.query(
      `SELECT r.id, r.program, r.product_label, r.status, r.note_rate, r.total_loan, r.target_ltc,
              r.is_current, r.created_at, r.inputs, r.quote, s.full_name AS registered_by_name
         FROM product_registrations r LEFT JOIN staff_users s ON s.id=r.registered_by
        WHERE r.application_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    const current = hist.rows.find((x) => x.is_current) || null;
    let quote = null;
    if (pricing.enginesReady()) { try { quote = pricing.quoteAll(f.app, f.exp); quote.experience = f.exp; } catch (_) {} }
    res.json({ current, history: hist.rows, quote, enginesReady: pricing.enginesReady() });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// Register a product: recompute authoritatively, persist as the current terms,
// sync loan_amount / rate_pct onto the file, audit + notify the team.
router.post('/applications/:id/pricing/register', async (req, res) => {
  const appId = req.params.id;
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const locked = await require('../lib/file-lock').structuralLockReason(appId);   // #84
    if (locked) return res.status(409).json({ error: locked });
    const b = req.body || {};
    const program = b.program === 'gold' ? 'gold' : 'standard';
    const f = await loadFileForPricing(appId);
    if (!f) return res.status(404).json({ error: 'not found' });

    const { overrides } = sanitizeOverrides(req, b.overrides || {});
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    // S3-06: this endpoint writes arv back onto the file and sizes the loan off
    // both the arv and the as-is value, so a raised arv/as-is OVERRIDE here is the
    // same higher-leverage raise the /details + /complete-fields gates forbid. On a
    // priced file (re-registration), a non-seesAll staffer may not raise either.
    // Underwriters/admins and the FIRST registration (not yet priced) are unaffected.
    if (!seesAll(req) && await changeRequests.isBorrowerLocked(appId)) {
      const oa = f.app.arv == null ? null : Number(f.app.arv);
      const oi = f.app.as_is_value == null ? null : Number(f.app.as_is_value);
      const na = inputs.arv == null ? null : Number(inputs.arv);
      const ni = inputs.asIsValue == null ? null : Number(inputs.asIsValue);
      const raised = [];
      if (oa != null && na != null && na > oa) raised.push('the ARV');
      if (oi != null && ni != null && ni > oi) raised.push('the as-is value');
      if (raised.length)
        return res.status(403).json({ error: `Only an underwriter or admin can raise ${raised.join(' and ')} on a priced file.` });
    }
    const quote = pricing.quoteProgram(program, inputs);
    // Gold Standard renovation cannot finance an interest reserve — never persist a
    // requested reserve on the registered scenario for that program.
    if (program === 'gold' && quote.kind === 'reno') inputs.irMonths = 0;
    if (quote.status === 'INELIGIBLE' && !overrides.forcePrice) {
      return res.status(422).json({ error: 'ineligible', reasons: quote.reasons, quote });
    }
    const total = quote.sizing ? quote.sizing.totalLoan : 0;
    if (!(total > 0)) return res.status(422).json({ error: 'no loan sized', quote });

    // The superseded terms, captured before the new row lands — the audit trail
    // (and Activity feed) shows exactly what a reprice changed.
    const prevQ = await db.query(
      `SELECT program, total_loan, note_rate, product_label FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    const prev = prevQ.rows[0] || null;

    const client = await db.getClient();
    let regId;
    try {
      await client.query('BEGIN');
      regId = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: req.actor.id,
      });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
    // Registration rewrites loan amount / rate / program — re-run condition rules.
    try { await conditionEngine.evaluateApplication(appId, { actor: req.actor, reason: 'product_registered' }); } catch (_) {}

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null,
        origination: quote.origination != null ? quote.origination : undefined,
        origPct: quote.origPct != null ? quote.origPct : undefined,
        cashToClose: quote.cashToClose != null ? quote.cashToClose : undefined,
        liquidity: (quote.liquidity ?? quote.liquidityRequired) != null ? (quote.liquidity ?? quote.liquidityRequired) : undefined,
        previous: prev ? { program: prev.program, totalLoan: Number(prev.total_loan), noteRate: Number(prev.note_rate), productLabel: prev.product_label } : undefined });

    // Registering (or RE-registering) the product REOPENS the "Products & pricing"
    // condition for re-verification: a new registration changes the structure, so
    // any prior review / sign-off is cleared and the condition returns to
    // 'received' (awaiting re-verification), even if it was already signed off.
    try {
      await db.query(
        `UPDATE checklist_items
            SET status='received', signed_off_at=NULL, signed_off_by=NULL,
                reviewed_at=NULL, reviewed_by=NULL, updated_at=now()
          WHERE application_id=$1 AND tool_key='product_pricing'`, [appId]);
    } catch (_) { /* condition may not exist on older files */ }

    // Dynamic liquidity: the registered quote knows the exact cash-to-close +
    // reserve requirement, so write that into the bank-statement condition (and
    // reopen it if the required liquidity went UP since it was last signed off).
    // (#59 — writing the priced experience back onto the application and
    // repopulating the track-record condition is handled inside
    // persistProductRegistration above.)
    try { await require('../lib/liquidity').syncLiquidityCondition(appId, quote); } catch (_) {}
    // Gold Standard Program requires a 5% SOW contingency: if the file just
    // registered Gold and the saved Scope of Work doesn't carry it, REOPEN the
    // rehab-budget condition (even if it was already signed off) with a FATAL note.
    try { await require('../lib/rehab-budget').enforceGoldSowContingency(appId); } catch (_) {}

    // Register committed the priced scenario onto the file (loan amount, rate,
    // rehab budget, term, IR months, ARV / as-is / purchase, assignment split,
    // desired rate). Push those changed fields to ClickUp immediately so the task
    // mirrors the registration instead of waiting for the next reconcile.
    require('../clickup/orchestrator').pushApplication(appId).catch((e) => console.error('[clickup] push after register (staff)', appId, e && e.message));

    // Notify the assigned team (LO + processor), not the borrower.
    try {
      const t = await db.query(`SELECT loan_officer_id, processor_id, ys_loan_number FROM applications WHERE id=$1`, [appId]);
      const row = t.rows[0] || {};
      const pctRate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : '—';
      const dollars = '$' + Math.round(total).toLocaleString('en-US');
      const money2 = (n) => (n == null ? '—' : '$' + Math.round(Number(n)).toLocaleString('en-US'));
      const szn = quote.sizing || {};
      const ctx = await notify.fileContext(appId, [
        { label: 'Registered product', value: [quote.programLabel, quote.productLabel].filter(Boolean).join(' - ') || pricing.PROGRAM_LABEL[program] },
        { label: 'Total loan', value: `${dollars} @ ${pctRate}` },
        szn.downPayment != null ? { label: 'Down payment', value: money2(szn.downPayment) } : null,
        quote.cashToClose != null ? { label: 'Cash to close', value: money2(quote.cashToClose) } : null,
        (quote.liquidity ?? quote.liquidityRequired) != null ? { label: 'Liquidity to verify', value: money2(quote.liquidity ?? quote.liquidityRequired) } : null,
      ].filter(Boolean));
      const body = `${pricing.PROGRAM_LABEL[program]} · ${dollars} @ ${pctRate}${quote.status !== 'ELIGIBLE' ? ' (' + quote.status.toLowerCase() + ')' : ''} on ${ctx ? ctx.label : 'the file'} · cash to close ${money2(quote.cashToClose)} · liquidity ${money2(quote.liquidity ?? quote.liquidityRequired)}`;
      for (const sid of [row.loan_officer_id, row.processor_id]) {
        if (sid && sid !== req.actor.id) await notify.notifyStaff(sid, {
          type: 'product_registered', title: 'Product registered on ' + (row.ys_loan_number || 'a file'),
          body, meta: (ctx && ctx.meta) || undefined, applicationId: appId,
          link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file' });
      }
    } catch (_) { /* notification is best-effort */ }

    res.status(201).json({ ok: true, registrationId: regId, quote });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// Staff build/adjust a file's rehab budget (scope of work) — for staff-run
// files where the borrower isn't filling it in. Upserts the rehab_budget tool
// item's payload and syncs applications.rehab_budget (feeds pricing).
router.post('/applications/:id/rehab-budget', async (req, res) => {
  const appId = req.params.id;
  const payload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : null;
  if (!payload) return res.status(400).json({ error: 'payload required' });
  const locked = await require('../lib/file-lock').structuralLockReason(appId);   // #84
  if (locked) return res.status(409).json({ error: locked });
  try {
    let it = await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' LIMIT 1`, [appId]);
    let itemId = it.rows[0] && it.rows[0].id;
    if (!itemId) {
      const ins = await db.query(
        `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,tool_key,created_by_kind,created_by_id)
         VALUES ('application',$1,'Rehab budget','Rehab budget','borrower','task','rehab_budget','staff',$2) RETURNING id`, [appId, req.actor.id]);
      itemId = ins.rows[0].id;
    }
    // Scope-of-Work condition logic (owner-directed 2026-07-09): the SOW always
    // saves (never refused) and NEVER changes the file's rehab budget (frozen). The
    // exact-match rule is a CONDITION gate only — the condition stays open with a
    // plain-language note until the line items total the budget exactly.
    const total = Number(payload.total);
    const chk = await require('../lib/rehab-budget').checkSowBudget(appId, payload);
    const mismatch = chk.ok ? null : { required: chk.required, total, message: chk.message };
    const goldSow = await require('../lib/rehab-budget').checkGoldSow(appId, payload);
    const st = (mismatch || !goldSow.ok) ? (isFinite(total) && total > 0 ? 'issue' : null) : 'received';
    await db.query(`UPDATE checklist_items SET tool_payload=$2, status=COALESCE($3,status), updated_at=now() WHERE id=$1`, [itemId, JSON.stringify(payload), st]);
    const rbMoney = require('../lib/rehab-budget').money;
    const note = mismatch
      ? `[auto] Scope of Work (line items ${rbMoney(total)}) does not match the file's rehab budget ${rbMoney(mismatch.required)} — this condition stays open for all parties until the first-page construction budget AND the line items each total exactly ${rbMoney(mismatch.required)}.`
      : (!goldSow.ok
        ? `[auto] ${require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG}`
        : `[auto] Scope of Work totals ${rbMoney(total)} and matches the file's rehab budget — ready to clear.`);
    try { await db.query(`UPDATE checklist_items SET notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END, updated_at=now() WHERE id=$1`, [itemId, note]); } catch (_) {}
    await audit(req, 'save_rehab_budget', 'application', appId, { total: isFinite(total) ? total : null });
    try { await conditionEngine.evaluateApplication(appId, { actor: req.actor, reason: 'rehab_budget_saved' }); } catch (_) {}
    const notice = mismatch || (!goldSow.ok ? { gold: true, message: require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG } : undefined);
    res.json({ ok: true, itemId, mismatch: notice });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- Scope of Work tool (staff side) ----------------
// Staff open the same static Scope of Work builder as the borrower, on the
// same condition: load/autosave the draft state, and submit to snapshot the
// state + regenerate the PDF/Excel exports on the file.
router.get('/applications/:id/checklist/:itemId/tool-state', async (req, res) => {
  const r = await db.query(
    `SELECT tool_state, tool_payload, status FROM checklist_items
      WHERE id=$1 AND application_id=$2 AND tool_key IS NOT NULL`,
    [req.params.itemId, req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  const row = r.rows[0];
  const state = row.tool_state || (row.tool_payload && row.tool_payload.state) || null;
  res.json({ state, status: row.status, submitted: !!row.tool_payload });
});
router.put('/applications/:id/checklist/:itemId/tool-state', async (req, res) => {
  const state = (req.body && typeof req.body.state === 'object') ? req.body.state : null;
  if (!state) return res.status(400).json({ error: 'state required' });
  const r = await db.query(
    `UPDATE checklist_items SET tool_state=$3, updated_at=now()
      WHERE id=$1 AND application_id=$2 AND tool_key IS NOT NULL RETURNING id`,
    [req.params.itemId, req.params.id, JSON.stringify(state)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  res.json({ ok: true, savedAt: new Date().toISOString() });
});
router.post('/applications/:id/checklist/:itemId/tool', async (req, res) => {
  const it = await db.query(
    `SELECT ci.id, ci.tool_key, a.borrower_id
       FROM checklist_items ci JOIN applications a ON a.id=ci.application_id
      WHERE ci.id=$1 AND ci.application_id=$2 AND ci.tool_key IS NOT NULL`,
    [req.params.itemId, req.params.id]);
  if (!it.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  const toolKey = it.rows[0].tool_key;
  if (toolKey === 'rehab_budget') {   // #84 — rehab budget is loan structure, frozen at CTC
    const locked = await require('../lib/file-lock').structuralLockReason(req.params.id);
    if (locked) return res.status(409).json({ error: locked, fatal: true });
  }
  const rawPayload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : { submitted: true };
  const attachments = (Array.isArray(rawPayload.attachments) ? rawPayload.attachments : []).slice(0, 4)
    .map((a) => ({
      filename: String(a.filename || 'tool-export.txt').replace(/[\\/:*?"<>|]/g, '_').slice(0, 160),
      contentType: String(a.contentType || 'application/octet-stream').slice(0, 120),
      dataBase64: String(a.dataBase64 || ''),
    })).filter((a) => a.filename && a.dataBase64);
  const payload = { ...rawPayload };
  delete payload.attachments;
  if (attachments.length) payload.export_files = attachments.map((a) => ({ filename: a.filename, contentType: a.contentType }));
  // Scope-of-Work condition logic (owner-directed 2026-07-09): the SOW always saves
  // (never refused) and NEVER changes the file's rehab budget (frozen). The
  // exact-match rule is a CONDITION gate only — the condition stays open with a
  // plain-language note until the line items total the budget exactly.
  let sowMismatch = null, goldSow = { ok: true };
  if (toolKey === 'rehab_budget') {
    const chk = await require('../lib/rehab-budget').checkSowBudget(req.params.id, payload);
    if (!chk.ok) sowMismatch = { required: chk.required, total: Number(payload && payload.total), message: chk.message };
    goldSow = await require('../lib/rehab-budget').checkGoldSow(req.params.id, payload);
  }
  const rbTotal = Number(payload && payload.total);
  const toolStatus = (sowMismatch || !goldSow.ok) ? (isFinite(rbTotal) && rbTotal > 0 ? 'issue' : null) : 'received';
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, tool_state=COALESCE($3,tool_state), status=COALESCE($4,status), updated_at=now() WHERE id=$1`,
    [req.params.itemId, JSON.stringify(payload),
     payload && typeof payload.state === 'object' ? JSON.stringify(payload.state) : null, toolStatus]);
  if (toolKey === 'rehab_budget') {
    const rbMoney = require('../lib/rehab-budget').money;
    const note = sowMismatch
      ? `[auto] Scope of Work (line items ${rbMoney(rbTotal)}) does not match the file's rehab budget ${rbMoney(sowMismatch.required)} — this condition stays open for all parties until the first-page construction budget AND the line items each total exactly ${rbMoney(sowMismatch.required)}.`
      : (!goldSow.ok
        ? `[auto] ${require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG}`
        : `[auto] Scope of Work totals ${rbMoney(rbTotal)} and matches the file's rehab budget — ready to clear.`);
    try { await db.query(`UPDATE checklist_items SET notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END, updated_at=now() WHERE id=$1`, [req.params.itemId, note]); } catch (_) {}
    try { await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'rehab_budget_saved' }); } catch (_) {}
  }
  // A resubmission outdates the previous exports: the old PDF/Excel are
  // superseded and the fresh ones become the current versions on the condition.
  await db.query(
    `UPDATE documents SET is_current=false,
        review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
      WHERE checklist_item_id=$1 AND source_type='system' AND is_current=true`, [req.params.itemId]);
  const out = [];
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  for (const a of attachments) {
    const buf = Buffer.from(a.dataBase64, 'base64');
    if (!buf.length || buf.length > maxBytes) continue;
    const { ref, provider } = await storage.save(buf, { filename: a.filename });
    const r = await db.query(
      `INSERT INTO documents
         (checklist_item_id,application_id,borrower_id,filename,content_type,size_bytes,
          storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,source_type,visibility,doc_kind)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,'system','borrower',$10) RETURNING id`,
      [req.params.itemId, req.params.id, it.rows[0].borrower_id, a.filename, a.contentType, buf.length,
       provider, ref, req.actor.id, toolKey + '_export']);
    out.push({ id: r.rows[0].id, filename: a.filename });
  }
  await audit(req, 'staff_tool_submit', 'checklist_item', req.params.itemId, { toolKey, files: out.map((x) => x.filename) });
  if (out.length) { try { require('../lib/sharepoint-backup').kick(); } catch (_) {} }
  const sowNotice = sowMismatch || (!goldSow.ok ? { gold: true, message: require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG } : undefined);
  res.json({ ok: true, status: toolStatus || 'outstanding', mismatch: sowNotice, exports: out });
});

router.get('/applications/:id/checklist', async (req, res) => {
  // Recompute the experience/track-record condition from the file's current
  // requested experience + verified counts BEFORE reading the checklist — same as
  // the borrower side (borrower.js). Without this the staff conditions view could
  // show a stale "No experience required" after experience was entered on the
  // application or in Products & Pricing (all-sides parity).
  try { await syncExperienceChecklistForApplication(req.params.id); } catch (_) { /* best-effort */ }
  const r = await db.query(
    `SELECT ci.id, ci.label, ci.status, ci.audience, ci.item_kind, ci.is_required,
            ci.phase, ci.role_scope, ci.hint, ci.is_gate, ci.is_milestone, ci.sort_order,
            ci.due_date, ci.notes, ci.created_by_kind, ci.created_at,
            ci.field_key, ci.category, ci.origin_kind, ci.origin_detail, ci.esign_doc, ci.borrower_label,
            -- The borrower-facing hint carries an "accept + request another document"
            -- ask ("Still needed: …") — staff must see what was requested, not only
            -- the borrower (#125). Rendered on the staff borrower-conditions panel.
            ci.borrower_hint,
            (SELECT code FROM checklist_templates t WHERE t.id=ci.template_id) AS template_code,
            (SELECT slots FROM checklist_templates t WHERE t.id=ci.template_id) AS slots,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            ci.assignee_staff_id, asg.full_name AS assignee_name,
            ci.signed_off_by, so.full_name AS signed_off_name, ci.signed_off_at,
            ci.reviewed_by, rv.full_name AS reviewed_by_name, ci.reviewed_at,
            -- The borrower-visible reason a condition was rejected / pushed back /
            -- raised (#125): staff must see it on the condition too, not only in the
            -- separate documents panel. Falls back to the latest rejected document's
            -- reason so the staff condition row shows the same "why" the borrower sees.
            ci.issue_reason, ci.raised_entity,
            (SELECT d.rejection_reason FROM documents d
              WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
              ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1) AS rejection_reason
       FROM checklist_items ci
       LEFT JOIN staff_users asg ON asg.id = ci.assignee_staff_id
       LEFT JOIN staff_users so  ON so.id  = ci.signed_off_by
       LEFT JOIN staff_users rv  ON rv.id  = ci.reviewed_by
      WHERE ci.application_id=$1
      ORDER BY ci.sort_order, ci.created_at`, [req.params.id]);
  res.json(r.rows);
});

// add a borrower-facing document request
router.post('/applications/:id/checklist', async (req, res) => {
  const b = req.body || {};
  if (!b.label) return res.status(400).json({ error: 'label required' });
  // This IS a borrower-facing request — the typed label is what the borrower
  // should see, so it doubles as the borrower_label. Without it the borrower
  // portal would show the generic "An item your loan team needs" (#78).
  const audience = b.audience || 'borrower';
  const borrowerLabel = (audience === 'borrower' || audience === 'both')
    ? scrubText(String(b.borrowerLabel || b.label).trim().slice(0, 300)) : null;
  const r = await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,borrower_label,audience,item_kind,is_required,due_date,created_by_kind,created_by_id)
     VALUES ('application',$1,$2,$3,$4,'document',$5,$6,'staff',$7) RETURNING id`,
    [req.params.id, b.label, borrowerLabel, audience, b.isRequired !== false, b.dueDate || null, req.actor.id]);
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
  // Only tell the borrower when the item is actually borrower-facing, and show
  // them the BORROWER-facing wording (never the internal label). (S2-02)
  if (app.rows[0] && audience !== 'staff') {
    const ctx = await notify.fileContext(req.params.id);
    await notify.notifyBorrower(app.rows[0].borrower_id, {
      type: 'condition_added', title: 'New document requested on your file',
      body: `"${borrowerLabel || b.label}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
      meta: (ctx && ctx.meta) || undefined,
      applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Open your conditions' });
  }
  await audit(req, 'add_checklist_item', 'application', req.params.id, { label: b.label });
  res.status(201).json({ ok: true, itemId: r.rows[0].id });
});

// add an internal condition (staff-facing by default)
router.post('/applications/:id/conditions', async (req, res) => {
  const b = req.body || {};
  if (!b.label) return res.status(400).json({ error: 'label required' });
  const r = await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,audience,item_kind,is_required,notes,created_by_kind,created_by_id)
     VALUES ('application',$1,$2,$3,'condition',$4,$5,'staff',$6) RETURNING id`,
    [req.params.id, b.label, b.audience || 'staff', b.isRequired !== false, b.notes || null, req.actor.id]);
  await audit(req, 'add_condition', 'application', req.params.id, { label: b.label });
  res.status(201).json({ ok: true, itemId: r.rows[0].id });
});

// ---------------- Condition Center: per-file conditions ----------------
// Everything staff need to build a one-off condition on THIS file with the
// same type system the admin studio uses (document / info field / form-tool /
// e-sign / internal), plus attaching a library definition manually and
// re-running the automatic rules on demand.

// Field registry + type vocabulary + the attachable library, for the staff UI.
router.get('/conditions/meta', async (req, res) => {
  const lib = await db.query(
    `SELECT * FROM checklist_templates
      WHERE is_active=true AND scope='application'
      ORDER BY sort_order, label`);
  const fields = await conditionRegistry.fieldMap(db);
  res.json({
    fields: await conditionRegistry.publicFieldsAll(db),
    operators: conditionRules.OPERATORS_BY_TYPE,
    operatorLabels: conditionRules.OPERATOR_LABEL,
    categories: CATEGORIES,
    types: Object.entries(CONDITION_TYPES).map(([v, t]) => ({ v, label: t.label })),
    tools: TOOLS,
    library: lib.rows.map((t) => ({
      id: t.id, code: t.code, label: t.label, borrowerLabel: t.borrower_label,
      conditionType: conditionTypeOf(t), audience: t.audience, category: t.category,
      autoApply: t.auto_apply, fieldKey: t.field_key,
      ruleSummary: t.rule_logic ? conditionRules.summarizeRule(t.rule_logic, { fields }) : null,
    })),
  });
});

// Add a custom condition of any type to this file.
router.post('/applications/:id/conditions/custom', async (req, res) => {
  const b = req.body || {};
  const type = CONDITION_TYPES[b.conditionType] ? b.conditionType : null;
  if (!type) return res.status(400).json({ error: 'pick a condition type' });
  const label = String(b.label || '').trim();
  if (!label) return res.status(400).json({ error: 'label required' });
  const audience = ['borrower', 'staff', 'both'].includes(b.audience) ? b.audience
    : (type === 'internal_task' || type === 'internal_condition' ? 'staff' : 'borrower');
  let toolKey = CONDITION_TYPES[type].toolKey;
  if (type === 'tool') {
    if (!TOOLS.some((t) => t.v === b.toolKey)) return res.status(400).json({ error: 'pick a form/tool' });
    toolKey = b.toolKey;
  }
  let fieldKey = null;
  if (type === 'info_field') {
    const f = (await conditionRegistry.fieldMap(db))[b.fieldKey];
    if (!f || !f.writable) return res.status(400).json({ error: 'an information condition needs a fillable field' });
    if (audience === 'staff') return res.status(400).json({ error: 'an information condition must be visible to the borrower' });
    fieldKey = b.fieldKey;
  }
  const category = CATEGORIES.some((c) => c.v === b.category) ? b.category : null;
  if ((type === 'internal_task' || type === 'internal_condition') && audience !== 'staff') {
    return res.status(400).json({ error: 'internal items must have an internal audience' });
  }
  const r = await db.query(
    `INSERT INTO checklist_items
       (scope,application_id,label,borrower_label,hint,borrower_hint,audience,item_kind,tool_key,field_key,
        esign_doc,category,is_required,due_date,notes,created_by_kind,created_by_id,origin_kind)
     VALUES ('application',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'staff',$15,'manual_custom')
     RETURNING id`,
    [req.params.id, label.slice(0, 300),
     scrubText(String(b.borrowerLabel || '').trim().slice(0, 300)) || null,
     String(b.hint || '').trim().slice(0, 2000) || null,
     scrubText(String(b.borrowerHint || '').trim().slice(0, 2000)) || null,
     audience, CONDITION_TYPES[type].itemKind, toolKey || null, fieldKey,
     type === 'esign' ? (String(b.esignDoc || '').trim().slice(0, 300) || null) : null,
     category, b.isRequired !== false, b.dueDate || null,
     String(b.notes || '').trim().slice(0, 2000) || null, req.actor.id]);
  await audit(req, 'add_condition_custom', 'application', req.params.id, { label, type, audience });
  if (audience !== 'staff') {
    try {
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppBorrowers(req.params.id, {
        type: 'condition_added', title: 'A new item was added to your file',
        // Never interpolate the internal label — it can carry underwriting /
        // capital-partner (note-buyer) context. Borrower wording or a generic line.
        body: b.borrowerLabel
          ? `"${b.borrowerLabel}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`
          : `A new item was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
        meta: (ctx && ctx.meta) || undefined,
        applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Open your conditions' });
    } catch (_) { /* best-effort */ }
  }
  res.status(201).json({ ok: true, itemId: r.rows[0].id });
});

// Attach a library definition to this file by hand (dedup per template).
router.post('/applications/:id/conditions/attach', async (req, res) => {
  const tplId = (req.body || {}).templateId;
  if (!tplId) return res.status(400).json({ error: 'templateId required' });
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE id=$1 AND is_active=true AND scope='application'`, [tplId]);
  if (!t.rows[0]) return res.status(404).json({ error: 'condition definition not found' });
  const dup = await db.query(
    `SELECT 1 FROM checklist_items WHERE application_id=$1 AND template_id=$2 LIMIT 1`,
    [req.params.id, tplId]);
  if (dup.rows[0]) return res.status(409).json({ error: 'this condition is already on the file' });
  const tpl = t.rows[0];
  const itemId = await conditionEngine.instantiateTemplate(tpl, { application_id: req.params.id }, {
    createdByKind: 'staff', createdById: req.actor.id, originKind: 'manual_library',
    originDetail: { templateVersion: tpl.version },
  });
  await audit(req, 'attach_condition', 'application', req.params.id, { label: tpl.label, templateId: tplId });
  if (tpl.audience !== 'staff') {
    try {
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppBorrowers(req.params.id, {
        type: 'condition_added', title: 'A new item was added to your file',
        // Borrower wording only — never fall back to the internal tpl.label.
        body: tpl.borrower_label
          ? `"${tpl.borrower_label}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`
          : `A new item was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
        meta: (ctx && ctx.meta) || undefined,
        applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Open your conditions' });
    } catch (_) { /* best-effort */ }
  }
  res.status(201).json({ ok: true, itemId });
});

// Re-run the automatic condition rules for this one file.
router.post('/applications/:id/conditions/reevaluate', async (req, res) => {
  const result = await conditionEngine.evaluateApplication(req.params.id, {
    actor: req.actor, reason: 'manual_reevaluate',
  });
  res.json({ ok: true, added: result.added, removed: result.removed });
});

// ---- post-closing ----
router.get('/applications/:id/post-closing', async (req, res) => {
  const r = await db.query(
    `SELECT p.*, s.full_name AS assignee_name FROM post_closing_items p
       LEFT JOIN staff_users s ON s.id=p.assigned_staff_id
      WHERE p.application_id=$1 ORDER BY p.created_at`, [req.params.id]);
  res.json(r.rows);
});
router.post('/applications/:id/post-closing/seed', async (req, res) => {
  try { await seedPostClosing(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.patch('/post-closing/:pid', async (req, res) => {
  const b = req.body || {};
  try {
    const c = await db.query(`SELECT application_id FROM post_closing_items WHERE id=$1`, [req.params.pid]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, c.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    const status = ['pending', 'ordered', 'received', 'accepted', 'exception'].includes(b.status) ? b.status : null;
    await db.query(
      `UPDATE post_closing_items SET
         status=COALESCE($2,status),
         exception_note=CASE WHEN $3::text IS NOT NULL THEN $3 ELSE exception_note END,
         assigned_staff_id=CASE WHEN $4::uuid IS NOT NULL THEN $4 ELSE assigned_staff_id END,
         updated_at=now() WHERE id=$1`,
      [req.params.pid, status, b.exceptionNote ?? null, b.assigneeStaffId || null]);
    await audit(req, 'post_closing_update', 'application', c.rows[0].application_id, { pid: req.params.pid, status });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// TPR / clean-file export — streams a stacked ZIP of the accepted+current
// document set with a manifest. Staff-only (path middleware already scoped it).
router.get('/applications/:id/export/tpr', async (req, res) => {
  try {
    const { zip, filename } = await require('../lib/tpr-export').buildTprExport(req.params.id);
    await audit(req, 'export_tpr', 'application', req.params.id, { bytes: zip.length });
    // Owner-directed (2026-07-13): every export is also kept on the file and
    // mirrored into SharePoint ("YS portal syncing/TPR Exports", versioned on
    // re-export). Best-effort — a save failure never blocks the download.
    try { await require('../lib/tpr-export').saveTprExportDocument(req.params.id, zip, filename, req.actor.id); }
    catch (e2) { console.warn('[tpr-export] save-to-file failed:', e2.message); }
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zip);
  } catch (e) { res.status(500).json({ error: 'export failed' }); }
});
// Readiness preview (counts + missing list) without building the whole zip.
router.get('/applications/:id/export/tpr/preview', async (req, res) => {
  try {
    const included = (await db.query(
      `SELECT count(*)::int c FROM documents
        WHERE (application_id=$1
               OR (application_id IS NULL AND llc_id IS NOT NULL
                   AND llc_id=(SELECT llc_id FROM applications WHERE id=$1)))
          AND review_status='accepted' AND is_current=true AND source_type<>'chat_attachment'
          AND NOT EXISTS (SELECT 1 FROM checklist_items ci WHERE ci.id = documents.checklist_item_id AND ci.tpr_exclude IS TRUE)`, [req.params.id])).rows[0].c;
    // The DPR also packages the borrower's (+ co-borrower's) track-record
    // verification documents — count them so the panel promise matches the ZIP.
    const trackDocs = (await db.query(
      `SELECT count(*)::int c FROM documents
        WHERE is_current=true AND source_type<>'chat_attachment' AND review_status<>'rejected'
          AND track_record_id IN (
            SELECT id FROM track_records WHERE borrower_id IN (
              SELECT borrower_id FROM applications WHERE id=$1
              UNION SELECT co_borrower_id FROM applications WHERE id=$1 AND co_borrower_id IS NOT NULL))`, [req.params.id])).rows[0].c;
    // A document condition only counts as "missing" for the export when it has
    // NO accepted current document and isn't satisfied/signed off. (Accepting a
    // document now leaves the condition 'received' until sign-off — #135 — so
    // 'satisfied' alone would wrongly flag accepted-but-unsigned docs as missing.)
    const missing = (await db.query(
      `SELECT COALESCE(label,'(document)') AS label FROM checklist_items ci
        WHERE application_id=$1 AND item_kind='document' AND status<>'satisfied'
          AND signed_off_at IS NULL AND tpr_exclude IS NOT TRUE
          AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.checklist_item_id=ci.id AND d.is_current AND d.review_status='accepted')
        ORDER BY sort_order`, [req.params.id])).rows.map(r => r.label);
    res.json({ includedCount: included, trackDocs, missing });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Full file activity feed (staff sees everything, including internal).
router.get('/applications/:id/activity', async (req, res) => {
  try { res.json(await require('../lib/activity').fileActivity(req.params.id, false)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---- first-class conditions (object model) ----
router.get('/applications/:id/conditions', async (req, res) => {
  const r = await db.query(
    `SELECT c.*, cb.full_name AS created_by_name, xb.full_name AS cleared_by_name,
            rb.full_name AS reviewed_by_name
       FROM conditions c
       LEFT JOIN staff_users cb ON cb.id=c.created_by
       LEFT JOIN staff_users xb ON xb.id=c.cleared_by
       LEFT JOIN staff_users rb ON rb.id=c.reviewed_by
      WHERE c.application_id=$1 ORDER BY (c.status='open') DESC, c.created_at DESC`, [req.params.id]);
  res.json(r.rows);
});
router.post('/applications/:id/loan-conditions', async (req, res) => {
  const b = req.body || {};
  if (!b.title && !b.borrowerTitle) return res.status(400).json({ error: 'title required' });
  const audience = ['staff', 'borrower', 'both'].includes(b.audience) ? b.audience : 'staff';
  const severity = ['standard', 'prior_to_docs', 'prior_to_funding', 'post_closing'].includes(b.severity) ? b.severity : 'standard';
  try {
    const r = await db.query(
      `INSERT INTO conditions (application_id,title,borrower_title,detail,borrower_detail,audience,severity,linked_entity_type,linked_entity_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [req.params.id, b.title || b.borrowerTitle, b.borrowerTitle || null, b.detail || null, b.borrowerDetail || null,
       audience, severity, b.linkedEntityType || null, b.linkedEntityId || null, req.actor.id]);
    await audit(req, 'add_loan_condition', 'application', req.params.id, { severity, audience });
    if (audience !== 'staff') {
      const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
      if (a.rows[0]?.borrower_id) {
        try {
          await notify.notifyAppBorrowers(req.params.id, {
            type: 'condition_added', title: 'A new item needs your attention',
            // Never surface the internal title to the borrower — use the
            // borrower-facing wording, or a generic prompt if none was given.
            body: b.borrowerTitle || 'Your loan team added an item to your file — sign in to see what we need.',
            applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'See what we need' });
        } catch (_) {}
      }
    }
    res.status(201).json({ ok: true, conditionId: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Clearing (signing off) a first-class condition is the PROCESSOR/underwriter's
// call (audit S3-01) — a loan officer marks it REVIEWED instead (below), never
// cleared. Mirrors the checklist sign-off gate + the sibling /waive gate.
router.post('/loan-conditions/:cid/clear', async (req, res) => {
  if (!can(req.actor, 'sign_off_conditions'))
    return res.status(403).json({ error: 'Only a processor or underwriter can clear (sign off) a condition — mark it reviewed instead.' });
  try {
    const c = await db.query(`SELECT application_id FROM conditions WHERE id=$1`, [req.params.cid]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, c.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    await db.query(`UPDATE conditions SET status='cleared', cleared_by=$2, cleared_at=now(), updated_at=now() WHERE id=$1`, [req.params.cid, req.actor.id]);
    await audit(req, 'clear_condition', 'condition', req.params.cid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// The lighter "reviewed" stamp — a loan officer's "I looked at it / I believe
// it's done". It NEVER changes the condition's status (still open until a
// sign-off holder clears/waives it); it just records who reviewed it and when.
// Sign-off holders may review too. `{reviewed:false}` clears the stamp.
router.post('/loan-conditions/:cid/review', async (req, res) => {
  if (!can(req.actor, 'review_conditions') && !can(req.actor, 'sign_off_conditions'))
    return res.status(403).json({ error: 'You do not have permission to review conditions on this file.' });
  const reviewed = !(req.body && req.body.reviewed === false);
  try {
    const c = await db.query(`SELECT application_id FROM conditions WHERE id=$1`, [req.params.cid]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, c.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    await db.query(
      reviewed
        ? `UPDATE conditions SET reviewed_by=$2, reviewed_at=now(), updated_at=now() WHERE id=$1`
        : `UPDATE conditions SET reviewed_by=NULL, reviewed_at=NULL, updated_at=now() WHERE id=$1`,
      [req.params.cid, reviewed ? req.actor.id : null]);
    await audit(req, reviewed ? 'review_condition' : 'unreview_condition', 'condition', req.params.cid);
    res.json({ ok: true, reviewed });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/loan-conditions/:cid/waive', async (req, res) => {
  if (!can(req.actor, 'waive_conditions')) return res.status(403).json({ error: 'you do not have permission to waive conditions' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'a waive reason is required' });
  try {
    // Per-file authorization — mirror the sibling /clear endpoint. Having the
    // waive_conditions capability must not let a scoped staffer waive a condition
    // on a file they aren't assigned to.
    const c = await db.query(`SELECT application_id FROM conditions WHERE id=$1`, [req.params.cid]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, c.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(`UPDATE conditions SET status='waived', waive_reason=$2, cleared_by=$3, cleared_at=now(), updated_at=now() WHERE id=$1 RETURNING id`, [req.params.cid, reason.slice(0, 500), req.actor.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'waive_condition', 'condition', req.params.cid, { reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- borrower change requests (S5-03 sandbox) ----------------
// On a REGISTERED file, a borrower can no longer edit the deal economics
// directly; each proposed change is a `change_requests` row the assigned loan
// officer / processor approves or rejects here. Approving applies the value in an
// audited write (which re-fires the economics-reopen trigger); rejecting closes
// it and the live record never changed.
router.get('/applications/:id/change-requests', async (req, res) => {
  const r = await db.query(
    `SELECT cr.id, cr.field, cr.field_label, cr.old_value, cr.new_value, cr.reason, cr.status,
            cr.decision_note, cr.created_at, cr.decided_at, cr.requested_by_kind,
            db_.full_name AS decided_by_name
       FROM change_requests cr
       LEFT JOIN staff_users db_ ON db_.id=cr.decided_by
      WHERE cr.application_id=$1
      ORDER BY (cr.status='pending') DESC, cr.created_at DESC`, [req.params.id]);
  res.json(r.rows);
});

// Approve a pending change request → apply the value to the live record.
router.post('/change-requests/:cid/approve', async (req, res) => {
  const note = String((req.body || {}).note || '').trim() || null;
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    // Lock the row so two reviewers can't both apply it.
    const cr = (await client.query(
      `SELECT * FROM change_requests WHERE id=$1 FOR UPDATE`, [req.params.cid])).rows[0];
    if (!cr) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    if (!(await canTouchApp(req, cr.application_id))) { await client.query('ROLLBACK'); return res.status(403).json({ error: 'forbidden' }); }
    if (cr.status !== 'pending') { await client.query('ROLLBACK'); return res.status(409).json({ error: `this request is already ${cr.status}` }); }
    const applied = await changeRequests.applyRequest(client, cr, req.actor.id, note);
    await client.query('COMMIT');
    // The change is already committed — never let the audit/notify below turn a
    // successful apply into a 500.
    try {
      await audit(req, 'approve_change_request', 'application', cr.application_id,
        { field: applied.field, from: applied.oldValue, to: applied.newValue });
    } catch (_) {}
    // Tell the borrower their requested change was accepted (borrower-safe copy).
    try {
      await notify.notifyAppBorrowers(cr.application_id, {
        type: 'change_request', title: 'Your requested change was approved',
        body: `Your loan team approved your update to ${cr.field_label}.`,
        applicationId: cr.application_id, link: `/app/${cr.application_id}`, ctaLabel: 'Open your file' });
    } catch (_) {}
    res.json({ ok: true, applied });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    res.status(500).json({ error: 'server error' });
  } finally { client.release(); }
});

// Reject a pending change request → it closes and the live record is untouched.
router.post('/change-requests/:cid/reject', async (req, res) => {
  const note = String((req.body || {}).note || '').trim() || null;
  try {
    const cr = (await db.query(`SELECT application_id, field_label, status FROM change_requests WHERE id=$1`, [req.params.cid])).rows[0];
    if (!cr) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, cr.application_id))) return res.status(403).json({ error: 'forbidden' });
    if (cr.status !== 'pending') return res.status(409).json({ error: `this request is already ${cr.status}` });
    // The status guard in the WHERE makes this atomic against a concurrent approve
    // (which row-locks + rechecks 'pending'): if the request was decided between
    // the SELECT above and here, the UPDATE touches nothing and we 409 — so a
    // reject can never overwrite an already-approved (and applied) request.
    const upd = await db.query(
      `UPDATE change_requests SET status='rejected', decided_by=$2, decided_at=now(), decision_note=$3, updated_at=now()
        WHERE id=$1 AND status='pending' RETURNING id`, [req.params.cid, req.actor.id, note]);
    if (!upd.rows[0]) return res.status(409).json({ error: 'this request was just decided by someone else' });
    await audit(req, 'reject_change_request', 'application', cr.application_id, { field: cr.field_label });
    try {
      await notify.notifyAppBorrowers(cr.application_id, {
        type: 'change_request', title: 'Update on your requested change',
        body: `Your loan team reviewed your requested change to ${cr.field_label}.`,
        applicationId: cr.application_id, link: `/app/${cr.application_id}`, ctaLabel: 'Open your file' });
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Data-integrity gate for the three tool-backed conditions. Returns null when
// clear, or a plain-language reason string that blocks the sign-off.
//   rtl_p1_product  — a product must be registered on the file.
//   rtl_p1_budget   — the Scope of Work total must equal the file's rehab
//                     budget AND the registered product's budget.
//   rtl_p3_reo      — verified track-record experience must meet the registered
//                     product's claimed experience (re-register with less, or
//                     verify more, until they agree).
async function signOffGate(itemId, actor) {
  const it = await db.query(
    `SELECT ci.application_id, ci.tool_key, ci.tool_payload, ci.item_kind,
            (SELECT code FROM checklist_templates t WHERE t.id=ci.template_id) AS template_code
       FROM checklist_items ci WHERE ci.id=$1`, [itemId]);
  const item = it.rows[0];
  if (!item || !item.application_id) return null;
  const code = item.template_code || '';
  const isProduct = code === 'rtl_p1_product' || item.tool_key === 'product_pricing';
  const isBudget = code === 'rtl_p1_budget' || item.tool_key === 'rehab_budget';
  const isExp = code === 'rtl_p3_reo' || item.tool_key === 'track_record';
  const isInsurance = code === 'rtl_cond_insurance';
  const isTitle = code === 'rtl_cond_title';
  const isFraud = code === 'rtl_cond_fraud';

  // EMERGENCY doc-gate (owner-directed): a DOCUMENT-upload condition can never be
  // signed off with ZERO documents on it — the sign-off would attest to a file
  // that isn't there. Applies to everyone (LO, processor, underwriter, admin,
  // semi-admin); ONLY a super_admin may override. Tool-backed conditions
  // (product / budget / experience / appraisal card) are verified by their own
  // rules below, and the entity-fulfilled LLC condition is verified from the
  // linked LLC — those are exempt. Insurance/title/fraud have stricter slot
  // rules handled just below (and return before reaching here).
  if (item.item_kind === 'document' && !item.tool_key
      && code !== 'rtl_p1_llc' && !isInsurance && !isTitle && !isFraud) {
    if (!actor || actor.role !== 'super_admin') {
      const has = await db.query(
        `SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current
           AND COALESCE(review_status,'') <> 'rejected' LIMIT 1`, [itemId]);
      if (!has.rows.length)
        return 'Upload a document to this condition before signing it off — a document-based condition cannot be completed with nothing uploaded. (Only a super-admin can override this.)';
    }
  }

  // Document-gated conditions: cannot be signed off until the required upload(s)
  // are present on the item (current, non-rejected versions). slot_label carries
  // the slot key/label, so a case-insensitive substring identifies each slot.
  if (isInsurance || isTitle || isFraud) {
    const docs = await db.query(
      `SELECT lower(coalesce(slot_label,'')) AS slot FROM documents
        WHERE checklist_item_id=$1 AND is_current AND COALESCE(review_status,'') <> 'rejected'`, [itemId]);
    const slots = docs.rows.map((r) => r.slot);
    const hasSlot = (needle) => slots.some((s) => s.includes(needle));
    if (isInsurance) {
      if (!hasSlot('binder') || !hasSlot('invoice'))
        return 'Upload BOTH the insurance binder and the insurance invoice before signing off — this condition cannot be completed without both documents.';
      return null;
    }
    if (isTitle) {
      if (!slots.length)
        return 'Upload the title document before signing off — this condition cannot be completed without it.';
      return null;
    }
    if (isFraud) {
      if (!hasSlot('background'))
        return 'Upload the background report before signing off — it is required on this condition.';
      const gp = (await db.query(`SELECT program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`, [item.application_id])).rows[0];
      if (gp && /gold/i.test(String(gp.program || '')) && !hasSlot('criminal'))
        return 'This is a Gold Standard file — the criminal report is required. Upload it before signing off.';
      return null;
    }
  }

  if (!isProduct && !isBudget && !isExp) return null;

  const ar = await db.query(
    `SELECT rehab_budget, borrower_id, co_borrower_id,
            requested_exp_flips, requested_exp_holds, requested_exp_ground
       FROM applications WHERE id=$1`, [item.application_id]);
  const app = ar.rows[0];
  if (!app) return null;
  // Experience for the FILE counts BOTH borrowers on it (#80).
  const expBorrowerIds = [app.borrower_id, app.co_borrower_id].filter(Boolean);
  const reg = (await db.query(
    `SELECT inputs, quote, program FROM product_registrations WHERE application_id=$1 AND is_current LIMIT 1`,
    [item.application_id])).rows[0] || null;
  const money = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');
  // Exact match to the cent (owner-directed): the Scope of Work must equal the
  // file budget and the registered product budget EXACTLY, not just to the dollar.
  const eq = (a, c) => Math.round((Number(a) || 0) * 100) === Math.round((Number(c) || 0) * 100);

  if (isProduct) {
    if (!reg) return 'Register a product first — this condition can only be signed off once a product is registered on the file in the Term Sheet Studio.';
    return null;
  }
  if (isBudget) {
    if (!reg) return 'Register a product first — the rehab budget must match the registered product before this can be signed off.';
    const sowTotal = item.tool_payload && item.tool_payload.total != null ? Number(item.tool_payload.total) : null;
    if (sowTotal == null) return 'The Scope of Work / rehab budget has not been submitted yet.';
    const appBudget = Number(app.rehab_budget) || 0;
    const regBudget = reg.inputs && reg.inputs.rehabBudget != null ? Number(reg.inputs.rehabBudget) : null;
    // The FIRST-PAGE construction budget on the SOW (state.target) — prefilled
    // from the application ("the total you start at originally"). When set it must
    // ALSO equal the budget exactly, so the number you start at, the line-item
    // total, the file budget and the product budget all agree (owner-directed
    // 2026-07-10 belt-and-suspenders).
    const fpTarget = require('../lib/rehab-budget').firstPageBudget(item.tool_payload);
    const fpSet = fpTarget != null && fpTarget > 0;
    if (!eq(sowTotal, appBudget) || (regBudget != null && !eq(appBudget, regBudget)) || (fpSet && !eq(fpTarget, appBudget))) {
      return `Budgets do not match — first-page construction budget ${fpSet ? money(fpTarget) : '—'}, Scope of Work line-item total ${money(sowTotal)}, file budget ${money(appBudget)}${regBudget != null ? `, registered product budget ${money(regBudget)}` : ''}. They must ALL agree to the cent before sign-off: adjust the Scope of Work (start total + line items) or re-register the product so the numbers match.`;
    }
    // Gold Standard Program: the Scope of Work must carry a >= 5% construction
    // contingency (owner-directed 2026-07-12). The budget still matches exactly
    // above — this is a composition requirement on top of it.
    if (/gold/i.test(String(reg.program || '')) && !require('../lib/rehab-budget').goldContingencyOk(item.tool_payload)) {
      return require('../lib/rehab-budget').GOLD_CONTINGENCY_MSG;
    }
    return null;
  }
  // isExp — the experience REMINDER slot (#97). When NO experience is claimed on
  // the file (nothing to verify for the chosen structure), it may be signed off
  // freely; it only becomes gated once experience is claimed on the application /
  // term sheet / product.
  const claimed = (Number(app.requested_exp_flips) || 0) + (Number(app.requested_exp_holds) || 0) + (Number(app.requested_exp_ground) || 0);
  if (claimed === 0) return null;
  if (!reg) return 'Register a product first — experience is checked against the registered product before this can be signed off.';
  const tr = await db.query(
    `SELECT lower(coalesce(deal_type,'')) dt, count(*)::int n
       FROM track_records WHERE borrower_id = ANY($1::uuid[]) AND is_verified=true AND (${RECENT_EXIT_SQL}) GROUP BY 1`, [expBorrowerIds]);
  const v = { flips: 0, holds: 0, ground: 0 };
  for (const row of tr.rows) {
    if (/ground|construction/.test(row.dt)) v.ground += row.n;
    else if (/flip/.test(row.dt)) v.flips += row.n;
    else v.holds += row.n;
  }
  const inp = reg.inputs || {};
  const need = { flips: Number(inp.expFlips) || 0, holds: Number(inp.expHolds) || 0, ground: Number(inp.expGround) || 0 };
  const short = [];
  if (v.flips < need.flips) short.push(`${need.flips - v.flips} more flip${need.flips - v.flips === 1 ? '' : 's'}`);
  if (v.holds < need.holds) short.push(`${need.holds - v.holds} more hold${need.holds - v.holds === 1 ? '' : 's'}`);
  if (v.ground < need.ground) short.push(`${need.ground - v.ground} more ground-up`);
  if (short.length) {
    return `Experience does not match the registered product — it claims ${need.flips} flip(s) / ${need.holds} hold(s) / ${need.ground} ground-up, but only ${v.flips}/${v.holds}/${v.ground} are VERIFIED on the track record. Verify ${short.join(', ')}, or re-register the product with the experience the borrower can prove.`;
  }
  return null;
}

router.patch('/checklist/:itemId', async (req, res) => {
  // access guard: non-privileged staff may only edit items on their own files.
  // llc-scoped items (entity document slots) have no application_id — they're
  // editable by anyone assigned to a file vesting in that LLC.
  if (!seesAll(req)) {
    const own = await db.query(
      `SELECT 1 FROM checklist_items ci
        LEFT JOIN applications a ON a.id=ci.application_id
        WHERE ci.id=$1 AND (
          (a.id IS NOT NULL AND a.deleted_at IS NULL AND (a.loan_officer_id=$2 OR a.processor_id=$2
             OR a.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2)))
          OR (ci.llc_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM applications ap
                 WHERE ap.llc_id=ci.llc_id AND ap.deleted_at IS NULL AND (ap.loan_officer_id=$2 OR ap.processor_id=$2
                   OR ap.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2)))))`,
      [req.params.itemId, req.actor.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
  }
  const b = req.body || {};
  const allowed = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
  if (b.status && !allowed.includes(b.status)) return res.status(400).json({ error: 'bad status' });
  // Completing a condition is the PROCESSOR's call (admins too). A loan
  // officer marks it reviewed instead — a lighter stamp, never "satisfied".
  const canComplete = can(req.actor, 'sign_off_conditions');
  if ((b.signedOff === true || b.status === 'satisfied') && !canComplete) {
    return res.status(403).json({ error: 'Only a processor or underwriter can complete a condition — mark it reviewed instead.' });
  }
  // The lighter "reviewed" stamp is tied to its own capability (loan officers have
  // it; processors/underwriters/admins do too). Sign-off holders implicitly may
  // review as well, so accept either capability for a review-only action.
  if (b.reviewed === true && !can(req.actor, 'review_conditions') && !canComplete) {
    return res.status(403).json({ error: 'You do not have permission to review conditions on this file.' });
  }
  // Push-back / reject / reopen: send a condition back to the borrower with a
  // BORROWER-VISIBLE reason (owner-directed 2026-07-12, LOS-grade management). One
  // verb covers reject (an open item is not acceptable), push-back, and add-back /
  // reopen (a satisfied or signed-off item is sent back). A reason is REQUIRED. Any
  // reviewer may push back (loan officers included).
  if (b.pushBack === true) {
    if (!can(req.actor, 'review_conditions') && !canComplete) {
      return res.status(403).json({ error: 'You do not have permission to send conditions back on this file.' });
    }
    if (!String(b.issueReason || '').trim()) {
      return res.status(400).json({ error: 'a reason is required to send this condition back to the borrower' });
    }
  }
  // Data-integrity gates on the three tool-backed conditions: a product must be
  // registered, the rehab budget must agree across SOW/file/product, and
  // verified experience must back the registered product. Blocks the sign-off
  // (422) with a plain-language reason until everything lines up.
  if (b.signedOff === true || b.status === 'satisfied') {
    const gate = await signOffGate(req.params.itemId, req.actor);
    if (gate) return res.status(422).json({ error: gate });
  }

  const sets = ['updated_at=now()'];
  const params = [req.params.itemId];
  const add = (frag, val) => { params.push(val); sets.push(frag.replace('?', '$' + params.length)); };

  // Sign-off forces status='satisfied' below, so skip an explicit status here
  // when signing off in the same call — otherwise the UPDATE sets the `status`
  // column twice and Postgres rejects it (42601) with a 500. Push-back also owns
  // the status ('issue'), so skip the explicit one in that case too.
  if (b.status && b.signedOff !== true && b.pushBack !== true) add('status=?', b.status);
  if (b.notes != null) add('notes=?', b.notes);
  if ('assigneeStaffId' in b) add('assignee_staff_id=?', b.assigneeStaffId || null);
  // Requirement toggle — e.g. the LLC's Certificate of Good Standing is
  // optional by default; the officer/processor can flip it to required (it
  // then gates the entity's verification) and back.
  if (typeof b.isRequired === 'boolean') add('is_required=?', b.isRequired);

  // Sign-off marks the item satisfied and stamps who/when; un-sign clears it.
  if (b.signedOff === true) {
    add('signed_off_by=?', req.actor.id);
    sets.push("signed_off_at=now()", "status='satisfied'");
  } else if (b.signedOff === false) {
    sets.push('signed_off_by=NULL', 'signed_off_at=NULL');
  }
  // Reviewed stamp (any assigned staff, typically the loan officer).
  if (b.reviewed === true) {
    add('reviewed_by=?', req.actor.id);
    sets.push('reviewed_at=now()');
  } else if (b.reviewed === false) {
    sets.push('reviewed_by=NULL', 'reviewed_at=NULL');
  }

  // Push-back: flip to 'issue', clear every completion stamp (sign-off + review),
  // and record the borrower-visible reason. Works on an open OR an already-cleared
  // condition (reopen / add-back). issue_reason is what the borrower is shown.
  if (b.pushBack === true) {
    add('issue_reason=?', String(b.issueReason).slice(0, 500));
    sets.push("status='issue'", 'signed_off_by=NULL', 'signed_off_at=NULL', 'reviewed_by=NULL', 'reviewed_at=NULL');
  } else if (b.issueReason != null) {
    // A plain reject that passes an explicit status='issue' can carry the reason.
    add('issue_reason=?', String(b.issueReason).slice(0, 500));
  }
  // Resolving a condition clears any stale push-back reason so a re-satisfied item
  // never keeps showing an old "needs a fix" note.
  if (b.signedOff === true || b.status === 'satisfied') sets.push('issue_reason=NULL');

  const r = await db.query(`UPDATE checklist_items SET ${sets.join(', ')} WHERE id=$1`, params);
  // A wrong/deleted item id used to answer {ok:true} — the UI showed a sign-off
  // that never persisted. Phantom success is this repo's #1 bug class.
  if (r.rowCount === 0) return res.status(404).json({ error: 'checklist item not found' });
  // Propagate a mapped condition's status to its ClickUp dropdown (scoped push;
  // self-gating no-op for unmapped items / unlinked files).
  enqueueChecklistStatusPush(req.params.itemId).catch(() => {});

  // Push-back: audit it and tell the borrower what needs fixing (only for
  // borrower-facing conditions — a staff-only item has no borrower to notify).
  if (b.pushBack === true) {
    try { await audit(req, 'push_back_condition', 'checklist_item', req.params.itemId, { reason: String(b.issueReason).slice(0, 500) }); } catch (_) {}
    try {
      const it = await db.query(
        `SELECT ci.application_id, ci.audience, COALESCE(ci.borrower_label, ci.label) AS label, a.borrower_id
           FROM checklist_items ci LEFT JOIN applications a ON a.id=ci.application_id WHERE ci.id=$1`,
        [req.params.itemId]);
      const row = it.rows[0];
      if (row && row.borrower_id && row.audience !== 'staff') {
        const ctx = row.application_id ? await notify.fileContext(row.application_id) : null;
        await notify.notifyBorrower(row.borrower_id, {
          type: 'doc_rejected',
          title: `"${row.label}" needs your attention`,
          body: `Your loan team sent "${row.label}" back${ctx ? ` (${ctx.label})` : ''}: ${String(b.issueReason).slice(0, 180)}`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: row.application_id,
          link: row.application_id ? `/app/${row.application_id}` : '/profile',
          ctaLabel: 'Review the condition' });
      }
    } catch (_) { /* best-effort */ }
  }
  res.json({ ok: true });
});

// ---------------- assign a Lead-Capture application ----------------
router.post('/applications/:id/assign', async (req, res) => {
  const { loanOfficerId, processorId } = req.body || {};
  if (!loanOfficerId && !processorId) return res.status(400).json({ error: 'loanOfficerId or processorId required' });
  try {
    // Reassigning a file is a manager function (audit S3-02). A non-admin may
    // ONLY claim a currently-EMPTY slot for THEMSELVES — never take over a file
    // already assigned to another officer/processor. Admins may (re)assign
    // freely. The audit records both the previous and new owner.
    const cur = await db.query(`SELECT loan_officer_id, processor_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'application not found' });
    const admin = isAdmin(req);
    if (loanOfficerId) {
      const selfClaimEmpty = !cur.rows[0].loan_officer_id && String(loanOfficerId) === String(req.actor.id);
      if (!admin && !selfClaimEmpty) {
        return res.status(403).json({ error: cur.rows[0].loan_officer_id
          ? 'Only an admin can reassign a file that already has a loan officer.'
          : 'Only an admin can assign this file to another officer — you may claim an unassigned file for yourself.' });
      }
      const off = await db.query(`SELECT full_name FROM staff_users WHERE id=$1 AND is_active=true`, [loanOfficerId]);
      if (!off.rows[0]) return res.status(404).json({ error: 'officer not found' });
      const u = await db.query(`UPDATE applications SET loan_officer_id=$2, loan_officer_name=$3, updated_at=now() WHERE id=$1`,
        [req.params.id, loanOfficerId, off.rows[0].full_name]);
      if (u.rowCount === 0) return res.status(404).json({ error: 'application not found' });
      await notify.notifyStaff(loanOfficerId, {
        type: 'assignment', title: 'Application assigned to you', applicationId: req.params.id,
        link: `/internal/app/${req.params.id}` });
      await audit(req, 'assign_application', 'application', req.params.id, { from: cur.rows[0].loan_officer_id || null, to: loanOfficerId });
    }
    if (processorId) {
      const selfClaimEmpty = !cur.rows[0].processor_id && String(processorId) === String(req.actor.id);
      if (!admin && !selfClaimEmpty) {
        return res.status(403).json({ error: cur.rows[0].processor_id
          ? 'Only an admin can reassign the processor on a file.'
          : 'Only an admin can assign this file to another processor — you may claim an unassigned file for yourself.' });
      }
      const p = await db.query(`SELECT full_name FROM staff_users WHERE id=$1 AND is_active=true AND role='processor'`, [processorId]);
      if (!p.rows[0]) return res.status(404).json({ error: 'processor not found' });
      const u = await db.query(`UPDATE applications SET processor_id=$2, updated_at=now() WHERE id=$1`,
        [req.params.id, processorId]);
      if (u.rowCount === 0) return res.status(404).json({ error: 'application not found' });
      await notify.notifyStaff(processorId, {
        type: 'assignment', title: 'File assigned to you for processing', applicationId: req.params.id,
        link: `/internal/app/${req.params.id}` });
      await audit(req, 'assign_processor', 'application', req.params.id, { from: cur.rows[0].processor_id || null, to: processorId });
    }
    enqueueClickupPush(req.params.id, ['officer', 'processor']).catch(() => {}); // propagate officer/processor to ClickUp promptly
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------- borrower profile view + SSN reveal (audited) ----------------
// A non-privileged staffer (loan_officer / processor) may only see a borrower
// they actually work with — i.e. one on a file they are assigned to. admins,
// super_admins and underwriters (seesAll) may see any. This is the GLBA / PII
// horizontal-authorization gate.
// May the actor see a specific borrower? seesAll (admin/super_admin/underwriter)
// always; otherwise only if assigned to one of that borrower's files.
async function canSeeBorrowerId(req, borrowerId) {
  if (seesAllBorrowers(req)) return true;
  if (!borrowerId) return false;
  const r = await db.query(
    `SELECT 1 FROM applications
      WHERE borrower_id=$1 AND deleted_at IS NULL
        AND (loan_officer_id=$2 OR processor_id=$2
             OR loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2))
      LIMIT 1`,
    [borrowerId, req.actor.id]);
  return !!r.rows[0];
}
async function canSeeBorrower(req) { return canSeeBorrowerId(req, req.params.id); }
// The appraisal payment card, decrypted for the back office to place the
// order. Every reveal is audited (GLBA-grade payment data).
router.get('/applications/:id/appraisal-card', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT card_encrypted, last4, brand, exp_month, exp_year, billing_zip, updated_at
         FROM application_payment_cards WHERE application_id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'no card on file' });
    const row = r.rows[0];
    let full = null;
    try { full = JSON.parse(C.decryptSSN(Buffer.from(row.card_encrypted, 'base64'))); } catch (_) {}
    if (!full) return res.status(500).json({ error: 'could not decrypt the card' });
    await audit(req, 'view_appraisal_card', 'application', req.params.id, { last4: row.last4 });
    res.json({
      number: full.number, cvc: full.cvc, brand: row.brand,
      expMonth: row.exp_month, expYear: row.exp_year, zip: row.billing_zip,
      last4: row.last4, updatedAt: row.updated_at,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Borrower name typeahead for staff origination (StaffNewFile): match prior
// borrowers by name so a new file can LINK to the existing borrower instead of
// creating a duplicate, and known contact info can be pre-filled. Registered
// BEFORE /borrowers/:id so Express doesn't capture "search" as an :id. Scoped
// like every other staff read: seesAll staff match all borrowers; everyone else
// only borrowers on a file they're the loan officer/processor on. The search
// text is ALWAYS bound as %q% — never interpolated into SQL.
router.get('/borrowers/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const params = ['%' + q + '%'];
    let scope = '';
    if (!seesAll(req)) {
      params.push(req.actor.id);
      scope = `AND EXISTS (SELECT 1 FROM applications a
                            WHERE a.borrower_id=b.id AND a.deleted_at IS NULL
                              AND (a.loan_officer_id=$2 OR a.processor_id=$2))`;
    }
    const r = await db.query(
      `SELECT b.id, b.first_name, b.last_name, b.email, b.cell_phone,
              (SELECT count(*)::int FROM applications
                 WHERE borrower_id=b.id AND deleted_at IS NULL) AS prior_files
         FROM borrowers b
        WHERE (b.first_name ILIKE $1 OR b.last_name ILIKE $1
               OR (b.first_name||' '||b.last_name) ILIKE $1)
          ${scope}
        ORDER BY b.last_name, b.first_name
        LIMIT 10`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- Loan-officer borrower management (#83) ----------------
// The LO's book of borrowers: everyone on a file they run (seesAll staff get
// everyone), with portal-account state and last activity, plus the actions an LO
// needs — invite to the portal, email a reset link, or set a password directly.
// Scoped exactly like every other staff borrower read. Registered before
// /borrowers/:id so "borrowers" is never captured as an :id.
router.get('/borrowers', async (req, res) => {
  try {
    const params = [];
    let scope = '';
    if (!seesAllBorrowers(req)) {
      params.push(req.actor.id);
      scope = `WHERE EXISTS (SELECT 1 FROM applications a
                              WHERE a.borrower_id=b.id AND a.deleted_at IS NULL
                                AND (a.loan_officer_id=$1 OR a.processor_id=$1))`;
    }
    const r = await db.query(
      `SELECT b.id, b.first_name, b.last_name, b.email, b.cell_phone, b.tier, b.created_at,
              (ba.borrower_id IS NOT NULL) AS has_account,
              ba.last_login_at, b.last_seen_at,
              (SELECT count(*)::int FROM applications WHERE borrower_id=b.id AND deleted_at IS NULL) AS files,
              lf.id AS latest_file_id,
              off.full_name AS loan_officer_name
         FROM borrowers b
         LEFT JOIN borrower_auth ba ON ba.borrower_id=b.id
         LEFT JOIN LATERAL (
           SELECT id, loan_officer_id FROM applications
            WHERE borrower_id=b.id AND deleted_at IS NULL
            ORDER BY created_at DESC LIMIT 1
         ) lf ON true
         LEFT JOIN staff_users off ON off.id = lf.loan_officer_id
        ${scope}
        ORDER BY COALESCE(ba.last_login_at, b.last_seen_at) DESC NULLS LAST, b.last_name, b.first_name
        LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Invite a borrower to the portal — binds to their most recent file and emails
// the set-password link. Re-inviting just issues a fresh link.
router.post('/borrowers/:id/portal-invite', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const b = (await db.query(`SELECT id, email, first_name FROM borrowers WHERE id=$1`, [req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'not found' });
    if (!b.email) return res.status(400).json({ error: 'this borrower has no email on file' });
    const app = (await db.query(
      `SELECT id FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [req.params.id])).rows[0];
    if (!app) return res.status(400).json({ error: 'this borrower has no active file to invite them to' });
    const out = await inviteBorrowerToFile({ appId: app.id, borrowerId: b.id, email: b.email, firstName: b.first_name, req });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Email the borrower a password-reset link (staff never see the password).
router.post('/borrowers/:id/reset-password', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const b = (await db.query(
      `SELECT b.id, b.email, b.first_name FROM borrowers b
         JOIN borrower_auth ba ON ba.borrower_id=b.id WHERE b.id=$1`, [req.params.id])).rows[0];
    if (!b) return res.status(400).json({ error: 'this borrower has no portal account yet — invite them first' });
    if (!b.email) return res.status(400).json({ error: 'this borrower has no email on file' });
    const { token } = await issueEmailToken({ borrowerId: b.id, email: b.email, kind: 'reset', ttlMin: 60, withToken: true });
    await mail.send('passwordReset', b.email, { firstName: b.first_name, resetUrl: mail.link('/reset?token=' + token), minutes: 60 });
    await audit(req, 'borrower_reset_password_email', 'borrower', b.id, {});
    res.json({ ok: true, emailed: true });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});

// Set a borrower's password directly (LO-assisted). Creates the login row if the
// borrower had none, bumps token_version to revoke any live sessions, audits it,
// and notifies the borrower their password changed.
router.post('/borrowers/:id/set-password', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const pw = String((req.body || {}).password || '');
    { const w = C.passwordProblem(pw); if (w) return res.status(400).json({ error: w }); }
    const b = (await db.query(`SELECT id, email, first_name FROM borrowers WHERE id=$1`, [req.params.id])).rows[0];
    if (!b) return res.status(404).json({ error: 'not found' });
    const hash = await C.hashPassword(pw);
    const existing = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [req.params.id]);
    if (existing.rows[0]) {
      await db.query(
        `UPDATE borrower_auth SET password_hash=$2, token_version=token_version+1,
             failed_attempts=0, locked_until=NULL WHERE borrower_id=$1`, [req.params.id, hash]);
    } else {
      await db.query(`INSERT INTO borrower_auth (borrower_id,password_hash,token_version) VALUES ($1,$2,0)`, [req.params.id, hash]);
    }
    await audit(req, 'borrower_set_password', 'borrower', b.id, {});
    try { if (b.email) await mail.send('passwordChanged', b.email, { firstName: b.first_name }); } catch (_) {}
    res.json({ ok: true, set: true, hadAccount: !!existing.rows[0] });
  } catch (e) { res.status(500).json({ error: e.message || 'server error' }); }
});
// (A borrower's entities live at GET /borrowers/:id/llcs below — the full
// review bundle; its rows carry id/llc_name/is_verified for the track-record
// tool's linker plus members/slots/completeness for the LLC review panel.)
router.get('/borrowers/:id', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT b.id, b.first_name, b.last_name, b.email, b.cell_phone, b.date_of_birth,
              b.ssn_last4, b.fico, b.citizenship, b.marital_status, b.dependents_count, b.tier,
              b.current_address, b.mailing_address, b.years_at_residence, b.months_at_residence,
              b.housing_status, b.housing_payment, b.contact_type, b.primary_officer_id,
              b.photo_id_document_id, b.created_at, b.last_seen_at,
              (SELECT last_login_at FROM borrower_auth WHERE borrower_id=b.id) AS last_login_at,
              (b.ssn_encrypted IS NOT NULL) AS has_ssn,
              off.full_name AS primary_officer_name
         FROM borrowers b
         LEFT JOIN staff_users off ON off.id = b.primary_officer_id
        WHERE b.id=$1`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Edit a borrower's CRM / contact fields (staff, audited). Identity fields that
// belong to underwriting (SSN, FICO, DOB, legal name) are intentionally NOT
// editable here — those are corrected on the file. This is contact + CRM metadata.
router.patch('/borrowers/:id', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const sets = [], vals = [req.params.id];
    const put = (col, val) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
    if (b.email != null) put('email', String(b.email).trim().toLowerCase() || null);
    if (b.cellPhone != null) put('cell_phone', String(b.cellPhone).trim() || null);
    if (b.contactType != null) put('contact_type', String(b.contactType).trim() || null);
    if (b.maritalStatus != null) put('marital_status', String(b.maritalStatus).trim() || null);
    if (b.citizenship != null) put('citizenship', String(b.citizenship).trim() || null);
    if (b.currentAddress !== undefined) put('current_address', b.currentAddress ? JSON.stringify(b.currentAddress) : null);
    if (b.mailingAddress !== undefined) put('mailing_address', b.mailingAddress ? JSON.stringify(b.mailingAddress) : null);
    if (b.primaryOfficerId !== undefined) put('primary_officer_id', b.primaryOfficerId || null);
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=now()');
    try {
      await db.query(`UPDATE borrowers SET ${sets.join(', ')} WHERE id=$1`, vals);
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'that email is already in use by another borrower' });
      throw e;
    }
    await audit(req, 'update_borrower', 'borrower', req.params.id, { fields: sets.slice(0, -1).map((s) => s.split('=')[0]) });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The borrower's loan files (one per property) — their "mortgages with us". Scoped
// by canSeeBorrower; the list is view context (opening an individual file still
// goes through the /applications/:id scope). Includes the borrower as primary or
// co-borrower so a co-borrowed file shows up on both profiles.
router.get('/borrowers/:id/applications', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.program, a.loan_type, a.status, a.internal_status,
              a.property_address, a.loan_amount, a.created_at, a.expected_closing, a.actual_closing,
              a.borrower_id=$1 AS is_primary, a.co_borrower_id=$1 AS is_co_borrower,
              off.full_name AS loan_officer_name, l.llc_name AS entity_name, l.is_verified AS entity_verified
         FROM applications a
         LEFT JOIN staff_users off ON off.id = a.loan_officer_id
         LEFT JOIN llcs l ON l.id = a.llc_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
        ORDER BY a.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Open conditions/tasks-to-clear rolled up across ALL of the borrower's files —
// so staff see everything outstanding for the person in one place.
router.get('/borrowers/:id/conditions', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT c.id, c.application_id, c.title, c.status, c.audience, c.severity, c.created_at,
              a.ys_loan_number, a.property_address
         FROM conditions c
         JOIN applications a ON a.id = c.application_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
          AND c.status IN ('open','borrower_responded')
        ORDER BY c.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Reminders + tasks across the borrower's files (the #93 system, rolled up per
// borrower). Creating a task attaches it to the chosen file (or the latest file)
// so it flows through the existing, tested reminder dispatcher unchanged.
router.get('/borrowers/:id/reminders', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT r.id, r.application_id, r.kind, r.title, r.body, r.due_at, r.status,
              r.assignee_staff_id, r.completed_at, r.created_at,
              a.ys_loan_number, a.property_address,
              asg.full_name AS assignee_name
         FROM reminders r
         JOIN applications a ON a.id = r.application_id
         LEFT JOIN staff_users asg ON asg.id = r.assignee_staff_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
        ORDER BY (r.status='scheduled') DESC, r.due_at ASC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/borrowers/:id/reminders', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const body = req.body || {};
    // Attach to the given file if it belongs to this borrower, else the latest file.
    let appId = body.applicationId || null;
    const owns = await db.query(
      `SELECT id FROM applications
        WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL
          ${appId ? 'AND id=$2' : ''}
        ORDER BY created_at DESC LIMIT 1`, appId ? [req.params.id, appId] : [req.params.id]);
    if (!owns.rows[0]) return res.status(400).json({ error: 'this borrower has no file to attach a task to' });
    appId = owns.rows[0].id;
    const id = await reminders.create(appId, body, req.actor);
    await audit(req, 'create_reminder', 'application', appId, { reminderId: id, viaBorrower: req.params.id });
    res.json({ ok: true, id, applicationId: appId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'server error' });
  }
});

// The borrower's document vault — every document on file for the person, across
// their files + entity + track record. Download goes through /documents/:id/download.
router.get('/borrowers/:id/documents', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.doc_kind, d.created_at,
              d.application_id, d.llc_id, d.track_record_id,
              a.ys_loan_number
         FROM documents d
         LEFT JOIN applications a ON a.id = d.application_id
        WHERE d.borrower_id=$1
           OR d.application_id IN (SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL)
           OR d.llc_id IN (SELECT id FROM llcs WHERE borrower_id=$1)
           OR d.track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)
        ORDER BY d.created_at DESC LIMIT 500`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Activity timeline for the borrower — staff actions on the person and on their
// files (audit trail: SSN reveals, edits, password sets, doc downloads, etc.).
router.get('/borrowers/:id/activity', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT g.id, g.action, g.entity_type, g.entity_id, g.detail, g.created_at,
              g.actor_kind, su.full_name AS actor_name
         FROM audit_log g
         LEFT JOIN staff_users su ON su.id = g.actor_id AND g.actor_kind='staff'
        WHERE (g.entity_type='borrower' AND g.entity_id=$1)
           OR (g.entity_type IN ('application','document','track_record','llc')
               AND g.entity_id IN (
                 SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1)
                 UNION SELECT id FROM llcs WHERE borrower_id=$1
                 UNION SELECT id FROM track_records WHERE borrower_id=$1))
        ORDER BY g.created_at DESC LIMIT 200`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Internal notes timeline on the borrower (staff-only, free text). A core CRM
// feature: log a call, a preference, a heads-up. Author + timestamp captured.
router.get('/borrowers/:id/notes', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT n.id, n.body, n.created_at, n.updated_at, n.author_staff_id, su.full_name AS author_name
         FROM borrower_notes n LEFT JOIN staff_users su ON su.id = n.author_staff_id
        WHERE n.borrower_id=$1 ORDER BY n.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/borrowers/:id/notes', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'note body required' });
    const r = await db.query(
      `INSERT INTO borrower_notes (borrower_id, author_staff_id, body) VALUES ($1,$2,$3) RETURNING id`,
      [req.params.id, req.actor.id, body]);
    await audit(req, 'add_borrower_note', 'borrower', req.params.id, { noteId: r.rows[0].id });
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.delete('/borrowers/:id/notes/:nid', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    await db.query(`DELETE FROM borrower_notes WHERE id=$1 AND borrower_id=$2`, [req.params.nid, req.params.id]);
    await audit(req, 'delete_borrower_note', 'borrower', req.params.id, { noteId: req.params.nid });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// A borrower's investment track record (experience) — drives the pricing tier.
router.get('/borrowers/:id/track-records', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT t.id, t.deal_type, t.property_address, t.purchase_price, t.sale_price, t.rehab_amount,
              t.purchase_date, t.sale_date, t.rent_amount, t.rent_date, t.refi_amount, t.refi_date,
              t.current_value, t.notes, t.is_verified, t.verified_at, t.docs_status,
              t.property_type, t.verification_status, t.lo_notes, t.owned_personally,
              COALESCE(t.entity_name, l.llc_name) AS entity_name, v.full_name AS verified_by_name,
              (SELECT count(*)::int FROM documents d WHERE d.track_record_id=t.id) AS doc_count,
              (SELECT COALESCE(json_agg(json_build_object(
                      'id', d.id, 'filename', d.filename, 'review_status', d.review_status,
                      'created_at', d.created_at) ORDER BY d.created_at), '[]'::json)
                 FROM documents d
                WHERE d.track_record_id=t.id AND d.is_current) AS docs,
              (SELECT COALESCE(json_agg(json_build_object(
                      'id', ci.id, 'label', ci.label, 'hint', ci.hint, 'status', ci.status,
                      'application_id', ci.application_id) ORDER BY ci.created_at), '[]'::json)
                 FROM checklist_items ci
                WHERE ci.track_record_id=t.id AND ci.status NOT IN ('satisfied')) AS doc_requests
         FROM track_records t
         LEFT JOIN llcs l ON l.id = t.llc_id
         LEFT JOIN staff_users v ON v.id = t.verified_by
        WHERE t.borrower_id=$1 ORDER BY t.sale_date DESC NULLS LAST, t.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Staff manage the borrower's general track record on their behalf: add,
// edit, remove entries, and attach/read the per-entry supporting documents.
const { trackRecordErrors, trackRecordCols, trackRecordMissing } = require('./borrower');
router.post('/borrowers/:id/track-records', async (req, res) => {
  const b = req.body || {};
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  if (b.ownedPersonally) b.llcId = null;   // personal-name line carries no entity
  const bad = trackRecordErrors(b);
  if (bad) return res.status(400).json({ error: bad });
  const cols = trackRecordCols(b);
  if (b.llcId) {
    const l = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, req.params.id]);
    if (l.rows[0]) cols.llc_id = b.llcId;
  }
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  // Idempotent create: a stable clientRowId per line collapses a repeated POST
  // (autosave retry, second tab, network replay, double-tap) onto one row
  // instead of a duplicate — belt-and-suspenders behind the tool's client-side
  // create-once fix. Rows without a key keep plain-insert (partial index ignores
  // NULLs). Staff may edit verified rows, so the upsert updates unconditionally.
  const clientRowId = b.clientRowId ? String(b.clientRowId).slice(0, 80) : null;
  const allNames = ['borrower_id', 'client_row_id', ...names];
  const allVals = [req.params.id, clientRowId, ...vals];
  const ph = allVals.map((_, i) => '$' + (i + 1)).join(',');
  const updateSet = [...names.map(n => `${n}=EXCLUDED.${n}`), 'updated_at=now()'].join(', ');
  const r = await db.query(
    `INSERT INTO track_records (${allNames.join(',')}) VALUES (${ph})
     ON CONFLICT (borrower_id, client_row_id) WHERE client_row_id IS NOT NULL
       DO UPDATE SET ${updateSet}
     RETURNING id`,
    allVals);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(req.params.id); } catch (_) {}
  await audit(req, 'staff_add_track_record', 'track_record', r.rows[0].id);
  res.status(201).json({ ok: true, trackRecordId: r.rows[0].id, missing: trackRecordMissing(b) });
});
router.put('/track-records/:id', async (req, res) => {
  const b = req.body || {};
  if (b.ownedPersonally) b.llcId = null;   // personal-name line carries no entity
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const bad = trackRecordErrors(b);
  if (bad) return res.status(400).json({ error: bad });
  const cols = trackRecordCols(b);
  if (b.loNotes !== undefined) cols.lo_notes = b.loNotes ? String(b.loNotes).slice(0, 1000) : null;
  if (b.llcId !== undefined) {
    if (b.llcId) {
      const l = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, tr.rows[0].borrower_id]);
      if (l.rows[0]) cols.llc_id = b.llcId;
    } else cols.llc_id = null;
  }
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  await db.query(
    `UPDATE track_records SET ${names.map((n, i) => `${n}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1`,
    [req.params.id, ...vals]);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(tr.rows[0].borrower_id); } catch (_) {}
  await audit(req, 'staff_edit_track_record', 'track_record', req.params.id);
  res.json({ ok: true, missing: trackRecordMissing(b) });
});
router.delete('/track-records/:id', async (req, res) => {
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`DELETE FROM track_records WHERE id=$1`, [req.params.id]);
  await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true AND (${RECENT_EXIT_SQL})) WHERE id=$1`,
    [tr.rows[0].borrower_id]);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(tr.rows[0].borrower_id); } catch (_) {}
  await audit(req, 'staff_delete_track_record', 'track_record', req.params.id);
  res.json({ ok: true });
});
// The borrower's saved STATIC COPY of their track record (self-contained HTML
// with the data): staff edits refresh it exactly like borrower edits do.
router.put('/borrowers/:id/track-record/snapshot', async (req, res) => {
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  try {
    const out = await require('../lib/track-record-snapshot').saveSnapshot(req.params.id, {
      html: b.html, filename: b.filename, uploadedByKind: 'staff', uploadedById: req.actor.id,
    });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.message || 'could not save the snapshot' }); }
});
router.get('/borrowers/:id/track-record/snapshot', async (req, res) => {
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await require('../lib/track-record-snapshot').latestSnapshot(req.params.id)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.get('/track-records/:id/documents', async (req, res) => {
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,uploaded_by_kind,created_at,
            review_status,rejection_reason,reviewed_at FROM documents
      WHERE track_record_id=$1 AND is_current ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});
router.post('/track-records/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  // Same contract as the borrower path: an upload straight to the line item
  // also lands on the oldest open document-request condition for that line.
  const openReq = await db.query(
    `SELECT id FROM checklist_items
      WHERE track_record_id=$1 AND item_kind='document'
        AND status IN ('outstanding','requested','issue')
      ORDER BY created_at LIMIT 1`, [req.params.id]);
  const reqItemId = openReq.rows[0] ? openReq.rows[0].id : null;
  const r = await db.query(
    `INSERT INTO documents (borrower_id,track_record_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,'track_record_doc') RETURNING id`,
    [tr.rows[0].borrower_id, req.params.id, reqItemId, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id]);
  await db.query(`UPDATE track_records SET docs_status='received', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [req.params.id]);
  if (reqItemId) {
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE id=$1 AND status IN ('outstanding','requested','issue')`, [reqItemId]);
    try { await enqueueChecklistStatusPush(reqItemId); } catch (_) {}
  }
  await audit(req, 'staff_upload_track_record_doc', 'track_record', req.params.id, { filename: b.filename });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  res.status(201).json({ ok: true, documentId: r.rows[0].id });
});
router.get('/borrowers/:id/ssn', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]?.ssn_encrypted) return res.status(404).json({ error: 'no ssn on file' });
    await audit(req, 'view_ssn', 'borrower', req.params.id);
    res.json({ ssn: C.decryptSSN(r.rows[0].ssn_encrypted) });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- LLC review & verification ----------------
// Every LLC of a borrower, with ownership structure and the three document
// slots — the staff review surface (per-doc accept/reject + whole-LLC verify).
router.get('/borrowers/:id/llcs', async (req, res) => {
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 ORDER BY created_at`, [req.params.id]);
  const out = [];
  for (const row of r.rows) {
    const bundle = await llcLib.getLlcBundle(row.id);
    if (bundle) out.push({ ...bundle, missing: llcLib.missingForVerification(bundle, bundle.members, bundle.slots) });
  }
  res.json(out);
});

// Create a borrower entity on their behalf — full parity with the borrower's
// own POST /llcs. Same validators (src/lib/llc.js), same requirement pull. A
// staffer standing up the LLC for a borrower who can't lands them the exact
// same document slots the borrower would have created.
router.post('/borrowers/:id/llcs', async (req, res) => {
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  const borrowerId = req.params.id;
  const b = req.body || {};
  if (!b.llcName || !String(b.llcName).trim()) return res.status(400).json({ error: 'llcName required' });
  if (b.ownershipPct !== undefined && b.ownershipPct !== '' && b.ownershipPct != null) {
    const p = Number(b.ownershipPct);
    if (!isFinite(p) || p < 0 || p > 100) return res.status(400).json({ error: 'ownership % must be between 0 and 100' });
  }
  const ein = llcLib.normalizeEin(b.ein);
  if (ein.error) return res.status(400).json({ error: ein.error });
  const parsed = llcLib.parseMembers(b.members, b.ownershipPct);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  // A name this borrower already has is REUSED, not duplicated or rejected — so
  // adding "123 Main LLC" to a file when the borrower already has that entity
  // links the existing one (with its docs + verification) instead of erroring.
  const { id: llcId, existed } = await llcLib.findOrCreateLlc(borrowerId, {
    llcName: String(b.llcName).trim(), ein: ein.ein, formationState: b.formationState,
    formationDate: b.formationDate, ownershipPct: b.ownershipPct,
  });
  // Only a brand-new entity gets members + its document checklist; an existing
  // one keeps its own (never clobbered by a re-create).
  if (!existed) {
    if (parsed.members && parsed.members.length) {
      try { await llcLib.replaceMembers(llcId, parsed.members, { borrowerId }); }
      catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'could not save the members' }); }
    }
    try { await require('./borrower').generateLlcChecklist(llcId); } catch (_) { /* best-effort */ }
  }
  await audit(req, existed ? 'reuse_llc' : 'create_llc', 'llc', llcId, { borrowerId, existed });
  res.status(existed ? 200 : 201).json({ ok: true, llcId, existed });
});

// Fill in / correct an entity's details on the borrower's behalf. Mirrors the
// borrower's PATCH /llcs/:id, including the verified-lock: a verified entity
// must be unlocked (POST /llcs/:id/verify {verified:false}) before edits.
// Staff single-entity bundle — parity with the borrower GET /llcs/:id so the
// SHARED LlcManager component works from the staff CRM entity section (it was
// hard-wired to the borrower-only endpoint, which 403'd for staff — the CRM
// Entities tab showed "borrower only"). Scoped by canSeeBorrowerId; staff always
// manage (read_only:false).
router.get('/llcs/:id', async (req, res) => {
  try {
    const own = await db.query(`SELECT borrower_id FROM llcs WHERE id=$1`, [req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    const bundle = await llcLib.getLlcBundle(req.params.id);
    if (!bundle) return res.status(404).json({ error: 'not found' });
    res.json({ ...bundle, read_only: false });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

// Staff upload of an entity document into a specific LLC checklist slot, WITHOUT a
// file context (the CRM entity library has no appId). Mirrors the LLC path of the
// staff app-doc upload; visibility='borrower' so the entity's docs stay shared.
router.post('/llcs/:id/documents', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
    const own = await db.query(`SELECT borrower_id, is_verified FROM llcs WHERE id=$1`, [req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — revoke verification before replacing its documents' });
    if (b.checklistItemId) {
      const ci = await db.query(`SELECT id FROM checklist_items WHERE id=$1 AND llc_id=$2`, [b.checklistItemId, req.params.id]);
      if (!ci.rows[0]) return res.status(404).json({ error: 'checklist item not found on this entity' });
    }
    const buf = Buffer.from(b.dataBase64, 'base64');
    if (!buf.length) return res.status(400).json({ error: 'empty file' });
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
    const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
    const { ref, provider } = await storage.save(buf, { filename: b.filename });
    const r = await db.query(
      `INSERT INTO documents (checklist_item_id,llc_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,slot_label,visibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,'borrower') RETURNING id`,
      [b.checklistItemId || null, req.params.id, own.rows[0].borrower_id, b.filename,
       b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id, slot]);
    if (b.checklistItemId) {
      if (b.replaceDocumentId) {
        await db.query(
          `UPDATE documents SET is_current=false,
              review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
            WHERE id=$1 AND checklist_item_id=$2`, [b.replaceDocumentId, b.checklistItemId]);
      }
      await db.query(
        `UPDATE documents SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE checklist_item_id=$1 AND id<>$2 AND is_current=true
            AND ($3::text IS NOT NULL OR $4::uuid IS NULL)
            AND ($3::text IS NULL OR slot_label IS NOT DISTINCT FROM $3)`,
        [b.checklistItemId, r.rows[0].id, slot, b.replaceDocumentId || null]);
      await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1`, [b.checklistItemId]);
      enqueueChecklistStatusPush(b.checklistItemId).catch(() => {});
    }
    try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
    try { await llcLib.syncLlcConditions(req.params.id); } catch (_) { /* best-effort */ }
    await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename, llcId: req.params.id });
    res.status(201).json({ ok: true, documentId: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'server error', detail: e.message }); }
});

router.patch('/llcs/:id', async (req, res) => {
  const own = await db.query(`SELECT borrower_id, is_verified FROM llcs WHERE id=$1`, [req.params.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — revoke verification before making changes' });
  const b = req.body || {};
  if (b.ein !== undefined) {
    const ein = llcLib.normalizeEin(b.ein);
    if (ein.error) return res.status(400).json({ error: ein.error });
    b.ein = ein.ein === null ? '' : ein.ein;
  }
  if (b.llcName !== undefined && !String(b.llcName).trim()) return res.status(400).json({ error: 'llcName cannot be empty' });
  const sets = [], vals = []; let i = 1;
  const map = { llcName: 'llc_name', ein: 'ein', formationState: 'formation_state', formationDate: 'formation_date', ownershipPct: 'ownership_pct' };
  for (const [k, col] of Object.entries(map)) if (b[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  if (b.ownershipPct !== undefined && b.ownershipPct !== '' && b.ownershipPct != null) {
    const p = Number(b.ownershipPct);
    if (!isFinite(p) || p < 0 || p > 100) return res.status(400).json({ error: 'ownership % must be between 0 and 100' });
    const mem = await db.query(`SELECT COALESCE(sum(ownership_pct),0) AS s FROM llc_members WHERE llc_id=$1`, [req.params.id]);
    const total = p + Number(mem.rows[0].s);
    if (total > 100.01) return res.status(400).json({ error: `ownership exceeds 100% (${total.toFixed(2)}% with the other members) — adjust the members first` });
  }
  sets.push('updated_at=now()'); vals.push(req.params.id);
  await db.query(`UPDATE llcs SET ${sets.join(',')} WHERE id=$${i}`, vals);
  await audit(req, 'update_llc', 'llc', req.params.id);
  res.json({ ok: true });
});

// Replace an entity's OTHER members on the borrower's behalf. Same shape/lock
// as the borrower's PUT /llcs/:id/members.
router.put('/llcs/:id/members', async (req, res) => {
  const own = await db.query(`SELECT borrower_id, is_verified, ownership_pct FROM llcs WHERE id=$1`, [req.params.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — revoke verification before making changes' });
  const parsed = llcLib.parseMembers((req.body || {}).members || [], own.rows[0].ownership_pct);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  try { await llcLib.replaceMembers(req.params.id, parsed.members || [], { borrowerId: own.rows[0].borrower_id }); }
  catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'could not save the members' }); }
  // Ownership feeds the entity condition (chain-aware) — recompute right away.
  try { await llcLib.syncLlcConditions(req.params.id); } catch (_) { /* best-effort */ }
  await audit(req, 'update_llc_members', 'llc', req.params.id, { count: (parsed.members || []).length });
  res.json({ ok: true });
});

// Verify — or revoke verification of — an LLC. Verification is a real gate:
// entity details + ownership totalling 100% + all three documents accepted.
// Verifying auto-satisfies (and signs off) the LLC condition on every open
// file vesting in this entity; revoking reopens those conditions.
router.post('/llcs/:id/verify', async (req, res) => {
  const own = await db.query(`SELECT borrower_id, llc_name, is_verified FROM llcs WHERE id=$1`, [req.params.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const verified = b.verified !== false;   // default true (backward compatible)

  // Verifying an LLC SIGNS OFF the rtl_p1_llc condition (satisfied + signed_off)
  // on every vesting file — that is the processor's call, never a loan officer's
  // (#126). Revoking is a "send it back" any reviewer may do, but it reopens the
  // borrower's condition, so it now REQUIRES a reason the borrower is shown (#125).
  if (verified && !can(req.actor, 'sign_off_conditions')) {
    return res.status(403).json({ error: 'Only a processor can verify an LLC — verifying signs off the entity condition. Reject a document or raise an issue instead.' });
  }
  if (!verified && !String(b.reason || '').trim()) {
    return res.status(400).json({ error: 'a reason is required to revoke verification — the borrower is told why' });
  }

  if (verified) {
    const bundle = await llcLib.getLlcBundle(req.params.id);
    const missing = llcLib.missingForVerification(bundle, bundle.members, bundle.slots);
    if (missing.length) return res.status(409).json({ error: 'this LLC is not ready to verify', missing });
    await db.query(`UPDATE llcs SET is_verified=true, verified_at=now(), verified_by=$2, updated_at=now() WHERE id=$1`,
      [req.params.id, req.actor.id]);
    await llcLib.syncLlcConditions(req.params.id, { verifiedBy: req.actor.id });
    await audit(req, 'verify_llc', 'llc', req.params.id);
    try {
      await notify.notifyBorrower(own.rows[0].borrower_id, {
        type: 'llc_verified', title: 'Your LLC is verified',
        body: `"${own.rows[0].llc_name}" is fully verified. Its documents and ownership details are on file and will be reused automatically on your loans.`,
        link: '/profile', ctaLabel: 'View your profile' });
    } catch (_) { /* best-effort */ }
    return res.json({ ok: true, verified: true });
  }

  const reason = String(b.reason || '').trim().slice(0, 500);
  await db.query(`UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now() WHERE id=$1`,
    [req.params.id]);
  await llcLib.syncLlcConditions(req.params.id, { reopen: true });
  await audit(req, 'unverify_llc', 'llc', req.params.id, reason ? { reason } : null);
  try {
    await notify.notifyBorrower(own.rows[0].borrower_id, {
      type: 'llc_unverified', title: 'Your LLC needs attention',
      body: `Verification of "${own.rows[0].llc_name}" was revoked${reason ? `: ${reason}` : ''}. Please review its details and documents on your profile.`,
      link: '/profile', ctaLabel: 'Review your LLC' });
  } catch (_) { /* best-effort */ }
  res.json({ ok: true, verified: false });
});
// Verification statuses mirror the static Track Record tool: pending review,
// documentation required, verified (with docs), limited (public record only).
// 'verified' and 'limited' both count toward the borrower's experience tier.
const TR_STATUSES = ['pending', 'docs', 'verified', 'limited'];
router.post('/track-records/:id/verify', async (req, res) => {
  const tr = await db.query(
    `SELECT t.borrower_id, t.is_verified, t.property_address
       FROM track_records t WHERE t.id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const status = TR_STATUSES.includes(req.body && req.body.status) ? req.body.status : 'verified';
  const counts = status === 'verified' || status === 'limited';
  const wasVerified = tr.rows[0].is_verified === true;
  // Moving a currently-verified line item to a non-counting status is a REVOKE:
  // it pulls the project out of the experience tier and reopens the experience
  // condition, so — exactly like the LLC unverify (#125/#147) — it REQUIRES a
  // reason the borrower is shown and it notifies them.
  const isRevoke = wasVerified && !counts;
  // Marking a line item verified/limited COUNTS toward the experience tier and
  // drives the experience condition to satisfied — a sign-off, so processor-only
  // (#126). A non-counting status (pending/docs) is a review action anyone may set.
  if (counts && !can(req.actor, 'sign_off_conditions')) {
    return res.status(403).json({ error: 'Only a processor can verify a track-record line item — it signs off the experience condition. Request documents or raise an issue instead.' });
  }
  const reason = String((req.body && req.body.reason) || '').trim().slice(0, 500);
  if (isRevoke && !reason) {
    return res.status(400).json({ error: 'a reason is required to revoke verification — the borrower is told why' });
  }
  await db.query(
    `UPDATE track_records
        SET verification_status=$3,
            is_verified=$4,
            verified_at=CASE WHEN $4 THEN now() ELSE NULL END,
            verified_by=CASE WHEN $4 THEN $2::uuid ELSE NULL END,
            updated_at=now()
      WHERE id=$1`, [req.params.id, req.actor.id, status, counts]);
  // recompute borrower tier = count of verified track records
  await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true AND (${RECENT_EXIT_SQL})) WHERE id=$1`,
    [tr.rows[0].borrower_id]);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(tr.rows[0].borrower_id); } catch (_) {}
  // Tier / verified-experience counts are rule-engine fields.
  try { await conditionEngine.evaluateBorrowerApplications(tr.rows[0].borrower_id, { actor: req.actor, reason: isRevoke ? 'track_record_unverified' : 'track_record_verified' }); } catch (_) {}
  if (isRevoke) {
    await audit(req, 'unverify_track_record', 'track_record', req.params.id, { status, reason });
    const addr = (tr.rows[0].property_address && (tr.rows[0].property_address.oneLine || tr.rows[0].property_address.line1)) || 'a property';
    try {
      await notify.notifyBorrower(tr.rows[0].borrower_id, {
        type: 'track_record_unverified', title: 'A track-record project needs attention',
        body: `Verification of your project at ${addr} was revoked: ${reason}. Please review it and its documents on your track record.`,
        link: '/track-record', ctaLabel: 'Review your track record' });
    } catch (_) { /* best-effort */ }
  } else {
    await audit(req, 'verify_track_record', 'track_record', req.params.id, { status });
  }
  res.json({ ok: true, status, revoked: isRevoke });
});

// ---------------- raise an issue against a track-record line item / an LLC ----------------
// A staffer reviewing a track-record line item or a vesting entity can post a
// request/issue against it. It becomes a real condition ON A FILE, NAMED by the
// entity (property address / LLC name) + the reason, visible to BOTH the internal
// team and the borrower. See src/lib/raise-issue.js. The staffer raises it from
// within a file (applicationId), so the condition attaches to that loan.
function addressLabel(pa) {
  if (!pa || typeof pa !== 'object') return '';
  if (pa.oneLine) return String(pa.oneLine);
  return [pa.line1 || pa.street || pa.address, pa.city, pa.state].filter(Boolean).join(', ');
}
router.post('/track-records/:id/raise-issue', async (req, res) => {
  try {
    const b = req.body || {};
    const appId = b.applicationId;
    if (!appId) return res.status(400).json({ error: 'applicationId is required — raise the issue from within a loan file' });
    if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'a reason is required' });
    const tr = await db.query(`SELECT borrower_id, property_address FROM track_records WHERE id=$1`, [req.params.id]);
    if (!tr.rows[0]) return res.status(404).json({ error: 'track record not found' });
    if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
    const name = addressLabel(tr.rows[0].property_address) || 'a past project';
    const out = await raiseEntityIssue({ appId, entityKind: 'track_record', entityId: req.params.id, entityName: name, reason: b.reason, actorId: req.actor.id });
    await audit(req, 'raise_track_record_issue', 'track_record', req.params.id, { applicationId: appId, reason: String(b.reason).slice(0, 500) });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' }); }
});
// Request a DOCUMENT for one track-record line item (owner-directed): the back
// office asks for a specific document on a specific past project. Same
// chokepoint as raise-issue (one condition tagged with the line item), but the
// wording/notification is a document request, and the borrower can satisfy it
// by uploading either on the condition or straight on the line item.
router.post('/track-records/:id/request-doc', async (req, res) => {
  try {
    const b = req.body || {};
    const appId = b.applicationId;
    if (!appId) return res.status(400).json({ error: 'applicationId is required — request the document from within a loan file' });
    const ask = String(b.label || b.reason || '').trim();
    if (!ask) return res.status(400).json({ error: 'say which document you need' });
    const tr = await db.query(`SELECT borrower_id, property_address FROM track_records WHERE id=$1`, [req.params.id]);
    if (!tr.rows[0]) return res.status(404).json({ error: 'track record not found' });
    if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
    const name = addressLabel(tr.rows[0].property_address) || 'a past project';
    const out = await raiseEntityIssue({
      appId, entityKind: 'track_record', entityId: req.params.id, entityName: name,
      reason: ask, actorId: req.actor.id, requestKind: 'doc_request',
    });
    await db.query(`UPDATE track_records SET docs_status='requested', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding')`, [req.params.id]);
    await audit(req, 'request_track_record_doc', 'track_record', req.params.id, { applicationId: appId, label: ask.slice(0, 500) });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' }); }
});
router.post('/llcs/:id/raise-issue', async (req, res) => {
  try {
    const b = req.body || {};
    const appId = b.applicationId;
    if (!appId) return res.status(400).json({ error: 'applicationId is required — raise the issue from within a loan file' });
    if (!String(b.reason || '').trim()) return res.status(400).json({ error: 'a reason is required' });
    const own = await db.query(`SELECT borrower_id, llc_name FROM llcs WHERE id=$1`, [req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'entity not found' });
    if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
    const out = await raiseEntityIssue({ appId, entityKind: 'llc', entityId: req.params.id, entityName: own.rows[0].llc_name || 'the entity', reason: b.reason, actorId: req.actor.id });
    await audit(req, 'raise_llc_issue', 'llc', req.params.id, { applicationId: appId, reason: String(b.reason).slice(0, 500) });
    res.json({ ok: true, ...out });
  } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' }); }
});

// ---------------- advance application status ----------------
const APP_STATUS = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];
const STATUS_LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
// Conditions-to-close gating. Reaching "clear to close" requires every open
// prior-to-docs (and standard) condition cleared/waived and every gate item
// signed off; "funded" additionally requires prior-to-funding conditions.
// post_closing conditions never block. An admin may force past blockers.
const CTC_SEVERITIES = ['standard', 'prior_to_docs'];
const FUND_SEVERITIES = ['standard', 'prior_to_docs', 'prior_to_funding'];
async function advancementBlockers(appId, target) {
  const sevs = target === 'funded' ? FUND_SEVERITIES : CTC_SEVERITIES;
  const conds = await db.query(
    `SELECT id, COALESCE(borrower_title, title) AS title, severity
       FROM conditions
      WHERE application_id=$1 AND status IN ('open','borrower_responded') AND severity = ANY($2::text[])
      ORDER BY severity, created_at`, [appId, sevs]);
  // Every REQUIRED document/condition on the file that isn't cleared (signed off
  // or satisfied) also blocks clear-to-close — the readiness widget used to
  // count only the underwriting `conditions` rows + gate items, so it showed a
  // tiny number ("2 to clear") while a dozen real conditions were still open.
  // Gate items are counted separately below, so exclude them here to avoid a
  // double count. Internal checklist TASKS are workflow, not conditions, so they
  // don't gate here (their milestone subset is captured by is_gate).
  const checklistConds = await db.query(
    `SELECT ci.id, COALESCE(ci.label, ci.borrower_label, 'Condition') AS title
       FROM checklist_items ci
      WHERE ci.application_id=$1
        AND ci.item_kind IN ('document','condition')
        AND COALESCE(ci.is_required, true) = true
        AND COALESCE(ci.is_gate, false) = false
        AND NOT (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')
      ORDER BY ci.sort_order, ci.created_at`, [appId]);
  const gates = await db.query(
    `SELECT id, label FROM checklist_items
      WHERE application_id=$1 AND is_gate=true AND NOT (signed_off_at IS NOT NULL OR status='satisfied')
      ORDER BY sort_order, created_at`, [appId]);
  return { conditions: [...conds.rows, ...checklistConds.rows], gates: gates.rows };
}

// Readiness for the gated transitions — powers the "conditions to close" widget.
router.get('/applications/:id/gating', async (req, res) => {
  try {
    const [ctc, fund] = await Promise.all([
      advancementBlockers(req.params.id, 'clear_to_close'),
      advancementBlockers(req.params.id, 'funded'),
    ]);
    res.json({
      clear_to_close: { ready: !ctc.conditions.length && !ctc.gates.length, ...ctc },
      funded: { ready: !fund.conditions.length && !fund.gates.length, ...fund },
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/applications/:id/status-history', async (req, res) => {
  const r = await db.query(
    `SELECT h.from_status, h.to_status, h.forced, h.created_at, s.full_name AS changed_by_name
       FROM application_status_history h LEFT JOIN staff_users s ON s.id=h.changed_by
      WHERE h.application_id=$1 ORDER BY h.created_at`, [req.params.id]);
  res.json(r.rows);
});

// Edit core loan-file data after creation (fix a typo'd price, wrong property
// type, omitted assignment flag, etc.). Scoped by the /applications/:id guard
// to admins + the assigned officer/processor. Money/unit fields are coerced.
// Covers EVERY application field the intake collects (incl. refi economics),
// and records a field-level before/after diff into the audit log so the
// file's Activity feed shows exactly what changed.
router.patch('/applications/:id/details', async (req, res) => {
  const b = req.body || {};
  const NUM = { units: 'units', purchasePrice: 'purchase_price', asIsValue: 'as_is_value',
    arv: 'arv', rehabBudget: 'rehab_budget', sqftPre: 'sqft_pre', sqftPost: 'sqft_post',
    requestedExpFlips: 'requested_exp_flips', requestedExpHolds: 'requested_exp_holds', requestedExpGround: 'requested_exp_ground',
    requestedExpReo: 'requested_exp_reo', requestedIrMonths: 'requested_ir_months', requestedIrAmount: 'requested_ir_amount',
    payoffAmount: 'payoff_amount', originalPurchasePrice: 'original_purchase_price',
    underlyingContractPrice: 'underlying_contract_price', assignmentFee: 'assignment_fee' };
  const STR = { propertyType: 'property_type', loanType: 'loan_type', program: 'program', occupancy: 'occupancy',
    rehabType: 'rehab_type', term: 'term', lender: 'lender', channel: 'channel', ppp: 'ppp' };
  const DATE = { acquisitionDate: 'acquisition_date' };
  const INT_KEYS = /^(requestedExp|requestedIr)/;
  const sets = [], vals = []; let i = 1;
  const touchedCols = [];
  for (const [k, col] of Object.entries(NUM)) if (k in b) {
    const n = INT_KEYS.test(k) ? intField(b[k]) : (b[k] === '' || b[k] == null ? null : Number(b[k]));
    if (n != null && !isFinite(n)) return res.status(400).json({ error: `${k} must be a number` });
    sets.push(`${col}=$${i++}`); vals.push(n); touchedCols.push(col);
  }
  for (const [k, col] of Object.entries(STR)) if (k in b) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : String(b[k]).slice(0, 200)); touchedCols.push(col); }
  for (const [k, col] of Object.entries(DATE)) if (k in b) {
    const v = b[k] === '' || b[k] == null ? null : String(b[k]).slice(0, 10);
    if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return res.status(400).json({ error: `${k} must be a YYYY-MM-DD date` });
    sets.push(`${col}=$${i++}`); vals.push(v); touchedCols.push(col);
  }
  if ('isAssignment' in b) { sets.push(`is_assignment=$${i++}`); vals.push(!!b.isAssignment); touchedCols.push('is_assignment'); }
  if (b.propertyAddress !== undefined) { sets.push(`property_address=$${i++}`); vals.push(b.propertyAddress ? JSON.stringify(b.propertyAddress) : null); touchedCols.push('property_address'); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    // Before-image of exactly the touched columns — the audit trail records
    // {field: {from, to}} so the Activity feed can say precisely what changed.
    const beforeQ = await db.query(`SELECT ${touchedCols.join(',')} FROM applications WHERE id=$1`, [req.params.id]);
    const before = beforeQ.rows[0] || {};
    // S3-06: on a PRICED file (a product is registered), only underwriting-authority
    // roles (seesAll: admin / underwriter / loan_coordinator) may RAISE the appraisal
    // values that drive leverage — as-is value and ARV. A loan officer can still edit
    // other fields, and lowering a value (less leverage) is allowed; inflating a value
    // to re-price higher is an underwriter's call. The change already reopens Products
    // & Pricing via the db/072 trigger — this adds the who-can-raise control.
    if (!seesAll(req)) {
      const raised = [];
      const oldN = (c) => (before[c] == null ? null : Number(before[c]));
      const newN = (v) => (v === '' || v == null ? null : Number(v));
      if ('asIsValue' in b) { const o = oldN('as_is_value'), n = newN(b.asIsValue); if (o != null && n != null && n > o) raised.push('the as-is value'); }
      if ('arv' in b) { const o = oldN('arv'), n = newN(b.arv); if (o != null && n != null && n > o) raised.push('the ARV'); }
      if (raised.length && await changeRequests.isBorrowerLocked(req.params.id))
        return res.status(403).json({ error: `Only an underwriter or admin can raise ${raised.join(' and ')} on a priced file.` });
    }
    const upd = await db.query(`UPDATE applications SET ${sets.join(',')} WHERE id=$${i}`, vals);
    if (upd.rowCount === 0) return res.status(404).json({ error: 'application not found' });
    enqueueClickupPush(req.params.id, touchedCols).catch(() => {}); // propagate ONLY the edited columns to ClickUp promptly
    if ('requestedExpFlips' in b || 'requestedExpHolds' in b || 'requestedExpGround' in b) {
      try { await syncExperienceChecklistForApplication(req.params.id); } catch (_) { /* best-effort */ }
    }
    const afterQ = await db.query(`SELECT ${touchedCols.join(',')} FROM applications WHERE id=$1`, [req.params.id]);
    const after = afterQ.rows[0] || {};
    const norm = (v) => {
      if (v == null || v === '') return null;
      if (v instanceof Date) return v.toISOString().slice(0, 10);
      if (typeof v === 'object') return JSON.stringify(v);
      return String(v);
    };
    const changes = {};
    for (const col of touchedCols) {
      if (norm(before[col]) !== norm(after[col])) changes[col] = { from: norm(before[col]), to: norm(after[col]) };
    }
    await audit(req, 'edit_application', 'application', req.params.id,
      { fields: Object.keys(b), changes: Object.keys(changes).length ? changes : undefined });
    // Field data changed — let the Condition Center engine re-check its rules.
    let conditions = null;
    if (Object.keys(changes).length) {
      try { conditions = await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'details_edited' }); }
      catch (_) { /* best-effort */ }
    }
    res.json({ ok: true, changed: Object.keys(changes), conditions });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Nudge the borrower with a friendly reminder of what's still outstanding on
// their file (borrower-facing checklist items + open borrower conditions).
router.post('/applications/:id/nudge', async (req, res) => {
  try {
    const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!a.rows[0] || !a.rows[0].borrower_id) return res.status(404).json({ error: 'no borrower on file' });
    const items = await db.query(
      `SELECT COALESCE(borrower_label,label) AS label FROM checklist_items
        WHERE application_id=$1 AND audience IN ('borrower','both') AND status IN ('outstanding','requested','issue')
        ORDER BY sort_order LIMIT 20`, [req.params.id]);
    // Conditions must use the BORROWER-facing wording only — never fall back to
    // the internal title, which can carry underwriting / capital-partner detail.
    // A borrower/both condition without borrower_title is skipped from the nudge.
    const conds = await db.query(
      `SELECT borrower_title AS title FROM conditions
        WHERE application_id=$1 AND audience IN ('borrower','both') AND borrower_title IS NOT NULL
          AND status IN ('open','borrower_responded') LIMIT 20`, [req.params.id]);
    const list = [...items.rows.map(r => r.label), ...conds.rows.map(r => r.title)].filter(Boolean);
    if (!list.length) return res.status(400).json({ error: 'nothing outstanding to remind about' });
    const shown = list.slice(0, 8).join('; ') + (list.length > 8 ? `; +${list.length - 8} more` : '');
    await notify.notifyAppBorrowers(req.params.id, {
      type: 'reminder', title: 'A friendly reminder on your loan file',
      body: `Still needed to keep things moving: ${shown}.`,
      applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Complete your items' });
    await audit(req, 'nudge_borrower', 'application', req.params.id, { count: list.length });
    res.json({ ok: true, count: list.length });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ── Reminders + task management (#93) ────────────────────────────────────────
// The "Remind" button on a file. A reminder/task has a due date+time, a set of
// recipients (any mix of the loan team, the borrower/co-borrower, or an ad-hoc
// email) and a message; a task also carries an assignee. The boot dispatcher
// fires the notification at the due moment via the normal notify fan-out.
const reminders = require('../lib/reminders');

// Everything the composer needs in one call: existing reminders on the file,
// the selectable contacts, and the borrower-facing outstanding items (for the
// "prefill outstanding conditions" helper). Access is already gated by the
// /applications/:id scope middleware above.
router.get('/applications/:id/reminders', async (req, res) => {
  try {
    const [list, contacts, outstanding] = await Promise.all([
      reminders.listForApplication(req.params.id),
      reminders.contactsForApplication(req.params.id, req.actor),
      reminders.outstandingItems(req.params.id),
    ]);
    res.json({ reminders: list, contacts, outstanding });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/applications/:id/reminders', async (req, res) => {
  try {
    const id = await reminders.create(req.params.id, req.body || {}, req.actor);
    await audit(req, 'create_reminder', 'application', req.params.id,
      { reminderId: id, kind: (req.body || {}).kind || 'reminder' });
    res.json({ ok: true, id });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'server error' });
  }
});

router.patch('/applications/:id/reminders/:rid', async (req, res) => {
  try {
    // Defense in depth: the reminder must belong to this (already-scoped) file.
    const own = await db.query(`SELECT 1 FROM reminders WHERE id=$1 AND application_id=$2`, [req.params.rid, req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
    const row = await reminders.update(req.params.rid, req.body || {}, req.actor);
    await audit(req, 'update_reminder', 'application', req.params.id, { reminderId: req.params.rid, status: (req.body || {}).status });
    res.json({ ok: true, reminder: row });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    res.status(500).json({ error: 'server error' });
  }
});

router.delete('/applications/:id/reminders/:rid', async (req, res) => {
  try {
    const own = await db.query(`SELECT 1 FROM reminders WHERE id=$1 AND application_id=$2`, [req.params.rid, req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
    await reminders.remove(req.params.rid);
    await audit(req, 'delete_reminder', 'application', req.params.id, { reminderId: req.params.rid });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Set the file's expected / actual closing date. Setting an estimated closing
// notifies the borrower so they can plan.
router.post('/applications/:id/closing-date', async (req, res) => {
  const b = req.body || {};
  const sets = [], vals = []; let i = 1;
  // Reject not just bad format but impossible calendar dates (2026-13-45), which
  // would otherwise reach Postgres and surface as an opaque 500.
  const bad = (v) => {
    if (!v) return false;
    const s = String(v);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return true;
    const d = new Date(s + 'T00:00:00Z');
    return isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s;
  };
  if (bad(b.expectedClosing) || bad(b.actualClosing)) return res.status(400).json({ error: 'dates must be a valid YYYY-MM-DD' });
  if ('expectedClosing' in b) { sets.push(`expected_closing=$${i++}`); vals.push(b.expectedClosing || null); }
  if ('actualClosing' in b) { sets.push(`actual_closing=$${i++}`); vals.push(b.actualClosing || null); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    await db.query(`UPDATE applications SET ${sets.join(',')} WHERE id=$${i}`, vals);
    await audit(req, 'set_closing_date', 'application', req.params.id, { expectedClosing: b.expectedClosing, actualClosing: b.actualClosing });
    if (b.expectedClosing) {
      const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
      if (a.rows[0] && a.rows[0].borrower_id) {
        const nice = new Date(b.expectedClosing + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await notify.notifyAppBorrowers(req.params.id, {
          type: 'closing_date', title: 'Estimated closing date set',
          body: `Your loan is now targeting ${nice}. We'll keep you posted as it approaches.`,
          applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'View your file' });
      }
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Inline "application completeness" editing: fill a missing field straight from
// the completeness panel (no full form). Whitelisted app + borrower fields only;
// SSN has its own secure reveal/enter flow and is NEVER set here. App-field
// changes enqueue a scoped ClickUp push. Behind the /applications/:id guard.
const COMPLETE_APP_FIELDS = { program: 'text', loan_type: 'text', property_type: 'text',
  purchase_price: 'money', as_is_value: 'money', arv: 'money', rehab_budget: 'money' };
const COMPLETE_BORROWER_FIELDS = { cell_phone: 'text', date_of_birth: 'date', fico: 'int', citizenship: 'text' };
async function completeFields(req, res, borrowerScoped) {
  const b = req.body || {};
  try {
    const brRow = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!brRow.rows[0]) return res.status(404).json({ error: 'not found' });
    const bid = brRow.rows[0].borrower_id;
    const appVals = [req.params.id]; const appSets = []; const appKeys = [];
    for (const [k, t] of Object.entries(COMPLETE_APP_FIELDS)) {
      if (!(k in b) || b[k] === '' || b[k] == null) continue;
      let v = b[k];
      if (t === 'money') { const s = String(v).replace(/[^0-9.]/g, ''); if (s === '') continue; v = Number(s); if (!Number.isFinite(v)) continue; }
      appVals.push(v); appSets.push(`${k}=$${appVals.length}`); appKeys.push(k);
    }
    // S3-06 (mirror of /details): this path overwrites unconditionally, so it's
    // also a raising vector — a non-seesAll staffer may not RAISE the as-is value
    // or ARV on a priced file. Filling a blank or lowering is still allowed.
    if (!seesAll(req) && ('as_is_value' in b || 'arv' in b)) {
      const cur = (await db.query(`SELECT as_is_value, arv FROM applications WHERE id=$1`, [req.params.id])).rows[0] || {};
      const moneyN = (v) => { if (v === '' || v == null) return null; const s = String(v).replace(/[^0-9.]/g, ''); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };
      const raised = [];
      if ('as_is_value' in b) { const o = cur.as_is_value == null ? null : Number(cur.as_is_value), n = moneyN(b.as_is_value); if (o != null && n != null && n > o) raised.push('the as-is value'); }
      if ('arv' in b) { const o = cur.arv == null ? null : Number(cur.arv), n = moneyN(b.arv); if (o != null && n != null && n > o) raised.push('the ARV'); }
      if (raised.length && await changeRequests.isBorrowerLocked(req.params.id))
        return res.status(403).json({ error: `Only an underwriter or admin can raise ${raised.join(' and ')} on a priced file.` });
    }
    if (appSets.length) {
      appSets.push('updated_at=now()');
      await db.query(`UPDATE applications SET ${appSets.join(', ')} WHERE id=$1`, appVals);
      enqueueClickupPush(req.params.id, appKeys).catch(() => {});
    }
    const brVals = [bid]; const brSets = [];
    for (const [k, t] of Object.entries(COMPLETE_BORROWER_FIELDS)) {
      if (!(k in b) || b[k] === '' || b[k] == null) continue;
      let v = b[k];
      if (t === 'int') { v = parseInt(v, 10); if (!Number.isFinite(v)) continue; }
      brVals.push(v); brSets.push(`${k}=$${brVals.length}`);
    }
    if (brSets.length) {
      brSets.push('updated_at=now()');
      await db.query(`UPDATE borrowers SET ${brSets.join(', ')} WHERE id=$1`, brVals);
    }
    if (!borrowerScoped) await audit(req, 'complete_fields', 'application', req.params.id, { app: appKeys, borrower: brSets.length });
    res.json({ ok: true, appFields: appKeys.length, borrowerFields: brSets.length });
  } catch (e) { res.status(500).json({ error: db.describeError ? db.describeError(e) : 'server error' }); }
}
router.post('/applications/:id/complete-fields', (req, res) => completeFields(req, res, false));

// S3-05: DECISION-grade statuses are an underwriting call — only roles with
// see_all_files authority (admin / underwriter / loan_coordinator) may move a file
// into one. A loan officer or processor can advance a file through the working
// statuses but cannot approve, clear-to-close, fund, or decline it.
const DECISION_STATUSES = new Set(['approved', 'clear_to_close', 'funded', 'declined']);
router.patch('/applications/:id', async (req, res) => {
  const { status } = req.body || {};
  const force = !!(req.body && req.body.force);
  if (!status || !APP_STATUS.includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const cur = await db.query(
      `SELECT status, borrower_id, loan_officer_id, processor_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (cur.rows[0].status === status) return res.json({ ok: true, unchanged: true, status });
    if (DECISION_STATUSES.has(status) && !seesAll(req))
      return res.status(403).json({ error: 'Only an underwriter or admin can move a file to this status.' });
    // Gate the underwriting-critical transitions on conditions-to-close + gate items.
    let forced = false;
    if (status === 'clear_to_close' || status === 'funded') {
      const blockers = await advancementBlockers(req.params.id, status);
      if (blockers.conditions.length || blockers.gates.length) {
        if (!(force && isAdmin(req))) return res.status(409).json({ error: 'blocked', target: status, blockers });
        forced = true;
      }
    }
    await db.query(`UPDATE applications SET status=$2, status_changed_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, status]);
    enqueueClickupPush(req.params.id, ['status']).catch(() => {}); // propagate ONLY the status change to ClickUp promptly
    // Record the transition on the file's timeline.
    await db.query(
      `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, forced)
       VALUES ($1,$2,$3,$4,$5)`, [req.params.id, cur.rows[0].status, status, req.actor.id, forced]);
    // Funding seeds the post-closing trailing-doc checklist.
    if (status === 'funded') { try { await seedPostClosing(req.params.id); } catch (_) {} }
    await audit(req, 'status_change', 'application', req.params.id, { from: cur.rows[0].status, to: status, forced: forced || undefined });
    // Status is a rule-engine field (e.g. "when the file reaches underwriting").
    try { await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'status_change' }); } catch (_) {}
    const label = STATUS_LABEL[status] || status;
    try {
      await notify.notifyAppBorrowers(req.params.id, {
        type: 'status_change', title: `Your loan status: ${label}`,
        body: `Your application has moved to "${label}". Sign in to see the latest.`,
        applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'View your file' });
      const team = new Set([cur.rows[0].loan_officer_id, cur.rows[0].processor_id].filter(Boolean).filter(x => x !== req.actor.id));
      for (const sid of team)
        await notify.notifyStaff(sid, {
          type: 'status_change', title: `File moved to ${label}`,
          applicationId: req.params.id, link: `/internal/app/${req.params.id}` });
    } catch (_) { /* notify best-effort */ }
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Set the EXACT ClickUp task status (internal_status) directly — the 38-status
// workflow, not the 9 borrower-facing buckets. The borrower-facing `status` is
// re-derived from it (statusMap.externalFor) and the scoped push mirrors both to
// ClickUp. The /applications/:id path middleware already enforces per-file auth.
router.post('/applications/:id/internal-status', async (req, res) => {
  const internalStatus = req.body && req.body.internalStatus;
  if (!statusMap.isKnownInternal(internalStatus)) return res.status(400).json({ error: 'unknown internal status' });
  const external = statusMap.externalFor(internalStatus);
  try {
    const cur = await db.query(`SELECT status, internal_status FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (statusMap.norm(cur.rows[0].internal_status) === statusMap.norm(internalStatus))
      return res.json({ ok: true, unchanged: true, internal_status: internalStatus, status: external });
    // S3-05: the internal-status path re-derives the borrower-facing status, so it
    // is a second door into the decision-grade buckets — gate it the same way.
    if (DECISION_STATUSES.has(external) && !seesAll(req))
      return res.status(403).json({ error: 'Only an underwriter or admin can move a file to this status.' });
    await db.query(
      `UPDATE applications SET internal_status=$2, status=$3, status_changed_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, internalStatus, external]);
    enqueueClickupPush(req.params.id, ['status']).catch(() => {}); // push ONLY the status (task status + borrower_portal_status mirror)
    // Record the (borrower-facing) transition on the file's timeline, like PATCH /:id.
    await db.query(
      `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, forced)
       VALUES ($1,$2,$3,$4,$5)`, [req.params.id, cur.rows[0].status, external, req.actor.id, false]);
    await audit(req, 'internal_status_change', 'application', req.params.id,
      { from: cur.rows[0].internal_status, to: internalStatus, external });
    // Status is a rule-engine field — re-run conditions on the new external bucket.
    try { await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'status_change' }); } catch (_) {}
    res.json({ ok: true, internal_status: internalStatus, status: external });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ARCHIVE a file (soft): keeps the row + audit trail but removes it from every
// active surface AND from the dashboard figures. Reversible via restore; lives
// in the Archived folder. `deleted_at` is the archive marker. delete_files cap.
router.post('/applications/:id/archive', async (req, res) => {
  if (!can(req.actor, 'delete_files')) return res.status(403).json({ error: 'you do not have permission to archive files' });
  try {
    const r = await db.query(`UPDATE applications SET deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'archive_application', 'application', req.params.id, { reason: (req.body && req.body.reason) || null });
    res.json({ ok: true, archived: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/restore', async (req, res) => {
  if (!can(req.actor, 'delete_files')) return res.status(403).json({ error: 'you do not have permission to restore files' });
  try {
    const r = await db.query(`UPDATE applications SET deleted_at=NULL, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'restore_application', 'application', req.params.id);
    res.json({ ok: true, restored: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// DELETE PERMANENTLY (hard): the row and everything under it (checklist items,
// documents, conditions, product registrations, status history, conversations,
// field values…) are removed by ON DELETE CASCADE, the stored document bytes are
// deleted from disk, and it is gone from every surface and every figure. Not
// reversible. Entity (LLC) documents are shared and keyed on llc_id (not this
// file), so they are left untouched. delete_files capability.
router.delete('/applications/:id', async (req, res) => {
  if (!can(req.actor, 'delete_files')) return res.status(403).json({ error: 'you do not have permission to delete files' });
  try {
    const exists = await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1`, [req.params.id]);
    if (!exists.rows[0]) return res.status(404).json({ error: 'not found' });
    // Remove stored document bytes for THIS file (app-owned only; leave shared
    // LLC entity docs). Best-effort per file — a missing blob never blocks.
    const docs = await db.query(`SELECT storage_ref FROM documents WHERE application_id=$1`, [req.params.id]);
    for (const d of docs.rows) { try { if (d.storage_ref) await storage.remove(d.storage_ref); } catch (_) { /* orphan bytes are harmless */ } }
    await db.query(`DELETE FROM applications WHERE id=$1`, [req.params.id]);
    // Audit AFTER the delete: audit_log.entity_id has no FK, so the trail
    // survives the purge. Ties the removal to a real actor + reason.
    await audit(req, 'purge_application', 'application', req.params.id,
      { ysLoanNumber: exists.rows[0].ys_loan_number || null, reason: (req.body && req.body.reason) || null, documents: docs.rows.length });
    res.json({ ok: true, purged: true });
  } catch (e) { console.error('[staff] purge failed:', db.describeError ? db.describeError(e) : e.message); res.status(500).json({ error: 'could not delete the file' }); }
});
// The Archived folder — soft-deleted files, newest first. delete_files cap.
// Mounted OUTSIDE the /applications/:id path so it isn't read as an id.
router.get('/archived-applications', async (req, res) => {
  if (!can(req.actor, 'delete_files')) return res.status(403).json({ error: 'forbidden' });
  // S3-09: scope to the officer's own files exactly like GET /applications does —
  // a non-seesAll staffer granted delete_files must not see every officer's
  // archived files. seesAll actors get the empty scope (all archived files).
  const s = scopeClause(req);
  const params = [...s.params];
  const where = ['a.deleted_at IS NOT NULL'];
  if (s.where) where.push(s.where.replace(/\$SCOPE/g, '$1').replace(/^AND\s+/, ''));
  const r = await db.query(
    `SELECT a.id, a.ys_loan_number, a.program, a.loan_type, a.status, a.property_address,
            a.loan_amount, a.deleted_at, a.created_at,
            b.first_name, b.last_name, b.email
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.deleted_at DESC`, params);
  res.json(r.rows);
});

// ---------------- chat inbox (Slack-style: a channel per loan file) ----------------
// Every file the staffer can see is a conversation — even before the first
// message — so there's always somewhere to start. Unread rises to the top, then
// most-recent activity, then newest file. Closed files sink below active ones.
router.get('/chat/inbox', async (req, res) => {
  try {
    const scoped = !seesAll(req);
    const params = [req.actor.id];
    const r = await db.query(
      `SELECT * FROM (
        SELECT a.id, a.ys_loan_number, a.status, a.property_address, a.created_at,
              b.first_name, b.last_name,
              (b.last_seen_at IS NOT NULL AND b.last_seen_at > now() - interval '3 minutes') AS borrower_online,
              lm.body AS last_body, lm.channel AS last_channel, lm.sender_kind AS last_sender_kind,
              lm.attachment_kind AS last_attachment_kind, lm.created_at AS last_at,
              (a.status IN ('funded','declined','withdrawn')) AS closed,
              -- Unread now comes from the per-member watermark model (035).
              COALESCE((SELECT cm.unread_count FROM conversation_members cm
                          JOIN conversations c2 ON c2.id=cm.conversation_id
                         WHERE c2.application_id=a.id AND c2.kind='borrower'
                           AND cm.member_kind='staff' AND cm.member_id=$1 AND cm.removed_at IS NULL), 0) AS unread_borrower,
              COALESCE((SELECT sum(cm.unread_count)::int FROM conversation_members cm
                          JOIN conversations c2 ON c2.id=cm.conversation_id
                         WHERE c2.application_id=a.id AND c2.kind<>'borrower'
                           AND cm.member_kind='staff' AND cm.member_id=$1 AND cm.removed_at IS NULL), 0) AS unread_internal
         FROM applications a
         JOIN borrowers b ON b.id=a.borrower_id
         LEFT JOIN LATERAL (SELECT body, channel, sender_kind, attachment_kind, created_at
                         FROM messages m WHERE m.application_id=a.id
                        ORDER BY created_at DESC LIMIT 1) lm ON true
        WHERE a.deleted_at IS NULL ${scoped ? `AND ${VISIBLE_OFFICERS_SQL('a', '$1')}` : ''}
      ) q
      -- The chat hub (outside a file) is a list of REAL conversations, not every
      -- file that exists: only surface files that actually have back-and-forth
      -- messages. A file with no messages is reached from the file itself, not here.
      WHERE q.last_at IS NOT NULL
      ORDER BY (q.unread_borrower + q.unread_internal) DESC,
               q.closed ASC,
               q.last_at DESC NULLS LAST,
               q.created_at DESC
      LIMIT 100`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Everything mentionable on this file: people, tasks, documents, and the
// borrower's other applications/properties — powers the @/# composer picker.
router.get('/applications/:id/mentionables', async (req, res) => {
  try {
    const [users, tasks, docs, apps] = await Promise.all([
      db.query(`SELECT id, full_name AS label FROM staff_users WHERE is_active=true ORDER BY full_name`),
      db.query(`SELECT id, label, status FROM checklist_items WHERE application_id=$1 ORDER BY sort_order LIMIT 300`, [req.params.id]),
      db.query(`SELECT id, filename AS label FROM documents WHERE application_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]),
      db.query(`SELECT a.id, COALESCE(a.property_address->>'oneLine', a.property_address->>'street', 'Application') AS label
                  FROM applications a WHERE a.borrower_id=(SELECT borrower_id FROM applications WHERE id=$1)`, [req.params.id]),
    ]);
    res.json({ users: users.rows, tasks: tasks.rows, documents: docs.rows, applications: apps.rows });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Toggle an emoji reaction on a message (per person per emoji).
router.post('/messages/:mid/react', async (req, res) => {
  const emoji = String((req.body || {}).emoji || '').slice(0, 16);
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  try {
    const m = await db.query(`SELECT application_id, conversation_id FROM messages WHERE id=$1`, [req.params.mid]);
    if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!seesAll(req)) {
      const own = await db.query(
        `SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2)`,
        [m.rows[0].application_id, req.actor.id]);
      if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
    }
    const del = await db.query(
      `DELETE FROM message_reactions WHERE message_id=$1 AND actor_kind='staff' AND actor_id=$2 AND emoji=$3 RETURNING id`,
      [req.params.mid, req.actor.id, emoji]);
    if (!del.rows[0])
      await db.query(`INSERT INTO message_reactions (message_id,actor_kind,actor_id,emoji) VALUES ($1,'staff',$2,$3)`,
        [req.params.mid, req.actor.id, emoji]);
    if (m.rows[0].conversation_id) {
      const chatLib = require('../lib/chat');
      const fresh = await chatLib.getMessage(req.params.mid);
      require('../lib/events').publishToConversation(m.rows[0].conversation_id, 'reaction:update',
        { conversationId: m.rows[0].conversation_id, messageId: req.params.mid, reactions: fresh.reactions }).catch(() => {});
    }
    res.json({ ok: true, reacted: !del.rows[0] });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Pin / unpin a message (any staffer on the file).
router.post('/messages/:mid/pin', async (req, res) => {
  try {
    const m = await db.query(`SELECT application_id, pinned FROM messages WHERE id=$1`, [req.params.mid]);
    if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, m.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    const next = !m.rows[0].pinned;
    await db.query(`UPDATE messages SET pinned=$2::boolean, pinned_by=CASE WHEN $2 THEN $3::uuid ELSE NULL END, pinned_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`, [req.params.mid, next, req.actor.id]);
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) {
      const fresh = await require('../lib/chat').getMessage(req.params.mid);
      require('../lib/events').publishToConversation(convId, 'message:edited',
        { conversationId: convId, message: fresh }).catch(() => {});
    }
    res.json({ ok: true, pinned: next });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Edit a staff message (own, within 15 min) — or admin any time.
router.patch('/messages/:mid', async (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  try {
    const m = await db.query(`SELECT application_id, sender_id, sender_kind, created_at, deleted_at FROM messages WHERE id=$1`, [req.params.mid]);
    const row = m.rows[0];
    if (!row || row.deleted_at) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
    // Editing changes the author's words, so it is restricted to one's OWN
    // message (never a borrower's or another staffer's). Non-admins are also
    // held to a 15-minute window; admins may edit their own past it. Removing
    // someone else's message is handled by soft-delete (moderation) below.
    const mine = row.sender_kind === 'staff' && row.sender_id === req.actor.id;
    const fresh = (Date.now() - new Date(row.created_at).getTime()) < 15 * 60 * 1000;
    if (!(mine && (fresh || isAdmin(req)))) return res.status(403).json({ error: 'can only edit your own recent message' });
    // Append-only revision trail: the UI shows only the latest + "(edited)",
    // but the pre-edit body is preserved for audit/discovery.
    await db.query(
      `INSERT INTO message_revisions (message_id, body, edited_by_kind, edited_by_id)
       SELECT id, body, 'staff', $2 FROM messages WHERE id=$1`, [req.params.mid, req.actor.id]);
    await db.query(`UPDATE messages SET body=$2, edited_at=now() WHERE id=$1`, [req.params.mid, body.slice(0, 4000)]);
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) {
      const freshMsg = await require('../lib/chat').getMessage(req.params.mid);
      require('../lib/events').publishToConversation(convId, 'message:edited',
        { conversationId: convId, message: freshMsg }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Soft-delete a message (own, or admin/underwriter as moderator).
router.delete('/messages/:mid', async (req, res) => {
  try {
    const m = await db.query(`SELECT application_id, sender_id, sender_kind FROM messages WHERE id=$1`, [req.params.mid]);
    const row = m.rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, row.application_id))) return res.status(403).json({ error: 'forbidden' });
    const mine = row.sender_kind === 'staff' && row.sender_id === req.actor.id;
    if (!(seesAll(req) || mine)) return res.status(403).json({ error: 'forbidden' });
    // Tombstone, never a hard delete — the pre-delete body goes to the
    // revision trail so the record survives for audit/discovery.
    await db.query(
      `INSERT INTO message_revisions (message_id, body, edited_by_kind, edited_by_id)
       SELECT id, body, 'staff', $2 FROM messages WHERE id=$1`, [req.params.mid, req.actor.id]);
    await db.query(`UPDATE messages SET deleted_at=now(), body='[message removed]', pinned=false WHERE id=$1`, [req.params.mid]);
    await db.query(`DELETE FROM message_reactions WHERE message_id=$1`, [req.params.mid]);
    await audit(req, 'delete_message', 'application', row.application_id, { messageId: req.params.mid });
    const convId = (await db.query(`SELECT conversation_id FROM messages WHERE id=$1`, [req.params.mid])).rows[0].conversation_id;
    if (convId) require('../lib/events').publishToConversation(convId, 'message:deleted',
      { conversationId: convId, messageId: req.params.mid }).catch(() => {});
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- collaboration messaging (LEGACY channel endpoints) --------
// Conversations are first-class now (see routes/staff-chat.js). These two
// endpoints keep the old (application, channel) contract working for any
// stale client by delegating onto the file's default conversations.
router.get('/applications/:id/messages', async (req, res) => {
  const channel = req.query.channel === 'internal' ? 'internal' : 'borrower';
  try {
    const chatLib = require('../lib/chat');
    await chatLib.ensureConversationsForApp(req.params.id);
    const c = await db.query(
      `SELECT id FROM conversations WHERE application_id=$1 AND kind=$2`, [req.params.id, channel]);
    if (!c.rows[0]) return res.json([]);
    const conv = await chatLib.getConversation(c.rows[0].id);
    const msgs = await chatLib.fetchMessages(conv.id, { limit: 200 });
    // The legacy contract marked everything read on open.
    const maxSeq = msgs.length ? msgs[msgs.length - 1].seq : 0;
    if (maxSeq) await chatLib.markRead(conv, { kind: 'staff', id: req.actor.id }, maxSeq);
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/messages', async (req, res) => {
  const b = req.body || {};
  const channel = b.channel === 'internal' ? 'internal' : 'borrower';
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  try {
    const chatLib = require('../lib/chat');
    await chatLib.ensureConversationsForApp(req.params.id);
    const c = await db.query(
      `SELECT id FROM conversations WHERE application_id=$1 AND kind=$2`, [req.params.id, channel]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    const conv = await chatLib.getConversation(c.rows[0].id);

    let taskId = null;
    if (b.makeTask && channel === 'internal') {
      const t = await db.query(
        `INSERT INTO checklist_items
           (application_id, scope, audience, item_kind, label, status, created_by_kind, created_by_id, assignee_staff_id)
         VALUES ($1,'application','staff','task',$2,'outstanding','staff',$3,$4) RETURNING id`,
        [req.params.id, String(b.taskLabel || b.body).slice(0, 300), req.actor.id, b.assigneeStaffId || null]);
      taskId = t.rows[0].id;
    }
    const { message } = await chatLib.postMessage({
      conv, actor: { kind: 'staff', id: req.actor.id, role: req.actor.role },
      body: b.body, attachment: att, entityRefs: b.entityRefs, checklistItemId: taskId,
    });
    await audit(req, 'post_message', 'application', req.params.id, { channel, taskId, attachment: !!att });
    res.status(201).json({ ok: true, messageId: message.id, taskId });
  } catch (e) {
    if (e.code === 'pii_blocked') return res.status(400).json({ error: e.message });
    res.status(e.status || 500).json({ error: e.status ? e.message : 'server error' });
  }
});

// ---------------- leads (marketing-site submissions) ----------------
// admins/underwriters see all; a loan officer sees leads routed to them plus
// unrouted ones (the shared desk).
router.get('/leads', async (req, res) => {
  try {
    const where = seesAll(req) ? '' : 'WHERE (officer_id=$1 OR officer_id IS NULL)';
    const params = seesAll(req) ? [] : [req.actor.id];
    const r = await db.query(
      `SELECT l.id,l.tool,l.name,l.email,l.phone,l.subject,l.message,l.payload,l.status,
              l.officer_id,l.created_at, s.full_name AS officer_name
         FROM leads l LEFT JOIN staff_users s ON s.id=l.officer_id
         ${where} ORDER BY l.created_at DESC LIMIT 300`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.patch('/leads/:id', async (req, res) => {
  const b = req.body || {};
  const STATUSES = ['new', 'contacted', 'working', 'converted', 'archived'];
  if (b.status && !STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
  // Horizontal scope: a non-privileged officer may only touch a lead that is
  // unassigned or already theirs — the same scope GET /leads applies — so one
  // officer can't reassign or alter another officer's lead by its id.
  if (!seesAll(req)) {
    const own = await db.query(`SELECT 1 FROM leads WHERE id=$1 AND (officer_id=$2 OR officer_id IS NULL)`, [req.params.id, req.actor.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
  }
  const sets = [], vals = []; let i = 1;
  if (b.status !== undefined) { sets.push(`status=$${i++}`); vals.push(b.status); }
  if (b.officerId !== undefined) { sets.push(`officer_id=$${i++}`); vals.push(b.officerId || null); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try { await db.query(`UPDATE leads SET ${sets.join(',')} WHERE id=$${i}`, vals); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- documents ----------------
// List documents on a file. The /applications/:id middleware already enforced
// that this staffer may see this application.
router.get('/applications/:id/documents', async (req, res) => {
  // Formal documents only — chat attachments live in the conversation, not the
  // review queue. source_type/visibility are returned so the UI can badge.
  // The vesting LLC's documents (application_id NULL, llc_id = the file's LLC)
  // are part of the file too — they ride along automatically wherever the
  // entity is linked.
  const r = await db.query(
    `SELECT d.id,d.filename,d.content_type,d.size_bytes,d.checklist_item_id,d.slot_label,d.doc_kind,d.uploaded_by_kind,d.created_at,
            d.review_status,d.rejection_reason,d.reviewed_at,d.is_current,d.replaces_document_id,
            d.source_type,d.visibility,d.llc_id,
            s.full_name AS reviewed_by_name,
            CASE WHEN d.llc_id IS NOT NULL THEN 'LLC — ' || COALESCE(ci.label, l.llc_name) ELSE ci.label END AS item_label
       FROM documents d
       LEFT JOIN staff_users s ON s.id=d.reviewed_by
       LEFT JOIN checklist_items ci ON ci.id=d.checklist_item_id
       LEFT JOIN llcs l ON l.id=d.llc_id
      WHERE (d.application_id=$1
             OR (d.application_id IS NULL AND d.llc_id IS NOT NULL
                 AND d.llc_id=(SELECT llc_id FROM applications WHERE id=$1)))
        AND d.source_type <> 'chat_attachment'
      ORDER BY d.is_current DESC, d.created_at DESC`, [req.params.id]);
  res.json(r.rows);
});

// Attach a document to the file as staff. Used by the Term Sheet Studio panel
// to save the registered term sheet PDF; docKind 'term_sheet' supersedes any
// prior term sheet so only the latest registration's sheet stays current.
// With a checklistItemId the upload lands INSIDE that condition on the
// borrower's behalf — same slots, same supersede rules as a borrower upload —
// so a staffer can fill the shared conditions list when the borrower can't.
router.post('/applications/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  const appOk = await db.query(`SELECT id, borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!appOk.rows[0]) return res.status(404).json({ error: 'not found' });
  let borrowerId = appOk.rows[0].borrower_id;
  // LLC-slot upload: the document belongs to a borrower entity (application_id
  // NULL, llc_id set) so it follows the entity to every vesting file — the same
  // shape a borrower upload produces. Mirror the borrower's verified-lock.
  let llcId = null;
  if (b.llcId) {
    const l = await db.query(`SELECT id, borrower_id, is_verified FROM llcs WHERE id=$1`, [b.llcId]);
    if (!l.rows[0]) return res.status(404).json({ error: 'entity not found' });
    if (l.rows[0].borrower_id !== appOk.rows[0].borrower_id) return res.status(403).json({ error: 'this entity is not on the borrower for this file' });
    if (l.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — revoke verification before replacing its documents' });
    llcId = l.rows[0].id;
    borrowerId = l.rows[0].borrower_id;
  }
  // Term sheets auto-attach to the Products & Pricing register condition as a
  // document slot (owner-directed #139): the registered term sheet saves STRAIGHT
  // INTO that condition, not just as a loose file. Only when the caller didn't
  // already target a specific condition or an LLC slot.
  if (b.docKind === 'term_sheet' && !b.checklistItemId && !llcId) {
    const pp = await db.query(
      `SELECT id FROM checklist_items WHERE application_id=$1 AND tool_key='product_pricing' ORDER BY created_at LIMIT 1`,
      [req.params.id]);
    if (pp.rows[0]) { b.checklistItemId = pp.rows[0].id; if (!b.slot) b.slot = 'Term sheet'; }
  }
  let itemLabel = '';
  let itemAudience = null;
  let itemTrackRecordId = null;
  if (b.checklistItemId) {
    // An LLC slot item has application_id NULL — look it up by llc_id instead.
    const it = llcId
      ? await db.query(`SELECT id, COALESCE(borrower_label,label) AS label, audience, track_record_id FROM checklist_items WHERE id=$1 AND llc_id=$2`, [b.checklistItemId, llcId])
      : await db.query(`SELECT id, COALESCE(borrower_label,label) AS label, audience, track_record_id FROM checklist_items WHERE id=$1 AND application_id=$2`, [b.checklistItemId, req.params.id]);
    if (!it.rows[0]) return res.status(404).json({ error: 'checklist item not found on this file' });
    itemLabel = it.rows[0].label;
    itemAudience = it.rows[0].audience;
    // A condition raised FOR one track-record line item: the upload belongs to
    // that line too (same contract as the borrower path).
    itemTrackRecordId = it.rows[0].track_record_id || null;
  }
  // Internal (staff-audience) conditions like Insurance / Title never leak to the
  // borrower: store the document staff-only and skip the borrower notification.
  const staffOnly = itemAudience === 'staff';
  const docVisibility = staffOnly ? 'staff_only' : 'borrower';
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;
  const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (application_id,checklist_item_id,borrower_id,llc_id,track_record_id,filename,content_type,size_bytes,storage_provider,storage_ref,
                            uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staff',$11,$12,$13,$14) RETURNING id`,
    [llcId ? null : req.params.id, b.checklistItemId || null,
     (b.checklistItemId || llcId) ? borrowerId : null, llcId, itemTrackRecordId,
     b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref,
     req.actor.id, docKind, slot, docVisibility]);
  if (itemTrackRecordId) {
    await db.query(
      `UPDATE track_records SET docs_status='received', updated_at=now()
        WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [itemTrackRecordId]);
  }
  if (docKind === 'term_sheet') {
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE application_id=$1 AND doc_kind='term_sheet' AND id<>$2 AND is_current=true`,
      [req.params.id, r.rows[0].id]);
  }
  if (b.checklistItemId) {
    // Mirror the borrower upload rules: replacing a document (or re-filling a
    // slot) supersedes only that slot's versions; other slots coexist.
    if (b.replaceDocumentId) {
      await db.query(
        `UPDATE documents SET is_current=false,
            review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
          WHERE id=$1 AND checklist_item_id=$2`,
        [b.replaceDocumentId, b.checklistItemId]);
    }
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE checklist_item_id=$1 AND id<>$2 AND is_current=true
          AND ($3::text IS NOT NULL OR $4::uuid IS NULL)
          AND ($3::text IS NULL OR slot_label IS NOT DISTINCT FROM $3)`,
      [b.checklistItemId, r.rows[0].id, slot, b.replaceDocumentId || null]);
    await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1`, [b.checklistItemId]);
    enqueueChecklistStatusPush(b.checklistItemId).catch(() => {}); // mapped conditions → ClickUp dropdown
    // The shared list works both ways — tell the borrower their team added it.
    // Staff-only (internal) conditions are never surfaced or emailed to them.
    if (borrowerId && !staffOnly) {
      try {
        const ctx = await notify.fileContext(req.params.id);
        await notify.notifyBorrower(borrowerId, {
          type: 'doc_uploaded', title: `Your loan team added a document to "${itemLabel}"`,
          body: `"${b.filename}" was uploaded to ${llcId ? 'your entity documents' : `condition "${itemLabel}"`}${slot ? ` (${slot})` : ''}${ctx ? ` on ${ctx.label}` : ''} on your behalf.`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: llcId ? null : req.params.id, link: llcId ? '/entities' : `/app/${req.params.id}` });
      } catch (_) { /* best-effort */ }
    }
  }
  // An LLC-slot upload re-drives the umbrella LLC condition on every open file
  // vesting in the entity (all slots present → received; etc).
  if (llcId) { try { await llcLib.syncLlcConditions(llcId); } catch (_) { /* best-effort */ } }
  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename, docKind, checklistItemId: b.checklistItemId || null, llcId });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  res.status(201).json({ ok: true, documentId: r.rows[0].id });
});

// Approve or reject an uploaded document. Rejection requires a reason, keeps the
// rejected file in history (never in the clean file), and flips its checklist
// item back to 'issue' so the borrower sees exactly what to fix and re-uploads.
// Acceptance marks the item RECEIVED (not satisfied) — the condition stays open
// until a reviewer signs it off (#135). Only accepted+current docs count for the
// file (see getApprovedDocuments / TPR export).
router.post('/documents/:id/review', async (req, res) => {
  const b = req.body || {};
  const action = b.action;
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be accept or reject' });
  // Accepting a document completes its condition — processor/admin only.
  // Anyone on the file may reject (the document lands in the file's trash).
  if (action === 'accept' && !can(req.actor, 'sign_off_conditions')) {
    return res.status(403).json({ error: 'Only the processor can accept a document — you can reject it or mark the condition reviewed.' });
  }
  if (action === 'reject' && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a rejection reason is required' });
  // Accept + request another document: the borrower must be told WHAT else is
  // needed, so the note is required too (owner-directed 2026-07-12) — an empty
  // "request more" left the borrower with a still-open condition and no reason.
  if (action === 'accept' && b.requestMore && !String(b.note || '').trim()) {
    return res.status(400).json({ error: 'tell the borrower what additional document is needed' });
  }
  try {
    const r = await db.query(
      `SELECT id,filename,application_id,borrower_id,llc_id,checklist_item_id,track_record_id FROM documents WHERE id=$1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeDocument(req, doc))) return res.status(403).json({ error: 'forbidden' });

    const status = action === 'accept' ? 'accepted' : 'rejected';
    // Accept-and-request-more: the document itself is GOOD and stays accepted,
    // but the condition is not satisfied yet — the reviewer asks the borrower
    // for one more document on the same condition (a new slot), so the
    // condition stays open instead of signing off.
    const requestMore = action === 'accept' && !!b.requestMore;
    const moreNote = requestMore ? String(b.note || '').trim().slice(0, 500) : '';
    await db.query(
      `UPDATE documents SET review_status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
      [doc.id, status, action === 'reject' ? String(b.reason).slice(0, 1000) : null, req.actor.id]);

    // Move the linked checklist item: accept -> satisfied, reject -> issue —
    // unless the reviewer asked for another document, which keeps it open.
    if (doc.checklist_item_id) {
      if (requestMore) {
        // The note must reach the BORROWER — ci.notes is internal-only (never
        // sent to borrowers), so the ask lands in borrower_hint, replacing any
        // previous "Still needed:" suffix instead of stacking them.
        const cur = await db.query(`SELECT COALESCE(borrower_hint, hint, '') AS bh FROM checklist_items WHERE id=$1`, [doc.checklist_item_id]);
        const baseHint = String((cur.rows[0] && cur.rows[0].bh) || '').replace(/\s*·?\s*Still needed:.*$/s, '').trim();
        const newHint = moreNote ? (baseHint ? `${baseHint} · Still needed: ${moreNote}` : `Still needed: ${moreNote}`) : null;
        await db.query(
          `UPDATE checklist_items SET status='outstanding',
                  notes=CASE WHEN $2 <> '' THEN $2 ELSE notes END,
                  borrower_hint=COALESCE($3, borrower_hint), updated_at=now() WHERE id=$1`,
          [doc.checklist_item_id, moreNote ? `Still needed: ${moreNote}` : '', newHint]);
      } else {
        // Accepting a document only marks the condition RECEIVED — NOT satisfied
        // (owner-directed 2026-07-12). The condition stays open on the list until
        // a reviewer explicitly SIGNS IT OFF (which routes through signOffGate and
        // therefore enforces every required document/slot — e.g. a background AND
        // criminal report, insurance binder AND invoice). This prevents a
        // multi-document condition from "flying away" the moment ONE of its
        // documents is accepted, and keeps accept (doc is good) distinct from
        // sign-off (the whole condition is complete). Reject -> issue.
        await db.query(`UPDATE checklist_items SET status=$2, updated_at=now() WHERE id=$1`,
          [doc.checklist_item_id, action === 'accept' ? 'received' : 'issue']);
      }
      enqueueChecklistStatusPush(doc.checklist_item_id).catch(() => {}); // mapped conditions → ClickUp dropdown
    }
    await audit(req, action === 'accept' ? (requestMore ? 'accept_document_request_more' : 'accept_document') : 'reject_document', 'document', doc.id,
      action === 'reject' ? { reason: b.reason } : requestMore ? { note: moreNote } : null);

    // Tell the borrower another document is needed on this condition — the
    // accepted file is kept; this is an "and also", not a rejection.
    if (requestMore && doc.borrower_id) {
      try {
        let condLabel = '';
        if (doc.checklist_item_id) {
          const it = await db.query(`SELECT COALESCE(borrower_label,label) AS label FROM checklist_items WHERE id=$1`, [doc.checklist_item_id]);
          if (it.rows[0]) condLabel = it.rows[0].label;
        }
        const ctx = doc.application_id ? await notify.fileContext(doc.application_id) : null;
        await notify.notifyBorrower(doc.borrower_id, {
          type: 'doc_requested',
          title: condLabel ? `"${condLabel}" needs one more document` : 'One more document is needed',
          body: `"${doc.filename}" was accepted ✓${condLabel ? ` — but condition "${condLabel}" needs one more document` : ''}${moreNote ? `: ${moreNote}` : '.'}${ctx ? ` (${ctx.label})` : ''}`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: doc.application_id,
          link: doc.application_id ? `/app/${doc.application_id}` : '/profile',
          ctaLabel: 'Upload the document' });
      } catch (_) { /* best-effort */ }
    }

    // An LLC document verdict changes the entity's state everywhere: rejecting
    // a document of a VERIFIED LLC revokes the verification (its clean doc set
    // no longer stands), and every open file vesting in the entity gets its
    // LLC condition recomputed.
    if (doc.llc_id) {
      if (action === 'reject') {
        const wasVerified = await db.query(
          `UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now()
            WHERE id=$1 AND is_verified=true RETURNING id`, [doc.llc_id]);
        if (wasVerified.rows[0]) await audit(req, 'unverify_llc', 'llc', doc.llc_id, { cause: 'document_rejected', documentId: doc.id });
      }
      try { await llcLib.syncLlcConditions(doc.llc_id, { reopen: action === 'reject' }); } catch (_) { /* best-effort */ }
    }

    // A track-record line-item document verdict: rejecting a document that a
    // verified line item was verified against un-verifies that line item (its
    // evidence no longer stands) and recomputes the borrower's tier + experience
    // condition — mirroring the LLC behavior (#126 per-line-item reject).
    if (doc.track_record_id && action === 'reject') {
      const was = await db.query(
        `UPDATE track_records SET verification_status='docs', is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now()
          WHERE id=$1 AND is_verified=true RETURNING borrower_id`, [doc.track_record_id]);
      if (was.rows[0]) {
        await audit(req, 'unverify_track_record', 'track_record', doc.track_record_id, { cause: 'document_rejected', documentId: doc.id });
        await db.query(
          `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true AND (${RECENT_EXIT_SQL})) WHERE id=$1`,
          [was.rows[0].borrower_id]);
        try { await require('../lib/experience').syncExperienceChecklistForBorrower(was.rows[0].borrower_id); } catch (_) {}
        try { await conditionEngine.evaluateBorrowerApplications(was.rows[0].borrower_id, { actor: req.actor, reason: 'track_record_doc_rejected' }); } catch (_) {}
      }
    }

    // On rejection, tell the borrower what to fix. LLC documents live on the
    // borrower profile, not on a file — send the borrower there instead.
    if (action === 'reject' && doc.borrower_id) {
      try {
        let condLabel = '';
        if (doc.checklist_item_id) {
          const it = await db.query(`SELECT COALESCE(borrower_label,label) AS label FROM checklist_items WHERE id=$1`, [doc.checklist_item_id]);
          if (it.rows[0]) condLabel = it.rows[0].label;
        }
        const ctx = doc.application_id ? await notify.fileContext(doc.application_id) : null;
        await notify.notifyBorrower(doc.borrower_id, {
          type: 'doc_rejected', title: condLabel ? `"${condLabel}" needs a new document` : 'A document needs to be re-uploaded',
          body: `"${doc.filename}"${condLabel ? ` on condition "${condLabel}"` : ''}${ctx ? ` (${ctx.label})` : ''} couldn't be accepted: ${String(b.reason).slice(0, 180)}`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: doc.application_id,
          link: doc.application_id ? `/app/${doc.application_id}` : '/profile',
          ctaLabel: 'Upload a new version' });
      } catch (_) {}
    }
    res.json({ ok: true, review_status: status });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// The clean set of documents on a file: accepted + current only. Every export /
// package path should draw from here so a rejected/superseded doc is never
// included. Exported for reuse by the (future) TPR export builder.
async function getApprovedDocuments(applicationId) {
  // The clean file includes the vesting LLC's accepted documents — a verified
  // entity's formation docs / EIN letter / operating agreement travel with
  // every file the entity is linked to.
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,storage_provider,storage_ref,checklist_item_id,doc_kind,created_at
       FROM documents
      WHERE (application_id=$1
             OR (application_id IS NULL AND llc_id IS NOT NULL
                 AND llc_id=(SELECT llc_id FROM applications WHERE id=$1)))
        AND review_status='accepted' AND is_current=true
      ORDER BY created_at`, [applicationId]);
  return r.rows;
}
router.getApprovedDocuments = getApprovedDocuments;

// Can this staffer access a given document? seesAll -> yes. Otherwise they must
// be assigned to the document's application, or (for borrower/llc-scoped docs)
// to some application belonging to that borrower.
async function canSeeDocument(req, doc) {
  if (seesAll(req)) return true;
  if (doc.application_id) {
    // An application document is authorized SOLELY by assignment to its own
    // application — never fall through to the borrower's other files, or an
    // officer on App1 could reach App2 of the same borrower. (A shared-officer
    // grant still applies per-application via the visible_officer_ids expansion.)
    const r = await db.query(
      `SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL
          AND (loan_officer_id=$2 OR processor_id=$2
               OR loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2))`,
      [doc.application_id, req.actor.id]);
    return !!r.rows[0];
  }
  if (doc.borrower_id) {
    // Only borrower/llc-scoped documents (no application_id) use the
    // borrower-wide fallback.
    const r = await db.query(
      `SELECT 1 FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL
          AND (loan_officer_id=$2 OR processor_id=$2
               OR loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=$2))
        LIMIT 1`,
      [doc.borrower_id, req.actor.id]);
    if (r.rows[0]) return true;
  }
  return false;
}

router.get('/documents/:id/download', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id,filename,content_type,storage_ref,application_id,borrower_id,llc_id FROM documents WHERE id=$1`,
      [req.params.id]);
    const doc = r.rows[0];
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeDocument(req, doc))) return res.status(403).json({ error: 'forbidden' });
    await audit(req, 'download_document', 'document', doc.id);
    return serveDocument(res, doc, { inline: req.query.inline === '1' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- notifications ----------------
router.get('/notifications', async (req, res) => {
  const r = await db.query(
    `SELECT id,type,title,body,application_id,link,read_at,created_at FROM notifications
     WHERE staff_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.actor.id]);
  res.json(r.rows);
});
router.post('/notifications/:id/read', async (req, res) => {
  await db.query(`UPDATE notifications SET read_at=now() WHERE id=$1 AND staff_id=$2`, [req.params.id, req.actor.id]);
  res.json({ ok: true });
});

// Active staff roster — used to populate LO / processor assignment dropdowns.
router.get('/team', async (req, res) => {
  const r = await db.query(
    `SELECT id, full_name, email, role, title, department FROM staff_users
      WHERE is_active=true ORDER BY department NULLS LAST, sort_order, full_name`);
  res.json(r.rows);
});

// ---------------- VENDOR DIRECTORY (admin) ----------------
// Every title company / insurance agent contact entered anywhere on the
// platform, tagged by type. Admins curate it: enrich, correct, or delete bad
// entries — borrowers then autocomplete against the cleaned-up records.
const VENDOR_TYPES = ['title_company', 'insurance_agent', 'attorney', 'contractor', 'other'];
router.get('/vendors', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const type = VENDOR_TYPES.includes(req.query.type) ? req.query.type : null;
  const r = await db.query(
    `SELECT sc.id, sc.contact_type, sc.company_name, sc.contact_name, sc.email, sc.phone, sc.address,
            sc.notes, sc.created_at, sc.updated_at, sc.last_used_at,
            b.first_name || ' ' || b.last_name AS added_by_borrower,
            s.full_name AS added_by_staff,
            (SELECT count(*)::int FROM application_service_contacts x WHERE x.service_contact_id=sc.id) AS files_used
       FROM service_contacts sc
       LEFT JOIN borrowers b ON b.id=sc.borrower_id
       LEFT JOIN staff_users s ON s.id=sc.added_by_staff_id
      WHERE ($1::text IS NULL OR sc.contact_type=$1)
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [type]);
  res.json(r.rows);
});
router.post('/vendors', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const b = req.body || {};
  const type = VENDOR_TYPES.includes(b.contactType) ? b.contactType : 'other';
  if (!b.companyName && !b.contactName && !b.email && !b.phone)
    return res.status(400).json({ error: 'enter at least one contact detail' });
  const r = await db.query(
    `INSERT INTO service_contacts (contact_type,company_name,contact_name,email,phone,address,notes,added_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [type, b.companyName || null, b.contactName || null, b.email || null, b.phone || null,
     b.address || null, b.notes || null, req.actor.id]);
  await audit(req, 'add_vendor', 'service_contact', r.rows[0].id, { type });
  res.status(201).json({ ok: true, vendorId: r.rows[0].id });
});
router.patch('/vendors/:id', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const b = req.body || {};
  const map = { companyName: 'company_name', contactName: 'contact_name', email: 'email',
                phone: 'phone', address: 'address', notes: 'notes' };
  const sets = [], vals = []; let i = 1;
  for (const [k, col] of Object.entries(map))
    if (b[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
  if (b.contactType && VENDOR_TYPES.includes(b.contactType)) { sets.push(`contact_type=$${i++}`); vals.push(b.contactType); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  const r = await db.query(`UPDATE service_contacts SET ${sets.join(',')} WHERE id=$${i} RETURNING id`, vals);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'edit_vendor', 'service_contact', req.params.id);
  res.json({ ok: true });
});
router.delete('/vendors/:id', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const r = await db.query(`DELETE FROM service_contacts WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'delete_vendor', 'service_contact', req.params.id);
  res.json({ ok: true });
});

// ---------------- GENERAL FILE CONTACTS — staff side (#144) ----------------
// Any staff on the file can add any kind of vendor. The contact is tied to the
// file's borrower (so it shows on the borrower profile) AND flows into the
// company-wide vendor directory (service_contacts). Many contacts per file.
const FILE_CONTACT_TYPES = ['realtor', 'attorney', 'title_company', 'insurance_agent', 'flood_insurance', 'contractor', 'appraiser', 'lender', 'escrow', 'other'];
router.get('/applications/:id/file-contacts', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(
    `SELECT l.id AS link_id, sc.id AS contact_id, sc.contact_type, sc.custom_type,
            sc.company_name, sc.contact_name, sc.email, sc.phone, sc.address, sc.notes,
            l.added_by_kind, l.created_at,
            s.full_name AS added_by_staff, (b.first_name||' '||b.last_name) AS added_by_borrower
       FROM application_service_contacts l
       JOIN service_contacts sc ON sc.id = l.service_contact_id
       LEFT JOIN staff_users s ON s.id = l.added_by_id AND l.added_by_kind='staff'
       LEFT JOIN borrowers b ON b.id = l.added_by_id AND l.added_by_kind='borrower'
      WHERE l.application_id=$1
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [req.params.id]);
  res.json(r.rows);
});
router.post('/applications/:id/file-contacts', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  const type = FILE_CONTACT_TYPES.includes(b.contactType) ? b.contactType : 'other';
  const custom = type === 'other' ? (String(b.customType || '').trim().slice(0, 60) || null) : null;
  if (!b.companyName && !b.contactName && !b.email && !b.phone) return res.status(400).json({ error: 'enter at least one contact detail' });
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
  if (!app.rows[0]) return res.status(404).json({ error: 'not found' });
  const sc = await db.query(
    `INSERT INTO service_contacts (borrower_id,contact_type,custom_type,company_name,contact_name,email,phone,address,notes,added_by_staff_id,last_used_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()) RETURNING id`,
    [app.rows[0].borrower_id, type, custom, b.companyName || null, b.contactName || null, b.email || null, b.phone || null, b.address || null, b.notes || null, req.actor.id]);
  const link = await db.query(
    `INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type,added_by_kind,added_by_id)
     VALUES ($1,$2,$3,'staff',$4)
     ON CONFLICT (application_id,service_contact_id) DO UPDATE SET contact_type=EXCLUDED.contact_type RETURNING id`,
    [req.params.id, sc.rows[0].id, type, req.actor.id]);
  await audit(req, 'add_file_contact', 'application', req.params.id, { contactType: type });
  res.status(201).json({ ok: true, linkId: link.rows[0].id, contactId: sc.rows[0].id });
});
router.delete('/file-contacts/:linkId', async (req, res) => {
  const f = await db.query(`SELECT application_id FROM application_service_contacts WHERE id=$1`, [req.params.linkId]);
  if (!f.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canTouchApp(req, f.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`DELETE FROM application_service_contacts WHERE id=$1`, [req.params.linkId]);
  await audit(req, 'remove_file_contact', 'application', f.rows[0].application_id, {});
  res.json({ ok: true });
});
// A borrower's whole vendor list (profile) — every contact tied to the borrower.
router.get('/borrowers/:id/contacts', async (req, res) => {
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  const r = await db.query(
    `SELECT sc.id, sc.contact_type, sc.custom_type, sc.company_name, sc.contact_name, sc.email, sc.phone, sc.notes,
            count(l.application_id)::int AS files_used
       FROM service_contacts sc
       LEFT JOIN application_service_contacts l ON l.service_contact_id = sc.id
      WHERE sc.borrower_id=$1
      GROUP BY sc.id
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [req.params.id]);
  res.json(r.rows);
});

// ---------------- system-wide audit log (#145) -----------------------------
// The company-wide trail: every action across every file and borrower, in one
// searchable place, each row linked to the file / borrower / staffer involved.
// The DEEP per-file and per-borrower trails already exist
// (/applications/:id/activity, /borrowers/:id/activity); this is the global
// compliance view. Gated on the dedicated view_audit_log capability
// (admin/super_admin by default; grantable to a compliance underwriter).
const {
  describeAction: describeAuditAction, CATEGORIES: AUDIT_CATEGORIES,
  KNOWN_CODES: AUDIT_KNOWN_CODES, CATEGORY_CODES: AUDIT_CATEGORY_CODES, codesMatchingText: auditCodesMatchingText,
} = require('../lib/audit-actions');
const AUDIT_ACTOR_KINDS = new Set(['staff', 'borrower', 'system']);
const AUDIT_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.get('/audit-log', async (req, res) => {
  if (!can(req.actor, 'view_audit_log')) return res.status(403).json({ error: 'forbidden' });
  try {
    const q = String(req.query.q || '').trim();
    const action = String(req.query.action || '').trim();
    const category = String(req.query.category || '').trim();
    const actorKind = AUDIT_ACTOR_KINDS.has(String(req.query.actorKind || '')) ? String(req.query.actorKind) : '';
    // Validate typed params so a malformed value is IGNORED, never a 500 from a
    // failed ::uuid / ::date cast.
    const actorIdRaw = String(req.query.actorId || '').trim();
    const actorId = UUID_RE.test(actorIdRaw) ? actorIdRaw : '';
    const entityType = String(req.query.entityType || '').trim();
    const fromRaw = String(req.query.from || '').trim();
    const from = AUDIT_DATE_RE.test(fromRaw) ? fromRaw : '';
    const toRaw = String(req.query.to || '').trim();
    const to = AUDIT_DATE_RE.test(toRaw) ? toRaw : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 300);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const params = [];
    const where = [];
    const P = (v) => { params.push(v); return '$' + params.length; };

    if (action) where.push(`al.action = ${P(action)}`);
    // Category → the set of action codes in it (server-side, so pagination is
    // correct). 'other' = any code not in the known map.
    else if (category) {
      if (category === 'other') where.push(`al.action <> ALL(${P(AUDIT_KNOWN_CODES)}::text[])`);
      else where.push(`al.action = ANY(${P(AUDIT_CATEGORY_CODES[category] || [])}::text[])`);
    }
    if (actorKind) where.push(`al.actor_kind = ${P(actorKind)}`);
    if (actorId) where.push(`al.actor_id = ${P(actorId)}::uuid`);
    if (entityType) where.push(`al.entity_type = ${P(entityType)}`);
    if (from) where.push(`al.created_at >= ${P(from)}::date`);
    if (to) where.push(`al.created_at < (${P(to)}::date + 1)`); // inclusive of the whole "to" day
    if (q) {
      // Free-text across who did it (actor OR the file's loan officer), what
      // they did (action code AND human label), and which borrower / property.
      const like = P('%' + q + '%');
      const codes = P(auditCodesMatchingText(q)); // action codes whose label matches
      where.push(`(
        s.full_name ILIKE ${like} OR ab.first_name ILIKE ${like} OR ab.last_name ILIKE ${like}
        OR al.action ILIKE ${like} OR al.action = ANY(${codes}::text[])
        OR appb.first_name ILIKE ${like} OR appb.last_name ILIKE ${like}
        OR eb.first_name ILIKE ${like} OR eb.last_name ILIKE ${like}
        OR lo.full_name ILIKE ${like}
        OR app.property_address::text ILIKE ${like}
      )`);
    }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const lim = P(limit), off = P(offset);
    const sql = `
      SELECT al.id, al.created_at, al.action, al.actor_kind, al.actor_id,
             al.entity_type, al.entity_id, al.ip_address::text AS ip_address, al.detail,
             CASE WHEN al.actor_kind='staff' THEN s.full_name
                  WHEN al.actor_kind='borrower' THEN NULLIF(btrim(coalesce(ab.first_name,'')||' '||coalesce(ab.last_name,'')), '')
                  ELSE NULL END AS actor_name,
             s.role AS actor_role,
             app.id AS app_id,
             app.property_address AS app_address,
             appb.id AS app_borrower_id,
             NULLIF(btrim(coalesce(appb.first_name,'')||' '||coalesce(appb.last_name,'')), '') AS app_borrower_name,
             lo.id AS app_officer_id, lo.full_name AS app_officer_name,
             eb.id AS ent_borrower_id,
             NULLIF(btrim(coalesce(eb.first_name,'')||' '||coalesce(eb.last_name,'')), '') AS ent_borrower_name
        FROM audit_log al
        LEFT JOIN staff_users s ON al.actor_kind='staff' AND s.id = al.actor_id
        LEFT JOIN borrowers ab ON al.actor_kind='borrower' AND ab.id = al.actor_id
        LEFT JOIN applications app ON al.entity_type IN ('application','clickup') AND app.id = al.entity_id
        LEFT JOIN borrowers appb ON appb.id = app.borrower_id
        LEFT JOIN staff_users lo ON lo.id = app.loan_officer_id
        LEFT JOIN borrowers eb ON al.entity_type='borrower' AND eb.id = al.entity_id
        ${whereSql}
       ORDER BY al.created_at DESC, al.id DESC
       LIMIT ${lim} OFFSET ${off}`;
    const r = await db.query(sql, params);

    const rows = r.rows.map((row) => {
      const meta = describeAuditAction(row.action);
      let addr = row.app_address;
      if (typeof addr === 'string') { try { addr = JSON.parse(addr); } catch (_) { addr = null; } }
      const addressText = addr
        ? (addr.oneLine || [addr.line1 || addr.street, addr.city, addr.state].filter(Boolean).join(', ') || null)
        : null;
      return {
        id: String(row.id),
        at: row.created_at,
        action: row.action,
        action_label: meta.label,
        category: meta.cat,
        actor_kind: row.actor_kind,
        actor_id: row.actor_id,
        actor_name: row.actor_name || (row.actor_kind === 'system' ? 'System' : (row.actor_kind === 'borrower' ? 'A borrower' : 'A staff member')),
        actor_role: row.actor_role || null,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        ip_address: row.ip_address || null,
        detail: row.detail || null,
        // Linking context: which file / borrower / officer this touched.
        app_id: row.app_id || null,
        app_address: addressText,
        app_borrower_id: row.app_borrower_id || null,
        app_borrower_name: row.app_borrower_name || null,
        app_officer_id: row.app_officer_id || null,
        app_officer_name: row.app_officer_name || null,
        ent_borrower_id: row.ent_borrower_id || null,
        ent_borrower_name: row.ent_borrower_name || null,
      };
    });
    res.json({ rows, limit, offset, hasMore: rows.length === limit });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// Facets for the audit-log filters: the distinct actions actually present (with
// human labels + counts), the categories, and the staff roster for the actor
// picker. Cheap, cached lightly by the client.
router.get('/audit-log/facets', async (req, res) => {
  if (!can(req.actor, 'view_audit_log')) return res.status(403).json({ error: 'forbidden' });
  try {
    const [acts, staff] = await Promise.all([
      db.query(`SELECT action, count(*)::int AS n FROM audit_log GROUP BY action ORDER BY n DESC`),
      db.query(`SELECT id, full_name, role FROM staff_users WHERE is_active IS NOT FALSE ORDER BY full_name`),
    ]);
    const actions = acts.rows.map((a) => {
      const meta = describeAuditAction(a.action);
      return { action: a.action, label: meta.label, category: meta.cat, count: a.n };
    });
    res.json({ actions, categories: AUDIT_CATEGORIES, staff: staff.rows });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ---------------- chat v3: conversations, receipts, presence ----------------
// Mounted last so the /applications/:id scope guard above still covers the
// application-scoped chat routes (create chat / export).
router.use(require('./staff-chat'));

module.exports = router;
