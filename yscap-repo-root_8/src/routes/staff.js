/**
 * Staff API (loan officers, processors, underwriters, admins).
 * Officers see their assigned pipeline; admins see everything. They add
 * conditions + document requests, update checklist status, verify LLCs and
 * track records, and assign Lead-Capture (unassigned) applications.
 */
const express = require('express');
const router = require('../lib/safe-router')();
const db = require('../db');
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { serveDocument } = require('../lib/serve-document');
const cfg = require('../config');
const storage = require('../lib/storage');
const { requireAuth, requireRole } = require('../auth');
const pricing = require('../lib/pricing');
const { persistProductRegistration } = require('../lib/product-registration');
const { syncExperienceChecklistForApplication } = require('../lib/experience');
const llcLib = require('../lib/llc');

router.use(requireAuth, requireRole('admin', 'loan_officer', 'processor', 'underwriter'));
// admins + super-admins + underwriters (risk) see every file;
// loan officers and processors see only files they are assigned to.
const seesAll = (req) => ['admin', 'super_admin', 'underwriter'].includes(req.actor.role);
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
    `SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2) AND deleted_at IS NULL`,
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
// officers/processors only see their files; admins/super-admins/underwriters see all
function scopeClause(req, alias = 'a') {
  if (seesAll(req)) return { where: '', params: [] };
  return { where: `AND (${alias}.loan_officer_id=$SCOPE OR ${alias}.processor_id=$SCOPE)`, params: [req.actor.id] };
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
      `SELECT 1 FROM applications WHERE id=$1 AND deleted_at IS NULL AND (loan_officer_id=$2 OR processor_id=$2)`,
      [req.params.id, req.actor.id]);
    if (!r.rows[0]) return res.status(403).json({ error: 'forbidden' });
    next();
  } catch (e) { next(e); }
});

