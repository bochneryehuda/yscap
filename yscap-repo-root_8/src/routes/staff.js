/**
 * Staff API (loan officers, processors, underwriters, admins).
 * Officers see their assigned pipeline; admins see everything. They add
 * conditions + document requests, update checklist status, verify LLCs and
 * track records, and assign Lead-Capture (unassigned) applications.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const C = require('../lib/crypto');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { serveDocument } = require('../lib/serve-document');
const { requireAuth, requireRole } = require('../auth');
const pricing = require('../lib/pricing');

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
  const r = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2)`, [appId, req.actor.id]);
  return !!r.rows[0];
}
const isAdmin = (req) => ['admin', 'super_admin'].includes(req.actor.role);

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
    const r = await db.query(
      `SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2)`,
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
  const r = await db.query(
    `SELECT a.id,a.ys_loan_number,a.program,a.property_address,a.created_at,b.first_name,b.last_name,b.email
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     WHERE a.loan_officer_id IS NULL ORDER BY a.created_at DESC`);
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

    const ins = await db.query(
      `INSERT INTO applications
         (borrower_id,property_address,property_type,units,program,loan_type,
          purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
          processor_id,source,status,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'staff','new',now())
       RETURNING id,ys_loan_number`,
      [borrowerId, JSON.stringify(addr), b.propertyType || null, b.units || null,
       b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
       b.arv || null, b.rehabBudget || null, officerId, officerName, processorId]);
    const appId = ins.rows[0].id;

    try { await require('./borrower').generateChecklist(appId, borrowerId, b.program, b.loanType); }
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
    `SELECT a.*, b.first_name,b.last_name,b.email,b.cell_phone,b.fico, l.llc_name AS entity_name
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id
     LEFT JOIN llcs l ON l.id=a.llc_id WHERE a.id=$1`, [req.params.id]);
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

// Admin-only pricing overrides: setting the qualifying basis/rate directly,
// forcing a price past ineligibility, OR setting the experience counts all
// bypass the frozen-engine guardrails, so only admins/super-admins may supply
// them. Experience is included because the tier it drives moves the exact same
// caps/rate/eligibility that ovrLTC/ovrRate do — and it must stay verified-only
// for non-admins (a loan officer/processor can what-if the deal economics, but
// not inject unverified experience or override the caps/rate). For anyone else
// these keys are stripped. Returns { overrides, strippedAdminKeys }.
const ADMIN_OVERRIDE_KEYS = ['ovrRate', 'ovrLTC', 'ovrAcqLTV', 'ovrARLTV', 'forcePrice',
  'expFlips', 'expHolds', 'expGround'];
function sanitizeOverrides(req, raw) {
  const o = { ...(raw || {}) };
  let stripped = false;
  if (!isAdmin(req)) for (const k of ADMIN_OVERRIDE_KEYS) if (k in o) { delete o[k]; stripped = true; }
  return { overrides: o, strippedAdminKeys: stripped };
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
              r.is_current, r.created_at, r.quote, s.full_name AS registered_by_name
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

    const client = await db.getClient();
    let regId;
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE product_registrations SET is_current=false WHERE application_id=$1 AND is_current`, [appId]);
      const ins = await client.query(
        `INSERT INTO product_registrations
           (application_id, program, product_label, status, note_rate, total_loan, target_ltc, inputs, quote, is_current, registered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,true,$10) RETURNING id`,
        [appId, program, quote.productLabel || null, quote.status, quote.noteRate, total,
         inputs.targetLTC || null, JSON.stringify(inputs), JSON.stringify(quote), req.actor.id]);
      regId = ins.rows[0].id;
      // The registered product IS the file's terms now.
      await client.query(
        `UPDATE applications SET loan_amount=$2, rate_pct=$3, updated_at=now() WHERE id=$1`,
        [appId, total, quote.noteRate != null ? (quote.noteRate * 100) : null]);
      await client.query('COMMIT');
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }

    await audit(req, 'register_product', 'application', appId,
      { program, status: quote.status, noteRate: quote.noteRate, totalLoan: total, productLabel: quote.productLabel || null });

    // Notify the assigned team (LO + processor), not the borrower.
    try {
      const t = await db.query(`SELECT loan_officer_id, processor_id, ys_loan_number FROM applications WHERE id=$1`, [appId]);
      const row = t.rows[0] || {};
      const pctRate = quote.noteRate != null ? (quote.noteRate * 100).toFixed(2) + '%' : '—';
      const dollars = '$' + Math.round(total).toLocaleString('en-US');
      const body = `${pricing.PROGRAM_LABEL[program]} · ${dollars} @ ${pctRate}${quote.status !== 'ELIGIBLE' ? ' (' + quote.status.toLowerCase() + ')' : ''}`;
      for (const sid of [row.loan_officer_id, row.processor_id]) {
        if (sid && sid !== req.actor.id) await notify.notifyStaff(sid, {
          type: 'product_registered', title: 'Product registered on ' + (row.ys_loan_number || 'a file'),
          body, applicationId: appId });
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

router.get('/applications/:id/checklist', async (req, res) => {
  const r = await db.query(
    `SELECT ci.id, ci.label, ci.status, ci.audience, ci.item_kind, ci.is_required,
            ci.phase, ci.role_scope, ci.hint, ci.is_gate, ci.is_milestone, ci.sort_order,
            ci.due_date, ci.notes, ci.created_by_kind, ci.created_at,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            ci.assignee_staff_id, asg.full_name AS assignee_name,
            ci.signed_off_by, so.full_name AS signed_off_name, ci.signed_off_at
       FROM checklist_items ci
       LEFT JOIN staff_users asg ON asg.id = ci.assignee_staff_id
       LEFT JOIN staff_users so  ON so.id  = ci.signed_off_by
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
  if (app.rows[0]) await notify.notifyBorrower(app.rows[0].borrower_id, {
    type: 'condition_added', title: 'New document requested', body: b.label, applicationId: req.params.id });
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
      `SELECT count(*)::int c FROM documents WHERE application_id=$1 AND review_status='accepted' AND is_current=true AND source_type<>'chat_attachment'`, [req.params.id])).rows[0].c;
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
          await notify.notifyBorrower(a.rows[0].borrower_id, {
            type: 'condition_added', title: 'A new item needs your attention',
            body: b.borrowerTitle || b.title, applicationId: req.params.id,
            link: `/app/${req.params.id}`, ctaLabel: 'See what we need' });
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
  // access guard: non-privileged staff may only edit items on their own files
  if (!seesAll(req)) {
    const own = await db.query(
      `SELECT 1 FROM checklist_items ci JOIN applications a ON a.id=ci.application_id
        WHERE ci.id=$1 AND (a.loan_officer_id=$2 OR a.processor_id=$2)`,
      [req.params.itemId, req.actor.id]);
    if (!own.rows[0]) return res.status(403).json({ error: 'forbidden' });
  }
  const b = req.body || {};
  const allowed = ['outstanding', 'requested', 'received', 'satisfied', 'issue'];
  if (b.status && !allowed.includes(b.status)) return res.status(400).json({ error: 'bad status' });

  const sets = ['updated_at=now()'];
  const params = [req.params.itemId];
  const add = (frag, val) => { params.push(val); sets.push(frag.replace('?', '$' + params.length)); };

  if (b.status) add('status=?', b.status);
  if (b.notes != null) add('notes=?', b.notes);
  if ('assigneeStaffId' in b) add('assignee_staff_id=?', b.assigneeStaffId || null);

  // Sign-off marks the item satisfied and stamps who/when; un-sign clears it.
  if (b.signedOff === true) {
    add('signed_off_by=?', req.actor.id);
    sets.push("signed_off_at=now()", "status='satisfied'");
  } else if (b.signedOff === false) {
    sets.push('signed_off_by=NULL', 'signed_off_at=NULL');
  }

  await db.query(`UPDATE checklist_items SET ${sets.join(', ')} WHERE id=$1`, params);
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
      await db.query(`UPDATE applications SET loan_officer_id=$2, loan_officer_name=$3, updated_at=now() WHERE id=$1`,
        [req.params.id, loanOfficerId, off.rows[0].full_name]);
      await notify.notifyStaff(loanOfficerId, {
        type: 'assignment', title: 'Application assigned to you', applicationId: req.params.id,
        link: `/staff/app/${req.params.id}` });
      await audit(req, 'assign_application', 'application', req.params.id, { loanOfficerId });
    }
    if (processorId) {
      const p = await db.query(`SELECT full_name FROM staff_users WHERE id=$1 AND is_active=true AND role='processor'`, [processorId]);
      if (!p.rows[0]) return res.status(404).json({ error: 'processor not found' });
      await db.query(`UPDATE applications SET processor_id=$2, updated_at=now() WHERE id=$1`,
        [req.params.id, processorId]);
      await notify.notifyStaff(processorId, {
        type: 'assignment', title: 'File assigned to you for processing', applicationId: req.params.id,
        link: `/staff/app/${req.params.id}` });
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
      WHERE borrower_id=$1 AND (loan_officer_id=$2 OR processor_id=$2) LIMIT 1`,
    [borrowerId, req.actor.id]);
  return !!r.rows[0];
}
async function canSeeBorrower(req) { return canSeeBorrowerId(req, req.params.id); }
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
              t.purchase_date, t.sale_date, t.is_verified, t.verified_at, t.docs_status,
              l.llc_name AS entity_name, v.full_name AS verified_by_name
         FROM track_records t
         LEFT JOIN llcs l ON l.id = t.llc_id
         LEFT JOIN staff_users v ON v.id = t.verified_by
        WHERE t.borrower_id=$1 ORDER BY t.sale_date DESC NULLS LAST, t.created_at DESC`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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

// ---------------- verify LLC / track record ----------------
router.post('/llcs/:id/verify', async (req, res) => {
  const own = await db.query(`SELECT borrower_id FROM llcs WHERE id=$1`, [req.params.id]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, own.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`UPDATE llcs SET is_verified=true, verified_at=now(), verified_by=$2 WHERE id=$1`, [req.params.id, req.actor.id]);
  await audit(req, 'verify_llc', 'llc', req.params.id);
  res.json({ ok: true });
});
router.post('/track-records/:id/verify', async (req, res) => {
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (!tr.rows[0]) return res.status(404).json({ error: 'not found' });
  if (!(await canSeeBorrowerId(req, tr.rows[0].borrower_id))) return res.status(403).json({ error: 'forbidden' });
  await db.query(`UPDATE track_records SET is_verified=true, verified_at=now(), verified_by=$2 WHERE id=$1`, [req.params.id, req.actor.id]);
  // recompute borrower tier = count of verified track records
  await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true) WHERE id=$1`,
    [tr.rows[0].borrower_id]);
  await audit(req, 'verify_track_record', 'track_record', req.params.id);
  res.json({ ok: true });
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
      if (cur.rows[0].borrower_id)
        await notify.notifyBorrower(cur.rows[0].borrower_id, {
          type: 'status_change', title: `Your loan status: ${label}`,
          body: `Your application has moved to "${label}". Sign in to see the latest.`,
          applicationId: req.params.id, link: `/app/${req.params.id}`, ctaLabel: 'View your file' });
      const team = new Set([cur.rows[0].loan_officer_id, cur.rows[0].processor_id].filter(Boolean).filter(x => x !== req.actor.id));
      for (const sid of team)
        await notify.notifyStaff(sid, {
          type: 'status_change', title: `File moved to ${label}`,
          applicationId: req.params.id, link: `/staff/app/${req.params.id}` });
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
              (SELECT count(*)::int FROM messages m WHERE m.application_id=a.id
                 AND m.channel='borrower' AND m.sender_kind='borrower' AND m.read_at IS NULL) AS unread_borrower,
              (SELECT count(*)::int FROM messages m WHERE m.application_id=a.id
                 AND m.channel='internal' AND m.read_at IS NULL
                 AND (m.sender_id IS NULL OR m.sender_id<>$1)) AS unread_internal
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
    const m = await db.query(`SELECT application_id FROM messages WHERE id=$1`, [req.params.mid]);
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
    await db.query(`UPDATE messages SET body=$2, edited_at=now() WHERE id=$1`, [req.params.mid, body.slice(0, 4000)]);
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
    await db.query(`UPDATE messages SET deleted_at=now(), body='[message removed]', pinned=false WHERE id=$1`, [req.params.mid]);
    await db.query(`DELETE FROM message_reactions WHERE message_id=$1`, [req.params.mid]);
    await audit(req, 'delete_message', 'application', row.application_id, { messageId: req.params.mid });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});

// ---------------- collaboration messaging (per file, two channels) ----------------
// channel 'borrower' = borrower <-> loan team; channel 'internal' = LO <->
// processor <-> underwriter <-> admin, never visible to the borrower.
// Guarded by the /applications/:id middleware (staffer must see this file).
router.get('/applications/:id/messages', async (req, res) => {
  const channel = req.query.channel === 'internal' ? 'internal' : 'borrower';
  try {
    const r = await db.query(
      `SELECT m.id, m.sender_kind, m.sender_id, m.body, m.channel, m.checklist_item_id,
              m.is_task_request, m.read_at, m.created_at, m.pinned, m.edited_at, m.deleted_at,
              m.attachment_document_id, m.attachment_kind, m.entity_refs,
              d.filename AS attachment_name, d.content_type AS attachment_type, d.size_bytes AS attachment_size,
              COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'kind', r.actor_kind, 'actor', r.actor_id))
                          FROM message_reactions r WHERE r.message_id=m.id), '[]'::json) AS reactions,
              CASE WHEN m.sender_kind='staff' THEN s.full_name
                   WHEN m.sender_kind='borrower' THEN (b.first_name || ' ' || b.last_name)
                   ELSE 'System' END AS sender_name,
              ci.label AS task_label, ci.status AS task_status
         FROM messages m
         LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
         LEFT JOIN borrowers  b ON b.id=m.borrower_id
         LEFT JOIN checklist_items ci ON ci.id=m.checklist_item_id
         LEFT JOIN documents d ON d.id=m.attachment_document_id
        WHERE m.application_id=$1 AND m.channel=$2 ORDER BY m.created_at`, [req.params.id, channel]);
    // Opening a channel marks the other side's messages as read (receipts).
    if (channel === 'borrower')
      await db.query(`UPDATE messages SET read_at=now() WHERE application_id=$1 AND channel='borrower' AND sender_kind='borrower' AND read_at IS NULL`, [req.params.id]);
    else
      await db.query(`UPDATE messages SET read_at=now() WHERE application_id=$1 AND channel='internal' AND sender_id<>$2 AND read_at IS NULL`, [req.params.id, req.actor.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/messages', async (req, res) => {
  const b = req.body || {};
  const body = b.body;
  const channel = b.channel === 'internal' ? 'internal' : 'borrower';
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!body || !String(body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  try {
    const appRow = await db.query(
      `SELECT borrower_id, loan_officer_id, processor_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!appRow.rows[0]) return res.status(404).json({ error: 'not found' });
    const a = appRow.rows[0];

    // Store any attachment (photo, video, voice note, PDF, file) first.
    let attDoc = null;
    if (att) {
      try {
        attDoc = await require('../lib/chat-attach').saveChatAttachment({
          applicationId: req.params.id, borrowerId: a.borrower_id,
          filename: att.filename, contentType: att.contentType, dataBase64: att.dataBase64,
          byKind: 'staff', byId: req.actor.id, channel });
      } catch (e2) { return res.status(e2.status || 500).json({ error: e2.message }); }
    }

    // Optionally promote the message into a real task on the application
    // (staff-audience checklist item), so decisions in chat become work items.
    let taskId = null;
    if (b.makeTask && channel === 'internal') {
      const t = await db.query(
        `INSERT INTO checklist_items
           (application_id, scope, audience, item_kind, label, status, created_by_kind, created_by_id, assignee_staff_id)
         VALUES ($1,'application','staff','task',$2,'outstanding','staff',$3,$4) RETURNING id`,
        [req.params.id, String(b.taskLabel || body).slice(0, 300), req.actor.id, b.assigneeStaffId || null]);
      taskId = t.rows[0].id;
    }

    // Structured entity mentions (#task / #document / #application chips).
    const refs = Array.isArray(b.entityRefs)
      ? b.entityRefs.slice(0, 20).map(r => ({
          type: ['task','document','application','borrower'].includes(r.type) ? r.type : 'task',
          id: String(r.id || '').slice(0, 60), label: String(r.label || '').slice(0, 160) }))
        .filter(r => r.id && r.label)
      : null;
    const ins = await db.query(
      `INSERT INTO messages (application_id,borrower_id,sender_kind,sender_id,body,channel,checklist_item_id,attachment_document_id,attachment_kind,entity_refs)
       VALUES ($1,$2,'staff',$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [req.params.id, a.borrower_id, req.actor.id, String(body || '').slice(0, 4000), channel, taskId,
       attDoc ? attDoc.documentId : null, attDoc ? attDoc.kind : null,
       refs && refs.length ? JSON.stringify(refs) : null]);
    // Link the stored attachment back to its message (visibility was already
    // set from the channel at save time — this is just the back-reference).
    if (attDoc) await db.query(`UPDATE documents SET message_id=$1 WHERE id=$2`, [ins.rows[0].id, attDoc.documentId]);
    await audit(req, 'post_message', 'application', req.params.id, { channel, taskId, attachment: !!attDoc });

    try {
      if (channel === 'borrower' && a.borrower_id) {
        await notify.notifyBorrower(a.borrower_id, {
          type: 'message', title: 'New message from your loan team',
          body: String(body).slice(0, 140), applicationId: req.params.id,
          link: `/app/${req.params.id}`, ctaLabel: 'Open the conversation' });
      } else if (channel === 'internal') {
        // Notify the rest of the file's team (assigned LO/processor + a task
        // assignee if any) — never the borrower, never the sender.
        const team = new Set([a.loan_officer_id, a.processor_id, b.assigneeStaffId].filter(Boolean));
        team.delete(req.actor.id);
        for (const sid of team)
          await notify.notifyStaff(sid, {
            type: 'message', title: taskId ? 'New task from team chat' : 'New internal note on a file',
            body: String(body).slice(0, 140), applicationId: req.params.id,
            link: `/staff/app/${req.params.id}`, ctaLabel: 'Open the file' });
      }
      // @mentions get a direct ping regardless of channel/assignment.
      if (body) {
        const meRow = await db.query(`SELECT full_name FROM staff_users WHERE id=$1`, [req.actor.id]);
        await require('../lib/mentions').notifyMentions({
          body, applicationId: req.params.id, senderId: req.actor.id,
          senderName: meRow.rows[0]?.full_name || 'A teammate' });
      }
    } catch (_) {}
    res.status(201).json({ ok: true, messageId: ins.rows[0].id, taskId });
  } catch (e) { res.status(500).json({ error: 'server error' }); }
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
  const r = await db.query(
    `SELECT d.id,d.filename,d.content_type,d.size_bytes,d.checklist_item_id,d.uploaded_by_kind,d.created_at,
            d.review_status,d.rejection_reason,d.reviewed_at,d.is_current,d.replaces_document_id,
            d.source_type,d.visibility,
            s.full_name AS reviewed_by_name, ci.label AS item_label
       FROM documents d
       LEFT JOIN staff_users s ON s.id=d.reviewed_by
       LEFT JOIN checklist_items ci ON ci.id=d.checklist_item_id
      WHERE d.application_id=$1 AND d.source_type <> 'chat_attachment'
      ORDER BY d.is_current DESC, d.created_at DESC`, [req.params.id]);
  res.json(r.rows);
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
  if (action === 'reject' && !String(b.reason || '').trim()) return res.status(400).json({ error: 'a rejection reason is required' });
  try {
    const r = await db.query(
      `SELECT id,filename,application_id,borrower_id,checklist_item_id FROM documents WHERE id=$1`, [req.params.id]);
    const doc = r.rows[0];
    if (!doc) return res.status(404).json({ error: 'not found' });
    if (!(await canSeeDocument(req, doc))) return res.status(403).json({ error: 'forbidden' });

    const status = action === 'accept' ? 'accepted' : 'rejected';
    await db.query(
      `UPDATE documents SET review_status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1`,
      [doc.id, status, action === 'reject' ? String(b.reason).slice(0, 1000) : null, req.actor.id]);

    // Move the linked checklist item: accept -> satisfied, reject -> issue.
    if (doc.checklist_item_id) {
      await db.query(`UPDATE checklist_items SET status=$2, updated_at=now() WHERE id=$1`,
        [doc.checklist_item_id, action === 'accept' ? 'satisfied' : 'issue']);
    }
    await audit(req, action === 'accept' ? 'accept_document' : 'reject_document', 'document', doc.id,
      action === 'reject' ? { reason: b.reason } : null);

    // On rejection, tell the borrower what to fix.
    if (action === 'reject' && doc.borrower_id) {
      try {
        await notify.notifyBorrower(doc.borrower_id, {
          type: 'doc_rejected', title: 'A document needs to be re-uploaded',
          body: `"${doc.filename}" couldn't be accepted: ${String(b.reason).slice(0, 180)}`,
          applicationId: doc.application_id, link: `/app/${doc.application_id}`,
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
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,storage_provider,storage_ref,checklist_item_id,doc_kind,created_at
       FROM documents
      WHERE application_id=$1 AND review_status='accepted' AND is_current=true
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

module.exports = router;
