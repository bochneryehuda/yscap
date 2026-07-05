/**
 * Borrower-facing API (all endpoints require a borrower token; everything is
 * scoped to req.actor.id so a borrower can only ever see their own data).
 *   Profile · Applications (many, per-address) · LLCs+docs · Track records
 *   · Checklists (borrower-visible) · Documents · Notifications · Messages
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const cfg = require('../config');
const C = require('../lib/crypto');
const storage = require('../lib/storage');
const { requireAuth, requireBorrower } = require('../auth');
const notify = require('../lib/notify');
const mail = require('../lib/email/catalog');
const { redactPII } = require('../lib/redact');
const { serveDocument } = require('../lib/serve-document');

router.use(requireAuth, requireBorrower);
const me = (req) => req.actor.id;
async function audit(req, action, entity_type, entity_id, detail) {
  await db.query(
    `INSERT INTO audit_log (actor_kind,actor_id,action,entity_type,entity_id,ip_address,user_agent,detail)
     VALUES ('borrower',$1,$2,$3,$4,$5,$6,$7)`,
    [me(req), action, entity_type, entity_id || null, req.ip, req.get('user-agent') || null, detail || null]);
}

// ---------------- PROFILE (canonical PII, shared across applications) ----------------
router.get('/profile', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,cell_phone,date_of_birth,ssn_last4,fico,
            current_address,years_at_residence,prior_address,citizenship,marital_status,
            dependents_count,employment_type,employer,contact_type,tier
     FROM borrowers WHERE id=$1`, [me(req)]);
  res.json(r.rows[0] || {});
});

router.put('/profile', async (req, res) => {
  const b = req.body || {};
  // Only columns actually present in the request are updated. Using `|| null`
  // here would turn every ABSENT field into an explicit NULL and wipe stored
  // PII on every partial save — so keep absent fields `undefined` and skip them.
  const fields = {
    first_name: b.firstName, last_name: b.lastName, cell_phone: b.cellPhone,
    date_of_birth: b.dateOfBirth, fico: b.fico,
    current_address: b.currentAddress !== undefined ? JSON.stringify(b.currentAddress) : undefined,
    years_at_residence: b.yearsAtResidence,
    prior_address: b.priorAddress !== undefined ? JSON.stringify(b.priorAddress) : undefined,
    citizenship: b.citizenship, marital_status: b.maritalStatus,
    dependents_count: b.dependentsCount,
    employment_type: b.employmentType, employer: b.employer,
  };
  const sets = [], vals = []; let i = 1;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) { sets.push(`${k}=$${i++}`); vals.push(v); }
  if (b.ssn) { sets.push(`ssn_encrypted=$${i++}`); vals.push(C.encryptSSN(b.ssn)); sets.push(`ssn_last4=$${i++}`); vals.push(String(b.ssn).replace(/\D/g, '').slice(-4)); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(me(req));
  await db.query(`UPDATE borrowers SET ${sets.join(',')} WHERE id=$${i}`, vals);
  await audit(req, 'update_profile', 'borrower', me(req));
  res.json({ ok: true });
});

// ---------------- APPLICATIONS (one borrower : many; each a distinct address) ----------------
router.get('/applications', async (req, res) => {
  const r = await db.query(
    `SELECT id,ys_loan_number,program,loan_type,status,property_address,loan_amount,
            loan_officer_name,submitted_at,created_at
     FROM applications WHERE borrower_id=$1 OR co_borrower_id=$1 ORDER BY created_at DESC`, [me(req)]);
  res.json(r.rows);
});

router.post('/applications', async (req, res) => {
  const b = req.body || {};
  if (!b.propertyAddress) return res.status(400).json({ error: 'propertyAddress required' });
  const r = await db.query(
    `INSERT INTO applications
       (borrower_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_name,source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'portal',$12,'new',now()) RETURNING id,ys_loan_number`,
    [me(req), JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, b.loanOfficerName || null, JSON.stringify(redactPII(b))]);
  const appId = r.rows[0].id;
  await generateChecklist(appId, me(req), b.program, b.loanType);
  await audit(req, 'create_application', 'application', appId);
  res.status(201).json({ ok: true, applicationId: appId });
});

router.get('/applications/:id', async (req, res) => {
  const r = await db.query(`SELECT * FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// ---------------- CHECKLIST (borrower-visible items only) ----------------
router.get('/applications/:id/checklist', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT id,label,status,item_kind,phase,hint,is_required,due_date,notes,
            tool_key, (tool_payload IS NOT NULL) AS tool_submitted
       FROM checklist_items
      WHERE application_id=$1 AND audience IN ('borrower','both')
      ORDER BY sort_order, created_at`, [req.params.id]);
  res.json(r.rows);
});

// Borrower completes a tool-backed task (Rehab Budget / Track Record) inside the
// portal. Stores the exported payload and moves the item to 'received' so staff
// can verify and sign off. The borrower is doing "their part" of the file here.
router.post('/applications/:id/checklist/:itemId/tool', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const it = await db.query(
    `SELECT id,tool_key FROM checklist_items
      WHERE id=$1 AND application_id=$2 AND audience IN ('borrower','both') AND tool_key IS NOT NULL`,
    [req.params.itemId, req.params.id]);
  if (!it.rows[0]) return res.status(404).json({ error: 'tool task not found' });
  const payload = (req.body && typeof req.body.payload === 'object') ? req.body.payload : { submitted: true };
  const notes = (req.body && req.body.notes) ? String(req.body.notes).slice(0, 2000) : null;
  await db.query(
    `UPDATE checklist_items SET tool_payload=$2, status='received', notes=COALESCE($3,notes), updated_at=now()
      WHERE id=$1`, [req.params.itemId, JSON.stringify(payload), notes]);
  res.json({ ok: true, status: 'received' });
});

// ---------------- LLCs + documents ----------------
router.get('/llcs', async (req, res) => {
  const r = await db.query(
    `SELECT l.*, (SELECT count(*) FROM documents d WHERE d.llc_id=l.id) AS doc_count
     FROM llcs l WHERE borrower_id=$1 ORDER BY created_at`, [me(req)]);
  res.json(r.rows);
});
router.post('/llcs', async (req, res) => {
  const b = req.body || {};
  if (!b.llcName) return res.status(400).json({ error: 'llcName required' });
  const r = await db.query(
    `INSERT INTO llcs (borrower_id,llc_name,ein,formation_state,formation_date,ownership_pct)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [me(req), b.llcName, b.ein || null, b.formationState || null, b.formationDate || null, b.ownershipPct || null]);
  // Requesting an LLC pulls its document requirements: EIN letter, formation docs, operating agreement.
  try { await generateLlcChecklist(r.rows[0].id); } catch (_) {}
  res.status(201).json({ ok: true, llcId: r.rows[0].id });
});
router.get('/llcs/:id/documents', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(`SELECT id,filename,content_type,size_bytes,created_at FROM documents WHERE llc_id=$1 ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});

// ---------------- TRACK RECORDS (on the borrower profile) ----------------
router.get('/track-records', async (req, res) => {
  const r = await db.query(`SELECT * FROM track_records WHERE borrower_id=$1 ORDER BY sale_date DESC NULLS LAST, created_at DESC`, [me(req)]);
  res.json(r.rows);
});
router.post('/track-records', async (req, res) => {
  const b = req.body || {};
  // An LLC reference must be one of the borrower's own entities.
  if (b.llcId) {
    const own = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!own.rows[0]) return res.status(404).json({ error: 'llc not found' });
  }
  const r = await db.query(
    `INSERT INTO track_records (borrower_id,llc_id,property_address,deal_type,purchase_price,sale_price,rehab_amount,purchase_date,sale_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [me(req), b.llcId || null, b.propertyAddress ? JSON.stringify(b.propertyAddress) : null, b.dealType || null,
     b.purchasePrice || null, b.salePrice || null, b.rehabAmount || null, b.purchaseDate || null, b.saleDate || null]);
  res.status(201).json({ ok: true, trackRecordId: r.rows[0].id });
});

// ---------------- DOCUMENTS (upload metadata + bytes via storage) ----------------
// Accepts base64 body {filename, contentType, dataBase64, applicationId|llcId, checklistItemId}
router.post('/documents', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  // ownership check for whichever owner is supplied
  if (b.applicationId) {
    const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [b.applicationId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'application not found' });
  }
  if (b.llcId) {
    const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'llc not found' });
  }
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  const { ref, provider } = await storage.save(buf, { filename: b.filename });
  const r = await db.query(
    `INSERT INTO documents (checklist_item_id,application_id,borrower_id,llc_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'borrower',$10) RETURNING id`,
    [b.checklistItemId || null, b.applicationId || null, me(req), b.llcId || null,
     b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref, me(req)]);
  if (b.checklistItemId)
    await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1 AND (application_id IN (SELECT id FROM applications WHERE borrower_id=$2) OR borrower_id=$2 OR llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`, [b.checklistItemId, me(req)]);
  await audit(req, 'upload_document', 'document', r.rows[0].id, { filename: b.filename });
  res.status(201).json({ ok: true, documentId: r.rows[0].id });

  // Notify the file's loan officer + processor that a document arrived
  // (best-effort, after the response — never blocks the upload).
  if (b.applicationId) {
    try {
      const a = await db.query(
        `SELECT a.loan_officer_id, a.processor_id, b.first_name, b.last_name
           FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [b.applicationId]);
      const row = a.rows[0];
      if (row) {
        const who = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A borrower';
        const opts = {
          type: 'doc_uploaded',
          title: 'New document uploaded',
          body: `${who} uploaded "${b.filename}".`,
          applicationId: b.applicationId,
          link: `/staff/app/${b.applicationId}`,
          ctaLabel: 'Review the document',
        };
        const targets = new Set([row.loan_officer_id, row.processor_id].filter(Boolean));
        for (const sid of targets) await notify.notifyStaff(sid, opts);
      }
    } catch (_) { /* never fail the upload on a notify hiccup */ }
  }
});