// ---------------- dashboard KPIs ----------------
router.get('/dashboard', async (req, res) => {
  try {
    const s = scopeClause(req);
    const w = s.where.replace(/\$SCOPE/g, '$1');
    const [byStatus, totals, leads, aging] = await Promise.all([
      db.query(`SELECT status, count(*)::int c, COALESCE(sum(loan_amount),0)::bigint v
                  FROM applications a WHERE 1=1 ${w} GROUP BY status`, s.params),
      db.query(`SELECT count(*)::int total,
                       COALESCE(sum(loan_amount),0)::bigint pipeline_value,
                       count(*) FILTER (WHERE created_at > now() - interval '7 days')::int new_week,
                       count(*) FILTER (WHERE status='funded')::int funded,
                       count(*) FILTER (WHERE status NOT IN ('funded','declined','withdrawn'))::int active
                  FROM applications a WHERE 1=1 ${w}`, s.params),
      seesAll(req)
        ? db.query(`SELECT count(*)::int c FROM leads WHERE status NOT IN ('converted','archived')`)
        : db.query(`SELECT count(*)::int c FROM leads WHERE status NOT IN ('converted','archived') AND (officer_id=$1 OR officer_id IS NULL)`, [req.actor.id]),
      db.query(`SELECT count(*)::int c FROM applications a
                 WHERE status NOT IN ('funded','declined','withdrawn')
                   AND updated_at < now() - interval '5 days' ${w}`, s.params),
    ]);
    const t = totals.rows[0];
    res.json({
      byStatus: byStatus.rows,
      total: t.total, pipelineValue: Number(t.pipeline_value), active: t.active,
      funded: t.funded, newThisWeek: t.new_week,
      openLeads: leads.rows[0].c,
      stale: aging.rows[0].c,           // active files untouched > 5 days
      conversion: t.total ? Math.round((t.funded / t.total) * 100) : 0,
    });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- pipeline ----------------
router.get('/applications', async (req, res) => {
  const s = scopeClause(req);
  const sql = `SELECT a.id,a.ys_loan_number,a.program,a.loan_type,a.status,a.property_address,
                      a.loan_amount,a.loan_officer_id,a.loan_officer_name,a.processor_id,a.created_at,
                      b.first_name,b.last_name,b.email,
                      (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id) AS total_items,
                      (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id
                         AND (ci.signed_off_at IS NOT NULL OR ci.status='satisfied')) AS done_items
               FROM applications a JOIN borrowers b ON b.id=a.borrower_id
               WHERE a.deleted_at IS NULL ${s.where.replace(/\$SCOPE/g, '$1')} ORDER BY a.created_at DESC`;
  const r = await db.query(sql, s.params);
  res.json(r.rows);
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

    // SECURITY: a scoped officer/processor must not be able to originate a file
    // against a PRE-EXISTING borrower they have no prior relationship with —
    // that would auto-assign them and unlock the borrower's decrypted SSN and
    // documents (canSeeBorrower keys off assignment to ANY of the borrower's
    // files). seesAll staff, and staff already on one of the borrower's files,
    // are allowed; everyone else must route it through an admin.
    if (!br.rows[0].created && !seesAll(req)) {
      const rel = await db.query(
        `SELECT 1 FROM applications WHERE borrower_id=$1 AND (loan_officer_id=$2 OR processor_id=$2) LIMIT 1`,
        [borrowerId, req.actor.id]);
      if (!rel.rows[0]) {
        // Undo the borrower row if THIS request just created it (it didn't here,
        // since created=false), then refuse.
        return res.status(403).json({ error: 'This borrower already has a file with YS. Ask an admin to originate or assign this file to you.' });
      }
    }

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
    await audit(req, 'create_application', 'application', appId, { origin: 'staff', borrowerId });

    // Optionally invite the borrower to the portal for this file right away.
    let invited = null;
    if (b.inviteBorrower) {
      try { invited = await inviteBorrowerToFile({ appId, borrowerId, email, firstName, req }); }
      catch (e) { console.error('[staff-origination] borrower invite failed:', db.describeError(e)); }
    }
    res.status(201).json({
      ok: true, applicationId: appId, ysLoanNumber: ins.rows[0].ys_loan_number,
      borrowerId, borrowerCreated: br.rows[0].created, invited });
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
            pr.program AS registered_program, pr.product_label AS registered_product_label,
            pr.status AS registered_product_status, pr.note_rate AS registered_note_rate,
            pr.total_loan AS registered_total_loan, pr.quote AS registered_quote,
            pr.created_at AS registered_at
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     LEFT JOIN llcs l ON l.id=a.llc_id
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

/* ---------------- Product registration / term sheet ----------------
   Pricing is computed here on the server from the same FROZEN engines the
   browser loads, so a registered product is always authoritative. */

// Load a joined application row + count the borrower's track record into the
// experience buckets the engines expect (flips / holds / ground-up).
async function loadFileForPricing(appId) {
  const a = await db.query(
    `SELECT a.*, b.fico FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [appId]);
  const app = a.rows[0];
  if (!app) return null;
  // Only VERIFIED deals count toward experience/tier — the same basis the
  // borrowers.tier recompute uses. Unverified, borrower-claimed deals must not
  // inflate the authoritative pricing tier. Staff can still override the exp*
  // inputs in the panel for a what-if.
  const tr = await db.query(
    `SELECT lower(coalesce(deal_type,'')) AS dt, count(*)::int AS n
       FROM track_records WHERE borrower_id=$1 AND is_verified=true GROUP BY 1`, [app.borrower_id]);
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
    const b = req.body || {};
    const program = b.program === 'gold' ? 'gold' : 'standard';
    const f = await loadFileForPricing(appId);
    if (!f) return res.status(404).json({ error: 'not found' });

    const { overrides } = sanitizeOverrides(req, b.overrides || {});
    const inputs = pricing.buildInputs(f.app, f.exp, overrides);
    const quote = pricing.quoteProgram(program, inputs);
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

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null,
        origination: quote.origination != null ? quote.origination : undefined,
        origPct: quote.origPct != null ? quote.origPct : undefined,
        cashToClose: quote.cashToClose != null ? quote.cashToClose : undefined,
        liquidity: (quote.liquidity ?? quote.liquidityRequired) != null ? (quote.liquidity ?? quote.liquidityRequired) : undefined,
        previous: prev ? { program: prev.program, totalLoan: Number(prev.total_loan), noteRate: Number(prev.note_rate), productLabel: prev.product_label } : undefined });

    // Registering the product satisfies the "Products & pricing" condition.
    try {
      await db.query(
        `UPDATE checklist_items SET status='received', updated_at=now()
          WHERE application_id=$1 AND tool_key='product_pricing' AND status <> 'satisfied'`, [appId]);
    } catch (_) { /* condition may not exist on older files */ }

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
  try {
    let it = await db.query(`SELECT id FROM checklist_items WHERE application_id=$1 AND tool_key='rehab_budget' LIMIT 1`, [appId]);
    let itemId = it.rows[0] && it.rows[0].id;
    if (!itemId) {
      const ins = await db.query(
        `INSERT INTO checklist_items (scope,application_id,label,audience,item_kind,tool_key,created_by_kind,created_by_id)
         VALUES ('application',$1,'Rehab budget','borrower','task','rehab_budget','staff',$2) RETURNING id`, [appId, req.actor.id]);
      itemId = ins.rows[0].id;
    }
    await db.query(`UPDATE checklist_items SET tool_payload=$2, status='received', updated_at=now() WHERE id=$1`, [itemId, JSON.stringify(payload)]);
    const total = Number(payload.total);
    if (isFinite(total) && total >= 0) await db.query(`UPDATE applications SET rehab_budget=$2, updated_at=now() WHERE id=$1`, [appId, total]);
    await audit(req, 'save_rehab_budget', 'application', appId, { total: isFinite(total) ? total : null });
    res.json({ ok: true, itemId });
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
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, tool_state=COALESCE($3,tool_state), status='received', updated_at=now() WHERE id=$1`,
    [req.params.itemId, JSON.stringify(payload),
     payload && typeof payload.state === 'object' ? JSON.stringify(payload.state) : null]);
  if (toolKey === 'rehab_budget') {
    const total = Number(payload && payload.total);
    if (isFinite(total) && total >= 0) {
      await db.query(`UPDATE applications SET rehab_budget=$2, updated_at=now() WHERE id=$1`, [req.params.id, total]);
    }
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
  res.json({ ok: true, status: 'received', exports: out });
});

router.get('/applications/:id/checklist', async (req, res) => {
  const r = await db.query(
    `SELECT ci.id, ci.label, ci.status, ci.audience, ci.item_kind, ci.is_required,
            ci.phase, ci.role_scope, ci.hint, ci.is_gate, ci.is_milestone, ci.sort_order,
            ci.due_date, ci.notes, ci.created_by_kind, ci.created_at,
            (SELECT code FROM checklist_templates t WHERE t.id=ci.template_id) AS template_code,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            ci.assignee_staff_id, asg.full_name AS assignee_name,
            ci.signed_off_by, so.full_name AS signed_off_name, ci.signed_off_at,
            ci.reviewed_by, rv.full_name AS reviewed_by_name, ci.reviewed_at
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
  const r = await db.query(
    `INSERT INTO checklist_items (scope,application_id,label,audience,item_kind,is_required,due_date,created_by_kind,created_by_id)
     VALUES ('application',$1,$2,$3,'document',$4,$5,'staff',$6) RETURNING id`,
    [req.params.id, b.label, b.audience || 'borrower', b.isRequired !== false, b.dueDate || null, req.actor.id]);
  const app = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
  if (app.rows[0]) {
    const ctx = await notify.fileContext(req.params.id);
    await notify.notifyBorrower(app.rows[0].borrower_id, {
      type: 'condition_added', title: 'New document requested on your file',
      body: `"${b.label}" was added to your conditions on ${ctx ? ctx.label : 'your file'}.`,
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
          AND review_status='accepted' AND is_current=true AND source_type<>'chat_attachment'`, [req.params.id])).rows[0].c;
    const missing = (await db.query(
      `SELECT COALESCE(label,'(document)') AS label FROM checklist_items WHERE application_id=$1 AND item_kind='document' AND status<>'satisfied' ORDER BY sort_order`, [req.params.id])).rows.map(r => r.label);
    res.json({ includedCount: included, missing });
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
    `SELECT c.*, cb.full_name AS created_by_name, xb.full_name AS cleared_by_name
       FROM conditions c
       LEFT JOIN staff_users cb ON cb.id=c.created_by
       LEFT JOIN staff_users xb ON xb.id=c.cleared_by
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
router.post('/loan-conditions/:cid/clear', async (req, res) => {
  try {
    const c = await db.query(`SELECT application_id FROM conditions WHERE id=$1`, [req.params.cid]);
    if (!c.rows[0]) return res.status(404).json({ error: 'not found' });
    if (!(await canTouchApp(req, c.rows[0].application_id))) return res.status(403).json({ error: 'forbidden' });
    await db.query(`UPDATE conditions SET status='cleared', cleared_by=$2, cleared_at=now(), updated_at=now() WHERE id=$1`, [req.params.cid, req.actor.id]);
    await audit(req, 'clear_condition', 'condition', req.params.cid);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/loan-conditions/:cid/waive', async (req, res) => {
  if (!['admin', 'super_admin'].includes(req.actor.role)) return res.status(403).json({ error: 'admin only' });
  const reason = String((req.body || {}).reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'a waive reason is required' });
  try {
    const r = await db.query(`UPDATE conditions SET status='waived', waive_reason=$2, cleared_by=$3, cleared_at=now(), updated_at=now() WHERE id=$1 RETURNING id`, [req.params.cid, reason.slice(0, 500), req.actor.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'waive_condition', 'condition', req.params.cid, { reason });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

router.patch('/checklist/:itemId', async (req, res) => {
  // access guard: non-privileged staff may only edit items on their own files.
  // llc-scoped items (entity document slots) have no application_id — they're
  // editable by anyone assigned to a file vesting in that LLC.
  if (!seesAll(req)) {
    const own = await db.query(
      `SELECT 1 FROM checklist_items ci
        LEFT JOIN applications a ON a.id=ci.application_id
        WHERE ci.id=$1 AND (
          (a.id IS NOT NULL AND (a.loan_officer_id=$2 OR a.processor_id=$2))
          OR (ci.llc_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM applications ap
                 WHERE ap.llc_id=ci.llc_id AND (ap.loan_officer_id=$2 OR ap.processor_id=$2))))`,
      [req.params.itemId, req.actor.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
  }
  const b = req.body || {};
  const allowed = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
  if (b.status && !allowed.includes(b.status)) return res.status(400).json({ error: 'bad status' });
  // Completing a condition is the PROCESSOR's call (admins too). A loan
  // officer marks it reviewed instead — a lighter stamp, never "satisfied".
  const canComplete = ['processor', 'admin', 'super_admin', 'underwriter'].includes(req.actor.role);
  if ((b.signedOff === true || b.status === 'satisfied') && !canComplete) {
    return res.status(403).json({ error: 'Only the processor can complete a condition — mark it reviewed instead.' });
  }

  const sets = ['updated_at=now()'];
  const params = [req.params.itemId];
  const add = (frag, val) => { params.push(val); sets.push(frag.replace('?', '$' + params.length)); };

  // Sign-off forces status='satisfied' below, so skip an explicit status here
  // when signing off in the same call — otherwise the UPDATE sets the `status`
  // column twice and Postgres rejects it (42601) with a 500.
  if (b.status && b.signedOff !== true) add('status=?', b.status);
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

  const r = await db.query(`UPDATE checklist_items SET ${sets.join(', ')} WHERE id=$1`, params);
  // A wrong/deleted item id used to answer {ok:true} — the UI showed a sign-off
  // that never persisted. Phantom success is this repo's #1 bug class.
  if (r.rowCount === 0) return res.status(404).json({ error: 'checklist item not found' });
  res.json({ ok: true });
});

// ---------------- assign a Lead-Capture application ----------------
router.post('/applications/:id/assign', async (req, res) => {
  const { loanOfficerId, processorId } = req.body || {};
  if (!loanOfficerId && !processorId) return res.status(400).json({ error: 'loanOfficerId or processorId required' });
  try {
    if (loanOfficerId) {
      const off = await db.query(`SELECT full_name FROM staff_users WHERE id=$1 AND is_active=true`, [loanOfficerId]);
      if (!off.rows[0]) return res.status(404).json({ error: 'officer not found' });
      const u = await db.query(`UPDATE applications SET loan_officer_id=$2, loan_officer_name=$3, updated_at=now() WHERE id=$1`,
        [req.params.id, loanOfficerId, off.rows[0].full_name]);
      if (u.rowCount === 0) return res.status(404).json({ error: 'application not found' });
      await notify.notifyStaff(loanOfficerId, {
        type: 'assignment', title: 'Application assigned to you', applicationId: req.params.id,
        link: `/internal/app/${req.params.id}` });
      await audit(req, 'assign_application', 'application', req.params.id, { loanOfficerId });
    }
    if (processorId) {
      const p = await db.query(`SELECT full_name FROM staff_users WHERE id=$1 AND is_active=true AND role='processor'`, [processorId]);
      if (!p.rows[0]) return res.status(404).json({ error: 'processor not found' });
      const u = await db.query(`UPDATE applications SET processor_id=$2, updated_at=now() WHERE id=$1`,
        [req.params.id, processorId]);
      if (u.rowCount === 0) return res.status(404).json({ error: 'application not found' });
      await notify.notifyStaff(processorId, {
        type: 'assignment', title: 'File assigned to you for processing', applicationId: req.params.id,
        link: `/internal/app/${req.params.id}` });
      await audit(req, 'assign_processor', 'application', req.params.id, { processorId });
    }
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
  if (seesAll(req)) return true;
  if (!borrowerId) return false;
  const r = await db.query(
    `SELECT 1 FROM applications
      WHERE borrower_id=$1 AND (loan_officer_id=$2 OR processor_id=$2)
        AND deleted_at IS NULL LIMIT 1`,
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
// (A borrower's entities live at GET /borrowers/:id/llcs below — the full
// review bundle; its rows carry id/llc_name/is_verified for the track-record
// tool's linker plus members/slots/completeness for the LLC review panel.)
router.get('/borrowers/:id', async (req, res) => {
  try {
    if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
    const r = await db.query(
      `SELECT id,first_name,last_name,email,cell_phone,date_of_birth,ssn_last4,fico,citizenship,tier FROM borrowers WHERE id=$1`,
      [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    res.json(r.rows[0]);
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
              t.property_type, t.verification_status, t.lo_notes,
              COALESCE(t.entity_name, l.llc_name) AS entity_name, v.full_name AS verified_by_name,
              (SELECT count(*)::int FROM documents d WHERE d.track_record_id=t.id) AS doc_count
         FROM track_records t
         LEFT JOIN llcs l ON l.id = t.llc_id
         LEFT JOIN staff_users v ON v.id = t.verified_by
        WHERE t.borrower_id=$1 ORDER BY t.sale_date DESC NULLS LAST, t.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
// Staff manage the borrower's general track record on their behalf: add,
// edit, remove entries, and attach/read the per-entry supporting documents.
const { trackRecordErrors, trackRecordCols } = require('./borrower');
router.post('/borrowers/:id/track-records', async (req, res) => {
  const b = req.body || {};
  if (!(await canSeeBorrower(req))) return res.status(403).json({ error: 'forbidden' });
  const bad = trackRecordErrors(b);
  if (bad) return res.status(400).json({ error: bad });
  const cols = trackRecordCols(b);
  if (b.llcId) {
    const l = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, req.params.id]);
    if (l.rows[0]) cols.llc_id = b.llcId;
  }
  const names = Object.keys(cols);
  const vals = Object.values(cols);
  const r = await db.query(
    `INSERT INTO track_records (borrower_id,${names.join(',')})
     VALUES ($1,${names.map((_, i) => '$' + (i + 2)).join(',')}) RETURNING id`,
    [req.params.id, ...vals]);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(req.params.id); } catch (_) {}
  await audit(req, 'staff_add_track_record', 'track_record', r.rows[0].id);
  res.status(201).json({ ok: true, trackRecordId: r.rows[0].id });
});
router.put('/track-records/:id', async (req, res) => {
  const b = req.body || {};
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
  res.json({ ok: true });
});
router.delete('/track-records/:id', async (req, res) => {
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`DELETE FROM track_records WHERE id=$1`, [req.params.id]);
  await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true) WHERE id=$1`,
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
    `SELECT id,filename,content_type,size_bytes,uploaded_by_kind,created_at FROM documents
      WHERE track_record_id=$1 ORDER BY created_at`, [req.params.id]);
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
  const r = await db.query(
    `INSERT INTO documents (borrower_id,track_record_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'staff',$8,'track_record_doc') RETURNING id`,
    [tr.rows[0].borrower_id, req.params.id, b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, req.actor.id]);
  await db.query(`UPDATE track_records SET docs_status='received', updated_at=now() WHERE id=$1 AND docs_status IN ('outstanding','requested')`, [req.params.id]);
  await audit(req, 'staff_upload_track_record_doc', 'track_record', req.params.id, { filename: b.filename });
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
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  const status = TR_STATUSES.includes(req.body && req.body.status) ? req.body.status : 'verified';
  const counts = status === 'verified' || status === 'limited';
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
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true) WHERE id=$1`,
    [tr.rows[0].borrower_id]);
  try { await require('../lib/experience').syncExperienceChecklistForBorrower(tr.rows[0].borrower_id); } catch (_) {}
  await audit(req, 'verify_track_record', 'track_record', req.params.id, { status });
  res.json({ ok: true, status });
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
  const gates = await db.query(
    `SELECT id, label FROM checklist_items
      WHERE application_id=$1 AND is_gate=true AND NOT (signed_off_at IS NOT NULL OR status='satisfied')
      ORDER BY sort_order, created_at`, [appId]);
  return { conditions: conds.rows, gates: gates.rows };
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
    requestedExpReo: 'requested_exp_reo', requestedIrMonths: 'requested_ir_months',
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
    const upd = await db.query(`UPDATE applications SET ${sets.join(',')} WHERE id=$${i}`, vals);
    if (upd.rowCount === 0) return res.status(404).json({ error: 'application not found' });
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
    res.json({ ok: true, changed: Object.keys(changes) });
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

router.patch('/applications/:id', async (req, res) => {
  const { status } = req.body || {};
  const force = !!(req.body && req.body.force);
  if (!status || !APP_STATUS.includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const cur = await db.query(
      `SELECT status, borrower_id, loan_officer_id, processor_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (cur.rows[0].status === status) return res.json({ ok: true, unchanged: true, status });
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
    // Record the transition on the file's timeline.
    await db.query(
      `INSERT INTO application_status_history (application_id, from_status, to_status, changed_by, forced)
       VALUES ($1,$2,$3,$4,$5)`, [req.params.id, cur.rows[0].status, status, req.actor.id, forced]);
    // Funding seeds the post-closing trailing-doc checklist.
    if (status === 'funded') { try { await seedPostClosing(req.params.id); } catch (_) {} }
    await audit(req, 'status_change', 'application', req.params.id, { from: cur.rows[0].status, to: status, forced: forced || undefined });
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

// Admin: soft-delete a file (keeps the row + audit trail; it disappears from
// every borrower and staff surface). Restore reverses it. Admin/super_admin only.
router.delete('/applications/:id', async (req, res) => {
  if (!['admin', 'super_admin'].includes(req.actor.role)) return res.status(403).json({ error: 'admin only' });
  try {
    const r = await db.query(`UPDATE applications SET deleted_at=now(), updated_at=now() WHERE id=$1 AND deleted_at IS NULL RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'delete_application', 'application', req.params.id, { reason: (req.body && req.body.reason) || null });
    res.json({ ok: true, deleted: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/restore', async (req, res) => {
  if (!['admin', 'super_admin'].includes(req.actor.role)) return res.status(403).json({ error: 'admin only' });
  try {
    const r = await db.query(`UPDATE applications SET deleted_at=NULL, updated_at=now() WHERE id=$1 RETURNING id`, [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
    await audit(req, 'restore_application', 'application', req.params.id);
    res.json({ ok: true, restored: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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
        WHERE a.deleted_at IS NULL ${scoped ? 'AND (a.loan_officer_id=$1 OR a.processor_id=$1)' : ''}
      ) q
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
  const borrowerId = appOk.rows[0].borrower_id;
  let itemLabel = '';
  if (b.checklistItemId) {
    const it = await db.query(
      `SELECT id, COALESCE(borrower_label,label) AS label FROM checklist_items WHERE id=$1 AND application_id=$2`,
      [b.checklistItemId, req.params.id]);
    if (!it.rows[0]) return res.status(404).json({ error: 'checklist item not found on this file' });
    itemLabel = it.rows[0].label;
  }
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const docKind = b.docKind === 'term_sheet' ? 'term_sheet' : null;
  const slot = b.slot ? String(b.slot).trim().slice(0, 80) : null;
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (application_id,checklist_item_id,borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,
                            uploaded_by_kind,uploaded_by_id,doc_kind,slot_label,visibility)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'staff',$9,$10,$11,'borrower') RETURNING id`,
    [req.params.id, b.checklistItemId || null, b.checklistItemId ? borrowerId : null,
     b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref,
     req.actor.id, docKind, slot]);
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
    // The shared list works both ways — tell the borrower their team added it.
    if (borrowerId) {
      try {
        const ctx = await notify.fileContext(req.params.id);
        await notify.notifyBorrower(borrowerId, {
          type: 'doc_uploaded', title: `Your loan team added a document to "${itemLabel}"`,
          body: `"${b.filename}" was uploaded to condition "${itemLabel}"${slot ? ` (${slot})` : ''}${ctx ? ` on ${ctx.label}` : ''} on your behalf.`,
          meta: (ctx && ctx.meta) || undefined,
          applicationId: req.params.id, link: `/app/${req.params.id}` });
      } catch (_) { /* best-effort */ }
    }
  }
  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename, docKind, checklistItemId: b.checklistItemId || null });
  res.status(201).json({ ok: true, documentId: r.rows[0].id });
});

// Approve or reject an uploaded document. Rejection requires a reason, keeps the
// rejected file in history (never in the clean file), and flips its checklist
// item back to 'issue' so the borrower sees exactly what to fix and re-uploads.
// Acceptance marks the item satisfied. Only accepted+current docs count for the
// file (see getApprovedDocuments / future TPR export).
router.post('/documents/:id/review', async (req, res) => {
  const b = req.body || {};
  const action = b.action;
  if (!['accept', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be accept or reject' });
  // Accepting a document completes its condition — processor/admin only.
  // Anyone on the file may reject (the document lands in the file's trash).
  if (action === 'accept' && !['processor', 'admin', 'super_admin', 'underwriter'].includes(req.actor.role)) {
    return res.status(403).json({ error: 'Only the processor can accept a document — you can reject it or mark the condition reviewed.' });
  }
  if (action === 'reject' && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a rejection reason is required' });
  try {
    const r = await db.query(
      `SELECT id,filename,application_id,borrower_id,llc_id,checklist_item_id FROM documents WHERE id=$1`, [req.params.id]);
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
        await db.query(`UPDATE checklist_items SET status=$2, updated_at=now() WHERE id=$1`,
          [doc.checklist_item_id, action === 'accept' ? 'satisfied' : 'issue']);
      }
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
    // officer on App1 could reach App2 of the same borrower.
    const r = await db.query(
      `SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2)`,
      [doc.application_id, req.actor.id]);
    return !!r.rows[0];
  }
  if (doc.borrower_id) {
    // Only borrower/llc-scoped documents (no application_id) use the
    // borrower-wide fallback.
    const r = await db.query(
      `SELECT 1 FROM applications WHERE borrower_id=$1 AND (loan_officer_id=$2 OR processor_id=$2) LIMIT 1`,
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
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
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
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
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
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
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
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const r = await db.query(`DELETE FROM service_contacts WHERE id=$1 RETURNING id`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'delete_vendor', 'service_contact', req.params.id);
  res.json({ ok: true });
});

// ---------------- chat v3: conversations, receipts, presence ----------------
// Mounted last so the /applications/:id scope guard above still covers the
// application-scoped chat routes (create chat / export).
router.use(require('./staff-chat'));

module.exports = router;
