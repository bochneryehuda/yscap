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
            current_address,mailing_address,years_at_residence,months_at_residence,
            housing_status,housing_payment,citizenship,marital_status,
            photo_id_document_id,contact_type,tier
     FROM borrowers WHERE id=$1`, [me(req)]);
  res.json(r.rows[0] || {});
});

// Update the borrower's canonical profile. The client sends camelCase keys and
// only the fields it wants to change — absent keys are left untouched so a
// partial save never wipes stored PII. NOT-NULL identity fields (name) are
// skipped when blank; nullable fields accept an explicit '' to clear.
// current_address is the PHYSICAL address (may carry a unit); mailing_address is
// only stored when it differs (mailingDifferent:false clears it). Employment is
// intentionally NOT collected — this is a no-doc / no-income lender.
router.put('/profile', async (req, res) => {
  const b = req.body || {};
  const clean = (v) => (v === '' ? null : v);
  const fields = {};
  if (b.firstName !== undefined && String(b.firstName).trim()) fields.first_name = String(b.firstName).trim();
  if (b.lastName !== undefined && String(b.lastName).trim()) fields.last_name = String(b.lastName).trim();
  if (b.cellPhone !== undefined) fields.cell_phone = clean(b.cellPhone);
  if (b.dateOfBirth !== undefined) fields.date_of_birth = clean(b.dateOfBirth);
  if (b.fico !== undefined) fields.fico = (b.fico === '' || b.fico == null) ? null : (parseInt(b.fico, 10) || null);
  if (b.citizenship !== undefined) fields.citizenship = clean(b.citizenship);
  if (b.maritalStatus !== undefined) fields.marital_status = clean(b.maritalStatus);
  if (b.yearsAtResidence !== undefined) fields.years_at_residence = (b.yearsAtResidence === '' || b.yearsAtResidence == null) ? null : Number(b.yearsAtResidence);
  if (b.monthsAtResidence !== undefined) fields.months_at_residence = (b.monthsAtResidence === '' || b.monthsAtResidence == null) ? null : parseInt(b.monthsAtResidence, 10);
  if (b.housingStatus !== undefined) fields.housing_status = clean(b.housingStatus);
  if (b.housingPayment !== undefined) fields.housing_payment = (b.housingPayment === '' || b.housingPayment == null) ? null : Number(String(b.housingPayment).replace(/[^0-9.]/g, '')) || null;
  if (b.currentAddress !== undefined) fields.current_address = b.currentAddress ? JSON.stringify(b.currentAddress) : null;
  if (b.mailingDifferent === false) fields.mailing_address = null;
  else if (b.mailingAddress !== undefined) fields.mailing_address = b.mailingAddress ? JSON.stringify(b.mailingAddress) : null;

  const sets = [], vals = []; let i = 1;
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=$${i++}`); vals.push(v); }
  if (b.ssn) { sets.push(`ssn_encrypted=$${i++}`); vals.push(C.encryptSSN(b.ssn)); sets.push(`ssn_last4=$${i++}`); vals.push(String(b.ssn).replace(/\D/g, '').slice(-4)); }
  if (!sets.length) return res.status(400).json({ error: 'nothing to update' });
  sets.push('updated_at=now()'); vals.push(me(req));
  await db.query(`UPDATE borrowers SET ${sets.join(',')} WHERE id=$${i}`, vals);
  await audit(req, 'update_profile', 'borrower', me(req));
  res.json({ ok: true });
});

