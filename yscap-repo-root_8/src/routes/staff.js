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

router.use(requireAuth, requireRole('admin', 'loan_officer', 'processor', 'underwriter'));
// admins + super-admins + underwriters (risk) see every file;
// loan officers and processors see only files they are assigned to.
const seesAll = (req) => ['admin', 'super_admin', 'underwriter'].includes(req.actor.role);
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
               WHERE 1=1 ${s.where.replace(/\$SCOPE/g, '$1')} ORDER BY a.created_at DESC`;
  const r = await db.query(sql, s.params);
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
    `SELECT a.*, b.first_name,b.last_name,b.email,b.cell_phone,b.fico
     FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
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
async function canSeeBorrower(req) {
  if (seesAll(req)) return true;
  const r = await db.query(
    `SELECT 1 FROM applications
      WHERE borrower_id=$1 AND (loan_officer_id=$2 OR processor_id=$2) LIMIT 1`,
    [req.params.id, req.actor.id]);
  return !!r.rows[0];
}
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
  await db.query(`UPDATE llcs SET is_verified=true, verified_at=now(), verified_by=$2 WHERE id=$1`, [req.params.id, req.actor.id]);
  await audit(req, 'verify_llc', 'llc', req.params.id);
  res.json({ ok: true });
});
router.post('/track-records/:id/verify', async (req, res) => {
  await db.query(`UPDATE track_records SET is_verified=true, verified_at=now(), verified_by=$2 WHERE id=$1`, [req.params.id, req.actor.id]);
  // recompute borrower tier = count of verified track records
  const tr = await db.query(`SELECT borrower_id FROM track_records WHERE id=$1`, [req.params.id]);
  if (tr.rows[0]) await db.query(
    `UPDATE borrowers SET tier=(SELECT count(*) FROM track_records WHERE borrower_id=$1 AND is_verified=true) WHERE id=$1`,
    [tr.rows[0].borrower_id]);
  await audit(req, 'verify_track_record', 'track_record', req.params.id);
  res.json({ ok: true });
});

// ---------------- advance application status ----------------
const APP_STATUS = ['new', 'in_review', 'processing', 'underwriting', 'approved', 'clear_to_close', 'funded', 'declined', 'withdrawn'];
const STATUS_LABEL = { new: 'Submitted', in_review: 'In review', processing: 'Processing', underwriting: 'Underwriting', approved: 'Approved', clear_to_close: 'Clear to close', funded: 'Funded', declined: 'Declined', withdrawn: 'Withdrawn' };
router.patch('/applications/:id', async (req, res) => {
  const { status } = req.body || {};
  if (!status || !APP_STATUS.includes(status)) return res.status(400).json({ error: 'bad status' });
  try {
    const cur = await db.query(
      `SELECT status, borrower_id, loan_officer_id, processor_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!cur.rows[0]) return res.status(404).json({ error: 'not found' });
    if (cur.rows[0].status === status) return res.json({ ok: true, unchanged: true, status });
    await db.query(`UPDATE applications SET status=$2, status_changed_at=now(), updated_at=now() WHERE id=$1`,
      [req.params.id, status]);
    await audit(req, 'status_change', 'application', req.params.id, { from: cur.rows[0].status, to: status });
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
        WHERE 1=1 ${scoped ? 'AND (a.loan_officer_id=$1 OR a.processor_id=$1)' : ''}
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

// ---------------- collaboration messaging (per file, two channels) ----------------
// channel 'borrower' = borrower <-> loan team; channel 'internal' = LO <->
// processor <-> underwriter <-> admin, never visible to the borrower.
// Guarded by the /applications/:id middleware (staffer must see this file).
router.get('/applications/:id/messages', async (req, res) => {
  const channel = req.query.channel === 'internal' ? 'internal' : 'borrower';
  try {
    const r = await db.query(
      `SELECT m.id, m.sender_kind, m.sender_id, m.body, m.channel, m.checklist_item_id,
              m.is_task_request, m.read_at, m.created_at,
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
    const r = await db.query(
      `SELECT 1 FROM applications WHERE id=$1 AND (loan_officer_id=$2 OR processor_id=$2)`,
      [doc.application_id, req.actor.id]);
    if (r.rows[0]) return true;
  }
  if (doc.borrower_id) {
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
