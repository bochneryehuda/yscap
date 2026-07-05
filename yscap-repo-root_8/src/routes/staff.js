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
                      a.loan_amount,a.loan_officer_id,a.loan_officer_name,a.created_at,
                      b.first_name,b.last_name,b.email
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

// ---------------- secure messaging (borrower <-> staff, per file) ----------------
// Guarded by the /applications/:id middleware (staffer must see this file).
router.get('/applications/:id/messages', async (req, res) => {
  try {
    const r = await db.query(
      `SELECT m.id, m.sender_kind, m.sender_id, m.body, m.is_task_request, m.read_at, m.created_at,
              CASE WHEN m.sender_kind='staff' THEN s.full_name
                   WHEN m.sender_kind='borrower' THEN (b.first_name || ' ' || b.last_name)
                   ELSE 'System' END AS sender_name
         FROM messages m
         LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
         LEFT JOIN borrowers  b ON b.id=m.borrower_id
        WHERE m.application_id=$1 ORDER BY m.created_at`, [req.params.id]);
    // Mark borrower messages as read now that staff has opened the thread.
    await db.query(`UPDATE messages SET read_at=now() WHERE application_id=$1 AND sender_kind='borrower' AND read_at IS NULL`, [req.params.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.post('/applications/:id/messages', async (req, res) => {
  const body = (req.body || {}).body;
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'message body required' });
  try {
    const appRow = await db.query(`SELECT borrower_id FROM applications WHERE id=$1`, [req.params.id]);
    if (!appRow.rows[0]) return res.status(404).json({ error: 'not found' });
    const ins = await db.query(
      `INSERT INTO messages (application_id,borrower_id,sender_kind,sender_id,body)
       VALUES ($1,$2,'staff',$3,$4) RETURNING id`,
      [req.params.id, appRow.rows[0].borrower_id, req.actor.id, String(body).slice(0, 4000)]);
    await audit(req, 'post_message', 'application', req.params.id);
    // Notify the borrower a message is waiting.
    try {
      if (appRow.rows[0].borrower_id)
        await notify.notifyBorrower(appRow.rows[0].borrower_id, {
          type: 'message', title: 'New message from your loan team',
          body: String(body).slice(0, 140), applicationId: req.params.id,
          link: `/app/${req.params.id}`, ctaLabel: 'Open the conversation' });
    } catch (_) {}
    res.status(201).json({ ok: true, messageId: ins.rows[0].id });
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
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,checklist_item_id,uploaded_by_kind,created_at
       FROM documents WHERE application_id=$1 ORDER BY created_at DESC`, [req.params.id]);
  res.json(r.rows);
});

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