// List the borrower's own documents (optionally scoped to one application).
router.get('/documents', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,application_id,llc_id,checklist_item_id,created_at
       FROM documents
      WHERE borrower_id=$1 AND ($2::uuid IS NULL OR application_id=$2)
      ORDER BY created_at DESC`,
    [me(req), req.query.applicationId || null]);
  res.json(r.rows);
});

// Download a document the borrower may see: their own uploads, plus anything
// (e.g. chat attachments from staff or a co-borrower) on an application they
// are the borrower or co-borrower on.
router.get('/documents/:id/download', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,storage_ref FROM documents
      WHERE id=$1 AND (borrower_id=$2 OR application_id IN
        (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2))`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  await audit(req, 'download_document', 'document', r.rows[0].id);
  return serveDocument(res, r.rows[0], { inline: req.query.inline === '1' });
});

// ---------------- bank verification (Plaid framework) ----------------
// Manual bank-statement upload always works via the documents flow above; these
// enable instant verification once Plaid keys are added.
router.post('/plaid/link-token', async (req, res) => {
  const plaid = require('../lib/integrations').plaid;
  if (!plaid.configured()) return res.status(503).json({ error: 'Instant bank verification is not enabled yet — please upload statements instead.' });
  try { res.json(await plaid.createLinkToken({ userId: me(req) })); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
router.post('/plaid/exchange', async (req, res) => {
  const plaid = require('../lib/integrations').plaid;
  if (!plaid.configured()) return res.status(503).json({ error: 'not enabled' });
  const { publicToken } = req.body || {};
  if (!publicToken) return res.status(400).json({ error: 'publicToken required' });
  try {
    await plaid.exchangePublicToken(publicToken);   // access token handling wired when keys arrive
    await audit(req, 'link_bank', 'borrower', me(req));
    res.json({ ok: true, linked: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------------- NOTIFICATIONS ----------------
router.get('/notifications', async (req, res) => {
  const r = await db.query(
    `SELECT id,type,title,body,application_id,link,read_at,created_at FROM notifications
     WHERE borrower_id=$1 ORDER BY created_at DESC LIMIT 100`, [me(req)]);
  res.json(r.rows);
});
router.post('/notifications/:id/read', async (req, res) => {
  await db.query(`UPDATE notifications SET read_at=now() WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  res.json({ ok: true });
});

// ---------------- MESSAGES (per application) ----------------
router.get('/messages', async (req, res) => {
  const r = await db.query(
    `SELECT m.id,m.application_id,m.sender_kind,m.body,m.is_task_request,m.read_at,m.created_at,
            m.attachment_document_id, m.attachment_kind,
            d.filename AS attachment_name, d.content_type AS attachment_type, d.size_bytes AS attachment_size,
            CASE WHEN m.sender_kind='staff' THEN COALESCE(s.full_name,'Your loan team')
                 WHEN m.sender_kind='borrower' THEN 'You'
                 ELSE 'System' END AS sender_name
       FROM messages m LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
       LEFT JOIN documents d ON d.id=m.attachment_document_id
      WHERE m.channel='borrower'                     -- internal team notes are NEVER shown to borrowers
        AND ($2::uuid IS NULL OR m.application_id=$2)
        AND (m.borrower_id=$1 OR m.application_id IN
             (SELECT id FROM applications WHERE co_borrower_id=$1))
      ORDER BY m.created_at`,
    [me(req), req.query.applicationId || null]);
  // Opening the thread clears the "new message" badge for staff replies.
  if (req.query.applicationId)
    await db.query(`UPDATE messages SET read_at=now() WHERE application_id=$1 AND borrower_id=$2 AND sender_kind='staff' AND read_at IS NULL`,
      [req.query.applicationId, me(req)]);
  res.json(r.rows);
});
router.post('/messages', async (req, res) => {
  const b = req.body || {};
  const att = b.attachment && b.attachment.dataBase64 ? b.attachment : null;
  if ((!b.body || !String(b.body).trim()) && !att) return res.status(400).json({ error: 'message body or attachment required' });
  // If tied to an application, it must be the borrower's own — never let a
  // borrower post onto another borrower's file by guessing its id.
  if (b.applicationId) {
    const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [b.applicationId, me(req)]);
    if (!own.rows[0]) return res.status(404).json({ error: 'application not found' });
  }
  // Store any attachment (photo, video, voice note, PDF, file).
  let attDoc = null;
  if (att) {
    if (!b.applicationId) return res.status(400).json({ error: 'attachments require an application' });
    try {
      attDoc = await require('../lib/chat-attach').saveChatAttachment({
        applicationId: b.applicationId, borrowerId: me(req),
        filename: att.filename, contentType: att.contentType, dataBase64: att.dataBase64,
        byKind: 'borrower', byId: me(req) });
    } catch (e2) { return res.status(e2.status || 500).json({ error: e2.message }); }
  }
  const r = await db.query(
    `INSERT INTO messages (application_id,borrower_id,sender_kind,sender_id,body,is_task_request,attachment_document_id,attachment_kind)
     VALUES ($1,$2,'borrower',$2,$3,$4,$5,$6) RETURNING id`,
    [b.applicationId || null, me(req), String(b.body || '').slice(0, 4000), !!b.isTaskRequest,
     attDoc ? attDoc.documentId : null, attDoc ? attDoc.kind : null]);
  res.status(201).json({ ok: true, messageId: r.rows[0].id });

  // Notify the file's loan officer + processor of the new borrower message.
  if (b.applicationId) {
    try {
      const a = await db.query(
        `SELECT a.loan_officer_id, a.processor_id, bo.first_name, bo.last_name
           FROM applications a JOIN borrowers bo ON bo.id=a.borrower_id WHERE a.id=$1`, [b.applicationId]);
      const row = a.rows[0];
      if (row) {
        const who = `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'A borrower';
        const opts = {
          type: 'message', title: `New message from ${who}`,
          body: String(b.body).slice(0, 140), applicationId: b.applicationId,
          link: `/staff/app/${b.applicationId}`, ctaLabel: 'Open the conversation',
        };
        for (const sid of new Set([row.loan_officer_id, row.processor_id].filter(Boolean)))
          await notify.notifyStaff(sid, opts);
      }
    } catch (_) {}
  }
});

// ---------------- shared: auto-generate checklist from templates ----------------
// ==================== APPLICATION DRAFTS (save-as-you-go) ====================
// One open draft = one in-progress application. The wizard PUTs the whole
// form-state object as it changes; nothing here touches the pricing engines.

router.get('/drafts', async (req, res) => {
  const r = await db.query(
    `SELECT id,label,step,updated_at,created_at,submitted_application_id
       FROM application_drafts
      WHERE borrower_id=$1 AND submitted_application_id IS NULL
      ORDER BY updated_at DESC`, [me(req)]);
  res.json(r.rows);
});

router.post('/drafts', async (req, res) => {
  const b = req.body || {};
  const r = await db.query(
    `INSERT INTO application_drafts (borrower_id,label,data,step)
     VALUES ($1,$2,$3,$4) RETURNING id,label,step,updated_at`,
    [me(req), b.label || null, JSON.stringify(b.data || {}), b.step || 1]);
  res.status(201).json(r.rows[0]);
});

router.get('/drafts/:id', async (req, res) => {
  const r = await db.query(
    `SELECT id,label,data,step,updated_at,submitted_application_id
       FROM application_drafts WHERE id=$1 AND borrower_id=$2`, [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Autosave target. Shallow-merges the posted `data` into the stored object so
// partial saves are safe; last write wins. Also updates step/label if sent.
router.put('/drafts/:id', async (req, res) => {
  const b = req.body || {};
  const own = await db.query(
    `SELECT submitted_application_id FROM application_drafts WHERE id=$1 AND borrower_id=$2`,
    [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  if (own.rows[0].submitted_application_id) return res.status(409).json({ error: 'already submitted' });
  const r = await db.query(
    `UPDATE application_drafts
        SET data = data || $3::jsonb,
            step = COALESCE($4, step),
            label = COALESCE($5, label),
            updated_at = now()
      WHERE id=$1 AND borrower_id=$2
      RETURNING id,step,updated_at`,
    [req.params.id, me(req), JSON.stringify(b.data || {}),
     (b.step == null ? null : b.step), (b.label == null ? null : b.label)]);
  res.json({ ok: true, ...r.rows[0] });
});

router.delete('/drafts/:id', async (req, res) => {
  await db.query(`DELETE FROM application_drafts WHERE id=$1 AND borrower_id=$2 AND submitted_application_id IS NULL`,
    [req.params.id, me(req)]);
  res.json({ ok: true });
});

/**
 * Personal info flows BOTH ways: the profile prefills the application, and
 * anything the borrower fills during the application is saved back to their
 * profile — but only into fields that are still empty, so the profile (the
 * canonical record) is never silently overwritten by a later application.
 */
async function syncProfileFromApplication(borrowerId, b) {
  const p = b.personal || {};
  const hasAny = ['cellPhone', 'dateOfBirth', 'citizenship', 'maritalStatus', 'employmentType', 'employer', 'fico']
    .some(k => p[k] != null && p[k] !== '');
  if (!hasAny && !b.ssn) return;
  await db.query(
    `UPDATE borrowers SET
       cell_phone      = COALESCE(cell_phone, NULLIF($2,'')),
       date_of_birth   = COALESCE(date_of_birth, NULLIF($3,'')::date),
       citizenship     = COALESCE(citizenship, NULLIF($4,'')),
       marital_status  = COALESCE(marital_status, NULLIF($5,'')),
       employment_type = COALESCE(employment_type, NULLIF($6,'')),
       employer        = COALESCE(employer, NULLIF($7,'')),
       fico            = COALESCE(fico, $8),
       updated_at      = now()
     WHERE id=$1`,
    [borrowerId, p.cellPhone || '', p.dateOfBirth || '', p.citizenship || '', p.maritalStatus || '',
     p.employmentType || '', p.employer || '', p.fico ? parseInt(p.fico, 10) || null : null]);
  if (b.ssn) {
    await db.query(
      `UPDATE borrowers SET ssn_encrypted = COALESCE(ssn_encrypted, $2),
              ssn_last4 = COALESCE(ssn_last4, $3), updated_at=now() WHERE id=$1`,
      [borrowerId, C.encryptSSN(b.ssn), String(b.ssn).replace(/\D/g, '').slice(-4)]);
  }
}

/**
 * A co-borrower named on the application becomes a real borrower: their record
 * is created (or matched by email), linked to the application, and they get an
 * emailed invitation to set up portal access — from which they can follow the
 * whole file (access is granted via co_borrower_id scoping on the app routes).
 */
async function inviteCoBorrower(appId, primaryName, co) {
  if (!co || !co.email) return null;
  const cb = await db.query(
    `INSERT INTO borrowers (first_name,last_name,email,cell_phone)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (email) DO UPDATE SET updated_at=now() RETURNING id`,
    [co.firstName || 'Co-Borrower', co.lastName || '', co.email, co.phone || null]);
  const coId = cb.rows[0].id;
  await db.query(`UPDATE applications SET co_borrower_id=$2, updated_at=now() WHERE id=$1`, [appId, coId]);
  // Existing login? They already have access via co_borrower_id — just notify.
  const hasAuth = await db.query(`SELECT 1 FROM borrower_auth WHERE borrower_id=$1`, [coId]);
  const token = C.randomToken(24);
  if (!hasAuth.rows[0]) {
    await db.query(
      `INSERT INTO invite_tokens (token_hash,kind,email,expires_at)
       VALUES ($1,'borrower',$2, now() + interval '14 days')`, [C.sha256(token), co.email]);
  }
  try {
    await mail.send('coBorrowerInvite', co.email, {
      firstName: co.firstName || '',
      primaryName: primaryName || 'your co-borrower',
      acceptUrl: hasAuth.rows[0] ? mail.link('/login') : mail.link('/accept?token=' + token),
      hasAccount: !!hasAuth.rows[0],
    });
  } catch (_) {}
  return coId;
}

// Convert a draft into a real application (mirrors POST /applications), fire the
// staff notification (assigned officer, else Lead Capture admins), then stamp
// the draft so it drops out of the open list but stays for audit.
router.post('/drafts/:id/submit', async (req, res) => {
  const d = await db.query(
    `SELECT data,submitted_application_id FROM application_drafts WHERE id=$1 AND borrower_id=$2`,
    [req.params.id, me(req)]);
  if (!d.rows[0]) return res.status(404).json({ error: 'not found' });
  if (d.rows[0].submitted_application_id)
    return res.status(409).json({ error: 'already submitted', applicationId: d.rows[0].submitted_application_id });
  const b = { ...(d.rows[0].data || {}), ...(req.body || {}) };
  if (!b.propertyAddress) return res.status(400).json({ error: 'propertyAddress required' });

  // resolve officer (by email, else by name) -> null means Lead Capture
  let officerId = null, officerRow = null;
  if (b.loanOfficerEmail) {
    const o = await db.query(`SELECT id,email,full_name FROM staff_users WHERE lower(email)=lower($1) AND is_active=true`, [b.loanOfficerEmail]);
    officerRow = o.rows[0] || null;
  }
  if (!officerRow && b.loanOfficerName) {
    const o = await db.query(`SELECT id,email,full_name FROM staff_users WHERE lower(full_name)=lower($1) AND is_active=true`, [b.loanOfficerName]);
    officerRow = o.rows[0] || null;
  }
  if (officerRow) officerId = officerRow.id;

  const ins = await db.query(
    `INSERT INTO applications
       (borrower_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
        source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'portal',$13,'new',now())
     RETURNING id,ys_loan_number`,
    [me(req), JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, officerId, b.loanOfficerName || null, JSON.stringify(redactPII(b))]);
  const appId = ins.rows[0].id;

  // Personal info entered during the application is saved to the borrower's
  // profile (empty fields only) so it never has to be typed again.
  try { await syncProfileFromApplication(me(req), b); } catch (e) { console.error('[apply] profile sync failed:', db.describeError(e)); }
  // A named co-borrower is created, linked, and invited to the portal.
  try {
    const primary = await db.query(`SELECT first_name,last_name FROM borrowers WHERE id=$1`, [me(req)]);
    const pn = primary.rows[0] ? `${primary.rows[0].first_name} ${primary.rows[0].last_name}`.trim() : '';
    await inviteCoBorrower(appId, pn, b.coBorrower);
  } catch (e) { console.error('[apply] co-borrower invite failed:', db.describeError(e)); }

  await generateChecklist(appId, me(req), b.program, b.loanType);
  await db.query(`UPDATE application_drafts SET submitted_application_id=$1, updated_at=now() WHERE id=$2 AND borrower_id=$3`,
    [appId, req.params.id, me(req)]);
  await audit(req, 'submit_application', 'application', appId);

  // notify staff (branded)
  const addr = (b.propertyAddress && (b.propertyAddress.oneLine || b.propertyAddress.street)) || 'a new property';
  const meta = [{ label: 'Property', value: String(addr) }];
  if (b.program) meta.push({ label: 'Program', value: b.program });
  if (b.loanType) meta.push({ label: 'Loan type', value: b.loanType });
  try {
    if (officerRow) {
      await notify.notifyStaff(officerId, {
        type: 'new_application', title: 'New application submitted',
        body: 'A borrower submitted a new loan application through the portal.',
        applicationId: appId, link: `/staff/app/${appId}`, meta,
        emailTo: officerRow.email, ctaLabel: 'Open the loan file',
      });
    } else {
      await notify.notifyAdmins({
        type: 'unassigned_application', title: 'New application — Lead Capture',
        body: 'A borrower submitted a new application with no loan officer selected. It is in Lead Capture.',
        applicationId: appId, link: `/staff`, meta, ctaLabel: 'Open Lead Capture',
      });
    }
  } catch (e) { /* notification failure never blocks submission */ }

  res.status(201).json({ ok: true, applicationId: appId, ysLoanNumber: ins.rows[0].ys_loan_number });
});

// Map a raw program/loan type onto a checklist track ('rtl' | 'dscr').
// RTL-first shop: anything not clearly a rental/DSCR file runs the RTL workflow,
// so every application connects to a checklist automatically.
function normLoanType(text) {
  const s = String(text || '').toLowerCase();
  if (/dscr|rental|\brent\b|long[-\s]?term|30[-\s]?year/.test(s)) return 'dscr';
  return 'rtl';
}

// Insert a checklist_items row from a template row, carrying workflow columns.
async function insertFromTemplate(tpl, owner) {
  const cols = ['template_id', 'scope', 'label', 'audience', 'item_kind',
                'role_scope', 'phase', 'hint', 'is_gate', 'is_milestone',
                'sort_order', 'tool_key', 'clickup_field_id', 'created_by_kind'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, 'system'];
  for (const [k, v] of Object.entries(owner)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await db.query(`INSERT INTO checklist_items (${cols.join(',')}) VALUES (${ph})`, vals);
}

async function generateChecklist(appId, borrowerId, program, loanType) {
  const track = normLoanType([program, loanType].join(' '));
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE is_active=true AND scope IN ('application','borrower_profile')
       AND (applies_program IS NULL OR applies_program=$1)
       AND (applies_loan_type IS NULL OR applies_loan_type=$2)
     ORDER BY sort_order`, [program || null, track]);
  for (const tpl of t.rows) {
    const owner = tpl.scope === 'application' ? { application_id: appId }
                : tpl.scope === 'borrower_profile' ? { borrower_id: borrowerId }
                : null; // llc-scoped items are created when an LLC is linked
    if (!owner) continue;
    if (tpl.scope === 'borrower_profile') {
      const dup = await db.query(`SELECT 1 FROM checklist_items WHERE borrower_id=$1 AND template_id=$2`, [borrowerId, tpl.id]);
      if (dup.rows[0]) continue;
    }
    await insertFromTemplate(tpl, owner);
  }
}

// Materialize the LLC document requirements (EIN letter, formation docs,
// operating agreement) against an LLC. Idempotent per (llc_id, template).
async function generateLlcChecklist(llcId) {
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE is_active=true AND scope='llc' ORDER BY sort_order`);
  for (const tpl of t.rows) {
    const dup = await db.query(`SELECT 1 FROM checklist_items WHERE llc_id=$1 AND template_id=$2`, [llcId, tpl.id]);
    if (dup.rows[0]) continue;
    await insertFromTemplate(tpl, { llc_id: llcId });
  }
}

router.generateChecklist = generateChecklist;
router.generateLlcChecklist = generateLlcChecklist;
module.exports = router;
module.exports.generateChecklist = generateChecklist;
module.exports.generateLlcChecklist = generateLlcChecklist;