// Government photo ID lives on the PROFILE, collected once and reused on every
// file (so a borrower is never asked for it again). Stores the bytes like any
// document and points borrowers.photo_id_document_id at it. Any file's gov-ID
// checklist item is auto-satisfied from this (see generateChecklist).
router.post('/profile/photo-id', async (req, res) => {
  const b = req.body || {};
  if (!b.filename || !b.dataBase64) return res.status(400).json({ error: 'filename + dataBase64 required' });
  const buf = Buffer.from(b.dataBase64, 'base64');
  if (!buf.length) return res.status(400).json({ error: 'empty file' });
  const maxBytes = cfg.maxUploadMb * 1024 * 1024;
  if (buf.length > maxBytes) return res.status(413).json({ error: `file too large (max ${cfg.maxUploadMb} MB)` });
  try {
    const { ref, provider } = await storage.save(buf, { filename: b.filename });
    const d = await db.query(
      `INSERT INTO documents (borrower_id,filename,content_type,size_bytes,storage_provider,storage_ref,uploaded_by_kind,uploaded_by_id,doc_kind)
       VALUES ($1,$2,$3,$4,$5,$6,'borrower',$1,'photo_id') RETURNING id`,
      [me(req), b.filename, b.contentType || 'application/octet-stream', buf.length, provider, ref]);
    await db.query(`UPDATE borrowers SET photo_id_document_id=$2, updated_at=now() WHERE id=$1`, [me(req), d.rows[0].id]);
    // Satisfy any outstanding government-ID checklist item on the borrower's files.
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id')
          AND status NOT IN ('satisfied')
          AND application_id IN (SELECT id FROM applications WHERE borrower_id=$1 OR co_borrower_id=$1)`,
      [me(req)]);
    await audit(req, 'upload_photo_id', 'borrower', me(req));
    res.status(201).json({ ok: true, documentId: d.rows[0].id });
  } catch (e) { res.status(500).json({ error: db.describeError(e) }); }
});

// ---------------- APPLICATIONS (one borrower : many; each a distinct address) ----------------
router.get('/applications', async (req, res) => {
  const r = await db.query(
    `SELECT a.id,a.ys_loan_number,a.program,a.loan_type,a.status,a.property_address,a.loan_amount,
            a.loan_officer_name,a.submitted_at,a.created_at,
            (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both')) AS borrower_total,
            (SELECT count(*)::int FROM checklist_items ci WHERE ci.application_id=a.id AND ci.audience IN ('borrower','both') AND ci.status IN ('received','satisfied')) AS borrower_done
     FROM applications a WHERE (a.borrower_id=$1 OR a.co_borrower_id=$1) AND a.deleted_at IS NULL ORDER BY a.created_at DESC`, [me(req)]);
  res.json(r.rows);
});

// Borrower requests draw setup on a FUNDED file. Notifies the assigned loan team
// (in-app + email), emails the draws desk + borrower, and confirms in-app.
router.post('/applications/:id/request-draw', async (req, res) => {
  const own = await db.query(
    `SELECT a.id,a.status,a.property_address,a.ys_loan_number,a.loan_officer_id,a.processor_id,
            b.first_name,b.last_name,b.email
       FROM applications a JOIN borrowers b ON b.id=a.borrower_id
      WHERE a.id=$1 AND (a.borrower_id=$2 OR a.co_borrower_id=$2)`, [req.params.id, me(req)]);
  const a = own.rows[0];
  if (!a) return res.status(404).json({ error: 'not found' });
  if (a.status !== 'funded') return res.status(400).json({ error: 'Draws can be requested once your loan is funded.' });
  const addr = (a.property_address && (a.property_address.oneLine || a.property_address.street)) || 'your property';
  const borrowerName = `${a.first_name || ''} ${a.last_name || ''}`.trim();
  const team = [...new Set([a.loan_officer_id, a.processor_id].filter(Boolean))];
  try {
    for (const sid of team)
      await notify.notifyStaff(sid, {
        type: 'draw_request', title: 'Draw setup requested',
        body: `${borrowerName || 'The borrower'} requested draw setup on ${addr}.`,
        applicationId: a.id, link: `/staff/app/${a.id}`, ctaLabel: 'Open the file' });
    await notify.notifyBorrower(me(req), {
      type: 'draw_request', title: 'Draw request received',
      body: `We received your request to set up draws on ${addr}. Our draws team will follow up.`,
      applicationId: a.id, link: `/app/${a.id}` });
    // Branded email to the draws desk + assigned team + borrower.
    const staff = team.length ? await db.query(`SELECT email FROM staff_users WHERE id = ANY($1::uuid[])`, [team]) : { rows: [] };
    const recipients = ['draws@yscapgroup.com', a.email, ...staff.rows.map(r => r.email)].filter(Boolean);
    await mail.deliver(mail.drawRequest({ borrowerName, propertyLabel: addr, loanNumber: a.ys_loan_number }), recipients);
  } catch (e) { /* in-app notice already written; email is best-effort */ }
  await audit(req, 'request_draw', 'application', a.id);
  res.json({ ok: true });
});

router.post('/applications', async (req, res) => {
  const b = req.body || {};
  if (!b.propertyAddress) return res.status(400).json({ error: 'propertyAddress required' });
  if (b.llcId) { const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]); if (!o.rows[0]) b.llcId = null; }
  const r = await db.query(
    `INSERT INTO applications
       (borrower_id,llc_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_name,
        is_assignment,underlying_contract_price,assignment_fee,source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'portal',$16,'new',now()) RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, b.loanOfficerName || null,
     !!b.isAssignment, b.underlyingContractPrice || null, b.assignmentFee || null, JSON.stringify(redactPII(b))]);
  const appId = r.rows[0].id;
  await generateChecklist(appId, me(req), b.program, b.loanType, { isAssignment: !!b.isAssignment });
  await audit(req, 'create_application', 'application', appId);
  res.status(201).json({ ok: true, applicationId: appId });
});

