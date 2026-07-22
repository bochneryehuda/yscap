/**
 * Staff API (loan officers, processors, underwriters, admins).
 * Officers see their assigned pipeline; admins see everything. They add
 * conditions + document requests, update checklist status, verify LLCs and
 * track records, and assign Lead-Capture (unassigned) applications.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const { scrubText, scrubTextExcept } = require('../lib/borrower-safe');
const email = require('../lib/email');                    // Email Center: send staff replies
const emailLog = require('../lib/email-log');             // Email Center: capture + on-demand body
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const { claimOncePerPeriod } = require('../lib/throttle-claim');
const changeRequests = require('../lib/change-requests');
const mail = require('../lib/email/catalog');
const { fileReplyTo } = require('../lib/file-address');   // #68 per-file shared reply-to
const { serveDocument } = require('../lib/serve-document');
const { decodeUploadBase64, safeFilename } = require('../lib/upload-bytes');
const cfg = require('../config');
const storage = require('../lib/storage');
const { requireAuth, requireRole, issueEmailToken } = require('../auth');
const pricing = require('../lib/pricing');
const { persistProductRegistration } = require('../lib/product-registration');
const manualProgram = require('../lib/manual-program');
const workflow = require('../lib/workflow');
const workflowAuto = require('../lib/workflow-automation');
const { syncExperienceChecklistForApplication, RECENT_EXIT_SQL, EXIT_DATE_SQL } = require('../lib/experience');
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
// draw_coordinator + closer are here so they can reach their OWN personal
// Workflow queue (/api/staff/workflow) and the files handed to them; every route
// still applies its own per-route capability / see_all_files / file-scope gate.
router.use(requireAuth, requireRole('admin', 'loan_officer', 'processor', 'underwriter', 'loan_coordinator', 'draw_coordinator', 'closer', 'software_setup'));
// Who sees every file vs. only their assigned ones — now a capability, so an
// admin can grant "see all files" to a coordinator without a code change.
const seesAll = (req) => can(req.actor, 'see_all_files');
// The borrower DIRECTORY / CRM has a WIDER audience than file-level see_all_files
// (owner-directed): admins, underwriters, loan_coordinators (seesAll) AND
// processors may open ANY borrower's full profile; loan_officers stay limited to
// borrowers they've done a loan for. File-level access (/applications/:id) is
// unchanged — a processor still opens individual files only where assigned.
const seesAllBorrowers = (req) => seesAll(req) || (req.actor && req.actor.role === 'processor');
// A file that is NOT actionable work: funded/closed (done), declined/withdrawn
// (dead), or ON HOLD (paused — owner-directed 2026-07-14). None of these should
// surface as active tasks, reminders, doc-prompts, or stale-file nags, or inflate
// the live-pipeline metrics — their open items stay INSIDE the file but fall off
// every "what's on my plate" surface. (Post-closing items are the sole exception
// on funded files; that carve-out is applied where it matters.) Kept as one SQL
// IN-list so every active-work query shares a single definition — extends the #24
// funded-muting to on_hold.
// file_intake (#151) is the pre-processing intake stage — a prospect in the
// system that is NOT an active file, so it sits with the other non-active
// statuses here and falls out of every KPI/task/exception view built on this.
const INACTIVE_FILE_STATUSES = "('funded','declined','withdrawn','on_hold','file_intake')";

// #145 — ONE definition per clickable dashboard figure, shared by the COUNT that
// renders the KPI/exception tile AND the drill-down FILTER the click applies, so a
// figure can NEVER show a number you can't reproduce by clicking into it. Before
// this, /dashboard, /exceptions and the /applications flag filter each spelled out
// their own predicates and drifted (the "stalled" count was >7 days while its
// drill-down filtered >5; "New this week" excluded clickup_backfill rows the
// drill-down still showed). All three now reference these fragments (alias `a`).
const ACTIVE_FILE_SQL = `a.status NOT IN ${INACTIVE_FILE_STATUSES}`;
const DASH_FILTER_SQL = {
  // file-level "exception" buckets (mirrors /exceptions, drill into the pipeline)
  unassigned: `a.loan_officer_id IS NULL AND ${ACTIVE_FILE_SQL}`,
  needs_correction: `${ACTIVE_FILE_SQL} AND EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.status='issue')`,
  awaiting_borrower: `${ACTIVE_FILE_SQL} AND EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both') AND ci.status IN ('outstanding','requested'))`,
  awaiting_review: `${ACTIVE_FILE_SQL} AND EXISTS(SELECT 1 FROM checklist_items ci WHERE ci.application_id=a.id AND ci.status='received')`,
  unread_messages: `EXISTS(SELECT 1 FROM messages m WHERE m.application_id=a.id AND m.channel='borrower' AND m.sender_kind='borrower' AND m.read_at IS NULL)`,
  open_conditions: `${ACTIVE_FILE_SQL} AND EXISTS(SELECT 1 FROM conditions c WHERE c.application_id=a.id AND c.status='open')`,
  post_closing_exceptions: `EXISTS(SELECT 1 FROM post_closing_items p WHERE p.application_id=a.id AND p.status='exception')`,
  // KPI-grid buckets
  stalled: `${ACTIVE_FILE_SQL} AND a.updated_at < now() - interval '7 days'`,
  // a genuinely NEW file is a real intake this week — NOT a clickup backfill row
  // (those default created_at=now() and would make the whole back-book look new).
  newintake: `a.created_at > now() - interval '7 days' AND COALESCE(a.source,'') <> 'clickup_backfill'`,
};

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
    `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL
        AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
    [appId, req.actor.id]);
  return !!r.rows[0];
}
const isAdmin = (req) => ['admin', 'super_admin'].includes(req.actor.role);
function intField(v) {
  const n = parseInt(v, 10);
  return isFinite(n) && n > 0 ? n : 0;
}

async function audit(req, action, entity_type, entity_id, detail) {
  // `detail` lands in a jsonb column. pg serializes a JS OBJECT to valid JSON, but
  // a bare scalar (string/number/bool) is handed to jsonb verbatim and rejected
  // ("invalid input syntax for type json"), which would turn an otherwise-successful
  // action into a failed request. Wrap any scalar so a logging write can never do that.
  let d = detail;
  if (d != null && typeof d !== 'object') d = { note: String(d) };
  // Best-effort: a logging write must NEVER fail an otherwise-completed action
  // (esp. after an irreversible DocuSign send/resend/void). Swallow + warn.
  try {
    await db.query(
      `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
       VALUES ('staff',$1,$2,$3,$4,$5,$6,$7)`,
      [req.actor.id, action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, d || null]);
  } catch (e) {
    console.warn(`[audit] failed to log ${action}: ${db.describeError ? db.describeError(e) : e.message}`);
  }
}
// officers/processors only see their files; admins/super-admins/underwriters see all.
// PLUS: a staffer may be granted access to specific loan officers' files (their
// visible_officer_ids). The uncorrelated subquery reads that list off the actor's
// staff row, so this stays a SINGLE-param ($SCOPE) clause — no caller changes.
// A staffer may reach a file when they are the primary LO/processor, OR are on
// the primary's visible_officer_ids delegation list, OR are an active assignee
// (primary OR full-access ASSISTANT — #64) via application_assignees. The
// assignee EXISTS also covers the primary (backfilled + trigger-synced), so this
// term is behavior-identical until assistants are actually added. Single-param
// ($p repeated) — no caller changes. Requires ${alias}.id to be selectable.
const VISIBLE_OFFICERS_SQL = (alias, p) =>
  `(${alias}.loan_officer_id=${p} OR ${alias}.processor_id=${p}` +
  ` OR ${alias}.loan_officer_id IN (SELECT unnest(visible_officer_ids) FROM staff_users WHERE id=${p})` +
  ` OR EXISTS (SELECT 1 FROM application_assignees aa` +
  ` WHERE aa.application_id=${alias}.id AND aa.staff_id=${p} AND aa.removed_at IS NULL)` +
  // The Workflow (owner-directed 2026-07-21): a person a file was SUBMITTED to
  // (an open/in-progress hand-off routed to them) can open + work it — e.g. an
  // exception sent to a processor/closer who isn't otherwise on the file. Access
  // ends when they send it back (status leaves open/in_progress).
  ` OR EXISTS (SELECT 1 FROM workflow_items wi` +
  ` WHERE wi.application_id=${alias}.id AND wi.to_staff_id=${p} AND wi.status IN ('open','in_progress')))`;
function scopeClause(req, alias = 'a') {
  if (seesAll(req)) return { where: '', params: [] };
  return { where: `AND ${VISIBLE_OFFICERS_SQL(alias, '$SCOPE')}`, params: [req.actor.id] };
}

// Guard every /applications/:id* route: a non-privileged staffer may only touch
// a file they are the loan officer or processor on. (Borrower :id routes live
// under /borrowers/:id and are unaffected by this path-scoped middleware.)
// #152 — export the CURRENT pipeline view to Excel. Registered BEFORE the
// /applications/:id scope middleware (── 'export' must never be read as a file
// id). Accepts the exact same filter params as GET /applications via the ONE
// shared builder (buildPipelineFilter), so the spreadsheet always matches the
// view on screen — that's the whole point (troubleshoot which files are/aren't
// in a view, send a view onward). Maximum information per file, NEVER SSN/DOB/
// card data, and no pricing internals (scalar registration columns only).
router.get('/applications/export', async (req, res) => {
  try {
    const f = buildPipelineFilter(req, req.query);
    if (f.error) return res.status(400).json({ error: f.error });
    const sql = `
      SELECT a.id, a.ys_loan_number, a.investor_loan_number, a.status, a.internal_status,
             a.program, a.loan_type, a.property_type, a.units, a.occupancy, a.channel, a.source,
             COALESCE(a.property_address->>'oneLine',
                      NULLIF(concat_ws(', ', a.property_address->>'line1', a.property_address->>'city',
                                       a.property_address->>'state', a.property_address->>'zip'), '')) AS address,
             a.property_address->>'city'  AS city,
             a.property_address->>'state' AS state,
             a.property_address->>'zip'   AS zip,
             b.first_name, b.last_name, b.email AS borrower_email, b.cell_phone AS borrower_phone,
             b.fico AS borrower_fico, b.tier AS borrower_tier,
             (cb.first_name || ' ' || cb.last_name) AS co_borrower_name, cb.email AS co_borrower_email,
             COALESCE(lo.full_name, a.loan_officer_name) AS loan_officer, pr.full_name AS processor,
             uw.full_name AS underwriter,
             a.purchase_price, a.as_is_value, a.arv, a.rehab_budget, a.loan_amount, a.ltv, a.rate_pct,
             a.term, a.requested_ir_months, a.requested_ir_amount,
             a.is_assignment, a.underlying_contract_price, a.assignment_fee, a.lender,
             reg.program AS registered_program, reg.product_label, reg.note_rate AS registered_rate,
             reg.total_loan AS registered_loan, reg.status AS registration_status, reg.created_at AS registered_at,
             a.created_at, a.clickup_created_at, a.submitted_at, a.status_changed_at,
             a.expected_closing, a.actual_closing, a.updated_at,
             (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id) AS total_items,
             (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id
                AND (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')) AS done_items,
             (SELECT count(*)::int FROM conditions c WHERE c.application_id=a.id AND c.status='open') AS open_conditions,
             a.clickup_pipeline_task_id, a.sync_state, a.clickup_last_synced_at
        FROM applications a
        JOIN borrowers b ON b.id = a.borrower_id
        LEFT JOIN borrowers cb ON cb.id = a.co_borrower_id
        LEFT JOIN staff_users lo ON lo.id = a.loan_officer_id
        LEFT JOIN staff_users pr ON pr.id = a.processor_id
        LEFT JOIN staff_users uw ON uw.id = a.underwriter_id
        LEFT JOIN LATERAL (
          SELECT r.program, r.product_label, r.note_rate, r.total_loan, r.status, r.created_at
            FROM product_registrations r WHERE r.application_id = a.id AND r.is_current LIMIT 1
        ) reg ON true
       WHERE ${f.where.join(' AND ')} ORDER BY ${f.orderBy}
       LIMIT 20000`;
    const r = await db.query(sql, f.params);

    const day = (v) => (v == null ? '' : String(v).slice(0, 10));
    const ts = (v) => { if (v == null) return ''; try { return new Date(v).toISOString().replace('T', ' ').slice(0, 16); } catch (_) { return String(v); } };
    const num = (v) => (v == null || v === '' ? '' : Number(v));
    const yn = (v) => (v === true ? 'yes' : v === false ? 'no' : '');
    const HEADERS = [
      'YS loan #', 'Investor loan #', 'Status', 'ClickUp status', 'Program', 'Loan type', 'Property type', 'Units',
      'Occupancy', 'Channel', 'Source', 'Address', 'City', 'State', 'Zip',
      'Borrower first name', 'Borrower last name', 'Borrower email', 'Borrower phone', 'Borrower FICO', 'Tier',
      'Co-borrower', 'Co-borrower email', 'Loan officer', 'Processor', 'Underwriter',
      'Purchase price', 'As-is value', 'ARV', 'Rehab budget', 'Loan amount', 'LTV %', 'Rate %', 'Term',
      'IR months', 'IR amount', 'Assignment?', 'Underlying contract', 'Assignment fee', 'Note buyer',
      'Registered program', 'Registered product', 'Registered rate', 'Registered loan', 'Registration status', 'Registered at',
      'Created', 'ClickUp created', 'Submitted', 'Status changed', 'Expected closing', 'Actual closing', 'Updated',
      'Checklist items', 'Checklist done', 'Open conditions', 'ClickUp task ID', 'Sync state', 'Last synced', 'File ID',
    ];
    const rows = r.rows.map((x) => [
      x.ys_loan_number || '', x.investor_loan_number || '', STATUS_LABEL[x.status] || x.status || '', x.internal_status || '',
      x.program || '', x.loan_type || '', x.property_type || '', num(x.units), x.occupancy || '', x.channel || '', x.source || '',
      x.address || '', x.city || '', x.state || '', x.zip || '',
      x.first_name || '', x.last_name || '', x.borrower_email || '', x.borrower_phone || '', num(x.borrower_fico), x.borrower_tier || '',
      x.co_borrower_name || '', x.co_borrower_email || '', x.loan_officer || '', x.processor || '', x.underwriter || '',
      num(x.purchase_price), num(x.as_is_value), num(x.arv), num(x.rehab_budget), num(x.loan_amount), num(x.ltv), num(x.rate_pct), x.term || '',
      num(x.requested_ir_months), num(x.requested_ir_amount), yn(x.is_assignment), num(x.underlying_contract_price), num(x.assignment_fee), x.lender || '',
      x.registered_program || '', x.product_label || '', num(x.registered_rate), num(x.registered_loan), x.registration_status || '', ts(x.registered_at),
      ts(x.created_at), ts(x.clickup_created_at), ts(x.submitted_at), ts(x.status_changed_at),
      day(x.expected_closing), day(x.actual_closing), ts(x.updated_at),
      num(x.total_items), num(x.done_items), num(x.open_conditions), x.clickup_pipeline_task_id || '', x.sync_state || '', ts(x.clickup_last_synced_at), x.id,
    ]);
    const { buildXlsx } = require('../lib/tpr-export');
    const buf = buildXlsx([HEADERS, ...rows], 'Pipeline');
    const pick = {};
    for (const k of ['group', 'status', 'flag', 'q', 'officerId', 'processorId', 'program', 'loanType', 'minAmount', 'maxAmount', 'fundedFrom', 'fundedTo', 'createdFrom', 'createdTo', 'mine', 'sort']) {
      if (req.query[k] !== undefined && req.query[k] !== '') pick[k] = String(req.query[k]).slice(0, 80);
    }
    await audit(req, 'export_pipeline', 'application', null, { rows: r.rows.length, filters: pick });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="pilot-pipeline-${new Date().toISOString().slice(0, 10)}.xlsx"`);
    res.send(buf);
  } catch (e) { console.error('[export pipeline]', e && e.message); res.status(500).json({ error: 'server error' }); }
});

router.use('/applications/:id', async (req, res, next) => {
  try {
    if (seesAll(req)) return next();
    // A soft-deleted file is inaccessible to non-privileged staff (admins can
    // still reach it to restore); this blocks open/mutate-by-direct-link.
    const r = await db.query(
      `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL
          AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
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
  // Scoped user: their full book (incl. files they're an assistant on, #64).
  if (!seesAll(req)) return { where: `AND ${VISIBLE_OFFICERS_SQL('a', '$1')}`, params: [req.actor.id] };
  // seesAll user narrowing to "my files": include assistant assignments so the
  // dashboard numbers match the (assistant-inclusive) pipeline list.
  if (mine) return { where: `AND (a.loan_officer_id=$1 OR a.processor_id=$1 OR EXISTS (SELECT 1 FROM application_assignees aa WHERE aa.application_id=a.id AND aa.staff_id=$1 AND aa.removed_at IS NULL))`, params: [req.actor.id] };
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
    const ACTIVE_SQL = `status NOT IN ${INACTIVE_FILE_STATUSES}`;
    const CANCELLED_SQL = `status IN ('declined','withdrawn')`;
    // A genuinely NEW file is a real portal/staff intake this week — NOT a row the
    // ClickUp backfill just inserted (those default created_at=now() and would make
    // the whole back-book look "new"). Exclude backfilled origin. #145: the exact
    // same predicate the "New this week" KPI drill-down applies (flag=newintake).
    const NEW_SQL = DASH_FILTER_SQL.newintake;
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
                       -- #151: pre-processing intake prospects — in the system, NOT
                       -- active. Their own KPI, never inside pipeline_value/active.
                       count(*) FILTER (WHERE status='file_intake')::int intake,
                       -- Ops/AI signal: active files gone stale (untouched > 7 days) — the
                       -- files silently stalling in the pipeline that need a nudge. #145:
                       -- the exact predicate the "Needs attention" drill-down uses (flag=stalled).
                       count(*) FILTER (WHERE ${DASH_FILTER_SQL.stalled})::int stalled,
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
      cancelled: t.cancelled, activelyProcessing: t.actively_processing, onHold: t.on_hold, intake: t.intake, stalled: t.stalled,
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
// #152 — ONE filter/sort builder shared by the pipeline LIST and the pipeline
// EXPORT, so the exported spreadsheet can never drift from the view on screen.
// Returns { error } (→ 400) or { where, params, add, orderBy }.
function buildPipelineFilter(req, q) {
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
      where.push(`a.status NOT IN ${INACTIVE_FILE_STATUSES}`);
    } else if (q.group === 'cancelled') {
      where.push(`a.status IN ('declined','withdrawn')`);
    } else if (q.group === 'closed') {
      where.push(`a.status = 'funded'`);
    } else if (q.group === 'on_hold') {
      // Held files no longer live in the 'active' bucket (they're paused, not
      // being worked), so give them their own reachable bucket.
      where.push(`a.status = 'on_hold'`);
    } else if (q.group === 'intake') {
      // #151 — the pre-processing intake prospects (ClickUp 'starting' /
      // 'Prospect / Pricing'): in the system, but not active files.
      where.push(`a.status = 'file_intake'`);
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
      if (!UUID_RE.test(String(q.officerId))) return { error: 'invalid officerId' };
      where.push(`a.loan_officer_id = ${add(String(q.officerId))}`);
    }
    if (q.processorId) {
      if (!UUID_RE.test(String(q.processorId))) return { error: 'invalid processorId' };
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
      if (!DATE_RE.test(String(v))) return { error: `invalid ${key}` };
      where.push(`${col} ${op} ${add(String(v))}`);
    }

    // Ops flags — every flag mirrors EXACTLY the dashboard/exception COUNT of the
    // same name via the single shared definition (DASH_FILTER_SQL), so clicking a
    // KPI or exception tile drills into precisely the files it counted (#145).
    // Covers stalled, newintake, unassigned, needs_correction, awaiting_borrower,
    // awaiting_review, unread_messages, open_conditions, post_closing_exceptions.
    // `nodate` is the K1 dateless-funded bucket used by the production block.
    if (q.flag && Object.prototype.hasOwnProperty.call(DASH_FILTER_SQL, q.flag)) {
      where.push(DASH_FILTER_SQL[q.flag]);
    } else if (q.flag === 'nodate') {
      where.push(`a.status = 'funded' AND a.actual_closing IS NULL`);
    }

    // "My files only" — the same lens the UI's ?mine=1 checkbox applies as a
    // client-side post-filter (LO OR processor of the file). Exposed as a
    // server param so the EXPORT mirrors the checkbox exactly (#152).
    if (q.mine === '1' && req.actor && req.actor.id) {
      const p = add(req.actor.id);
      where.push(`(a.loan_officer_id = ${p} OR a.processor_id = ${p})`);
    }

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
    return { where, params, add, orderBy };
}

router.get('/applications', async (req, res) => {
  try {
    const q = req.query;
    const f = buildPipelineFilter(req, q);
    if (f.error) return res.status(400).json({ error: f.error });
    const { where, params, add, orderBy } = f;

    let limit = parseInt(q.limit, 10);
    if (!Number.isFinite(limit)) limit = 500;
    limit = Math.min(1000, Math.max(1, limit));
    let offset = parseInt(q.offset, 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;

    const sql = `SELECT a.id,a.ys_loan_number,a.program,a.loan_type,a.status,a.internal_status,a.sync_state,
                        a.clickup_pipeline_task_id,a.property_address,a.lender,
                        a.loan_amount,a.loan_officer_id,a.loan_officer_name,a.processor_id,a.created_at,a.actual_closing,
                        b.first_name,b.last_name,b.email,
                        (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id) AS total_items,
                        (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id
                           AND (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')) AS done_items,
                        (SELECT count(*)::int FROM ai_suggestions s
                           WHERE s.application_id=a.id AND s.severity='fatal'
                             AND s.status IN ('open','marked_important','escalated','asked_admin')) AS open_fatal_ai,
                        (SELECT EXTRACT(EPOCH FROM (now() - MIN(s.created_at)))/86400 FROM ai_suggestions s
                           WHERE s.application_id=a.id AND s.severity='fatal'
                             AND s.status IN ('open','marked_important','escalated','asked_admin')) AS open_fatal_ai_oldest_days,
                        LEAST(100, COALESCE((SELECT
                            SUM(CASE severity WHEN 'fatal' THEN 25 WHEN 'warning' THEN 8 WHEN 'info' THEN 2 ELSE 4 END)::int
                          FROM ai_suggestions s
                          WHERE s.application_id=a.id
                            AND s.status IN ('open','marked_important','escalated','asked_admin')),0)) AS ai_risk_score
                 FROM applications a JOIN borrowers b ON b.id=a.borrower_id
                 WHERE ${where.join(' AND ')} ORDER BY ${orderBy}
                 LIMIT ${add(limit)} OFFSET ${add(offset)}`;
    const r = await db.query(sql, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Unified global search for the top-bar omnibox — loans, borrowers, and LLCs in
// ONE call so the header search actually returns results (it used to be a dead
// aria-hidden placeholder). Every value is bound as %q% (never interpolated);
// authorization mirrors the rest of the staff API: seesAll staff match
// everything, everyone else is scoped to files they run (loans) / borrowers on
// those files (borrowers + their LLCs). Returns at most 6 of each so the
// dropdown stays snappy.
router.get('/search', async (req, res) => {
  try {
    const raw = String(req.query.q || '').trim();
    if (raw.length < 2) return res.json({ loans: [], borrowers: [], llcs: [], trackRecords: [], officers: [], tasks: [], chats: [] });
    const like = '%' + raw.slice(0, 80) + '%';
    const meId = req.actor && req.actor.id;

    // ---- loans (applications) ----
    // Scope matches the pipeline list exactly (incl. visible_officer_ids
    // delegation) so a file an officer can open is also findable here.
    const loanParams = [like];
    let loanScope = '';
    if (!seesAll(req)) { loanParams.push(meId); loanScope = 'AND ' + VISIBLE_OFFICERS_SQL('a', '$2'); }
    const loans = await db.query(
      `SELECT a.id, a.ys_loan_number, a.status, a.program, a.loan_amount, a.property_address,
              b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id
        WHERE a.deleted_at IS NULL ${loanScope}
          AND ((b.first_name||' '||b.last_name) ILIKE $1
               OR a.ys_loan_number ILIKE $1
               OR COALESCE(a.property_address->>'oneLine','') ILIKE $1)
        ORDER BY a.created_at DESC LIMIT 6`, loanParams);

    // ---- borrowers ----
    const bParams = [like];
    let bScope = '';
    if (!seesAllBorrowers(req)) {
      bParams.push(meId);
      bScope = `AND EXISTS (SELECT 1 FROM applications a WHERE a.borrower_id=b.id
                              AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')})`;
    }
    const borrowers = await db.query(
      `SELECT b.id, b.first_name, b.last_name, b.email, b.cell_phone
         FROM borrowers b
        WHERE (b.first_name ILIKE $1 OR b.last_name ILIKE $1
               OR (b.first_name||' '||b.last_name) ILIKE $1
               OR COALESCE(b.email,'') ILIKE $1)
          ${bScope}
        ORDER BY b.last_name, b.first_name LIMIT 6`, bParams);

    // ---- LLCs (scoped through their owning borrower) ----
    const lParams = [like];
    let lScope = '';
    if (!seesAllBorrowers(req)) {
      lParams.push(meId);
      lScope = `AND EXISTS (SELECT 1 FROM applications a WHERE a.borrower_id=l.borrower_id
                              AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')})`;
    }
    const llcs = await db.query(
      `SELECT l.id, l.llc_name, l.ein, l.borrower_id, b.first_name, b.last_name
         FROM llcs l JOIN borrowers b ON b.id=l.borrower_id
        WHERE (l.llc_name ILIKE $1 OR COALESCE(l.ein,'') ILIKE $1)
          ${lScope}
        ORDER BY l.llc_name LIMIT 6`, lParams);

    // ---- track records (REO — the borrower's prior projects, by address) ----
    // Scoped through the owning borrower exactly like LLCs.
    const trParams = [like];
    let trScope = '';
    if (!seesAllBorrowers(req)) {
      trParams.push(meId);
      trScope = `AND EXISTS (SELECT 1 FROM applications a WHERE a.borrower_id=t.borrower_id
                               AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')})`;
    }
    const trackRecords = await db.query(
      `SELECT t.id, t.borrower_id, t.property_address, t.deal_type, b.first_name, b.last_name
         FROM track_records t JOIN borrowers b ON b.id=t.borrower_id
        WHERE COALESCE(t.property_address->>'oneLine','') ILIKE $1 ${trScope}
        ORDER BY t.created_at DESC LIMIT 6`, trParams);

    // ---- officers / team (the roster is visible to all staff) ----
    const officers = await db.query(
      `SELECT id, full_name, title, role, email FROM staff_users
        WHERE is_active=true AND (full_name ILIKE $1 OR COALESCE(email,'') ILIKE $1 OR COALESCE(title,'') ILIKE $1)
        ORDER BY sort_order NULLS LAST, full_name LIMIT 6`, [like]);

    // ---- tasks / reminders (title), scoped to files the staffer can reach ----
    const tkParams = [like];
    let tkScope = '';
    if (!seesAll(req)) { tkParams.push(meId); tkScope = 'AND ' + VISIBLE_OFFICERS_SQL('a', '$2'); }
    const tasks = await db.query(
      `SELECT r.id, r.title, r.kind, r.status, r.application_id, b.first_name, b.last_name,
              a.property_address
         FROM reminders r JOIN applications a ON a.id=r.application_id
         JOIN borrowers b ON b.id=a.borrower_id
        WHERE a.deleted_at IS NULL AND r.title ILIKE $1 ${tkScope}
        ORDER BY r.due_at DESC NULLS LAST LIMIT 6`, tkParams);

    // ---- chats (conversation name), scoped to files the staffer can reach ----
    const cvParams = [like];
    let cvScope = '';
    if (!seesAll(req)) { cvParams.push(meId); cvScope = 'AND ' + VISIBLE_OFFICERS_SQL('a', '$2'); }
    const chats = await db.query(
      `SELECT c.id, c.name, c.application_id, b.first_name, b.last_name
         FROM conversations c JOIN applications a ON a.id=c.application_id
         JOIN borrowers b ON b.id=a.borrower_id
        WHERE a.deleted_at IS NULL AND c.archived_at IS NULL AND c.name ILIKE $1 ${cvScope}
        ORDER BY c.created_at DESC LIMIT 6`, cvParams);

    res.json({
      loans: loans.rows, borrowers: borrowers.rows, llcs: llcs.rows,
      trackRecords: trackRecords.rows, officers: officers.rows,
      tasks: tasks.rows, chats: chats.rows,
    });
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
    // #145 — each count uses the SAME predicate its drill-down filter applies
    // (DASH_FILTER_SQL), so clicking a tile shows exactly the files it counted.
    // Funded/terminal files stay quiet in every outside-the-file rollup
    // (owner-directed 2026-07-14); their conditions remain inside the file.
    const r = await db.query(
      `SELECT
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.unassigned})::int AS unassigned,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.needs_correction})::int AS needs_correction,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.awaiting_borrower})::int AS awaiting_borrower,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.awaiting_review})::int AS awaiting_review,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.unread_messages})::int AS unread_messages,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.open_conditions})::int AS open_conditions,
         count(*) FILTER (WHERE ${DASH_FILTER_SQL.post_closing_exceptions})::int AS post_closing_exceptions
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
            -- #142: the completion state so the task list can offer the SAME inline
            -- Done / Sign off / Waive actions the file's condition list does.
            ci.reviewed_at, ci.signed_off_at, ci.waived_at, ci.is_required, ci.audience,
            su2.full_name AS reviewed_by_name,
            (ci.assignee_staff_id=$1) AS assigned_to_me,
            (SELECT count(*)::int FROM messages m WHERE m.application_id=a.id
               AND m.channel='borrower' AND m.sender_kind='borrower' AND m.read_at IS NULL) AS unread
       FROM checklist_items ci
       JOIN applications a ON a.id=ci.application_id
       JOIN borrowers b ON b.id=a.borrower_id
       LEFT JOIN staff_users su2 ON su2.id=ci.reviewed_by
      WHERE a.deleted_at IS NULL
        AND ci.status NOT IN ('satisfied')
        -- FUNDED/terminal/ON-HOLD files stay quiet OUTSIDE the file (owner-
        -- directed 2026-07-14): their open conditions remain visible INSIDE the
        -- file, but they never populate the task list again. Post-closing items
        -- are the one exception — they stay live even after funding.
        AND (a.status NOT IN ${INACTIVE_FILE_STATUSES}
             OR ci.phase = 'post_closing' OR ci.category = 'post_closing')
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

// SAME-EMAIL, DIFFERENT-PERSON guard (owner incident 2026-07-15 night): every
// staff path that match-or-creates a borrower by email must first check that
// the existing row's NAME belongs to the same person. A family-shared email
// silently adopted a loan officer's LEAD as the borrower of a different
// person's file — merging two people into one profile and handing the file
// (via owning-officer stickiness) to the wrong loan officer. When the names
// materially disagree, the write is REFUSED with an explicit 409 so the
// staffer decides — open the existing profile if it truly is the same person,
// or use a different email for the new one. Never a silent merge.
async function emailAdoptionConflict(email, firstName, lastName) {
  if (!email) return null;
  const identity = require('../clickup/identity');
  const r = await db.query(
    `SELECT id, first_name, last_name FROM borrowers WHERE email=$1 LIMIT 1`,
    [String(email).toLowerCase().trim()]);
  const ex = r.rows[0];
  if (!ex) return null;
  if (!identity.nameConflict(firstName, lastName, ex.first_name, ex.last_name)) return null;
  return ex;
}
function emailAdoptionError(res, ex, email) {
  const who = [ex.first_name, ex.last_name].filter(Boolean).join(' ') || 'another person';
  return res.status(409).json({
    error: `The email ${email} already belongs to ${who} — a different name. ` +
      `If this really is the same person, open their existing profile and start the file from there; ` +
      `otherwise use a different email for this borrower. Two people are never merged on a shared email.`,
    existingBorrowerId: ex.id, existingName: who,
  });
}

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
    // Same email + a DIFFERENT person's name → refuse the silent merge (409).
    const exConflict = await emailAdoptionConflict(email, firstName, lastName);
    if (exConflict) return emailAdoptionError(res, exConflict, email);
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
    // Self-assign default (owner-directed 2026-07-20): the staffer OPENING the
    // file is put on it automatically — they never have to pick, and it never
    // falls to Lead Capture — as long as they hold an officer-eligible role
    // (loan_officer / admin / super_admin; those are exactly the roles the
    // new-file officer dropdown offers). A processor/underwriter creator is not a
    // valid LO, so they fall through to borrower stickiness / Lead Capture. An
    // explicit pick above still wins (an admin opening on behalf of an LO just
    // picks them).
    if (!officerId && ['loan_officer', 'admin', 'super_admin'].includes(req.actor.role)) {
      const meRow = await db.query(`SELECT id,full_name FROM staff_users WHERE id=$1 AND is_active=true`, [req.actor.id]);
      if (meRow.rows[0]) { officerId = meRow.rows[0].id; officerName = meRow.rows[0].full_name; }
    }
    // #98 LO stickiness: an admin/processor creating a file for an EXISTING
    // borrower who already has an owning officer inherits that officer rather
    // than falling to Lead Capture. An explicit pick and the creating-LO default
    // both still win — this only fills a remaining blank.
    if (!officerId && borrowerId) {
      // Only inherit an ACTIVE owning officer (mirrors the borrower path) — a
      // deactivated officer must never silently receive new files.
      const own = await db.query(
        `SELECT s.id, s.full_name FROM borrowers b
           JOIN staff_users s ON s.id=b.primary_officer_id AND s.is_active=true
          WHERE b.id=$1`, [borrowerId]);
      if (own.rows[0]) { officerId = own.rows[0].id; officerName = own.rows[0].full_name; }
    }
    let processorId = null;
    if (b.processorId) {
      const p = await db.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true AND role='processor'`, [b.processorId]);
      if (p.rows[0]) processorId = p.rows[0].id;
    }
    // NO automatic processor assignment (owner-directed 2026-07-14): a file's
    // processor is set ONLY by an explicit pick (the dropdown above) or by the
    // ClickUp Processor Email field mirroring in (the sync stays bidirectional).
    // The old "a processor who opens a file is assigned to it" default is exactly
    // how Lisa Katz (role processor, but the DRAW coordinator) ended up
    // auto-assigned on a file she merely created — that must never happen. This
    // create path never sets a default processor; assignment is explicit only.

    // Assignment purchases: capture the underlying price + fee (like the
    // borrower path) so leverage/pricing size off seller price + fee and the
    // assignment doc is generated.
    // The TICKED flag is the truth (root fix 2026-07-14): requiring the
    // underlying price too silently stored is_assignment=false when staff
    // ticked assignment without typing the price yet — so the assignment
    // condition never generated. The price is its own field, filled when known.
    // Shared with the borrower create paths (#96) so the assignment invariant
    // has ONE definition and can never drift between staff and borrower surfaces.
    const { isAssignment, underlying, assignFee, purchasePrice } =
      require('../lib/fields').assignmentFields(b);
    // sqft only applies to a square-footage / ground-up rehab — null it otherwise
    // so a stale value can't force the pricing sqftAddition flag.
    const sqf = require('../lib/fields').sqftForType(b.rehabType, intField(b.sqftPre) || null, intField(b.sqftPost) || null);

    const ins = await db.query(
      `INSERT INTO applications
         (borrower_id,property_address,property_type,units,program,loan_type,
          purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
          rehab_type,sqft_pre,sqft_post,requested_exp_flips,requested_exp_holds,requested_exp_ground,
          processor_id,is_assignment,underlying_contract_price,assignment_fee,requested_exp_reo,source,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,'staff','new',now())
       RETURNING id,ys_loan_number`,
      [borrowerId, JSON.stringify(addr), b.propertyType || null, b.units || null,
       b.program || null, require('../lib/fields').sanitizeLoanType(b.loanType), purchasePrice, b.asIsValue || null,   // #95: never a program
       b.arv || null, b.rehabBudget || null, officerId, officerName,
       b.rehabType || null, sqf.sqftPre, sqf.sqftPost,
       intField(b.requestedExpFlips), intField(b.requestedExpHolds), intField(b.requestedExpGround),
       processorId, isAssignment, underlying, assignFee, intField(b.requestedExpReo)]);   // #97: General REO slot
    const appId = ins.rows[0].id;

    try { await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'staff_create' }); }
    catch (e) {
      // NEVER silent (root fix 2026-07-14): a staff file with no checklist was
      // a 201 + a console line nobody saw. It still must not fail the create,
      // but it now leaves an audit trail; the db/095 boot reconciler + the
      // zero-item health tripwire catch anything that slips through.
      console.error('[staff-origination] checklist failed:', db.describeError(e));
      try { await audit(req, 'conditions_generation_failed', 'application', appId, { error: String(e.message || e).slice(0, 300) }); } catch (_) {}
    }
    // Vesting entity (owner-directed 2026-07-20): persist which LLC the property is
    // purchased under, straight from the new-file form. A picked llcId owned by
    // this borrower wins; otherwise a typed entity name is resolved-or-created on
    // the borrower. All wiring (llc_id + LLC doc checklist + condition + re-eval)
    // goes through the vesting chokepoint — never a raw UPDATE. Best-effort: a
    // vesting hiccup never fails the already-created file.
    try {
      let vestLlcId = null;
      if (b.llcId) {
        const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, borrowerId]);
        if (o.rows[0]) vestLlcId = b.llcId;
      }
      if (!vestLlcId && b.entityName && String(b.entityName).trim()) {
        const nm = String(b.entityName).trim();
        const ex = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2) LIMIT 1`, [borrowerId, nm]);
        vestLlcId = ex.rows[0] ? ex.rows[0].id
          : (await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, nm])).rows[0].id;
      }
      if (vestLlcId) await require('../lib/vesting').setVestingLlc(appId, vestLlcId, { source: 'staff', actor: req.actor.id });
    } catch (e) { console.error('[staff-origination] vesting failed:', db.describeError(e)); }
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
        `SELECT 1 FROM applications a WHERE a.borrower_id=$1 AND a.id<>$3 AND ${VISIBLE_OFFICERS_SQL('a', '$2')} LIMIT 1`,
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  // #150 — LO branding: the invite arrives FROM the inviting officer (display
  // name) and carries their full contact block, so the client knows exactly
  // who is inviting them — not just "the company."
  const inviter = await db.query(`SELECT full_name, title, email, phone, cell, nmls FROM staff_users WHERE id=$1`, [req.actor.id]);
  const inv = inviter.rows[0] || {};
  await mail.send('borrowerInvite', email, {
    firstName,
    propertyLabel: meta.rows[0]?.addr || 'your loan',
    loanNumber: meta.rows[0]?.ys_loan_number || null,
    inviter: inv.full_name || null,
    officer: inv.full_name ? { name: inv.full_name, title: inv.title, email: inv.email, phone: inv.cell || inv.phone, nmls: inv.nmls } : null,
    acceptUrl, hasAccount: !!hasAuth.rows[0],
  }, { replyTo: fileReplyTo(appId), from: require('../lib/email').fromWithName(inv.full_name) });   // #68 reply reaches the team; #150 From = the officer
  await audit(req, 'invite_borrower', 'application', appId, { email });
  // Best-effort in-app notice to the file's team.
  return { emailed: true, hasAccount: !!hasAuth.rows[0], inviteToken: token };
}

// #102: invite ANY email to the portal — no file required. The person becomes a
// borrower profile AUTO-ASSIGNED to the inviting loan officer (owning officer of
// record, #98), the portal invite email goes out, and a CRM lead is opened for the
// inviting officer so the relationship is tracked from first touch (officer + lead
// CRM). Any active staffer may invite; only a seesAll admin may assign the owning
// officer to someone other than themselves.
router.post('/invite-to-portal', async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'a valid email is required' });
  const first = String(b.firstName || '').trim();
  const last = String(b.lastName || '').trim();
  const phone = String(b.phone || '').trim() || null;
  // Owning officer = the inviting staffer, unless an admin explicitly assigns another
  // active loan officer / processor.
  let officerId = req.actor.id;
  if (b.officerId && seesAll(req)) {
    // Validate the UUID up front: a hand-crafted non-UUID officerId would otherwise
    // reach Postgres as a bad uuid literal (22P02) and surface as a 500 — return a
    // clean 400 instead. (Not reachable from the UI, which only emits staff UUIDs.)
    if (!UUID_RE.test(String(b.officerId))) return res.status(400).json({ error: 'invalid officerId' });
    const o = await db.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true`, [b.officerId]);
    if (o.rows[0]) officerId = o.rows[0].id;
  }
  try {
    // Same email + a DIFFERENT person's name → refuse the silent merge (409).
    // (Inviting "Chaim Mendelovits" on an email that belongs to "Noach
    // Mendelovits" must not overlay one person's lead on the other's profile.)
    const exConflict = await emailAdoptionConflict(email, first, last);
    if (exConflict) return emailAdoptionError(res, exConflict, email);
    // 1) upsert the borrower profile by email; set the owning officer only when the
    // borrower doesn't already have one (never steal an existing relationship).
    const bor = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,primary_officer_id)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET
         first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown')
                          AND lower(btrim(EXCLUDED.first_name)) NOT IN ('','unknown')
                         THEN EXCLUDED.first_name ELSE borrowers.first_name END,
         last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','')
                         AND lower(btrim(EXCLUDED.last_name)) NOT IN ('','unknown')
                        THEN EXCLUDED.last_name ELSE borrowers.last_name END,
         cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
         primary_officer_id=COALESCE(borrowers.primary_officer_id,EXCLUDED.primary_officer_id),
         updated_at=now()
       RETURNING id, (xmax=0) AS created, primary_officer_id`,
      [first || 'Unknown', last || '', email, phone, officerId]);
    const borrowerId = bor.rows[0].id;
    // 2) portal invite — existing login → /login, else a fresh 14-day accept token.
    const hasAuth = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [borrowerId]);
    let token = null, acceptUrl;
    if (hasAuth.rows[0]) acceptUrl = mail.link('/login');
    else {
      token = C.randomToken(24);
      await db.query(`INSERT INTO invite_tokens (token_hash,kind,email,created_by,expires_at)
                      VALUES ($1,'borrower',$2,$3, now() + interval '14 days')`, [C.sha256(token), email, req.actor.id]);
      acceptUrl = mail.link('/accept?token=' + token);
    }
    // #150 — the "Invite to PILOT" email comes FROM the inviting officer, with
    // their contact block, and replies go straight to them.
    const inviter = await db.query(`SELECT full_name, title, email, phone, cell, nmls FROM staff_users WHERE id=$1`, [req.actor.id]);
    const inv = inviter.rows[0] || {};
    try {
      await mail.send('borrowerInvite', email, {
        firstName: first,
        propertyLabel: 'the YS Capital borrower portal',
        loanNumber: null,
        inviter: inv.full_name || null,
        officer: inv.full_name ? { name: inv.full_name, title: inv.title, email: inv.email, phone: inv.cell || inv.phone, nmls: inv.nmls } : null,
        acceptUrl, hasAccount: !!hasAuth.rows[0],
      }, { replyTo: inv.email || null, from: require('../lib/email').fromWithName(inv.full_name) });
    } catch (_) { /* invite email is best-effort; the profile + lead are already saved */ }
    // 3) open a CRM lead for the owning officer so the relationship is tracked from
    // first touch — unless one already exists for this email + officer (idempotent).
    let leadId = null;
    try {
      const dup = await db.query(`SELECT id FROM leads WHERE lower(email)=$1 AND officer_id=$2 LIMIT 1`, [email, officerId]);
      if (dup.rows[0]) leadId = dup.rows[0].id;
      else {
        const name = [first, last].filter(Boolean).join(' ') || email;
        const lr = await db.query(
          `INSERT INTO leads (tool,source,lead_source,name,first_name,last_name,email,phone,status,officer_id,created_by_staff_id,last_activity_at)
           VALUES ('manual','portal_invite','portal_invite',$1,$2,$3,$4,$5,'new',$6,$7,now()) RETURNING id`,
          [name, first || null, last || null, email, phone, officerId, req.actor.id]);
        leadId = lr.rows[0].id;
        await db.query(`INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body) VALUES ($1,$2,'system','Invited to portal',$3)`,
          [leadId, req.actor.id, 'Invited ' + email + ' to the borrower portal']);
      }
    } catch (_) { /* the CRM lead is best-effort */ }
    await audit(req, 'invite_to_portal', 'borrower', borrowerId, { email, officerId, leadId, created: !!bor.rows[0].created });
    res.status(201).json({ ok: true, borrowerId, leadId, emailed: true, hasAccount: !!hasAuth.rows[0], created: !!bor.rows[0].created });
  } catch (e) { console.error('[invite-to-portal] failed:', db.describeError(e)); res.status(500).json({ error: 'could not send the invite' }); }
});

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
            pr.stale AS registered_stale, pr.stale_reason AS registered_stale_reason,
            pr.created_at AS registered_at
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     LEFT JOIN llcs l ON l.id=a.llc_id
     LEFT JOIN borrowers cb ON cb.id=a.co_borrower_id
     LEFT JOIN LATERAL (
       SELECT program, product_label, status, note_rate, total_loan, quote, stale, stale_reason, created_at
         FROM product_registrations
        WHERE application_id=a.id AND is_current
        ORDER BY created_at DESC LIMIT 1
     ) pr ON true
     WHERE a.id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  const fileRow = r.rows[0];
  // Flag the overview when the CURRENT registration is stale — the leverage %/loan
  // amount on the snapshot are "as last registered" until a re-price, so they must
  // not read as live numbers next to freshly-edited economics (audit 2026-07-19).
  // Use the authoritative, trigger-maintained flag: product_registrations.stale is
  // set true by db/096+126 whenever ANY pricing input on the file changes after it
  // was registered (ARV/rehab/purchase/term/program/rehab-type/sq-ft/co-borrower/
  // FICO/assignment/…), and cleared on re-register — so this covers every driver and
  // avoids fetching the registered inputs (which carry the internal per-file markup).
  // (The raw applications.file_markup_* columns still ride a.* here as before; keeping
  // those off non-admin staff clients is a separate pre-existing follow-up.)
  fileRow.pricing_stale = !!(fileRow.registered_quote && fileRow.registered_stale);
  // The plain-language "why you must re-register" (which number changed, old → new).
  // Only meaningful when the registration is actually stale.
  fileRow.pricing_stale_reason = fileRow.pricing_stale ? (fileRow.registered_stale_reason || null) : null;
  delete fileRow.registered_stale;
  delete fileRow.registered_stale_reason;
  res.json(fileRow);
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
    // #91/#92: normalize + validate through the single SSN chokepoint — never
    // encrypt a dash-formatted string or store a partial/garbage last4.
    const ssnStore = b.ssn ? C.ssnForStorage(b.ssn) : null;
    const identity = require('../clickup/identity');
    const ssnHash = ssnStore ? identity.ssnHash(ssnStore.digits, cfg.ssnMatchKey) : null;
    const ssnEnc = ssnStore ? ssnStore.encrypted : null;
    const ssnLast4 = ssnStore ? ssnStore.last4 : null;
    // Identity graph: match an existing borrower by SSN-hash first (so the same
    // person across files stays one record), else create/update by email.
    if (ssnHash) {
      const m = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 LIMIT 1`, [ssnHash]);
      if (m.rows[0]) coId = m.rows[0].id;
    }
    if (!coId) {
      // N-2 (round-2): never silently adopt a DIFFERENT existing borrower who
      // shares this email (family emails are common) — that would grant them
      // access to this file's PII. If the email is on record under a conflicting
      // name, stop and make staff resolve it (same guard the primary paths use).
      const conflict = await emailAdoptionConflict(email, first, last);
      if (conflict) {
        const e = new Error(`That email is already on file for a different borrower (${(conflict.first_name || '').trim()} ${(conflict.last_name || '').trim()}). Use a different email or resolve the match first.`);
        e.status = 409; throw e;
      }
      const ins = await db.query(
        `INSERT INTO borrowers (first_name,last_name,email,cell_phone,date_of_birth,ssn_encrypted,ssn_last4,ssn_hash,origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'co_borrower')
         ON CONFLICT (email) DO UPDATE SET
           -- Staff-typed identity beats a PLACEHOLDER ('Unknown'/'Co-Borrower' are
           -- our own not-null fillers, never data) — but never a real stored name.
           first_name=CASE WHEN lower(btrim(coalesce(borrowers.first_name,''))) IN ('','unknown','co-borrower')
                           THEN EXCLUDED.first_name ELSE borrowers.first_name END,
           last_name=CASE WHEN lower(btrim(coalesce(borrowers.last_name,''))) IN ('','unknown','co-borrower')
                          THEN EXCLUDED.last_name ELSE borrowers.last_name END,
           cell_phone=COALESCE(borrowers.cell_phone,EXCLUDED.cell_phone),
           date_of_birth=COALESCE(borrowers.date_of_birth,EXCLUDED.date_of_birth),
           ssn_encrypted=COALESCE(borrowers.ssn_encrypted,EXCLUDED.ssn_encrypted),
           ssn_last4=COALESCE(borrowers.ssn_last4,EXCLUDED.ssn_last4),
           ssn_hash=COALESCE(borrowers.ssn_hash,EXCLUDED.ssn_hash),
           updated_at=now()
         RETURNING id`,
        [first, last, email, b.phone || null,
         require('../lib/fields').sanitizeDob(b.dob),   // typed '26' resolves to the real year; garbage never persists
         ssnEnc, ssnLast4, ssnHash]);
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
    // Detail carries the FIELD NAMES the attach touched (esp. 'date_of_birth')
    // so the DOB backdating provenance check can see this human entry
    // (post-merge audit #271, provenance hole #3).
    await audit(req, 'set_co_borrower', 'application', appId, {
      coBorrowerId: coId,
      fields: ['first_name', b.phone ? 'cell_phone' : null,
        require('../lib/fields').sanitizeDob(b.dob) ? 'date_of_birth' : null,
        b.ssn ? 'ssn' : null].filter(Boolean),
    });
    res.json({ ok: true, coBorrowerId: coId });
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: e.message });
    console.warn('[staff] handler error:', db.describeError(e));
    res.status(500).json({ error: 'server error' });
  }
});

// #30 — inline-fill the CO-BORROWER's missing identity fields from the file's
// separate "Co-borrower completeness" section, mirroring /complete-fields for
// the primary borrower. Partial update of the linked co-borrower's `borrowers`
// row; SSN + email stay in the Co-borrower panel (secure/link flows), so this
// only handles name / phone / date of birth.
router.post('/applications/:id/co-borrower-fields', async (req, res) => {
  const b = req.body || {};
  try {
    const ar = await db.query(`SELECT co_borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!ar.rows[0]) return res.status(404).json({ error: 'not found' });
    const coId = ar.rows[0].co_borrower_id;
    if (!coId) return res.status(409).json({ error: 'no co-borrower on this file' });
    const vals = [coId]; const sets = [];
    const put = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (typeof b.co_name === 'string' && b.co_name.trim()) {
      const parts = b.co_name.trim().split(/\s+/);
      put('first_name', parts.shift());
      // Only set last_name when a second token was actually given — a single-word
      // entry shouldn't duplicate the first name into the last (it would falsely
      // read as a complete name; leaving last_name keeps completeness flagging it).
      if (parts.length) put('last_name', parts.join(' '));
    }
    if (typeof b.co_phone === 'string' && b.co_phone.trim()) put('cell_phone', b.co_phone.trim());
    if (b.co_dob) {
      const dob = require('../lib/fields').sanitizeDob(b.co_dob);   // typed '26' resolves; garbage rejected
      if (dob == null) return res.status(400).json({ error: 'co-borrower date of birth must be a valid YYYY-MM-DD with a 4-digit year' });
      put('date_of_birth', dob);
    }
    // #60 — parity with the primary borrower's inline-add fields.
    if (b.co_fico !== undefined && b.co_fico !== '') { const cf = require('../lib/fields').sanitizeFico(b.co_fico); if (cf != null) put('fico', cf); }  // #90: 3-digit, 300–850
    if (typeof b.co_citizenship === 'string' && b.co_citizenship.trim()) put('citizenship', b.co_citizenship.trim());
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=now()');
    await db.query(`UPDATE borrowers SET ${sets.join(', ')} WHERE id=$1`, vals);
    // Detail carries the FIELD NAMES (not just a count): the DOB backdating
    // provenance check reads the audit trail for a human 'date_of_birth'
    // fingerprint — a bare count would make a co-borrower DOB edit invisible
    // to it and the backdating rule could override a human's entry.
    await audit(req, 'complete_co_borrower_fields', 'application', req.params.id,
      { fields: sets.filter((s) => !s.startsWith('updated_at')).map((s) => s.split('=')[0]), coBorrowerId: coId });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  const verified = { flips: 0, holds: 0, ground: 0 };
  for (const row of tr.rows) {
    if (row.dt.indexOf('ground') > -1 || row.dt.indexOf('construction') > -1) verified.ground += row.n;
    else if (row.dt.indexOf('flip') > -1) verified.flips += row.n;
    else verified.holds += row.n;   // fix-and-hold, rental, anything else
  }
  // Owner-directed 2026-07-14: the loan SIZES on the borrower's CLAIMED experience
  // of record (requested_exp_*) — the loan they qualify for on their STATED
  // experience — exactly as the Term Sheet Studio's what-if display already does
  // (requested_exp ?? verified). Funding stays gated by the experience CONDITION
  // (clear-to-close blocks until the claim is VERIFIED), so this never over-lends;
  // it only stops the registered loan from silently landing BELOW what the studio
  // showed. Previously sized verified-only, so a NON-ADMIN registration (whose
  // claimed-experience override is stripped) persisted a SMALLER loan than the
  // studio displayed — e.g. a 187,500 quote landed as 174,921 on the pipeline. A
  // non-admin still can't inflate: the studio override stays stripped and the base
  // is the APPLICATION's attested claim, editable only through the (audited) form.
  const claimed = (v, fb) => (v != null ? (Number(v) || 0) : fb);
  const exp = {
    flips:  claimed(app.requested_exp_flips,  verified.flips),
    holds:  claimed(app.requested_exp_holds,  verified.holds),
    ground: claimed(app.requested_exp_ground, verified.ground),
  };
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
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice',
  'expFlips', 'expHolds', 'expGround',
];
// The manual-PRICING knobs (rate / leverage / force-price). A non-admin sending
// one of these MEANINGFULLY engaged means the studio displayed terms the server
// won't honor — that must be refused loudly, not registered differently
// (Pinchus Wieder). Experience keys are NOT here on purpose: the studio always
// carries the file's own experience, and a non-admin's experience change belongs
// in the audited application form — silently sizing off the file's claim is the
// correct long-standing behavior, so it must not trip the loud refusal (that
// would 403 EVERY vanilla non-admin register).
const MANUAL_PRICING_KEYS = [
  'forcePrice', 'manualPricing',
  'ovrAcqLTV', 'ovrARLTV', 'ovrLTC', 'ovrRate',
  'ovrAcqLTVPct', 'ovrARLTVPct', 'ovrLTCPct', 'ovrRatePct', 'ovrIrMonths', 'ovrEffPrice',
];
// "Meaningfully engaged": a truthy flag, or a numeric override with a real value
// — NOT a present-but-default key (manualPricing:false is sent on every staff
// register, so mere presence must never count).
const engaged = (v) => v === true || (v != null && v !== '' && v !== false && !(typeof v === 'number' && Number.isNaN(v)));
function sanitizeOverrides(req, raw) {
  const overrides = (raw && typeof raw === 'object') ? { ...raw } : {};
  const role = req.actor && req.actor.role;
  if (role === 'admin' || role === 'super_admin') return { overrides, strippedAdminKeys: false };
  let stripped = false;
  for (const k of ADMIN_ONLY_OVERRIDE_KEYS) {
    if (k in overrides) {
      // Only a MEANINGFULLY-engaged MANUAL-PRICING knob makes the studio diverge
      // from what the server will register — that's what we refuse loudly.
      if (MANUAL_PRICING_KEYS.includes(k) && engaged(overrides[k])) stripped = true;
      delete overrides[k];
    }
  }
  return { overrides, strippedAdminKeys: stripped };
}

// Fresh quote for both programs (no persistence). Body: { program?, overrides? }.
router.post('/applications/:id/pricing/quote', async (req, res) => {
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const f = await loadFileForPricing(req.params.id);
    if (!f) return res.status(404).json({ error: 'not found' });
    // Same no-silent-divergence rule as register: a quote must never PREVIEW
    // numbers the server would refuse to register for this role.
    const { overrides, strippedAdminKeys } = sanitizeOverrides(req, (req.body && req.body.overrides) || {});
    if (strippedAdminKeys)
      return res.status(403).json({ error: 'Manual rate/leverage and experience overrides need an admin — clear the admin pricing fields to quote as your role.' });
    const out = pricing.quoteAll(f.app, f.exp, overrides);
    res.json({ ...out, experience: f.exp });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Current registered product + history, plus a fresh default quote for the panel.
router.get('/applications/:id/pricing', async (req, res) => {
  try {
    const f = await loadFileForPricing(req.params.id);
    if (!f) return res.status(404).json({ error: 'not found' });
    const hist = await db.query(
      `SELECT r.id, r.program, r.product_label, r.status, r.note_rate, r.total_loan, r.target_ltc,
              r.is_current, r.created_at, r.inputs, r.quote, r.is_manual, r.asset_months, s.full_name AS registered_by_name
         FROM product_registrations r LEFT JOIN staff_users s ON s.id=r.registered_by
        WHERE r.application_id=$1 ORDER BY r.created_at DESC`, [req.params.id]);
    const current = hist.rows.find((x) => x.is_current) || null;
    let quote = null;
    if (pricing.enginesReady()) { try { quote = pricing.quoteAll(f.app, f.exp); quote.experience = f.exp; } catch (_) {} }
    // Manual-product state: the current escalation (pending / decided) + the
    // company default liquidity months so the studio can prefill the asset-months
    // field it must collect before registering a manual product.
    let manualEscalation = null, manualDefaults = null;
    try { manualEscalation = await manualProgram.pendingForApp(req.params.id); } catch (_) {}
    if (!manualEscalation) {
      try {
        const d = await db.query(
          `SELECT status, asset_months, decided_at, decision_note FROM manual_program_escalations
            WHERE application_id=$1 ORDER BY created_at DESC LIMIT 1`, [req.params.id]);
        manualEscalation = d.rows[0] || null;
      } catch (_) {}
    }
    try { const ms = await manualProgram.loadSettings(); manualDefaults = { assetMonths: ms.assetMonths, isActive: ms.isActive, maxAcqLtv: ms.maxAcqLtv, maxArvLtv: ms.maxArvLtv, maxLtc: ms.maxLtc }; } catch (_) {}
    // The studio echoes econVersion back on register; a mismatch means the
    // file's economics moved underneath the open sheet (409, never a silent
    // stale re-register).
    res.json({ current, history: hist.rows, quote, enginesReady: pricing.enginesReady(),
      econVersion: pricing.econVersionFor(f.app), manualEscalation, manualDefaults });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Register a product: recompute authoritatively, persist as the current terms,
// sync loan_amount / rate_pct onto the file, audit + notify the team.
router.post('/applications/:id/pricing/register', async (req, res) => {
  const appId = req.params.id;
  // Every refusal is AUDITED (register_product_refused) — "LO says register
  // doesn't work" must be diagnosable from the logs alone, without reproducing
  // (#148/#149: the 403/409/422 paths used to leave no trace).
  const refuse = async (status, payload, reason, extra) => {
    try { await audit(req, 'register_product_refused', 'application', appId, { reason, status, ...extra }); } catch (_) {}
    return res.status(status).json(payload);
  };
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    const locked = await require('../lib/file-lock').structuralLockReason(appId, db, { actor: req.actor });   // #84
    if (locked) return refuse(409, { error: locked }, 'structural_lock');
    const b = req.body || {};
    const requestedProgram = b.program === 'gold' ? 'gold' : 'standard';
    const f = await loadFileForPricing(appId);
    if (!f) return res.status(404).json({ error: 'not found' });

    // Optimistic concurrency on the FILE-owned pricing basis: the studio sends
    // back the econVersion it prefilled from; if the file's economics changed
    // since (form edit, ClickUp inbound, another staffer), refuse rather than
    // silently re-register — and write back — a stale scenario (#148 root:
    // "re-register doesn't update the file" was a stale snapshot clobbering
    // the file's newer values). Old bundles that don't send it are unaffected.
    if (b.econVersion && b.econVersion !== pricing.econVersionFor(f.app)) {
      return refuse(409, {
        error: 'This file’s pricing inputs changed since the studio was opened. The latest values have been reloaded — review the scenario and register again.',
        code: 'econ_version_conflict',
      }, 'econ_version_conflict', { sent: String(b.econVersion).slice(0, 32) });
    }

    // NEVER register terms that silently differ from what the staffer saw
    // (root-caused 2026-07-16, Pinchus Wieder: a non-admin's rate/experience
    // overrides were stripped and the file re-registered with OLD economics
    // behind a success toast). If sanitize dropped keys, refuse loudly instead.
    const { overrides, strippedAdminKeys } = sanitizeOverrides(req, b.overrides || {});
    if (strippedAdminKeys)
      return refuse(403, { error: 'Manual rate/leverage and experience overrides need an admin — ask an admin to register these terms, or clear the admin pricing fields and re-register.' }, 'admin_override_stripped');
    // MANUAL PRODUCT: a structural override of the deal leverage (acquisition LTV /
    // after-repair LTV / loan-to-cost) is NOT a Standard/Gold registration — it
    // becomes its own "Manual Program" (priced on the Standard/Fidelis engine),
    // needs the registrant to state how many months of liquidity the file must
    // show, and goes to the super-admin escalation box. A markup/points/fee/rate
    // override alone is manual PRICING, not a manual product, and keeps the
    // requested program. (Structural override keys are already admin-only via
    // sanitizeOverrides, so only an admin/super-admin ever reaches manual here.)
    const program = manualProgram.resolveProgram(requestedProgram, overrides);
    const isManual = program === 'manual';
    let assetMonths = null;
    if (isManual) {
      const settings = await manualProgram.loadSettings();
      const raw = b.assetMonths != null && b.assetMonths !== '' ? Number(b.assetMonths) : NaN;
      assetMonths = Number.isFinite(raw) ? Math.round(raw) : NaN;
      if (!Number.isFinite(assetMonths) || assetMonths < 1 || assetMonths > 24) {
        return refuse(422, {
          error: 'This is a manual product (you changed the LTV, LTC or ARV structure). Enter how many months of assets/liquidity this file must show before registering it.',
          code: 'manual_asset_months_required',
          suggestedAssetMonths: settings.assetMonths,
        }, 'manual_asset_months_required', { program });
      }
    }
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    // A manual product overrides the guidelines by design — always force-price it
    // so a leverage override that lands "ineligible" against the Standard caps is
    // sized/registered as MANUAL (with the escalation), never bounced.
    if (isManual) inputs.forcePrice = true;
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
        return refuse(403, { error: `Only an underwriter or admin can raise ${raised.join(' and ')} on a priced file.` }, 'value_raise_blocked', { raised });
    }
    const quote = pricing.quoteProgram(program, inputs);
    // Gold Standard renovation cannot finance an interest reserve — never persist a
    // requested reserve on the registered scenario for that program.
    // Gold renovation finances NO interest reserve — zero BOTH request forms so a
    // leftover amount can't silently finance a reserve if the file later moves to the
    // Standard program, and the registered scenario never carries a phantom request
    // (audit findings #14/#34/#40/#49, 2026-07-17).
    if (program === 'gold' && quote.kind === 'reno') { inputs.irMonths = 0; inputs.irAmount = 0; }
    if (quote.status === 'INELIGIBLE' && !overrides.forcePrice) {
      return refuse(422, { error: 'ineligible', reasons: quote.reasons, quote }, 'ineligible', { program });
    }
    const total = quote.sizing ? quote.sizing.totalLoan : 0;
    if (!(total > 0)) return refuse(422, { error: 'no loan sized', quote }, 'no_loan_sized', { program });

    // Owner-directed 2026-07-21: a MANUAL result is NOT eligible as-is. Every
    // manual-review scenario — below the $100,000 minimum, over the program
    // maximum, a FICO waiver, a city/exit/heavy-budget/term exception, anything the
    // frozen engine flags MANUAL — is a manual-review EXCEPTION that must be (1)
    // explicitly SUBMITTED as an exception request and (2) APPROVED by a super-admin
    // before any terms are confirmed. So a plain register of a MANUAL scenario is
    // BLOCKED here (the studio then offers "Submit exception request"); a Manual
    // Program (structural LTV/LTC/ARV override) is itself a deliberate exception and
    // is not blocked — it always escalates below.
    const submitException = !!b.submitException;
    const manualReasons = (quote.reasons || [])
      .filter((r) => r && r.level === 'MANUAL').map((r) => r.msg).filter(Boolean);
    if (quote.status === 'MANUAL' && !isManual && !submitException) {
      return refuse(422, {
        error: 'exception_required',
        code: 'exception_required',
        message: `This scenario isn’t eligible as-is on the ${pricing.PROGRAM_LABEL[program]}. It needs a manual-review exception: ${manualReasons.join('; ') || 'a guideline exception'}. Submit an exception request — a super-admin reviews it, and the borrower is not sent terms unless it’s approved.`,
        reasons: quote.reasons, quote,
        exceptionRequired: true, manualReasons,
      }, 'exception_required', { program, manualReasons });
    }

    // A registration that reaches here as MANUAL (exception submitted) OR a Manual
    // Program must go through the super-admin escalation box and must NEVER confirm
    // terms to the borrower until approved. A clean ELIGIBLE Standard/Gold
    // registration is unaffected (confirms immediately, as before). Shared
    // definition in manual-program.js.
    const needsEscalation = manualProgram.needsSuperAdminApproval({ program, status: quote.status });

    // The superseded terms, captured before the new row lands — the audit trail
    // (and Activity feed) shows exactly what a reprice changed.
    const prevQ = await db.query(
      `SELECT program, total_loan, note_rate, product_label FROM product_registrations
        WHERE application_id=$1 AND is_current LIMIT 1`, [appId]);
    const prev = prevQ.rows[0] || null;

    const client = await db.getClient();
    let regId;
    let economicsChanged = true;   // first registration always notifies the borrower
    try {
      await client.query('BEGIN');
      const reg = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: req.actor.id,
        isManual, assetMonths,
      });
      regId = reg.id;
      economicsChanged = reg.economicsChanged;
      // Needs manual review → open a super-admin escalation in the same
      // transaction. The file registers now, but the product stays "pending
      // super-admin approval" until the escalation is decided (db/207), and the
      // borrower is NOT sent confirmed terms until then. Superseding any prior
      // pending row is handled inside openEscalation. Covers both a Manual Program
      // (structural override) AND a Standard/Gold registration the engine flagged
      // MANUAL (below minimum, over maximum, or any other manual-review reason).
      if (needsEscalation) {
        // Escalation is REQUIRED — if it can't open, the throw rolls back the
        // whole registration (never an un-escalated manual-review file).
        await manualProgram.openEscalation(client, {
          appId, registrationId: regId, assetMonths,
          overrides,
          summary: {
            kind: isManual ? 'manual_product' : 'manual_review',
            program, productLabel: quote.productLabel || null,
            status: quote.status,
            totalLoan: total, noteRate: quote.noteRate,
            acqLtvPct: quote.sizing ? quote.sizing.acqLtvPct : null,
            arvPct: quote.sizing ? quote.sizing.arvPct : null,
            ltcPct: quote.sizing ? quote.sizing.ltcPct : null,
            assetMonths,
            manualReasons,
          },
          requestedBy: req.actor.id,
        });
      } else {
        // Re-registered as a clean, auto-eligible product: close any stale pending
        // escalation so the super-admin box doesn't keep showing an approval for a
        // file that no longer needs one.
        await manualProgram.closePendingForApp(client, appId);
      }
      // #101: STICK an explicit per-file markup override to the file so it re-applies
      // to every future quote — the borrower's self-service pricing can then never
      // reprice below it. Only touch a column the caller explicitly set: a blank/
      // omitted markup leaves the sticky value as-is; an explicit value (incl. an
      // admin resetting it) overwrites it. A live company-default registration
      // (no markup key) never freezes the default onto the file.
      const stickyMk = (v) => { if (v == null || v === '') return null; const n = Number(v); return isFinite(n) ? n : null; };
      if (Object.prototype.hasOwnProperty.call(overrides, 'markupStdPct'))
        await client.query(`UPDATE applications SET file_markup_std_pct=$2 WHERE id=$1`, [appId, stickyMk(overrides.markupStdPct)]);
      if (Object.prototype.hasOwnProperty.call(overrides, 'markupGoldPct'))
        await client.query(`UPDATE applications SET file_markup_gold_pct=$2 WHERE id=$1`, [appId, stickyMk(overrides.markupGoldPct)]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }

    // Vesting LLC on register (owner-directed 2026-07-21): if the staffer typed
    // an entity name on the Products & Pricing / Term Sheet Studio screen and
    // the file has no vesting LLC yet, persist the typed name as the subject-
    // property LLC — resolve-or-create it under this borrower and route through
    // the vesting chokepoint (llc_id + LLC condition + doc slots + re-eval). A
    // file that already carries a vesting LLC is untouched (never renamed).
    // Best-effort: a vesting hiccup never fails the just-committed register.
    try {
      const typed = String((b.overrides && b.overrides.entityName) || b.entityName || '').trim();
      if (typed && !f.app.llc_id) {
        const borrowerId = f.app.borrower_id;
        const ex = await db.query(`SELECT id FROM llcs WHERE borrower_id=$1 AND lower(llc_name)=lower($2) LIMIT 1`, [borrowerId, typed]);
        const vestLlcId = ex.rows[0] ? ex.rows[0].id
          : (await db.query(`INSERT INTO llcs (borrower_id, llc_name) VALUES ($1,$2) RETURNING id`, [borrowerId, typed])).rows[0].id;
        if (vestLlcId) await require('../lib/vesting').setVestingLlc(appId, vestLlcId, { source: 'staff', actor: req.actor.id });
      }
    } catch (e) { console.error('[staff-register] vesting from studio failed:', db.describeError(e)); }
    finally { client.release(); }
    // Registration rewrites loan amount / rate / program — re-run condition rules.
    try { await conditionEngine.evaluateApplication(appId, { actor: req.actor, reason: 'product_registered' }); } catch (_) {}

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null,
        origination: quote.origination != null ? quote.origination : undefined,
        origPct: quote.origPct != null ? quote.origPct : undefined,
        cashToClose: quote.cashToClose != null ? quote.cashToClose : undefined,
        liquidity: (quote.liquidity ?? quote.liquidityRequired) != null ? (quote.liquidity ?? quote.liquidityRequired) : undefined,
        previous: prev ? { program: prev.program, totalLoan: Number(prev.total_loan), noteRate: Number(prev.note_rate), productLabel: prev.product_label } : undefined,
        isManual, assetMonths: assetMonths != null ? assetMonths : undefined });

    // Needs manual review → tell the admins/super-admins it's waiting in the
    // escalation box (they alone approve it). Audited separately so the escalation
    // is diagnosable, and the team notification above already fired for the
    // register. Covers a Manual Program AND a Standard/Gold MANUAL registration.
    if (needsEscalation) {
      try { await audit(req, 'manual_program_escalated', 'application', appId, { kind: isManual ? 'manual_product' : 'manual_review', status: quote.status, assetMonths, totalLoan: total, noteRate: quote.noteRate, manualReasons }); } catch (_) {}
      try {
        const dollars = '$' + Math.round(total).toLocaleString('en-US');
        const productDesc = isManual ? 'Manual Program (custom LTV/LTC/ARV)'
          : `${pricing.PROGRAM_LABEL[program]} — manual review`;
        const ectx = await notify.fileContext(appId, [
          { label: 'Requested product', value: productDesc },
          { label: 'Loan amount', value: dollars },
          isManual ? { label: 'Liquidity months stated', value: `${assetMonths} month${assetMonths === 1 ? '' : 's'}` } : null,
          manualReasons.length ? { label: 'Why manual review', value: manualReasons.join(' · ') } : null,
        ].filter(Boolean));
        const why = isManual
          ? `A Manual Program (custom LTV/LTC/ARV) was registered on ${ectx ? ectx.label : 'a file'} and is waiting for super-admin approval in the Escalations box. Loan amount ${dollars} · ${assetMonths} month${assetMonths === 1 ? '' : 's'} of liquidity required.`
          : `A ${pricing.PROGRAM_LABEL[program]} registration on ${ectx ? ectx.label : 'a file'} needs manual review (${manualReasons.join('; ') || 'guideline exception'}) and is waiting for super-admin approval in the Escalations box. The borrower is NOT sent terms until it's approved. Loan amount ${dollars}.`;
        await notify.notifyAdmins({
          type: 'manual_escalation',
          title: isManual ? 'Manual product needs approval' : 'Registration needs super-admin approval',
          body: why,
          meta: (ectx && ectx.meta) || undefined, applicationId: appId,
          link: '/internal/escalations', ctaLabel: 'Open the Escalations box',
        });
      } catch (_) { /* notification is best-effort */ }
      // …and raise it DIRECTLY into the super-admin Workflow (with the file link,
      // the reason, and a pointer to the Escalations box). Best-effort.
      try {
        const dollars = '$' + Math.round(total).toLocaleString('en-US');
        const wfNote = (isManual
          ? `Manual Program (custom LTV/LTC/ARV) — ${dollars}.`
          : `${pricing.PROGRAM_LABEL[program]} — manual-review exception: ${manualReasons.join('; ') || 'guideline exception'}. ${dollars}.`)
          + ' Review the exception and approve/decline it in the Escalations box.';
        await workflowAuto.onEscalationOpened(appId, { fromStaffId: req.actor.id, note: wfNote });
      } catch (_) { /* best-effort */ }
    } else {
      // Clean, auto-eligible (re-)registration → clear any lingering escalation
      // hand-off from the super-admin Workflow.
      workflowAuto.closeEscalationWorkflow(appId, 'Re-registered as eligible').catch(() => {});
    }

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
    try { await require('../lib/liquidity').syncLiquidityCondition(appId, quote, db, isManual ? { program, assetMonths } : {}); } catch (_) {}
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
      await notify.notifyAppStaff(appId, {   // #113: whole team (primary + assistants), minus the actor
          type: 'product_registered', title: 'Product registered',   // file identity (loan# · borrower · property) rides in the subject tag — never in the title (no double loan number)
          body, meta: (ctx && ctx.meta) || undefined, applicationId: appId,
          link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file', exceptStaffId: req.actor.id });

      // #150 / owner-directed 2026-07-20 — the CLIENT gets the SAME rich,
      // borrower-safe loan-terms email the team's own notice is built from (full
      // structure breakdown, not a thin one-liner), branded to (and From) their
      // assigned loan officer so recurring business stays with the officer's name.
      // Borrower-safe copy only (program label + the borrower's own deal numbers);
      // type 'term_sheet' is in the borrower MAJOR-email allowlist (#88), and the
      // subject line auto-carries the file (loan # · property) via notify.js.
      // Send the borrower their "terms are ready" email ONLY when (a) a headline
      // number actually changed (owner-directed 2026-07-20 — an internal
      // re-register with the SAME numbers must not nudge them again) AND (b) the
      // registration does NOT need super-admin approval (owner-directed
      // 2026-07-21 — a manual-review / manual-program registration is confirmed to
      // the borrower ONLY after a super-admin approves the escalation; see
      // admin-manual-programs.js). The team's own notice above always fires.
      if (economicsChanged && !needsEscalation) {
        try { await require('../lib/terms-notify').sendBorrowerTerms(appId, { quote, total, termMonths: inputs && inputs.term }); }
        catch (_) { /* borrower terms email is best-effort */ }
      }
    } catch (_) { /* notification is best-effort */ }

    res.status(201).json({ ok: true, registrationId: regId, quote, pendingApproval: needsEscalation });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Request an EXCEPTION to a guideline that the deal otherwise follows — e.g. to
// finance MORE of an assignment fee than the 15% cap (a bigger loan), or any
// other over-guideline ask (owner-directed 2026-07-21). This does NOT change the
// registered product; it raises an escalation into the super-admin Workflow +
// Escalations box for review. A super-admin grants it by applying the relevant
// admin override (e.g. the approved effective purchase price) and re-registering.
router.post('/applications/:id/pricing/request-exception', async (req, res) => {
  const appId = req.params.id;
  try {
    const note = String((req.body && req.body.note) || '').slice(0, 1000).trim();
    if (!note) return res.status(400).json({ error: 'Describe the exception you’re requesting.' });
    const ctx = await notify.fileContext(appId);
    const wfNote = `Exception request: ${note}`;
    await workflowAuto.onEscalationOpened(appId, { fromStaffId: req.actor.id, note: wfNote });
    try {
      await notify.notifyAdmins({
        type: 'manual_escalation',
        title: 'Exception request needs super-admin review',
        body: `${req.actor.name || 'A team member'} requested an exception on ${ctx ? ctx.label : 'a file'}: ${note}`,
        meta: (ctx && ctx.meta) || undefined, applicationId: appId,
        link: '/internal/escalations', ctaLabel: 'Open the Escalations box',
      });
    } catch (_) { /* best-effort */ }
    await audit(req, 'pricing_exception_requested', 'application', appId, { note });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Loan officer's ONE-CLICK accept of a super-admin's counter-offer (owner-directed
// 2026-07-21, Task #6). The counter's numeric terms were AUTHORED by a super-admin
// on the escalations page (manual_program_escalations.counter_terms). Accepting
// them re-registers the file at those terms — no need for the LO to retype them.
// The route runs the same guarded pricing + persist path a normal register uses,
// then marks the escalation APPROVED (the LO's accept IS the approval) and
// notifies the super-admin who authored the counter. Because the counter came
// from a super-admin, the admin-only override keys are already authorized — they
// bypass sanitizeOverrides which would strip them for a non-admin LO.
router.post('/applications/:id/pricing/accept-counter', async (req, res) => {
  const appId = req.params.id;
  try {
    if (!pricing.enginesReady()) return res.status(503).json({ error: 'pricing engines unavailable', detail: pricing.loadErr() });
    // The file's currently OPEN escalation (pending or countered). We only accept
    // when it's actually a counter — plain pending has nothing to accept.
    const esc = await manualProgram.pendingForApp(appId);
    if (!esc) return res.status(409).json({ error: 'No open escalation on this file.' });
    if (esc.status !== 'countered') return res.status(409).json({ error: 'This escalation is not in counter-offer state — nothing to accept.' });
    const f = await loadFileForPricing(appId);
    if (!f) return res.status(404).json({ error: 'not found' });

    // Build overrides: start with the ORIGINAL manual-review overrides (stored
    // structural keys on the escalation), then overlay the super-admin's counter
    // terms. counter_terms holds fractions (0.925 = 92.5%) so they feed the engine's
    // ovr* keys directly.
    const rawCt = esc.counter_terms || {};
    const ct = typeof rawCt === 'string' ? JSON.parse(rawCt) : rawCt;
    const rawOv = esc.overrides || {};
    const overrides = { ...(typeof rawOv === 'string' ? JSON.parse(rawOv) : rawOv) };
    if (ct.maxAcqLtv != null) overrides.ovrAcqLTV = Number(ct.maxAcqLtv);
    if (ct.maxArvLtv != null) overrides.ovrARLTV = Number(ct.maxArvLtv);
    if (ct.maxLtc    != null) overrides.ovrLTC   = Number(ct.maxLtc);
    if (ct.noteRate  != null) overrides.ovrRate  = Number(ct.noteRate);
    if (ct.origPct   != null) {
      const pctVal = Number(ct.origPct) * 100;
      overrides.origStdPct = pctVal;
      overrides.origGoldPct = pctVal;
    }
    // Force-price so a scenario ineligible under the standard caps still sizes
    // and registers as MANUAL (the counter TERMS are the approval — we don't want
    // an under-cap engine bounce). A super-admin authored these terms, so the
    // authorization is already in place.
    overrides.forcePrice = true;

    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    inputs.forcePrice = true;
    const requestedProgram = (esc.summary && esc.summary.program) === 'gold' ? 'gold' : 'standard';
    const program = manualProgram.resolveProgram(requestedProgram, overrides);
    const quote = pricing.quoteProgram(program, inputs);
    const total = Number(quote && quote.totalLoan) || 0;

    // Persist + mark the escalation approved in ONE transaction so an accept
    // never half-lands (registered without the escalation closing, or vice versa).
    const client = await db.getClient();
    let regId;
    try {
      await client.query('BEGIN');
      const reg = await persistProductRegistration(client, {
        appId, program, inputs, quote, registeredByStaffId: req.actor.id,
        isManual: program === 'manual', assetMonths: esc.asset_months,
      });
      regId = reg.id;
      // The LO's accept IS the approval. Mark THIS row 'approved' (persistProductRegistration
      // may have opened a NEW escalation for the re-register — that's a separate row and stays
      // pending only if the new scenario is itself manual-review, which is fine). The status
      // guard makes the UPDATE strict — a parallel super-admin decide/counter that landed a
      // millisecond earlier won't get clobbered here.
      await client.query(
        `UPDATE manual_program_escalations
            SET status='approved', decided_by=$2, decided_at=now(),
                decision_note=COALESCE(decision_note,'Loan officer accepted the counter-offer'),
                updated_at=now()
          WHERE id=$1 AND status='countered'`,
        [esc.id, req.actor.id]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    // Post-register rule re-evaluation — the accept-counter path RE-REGISTERS the file with
    // new economics, so the same downstream re-evaluations the normal /register endpoint runs
    // (rule-driven conditions like liquidity months, the EMD condition on note-buyer changes,
    // the Blue Lake 5% SOW contingency) must run here too. Otherwise a countered file lands
    // with stale conditions. All best-effort (they never break the accept).
    try { await conditionEngine.evaluateApplication(appId, { actor: req.actor, reason: 'counter_accepted' }); } catch (_) {}
    try { await require('../lib/liquidity').syncLiquidityCondition(appId, quote, db, program === 'manual' ? { program, assetMonths: esc.asset_months } : {}); } catch (_) {}
    try { await require('../lib/rehab-budget').enforceGoldSowContingency(appId); } catch (_) {}
    // Push the new economics to ClickUp so the task mirrors the accepted terms.
    try { require('../clickup/orchestrator').pushApplication(appId).catch(() => {}); } catch (_) {}

    await audit(req, 'manual_program_counter_accepted', 'application', appId,
      { escalationId: esc.id, registrationId: regId, counterTerms: ct, totalLoan: total });

    // Notify the super-admin who authored the counter — their proposal went through.
    try {
      if (esc.countered_by) {
        const ctx = await notify.fileContext(appId, [{ label: 'Counter-offer', value: 'Accepted by the loan officer' }]);
        await notify.notifyStaff(esc.countered_by, {
          type: 'manual_escalation_decided',
          title: 'Your counter-offer was accepted',
          body: `The loan officer accepted your counter-offer on ${ctx ? ctx.label : 'the file'} and the file has been re-registered with the countered terms. The borrower will be sent their confirmed terms.`,
          meta: (ctx && ctx.meta) || undefined, applicationId: appId,
          link: `/internal/app/${appId}`, ctaLabel: 'Open the loan file',
        });
      }
    } catch (_) { /* best-effort */ }

    // Take the escalation hand-off off the super-admin Workflow (mirrors decide).
    try { await require('../lib/workflow-automation').closeEscalationWorkflow(appId, 'Counter accepted'); } catch (_) {}

    // Send the borrower their confirmed terms — same email the plain-approval path sends.
    try {
      await require('../lib/terms-notify').sendBorrowerTerms(appId, {
        quote, total, termMonths: inputs && inputs.term,
      });
    } catch (_) { /* best-effort */ }

    res.json({ ok: true, registrationId: regId, totalLoan: total });
  } catch (e) {
    console.warn('[staff] accept-counter error:', db.describeError(e));
    res.status(500).json({ error: 'could not accept the counter-offer' });
  }
});

// Staff build/adjust a file's rehab budget (scope of work) — for staff-run
// files where the borrower isn't filling it in. Upserts the rehab_budget tool
// item's payload and syncs applications.rehab_budget (feeds pricing).
router.post('/applications/:id/rehab-budget', async (req, res) => {
  const appId = req.params.id;
  const payload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : null;
  if (!payload) return res.status(400).json({ error: 'payload required' });
  const locked = await require('../lib/file-lock').structuralLockReason(appId, db, { actor: req.actor });   // #84
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
    const locked = await require('../lib/file-lock').structuralLockReason(req.params.id, db, { actor: req.actor });
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
  // Validate/decode the replacement exports FIRST (strict decode — a data:-URL
  // prefix or non-base64 junk must never garble stored bytes), and only
  // supersede the previous exports when at least one valid replacement exists:
  // a submission whose attachments all fail must not strip the condition of
  // its current documents.
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  const valid = [];
  for (const a of attachments) {
    let buf;
    try { ({ buf } = decodeUploadBase64(a.dataBase64)); } catch (_) { continue; }
    if (!buf.length || buf.length > maxBytes) continue;
    valid.push({ a, buf });
  }
  if (valid.length) {
    // A resubmission outdates the previous exports: the old PDF/Excel are
    // superseded and the fresh ones become the current versions on the condition.
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE checklist_item_id=$1 AND source_type='system' AND is_current=true`, [req.params.itemId]);
  }
  const out = [];
  for (const { a, buf } of valid) {
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
            ci.waived_at, ci.waived_by, wv.full_name AS waived_by_name,
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
       LEFT JOIN staff_users wv  ON wv.id  = ci.waived_by
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
    [req.params.id, b.label, borrowerLabel, audience, b.isRequired !== false, require('../lib/fields').normalizeTypedDate(b.dueDate), req.actor.id]);  // WO-6 (F-M11): year-0026-proof due date
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
  // Only tell the borrower when the item is actually borrower-facing, and show
  // them the BORROWER-facing wording (never the internal label). (S2-02)
  if (app.rows[0] && audience !== 'staff') {
    const ctx = await notify.fileContext(req.params.id);
    await notify.notifyBorrower(app.rows[0].borrower_id, {
      type: 'condition_added', title: 'New document requested on your file', badge: { text: 'Action needed', tone: 'action' },
      body: `"${borrowerLabel || b.label}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
      meta: (ctx && ctx.borrowerMeta) || undefined,
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
     category, b.isRequired !== false, require('../lib/fields').normalizeTypedDate(b.dueDate),  // WO-6 (F-M11): year-0026-proof due date
     String(b.notes || '').trim().slice(0, 2000) || null, req.actor.id]);
  await audit(req, 'add_condition_custom', 'application', req.params.id, { label, type, audience });
  if (audience !== 'staff') {
    try {
      const ctx = await notify.fileContext(req.params.id);
      await notify.notifyAppBorrowers(req.params.id, {
        type: 'condition_added', title: 'A new item was added to your file', badge: { text: 'Action needed', tone: 'action' },
        // Never interpolate the internal label — it can carry underwriting /
        // capital-partner (note-buyer) context. Borrower wording or a generic line.
        body: b.borrowerLabel
          ? `"${b.borrowerLabel}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`
          : `A new item was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
        meta: (ctx && ctx.borrowerMeta) || undefined,
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
        type: 'condition_added', title: 'A new item was added to your file', badge: { text: 'Action needed', tone: 'action' },
        // Borrower wording only — never fall back to the internal tpl.label.
        body: tpl.borrower_label
          ? `"${tpl.borrower_label}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`
          : `A new item was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
        meta: (ctx && ctx.borrowerMeta) || undefined,
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
// Draws from the SAME shared selection as the zip builder (owner-directed
// 2026-07-16: the export packages EVERY current document on the file), so the
// promised count can never disagree with the package.
router.get('/applications/:id/export/tpr/preview', async (req, res) => {
  try {
    const tpr = require('../lib/tpr-export');
    const included = (await tpr.selectTprDocuments(req.params.id)).length;
    const trIds = (await db.query(
      `SELECT id FROM track_records WHERE borrower_id IN (
         SELECT borrower_id FROM applications WHERE id=$1
         UNION SELECT co_borrower_id FROM applications WHERE id=$1 AND co_borrower_id IS NOT NULL)`,
      [req.params.id])).rows.map(r => r.id);
    const trackDocs = (await tpr.selectTrackRecordDocs(trIds)).length;
    const missing = await tpr.selectTprMissing(req.params.id);
    res.json({ includedCount: included, trackDocs, missing });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ============================ MISMO 3.4 import / export ======================
// MISMO is the mortgage industry's shared file format. Export turns one of our
// loan files into a MISMO v3.4 XML document any other system can read; import
// reads such a file back into a new portal loan file. The heavy lifting lives in
// src/lib/mismo/ (a dependency-free XML engine + field crosswalk).

// EXPORT — download this loan file as a MISMO 3.4 XML document. Under the
// /applications/:id path scope, so only assigned staff / see-all can pull it.
// The file carries PII (incl. SSN, a core MISMO field), so the download is
// audited exactly like the TPR export.
router.get('/applications/:id/export/mismo', async (req, res) => {
  try {
    const mismo = require('../lib/mismo');
    const xml = await mismo.exportApplicationXml(req.params.id);
    if (!xml) return res.status(404).json({ error: 'application not found' });
    const row = (await db.query(
      'SELECT a.ys_loan_number, b.last_name FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1',
      [req.params.id])).rows[0] || {};
    const filename = mismo.exportFilename(row.ys_loan_number, row.last_name);
    await audit(req, 'export_mismo', 'application', req.params.id, { bytes: Buffer.byteLength(xml) });
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(xml);
  } catch (e) {
    console.error('[mismo] export failed:', db.describeError ? db.describeError(e) : e.message);
    res.status(500).json({ error: 'export failed' });
  }
});

// A tiny masker so a PREVIEW never surfaces a full SSN — staff see only the
// last four, exactly as everywhere else PII is shown before it's stored.
function maskMismoPreview(parsed) {
  const clone = JSON.parse(JSON.stringify(parsed || {}));
  for (const key of ['borrower', 'coBorrower']) {
    const p = clone[key];
    if (p && p.ssn) p.ssn = '•••-••-' + String(p.ssn).slice(-4);
  }
  return clone;
}

// IMPORT — PREVIEW. Parse an uploaded MISMO file and return exactly what would be
// imported. This NEVER writes to the database, so staff always see the contents
// before a single row is created (the repo's "never silently apply" posture).
router.post('/mismo/preview', async (req, res) => {
  const xml = req.body && req.body.xml;
  if (!xml || typeof xml !== 'string') return res.status(400).json({ error: 'no MISMO XML provided' });
  try {
    const parsed = require('../lib/mismo').previewImport(xml);
    res.json({ ok: true, preview: maskMismoPreview(parsed), warnings: parsed.warnings || [] });
  } catch (e) {
    res.status(422).json({ error: e.userMessage || 'this file could not be read as a MISMO 3.4 file' });
  }
});

// IMPORT — CREATE. Re-parse the SAME XML server-side (never trust a client-edited
// object — the SSN and every field are re-read from the file here) and create a
// new loan file from it. The importing loan officer is assigned to it; anyone
// else leaves it in Lead Capture.
router.post('/mismo/create', async (req, res) => {
  const xml = req.body && req.body.xml;
  if (!xml || typeof xml !== 'string') return res.status(400).json({ error: 'no MISMO XML provided' });
  try {
    const mismo = require('../lib/mismo');
    const parsed = mismo.previewImport(xml);
    if (!parsed.borrower) return res.status(422).json({ error: 'this file has no borrower, so a loan file can’t be created from it' });
    const officerId = req.actor.role === 'loan_officer' ? req.actor.id : null;
    const { borrowerId, applicationId } = await mismo.createFromParsed(parsed, { officerId });
    await audit(req, 'import_mismo', 'application', applicationId, { borrowerId, warnings: (parsed.warnings || []).length });
    res.status(201).json({ ok: true, applicationId, borrowerId, warnings: parsed.warnings || [] });
  } catch (e) {
    console.error('[mismo] import create failed:', db.describeError ? db.describeError(e) : e.message);
    res.status(500).json({ error: e.userMessage || 'could not create a file from this MISMO import' });
  }
});

// Full file activity feed (staff sees everything, including internal).
router.get('/applications/:id/activity', async (req, res) => {
  try { res.json(await require('../lib/activity').fileActivity(req.params.id, false)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ════════════════════════════════════════════════════════════════════════════
// EMAIL CENTER (owner-directed 2026-07-20) — a Gmail/Outlook-style history on
// every file: every email that went out (to the borrower, co-borrower, each
// assigned staffer, external partners) with its FULL designed body, exactly whom
// it reached and when, the delivery status (so a failed send can be troubleshot),
// the inbound replies WITH their body, and a reply box. Reads the email_messages
// store (db/185) which src/lib/email-log.js captures every send + reply into; the
// prior history is backdated in by the boot backfill. Staff-only, file-scoped.
// ════════════════════════════════════════════════════════════════════════════

// Shape one email_messages row for the client (used by the file view + mailbox).
function emailRowShape(r) {
  return {
    id: r.id,
    direction: r.direction,
    type: r.msg_type,
    category: r.category,
    subject: r.subject || '(no subject)',
    preview: r.preview || '',
    from_email: r.from_email,
    from_name: r.from_name,
    to: Array.isArray(r.to_emails) ? r.to_emails : [],
    cc: Array.isArray(r.cc_emails) ? r.cc_emails : [],
    reply_to: r.reply_to,
    recipient_kind: r.recipient_kind,
    recipient_name: r.recipient_name || null,
    audience: r.audience,
    status: r.status,
    error: r.error,
    attachments: Array.isArray(r.attachments) ? r.attachments : [],
    meta: r.meta || null,
    reconstructed: r.reconstructed,
    has_body: r.has_body,
    thread_key: r.thread_key,
    occurred_at: r.occurred_at,
    // file identity (present on the global mailbox rows)
    application_id: r.application_id || null,
    loan_no: r.ys_loan_number || null,
    file_label: r.file_label || null,
    // every recipient this exact email reached (filled by consolidateEmailRows)
    recipients: r.recipients || null,
    recipient_count: r.recipient_count || null,
    // open tracking (whether/when this recipient opened it)
    opened_at: r.opened_at || null,
    open_count: r.open_count || 0,
  };
}

// Recipients of a single row → [{email,name,kind,status}]. A notify fan-out
// writes one row per recipient, so this is usually one entry; consolidation
// merges the whole fan-out below.
function recipientsOfRow(r) {
  const to = Array.isArray(r.to_emails) ? r.to_emails : [];
  if (!to.length) return r.recipient_name ? [{ email: null, name: r.recipient_name, kind: r.recipient_kind, status: r.status, opened_at: r.opened_at || null }] : [];
  return to.map((t, i) => ({
    email: t.email || null,
    name: (i === 0 ? r.recipient_name : null) || t.name || null,
    kind: r.recipient_kind || null,
    status: r.status,
    opened_at: r.opened_at || null,
  }));
}
const _STATUS_RANK = { error: 3, no_recipients: 3, failed_permanent: 3, skipped: 2, received: 1, forwarded: 1, sent: 1 };
const worseStatus = (a, b) => ((_STATUS_RANK[b] || 0) > (_STATUS_RANK[a] || 0) ? b : a);

// Consolidate a notify FAN-OUT (the same email sent to many people as one row
// each) into ONE message that lists everyone it reached with each recipient's
// delivery status — so opening it reads like a real email ("To: A, B, C"), not
// N near-identical rows. Rows are grouped by file+thread+type+audience+subject
// within the same minute (a single fan-out). Inbound replies never consolidate.
function consolidateEmailRows(rows) {
  const groups = new Map();
  const out = [];
  for (const r of rows) {
    const shaped = emailRowShape(r);
    if (r.direction !== 'outbound') { shaped.recipients = recipientsOfRow(r); shaped.recipient_count = shaped.recipients.length; out.push(shaped); continue; }
    const minute = r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 16) : '';
    const key = [r.thread_key || '', r.msg_type || '', r.audience || '', r.subject || '', minute].join('|');
    let g = groups.get(key);
    if (!g) { g = shaped; g.recipients = []; groups.set(key, g); out.push(g); }
    g.recipients.push(...recipientsOfRow(r));
    // prefer a representative row that actually stored a body, so opening it shows
    // the full designed email (a fan-out stores an identical body on each row).
    if (r.has_body && !g.has_body) { g.id = r.id; g.has_body = true; }
    g.status = worseStatus(g.status, r.status);
    if (r.error && !g.error) g.error = r.error;
    if (new Date(r.occurred_at) > new Date(g.occurred_at)) g.occurred_at = r.occurred_at;
  }
  for (const g of out) {
    if (Array.isArray(g.recipients)) {
      // de-dupe recipients on email, cap for display
      const seen = new Set();
      g.recipients = g.recipients.filter((x) => { const k = x.email || x.name; if (!k || seen.has(k)) return false; seen.add(k); return true; }).slice(0, 60);
      g.recipient_count = g.recipients.length;
      g.to = g.recipients.map((x) => ({ email: x.email, name: x.name }));
    }
  }
  return out;
}

// The DRAW email center folds in two sources beyond PILOT's own emails so the coordinator sees
// EVERYTHING that happened on the draws in one place (owner-directed 2026-07-20): (1) the DocuSign
// "Draw Request & Wire Instructions" form's send/sign lifecycle, and (2) Sitewire's OWN activity events
// (inspector assigned, inspection completed, borrower submitted, lender approved). Sitewire's API does
// NOT expose the actual emails it sends (to the inspector/borrower) — only lifecycle EVENTS with an
// actor + timestamp — so those render as clearly-labeled "From Sitewire" activity rows (the fullest
// their system allows). Returns rows already in the frontend email-row shape, tagged kind:'event'.
const SW_DRAW_EVENT = {
  created: 'Borrower started a draw request',
  submit: 'Borrower submitted a draw request',
  delegate_submit: 'A draw request was submitted',
  inspector_assigned: 'An inspector was assigned',
  inspector_approve: 'The inspection was completed',
  lender_approve: 'The draw was approved',
};
function drawEventRow({ id, source, subject, preview, occurredAt, toName, body }) {
  return {
    id, kind: 'event', source, direction: 'event', type: `${source}_event`,
    subject: subject || '(activity)', preview: preview || '', category: 'draws',
    from_email: null, from_name: source === 'docusign' ? 'DocuSign' : 'Sitewire',
    to: toName ? [{ email: null, name: toName }] : [], reply_to: null,
    recipient_kind: null, recipient_name: toName || null, audience: 'staff',
    status: 'event', error: null, attachments: [], meta: null, reconstructed: false,
    has_body: false, body: body || preview || '', thread_key: id, occurred_at: occurredAt,
    application_id: null,
    recipients: toName ? [{ email: null, name: toName, kind: null, status: 'event' }] : [],
    recipient_count: toName ? 1 : 0, opened_at: null, open_count: 0,
  };
}
async function assembleDrawEventRows(appId) {
  const rows = [];
  const iso = (v) => { try { return new Date(v).toISOString(); } catch (_) { return null; } };
  // (1) DocuSign draw-request/wire form send + sign lifecycle.
  try {
    const envs = (await db.query(
      `SELECT e.id, e.status, e.sent_at, e.delivered_at, e.completed_at, e.declined_at, e.voided_at,
              (SELECT r.name FROM esign_recipients r WHERE r.envelope_row_id = e.id AND r.role = 'borrower'
                ORDER BY r.routing_order LIMIT 1) AS borrower_name
         FROM esign_envelopes e WHERE e.application_id = $1 AND e.purpose = 'draw_request'`, [appId])).rows;
    for (const e of envs) {
      const who = e.borrower_name || 'the borrower';
      if (e.sent_at) rows.push(drawEventRow({ id: `ds:${e.id}:sent`, source: 'docusign', occurredAt: iso(e.sent_at), toName: who, subject: 'Draw Request & Wire Instructions form sent for signature', preview: `Sent to ${who} via DocuSign`, body: `The Draw Request & Wire Instructions form was sent to ${who} for signature through DocuSign.` }));
      if (e.delivered_at) rows.push(drawEventRow({ id: `ds:${e.id}:viewed`, source: 'docusign', occurredAt: iso(e.delivered_at), toName: who, subject: 'Borrower opened the draw request form', preview: `${who} opened the form` }));
      if (e.completed_at) rows.push(drawEventRow({ id: `ds:${e.id}:signed`, source: 'docusign', occurredAt: iso(e.completed_at), toName: who, subject: 'Borrower signed the draw request form', preview: `${who} finished signing — wire instructions captured`, body: `${who} signed the Draw Request & Wire Instructions form. The signed form and the typed wire instructions were captured to the file.` }));
      if (e.declined_at) rows.push(drawEventRow({ id: `ds:${e.id}:declined`, source: 'docusign', occurredAt: iso(e.declined_at), toName: who, subject: 'Borrower declined the draw request form', preview: `${who} declined to sign` }));
      if (e.voided_at) rows.push(drawEventRow({ id: `ds:${e.id}:voided`, source: 'docusign', occurredAt: iso(e.voided_at), subject: 'Draw request form was voided', preview: 'The signing request was voided' }));
    }
  } catch (_) { /* esign tables optional */ }
  // (2) Sitewire's OWN activity events (from the pulled draw_events jsonb).
  try {
    const draws = (await db.query(`SELECT number, sitewire_draw_id, events FROM sitewire_draws WHERE application_id = $1`, [appId])).rows;
    for (const d of draws) {
      const evs = Array.isArray(d.events) ? d.events : [];
      evs.forEach((e, i) => {
        if (!e || !e.occurred_at) return;
        const label = SW_DRAW_EVENT[e.event] || String(e.event || 'activity').replace(/_/g, ' ');
        const actor = String(e.actor_role || e.actor || '').replace(/_/g, ' ').trim();
        rows.push(drawEventRow({
          id: `sw:${d.sitewire_draw_id}:${i}`, source: 'sitewire', occurredAt: iso(e.occurred_at),
          subject: `Draw #${d.number == null ? '—' : d.number} — ${label}`,
          preview: actor ? `From Sitewire · ${actor}` : 'From Sitewire',
          body: `Sitewire activity on draw #${d.number == null ? '—' : d.number}: ${label}.${actor ? ` (by ${actor})` : ''} Sitewire shares the activity it recorded, not the exact email it sent to the inspector or borrower.`,
        }));
      });
    }
  } catch (_) { /* sitewire tables optional */ }
  return rows.filter((r) => r.occurred_at);
}

// Per-file email history (newest first), grouped into threads client-side by
// thread_key. Backfills THIS file's prior history on read so it's always complete.
router.get('/applications/:id/emails', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    await emailLog.ensureFileBackfilled(req.params.id).catch(() => {});
    // scope=draw → the DRAW email center: only draw/scope-of-work alerts (draw%, sow_%)
    // plus every message in those same conversation THREADS (so borrower replies and
    // coordinator follow-ups on a draw email stay attached), AND — folded in below — the
    // DocuSign draw-request form lifecycle + Sitewire's own activity events. The unscoped
    // call returns the file's whole email history (the regular file Email Center) — byte-identical.
    // Order-scoped inbox (#orders): scope=title / scope=insurance shows just that order's
    // emails (order + follow-ups + the vendor's replies), by msg_type prefix + same threads.
    const rawScope = String(req.query.scope || '');
    const drawScope = rawScope === 'draw';
    const orderScope = (rawScope === 'title' || rawScope === 'insurance') ? rawScope : null;
    let scopeSql = '';
    if (drawScope) {
      scopeSql = `AND (em.msg_type LIKE 'draw%' OR em.msg_type LIKE 'sow_%'
             OR (em.thread_key IS NOT NULL AND em.thread_key IN (
                   SELECT thread_key FROM email_messages
                    WHERE application_id = $1 AND thread_key IS NOT NULL
                      AND (msg_type LIKE 'draw%' OR msg_type LIKE 'sow_%'))))`;
    } else if (orderScope) {
      scopeSql = `AND (em.msg_type LIKE '${orderScope}\\_%'
             OR (em.thread_key IS NOT NULL AND em.thread_key IN (
                   SELECT thread_key FROM email_messages
                    WHERE application_id = $1 AND thread_key IS NOT NULL
                      AND msg_type LIKE '${orderScope}\\_%')))`;
    }
    const r = await db.query(
      `SELECT em.id, em.direction, em.msg_type, em.category, em.subject, em.preview,
              em.from_email, em.from_name, em.to_emails, em.reply_to, em.recipient_kind,
              em.audience, em.status, em.error, em.attachments, em.meta, em.reconstructed,
              (em.body_html IS NOT NULL) AS has_body, em.thread_key, em.occurred_at, em.application_id,
              eo.first_opened_at AS opened_at, eo.open_count,
              COALESCE(su.full_name,
                       NULLIF(TRIM(COALESCE(bo.first_name,'') || ' ' || COALESCE(bo.last_name,'')), '')) AS recipient_name
         FROM email_messages em
         LEFT JOIN email_opens eo ON eo.notification_id = em.notification_id
         LEFT JOIN notifications n ON n.id = em.notification_id
         LEFT JOIN staff_users su ON su.id = n.staff_id
         LEFT JOIN borrowers   bo ON bo.id = n.borrower_id
        WHERE em.application_id = $1 ${scopeSql}
        ORDER BY em.occurred_at DESC
        LIMIT 500`, [req.params.id]);
    let out = consolidateEmailRows(r.rows);
    if (drawScope) {
      // Fold in the DocuSign wire-form lifecycle + Sitewire's own activity events, newest first,
      // so the draw email center is the ONE place that shows everything that happened on the draws.
      const extra = await assembleDrawEventRows(req.params.id).catch(() => []);
      out = out.concat(extra).sort((a, b) => new Date(b.occurred_at || 0) - new Date(a.occurred_at || 0));
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Who a reply on this file will reach — the borrower(s) + active assignees, minus
// the viewer. Lets the composer show recipient chips before sending. Declared
// BEFORE /emails/:msgId so 'reply-recipients' isn't read as a message id.
router.get('/applications/:id/emails/reply-recipients', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const meEmail = String(((await db.query(`SELECT lower(email) AS email FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {}).email || '').toLowerCase();
    const r = await db.query(
      `SELECT lower(bo.email) AS email, NULLIF(TRIM(COALESCE(bo.first_name,'')||' '||COALESCE(bo.last_name,'')),'') AS name, 'borrower' AS kind
         FROM applications a JOIN borrowers bo ON bo.id IN (a.borrower_id, a.co_borrower_id)
        WHERE a.id=$1 AND bo.email IS NOT NULL AND btrim(bo.email)<>''
       UNION
       SELECT lower(su.email) AS email, su.full_name AS name, 'staff' AS kind
         FROM application_assignees aa JOIN staff_users su ON su.id=aa.staff_id
        WHERE aa.application_id=$1 AND aa.removed_at IS NULL AND su.is_active=true
          AND su.email IS NOT NULL AND btrim(su.email)<>''`, [req.params.id]);
    res.json(r.rows.filter((p) => p.email && p.email !== meEmail));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Full body of one message. Stored body wins; a lightweight/historical row's body
// is rendered on demand from its linked notification. Scoped to the file.
router.get('/applications/:id/emails/:msgId', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const r = await db.query(
      `SELECT em.*, (em.body_html IS NOT NULL) AS has_body,
              COALESCE(su.full_name,
                       NULLIF(TRIM(COALESCE(bo.first_name,'') || ' ' || COALESCE(bo.last_name,'')), '')) AS recipient_name
         FROM email_messages em
         LEFT JOIN notifications n ON n.id = em.notification_id
         LEFT JOIN staff_users su ON su.id = n.staff_id
         LEFT JOIN borrowers   bo ON bo.id = n.borrower_id
        WHERE em.id = $1 AND em.application_id = $2`, [req.params.msgId, req.params.id]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    const out = emailRowShape({ ...row, has_body: true });
    out.body_html = row.body_html || null;
    out.body_text = row.body_text || null;
    // Historical/lightweight outbound row → re-render the branded body on demand.
    if (!out.body_html && row.direction === 'outbound' && row.notification_id) {
      const built = await emailLog.renderHistoricalBody(row.notification_id).catch(() => null);
      if (built) { out.body_html = built.html; out.body_text = built.text; out.rendered = true; }
    }
    if (!out.body_html && !out.body_text) {
      out.body_unavailable = row.direction === 'inbound'
        ? 'This reply predates archiving — its body was not stored. Newer replies show in full.'
        : 'The full body for this message was not stored.';
    }
    // Mark which attachments have their BYTES stored (the #442 sent_emails capture),
    // so the reader can offer a real download link. Best-effort.
    if (Array.isArray(out.attachments) && out.attachments.length && row.notification_id) {
      try {
        const se = (await db.query(
          `SELECT attachments FROM sent_emails WHERE notification_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`,
          [row.notification_id, req.params.id])).rows[0];
        const bytes = se && Array.isArray(se.attachments) ? se.attachments : [];
        out.attachments = out.attachments.map((a, i) => ({ ...a, downloadable: !!(bytes[i] && bytes[i].storage_ref) }));
      } catch (_) { /* best-effort */ }
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Download one attachment's bytes (stored by the #442 sent_emails capture), keyed
// through the email_messages row → its notification → sent_emails. Staff-scoped.
router.get('/applications/:id/emails/:msgId/attachments/:idx', async (req, res) => {
  const appId = req.params.id;
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!/^[0-9a-f-]{36}$/i.test(String(req.params.msgId)) || !/^\d{1,3}$/.test(String(req.params.idx))) return res.status(404).json({ error: 'not found' });
  try {
    const m = (await db.query(`SELECT notification_id FROM email_messages WHERE id=$1 AND application_id=$2`, [req.params.msgId, appId])).rows[0];
    if (!m || !m.notification_id) return res.status(404).json({ error: 'not found' });
    const e = (await db.query(
      `SELECT attachments FROM sent_emails WHERE notification_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`,
      [m.notification_id, appId])).rows[0];
    const a = e && Array.isArray(e.attachments) ? e.attachments[Number(req.params.idx)] : null;
    if (!a || !a.storage_ref) return res.status(404).json({ error: 'attachment not available' });
    let buf; try { buf = await storage.read(a.storage_ref); } catch (_) { buf = null; }
    if (!buf) return res.status(404).json({ error: 'attachment bytes missing' });
    // Sanitize the stored content-type before it becomes a response header (defense
    // in depth — a header with illegal chars would otherwise throw a 500).
    const ct = String(a.content_type || a.contentType || 'application/octet-stream').replace(/[^\w.+/-]/g, '').slice(0, 100) || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Disposition', `attachment; filename="${String(a.filename || 'attachment').replace(/[^\w.\- ]+/g, '_')}"`);
    res.send(buf);
  } catch (err) { res.status(500).json({ error: 'Could not download this attachment.' }); }
});

// Resend a FILE email — troubleshoot a failed/in-app-only send by re-delivering the
// exact rendered email to its original recipients (re-attaching stored bytes when
// available). Outbound only; captured into the history as a fresh message.
router.post('/applications/:id/emails/:msgId/resend', async (req, res) => {
  const appId = req.params.id;
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const row = (await db.query(`SELECT * FROM email_messages WHERE id=$1 AND application_id=$2`, [req.params.msgId, appId])).rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    if (row.direction !== 'outbound') return res.status(400).json({ error: 'Only an outgoing email can be resent.' });
    const to = (Array.isArray(row.to_emails) ? row.to_emails : []).map((t) => t && t.email).filter(Boolean);
    if (!to.length) return res.status(400).json({ error: 'This message has no recipient to resend to.' });
    let html = row.body_html, text = row.body_text, subject = row.subject;
    if (!html && row.notification_id) {
      const built = await emailLog.renderHistoricalBody(row.notification_id).catch(() => null);
      if (built) { html = built.html; text = built.text; subject = subject || built.subject; }
    }
    if (!html && !text) return res.status(400).json({ error: 'The full email could not be rebuilt to resend.' });
    // Re-attach the original bytes when the #442 capture stored them.
    let attachments = [];
    if (row.notification_id) {
      try {
        const se = (await db.query(`SELECT attachments FROM sent_emails WHERE notification_id=$1 AND application_id=$2 ORDER BY created_at DESC LIMIT 1`, [row.notification_id, appId])).rows[0];
        for (const a of (se && Array.isArray(se.attachments) ? se.attachments : [])) {
          if (!a || !a.storage_ref) continue;
          try { const buf = await storage.read(a.storage_ref); if (buf) attachments.push({ filename: a.filename, contentType: a.content_type || a.contentType, content: buf.toString('base64') }); } catch (_) { /* skip */ }
        }
      } catch (_) { /* best-effort */ }
    }
    await email.sendMail({
      to, subject, html, text, attachments,
      replyTo: fileReplyTo(appId) || cfg.replyToDefault || null,
      _ctx: { applicationId: appId, type: 'resend', audience: row.audience || 'staff' },
    });
    await audit(req, 'email_resent', 'application', appId, { to: to.length, subject });
    res.json({ ok: true, sent_to: to });
  } catch (e) { res.status(500).json({ error: 'Could not resend this email.' }); }
});

// Reply from the Email Center. Sends a branded email to the file's parties (the
// borrower(s) + the other active assignees, minus the sender) — or an explicit
// recipient list — on the shared file thread, and captures it into the history.
router.post('/applications/:id/emails/reply', async (req, res) => {
  const appId = req.params.id;
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  const bodyText = String((req.body && req.body.body) || '').trim();
  if (!bodyText) return res.status(400).json({ error: 'Type a message to send.' });
  try {
    const ctx = await notify.fileContext(appId).catch(() => null);
    // The acting staffer's own email/name (req.actor carries only id/role/perms).
    const meRow = (await db.query(`SELECT lower(email) AS email, full_name FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    // Recipient set: an explicit list (validated as file parties) or the default
    // fan-out = borrower(s) + active assignees, minus the acting staffer.
    const partyRows = await db.query(
      `SELECT lower(bo.email) AS email, 'borrower' AS kind
         FROM applications a
         JOIN borrowers bo ON bo.id IN (a.borrower_id, a.co_borrower_id)
        WHERE a.id=$1 AND bo.email IS NOT NULL AND btrim(bo.email)<>''
       UNION
       SELECT lower(su.email) AS email, 'staff' AS kind
         FROM application_assignees aa
         JOIN staff_users su ON su.id=aa.staff_id
        WHERE aa.application_id=$1 AND aa.removed_at IS NULL AND su.is_active=true
          AND su.email IS NOT NULL AND btrim(su.email)<>''`, [appId]);
    const meEmail = String(meRow.email || '').trim().toLowerCase();
    const parties = partyRows.rows.filter((p) => p.email && p.email !== meEmail);
    let recipients = parties;
    if (Array.isArray(req.body.to) && req.body.to.length) {
      const want = new Set(req.body.to.map((e) => String(e).trim().toLowerCase()));
      recipients = parties.filter((p) => want.has(p.email));   // only ever real file parties
    }
    if (!recipients.length) return res.status(400).json({ error: 'No one on this file to send to. Add the borrower or an assignee first.' });
    const toEmails = recipients.map((r) => r.email);
    const anyBorrower = recipients.some((r) => r.kind === 'borrower');
    const audience = anyBorrower ? 'borrower' : 'staff';
    // Borrower-safe (frozen rule): the reply builds the borrower email directly
    // (not via notifyBorrower), so we scrub a note-buyer/capital-partner name a
    // staffer might type in the SUBJECT *and* the body before it can reach a
    // borrower. Protect the file's own clean data from the scrub using the
    // BORROWER-safe meta (borrowerMeta already scrubs the program label) — never
    // the staff `meta`, whose raw program value could shield a partner name.
    const protectSrc = anyBorrower ? (ctx && ctx.borrowerMeta) : (ctx && ctx.meta);
    const protect = Array.isArray(protectSrc) ? protectSrc.map((m) => m && m.value).filter((v) => typeof v === 'string') : [];
    const safeBody = anyBorrower ? scrubTextExcept(bodyText, protect) : bodyText;
    const rawSubject = String((req.body && req.body.subject) || '').trim();
    const safeSubject = anyBorrower ? scrubTextExcept(rawSubject, protect) : rawSubject;
    const subject = (safeSubject || (ctx ? `Re: ${ctx.loanNo}` : 'Re: your loan file')).slice(0, 200);
    // Split the typed reply into paragraphs: the first is the intro (body), the
    // rest render as additional lines — never both, so the text isn't duplicated.
    const paras = safeBody.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    const built = notify.buildEmail({
      title: subject.replace(/^\s*re:\s*/i, '') || 'A message from your loan team',
      body: paras[0] || safeBody,
      lines: paras.slice(1),
      applicationId: appId,
      subjectTag: ctx ? ctx.subjectTag : '',
      link: audience === 'borrower' ? `/app/${appId}` : `/internal/app/${appId}`,
      ctaLabel: audience === 'borrower' ? 'Open your file' : 'Open the loan file',
      replyable: true,
    }, audience);
    // From the officer by name so the reply reads as a person, not a robot.
    const fromName = email.fromWithName ? email.fromWithName(meRow.full_name || meRow.email) : null;
    // A reply/compose sent FROM the draw email center is tagged 'draw_message' so it
    // stays visible in that draw-scoped inbox (which filters on draw%/sow_% types);
    // a normal file reply keeps 'staff_reply'. Cosmetic tag only — same delivery.
    const scopeIn = String((req.body && req.body.scope) || '');
    const replyType = scopeIn === 'draw' ? 'draw_message'
      : scopeIn === 'title' ? 'title_message'
      : scopeIn === 'insurance' ? 'insurance_message'
      : 'staff_reply';
    await email.sendMail({
      to: toEmails, subject: built.subject, html: built.html, text: built.text,
      replyTo: fileReplyTo(appId) || cfg.replyToDefault || null,
      from: fromName || undefined,
      _ctx: { applicationId: appId, type: replyType, audience },
    });
    await audit(req, 'email_reply_sent', 'application', appId, { to: toEmails.length, subject });
    res.json({ ok: true, sent_to: toEmails });
  } catch (e) { res.status(500).json({ error: 'Could not send the reply.' }); }
});

/* ═══════════════════════════════ ORDERS DESK (#orders) ═══════════════════════
   Title + insurance orders for a file. An order can only be placed once the file
   has its LOAN NUMBER (the mortgagee clause needs it) and a vendor CONTACT (the
   title company / insurance agent). The order emails the vendor with the
   borrower, loan officer and processor CC'd and a unique per-order reply-to, so
   the vendor's reply + any returned documents route back to the right order.
   A follow-up is a separate message on the same thread; the order itself won't
   re-send unless the caller forces it. Returned documents land as unassigned
   documents for the team to classify. Uses the orders lib for all email building.
   ═══════════════════════════════════════════════════════════════════════════ */
const orders = require('../lib/orders');
const { orderReplyTo } = require('../lib/file-address');
const ORDER_RETURN_KIND = { title: 'title_order_return', insurance: 'insurance_order_return' };
const ORDER_SLOTS = {
  title: ['Title Commitment', 'CPL', 'Tax Certificate', 'Wiring Instructions', 'Preliminary Settlement Statement', 'Other'],
  insurance: ['Binder', 'Invoice', 'Quote', 'Declaration Page', 'Other'],
};

function isOrderKind(k) { return k === 'title' || k === 'insurance'; }

// The whole Orders section for a file: both orders' state, whether each can be
// placed (blockers), the vendor on file, and the returned documents waiting to be
// classified. One call powers the panel.
router.get('/applications/:id/orders', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  try {
    const data = await orders.getOrderData(req.params.id);
    if (!data) return res.status(404).json({ error: 'not found' });
    const rows = (await db.query(
      `SELECT order_type, status, vendor_name, vendor_email, ordered_at, last_followup_at,
              followup_count, send_count
         FROM file_orders WHERE application_id=$1`, [req.params.id])).rows;
    const orderOf = (k) => rows.find((r) => r.order_type === k) || null;
    // Returned documents per order (unassigned = no slot_label yet).
    const docs = (await db.query(
      `SELECT id, doc_kind, filename, slot_label, review_status, is_current, size_bytes, created_at
         FROM documents
        WHERE application_id=$1 AND doc_kind = ANY($2::text[])
        ORDER BY created_at DESC`,
      [req.params.id, Object.values(ORDER_RETURN_KIND)])).rows;
    const docsFor = (k) => docs.filter((d) => d.doc_kind === ORDER_RETURN_KIND[k] && d.is_current !== false);
    // The real document condition each order files into (rtl_cond_title /
    // rtl_cond_insurance) — so the panel can show where returned docs land + its
    // current status.
    const CONDITION_CODE = { title: 'rtl_cond_title', insurance: 'rtl_cond_insurance' };
    const conds = (await db.query(
      `SELECT ci.id, ci.status, t.code, t.label
         FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id
        WHERE ci.application_id=$1 AND t.code = ANY($2::text[])`,
      [req.params.id, Object.values(CONDITION_CODE)])).rows;
    const condOf = (k) => conds.find((c) => c.code === CONDITION_CODE[k]) || null;

    const shape = (k) => {
      const row = orderOf(k);
      const vendor = data.vendors[k];
      const cond = condOf(k);
      return {
        orderType: k,
        status: row ? row.status : 'not_ordered',
        blockers: orders.blockers(k, data),
        vendor: vendor ? { id: vendor.id, name: vendor.company_name || vendor.contact_name, email: vendor.email, phone: vendor.phone, contactName: vendor.contact_name } : null,
        orderedAt: row ? row.ordered_at : null,
        lastFollowupAt: row ? row.last_followup_at : null,
        followupCount: row ? row.followup_count : 0,
        sendCount: row ? row.send_count : 0,
        slots: ORDER_SLOTS[k],
        condition: cond ? { label: cond.label, status: cond.status } : null,
        returnedDocs: docsFor(k),
      };
    };
    // Who an order will reach, so the panel can show it before sending.
    const recipientsPreview = (k) => {
      const { to, cc } = orders.recipientsFor(k, data);
      return { to, cc };
    };
    res.json({
      file: {
        loanNumber: data.loanNumber, hasLoanNumber: data.hasLoanNumber,
        propertyLine: data.propertyLine, borrowerName: data.borrowerName,
        borrowerEmail: data.borrowerEmail, coBorrowerEmail: data.coBorrowerEmail,
        officer: data.officer, processor: data.processor,
      },
      orders: {
        title: { ...shape('title'), recipients: recipientsPreview('title') },
        insurance: { ...shape('insurance'), recipients: recipientsPreview('insurance') },
      },
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Place (send) an order. Gated on loan number + vendor contact. Re-sending an
// already-placed order requires ?force / {force:true} so a stray double-click
// never re-blasts the vendor + whole CC chain.
router.post('/applications/:id/orders/:kind/place', async (req, res) => {
  const appId = req.params.id;
  const kind = req.params.kind;
  if (!isOrderKind(kind)) return res.status(400).json({ error: 'unknown order type' });
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const data = await orders.getOrderData(appId);
    if (!data) return res.status(404).json({ error: 'not found' });
    const blk = orders.blockers(kind, data);
    if (blk.includes('loan_number')) return res.status(400).json({ error: 'Add the file’s loan number first — it prints in the mortgage clause.', code: 'loan_number' });
    if (blk.includes('contact')) return res.status(400).json({ error: `Add the ${kind === 'title' ? 'title company' : 'insurance agent'} contact first.`, code: 'contact' });

    const existing = (await db.query(`SELECT status, send_count FROM file_orders WHERE application_id=$1 AND order_type=$2`, [appId, kind])).rows[0];
    const force = req.body && (req.body.force === true || req.body.force === 'true');
    if (existing && existing.status !== 'not_ordered' && existing.status !== 'cancelled' && !force) {
      return res.status(409).json({ error: `This ${kind} order was already sent. Use Follow-up, or force a re-send.`, code: 'already_ordered' });
    }

    const built = orders.buildOrderEmail(kind, data, {});
    const { to, cc, replyTo } = orders.recipientsFor(kind, data);
    const meRow = (await db.query(`SELECT full_name, email FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    await email.sendMail({
      to, cc,
      subject: built.subject, html: built.html, text: built.text,
      replyTo: replyTo || fileReplyTo(appId) || cfg.replyToDefault || null,
      from: email.fromWithName ? email.fromWithName(meRow.full_name || meRow.email) : undefined,
      _ctx: { applicationId: appId, type: `${kind}_order`, audience: 'staff' },
    });
    const vendor = data.vendors[kind];
    await db.query(
      `INSERT INTO file_orders (application_id, order_type, status, vendor_contact_id, vendor_email, vendor_name, subject, ordered_at, ordered_by, send_count)
       VALUES ($1,$2,'ordered',$3,$4,$5,$6,now(),$7,1)
       ON CONFLICT (application_id, order_type)
       DO UPDATE SET status='ordered', vendor_contact_id=EXCLUDED.vendor_contact_id, vendor_email=EXCLUDED.vendor_email,
                     vendor_name=EXCLUDED.vendor_name, subject=EXCLUDED.subject, ordered_at=now(),
                     ordered_by=EXCLUDED.ordered_by, send_count=file_orders.send_count+1, updated_at=now()`,
      [appId, kind, vendor ? vendor.id : null, (vendor && vendor.email) || null,
       (vendor && (vendor.company_name || vendor.contact_name)) || null, built.subject, req.actor.id]);
    await audit(req, 'order_placed', 'application', appId, { kind, to: to.length, cc: cc.length, force: !!force });
    res.json({ ok: true, sent_to: to, cc });
  } catch (e) { res.status(500).json({ error: 'Could not send the order.' }); }
});

// Send a follow-up on an existing order (same thread, to the vendor + CC chain).
// Never the first contact — the order must already be placed.
router.post('/applications/:id/orders/:kind/followup', async (req, res) => {
  const appId = req.params.id;
  const kind = req.params.kind;
  if (!isOrderKind(kind)) return res.status(400).json({ error: 'unknown order type' });
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const row = (await db.query(`SELECT status FROM file_orders WHERE application_id=$1 AND order_type=$2`, [appId, kind])).rows[0];
    if (!row || row.status === 'not_ordered' || row.status === 'cancelled') {
      return res.status(400).json({ error: 'Place the order before following up.', code: 'not_ordered' });
    }
    const data = await orders.getOrderData(appId);
    if (!data) return res.status(404).json({ error: 'not found' });
    if (!data.vendors[kind] || !data.vendors[kind].email) return res.status(400).json({ error: 'The vendor contact is missing.', code: 'contact' });
    const note = String((req.body && req.body.message) || '').trim().slice(0, 4000);
    const built = orders.buildOrderEmail(kind, data, { followup: true, note });
    const { to, cc, replyTo } = orders.recipientsFor(kind, data);
    const meRow = (await db.query(`SELECT full_name, email FROM staff_users WHERE id=$1`, [req.actor.id])).rows[0] || {};
    await email.sendMail({
      to, cc,
      subject: built.subject, html: built.html, text: built.text,
      replyTo: replyTo || fileReplyTo(appId) || cfg.replyToDefault || null,
      from: email.fromWithName ? email.fromWithName(meRow.full_name || meRow.email) : undefined,
      _ctx: { applicationId: appId, type: `${kind}_followup`, audience: 'staff' },
    });
    await db.query(
      `UPDATE file_orders SET followup_count=followup_count+1, last_followup_at=now(), updated_at=now()
        WHERE application_id=$1 AND order_type=$2`, [appId, kind]);
    await audit(req, 'order_followup', 'application', appId, { kind, to: to.length });
    res.json({ ok: true, sent_to: to, cc });
  } catch (e) { res.status(500).json({ error: 'Could not send the follow-up.' }); }
});

// Classify a returned document (assign it to a slot: binder / invoice / …) — the
// "assign what came back" step. slot_label='' clears it back to unassigned.
router.post('/applications/:id/orders/:kind/documents/:docId/classify', async (req, res) => {
  const appId = req.params.id;
  const kind = req.params.kind;
  if (!isOrderKind(kind)) return res.status(400).json({ error: 'unknown order type' });
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  if (!UUID_RE.test(String(req.params.docId))) return res.status(404).json({ error: 'not found' });
  try {
    const slotRaw = String((req.body && req.body.slot) || '').trim().slice(0, 80);
    const allowed = new Set(ORDER_SLOTS[kind]);
    // Empty clears back to unassigned; anything else must be one of this order's
    // known slots (Binder / Invoice / Title Commitment / …) — an unknown label is
    // rejected rather than stored as free text.
    if (slotRaw && !allowed.has(slotRaw)) return res.status(400).json({ error: 'Choose one of the listed document types.', code: 'bad_slot' });
    const slot = slotRaw || null;
    const upd = await db.query(
      `UPDATE documents SET slot_label=$4
        WHERE id=$1 AND application_id=$2 AND doc_kind=$3 RETURNING id`,
      [req.params.docId, appId, ORDER_RETURN_KIND[kind], slot]);
    if (!upd.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'order_doc_classified', 'application', appId, { kind, slot: slot || 'unassigned' });
    res.json({ ok: true, slot });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Cancel an order (or reopen a cancelled one). Cancelling frees it to be
// re-ordered from scratch (the place gate treats 'cancelled' like 'not_ordered').
router.post('/applications/:id/orders/:kind/cancel', async (req, res) => {
  const appId = req.params.id;
  const kind = req.params.kind;
  if (!isOrderKind(kind)) return res.status(400).json({ error: 'unknown order type' });
  if (!(await canTouchApp(req, appId))) return res.status(403).json({ error: 'forbidden' });
  try {
    const reopen = req.body && (req.body.reopen === true || req.body.reopen === 'true');
    const next = reopen ? 'ordered' : 'cancelled';
    const upd = await db.query(
      `UPDATE file_orders SET status=$3, updated_at=now()
        WHERE application_id=$1 AND order_type=$2 RETURNING status`, [appId, kind, next]);
    if (!upd.rows[0]) return res.status(404).json({ error: 'This order has not been created yet.' });
    await audit(req, reopen ? 'order_reopened' : 'order_cancelled', 'application', appId, { kind });
    res.json({ ok: true, status: upd.rows[0].status });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// GLOBAL ORDERS QUEUE — every title/insurance order across the files the viewer
// can see, so a processor can track all orders (and what's waiting to be
// classified) in one place. Scoped like every other cross-file view.
router.get('/orders', async (req, res) => {
  try {
    const params = [];
    let scopeSql = '';
    if (!seesAll(req)) { params.push(req.actor.id); scopeSql = `AND ${VISIBLE_OFFICERS_SQL('a', '$1')}`; }
    const r = await db.query(
      `SELECT a.id AS application_id, a.ys_loan_number, a.property_address, a.status AS file_status,
              b.first_name, b.last_name,
              o.order_type, o.status, o.vendor_name, o.ordered_at, o.last_followup_at, o.followup_count,
              COALESCE(dc.unassigned, 0)::int AS unassigned_docs, COALESCE(dc.total, 0)::int AS returned_docs
         FROM file_orders o
         JOIN applications a ON a.id = o.application_id AND a.deleted_at IS NULL
         JOIN borrowers b ON b.id = a.borrower_id
         LEFT JOIN LATERAL (
           SELECT count(*) FILTER (WHERE slot_label IS NULL) AS unassigned, count(*) AS total
             FROM documents d
            WHERE d.application_id = o.application_id AND d.is_current = true
              AND d.doc_kind = CASE o.order_type WHEN 'title' THEN 'title_order_return' ELSE 'insurance_order_return' END
         ) dc ON true
        WHERE o.status <> 'cancelled' ${scopeSql}
        ORDER BY (COALESCE(dc.unassigned, 0) > 0) DESC, o.ordered_at DESC NULLS LAST`, params);
    // Group into one row per file with a title + insurance sub-object.
    const byFile = new Map();
    for (const row of r.rows) {
      if (!byFile.has(row.application_id)) {
        byFile.set(row.application_id, {
          applicationId: row.application_id, loanNumber: row.ys_loan_number,
          propertyAddress: row.property_address, fileStatus: row.file_status,
          borrowerName: [row.first_name, row.last_name].filter(Boolean).join(' '),
          title: null, insurance: null,
        });
      }
      const f = byFile.get(row.application_id);
      f[row.order_type] = {
        status: row.status, vendorName: row.vendor_name, orderedAt: row.ordered_at,
        lastFollowupAt: row.last_followup_at, followupCount: row.followup_count,
        unassignedDocs: row.unassigned_docs, returnedDocs: row.returned_docs,
      };
    }
    res.json([...byFile.values()]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// A short "which file" label for a mailbox row (loan# · street · borrower).
function fileLabelOf(r) {
  const pa = r.property_address || {};
  const street = pa.street || pa.line1 || (typeof pa.oneLine === 'string' ? pa.oneLine.split(',')[0] : '') || '';
  const borrower = [r.b_first, r.b_last].filter(Boolean).join(' ');
  return [r.ys_loan_number, street, borrower].filter(Boolean).join(' · ') || null;
}

// GLOBAL MAILBOX — every email across the files the viewer can see (admins /
// underwriters: all; loan officers / processors: only their assigned files).
// This is the portal-wide audit view the owner asked for: filter by delivery
// status (troubleshoot failures), direction, category, or a text search over
// subject / sender / recipients. Newest first, paginated.
router.get('/emails/stats', async (req, res) => {
  try {
    const params = [];
    let scope = '';
    if (!seesAll(req)) {
      params.push(req.actor.id);
      scope = `WHERE em.application_id IS NOT NULL AND EXISTS (SELECT 1 FROM applications a
                 WHERE a.id=em.application_id AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$1')})`;
    }
    const r = await db.query(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE em.direction='outbound' AND em.status='sent')::int AS sent,
         count(*) FILTER (WHERE em.direction='outbound' AND em.status='skipped')::int AS in_app_only,
         count(*) FILTER (WHERE em.direction='outbound' AND em.status='error')::int AS failed,
         count(*) FILTER (WHERE em.direction='inbound')::int AS inbound,
         count(*) FILTER (WHERE em.occurred_at > now() - interval '7 days')::int AS last_7d
       FROM email_messages em ${scope}`, params);
    res.json(r.rows[0] || {});
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.get('/emails', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (!seesAll(req)) {
      params.push(req.actor.id);
      where.push(`em.application_id IS NOT NULL AND EXISTS (SELECT 1 FROM applications a
                    WHERE a.id=em.application_id AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$' + params.length)})`);
    }
    const dir = String(req.query.direction || '');
    if (dir === 'inbound' || dir === 'outbound') { params.push(dir); where.push(`em.direction=$${params.length}`); }
    const status = String(req.query.status || '');
    if (status === 'sent' || status === 'skipped' || status === 'error') { params.push(status); where.push(`em.status=$${params.length}`); }
    else if (status === 'issues') { where.push(`em.status IN ('error','no_recipients','failed_permanent','retrieval_failed','forward_failed','lookup_failed')`); }
    const category = String(req.query.category || '');
    if (category) { params.push(category); where.push(`em.category=$${params.length}`); }
    const q = String(req.query.q || '').trim();
    if (q) {
      params.push('%' + q.replace(/[%_]/g, (m) => '\\' + m) + '%');
      const i = params.length;
      where.push(`(em.subject ILIKE $${i} OR em.preview ILIKE $${i} OR em.from_email ILIKE $${i} OR em.to_emails::text ILIKE $${i})`);
    }
    const limit = Math.min(200, intField(req.query.limit) || 60);
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    params.push(limit); const limIdx = params.length;
    params.push(offset); const offIdx = params.length;
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const r = await db.query(
      `SELECT em.id, em.direction, em.msg_type, em.category, em.subject, em.preview,
              em.from_email, em.from_name, em.to_emails, em.reply_to, em.recipient_kind,
              em.audience, em.status, em.error, em.attachments, em.meta, em.reconstructed,
              (em.body_html IS NOT NULL) AS has_body, em.thread_key, em.occurred_at, em.application_id,
              eo.first_opened_at AS opened_at, eo.open_count,
              a.ys_loan_number, a.property_address, b.first_name AS b_first, b.last_name AS b_last,
              COALESCE(su.full_name,
                       NULLIF(TRIM(COALESCE(bo.first_name,'') || ' ' || COALESCE(bo.last_name,'')), '')) AS recipient_name
         FROM email_messages em
         LEFT JOIN applications a ON a.id = em.application_id
         LEFT JOIN borrowers   b ON b.id = a.borrower_id
         LEFT JOIN email_opens eo ON eo.notification_id = em.notification_id
         LEFT JOIN notifications n ON n.id = em.notification_id
         LEFT JOIN staff_users su ON su.id = n.staff_id
         LEFT JOIN borrowers   bo ON bo.id = n.borrower_id
         ${whereSql}
        ORDER BY em.occurred_at DESC
        LIMIT $${limIdx} OFFSET $${offIdx}`, params);
    res.json(consolidateEmailRows(r.rows.map((row) => ({ ...row, file_label: fileLabelOf(row) }))));
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Full body of one message from the GLOBAL mailbox (scoped to a file the viewer
// can see). Renders a historical row's body on demand, same as the per-file view.
router.get('/emails/:msgId', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT em.*, a.ys_loan_number, a.property_address, b.first_name AS b_first, b.last_name AS b_last,
              COALESCE(su.full_name,
                       NULLIF(TRIM(COALESCE(bo.first_name,'') || ' ' || COALESCE(bo.last_name,'')), '')) AS recipient_name
         FROM email_messages em
         LEFT JOIN applications a ON a.id = em.application_id
         LEFT JOIN borrowers   b ON b.id = a.borrower_id
         LEFT JOIN notifications n ON n.id = em.notification_id
         LEFT JOIN staff_users su ON su.id = n.staff_id
         LEFT JOIN borrowers   bo ON bo.id = n.borrower_id
        WHERE em.id = $1`, [req.params.msgId]);
    const row = r.rows[0];
    if (!row) return res.status(404).json({ error: 'not found' });
    // Authorize: a file-scoped message requires touch access; a non-file (system)
    // message is admins-only.
    if (row.application_id) { if (!(await canTouchApp(req, row.application_id))) return res.status(403).json({ error: 'forbidden' }); }
    else if (!seesAll(req)) return res.status(403).json({ error: 'forbidden' });
    const out = { ...emailRowShape(row), file_label: fileLabelOf(row) };
    out.body_html = row.body_html || null;
    out.body_text = row.body_text || null;
    if (!out.body_html && row.direction === 'outbound' && row.notification_id) {
      const built = await emailLog.renderHistoricalBody(row.notification_id).catch(() => null);
      if (built) { out.body_html = built.html; out.body_text = built.text; out.rendered = true; }
    }
    if (!out.body_html && !out.body_text) {
      out.body_unavailable = row.direction === 'inbound'
        ? 'This reply predates archiving — its body was not stored. Newer replies show in full.'
        : 'The full body for this message was not stored.';
    }
    res.json(out);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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
            type: 'condition_added', title: 'A new item needs your attention', badge: { text: 'Action needed', tone: 'action' },
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
    return res.status(403).json({ error: 'Only a processor or underwriter can sign a condition off — click Done to record your completion; the back office signs off after you.' });
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
    // #84 — once a file is clear-to-close / funded its economics are frozen, so even
    // an APPROVED change may not be written onto it (a super_admin can unlock the
    // file to make the correction). Without this the CR-approve path is another door
    // around the funded freeze.
    // The funded / clear-to-close structural freeze is ECONOMICS-only. A personal
    // identity correction (name / DOB / SSN / phone / …) is not loan structure, so it
    // must NOT be blocked by it — only an applications-entity (economics) change
    // re-checks the freeze here.
    if (cr.target_table !== 'borrowers') {
      const crLock = await require('../lib/file-lock').structuralLockReason(cr.application_id, client, { actor: req.actor });
      if (crLock) { await client.query('ROLLBACK'); return res.status(409).json({ error: crLock, locked: true }); }
    }
    const applied = await changeRequests.applyRequest(client, cr, req.actor.id, note);
    await client.query('COMMIT');
    // Propagate the approved value to ClickUp (#86). The governed economics fields
    // are all mapped dir:'both', so ClickUp still holds the STALE pre-approval
    // value — without this push the next inbound pull COALESCEs that stale value
    // back over the approved one and silently REVERTS the change, and the
    // still-locked borrower re-requests it forever ("re-appears after approving
    // multiple times"). Every other governed-field write path already enqueues
    // its touched columns; the CR-approve path was the one that forgot. Must run
    // AFTER COMMIT so the sync worker reads the committed value, not the stale one.
    if (applied.entity === 'borrowers') {
      // A personal change updates the SHARED borrower row — propagate to EVERY file
      // where this borrower is the PRIMARY (their personal fields map to that task's
      // primary-borrower fields), and a DOB rides as a HUMAN edit so the outbound DOB
      // gate honors this explicit staff approval rather than treating it as an
      // automated overwrite it would park for review.
      try {
        const bfiles = await db.query(
          `SELECT id FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`,
          [applied.borrowerId]);
        const pushOpts = applied.field === 'date_of_birth' ? { humanEditKeys: ['date_of_birth'] } : {};
        for (const row of bfiles.rows) enqueueClickupPush(row.id, [applied.field], pushOpts).catch(() => {});
      } catch (_) { /* best-effort propagation */ }
    } else {
      enqueueClickupPush(cr.application_id, [applied.field]).catch(() => {});
    }
    // The change is already committed — never let the audit/notify below turn a
    // successful apply into a 500.
    try {
      await audit(req, 'approve_change_request', 'application', cr.application_id,
        { field: applied.field, from: applied.oldValue, to: applied.newValue });
    } catch (_) {}
    // Tell the borrower their requested change was accepted (borrower-safe copy),
    // spelling out the exact before → after that is now on file.
    try {
      const change = changeRequests.describeChange(cr);
      await notify.notifyAppBorrowers(cr.application_id, {
        type: 'change_request', title: 'Your requested change was approved', badge: { text: 'Approved', tone: 'positive' },
        body: `Your loan team approved your update to ${cr.field_label}. ${change} is now on file.`,
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
    const cr = (await db.query(`SELECT application_id, field, field_label, old_value, new_value, status FROM change_requests WHERE id=$1`, [req.params.cid])).rows[0];
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
      const change = changeRequests.describeChange(cr);
      await notify.notifyAppBorrowers(cr.application_id, {
        type: 'change_request', title: 'Update on your requested change', badge: { text: 'Reviewed', tone: 'neutral' },
        body: `Your loan team reviewed your requested change (${change}) and it was not applied${note ? `: ${note}` : '. Reach out if you have questions.'}`,
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
    `SELECT ci.application_id, ci.borrower_id, ci.tool_key, ci.tool_payload, ci.item_kind, ci.is_required,
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
  const isAppraisalDocs = code === 'rtl_cond_appraisaldocs';   // two slots: XML + PDF
  const isAppraisalReview = code === 'appraisal_review_cleared'; // CTC gate: no open fatal finding
  const isUnderwritingReview = code === 'underwriting_review_cleared'; // CTC gate: no open fatal document finding
  // Structured-DATA conditions — the borrower/staff enter DATA (not a document):
  // the appraisal payment card, and the title / insurance contact forms.
  const isApprCard = item.tool_key === 'appraisal_card' || code === 'rtl_p1_apprcard';
  const isTitleContact = item.tool_key === 'title_contact' || code === 'rtl_p1_titlec';
  const isInsContact = item.tool_key === 'insurance_contact' || code === 'rtl_p1_insc';

  // Doc-gate: a REQUIRED document-upload condition can never be signed off with
  // ZERO documents on it — the sign-off would attest to a file that isn't there.
  // Applies to EVERYONE with no exception (owner-directed 2026-07-20: an admin
  // signing off the government-ID condition with nothing uploaded is a "major
  // fatal" — the previous super_admin override is REMOVED; no role may bypass a
  // required condition's fulfillment). Tool-backed conditions (product / budget /
  // experience / appraisal card / title+insurance contact) are verified by their
  // own rules below, and the entity-fulfilled LLC condition is verified from the
  // linked LLC — those are exempt. Insurance/title/fraud have stricter slot rules
  // handled just below (and return before reaching here).
  // An OPTIONAL document condition (is_required=false — e.g. the Investor
  // Structure Printout) may still be signed off with nothing uploaded: "optional"
  // means the file can complete without it (matches the Waive affordance).
  if (item.item_kind === 'document' && !item.tool_key && item.is_required !== false
      && code !== 'rtl_p1_llc' && !isInsurance && !isTitle && !isFraud && !isAppraisalDocs) {
    const has = await db.query(
      `SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current
         AND COALESCE(review_status,'') <> 'rejected' LIMIT 1`, [itemId]);
    if (!has.rows.length) {
      // Government-ID REUSE exception: the photo ID is collected ONCE on the
      // borrower profile and reused across every file (borrower.js). On files
      // other than the one it was uploaded to, this condition carries NO document
      // linked to its own item — the ID lives on borrowers.photo_id_document_id,
      // and the reuse logic marks the item 'received' without a per-file doc. So a
      // strict "must have a doc on THIS item" gate would falsely block a reused
      // gov-ID. Accept the borrower's on-file photo ID as fulfillment (mirrors the
      // reuse rule, which keys off the file's borrower's photo_id_document_id).
      if (code === 'rtl_p1_id' || code === 'gov_id') {
        // The on-file photo ID must itself be a CURRENT, non-rejected document —
        // a rejected/superseded ID pointer is not fulfillment (the pointer is only
        // cleared by FK-on-delete, so reject alone leaves it dangling).
        const pid = await db.query(
          `SELECT 1 FROM borrowers b
             JOIN documents d ON d.id = b.photo_id_document_id
            WHERE d.is_current AND COALESCE(d.review_status,'') <> 'rejected'
              AND (b.id = $1 OR b.id = (SELECT borrower_id FROM applications WHERE id = $2))
            LIMIT 1`, [item.borrower_id || null, item.application_id || null]);
        if (pid.rows.length) return null;
      }
      return 'Upload a document to this condition before signing it off — a document-based condition cannot be completed with nothing uploaded.';
    }
  }

  // Document-gated conditions: cannot be signed off until the required upload(s)
  // are present on the item (current, non-rejected versions). slot_label carries
  // the slot key/label, so a case-insensitive substring identifies each slot.
  if (isInsurance || isTitle || isFraud || isAppraisalDocs) {
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
    if (isAppraisalDocs) {
      if (!hasSlot('xml') || !hasSlot('pdf'))
        return 'Upload BOTH the appraisal data file (XML) and the appraisal report (PDF) before signing off — this condition cannot be completed without both.';
      // The XML must have actually IMPORTED. If PILOT could not read the dropped file as a valid
      // appraisal, no `appraisal_review_cleared` condition is ever materialized — and without it the
      // whole PILOT findings engine (the fatal-finding clear-to-close gate) is silently skipped for
      // this file. A successful import always creates a current appraisals row AND that condition,
      // so require the row to exist before letting this document condition be signed off.
      const imported = (await db.query(
        `SELECT 1 FROM appraisals WHERE application_id=$1 AND superseded=false LIMIT 1`, [item.application_id])).rows[0];
      if (!imported)
        return 'The appraisal data file (XML) has not been read as a valid appraisal yet, so the PILOT appraisal review has not run. Re-upload a valid MISMO appraisal XML (PILOT imports it automatically) before signing off this condition.';
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

  // Appraisal review cleared — the clear-to-close gate. It cannot be signed off while ANY fatal
  // PILOT appraisal finding is still open (wrong property, value below purchase, expired license,
  // C6/Q6, stale date, …). This is the safety guarantee the whole findings engine exists for.
  if (isAppraisalReview) {
    const n = (await db.query(
      `SELECT count(*)::int AS n FROM appraisal_findings
        WHERE application_id=$1 AND status='open' AND severity='fatal' AND blocks_ctc=true`, [item.application_id])).rows[0].n;
    if (n > 0)
      return `Resolve the ${n} open fatal appraisal finding${n === 1 ? '' : 's'} first — the appraisal review cannot be cleared while a fatal PILOT finding is open. Open the appraisal to replace, keep, or grant an exception on each.`;
    return null;
  }

  // Document-underwriting review cleared — the CTC gate for the document-underwriting engine. It
  // cannot be signed off while ANY fatal document finding is open: the stored per-document fatals
  // (document_findings) OR the derived tie-out fatals (a fact that doesn't agree across the file's
  // documents). Same computation the desk uses, so the gate and the badge never disagree.
  if (isUnderwritingReview) {
    const { fileFatalCount } = require('../lib/underwriting/file-review');
    const { total } = await fileFatalCount(db, item.application_id);
    if (total > 0)
      return `Resolve the ${total} open fatal document finding${total === 1 ? '' : 's'} first — document underwriting cannot be cleared while a fatal PILOT finding is open. Open the Document Review section to post a condition, request a document, fix the file, or grant an exception on each.`;
    return null;
  }

  // Structured-DATA conditions (owner-directed 2026-07-20): these collect DATA,
  // not a document, so the doc-gate above never saw them and they could be signed
  // off empty — the reported "signed off the credit-card / title / insurance
  // condition with nothing entered" hole. A REQUIRED one now needs its data
  // present; an OPTIONAL one (is_required=false) may still be completed empty.
  if (isApprCard || isTitleContact || isInsContact) {
    if (item.is_required === false) return null;
    if (isApprCard) {
      const has = await db.query(`SELECT 1 FROM application_payment_cards WHERE application_id=$1 LIMIT 1`, [item.application_id]);
      if (!has.rows.length)
        return 'Enter the credit card for the appraisal before signing this off — this condition cannot be completed until the card is on file.';
      return null;
    }
    const types = isTitleContact ? ['title_company'] : ['insurance_agent', 'flood_insurance'];
    const has = await db.query(
      `SELECT 1 FROM application_service_contacts WHERE application_id=$1 AND contact_type = ANY($2::text[]) LIMIT 1`,
      [item.application_id, types]);
    if (!has.rows.length)
      return `Enter the ${isTitleContact ? 'title company' : 'insurance'} contact before signing this off — this condition cannot be completed without it.`;
    return null;
  }

  // Vesting-entity (LLC) condition (owner-directed 2026-07-20: "EVERY condition
  // required unless optional"). rtl_p1_llc is a required condition fulfilled by
  // VERIFYING the file's linked LLC (the LLC-verify route auto-signs it off on
  // verification). It's exempt from the plain document gate above (its documents
  // live on the LLC's own sub-conditions, not on this item), so without this it
  // could be signed off empty. Block a manual sign-off until the vesting LLC is
  // actually linked AND verified.
  if (code === 'rtl_p1_llc') {
    const v = (await db.query(
      `SELECT l.is_verified FROM applications a JOIN llcs l ON l.id = a.llc_id WHERE a.id=$1`, [item.application_id])).rows[0];
    if (!v) return 'Link the vesting entity (LLC) to this file, then verify it, before signing this off.';
    if (!v.is_verified) return 'Verify the vesting entity (LLC) — its details, ownership, and all its documents — before signing this off.';
    return null;
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
    // 5% construction contingency requirement (owner-directed 2026-07-12; extended
    // 2026-07-20): the Scope of Work must carry a >= 5% contingency when the file
    // is registered Gold OR its note buyer is Blue Lake. The budget still matches
    // exactly above — this is a composition requirement on top of it.
    const RB = require('../lib/rehab-budget');
    const contReq = await RB.sowContingencyRequired(item.application_id);
    if (contReq.required && !RB.goldContingencyOk(item.tool_payload)) {
      return RB.SOW_CONTINGENCY_MSG;
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
          (a.id IS NOT NULL AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')})
          OR (ci.llc_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM applications ap
                 WHERE ap.llc_id=ci.llc_id AND ap.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('ap', '$2')})))`,
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
    return res.status(403).json({ error: 'Only a processor or underwriter can sign a condition off — click Done to record your completion; the back office signs off after you.' });
  }
  // The lighter "reviewed" stamp is tied to its own capability (loan officers have
  // it; processors/underwriters/admins do too). Sign-off holders implicitly may
  // review as well, so accept either capability for a review-only action.
  if (b.reviewed === true && !can(req.actor, 'review_conditions') && !canComplete) {
    return res.status(403).json({ error: 'You do not have permission to review conditions on this file.' });
  }
  // #106: waiving is a completion action (it removes the condition from the list),
  // so it needs the same capability as a sign-off, and only an OPTIONAL condition
  // may be waived — a required condition must actually be satisfied.
  if (b.waived === true) {
    const cur = await db.query(
      `SELECT ci.is_required, ci.tool_key, t.code AS template_code
         FROM checklist_items ci LEFT JOIN checklist_templates t ON t.id = ci.template_id
        WHERE ci.id=$1`, [req.params.itemId]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    // The appraisal credit-card condition may ALSO be waived by the loan officer
    // (owner-directed): "The credit-card-for-appraisal condition should have a
    // waive button… the super admin should be able to waive the condition, the
    // loan officer should also be able to waive the condition." Every other
    // condition still needs sign-off authority to waive.
    const isApprCard = cur.rows[0].tool_key === 'appraisal_card' || cur.rows[0].template_code === 'rtl_p1_apprcard';
    const mayWaive = canComplete || (isApprCard && can(req.actor, 'review_conditions'));
    if (!mayWaive) return res.status(403).json({ error: 'Only a processor or underwriter can waive a condition.' });
    // Normally only an OPTIONAL condition may be waived. The appraisal credit-card
    // condition is an explicit exception (owner-directed): it is waivable directly
    // even though it's a required task — the appraisal may simply be paid another way.
    if (!isApprCard && cur.rows[0].is_required !== false) return res.status(422).json({ error: 'Only an optional condition can be waived — make it optional first, then waive.' });
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
  if (b.status && b.signedOff !== true && b.pushBack !== true && b.waived == null) add('status=?', b.status);
  if (b.notes != null) add('notes=?', b.notes);
  if ('assigneeStaffId' in b) add('assignee_staff_id=?', b.assigneeStaffId || null);
  // Requirement toggle — e.g. the LLC's Certificate of Good Standing is
  // optional by default; the officer/processor can flip it to required (it
  // then gates the entity's verification) and back.
  if (typeof b.isRequired === 'boolean') add('is_required=?', b.isRequired);

  // Sign-off marks the item satisfied and stamps who/when; un-sign clears it.
  // #106: a WAIVE completes an OPTIONAL condition (the "clear" action) — it
  // satisfies the item for every gate but records that it was WAIVED (not that the
  // doc/data was provided). Un-waive puts it back on the list.
  if (b.signedOff === true) {
    add('signed_off_by=?', req.actor.id);
    sets.push("signed_off_at=now()", "status='satisfied'");
  } else if (b.waived === true) {
    add('signed_off_by=?', req.actor.id);
    add('waived_by=?', req.actor.id);
    sets.push("signed_off_at=now()", "waived_at=now()", "status='satisfied'");
  } else if (b.signedOff === false || b.waived === false) {
    sets.push('signed_off_by=NULL', 'signed_off_at=NULL', 'waived_by=NULL', 'waived_at=NULL');
    if (b.waived === false) sets.push("status='outstanding'");
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
          badge: { text: 'Action needed', tone: 'action' },
          body: `Your loan team reviewed "${row.label}" and sent it back so it can be corrected.`,
          callout: { title: 'What we need', body: String(b.issueReason).slice(0, 300), tone: 'action' },
          meta: (ctx && ctx.borrowerMeta) || undefined,
          applicationId: row.application_id,
          link: row.application_id ? `/app/${row.application_id}` : '/profile',
          ctaLabel: 'Fix this item' });
      }
    } catch (_) { /* best-effort */ }
  }
  // "You're all caught up" (owner-directed 2026-07-20): when a borrower-visible
  // condition is signed off / waived and it was the LAST open item on the file,
  // reassure the borrower there's nothing left for them to do right now. Gated to
  // once per file per ~day (audit_log) so a batch of sign-offs sends ONE note, not
  // one per item. Only when the file truly has zero outstanding borrower items.
  if (b.signedOff === true || b.waived === true) {
    try {
      const it = await db.query(
        `SELECT ci.application_id, ci.audience, a.borrower_id
           FROM checklist_items ci LEFT JOIN applications a ON a.id=ci.application_id WHERE ci.id=$1`,
        [req.params.itemId]);
      const row = it.rows[0];
      if (row && row.borrower_id && row.application_id && row.audience !== 'staff') {
        const open = await require('../lib/reminders').outstandingItems(row.application_id);
        if (open.length === 0) {
          // Atomically CLAIM the 20h slot so two conditions clearing the last item
          // on the same file in the same instant can't both email (advisory-locked
          // shared helper — a plain INSERT…WHERE NOT EXISTS is not atomic).
          const claimId = await claimOncePerPeriod({ action: 'all_caught_up_emailed', entityId: row.application_id, interval: '20 hours' });
          if (claimId) {
            await notify.notifyAppBorrowers(row.application_id, {
              type: 'all_caught_up',
              title: 'You’re all caught up',
              hero: { label: 'Nothing needed right now', value: '✓ All caught up', tone: 'positive' },
              badge: { text: 'All clear', tone: 'positive' },
              body: 'Great news — you’ve completed everything your loan team needs from you at the moment, so there’s nothing left for you to do right now.',
              lines: ['We’ll email you the moment a new item needs your attention. In the meantime, you can always check your file in the portal.'],
              applicationId: row.application_id, link: `/app/${row.application_id}`, ctaLabel: 'View your file' });
          }
        }
      }
    } catch (_) { /* best-effort */ }
  }
  // The Workflow, phase two: a sign-off / waive may have made the file ready for
  // its next step — nudge the loan officer (throttled, best-effort).
  if (b.signedOff === true || b.waived === true) {
    try {
      const ar = await db.query(`SELECT application_id FROM checklist_items WHERE id=$1`, [req.params.itemId]);
      if (ar.rows[0] && ar.rows[0].application_id) await suggestNextStep(ar.rows[0].application_id, req.actor.id);
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
    const cur = await db.query(`SELECT loan_officer_id, processor_id, status, deleted_at FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'application not found' });
    const admin = isAdmin(req);
    // A borrower "meet your loan officer, guiding your loan to closing" email only
    // makes sense on a LIVE, borrower-visible file — never on a lead-capture file
    // the borrower hasn't accepted, a terminal (declined/withdrawn/funded) file, or
    // an archived one (owner-reported audit 2026-07-20).
    const fileLiveForBorrower = !cur.rows[0].deleted_at &&
      !['file_intake', 'declined', 'withdrawn', 'funded'].includes(cur.rows[0].status);
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
      const officerChanged = String(cur.rows[0].loan_officer_id || '') !== String(loanOfficerId);
      // Invalidate the LO-notification-gate's cache for this file so the very
      // next notification routes to the NEW LO's prefs (not the previous holder's).
      try { require('../lib/lo-notification-gate').invalidateFile(req.params.id); } catch (_) { /* best-effort */ }
      // Only email the officer on a REAL change — re-saving the assignment panel
      // with the same officer is a no-op and must not re-send "You are the loan
      // officer on a file" every time (round-2 audit N3).
      if (officerChanged) {
        await notify.notifyStaff(loanOfficerId, {
          type: 'assignment', title: 'You are the loan officer on a file',
          body: `${req.actor.name || 'An admin'} assigned this file to you as loan officer. The file details are below — open it to get started.`,
          applicationId: req.params.id, ctaLabel: 'Open the loan file',
          link: `/internal/app/${req.params.id}` });
      }
      // "Meet your loan officer" (owner-directed 2026-07-20): when the officer
      // CHANGES to a new person, introduce them to the borrower so the
      // relationship is personal and they know exactly who to reach (fileContext
      // now auto-adds the officer's contact card to every borrower email, so the
      // copy just needs to be the warm intro). Fires once per real change — and
      // only on a live, borrower-visible file (not a lead/terminal/archived one).
      if (fileLiveForBorrower && String(cur.rows[0].loan_officer_id || '') !== String(loanOfficerId)) {
        try {
          const o = await db.query(`SELECT full_name, title, email, phone, cell FROM staff_users WHERE id=$1`, [loanOfficerId]);
          const oa = o.rows[0] || {};
          const oname = oa.full_name || 'Your loan officer';
          const reach = [oa.cell || oa.phone, oa.email].filter(Boolean).join(' or ');
          await notify.notifyAppBorrowers(req.params.id, {
            type: 'officer_assigned',
            title: `${oname} is your loan officer`,
            body: `${oname}${oa.title ? `, ${oa.title},` : ''} will be your point of contact at YS Capital Group, guiding your loan from here through closing.`,
            lines: [
              reach ? `You can reach ${oname.split(' ')[0]} directly at ${reach} — or just reply to this email and it goes straight to your loan team.`
                    : `Just reply to this email any time and it goes straight to your loan team.`,
              'Your loan officer and their contact details are always shown at the bottom of these emails and in your portal.',
            ],
            applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Open your file',
            from: require('../lib/email').fromWithName(oname),
            replyTo: oa.email || null,
          });
        } catch (_) { /* intro email is best-effort */ }
      }
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
      // Only email the processor on a REAL change (round-2 audit N3) — a no-op
      // re-assign must not re-send "You are the processor on a file".
      if (String(cur.rows[0].processor_id || '') !== String(processorId)) {
        await notify.notifyStaff(processorId, {
          type: 'assignment', title: 'You are the processor on a file',
          body: `${req.actor.name || 'An admin'} assigned this file to you for processing. The file details are below — open it to get started.`,
          applicationId: req.params.id, ctaLabel: 'Open the loan file',
          link: `/internal/app/${req.params.id}` });
      }
      await audit(req, 'assign_processor', 'application', req.params.id, { from: cur.rows[0].processor_id || null, to: processorId });
    }
    enqueueClickupPush(req.params.id, ['officer', 'processor']).catch(() => {}); // propagate officer/processor to ClickUp promptly
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---------------- multi-assignee team (#64): full-access assistants ----------------
// The team = the PRIMARY LO/processor (mirrored from applications) plus any
// full-access ASSISTANTS. All three routes sit under the /applications/:id path
// middleware, so only someone who can already reach the file (an assignee or a
// seesAll staffer) gets here. Managing ASSISTANTS is a team-collaboration action
// any assignee may take (assistants have full access); the PRIMARY is changed
// only through /assign (admin-gated) — removing a primary here is refused, and
// assistants are portal-only (never pushed to ClickUp, so no enqueueClickupPush).
router.get('/applications/:id/assignees', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT aa.staff_id, aa.role, aa.is_primary, aa.added_at,
              s.full_name, s.title, s.role AS staff_role, s.email
         FROM application_assignees aa JOIN staff_users s ON s.id=aa.staff_id
        WHERE aa.application_id=$1 AND aa.removed_at IS NULL
        ORDER BY aa.role, aa.is_primary DESC, s.full_name`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/applications/:id/assignees', async (req, res) => {
  try {
    const b = req.body || {};
    const role = b.role === 'processor' ? 'processor' : b.role === 'loan_officer' ? 'loan_officer' : null;
    const staffId = b.staffId;
    if (!role || !staffId) return res.status(400).json({ error: 'staffId and role (loan_officer|processor) required' });
    // Active + role-appropriate (mirrors the /assign validation): a processor
    // assistant must actually hold the processor role.
    const s = await db.query(`SELECT id, full_name, role FROM staff_users WHERE id=$1 AND is_active=true`, [staffId]);
    if (!s.rows[0]) return res.status(404).json({ error: 'staff member not found' });
    if (role === 'processor' && s.rows[0].role !== 'processor')
      return res.status(400).json({ error: 'A processor assistant must be a staffer with the processor role.' });
    const dup = await db.query(
      `SELECT is_primary FROM application_assignees WHERE application_id=$1 AND role=$2 AND staff_id=$3 AND removed_at IS NULL`,
      [req.params.id, role, staffId]);
    if (dup.rows[0]) return res.status(409).json({ error: dup.rows[0].is_primary ? 'Already the primary for this role on this file.' : 'Already an assistant on this file.' });
    await db.query(
      `INSERT INTO application_assignees (application_id, staff_id, role, is_primary, added_by) VALUES ($1,$2,$3,false,$4)`,
      [req.params.id, staffId, role, req.actor.id]);
    await notify.notifyStaff(staffId, {
      type: 'assignment', title: `You were added to a file as ${role === 'processor' ? 'a processor' : 'a loan officer'}`,
      body: `${req.actor.name || 'A teammate'} added you to this file with full access. The file details are below.`,
      applicationId: req.params.id, ctaLabel: 'Open the loan file', link: `/internal/app/${req.params.id}` });
    await audit(req, 'add_assignee', 'application', req.params.id, { staffId, role });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

router.delete('/applications/:id/assignees/:staffId', async (req, res) => {
  try {
    const role = req.query.role === 'processor' ? 'processor' : 'loan_officer';
    const row = await db.query(
      `SELECT is_primary FROM application_assignees WHERE application_id=$1 AND role=$2 AND staff_id=$3 AND removed_at IS NULL`,
      [req.params.id, role, req.params.staffId]);
    if (!row.rows[0]) return res.status(404).json({ error: 'not an active assignee on this file' });
    if (row.rows[0].is_primary) return res.status(400).json({ error: 'Reassign the primary through Assign — a primary can’t be removed here.' });
    await db.query(
      `UPDATE application_assignees SET removed_at=now() WHERE application_id=$1 AND role=$2 AND staff_id=$3 AND removed_at IS NULL`,
      [req.params.id, role, req.params.staffId]);
    await audit(req, 'remove_assignee', 'application', req.params.id, { staffId: req.params.staffId, role });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
    // Match a file where this person is the primary OR the CO-borrower — a
    // co-borrower is a party on the staffer's file, so an assigned loan officer /
    // processor may see (and invite) them. Fails-safe: still requires the staffer
    // be assigned to a file the borrower is actually on.
    `SELECT 1 FROM applications a
      WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
        AND ${VISIBLE_OFFICERS_SQL('a', '$2')}
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
// #107: the LO / processor / admin can ENTER the appraisal payment card on the
// borrower's behalf (some borrowers give it over the phone). Same validation +
// at-rest encryption + condition completion as the borrower route, through the
// shared chokepoint — stored against the file's borrower as the card owner.
router.post('/applications/:id/appraisal-card', async (req, res) => {
  if (!(await canTouchApp(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
  if (!app.rows[0]) return res.status(404).json({ error: 'not found' });
  const apprCard = require('../lib/appraisal-card');
  const v = apprCard.validateCardInput(req.body || {});
  if (!v.ok) return res.status(400).json({ error: v.error });
  try {
    const { last4, brand } = await apprCard.saveApplicationCard({
      appId: req.params.id, borrowerId: app.rows[0].borrower_id,
      number: v.number, cvc: v.cvc, expMonth: v.expMonth, expYear: v.expYear, zip: v.zip });
    await audit(req, 'save_appraisal_card', 'application', req.params.id, { last4, enteredByStaff: true });
    res.status(201).json({ ok: true, last4, brand });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
                              AND ${VISIBLE_OFFICERS_SQL('a', '$2')})`;
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
                                AND ${VISIBLE_OFFICERS_SQL('a', '$1')})`;
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
    // Match files where they are the primary OR the CO-borrower (owner-directed
    // 2026-07-14): a co-borrower is its own borrower record and gets its own
    // portal login with full (OR-gated) access to the shared loan — but the
    // primary invite never reaches them, so this powers a dedicated co-borrower
    // invite. Without the co_borrower_id match a pure co-borrower would 400.
    const app = (await db.query(
      `SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [req.params.id])).rows[0];
    if (!app) return res.status(400).json({ error: 'this borrower has no active file to invite them to' });
    const out = await inviteBorrowerToFile({ appId: app.id, borrowerId: b.id, email: b.email, firstName: b.first_name, req });
    res.json({ ok: true, ...out });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
    // Staff-provisioned credentials are trusted the same way an invite-accept is
    // (S1-08): mark the email verified so the borrower isn't bounced to the
    // "confirm your email" gate on the sign-in the LO just set up for them.
    if (existing.rows[0]) {
      await db.query(
        `UPDATE borrower_auth SET password_hash=$2, token_version=token_version+1,
             failed_attempts=0, locked_until=NULL,
             email_verified=true, email_verified_at=COALESCE(email_verified_at, now())
         WHERE borrower_id=$1`, [req.params.id, hash]);
    } else {
      await db.query(
        `INSERT INTO borrower_auth (borrower_id,password_hash,token_version,email_verified,email_verified_at)
         VALUES ($1,$2,0,true,now())`, [req.params.id, hash]);
    }
    await audit(req, 'borrower_set_password', 'borrower', b.id, {});
    try { if (b.email) await mail.send('passwordChanged', b.email, { firstName: b.first_name }); } catch (_) {}
    res.json({ ok: true, set: true, hadAccount: !!existing.rows[0] });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
              b.current_address, b.mailing_address, b.years_at_residence, b.months_at_residence, b.residence_since,
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
    // ADDITIONAL contact info accumulated across the borrower's files
    // (owner-directed 2026-07-15 night: every synced file may bring more
    // phones/emails — they ADD to the profile, never replace the primary).
    const contacts = (await db.query(
      `SELECT kind, value, source, created_at FROM borrower_contacts
        WHERE borrower_id=$1 ORDER BY created_at DESC LIMIT 50`, [req.params.id]).catch(() => ({ rows: [] }))).rows;
    // Live residence duration from the anchored move-in date (owner-directed 2026-07-14).
    res.json({ ...require('../lib/residence').withLiveResidence(r.rows[0]), contacts });
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
    // DOB from the borrower-profile edit (owner-directed 2026-07-15 night: DOB
    // must be fully editable from PILOT — the profile screen previously showed
    // it read-only with no way to add or fix it). Validated as a real adult
    // birth date, then applied through the ONE canonical applier below —
    // portal + every linked ClickUp task, journaled, audited, stale reviews
    // auto-closed. Not added to `sets`: adoptDobEverywhere owns the write.
    let dobDay;
    if (b.dob !== undefined && b.dob !== null && b.dob !== '') {
      dobDay = require('../lib/fields').sanitizeDob(b.dob);
      if (dobDay == null) return res.status(400).json({ error: 'date of birth must be a real adult birth date (YYYY-MM-DD, 4-digit year)' });
    }
    if (!sets.length && !dobDay) return res.status(400).json({ error: 'nothing to update' });
    if (sets.length) {
      sets.push('updated_at=now()');
      try {
        await db.query(`UPDATE borrowers SET ${sets.join(', ')} WHERE id=$1`, vals);
      } catch (e) {
        if (e.code === '23505') return res.status(409).json({ error: 'that email is already in use by another borrower' });
        throw e;
      }
    }
    let dobResult;
    if (dobDay) {
      dobResult = await require('../lib/sync-autoresolve').adoptDobEverywhere({
        borrowerId: req.params.id, day: dobDay,
        why: 'staff_profile_edit', source: 'staff_edit', actorId: req.actor.id });
    }
    // Identity edits made HERE now reach ClickUp like every other edit — a
    // scoped push per linked active file, carrying only the changed keys
    // (previously this route wrote the portal and silently never propagated).
    const pushKeys = [];
    if (b.email != null) pushKeys.push('email');
    if (b.cellPhone != null) pushKeys.push('cell_phone');
    if (b.currentAddress !== undefined) pushKeys.push('current_address');
    if (pushKeys.length) {
      try {
        const apps = (await db.query(
          `SELECT id FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`,
          [req.params.id])).rows;
        for (const a of apps) enqueueClickupPush(a.id, pushKeys).catch(() => {});
      } catch (_) { /* best-effort */ }
    }
    await audit(req, 'update_borrower', 'borrower', req.params.id, {
      fields: sets.filter((s) => !s.startsWith('updated_at')).map((s) => s.split('=')[0]).concat(dobDay ? ['date_of_birth'] : []),
      ...(dobResult ? { dob: dobResult } : {}) });
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
    // A scoped loan officer must not see the existence/loan#/address/amount of the
    // borrower's OTHER files they aren't assigned to (round-2 audit F7); admins/
    // underwriters/processors keep the borrower-wide view.
    const params = [req.params.id];
    let scope = '';
    if (!seesAllBorrowers(req)) { params.push(req.actor.id); scope = `AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`; }
    const r = await db.query(
      `SELECT a.id, a.ys_loan_number, a.program, a.loan_type, a.status, a.internal_status,
              a.property_address, a.loan_amount, a.created_at, a.expected_closing, a.actual_closing,
              a.borrower_id=$1 AS is_primary, a.co_borrower_id=$1 AS is_co_borrower,
              off.full_name AS loan_officer_name, l.llc_name AS entity_name, l.is_verified AS entity_verified
         FROM applications a
         LEFT JOIN staff_users off ON off.id = a.loan_officer_id
         LEFT JOIN llcs l ON l.id = a.llc_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL ${scope}
        ORDER BY a.created_at DESC`, params);
    res.json(r.rows);
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Open conditions/tasks-to-clear rolled up across ALL of the borrower's files —
// so staff see everything outstanding for the person in one place.
router.get('/borrowers/:id/conditions', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    // Scope to files the actor is assigned to — a shared borrower must not expose
    // the conditions (with property address + loan number) of a file the officer
    // isn't on (round-2 audit N4).
    const params = [req.params.id];
    let scope = '';
    // seesAllBorrowers (admin/underwriter/processor) keep the borrower-wide view
    // — only a genuinely file-scoped loan officer is restricted to assigned files
    // (matches the canSeeBorrower gate; round-2 audit F6).
    if (!seesAllBorrowers(req)) { params.push(req.actor.id); scope = `AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`; }
    const r = await db.query(
      `SELECT c.id, c.application_id, c.title, c.status, c.audience, c.severity, c.created_at,
              a.ys_loan_number, a.property_address
         FROM conditions c
         JOIN applications a ON a.id = c.application_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
          AND c.status IN ('open','borrower_responded') ${scope}
        ORDER BY c.created_at DESC`, params);
    res.json(r.rows);
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Reminders + tasks across the borrower's files (the #93 system, rolled up per
// borrower). Creating a task attaches it to the chosen file (or the latest file)
// so it flows through the existing, tested reminder dispatcher unchanged.
router.get('/borrowers/:id/reminders', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    // Scope reminders/tasks to the actor's files for a scoped loan officer (F7).
    const params = [req.params.id];
    let scope = '';
    if (!seesAllBorrowers(req)) { params.push(req.actor.id); scope = `AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`; }
    const r = await db.query(
      `SELECT r.id, r.application_id, r.kind, r.title, r.body, r.due_at, r.status,
              r.assignee_staff_id, r.completed_at, r.created_at,
              a.ys_loan_number, a.property_address,
              asg.full_name AS assignee_name
         FROM reminders r
         JOIN applications a ON a.id = r.application_id
         LEFT JOIN staff_users asg ON asg.id = r.assignee_staff_id
        WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL ${scope}
        ORDER BY (r.status='scheduled') DESC, r.due_at ASC`, params);
    res.json(r.rows);
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
    // An APPLICATION document is authorized solely by assignment to its own file —
    // a shared borrower must not expose the filenames/loan numbers of a file the
    // officer isn't on (round-2 audit N4; mirrors canSeeDocument). Borrower/entity-
    // level docs (no application) keep the borrower-wide view they already have.
    const params = [req.params.id];
    let appVisible;
    if (seesAllBorrowers(req)) {   // admin/underwriter/processor keep the borrower-wide view (F6)
      appVisible = `SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1) AND deleted_at IS NULL`;
    } else {
      params.push(req.actor.id);
      appVisible = `SELECT a.id FROM applications a WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL
                      AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`;
    }
    const r = await db.query(
      `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.doc_kind, d.created_at,
              d.application_id, d.llc_id, d.track_record_id,
              a.ys_loan_number
         FROM documents d
         LEFT JOIN applications a ON a.id = d.application_id
        WHERE (d.application_id IS NOT NULL AND d.application_id IN (${appVisible}))
           OR (d.application_id IS NULL AND (
                 d.borrower_id=$1
                 OR d.llc_id IN (SELECT id FROM llcs WHERE borrower_id=$1)
                 OR d.track_record_id IN (SELECT id FROM track_records WHERE borrower_id=$1)))
        ORDER BY d.created_at DESC LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Activity timeline for the borrower — staff actions on the person and on their
// files (audit trail: SSN reveals, edits, password sets, doc downloads, etc.).
router.get('/borrowers/:id/activity', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    // Scope the file audit trail (SSN reveals, edits, downloads) to files the actor
    // is assigned to — a shared borrower must not expose the audit history of a file
    // the officer isn't on (round-2 audit N4). Borrower/entity-level entries stay.
    const params = [req.params.id];
    let appVisible;
    if (seesAllBorrowers(req)) {   // admin/underwriter/processor keep the borrower-wide view (F6)
      appVisible = `SELECT id FROM applications WHERE (borrower_id=$1 OR co_borrower_id=$1)`;
    } else {
      params.push(req.actor.id);
      appVisible = `SELECT a.id FROM applications a WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`;
    }
    const r = await db.query(
      `SELECT g.id, g.action, g.entity_type, g.entity_id, g.detail, g.created_at,
              g.actor_kind, su.full_name AS actor_name
         FROM audit_log g
         LEFT JOIN staff_users su ON su.id = g.actor_id AND g.actor_kind='staff'
        WHERE (g.entity_type='borrower' AND g.entity_id=$1)
           OR (g.entity_type IN ('application','document','track_record','llc')
               AND g.entity_id IN (
                 ${appVisible}
                 UNION SELECT id FROM llcs WHERE borrower_id=$1
                 UNION SELECT id FROM track_records WHERE borrower_id=$1))
        ORDER BY g.created_at DESC LIMIT 200`, params);
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
  // Personal-name lines carry no entity — clear it in the upsert's update set
  // too, so a retried create can't leave a stale llc_id on the conflicted row.
  if (b.ownedPersonally) cols.llc_id = null;
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
  // Live cross-user refresh (#112): the borrower + other staff viewing this
  // record reload; the acting staffer's own tab is excluded from the echo.
  require('../lib/events').publishTrackRecordUpdate(req.params.id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
  require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
  require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
  } catch (e) { if (!e.status) console.warn('[staff] snapshot error:', db.describeError(e)); res.status(e.status || 500).json({ error: e.status ? e.message : 'could not save the snapshot' }); }
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
            review_status,rejection_reason,reviewed_at,slot_label AS doc_type FROM documents
      WHERE track_record_id=$1 AND is_current ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});
// #112: valid track-record supporting-doc TYPEs (stored in documents.slot_label),
// kept in sync with the borrower route + the tool's dropdown.
const TR_DOC_TYPE_SET = new Set([
  'Closing statement (HUD)', 'Deed', 'Recorded mortgage', 'Payoff statement',
  'Lease', 'Property profile report', 'Other',
]);
const trDocType = (v) => (TR_DOC_TYPE_SET.has(String(v || '').trim()) ? String(v).trim() : null);
router.post('/track-records/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
  try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
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
  const dupStaffTr = await require('../lib/doc-dedup').recentDuplicateDocId({   // idempotency (#87)
    filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'staff', uploadedById: req.actor.id,
    trackRecordId: req.params.id, checklistItemId: reqItemId, docKind: 'track_record_doc' });
  if (dupStaffTr) return res.status(201).json({ ok: true, documentId: dupStaffTr, deduped: true });
  const r = await db.query(
    `INSERT INTO documents (borrower_id,track_record_id,checklist_item_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind,slot_label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,'track_record_doc',$10) RETURNING id`,
    [tr.rows[0].borrower_id, req.params.id, reqItemId, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id, trDocType(b.docType)]);
  await db.query(`UPDATE track_records SET docs_status='received', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [req.params.id]);
  if (reqItemId) {
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE id=$1 AND status IN ('outstanding','requested','issue')`, [reqItemId]);
    try { await enqueueChecklistStatusPush(reqItemId); } catch (_) {}
  }
  await audit(req, 'staff_upload_track_record_doc', 'track_record', req.params.id, { filename: b.filename });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}
  require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
  res.status(201).json({ ok: true, documentId: r.rows[0].id });
});
router.get('/borrowers/:id/ssn', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(`SELECT ssn_encrypted FROM borrowers WHERE id=$1`, [req.params.id]);
    if (!r.rows[0]?.ssn_encrypted) return res.status(404).json({ error: 'no ssn on file' });
    await audit(req, 'view_ssn', 'borrower', req.params.id);
    // Reveal in the REAL SSN format XXX-XX-XXXX (owner-directed 2026-07-20) — stored
    // as bare digits, presented dashed. The edit input re-formats on change, so a
    // dashed reveal round-trips cleanly.
    res.json({ ssn: require('../lib/fields').formatSsn(C.decryptSSN(r.rows[0].ssn_encrypted)) });
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

// Set / correct a borrower's Social Security number (owner-directed 2026-07-15
// night: LOs and processors must be able to ADD an SSN on their own files —
// there was a reveal endpoint but no set). Scoped by canSeeBorrower (assigned
// LO / processor / assistants; admins everywhere), a full 9-digit number only,
// cross-borrower collision-checked (an SSN is one person), audited with
// masked before/after, and propagated to every linked PRIMARY-borrower task
// as a scoped 'ssn' push (the staff-typed value IS the human decision;
// journaled + no-op-suppressed like every write).
router.post('/borrowers/:id/ssn', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const store = C.ssnForStorage((req.body || {}).ssn);
    if (!store) return res.status(400).json({ error: 'a full 9-digit Social Security number is required' });
    const hash = require('../clickup/identity').ssnHash(store.digits, cfg.ssnMatchKey);
    const clash = await db.query(`SELECT id FROM borrowers WHERE ssn_hash=$1 AND id<>$2 LIMIT 1`, [hash, req.params.id]);
    if (clash.rows[0]) return res.status(409).json({ error: 'another borrower already carries this Social Security number — check for a duplicate profile' });
    const before = (await db.query(`SELECT ssn_last4 FROM borrowers WHERE id=$1`, [req.params.id])).rows[0];
    if (!before) return res.status(404).json({ error: 'not found' });
    await db.query(
      `UPDATE borrowers SET ssn_encrypted=$2, ssn_last4=$3, ssn_hash=$4, updated_at=now() WHERE id=$1`,
      [req.params.id, store.encrypted, store.last4, hash]);
    await audit(req, 'set_borrower_ssn', 'borrower', req.params.id,
      { beforeLast4: before.ssn_last4 || null, afterLast4: store.last4 });
    try {
      const apps = (await db.query(
        `SELECT id FROM applications WHERE borrower_id=$1 AND deleted_at IS NULL AND clickup_pipeline_task_id IS NOT NULL`,
        [req.params.id])).rows;
      for (const a of apps) enqueueClickupPush(a.id, ['ssn']).catch(() => {});
    } catch (_) { /* best-effort */ }
    res.json({ ok: true, last4: store.last4 });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Staff upload of an entity document into a specific LLC checklist slot, WITHOUT a
// file context (the CRM entity library has no appId). Mirrors the LLC path of the
// staff app-doc upload; visibility='borrower' so the entity's docs stay shared.
router.post('/llcs/:id/documents', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
    b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
    const own = await db.query(`SELECT borrower_id, is_verified FROM llcs WHERE id=$1`, [req.params.id]);
    if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
    if (own.rows[0].is_verified) return res.status(409).json({ error: 'this LLC is verified — revoke verification before replacing its documents' });
    if (b.checklistItemId) {
      const ci = await db.query(`SELECT id FROM checklist_items WHERE id=$1 AND llc_id=$2`, [b.checklistItemId, req.params.id]);
      if (!ci.rows[0]) return res.status(404).json({ error: 'checklist item not found on this entity' });
    }
    let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
    try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
    const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
    const dupLlc = await require('../lib/doc-dedup').recentDuplicateDocId({   // idempotency (#87)
      filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'staff', uploadedById: req.actor.id,
      llcId: req.params.id, checklistItemId: b.checklistItemId || null, slotLabel: slot });
    if (dupLlc) return res.status(201).json({ ok: true, documentId: dupLlc, deduped: true });
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
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
  // WO-6 (F-M11): normalize a mid-typed formation date so year-0026 can't persist.
  if (b.formationDate !== undefined) b.formationDate = require('../lib/fields').normalizeTypedDate(b.formationDate);
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
  // Layered entities verify BOTTOM-UP, so a revoked owner invalidates every
  // verified entity it (transitively) owns — revoke them too, with a derived
  // reason, or the chain invariant silently breaks (a verified child would sit
  // on an unverified owner and its file condition would stay signed off).
  const revokedChildren = [];
  try {
    for (const childId of await llcLib.getDescendantEntityIds(req.params.id)) {
      const c = (await db.query(`SELECT id, llc_name, is_verified FROM llcs WHERE id=$1`, [childId])).rows[0];
      if (!c || !c.is_verified) continue;
      await db.query(`UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now() WHERE id=$1`, [childId]);
      await llcLib.syncLlcConditions(childId, { reopen: true });
      await audit(req, 'unverify_llc', 'llc', childId, { reason: `owning entity "${own.rows[0].llc_name}" verification was revoked` });
      revokedChildren.push(c.llc_name);
    }
  } catch (e) { console.warn('[llc-revoke] chain revoke failed:', e.message); }
  try {
    await notify.notifyBorrower(own.rows[0].borrower_id, {
      type: 'llc_unverified', title: 'Your LLC needs attention', badge: { text: 'Action needed', tone: 'action' },
      body: `Verification of "${own.rows[0].llc_name}" was revoked${reason ? `: ${reason}` : ''}.`
        + (revokedChildren.length ? ` Because it owns ${revokedChildren.map(n => `"${n}"`).join(', ')}, verification there was reopened too.` : '')
        + ' Please review the details and documents on your profile.',
      link: '/profile', ctaLabel: 'Review your LLC' });
  } catch (_) { /* best-effort */ }
  res.json({ ok: true, verified: false, revokedChildren });
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
  // #112 verify gate — a line may be VERIFIED toward experience ONLY when it has a
  // COMPLETED, in-window exit: no exit date is FATAL, a future-dated exit hasn't
  // closed yet, and an exit >3 years old no longer counts (frozen 36-month window,
  // reused from experience.js — never re-derived here). This stops a misleading
  // "verified but counts toward nothing" line: such a row silently fails
  // RECENT_EXIT_SQL, so it would show as verified yet contribute zero to the tier /
  // experience / sign-off gate. Only counting statuses (verified/limited) are gated;
  // a non-counting review status (pending/docs) is unaffected, as is any REVOKE.
  if (counts && !isRevoke) {
    const elig = await db.query(
      `SELECT (${EXIT_DATE_SQL}) IS NULL AS no_exit,
              (${EXIT_DATE_SQL}) > CURRENT_DATE AS future,
              (${EXIT_DATE_SQL}) < (CURRENT_DATE - INTERVAL '36 months') AS expired
         FROM track_records WHERE id=$1`, [req.params.id]);
    const e = elig.rows[0] || {};
    if (e.no_exit || e.future || e.expired) {
      const msg = e.no_exit
        ? 'This project has no completed exit date (a sale date for a flip, or a lease / refinance date for a hold). It can’t be verified toward experience until the exit is recorded — request the exit documents instead.'
        : e.future
          ? 'This project’s exit date is in the future — it can’t be verified until the exit has actually closed.'
          : 'This project’s exit is more than 3 years ago, so it no longer counts toward experience (only exits within the last 36 months count). It can’t be verified toward experience.';
      return res.status(422).json({ error: msg, code: e.no_exit ? 'no_exit_date' : e.future ? 'future_exit' : 'exit_expired' });
    }
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
        type: 'track_record_unverified', title: 'A track-record project needs attention', badge: { text: 'Action needed', tone: 'action' },
        body: `Verification of your project at ${addr} was revoked: ${reason}. Please review it and its documents on your track record.`,
        link: '/track-record', ctaLabel: 'Review your track record' });
    } catch (_) { /* best-effort */ }
  } else {
    await audit(req, 'verify_track_record', 'track_record', req.params.id, { status });
  }
  // Live cross-user refresh (#112): the borrower + other staff see the new
  // verification badge / revoke on the line item immediately.
  require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
    require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
    // A fresh ask reopens the line's doc state (an open 'issue' stays issue).
    await db.query(`UPDATE track_records SET docs_status='requested', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','received','satisfied')`, [req.params.id]);
    await audit(req, 'request_track_record_doc', 'track_record', req.params.id, { applicationId: appId, label: ask.slice(0, 500) });
    require('../lib/events').publishTrackRecordUpdate(tr.rows[0].borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
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
const APP_STATUS = ['file_intake', 'new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];
// Borrower-facing status labels, the DECISION-milestone email set, the
// plain-language explanations, and the journey path all live in ONE shared
// module (src/lib/status-notify.js) so the borrower sees identical copy whether
// a status change originates in the portal OR directly in ClickUp (the inbound
// sync reuses the same builder). Imported here (not redefined) to stay in sync.
const { STATUS_LABEL, MAJOR_STATUSES, borrowerStatusOpts } = require('../lib/status-notify');
// Announce a borrower-facing status transition to the borrower + the team.
// Extracted so BOTH doors into the borrower-facing bucket notify IDENTICALLY:
// the PATCH /:id status route AND the POST /:id/internal-status door (the
// 38-status ClickUp workflow the team also drives). Previously only PATCH
// notified, so funding/approving a file via the internal-status dropdown gave
// the borrower NO email — a real parity gap (owner-directed 2026-07-20). Only
// call this when the borrower-facing bucket ACTUALLY changed (from !== to): the
// internal door often moves between two internal statuses that map to the SAME
// external bucket, and re-announcing an unchanged status would be a wrong-time /
// duplicate email. A soft-deleted file is skipped (it's out of the pipeline —
// "your loan is now …" would be a wrong-time send). Best-effort; never throws.
// (A status change made directly in ClickUp is handled by the inbound sync via
// statusNotify.notifyInboundStatusChange, sharing borrowerStatusOpts below.)
// Which internal statuses trigger an AUTO-ISSUE of a Sovereign signed
// snapshot (owner-directed 2026-07-22, R2.4). Every material milestone
// gets an immutable snapshot the moment the file reaches it — so a later
// audit can prove the state PILOT made the decision on. Best-effort:
// a snapshot failure never blocks the status change or its notifications.
const CERT_MILESTONE_BY_STATUS = { clear_to_close: 'clear_to_close', funded: 'pre_funding' };

async function notifyStatusTransition(appId, fromStatus, toStatus, opts = {}) {
  try {
    const live = await db.query(`SELECT deleted_at FROM applications WHERE id=$1`, [appId]);
    if (!live.rows[0] || live.rows[0].deleted_at) return;
    const label = STATUS_LABEL[toStatus] || toStatus;
    const fromLabel = STATUS_LABEL[fromStatus] || fromStatus;
    // Borrower half — identical copy to the inbound (ClickUp-driven) path.
    await notify.notifyAppBorrowers(appId, borrowerStatusOpts(appId, fromStatus, toStatus));
    await notify.notifyAppStaff(appId, {   // #113: whole team (primary + assistants), minus the actor
      type: 'status_change', title: `File moved to ${label}`,
      body: `This file moved from "${fromLabel}" to "${label}"${opts.forced ? ' (advanced with an admin override)' : ''}.`,
      applicationId: appId, link: `/internal/app/${appId}`, exceptStaffId: opts.actorId,
      // Owner-directed 2026-07-20: the team gets an EMAIL only on DECISION
      // milestones (approved / clear-to-close / funded / declined / withdrawn).
      // Routine working moves (in review, processing, underwriting) post in-app
      // only — no inbox bombardment when a file advances a step.
      inAppOnly: !MAJOR_STATUSES.has(toStatus) });
    // R2.4 — Sovereign signed-snapshot AUTO-ISSUE on milestone moves. Fires only
    // when the transition is INTO a milestone that carries a certificate meaning
    // (clear_to_close → 'clear_to_close' cert; funded → 'pre_funding' cert),
    // never on a lateral / backward move. Best-effort per pattern.
    const milestone = CERT_MILESTONE_BY_STATUS[toStatus];
    if (milestone && toStatus !== fromStatus) {
      try {
        const cert = require('../lib/underwriting/certificate');
        const client = await db.pool.connect();
        try {
          await client.query('BEGIN');
          await cert.issueCertificate(client, {
            appId, milestone, staffId: opts.actorId || null,
            reason: `auto-issued on transition to ${label}`,
          });
          await client.query('COMMIT');
        } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
        finally { client.release(); }
      } catch (e) { console.error('[cert] auto-issue', appId, milestone, e && e.message); }
    }
  } catch (_) { /* notify best-effort */ }
}
// Conditions-to-close gating. Reaching "clear to close" requires every open
// prior-to-docs (and standard) condition cleared/waived and every gate item
// signed off; "funded" additionally requires prior-to-funding conditions.
// post_closing conditions never block. An admin may force past blockers.
const CTC_SEVERITIES = ['standard', 'prior_to_docs'];
const FUND_SEVERITIES = ['standard', 'prior_to_docs', 'prior_to_funding'];
const SEV_LABEL = { standard: 'Standard', prior_to_docs: 'Prior to docs', prior_to_funding: 'Prior to funding', post_closing: 'Post-closing' };
// Which file SECTION resolves a given blocker — so the "clear to close"
// outstanding list can link each item straight to where you fix it (the section
// expands + scrolls). Keyed on tool_key / template_code / audience. Anything we
// don't recognize points at the shared "Conditions to close" section.
function sectionForBlocker(row) {
  const tk = row.tool_key || '';
  const code = row.template_code || '';
  // Pricing + appraisal blockers keep their own sections; EVERYTHING condition-ish
  // (borrower conditions, underwriting conditions, internal staff conditions, LLC)
  // now lives in the single tabbed "Conditions" hub — condTabForBlocker picks the tab.
  if (tk === 'product_pricing' || code === 'rtl_p1_product') return 'sec-pricing';
  if (code === 'appraisal_review_cleared' || code === 'rtl_p3_apprreview' || code === 'rtl_cond_appraisaldocs' || tk === 'appraisal_review') return 'sec-appraisal';
  if (tk === 'esign') return 'sec-esign';
  return 'sec-conditions';
}
// Which tab inside the Conditions hub a blocker belongs to (only meaningful when
// section === 'sec-conditions').
function condTabForBlocker(row) {
  const code = row.template_code || '';
  if (row.source === 'underwriting') return 'underwriting';
  if (code === 'rtl_p1_llc') return 'llc';
  if (row.audience === 'staff') return 'internal';
  return 'borrower';
}
// A short, plain-language "why this is still outstanding" for the list.
function blockerReason(row) {
  if (row.kind === 'gate') return 'A gate — it must be signed off before this file can clear to close.';
  if (row.severity) return `${SEV_LABEL[row.severity] || row.severity} condition — clear or waive it.`;
  if (row.status === 'received') return 'A document is in — it just needs a final sign-off.';
  if (row.status === 'issue') return 'Sent back to the borrower — waiting on a corrected item.';
  if (String(row.hint || '').trim()) return String(row.hint).trim();
  return 'Not completed and signed off yet.';
}
function decorateBlocker(row, kind) {
  const r = { ...row, kind, title: row.title || row.label };
  // A blocker may pin its OWN destination + explanation (e.g. the underwriting
  // dealbreaker points at the findings desk, not the conditions hub, and carries
  // the actual finding text). Otherwise fall back to the derived section/reason.
  r.section = row.section || sectionForBlocker(r);
  if (r.section === 'sec-conditions') r.condTab = condTabForBlocker(r);
  r.reason = row.reason || blockerReason(r);
  return r;
}
async function advancementBlockers(appId, target) {
  const sevs = target === 'funded' ? FUND_SEVERITIES : CTC_SEVERITIES;
  const conds = await db.query(
    `SELECT id, COALESCE(borrower_title, title) AS title, severity, audience
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
    `SELECT ci.id, COALESCE(ci.label, ci.borrower_label, 'Condition') AS title,
            ci.tool_key, t.code AS template_code, ci.audience, ci.status, ci.hint
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1
        AND ci.item_kind IN ('document','condition')
        AND COALESCE(ci.is_required, true) = true
        AND COALESCE(ci.is_gate, false) = false
        AND NOT (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')
      ORDER BY ci.sort_order, ci.created_at`, [appId]);
  const gates = await db.query(
    `SELECT ci.id, ci.label, ci.tool_key, t.code AS template_code, ci.audience, ci.status
       FROM checklist_items ci
       LEFT JOIN checklist_templates t ON t.id = ci.template_id
      WHERE ci.application_id=$1 AND ci.is_gate=true AND NOT (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')
      ORDER BY ci.sort_order, ci.created_at`, [appId]);
  // Tag the first-class `conditions`-table rows so navigation sends them to the
  // Underwriting-conditions panel (which renders them) rather than a checklist section.
  const underwriting = conds.rows.map(r => ({ ...r, source: 'underwriting' }));
  // Underwriting DEALBREAKERS gate clear-to-close AND funding directly — whether or not the
  // `underwriting_review_cleared` condition was ever materialized. A derived tie-out (cross-
  // document) fatal has NO stored condition row, so the checklist queries above are blind to it;
  // relying on the materialized gate item alone let a file with an open cross-document fatal
  // (e.g. a settlement price that disagrees with the file) advance to clear-to-close (audit
  // 2026-07-20). fileFatalCount is the authoritative count — stored per-document fatals PLUS the
  // derived tie-out fatals — computed live, so this covers previous AND future files with no
  // backfill. Best-effort: a tie-out compute error must never silently OPEN the gate, so a
  // failure leaves the stored-fatal count in place (fileFatalCount already swallows tie-out
  // errors and still returns the stored count). Tagged source:'underwriting' so it decorates +
  // navigates to the underwriting-conditions panel like the other first-class conditions.
  let underwritingFatals = [];
  try {
    const { fileFatalDetails } = require('../lib/underwriting/file-review');
    // Pull the ACTUAL findings (title + what disagrees), not just a count — a loan
    // officer needs to know WHAT the dealbreaker is, and "Go fix →" must land on the
    // Document-review desk where the finding actually lives (not the conditions hub,
    // where a derived tie-out/experience fatal has no row to show — that was the
    // dead "Go fix" + vague "1 open dealbreaker finding" the LO reported).
    const details = await fileFatalDetails(db, appId);
    if (details.length) {
      const first = details[0];
      const more = details.length - 1;
      const cap = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
      const title = details.length === 1
        ? `Underwriting dealbreaker: ${cap(first.title, 140)}`
        : `${details.length} underwriting dealbreakers to resolve`;
      const bits = [];
      const dv = cap(first.docValue, 120);
      const fv = cap(first.fileValue, 120);
      if (dv && fv) bits.push(`The document says “${dv}”, but our file says “${fv}”.`);
      else if (first.howTo) bits.push(cap(first.howTo, 300));
      if (more > 0) bits.push(`Plus ${more} more finding${more === 1 ? '' : 's'}.`);
      bits.push('Open the “Document review & PILOT findings” section to fix it or grant an exception.');
      underwritingFatals = [{
        id: 'underwriting_fatal', title, label: title, source: 'underwriting',
        section: 'sec-underwriting', reason: bits.join(' '),
      }];
    }
  } catch (_) { /* never break advancement gating on a tie-out compute error */ }
  // R3.17 — AI fraud/authenticity fatal suggestions surface here as ADVISORY
  // blockers so a reviewer sees them on the readiness widget before moving to
  // clear-to-close. Per HARD RULE the AI never blocks the transition itself
  // — the client's "Advance" action may still confirm past them. Best-effort:
  // a load failure never breaks the readiness view.
  let aiAdvisories = [];
  try {
    const fa = require('../lib/underwriting/fraud-alert');
    const signals = await fa.openMajorSignals(appId, db);
    aiAdvisories = signals.map(s => ({
      id: `ai:${s.id}`, title: `AI advisory: ${s.title}`, source: 'ai_suggestion',
      section: 'sec-underwriting',
      reason: `A ${s.source.replace(/_/g, ' ')} signal is open on the AI Findings panel. Review or dismiss before moving to clear-to-close.`,
    }));
  } catch (_) { aiAdvisories = []; }
  return {
    conditions: [...underwriting, ...checklistConds.rows, ...underwritingFatals, ...aiAdvisories].map(r => decorateBlocker(r, 'condition')),
    gates: gates.rows.map(r => decorateBlocker(r, 'gate')),
  };
}

// Readiness for the gated transitions — powers the "conditions to close" widget.
router.get('/applications/:id/gating', async (req, res) => {
  try {
    const [ctc, fund, cleared] = await Promise.all([
      advancementBlockers(req.params.id, 'clear_to_close'),
      advancementBlockers(req.params.id, 'funded'),
      workflow.conditionsClearedPct(req.params.id),   // powers the condition-clearing submit + helper text
    ]);
    res.json({
      clear_to_close: { ready: !ctc.conditions.length && !ctc.gates.length, ...ctc },
      funded: { ready: !fund.conditions.length && !fund.gates.length, ...fund },
      conditions_cleared: cleared,
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
  // #84 — a clear-to-close / funded file's loan structure is FROZEN for everyone,
  // super_admin included. This economics editor is one of the write paths that
  // used to skip the freeze (it could rewrite a funded loan's numbers). A
  // super_admin can UNLOCK the file first to correct a mistake, then re-lock.
  const detailsLock = await require('../lib/file-lock').structuralLockReason(req.params.id, db, { actor: req.actor });
  if (detailsLock) return res.status(409).json({ error: detailsLock, locked: true });
  // sqft only applies to a square-footage / ground-up rehab. When the rehab type
  // is being changed to something else, null any stale sqft in the SAME update so
  // it can't keep flipping the pricing engine's sqftAddition flag (its
  // `sqft_post > sqft_pre` clause). The forms always send both together.
  if ('rehabType' in b && !require('../lib/fields').sqftRelevantType(b.rehabType)) {
    b.sqftPre = null; b.sqftPost = null;
  }
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
  for (const [k, col] of Object.entries(STR)) if (k in b) { const raw = b[k] === '' ? null : String(b[k]).slice(0, 200); sets.push(`${col}=$${i++}`); vals.push(col === 'loan_type' ? require('../lib/fields').sanitizeLoanType(raw) : raw); touchedCols.push(col); }   // #95: loan_type never a program
  for (const [k, col] of Object.entries(DATE)) if (k in b) {
    // sanitizeDateOnly enforces a REAL calendar date with a 4-digit year in
    // [1900, 2100] — a 2-digit year ('0026-…') is rejected here instead of
    // persisting and syncing out (2026-07-15 incident class).
    const v = b[k] === '' || b[k] == null ? null : require('../lib/fields').normalizeTypedDate(b[k]);
    if (b[k] && v == null) return res.status(400).json({ error: `${k} must be a valid YYYY-MM-DD date with a 4-digit year (1900–2100)` });
    sets.push(`${col}=$${i++}`); vals.push(v); touchedCols.push(col);
  }
  if ('isAssignment' in b) { sets.push(`is_assignment=$${i++}`); vals.push(!!b.isAssignment); touchedCols.push('is_assignment'); }
  if (b.propertyAddress !== undefined) { sets.push(`property_address=$${i++}`); vals.push(b.propertyAddress ? JSON.stringify(b.propertyAddress) : null); touchedCols.push('property_address'); }
  // Couple units to a property_type change when the caller didn't send units
  // explicitly (a direct API call, or the completeness panel) — mirrors the
  // intake form's unitsForType so a single-family type auto-fills "1 unit" and a
  // switch to multi doesn't keep a stale single "1".
  if ('propertyType' in b && !('units' in b)) {
    const curU = (await db.query(`SELECT units FROM applications WHERE id=$1`, [req.params.id])).rows[0];
    const prevUnits = curU ? curU.units : null;
    const nextUnits = require('../lib/units').unitsForPropertyType(b.propertyType, prevUnits);
    if (nextUnits !== prevUnits) { sets.push(`units=$${i++}`); vals.push(nextUnits); touchedCols.push('units'); }
  }
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
      // Loan Digital Twin (Sovereign 1/4): the same-write also feeds the twin so
      // the LOS-side value shows up as an observation next to any document-sourced
      // observations for the same fact. Best-effort.
      try {
        const row = (await db.query(
          `SELECT loan_amount, purchase_price, as_is_value, arv, rehab_budget, assignment_fee,
                  underlying_contract_price, property_type, units, property_address, program, loan_type
             FROM applications WHERE id=$1`, [req.params.id])).rows[0];
        if (row) {
          const client = await db.getClient();
          try {
            await client.query('BEGIN');
            await require('../lib/underwriting/twin').recordLosFieldFacts(client, req.params.id, row);
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
          finally { client.release(); }
        }
      } catch (_) { /* twin capture is additive */ }
    }
    res.json({ ok: true, changed: Object.keys(changes), conditions });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Backfill / set the file's YS loan number. Needed at send time: the term-sheet
// package prints the loan number on the business-purpose disclosure, so a file
// missing it can't send — staff enter it right where the send failed. RULES
// (owner-directed 2026-07-20): must start with "YSCAP" and be UNIQUE across files
// (never a duplicate of another file's number). Filling a BLANK is open to anyone
// who can touch the file; CHANGING an existing number is an admin action (it's a key
// already shared with the LOS/ClickUp — a stray edit must never clobber it). Rides
// the /applications/:id scope guard for access control.
router.post('/applications/:id/loan-number', async (req, res) => {
  const { sanitizeLoanNumber } = require('../lib/fields');
  const ln = sanitizeLoanNumber((req.body || {}).loanNumber);
  if (!ln) return res.status(400).json({ error: 'A YS loan number must start with “YSCAP” (for example YSCAP258134628).' });
  try {
    const cur = await db.query(`SELECT ys_loan_number FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'application not found' });
    const existing = cur.rows[0].ys_loan_number;
    if (existing && String(existing).toUpperCase() === ln) return res.json({ ok: true, loanNumber: existing, unchanged: true });
    if (existing && !seesAll(req)) return res.status(403).json({ error: 'This file already has a loan number — only an admin can change it.' });
    // Uniqueness across BOTH our own files AND every ClickUp file — including a
    // data-only (e.g. DSCR) task we pull for data but never turn into a loan file
    // (owner-directed 2026-07-20). The db/048 partial-unique index is the final
    // backstop for our own files; this is the friendly, ClickUp-wide front door.
    // ANY collision is ALSO parked to manual review so nothing "bumping" is silent.
    const loanNumber = require('../lib/loan-number');
    const collision = await loanNumber.findLoanNumberCollision(ln, { excludeAppId: req.params.id });
    if (collision) {
      let queued = false;
      try {
        // Show WHICH side already carries the number — never both. The number was
        // REJECTED here (never saved to this file), so "In PILOT"/"In ClickUp"
        // must reflect the OTHER file that owns it, not this rejected entry. The
        // collision detail (other file / task) rides raw_value for the reviewer.
        queued = await require('../lib/sync-review').queueReview({
          applicationId: req.params.id, direction: 'outbound', fieldKey: 'ys_loan_number',
          reason: 'loan_number_duplicate_entered', proposedValue: ln,
          portalValue: collision.where === 'our_file' ? ln : null,
          clickupValue: collision.where === 'clickup_file' ? ln : null,
          rawValue: JSON.stringify({
            number: ln, where: collision.where,
            ofApplication: collision.applicationId || null, taskName: collision.taskName || null,
          }),
          suppressIfRejected: true,
        });
      } catch (_) { /* review is best-effort; the reject below is the hard stop */ }
      const msg = loanNumber.collisionMessage(collision, ln)
        + (queued ? ' It’s been flagged for manual review.' : '');
      return res.status(409).json({ error: msg, duplicate: true });
    }
    let upd;
    try {
      upd = await db.query(`UPDATE applications SET ys_loan_number=$1, updated_at=now() WHERE id=$2 AND deleted_at IS NULL RETURNING ys_loan_number`, [ln, req.params.id]);
    } catch (e) {
      // Partial-unique index caught a race (two files grabbing the same number at once).
      if (e && e.code === '23505') return res.status(409).json({ error: 'That loan number was just taken by another file — loan numbers must be unique.' });
      throw e;
    }
    if (!upd.rows.length) return res.status(404).json({ error: 'application not found' });
    await audit(req, 'set_loan_number', 'application', req.params.id, { from: existing || null, to: ln });
    enqueueClickupPush(req.params.id, ['ys_loan_number']).catch(() => {});   // keep ClickUp/LOS in sync (self-gates; no-op when unmapped/unlinked)
    res.json({ ok: true, loanNumber: upd.rows[0].ys_loan_number });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
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
    // Anti-double-send (round-2 audit N2): a "Remind" is a deliberate reach-out,
    // but repeated/accidental clicks must not email the borrower several times in
    // a row. Block a repeat nudge to the SAME file within a short window; a
    // genuine later reminder still goes through.
    // Atomically CLAIM the 30-min nudge slot (stamp-first): this ONE INSERT both
    // records the audit event AND enforces the throttle, so two simultaneous
    // "Remind" clicks can't both pass a SELECT and both email the borrower. The
    // loser gets the 429. (Old shape SELECTed then stamped after send — a race.)
    const nudgeClaimId = await claimOncePerPeriod({ action: 'nudge_borrower', entityId: req.params.id, interval: '30 minutes', actorKind: 'staff', actorId: req.actor.id, detail: { count: list.length } });
    if (!nudgeClaimId) return res.status(429).json({ error: 'This borrower was already reminded on this file in the last 30 minutes — please wait before sending another.' });
    await notify.notifyAppBorrowers(req.params.id, {
      type: 'reminder', title: 'A friendly reminder on your loan file',
      body: `Still needed to keep things moving: ${shown}.`,
      applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'Complete your items',
      major: true });   // #88: the staff "Remind" nudge is an explicit reach-out — it emails
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
  // Server-side year bounds (2026-07-15 incident): a mid-typing artifact like
  // year 0026 must never persist even if a client bypasses the UI guard. A
  // typed 2-DIGIT year ("26" → browser sends 0026-…) RESOLVES to the real year
  // (normalizeTypedDate → 2026) instead of erroring — one way to read a date,
  // system-wide. Truly invalid input (bad shape, impossible day, year 0203) 400s.
  const { normalizeTypedDate } = require('../lib/fields');
  const normExpected = 'expectedClosing' in b && b.expectedClosing ? normalizeTypedDate(b.expectedClosing) : null;
  const normActual = 'actualClosing' in b && b.actualClosing ? normalizeTypedDate(b.actualClosing) : null;
  if ((b.expectedClosing && !normExpected) || (b.actualClosing && !normActual)) {
    return res.status(400).json({ error: 'dates must be a valid YYYY-MM-DD with a real year (1900–2100)' });
  }
  if ('expectedClosing' in b) { sets.push(`expected_closing=$${i++}`); vals.push(normExpected); }
  if ('actualClosing' in b) { sets.push(`actual_closing=$${i++}`); vals.push(normActual); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(req.params.id);
  try {
    // Before-image for the audit trail (incident gap: set_closing_date logged
    // only the NEW values, so damage could not be reconstructed from audit_log).
    const beforeRow = (await db.query(`SELECT expected_closing, actual_closing FROM applications WHERE id=$1`, [req.params.id])).rows[0] || {};
    await db.query(`UPDATE applications SET ${sets.join(',')} WHERE id=$${i}`, vals);
    await audit(req, 'set_closing_date', 'application', req.params.id, {
      expectedClosing: b.expectedClosing, actualClosing: b.actualClosing,
      before: { expectedClosing: beforeRow.expected_closing || null, actualClosing: beforeRow.actual_closing || null } });
    // Propagate the new expected closing to ClickUp right away (scoped push —
    // only this field). actual_closing is pull-only (ClickUp owns it).
    if ('expectedClosing' in b) enqueueClickupPush(req.params.id, ['expected_closing']).catch(() => {});
    if (b.expectedClosing) {
      const a = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
      if (a.rows[0] && a.rows[0].borrower_id) {
        const nice = new Date(normExpected + 'T00:00:00').toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
        await notify.notifyAppBorrowers(req.params.id, {
          type: 'closing_date', title: `Estimated closing date: ${nice}`,
          body: `Your loan is now targeting a closing date of ${nice}. We'll keep you posted as it approaches — reach out any time with questions.`,
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
  purchase_price: 'money', as_is_value: 'money', arv: 'money', rehab_budget: 'money',
  // Note buyer / capital partner (applications.lender). Normally fed from ClickUp,
  // but staff can fill/correct it here when ClickUp doesn't feed it or is empty —
  // it's part of application completeness (owner-directed 2026-07-20). STAFF-ONLY;
  // never offered on the borrower completeness panel.
  lender: 'text' };
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
      if (k === 'loan_type') v = require('../lib/fields').sanitizeLoanType(v);   // #95: never a program
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
      // #84 — this staff completeness path writes the SAME frozen economics fields
      // as PATCH /details (program / loan_type / property_type / price / as-is / ARV
      // / rehab budget), so it must honor the clear-to-close / funded freeze too — a
      // super_admin can unlock the file to correct it. The NOTE BUYER (lender) is
      // pure staff metadata (not a frozen economics field), so a lender-only edit
      // is allowed even on a locked file; the freeze only guards economics.
      if (appKeys.some((k) => k !== 'lender')) {
        const lock = await require('../lib/file-lock').structuralLockReason(req.params.id, db, { actor: req.actor });
        if (lock) return res.status(409).json({ error: lock, locked: true });
      }
      appSets.push('updated_at=now()');
      await db.query(`UPDATE applications SET ${appSets.join(', ')} WHERE id=$1`, appVals);
      enqueueClickupPush(req.params.id, appKeys).catch(() => {});
      // Filling a rule-driven field here (most importantly the NOTE BUYER) may
      // attach/retract a condition — e.g. the CorrFirst EMD verification — and can
      // flip the 5% SOW-contingency requirement (a Blue Lake note buyer). Re-run
      // the Condition Center engine and enforce the contingency, exactly like the
      // details edit path does. Best-effort — never blocks the save.
      try { await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'completeness_edited' }); } catch (_) {}
      try { await require('../lib/rehab-budget').enforceSowContingency(req.params.id); } catch (_) {}
      // Loan Digital Twin (Sovereign 1/4, owner-directed 2026-07-21): every LOS
      // field write is a fresh observation of the underlying canonical facts
      // (loan.amount, property.address, etc.). Feeds the twin so the completeness
      // edit shows up in the "canonical facts" cockpit alongside every document-
      // sourced observation. Best-effort — never blocks the save.
      try {
        const row = (await db.query(
          `SELECT loan_amount, purchase_price, as_is_value, arv, rehab_budget, assignment_fee,
                  underlying_contract_price, property_type, units, property_address, program, loan_type
             FROM applications WHERE id=$1`, [req.params.id])).rows[0];
        if (row) {
          const client = await db.getClient();
          try {
            await client.query('BEGIN');
            await require('../lib/underwriting/twin').recordLosFieldFacts(client, req.params.id, row);
            await client.query('COMMIT');
          } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
          finally { client.release(); }
        }
      } catch (_) { /* twin capture is additive */ }
    }
    const brVals = [bid]; const brSets = []; const brKeys = [];
    for (const [k, t] of Object.entries(COMPLETE_BORROWER_FIELDS)) {
      if (!(k in b) || b[k] === '' || b[k] == null) continue;
      let v = b[k];
      if (t === 'int') { v = k === 'fico' ? require('../lib/fields').sanitizeFico(v) : parseInt(v, 10); if (v == null || !Number.isFinite(v)) continue; }  // #90: FICO 300–850
      if (t === 'date') {  // 2026-07-15 incident: strict calendar + year bounds;
        // a typed 2-digit year resolves to the real year (DOB → adult century).
        v = require('../lib/fields').sanitizeDob(v);
        if (v == null) continue;
      }
      brVals.push(v); brSets.push(`${k}=$${brVals.length}`); brKeys.push(k);
    }
    let brBefore = null;
    if (brSets.length) {
      // Before-image for the audit trail (incident gap: this audit logged a COUNT).
      try { brBefore = (await db.query(`SELECT ${brKeys.join(', ')} FROM borrowers WHERE id=$1`, [bid])).rows[0] || null; } catch (_) {}
      brSets.push('updated_at=now()');
      await db.query(`UPDATE borrowers SET ${brSets.join(', ')} WHERE id=$1`, brVals);
      // Borrower identity fields (DOB / cell / FICO / citizenship) now propagate
      // to ClickUp immediately, like app fields always did — the owner-reported
      // gap where a DOB "added after the application" never reached ClickUp
      // until an unrelated full repush. A typed DOB is marked as the HUMAN
      // decision so the outbound DOB gate writes it through instead of parking
      // the staffer's own edit in the review queue (owner-directed 2026-07-15
      // night: DOB fully editable from PILOT).
      enqueueClickupPush(req.params.id, brKeys,
        { humanEditKeys: brKeys.filter((k) => k === 'date_of_birth') }).catch(() => {});
    }
    if (!borrowerScoped) await audit(req, 'complete_fields', 'application', req.params.id, { app: appKeys, borrower: brKeys, before: brBefore || undefined });
    res.json({ ok: true, appFields: appKeys.length, borrowerFields: brSets.length });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
}
router.post('/applications/:id/complete-fields', (req, res) => completeFields(req, res, false));

// All note buyers available to pick in the completeness panel — every value from
// the ClickUp note-buyer dropdown, PLUS the confirmed registry set and anything
// already on a file (owner-directed 2026-07-20). Staff-only (this whole router is
// staff-gated) — a note buyer name is never exposed to a borrower.
router.get('/note-buyers', async (req, res) => {
  try {
    const noteBuyers = await require('../lib/note-buyers').listNoteBuyers();
    res.json({ noteBuyers });
  } catch (e) { console.warn('[staff] note-buyers error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// S3-05: DECISION-grade statuses are an underwriting call — only roles with
// see_all_files authority (admin / underwriter / loan_coordinator) may move a file
// into one. A loan officer or processor can advance a file through the working
// statuses but cannot approve, clear-to-close, fund, or decline it.
const DECISION_STATUSES = new Set(['approved', 'clear_to_close', 'funded', 'declined']);

// Shared status DOOR (owner-directed 2026-07-21). Set the EXACT ClickUp internal
// status, re-derive the borrower-facing bucket, mirror to ClickUp, record the
// transition on the file timeline, seed post-closing on funded, re-run the
// condition rule engine, and announce the transition to borrower + team. BOTH the
// internal-status route AND the new WORKFLOW submit path call this — so a
// workflow button click drives the status + ClickUp card automatically (the
// workflow drives the status, not the other way around). The caller audits (audit
// needs the request); this returns everything the caller needs to log it.
//   opts: { actorId, canDecide (see_all_files), force, allowForce (isAdmin) }
//   returns one of:
//     { unchanged:true, internal_status, status }
//     { forbidden:true, reason }                         — decision-grade + not canDecide
//     { blocked:true, target, blockers }                 — conditions/gates outstanding + not forced
//     { ok:true, internal_status, status, fromStatus, forced }
async function applyInternalStatus(appId, internalStatus, opts = {}) {
  if (!statusMap.isKnownInternal(internalStatus)) { const e = new Error('unknown internal status'); e.code = 'unknown_status'; throw e; }
  const external = statusMap.externalFor(internalStatus);
  const cur = await db.query(`SELECT status, internal_status FROM applications WHERE id=$1`, [appId]);
  if (!cur.rows[0]) { const e = new Error('not found'); e.code = 'not_found'; throw e; }
  if (statusMap.norm(cur.rows[0].internal_status) === statusMap.norm(internalStatus))
    return { unchanged: true, internal_status: internalStatus, status: external };
  if (DECISION_STATUSES.has(external) && !opts.canDecide)
    return { forbidden: true, reason: 'Only an underwriter or admin can move a file to this status.' };
  let forced = false;
  if (external === 'clear_to_close' || external === 'funded') {
    const blockers = await advancementBlockers(appId, external);
    if (blockers.conditions.length || blockers.gates.length) {
      if (!(opts.force && opts.allowForce)) return { blocked: true, target: external, blockers };
      forced = true;
    }
  }
  await db.query(
    // status_notified_external tracks the announced status (db/187) so a ClickUp
    // echo of this change never re-notifies the borrower.
    `UPDATE applications SET internal_status=$2, status=$3, status_notified_external=$3, status_changed_at=now(), updated_at=now() WHERE id=$1`,
    [appId, internalStatus, external]);
  enqueueClickupPush(appId, ['internal_status']).catch(() => {}); // push the ClickUp task status + the mirror
  await db.query(
    `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, forced)
     VALUES ($1,$2,$3,$4,$5)`, [appId, cur.rows[0].status, external, opts.actorId || null, forced]);
  if (external === 'funded') {
    try { await seedPostClosing(appId); } catch (_) {}
    // The Workflow, phase two: a freshly-funded file auto-hands off to the draw
    // coordinator (best-effort — never breaks the status move).
    try { await workflowAuto.onFunded(appId, opts.actorId); } catch (_) {}
  }
  try { await conditionEngine.evaluateApplication(appId, { actor: opts.actorId ? { id: opts.actorId } : undefined, reason: 'status_change' }); } catch (_) {}
  // Announce only when the BORROWER-FACING bucket actually changed (many internal
  // statuses map to the same external bucket — re-announcing would be a wrong email).
  if (external !== cur.rows[0].status) {
    await notifyStatusTransition(appId, cur.rows[0].status, external, { forced, actorId: opts.actorId });
  }
  return { ok: true, internal_status: internalStatus, status: external, fromStatus: cur.rows[0].status, forced };
}

// The Workflow, phase two: after conditions move, gently nudge the loan officer
// when the file has just become READY for its next step (condition-clearing
// threshold reached, or clear-to-close ready). Throttled per file+step to at most
// once / ~day so it never spams. Advisory only — it never moves the file itself.
async function suggestNextStep(appId, actorId) {
  try {
    const app = (await db.query(`SELECT status, loan_officer_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app || !app.loan_officer_id) return;
    const [cleared, ctc, hasCC, hasCtc] = await Promise.all([
      workflow.conditionsClearedPct(appId),
      advancementBlockers(appId, 'clear_to_close'),
      workflowAuto.hasLiveItem(appId, 'condition_clearing'),
      workflowAuto.hasLiveItem(appId, 'clear_to_close'),
    ]);
    const suggestions = workflowAuto.nextStepSuggestions({
      status: app.status, clearedPct: cleared.pct,
      ctcReady: !ctc.conditions.length && !ctc.gates.length,
      hasLiveConditionClearing: hasCC, hasLiveClearToClose: hasCtc, threshold: 0.80,
    });
    for (const s of suggestions) {
      const claimId = await claimOncePerPeriod({ action: `wf_ready_${s.type}`, entityId: appId, interval: '20 hours' });
      if (!claimId) continue;   // already nudged for this step recently
      await notify.notifyStaff(app.loan_officer_id, {
        type: 'workflow_ready', title: 'This file is ready for its next step',
        body: s.message, applicationId: appId, ctaLabel: 'Open the loan file', link: `/internal/app/${appId}`,
      }).catch(() => {});
    }
  } catch (_) { /* best-effort — a suggestion must never break a sign-off */ }
}

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
    // Advance the go-forward notification watermark in lock-step with the status
    // we're about to announce, so a later ClickUp ECHO of this same change is
    // recognized as already-notified and does not re-notify (db/187).
    await db.query(`UPDATE applications SET status=$2, status_notified_external=$2, status_changed_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, status]);
    enqueueClickupPush(req.params.id, ['status']).catch(() => {}); // propagate ONLY the status change to ClickUp promptly
    // Record the transition on the file's timeline.
    await db.query(
      `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, forced)
       VALUES ($1,$2,$3,$4,$5)`, [req.params.id, cur.rows[0].status, status, req.actor.id, forced]);
    // Funding seeds the post-closing trailing-doc checklist + auto-hands off to
    // the draw coordinator (best-effort).
    if (status === 'funded') {
      try { await seedPostClosing(req.params.id); } catch (_) {}
      try { await workflowAuto.onFunded(req.params.id, req.actor.id); } catch (_) {}
    }
    await audit(req, 'status_change', 'application', req.params.id, { from: cur.rows[0].status, to: status, forced: forced || undefined });
    // Status is a rule-engine field (e.g. "when the file reaches underwriting").
    try { await conditionEngine.evaluateApplication(req.params.id, { actor: req.actor, reason: 'status_change' }); } catch (_) {}
    // Announce the transition to the borrower + team (shared with the
    // internal-status door so both notify identically). The bucket always
    // changed here (guarded by the unchanged-status early return above).
    await notifyStatusTransition(req.params.id, cur.rows[0].status, status, { forced, actorId: req.actor.id });
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
  try {
    const before = await db.query(`SELECT internal_status FROM applications WHERE id=$1`, [req.params.id]);
    // The shared status door does all the work (re-derive external, gate, push,
    // history, seed post-closing, re-run conditions, announce). This route just
    // maps its verdict to the right HTTP response + audits.
    const r = await applyInternalStatus(req.params.id, internalStatus, {
      actorId: req.actor.id, canDecide: seesAll(req),
      force: !!(req.body && req.body.force), allowForce: isAdmin(req),
    });
    if (r.forbidden) return res.status(403).json({ error: r.reason });
    if (r.blocked) return res.status(409).json({ error: 'blocked', target: r.target, blockers: r.blockers });
    if (r.unchanged) return res.json({ ok: true, unchanged: true, internal_status: r.internal_status, status: r.status });
    await audit(req, 'internal_status_change', 'application', req.params.id,
      { from: before.rows[0] ? before.rows[0].internal_status : null, to: internalStatus, external: r.status, forced: r.forced || undefined });
    res.json({ ok: true, internal_status: r.internal_status, status: r.status });
  } catch (e) {
    if (e && e.code === 'not_found') return res.status(404).json({ error: 'not found' });
    if (e && e.code === 'unknown_status') return res.status(400).json({ error: 'unknown internal status' });
    res.status(500).json({ error: 'server error' });
  }
});

// ===========================================================================
// THE WORKFLOW (owner-directed 2026-07-21) — submission hand-offs + personal
// work queues. A plain Submit button inside a file drops it onto the right
// downstream person's queue AND sets the file's status automatically (the
// workflow drives the status). Every recipient has their own ordered "up next"
// list + a "what I finished / sent back" history. The pure data logic lives in
// src/lib/workflow.js; this is the HTTP layer + the gating (which reuses the
// existing completeness / advancementBlockers / status-door machinery).
// ===========================================================================

// "Application completeness" for the Loan Setup gate — the file's core product +
// borrower identity must be filled before it can be set up. Returns the missing
// items in plain language so the Submit panel can show exactly what's needed.
async function applicationCompleteness(appId) {
  const r = await db.query(
    `SELECT a.program, a.loan_type, a.property_type, b.cell_phone, b.date_of_birth, b.fico
       FROM applications a JOIN borrowers b ON b.id = a.borrower_id WHERE a.id = $1`, [appId]);
  const row = r.rows[0] || {};
  const need = [
    [row.program, 'Program'], [row.loan_type, 'Loan type'], [row.property_type, 'Property type'],
    [row.cell_phone, 'Borrower phone'], [row.date_of_birth, 'Borrower date of birth'], [row.fico, 'Borrower FICO score'],
  ];
  const missing = need.filter(([v]) => v == null || v === '').map(([, label]) => label);
  return { complete: missing.length === 0, missing };
}
const COND_CLEAR_THRESHOLD = 0.80;   // "once 80–90% of conditions are cleared" (owner)

// The data behind the file's Submit panel: which people each type routes to (the
// already-assigned person or the list to pick from), what's already in someone's
// queue, and the gating status per type so a button can disable + explain itself.
router.get('/applications/:id/workflow/options', async (req, res) => {
  const appId = req.params.id;
  try {
    const app = (await db.query(
      `SELECT a.id, a.status, a.processor_id, a.closer_id, a.underwriter_id, a.loan_officer_id, a.expected_closing,
              p.full_name AS processor_name, c.full_name AS closer_name, u.full_name AS underwriter_name
         FROM applications a
         LEFT JOIN staff_users p ON p.id = a.processor_id
         LEFT JOIN staff_users c ON c.id = a.closer_id
         LEFT JOIN staff_users u ON u.id = a.underwriter_id
        WHERE a.id = $1 AND a.deleted_at IS NULL`, [appId])).rows[0];
    if (!app) return res.status(404).json({ error: 'not found' });
    const [completeness, cleared, live, ctc, procs, closers, draws, sadmins, everyone] = await Promise.all([
      applicationCompleteness(appId),
      workflow.conditionsClearedPct(appId),
      workflow.fileLiveItems(appId),
      advancementBlockers(appId, 'clear_to_close'),
      workflow.candidatesForRole('processor'),
      workflow.candidatesForRole('closer'),
      workflow.candidatesForRole('draw_coordinator'),
      workflow.candidatesForRole('super_admin'),
      workflow.allActiveStaff(),
    ]);
    res.json({
      types: workflow.TYPES,
      appStatus: app.status,
      funded: app.status === 'funded',
      assigned: {
        processor: app.processor_id ? { id: app.processor_id, name: app.processor_name } : null,
        closer: app.closer_id ? { id: app.closer_id, name: app.closer_name } : null,
        underwriter: app.underwriter_id ? { id: app.underwriter_id, name: app.underwriter_name } : null,
      },
      candidates: { processor: procs, closer: closers, draw_coordinator: draws, super_admin: sadmins, all: everyone },
      completeness,
      conditionsCleared: cleared,
      conditionsThreshold: COND_CLEAR_THRESHOLD,
      ctcReady: !ctc.conditions.length && !ctc.gates.length,
      ctcHardBlockers: ctc.conditions.filter((c) => c.source === 'underwriting'),
      live,
      outcomeLabels: workflow.OUTCOME_LABELS,
      expectedClosing: app.expected_closing || null,
    });
  } catch (e) { console.warn('[workflow] options error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// The file's Workflow timeline (every hand-off event) for the file page.
router.get('/applications/:id/workflow/timeline', async (req, res) => {
  try { res.json(await workflow.fileTimeline(req.params.id)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// SUBMIT a file into the workflow. Body: { submissionType, toStaffId?, note?,
// priority?, estClosingDate? }. Gates per type, resolves the recipient (assigned
// person, else the chosen one), records the hand-off + event, opens the closing
// sub-workflow for a closing submit, then DRIVES the status via the shared door.
router.post('/applications/:id/workflow/submit', async (req, res) => {
  const appId = req.params.id;
  const b = req.body || {};
  const cfg = workflow.typeConfig(b.submissionType);
  if (!cfg) return res.status(400).json({ error: 'unknown submission type' });
  try {
    const app = (await db.query(
      `SELECT id, status, processor_id, closer_id, underwriter_id, loan_officer_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [appId])).rows[0];
    if (!app) return res.status(404).json({ error: 'not found' });

    // ---- GATE per submission type (reuses the existing engines) ----
    if (cfg.gate === 'completeness') {
      const c = await applicationCompleteness(appId);
      if (!c.complete) return res.status(409).json({ error: 'incomplete', missing: c.missing });
    } else if (cfg.gate === 'conditions') {
      const cc = await workflow.conditionsClearedPct(appId);
      if (cc.pct < COND_CLEAR_THRESHOLD) return res.status(409).json({ error: 'conditions_not_ready', ...cc, threshold: COND_CLEAR_THRESHOLD });
    } else if (cfg.gate === 'ctc') {
      // The LO marks his side done but does NOT sign off — the CTC handler signs
      // off in the workflow. So only HARD underwriting dealbreakers block the
      // SUBMIT; open sign-offs are expected and do not block.
      const blk = await advancementBlockers(appId, 'clear_to_close');
      const fatal = blk.conditions.filter((c) => c.source === 'underwriting');
      if (fatal.length) return res.status(409).json({ error: 'blocked', blockers: { conditions: fatal, gates: [] } });
    } else if (cfg.gate === 'funded') {
      if (app.status !== 'funded') return res.status(409).json({ error: 'not_funded' });
    } else if (cfg.gate === 'recipient') {
      if (!b.toStaffId) return res.status(400).json({ error: 'pick_recipient', role: null });
    }

    // ---- RESOLVE the recipient: assigned person, else the submitter's pick ----
    let toStaffId = null, setPointer = false;
    if (cfg.pointer && app[cfg.pointer]) {
      toStaffId = app[cfg.pointer];
    } else if (b.toStaffId) {
      toStaffId = b.toStaffId;
      setPointer = !!(cfg.pointer && cfg.assigns);
    } else if (cfg.role) {
      const cands = await workflow.candidatesForRole(cfg.role);
      if (cands.length === 1) { toStaffId = cands[0].id; setPointer = !!(cfg.pointer && cfg.assigns); }
      else return res.status(400).json({ error: 'pick_recipient', role: cfg.role, candidates: cands });
    } else {
      return res.status(400).json({ error: 'pick_recipient', role: null });
    }
    const recipient = (await db.query(`SELECT id, full_name, role FROM staff_users WHERE id=$1 AND is_active=true`, [toStaffId])).rows[0];
    if (!recipient) return res.status(400).json({ error: 'recipient not found or inactive' });

    // ---- estimated closing date (closing only) ----
    let estClosing = null;
    if (cfg.needsEstClosing) {
      estClosing = b.estClosingDate ? require('../lib/fields').normalizeTypedDate(b.estClosingDate) : null;
      if (!estClosing) return res.status(400).json({ error: 'Enter an estimated closing date (a real YYYY-MM-DD date).' });
    }

    // ---- transaction: assign the pointer (if picking a new person), insert the
    //      hand-off + event, open the closing row for a closing submit ----
    const client = await db.getClient();
    let item;
    try {
      await client.query('BEGIN');
      if (setPointer && cfg.pointer) await client.query(`UPDATE applications SET ${cfg.pointer}=$2, updated_at=now() WHERE id=$1`, [appId, toStaffId]);
      item = await workflow.submitItem(client, {
        appId, submissionType: b.submissionType, fromStaffId: req.actor.id, toStaffId, toRole: recipient.role,
        note: b.note, priority: Number(b.priority), estClosingDate: estClosing,
      });
      if (b.submissionType === 'closing') await workflow.openClosing(client, { appId, workflowItemId: item.id, estClosingDate: estClosing, actorId: req.actor.id });
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }

    // ---- side effects (outside the tx) ----
    // A newly-picked processor is mirrored to ClickUp (processor syncs both ways);
    // the db/103 trigger already granted the person file access via the pointer.
    if (setPointer && cfg.pointer === 'processor_id') enqueueClickupPush(appId, ['processor']).catch(() => {});
    // Closing writes the estimated closing date onto the file too (borrower-facing).
    if (b.submissionType === 'closing' && estClosing) {
      try { await db.query(`UPDATE applications SET expected_closing=$2, updated_at=now() WHERE id=$1`, [appId, estClosing]); enqueueClickupPush(appId, ['expected_closing']).catch(() => {}); } catch (_) {}
    }
    // DRIVE the status automatically (the workflow drives the status). The
    // workflow is the authorized path, so it may set decision-grade statuses
    // (canDecide:true); it is BEST-EFFORT — the hand-off already landed, so a
    // status gate/decline never fails the submit (the status catches up later).
    let statusResult = null;
    if (cfg.internalStatus) {
      try {
        statusResult = await applyInternalStatus(appId, cfg.internalStatus, { actorId: req.actor.id, canDecide: true, force: isAdmin(req), allowForce: isAdmin(req) });
      } catch (_) { statusResult = null; }
    }
    // Notify the recipient it's in their Workflow (best-effort — the hand-off
    // already committed, so a notify hiccup must never fail the submit).
    await notify.notifyStaff(toStaffId, {
      type: 'workflow_submitted', title: `New in your Workflow: ${cfg.label}`,
      body: `${req.actor.name || 'A team member'} submitted this file to you for ${cfg.label}.${b.note ? ' Note: ' + String(b.note).slice(0, 300) : ''}`,
      applicationId: appId, ctaLabel: 'Open my Workflow', link: '/internal/workflow',
    }).catch(() => {});
    await audit(req, 'workflow_submit', 'application', appId, { submissionType: b.submissionType, toStaffId, itemId: item.id, statusApplied: statusResult && statusResult.ok ? statusResult.status : undefined });
    res.json({ ok: true, item, status: statusResult && statusResult.ok ? statusResult.status : undefined, statusBlocked: statusResult && statusResult.blocked ? true : undefined });
  } catch (e) { console.warn('[workflow] submit error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// MY personal workflow. ?tab=next|history &sort=received|priority|aging &type=…
router.get('/workflow', async (req, res) => {
  try {
    const rows = await workflow.listQueue(req.actor.id, { tab: req.query.tab, sort: req.query.sort, type: req.query.type });
    res.json(rows);
  } catch (e) { console.warn('[workflow] list error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Counts for the nav badge + KPI tiles.
router.get('/workflow/count', async (req, res) => {
  try { res.json(await workflow.queueCounts(req.actor.id)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// PICK UP an item (start working it). Only the person it's routed to (or an admin).
router.post('/workflow/:itemId/pickup', async (req, res) => {
  try {
    const it = (await db.query(`SELECT to_staff_id, status FROM workflow_items WHERE id=$1`, [req.params.itemId])).rows[0];
    if (!it) return res.status(404).json({ error: 'not found' });
    if (String(it.to_staff_id || '') !== String(req.actor.id) && !isAdmin(req)) return res.status(403).json({ error: 'this item is not in your workflow' });
    const client = await db.getClient();
    let item;
    try { await client.query('BEGIN'); item = await workflow.pickItem(client, req.params.itemId, req.actor.id); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// RETURN an item — finished; send it back to whoever submitted it, with an
// outcome label + optional note. Leaves the live queue, stays in history.
router.post('/workflow/:itemId/return', async (req, res) => {
  const outcomeLabel = req.body && req.body.outcomeLabel;
  const note = req.body && req.body.note;
  if (!outcomeLabel) return res.status(400).json({ error: 'pick an outcome (what you finished / did)' });
  try {
    const it = (await db.query(`SELECT application_id, to_staff_id, from_staff_id, submission_type, status FROM workflow_items WHERE id=$1`, [req.params.itemId])).rows[0];
    if (!it) return res.status(404).json({ error: 'not found' });
    if (String(it.to_staff_id || '') !== String(req.actor.id) && !isAdmin(req)) return res.status(403).json({ error: 'this item is not in your workflow' });
    if (!['open', 'in_progress'].includes(it.status)) return res.status(409).json({ error: 'this item is already finished' });
    const client = await db.getClient();
    let item;
    try { await client.query('BEGIN'); item = await workflow.returnItem(client, req.params.itemId, req.actor.id, outcomeLabel, note); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    // Tell the person who submitted it that it's been finished + sent back.
    if (it.from_staff_id && String(it.from_staff_id) !== String(req.actor.id)) {
      const label = (workflow.typeConfig(it.submission_type) || {}).label || it.submission_type;
      await notify.notifyStaff(it.from_staff_id, {
        type: 'workflow_returned', title: `${req.actor.name || 'A team member'} finished ${label}: ${outcomeLabel}`,
        body: `Your ${label} submission was finished and sent back to you.${note ? ' Note: ' + String(note).slice(0, 300) : ''}`,
        applicationId: it.application_id, ctaLabel: 'Open the loan file', link: `/internal/app/${it.application_id}`,
      }).catch(() => {});
    }
    // The Workflow, phase two: the outcome can DRIVE the status forward (e.g.
    // "Finished CTC" → clear-to-close). Best-effort — the hand-off already
    // returned, so a status hiccup never fails the send-back.
    let statusApplied;
    const action = workflowAuto.outcomeAction(outcomeLabel);
    if (action && action.internalStatus) {
      try {
        const r = await applyInternalStatus(it.application_id, action.internalStatus,
          { actorId: req.actor.id, canDecide: true, force: isAdmin(req), allowForce: isAdmin(req) });
        if (r && r.ok) statusApplied = r.status;
      } catch (_) { /* status is best-effort */ }
    }
    await audit(req, 'workflow_return', 'application', it.application_id, { itemId: req.params.itemId, outcomeLabel, statusApplied });
    res.json({ ok: true, item, status: statusApplied });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Advance the closing sub-workflow. Body: { stage }. fully_closed → funded (the
// owner's "fully closed links funded"), done via the shared status door.
router.post('/applications/:id/closing-workflow', async (req, res) => {
  const stage = req.body && req.body.stage;
  if (!workflow.CLOSING_STAGES.includes(stage)) return res.status(400).json({ error: 'unknown closing stage' });
  try {
    const client = await db.getClient();
    let out;
    try { await client.query('BEGIN'); out = await workflow.advanceClosing(client, req.params.id, stage, req.actor.id); await client.query('COMMIT'); }
    catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }
    // Drive the matching ClickUp status (fully_closed → funded) best-effort.
    let statusResult = null;
    if (out.internalStatus) {
      try { statusResult = await applyInternalStatus(req.params.id, out.internalStatus, { actorId: req.actor.id, canDecide: true, force: isAdmin(req), allowForce: isAdmin(req) }); } catch (_) {}
    }
    await audit(req, 'closing_workflow_stage', 'application', req.params.id, { stage, statusApplied: statusResult && statusResult.ok ? statusResult.status : undefined });
    res.json({ ok: true, closing: out.row, status: statusResult && statusResult.ok ? statusResult.status : undefined, statusBlocked: statusResult && statusResult.blocked ? true : undefined });
  } catch (e) {
    if (e && e.code === 'bad_stage') return res.status(400).json({ error: 'unknown closing stage' });
    res.status(500).json({ error: 'server error' });
  }
});

// The closing sub-workflow state for the file page.
router.get('/applications/:id/closing-workflow', async (req, res) => {
  try { res.json(await workflow.getClosing(req.params.id) || { stage: null }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// #84 — super-admin STRUCTURAL UNLOCK. A clear-to-close / funded file's loan
// structure (price, loan amount, pricing, budget, vesting, program) is frozen for
// EVERYONE, super_admin included. A super_admin may deliberately UNLOCK a specific
// file to correct a genuine mistake, then re-lock it — every toggle is audited.
// Only a super_admin (not a regular admin) may do this.
router.post('/applications/:id/structural-lock', async (req, res) => {
  if (!(req.actor && req.actor.role === 'super_admin'))
    return res.status(403).json({ error: 'Only a super-admin can unlock a frozen file.' });
  const unlock = !!(req.body && req.body.unlocked);
  const reason = req.body && req.body.reason ? String(req.body.reason).slice(0, 500) : null;
  try {
    const cur = await db.query(`SELECT status FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (unlock) {
      await db.query(
        `UPDATE applications SET structural_unlocked_at=now(), structural_unlocked_by=$2, structural_unlock_reason=$3, updated_at=now() WHERE id=$1`,
        [req.params.id, req.actor.id, reason]);
    } else {
      await db.query(
        `UPDATE applications SET structural_unlocked_at=NULL, structural_unlocked_by=NULL, structural_unlock_reason=NULL, updated_at=now() WHERE id=$1`,
        [req.params.id]);
    }
    await audit(req, unlock ? 'structural_unlock' : 'structural_relock', 'application', req.params.id, { reason });
    res.json({ ok: true, unlocked: unlock });
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
      // S3-11: the borrower's OTHER files are only mentionable if THIS officer can
      // access them — a non-seesAll officer never sees a file they aren't on.
      db.query(`SELECT a.id, COALESCE(a.property_address->>'oneLine', a.property_address->>'street', 'Application') AS label
                  FROM applications a
                 WHERE a.borrower_id=(SELECT borrower_id FROM applications WHERE id=$1)
                   AND a.deleted_at IS NULL
                   ${seesAll(req) ? '' : `AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`}`,
        seesAll(req) ? [req.params.id] : [req.params.id, req.actor.id]),
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
        `SELECT 1 FROM applications a WHERE a.id=$1 AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
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
const LEAD_STATUSES = ['new', 'contacted', 'qualified', 'quoted', 'working', 'nurturing', 'converted', 'lost', 'archived'];
router.get('/leads', async (req, res) => {
  try {
    const where = seesAll(req) ? '' : 'WHERE (l.officer_id=$1 OR l.officer_id IS NULL)';
    const params = seesAll(req) ? [] : [req.actor.id];
    const r = await db.query(
      `SELECT l.id,l.tool,l.name,l.first_name,l.last_name,l.company,l.email,l.phone,l.phone_alt,
              l.subject,l.message,l.status,l.officer_id,l.created_at,l.updated_at,l.next_follow_up,
              l.application_id,l.borrower_id,l.loan_amount,l.program,l.property_type,l.property_address,
              l.lead_source,l.referral_partner,l.tags,l.estimated_close,l.lost_reason,l.last_activity_at,
              s.full_name AS officer_name,
              (SELECT count(*)::int FROM lead_activities la WHERE la.lead_id=l.id) AS activity_count,
              (SELECT count(*)::int FROM lead_tasks lt WHERE lt.lead_id=l.id AND lt.done=false) AS open_tasks,
              (SELECT min(lt.due_at) FROM lead_tasks lt WHERE lt.lead_id=l.id AND lt.done=false) AS next_task_due,
              (SELECT count(*)::int FROM documents d WHERE d.lead_id=l.id) AS doc_count
         FROM leads l LEFT JOIN staff_users s ON s.id=l.officer_id
         ${where}
        ORDER BY (l.status='new') DESC, COALESCE(l.next_follow_up,'9999-12-31') ASC,
                 l.last_activity_at DESC NULLS LAST, l.created_at DESC LIMIT 500`, params);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// #153 — bulk-archive junk leads (admin). The bot-spam wave imported hundreds
// of fake "subscribe" leads and the CRM only had a one-by-one PATCH; this
// archives every non-converted lead matching a tool/source/status filter in
// one audited call. At least one filter is required — a bare call must never
// archive the whole desk.
router.post('/leads/bulk-archive', requireRole('admin'), async (req, res) => {
  try {
    const b = req.body || {};
    const conds = [`status NOT IN ('converted','archived')`], vals = []; let i = 1;
    if (b.tool) { conds.push(`tool=$${i++}`); vals.push(String(b.tool).slice(0, 60)); }
    if (b.source) {
      // The generic 'marketing_site' bucket covers EVERY public form (and the
      // db/101 boot backfill stamps it onto all of them) — archiving by it
      // would sweep contact + loan-application + subscribe leads in one call
      // (audit-caught 2026-07-17). Refuse it; archive by the specific tool.
      if (String(b.source) === 'marketing_site') return res.status(400).json({ error: "archive by the specific tool instead of the generic 'marketing_site' source" });
      conds.push(`COALESCE(lead_source, source)=$${i++}`); vals.push(String(b.source).slice(0, 60));
    }
    if (b.status) {
      if (!LEAD_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
      conds.push(`status=$${i++}`); vals.push(b.status);
    }
    if (b.q) { conds.push(`(email ILIKE $${i} OR name ILIKE $${i} OR subject ILIKE $${i})`); vals.push('%' + String(b.q).slice(0, 80) + '%'); i++; }
    if (vals.length === 0) return res.status(400).json({ error: 'a filter (tool, source, status or q) is required' });
    const r = await db.query(`UPDATE leads SET status='archived', updated_at=now() WHERE ${conds.join(' AND ')} RETURNING id`, vals);
    await audit(req, 'leads_bulk_archive', 'lead', null, { count: r.rowCount, tool: b.tool || null, source: b.source || null, status: b.status || null, q: b.q || null });
    res.json({ ok: true, archived: r.rowCount });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Manually add a lead (the CRM "+ Add lead" — leads no longer only arrive from
// the marketing tools). Owned by the creator when they're a loan officer (their
// book); admins may pick an owner or leave it on the shared desk.
router.post('/leads', async (req, res) => {
  const b = req.body || {};
  const first = String(b.firstName || '').trim();
  const last = String(b.lastName || '').trim();
  const email = String(b.email || '').trim();
  const phone = String(b.phone || '').trim();
  if (!first && !last && !email && !phone) return res.status(400).json({ error: 'a name, email, or phone is required' });
  const name = [first, last].filter(Boolean).join(' ') || email || phone;
  const status = LEAD_STATUSES.includes(b.status) ? b.status : 'new';
  const amount = (b.loanAmount !== undefined && b.loanAmount !== '' && Number.isFinite(Number(b.loanAmount))) ? Number(b.loanAmount) : null;
  try {
    let officerId = null;
    if (b.officerId) { const o = await db.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true`, [b.officerId]); if (o.rows[0]) officerId = o.rows[0].id; }
    if (!officerId && !seesAll(req)) officerId = req.actor.id;
    const ins = await db.query(
      `INSERT INTO leads (tool,source,lead_source,name,first_name,last_name,company,email,phone,phone_alt,
                          contact_address,property_address,property_type,program,loan_amount,referral_partner,
                          subject,message,status,officer_id,created_by_staff_id,last_activity_at)
       VALUES ('manual','manual',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
       RETURNING id`,
      [b.leadSource || 'manual', name, first || null, last || null, b.company || null, email || null, phone || null, b.phoneAlt || null,
        b.contactAddress ? JSON.stringify(b.contactAddress) : null, b.propertyAddress ? JSON.stringify(b.propertyAddress) : null,
        b.propertyType || null, b.program || null, amount, b.referralPartner || null,
        b.subject || null, b.message || null, status, officerId, req.actor.id]);
    const leadId = ins.rows[0].id;
    await db.query(`INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body) VALUES ($1,$2,'system','Lead created',$3)`,
      [leadId, req.actor.id, 'Lead added manually']);
    await audit(req, 'staff_create_lead', 'lead', leadId, { name });
    res.status(201).json({ ok: true, leadId });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.patch('/leads/:id', async (req, res) => {
  const b = req.body || {};
  if (b.status && !LEAD_STATUSES.includes(b.status)) return res.status(400).json({ error: 'bad status' });
  // Horizontal scope: a non-privileged officer may only touch a lead that is
  // unassigned or already theirs — the same scope GET /leads applies — so one
  // officer can't reassign or alter another officer's lead by its id.
  if (!seesAll(req)) {
    const own = await db.query(`SELECT 1 FROM leads WHERE id=$1 AND (officer_id=$2 OR officer_id IS NULL)`, [req.params.id, req.actor.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
  }
  // Snapshot the current status (for stage-change logging) + names (so a
  // single-field name PATCH rebuilds the flat `name` from both parts).
  const cur = await db.query(`SELECT status, first_name, last_name FROM leads WHERE id=$1`, [req.params.id]);
  if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
  const prevStatus = cur.rows[0].status;
  const sets = [], vals = []; let i = 1;
  const col = (name, val) => { sets.push(`${name}=$${i++}`); vals.push(val); };
  if (b.status !== undefined) { col('status', b.status); if (b.status === 'lost') col('lost_at', new Date().toISOString()); }
  if (b.officerId !== undefined) col('officer_id', b.officerId || null);
  if (b.nextFollowUp !== undefined) col('next_follow_up', b.nextFollowUp || null);
  if (b.firstName !== undefined) col('first_name', String(b.firstName).trim() || null);
  if (b.lastName !== undefined) col('last_name', String(b.lastName).trim() || null);
  if (b.company !== undefined) col('company', b.company || null);
  if (b.email !== undefined) col('email', String(b.email).trim() || null);
  if (b.phone !== undefined) col('phone', String(b.phone).trim() || null);
  if (b.phoneAlt !== undefined) col('phone_alt', String(b.phoneAlt).trim() || null);
  if (b.contactAddress !== undefined) col('contact_address', b.contactAddress ? JSON.stringify(b.contactAddress) : null);
  if (b.propertyAddress !== undefined) col('property_address', b.propertyAddress ? JSON.stringify(b.propertyAddress) : null);
  if (b.propertyType !== undefined) col('property_type', b.propertyType || null);
  if (b.program !== undefined) col('program', b.program || null);
  if (b.loanAmount !== undefined) col('loan_amount', (b.loanAmount !== '' && Number.isFinite(Number(b.loanAmount))) ? Number(b.loanAmount) : null);
  if (b.leadSource !== undefined) col('lead_source', b.leadSource || null);
  if (b.referralPartner !== undefined) col('referral_partner', b.referralPartner || null);
  if (b.estimatedClose !== undefined) col('estimated_close', b.estimatedClose || null);
  if (b.lostReason !== undefined) col('lost_reason', b.lostReason || null);
  if (Array.isArray(b.tags)) col('tags', b.tags.map(t => String(t).trim()).filter(Boolean).slice(0, 20));
  // Keep the flat `name` in sync when structured names change (legacy consumers).
  if (b.firstName !== undefined || b.lastName !== undefined) {
    const nm = [b.firstName !== undefined ? String(b.firstName).trim() : (cur.rows[0].first_name || ''),
      b.lastName !== undefined ? String(b.lastName).trim() : (cur.rows[0].last_name || '')].filter(Boolean).join(' ');
    if (nm) col('name', nm);
  }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()');
  vals.push(req.params.id);
  try {
    await db.query(`UPDATE leads SET ${sets.join(',')} WHERE id=$${i}`, vals);
    // Log a stage change to the activity timeline (and re-stamp activity time).
    if (b.status !== undefined && b.status !== prevStatus) {
      await db.query(
        `INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body, meta)
         VALUES ($1,$2,'status_change',$3,$4,$5)`,
        [req.params.id, req.actor.id, `Stage → ${b.status}`, `Moved from ${prevStatus} to ${b.status}`,
          JSON.stringify({ from: prevStatus, to: b.status })]);
      await db.query(`UPDATE leads SET last_activity_at=now() WHERE id=$1`, [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Full detail for one lead (contact + deal + owner). Timeline/tasks/docs load
// via their own endpoints below.
router.get('/leads/:id', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT l.*, s.full_name AS officer_name,
              cb.full_name AS created_by_name,
              b.first_name AS conv_borrower_first, b.last_name AS conv_borrower_last,
              a.ys_loan_number AS conv_loan_number, a.status AS conv_app_status
         FROM leads l
         LEFT JOIN staff_users s ON s.id=l.officer_id
         LEFT JOIN staff_users cb ON cb.id=l.created_by_staff_id
         LEFT JOIN borrowers b ON b.id=l.borrower_id
         LEFT JOIN applications a ON a.id=l.application_id
        WHERE l.id=$1`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Lead CRM: per-lead notes / contact log. Same horizontal scope as PATCH — a
// non-privileged officer only touches their own or an unassigned lead.
async function leadInScope(req, leadId) {
  if (seesAll(req)) return true;
  const r = await db.query(`SELECT 1 FROM leads WHERE id=$1 AND (officer_id=$2 OR officer_id IS NULL)`, [leadId, req.actor.id]);
  return !!r.rows[0];
}
router.get('/leads/:id/notes', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT ln.id, ln.body, ln.created_at, s.full_name AS staff_name
         FROM lead_notes ln LEFT JOIN staff_users s ON s.id=ln.staff_id
        WHERE ln.lead_id=$1 ORDER BY ln.created_at DESC LIMIT 200`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/leads/:id/notes', async (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'a note is required' });
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const ins = await db.query(
      `INSERT INTO lead_notes (lead_id, staff_id, body) VALUES ($1,$2,$3)
       RETURNING id, body, created_at`, [req.params.id, req.actor.id, body.slice(0, 4000)]);
    // Touch the lead so it re-sorts and a fresh note nudges it out of "new".
    await db.query(`UPDATE leads SET updated_at=now(), status=CASE WHEN status='new' THEN 'contacted' ELSE status END WHERE id=$1`, [req.params.id]);
    res.status(201).json({ ok: true, note: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ===================== Lead CRM: activity timeline ========================
// One append-only log of everything on a lead: logged calls/emails/SMS/meetings,
// freeform notes, plus the automatic status_change/file/assignment rows.
const LEAD_ACTIVITY_TYPES = ['call', 'email', 'sms', 'meeting', 'note'];
router.get('/leads/:id/activities', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT la.id, la.activity_type, la.direction, la.subject, la.body, la.occurred_at, la.meta, la.created_at,
              s.full_name AS staff_name
         FROM lead_activities la LEFT JOIN staff_users s ON s.id=la.staff_id
        WHERE la.lead_id=$1 ORDER BY la.occurred_at DESC, la.created_at DESC LIMIT 300`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/leads/:id/activities', async (req, res) => {
  const b = req.body || {};
  const type = LEAD_ACTIVITY_TYPES.includes(b.type) ? b.type : 'note';
  const body = String(b.body || '').trim();
  const subject = String(b.subject || '').trim();
  if (!body && !subject) return res.status(400).json({ error: 'a note or subject is required' });
  const direction = ['inbound', 'outbound'].includes(b.direction) ? b.direction : null;
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    // A logged activity may carry its own timestamp (e.g. "I called yesterday").
    let occurred = null;
    if (b.occurredAt && !Number.isNaN(Date.parse(b.occurredAt))) occurred = new Date(b.occurredAt).toISOString();
    const ins = await db.query(
      `INSERT INTO lead_activities (lead_id, staff_id, activity_type, direction, subject, body, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))
       RETURNING id, activity_type, direction, subject, body, occurred_at, created_at`,
      [req.params.id, req.actor.id, type, direction, subject || null, body.slice(0, 6000) || null, occurred]);
    // Logging real contact nudges a brand-new lead out of "new" and re-sorts it.
    await db.query(
      `UPDATE leads SET last_activity_at=now(), updated_at=now(),
              status=CASE WHEN status='new' AND $2 THEN 'contacted' ELSE status END
        WHERE id=$1`, [req.params.id, type !== 'note']);
    await audit(req, 'staff_lead_activity', 'lead', req.params.id, { type });
    res.status(201).json({ ok: true, activity: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ===================== Lead CRM: tasks ====================================
router.get('/leads/:id/tasks', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT t.id, t.title, t.body, t.due_at, t.done, t.done_at, t.assignee_staff_id, t.created_at,
              s.full_name AS assignee_name
         FROM lead_tasks t LEFT JOIN staff_users s ON s.id=t.assignee_staff_id
        WHERE t.lead_id=$1 ORDER BY t.done ASC, t.due_at ASC NULLS LAST, t.created_at DESC LIMIT 200`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/leads/:id/tasks', async (req, res) => {
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (!title) return res.status(400).json({ error: 'a task title is required' });
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    let assignee = req.actor.id;
    if (b.assigneeStaffId) { const o = await db.query(`SELECT id FROM staff_users WHERE id=$1 AND is_active=true`, [b.assigneeStaffId]); if (o.rows[0]) assignee = o.rows[0].id; }
    let due = null;
    if (b.dueAt && !Number.isNaN(Date.parse(b.dueAt))) due = new Date(b.dueAt).toISOString();
    const ins = await db.query(
      `INSERT INTO lead_tasks (lead_id, title, body, due_at, assignee_staff_id, created_by_staff_id)
       VALUES ($1,$2,$3,$4::timestamptz,$5,$6)
       RETURNING id, title, body, due_at, done, assignee_staff_id, created_at`,
      [req.params.id, title.slice(0, 300), String(b.body || '').slice(0, 2000) || null, due, assignee, req.actor.id]);
    await db.query(`UPDATE leads SET updated_at=now() WHERE id=$1`, [req.params.id]);
    res.status(201).json({ ok: true, task: ins.rows[0] });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.patch('/leads/:id/tasks/:taskId', async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const sets = [], vals = []; let i = 1;
    if (b.done !== undefined) { sets.push(`done=$${i++}`); vals.push(!!b.done); sets.push(`done_at=${b.done ? 'now()' : 'NULL'}`); }
    if (b.title !== undefined && String(b.title).trim()) { sets.push(`title=$${i++}`); vals.push(String(b.title).trim().slice(0, 300)); }
    if (b.dueAt !== undefined) { sets.push(`due_at=$${i++}::timestamptz`); vals.push(b.dueAt && !Number.isNaN(Date.parse(b.dueAt)) ? new Date(b.dueAt).toISOString() : null); }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
    sets.push('updated_at=now()');
    vals.push(req.params.taskId); vals.push(req.params.id);
    const r = await db.query(`UPDATE lead_tasks SET ${sets.join(',')} WHERE id=$${i++} AND lead_id=$${i} RETURNING id`, vals);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ===================== Lead CRM: attachments ==============================
router.get('/leads/:id/documents', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT d.id, d.filename, d.content_type, d.size_bytes, d.created_at, d.uploaded_by_kind
         FROM documents d WHERE d.lead_id=$1 ORDER BY d.created_at DESC LIMIT 200`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/leads/:id/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
    try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
    catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
    const maxBytes = cfg.maxUploadMb * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
    const { ref, provider } = await storage.save(buf, { filename: b.filename });
    const r = await db.query(
      `INSERT INTO documents (lead_id, filename, content_type, size_bytes, storage_provider, storage_ref, uploaded_by_kind, uploaded_by_id)
       VALUES ($1,$2,$3,$4,$5,$6,'staff',$7) RETURNING id`,
      [req.params.id, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id]);
    await db.query(
      `INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body, meta)
       VALUES ($1,$2,'file','Attached a file',$3,$4)`,
      [req.params.id, req.actor.id, b.filename, JSON.stringify({ documentId: r.rows[0].id })]);
    await db.query(`UPDATE leads SET last_activity_at=now(), updated_at=now() WHERE id=$1`, [req.params.id]);
    await audit(req, 'staff_upload_lead_doc', 'lead', req.params.id, { filename: b.filename });
    res.status(201).json({ ok: true, documentId: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.get('/leads/:id/documents/:docId', async (req, res) => {
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(`SELECT * FROM documents WHERE id=$1 AND lead_id=$2`, [req.params.docId, req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'staff_download_lead_doc', 'lead', req.params.id, { documentId: req.params.docId });
    return serveDocument(res, r.rows[0], { inline: req.query.inline === '1' });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ===================== Lead CRM: convert to a loan file ===================
// Turn a qualified lead into a real borrower + application, and write back the
// (previously dead) leads.borrower_id / leads.application_id linkage. Reuses the
// same match-or-create borrower pattern as POST /applications.
router.post('/leads/:id/convert', async (req, res) => {
  const b = req.body || {};
  try {
    if (!(await leadInScope(req, req.params.id))) return res.status(403).json({ error: 'forbidden' });
    const lr = await db.query(`SELECT * FROM leads WHERE id=$1`, [req.params.id]);
    const lead = lr.rows[0];
    if (!lead) return res.status(404).json({ error: 'not found' });
    if (lead.application_id) return res.status(409).json({ error: 'This lead is already converted.', applicationId: lead.application_id });

    const email = String(b.email || lead.email || '').trim();
    const firstName = String(b.firstName || lead.first_name || '').trim();
    const lastName = String(b.lastName || lead.last_name || '').trim();
    const addr = b.propertyAddress || lead.property_address || null;
    if (!email) return res.status(400).json({ error: 'a borrower email is required to convert' });
    if (!firstName) return res.status(400).json({ error: 'a borrower first name is required to convert' });
    if (!addr || !(addr.oneLine || addr.street || addr.line1))
      return res.status(400).json({ error: 'a subject property address is required to convert' });

    // Same email + a DIFFERENT person's name → refuse the silent merge (409).
    // Converting officer A's lead onto a borrower row that is really a
    // DIFFERENT person (family-shared email, same surname) is exactly the
    // wrong-officer merge incident — the lead's officer would inherit the
    // other person's file and profile.
    const exConflict = await emailAdoptionConflict(email, firstName, lastName);
    if (exConflict) return emailAdoptionError(res, exConflict, email);

    // Carry the economics the applicant actually entered on the public loan
    // application (payload = collectState() → { v:{by input id}, c:{checkboxes} }),
    // so the created file's Term Sheet Studio opens PREFILLED instead of empty and
    // staff never re-key from memory (and never miss the assignment flag, which
    // would mis-price on the fee-inclusive total). loan_amount is intentionally
    // excluded — it's set by the pricing engine on registration (audit #23).
    // collectState() (web/*/suite.js) buckets inputs by kind: text/select in .v,
    // checkboxes in .c, RADIOS in .rad. Read each field from the right bucket under
    // its REAL loan-application id (verified against the tool): the rehab budget is
    // `rehab` (not "construction"), and loan purpose is the `purpose` radio.
    const pl = (lead.tool === 'loan_application' && lead.payload) ? lead.payload : {};
    const pv = (pl && pl.v) || {}, pc = (pl && pl.c) || {}, pr = (pl && pl.rad) || {};
    const numv = (x) => { const n = Number(String(x == null ? '' : x).replace(/,/g, '')); return isFinite(n) && n > 0 ? n : null; };
    const econIsAssign = !!pc.isAssign;
    const econPrice = numv(pv.price);
    const econSeller = econIsAssign ? numv(pv.origPrice) : null;
    const econFee = (econIsAssign && econPrice && econSeller) ? Math.max(0, econPrice - econSeller) : null;
    const econReserveOn = !!pc.finReserve;
    const econFico = (() => { const n = Number(pv.fico); return isFinite(n) && n >= 300 && n <= 850 ? Math.round(n) : null; })();
    const econLoanType = /refi/i.test(String(pr.purpose || '')) ? 'Refinance' : 'Purchase';

    const br = await db.query(
      `INSERT INTO borrowers (first_name,last_name,email,cell_phone,fico)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (email) DO UPDATE SET cell_phone=COALESCE(borrowers.cell_phone, EXCLUDED.cell_phone),
                                         fico=COALESCE(borrowers.fico, EXCLUDED.fico), updated_at=now()
       RETURNING id`,
      [firstName, lastName || '', email, lead.phone || null, econFico]);
    const borrowerId = br.rows[0].id;

    // Owner: the lead's officer, else the acting officer, else unassigned.
    let officerId = lead.officer_id, officerName = null;
    if (b.loanOfficerId) { const o = await db.query(`SELECT id,full_name FROM staff_users WHERE id=$1 AND is_active=true`, [b.loanOfficerId]); if (o.rows[0]) { officerId = o.rows[0].id; officerName = o.rows[0].full_name; } }
    if (officerId && !officerName) { const o = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [officerId]); officerName = o.rows[0] ? o.rows[0].full_name : null; }
    if (!officerId && req.actor.role === 'loan_officer') { officerId = req.actor.id; const o = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]); officerName = o.rows[0] ? o.rows[0].full_name : null; }

    // loan_amount is intentionally left null — it's set by the pricing engine on
    // product registration, exactly like a normal new staff file. The lead's
    // estimate stays on the lead; it must not seed the priced pipeline amount.
    const ins = await db.query(
      `INSERT INTO applications
         (borrower_id,property_address,property_type,program,loan_officer_id,loan_officer_name,source,status,submitted_at,
          loan_type,purchase_price,as_is_value,arv,rehab_budget,term,
          requested_ir_months,requested_ir_amount,is_assignment,underlying_contract_price,assignment_fee,
          requested_exp_flips,requested_exp_holds,requested_exp_ground)
       VALUES ($1,$2,$3,$4,$5,$6,'staff','new',now(),
          $7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id, ys_loan_number`,
      [borrowerId, JSON.stringify(addr),
        b.propertyType || pv.propType || lead.property_type || null,
        b.program || pv.dealType || lead.program || null, officerId, officerName,
        econLoanType,
        econPrice, numv(pv.asIs), numv(pv.arv), numv(pv.rehab),
        pv.termMonths ? String(parseInt(pv.termMonths, 10) || '') || null : null,
        (econReserveOn ? (parseInt(pv.resMonths, 10) || null) : null),
        (econReserveOn ? numv(pv.resAmount) : null),
        econIsAssign, econSeller, econFee,
        (parseInt(pv.expFlips, 10) || null), (parseInt(pv.expBrrrr, 10) || null), (parseInt(pv.expGround, 10) || null)]);
    const appId = ins.rows[0].id;

    try { await require('../lib/conditions/ensure').ensureFileConditions(appId, { reason: 'lead_convert' }); }
    catch (e) { console.error('[lead-convert] checklist failed:', db.describeError ? db.describeError(e) : e.message); }

    await db.query(
      `UPDATE leads SET status='converted', borrower_id=$2, application_id=$3, last_activity_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, borrowerId, appId]);
    await db.query(
      `INSERT INTO lead_activities (lead_id, staff_id, activity_type, subject, body, meta)
       VALUES ($1,$2,'system','Converted to a loan file',$3,$4)`,
      [req.params.id, req.actor.id, `Created file ${ins.rows[0].ys_loan_number || appId}`, JSON.stringify({ applicationId: appId, borrowerId })]);
    await audit(req, 'staff_convert_lead', 'lead', req.params.id, { applicationId: appId, borrowerId });
    res.status(201).json({ ok: true, applicationId: appId, borrowerId, loanNumber: ins.rows[0].ys_loan_number });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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
  b.filename = safeFilename(b.filename);   // S4-10: sanitize + length-cap before it hits the DB / emails
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
  let buf;   // strict decode — a data: prefix / non-base64 junk 400s instead of garbling bytes
  try { ({ buf } = decodeUploadBase64(b.dataBase64)); }
  catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;
  const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  const dupApp = await require('../lib/doc-dedup').recentDuplicateDocId({   // idempotency (#87)
    filename: b.filename, sizeBytes: buf.length, uploadedByKind: 'staff', uploadedById: req.actor.id,
    applicationId: llcId ? null : req.params.id, checklistItemId: b.checklistItemId || null,
    llcId: llcId || null, trackRecordId: itemTrackRecordId, slotLabel: slot, docKind });
  if (dupApp) return res.status(201).json({ ok: true, documentId: dupApp, deduped: true });
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
          AND COALESCE(doc_kind,'') <> 'track_record_doc'
          AND ($3::text IS NOT NULL OR $4::uuid IS NULL)
          AND ($3::text IS NULL OR slot_label IS NOT DISTINCT FROM $3)`,
      [b.checklistItemId, r.rows[0].id, slot, b.replaceDocumentId || null]);
    // A superseding upload replaces the reviewed evidence with a new UNREVIEWED
    // file, so a prior sign-off no longer matches what's on the item — drop it so
    // the new version is re-reviewed before the file can clear-to-close.
    await require('../lib/checklist-evidence').reopenConditionEvidence(db, b.checklistItemId, 'received');
    enqueueChecklistStatusPush(b.checklistItemId).catch(() => {}); // mapped conditions → ClickUp dropdown
    // The shared list works both ways — tell the borrower their team added it.
    // Staff-only (internal) conditions are never surfaced or emailed to them.
    if (borrowerId && !staffOnly) {
      try {
        const ctx = await notify.fileContext(req.params.id);
        await notify.notifyBorrower(borrowerId, {
          type: 'doc_uploaded', title: `Your loan team added a document to "${itemLabel}"`,
          body: `"${b.filename}" was uploaded to ${llcId ? 'your entity documents' : `condition "${itemLabel}"`}${slot ? ` (${slot})` : ''}${ctx ? ` on ${ctx.label}` : ''} on your behalf.`,
          meta: (ctx && ctx.borrowerMeta) || undefined,
          applicationId: llcId ? null : req.params.id, link: llcId ? '/entities' : `/app/${req.params.id}` });
      } catch (_) { /* best-effort */ }
    }
  }
  // An LLC-slot upload re-drives the umbrella LLC condition on every open file
  // vesting in the entity (all slots present → received; etc).
  if (llcId) { try { await llcLib.syncLlcConditions(llcId); } catch (_) { /* best-effort */ } }

  // Auto-import: an appraisal XML dropped on the appraisal-documents condition's XML slot
  // imports the appraisal right there (builds the property report + PILOT findings + the two
  // internal conditions) — the officer never has to use the separate import screen, though it
  // still works. Best-effort: a bad/unparseable XML notes the failure on the condition and
  // never breaks the upload.
  let apprImport = null;   // surfaced in the response so the UI can show the findings immediately
  if (b.checklistItemId && !llcId && /xml/i.test(slot || '')) {
    try {
      const tc = (await db.query(
        `SELECT t.code FROM checklist_items ci JOIN checklist_templates t ON t.id=ci.template_id WHERE ci.id=$1`,
        [b.checklistItemId])).rows[0];
      if (tc && tc.code === 'rtl_cond_appraisaldocs') {
        const xml = buf.toString('utf8');
        const pdfDoc = (await db.query(
          `SELECT id FROM documents WHERE checklist_item_id=$1 AND is_current
             AND lower(coalesce(slot_label,'')) LIKE '%pdf%' ORDER BY created_at DESC LIMIT 1`,
          [b.checklistItemId])).rows[0];
        const out = await require('../lib/appraisal/desk').runAppraisalImport({
          appId: req.params.id, xml, importedBy: req.actor.id,
          xmlDocumentId: r.rows[0].id, pdfDocumentId: pdfDoc && pdfDoc.id,
        });
        if (out && out.ok) {
          // Surface the result so the upload UI can announce "findings built" and
          // refresh the appraisal panel — no separate re-import into the findings.
          apprImport = { ok: true, appraisalId: out.appraisalId, summary: out.summary };
          await audit(req, 'appraisal_import', 'application', req.params.id,
            { via: 'condition_slot', appraisalId: out.appraisalId, findings: out.summary });
        } else {
          apprImport = { ok: false, error: (out && out.error) || 'the appraisal XML could not be imported' };
          // Never silent: tell the officer the XML didn't import and why.
          try {
            await db.query(
              `UPDATE checklist_items SET notes=CASE WHEN notes IS NULL OR notes LIKE '[auto]%' THEN $2 ELSE notes END, updated_at=now() WHERE id=$1`,
              [b.checklistItemId, `[auto] The uploaded appraisal XML could not be imported${out && out.error ? ` (${out.error})` : ''}. Please confirm it is the appraisal DATA file (XML), not the PDF.`]);
          } catch (_) { /* best-effort */ }
        }
      }
    } catch (e) { console.error('[appraisal] condition auto-import failed (non-fatal):', e && e.message); }
  }

  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename, docKind, checklistItemId: b.checklistItemId || null, llcId });
  try { require('../lib/sharepoint-backup').kick(); } catch (_) {}

  // AI classifier auto-hook (R3.13, owner-directed 2026-07-22, HARD RULE — never
  // moves the document itself; never clears/reopens a condition). When the Azure
  // Custom Classifier is trained, run it against the uploaded bytes and post AI
  // suggestions to the file: (a) wrong-condition if the classifier says the doc
  // belongs to a different condition than where it was filed, (b) splitter if the
  // document looks like a combined package. Fires in setImmediate so upload stays
  // fast; every step is best-effort and never blocks the response.
  const uploadedDocId = r.rows[0].id;
  const appIdForAi = llcId ? null : req.params.id;
  if (appIdForAi && buf && buf.length) setImmediate(() => {
    (async () => {
      const azc = require('../lib/ai/azure-custom');
      if (!azc.classifierConfigured()) return;   // dormant until classifier trained
      const client = await db.pool.connect();
      try {
        // For classification we only need the bytes; classify+suggest are separate DB
        // writes but share one connection so a rollback of one doesn't hurt the other.
        const classifier = await azc.classify({ buffer: buf, appId: appIdForAi, documentId: uploadedDocId });
        if (!classifier.ok || !classifier.segments || !classifier.segments.length) return;
        await client.query('BEGIN');
        // (a) Wrong-condition detector: only when filed under a specific checklist item.
        if (b.checklistItemId) {
          const wc = require('../lib/underwriting/wrong-condition');
          const tc = (await client.query(
            `SELECT t.code, COALESCE(t.borrower_label, t.label) AS label
               FROM checklist_items ci JOIN checklist_templates t ON t.id = ci.template_id
              WHERE ci.id = $1`, [b.checklistItemId])).rows[0];
          if (tc && tc.code) {
            // Pick the highest-confidence segment as the document's dominant type.
            const dominant = classifier.segments.slice().sort((a, b2) => (b2.confidence || 0) - (a.confidence || 0))[0];
            await wc.analyzeAndRecord(client, {
              applicationId: appIdForAi, documentId: uploadedDocId, checklistItemId: b.checklistItemId,
              conditionCode: tc.code, conditionLabel: tc.label,
              classifier: { docType: dominant.docType, confidence: dominant.confidence, pages: dominant.pages },
            });
          }
        }
        // (b) Splitter suggest: only meaningful for PDFs with 2+ distinct doc types.
        const ss = require('../lib/underwriting/splitter-suggest');
        // pageCount from the classifier segments' max page number as a floor.
        const maxPage = Math.max(...classifier.segments.flatMap(s => s.pages || [0]).map(Number).filter(Number.isFinite));
        await ss.suggestSplit(client, {
          applicationId: appIdForAi, documentId: uploadedDocId, buffer: buf, pageCount: maxPage,
          staffId: req.actor.staffId,
        });
        await client.query('COMMIT');
      } catch (_) { await client.query('ROLLBACK').catch(() => {}); }
      finally { client.release(); }
    })().catch(() => {});
  });

  res.status(201).json({ ok: true, documentId: r.rows[0].id, ...(apprImport ? { appraisal: apprImport } : {}) });
});

// Approve or reject an uploaded document. Rejection requires a reason, keeps the
// rejected file in history (never in the clean file), and flips its checklist
// item back to 'issue' so the borrower sees exactly what to fix and re-uploads.
// Acceptance marks the item RECEIVED (not satisfied) — the condition stays open
// until a reviewer signs it off (#135). Only accepted+current docs count for the
// file (see getApprovedDocuments / TPR export).
// A tool submission (Scope of Work, track record, term sheet…) saves the SAME
// logical document in SEVERAL formats — HTML + XML + PDF — as separate `documents`
// rows on ONE checklist item. A verdict (reject / request-more) on that item was
// firing the borrower email once PER FORMAT (owner-reported 2026-07-20: three
// identical "needs a new document" emails for one Scope of Work). Send ONE
// borrower notification per checklist item per verdict: atomically CLAIM a short
// window (the export formats are decided within seconds of each other, whether by
// one cascading action or three quick clicks) — the first format's verdict
// notifies, the sibling formats update silently. Returns true if THIS call should
// notify. No checklist item to key on (LLC/profile doc) → always notify.
async function claimItemVerdictEmail(checklistItemId, action) {
  if (!checklistItemId) return true;   // no logical item to key on → always notify
  // Use the shared ATOMIC claim (pg_advisory_xact_lock in its own statement) —
  // a plain INSERT…WHERE NOT EXISTS is NOT race-safe under READ COMMITTED, so two
  // of the export formats' parallel reject calls could both win and re-send. The
  // helper also FAILS CLOSED on a DB error (returns null → no email) instead of
  // throwing a 500 out of the handler after the review already committed.
  const { claimOncePerPeriod } = require('../lib/throttle-claim');
  return (await claimOncePerPeriod({ action, entityId: checklistItemId, interval: '5 minutes', entityType: 'checklist_item' })) != null;
}
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
                  signed_off_at=NULL, signed_off_by=NULL, reviewed_at=NULL, reviewed_by=NULL,
                  notes=CASE WHEN $2 <> '' THEN $2 ELSE notes END,
                  borrower_hint=COALESCE($3, borrower_hint), updated_at=now() WHERE id=$1`,
          [doc.checklist_item_id, moreNote ? `Still needed: ${moreNote}` : '', newHint]);
      } else if (action === 'accept') {
        // Accepting a document only marks the condition RECEIVED — NOT satisfied
        // (owner-directed 2026-07-12). The condition stays open on the list until
        // a reviewer explicitly SIGNS IT OFF (which routes through signOffGate and
        // therefore enforces every required document/slot — e.g. a background AND
        // criminal report, insurance binder AND invoice). This prevents a
        // multi-document condition from "flying away" the moment ONE of its
        // documents is accepted, and keeps accept (doc is good) distinct from
        // sign-off (the whole condition is complete).
        await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1`,
          [doc.checklist_item_id]);
      } else {
        // Reject -> issue, AND drop any prior sign-off: the rejected document was
        // the evidence the sign-off attested to, so the condition must re-open
        // (otherwise a signed-off condition stays "cleared" for the clear-to-close
        // gate with rejected/zero evidence). Same class as the LLC/track-record
        // reject-revokes-verification handling below.
        await require('../lib/checklist-evidence').reopenConditionEvidence(db, doc.checklist_item_id, 'issue');
      }
      enqueueChecklistStatusPush(doc.checklist_item_id).catch(() => {}); // mapped conditions → ClickUp dropdown
    }
    await audit(req, action === 'accept' ? (requestMore ? 'accept_document_request_more' : 'accept_document') : 'reject_document', 'document', doc.id,
      action === 'reject' ? { reason: b.reason } : requestMore ? { note: moreNote } : null);

    // Tell the borrower another document is needed on this condition — the
    // accepted file is kept; this is an "and also", not a rejection.
    if (requestMore && doc.borrower_id && await claimItemVerdictEmail(doc.checklist_item_id, 'doc_requested_emailed')) {
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
          badge: { text: 'Action needed', tone: 'action' },
          body: `Good news — "${doc.filename}" was accepted. To finish this item, your loan team needs one more document.`,
          callout: moreNote ? { title: 'What we still need', body: moreNote, tone: 'action' } : undefined,
          meta: (ctx && ctx.borrowerMeta) || undefined,
          applicationId: doc.application_id,
          link: doc.application_id ? `/app/${doc.application_id}` : '/profile',
          ctaLabel: 'Upload the document' });
      } catch (_) { /* best-effort */ }
    }

    // Plain accept → the borrower is NOT notified at all (owner-directed
    // 2026-07-20 evening: "nobody needs to be aware when somebody is accepting
    // something internally — the borrower does not need to be aware"). A staff
    // member accepting a document is an INTERNAL workflow step, not a borrower
    // milestone: no email AND no in-app ping. The borrower can still see a
    // document is accepted in their checklist if they look, and the events that
    // DO reach them are unchanged — a REJECTED / REQUESTED document (they must
    // redo it, below) and real milestones (a status decision). We previously sent
    // an "Accepted" confirmation here (throttled email + in-app); that whole
    // notification is removed.

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
    if (action === 'reject' && doc.borrower_id && await claimItemVerdictEmail(doc.checklist_item_id, 'doc_rejected_emailed')) {
      try {
        let condLabel = '';
        if (doc.checklist_item_id) {
          const it = await db.query(`SELECT COALESCE(borrower_label,label) AS label FROM checklist_items WHERE id=$1`, [doc.checklist_item_id]);
          if (it.rows[0]) condLabel = it.rows[0].label;
        }
        const ctx = doc.application_id ? await notify.fileContext(doc.application_id) : null;
        await notify.notifyBorrower(doc.borrower_id, {
          type: 'doc_rejected', title: condLabel ? `"${condLabel}" needs a new document` : 'A document needs to be re-uploaded',
          badge: { text: 'Action needed', tone: 'action' },
          body: `"${doc.filename}"${condLabel ? ` on "${condLabel}"` : ''} couldn't be accepted this time, so please upload a new version.`,
          callout: { title: 'Why it was sent back', body: String(b.reason).slice(0, 300), tone: 'action' },
          meta: (ctx && ctx.borrowerMeta) || undefined,
          applicationId: doc.application_id,
          link: doc.application_id ? `/app/${doc.application_id}` : '/profile',
          ctaLabel: 'Upload a new version' });
      } catch (_) {}
    }
    // Live cross-user refresh (#112): a verdict on a track-record line-item doc
    // (accept badge / rejection) shows on the borrower's + other staff's view now.
    if (doc.track_record_id) require('../lib/events').publishTrackRecordUpdate(doc.borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
    res.json({ ok: true, review_status: status });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// PERMANENTLY delete a document (owner-directed 2026-07-14): a mistake-upload
// shouldn't linger as a "not accepted" version forever, and — critically — a
// deleted document must NEVER be mirrored to SharePoint (it was never needed,
// it's not just an old version). This hard-deletes the DB row + the local
// bytes; because the SharePoint reconciler only ever mirrors documents where
// sharepoint_backed_up_at IS NULL, a doc deleted before the async sync runs is
// simply gone and never reaches a Version-1 folder. SharePoint's own no-delete
// policy is honored: we never issue a Graph delete — if the doc had already
// been mirrored, that copy stays (a human removes it in SharePoint if desired).
// Works for EVERY document surface (pipeline conditions, LLC docs, track-record
// docs) since they all live in one `documents` table, keyed by the doc id.
router.delete('/documents/:id', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT id,filename,storage_provider,storage_ref,application_id,borrower_id,llc_id,
              checklist_item_id,track_record_id,review_status,is_current,sharepoint_backed_up_at
         FROM documents WHERE id=$1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeDocument(req, doc))) return res.status(403).json({ error: 'forbidden' });
    // Permanent, irreversible deletion (and SharePoint-backup suppression) is
    // more destructive than accept/reject, so gate it on the same capability the
    // UI gates the Delete button on (`canComplete` = sign-off-capable roles) —
    // an assigned loan_officer / software_setup is never shown the button and
    // must not be able to delete via a direct API call.
    if (!can(req.actor, 'sign_off_conditions'))
      return res.status(403).json({ error: 'You do not have permission to permanently delete documents.' });

    // Remove the stored bytes best-effort (never block the DB delete on a
    // storage hiccup). local unlinks; s3/sharepoint providers are no-op removes.
    try { if (doc.storage_ref) await storage.remove(doc.storage_ref); } catch (_) { /* orphan bytes are acceptable */ }

    // Hard-delete the row. FKs into documents are ON DELETE SET NULL
    // (borrowers.photo_id_document_id) so this never cascades unexpectedly.
    await db.query(`DELETE FROM documents WHERE id=$1`, [doc.id]);

    // If this was the current document on a checklist condition and nothing
    // accepted remains, reopen the condition so it's re-requested (unless it was
    // already signed off — a signed-off item stays; staff can reopen it
    // explicitly). Mirrors the review endpoint's condition handling.
    if (doc.checklist_item_id) {
      const remain = await db.query(
        `SELECT 1 FROM documents WHERE checklist_item_id=$1 AND is_current=true AND review_status='accepted' LIMIT 1`,
        [doc.checklist_item_id]);
      if (!remain.rows[0]) {
        await db.query(
          `UPDATE checklist_items SET status='outstanding', updated_at=now()
            WHERE id=$1 AND status IN ('received','issue','requested') AND signed_off_at IS NULL`,
          [doc.checklist_item_id]);
        try { await enqueueChecklistStatusPush(doc.checklist_item_id); } catch (_) {}
      }
    }

    // Removing CURRENT evidence un-does the downstream state the same way a
    // reject does — deleting a mistake pending doc changes nothing, but deleting
    // the live doc a verified LLC / track-record line stood on revokes that
    // verification (its clean evidence no longer exists). Old/superseded versions
    // (is_current=false) never disturb a verification.
    if (doc.is_current && doc.llc_id) {
      const wasVerified = await db.query(
        `UPDATE llcs SET is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now()
          WHERE id=$1 AND is_verified=true RETURNING id`, [doc.llc_id]);
      if (wasVerified.rows[0]) await audit(req, 'unverify_llc', 'llc', doc.llc_id, { cause: 'document_deleted', documentId: doc.id });
      try { await llcLib.syncLlcConditions(doc.llc_id, { reopen: true }); } catch (_) { /* best-effort */ }
    }
    if (doc.is_current && doc.track_record_id) {
      const was = await db.query(
        `UPDATE track_records SET verification_status='docs', is_verified=false, verified_at=NULL, verified_by=NULL, updated_at=now()
          WHERE id=$1 AND is_verified=true RETURNING borrower_id`, [doc.track_record_id]);
      if (was.rows[0]) {
        await audit(req, 'unverify_track_record', 'track_record', doc.track_record_id, { cause: 'document_deleted', documentId: doc.id });
        await db.query(
          `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true AND (${RECENT_EXIT_SQL})) WHERE id=$1`,
          [was.rows[0].borrower_id]);
        try { await require('../lib/experience').syncExperienceChecklistForBorrower(was.rows[0].borrower_id); } catch (_) {}
        try { await conditionEngine.evaluateBorrowerApplications(was.rows[0].borrower_id, { actor: req.actor, reason: 'track_record_doc_deleted' }); } catch (_) {}
      }
    }
    await audit(req, 'delete_document', 'document', doc.id,
      { filename: doc.filename, wasMirrored: !!doc.sharepoint_backed_up_at, llcId: doc.llc_id, trackRecordId: doc.track_record_id });
    // Live cross-user refresh (#112): a deleted track-record line-item doc leaves
    // the borrower's + other staff's view immediately.
    if (doc.track_record_id) require('../lib/events').publishTrackRecordUpdate(doc.borrower_id, { kind: 'staff', id: req.actor.id }).catch(() => {});
    res.json({ ok: true, deleted: true, wasMirrored: !!doc.sharepoint_backed_up_at });
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
      `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL
          AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
      [doc.application_id, req.actor.id]);
    return !!r.rows[0];
  }
  if (doc.borrower_id) {
    // Only borrower/llc-scoped documents (no application_id) use the
    // borrower-wide fallback.
    const r = await db.query(
      `SELECT 1 FROM applications a WHERE a.borrower_id=$1 AND a.deleted_at IS NULL
          AND ${VISIBLE_OFFICERS_SQL('a', '$2')}
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
// Normalize an email for dedup / matching — lowercased + whitespace stripped.
// Returns '' for blank / non-string input. Used by the vendor merge suggester +
// the mergeArrays helper below (case-only duplicates collapse to one entry).
function vendorNormEmail(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
// Digits-only phone form for dedup (formatting differences don't split rows).
function vendorNormPhone(v) { return String(v == null ? '' : v).replace(/\D+/g, ''); }
// Alphanumeric lowercased vendor name key for duplicate detection.
function vendorNormName(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ''); }
// De-dupe an array by a normalizer, preserving first-seen order + trimming.
function dedupBy(arr, norm) {
  const seen = new Set(), out = [];
  for (const raw of (arr || [])) {
    const s = String(raw == null ? '' : raw).trim();
    if (!s) continue;
    const k = norm(s);
    if (!k || seen.has(k)) continue;
    seen.add(k); out.push(s);
  }
  return out;
}

router.get('/vendors', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const type = VENDOR_TYPES.includes(req.query.type) ? req.query.type : null;
  // Merged rows are hidden by default — the merge target absorbs them. Pass
  // ?includeMerged=1 to include them (for an audit view / history panel).
  const includeMerged = String(req.query.includeMerged || '') === '1';
  const r = await db.query(
    `SELECT sc.id, sc.contact_type, sc.company_name, sc.contact_name,
            sc.email, sc.phone, sc.emails, sc.phones, sc.address,
            sc.notes, sc.created_at, sc.updated_at, sc.last_used_at,
            sc.merged_into_id, sc.merged_at,
            b.first_name || ' ' || b.last_name AS added_by_borrower,
            s.full_name AS added_by_staff,
            (SELECT count(*)::int FROM application_service_contacts x WHERE x.service_contact_id=sc.id) AS files_used
       FROM service_contacts sc
       LEFT JOIN borrowers b ON b.id=sc.borrower_id
       LEFT JOIN staff_users s ON s.id=sc.added_by_staff_id
      WHERE ($1::text IS NULL OR sc.contact_type=$1)
        AND ($2::boolean OR sc.merged_into_id IS NULL)
      ORDER BY sc.contact_type, lower(coalesce(sc.company_name, sc.contact_name, sc.email, ''))`, [type, includeMerged]);
  // Duplicate detection: group vendors of the same type that share ANY signal —
  // normalized company name, any email (case-insensitive), or any phone (digits).
  // Returns a `duplicate_group` id per candidate cluster so the UI can offer a
  // merge without a second round-trip. Runs in-memory (small dataset).
  const rows = r.rows.map((v) => ({ ...v,
    emails: Array.isArray(v.emails) ? v.emails : (v.email ? [v.email] : []),
    phones: Array.isArray(v.phones) ? v.phones : (v.phone ? [v.phone] : []),
  }));
  const parent = new Map();
  const find = (x) => { let p = x; while (parent.get(p) && parent.get(p) !== p) p = parent.get(p); return p; };
  const union = (a, b) => { const pa = find(a), pb = find(b); if (pa !== pb) parent.set(pa, pb); };
  for (const v of rows) parent.set(v.id, v.id);
  const byKey = new Map();   // key -> first vendor id seen
  const addKey = (key, vid) => {
    if (!key) return;
    const seen = byKey.get(key);
    if (seen) union(seen, vid); else byKey.set(key, vid);
  };
  for (const v of rows) {
    if (v.merged_into_id) continue;
    const t = v.contact_type || '';
    const nk = vendorNormName(v.company_name || v.contact_name || '');
    if (nk) addKey(`${t}|n|${nk}`, v.id);
    for (const em of v.emails) { const k = vendorNormEmail(em); if (k) addKey(`${t}|e|${k}`, v.id); }
    for (const ph of v.phones) { const k = vendorNormPhone(ph); if (k && k.length >= 7) addKey(`${t}|p|${k}`, v.id); }
  }
  // Only stamp a group id when 2+ vendors joined the same cluster.
  const groupSize = new Map();
  for (const v of rows) { const g = find(v.id); groupSize.set(g, (groupSize.get(g) || 0) + 1); }
  for (const v of rows) {
    const g = find(v.id);
    v.duplicate_group = (groupSize.get(g) || 0) > 1 ? g : null;
  }
  res.json(rows);
});
router.post('/vendors', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const b = req.body || {};
  const type = VENDOR_TYPES.includes(b.contactType) ? b.contactType : 'other';
  const emailsRaw = Array.isArray(b.emails) ? b.emails : (b.email ? [b.email] : []);
  const phonesRaw = Array.isArray(b.phones) ? b.phones : (b.phone ? [b.phone] : []);
  const emails = dedupBy(emailsRaw, vendorNormEmail);
  const phones = dedupBy(phonesRaw, vendorNormPhone);
  if (!b.companyName && !b.contactName && !emails.length && !phones.length)
    return res.status(400).json({ error: 'enter at least one contact detail' });
  const r = await db.query(
    `INSERT INTO service_contacts (contact_type,company_name,contact_name,email,phone,emails,phones,address,notes,added_by_staff_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [type, b.companyName || null, b.contactName || null,
     emails[0] || null, phones[0] || null,
     emails.length ? emails : null, phones.length ? phones : null,
     b.address || null, b.notes || null, req.actor.id]);
  await audit(req, 'add_vendor', 'service_contact', r.rows[0].id, { type });
  res.status(201).json({ ok: true, vendorId: r.rows[0].id });
});
router.patch('/vendors/:id', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const b = req.body || {};
  const map = { companyName: 'company_name', contactName: 'contact_name',
                phone: 'phone', address: 'address', notes: 'notes' };
  const sets = [], vals = []; let i = 1;
  for (const [k, col] of Object.entries(map))
    if (b[k] !== undefined) { sets.push(`${col}=$${i++}`); vals.push(b[k] === '' ? null : b[k]); }
  if (b.contactType && VENDOR_TYPES.includes(b.contactType)) { sets.push(`contact_type=$${i++}`); vals.push(b.contactType); }
  // Emails / phones — accept either an ARRAY (full replacement, deduped) or a
  // legacy scalar (goes into the primary column). When an array is given, the
  // scalar email/phone is set to the first entry so the display stays consistent.
  if (Array.isArray(b.emails)) {
    const arr = dedupBy(b.emails, vendorNormEmail);
    sets.push(`emails=$${i++}`); vals.push(arr.length ? arr : null);
    sets.push(`email=$${i++}`); vals.push(arr[0] || null);
  } else if (b.email !== undefined) {
    sets.push(`email=$${i++}`); vals.push(b.email === '' ? null : b.email);
  }
  if (Array.isArray(b.phones)) {
    const arr = dedupBy(b.phones, vendorNormPhone);
    sets.push(`phones=$${i++}`); vals.push(arr.length ? arr : null);
    sets.push(`phone=$${i++}`); vals.push(arr[0] || null);
  }
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

// Manual vendor merge (owner-directed 2026-07-21). The survivor absorbs the
// loser's field values PER-FIELD (fieldPicks tells us which side wins each
// scalar); their emails/phones arrays UNION (dedup); every application link
// re-points to the survivor; the loser is soft-marked merged_into_id (never
// deleted, so audit trails still resolve). Body:
//   { survivorId, mergedId, picks: { companyName, contactName, address, notes,
//                                    contactType, primaryEmail, primaryPhone },
//     emails: [...], phones: [...] }
// Every pick is optional — omitted → keep the survivor's current value.
router.post('/vendors/merge', async (req, res) => {
  if (!can(req.actor, 'manage_vendors')) return res.status(403).json({ error: 'you do not have permission to manage vendors' });
  const b = req.body || {};
  const survivorId = b.survivorId, mergedId = b.mergedId;
  if (!survivorId || !mergedId || survivorId === mergedId)
    return res.status(400).json({ error: 'pick two different vendors to merge' });
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const sv = (await client.query(`SELECT * FROM service_contacts WHERE id=$1 FOR UPDATE`, [survivorId])).rows[0];
    const md = (await client.query(`SELECT * FROM service_contacts WHERE id=$1 FOR UPDATE`, [mergedId])).rows[0];
    if (!sv || !md) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'vendor not found' }); }
    if (sv.merged_into_id || md.merged_into_id) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'one of the vendors is already merged' }); }
    const picks = b.picks || {};
    // Per-scalar-field pick: value not provided → keep the survivor's current.
    const pick = (k, cur) => (picks[k] === undefined ? cur : (picks[k] === '' ? null : picks[k]));
    const type = VENDOR_TYPES.includes(picks.contactType) ? picks.contactType : sv.contact_type;
    // Union both sides' email/phone arrays, then honor the caller's explicit
    // list if they sent one (an admin de-selecting a bad email during merge).
    const svEmails = Array.isArray(sv.emails) ? sv.emails : (sv.email ? [sv.email] : []);
    const mdEmails = Array.isArray(md.emails) ? md.emails : (md.email ? [md.email] : []);
    const svPhones = Array.isArray(sv.phones) ? sv.phones : (sv.phone ? [sv.phone] : []);
    const mdPhones = Array.isArray(md.phones) ? md.phones : (md.phone ? [md.phone] : []);
    const emails = Array.isArray(b.emails) ? dedupBy(b.emails, vendorNormEmail) : dedupBy([...svEmails, ...mdEmails], vendorNormEmail);
    const phones = Array.isArray(b.phones) ? dedupBy(b.phones, vendorNormPhone) : dedupBy([...svPhones, ...mdPhones], vendorNormPhone);
    // Primary email/phone = the caller's pick if present AND actually kept in
    // the final array (post-merge-review 2026-07-21: the UI let a user pick a
    // primary and then uncheck that same value from the list — the primary
    // would then point at an email the vendor no longer carries). Fall back to
    // the FIRST of the merged array so the primary is always a real, retained
    // value — never blank when there IS an entry available.
    const emailKeys = new Set(emails.map(vendorNormEmail));
    const phoneKeys = new Set(phones.map(vendorNormPhone));
    const primaryEmail = (picks.primaryEmail !== undefined && picks.primaryEmail
      && emailKeys.has(vendorNormEmail(picks.primaryEmail)))
      ? picks.primaryEmail : (emails[0] || null);
    const primaryPhone = (picks.primaryPhone !== undefined && picks.primaryPhone
      && phoneKeys.has(vendorNormPhone(picks.primaryPhone)))
      ? picks.primaryPhone : (phones[0] || null);
    await client.query(
      `UPDATE service_contacts
          SET contact_type=$2, company_name=$3, contact_name=$4, address=$5, notes=$6,
              email=$7, phone=$8, emails=$9, phones=$10, updated_at=now()
        WHERE id=$1`,
      [survivorId, type,
       pick('companyName', sv.company_name), pick('contactName', sv.contact_name),
       pick('address', sv.address), pick('notes', sv.notes),
       primaryEmail, primaryPhone,
       emails.length ? emails : null, phones.length ? phones : null]);
    // Re-point every application link. The (application_id, service_contact_id)
    // unique index (db/078) collides if the SAME file already had BOTH vendors
    // linked — in that case keep the survivor's existing link and drop the
    // loser's link row (the survivor already covers the file).
    try {
      await client.query(
        `UPDATE application_service_contacts SET service_contact_id=$2
          WHERE service_contact_id=$1
            AND NOT EXISTS (
              SELECT 1 FROM application_service_contacts x
               WHERE x.application_id = application_service_contacts.application_id
                 AND x.service_contact_id = $2
            )`,
        [mergedId, survivorId]);
    } catch (e) {
      // Fall back on 23505 by dropping conflicting rows explicitly.
      if (!e || e.code !== '23505') throw e;
    }
    await client.query(
      `DELETE FROM application_service_contacts WHERE service_contact_id=$1`,
      [mergedId]);
    // Soft-mark the loser — bytes stay for audit; the listing hides it.
    await client.query(
      `UPDATE service_contacts SET merged_into_id=$2, merged_at=now(), updated_at=now() WHERE id=$1`,
      [mergedId, survivorId]);
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.warn('[vendor-merge] failed:', db.describeError(e));
    return res.status(500).json({ error: 'merge failed' });
  } finally { client.release(); }
  await audit(req, 'merge_vendors', 'service_contact', survivorId, { mergedId });
  res.json({ ok: true, survivorId, mergedId });
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
  // Don't add a contact (or, now, complete its condition) on a soft-deleted file
  // (audit #236 hardening — an admin's canTouchApp short-circuits seesAll, so
  // guard the lookup itself).
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1 AND deleted_at IS NULL`, [req.params.id]);
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
  // #107: entering the title / insurance contact completes the borrower's contact
  // CONDITION too — the LO / processor / admin can satisfy it on the borrower's
  // behalf, the same 'received' transition the borrower's own form submission makes
  // (sign-off stays separate). An explicit checklistItemId targets one item; else
  // it auto-resolves the open condition by tool_key from the contact type. Never
  // reopens an already-satisfied/waived condition. Best-effort: the contact is
  // already saved, so a condition hiccup never fails the request.
  const CONTACT_CONDITION = { title_company: 'title_contact', insurance_agent: 'insurance_contact', flood_insurance: 'insurance_contact' };
  const toolKey = CONTACT_CONDITION[type];
  if (toolKey) {
    try {
      const upd = b.checklistItemId
        ? await db.query(
            `UPDATE checklist_items SET status='received', updated_at=now()
              WHERE id=$1 AND application_id=$2 AND tool_key=$3 AND status NOT IN ('satisfied','waived') RETURNING id`,
            [b.checklistItemId, req.params.id, toolKey])
        : await db.query(
            `UPDATE checklist_items SET status='received', updated_at=now()
              WHERE application_id=$1 AND tool_key=$2 AND status NOT IN ('satisfied','waived') RETURNING id`,
            [req.params.id, toolKey]);
      for (const row of upd.rows) enqueueChecklistStatusPush(row.id).catch(() => {});
    } catch (_) { /* condition completion is best-effort */ }
  }
  res.status(201).json({ ok: true, linkId: link.rows[0].id, contactId: sc.rows[0].id });
});
// Edit a file contact in place (owner-directed 2026-07-16: staff had only a
// Remove button — a mistyped title/insurance/realtor contact needs an Edit, not
// a delete-and-re-add). Updates the shared vendor row's details + the link's
// contact type. Mirrored on the borrower side.
router.patch('/file-contacts/:linkId', async (req, res) => {
  const f = await db.query(
    `SELECT l.application_id, l.service_contact_id
       FROM application_service_contacts l JOIN applications a ON a.id=l.application_id
      WHERE l.id=$1 AND a.deleted_at IS NULL`, [req.params.linkId]);
  if (!f.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canTouchApp(req, f.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
  const b = req.body || {};
  if (!b.companyName && !b.contactName && !b.email && !b.phone) return res.status(400).json({ error: 'enter at least one contact detail' });
  const type = FILE_CONTACT_TYPES.includes(b.contactType) ? b.contactType : null;
  const custom = type === 'other' ? (String(b.customType || '').trim().slice(0, 60) || null) : null;
  // COALESCE the type so a request that omits it keeps the stored value; keep the
  // stored custom_type too when no valid type is given (only reset it when the
  // type is actually being changed).
  await db.query(
    `UPDATE service_contacts SET contact_type=COALESCE($2, contact_type),
        custom_type=CASE WHEN $2::text IS NULL THEN custom_type ELSE $3 END,
        company_name=$4, contact_name=$5, email=$6, phone=$7, address=$8, notes=$9, updated_at=now()
      WHERE id=$1`,
    [f.rows[0].service_contact_id, type, custom, b.companyName || null, b.contactName || null,
     b.email || null, b.phone || null, b.address || null, b.notes || null]);
  if (type) await db.query(`UPDATE application_service_contacts SET contact_type=$2 WHERE id=$1`, [req.params.linkId, type]);
  await audit(req, 'edit_file_contact', 'application', f.rows[0].application_id, { contactType: type || undefined });
  res.json({ ok: true });
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

// ---------------- request-audit (automatic HTTP firehose) -------------------
// Companion to /audit-log: this feed is the AUTOMATIC log written by
// src/lib/request-audit.js — ONE row per HTTP request the server answered,
// regardless of whether the handler chose to journal a semantic action. Same
// permission gate (view_audit_log) — this is a whole-company operational log,
// not a per-file view — so only admins hold it by default.
//
// Filter shape mirrors /audit-log: q (free-text over path/method/actor/route),
// actorKind, actorId, method, status (integer OR '2xx'/'4xx'/'5xx' bucket),
// path (substring), route (exact), from/to dates, limit/offset.
router.get('/request-audit', async (req, res) => {
  if (!can(req.actor, 'view_audit_log')) return res.status(403).json({ error: 'forbidden' });
  try {
    const q = String(req.query.q || '').trim();
    const actorKindRaw = String(req.query.actorKind || '').trim();
    const actorKind = ['staff', 'borrower', 'anon', 'system'].includes(actorKindRaw) ? actorKindRaw : '';
    const actorIdRaw = String(req.query.actorId || '').trim();
    const actorId = UUID_RE.test(actorIdRaw) ? actorIdRaw : '';
    const method = String(req.query.method || '').trim().toUpperCase().slice(0, 10);
    const statusRaw = String(req.query.status || '').trim();
    const pathQ = String(req.query.path || '').trim();
    const route = String(req.query.route || '').trim();
    const fromRaw = String(req.query.from || '').trim();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : '';
    const toRaw = String(req.query.to || '').trim();
    const to = /^\d{4}-\d{2}-\d{2}$/.test(toRaw) ? toRaw : '';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    const params = [];
    const where = [];
    const P = (v) => { params.push(v); return '$' + params.length; };

    if (actorKind) where.push(`ra.actor_kind = ${P(actorKind)}`);
    if (actorId) where.push(`ra.actor_id = ${P(actorId)}::uuid`);
    if (method && /^[A-Z]+$/.test(method)) where.push(`ra.method = ${P(method)}`);
    if (pathQ) where.push(`ra.path ILIKE ${P('%' + pathQ + '%')}`);
    if (route) where.push(`ra.route = ${P(route)}`);
    if (from) where.push(`ra.at >= ${P(from)}::date`);
    if (to) where.push(`ra.at < (${P(to)}::date + 1)`);
    if (statusRaw) {
      if (/^\d{3}$/.test(statusRaw)) where.push(`ra.status = ${P(parseInt(statusRaw, 10))}`);
      else if (/^[2345]xx$/i.test(statusRaw)) {
        const bucket = parseInt(statusRaw[0], 10) * 100;
        where.push(`ra.status >= ${P(bucket)} AND ra.status < ${P(bucket + 100)}`);
      } else if (statusRaw === 'error') where.push(`ra.status >= 400`);
    }
    if (q) {
      const like = P('%' + q + '%');
      where.push(`(ra.path ILIKE ${like} OR ra.route ILIKE ${like} OR ra.method ILIKE ${like}
                    OR ra.user_agent ILIKE ${like} OR ra.referer ILIKE ${like}
                    OR ra.actor_email ILIKE ${like} OR ra.error ILIKE ${like}
                    OR s.full_name ILIKE ${like}
                    OR (bo.first_name || ' ' || bo.last_name) ILIKE ${like})`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const lim = P(limit), off = P(offset);
    const sql = `
      SELECT ra.id, ra.at, ra.request_id,
             ra.actor_kind, ra.actor_id, ra.actor_email, ra.actor_role,
             ra.method, ra.path, ra.route, ra.query, ra.status, ra.duration_ms,
             ra.ip::text AS ip, ra.user_agent, ra.referer,
             ra.entity_type, ra.entity_id, ra.body_summary, ra.error, ra.bytes_out,
             CASE WHEN ra.actor_kind = 'staff' THEN s.full_name
                  WHEN ra.actor_kind = 'borrower' THEN NULLIF(btrim(coalesce(bo.first_name,'')||' '||coalesce(bo.last_name,'')), '')
                  ELSE NULL END AS actor_name
        FROM request_audit_log ra
        LEFT JOIN staff_users s ON ra.actor_kind='staff' AND s.id = ra.actor_id
        LEFT JOIN borrowers bo  ON ra.actor_kind='borrower' AND bo.id = ra.actor_id
        ${whereSql}
       ORDER BY ra.at DESC, ra.id DESC
       LIMIT ${lim} OFFSET ${off}`;
    const r = await db.query(sql, params);
    const rows = r.rows.map((row) => ({
      id: String(row.id),
      at: row.at,
      requestId: row.request_id,
      actor: {
        kind: row.actor_kind,
        id: row.actor_id,
        role: row.actor_role,
        email: row.actor_email,
        name: row.actor_name || (row.actor_kind === 'anon' ? 'Anonymous' : row.actor_kind === 'system' ? 'System' : null),
      },
      method: row.method,
      path: row.path,
      route: row.route,
      query: row.query,
      status: row.status,
      durationMs: row.duration_ms,
      ip: row.ip,
      userAgent: row.user_agent,
      referer: row.referer,
      entity: row.entity_type ? { type: row.entity_type, id: row.entity_id } : null,
      bodySummary: row.body_summary,
      error: row.error,
      bytesOut: row.bytes_out,
    }));
    res.json({ rows, limit, offset, hasMore: rows.length === limit });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// Summary counters for the request-audit dashboard header — small,
// bounded scans across the recent window so a filter panel + a
// "requests-per-minute" strip can render off ONE call.
router.get('/request-audit/summary', async (req, res) => {
  if (!can(req.actor, 'view_audit_log')) return res.status(403).json({ error: 'forbidden' });
  try {
    const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 168);
    const [totals, byMethod, byStatus, topPaths, topActors] = await Promise.all([
      db.query(
        `SELECT count(*)::int AS n,
                count(*) FILTER (WHERE status >= 500)::int AS errors_5xx,
                count(*) FILTER (WHERE status >= 400 AND status < 500)::int AS errors_4xx,
                round(avg(duration_ms))::int AS avg_ms,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms
           FROM request_audit_log
          WHERE at >= now() - make_interval(hours => $1)`, [hours]),
      db.query(
        `SELECT method, count(*)::int AS n
           FROM request_audit_log
          WHERE at >= now() - make_interval(hours => $1)
          GROUP BY method ORDER BY n DESC`, [hours]),
      db.query(
        `SELECT status, count(*)::int AS n
           FROM request_audit_log
          WHERE at >= now() - make_interval(hours => $1) AND status IS NOT NULL
          GROUP BY status ORDER BY n DESC LIMIT 20`, [hours]),
      db.query(
        `SELECT COALESCE(route, path) AS p, count(*)::int AS n,
                round(avg(duration_ms))::int AS avg_ms
           FROM request_audit_log
          WHERE at >= now() - make_interval(hours => $1)
          GROUP BY p ORDER BY n DESC LIMIT 25`, [hours]),
      db.query(
        `SELECT ra.actor_kind, ra.actor_id, count(*)::int AS n,
                CASE WHEN ra.actor_kind='staff' THEN s.full_name
                     WHEN ra.actor_kind='borrower' THEN NULLIF(btrim(coalesce(bo.first_name,'')||' '||coalesce(bo.last_name,'')), '')
                     ELSE ra.actor_kind END AS name
           FROM request_audit_log ra
           LEFT JOIN staff_users s ON ra.actor_kind='staff' AND s.id = ra.actor_id
           LEFT JOIN borrowers bo  ON ra.actor_kind='borrower' AND bo.id = ra.actor_id
          WHERE ra.at >= now() - make_interval(hours => $1)
          GROUP BY ra.actor_kind, ra.actor_id, name
          ORDER BY n DESC LIMIT 20`, [hours]),
    ]);
    res.json({
      windowHours: hours,
      totals: totals.rows[0] || {},
      byMethod: byMethod.rows,
      byStatus: byStatus.rows,
      topPaths: topPaths.rows,
      topActors: topActors.rows,
    });
  } catch (e) {
    res.status(500).json({ error: 'server error' });
  }
});

// ---------------- per-file observability timeline (#147) --------------------
// ONE cross-system "what happened to this file" feed, time-ordered, merging every
// event stream the platform already journals: the portal audit trail (audit_log),
// the OUTBOUND ClickUp field-write journal (clickup_write_log, incl. guard-blocked
// writes), the two-sided sync review queue (sync_review_queue), and the SharePoint
// mirror lifecycle (documents' sharepoint_* stamps: backed-up / verified / skipped
// / errored). Access is the file's own scope (the /applications/:id middleware
// above already gated it), so a file's team sees its own history; nothing new is
// exposed. Read-only aggregation — never emits a raw SSN/card (the ClickUp journal
// is already masked; we surface field KEYS + outcomes, not full values). The
// companion docs/OBSERVABILITY.md maps every source and how they compose.
router.get('/applications/:id/observability', async (req, res) => {
  const appId = req.params.id;
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 250, 1), 500);
    const sources = String(req.query.sources || '').split(',').map((s) => s.trim()).filter(Boolean);
    const want = (name) => sources.length === 0 || sources.includes(name);

    const [portal, cuOut, reviews, sp] = await Promise.all([
      // Portal actions on this file: entity is the application, OR the detail
      // names this application (many writes stamp detail.applicationId).
      want('portal') ? db.query(
        `SELECT al.created_at AS ts, al.actor_kind, al.action, al.detail,
                COALESCE(su.full_name, bo.first_name || ' ' || bo.last_name, 'System') AS actor
           FROM audit_log al
           LEFT JOIN staff_users su ON su.id = al.actor_id AND al.actor_kind = 'staff'
           LEFT JOIN borrowers bo   ON bo.id = al.actor_id AND al.actor_kind = 'borrower'
          WHERE (al.entity_type = 'application' AND al.entity_id = $1)
             OR al.detail->>'applicationId' = $1::text
          ORDER BY al.created_at DESC LIMIT $2`, [appId, limit]) : { rows: [] },
      // Outbound ClickUp field writes (incl. guard-blocked ones).
      want('clickup') ? db.query(
        `SELECT created_at AS ts, field_key, field_id, changed, blocked, source
           FROM clickup_write_log WHERE application_id = $1
          ORDER BY created_at DESC LIMIT $2`, [appId, limit]) : { rows: [] },
      // Cross-system sync reviews (suspicious changes parked / resolved).
      want('sync') ? db.query(
        `SELECT created_at AS ts, resolved_at, direction, field_key, reason, status, winner, auto_resolved
           FROM sync_review_queue WHERE application_id = $1
          ORDER BY created_at DESC LIMIT $2`, [appId, limit]) : { rows: [] },
      // SharePoint mirror lifecycle per document on the file.
      want('sharepoint') ? db.query(
        `SELECT filename, sharepoint_backed_up_at, sharepoint_verified_at, sharepoint_stamped_at,
                sharepoint_backup_error, sharepoint_skipped_reason, sharepoint_integrity, sharepoint_web_url,
                created_at
           FROM documents
          WHERE application_id = $1
            AND (sharepoint_backed_up_at IS NOT NULL OR sharepoint_verified_at IS NOT NULL
                 OR sharepoint_backup_error IS NOT NULL OR sharepoint_skipped_reason IS NOT NULL)
          ORDER BY COALESCE(sharepoint_verified_at, sharepoint_backed_up_at, created_at) DESC LIMIT $2`, [appId, limit]) : { rows: [] },
    ]);

    const events = [];
    for (const r of portal.rows) {
      const meta = describeAuditAction(r.action);
      events.push({ ts: r.ts, source: 'portal', category: meta.cat || 'other',
        actor: r.actor, action: r.action, summary: meta.label || r.action,
        detail: { entity: r.detail && (r.detail.entityType || undefined) } });
    }
    for (const r of cuOut.rows) {
      const key = r.field_key || r.field_id || 'field';
      events.push({ ts: r.ts, source: 'clickup', category: 'sync',
        actor: 'ClickUp sync', action: r.blocked ? 'clickup_write_blocked' : 'clickup_write',
        summary: r.blocked ? `ClickUp write BLOCKED by a guardrail (${key})`
          : r.changed ? `Wrote ${key} to ClickUp` : `No-op ${key} (already equal)`,
        detail: { field: key, changed: r.changed, blocked: r.blocked, via: r.source } });
    }
    for (const r of reviews.rows) {
      events.push({ ts: r.resolved_at || r.ts, source: 'sync', category: 'sync',
        actor: r.auto_resolved ? 'Auto-resolver' : 'Sync review',
        action: `sync_review_${r.status}`,
        summary: `Sync review (${r.direction || '—'} ${r.field_key || ''}) — ${r.status}${r.winner ? ` · kept ${r.winner}` : ''}`,
        detail: { reason: r.reason, status: r.status, winner: r.winner || undefined, autoResolved: !!r.auto_resolved } });
    }
    for (const r of sp.rows) {
      const ts = r.sharepoint_verified_at || r.sharepoint_backed_up_at || r.sharepoint_stamped_at || r.created_at;
      const state = r.sharepoint_backup_error ? 'errored'
        : r.sharepoint_skipped_reason ? `skipped (${r.sharepoint_skipped_reason})`
          : r.sharepoint_verified_at ? `verified (${r.sharepoint_integrity || 'ok'})`
            : 'mirrored';
      events.push({ ts, source: 'sharepoint', category: 'sync', actor: 'SharePoint sync',
        action: 'sharepoint_mirror', summary: `${r.filename || 'Document'} — ${state}`,
        detail: { integrity: r.sharepoint_integrity || undefined, skipped: r.sharepoint_skipped_reason || undefined,
          error: r.sharepoint_backup_error ? String(r.sharepoint_backup_error).slice(0, 160) : undefined,
          url: r.sharepoint_web_url || undefined } });
    }

    // One time-ordered feed (newest first), capped after the merge.
    events.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    const trimmed = events.slice(0, limit);
    res.json({
      applicationId: appId,
      counts: { portal: portal.rows.length, clickup: cuOut.rows.length, sync: reviews.rows.length, sharepoint: sp.rows.length, total: events.length },
      events: trimmed,
    });
  } catch (e) {
    console.error('[observability] timeline failed', appId, e.message);
    res.status(500).json({ error: 'server error' });
  }
});

// ---------------- sync review queue (2026-07-15 date incident) --------------
// The human gate for suspicious cross-system changes (db/108): blocked outbound
// DOB shifts, inbound out-of-range years (mid-typing / 2-digit "26"), and
// inbound DOBs that disagree with the portal. Nothing here is applied until a
// person approves it; rejecting closes the row. Scoped like every other list:
// seesAll sees everything (incl. rows not tied to a file); an LO/processor sees
// rows on their own files only.
router.get('/sync-reviews', async (req, res) => {
  try {
    const status = ['open', 'approved', 'rejected', 'resolved'].includes(String(req.query.status)) ? String(req.query.status) : 'open';
    const scoped = !seesAll(req);
    // Scoped access = the row's file is theirs, OR (for rows not tied to a
    // file yet — a non-materialized task, a borrower-level DOB) any of the
    // row's borrower's active files is theirs. Matches the notifyLoanOfficer
    // fan-out, so the emailed LO always finds the row behind the deep link
    // (pre-merge audit: the old scope hid application-less rows from LOs).
    const r = await db.query(
      `SELECT q.*, a.deleted_at,
              b.first_name || ' ' || b.last_name AS borrower_name,
              COALESCE(a.property_address->>'oneLine', a.property_address->>'line1') AS property
         FROM sync_review_queue q
         LEFT JOIN applications a ON a.id = q.application_id
         LEFT JOIN borrowers b ON b.id = COALESCE(q.borrower_id, a.borrower_id)
        WHERE q.status = $1
          ${scoped ? `AND ((a.id IS NOT NULL AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')})
                       OR (q.application_id IS NULL AND q.borrower_id IS NOT NULL AND EXISTS (
                             SELECT 1 FROM applications a2
                              WHERE a2.borrower_id = q.borrower_id AND a2.deleted_at IS NULL
                                AND ${VISIBLE_OFFICERS_SQL('a2', '$2')})))` : ''}
        ORDER BY q.created_at DESC LIMIT 500`,
      scoped ? [status, req.actor.id] : [status]);
    res.json({ reviews: r.rows });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Lightweight open-row count for the sidebar badge — same scope as the list,
// so a loan officer's badge counts THEIR rows (owner-directed 2026-07-15
// night: reviews must be impossible to miss, without being strict).
router.get('/sync-reviews/count', async (req, res) => {
  try {
    const scoped = !seesAll(req);
    const r = await db.query(
      `SELECT count(*)::int AS n
         FROM sync_review_queue q
         LEFT JOIN applications a ON a.id = q.application_id
        WHERE q.status = 'open'
          ${scoped ? `AND ((a.id IS NOT NULL AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$1')})
                       OR (q.application_id IS NULL AND q.borrower_id IS NOT NULL AND EXISTS (
                             SELECT 1 FROM applications a2
                              WHERE a2.borrower_id = q.borrower_id AND a2.deleted_at IS NULL
                                AND ${VISIBLE_OFFICERS_SQL('a2', '$1')})))` : ''}`,
      scoped ? [req.actor.id] : []);
    res.json({ open: r.rows[0].n });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

async function loadReviewFor(req, res) {
  const r = await db.query(`SELECT * FROM sync_review_queue WHERE id=$1`, [req.params.id]);
  const row = r.rows[0];
  if (!row) { res.status(404).json({ error: 'not found' }); return null; }
  if (row.status !== 'open') { res.status(409).json({ error: 'already resolved' }); return null; }
  if (!seesAll(req)) {
    // Same scope as the list: their file, or (application-less row) a
    // borrower any of whose active files is theirs.
    const ok = row.application_id
      ? await db.query(
          `SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`,
          [row.application_id, req.actor.id])
      : (row.borrower_id
          ? await db.query(
              `SELECT 1 FROM applications a WHERE a.borrower_id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')} LIMIT 1`,
              [row.borrower_id, req.actor.id])
          : { rows: [] });
    if (!ok.rows[0]) { res.status(403).json({ error: 'forbidden' }); return null; }
  }
  return row;
}

// Approve: apply the proposed value through the NORMAL audited write path.
//  inbound  → write the portal column (borrowers.date_of_birth / applications.*),
//             with a before-image audit row.
//  outbound → re-push the field to ClickUp with the review bypass (the push was
//             blocked by the DOB-shift guard; approval is the deliberate human
//             action the guard demands).
const REVIEW_APP_COLS = new Set(['expected_closing', 'actual_closing', 'acquisition_date']);
router.post('/sync-reviews/:id/approve', async (req, res) => {
  try {
    const row = await loadReviewFor(req, res);
    if (!row) return;
    if (row.direction === 'inbound') {
      const v = row.proposed_value;
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return res.status(422).json({ error: 'no valid proposed value to apply' });
      if (row.field_key === 'date_of_birth') {
        if (!row.borrower_id) return res.status(422).json({ error: 'no borrower on this review' });
        // WO-6 (F-M12): the shape-only regex above lets year-0026 AND a child's
        // DOB through — this legacy path wrote them unvalidated. Route through the
        // same adult-plausibility guard every other DOB write uses; reject the
        // implausible so it's fixed at the source, never blind-written.
        const dob = require('../lib/fields').sanitizeDob(v);
        if (!dob) return res.status(422).json({ error: 'not a valid adult date of birth — fix it at the source, then re-sync' });
        const before = (await db.query(`SELECT date_of_birth FROM borrowers WHERE id=$1`, [row.borrower_id])).rows[0];
        await db.query(`UPDATE borrowers SET date_of_birth=$2::date, updated_at=now() WHERE id=$1`, [row.borrower_id, dob]);
        await audit(req, 'sync_review_apply', 'borrower', row.borrower_id,
          { reviewId: row.id, field: 'date_of_birth', from: before && before.date_of_birth, to: dob, reason: row.reason });
      } else if (REVIEW_APP_COLS.has(row.field_key)) {
        if (!row.application_id) return res.status(422).json({ error: 'no application on this review' });
        // WO-6 (F-M12): year-window the date (0026 → 2026, garbage → reject) —
        // the shape regex above let a mid-typed year through to a ::date write.
        const d = require('../lib/fields').normalizeTypedDate(v);
        if (!d) return res.status(422).json({ error: 'not a valid date — fix it at the source, then re-sync' });
        const before = (await db.query(`SELECT ${row.field_key} FROM applications WHERE id=$1`, [row.application_id])).rows[0];
        await db.query(`UPDATE applications SET ${row.field_key}=$2::date, updated_at=now() WHERE id=$1`, [row.application_id, d]);
        await audit(req, 'sync_review_apply', 'application', row.application_id,
          { reviewId: row.id, field: row.field_key, from: before && before[row.field_key], to: d, reason: row.reason });
      } else {
        return res.status(422).json({ error: `unsupported field ${row.field_key}` });
      }
    } else {
      if (!row.application_id) return res.status(422).json({ error: 'no application on this review' });
      const orch = require('../clickup/orchestrator');
      const out = await orch.pushApplication(row.application_id, { only: [row.field_key], approvedReview: true });
      await audit(req, 'sync_review_apply', 'application', row.application_id,
        { reviewId: row.id, field: row.field_key, direction: 'outbound', pushed: out && out.fields, reason: row.reason });
    }
    await db.query(
      `UPDATE sync_review_queue SET status='approved', resolved_by=$2, resolved_at=now(), resolution_note=$3
        WHERE id=$1 AND status='open'`,
      [row.id, req.actor.id, (req.body && req.body.note) || null]);
    res.json({ ok: true });
  } catch (e) { return sendReviewActionError(res, e); }   // same upstream shielding as resolve/resolve-file (mega-audit nit)
});

// TWO-SIDED resolution (owner-directed 2026-07-15 evening): the reviewer picks
// which SIDE wins — 'clickup' or 'portal' — and the chosen value is applied to
// BOTH systems. Values are re-read LIVE from the winning side at resolve time
// (the row's stored values are display-only; SSNs are never stored in the
// queue). Scoped like approve/reject: the file's LO can resolve their own rows.
router.post('/sync-reviews/:id/resolve', async (req, res) => {
  try {
    const winner = String((req.body && req.body.winner) || '');
    if (!['clickup', 'portal', 'custom'].includes(winner)) return res.status(400).json({ error: "winner must be 'clickup', 'portal', or 'custom' (with a value)" });
    const row = await loadReviewFor(req, res);
    if (!row) return;
    const out = await require('../lib/sync-autoresolve').applyReviewWinner(row, winner, req.body && req.body.value);
    await db.query(
      `UPDATE sync_review_queue SET status='resolved', winner=$2, resolved_by=$3, resolved_at=now(), resolution_note=$4
        WHERE id=$1 AND status='open'`,
      [row.id, winner, req.actor.id, (req.body && req.body.note) || null]);
    await audit(req, 'sync_review_resolve', row.application_id ? 'application' : 'borrower',
      row.application_id || row.borrower_id, { reviewId: row.id, field: row.field_key, winner, ...out });
    res.json({ ok: true, ...out });
  } catch (e) { return sendReviewActionError(res, e); }
});

// Only OUR OWN validation errors (`expose`) relay their status verbatim. A
// ClickUp client error also carries `.status` — ClickUp's HTTP status — and
// relaying it is harmful: an upstream 401 (rotated ClickUp token) would read
// as session-expiry and the SPA logs the staff user out. Upstream → 502.
function sendReviewActionError(res, e) {
  if (e && e.status && e.expose) return res.status(e.status).json({ error: e.message });
  if (e && e.status) return res.status(502).json({ error: `ClickUp did not accept the request (upstream ${e.status}) — nothing was changed; try again shortly` });
  console.warn('[staff] review-action error:', db.describeError(e));
  return res.status(500).json({ error: 'server error' });
}

// FILE-LEVEL resolution (owner-directed 2026-07-15 night): a stuck FILE's
// review row is resolved by choosing an ACTION — create the file from the
// task, link the task to an existing file, retry the dead push, archive/keep
// the orphaned file — not by adopting a field value. The action list per
// reason lives in src/lib/sync-file-review.js (REASON_ACTIONS); every action
// runs the sync's own guarded machinery and is audited. Scoped like the other
// resolve endpoints (the file's LO, or borrower-level for unmaterialized).
router.post('/sync-reviews/:id/resolve-file', async (req, res) => {
  try {
    const row = await loadReviewFor(req, res);
    if (!row) return;
    const SFR = require('../lib/sync-file-review');
    const action = String((req.body && req.body.action) || '');
    const out = await SFR.applyFileReviewAction({
      row, action,
      targetApplicationId: (req.body && req.body.targetApplicationId) || null,
      // relink_task (dead/unlinked file → move an existing ClickUp card onto it)
      // carries a card id/link + an explicit move confirmation. It is ADMIN-ONLY
      // (moving a card is the same privileged action as the direct relink
      // endpoint); the action layer enforces it with this flag, since this
      // route itself is LO-reachable for the other (non-privileged) actions.
      targetTaskId: (req.body && req.body.targetTaskId) || null,
      confirmMove: !!(req.body && req.body.confirmMove),
      isAdmin: isAdmin(req),
      actorId: req.actor.id,
    });
    await db.query(
      `UPDATE sync_review_queue SET status='resolved', resolved_by=$2, resolved_at=now(), resolution_note=$3
        WHERE id=$1 AND status='open'`,
      [row.id, req.actor.id, out.note || action]);
    await audit(req, 'sync_review_resolve_file', row.application_id || out.applicationId ? 'application' : 'borrower',
      row.application_id || out.applicationId || row.borrower_id, { reviewId: row.id, reason: row.reason, action, note: out.note });
    res.json({ ok: true, ...out });
  } catch (e) {
    // relink_task on a held card asks the reviewer to confirm the move first.
    if (e && e.needsConfirm) return res.status(409).json({ error: e.message, needsConfirm: true, holder: e.holder || null });
    return sendReviewActionError(res, e);
  }
});

// ---------------- ADMIN manual ClickUp link / unlink ----------------
// Owner-directed 2026-07-19 (the Pinches Lichtman / 129 Carlisle St incident):
// the sync bound the live ClickUp card to the near-empty twin file while the
// real, worked file was orphaned. A REAL ADMIN (admin/super_admin ONLY — never a
// processor/loan_officer/underwriter, and NOT via a grantable capability) can
// detach a file from its card and move a card onto the correct file. The heavy
// lifting + all data-safety guards live in the single chokepoint
// src/clickup/relink.js; these routes are thin, role-gated wrappers.
//
// requireRole('admin') admits admin AND super_admin only (super_admin satisfies
// every gate). The /applications/:id path middleware (above) already ran and
// admitted the actor (admins are seesAll), so req.params.id is a file the actor
// may touch; the role gate then narrows to real admins.

// Preview a move for the confirm dialog: does the pasted card exist, and is it
// currently linked to another file? Never changes anything.
router.get('/applications/:id/clickup/relink-preview', requireRole('admin'), async (req, res) => {
  try {
    const out = await require('../clickup/relink').relinkPreview({ appId: req.params.id, taskInput: req.query.taskId });
    res.json({ ok: true, ...out });
  } catch (e) { return sendReviewActionError(res, e); }
});

// Detach this file from its ClickUp card. Pure portal-side unlink — the card is
// left untouched; the file parks in 'manual_review' so it won't get an auto
// re-created card and stays visible for follow-up.
router.post('/applications/:id/clickup/unlink', requireRole('admin'), async (req, res) => {
  try {
    const out = await require('../clickup/relink').unlinkFileFromTask({
      appId: req.params.id, actorId: req.actor.id, note: (req.body && req.body.note) || null });
    await audit(req, 'clickup_manual_unlink', 'application', req.params.id, { previousTaskId: out.previousTaskId });
    res.json({ ok: true, ...out });
  } catch (e) { return sendReviewActionError(res, e); }
});

// Link this file to a ClickUp card (admin override). Moves the card off any
// current holder ONLY when confirmMove is set; without it, a held card returns
// 409 { needsConfirm:true, holder } so the UI can ask first.
router.post('/applications/:id/clickup/relink', requireRole('admin'), async (req, res) => {
  try {
    const out = await require('../clickup/relink').relinkFileToTask({
      appId: req.params.id,
      taskInput: (req.body && (req.body.taskId != null ? req.body.taskId : req.body.taskInput)) || '',
      confirmMove: !!(req.body && req.body.confirmMove),
      actorId: req.actor.id });
    await audit(req, 'clickup_manual_relink', 'application', req.params.id, { taskId: out.taskId, movedFrom: out.movedFrom || null });
    res.json({ ok: true, ...out });
  } catch (e) {
    // A held-card conflict carries the holder detail so the UI can confirm the move.
    if (e && e.needsConfirm) return res.status(409).json({ error: e.message, needsConfirm: true, holder: e.holder || null });
    return sendReviewActionError(res, e);
  }
});

// BULK resolution (mega-audit enhancement #4): boot heal passes can queue
// dozens of identical-reason rows — one selection instead of fifty clicks.
// Each row goes through the SAME per-row scope check and the SAME guarded
// applier as a single resolve; per-row outcomes come back so one bad row
// never blocks the batch. Bounded to 100 ids per call.
router.post('/sync-reviews/bulk', async (req, res) => {
  try {
    const b = req.body || {};
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 100) : [];
    const action = String(b.action || '');
    if (!ids.length) return res.status(400).json({ error: 'ids required' });
    if (!['reject', 'resolve'].includes(action)) return res.status(400).json({ error: "action must be 'reject' or 'resolve'" });
    const winner = String(b.winner || '');
    if (action === 'resolve' && !['clickup', 'portal'].includes(winner)) {
      return res.status(400).json({ error: "bulk resolve needs winner 'clickup' or 'portal' (custom values are per-row)" });
    }
    const results = [];
    for (const id of ids) {
      try {
        const r = await db.query(`SELECT * FROM sync_review_queue WHERE id=$1`, [id]);
        const row = r.rows[0];
        if (!row) { results.push({ id, ok: false, error: 'not found' }); continue; }
        if (row.status !== 'open') { results.push({ id, ok: false, error: 'already resolved' }); continue; }
        if (!seesAll(req)) {
          const ok = row.application_id
            ? await db.query(`SELECT 1 FROM applications a WHERE a.id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')}`, [row.application_id, req.actor.id])
            : (row.borrower_id
                ? await db.query(`SELECT 1 FROM applications a WHERE a.borrower_id=$1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')} LIMIT 1`, [row.borrower_id, req.actor.id])
                : { rows: [] });
          if (!ok.rows[0]) { results.push({ id, ok: false, error: 'forbidden' }); continue; }
        }
        if (action === 'reject') {
          await db.query(
            `UPDATE sync_review_queue SET status='rejected', resolved_by=$2, resolved_at=now(), resolution_note='bulk dismiss' WHERE id=$1 AND status='open'`,
            [row.id, req.actor.id]);
          results.push({ id, ok: true });
        } else {
          const out = await require('../lib/sync-autoresolve').applyReviewWinner(row, winner);
          await db.query(
            `UPDATE sync_review_queue SET status='resolved', winner=$2, resolved_by=$3, resolved_at=now(), resolution_note='bulk resolve' WHERE id=$1 AND status='open'`,
            [row.id, winner, req.actor.id]);
          results.push({ id, ok: true, ...out });
        }
      } catch (e) { results.push({ id, ok: false, error: e.expose ? e.message : (e.status ? `ClickUp upstream ${e.status}` : 'failed') }); }
    }
    await audit(req, 'sync_review_bulk', 'application', null,
      { action, winner: winner || undefined, total: ids.length, ok: results.filter((x) => x.ok).length });
    res.json({ results });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.post('/sync-reviews/:id/reject', async (req, res) => {
  try {
    const row = await loadReviewFor(req, res);
    if (!row) return;
    await db.query(
      `UPDATE sync_review_queue SET status='rejected', resolved_by=$2, resolved_at=now(), resolution_note=$3
        WHERE id=$1 AND status='open'`,
      [row.id, req.actor.id, (req.body && req.body.note) || null]);
    await audit(req, 'sync_review_reject', row.application_id ? 'application' : 'borrower',
      row.application_id || row.borrower_id, { reviewId: row.id, field: row.field_key, reason: row.reason });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---------------- e-signature (DocuSign) tracking — read model --------------
// The internal "our own DocuSign" dashboard + the per-file section. Read-only
// monitoring; management actions (send/resend/void) are added with the send
// orchestration. Access: the cross-file dashboard is officer-scoped; the
// per-file route rides the /applications/:id scope guard above.
const esignTracking = require('../lib/esign/tracking');

router.get('/esign/dashboard', async (req, res) => {
  try {
    const scope = seesAll(req)
      ? { where: '', params: [] }
      : { where: `AND ${VISIBLE_OFFICERS_SQL('a', '$1')}`, params: [req.actor.id] };
    res.json(await esignTracking.dashboard(db, scope));
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---- e-signature CONNECTION + MODE status (admin) ---------------------------
// The plain-English "are we live?" readout so an admin can see exactly what still
// keeps DocuSign in test mode. Reveals no secrets — just the mode flags and, if the
// credentials authenticate, which DocuSign ACCOUNT we're bound to (practice vs live).
// `liveToBorrowers` is the single yes/no: will a REAL borrower actually be emailed?
router.get('/esign/connection', requireRole('admin'), async (req, res) => {
  const ds = require('../lib/integrations/docusign');
  const c = cfg.docusign;
  const out = {
    configured: ds.configured(),
    demo: ds.isDemoHost(),                 // true = DocuSign PRACTICE/sandbox world
    oauthHost: c.oauthBase || null,
    sendEnabled: require('../lib/integrations/switches').on('DOCUSIGN_SEND_ENABLED'), // master switch (runtime override ?? DOCUSIGN_SEND_ENABLED env)
    testMode: !!c.testMode,                // gates sends to the allow-list on ANY host
    allowlist: c.testEmailAllowlist || [], // the only emails reachable while in test mode
    reachable: null,
  };
  if (out.configured) {
    // Best-effort live auth check — never throws (bad/absent creds just report not-reachable),
    // and time-boxed so the page can't hang on a slow DocuSign.
    try {
      const p = await Promise.race([
        ds.ping(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timed out reaching DocuSign')), 8000)),
      ]);
      out.reachable = true;
      out.demo = !!p.demo;                 // authoritative from the live host
      out.accountName = p.accountName || null;
      out.accountId = p.accountId || null;
      out.userName = p.name || null;
      out.userEmail = p.email || null;
    } catch (e) { out.reachable = false; out.reachError = e.message; }
  }
  // Real borrowers are emailed ONLY when: configured + credentials reach a LIVE (non-demo)
  // account + the master switch is on + test mode is off.
  out.liveToBorrowers = !!(out.configured && out.reachable && !out.demo && out.sendEnabled && !out.testMode);
  res.json(out);
});

router.get('/applications/:id/esign', async (req, res) => {
  try {
    res.json(await esignTracking.fileEsign(db, req.params.id));
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---------------- e-signature management actions ----------------------------
// Send / resend / void / mint the admin counter-sign view. Every action is
// gated (DOCUSIGN_SEND_ENABLED off => sending refused, in the route AND the send
// engine) and audited. In TEST mode the engine's allow-list is the final backstop;
// once LIVE (test mode off) that backstop is gone by design — the appraisal gate,
// validateGenerated, roster completeness, and the stale-document guard protect the
// real borrower instead.
const esignOrchestrate = require('../lib/esign/orchestrate');
const esignWebhook = require('../lib/esign/webhook');
const docusignLib = require('../lib/integrations/docusign');

// Map a thrown orchestration error to an HTTP status + safe message.
function esignErrStatus(e) {
  if (e && e.code === 'DOCUSIGN_SEND_DISABLED') return 409;
  if (e && e.code === 'DOCUSIGN_GATE_NOT_READY') return 409;
  if (e && e.retryable === false) return 400;
  return 500;
}
// Send an esign orchestration error safely: mapped 4xx/409 keep their curated
// message; an unknown 500 logs the detail server-side and returns generic — never
// leak raw pg/JS text to the client (round-2 audit F2).
function sendEsignError(res, e, extra = {}) {
  const st = esignErrStatus(e);
  if (st >= 500) { console.warn('[staff] esign error:', db.describeError(e)); return res.status(st).json({ error: 'server error' }); }
  return res.status(st).json({ error: e.message, ...extra });
}

// Load an envelope row and confirm the actor may see its file (the /esign/:rowId
// routes are NOT under the /applications/:id scope guard, so we check here).
async function loadEsignEnvelope(req, rowId) {
  const r = await db.query(`SELECT * FROM esign_envelopes WHERE id = $1`, [rowId]);
  const row = r.rows[0];
  if (!row) return { status: 404, error: 'not found' };
  if (row.is_test) {   // test envelopes are admin-created (app-less) — only an admin may resend/void one
    if (!isAdmin(req)) return { status: 403, error: 'admins only for test envelopes' };
    return { row };
  }
  if (!seesAll(req)) {
    const vis = await db.query(
      `SELECT 1 FROM applications a WHERE a.id = $1 AND a.deleted_at IS NULL AND ${VISIBLE_OFFICERS_SQL('a', '$2')} LIMIT 1`,
      [row.application_id, req.actor.id]);
    if (!vis.rows.length) return { status: 403, error: 'forbidden' };
  }
  return { row };
}

// Admin "send myself a test envelope": confirms DocuSign renders our generated
// documents + the signing flow, without a real loan file passing the send-gate.
// Reuses the send-once engine's guards — refuses unless DOCUSIGN_SEND_ENABLED is
// on, and only ever reaches an allow-listed address in test mode.
router.post('/esign/test-send', requireRole('admin'), async (req, res) => {
  try {
    const out = await require('../lib/esign/test-send').sendTestEnvelope({ actorId: req.actor.id, db, docusign: docusignLib });
    await audit(req, 'esign_test_send', 'esign_test', null, { to: out.to, envelopeId: out.envelopeId });
    res.json({ ok: true, ...out });
  } catch (e) { sendEsignError(res, e); }
});

// Send a package for a file. Rides the /applications/:id scope guard.
router.post('/applications/:id/esign/send', async (req, res) => {
  const purpose = String((req.body && req.body.purpose) || '');
  if (!esignOrchestrate.PACKAGES[purpose]) return res.status(400).json({ error: 'unknown package' });
  const reissue = !!(req.body && req.body.reissue);
  try {
    const out = await esignOrchestrate.sendPackage(req.params.id, purpose, req.actor, { db, docusign: docusignLib, reissue });
    await audit(req, 'esign_send', 'application', req.params.id, { purpose, reissue });
    // Return the REAL outcome — never a false "Sent for signature." toast. ok mirrors
    // sendPackage's ok (a genuine send / already-sent). Every non-success disposition
    // gets its OWN plain-language reason so staff always know the true state:
    //   terminal — a prior envelope is finished; a plain re-send is a no-op → use Re-issue
    //   dead     — permanently failed (missing document, recipient off the pre-go-live
    //              allow-list, validation error)
    //   queued   — claimed but not delivered yet; the retry engine will send it
    //   retry    — a transient failure; it will auto-retry
    //   paused   — the master send switch is off right now
    //   gone     — the envelope row vanished (deleted/superseded) — refresh
    const r = out.result || {};
    const reason =
        out.terminal ? 'This package was already sent for this file. Use “Re-issue” on the envelope below to send a fresh one.'
      : r.dead ? (r.error || 'The document could not be sent.')
      : r.queued ? 'Not delivered yet — the send is queued and will retry automatically. Refresh in a minute.'
      : (r.held || r.disposition === 'paused') ? 'Sending is paused right now (the master switch is off). Try again once it’s back on.'
      : r.retry ? 'Not delivered yet — a temporary hiccup; it will retry automatically. Refresh in a minute.'
      : r.disposition === 'gone' ? 'That envelope is no longer on the file — refresh and try again.'
      : (out.ok ? undefined : 'The document could not be sent — check the file and try again.');
    res.json({
      ok: out.ok, envelopeRowId: out.envelopeRowId, result: r,
      dead: !!r.dead, queued: !!r.queued, terminal: !!out.terminal,
      error: reason,
    });
  } catch (e) {
    sendEsignError(res, e, { outstanding: e.outstanding });
  }
});

// Resend (nudge) the current pending recipient(s).
router.post('/esign/:rowId/resend', async (req, res) => {
  try {
    const { row, status, error } = await loadEsignEnvelope(req, req.params.rowId);
    if (!row) return res.status(status).json({ error });
    if (!row.envelope_id) return res.status(409).json({ error: 'envelope not sent yet' });
    if (['completed', 'declined', 'voided'].includes(row.status)) return res.status(409).json({ error: `envelope already ${row.status}` });
    // Resend is a real borrower email — the master kill-switch must gate it too. Read the RUNTIME
    // switch (override ?? env) so flipping DocuSign off on the API Health page stops resends immediately.
    if (!require('../lib/integrations/switches').on('DOCUSIGN_SEND_ENABLED')) return res.status(409).json({ error: 'Sending is paused right now. Turn sending back on before resending.' });
    // A resend can only re-notify the address DocuSign baked into the envelope at
    // send time — it cannot re-address. If the file's borrower email changed since,
    // a resend would nudge the STALE address. Refuse and steer staff to void +
    // re-issue so the new address is used. (Test envelopes are app-less — no file
    // borrower to compare against, so they skip this check.)
    if (row.application_id) {
      const cur = (await db.query(
        `SELECT b.email AS file_email, r.email AS env_email
           FROM applications a JOIN borrowers b ON b.id = a.borrower_id
           LEFT JOIN esign_recipients r ON r.envelope_row_id = $1 AND r.role = 'borrower'
          WHERE a.id = $2
          ORDER BY r.id DESC NULLS LAST
          LIMIT 1`, [row.id, row.application_id])).rows[0];
      const fileEmail = cur && cur.file_email && String(cur.file_email).trim().toLowerCase();
      const envEmail = cur && cur.env_email && String(cur.env_email).trim().toLowerCase();
      if (fileEmail && envEmail && fileEmail !== envEmail) {
        return res.status(409).json({ error: 'The borrower’s email on file changed since this package was sent. A resend can’t update the address — void this package and re-issue it so the new email is used.' });
      }
    }
    await docusignLib.resendEnvelope(row.envelope_id);
    await audit(req, 'esign_resend', 'application', row.application_id, { purpose: row.purpose });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Void a still-open envelope (reason required by DocuSign).
router.post('/esign/:rowId/void', async (req, res) => {
  const reason = String((req.body && req.body.reason) || '').trim();
  if (!reason) return res.status(400).json({ error: 'a void reason is required' });
  try {
    const { row, status, error } = await loadEsignEnvelope(req, req.params.rowId);
    if (!row) return res.status(status).json({ error });
    if (!row.envelope_id) return res.status(409).json({ error: 'envelope not sent yet' });
    if (['completed', 'declined', 'voided'].includes(row.status)) return res.status(409).json({ error: `envelope already ${row.status}` });
    await docusignLib.voidEnvelope(row.envelope_id, reason);
    await db.query(
      `UPDATE esign_envelopes SET status='voided', voided_at=now(), void_reason=$2, updated_at=now() WHERE id=$1`,
      [row.id, reason]);
    await audit(req, 'esign_void', 'application', row.application_id, { purpose: row.purpose, reason });
    res.json({ ok: true });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// Mint an embedded signing URL for the ADMIN counter-signer to sign from the
// cockpit ("Sign now"). Admin-only; DocuSign errors if it isn't the admin's turn.
router.post('/esign/:rowId/countersign-view', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'only an admin can counter-sign' });
  try {
    const { row, status, error } = await loadEsignEnvelope(req, req.params.rowId);
    if (!row) return res.status(status).json({ error });
    if (!row.envelope_id) return res.status(409).json({ error: 'envelope not sent yet' });
    const rec = (await db.query(
      `SELECT recipient_id_ds, name, email, client_user_id FROM esign_recipients
        WHERE envelope_row_id=$1 AND role='admin' LIMIT 1`, [row.id])).rows[0];
    if (!rec) return res.status(409).json({ error: 'this envelope has no counter-signer' });
    const returnUrl = `${cfg.appUrl}/api/esign/return?app=${encodeURIComponent(row.application_id)}&env=${encodeURIComponent(row.envelope_id)}&dest=staff`;
    const url = await docusignLib.createRecipientView(row.envelope_id, {
      returnUrl, email: rec.email, userName: rec.name,
      clientUserId: rec.client_user_id, recipientId: rec.recipient_id_ds,
    });
    await audit(req, 'esign_countersign_view', 'application', row.application_id, { purpose: row.purpose });
    res.json({ url });
  } catch (e) { sendEsignError(res, e); }
});

// Admin: manually drain the inbound event inbox + the send queue (ops button).
router.post('/esign/drain', async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  try {
    const inbox = await esignWebhook.drainInbox({ db, docusign: docusignLib });
    res.json({ ok: true, inbox });
  } catch (e) { console.warn('[staff] handler error:', db.describeError(e)); res.status(500).json({ error: 'server error' }); }
});

// ---------------- chat v3: conversations, receipts, presence ----------------
// Mounted last so the /applications/:id scope guard above still covers the
// application-scoped chat routes (create chat / export).
router.use(require('./staff-chat'));
router.use(require('./staff-notif-center'));

module.exports = router;
// exported for tests (the draw email center's DocuSign + Sitewire activity fold-in)
module.exports.assembleDrawEventRows = assembleDrawEventRows;