router.get('/applications/:id', async (req, res) => {
  const r = await db.query(`SELECT * FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

// Borrower-safe file activity feed (never internal chat/notes/conditions).
router.get('/applications/:id/activity', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  try { res.json(await require('../lib/activity').fileActivity(req.params.id, true)); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});

// Borrower-visible conditions (object model) — open/unresolved, borrower wording.
router.get('/applications/:id/conditions', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2) AND deleted_at IS NULL`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT id, COALESCE(borrower_title,title) AS title, COALESCE(borrower_detail,detail) AS detail,
            severity, status, linked_entity_type, linked_entity_id, created_at
       FROM conditions
      WHERE application_id=$1 AND audience IN ('borrower','both') AND status IN ('open','borrower_responded')
      ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});

// ---------------- CHECKLIST (borrower-visible items only) ----------------
router.get('/applications/:id/checklist', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const r = await db.query(
    `SELECT ci.id, COALESCE(ci.borrower_label,ci.label) AS label, ci.status, ci.item_kind, ci.phase,
            COALESCE(ci.borrower_hint,ci.hint) AS hint, ci.is_required, ci.due_date, ci.notes,
            ci.tool_key, (ci.tool_payload IS NOT NULL) AS tool_submitted, ci.tool_payload,
            (SELECT d.rejection_reason FROM documents d
              WHERE d.checklist_item_id=ci.id AND d.review_status='rejected'
              ORDER BY d.reviewed_at DESC NULLS LAST LIMIT 1) AS rejection_reason
       FROM checklist_items ci
      WHERE ci.application_id=$1 AND ci.audience IN ('borrower','both')
      ORDER BY ci.sort_order, ci.created_at`, [req.params.id]);
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
  // The rehab-budget tool's grand total IS the file's rehab budget, which feeds
  // the pricing engine — sync it onto the application so terms reflect the SOW.
  if (it.rows[0].tool_key === 'rehab_budget') {
    const total = Number(payload && payload.total);
    if (isFinite(total) && total >= 0) {
      await db.query(`UPDATE applications SET rehab_budget=$2, updated_at=now() WHERE id=$1`, [req.params.id, total]);
    }
  }
  // Let the assigned loan team know the borrower completed this task.
  try {
    const a = await db.query(
      `SELECT a.loan_officer_id, a.processor_id, a.ys_loan_number, b.first_name, b.last_name
         FROM applications a JOIN borrowers b ON b.id=a.borrower_id WHERE a.id=$1`, [req.params.id]);
    const row = a.rows[0];
    if (row) {
      const who = [row.first_name, row.last_name].filter(Boolean).join(' ') || 'The borrower';
      const label = it.rows[0].tool_key === 'rehab_budget' ? 'rehab budget' : 'task';
      const extra = it.rows[0].tool_key === 'rehab_budget' && isFinite(Number(payload.total))
        ? ` — $${Math.round(Number(payload.total)).toLocaleString('en-US')}` : '';
      for (const sid of new Set([row.loan_officer_id, row.processor_id].filter(Boolean))) {
        await notify.notifyStaff(sid, {
          type: 'tool_submitted', title: `${who} submitted their ${label}`,
          body: `${row.ys_loan_number || 'A file'}${extra}`, applicationId: req.params.id });
      }
    }
  } catch (_) { /* notification is best-effort */ }
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
  const r = await db.query(`SELECT id,filename,content_type,size_bytes,created_at FROM documents
     WHERE llc_id=$1 AND visibility='borrower' AND source_type <> 'chat_attachment' ORDER BY created_at`, [req.params.id]);
  res.json(r.rows);
});

// ---------------- SERVICE CONTACTS (title company / insurance agent) ----------------
// Reusable across files: the borrower enters a contact once and links it on
// future files via autocomplete. tool_key on the checklist item decides which
// contact type the form collects.
const CONTACT_TYPES = ['title_company', 'insurance_agent', 'attorney', 'contractor', 'other'];
router.get('/contacts', async (req, res) => {
  const type = CONTACT_TYPES.includes(req.query.type) ? req.query.type : null;
  const r = await db.query(
    `SELECT id,contact_type,company_name,contact_name,email,phone,last_used_at
       FROM service_contacts WHERE borrower_id=$1 AND ($2::text IS NULL OR contact_type=$2)
      ORDER BY last_used_at DESC NULLS LAST, updated_at DESC`, [me(req), type]);
  res.json(r.rows);
});
// Save/attach a contact. Optionally links it to an application + satisfies a
// checklist item (the title/insurance "contact" tasks are forms, not uploads).
router.post('/contacts', async (req, res) => {
  const b = req.body || {};
  const type = CONTACT_TYPES.includes(b.contactType) ? b.contactType : 'other';
  if (!b.companyName && !b.contactName && !b.email && !b.phone)
    return res.status(400).json({ error: 'enter at least one contact detail' });
  if (b.applicationId) {
    const o = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [b.applicationId, me(req)]);
    if (!o.rows[0]) return res.status(404).json({ error: 'application not found' });
  }
  let contactId = b.contactId || null;
  if (contactId) {
    const upd = await db.query(
      `UPDATE service_contacts SET company_name=$3,contact_name=$4,email=$5,phone=$6,updated_at=now(),last_used_at=now()
        WHERE id=$1 AND borrower_id=$2 RETURNING id`,
      [contactId, me(req), b.companyName || null, b.contactName || null, b.email || null, b.phone || null]);
    if (!upd.rows[0]) contactId = null;
  }
  if (!contactId) {
    const ins = await db.query(
      `INSERT INTO service_contacts (borrower_id,contact_type,company_name,contact_name,email,phone,last_used_at)
       VALUES ($1,$2,$3,$4,$5,$6,now()) RETURNING id`,
      [me(req), type, b.companyName || null, b.contactName || null, b.email || null, b.phone || null]);
    contactId = ins.rows[0].id;
  }
  if (b.applicationId) {
    await db.query(
      `INSERT INTO application_service_contacts (application_id,service_contact_id,contact_type)
       VALUES ($1,$2,$3) ON CONFLICT (application_id,contact_type)
       DO UPDATE SET service_contact_id=EXCLUDED.service_contact_id, created_at=now()`,
      [b.applicationId, contactId, type]);
  }
  // Submitting the contact form satisfies its checklist task (moves to review).
  if (b.checklistItemId) {
    await db.query(
      `UPDATE checklist_items SET status='received', updated_at=now()
        WHERE id=$1 AND application_id IN (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2)`,
      [b.checklistItemId, me(req)]);
  }
  await audit(req, 'save_contact', 'borrower', me(req), { contactType: type, applicationId: b.applicationId || null });
  res.status(201).json({ ok: true, contactId });
});

// ---------------- PARTNERS (reusable co-borrowers) ----------------
router.get('/partners', async (req, res) => {
  const r = await db.query(
    `SELECT id,first_name,last_name,email,phone,relationship_type,partner_borrower_id
       FROM partners WHERE owner_borrower_id=$1 ORDER BY updated_at DESC`, [me(req)]);
  res.json(r.rows);
});
// Save/update a partner for reuse. Also called on submit to remember a co-borrower.
async function upsertPartner(ownerId, p) {
  if (!p || (!p.email && !p.firstName && !p.lastName)) return null;
  const r = await db.query(
    `INSERT INTO partners (owner_borrower_id,first_name,last_name,email,phone,relationship_type)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (owner_borrower_id,email) DO UPDATE SET
       first_name=COALESCE(EXCLUDED.first_name,partners.first_name),
       last_name=COALESCE(EXCLUDED.last_name,partners.last_name),
       phone=COALESCE(EXCLUDED.phone,partners.phone),
       relationship_type=EXCLUDED.relationship_type, updated_at=now()
     RETURNING id`,
    [ownerId, p.firstName || null, p.lastName || null, p.email || null, p.phone || null, p.relationshipType || 'co_borrower']);
  return r.rows[0] ? r.rows[0].id : null;
}
router.post('/partners', async (req, res) => {
  const b = req.body || {};
  try { const id = await upsertPartner(me(req), b); if (!id) return res.status(400).json({ error: 'enter partner details' }); res.status(201).json({ ok: true, partnerId: id }); }
  catch (e) { res.status(500).json({ error: 'server error' }); }
});
router.upsertPartner = upsertPartner;

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
// Delete a track-record entry — only the borrower's own, and only while it is
// still unverified (a verified entry is locked as underwriting evidence).
router.delete('/track-records/:id', async (req, res) => {
  const r = await db.query(
    `DELETE FROM track_records WHERE id=$1 AND borrower_id=$2 AND is_verified=false RETURNING id`,
    [req.params.id, me(req)]);
  if (!r.rows[0]) return res.status(404).json({ error: 'not found or already verified' });
  res.json({ ok: true });
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
  if (b.checklistItemId) {
    // A re-upload supersedes the borrower's prior versions for this item so a
    // rejected/old document never stays part of the file; the new one is the
    // current version, pending review again.
    await db.query(
      `UPDATE documents SET is_current=false,
          review_status=CASE WHEN review_status IN ('pending','rejected') THEN 'superseded' ELSE review_status END
        WHERE checklist_item_id=$1 AND borrower_id=$2 AND id<>$3 AND is_current=true`,
      [b.checklistItemId, me(req), r.rows[0].id]);
    await db.query(`UPDATE checklist_items SET status='received', updated_at=now() WHERE id=$1 AND (application_id IN (SELECT id FROM applications WHERE borrower_id=$2 OR co_borrower_id=$2) OR borrower_id=$2 OR llc_id IN (SELECT id FROM llcs WHERE borrower_id=$2))`, [b.checklistItemId, me(req)]);
  }
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
// Only borrower-visible items, and never chat attachments — those render inside
// the conversation, not the document library (see 014_document_visibility).
router.get('/documents', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,size_bytes,application_id,llc_id,checklist_item_id,created_at,
            review_status,rejection_reason,is_current
       FROM documents
      WHERE borrower_id=$1 AND ($2::uuid IS NULL OR application_id=$2)
        AND visibility='borrower' AND source_type <> 'chat_attachment'
      ORDER BY is_current DESC, created_at DESC`,
    [me(req), req.query.applicationId || null]);
  res.json(r.rows);
});

// Download a document the borrower may see: their own uploads plus staff files
// shared with them on the borrower channel, on an application they own or
// co-borrow. visibility='borrower' is mandatory — a borrower must never be able
// to fetch a staff-only / internal document even with a guessed id.
router.get('/documents/:id/download', async (req, res) => {
  const r = await db.query(
    `SELECT id,filename,content_type,storage_ref FROM documents
      WHERE id=$1 AND visibility='borrower' AND (borrower_id=$2 OR application_id IN
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

// Notification preferences: the borrower can quiet categories. Critical ones
// (documents, conditions) stay in-app; only their email can be turned off.
const CRITICAL_INAPP = new Set(['documents', 'conditions']);
router.get('/notification-prefs', async (req, res) => {
  const saved = await db.query(`SELECT category,in_app,email FROM notification_prefs WHERE borrower_id=$1`, [me(req)]);
  const byCat = Object.fromEntries(saved.rows.map(r => [r.category, r]));
  const cats = notify.NOTIFY_CATEGORIES.map(category => ({
    category,
    in_app: byCat[category] ? byCat[category].in_app : true,
    email: byCat[category] ? byCat[category].email : true,
    inAppLocked: CRITICAL_INAPP.has(category),   // can't turn off in-app for these
  }));
  res.json(cats);
});
router.put('/notification-prefs', async (req, res) => {
  const b = req.body || {};
  if (!notify.NOTIFY_CATEGORIES.includes(b.category)) return res.status(400).json({ error: 'bad category' });
  const inApp = CRITICAL_INAPP.has(b.category) ? true : b.in_app !== false;  // critical stays in-app
  await db.query(
    `INSERT INTO notification_prefs (borrower_id,category,in_app,email) VALUES ($1,$2,$3,$4)
     ON CONFLICT (borrower_id,category) DO UPDATE SET in_app=EXCLUDED.in_app, email=EXCLUDED.email`,
    [me(req), b.category, inApp, b.email !== false]);
  res.json({ ok: true });
});

// ---------------- MESSAGES (per application) ----------------
router.get('/messages', async (req, res) => {
  const r = await db.query(
    `SELECT m.id,m.application_id,m.sender_kind,m.body,m.is_task_request,m.read_at,m.created_at,
            m.pinned, m.edited_at, m.deleted_at,
            m.attachment_document_id, m.attachment_kind, m.entity_refs,
            d.filename AS attachment_name, d.content_type AS attachment_type, d.size_bytes AS attachment_size,
            COALESCE((SELECT json_agg(json_build_object('emoji', r.emoji, 'kind', r.actor_kind, 'actor', r.actor_id))
                        FROM message_reactions r WHERE r.message_id=m.id), '[]'::json) AS reactions,
            CASE WHEN m.sender_kind='staff' THEN COALESCE(s.full_name,'Your loan team')
                 WHEN m.sender_kind='borrower' THEN 'You'
                 ELSE 'System' END AS sender_name
       FROM messages m LEFT JOIN staff_users s ON s.id=m.sender_id AND m.sender_kind='staff'
       LEFT JOIN documents d ON d.id=m.attachment_document_id
      WHERE m.channel='borrower'                     -- internal team notes are NEVER shown to borrowers
        AND ($2::uuid IS NULL OR m.application_id=$2)
        AND (m.borrower_id=$1 OR m.application_id IN
             (SELECT id FROM applications WHERE borrower_id=$1 OR co_borrower_id=$1))
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
        byKind: 'borrower', byId: me(req), channel: 'borrower' });
    } catch (e2) { return res.status(e2.status || 500).json({ error: e2.message }); }
  }
  const refs = Array.isArray(b.entityRefs)
    ? b.entityRefs.slice(0, 20).map(r => ({
        type: ['task','document','application','borrower'].includes(r.type) ? r.type : 'task',
        id: String(r.id || '').slice(0, 60), label: String(r.label || '').slice(0, 160) }))
      .filter(r => r.id && r.label)
    : null;
  const r = await db.query(
    `INSERT INTO messages (application_id,borrower_id,sender_kind,sender_id,body,is_task_request,attachment_document_id,attachment_kind,entity_refs)
     VALUES ($1,$2,'borrower',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [b.applicationId || null, me(req), String(b.body || '').slice(0, 4000), !!b.isTaskRequest,
     attDoc ? attDoc.documentId : null, attDoc ? attDoc.kind : null,
     refs && refs.length ? JSON.stringify(refs) : null]);
  if (attDoc) await db.query(`UPDATE documents SET message_id=$1 WHERE id=$2`, [r.rows[0].id, attDoc.documentId]);
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
        // @mentions of staff by the borrower get a direct ping too.
        if (b.body) await require('../lib/mentions').notifyMentions({
          body: b.body, applicationId: b.applicationId, senderName: who });
      }
    } catch (_) {}
  }
});

// Toggle an emoji reaction on a borrower-channel message on one of my files.
router.post('/messages/:mid/react', async (req, res) => {
  const emoji = String((req.body || {}).emoji || '').slice(0, 16);
  if (!emoji) return res.status(400).json({ error: 'emoji required' });
  const m = await db.query(
    `SELECT 1 FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND (a.borrower_id=$2 OR a.co_borrower_id=$2)`,
    [req.params.mid, me(req)]);
  if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
  const del = await db.query(
    `DELETE FROM message_reactions WHERE message_id=$1 AND actor_kind='borrower' AND actor_id=$2 AND emoji=$3 RETURNING id`,
    [req.params.mid, me(req), emoji]);
  if (!del.rows[0])
    await db.query(`INSERT INTO message_reactions (message_id,actor_kind,actor_id,emoji) VALUES ($1,'borrower',$2,$3)`,
      [req.params.mid, me(req), emoji]);
  res.json({ ok: true, reacted: !del.rows[0] });
});

// Edit my own message (within 15 min). Only borrower-channel, my own file.
router.patch('/messages/:mid', async (req, res) => {
  const body = String((req.body || {}).body || '').trim();
  if (!body) return res.status(400).json({ error: 'body required' });
  const m = await db.query(
    `SELECT m.created_at, m.deleted_at FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND m.sender_kind='borrower' AND m.sender_id=$2
        AND (a.borrower_id=$2 OR a.co_borrower_id=$2)`, [req.params.mid, me(req)]);
  if (!m.rows[0] || m.rows[0].deleted_at) return res.status(404).json({ error: 'not found' });
  if ((Date.now() - new Date(m.rows[0].created_at).getTime()) > 15 * 60 * 1000)
    return res.status(403).json({ error: 'this message can no longer be edited' });
  await db.query(`UPDATE messages SET body=$2, edited_at=now() WHERE id=$1`, [req.params.mid, body.slice(0, 4000)]);
  res.json({ ok: true });
});
// Soft-delete my own message.
router.delete('/messages/:mid', async (req, res) => {
  const m = await db.query(
    `SELECT 1 FROM messages m JOIN applications a ON a.id=m.application_id
      WHERE m.id=$1 AND m.channel='borrower' AND m.sender_kind='borrower' AND m.sender_id=$2
        AND (a.borrower_id=$2 OR a.co_borrower_id=$2)`, [req.params.mid, me(req)]);
  if (!m.rows[0]) return res.status(404).json({ error: 'not found' });
  await db.query(`UPDATE messages SET deleted_at=now(), body='[message removed]', pinned=false WHERE id=$1`, [req.params.mid]);
  await db.query(`DELETE FROM message_reactions WHERE message_id=$1`, [req.params.mid]);
  res.json({ ok: true });
});

// What the borrower can mention: their team, their visible tasks, their
// documents, and their own applications/properties.
router.get('/applications/:id/mentionables', async (req, res) => {
  const own = await db.query(`SELECT 1 FROM applications WHERE id=$1 AND (borrower_id=$2 OR co_borrower_id=$2)`, [req.params.id, me(req)]);
  if (!own.rows[0]) return res.status(404).json({ error: 'not found' });
  const [users, tasks, docs, apps] = await Promise.all([
    db.query(`SELECT s.id, s.full_name AS label FROM applications a
                JOIN staff_users s ON s.id IN (a.loan_officer_id, a.processor_id)
               WHERE a.id=$1 AND s.is_active=true`, [req.params.id]),
    db.query(`SELECT id, label, status FROM checklist_items
               WHERE application_id=$1 AND audience IN ('borrower','both') ORDER BY sort_order LIMIT 200`, [req.params.id]),
    db.query(`SELECT id, filename AS label FROM documents WHERE application_id=$1
                AND visibility='borrower' AND source_type <> 'chat_attachment'
              ORDER BY created_at DESC LIMIT 100`, [req.params.id]),
    db.query(`SELECT id, COALESCE(property_address->>'oneLine', property_address->>'street', 'Application') AS label
                FROM applications WHERE borrower_id=$1 OR co_borrower_id=$1`, [me(req)]),
  ]);
  res.json({ users: users.rows, tasks: tasks.rows, documents: docs.rows, applications: apps.rows });
});

// Which of my applications have unread messages from the loan team.
router.get('/chat/inbox', async (req, res) => {
  const r = await db.query(
    `SELECT a.id, a.property_address, a.status,
            (SELECT count(*)::int FROM messages m WHERE m.application_id=a.id
               AND m.channel='borrower' AND m.sender_kind='staff' AND m.read_at IS NULL) AS unread,
            lm.body AS last_body, lm.sender_kind AS last_sender_kind, lm.created_at AS last_at
       FROM applications a
       LEFT JOIN LATERAL (SELECT body, sender_kind, created_at FROM messages m
                           WHERE m.application_id=a.id AND m.channel='borrower'
                           ORDER BY created_at DESC LIMIT 1) lm ON true
      WHERE a.borrower_id=$1 OR a.co_borrower_id=$1
      ORDER BY lm.created_at DESC NULLS LAST`, [me(req)]);
  res.json(r.rows);
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
  // Employment is intentionally not collected (no-doc / no-income lender).
  const hasAny = ['cellPhone', 'dateOfBirth', 'citizenship', 'maritalStatus', 'fico']
    .some(k => p[k] != null && p[k] !== '');
  if (!hasAny && !b.ssn) return;
  await db.query(
    `UPDATE borrowers SET
       cell_phone      = COALESCE(cell_phone, NULLIF($2,'')),
       date_of_birth   = COALESCE(date_of_birth, NULLIF($3,'')::date),
       citizenship     = COALESCE(citizenship, NULLIF($4,'')),
       marital_status  = COALESCE(marital_status, NULLIF($5,'')),
       fico            = COALESCE(fico, $6),
       updated_at      = now()
     WHERE id=$1`,
    [borrowerId, p.cellPhone || '', p.dateOfBirth || '', p.citizenship || '', p.maritalStatus || '',
     p.fico ? parseInt(p.fico, 10) || null : null]);
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
  // Only accept an LLC the borrower actually owns.
  if (b.llcId) { const o = await db.query(`SELECT 1 FROM llcs WHERE id=$1 AND borrower_id=$2`, [b.llcId, me(req)]); if (!o.rows[0]) b.llcId = null; }

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
       (borrower_id,llc_id,property_address,property_type,units,program,loan_type,
        purchase_price,as_is_value,arv,rehab_budget,loan_officer_id,loan_officer_name,
        is_assignment,underlying_contract_price,assignment_fee,
        source,raw_intake,status,submitted_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'portal',$17,'new',now())
     RETURNING id,ys_loan_number`,
    [me(req), b.llcId || null, JSON.stringify(b.propertyAddress), b.propertyType || null, b.units || null,
     b.program || null, b.loanType || null, b.purchasePrice || null, b.asIsValue || null,
     b.arv || null, b.rehabBudget || null, officerId, b.loanOfficerName || null,
     !!b.isAssignment, b.underlyingContractPrice || null, b.assignmentFee || null, JSON.stringify(redactPII(b))]);
  const appId = ins.rows[0].id;
  // If the borrower linked an LLC, ensure its document requirements exist.
  if (b.llcId) { try { await generateLlcChecklist(b.llcId); } catch (_) { /* best-effort */ } }

  // Personal info entered during the application is saved to the borrower's
  // profile (empty fields only) so it never has to be typed again.
  try { await syncProfileFromApplication(me(req), b); } catch (e) { console.error('[apply] profile sync failed:', db.describeError(e)); }
  // A named co-borrower (only when the co-borrower toggle is on) is created,
  // linked, and invited to the portal.
  if (b.hasCoBorrower && b.coBorrower && b.coBorrower.email) {
    try {
      const primary = await db.query(`SELECT first_name,last_name FROM borrowers WHERE id=$1`, [me(req)]);
      const pn = primary.rows[0] ? `${primary.rows[0].first_name} ${primary.rows[0].last_name}`.trim() : '';
      await inviteCoBorrower(appId, pn, b.coBorrower);
      // Remember this partner so the borrower can reuse them on the next file.
      try { await upsertPartner(me(req), { ...b.coBorrower, relationshipType: 'co_borrower' }); } catch (_) {}
    } catch (e) { console.error('[apply] co-borrower invite failed:', db.describeError(e)); }
  }

  await generateChecklist(appId, me(req), b.program, b.loanType, { isAssignment: !!b.isAssignment });
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
  const cols = ['template_id', 'scope', 'label', 'borrower_label', 'audience', 'item_kind',
                'role_scope', 'phase', 'hint', 'borrower_hint', 'is_gate', 'is_milestone',
                'sort_order', 'tool_key', 'clickup_field_id', 'created_by_kind'];
  const vals = [tpl.id, tpl.scope, tpl.label, tpl.borrower_label || null, tpl.audience, tpl.item_kind,
                tpl.role_scope || 'any', tpl.phase || null, tpl.hint || null, tpl.borrower_hint || null,
                tpl.is_gate || false, tpl.is_milestone || false,
                tpl.sort_order || 100, tpl.tool_key || null, tpl.clickup_field_id || null, 'system'];
  for (const [k, v] of Object.entries(owner)) { cols.push(k); vals.push(v); }
  const ph = vals.map((_, i) => `$${i + 1}`).join(',');
  await db.query(`INSERT INTO checklist_items (${cols.join(',')}) VALUES (${ph})`, vals);
}

async function generateChecklist(appId, borrowerId, program, loanType, opts = {}) {
  const track = normLoanType([program, loanType].join(' '));
  const t = await db.query(
    `SELECT * FROM checklist_templates WHERE is_active=true AND scope IN ('application','borrower_profile')
       AND (applies_program IS NULL OR applies_program=$1)
       AND (applies_loan_type IS NULL OR applies_loan_type=$2)
     ORDER BY sort_order`, [program || null, track]);
  for (const tpl of t.rows) {
    // Assignment paperwork is only required when the purchase is an assignment.
    if (tpl.code === 'rtl_p5_assign' && !opts.isAssignment) continue;
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
  // Government photo ID is collected once on the profile and reused: if it's
  // already on file, this application's gov-ID item is satisfied up front.
  try {
    const pid = await db.query(`SELECT photo_id_document_id FROM borrowers WHERE id=$1`, [borrowerId]);
    if (pid.rows[0] && pid.rows[0].photo_id_document_id)
      await db.query(
        `UPDATE checklist_items SET status='received', updated_at=now()
          WHERE application_id=$1 AND template_id=(SELECT id FROM checklist_templates WHERE code='rtl_p1_id')`,
        [appId]);
  } catch (_) { /* best-effort */ }
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
